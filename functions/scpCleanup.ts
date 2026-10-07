// SCP TTL/rate-limit housekeeping (Wave3 W3-3, P1-8 growth finding).
//
// Scope (per Wave3 W3-3 spec — intentionally narrow, matches the "구현" directive):
//   - qualification_judge_cache / video_review_judge_cache: delete entries whose
//     own recorded TTL has already elapsed (expiresAtIso / expiresAtMs).
//   - program_application_rate_limits / submission_upload_throttles: delete
//     counters whose rate-limit window closed well in the past.
//
// Explicitly OUT of scope here (left untouched — see docs/GAPS.md):
//   - scp_mail_results / sheet_raw_rows are audit/ledger-shaped records (the
//     latter is written with `immutable: true` and is also read back by
//     sheetIntakeRepository's legacy dedup fallback query). Deleting them is a
//     ledger-integrity decision, not a pure TTL-cache cleanup, so it is left for
//     a follow-up that can define a safe retention policy deliberately.
//
// Safety: every collection is cleaned in small batches with a per-run cap, so a
// single invocation can never runaway-delete an unexpectedly large backlog. The
// job is idempotent and safe to run repeatedly/concurrently (it only ever
// deletes documents that already match an "expired" predicate).
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  datasetSourceProfile,
  SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD,
} from "./scpSheetPublicProjection";

const QUALIFICATION_JUDGE_CACHE_COLLECTION = "qualification_judge_cache";
const VIDEO_REVIEW_JUDGE_CACHE_COLLECTION = "video_review_judge_cache";
const PROGRAM_APPLICATION_RATE_LIMITS_COLLECTION = "program_application_rate_limits";
const SUBMISSION_UPLOAD_THROTTLES_COLLECTION = "submission_upload_throttles";
const SHEET3_MANUAL_CHECKPOINT_COLLECTION = "sheet3_manual_plan_checkpoints";
const SHEET3_MANUAL_CHECKPOINT_CHILD_COLLECTIONS = ["chunks", "rows"] as const;
const SHEET_OPERATION_PREVIEW_COLLECTION = "sheet_source_operation_previews";
const SHEET_OPERATION_PREVIEW_SCHEMA_VERSION = "sheet-source-operation-preview-v1";
const SHEET_SOURCE_SYNC_OPERATION_PREFIX = "sheet-source-sync-";
const SHEET_SOURCE_SYNC_TOKEN_VERSION = "sheet-source-sync-v1";
const SHEET_SOURCE_SYNC_OPERATION = "sheet_source.sync";
const SHEET3_MANUAL_TOKEN_VERSION = "sheet3-submission-bridge-v1";
const SHEET3_MANUAL_OPERATION = "sheet_source.video_submission_bridge";
const APPLY_RECOVERY_RETENTION_MS = 24 * 60 * 60 * 1000;
const FAILED_RECOVERY_RETENTION_MS = 24 * 60 * 60 * 1000;

// program_application_rate_limits buckets are hour-granularity (see
// programs.ts programApplicationRateLimits: `bucket = nowIso.slice(0, 13)`), so
// a bucket is meaningless again well within a couple of hours. 24h is a
// generous safety margin against clock skew before we ever delete one.
const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;

// submission_upload_throttles windows are 10 minutes (see submissionTasks.ts
// UPLOAD_THROTTLE_WINDOW_MS). 2h is a generous safety margin past window close.
const THROTTLE_RETENTION_MS = 2 * 60 * 60 * 1000;

// Qualification projection applies can be recovered for 24 hours. A
// reservation older than that recovery boundary cannot be resumed by its
// preview capability and may otherwise block every later sync forever.
const QUALIFICATION_PROJECTION_RESERVATION_RETENTION_MS = 24 * 60 * 60 * 1000;

const DELETE_BATCH_SIZE = 300; // well under Firestore's 500-write batch cap
const MAX_BATCHES_PER_COLLECTION = 10; // caps a single run at ~3,000 deletes/collection

export type ScpCleanupCounters = {
  qualificationJudgeCacheDeleted: number;
  videoReviewJudgeCacheDeleted: number;
  programApplicationRateLimitsDeleted: number;
  submissionUploadThrottlesDeleted: number;
  qualificationProjectionReservationsReleased: number;
  sheet3ManualCheckpointChildrenDeleted: number;
  sheet3ManualCheckpointsDeleted: number;
  sheet3ManualCheckpointReservationsReleased: number;
};

export type ScpCleanupOptions = {
  nowIso?: string;
  batchSize?: number;
  maxBatchesPerCollection?: number;
};

export type ScpCleanupResult = ScpCleanupCounters & {
  ok: true;
  nowIso: string;
  totalDeleted: number;
};

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function positiveIntOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

// Deletes documents in `collectionName` whose `field` value is strictly less
// than `cutoff` (ISO string or epoch millis — Firestore compares both
// correctly for their respective types), in small batches, up to
// `maxBatches` iterations. Returns the number of documents deleted.
async function deleteExpiredBefore(
  collectionName: string,
  field: string,
  cutoff: string | number,
  batchSize: number,
  maxBatches: number,
): Promise<number> {
  let totalDeleted = 0;
  for (let iteration = 0; iteration < maxBatches; iteration += 1) {
    const snapshot = await adminDb
      .collection(collectionName)
      .where(field, "<", cutoff)
      .limit(batchSize)
      .get();
    if (snapshot.empty) break;

    const batch = adminDb.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    totalDeleted += snapshot.docs.length;

    if (snapshot.docs.length < batchSize) break; // fewer than a full page: nothing more to sweep right now
  }
  return totalDeleted;
}

type Sheet3CheckpointCleanupResult = {
  childrenDeleted: number;
  checkpointsDeleted: number;
  reservationsReleased: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveIntegerOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function qualificationPreviewReference(
  operationId: string,
): DocumentReference | null {
  const escapedPrefix = SHEET_SOURCE_SYNC_OPERATION_PREFIX.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const match = operationId.match(new RegExp(`^${escapedPrefix}([a-f0-9]{40})$`));
  return match
    ? adminDb.collection(SHEET_OPERATION_PREVIEW_COLLECTION).doc(`claim-${match[1]}`)
    : null;
}

function sheet3CheckpointPreviewReference(
  manifestRef: DocumentReference,
  manifest: Record<string, unknown>,
): DocumentReference | null {
  const previewTokenHash = asString(manifest.previewTokenHash).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(previewTokenHash)) return null;
  const suffix = previewTokenHash.slice(0, 40);
  if (manifestRef.id !== `checkpoint-${suffix}`) return null;
  return adminDb.collection(SHEET_OPERATION_PREVIEW_COLLECTION).doc(`claim-${suffix}`);
}

function sheetOperationPreviewIdentityMatches(
  preview: Record<string, unknown>,
  expected: {
    tokenVersion: string;
    operation: string;
    sourceKey: string;
    sourceId: string;
  },
): boolean {
  return preview.schemaVersion === SHEET_OPERATION_PREVIEW_SCHEMA_VERSION &&
    asString(preview.tokenVersion) === expected.tokenVersion &&
    asString(preview.operation) === expected.operation &&
    asString(preview.sourceKey) === expected.sourceKey &&
    asString(preview.sourceId) === expected.sourceId;
}

function sheetOperationPreviewRecoveryActive(
  preview: Record<string, unknown>,
  nowMs: number,
): boolean {
  const status = asString(preview.status);
  if (status === "pending") {
    return recoveryBoundary(preview.expiresAtIso) > nowMs;
  }
  if (status === "applying") {
    return recoveryBoundary(
      preview.applyingRetentionExpiresAtIso,
      preview.applyingAtIso,
      APPLY_RECOVERY_RETENTION_MS,
    ) > nowMs;
  }
  if (status === "failed") {
    return recoveryBoundary(
      preview.failedRetentionExpiresAtIso,
      asString(preview.failedAtIso) || preview.applyingAtIso,
      FAILED_RECOVERY_RETENTION_MS,
    ) > nowMs;
  }
  if (status === "completed") return false;

  // Unknown or malformed preview state fails closed. Cleanup must never infer
  // that an unrecognised execution capability is abandoned.
  return true;
}

function recoveryBoundary(
  explicitValue: unknown,
  stateAtValue?: unknown,
  retentionMs = 0,
): number {
  const explicit = Date.parse(asString(explicitValue));
  if (Number.isFinite(explicit)) return explicit;
  const stateAt = Date.parse(asString(stateAtValue));
  return Number.isFinite(stateAt) ? stateAt + retentionMs : Number.POSITIVE_INFINITY;
}

async function releaseExpiredQualificationProjectionReservation(
  nowIso: string,
): Promise<number> {
  const nowMs = Date.parse(nowIso);
  const cutoffMs = nowMs - QUALIFICATION_PROJECTION_RESERVATION_RETENTION_MS;
  if (!Number.isFinite(cutoffMs)) return 0;

  const profile = datasetSourceProfile("scpQualificationRows");
  const sourceRef = adminDb.collection("intake_sources").doc(profile.sourceId);
  return adminDb.runTransaction(async (transaction) => {
    const sourceSnapshot = await transaction.get(sourceRef);
    if (!sourceSnapshot.exists) return 0;
    const source = asRecord(sourceSnapshot.data());
    const reservation = asRecord(
      asRecord(source.publicProjectionBuilds).scpQualificationRows,
    );
    const operationId = asString(reservation.operationId);
    const previewRef = qualificationPreviewReference(operationId);
    const buildToken = asString(reservation.buildToken).toLowerCase();
    const reservedAtMs = Date.parse(asString(reservation.reservedAtIso));
    const generation = positiveIntegerOrNull(reservation.generation);
    if (
      !previewRef ||
      !/^[a-f0-9]{64}$/.test(buildToken) ||
      reservation.datasetKey !== "scpQualificationRows" ||
      reservation.sourceId !== profile.sourceId ||
      generation === null ||
      !Number.isFinite(reservedAtMs) ||
      reservedAtMs >= cutoffMs
    ) {
      return 0;
    }

    const previewSnapshot = await transaction.get(previewRef);
    const preview = asRecord(previewSnapshot.data());
    if (
      previewSnapshot.exists &&
      (!sheetOperationPreviewIdentityMatches(preview, {
        tokenVersion: SHEET_SOURCE_SYNC_TOKEN_VERSION,
        operation: SHEET_SOURCE_SYNC_OPERATION,
        sourceKey: "participant_selection",
        sourceId: profile.sourceId,
      }) || sheetOperationPreviewRecoveryActive(preview, nowMs))
    ) {
      return 0;
    }

    // Touch the same preview document that begin/retry transactions write.
    // Firestore therefore retries this cleanup if an apply starts concurrently;
    // the retry observes the live/recoverable lease and preserves the fence.
    if (previewSnapshot.exists) {
      transaction.update(previewRef, {
        cleanupFenceAtIso: nowIso,
        cleanupFenceBy: "scp_cleanup",
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    const watermarks = asRecord(
      source[SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD],
    );
    transaction.update(sourceRef, {
      "publicProjectionBuilds.scpQualificationRows": FieldValue.delete(),
      [`${SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD}.scpQualificationRows`]:
        Math.max(nonNegativeInteger(watermarks.scpQualificationRows), generation),
      updatedAtIso: nowIso,
      updatedBy: "scp_cleanup",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return 1;
  });
}

async function claimExpiredSheet3CheckpointCleanup(
  manifestRef: DocumentReference,
  nowIso: string,
): Promise<{ claimed: boolean; reservationReleased: boolean }> {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return { claimed: false, reservationReleased: false };
  return adminDb.runTransaction(async (transaction) => {
    const manifestSnapshot = await transaction.get(manifestRef);
    if (!manifestSnapshot.exists) {
      return { claimed: false, reservationReleased: false };
    }
    const manifest = asRecord(manifestSnapshot.data());
    const deleteAfterIso = asString(manifest.deleteAfterIso);
    if (
      !deleteAfterIso ||
      !Number.isFinite(Date.parse(deleteAfterIso)) ||
      Date.parse(deleteAfterIso) >= nowMs
    ) {
      return { claimed: false, reservationReleased: false };
    }

    const operationId = asString(manifest.operationId);
    const sourceId = asString(manifest.sourceId);
    const profile = datasetSourceProfile("scpVideoRows");
    const previewRef = sheet3CheckpointPreviewReference(manifestRef, manifest);
    if (!previewRef || sourceId !== profile.sourceId || !operationId) {
      return { claimed: false, reservationReleased: false };
    }
    const previewSnapshot = await transaction.get(previewRef);
    const preview = asRecord(previewSnapshot.data());
    if (
      previewSnapshot.exists &&
      (!sheetOperationPreviewIdentityMatches(preview, {
        tokenVersion: SHEET3_MANUAL_TOKEN_VERSION,
        operation: SHEET3_MANUAL_OPERATION,
        sourceKey: "content_review",
        sourceId,
      }) || sheetOperationPreviewRecoveryActive(preview, nowMs))
    ) {
      return { claimed: false, reservationReleased: false };
    }

    const sourceRef = adminDb.collection("intake_sources").doc(sourceId);
    const sourceSnapshot = await transaction.get(sourceRef);
    const source = asRecord(sourceSnapshot.data());
    const reservation = asRecord(
      asRecord(source.publicProjectionBuilds).scpVideoRows,
    );
    let reservationReleased = false;
    const generation = positiveIntegerOrNull(reservation.generation);
    if (
      sourceSnapshot.exists &&
      asString(reservation.operationId) === operationId &&
      asString(reservation.datasetKey) === "scpVideoRows" &&
      asString(reservation.sourceId) === sourceId &&
      generation !== null
    ) {
      const watermarks = asRecord(
        source[SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD],
      );
      transaction.update(sourceRef, {
        "publicProjectionBuilds.scpVideoRows": FieldValue.delete(),
        [`${SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD}.scpVideoRows`]:
          Math.max(nonNegativeInteger(watermarks.scpVideoRows), generation),
        updatedAtIso: nowIso,
        updatedBy: "scp_cleanup",
        updatedAt: FieldValue.serverTimestamp(),
      });
      reservationReleased = true;
    }

    if (previewSnapshot.exists) {
      transaction.update(previewRef, {
        cleanupFenceAtIso: nowIso,
        cleanupFenceBy: "scp_cleanup",
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    // Claim before deleting child chunks. A concurrent begin writes the same
    // preview document and forces this transaction to retry; after the claim,
    // the checkpoint is no longer readable as a ready reviewed plan.
    transaction.update(manifestRef, {
      status: "cleanup_pending",
      cleanupClaimedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { claimed: true, reservationReleased };
  });
}

async function deleteClaimedSheet3CheckpointManifest(
  manifestRef: DocumentReference,
  nowIso: string,
): Promise<boolean> {
  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(manifestRef);
    if (!snapshot.exists) return false;
    const manifest = asRecord(snapshot.data());
    const deleteAfterMs = Date.parse(asString(manifest.deleteAfterIso));
    const nowMs = Date.parse(nowIso);
    if (
      manifest.status !== "cleanup_pending" ||
      !Number.isFinite(deleteAfterMs) ||
      !Number.isFinite(nowMs) ||
      deleteAfterMs >= nowMs
    ) {
      return false;
    }
    transaction.delete(manifestRef);
    return true;
  });
}

async function deleteExpiredSheet3ManualCheckpoints(
  nowIso: string,
  batchSize: number,
  maxBatches: number,
): Promise<Sheet3CheckpointCleanupResult> {
  let childrenDeleted = 0;
  let checkpointsDeleted = 0;
  let reservationsReleased = 0;
  let remainingDeleteBudget = batchSize * maxBatches;

  while (remainingDeleteBudget > 0) {
    const manifests = await adminDb
      .collection(SHEET3_MANUAL_CHECKPOINT_COLLECTION)
      .where("deleteAfterIso", "<", nowIso)
      .limit(Math.min(batchSize, remainingDeleteBudget))
      .get();
    if (manifests.empty) break;
    let progressed = false;

    for (const manifest of manifests.docs) {
      const claimed = await claimExpiredSheet3CheckpointCleanup(manifest.ref, nowIso);
      if (!claimed.claimed) continue;
      if (claimed.reservationReleased) reservationsReleased += 1;
      progressed = true;

      for (const childCollection of SHEET3_MANUAL_CHECKPOINT_CHILD_COLLECTIONS) {
        while (remainingDeleteBudget > 0) {
          const children = await manifest.ref
            .collection(childCollection)
            .limit(Math.min(batchSize, remainingDeleteBudget))
            .get();
          if (children.empty) break;
          const batch = adminDb.batch();
          children.docs.forEach((document) => batch.delete(document.ref));
          await batch.commit();
          childrenDeleted += children.size;
          remainingDeleteBudget -= children.size;
          progressed = true;
        }
      }
      if (remainingDeleteBudget <= 0) break;

      const remainingChildren = await Promise.all(
        SHEET3_MANUAL_CHECKPOINT_CHILD_COLLECTIONS.map((childCollection) =>
          manifest.ref.collection(childCollection).limit(1).get()),
      );
      if (remainingChildren.some((snapshot) => !snapshot.empty)) continue;

      const checkpointDeleted = await deleteClaimedSheet3CheckpointManifest(
        manifest.ref,
        nowIso,
      );
      if (checkpointDeleted) {
        checkpointsDeleted += 1;
        remainingDeleteBudget -= 1;
        progressed = true;
      }
    }

    if (!progressed) break;
  }

  return { childrenDeleted, checkpointsDeleted, reservationsReleased };
}

export async function scpCleanup(options: ScpCleanupOptions = {}): Promise<ScpCleanupResult> {
  const nowIso = asString(options.nowIso, new Date().toISOString());
  const nowMs = Date.parse(nowIso);
  const batchSize = Math.min(positiveIntOr(options.batchSize, DELETE_BATCH_SIZE), 450);
  const maxBatches = positiveIntOr(options.maxBatchesPerCollection, MAX_BATCHES_PER_COLLECTION);

  const rateLimitCutoffIso = new Date(nowMs - RATE_LIMIT_RETENTION_MS).toISOString();
  const throttleCutoffIso = new Date(nowMs - THROTTLE_RETENTION_MS).toISOString();

  const [
    qualificationJudgeCacheDeleted,
    videoReviewJudgeCacheDeleted,
    programApplicationRateLimitsDeleted,
    submissionUploadThrottlesDeleted,
    qualificationProjectionReservationsReleased,
    sheet3CheckpointCleanup,
  ] = await Promise.all([
    // expiresAtIso is set to (write time + TTL) — anything less than "now" has expired.
    deleteExpiredBefore(QUALIFICATION_JUDGE_CACHE_COLLECTION, "expiresAtIso", nowIso, batchSize, maxBatches),
    // expiresAtMs is set to (write time-ms + TTL-ms) — anything less than "now" (ms) has expired.
    deleteExpiredBefore(VIDEO_REVIEW_JUDGE_CACHE_COLLECTION, "expiresAtMs", nowMs, batchSize, maxBatches),
    deleteExpiredBefore(PROGRAM_APPLICATION_RATE_LIMITS_COLLECTION, "updatedAtIso", rateLimitCutoffIso, batchSize, maxBatches),
    deleteExpiredBefore(SUBMISSION_UPLOAD_THROTTLES_COLLECTION, "windowStartedAtIso", throttleCutoffIso, batchSize, maxBatches),
    releaseExpiredQualificationProjectionReservation(nowIso),
    deleteExpiredSheet3ManualCheckpoints(nowIso, batchSize, maxBatches),
  ]);

  return {
    ok: true,
    nowIso,
    qualificationJudgeCacheDeleted,
    videoReviewJudgeCacheDeleted,
    programApplicationRateLimitsDeleted,
    submissionUploadThrottlesDeleted,
    qualificationProjectionReservationsReleased,
    sheet3ManualCheckpointChildrenDeleted: sheet3CheckpointCleanup.childrenDeleted,
    sheet3ManualCheckpointsDeleted: sheet3CheckpointCleanup.checkpointsDeleted,
    sheet3ManualCheckpointReservationsReleased: sheet3CheckpointCleanup.reservationsReleased,
    totalDeleted: qualificationJudgeCacheDeleted + videoReviewJudgeCacheDeleted +
      programApplicationRateLimitsDeleted + submissionUploadThrottlesDeleted +
      sheet3CheckpointCleanup.childrenDeleted + sheet3CheckpointCleanup.checkpointsDeleted,
  };
}
