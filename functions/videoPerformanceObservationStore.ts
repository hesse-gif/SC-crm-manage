// Append-only Firestore store for raw video metric observations (video.metrics.observed.v3) plus the
// CAS-protected 168-hour exact-measurement producer/finalizer, composing the pure
// ./videoPerformanceObservationCore decision functions (.specs/spec_video_performance_settlement_report/
// spec.md §5.2-§5.3, §6, §7.2 "eligibility registrar"/"exact-window finalizer" workers).
//
// Scope (Wave-1 foundation lane — see task non-goals):
//   - NO UI, NO functions/index.ts wiring, NO scheduler creation.
//   - NO silent shadow completion: `ExactWindowMetricProvider` may return real exact-window evidence, but
//     descriptive YouTube Data API snapshots / Analytics daily rows are represented as explicit fail-closed
//     readiness receipts (`exact168hOperational=false`). When no exact provider proof is injected, finalize
//     ALWAYS stays `verification_pending` and now records the precise blocker rather than treating shadow or
//     descriptive data as complete.
//   - Country-evidence Firestore persistence, calculation, and Portal delivery/receipt stores are OTHER
//     lanes' files (spec §10 file table: videoAudienceCountryEvidence.ts / videoSettlementCalculation.ts /
//     videoSettlementDelivery.ts / videoSettlementReceiptIngress.ts) — NOT implemented here. This module
//     only owns the observation ledger + measurement CAS state.
//
// Mirrors two proven patterns in this codebase:
//   - ./scpCreatorPipelineV3ManagementAckStore: injectable `{ firestore, now }` options, deterministic doc
//     ids via sha256, reserve-before-effect transactions, fail-closed-by-omission (never fabricate).
//   - ./videoReviewTransitionStore: single `runTransaction` per command, CAS on a stored revision number.

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  canonicalizeObservationBytes,
  computeMeasurementWindow,
  computeObservationId,
  evaluateObservationBytesComparison,
  isUIntString,
  planMeasurementFinalization,
  MEASUREMENT_SCHEMA_VERSION,
  OBSERVATION_SCHEMA_VERSION,
  type MeasurementState,
  type ObservationCanonicalContent,
  type SourceCapability,
  type VideoMetricMeasurementV1,
  type VideoMetricObservationV3,
} from "./videoPerformanceObservationCore";

export const VIDEO_METRIC_OBSERVATIONS_COLLECTION = "video_metric_observations";
export const VIDEO_METRIC_MEASUREMENTS_COLLECTION = "video_metric_measurements";
export const VIDEO_METRIC_OPERATIONAL_READINESS_RECEIPTS_COLLECTION = "video_metric_operational_readiness_receipts";

function docId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 48);
}

function measurementDocId(metricKey: string): string {
  return docId(`measurement:${metricKey}`);
}

// ---- append-only observation ledger -------------------------------------------------------------------

export type AppendObservationInput = Omit<VideoMetricObservationV3, "schemaVersion" | "observationId" | "createdAt">;

export type AppendObservationResult =
  | { status: "appended"; observationId: string }
  | { status: "duplicate"; observationId: string }
  | { status: "conflict"; observationId: string; reasonCode: "video_metric_observation_conflict" };

export type AppendObservationOptions = { firestore?: FirebaseFirestore.Firestore; now?: Date };

/**
 * Append-only write of one raw metric observation. The observationId is fully deterministic from
 * (metricKey, observedAt, sourceWatermark, sourceFingerprint) — see
 * ./videoPerformanceObservationCore#computeObservationId. Re-appending the SAME canonical content is an
 * idempotent no-op ("duplicate"); appending DIFFERENT content under the same id is a "conflict" and the
 * stored row is NEVER overwritten (hard invariant: append-only + conflict-on-different-bytes).
 */
export async function appendVideoMetricObservation(
  input: AppendObservationInput,
  options: AppendObservationOptions = {},
): Promise<AppendObservationResult> {
  const db = options.firestore ?? adminDb;
  const now = options.now ?? new Date();

  const observationId = computeObservationId({
    metricKey: input.metricKey,
    observedAt: input.observedAt,
    sourceWatermark: input.sourceWatermark,
    sourceFingerprint: input.sourceFingerprint,
  });

  const canonicalContent: ObservationCanonicalContent = { ...input, schemaVersion: OBSERVATION_SCHEMA_VERSION };
  const incomingBytes = canonicalizeObservationBytes(canonicalContent);
  const ref = db.collection(VIDEO_METRIC_OBSERVATIONS_COLLECTION).doc(observationId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existingBytes = snap.exists ? (snap.data()?.canonicalBytes as string | undefined) ?? null : null;
    const comparison = evaluateObservationBytesComparison(existingBytes, incomingBytes);

    if (comparison === "duplicate") return { status: "duplicate" as const, observationId };
    if (comparison === "conflict") {
      return { status: "conflict" as const, observationId, reasonCode: "video_metric_observation_conflict" as const };
    }

    const record: VideoMetricObservationV3 = {
      ...input,
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      observationId,
      createdAt: now.toISOString(),
    };
    tx.set(ref, {
      ...record,
      canonicalBytes: incomingBytes,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { status: "appended" as const, observationId };
  });
}

// ---- 168h measurement producer ------------------------------------------------------------------------

export type RegisterMeasurementInput = Readonly<{
  metricKey: string;
  eligibilityEpoch: string;
  enrollmentId: string;
  videoSubmissionId: string;
  revision: string;
  youtubeVideoId: string;
  publishedAt: string;
}>;

export type RegisterMeasurementResult =
  | { status: "registered"; measurementEndExclusive: string }
  | { status: "invalid_published_at" }
  | { status: "already_exists" };

/**
 * Producer: creates the initial `not_started` measurement row with `measurementStartAt = publishedAt`
 * and `measurementEndExclusive = publishedAt + 168h` (spec §3.4/§5.3). Never overwrites an existing
 * measurement row for the same metricKey — a re-registration attempt is a no-op ("already_exists"); a new
 * eligibilityEpoch after revision replacement always derives a NEW metricKey (spec §3.2), so this never
 * needs to mutate a prior epoch's row.
 */
export async function registerVideoMetricMeasurement(
  input: RegisterMeasurementInput,
  options: AppendObservationOptions = {},
): Promise<RegisterMeasurementResult> {
  const window = computeMeasurementWindow(input.publishedAt);
  if (!window) return { status: "invalid_published_at" };

  const db = options.firestore ?? adminDb;
  const now = options.now ?? new Date();
  const ref = db.collection(VIDEO_METRIC_MEASUREMENTS_COLLECTION).doc(measurementDocId(input.metricKey));

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return { status: "already_exists" as const };

    const record: VideoMetricMeasurementV1 = {
      schemaVersion: MEASUREMENT_SCHEMA_VERSION,
      metricKey: input.metricKey,
      eligibilityEpoch: input.eligibilityEpoch,
      enrollmentId: input.enrollmentId,
      videoSubmissionId: input.videoSubmissionId,
      revision: input.revision,
      youtubeVideoId: input.youtubeVideoId,
      state: "not_started",
      publishedAt: input.publishedAt,
      measurementStartAt: window.measurementStartAt,
      measurementEndExclusive: window.measurementEndExclusive,
      revisionNumber: 0,
      updatedAt: now.toISOString(),
    };
    tx.set(ref, { ...record, updatedAt: FieldValue.serverTimestamp(), updatedAtIso: record.updatedAt });
    return { status: "registered" as const, measurementEndExclusive: window.measurementEndExclusive };
  });
}

// SHADOW-MODE adapter interface only — NOT activated, NOT called over the network anywhere in this lane.
// Tests inject a fake implementation; production wiring (real YouTube Analytics/Data API calls) is
// explicitly out of scope (task non-goals). Absence of a provider (or a provider returning `null`) means
// the finalizer can never observe an exact-boundary proof and finalize() stays `verification_pending`.
export interface ExactWindowMetricResult {
  sourceCapability: SourceCapability;
  sourceProvesExactBoundary: true;
  totalViewsAtCutoff: string;
  eligibleViews: string;
  excludedViews: string;
  exclusionReasons?: Array<{ code: string; views: string }>;
  exactEvidenceObservationId?: string;
}

export interface ExactWindowMetricUnavailable {
  sourceCapability: Exclude<SourceCapability, "exact_window"> | "exact_window";
  sourceProvesExactBoundary: false;
  exact168hOperational: false;
  blockerCode: "video_metric_exact_source_unavailable" | "video_metric_provider_not_configured" | "video_metric_provider_external_state_unavailable";
  readinessReceipt?: Record<string, unknown> & { receiptId?: string; exact168hOperational?: false };
}

export type ExactWindowMetricProviderResult = ExactWindowMetricResult | ExactWindowMetricUnavailable;

export interface ExactWindowMetricProvider {
  fetchExactWindowMetric(input: {
    metricKey: string;
    youtubeVideoId: string;
    measurementStartAt: string;
    measurementEndExclusive: string;
  }): Promise<ExactWindowMetricProviderResult | null>;
}

export type FinalizeMeasurementInput = Readonly<{
  metricKey: string;
  presentedRevisionNumber: number;
  isCurrentRevision: boolean;
  withdrawn: boolean;
  superseded: boolean;
  invalidatedReason?: "superseded" | "withdrawn" | "approval_reversed" | "identity_conflict";
}>;

export type FinalizeMeasurementResult = Readonly<{
  applied: boolean;
  state: MeasurementState;
  reasonCode: string;
}>;

export type FinalizeMeasurementOptions = AppendObservationOptions & { provider?: ExactWindowMetricProvider };

/**
 * Finalizer: CAS-transitions the stored measurement row using ./videoPerformanceObservationCore's
 * `planMeasurementFinalization`. A prior/superseded `presentedRevisionNumber` (lower than the row's
 * stored `revisionNumber`) is ALWAYS rejected — the row is left untouched. A provider that is absent, that
 * returns `null`, or that reports `sourceProvesExactBoundary: false` leaves the row in
 * `verification_pending` and never writes eligibleViews. On success the row transitions to `finalized`
 * exactly once for a given (metricKey, revisionNumber); the finalized row is otherwise immutable.
 */
export async function finalizeVideoMetricMeasurement(
  input: FinalizeMeasurementInput,
  options: FinalizeMeasurementOptions = {},
): Promise<FinalizeMeasurementResult> {
  const db = options.firestore ?? adminDb;
  const now = options.now ?? new Date();
  const ref = db.collection(VIDEO_METRIC_MEASUREMENTS_COLLECTION).doc(measurementDocId(input.metricKey));

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { applied: false, state: "not_started" as const, reasonCode: "video_metric_revision_not_current" };
    const data = snap.data() as (VideoMetricMeasurementV1 & { canonicalBytes?: string }) | undefined;
    if (!data) return { applied: false, state: "not_started" as const, reasonCode: "video_metric_revision_not_current" };

    const storedRevisionNumber = Number(data.revisionNumber ?? 0);
    const currentState = data.state as MeasurementState;

    // The provider fetch happens BEFORE the finalization decision so `sourceProvesExactBoundary` reflects
    // reality; a missing/null provider result fails closed to "no exact proof" rather than fabricating one.
    const providerResult = options.provider
      ? await options.provider.fetchExactWindowMetric({
          metricKey: input.metricKey,
          youtubeVideoId: data.youtubeVideoId,
          measurementStartAt: data.measurementStartAt,
          measurementEndExclusive: data.measurementEndExclusive,
        })
      : null;

    const exactProviderResult = providerResult?.sourceProvesExactBoundary === true ? providerResult : null;
    const readinessReceipt = providerResult && providerResult.sourceProvesExactBoundary === false
      ? providerResult.readinessReceipt ?? null
      : null;

    const decision = planMeasurementFinalization({
      storedRevisionNumber,
      presentedRevisionNumber: input.presentedRevisionNumber,
      currentState,
      isCurrentRevision: input.isCurrentRevision,
      withdrawn: input.withdrawn,
      superseded: input.superseded,
      nowIso: now.toISOString(),
      measurementEndExclusive: data.measurementEndExclusive,
      sourceCapability: providerResult?.sourceCapability ?? "current_cumulative",
      sourceProvesExactBoundary: exactProviderResult?.sourceProvesExactBoundary === true,
      totalViewsAtCutoff: exactProviderResult?.totalViewsAtCutoff ?? "0",
      eligibleViews: exactProviderResult?.eligibleViews ?? "0",
      excludedViews: exactProviderResult?.excludedViews ?? "0",
    });

    if (!decision.allowed) {
      // verification_pending / cutoff_waiting_source / invalidated are all still worth persisting so the
      // report row reflects reality, but NEVER write eligibleViews/finalizedAt when not allowed.
      if (decision.nextState !== currentState || readinessReceipt) {
        const receiptId = typeof readinessReceipt?.receiptId === "string" ? readinessReceipt.receiptId : null;
        tx.set(
          ref,
          {
            state: decision.nextState,
            revisionNumber: Math.max(storedRevisionNumber, input.presentedRevisionNumber),
            lastErrorCode: decision.reasonCode,
            ...(readinessReceipt
              ? {
                  exact168hOperational: false,
                  operationalReadinessReceiptId: receiptId,
                  operationalReadinessReceipt: readinessReceipt,
                }
              : {}),
            ...(decision.nextState === "invalidated"
              ? { invalidatedAt: now.toISOString(), invalidatedReason: input.invalidatedReason ?? "identity_conflict" }
              : {}),
            updatedAt: FieldValue.serverTimestamp(),
            updatedAtIso: now.toISOString(),
          },
          { merge: true },
        );
        if (receiptId) {
          const readinessRecord = readinessReceipt as Record<string, unknown>;
          const receiptCreatedAtIso = typeof readinessRecord.createdAtIso === "string"
            ? readinessRecord.createdAtIso
            : typeof readinessRecord.assessedAtIso === "string"
              ? readinessRecord.assessedAtIso
              : now.toISOString();
          tx.set(
            db.collection(VIDEO_METRIC_OPERATIONAL_READINESS_RECEIPTS_COLLECTION).doc(receiptId),
            {
              ...readinessReceipt,
              metricKey: input.metricKey,
              createdAtIso: receiptCreatedAtIso,
              updatedAt: FieldValue.serverTimestamp(),
              updatedAtIso: now.toISOString(),
            },
            { merge: true },
          );
        }
      }
      return { applied: false, state: decision.nextState, reasonCode: decision.reasonCode };
    }

    if (!isUIntString(exactProviderResult?.eligibleViews) || !isUIntString(exactProviderResult?.excludedViews) || !isUIntString(exactProviderResult?.totalViewsAtCutoff)) {
      return { applied: false, state: "conflict", reasonCode: "video_metric_measurement_conflict" };
    }

    tx.set(
      ref,
      {
        state: "finalized",
        revisionNumber: input.presentedRevisionNumber,
        totalViewsAtCutoff: exactProviderResult.totalViewsAtCutoff,
        eligibleViews: exactProviderResult.eligibleViews,
        excludedViews: exactProviderResult.excludedViews,
        exclusionReasons: exactProviderResult.exclusionReasons ?? [],
        exactEvidenceObservationId: exactProviderResult.exactEvidenceObservationId ?? null,
        exact168hOperational: true,
        operationalReadinessReceiptId: null,
        finalizedAt: now.toISOString(),
        lastErrorCode: null,
        updatedAt: FieldValue.serverTimestamp(),
        updatedAtIso: now.toISOString(),
      },
      { merge: true },
    );
    return { applied: true, state: "finalized", reasonCode: "finalized" };
  });
}

// ---- Report projection aggregate helpers (NOT implemented in this lane) -------------------------------
//
// The projection-builder lane (spec §7.2 "projection builder" worker; §10 videoPerformanceProjection.ts)
// owns `video_performance_report_rows` / `video_performance_report_summaries` materialization. This lane
// only fixes the CONTRACT every such helper must satisfy: every list/aggregate accessor MUST be bounded by
// an explicit limit and an opaque cursor, and MUST be backed by one of the declared composite indexes
// below — none may scan an entire collection (spec §1.2, §9.1-§9.2).
//
//   listVideoMetricObservations(options: { metricKey: string; cursor?: string; limit: number })
//     => Promise<{ rows: VideoMetricObservationV3[]; nextCursor: string | null }>
//   listPendingMeasurementFinalizations(options: { cursor?: string; limit: number })
//     => Promise<{ rows: VideoMetricMeasurementV1[]; nextCursor: string | null }>
//   listVideoPerformanceReportRows(options: { filterBucketId: string; cursor?: string; limit: number })
//     => Promise<{ rows: unknown[]; nextCursor: string | null }>
//
// Required composite indexes for the above (spec §9.2; NOT declared in firestore.indexes.json by this
// lane — that file is integration-leader-owned):
//   video_metric_observations: metricKey ASC, observedAt DESC, __name__ ASC
//   video_metric_measurements: state ASC, measurementEndExclusive ASC, __name__ ASC
//   video_performance_report_rows: reportEligible ASC, attentionRank ASC, measurementEndExclusive ASC,
//                                  lastSyncedAt DESC, __name__ ASC
