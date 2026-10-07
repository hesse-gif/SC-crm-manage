// Task-100 갭 ①: "이 건은 몇 번째 반려 후 미재제출인가"를 담는 원장이 없었다. 이 파일은 그
// video_resubmission_cycles 문서의 순수 형태(ID·상태 전이·기한 계산)를 정의한다 — I/O 없음,
// 단위테스트 전용. Firestore 쓰기는 호출부(videoReviewTransitionStore.transitionVideoReviewDecision의
// 트랜잭션, scpVideoRevisionIngress 의 리비전 수락 트랜잭션)가 이 모듈의 순수 결과를 그대로 tx에 싣는다.
//
// 문서 ID: `{submissionId}__{cycleSeq}` (cycleSeq = 이 제출의 몇 번째 반려인가, 1-based).
// W86-B 형제 아웃박스와 같은 규율로 `tx.create` 로 적재해 키 자체가 중복을 막는다(재시도해도
// 같은 decisionRef 재적용은 transitionVideoReviewDecision 의 appliedDecisionRefs 가드가 이미
// 앞단에서 막으므로 이 함수까지 오지 않는다 — create 실패는 진짜 이상 상황만 남는다).

export const VIDEO_RESUBMISSION_CYCLE_COLLECTION = "video_resubmission_cycles";

export type ResubmissionCycleStatus =
  | "awaiting_resubmission"
  | "resubmitted"
  | "passed"
  | "failed"
  | "churned"
  // Task-94 undo 엣지가 닫은 사이클 — 반려 자체가 취소됐으므로 지표 분모·독려 대상에서 모두 빠진다.
  | "undone";

export type ResubmissionCycleDoc = {
  submissionId: string;
  applicationId: string;
  creatorId: string | null;
  cycleSeq: number;
  rejectedAtIso: string;
  rejectedRevision: number;
  reasonCode: string;
  reasonCodeRaw: string | null;
  deadlineAtIso: string;
  status: ResubmissionCycleStatus;
  createdAtIso: string;
  updatedAtIso: string;
  resubmittedAtIso?: string;
  resubmittedRevision?: number;
  decidedAtIso?: string;
  decidedRevision?: number;
  decisionRef?: string;
  undoneAtIso?: string;
  undoneByDecisionRef?: string;
};

export function resubmissionCycleDocId(submissionId: string, cycleSeq: number): string {
  return `${submissionId}__${cycleSeq}`;
}

/** rejectedAtIso + deadlineDays(정수, UTC 일 단위) → deadlineAtIso. */
export function computeResubmissionDeadlineIso(rejectedAtIso: string, deadlineDays: number): string {
  const base = Date.parse(rejectedAtIso);
  const safeBase = Number.isFinite(base) ? base : Date.now();
  const days = Number.isFinite(deadlineDays) && deadlineDays > 0 ? deadlineDays : 14;
  return new Date(safeBase + days * 24 * 60 * 60 * 1000).toISOString();
}

export type BuildResubmissionCycleInput = {
  submissionId: string;
  applicationId: string;
  creatorId?: string | null;
  cycleSeq: number;
  rejectedAtIso: string;
  rejectedRevision: number;
  reasonCode: string;
  reasonCodeRaw: string | null;
  deadlineDays: number;
  decisionRef?: string;
};

/** rejected 전이 훅이 새 사이클 문서를 만들 때 쓰는 순수 빌더. */
export function buildResubmissionCycleCreatedDoc(input: BuildResubmissionCycleInput): ResubmissionCycleDoc {
  const deadlineAtIso = computeResubmissionDeadlineIso(input.rejectedAtIso, input.deadlineDays);
  return {
    submissionId: input.submissionId,
    applicationId: input.applicationId,
    creatorId: input.creatorId ?? null,
    cycleSeq: input.cycleSeq,
    rejectedAtIso: input.rejectedAtIso,
    rejectedRevision: input.rejectedRevision,
    reasonCode: input.reasonCode || "other_documented",
    reasonCodeRaw: input.reasonCodeRaw,
    deadlineAtIso,
    status: "awaiting_resubmission",
    createdAtIso: input.rejectedAtIso,
    updatedAtIso: input.rejectedAtIso,
    ...(input.decisionRef ? { decisionRef: input.decisionRef } : {}),
  };
}

/** scpVideoRevisionIngress 의 리비전 증가(재제출) 훅이 쓰는 patch — 기존 필드 merge 전용. */
export function buildResubmissionCycleResubmittedPatch(input: {
  resubmittedAtIso: string;
  resubmittedRevision: number;
}): Partial<ResubmissionCycleDoc> {
  return {
    status: "resubmitted",
    resubmittedAtIso: input.resubmittedAtIso,
    resubmittedRevision: input.resubmittedRevision,
    updatedAtIso: input.resubmittedAtIso,
  };
}

/**
 * 재제출된 리비전에 대한 다음 판정이 이 사이클을 닫는다 — approved 면 passed, rejected 면 failed
 * (rejected 는 **같은 트랜잭션에서** cycleSeq+1 이 새로 열린다, 호출부 책임).
 * changes_requested 는 판정 보류로 본다(패스/실패 어느 쪽도 아니다) — 닫지 않고 그대로 둔다
 * (호출부가 이 함수를 아예 부르지 않는다).
 */
export function buildResubmissionCycleResolvedPatch(input: {
  outcome: "passed" | "failed";
  decidedAtIso: string;
  decidedRevision: number;
  decisionRef?: string;
}): Partial<ResubmissionCycleDoc> {
  return {
    status: input.outcome,
    decidedAtIso: input.decidedAtIso,
    decidedRevision: input.decidedRevision,
    updatedAtIso: input.decidedAtIso,
    ...(input.decisionRef ? { decisionRef: input.decisionRef } : {}),
  };
}

/**
 * Task-94 undo 엣지(rejected → human_review_required)가 그 반려로 열린 사이클을 닫을 때 쓰는 patch.
 * awaiting_resubmission 에서만 의미가 있다(호출부가 review-state 의 resubmissionCycleActive 로 판정).
 */
export function buildResubmissionCycleUndonePatch(input: {
  undoneAtIso: string;
  decisionRef?: string;
}): Partial<ResubmissionCycleDoc> {
  return {
    status: "undone",
    undoneAtIso: input.undoneAtIso,
    updatedAtIso: input.undoneAtIso,
    ...(input.decisionRef ? { undoneByDecisionRef: input.decisionRef } : {}),
  };
}

/**
 * 기한 초과 + 독려 소진 → churned. 순수 판정(스윕이 조회한 사실을 넘긴다) — 이 함수 자체는
 * Firestore 를 모른다. `awaiting_resubmission` 이 아닌 사이클(이미 재제출·판정·종결)은 대상이
 * 아니다(스윕이 쿼리 단계에서 이미 걸러야 하지만, 방어적으로 여기서도 다시 확인한다).
 */
export type PlanNextResubmissionNudgeOccurrenceInput = {
  rejectedAtIso: string;
  /** 이미 보낸 독려 수(0-based 다음 회차 = nudgesSent+1). */
  nudgesSent: number;
  policyEnabled: boolean;
  policyMaxNudges: number;
  policyNudgeIntervalDays: number;
  deadlineAtIso: string;
  nowIso: string;
};

export type ResubmissionNudgeOccurrencePlan = { due: true; nudgeSeq: number } | null;

/**
 * 다음 독려 회차가 지금 발송 대상인가. `rejectedAtIso + nudgeIntervalDays * nudgeSeq` 가 도래했고,
 * 기한(deadlineAtIso) 안이며, 정책이 켜져 있고 상한(maxNudges) 안일 때만 true.
 * 기한을 넘으면 독려 대신 종결(planResubmissionCycleChurn) 대상이다 — 두 함수가 서로 배타적이다.
 */
export function planNextResubmissionNudgeOccurrence(
  input: PlanNextResubmissionNudgeOccurrenceInput,
): ResubmissionNudgeOccurrencePlan {
  if (!input.policyEnabled || input.policyMaxNudges <= 0) return null;
  if (input.nudgesSent >= input.policyMaxNudges) return null;
  const nudgeSeq = input.nudgesSent + 1;
  const rejectedMs = Date.parse(input.rejectedAtIso);
  const nowMs = Date.parse(input.nowIso);
  const deadlineMs = Date.parse(input.deadlineAtIso);
  if (!Number.isFinite(rejectedMs) || !Number.isFinite(nowMs)) return null;
  const dueAtMs = rejectedMs + input.policyNudgeIntervalDays * nudgeSeq * 24 * 60 * 60 * 1000;
  if (dueAtMs > nowMs) return null;
  if (Number.isFinite(deadlineMs) && dueAtMs > deadlineMs) return null;
  return { due: true, nudgeSeq };
}

/**
 * [코덱스 라운드6] `nudgesSentCount`/`policyMaxNudges` 는 더 이상 이 판정을 막지 않는다(하위
 * 호환을 위해 입력 모양은 남겨 둔다) — 예전엔 "기한 초과 **+** 독려 소진"이어야 churn 했는데,
 * 발송이 계속 실패하거나(수신자 미해석 등) 드레인이 기한을 넘겨 미룸을 취소하는 경우(라운드4~6,
 * resubmissionNudgeMail.ts) nudgesSent 가 영원히 상한에 못 미쳐 사이클이 열린 채로 갇히는 결함을
 * 낳았다. 기한(deadlineAtIso)이 지났다는 사실 자체가 "더는 재제출을 받지 않는다"는 뜻이므로,
 * 그것만으로 종결한다 — 몇 번 독려가 나갔는지는 무관하다.
 */
export function planResubmissionCycleChurn(input: {
  status: ResubmissionCycleStatus;
  deadlineAtIso: string;
  nudgesSentCount: number;
  policyMaxNudges: number;
  nowIso: string;
}): boolean {
  if (input.status !== "awaiting_resubmission") return false;
  const deadlineMs = Date.parse(input.deadlineAtIso);
  const nowMs = Date.parse(input.nowIso);
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) return false;
  return nowMs >= deadlineMs;
}
