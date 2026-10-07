// 같은 페이지 로드 안에서 **완전히 동일한 콜러블 요청**이 동시에 여러 번 뜨는 것을 한 번으로 합친다.
//
// 왜 필요한가 (COST-P0-006/011 대응 — 이 파일 자체가 비용 절감 룰 대응이다):
//   프로드 실측(2026-08-22) `/flu/influencers` 1회 로드 = 콜러블 15회 / ~18MB, `/chat` = ~98회 / ~20.7MB.
//   원인의 상당수는 "부모(라우트 로더)와 자식(화면 훅)이 같은 데이터셋을 각자 당긴다"였다.
//   live.tsx 에는 이미 요청 단위 in-flight 병합(overlappingInFlightKeys/reusableInFlightRequest)이
//   있지만 그것은 `load()` 호출 단위라, 드레인 루프(loadRemainingPages)처럼 로더를 직접 부르는
//   경로나 force 우회 경로는 덮지 못했다. 이 모듈은 **콜러블 호출 그 자체**를 합쳐 남은 구멍을 막는다.
//
// 안전 계약 (데이터 정합 파괴 금지):
//   - **진행 중(pending) 프라미스만** 공유한다. 완료된 응답을 캐싱하지 않으므로 "오래된 값이 다시
//     쓰이는" 상태가 존재할 수 없다 — TTL 캐시(live.tsx MEMORY_TTL_MS)와 역할이 겹치지 않는다.
//   - 수동 새로고침·강제 재요청은 `bypass: true` 로 언제나 새 네트워크 호출을 낸다(요구사항: 수동
//     새로고침 경로는 항상 강제 우회). 그때 새 프라미스가 등록되므로 뒤따르는 일반 요청은 그 최신
//     호출에 합류한다.
//   - **인증 스코프가 키에 들어간다**(callableDedupeKey 의 필수 3번째 인자). 계정/세대가 다르면 키가
//     다르므로 서로 다른 사용자의 요청이 합류하는 일이 **구조적으로** 불가능하다. 종전에는 키가
//     `name|payload` 뿐이라 "전환 시점에 invalidateCallableDedupe() 를 부른다"는 호출 규율이
//     유일한 방어선이었다 — 한 곳만 빠뜨려도 남의 응답을 받는 구조였다.
//   - `invalidateCallableDedupe()` 는 뮤테이션 직후처럼 "지금 진행 중인 응답조차 믿을 수 없는"
//     시점에 진행 중 항목을 등록 해제한다(이미 떠 있는 네트워크 호출을 취소하지는 않는다).
//     계정 전환 방어선이 아니라 **최적화**다 — 위 스코프 키가 그 역할을 대신한다.
//
// 개인정보(SEC-P0-009): 응답 본문을 보관하지 않고 프라미스 참조만 들고 있다가 settle 시 즉시
//   버린다. localStorage 등 영속 저장은 하지 않는다.

const pendingCallables = new Map<string, Promise<unknown>>();

/**
 * 페이로드를 키 순서에 무관한 결정적 문자열로 만든다. 데이터셋 페이지 페이로드는
 * `{cursor?, limit?, programId?, campaignId?}` 수준의 평평한 객체라 이 정도면 충분하고,
 * 중첩/배열도 재귀로 안전하게 처리한다(순환 참조는 페이로드에 존재하지 않는다).
 */
export function canonicalCallablePayload(value: unknown): string {
  if (value === undefined) return "u";
  if (value === null) return "n";
  if (Array.isArray(value)) return `a[${value.map(canonicalCallablePayload).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `o{${entries.map(([key, entryValue]) => `${key}:${canonicalCallablePayload(entryValue)}`).join(",")}}`;
  }
  if (typeof value === "string") return `s${value.length}:${value}`;
  return `${typeof value}:${String(value)}`;
}

/**
 * 콜러블 합류의 인증 스코프. `live.tsx` 의 LiveAuthScope(authScopeKey + generation)와 같은 축이며,
 * 화면 훅은 `useLive()` 의 `authScopeKey`/`authScopeGeneration` 을 그대로 넘긴다.
 */
export type CallableAuthScope = Readonly<{ authScopeKey: string | null; generation: number }>;

/** 스코프를 키 조각으로 만든다. 길이 접두사라 스코프 키에 구분자가 있어도 다른 스코프와 섞이지 않는다. */
export function callableAuthScopeToken(scope: CallableAuthScope): string {
  const key = scope.authScopeKey ?? "";
  return `${key.length}:${key}@${scope.generation}`;
}

/**
 * `scope` 는 선택 인자가 아니다. 넘기지 않으면 컴파일이 깨지므로, 새 호출부가 스코프를 빠뜨린 채
 * 계정 간 합류 가능한 키를 만드는 경로가 남을 수 없다(위 안전 계약 참고).
 */
export function callableDedupeKey(name: string, payload: unknown, scope: CallableAuthScope): string {
  return `${callableAuthScopeToken(scope)}|${name}|${canonicalCallablePayload(payload)}`;
}

/**
 * `key` 로 이미 진행 중인 호출이 있으면 그 프라미스를 그대로 돌려주고, 없으면 `run()` 을 한 번만
 * 실행한다. `bypass` 는 캐시가 아니라 **합류**를 건너뛴다 — 새 호출을 내고, 그 호출을 이후
 * 합류 대상으로 등록한다.
 */
export function dedupeCallable<T>(
  key: string,
  run: () => Promise<T>,
  options: { bypass?: boolean } = {},
): Promise<T> {
  if (!options.bypass) {
    const existing = pendingCallables.get(key);
    if (existing) return existing as Promise<T>;
  }
  const promise = run();
  pendingCallables.set(key, promise);
  const release = () => {
    // 사이에 다른(예: bypass) 호출이 같은 키를 덮었으면 그 최신 항목은 건드리지 않는다.
    if (pendingCallables.get(key) === promise) pendingCallables.delete(key);
  };
  promise.then(release, release);
  return promise;
}

/**
 * 진행 중 항목 전체를 등록 해제한다. 수동 새로고침처럼 "방금 낸 변경 이전 응답을 받으면 안 되는"
 * 시점의 **최적화 해제**용이다 — 계정 간 격리는 키의 스코프가 이미 보장한다(위 안전 계약).
 */
export function invalidateCallableDedupe(): void {
  pendingCallables.clear();
}

/** 테스트/진단용 — 현재 합류 대기 중인 키 수. */
export function pendingCallableCount(): number {
  return pendingCallables.size;
}
