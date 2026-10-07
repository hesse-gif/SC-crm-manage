// Pure core for approved-only downstream eligibility (handoff §7 + video-review approvalGate).
// Hard invariants:
//  - Only the CURRENT APPROVED revision may project to Feed/Report.
//  - Rejected / changes_requested / human_review_required / queued / in_review / superseded / withdrawn /
//    stale revisions are NEVER Feed/Report/tracking/settlement eligible.
//  - Review approval ALONE leaves trackingEligible + settlementEligible false; they require the
//    confirmed downstream projection callback (a separate accepted step).
//  - View collectors accept only a current-approved eligibility token (issued only when tracking-eligible).
// Deterministic, no I/O.

import type { VideoReviewState } from "./videoReviewTransitionCore";

export const DOWNSTREAM_ELIGIBILITY_VERSION = "downstream_eligibility.v1" as const;

export type DownstreamEligibilityInput = {
  reviewState: VideoReviewState;
  isCurrentRevision: boolean;
  superseded?: boolean;
  withdrawn?: boolean;
  downstreamProjectionConfirmed?: boolean;
};

export type DownstreamEligibility = {
  version: typeof DOWNSTREAM_ELIGIBILITY_VERSION;
  feedEligible: boolean;
  reportEligible: boolean;
  trackingEligible: boolean;
  settlementEligible: boolean;
  eligibilityToken: string | null;
  reasonCode: string;
};

export function computeDownstreamEligibility(
  input: DownstreamEligibilityInput,
  ctx: { videoSubmissionId: string; revision: number },
): DownstreamEligibility {
  const approvedCurrent =
    input.reviewState === "approved" &&
    input.isCurrentRevision === true &&
    input.superseded !== true &&
    input.withdrawn !== true;
  const projectionConfirmed = input.downstreamProjectionConfirmed === true;

  const feedEligible = approvedCurrent;
  const reportEligible = approvedCurrent;
  // §video-review approvalGate: review approval itself leaves tracking/settlement false.
  const trackingEligible = approvedCurrent && projectionConfirmed;
  const settlementEligible = approvedCurrent && projectionConfirmed;

  const eligibilityToken = trackingEligible
    ? `veligible_${ctx.videoSubmissionId}_r${Math.max(0, Math.trunc(ctx.revision))}`
    : null;

  let reasonCode: string;
  if (!approvedCurrent) {
    if (input.reviewState !== "approved") reasonCode = `not_approved_${input.reviewState}`;
    else if (input.superseded === true) reasonCode = "superseded";
    else if (input.withdrawn === true) reasonCode = "withdrawn";
    else reasonCode = "not_current_revision";
  } else {
    reasonCode = projectionConfirmed ? "eligible" : "approved_pending_downstream_projection";
  }

  return {
    version: DOWNSTREAM_ELIGIBILITY_VERSION,
    feedEligible,
    reportEligible,
    trackingEligible,
    settlementEligible,
    eligibilityToken,
    reasonCode,
  };
}

// View collectors accept only a valid current-approved eligibility token bound to the exact revision.
export function isViewCollectionAllowed(
  eligibility: DownstreamEligibility,
  presentedToken: string | null,
): boolean {
  return eligibility.trackingEligible && !!presentedToken && presentedToken === eligibility.eligibilityToken;
}
