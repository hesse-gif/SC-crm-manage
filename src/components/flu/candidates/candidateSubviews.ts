// Flu/Task-45 — 후보 탭 서브뷰(전체/관심/히스토리) + 캘린더 날짜 필터의 순수 로직만 모은 파일.
// React/DOM 의존이 전혀 없다 — Node의 네이티브 TS 타입 스트리핑으로 node --test에서 직접
// import할 수 있게 하려는 의도(src/lib/discovery/candidate-hover.ts와 동일한 패턴). 그래서 타입
// import는 @/ 별칭이 아니라 상대 경로 + 명시적 .ts 확장자를 쓴다(별칭은 런타임에 풀리지 않는다 —
// 단 type-only이므로 스트리핑 시 통째로 지워져 실제로는 아무 경로도 참조하지 않는다).
import type { CandidateTableRow } from "../../../lib/data.ts";

export const CANDIDATE_SUBVIEWS = ["all", "starred", "history"] as const;
export type CandidateSubview = (typeof CANDIDATE_SUBVIEWS)[number];

export const CANDIDATE_SUBVIEW_LABEL: Record<CandidateSubview, string> = {
  all: "전체",
  starred: "관심",
  history: "히스토리",
};

export function isCandidateSubview(value: string | null | undefined): value is CandidateSubview {
  return value === "all" || value === "starred" || value === "history";
}

// URL의 ?view= 를 안전한 서브뷰로 되돌린다. 모르는 값(오타·구버전 링크)은 조용히 "all"로 접는다.
export function normalizeCandidateSubview(value: string | null | undefined): CandidateSubview {
  return isCandidateSubview(value) ? value : "all";
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateKey(value: string | null | undefined): value is string {
  return typeof value === "string" && DATE_KEY_PATTERN.test(value);
}

// URL의 ?date= 를 검증한다. 형식이 아니면(빈 값 포함) 필터 없음(null)으로 접는다.
export function normalizeDateParam(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return isValidDateKey(trimmed) ? trimmed : null;
}

// P2-1(2026-09-11 적대 리뷰): createdAtIso는 UTC ISO 문자열이다 — 그 문자열의 날짜 부분을 그대로
// 슬라이스하면(구버전) KST 자정 전후로 하루가 밀린다(예: UTC 18:00 = 같은 날 KST 03:00 다음날 —
// "그저께" 유입이 캘린더에서 "어제"로 잘못 잡힌다). functions/reportDashboardCore.ts kstDateKey와
// 동일한 패턴(+9h 오프셋 후 날짜만 슬라이스, DST 없는 고정 오프셋)으로 KST 달력일 버킷을 맞춘다 —
// CandidateCalendar.tsx의 기본 진입 월(currentYearMonthKst)도 같은 오프셋을 쓴다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function candidateDateKey(row: Pick<CandidateTableRow, "createdAtIso">): string | null {
  if (!row.createdAtIso) return null;
  const ms = Date.parse(row.createdAtIso);
  if (Number.isNaN(ms)) return null;
  const datePart = new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
  return isValidDateKey(datePart) ? datePart : null;
}

// P1-2(2026-09-11 적대 리뷰): Task-44 hydrateOutreachStats가 stats.lastSentAtIso를 정본(scp_coldmail_
// history+mail_outbound_log 기준)으로 채우면 그 값을 먼저 쓴다 — 44가 아직 머지되지 않은 지금은
// stats.lastSentAtIso가 항상 null이라 lastOutreachAtIso(campaign_outreach 기준, functions/
// candidateTable.ts hydrateContactStatus)로 폴백한다. 44 머지 후에는 자동으로 44 값이 우선된다.
function historySortKey(row: CandidateTableRow): string {
  return row.stats?.lastSentAtIso ?? row.lastOutreachAtIso ?? "";
}

// 서브뷰 필터 + (히스토리에 한해) 발송일 내림차순 정렬. 전체/관심은 서버가 준 순서를 유지한다.
export function filterCandidatesForSubview(
  rows: readonly CandidateTableRow[],
  subview: CandidateSubview,
): CandidateTableRow[] {
  if (subview === "starred") return rows.filter((row) => row.state.favorite);
  if (subview === "history") {
    return rows
      .filter((row) => row.state.contactStatus === "발송")
      .slice()
      .sort((a, b) => historySortKey(b).localeCompare(historySortKey(a)));
  }
  return [...rows];
}

// 캘린더에서 날짜를 클릭했을 때의 행 필터. dateKey가 null이면(필터 해제) 원본을 그대로 돌려준다.
export function filterCandidatesByDate(
  rows: readonly CandidateTableRow[],
  dateKey: string | null,
): CandidateTableRow[] {
  if (!dateKey) return [...rows];
  return rows.filter((row) => candidateDateKey(row) === dateKey);
}

// 2026-09-11 재리뷰(적대 리뷰 근인 진단): page.tsx의 listCandidates 재조회(스코프 변경 등)가
// handleToggleFavorite의 낙관적 업데이트와 경합하면, 조회가 나중에 도착해 response.candidates로
// rows를 통째로 교체하면서 방금 켠 즐겨찾기를 조용히 되돌렸다(requestIdRef 가드는 "더 최근 요청이
// 이겼는지"만 보지, "그 사이 로컬로 낙관 반영한 값을 지켰는지"는 보지 않는다 — 실측: 서버는
// favorite:true로 정상 기록했는데 클라이언트가 그 값을 버렸다). candidateRef → 의도한 favorite
// 값(overrides)을 페이지가 유지하고, 매 listCandidates 응답마다 이 순수 함수로 재조정한다:
// 응답 행의 favorite가 아직 의도값을 못 따라잡았으면 의도값으로 다시 덮어쓰고, 이미 같으면(=원장이
// 따라잡음) 더 이상 필요 없다는 신호로 그 id를 fulfilledIds에 담아 돌려준다(호출자가 overrides에서
// 지운다 — 이 함수 자신은 overrides를 변경하지 않는 순수 함수).
export function reconcileFavoriteOverrides(
  candidates: readonly CandidateTableRow[],
  overrides: ReadonlyMap<string, boolean>,
): { candidates: CandidateTableRow[]; fulfilledIds: string[] } {
  if (overrides.size === 0) return { candidates: [...candidates], fulfilledIds: [] };
  const fulfilledIds: string[] = [];
  const next = candidates.map((row) => {
    const desiredFavorite = overrides.get(row.id);
    if (desiredFavorite === undefined) return row;
    if (row.state.favorite === desiredFavorite) {
      fulfilledIds.push(row.id);
      return row;
    }
    return { ...row, state: { ...row.state, favorite: desiredFavorite } };
  });
  return { candidates: next, fulfilledIds };
}

// 캘린더 집계: yearMonth("YYYY-MM") 안의 날짜별 유입(createdAtIso) 카운트.
export function buildCandidateCalendarCounts(
  rows: readonly CandidateTableRow[],
  yearMonth: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const dateKey = candidateDateKey(row);
    if (!dateKey || !dateKey.startsWith(yearMonth)) continue;
    counts[dateKey] = (counts[dateKey] ?? 0) + 1;
  }
  return counts;
}
