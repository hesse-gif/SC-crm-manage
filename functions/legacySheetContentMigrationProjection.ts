import { createHash } from "node:crypto";
import {
  createIntegrationEventV2OutboxRecord,
  createVideoSubmittedEventV2,
} from "./integrationEventV2";
import type {
  LegacySheetContentMigrationPlan,
  LegacySheetMigrationAttempt,
} from "./legacySheetContentMigrationCore";

export const LEGACY_SHEET_PORTAL_PROGRAM_ID = "view-cpm" as const;
export const LEGACY_SHEET_PORTAL_ATTEMPT_AUDIT_COLLECTION =
  "scp_creator_content_submission_audit_events";
export const LEGACY_SHEET_PORTAL_SUBMISSIONS_COLLECTION =
  "scp_creator_content_submissions";
export const LEGACY_SHEET_PORTAL_REVISIONS_COLLECTION =
  "scp_creator_content_submission_revisions";
export const LEGACY_SHEET_PORTAL_OUTBOX_COLLECTION =
  "scp_integration_event_v2_outbox";
export const LEGACY_SHEET_PORTAL_RECEIPTS_COLLECTION =
  "scp_portal_command_receipts";

export interface LegacySheetSubjectBinding {
  identityKey: string;
  enrollmentId: string;
  applicationId: string;
  programId: string;
  campaignId: string;
  outreachId?: string;
  portalCreatorId: string;
  fluCreatorId: string;
  partnerId: string;
  settlementCreatorCode?: string;
  channelId?: string;
}

export interface LegacySheetPortalWrite {
  docId: string;
  data: Readonly<Record<string, unknown>>;
}

export interface LegacySheetProjectionExclusion {
  sourceRowNumber: number;
  youtubeVideoId: string | null;
  reason:
    | "invalid_media"
    | "test_data"
    | "identity_conflict"
    | "identity_unclassified"
    | "historical_clock_missing";
}

export interface LegacySheetExpectedFluEffect {
  submissionId: string;
  youtubeVideoId: string;
  applicationId: string;
  decisionRef: string;
  targetStatus: "approved" | "rejected" | "human_review_required";
  identitySource:
    | "verified_youtube_channel_id"
    | "creator_id"
    | "human_review";
  fluCreatorId: string | null;
  enrollmentId: string | null;
  partnerId: string | null;
  channelId: string | null;
}

export interface LegacySheetFluEventPolicy {
  eventId: string;
  submissionId: string;
  youtubeVideoId: string;
  applicationId: string;
  sourceManifestId: string;
  sourceRowNumber: number;
  rawStatus: string;
  targetStatus: "approved" | "rejected" | "human_review_required";
  decidedAt: string;
  decisionRef: string;
  verifiedYoutubeChannelId?: string;
  rosterCreatorId?: string;
}

export interface LegacySheetSourceArtifactDigests {
  rowsSha256: string;
  bindingsSha256: string;
  youtubeMetadataSha256: string | null;
}

export interface LegacySheetContentMigrationProjection {
  manifestId: string;
  sourceManifestId: string;
  sourceArtifactDigests: LegacySheetSourceArtifactDigests | null;
  projectionManifestId: string;
  projectionDigest: string;
  attemptAuditWrites: LegacySheetPortalWrite[];
  submissionWrites: LegacySheetPortalWrite[];
  revisionWrites: LegacySheetPortalWrite[];
  outboxWrites: LegacySheetPortalWrite[];
  privateFluPolicies: LegacySheetFluEventPolicy[];
  expectedFluEffects: LegacySheetExpectedFluEffect[];
  exclusions: LegacySheetProjectionExclusion[];
  counts: {
    attemptAuditWrites: number;
    submissionWrites: number;
    revisionWrites: number;
    releaseEvents: number;
    approvedReleaseEvents: number;
    rejectedReleaseEvents: number;
    testDataReleaseExclusions: number;
    humanReviewReleaseEvents: number;
    bindingCandidates: number;
    creatorCandidates: number;
    partnerActivationCandidates: number;
    feedReportCandidates: number;
    reviewCallbackCandidates: number;
    downstreamCallbackCandidates: number;
    receiptMailCandidates: number;
    resultMailCandidates: number;
    automationCandidates: number;
    historicalClockFallbacks: number;
    historicalClockMissing: number;
  };
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hash(value: string, length = 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function submissionId(videoId: string): string {
  return `legacy_sheet_youtube_${videoId}`;
}

function traceId(applicationId: string): `tr_${string}` {
  return `tr_legacy_sheet_${hash(applicationId, 32)}`;
}

function verifiedChannelId(
  attempt: LegacySheetMigrationAttempt,
): string | null {
  if (
    attempt.identityResolutionSource !== "verified_youtube_channel_id" ||
    !attempt.identityKey?.startsWith("youtube_channel:")
  ) return null;
  const channelId = clean(
    attempt.identityKey.slice("youtube_channel:".length),
  );
  return /^UC[A-Za-z0-9_-]{22}$/.test(channelId) ? channelId : null;
}

function rosterCreatorId(
  attempt: LegacySheetMigrationAttempt,
): string | null {
  if (
    attempt.identityResolutionSource !== "creator_id" ||
    !attempt.identityKey?.startsWith("creator:")
  ) return null;
  return clean(attempt.identityKey.slice("creator:".length)) || null;
}

function deterministicApplicationId(
  attempt: LegacySheetMigrationAttempt,
): string {
  return `legacy_sheet_application_${hash(
    attempt.identityKey ?? `row:${attempt.sourceRowNumber}`,
    24,
  )}`;
}

function historicalIdentitySuffix(kind: string, value: string): string {
  return hash(`legacy-sheet:${kind}:${value}`, 24);
}

function expectedFluEffect(input: {
  attempt: LegacySheetMigrationAttempt;
  binding?: LegacySheetSubjectBinding;
  applicationId: string;
  submissionId: string;
  youtubeVideoId: string;
}): LegacySheetExpectedFluEffect {
  const channelId = verifiedChannelId(input.attempt);
  const rosterId =
    clean(input.binding?.fluCreatorId) || rosterCreatorId(input.attempt);
  const identitySource = channelId
    ? "verified_youtube_channel_id" as const
    : rosterId
      ? "creator_id" as const
      : "human_review" as const;
  if (identitySource === "human_review") {
    return {
      submissionId: input.submissionId,
      youtubeVideoId: input.youtubeVideoId,
      applicationId: input.applicationId,
      decisionRef: input.attempt.decisionRef,
      targetStatus: "human_review_required",
      identitySource,
      fluCreatorId: null,
      enrollmentId: null,
      partnerId: null,
      channelId: null,
    };
  }
  const identityValue = channelId || rosterId || "";
  const suffix = historicalIdentitySuffix(identitySource, identityValue);
  return {
    submissionId: input.submissionId,
    youtubeVideoId: input.youtubeVideoId,
    applicationId: input.applicationId,
    decisionRef: input.attempt.decisionRef,
    targetStatus: input.attempt.decisionStatus,
    identitySource,
    fluCreatorId:
      rosterId || `CR_legacy_youtube_${historicalIdentitySuffix(
        "channel",
        channelId ?? "",
      )}`,
    enrollmentId:
      clean(input.binding?.enrollmentId) ||
      `legacy_sheet_enrollment_${suffix}`,
    partnerId:
      clean(input.binding?.partnerId) || "scp_integration_scope",
    channelId,
  };
}

function contentType(
  attempt: LegacySheetMigrationAttempt,
): "short" | "long_form" {
  return clean(attempt.sourceRow.content_type).toLowerCase().startsWith("long")
    ? "long_form"
    : "short";
}

function normalizedRawStatus(attempt: LegacySheetMigrationAttempt): string {
  return attempt.rawStatus.trim().toLowerCase();
}

function releaseExcludedReason(
  attempt: LegacySheetMigrationAttempt,
): LegacySheetProjectionExclusion["reason"] | null {
  if (attempt.testData) return "test_data";
  if (attempt.identityClassification === "identity_conflict") {
    return "identity_conflict";
  }
  if (attempt.identityClassification === "unclassified") {
    return "identity_unclassified";
  }
  if (!attempt.legacyFormSubmittedAt) return "historical_clock_missing";
  return null;
}

function rawAttemptAudit(
  plan: LegacySheetContentMigrationPlan,
  attempt: LegacySheetMigrationAttempt,
): LegacySheetPortalWrite {
  const sourceRow = Object.fromEntries(
    Object.entries(attempt.sourceRow).filter(([, value]) => value !== undefined),
  );
  return {
    docId: `legacy_sheet_${hash(
      `${plan.manifestId}|${attempt.sourceRowNumber}|${attempt.decisionRef}`,
      40,
    )}`,
    data: {
      schemaVersion: "scp.creator-content-submission-audit.v1",
      sensitivity: "restricted_pii_private_audit",
      action: "legacy_sheet_attempt_imported",
      manifestId: plan.manifestId,
      sourceRowNumber: attempt.sourceRowNumber,
      sourceRow,
      rawStatus: attempt.rawStatus,
      decisionAuthority: "flu",
      youtubeVideoId: attempt.youtubeVideoId,
      canonicalYoutubeUrl: attempt.canonicalYoutubeUrl,
      videoRevision: attempt.videoRevision,
      youtubePublishedAt: attempt.youtubePublishedAt,
      legacyFormSubmittedAt: attempt.legacyFormSubmittedAt,
      importedAt: attempt.importedAt,
      identityKey: attempt.identityKey,
      identityResolutionSource: attempt.identityResolutionSource,
      identityClassification: attempt.identityClassification,
      mediaClassification: attempt.mediaClassification,
      testData: attempt.testData,
      exclusionReasons: attempt.exclusionReasons,
      isCurrent: attempt.isCurrent,
      decisionRef: attempt.decisionRef,
    },
  };
}

export function buildLegacySheetContentMigrationProjection(input: {
  plan: LegacySheetContentMigrationPlan;
  subjectBindings: readonly LegacySheetSubjectBinding[];
  sourceArtifactDigests?: LegacySheetSourceArtifactDigests | null;
}): LegacySheetContentMigrationProjection {
  const sourceArtifactDigests = input.sourceArtifactDigests ?? null;
  if (
    sourceArtifactDigests &&
    ![
      sourceArtifactDigests.rowsSha256,
      sourceArtifactDigests.bindingsSha256,
      sourceArtifactDigests.youtubeMetadataSha256,
    ].every((value) => value === null || /^[a-f0-9]{64}$/.test(value))
  ) {
    throw new Error("legacy_sheet_source_artifact_digest_invalid");
  }
  const bindingByIdentity = new Map<string, LegacySheetSubjectBinding>();
  for (const binding of input.subjectBindings) {
    const identityKey = clean(binding.identityKey);
    if (!identityKey) continue;
    const prior = bindingByIdentity.get(identityKey);
    if (prior && canonicalJson(prior) !== canonicalJson(binding)) {
      throw new Error(`legacy_sheet_duplicate_subject_binding:${identityKey}`);
    }
    bindingByIdentity.set(identityKey, binding);
  }

  const attemptAuditWrites = input.plan.attempts.map((attempt) =>
    rawAttemptAudit(input.plan, attempt));
  const submissionWrites: LegacySheetPortalWrite[] = [];
  const revisionWrites: LegacySheetPortalWrite[] = [];
  const outboxWrites: LegacySheetPortalWrite[] = [];
  const privateFluPolicies: LegacySheetFluEventPolicy[] = [];
  const expectedFluEffects: LegacySheetExpectedFluEffect[] = [];
  const exclusions: LegacySheetProjectionExclusion[] = [];
  const byVideo = new Map<string, LegacySheetMigrationAttempt[]>();

  for (const attempt of input.plan.attempts) {
    if (!attempt.youtubeVideoId) {
      exclusions.push({
        sourceRowNumber: attempt.sourceRowNumber,
        youtubeVideoId: null,
        reason: "invalid_media",
      });
      continue;
    }
    const group = byVideo.get(attempt.youtubeVideoId) ?? [];
    group.push(attempt);
    byVideo.set(attempt.youtubeVideoId, group);
  }

  for (const [videoId, attempts] of [...byVideo.entries()].sort()) {
    const ordered = [...attempts].sort(
      (left, right) =>
        Number(left.videoRevision ?? 0) - Number(right.videoRevision ?? 0) ||
        left.sourceRowNumber - right.sourceRowNumber,
    );
    const current = ordered.at(-1);
    if (!current || !current.isCurrent || !current.canonicalYoutubeUrl) {
      throw new Error(`legacy_sheet_current_revision_missing:${videoId}`);
    }
    const id = submissionId(videoId);
    const binding = current.identityKey
      ? bindingByIdentity.get(current.identityKey)
      : undefined;
    const applicationId =
      clean(binding?.applicationId) || deterministicApplicationId(current);
    const channelId = verifiedChannelId(current);
    const creatorId =
      clean(binding?.fluCreatorId) || rosterCreatorId(current);
    const publishedAt =
      current.youtubePublishedAt ?? current.legacyFormSubmittedAt;
    const submittedAt =
      current.legacyFormSubmittedAt ?? current.importedAt;
    const submission = {
      id,
      schemaVersion: "scp-creator-content-submission-v1",
      ...(clean(binding?.portalCreatorId)
        ? { creatorId: clean(binding?.portalCreatorId) }
        : {}),
      programId: LEGACY_SHEET_PORTAL_PROGRAM_ID,
      ...(clean(binding?.enrollmentId)
        ? { enrollmentId: clean(binding?.enrollmentId) }
        : {}),
      status: "in_review",
      revision: current.videoRevision ?? ordered.length,
      title: "Legacy XP Hero content",
      contentUrl: current.canonicalYoutubeUrl,
      platform: "youtube",
      submittedAt,
      updatedAt: submittedAt,
      submissionSource: "public_url",
      applicationId,
      applicationMatchStatus: binding
        ? "matched_application"
        : "unmatched",
    };
    submissionWrites.push({ docId: id, data: submission });

    for (const attempt of ordered) {
      revisionWrites.push({
        docId: `${id}_r${attempt.videoRevision}`,
        data: {
          ...submission,
          revision: attempt.videoRevision,
          contentUrl: attempt.canonicalYoutubeUrl,
          submittedAt: attempt.legacyFormSubmittedAt,
          updatedAt: attempt.legacyFormSubmittedAt,
          status: "in_review",
          createdAt: attempt.legacyFormSubmittedAt,
          createdBy: "legacy_sheet_import",
          sensitivity: "restricted_pii_private_revision",
          isCurrent: attempt.isCurrent,
        },
      });
    }

    const excludedReason = releaseExcludedReason(current);
    if (excludedReason) {
      exclusions.push({
        sourceRowNumber: current.sourceRowNumber,
        youtubeVideoId: videoId,
        reason: excludedReason,
      });
      continue;
    }
    if (!publishedAt || !current.legacyFormSubmittedAt) {
      exclusions.push({
        sourceRowNumber: current.sourceRowNumber,
        youtubeVideoId: videoId,
        reason: "historical_clock_missing",
      });
      continue;
    }
    const event = createVideoSubmittedEventV2({
      occurredAt: current.legacyFormSubmittedAt,
      traceId: traceId(applicationId),
      revision: current.videoRevision ?? ordered.length,
      subject: {
        programId: LEGACY_SHEET_PORTAL_PROGRAM_ID,
        applicationId,
        videoSubmissionId: id,
        youtubeVideoId: videoId,
      },
      payload: {
        canonicalVideoUrl: current.canonicalYoutubeUrl,
        youtubeVideoId: videoId,
        reportedViews: 0,
        contentType: contentType(current),
        publishedAt,
        title: "Legacy XP Hero content",
      },
    });
    const outbox = createIntegrationEventV2OutboxRecord(event);
    outboxWrites.push({ docId: outbox.id, data: outbox });
    privateFluPolicies.push({
      eventId: event.eventId,
      submissionId: id,
      youtubeVideoId: videoId,
      applicationId,
      sourceManifestId: input.plan.manifestId,
      sourceRowNumber: current.sourceRowNumber,
      rawStatus: normalizedRawStatus(current),
      targetStatus: current.decisionStatus,
      decidedAt: current.legacyFormSubmittedAt,
      decisionRef: current.decisionRef,
      ...(channelId ? { verifiedYoutubeChannelId: channelId } : {}),
      ...(creatorId ? { rosterCreatorId: creatorId } : {}),
    });
    expectedFluEffects.push(expectedFluEffect({
      attempt: current,
      binding,
      applicationId,
      submissionId: id,
      youtubeVideoId: videoId,
    }));
  }

  const approvedEffects = expectedFluEffects.filter(
    (effect) => effect.targetStatus === "approved",
  );
  const trustedEffects = expectedFluEffects.filter(
    (effect) => effect.targetStatus !== "human_review_required",
  );
  const counts = {
    attemptAuditWrites: attemptAuditWrites.length,
    submissionWrites: submissionWrites.length,
    revisionWrites: revisionWrites.length,
    releaseEvents: outboxWrites.length,
    approvedReleaseEvents: privateFluPolicies.filter(
      (policy) => policy.rawStatus === "approval",
    ).length,
    rejectedReleaseEvents: privateFluPolicies.filter(
      (policy) => policy.rawStatus !== "approval",
    ).length,
    testDataReleaseExclusions: exclusions.filter(
      (item) => item.reason === "test_data",
    ).length,
    humanReviewReleaseEvents: privateFluPolicies.filter(
      (policy) =>
        !policy.verifiedYoutubeChannelId && !policy.rosterCreatorId,
    ).length,
    bindingCandidates: new Set(
      trustedEffects.map((effect) => effect.applicationId),
    ).size,
    creatorCandidates: new Set(
      approvedEffects
        .map((effect) => effect.fluCreatorId)
        .filter((value): value is string => Boolean(value)),
    ).size,
    partnerActivationCandidates: new Set(
      approvedEffects
        .map((effect) => effect.enrollmentId)
        .filter((value): value is string => Boolean(value)),
    ).size,
    feedReportCandidates: approvedEffects.length,
    reviewCallbackCandidates: expectedFluEffects.length,
    downstreamCallbackCandidates: approvedEffects.length,
    receiptMailCandidates: 0,
    resultMailCandidates: 0,
    automationCandidates: 0,
    historicalClockFallbacks: [...byVideo.values()].filter(
      (attempts) => {
        const current = [...attempts].sort(
          (left, right) =>
            Number(left.videoRevision ?? 0) -
              Number(right.videoRevision ?? 0) ||
            left.sourceRowNumber - right.sourceRowNumber,
        ).at(-1);
        return Boolean(
          current &&
            !current.youtubePublishedAt &&
            current.legacyFormSubmittedAt,
        );
      },
    ).length,
    historicalClockMissing: exclusions.filter(
      (item) => item.reason === "historical_clock_missing",
    ).length,
  };
  const projectionBody = {
    sourceManifestId: input.plan.manifestId,
    sourceArtifactDigests,
    attemptAuditWrites,
    submissionWrites,
    revisionWrites,
    outboxWrites,
    privateFluPolicies,
    expectedFluEffects,
    exclusions,
    counts,
  };
  const projectionDigest = digest(projectionBody);
  const projectionManifestId =
    `legacy_sheet_content_projection:${projectionDigest.slice(0, 24)}`;
  return {
    manifestId: projectionManifestId,
    sourceManifestId: input.plan.manifestId,
    sourceArtifactDigests,
    projectionManifestId,
    projectionDigest,
    attemptAuditWrites,
    submissionWrites,
    revisionWrites,
    outboxWrites,
    privateFluPolicies,
    expectedFluEffects,
    exclusions,
    counts,
  };
}
