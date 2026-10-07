// Pure core for content-submission eligibility (frozen contract §5; spec C).
// Deterministic gate — no side effects. Composed by the Portal video-submission ingress.
// Eligibility NEVER implies approval (§5.3): an eligible submission still enters the SCP review queue.

export const CONTENT_SUBMISSION_ELIGIBILITY_VERSION = "content_submission_eligibility_v2" as const;

// §5.1 the four required conditions (ALL must hold). UID verification and YouTube OAuth are
// explicitly NOT part of this set (§5.2) and must never influence the outcome.
export type ContentSubmissionConditions = {
  applicationNotRejectedOrWithdrawn: boolean; // spec C.4 (application not rejected/withdrawn)
  managedActiveProgramEnrollment: boolean; // §5.1(a)
  stableApplicationCreatorBinding: boolean; // §5.1(b)
  signedUnexpiredUnrevokedContentGrant: boolean; // §5.1(c)
  declaredPrimaryAudienceCountryPresent: boolean; // §5.1(d), versioned
};

export type ContentSubmissionBlockReason =
  | "application_rejected_or_withdrawn"
  | "enrollment_not_managed_active"
  | "creator_binding_unstable"
  | "content_grant_invalid"
  | "declared_primary_audience_country_absent";

export type ContentSubmissionEligibilityResult = {
  eligible: boolean;
  blockedReasons: ContentSubmissionBlockReason[];
  // Reminder to callers: eligibility is NOT approval; the current revision still enters review.
  impliesApproval: false;
};

export function contentSubmissionEligibility(
  conditions: ContentSubmissionConditions,
): ContentSubmissionEligibilityResult {
  const blockedReasons: ContentSubmissionBlockReason[] = [];
  if (!conditions.applicationNotRejectedOrWithdrawn) blockedReasons.push("application_rejected_or_withdrawn");
  if (!conditions.managedActiveProgramEnrollment) blockedReasons.push("enrollment_not_managed_active");
  if (!conditions.stableApplicationCreatorBinding) blockedReasons.push("creator_binding_unstable");
  if (!conditions.signedUnexpiredUnrevokedContentGrant) blockedReasons.push("content_grant_invalid");
  if (!conditions.declaredPrimaryAudienceCountryPresent) blockedReasons.push("declared_primary_audience_country_absent");
  return {
    eligible: blockedReasons.length === 0,
    blockedReasons,
    impliesApproval: false,
  };
}
