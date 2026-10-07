// W120: 검수 이력 요약(순수 함수, I/O 없음).
//
// 원장(`scp_video_review_state.reviewLedger`)은 제출 1건의 모든 판정을 append-only 로 들고 있는데,
// 화면도 메일도 그걸 세어 본 적이 없었다. 그래서 (a) "이 영상은 이전 rev 에서 이미 반려됐다" 와
// (b) "같은 사유로 N번째 반려다" 를 운영자가 판정 직전에 알 방법이 없었다 — 실데이터에서 같은
// 크리에이터가 같은 사유(워크스루)로 5건을 반복 제출한 사례가 확인됐다.
//
// 새 중복 탐지 인프라를 만들지 않는다. 이미 원장에 있는 사실을 세기만 한다.

export type VideoReviewLedgerSummary = {
  /** 반려(rejected) 판정 수. */
  readonly rejections: number;
  /** 변경 요청(changes_requested) 판정 수. */
  readonly changesRequested: number;
  /** 승인(approved) 판정 수. */
  readonly approvals: number;
  /** 반려·변경요청을 합친 "통과하지 못한 판정" 수 — 메일의 prior_rejection_count 가 이 값이다. */
  readonly declines: number;
  /** 가장 최근 반려·변경요청의 사유 코드. */
  readonly lastDeclineReasonCode: string | null;
  /** 2회 이상 반복된 반려 사유 코드(가장 많이 반복된 것). 없으면 null. */
  readonly repeatedReasonCode: string | null;
  /** 그 사유가 반복된 횟수(2 이상). 반복이 없으면 0. */
  readonly repeatedReasonCount: number;
  /**
   * W120 [적대 리뷰 M3]: 반려·변경요청 **엔트리 단위** 사유 분포. 크리에이터 단위 집계가
   * "문서당 마지막 사유 1건"으로 세면 한 제출에서 같은 사유로 3번 반려돼도 1로 접힌다.
   */
  readonly declineReasonCounts: Readonly<Record<string, number>>;
};

export const EMPTY_VIDEO_REVIEW_LEDGER_SUMMARY: VideoReviewLedgerSummary = {
  rejections: 0,
  changesRequested: 0,
  approvals: 0,
  declines: 0,
  lastDeclineReasonCode: null,
  repeatedReasonCode: null,
  repeatedReasonCount: 0,
  declineReasonCounts: {},
};

function entryState(entry: Record<string, unknown>): string {
  for (const key of ["toState", "state", "decision"]) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function entryReasonCode(entry: Record<string, unknown>): string {
  const value = entry.reasonCode;
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

/**
 * 원장 배열을 훑어 판정 분포를 센다.
 *
 * `excludeDecisionRef` 는 "지금 통지하고 있는 그 판정"을 빼기 위한 것이다 — 발송 메일의
 * `prior_rejection_count` 는 **이번 판정 이전**의 수여야 한다(이번 반려까지 세면 첫 반려가
 * 1이 아니라 2로 보인다). 판정 참조는 원장 엔트리와 아웃박스 행이 같은 값을 들고 있어
 * seq 를 유추하지 않고 정확히 한 건만 뺄 수 있다.
 */
export function summarizeVideoReviewLedger(
  reviewLedger: unknown,
  options: {
    readonly excludeDecisionRef?: string | null;
    /**
     * W126: 켜면 **크리에이터에게 실제로 통지된 판정만** 센다. 원장은 메일이 안 나간 판정도
     * 그대로 append 한다 — 컷오버 게이트(`mailSkippedReason`)·무메일 백필(`notifyCreator:false`)·
     * 과거 원장 재적재(`historical_import`)가 전부 그렇다. 그 판정들을 크리에이터 문장이
     * 세면, 통지를 한 번도 못 받은 사람의 **생애 첫 결과 메일**이 "N submissions were not
     * approved" 로 열린다(2026-08-24 무메일 백필 32건이 정확히 그 부류다).
     *
     * 기본값은 false 다 — 운영자 화면 배지·`prior_rejection_count` 는 "무슨 일이 있었나"를
     * 세는 축이라 통지 여부와 무관하게 전부 세야 한다(W120 계약 무변경).
     */
    readonly notifiedOnly?: boolean;
  } = {},
): VideoReviewLedgerSummary {
  const rows = Array.isArray(reviewLedger) ? reviewLedger : [];
  const excludeDecisionRef =
    typeof options.excludeDecisionRef === "string" && options.excludeDecisionRef.trim()
      ? options.excludeDecisionRef.trim()
      : null;
  let rejections = 0;
  let changesRequested = 0;
  let approvals = 0;
  let lastDeclineReasonCode: string | null = null;
  const reasonCounts = new Map<string, number>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (excludeDecisionRef !== null && entry.decisionRef === excludeDecisionRef) continue;
    if (options.notifiedOnly === true && !ledgerEntryNotifiedCreator(entry)) continue;
    const state = entryState(entry);
    if (state === "approved") {
      approvals += 1;
      continue;
    }
    if (state !== "rejected" && state !== "changes_requested") continue;
    if (state === "rejected") rejections += 1;
    else changesRequested += 1;
    const reasonCode = entryReasonCode(entry);
    if (reasonCode) {
      lastDeclineReasonCode = reasonCode;
      reasonCounts.set(reasonCode, (reasonCounts.get(reasonCode) ?? 0) + 1);
    }
  }
  const repeated = topRepeatedReasonFromMap(reasonCounts);
  const repeatedReasonCode = repeated.code;
  const repeatedReasonCount = repeated.count;
  return {
    rejections,
    changesRequested,
    approvals,
    declines: rejections + changesRequested,
    lastDeclineReasonCode,
    repeatedReasonCode,
    repeatedReasonCount,
    declineReasonCounts: Object.fromEntries(reasonCounts),
  };
}

/**
 * W126: 이 판정이 크리에이터에게 **실제로 통지됐는가**. 원장 엔트리가 스스로 답할 수 있는
 * 범위에서만 판정한다(아웃박스를 다시 조회하지 않는다 — 드레인 안에서 도는 계수라 그 비용을
 * 질 수 없다). 아웃박스 생성 조건(videoReviewTransitionStore)의 세 게이트를 그대로 반영한다.
 *
 * 한계(의도적): `notifyCreator` 는 2026-08-24 이후 엔트리부터 기록된다 — 그 이전 무메일 백필
 * 행은 이 필드가 없어 통지된 것으로 보인다. 없는 값을 추측하는 것보다 낫다고 판단했다.
 */
function ledgerEntryNotifiedCreator(entry: Record<string, unknown>): boolean {
  if (entry.notifyCreator === false) return false;
  if (entry.deliveryMode === "historical_import") return false;
  const skipped = entry.mailSkippedReason;
  if (typeof skipped === "string" && skipped.trim()) return false;
  return true;
}

function topRepeatedReasonFromMap(counts: Map<string, number>): { code: string | null; count: number } {
  let code: string | null = null;
  let count = 0;
  for (const [candidate, value] of counts) {
    if (value >= 2 && value > count) {
      code = candidate;
      count = value;
    }
  }
  return { code, count };
}

/**
 * W120 [적대 리뷰 M4]: **현재 헤드 상태를 만든 판정**의 참조. 배지가 이 판정을 함께 세면,
 * 같은 판정으로 나간 메일의 `prior_rejection_count` 와 화면 숫자가 1 어긋난다.
 *
 * 무조건 마지막 엔트리를 빼면 안 된다 — 새 리비전이 들어와 헤드가 `queued` 로 돌아간 경우
 * 마지막 엔트리는 **이전 rev 의 반려**이고, 그건 운영자가 반드시 봐야 하는 재제출 신호다.
 * 그래서 "toState 가 현재 상태이고 revision 도 현재 리비전인" 엔트리만 헤드로 인정한다.
 */
export function currentHeadDecisionRef(
  reviewLedger: unknown,
  state: string,
  revision: number,
): string | null {
  const rows = Array.isArray(reviewLedger) ? reviewLedger : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const raw = rows[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (entryState(entry) !== state) continue;
    if (Number(entry.revision) !== Number(revision)) continue;
    return typeof entry.decisionRef === "string" && entry.decisionRef.trim()
      ? entry.decisionRef.trim()
      : null;
  }
  return null;
}

/** 여러 제출의 사유 분포를 합친다(크리에이터 단위 집계 — 엔트리 수를 잃지 않는다). */
export function mergeDeclineReasonCounts(
  target: Map<string, number>,
  counts: Readonly<Record<string, number>>,
): void {
  for (const [code, count] of Object.entries(counts)) {
    target.set(code, (target.get(code) ?? 0) + count);
  }
}

/** 2회 이상 반복된 사유 중 가장 많은 것. 없으면 `{ code: null, count: 0 }`. */
export function topRepeatedReason(
  counts: Map<string, number> | Readonly<Record<string, number>>,
): { code: string | null; count: number } {
  const entries = counts instanceof Map ? [...counts] : Object.entries(counts);
  let code: string | null = null;
  let count = 0;
  for (const [candidate, value] of entries) {
    if (value >= 2 && value > count) {
      code = candidate;
      count = value;
    }
  }
  return { code, count };
}
