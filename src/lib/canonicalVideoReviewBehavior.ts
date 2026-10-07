/**
 * Pure, client-safe behavior for the canonical review panel.
 * Keeping this independent of React makes cursor-loop handling executable in Node 22 tests.
 */
export type CursorAdvance = {
  nextCursor: string | null;
  seenCursors: Set<string>;
  error: string | null;
};

export function advanceCanonicalReviewCursor(input: {
  requestedCursor: string;
  receivedCursor: string | null;
  seenCursors: ReadonlySet<string>;
}): CursorAdvance {
  const seenCursors = new Set(input.seenCursors);
  seenCursors.add(input.requestedCursor);
  if (!input.receivedCursor)
    return { nextCursor: null, seenCursors, error: null };
  if (
    input.receivedCursor === input.requestedCursor ||
    input.seenCursors.has(input.receivedCursor)
  ) {
    return {
      nextCursor: null,
      seenCursors,
      error: "동일한 커서가 반복되어 추가 로딩을 중단했습니다.",
    };
  }
  seenCursors.add(input.receivedCursor);
  return { nextCursor: input.receivedCursor, seenCursors, error: null };
}

/**
 * 다타이틀 서버 필터가 생긴 뒤의 목록 요청 계약(task-88/89/90). data.ts 의 페이로드 타입은
 * 이 변경의 편집 범위 밖이라 — 이 타입으로 선언한 값을 넘기면 구조적 타이핑이 titleId 를
 * 그대로 통과시킨다(객체 리터럴 직접 전달은 초과 프로퍼티 검사에 걸린다).
 * 서버 계약: functions/videoReviewStateCallables.ts 의 titleId 유계 스캔 — 필터가 걸려도
 * nextCursor 가 스캔 위치를 가리키므로 "추가 불러오기"가 필터된 스캔을 이어 받는다.
 */
export type CanonicalReviewListRequest = {
  limit?: number;
  cursor?: string;
  programId?: string;
  campaignId?: string;
  /** 레지스트리 타이틀 id — 비어 있으면 서버가 필터를 걸지 않는다. */
  titleId?: string;
  detailId?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-05 검수 탭 감사 F1/#5·#6 — 큐 배지 카운트 출처, 그리고 다타이틀 필터.
// 둘 다 순수 함수로 둔다: React 없이 노드 레인이 규칙을 직접 못 박을 수 있어야 한다
// (같은 파일의 커서 규칙과 같은 규율).
// ─────────────────────────────────────────────────────────────────────────────

/** 화면 배지 4칸. `queueBucketOf` 의 분류축과 1:1이다(changes_requested 는 반려 칸). */
export type ReviewQueueBucketCounts = {
  all: number;
  action: number;
  approved: number;
  rejected: number;
};

/** `listScpVideoReviewStates` 응답의 서버 집계(.count() 결과). 상세 요청이면 null 이다. */
export type ReviewQueueServerCounts = {
  action: number;
  changes_requested: number;
  approved: number;
  rejected?: number;
  all: number;
  /**
   * E2 (2026-09-06 Aside 게이트 후속): 프로그램 필터가 걸리면 이 집계는 canonicalProgramId 가
   * 아직 포털 별칭(view-cpm)으로 남은 행을 세지 못한다 — false 면 이 배지는 하한값이다
   * (functions/videoReviewStateCallables.ts reviewQueueCounts).
   */
  countsIncludeUnresolved?: boolean;
  /**
   * E2: 위 하한 격차를 메우려고 목록(states)에만 조인·합류된 행 수. 배지에는 안 잡히지만
   * 화면에는 보이는 행 — reviewQueueBadgeLowerBoundNote 가 이 값으로 안내 문구를 만든다.
   */
  portalAliasSplicedRowCount?: number;
} | null;

/**
 * E2 (2026-09-06 Aside 게이트 후속): 프로그램 필터가 걸려 있고 배지가 스스로 하한값이라고
 * 밝혔을 때만(countsIncludeUnresolved === false), 목록에만 있고 배지엔 없는 행 수를 안내한다.
 * 필터가 없거나(배지가 곧 전수), 격차가 0이면 조용히 넘어간다 — 없는 문제를 만들지 않는다.
 */
export function reviewQueueBadgeLowerBoundNote(input: {
  programFilterActive: boolean;
  countsIncludeUnresolved: boolean | undefined;
  portalAliasSplicedRowCount: number | undefined;
}): string | null {
  if (!input.programFilterActive) return null;
  if (input.countsIncludeUnresolved !== false) return null;
  const splicedCount = input.portalAliasSplicedRowCount ?? 0;
  if (splicedCount <= 0) return null;
  return `배지는 하한값 — 프로그램 미해석 행 ${splicedCount}건은 목록에만 포함`;
}

/**
 * 큐 배지에 쓸 카운트와 **그 출처**를 정한다.
 *
 * 배경(2026-09-05 적대 감사 F1): 배지는 서버가 이미 `.count()` 로 계산해 응답에 실어 보내는
 * 값을 쓰지 않고, 첫 페이지 50건을 클라에서 reduce 하고 있었다. 실측 총계 221건
 * (대기 30 / 승인 124 / 반려 67)에 대해 화면은 50 / 25 / 14 / 11 을 보여 줬다 — 승인은 110건,
 * 반려는 56건을 누락한 숫자다. 운영자가 화면 위쪽 굵은 숫자만 보고 백로그 규모를 오판한다.
 *
 * 다만 서버 집계는 **프로그램·캠페인 스코프까지만** 반영한다(콜러블이 그 두 축만 받는다).
 * 그래서 화면에만 있는 필터(타이틀·앱·검색·상태·링크/메일 필터)가 걸리면 서버 숫자는 그
 * 화면의 답이 아니다 — 그때는 불러온 페이지 기준으로 떨어지고 출처를 `loaded` 로 밝힌다.
 * "정확한 척"보다 "어느 모수인지 밝히기"가 규칙이다.
 *
 * Flu/Task-55: 최초 조회가 아직 끝나지 않았을 때(`loading`) loadedCounts는 항상 0으로 채워진
 * 초기값이라, 이 0을 그대로 배지에 실으면 "검수 대기 0건"처럼 실제로 로딩 중인 화면이 빈 결과로
 * 읽힌다. loading이면 다른 입력과 무관하게 counts를 null로 떨어뜨리고 출처를 `loading`으로
 * 밝힌다 — 호출부는 null일 때 숫자 대신 로딩 표시를 그린다.
 */
export function resolveReviewQueueBadgeCounts(input: {
  serverCounts: ReviewQueueServerCounts;
  loadedCounts: ReviewQueueBucketCounts;
  /** 서버가 모르는 화면 전용 필터가 하나라도 걸렸는가. */
  narrowedByClientFilters: boolean;
  /** 최초 목록 조회가 아직 진행 중인가. */
  loading: boolean;
}): { counts: ReviewQueueBucketCounts | null; source: "server" | "loaded" | "loading" } {
  if (input.loading) {
    return { counts: null, source: "loading" };
  }
  const server = input.serverCounts;
  if (!server || input.narrowedByClientFilters) {
    return { counts: input.loadedCounts, source: "loaded" };
  }
  const safe = (value: unknown): number =>
    Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0;
  return {
    counts: {
      all: safe(server.all),
      action: safe(server.action),
      approved: safe(server.approved),
      // changes_requested 는 화면에서 반려 칸에 합류한다(queueBucketOf 와 같은 분류).
      rejected: safe(server.rejected) + safe(server.changes_requested),
    },
    source: "server",
  };
}

/** 타이틀 필터 선택지 1개. 이름은 서버가 레지스트리에서 해석해 실어 보낸 값뿐이다. */
export type ReviewTitleOption = { id: string; name: string };

/**
 * 타이틀 필터에 그릴 선택지.
 *
 * 정본은 서버가 실어 준 레지스트리 목록이고, 불러온 행에만 있는 타이틀(레지스트리에서 나중에
 * 제거됐거나 아직 등록 전인 값)도 뒤에 덧붙인다 — 화면에 보이는데 고를 수 없는 타이틀을 만들지
 * 않기 위해서다. 게임명을 코드에 적지 않는다는 규칙은 그대로다(값은 전부 서버에서 온다).
 */
export function reviewTitleFilterOptions(
  registryTitles: readonly ReviewTitleOption[] | null | undefined,
  rowTitles: readonly (ReviewTitleOption | null | undefined)[],
): ReviewTitleOption[] {
  const options = new Map<string, ReviewTitleOption>();
  for (const title of registryTitles ?? []) {
    if (title?.id && title.name) options.set(title.id, { id: title.id, name: title.name });
  }
  for (const title of rowTitles) {
    if (title?.id && title.name && !options.has(title.id)) {
      options.set(title.id, { id: title.id, name: title.name });
    }
  }
  return [...options.values()];
}

/**
 * 행이 타이틀 필터에 맞는가. 빈 필터는 전체 통과.
 * 타이틀이 해석되지 않은 행(레지스트리 미등록 프로그램)은 특정 타이틀 선택에서 빠진다 —
 * 모르는 것을 아는 척 배정하지 않는다.
 */
export function rowMatchesReviewTitleFilter(
  rowTitleId: string | null | undefined,
  titleFilter: string,
): boolean {
  if (!titleFilter) return true;
  return (rowTitleId ?? "") === titleFilter;
}
