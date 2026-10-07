// `/chat` 계정 보기 대화 목록(mailAccount-scoped listConversations)용 메모리 SWR 캐시 (+ in-flight 병합).
//
// 왜 ("/chat 이 계속 눈에 보이게 새로고침된다" 리포트 대응):
//   이 목록은 page.tsx 의 생 useEffect 가 마운트/스코프 변경 때마다 listConversations(limit 2000)를
//   직접 부르고, 응답이 올 때까지 목록 state 가 null 이라 화면이 매번 비었다가 차오른다. 탭을 오갈
//   때·orgContext 재검증으로 effect 가 다시 돌 때마다 동일. 이 레이어는 "캐시된 첫 페이지를 먼저
//   그리고 배경에서 재검증"해 그 플래시를 없앤다.
//
// 신선도 계약: live.tsx `MEMORY_TTL_MS`, partner-list-cache.ts 와 같은 60초. TTL 을 늘리지 않는다
//   — 신선하면 네트워크를 생략하고, 만료됐어도 값은 그대로 돌려줘 화면이 먼저 그려진 뒤 재검증된다
//   (SWR). 캐시되는 값은 **첫 페이지 + 그 페이지의 nextCursor** 뿐이다 — person 탭의 뒷 페이지
//   드레인 결과는 캐시에 쓰지 않으므로, 캐시 재사용 시 드레인이 저장된 커서부터 이어 받는다.
//
// 무효화 계약 (callable-dedupe.ts 와 같은 의미):
//   - "지금 진행 중인 응답조차 믿을 수 없는" 시점(requestDataRefresh → `flu:data-refresh`)에는
//     진행 중 합류를 끊고 값을 만료시킨다. 값을 통째로 지우지는 않는다 — 지우면 다음 마운트가 다시
//     빈 화면으로 시작해 SWR 의 목적이 사라진다. 만료된 값은 먼저 그려지되 반드시 배경 재검증으로
//     갱신된다.
//   - 무효화로 등록이 끊긴 요청이 뒤늦게 성공해도 캐시에 쓰지 않는다 — 뮤테이션 이전 스냅샷이
//     "최신"으로 되살아나는 것을 막는다.
//
// 스코프/개인정보(SEC-P0-009): 키는 호출부의 mailAccountViewScopeKey(테넌트·uid·viewAs·org·계정
//   id/상태·선택 계정이 모두 들어간다) + includeUnregistered 여부. 다른 인증 스코프의 행은 키가
//   달라 섞일 수 없다. 상대방 이메일 등 사람 식별 정보가 행에 있으므로 **메모리 캐시만** 둔다 —
//   영속 저장 없음.

export const CONVERSATION_LIST_CACHE_TTL_MS = 60_000;

type ConversationListCacheEntry = { value: unknown; storedAt: number };

const MAX_CONVERSATION_LIST_CACHE_SIZE = 8;
const conversationListValues = new Map<string, ConversationListCacheEntry>();
const conversationListInFlight = new Map<string, Promise<unknown>>();

function capConversationListCache(): void {
  while (conversationListValues.size > MAX_CONVERSATION_LIST_CACHE_SIZE) {
    const oldestKey = conversationListValues.keys().next().value;
    if (oldestKey === undefined) break;
    conversationListValues.delete(oldestKey);
  }
}

/**
 * 캐시 키. `scopeKey` 는 호출부(chat/page.tsx mailAccountViewScopeKey)가 이미 인증·viewAs·계정
 * 차원을 전부 담아 만들어 넘긴다 — 여기서는 같은 계정 보기 안의 두 가지 읽기(기본 / 미등록 포함
 * 관리자 보기)만 갈라 담는다.
 */
export function conversationListCacheKey(scopeKey: string, includeUnregistered: boolean): string {
  return `${scopeKey}::${includeUnregistered ? "unregistered" : "registered"}`;
}

export type ConversationListCachePeek<T> = { value: T; fresh: boolean };

/** 캐시에 있으면 즉시 돌려준다(만료됐어도 `fresh:false` 로 함께 알려 SWR 렌더에 쓰게 한다). */
export function peekConversationListCache<T>(
  key: string,
  nowMs = Date.now(),
): ConversationListCachePeek<T> | null {
  const entry = conversationListValues.get(key);
  if (!entry) return null;
  return { value: entry.value as T, fresh: nowMs - entry.storedAt < CONVERSATION_LIST_CACHE_TTL_MS };
}

/** 캐시로 그릴 수 있을 때 네트워크를 생략할지 판정. 순수 함수라 유닛 테스트로 계약을 고정한다. */
export function shouldSkipConversationListRead(
  cached: ConversationListCachePeek<unknown> | null,
): boolean {
  return cached !== null && cached.fresh;
}

/**
 * 네트워크 읽기 + 캐시 쓰기. 같은 키로 진행 중인 호출이 있으면 그 프라미스에 합류한다
 * (StrictMode 이중 effect·연속 effect 재실행을 한 번의 호출로 만든다). 성공 응답은 "이 요청이
 * 아직 in-flight 등록된 현재 세대일 때만" 캐시에 쓴다 — 사이에 invalidate 됐으면(뮤테이션 이전에
 * 시작된 읽기) 쓰지 않고 버린다.
 */
export function revalidateConversationListCache<T>(
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const pending = conversationListInFlight.get(key);
  if (pending) return pending as Promise<T>;
  let promise: Promise<T>;
  promise = Promise.resolve()
    .then(load)
    .then((value) => {
      if (conversationListInFlight.get(key) === promise) {
        conversationListValues.set(key, { value, storedAt: Date.now() });
        capConversationListCache();
      }
      return value;
    })
    .finally(() => {
      if (conversationListInFlight.get(key) === promise) conversationListInFlight.delete(key);
    });
  conversationListInFlight.set(key, promise);
  return promise;
}

/**
 * 무효화 = 값을 지우지 않고 **만료**시킨다. 만료된 값은 peek 이 fresh:false 로 돌려줘 SWR 재검증을
 * 강제한다(다음 마운트·effect 재실행이 반드시 다시 읽는다). 진행 중 합류 등록만 끊어, 이후 재검증이
 * 뮤테이션 이전 요청의 응답을 받는 일이 없게 한다(해당 요청의 지연 성공도 캐시에 쓰이지 않는다).
 */
export function invalidateConversationListCache(key?: string): void {
  if (key) {
    const entry = conversationListValues.get(key);
    if (entry) entry.storedAt = 0;
    conversationListInFlight.delete(key);
    return;
  }
  for (const entry of conversationListValues.values()) entry.storedAt = 0;
  conversationListInFlight.clear();
}

/** 테스트·계정 전환 등 메모리 자체를 비워야 할 때만 쓴다(무효화와 달리 표시용 값까지 버린다). */
export function clearConversationListCache(): void {
  conversationListValues.clear();
  conversationListInFlight.clear();
}

type ReconcilableConversationRow = { id: unknown };

type ReconcilableConversationState<Row extends ReconcilableConversationRow> = {
  scopeKey: string;
  rows: Row[];
  nextCursor: string | null;
  // "이전 대화 더 보기"로 꼬리가 이어붙었는지 — 리뷰 수리(9de0a32f 후속): 예전엔 이걸
  //   `rows.length > firstPageSize(100)` 로 추론했는데, functions/read.ts 의
  //   MAX_HIDDEN_PAGE_SCAN_PAGES 백필 상한 때문에 org-sparse 관리자 보기 같은 곳은 nextCursor 가
  //   있어도 첫 페이지가 100행보다 짧게 올 수 있다(예: 60행+로드모어 40행=100행 → 100>100 은
  //   false). 그 케이스에서 "확장 아님"으로 오판해 배경 재검증이 꼬리·깊은 커서를 지워버렸다.
  //   이제 호출부가 로드모어를 실제로 했는지를 명시적으로 들고 있다가 여기 그대로 넘긴다.
  extendedByLoadMore: boolean;
  // 첫 페이지 구성 시점의 rows.length(머리 길이). 상수 대신 이 값으로 꼬리를 잘라낸다 — 서버가
  //   준 첫 페이지가 몇 행이었든(위 이유로 100보다 짧아도) 정확히 그 경계에서 꼬리를 보존한다.
  headLength: number;
};

/**
 * 78ead27e 회귀 수리 + 9de0a32f 후속(리뷰 MAJOR 수리): 계정 보기 목록의 배경 재검증(포커스 복귀
 * TTL 재검증·flu:data-refresh)이 "이전 대화 더 보기"로 이어붙인 꼬리를 그냥 지워버리고 커서까지
 * 1페이지로 역행시키던 결함을 고친다. 순수 함수라 React 하네스 없이 유닛 테스트로 계약을
 * 고정한다.
 *
 * - 아직 첫 페이지만 있으면(`current` 없음·스코프 다름·`current.extendedByLoadMore`가 false)
 *   그냥 `next`로 교체한다 — 커서도 `next.nextCursor`.
 * - "이전 대화 더 보기"로 확장된 상태면(`current.extendedByLoadMore`, 같은 스코프) 머리(첫
 *   페이지)만 `next.rows`로 새로 그리고, 그 뒤에 이어붙였던 꼬리(`current.rows.slice(current.
 *   headLength)`) 중 새 머리에 없는 행만(id 기준 dedupe) 순서 그대로 살려 붙인다. 커서는
 *   `current.nextCursor`(더 깊은 커서)를 그대로 유지한다 — `next.nextCursor`로 역행시키면 다음
 *   재검증이 이미 가진 페이지를 또 요청하게 된다. `extendedByLoadMore`/`headLength`는 결과에도
 *   이어 붙는다(머리 길이는 이제 `next.rows.length`, 확장 상태는 true 유지) — 다음 재검증도 같은
 *   방식으로 꼬리를 보존해야 하기 때문이다.
 * - 이 함수는 "이전 대화 더 보기" 자체를 자동으로 돌리지 않는다(자동 드레인 아님) — 이미 로드된
 *   꼬리를 배경 재검증이 지우지 않게 보존만 한다(tests/w108-person-drain.test.mjs 의 자동 드레인
 *   금지 pin 과 배치되지 않는다).
 * - 받아들이는 트레이드오프: 최근 활동으로 어떤 행이 새 머리 윈도우 밖으로 밀려나면(머리에도
 *   없고 살아있는 꼬리 슬라이스에도 없으면) 다음 "이전 대화 더 보기"나 새로고침 전까지는 잠깐
 *   화면에서 사라질 수 있다 — 의도된 동작이니 이후 리뷰어가 다시 "버그"로 고치지 않도록 남긴다.
 */
export function reconcileRevalidatedConversations<
  Row extends ReconcilableConversationRow,
  State extends ReconcilableConversationState<Row>,
>(current: State | null, next: State): State {
  const extended = Boolean(current)
    && current!.scopeKey === next.scopeKey
    && current!.extendedByLoadMore;
  if (!extended) return next;
  const headIds = new Set(next.rows.map((row) => String(row.id)));
  const retainedTail = current!.rows
    .slice(current!.headLength)
    .filter((row) => !headIds.has(String(row.id)));
  return {
    ...next,
    rows: [...next.rows, ...retainedTail],
    nextCursor: current!.nextCursor,
    extendedByLoadMore: true,
    headLength: next.rows.length,
  };
}

// 뮤테이션 갱신 신호(requestDataRefresh → "flu:data-refresh")는 이 캐시도 같은 시점에 만료시킨다 —
//   live.tsx 가 같은 이벤트에 invalidateCallableDedupe() 로 진행 중 합류를 끊는 것과 같은 의미다.
//   모듈 등록 시점에 걸어 두면 /chat 모듈이 한 번이라도 로드된 세션에서는 다른 화면에서 발생한
//   뮤테이션도 잡힌다(캐시가 비어 있던 세션이면 만료시킬 값 자체가 없어 무해). 노드 테스트 환경에는
//   window 가 없어 등록되지 않는다.
if (typeof window !== "undefined") {
  window.addEventListener("flu:data-refresh", () => invalidateConversationListCache());
}
