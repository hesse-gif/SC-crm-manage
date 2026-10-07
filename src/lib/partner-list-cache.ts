// `/flu/partners` 목록 읽기용 메모리 캐시 (+ in-flight 병합).
//
// 왜 (COST-P0-006/011 대응 — 이 파일 자체가 비용 절감 룰 대응이다):
//   프로드 실측(2026-08-22) `/flu/partners` 1회 로드 = 콜러블 8회. 이 화면만 캐시 레이어가 아예
//   없어서(page.tsx 의 생 useEffect 2개가 매 마운트마다 getActivePartners + listSubmissions(limit 500)
//   을 다시 부른다) SPA 안에서 탭을 오갈 때마다 전량 재호출됐다.
//
// 신선도 계약: live.tsx `MEMORY_TTL_MS` 와 같은 60초. 운영 판단 화면이 오래된 값으로 잘못 보이면
//   안 되므로 TTL 을 늘리지 않는다. 60초 이내면 캐시로 즉시 그리고 네트워크를 생략, 만료됐으면
//   **캐시를 먼저 그린 뒤 배경에서 재검증**한다(SWR — 화면이 매번 비었다 차오르지 않게).
//   수동 새로고침/재시도(reloadToken)는 언제나 강제 우회한다.
//
// 개인정보(SEC-P0-009): `use-operational-snapshot.ts` 는 서버가 PII-free 를 강제한 집계 수치라
//   localStorage 에 영속하지만, 파트너 목록은 사람 식별 정보(표시명·핸들)와 제출 원문(이메일)에서
//   파생된 행이다. 따라서 **메모리 캐시만** 둔다 — 영속 저장 없음. 인증 스코프(authScopeKey)를
//   캐시 키에 포함해 계정 간 캐시가 섞이지 않는다.

import { callableDedupeKey, dedupeCallable } from "./callable-dedupe.ts";

export const PARTNER_LIST_CACHE_TTL_MS = 60_000;

type PartnerCacheEntry = { value: unknown; storedAt: number };

const partnerListCache = new Map<string, PartnerCacheEntry>();

export type PartnerCachePeek<T> = { value: T; fresh: boolean };

export function partnerListCacheKey(authScopeKey: string | null, surface: string): string {
  return `${authScopeKey ?? "anonymous"}::${surface}`;
}

/** 캐시에 있으면 즉시 돌려준다(만료됐어도 `fresh:false` 로 함께 알려 SWR 렌더에 쓰게 한다). */
export function peekPartnerListCache<T>(key: string, nowMs = Date.now()): PartnerCachePeek<T> | null {
  const entry = partnerListCache.get(key);
  if (!entry) return null;
  return { value: entry.value as T, fresh: nowMs - entry.storedAt < PARTNER_LIST_CACHE_TTL_MS };
}

export function writePartnerListCache<T>(key: string, value: T, nowMs = Date.now()): void {
  partnerListCache.set(key, { value, storedAt: nowMs });
}

/**
 * 네트워크 읽기 + 캐시 쓰기. 같은 `dedupeKey` 로 이미 진행 중인 호출이 있으면 합류한다
 * (마운트가 두 번 도는 경우·두 섹션이 같은 콜러블을 부르는 경우를 한 번으로 만든다).
 * `force` 는 합류를 건너뛰고 새 호출을 낸다 — 수동 새로고침 전용.
 */
export async function revalidatePartnerListCache<T>(
  cacheKey: string,
  dedupeKey: string,
  load: () => Promise<T>,
  options: { force?: boolean } = {},
): Promise<T> {
  const value = await dedupeCallable(dedupeKey, load, { bypass: options.force === true });
  writePartnerListCache(cacheKey, value);
  return value;
}

/** 캐시를 쓸지(=네트워크 생략) 판정. 순수 함수라 유닛 테스트로 계약을 고정할 수 있다. */
export function shouldSkipPartnerNetworkRead(
  cached: PartnerCachePeek<unknown> | null,
  force: boolean,
): boolean {
  return !force && cached !== null && cached.fresh;
}

/** 테스트/계정 전환용. */
export function clearPartnerListCache(): void {
  partnerListCache.clear();
}
