/**
 * **검수 탭 반복 조회 캐시** (W123, 비용 감사 2026-08-24).
 *
 * ■ 무엇이 문제였나 (프로드 형상 — 코드에서 센 값)
 *   `listScpVideoReviewStates` 는 목록/상세를 한 핸들러가 겸하고, **미리보기 전용 콜러블이 없다**.
 *   그래서 운영자가 제출 1건을 처리하는 동안 같은 답을 위해 같은 조회가 반복된다:
 *     ① 목록 진입 → 페이지 videoId 전량으로 YouTube `videos.list` 1회(가용성 3상 + 제목/채널).
 *     ② 그중 한 건을 열면 그 1건으로 `videos.list` 를 **또** 부른다(방금 목록에서 받은 값이다).
 *     ③ 상세 진입마다 `relatedHistory` 2쿼리 — 동일 영상 ≤7 + 크리에이터 ≤51 = **최대 58 read**.
 *     ④ 미리보기 버튼·판정 버튼·판정 직후 갱신이 전부 같은 상세 핸들러를 통째로 다시 돈다
 *        → ②③ 이 클릭마다 반복된다(제출 1건당 상세 하이드레이트 3~4회).
 *   즉 제출 1건 처리에 `relatedHistory` 만 170~230 read 가 **같은 답을 위해** 나간다.
 *
 * ■ 이 모듈이 하는 일
 *   프로세스 안에서만 사는 짧은 TTL 읽기-통과 캐시다. 호출부(`videoReviewStateCallables`)는
 *   **얇게** 부르기만 한다 — 캐시 정책이 호출부에 흩어지지 않게 여기 한 곳에 둔다
 *   (W121 이 방금 만진 파일이라 그쪽 변경면을 최소로 유지하는 목적도 겸한다).
 *
 * ■ 규범 축
 *   - **캐시 키에 인증 스코프가 필수다** — `reviewCacheKey(name, scope, parts)` 의 `scope` 는
 *     선택 인자가 아니다. `src/lib/callable-dedupe.ts` 의 `callableDedupeKey(name, payload, scope)`
 *     와 같은 규율이다: 넘기지 않으면 컴파일이 깨지므로 계정 간 합류 가능한 키를 만드는 경로가
 *     남을 수 없다. 검수 큐는 실제로는 역할 단위 공용 데이터라 스코프를 넣으면 운영자 간 공유가
 *     사라지지만, **지배적인 패턴은 한 운영자의 왕복**(위 ①~④)이라 히트율 손실이 거의 없다.
 *     그 대가로 "남의 응답을 받는" 형상이 구조적으로 불가능해진다 — 싸게 사는 안전이다.
 *   - COST-P0-006: 히트 · 미스 · **우회** · 외부호출 수를 호출부가 한 줄 로그로 남긴다(`cacheStats`).
 *     우회(`bypasses`)는 미스와 **다른 칸**이다 — 상세 진입은 정책상 항상 캐시를 안 읽는데 그것을
 *     미스로 세면 누적 스냅샷이 "캐시가 안 듣는다"로 읽힌다(적대 리뷰 §4.11).
 *   - SEC-P0-009: 이 모듈은 **키와 건수만** 다룬다. 값은 프로세스 메모리에만 있고 로그·Firestore
 *     로 나가지 않는다. 키에 들어가는 것은 videoId·문서 id·세대값뿐이다(평문 PII 없음).
 *   - **판정이 걸린 진입은 캐시를 타지 않는다**(W123 적대 리뷰 H3): 상세 요청은 가용성 캐시를
 *     우회해 매번 재검증한다. 감지가 목적인 값은 TTL 을 짧게 잡는 것으로 정당화되지 않는다 —
 *     캐시를 **읽지 않는 것**이 정답이고, TTL 은 판정이 걸리지 않은 목록 배치만 덮는다.
 *   - 정확성: 여기 담기는 값은 **화면 표시·큐 필터 전용**이다. 판정·발송·원장에 들어가는 값은
 *     담지 않는다. 특히 결과메일 미리보기는 캐시된 `videos.list` 제목을 쓰지 않는다 —
 *     그 경로는 저장된 `videos` 문서만 본다(videoReviewStateCallables 의 "적대 리뷰 H2 · R1" 주석).
 *     수신자 해석·발송 게이트 조회는 이 모듈이 손대지 않는다.
 *   - **실패는 캐시하지 않는다**: 판정이 확정된 값만 담는다(`unknown` 가용성은 API 장애의 결과라
 *     담으면 복구를 TTL 동안 못 본다).
 *
 * ■ 프로세스 캐시의 한계를 숨기지 않는다
 *   Functions 인스턴스는 여러 개이고 언제든 죽는다. 이 캐시는 **적중하면 이득, 아니면 현행 그대로**
 *   인 최적화지 보장이 아니다(`ownerDisplayProjection` 의 members 색인 캐시와 같은 판단·형상).
 *   미스 경로는 종전 코드 그대로라 정확성이 캐시 적중 여부에 의존하지 않는다.
 */

/** TTL 캐시 1개의 상태. 값은 그대로 담는다 — 프라미스를 담고 싶으면 `TtlCache<Promise<T>>` 다. */
export type TtlCache<T> = {
  readonly name: string;
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly entries: Map<string, { readonly at: number; readonly value: T }>;
  hits: number;
  misses: number;
  /**
   * **일부러 캐시를 읽지 않은 조회 수**(= `bypassCache`). 미스와 반드시 분리한다.
   *
   * 미스는 "캐시가 못 맞혔다"는 신호라 히트율의 분모다. 우회는 그 반대 — 정책상 물어보지 않은
   * 것이라 캐시의 성능과 무관하다. 이 둘을 한 칸에 합치면 상세 진입(항상 우회)이 미스로 잡혀
   * 누적 스냅샷이 "캐시가 안 듣는다"로 보인다. 실제로는 목록 배치가 전량 히트하고 있어도 그렇다
   * (W123 적대 리뷰 §4.11 — 이 분리가 선행돼야 §4.10 unavailable 오반려 관측을 판정할 수 있다).
   */
  bypasses: number;
  evictions: number;
};

/**
 * 캐시 1개를 만든다.
 *
 * `maxEntries` 는 폭주 방지 캡이다. 한 인스턴스가 오래 살면서 큐 전량을 훑으면 항목이 쌓이는데
 * TTL 만으로는 "만료됐지만 아무도 다시 조회하지 않은" 항목이 계속 남는다 — 상한을 넘으면 만료분을
 * 먼저 걷고, 그래도 넘치면 가장 오래된 것부터 버린다(Map 은 삽입 순서를 유지한다).
 */
export function createTtlCache<T>(
  name: string,
  ttlMs: number,
  maxEntries: number,
): TtlCache<T> {
  return {
    name,
    ttlMs,
    maxEntries,
    entries: new Map(),
    hits: 0,
    misses: 0,
    bypasses: 0,
    evictions: 0,
  };
}

/** 테스트·회차 경계에서 캐시를 비운다(통계까지 초기화한다). */
export function resetTtlCache<T>(cache: TtlCache<T>): void {
  cache.entries.clear();
  cache.hits = 0;
  cache.misses = 0;
  cache.bypasses = 0;
  cache.evictions = 0;
}

/** COST-P0-006 관측용 스냅샷. 건수뿐이다 — 키도 값도 싣지 않는다. */
export function cacheStats<T>(cache: TtlCache<T>): {
  cache: string;
  hits: number;
  misses: number;
  bypasses: number;
  entries: number;
  evictions: number;
} {
  return {
    cache: cache.name,
    hits: cache.hits,
    misses: cache.misses,
    bypasses: cache.bypasses,
    entries: cache.entries.size,
    evictions: cache.evictions,
  };
}

/** 살아 있는 항목이면 값을, 없거나 만료면 `undefined`. 통계는 건드리지 않는다(집계는 호출부 몫). */
function freshEntry<T>(cache: TtlCache<T>, key: string, nowMs: number): T | undefined {
  const entry = cache.entries.get(key);
  if (!entry) return undefined;
  if (nowMs - entry.at >= cache.ttlMs) {
    cache.entries.delete(key);
    return undefined;
  }
  return entry.value;
}

function putEntry<T>(cache: TtlCache<T>, key: string, value: T, nowMs: number): void {
  cache.entries.set(key, { at: nowMs, value });
  if (cache.entries.size <= cache.maxEntries) return;
  for (const [candidate, entry] of cache.entries) {
    if (nowMs - entry.at < cache.ttlMs) continue;
    cache.entries.delete(candidate);
    cache.evictions += 1;
  }
  // 만료분을 걷고도 넘치면 오래된 순으로 버린다(Map 삽입 순서 = 최초 적재 순서).
  for (const candidate of cache.entries.keys()) {
    if (cache.entries.size <= cache.maxEntries) break;
    cache.entries.delete(candidate);
    cache.evictions += 1;
  }
}

/**
 * 키가 살아 있으면 그 프라미스를, 없으면 `load()` 를 **한 번만** 실행해 담는다.
 *
 * 진행 중 프라미스를 담으므로 같은 인스턴스에 동시에 들어온 호출도 한 번으로 합쳐진다
 * (`callable-dedupe` 의 in-flight 합류와 같은 효과). 실패한 프라미스는 **담아 두지 않는다** —
 * 남기면 TTL 동안 같은 에러를 계속 돌려주고 그 사이 정상 복구를 못 본다.
 */
export function readThroughTtlCache<T>(
  cache: TtlCache<Promise<T>>,
  key: string,
  load: () => Promise<T>,
  nowMs: number = Date.now(),
): { value: Promise<T>; cacheHit: boolean } {
  const existing = freshEntry(cache, key, nowMs);
  if (existing) {
    cache.hits += 1;
    return { value: existing, cacheHit: true };
  }
  cache.misses += 1;
  const value: Promise<T> = load().catch((error: unknown) => {
    if (cache.entries.get(key)?.value === value) cache.entries.delete(key);
    throw error;
  });
  putEntry(cache, key, value, nowMs);
  return { value, cacheHit: false };
}

/**
 * 캐시 격리의 인증 스코프. 서버측 축은 클라이언트 `LiveAuthScope` 의 대응물인
 * `AuthContext`(shared.ts) 의 `{userId, role, gameId}` 다 — 계정·역할·테넌트가 다르면 키가 다르다.
 */
export type ReviewCacheAuthScope = Readonly<{
  userId: string;
  role: string;
  gameId: string;
}>;

/** 길이 접두사라 조각 안에 구분자가 있어도 다른 스코프와 섞이지 않는다(callable-dedupe 와 같은 규칙). */
function token(value: string): string {
  return `${value.length}:${value}`;
}

export function reviewCacheScopeToken(scope: ReviewCacheAuthScope): string {
  return `${token(scope.userId)}/${token(scope.role)}/${token(scope.gameId)}`;
}

/**
 * 캐시 키. `scope` 는 선택 인자가 아니다 — 빠뜨리면 컴파일이 깨진다(위 규범 축 참조).
 * `parts` 에는 대상 식별자와 **세대값**을 넣는다. 세대값이 들어가면 그 문서가 바뀌는 순간 키가
 * 달라지므로 별도 무효화 호출 없이 캐시가 자동으로 갈린다.
 */
export function reviewCacheKey(
  name: string,
  scope: ReviewCacheAuthScope,
  parts: readonly string[],
): string {
  return `${name}|${reviewCacheScopeToken(scope)}|${parts.map(token).join("|")}`;
}

/**
 * **YouTube `videos.list` 신호 캐시의 TTL — 5분. 단, 판정이 걸린 경로는 캐시를 타지 않는다.**
 *
 * ■ 먼저: 감지가 목적인 값에 TTL 을 고르는 것은 **논증이 될 수 없다**
 *   가용성(`available`/`unavailable`)의 용도는 죽은 링크 감지다. 감지가 목적인 값은 원칙적으로
 *   캐싱 대상이 아니다 — "몇 분까지는 못 봐도 된다"고 말할 수 있는 값이 아니기 때문이다.
 *   그래서 이 TTL 은 **감지 경로를 지키는 근거가 아니다**. 감지 경로는 TTL 이 아니라 **우회**로
 *   지킨다: 상세(`detailId`) 요청은 `bypassCache` 로 캐시를 읽지 않고 매번 다시 검증한다
 *   (videoReviewStateCallables 의 W120 재검증 계약 · W123 적대 리뷰 H3).
 *   전이 콜러블에 서버측 가용성 확인이 없어 이 배지가 유일한 방어선이므로, 판정 직전 화면에
 *   TTL 만큼의 창을 여는 것은 **삭제된 영상을 승인하는 창**과 같은 말이다.
 *
 * ■ 그러면 이 5분은 무엇을 덮는가
 *   **목록 페이지의 배치 조회뿐이다.** 큐를 새로고침하거나 페이지를 오갈 때 같은 50건을 다시
 *   묻지 않는 것 — 판정이 걸리지 않은, 순수하게 배지를 그리기 위한 조회다. 여기서 5분 늦게
 *   반영되는 최악은 "큐 목록의 배지가 5분 늦다"이고, 그 제출을 실제로 열면 그 순간 재검증된다.
 *   값 자체는 사내 캐싱 TTL 규약(CLAUDE.md §14: LLM 1h · BQ 15m · 정책 10m) 중 가장 짧은 축인
 *   정책 10분보다 짧게 잡았다 — 목록 배지가 판정 화면보다 오래 낡아 있을 이유가 없다.
 *
 * 이 값이 미리보기·발송 문안에 새지 않는다는 점은 별도 축이다(모듈 헤더 "정확성").
 */
export const REVIEW_VIDEO_SIGNAL_TTL_MS = 5 * 60_000;

/**
 * **`relatedHistory` 캐시의 TTL — 45초.**
 *
 * ■ 세대 키가 덮지 못하는 축이 있다 (W123 적대 리뷰 H2)
 *   키에 들어가는 세대값은 **이 제출**의 `updatedAtIso#transitionSeq` 인데, 이 캐시가 담는 값은
 *   `youtubeVideoId`·`fluCreatorId` 로 조회한 **다른 문서들**의 집계다. 즉 자기 입력이 아니라
 *   그 옆의 값에 무효화가 걸려 있다. 지배적인 작업 순서에서 바로 깨진다:
 *     제출 B 열기(적재) → **같은 크리에이터의 제출 A 반려**(A 의 세대만 오름) → B 복귀 → 히트,
 *     방금 내린 A 반려가 TTL 만큼 안 보인다.
 *   그리고 이 배지는 정확히 그 상황을 위해 만든 것이다(W120: 파라미터만 바꾼 재제출 탐지 ·
 *   크리에이터 단위 반복 사유). 운영자는 크리에이터로 묶어 연속 처리하므로 이건 예외가 아니라 기본이다.
 *   따라서 **캐시가 담는 값 전부가 그 창 안**이다 — 세대 키는 "이 제출이 바뀌면 즉시 무효"라는
 *   보조 축일 뿐, 창의 길이를 정하는 것은 오로지 이 TTL 이다.
 *
 * ■ 그래서 판정 왕복 길이로 낮춘다 — 45초
 *   이 캐시가 실제로 없애야 하는 반복은 "상세 열기 → 미리보기 → 판정 → 판정 후 자동 재조회"라는
 *   **한 번의 왕복 안에서 같은 상세가 통째로 3~4회 재실행되는 것**(미리보기 전용 콜러블이 없어서
 *   생기는 구조적 중복)이다. 그 왕복은 수십 초 규모다. 45초면 그 중복은 전부 잡고, **다음 제출로
 *   넘어갈 때는 이미 만료**돼 옆 문서의 변경을 못 보는 창이 사실상 남지 않는다.
 *   10분 같은 값은 이 배지의 용도(방금 내린 판정을 옆 제출에서 즉시 보기)와 정면으로 충돌한다.
 *
 * 판정 근거인 `reviewHistorySummary`·`reviewLedger` 는 이 캐시를 타지 않는 라이브 값이다.
 */
export const REVIEW_RELATED_HISTORY_TTL_MS = 45_000;

/**
 * 항목 상한. 검수 큐는 프로드 실측 ~118행 규모라 한 인스턴스가 전량을 훑어도 여유가 있고,
 * 운영자 수만큼 스코프가 갈리는 것까지 감안한 값이다. 무한 성장만 막으면 된다.
 */
export const REVIEW_CACHE_MAX_ENTRIES = 512;

/**
 * 이 모듈이 들고 있는 **프로세스 전역 캐시 1개**. 담기는 값의 구체 타입은 호출부 제네릭이 정하는데
 * (신호 캐시의 `M`/`A`, 이력 캐시의 `T`) 캐시 자체는 그것을 알 수 없다 — 그래서 좁힘이 필요하다.
 *
 * M5 — 이 팩토리가 주는 것은 **한 곳으로 모음**이지 타입 안전이 아니다. 솔직히 적는다:
 *   · 내부는 `as unknown as TtlCache<U>` 다. 그건 대체한 `as TtlCache<…>` 보다 **더 강한** 탈출구다.
 *   · `U extends T` 제약도 여기서는 사실상 공허하다 — 이력 캐시는 `T = Promise<unknown>` 이라
 *     모든 `Promise<U>` 가 통과한다. 신호 캐시에서만 약하게 걸린다.
 *   그래서 이득은 하나뿐이고 그건 진짜다: **검증 없는 캐스트가 호출부마다 흩어지지 않고 이 한
 *   함수에만 있다.** 규칙이 깨지는지 보려면 여기만 읽으면 된다. 성립 근거는 캐시별 불변식이다 —
 *   **캐시 1개에 값 종류는 1개**이고(아래 두 인스턴스가 그 규율), 키에 캐시 이름이 들어가므로
 *   다른 캐시의 항목과 섞일 수 없다.
 */
export type ReviewCache<T> = TtlCache<T> & {
  view<U extends T>(): TtlCache<U>;
};

/** `REVIEW_CACHE_MAX_ENTRIES` 를 고정으로 물려 캐시 인스턴스마다 상한을 다시 적지 않게 한다. */
export function createReviewCache<T>(name: string, ttlMs: number): ReviewCache<T> {
  const cache = createTtlCache<T>(name, ttlMs, REVIEW_CACHE_MAX_ENTRIES);
  return Object.assign(cache, {
    view<U extends T>(): TtlCache<U> {
      return cache as unknown as TtlCache<U>;
    },
  });
}

/** videoId 1건분 캐시 값. 메타데이터가 없는 영상도 가용성은 있다(그래서 둘을 한 항목에 담는다). */
type VideoSignalEntry<M, A> = { readonly metadata: M | null; readonly availability: A };

const videoSignalCache = createReviewCache<VideoSignalEntry<unknown, string>>(
  "review_video_signals",
  REVIEW_VIDEO_SIGNAL_TTL_MS,
);

const relatedHistoryCache = createReviewCache<Promise<unknown>>(
  "review_related_history",
  REVIEW_RELATED_HISTORY_TTL_MS,
);

/** 테스트 훅 — 두 캐시를 모두 비운다. 프로드 경로에서는 부르지 않는다. */
export function resetReviewSignalCaches(): void {
  resetTtlCache(videoSignalCache);
  resetTtlCache(relatedHistoryCache);
}

/** COST-P0-006 관측 — 두 캐시의 누적 통계(건수뿐). */
export function reviewSignalCacheStats(): ReturnType<typeof cacheStats>[] {
  return [cacheStats(videoSignalCache), cacheStats(relatedHistoryCache)];
}

/**
 * **videoId 단위** `videos.list` 신호 캐시.
 *
 * 페이지 단위가 아니라 videoId 단위로 담는 것이 핵심이다 — 목록에서 받아 둔 50건 중 한 건을 열면
 * 상세는 **전량 히트**라 외부 호출이 0 이 된다. 페이지 단위로 담으면 목록 구성이 한 칸만 밀려도
 * 전부 미스가 된다.
 *
 * `load` 는 **미스인 id 만** 받는다(호출부의 배치 호출을 그대로 재사용한다). 미스가 0 이면
 * `load` 를 아예 부르지 않으므로 외부 호출도 0 이다.
 * `isCacheable` 이 false 인 가용성(= `unknown`, API 장애의 결과)은 담지 않는다.
 */
export async function cachedReviewVideoSignals<M, A extends string>(args: {
  readonly scope: ReviewCacheAuthScope;
  readonly videoIds: readonly string[];
  readonly load: (missing: readonly string[]) => Promise<{
    readonly metadata: ReadonlyMap<string, M>;
    readonly availability: ReadonlyMap<string, A>;
  }>;
  /** 담아도 되는 가용성 판정인가 — 확정 판정(available/unavailable)만 true 여야 한다. */
  readonly isCacheable: (availability: A) => boolean;
  /** 응답에 가용성이 빠진 id 의 값(호출부의 `unknown` 센티널). */
  readonly fallbackAvailability: A;
  /**
   * H3: **캐시를 읽지 않는다**(쓰기는 한다). 판정이 걸린 진입(상세)에서 재검증 계약을 지키는 축이다.
   * 쓰기를 유지하는 이유: 그 재검증 결과는 방금 확인한 최신값이라 뒤따르는 목록 배치가 그대로
   * 쓰는 편이 낫다 — 버리면 목록이 더 낡은 값을 다시 물어온다.
   *
   * 이 회차의 조회는 `misses` 가 아니라 `bypasses` 로 센다(§4.11). 캐시가 못 맞힌 게 아니라
   * 물어보지 않은 것이라 히트율의 분모가 아니다.
   */
  readonly bypassCache?: boolean;
  readonly nowMs?: number;
}): Promise<{
  metadata: Map<string, M>;
  availability: Map<string, A>;
  hits: number;
  misses: number;
  bypasses: number;
  apiCalls: number;
}> {
  const nowMs = args.nowMs ?? Date.now();
  const cache = videoSignalCache.view<VideoSignalEntry<M, A>>();
  const unique = [...new Set(args.videoIds.filter(Boolean))];
  const metadata = new Map<string, M>();
  const availability = new Map<string, A>();
  const missing: string[] = [];
  const bypassed = Boolean(args.bypassCache);
  let hits = 0;

  for (const videoId of unique) {
    const entry = bypassed
      ? undefined
      : freshEntry(cache, reviewCacheKey(cache.name, args.scope, [videoId]), nowMs);
    if (!entry) {
      missing.push(videoId);
      continue;
    }
    hits += 1;
    if (entry.metadata !== null) metadata.set(videoId, entry.metadata);
    availability.set(videoId, entry.availability);
  }
  cache.hits += hits;
  // 우회 회차는 캐시를 아예 읽지 않았으므로 미스가 아니다 — 섞으면 상세 진입 때문에 누적 미스가
  // 늘 부풀어 "캐시가 안 듣는다"로 보인다(§4.11: 이 분리가 §4.10 관측의 선행 조건이다).
  if (bypassed) cache.bypasses += missing.length;
  else cache.misses += missing.length;

  let apiCalls = 0;
  if (missing.length > 0) {
    const loaded = await args.load(missing);
    apiCalls = 1;
    for (const videoId of missing) {
      const loadedMetadata = loaded.metadata.get(videoId) ?? null;
      const loadedAvailability = loaded.availability.get(videoId) ?? args.fallbackAvailability;
      if (loadedMetadata !== null) metadata.set(videoId, loadedMetadata);
      availability.set(videoId, loadedAvailability);
      // 장애로 못 본 id 는 담지 않는다 — 담으면 TTL 동안 복구를 못 본다.
      if (!args.isCacheable(loadedAvailability)) continue;
      putEntry(
        cache,
        reviewCacheKey(cache.name, args.scope, [videoId]),
        { metadata: loadedMetadata, availability: loadedAvailability },
        nowMs,
      );
    }
  }
  return {
    metadata,
    availability,
    hits,
    misses: bypassed ? 0 : missing.length,
    bypasses: bypassed ? missing.length : 0,
    apiCalls,
  };
}

/**
 * 상세 1건의 `relatedHistory` 응답 캐시.
 *
 * `generation` 에는 그 제출의 변경을 나타내는 값(문서 `updatedAtIso` + 전이 시퀀스)을 넣는다 —
 * 운영자가 방금 내린 판정으로 문서가 바뀌면 키가 갈려 **즉시** 새로 조회된다(명시적 무효화 불필요).
 *
 * 왜 서버 응답 캐시이고 클라 측 메모가 아닌가: 이 값을 만드는 두 쿼리는 서버에만 있고
 * (SEC-P0-004 — 클라이언트는 Firestore 를 직접 못 읽는다), 반복을 만드는 것도 서버 왕복이다
 * (미리보기 전용 콜러블이 없어 상세 핸들러가 통째로 다시 도는 구조). 클라에 메모를 두면 화면
 * 컴포넌트마다 같은 규칙을 다시 구현해야 하고, 다른 진입 경로(다른 탭·새로고침)는 못 덮는다.
 */
export function cachedRelatedReviewHistory<T>(args: {
  readonly scope: ReviewCacheAuthScope;
  readonly detailId: string;
  readonly generation: string;
  readonly load: () => Promise<T>;
  readonly nowMs?: number;
}): { value: Promise<T>; cacheHit: boolean } {
  return readThroughTtlCache(
    relatedHistoryCache.view<Promise<T>>(),
    reviewCacheKey(relatedHistoryCache.name, args.scope, [args.detailId, args.generation]),
    args.load,
    args.nowMs ?? Date.now(),
  );
}
