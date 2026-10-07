import { FieldValue } from "firebase-admin/firestore";
import { resolveCanonicalProgramId, SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";
import { videoReviewAutomationSourceFingerprint } from "./videoReviewAutomationOutbox";
import {
  videoReviewProgramScopeKey,
  type VideoReviewProgramScope,
} from "./videoReviewProgramScope";

export type VideoReviewSourceInvalidationPlan = {
  sourceChanged: boolean;
  programScope: VideoReviewProgramScope;
  nextAutomationSourceFingerprint: string;
  submissionPatch: Record<string, unknown>;
};

/**
 * Plans the source-generation handoff before a submission mutation is committed.
 *
 * Operational timestamps are deliberately excluded from the comparison. Sheet status/mail
 * refreshes update `updatedAtIso`, but they are not a new video and must not erase a valid
 * recommendation. The exact (timestamp-bearing) fingerprint returned for the next source is
 * still the one stored on the outbox claim.
 */
export function planVideoReviewSourceInvalidation(input: {
  existingSubmission: Record<string, unknown> | null;
  nextSubmission: Record<string, unknown>;
  nowIso: string;
  /** Exact scope resolved from the authoritative submission+task+lead+application graph. */
  programScope: VideoReviewProgramScope;
}): VideoReviewSourceInvalidationPlan {
  const programScope = input.programScope;
  const nextAutomationSourceFingerprint = videoReviewAutomationSourceFingerprint(
    input.nextSubmission,
    programScope,
  );
  if (!input.existingSubmission) {
    return {
      sourceChanged: false,
      programScope,
      nextAutomationSourceFingerprint,
      submissionPatch: {},
    };
  }

  const previousComparableFingerprint = comparableSourceFingerprint(input.existingSubmission, programScope);
  const nextComparableFingerprint = comparableSourceFingerprint(input.nextSubmission, programScope);
  const sourceChanged = previousComparableFingerprint !== nextComparableFingerprint;
  if (!sourceChanged) {
    return {
      sourceChanged: false,
      programScope,
      nextAutomationSourceFingerprint,
      submissionPatch: {},
    };
  }

  const scopeKey = videoReviewProgramScopeKey(programScope);
  const scopeUpdates: Record<string, unknown> = {};
  const existingScopes = asRecord(input.existingSubmission.videoReviewByScope);
  for (const [existingScopeKey, projectionValue] of Object.entries(existingScopes)) {
    if (existingScopeKey === scopeKey || !/^scope_[a-f0-9]{48}$/.test(existingScopeKey)) continue;
    const projection = asRecord(projectionValue);
    if (resolveCanonicalProgramId(projection.canonicalProgramId) === programScope.canonicalProgramId) {
      // A submission has one live review generation per program. Removing older policy keys
      // makes the pending state unambiguous without depending on client timestamp ordering.
      scopeUpdates[existingScopeKey] = FieldValue.delete();
    }
  }
  const scopedInvalidation = {
    canonicalProgramId: programScope.canonicalProgramId,
    policyConfigHash: programScope.policyConfigHash,
    programScopeVersion: programScope.scopeVersion,
    sourceStatus: "not_collected",
    sourceFingerprint: nextAutomationSourceFingerprint,
    invalidatedAtIso: input.nowIso,
  };
  return {
    sourceChanged: true,
    programScope,
    nextAutomationSourceFingerprint,
    submissionPatch: {
      videoReviewByScope: { ...scopeUpdates, [scopeKey]: scopedInvalidation },
      ...(programScope.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID ? {
        aiRecommendation: null,
        aiRecommendationMultimodal: null,
        videoReviewEvidence: null,
        videoReviewEvidenceBinding: null,
        latestVideoReviewDecisionRef: null,
      } : {}),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function comparableSourceFingerprint(
  source: Record<string, unknown>,
  programScope: VideoReviewProgramScope,
): string {
  return videoReviewAutomationSourceFingerprint({
    ...source,
    // A write timestamp is not part of the creator's media generation.
    updatedAtIso: "",
  }, programScope);
}
