// `/flu/candidates` 목록 읽기(listCandidates)용 메모리 SWR 캐시 (+ in-flight 병합).
//
// 왜 (AI Drama 반짝거림 리포트 대응, partner-list-cache.ts/conversation-list-cache.ts 와 동일 원인):
//   candidates/page.tsx 의 조회 effect 가 스코프(프로그램/캠페인/viewAs/인증) 재계산 때마다,
//   그리고 명시적 새로고침·뮤테이션 후속 새로고침 때마다 rows 를 즉시 [] 로 비우고 나서
//   listCandidates 를 다시 불렀다 — 이미 그려둔 후보 목록이 응답이 올 때까지 매번 비었다가
//   차오르며 반짝였다(candidates 탭은 live.tsx DatasetBundle 회전에 들지 않는 스코프드 콜러블이라
//   그 캐시 레이어의 혜택을 받지 못했다). 이 레이어는 "캐시된 마지막 응답을 먼저 그리고 배경에서
//   재검증"해 그 플래시를 없앤다.
//
// 신선도 계약: live.tsx `MEMORY_TTL_MS`, partner-list-cache.ts/conversation-list-cache.ts 와 같은
//   60초. 신선하면 네트워크를 생략하고, 만료됐어도 값은 그대로 먼저 그린 뒤 배경에서 재검증한다
//   (SWR). 수동 새로고침·뮤테이션 후속 새로고침(handleRefresh)은 언제나 강제 우회(force)한다 —
//   메일 발송·보류·즐겨찾기 같은 조작 직후에는 오래된 값을 보여주면 안 된다.
//
// 스코프/개인정보(SEC-P0-009): 캐시 키는 candidates/page.tsx 가 이미 계산해 둔
//   candidateAuthScopeKey(인증 스코프·조직·"대신 보기"·선택된 프로그램/캠페인이 모두 들어간
//   합성 스코프 키)를 그대로 쓴다. 다른 스코프의 행은 키가 달라 섞일 수 없다. 후보 행에는 사람
//   식별 정보(표시명·이메일)가 있으므로 **메모리 캐시만** 둔다 — 영속 저장 없음. **인증 스코프**
//   (계정/조직/"대신 보기")가 실제로 전환될 때만 candidates/page.tsx 가 clearCandidateListCache()를
//   호출해 이전 스코프의 값을 메모리에서도 지운다 — partner-list-cache.ts M4/observedScopeRef와
//   동일 계약(마운트 시점·프로그램/캠페인 선택 변경만으로는 지우지 않는다: 지우면 SPA 재진입·탭
//   왕복마다 캐시가 비어 이 레이어의 목적이 사라진다 — 적대적 리뷰 라운드1 MAJOR 수리).
//
// 무효화 계약(conversation-list-cache.ts invalidateConversationListCache와 동일 의미): 다른
//   화면의 뮤테이션(검수 큐 승인 등)이 후보 상태를 바꿀 수 있어, 전역 `flu:data-refresh` 이벤트에
//   invalidateCandidateListCache()를 건다 — 값을 지우지 않고 **만료**시켜(storedAt=0) 다음 peek이
//   fresh:false로 SWR 재검증을 강제하게 한다(화면에 그려진 값은 그대로 유지, 빈 화면으로 되돌아가지
//   않는다).

import { dedupeCallable } from "./callable-dedupe.ts";

export const CANDIDATE_LIST_CACHE_TTL_MS = 60_000;

type CandidateListCacheEntry = { value: unknown; storedAt: number };

const candidateListCache = new Map<string, CandidateListCacheEntry>();

export type CandidateListCachePeek<T> = { value: T; fresh: boolean };

export function candidateListCacheKey(scopeKey: string): string {
  return scopeKey;
}

/** 캐시에 있으면 즉시 돌려준다(만료됐어도 `fresh:false` 로 함께 알려 SWR 렌더에 쓰게 한다). */
export function peekCandidateListCache<T>(key: string, nowMs = Date.now()): CandidateListCachePeek<T> | null {
  const entry = candidateListCache.get(key);
  if (!entry) return null;
  return { value: entry.value as T, fresh: nowMs - entry.storedAt < CANDIDATE_LIST_CACHE_TTL_MS };
}

export function writeCandidateListCache<T>(key: string, value: T, nowMs = Date.now()): void {
  candidateListCache.set(key, { value, storedAt: nowMs });
}

/**
 * 네트워크 읽기 + 캐시 쓰기. 같은 `dedupeKey` 로 이미 진행 중인 호출이 있으면 합류한다.
 * `force` 는 합류를 건너뛰고 새 호출을 낸다 — 수동 새로고침·뮤테이션 후속 새로고침 전용.
 */
export async function revalidateCandidateListCache<T>(
  cacheKey: string,
  dedupeKey: string,
  load: () => Promise<T>,
  options: { force?: boolean } = {},
): Promise<T> {
  const value = await dedupeCallable(dedupeKey, load, { bypass: options.force === true });
  writeCandidateListCache(cacheKey, value);
  return value;
}

/** 캐시를 쓸지(=네트워크 생략) 판정. 순수 함수라 유닛 테스트로 계약을 고정할 수 있다. */
export function shouldSkipCandidateNetworkRead(
  cached: CandidateListCachePeek<unknown> | null,
  force: boolean,
): boolean {
  return !force && cached !== null && cached.fresh;
}

/**
 * 무효화 = 값을 지우지 않고 **만료**시킨다(conversation-list-cache.ts와 동일 계약). `key`를 주면
 * 그 항목만, 생략하면 전체를 만료시킨다. 다른 화면의 뮤테이션(`flu:data-refresh`) 대응용 — 화면에
 * 이미 그려진 값은 유지한 채 다음 조회가 반드시 재검증하게 한다.
 */
export function invalidateCandidateListCache(key?: string): void {
  if (key) {
    const entry = candidateListCache.get(key);
    if (entry) entry.storedAt = 0;
    return;
  }
  for (const entry of candidateListCache.values()) entry.storedAt = 0;
}

/** 인증 스코프 전환(계정·조직·"대신 보기"·로그아웃)·테스트용 — 값 자체를 메모리에서 지운다. */
export function clearCandidateListCache(): void {
  candidateListCache.clear();
}
