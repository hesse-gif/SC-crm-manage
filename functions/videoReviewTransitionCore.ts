// Pure decision core for the canonical SCP Automation review transition (handoff §4).
// One higher-level command replaces fragmented status writes. Deterministic, no I/O — the Firestore
// CAS + append-only ledger + approved-only projection + Portal-callback/creator-mail outboxes compose
// this decision. Interoperates with Portal canonical states; legacy pending|needs_review are compat-mapped.

export const VIDEO_REVIEW_TRANSITION_VERSION = "video_review_transition_v3" as const;

export type VideoReviewState =
  | "queued"
  | "in_review"
  | "changes_requested"
  | "human_review_required"
  | "rejected"
  | "approved";

export const VIDEO_REVIEW_STATES: readonly VideoReviewState[] = [
  "queued",
  "in_review",
  "changes_requested",
  "human_review_required",
  "rejected",
  "approved",
] as const;

// Legacy compat: pending → queued, needs_review → human_review_required. History is preserved by the
// caller; this only normalizes the read state for transition planning.
export function normalizeLegacyReviewState(raw: string): VideoReviewState {
  if ((VIDEO_REVIEW_STATES as readonly string[]).includes(raw)) return raw as VideoReviewState;
  if (raw === "pending") return "queued";
  if (raw === "needs_review") return "human_review_required";
  return "queued";
}

// Terminal-for-revision states cannot directly transition again; a new canonical revision re-enters queued.
// Task-94: `rejected` gained ONE additional edge back to `human_review_required` — the operator
// undo / creator appeal path (videoReviewTransitionStore.ts requires a non-empty `undoReason` for
// this specific edge). Human final decisions can therefore be reconsidered without allowing any
// automated terminal decision.
const ALLOWED_NEXT: Record<VideoReviewState, readonly VideoReviewState[]> = {
  queued: ["in_review", "human_review_required", "changes_requested", "rejected", "approved"],
  in_review: ["approved", "rejected", "changes_requested", "human_review_required"],
  human_review_required: ["approved", "rejected", "changes_requested"],
  changes_requested: [],
  rejected: ["human_review_required"],
  approved: [],
};

export type ActorType = "human" | "ai";
export type EvidenceRisk = "low" | "high" | "uncertain";

export type VideoReviewTransitionInput = {
  current: {
    state: VideoReviewState;
    revision: number;
    contentFingerprint: string;
    canonicalProgramId: string;
    policyConfigHash: string;
  };
  targetStatus: VideoReviewState;
  expectedRevision: number;
  expectedContentFingerprint: string;
  expectedCanonicalProgramId: string;
  expectedPolicyConfigHash: string;
  reasonCode?: string | null;
  customerMessageCode?: string | null;
  actorType: ActorType;
  aiAutoPilotEnabled?: boolean;
  evidenceRisk?: EvidenceRisk;
};

export type VideoReviewMailKind = "content_approved" | "content_changes_requested" | "content_rejected";

export type VideoReviewTransitionDecision = {
  allowed: boolean;
  errorCode:
    | null
    | "stale_precondition"
    | "invalid_transition"
    | "reason_required"
    | "customer_message_required"
    | "ai_not_permitted";
  nextState: VideoReviewState | null;
  projectToFeed: boolean; // true only when the CURRENT revision becomes approved
  requiresHumanReview: boolean; // AI decision routed to human
  mailKind: VideoReviewMailKind | null;
};

function fail(errorCode: VideoReviewTransitionDecision["errorCode"]): VideoReviewTransitionDecision {
  return { allowed: false, errorCode, nextState: null, projectToFeed: false, requiresHumanReview: false, mailKind: null };
}

export function planVideoReviewTransition(input: VideoReviewTransitionInput): VideoReviewTransitionDecision {
  // 1. CAS preconditions — fail-closed on any drift (stale revision / fingerprint / program / policy).
  if (
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision !== input.current.revision ||
    input.expectedContentFingerprint !== input.current.contentFingerprint ||
    input.expectedCanonicalProgramId !== input.current.canonicalProgramId ||
    input.expectedPolicyConfigHash !== input.current.policyConfigHash
  ) {
    return fail("stale_precondition");
  }

  // 2. Valid canonical transition.
  if (!(ALLOWED_NEXT[input.current.state] ?? []).includes(input.targetStatus)) {
    return fail("invalid_transition");
  }

  // 3. Reason / customer-message requirements.
  if ((input.targetStatus === "changes_requested" || input.targetStatus === "rejected") && !input.reasonCode) {
    return fail("reason_required");
  }
  if (input.targetStatus === "changes_requested" && !input.customerMessageCode) {
    return fail("customer_message_required");
  }

  // 4. Actor gate. Video approval and rejection are human-only operational decisions. AI may
  //    collect evidence and recommend an outcome, but every AI-originated transition stops at
  //    human_review_required; the obsolete auto-pilot flags are intentionally ignored here.
  //
  //    Keeping this at the common transition boundary protects every producer (analysis judge,
  //    deterministic automation, sheet sync, and future callers) without relying on a mutable
  //    setting or each producer remembering to disable itself. It also means an AI route cannot
  //    create an approval/rejection result-mail plan.
  if (input.actorType === "ai") {
    return {
      allowed: true,
      errorCode: null,
      nextState: "human_review_required",
      projectToFeed: false,
      requiresHumanReview: true,
      mailKind: null,
    };
  }

  // 5. Derive projection + creator mail. Only the current approved revision projects to Feed/Report.
  //
  // W120: 승인도 결과 메일을 낸다. 종전에는 반려·변경요청만 통지해서, 승인된 크리에이터는 자기
  // 영상이 통과했는지·뷰 트래킹과 정산이 언제 시작되는지 알 방법이 포털 재방문뿐이었다.
  // 조건은 나머지 두 판정과 **정확히 같다**(호출부의 notifyCreator + deliveryMode 게이트) —
  // 승인 전용 예외를 만들지 않는다. projectToFeed 와 같은 판정에서 나오므로, 메일이 약속하는
  // "트래킹/정산 시작"은 실제로 피드·정산에 투영되는 그 리비전에서만 나간다.
  const projectToFeed = input.targetStatus === "approved";
  const mailKind: VideoReviewMailKind | null =
    input.targetStatus === "approved"
      ? "content_approved"
      : input.targetStatus === "changes_requested"
        ? "content_changes_requested"
        : input.targetStatus === "rejected"
          ? "content_rejected"
          : null;

  return { allowed: true, errorCode: null, nextState: input.targetStatus, projectToFeed, requiresHumanReview: false, mailKind };
}
