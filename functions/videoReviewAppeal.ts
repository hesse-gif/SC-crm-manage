// Task-94 item 5: `video.review.appeal` contract (portal -> flu).
//
// NOT wired into functions/integrationEventV2.ts's byte-identical vendored Portal contract library
// — that file's `integrationEventV2Names` union is pinned to a Portal-signed schema SHA and is only
// ever re-vendored when the Portal producer itself changes (see that file's own header: "Do NOT
// hand-edit... re-vendor if the contract SHA changes"). Adding a new event name there without a
// matching Portal-side change would silently desync the "byte-identical" invariant
// tests/integration-event-v2-contract.test.mjs pins. This event is therefore defined and RECEIVED
// here as a standalone contract, ready to be wired into scpIntegrationEventV2.ts's
// INBOUND_EVENT_NAMES / dispatchIntegrationEventV2 switch once Portal implements the sender side
// and the vendored contract is re-synced to include it (out of scope here — "do NOT implement the
// portal side").
//
// WHAT THIS IS: the Flu-side "on receipt" effect for a creator-initiated appeal of an AI-authored
// `rejected` decision. It reuses the SAME `rejected -> human_review_required` undo edge that
// operator undo uses (videoReviewTransitionCore.ts / videoReviewTransitionStore.ts), with
// `reason:"creator_appeal"` and `appeal.open:true` stamped onto the canonical review-state doc so
// the review queue can surface an "이의제기" badge (CanonicalVideoReviewPanel.tsx).
//
// Portal wire shape (to be produced by the Portal creator dashboard's appeal action once built):
//   {
//     submissionId: string;   // Flu videoSubmissionId (== the review-state doc's subject.videoSubmissionId)
//     decisionSeq: number;    // the ledger entry.seq of the rejection being appealed
//     message: string;        // creator's appeal message, <=1000 chars
//     submittedAtIso: string; // ISO8601 timestamp the creator submitted the appeal at
//   }
// Semantics on receipt: only valid against a review-state doc currently `rejected` whose LAST
// decision's seq equals `decisionSeq` — a stale appeal against an already-superseded rejection
// fails closed with stale_precondition (the SAME CAS videoReviewTransitionStore.ts's undo edge
// already enforces for operator undo; see its `isUndoEdge`/`expectedSeq` check).

import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";
import {
  transitionVideoReviewDecision,
  reviewDocId,
  SCP_VIDEO_REVIEW_STATE_COLLECTION,
  type TransitionCommandResult,
} from "./videoReviewTransitionStore";

export const VIDEO_REVIEW_APPEAL_EVENT_NAME = "video.review.appeal" as const;
const APPEAL_MESSAGE_MAX_LENGTH = 1000;

export interface VideoReviewAppealEventPayload {
  submissionId: string;
  decisionSeq: number;
  message: string;
  submittedAtIso: string;
}

export class VideoReviewAppealError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "VideoReviewAppealError";
  }
}

export function parseVideoReviewAppealPayload(value: unknown): VideoReviewAppealEventPayload {
  const data = asRecord(value);
  const submissionId = asString(data.submissionId).trim();
  const decisionSeq = Number(data.decisionSeq);
  const message = asString(data.message).trim();
  const submittedAtIso = asString(data.submittedAtIso).trim();
  if (!submissionId) throw new VideoReviewAppealError("invalid_payload", "submissionId is required");
  if (!Number.isInteger(decisionSeq) || decisionSeq <= 0) {
    throw new VideoReviewAppealError("invalid_payload", "decisionSeq must be a positive integer");
  }
  if (!message) throw new VideoReviewAppealError("invalid_payload", "message is required");
  if (message.length > APPEAL_MESSAGE_MAX_LENGTH) {
    throw new VideoReviewAppealError("invalid_payload", `message must be at most ${APPEAL_MESSAGE_MAX_LENGTH} characters`);
  }
  if (!submittedAtIso || !Number.isFinite(Date.parse(submittedAtIso))) {
    throw new VideoReviewAppealError("invalid_payload", "submittedAtIso must be a valid ISO8601 timestamp");
  }
  return { submissionId, decisionSeq, message, submittedAtIso };
}

/**
 * The appeal event's actual effect. Pure orchestration: validate the payload, read the review-state
 * doc for its CURRENT CAS fields (the store re-validates everything again inside its own
 * transaction — this read only supplies expected* values, exactly like undoVideoReviewDecisionHandler
 * does for operator undo), then delegate to the shared undo edge.
 */
export async function applyVideoReviewAppeal(
  rawPayload: unknown,
  now: Date = new Date(),
): Promise<TransitionCommandResult> {
  const payload = parseVideoReviewAppealPayload(rawPayload);
  const ref = adminDb.collection(SCP_VIDEO_REVIEW_STATE_COLLECTION).doc(reviewDocId(payload.submissionId));
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    throw new VideoReviewAppealError("not_found", "review state does not exist");
  }
  const data = snapshot.data() ?? {};
  return transitionVideoReviewDecision(
    {
      submissionId: payload.submissionId,
      targetStatus: "human_review_required",
      expectedRevision: Number(data.revision ?? 0),
      expectedContentFingerprint: asString(data.contentFingerprint),
      expectedCanonicalProgramId: asString(data.canonicalProgramId),
      expectedPolicyConfigHash: asString(data.policyConfigHash),
      expectedSeq: payload.decisionSeq,
      undoReason: "creator_appeal",
      appeal: { message: payload.message, submittedAtIso: payload.submittedAtIso },
      // Deterministic per (submission, decisionSeq) — a retried/duplicate delivery of the same
      // appeal event is idempotent instead of reprocessed.
      decisionRef: `creator_appeal:${reviewDocId(payload.submissionId)}:${payload.decisionSeq}`,
      // Not an AI decision — the creator is a person acting through the portal. Recording the
      // actor as "human" keeps planVideoReviewTransition's AI-only autopilot gate (§4) irrelevant
      // here, matching operator undo's actorType.
      actorType: "human",
      actorId: "portal:creator_appeal",
      notifyCreator: false,
    },
    now,
  );
}
