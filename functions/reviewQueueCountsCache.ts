/**
 * **검수 큐 배지·포털 별칭 스플라이스 캐시** (Task-53, 비용 감사 2026-09-11).
 *
 * ■ 무엇이 문제였나
 *   `listScpVideoReviewStatesHandler` 가 요청마다:
 *     ① `reviewQueueCounts` — 전체+상태별 9개 `count()` 집계를 매번 새로 낸다.
 *     ② 프로그램 필터 + 첫 페이지(커서 없음)일 때 `canonicalProgramId==="view-cpm"` 태그 행을
 *        최대 1000건(`PORTAL_ALIAS_PROGRAM_SPLICE_SCAN_CAP`) 스캔해 별칭 해석 스플라이스를 매번
 *        새로 낸다.
 *   둘 다 요청마다 **같은 질문을 반복해서** 묻는 구조라, 두 비용이 한 콜러블 호출 안에 동기적으로
 *   누적돼 12~15초 지연으로 이어졌다(functions/videoReviewStateCallables.ts 관찰 근거 주석).
 *
 * ■ 이 모듈이 하는 일
 *   두 결과를 프로세스 안에서만 사는 5분 TTL 로 캐싱한다. 이 값들은 **운영자 계정과 무관하게
 *   같은 답**이다(역할은 상위에서 이미 게이트됐고, 응답 자체는 누가 묻든 갈리지 않는다) —
 *   그래서 videoReviewSignalCache.ts 의 "캐시 키에 인증 스코프가 필수" 규율과 달리 스코프 없이
 *   공유한다. 여러 운영자가 동시에 `/flu/scp` 를 열어도 전체 프로세스에서 최대 1회만 낸다.
 *
 * ■ 정확성 — review-state 문서를 쓰는 모든 경로가 이 무효화를 불러야 한다
 *   review-state(`scp_video_review_state`) 문서의 `state`·`canonicalProgramId` 를 실제로 바꾸는
 *   쓰기는 아래 **세 경로**에 있다 — 하나의 공용 경유지로 합류하지 않는다(적대 리뷰 정정: 이전
 *   버전은 "판정 스토어 함수 하나로 전부 지나간다"고 적었는데, 아래 ②를 놓친 오류였다):
 *     ① `transitionVideoReviewDecision`(functions/videoReviewTransitionStore.ts) — 사람 판정
 *        (videoReviewTransitionCallables.ts)·AI 자동 판정(videoReviewAnalysisJudge.ts)·시트
 *        동기화(scpSheetReviewSync.ts)·포털 통합 이벤트(scpIntegrationEventV2.ts)가 전부 이
 *        하나의 스토어 함수를 통해서만 판정을 커밋한다. `state` 만 바꾸고 `canonicalProgramId`
 *        는 건드리지 않는다.
 *     ② `reserveAndUpsertVideoRevision`(functions/scpVideoRevisionIngress.ts) — 포털 리비전
 *        수집(신규 제출·철회)이 매 `accept` 결과마다 `canonicalProgramId`·(제출이면) `state`를
 *        직접 `transaction.set(stateRef, patch, {merge:true})` 로 쓴다. ①을 거치지 않는다.
 *     ③ `ingestScpIntegrationEventV2`(functions/scpIntegrationEventV2.ts) — v2 제출·새 리비전과
 *        중복 이벤트의 canonical graph 수리가 review-state 를 직접 생성하거나 갱신한다.
 *   세 경로 모두 커밋 직후 영향받은 스코프를 무효화한다. 스코프가 바뀌는 수집 경로는 이전·이후
 *   스코프를 함께 전달한다. `invalidateReviewQueueCachesForWrite` 가 저수준 진입점이다(트랜잭션 형태가 서로
 *   너무 달라 Firestore 쓰기 자체를 공용 헬퍼로 묶지는 않았다 — 무효화 호출만 하나로 모았다).
 *
 * ■ 왜 통째로 비우지 않고 영향받는 키만 비우는가
 *   배지는 `(programId, campaignId)` 필터 조합별로 캐시된다. 한 문서의 쓰기가 바꿀 수 있는 건
 *   정확히: (a) 무필터("", "") 버킷(전체 합계는 어느 행이 바뀌어도 변한다), (b) 그 문서의
 *   canonicalProgramId 별칭 집합에 해당하는 programId 필터 버킷(SCP 는 `scp`/
 *   `pg-super-creator-partners` 둘 다, 그 외는 자기 자신 하나뿐 — scpProgramAlias.ts 가 유일한
 *   출처), (c) 그 문서의 `subject.campaignId` 와 일치하는 campaignId 필터 버킷. 이 조합 밖의
 *   캐시 항목은 이 쓰기로 절대 달라지지 않으므로 살려 둔다 — 판정보다 조회가 훨씬 잦은 화면이라
 *   전량 재계산을 강제하면 그만큼 히트율을 깎는다.
 *   스플라이스는 쓰기 전·후 `canonicalProgramId` 중 포털 전역 태그(view-cpm)가 있으면 비운다.
 *   그 태그로 들어오는 행과 실제 프로그램 id 로 나가는 행 모두 스캔 집합을 바꿀 수 있다.
 *
 * ■ 프로세스 캐시의 한계를 숨기지 않는다
 *   Functions 인스턴스는 여러 개이고 언제든 죽는다. 이 캐시는 **적중하면 이득, 아니면 현행 그대로**
 *   인 최적화지 보장이 아니다(videoReviewSignalCache.ts 와 같은 판단·형상). 다른 인스턴스에서 낸
 *   쓰기는 이 인스턴스의 캐시를 못 비우므로, 최악은 "배지가 최대 5분 늦다" — 그 값 자체는 이미
 *   `REVIEW_VIDEO_SIGNAL_TTL_MS`(videoReviewSignalCache.ts)가 목록 배지에 적용하는 것과 같은 TTL
 *   축이다.
 *
 * ■ 무필터("전체") 버킷만 TTL 이 짧다 — 캐시를 아예 안 타는 게 아니다(2026-09-11 절충)
 *   `invalidateReviewQueueCachesForWrite` 는 이 프로세스가 아는 **세 쓰기 경로**(전이·v3 수집·v2 수집)만
 *   부를 수 있다. e2e 시드·백필 스크립트·관리 콘솔의 직접 Firestore 쓰기처럼 이 경로들을 거치지
 *   않는 대량 쓰기는 이 프로세스에 무효화 신호를 낼 방법이 구조적으로 없다 — 무필터 버킷은 정확히
 *   이 "직접 대량 쓰기 → 즉시 조회" 패턴에 가장 노출돼 있다(테스트뿐 아니라 실 운영의 백필도 같은
 *   모양). 그렇다고 무필터를 아예 캐시하지 않으면(2026-09-11 오전 시도) 가장 흔한 뷰의 매 요청마다
 *   9-count() 집계를 강제해 이 모듈이 애초에 없애려던 12~15초 지연을 그 뷰에서만 되살린다 — 과잉
 *   수리였다.
 *   절충: 무필터("", "") 버킷은 `REVIEW_QUEUE_UNFILTERED_TTL_MS`(20초)라는 훨씬 짧은 자체 TTL 로
 *   여전히 캐시한다 — 앱 쓰기 경로의 무효화 신호는 그대로 받되(전이·수집 직후 즉시 비워짐), 신호가
 *   안 오는 직접 쓰기라도 20초 안에는 수렴한다. 필터 있는 버킷(programId·campaignId 중 하나라도
 *   있음)은 스플라이스 스캔(최대 1000건)이 실제로 걸리는 쪽이라 히트 이득이 훨씬 크므로 그대로
 *   5분을 유지한다. `createTtlCache` 가 엔트리별 TTL 을 지원하지 않으므로 무필터 버킷은 별도
 *   캐시 인스턴스(`queueCountsUnfilteredCache`)로 분리한다.
 */

import {
  cacheStats,
  createTtlCache,
  readThroughTtlCache,
  resetTtlCache,
  type TtlCache,
} from "./videoReviewSignalCache";
import { scpProgramIdentitySet } from "./scpProgramAlias";
import { isReviewStatePortalAliasProgramId } from "./reviewStateProgramResolution";

/** 필터 있는 버킷(programId·campaignId 중 하나라도 있음)의 배지 캐시 TTL — 5분. */
export const REVIEW_QUEUE_COUNTS_TTL_MS = 5 * 60_000;

/**
 * 무필터("", "") 버킷의 배지 캐시 TTL — 20초(모듈 헤더 "무필터 버킷만 TTL 이 짧다" 참조).
 * 앱 쓰기 경로(전이·수집)의 무효화는 그대로 즉시 적용되고, 이 TTL 은 그 무효화가 안 닿는
 * 직접 Firestore 쓰기(시드·백필)에 대한 상한선일 뿐이다.
 */
export const REVIEW_QUEUE_UNFILTERED_TTL_MS = 20_000;

/** 포털 별칭(view-cpm) 스플라이스 스캔 캐시 TTL — 필터 버킷과 같은 축, 5분. */
export const REVIEW_QUEUE_PORTAL_ALIAS_SPLICE_TTL_MS = 5 * 60_000;

// programId × campaignId 조합 상한 — 큐 화면의 실제 필터 조합 수보다 넉넉하다(무한 성장만 막는다).
const REVIEW_QUEUE_COUNTS_MAX_ENTRIES = 256;

const queueCountsCache = createTtlCache<Promise<unknown>>(
  "review_queue_counts",
  REVIEW_QUEUE_COUNTS_TTL_MS,
  REVIEW_QUEUE_COUNTS_MAX_ENTRIES,
);

// 무필터 버킷은 키가 정확히 하나("", "")뿐이다 — 상한은 1이면 충분하다.
// `createTtlCache` 가 엔트리별 TTL 을 지원하지 않으므로, 짧은 TTL 을 쓰려면 별도 인스턴스가 필요하다.
const queueCountsUnfilteredCache = createTtlCache<Promise<unknown>>(
  "review_queue_counts_unfiltered",
  REVIEW_QUEUE_UNFILTERED_TTL_MS,
  1,
);

// 스플라이스 스캔은 programId 로 갈리지 않는다(원본 스캔 자체가 프로그램 무관 — 매칭은 호출부가
// 스캔 결과 위에서 한다) — 키 1개만 쓴다.
const portalAliasSpliceCache = createTtlCache<Promise<unknown>>(
  "review_queue_portal_alias_splice",
  REVIEW_QUEUE_PORTAL_ALIAS_SPLICE_TTL_MS,
  1,
);

const PORTAL_ALIAS_SPLICE_KEY = "portal_alias_splice";

/** 길이 접두사라 조각 안에 구분자가 있어도 다른 키와 섞이지 않는다(videoReviewSignalCache.ts 와 같은 규칙). */
function token(value: string): string {
  return `${value.length}:${value}`;
}

function countsKey(programId: string, campaignId: string): string {
  return `${token(programId)}|${token(campaignId)}`;
}

/**
 * 배지 9개 `count()` 집계를 읽기-통과 캐시한다. review-state 쓰기 직후
 * `invalidateReviewQueueCachesForWrite` 가 영향받는 키만 비운다.
 * 캐시 히트/미스는 **즉시**(await 없이) 알 수 있다 — `readThroughTtlCache` 가 프라미스를 담을 뿐,
 * 담긴 프라미스의 완료는 기다리지 않는다.
 *
 * 무필터("", "") 요청은 `queueCountsUnfilteredCache`(20초 TTL)를, 필터가 하나라도 있으면
 * `queueCountsCache`(5분 TTL)를 탄다 — 모듈 헤더 "무필터 버킷만 TTL 이 짧다" 참조.
 */
export function cachedReviewQueueCounts<T>(
  programId: string,
  campaignId: string,
  load: () => Promise<T>,
  nowMs: number = Date.now(),
): { value: Promise<T>; cacheHit: boolean } {
  const cache = programId || campaignId ? queueCountsCache : queueCountsUnfilteredCache;
  return readThroughTtlCache(
    cache as unknown as TtlCache<Promise<T>>,
    countsKey(programId, campaignId),
    load,
    nowMs,
  );
}

/** 포털 별칭(view-cpm) 태그 최대 1000건 스캔 결과를 읽기-통과 캐시한다. */
export function cachedPortalAliasSpliceSnapshot<T>(
  load: () => Promise<T>,
  nowMs: number = Date.now(),
): { value: Promise<T>; cacheHit: boolean } {
  return readThroughTtlCache(
    portalAliasSpliceCache as unknown as TtlCache<Promise<T>>,
    PORTAL_ALIAS_SPLICE_KEY,
    load,
    nowMs,
  );
}

/**
 * review-state 문서 1건의 `canonicalProgramId`·`state` 를 실제로 바꾼 쓰기 직후 호출하는 **유일한
 * 저수준 무효화 진입점**(모듈 헤더 "정확성" 참조) — `transitionVideoReviewDecision`
 * (videoReviewTransitionStore.ts) 과 두 수집 경로가 직접 또는 committed-scope 헬퍼로 여기를 부른다.
 *
 * @param writtenCanonicalProgramId 이번 쓰기 이후 그 문서의 `canonicalProgramId` 값.
 * @param writtenCampaignId 이번 쓰기 이후 그 문서의 `subject.campaignId` 값(없으면 `""`).
 */
export function invalidateReviewQueueCachesForWrite(
  writtenCanonicalProgramId: string,
  writtenCampaignId: string,
): void {
  // 적대 리뷰 2026-09-11 [LOW]: 별칭 확장은 scpProgramAlias.ts 의 scpProgramIdentitySet 이 유일한
  // 출처다 — videoReviewStateCallables.ts 의 쿼리 스코프(reviewStateIdentityProgramIds)도 같은
  // 함수를 쓴다(판정 fork 금지, 이 파일 헤더 "왜 통째로 비우지 않고" 참조).
  const programIds = ["", ...scpProgramIdentitySet(writtenCanonicalProgramId)];
  const campaignIds = writtenCampaignId ? ["", writtenCampaignId] : [""];
  for (const programId of programIds) {
    for (const campaignId of campaignIds) {
      const key = countsKey(programId, campaignId);
      // 무필터("", "") 조합은 별도 캐시 인스턴스(20초 TTL)에 산다 — 나머지는 필터 캐시(5분 TTL).
      const cache = programId || campaignId ? queueCountsCache : queueCountsUnfilteredCache;
      cache.entries.delete(key);
    }
  }
  // 스캔이 담는 건 정확히 "canonicalProgramId === 포털 별칭" 인 행의 집합이다 — 그 태그로의 쓰기만
  // 그 집합을 바꿀 수 있다. 판정(①)은 canonicalProgramId 를 안 건드리므로 여기 거의 안 걸린다.
  if (isReviewStatePortalAliasProgramId(writtenCanonicalProgramId)) {
    portalAliasSpliceCache.entries.delete(PORTAL_ALIAS_SPLICE_KEY);
  }
}

export type ReviewQueueCacheInvalidationScope = Readonly<{
  canonicalProgramId: string;
  campaignId: string;
}>;

/**
 * A rewrite can move one review-state row between scopes, for example from the Portal alias
 * (`view-cpm`) to the resolved program id. Invalidate both the prior membership and the committed
 * membership, while keeping the low-level invalidator targeted.
 */
export function invalidateReviewQueueCachesForCommittedWriteScopes(
  scopes: Iterable<ReviewQueueCacheInvalidationScope>,
): void {
  const seen = new Set<string>();
  for (const scope of scopes) {
    const canonicalProgramId = scope.canonicalProgramId || "";
    const campaignId = scope.campaignId || "";
    const key = countsKey(canonicalProgramId, campaignId);
    if (seen.has(key)) continue;
    seen.add(key);
    invalidateReviewQueueCachesForWrite(canonicalProgramId, campaignId);
  }
}

/**
 * COST-P0-006 관측용 — 건수뿐, 키도 값도 싣지 않는다. 앞 두 원소(`review_queue_counts`,
 * `review_queue_portal_alias_splice`)의 위치는 기존 호출부와의 호환을 위해 유지하고,
 * 무필터 캐시(`review_queue_counts_unfiltered`)는 셋째로 덧붙인다.
 */
export function reviewQueueCacheStats(): ReturnType<typeof cacheStats>[] {
  return [
    cacheStats(queueCountsCache),
    cacheStats(portalAliasSpliceCache),
    cacheStats(queueCountsUnfilteredCache),
  ];
}

/** 테스트 훅 — 회차 경계에서 캐시를 통째로 비운다. 프로드 경로에서는 부르지 않는다
 * (프로드는 항상 `invalidateReviewQueueCachesForWrite` 로 영향받는 키만 비운다). */
export function resetReviewQueueCaches(): void {
  resetTtlCache(queueCountsCache);
  resetTtlCache(queueCountsUnfilteredCache);
  resetTtlCache(portalAliasSpliceCache);
}
