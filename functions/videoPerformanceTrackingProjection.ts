// GAP-B (FLU-0538 completion, operator-locked 2026-07-21): descriptive video-tracking projection.
//
// The video-performance settlement report (functions/videoPerformanceReportProjection.ts) is, and stays,
// APPROVED-CURRENT-ONLY — `reportEligible = isCurrentRevision && isApproved`, and the settlement summary
// only ever aggregates those rows (hard invariant, adversarial-reviewed). Production has 0 v3-approved
// videos (`scp_video_review_state` = 0), so that settlement ledger is legitimately empty today.
//
// BUT ~940 `video_view_snapshots` / 104 `video_view_series` real tracked videos exist and carry real view
// numbers. The operator (2026-07-21) locked: "영상 + 리포트 백필은 무조건 진행 … 매핑 안 되는 레거시
// 추적영상은 리포트 전용(descriptive)로만 표시하고 정산-eligible로 올리지 말 것." (Show tracked videos as
// report-only descriptive; NEVER raise them to settlement-eligible.)
//
// This module is that descriptive tier. It is PURELY ADDITIVE: it produces `VideoPerformanceReportRow`
// values with `isApproved=false` → `reportEligible=false` (so `isReportEligible`/`summarizeVideoPerformance`
// never count them in any settlement aggregate), tagged so the store can persist a separate
// `descriptive`/`reportVisible` query surface. It NEVER mutates the frozen settlement projection, its
// predicates, or its callables.
//
// It also NEVER fabricates attribution: a tracked video whose `submissionId` cannot be resolved to a real
// creator/enrollment is rendered UNRESOLVED ("미귀속"), not stapled onto a guessed identity. Raw
// submission tokens are never surfaced — the resolver only ever emits canonical ids / a masked alias.
//
// Pure logic ONLY (no Firestore/network); the store layer (./videoPerformanceTrackingStore.ts) injects
// data access and the backfill script composes these functions.
import {
  buildCursorPage,
  resolveCreatorDisplayIdentity,
  resolveCursorPageRequest,
  type CursorPage,
  type CursorPageRequest,
} from "./managementProfileTabsReadModels";
import type { VideoPerformanceReportRow } from "./videoPerformanceReportProjection";

export type IsoInstant = string;
export type UIntString = string;

// UNRESOLVED sentinels — honest "미귀속" markers, never a fabricated real identity.
export const UNRESOLVED_CREATOR_ID = "" as const;
export const UNRESOLVED_ENROLLMENT_ID = "" as const;
export const UNCLASSIFIED_PROGRAM_ID = "unclassified" as const;
export const UNCLASSIFIED_PROGRAM_NAME = "미분류" as const;
export const UNRESOLVED_DISPLAY_NAME = "(미귀속 추적 영상)" as const;

export const MEASUREMENT_WINDOW_MS = 168 * 60 * 60 * 1000;

const UINT_RE = /^\d+$/;
function toUint(value: unknown): UIntString {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.trunc(value).toString();
  if (typeof value === "string" && UINT_RE.test(value)) return value;
  return "0";
}

function isoOrNull(value: unknown): IsoInstant | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// One tracked video, as read from video_view_series (+ the store's best-effort submission/creator
// resolution). Raw token submissionIds are NEVER passed through here — the store resolves them to a
// canonical id / masked alias before constructing this input.
export interface TrackedVideoInput {
  readonly youtubeVideoId: string;
  readonly totalViews: unknown;
  readonly latestDailyDeltaViews?: unknown;
  readonly publishedAtIso?: unknown;
  readonly updatedAtIso?: unknown;
  readonly dayCount?: unknown;
  // Resolution (all optional; absent => UNRESOLVED / report-only, never fabricated):
  readonly resolvedCreatorId?: string | null;
  readonly resolvedDisplayName?: string | null;
  readonly resolvedHandle?: string | null;
  readonly resolvedCreatorProfileImageUrl?: string | null;
  readonly resolvedEnrollmentId?: string | null;
  readonly resolvedProgramId?: string | null;
  readonly resolvedProgramName?: string | null;
  readonly resolvedTitle?: string | null;
  readonly resolvedThumbnailUrl?: string | null;
  readonly resolvedChannelTitle?: string | null;
  // True only when the resolved submission carried an approved/passed review lifecycle. This NEVER makes
  // the row settlement-eligible on its own (that still requires the full v3 approval ledger) — it is
  // surfaced as evidence for the GAP-D partner-backfill inventory, not consumed by the report.
  readonly hasApprovedSubmissionEvidence?: boolean;
}

export const DESCRIPTIVE_ROW_ID_PREFIX = "track:v:" as const;

export function descriptiveRowId(youtubeVideoId: string): string {
  return `${DESCRIPTIVE_ROW_ID_PREFIX}${youtubeVideoId}`;
}

export function canonicalYouTubeUrl(youtubeVideoId: string): string {
  return `https://www.youtube.com/watch?v=${youtubeVideoId}`;
}

// A descriptive row is attributed iff a real creator id was resolved.
export function isAttributed(input: TrackedVideoInput): boolean {
  return typeof input.resolvedCreatorId === "string" && input.resolvedCreatorId.length > 0;
}

// Pure mapping: one tracked video -> one descriptive VideoPerformanceReportRow.
// INVARIANT: isApproved is ALWAYS false and settlement.state is ALWAYS "not_eligible", so
// isReportEligible(row) === false for every descriptive row — it can never enter a settlement aggregate.
export function buildDescriptiveTrackingRow(input: TrackedVideoInput): VideoPerformanceReportRow {
  const publishedAt = isoOrNull(input.publishedAtIso);
  const lastObservedAt = isoOrNull(input.updatedAtIso);
  const measurementEndExclusive =
    publishedAt !== null ? new Date(Date.parse(publishedAt) + MEASUREMENT_WINDOW_MS).toISOString() : lastObservedAt ?? new Date(0).toISOString();
  const attributed = isAttributed(input);
  return {
    rowId: descriptiveRowId(input.youtubeVideoId),
    isCurrentRevision: true,
    // NEVER approved: descriptive tier can never be settlement-eligible.
    isApproved: false,
    creator: {
      fluCreatorId: attributed ? (input.resolvedCreatorId as string) : UNRESOLVED_CREATOR_ID,
      displayName: attributed ? input.resolvedDisplayName?.trim() || (input.resolvedCreatorId as string) : UNRESOLVED_DISPLAY_NAME,
      handle: (attributed && input.resolvedHandle?.trim()) || "",
      ...(attributed && input.resolvedCreatorProfileImageUrl?.trim()
        ? { profileImageUrl: input.resolvedCreatorProfileImageUrl.trim() }
        : {}),
    },
    scope: {
      enrollmentId: input.resolvedEnrollmentId?.trim() || UNRESOLVED_ENROLLMENT_ID,
      programId: input.resolvedProgramId?.trim() || UNCLASSIFIED_PROGRAM_ID,
      programName: input.resolvedProgramName?.trim() || UNCLASSIFIED_PROGRAM_NAME,
    },
    video: {
      videoSubmissionId: descriptiveRowId(input.youtubeVideoId),
      youtubeVideoId: input.youtubeVideoId,
      canonicalUrl: canonicalYouTubeUrl(input.youtubeVideoId),
      title: input.resolvedTitle?.trim() || "",
      ...(input.resolvedThumbnailUrl ? { thumbnailUrl: input.resolvedThumbnailUrl } : {}),
      ...(input.resolvedChannelTitle?.trim() ? { channelTitle: input.resolvedChannelTitle.trim() } : {}),
      publishedAt: publishedAt ?? new Date(0).toISOString(),
      revision: "tracked",
    },
    country: { state: "declared_only" },
    metrics: {
      totalViews: toUint(input.totalViews),
      periodDeltaViews: toUint(input.latestDailyDeltaViews),
      measurementEndExclusive,
      ...(lastObservedAt ? { lastObservedAt } : {}),
    },
    settlement: { state: "not_eligible", hasPortalReceipt: false },
    // "active" tracking when we have any views + a recent observation; else registration_pending.
    trackingState: lastObservedAt ? "active" : "registration_pending",
    measurementState: "collecting",
    attentionCodes: attributed ? [] : ["unattributed_tracking"],
    // Descriptive rows have no attention ranking; the descriptive list sorts by views desc, not this.
    attentionRank: Number.MAX_SAFE_INTEGER,
    lastSyncedAt: lastObservedAt ?? new Date(0).toISOString(),
  };
}

// The persisted document shape: the descriptive row plus the top-level query flags the store indexes on.
// `reportEligible` is ALWAYS false here (never overlaps the settlement ledger); `descriptive`/`reportVisible`
// are the descriptive surface's own query keys.
export interface PersistedDescriptiveRow extends VideoPerformanceReportRow {
  readonly descriptive: true;
  readonly reportVisible: true;
  readonly reportEligible: false;
  readonly hasApprovedSubmissionEvidence: boolean;
  readonly attributed: boolean;
}

export function toPersistedDescriptiveRow(input: TrackedVideoInput): PersistedDescriptiveRow {
  const row = buildDescriptiveTrackingRow(input);
  return {
    ...row,
    descriptive: true,
    reportVisible: true,
    reportEligible: false,
    hasApprovedSubmissionEvidence: input.hasApprovedSubmissionEvidence === true,
    attributed: isAttributed(input),
  };
}

export const APPROVED_AUTHORITATIVE_ROW_ID_PREFIX = "approved:v:" as const;

export interface ApprovedAuthoritativeTrackingInput {
  readonly sourceManifestId: string;
  readonly trackingReceiptDigest: string;
  readonly submissionId: string;
  readonly youtubeVideoId: string;
  readonly revision: number;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly publishedAtIso: string;
  readonly observedAtIso: string;
  readonly totalViews: unknown;
  /** 이미 확정된 정산 인정 조회수. 있으면 절대 덮지 않는다. */
  readonly existingEligibleViews?: unknown;
  readonly latestDailyDeltaViews: unknown;
  readonly trackingUnavailableReason?: "video_not_found";
  readonly fluCreatorId: string;
  readonly displayName: string;
  readonly handle?: string;
  readonly enrollmentId: string;
  readonly programId: string;
  readonly programName: string;
  readonly campaignId?: string;
  readonly campaignName?: string;
}

export interface PersistedApprovedAuthoritativeRow extends VideoPerformanceReportRow {
  readonly descriptive: false;
  readonly reportVisible: true;
  readonly reportEligible: true;
  readonly exact168hOperational: false;
  readonly authoritativeProjection: "approved_current_v3";
  readonly historicalImport: {
    readonly sourceManifestId: string;
    readonly trackingReceiptDigest: string;
    readonly currentViewObservationAvailable: boolean;
    readonly reportedViewsPlaceholderUsedAsActual: false;
  };
}

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function canonicalIso(value: string, code: string): string {
  const normalized = isoOrNull(value);
  if (!normalized) throw new Error(code);
  return normalized;
}

export function approvedAuthoritativeRowId(
  submissionId: string,
  revision: number,
  youtubeVideoId: string,
): string {
  const identity = `${required(submissionId, "approved_authoritative_submission_required")}\0${revision}\0${required(
    youtubeVideoId,
    "approved_authoritative_video_required",
  )}`;
  return `${APPROVED_AUTHORITATIVE_ROW_ID_PREFIX}${Buffer.from(identity)
    .toString("base64url")
    .slice(0, 120)}`;
}

export interface ApprovedCreatorIdentity {
  readonly displayName: string;
  readonly handle: string;
}

// 이름/핸들 규칙의 정본은 resolveCreatorIdentityProjection(managementProfileTabsReadModels.ts) 하나다 —
// 프로필 이미지가 resolveProfileImageProjection 으로 수렴한 것과 같은 자리. 여기서는 report 행이 handle
// 을 `string`(없으면 빈 문자열)으로 저장하므로 null 만 맞춰주는 얇은 어댑터다.
// 저장 시점(store)과 기존 행 리페어(scripts/repair-approved-report-row-identity.mjs)가 이 어댑터를 함께
// 쓴다.
export function resolveApprovedCreatorIdentity(
  creator: Record<string, unknown> | undefined,
  fluCreatorId: string,
): ApprovedCreatorIdentity {
  const identity = resolveCreatorDisplayIdentity(creator, fluCreatorId);
  return { displayName: identity.displayName, handle: identity.handle ?? "" };
}

/** 측정창이 관측 시각 기준으로 이미 닫혔는가. */
export function approvedMeasurementWindowClosed(publishedAtIso: string, observedAtIso: string): boolean {
  const published = Date.parse(publishedAtIso);
  const observed = Date.parse(observedAtIso);
  if (Number.isNaN(published) || Number.isNaN(observed)) return false;
  return observed >= published + MEASUREMENT_WINDOW_MS;
}

export function toPersistedApprovedAuthoritativeRow(
  input: ApprovedAuthoritativeTrackingInput,
): PersistedApprovedAuthoritativeRow {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new Error("approved_authoritative_revision_invalid");
  }
  const publishedAt = canonicalIso(
    input.publishedAtIso,
    "approved_authoritative_published_at_invalid",
  );
  const observedAt = canonicalIso(
    input.observedAtIso,
    "approved_authoritative_observed_at_invalid",
  );
  if (input.trackingUnavailableReason) {
    throw new Error(
      "approved_authoritative_actual_view_observation_required",
    );
  }
  const measurementEndExclusive = new Date(
    Date.parse(publishedAt) + MEASUREMENT_WINDOW_MS,
  ).toISOString();
  // 이미 확정된 값이 있으면 그대로, 없고 창이 닫혔으면 이번 관측치로 확정한다.
  // toUint("") 는 "0" 을 돌려주므로 "값이 있음"을 원문 존재로 판정한다 — 0 을 확정값으로 오인하지 않는다.
  const existingEligible = typeof input.existingEligibleViews === "string"
    && /^\d+$/.test(input.existingEligibleViews.trim())
    ? input.existingEligibleViews.trim()
    : "";
  const settledEligibleViews = existingEligible
    || (approvedMeasurementWindowClosed(publishedAt, observedAt) ? toUint(input.totalViews) : "");
  return {
    rowId: approvedAuthoritativeRowId(
      input.submissionId,
      input.revision,
      input.youtubeVideoId,
    ),
    isCurrentRevision: true,
    isApproved: true,
    reportEligible: true,
    reportVisible: true,
    descriptive: false,
    exact168hOperational: false,
    authoritativeProjection: "approved_current_v3",
    creator: {
      fluCreatorId: required(
        input.fluCreatorId,
        "approved_authoritative_creator_required",
      ),
      displayName:
        input.displayName.trim() ||
        required(
          input.fluCreatorId,
          "approved_authoritative_creator_required",
        ),
      handle: input.handle?.trim() || "",
    },
    scope: {
      enrollmentId: required(
        input.enrollmentId,
        "approved_authoritative_enrollment_required",
      ),
      programId: required(
        input.programId,
        "approved_authoritative_program_required",
      ),
      programName: input.programName.trim() || input.programId.trim(),
      ...(input.campaignId?.trim()
        ? { campaignId: input.campaignId.trim() }
        : {}),
      ...(input.campaignName?.trim()
        ? { campaignName: input.campaignName.trim() }
        : {}),
    },
    video: {
      videoSubmissionId: required(
        input.submissionId,
        "approved_authoritative_submission_required",
      ),
      youtubeVideoId: required(
        input.youtubeVideoId,
        "approved_authoritative_video_required",
      ),
      canonicalUrl:
        input.canonicalUrl.trim() ||
        canonicalYouTubeUrl(input.youtubeVideoId),
      title: input.title.trim(),
      publishedAt,
      revision: String(input.revision),
    },
    country: { state: "collecting" },
    metrics: {
      totalViews: toUint(input.totalViews),
      periodDeltaViews: toUint(input.latestDailyDeltaViews),
      measurementEndExclusive,
      lastObservedAt: observedAt,
      // 측정창이 이미 닫힌 뒤에 이 행을 다시 쓰면 조회수는 계속 자란다 — 그대로 두면 확정돼야 할
      // 정산 근거가 재적재마다 흔들린다. 창이 닫혀 있으면 정산 인정 조회수를 여기서 고정한다.
      // 이미 확정된 값이 있으면 절대 덮지 않는다(뒤늦게 커진 값으로 갱신하는 것이 곧 드리프트다).
      ...(settledEligibleViews ? { eligibleViews: settledEligibleViews } : {}),
    },
    settlement: {
      state: "measurement_pending",
      hasPortalReceipt: false,
    },
    trackingState: "active",
    measurementState: "verification_pending",
    attentionCodes: ["exact168h_verification_pending"],
    attentionRank: 0,
    lastSyncedAt: observedAt,
    historicalImport: {
      sourceManifestId: required(
        input.sourceManifestId,
        "approved_authoritative_manifest_required",
      ),
      trackingReceiptDigest: required(
        input.trackingReceiptDigest,
        "approved_authoritative_tracking_receipt_required",
      ),
      currentViewObservationAvailable: true,
      reportedViewsPlaceholderUsedAsActual: false,
    },
  };
}

// Deterministic descriptive ordering: most-viewed first, then newest observation, then videoId.
export function compareDescriptiveRows(a: VideoPerformanceReportRow, b: VideoPerformanceReportRow): number {
  const av = BigInt(UINT_RE.test(a.metrics.totalViews) ? a.metrics.totalViews : "0");
  const bv = BigInt(UINT_RE.test(b.metrics.totalViews) ? b.metrics.totalViews : "0");
  if (av !== bv) return av > bv ? -1 : 1;
  if (a.lastSyncedAt !== b.lastSyncedAt) return a.lastSyncedAt > b.lastSyncedAt ? -1 : 1;
  return a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0;
}

function descriptiveCursor(row: VideoPerformanceReportRow): string {
  return Buffer.from(`${row.metrics.totalViews}|${row.lastSyncedAt}|${row.rowId}`, "utf8").toString("base64url");
}

export interface DescriptiveTrackingSummary {
  readonly trackedVideoCount: number;
  readonly attributedCount: number;
  readonly unattributedCount: number;
  readonly approvedEvidenceCount: number;
  readonly totalViews: UIntString;
}

export interface VideoViewSeriesTrendPointInput {
  readonly date?: unknown;
  readonly views?: unknown;
  readonly dailyDeltaViews?: unknown;
}

export interface VideoViewSeriesTrendInput {
  readonly videoId: string;
  readonly updatedAtIso?: unknown;
  readonly points?: readonly VideoViewSeriesTrendPointInput[];
}

export interface VideoPerformanceTrendPoint {
  readonly label: string;
  readonly totalViews: UIntString;
  readonly recognizedViews: UIntString;
  readonly dailyDeltaViews: UIntString;
  readonly recognizedDailyDeltaViews: UIntString;
}

export interface VideoPerformanceTrendCoverage {
  readonly sourceCollection: typeof VIDEO_VIEW_SERIES_COLLECTION_NAME;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly periodStartTotalViews: UIntString;
  readonly periodStartRecognizedViews: UIntString;
  readonly periodEndTotalViews: UIntString;
  readonly periodEndRecognizedViews: UIntString;
  readonly periodNetIncreaseViews: UIntString;
  readonly periodRecognizedNetIncreaseViews: UIntString;
  readonly selectedTotalVideoCount: number;
  readonly selectedRecognizedVideoCount: number;
  readonly totalSeriesVideoCount: number;
  readonly recognizedSeriesVideoCount: number;
  readonly totalPointCount: number;
  readonly recognizedPointCount: number;
  readonly carryForwardCumulativeViews: true;
  readonly partial: boolean;
  readonly unavailableReason?: "no_selected_videos" | "no_series_points_in_period";
  readonly freshnessWatermarkIso: string | null;
}

export interface VideoPerformanceTrendEnvelope {
  readonly points: readonly VideoPerformanceTrendPoint[];
  readonly coverage: VideoPerformanceTrendCoverage;
}

export const VIDEO_VIEW_SERIES_COLLECTION_NAME = "video_view_series" as const;

export function buildVideoPerformanceTrendFromSeries(input: {
  readonly descriptiveRows: readonly VideoPerformanceReportRow[];
  readonly recognizedRows: readonly VideoPerformanceReportRow[];
  readonly seriesDocs: readonly VideoViewSeriesTrendInput[];
  readonly periodFrom: string;
  readonly periodTo: string;
}): VideoPerformanceTrendEnvelope {
  const fromDate = input.periodFrom.slice(0, 10);
  const toDate = input.periodTo.slice(0, 10);
  const totalVideoIds = new Set(input.descriptiveRows.map((row) => row.video.youtubeVideoId).filter(Boolean));
  const recognizedVideoIds = new Set(input.recognizedRows.map((row) => row.video.youtubeVideoId).filter(Boolean));
  const seriesByVideoId = new Map(input.seriesDocs.map((doc) => [doc.videoId, doc]));
  const dates = new Set<string>();
  const totalWithSeries = new Set<string>();
  const recognizedWithSeries = new Set<string>();
  let totalPointCount = 0;
  let recognizedPointCount = 0;
  let freshnessWatermarkIso: string | null = null;

  type NormalizedPoint = { date: string; views: bigint; daily: bigint };
  const normalizedByVideoId = new Map<string, NormalizedPoint[]>();

  function normalize(videoId: string): NormalizedPoint[] {
    if (normalizedByVideoId.has(videoId)) return normalizedByVideoId.get(videoId) ?? [];
    const series = seriesByVideoId.get(videoId);
    const updatedAtIso = isoOrNull(series?.updatedAtIso);
    if (updatedAtIso && (freshnessWatermarkIso === null || updatedAtIso > freshnessWatermarkIso)) freshnessWatermarkIso = updatedAtIso;
    const points = Array.isArray(series?.points) ? series.points : [];
    const normalized = points
      .map((point) => ({
        date: typeof point?.date === "string" ? point.date.slice(0, 10) : "",
        views: BigInt(toUint(point?.views)),
        daily: BigInt(toUint(point?.dailyDeltaViews)),
      }))
      .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && point.date <= toDate)
      .sort((a, b) => a.date.localeCompare(b.date));
    normalizedByVideoId.set(videoId, normalized);
    return normalized;
  }

  function scanSelected(videoIds: Set<string>, kind: "total" | "recognized") {
    for (const videoId of videoIds) {
      const points = normalize(videoId);
      let hasInPeriod = false;
      for (const point of points) {
        if (point.date < fromDate || point.date > toDate) continue;
        dates.add(point.date);
        hasInPeriod = true;
        if (kind === "total") totalPointCount += 1;
        else recognizedPointCount += 1;
      }
      if (hasInPeriod && kind === "total") totalWithSeries.add(videoId);
      if (hasInPeriod && kind === "recognized") recognizedWithSeries.add(videoId);
    }
  }

  scanSelected(totalVideoIds, "total");
  scanSelected(recognizedVideoIds, "recognized");

  function latestBefore(points: readonly NormalizedPoint[], date: string): NormalizedPoint | null {
    let latest: NormalizedPoint | null = null;
    for (const point of points) {
      if (point.date >= date) break;
      latest = point;
    }
    return latest;
  }

  function latestAtOrBefore(points: readonly NormalizedPoint[], date: string): NormalizedPoint | null {
    let latest: NormalizedPoint | null = null;
    for (const point of points) {
      if (point.date > date) break;
      latest = point;
    }
    return latest;
  }

  function cumulativeBeforePeriod(videoIds: Set<string>, date: string): bigint {
    let total = 0n;
    for (const videoId of videoIds) {
      const points = normalize(videoId);
      const prior = latestBefore(points, date);
      if (prior) {
        total += prior.views;
        continue;
      }
      const exact = points.find((point) => point.date === date);
      if (exact) total += exact.views > exact.daily ? exact.views - exact.daily : 0n;
    }
    return total;
  }

  function inPeriodDaily(videoIds: Set<string>): bigint {
    let total = 0n;
    for (const videoId of videoIds) {
      for (const point of normalize(videoId)) {
        if (point.date < fromDate || point.date > toDate) continue;
        total += point.daily;
      }
    }
    return total;
  }

  const periodStartTotal = cumulativeBeforePeriod(totalVideoIds, fromDate);
  const periodStartRecognized = cumulativeBeforePeriod(recognizedVideoIds, fromDate);
  const periodNetIncrease = inPeriodDaily(totalVideoIds);
  const periodRecognizedNetIncrease = inPeriodDaily(recognizedVideoIds);
  const periodEndTotal = periodStartTotal + periodNetIncrease;
  const periodEndRecognized = periodStartRecognized + periodRecognizedNetIncrease;

  const points = [...dates].sort((a, b) => a.localeCompare(b)).map((label) => {
    let total = 0n;
    let recognized = 0n;
    let totalDaily = 0n;
    let recognizedDaily = 0n;
    for (const videoId of totalVideoIds) {
      const point = latestAtOrBefore(normalize(videoId), label);
      if (!point) continue;
      total += point.views;
      if (point.date === label) totalDaily += point.daily;
    }
    for (const videoId of recognizedVideoIds) {
      const point = latestAtOrBefore(normalize(videoId), label);
      if (!point) continue;
      recognized += point.views;
      if (point.date === label) recognizedDaily += point.daily;
    }
    return {
      label,
      totalViews: total.toString(),
      recognizedViews: recognized.toString(),
      dailyDeltaViews: totalDaily.toString(),
      recognizedDailyDeltaViews: recognizedDaily.toString(),
    };
  });
  const selectedCount = totalVideoIds.size + recognizedVideoIds.size;
  const observedCount = totalWithSeries.size + recognizedWithSeries.size;
  const unavailableReason = trendUnavailableReason(selectedCount, points.length);
  return {
    points,
    coverage: {
      sourceCollection: VIDEO_VIEW_SERIES_COLLECTION_NAME,
      periodFrom: fromDate,
      periodTo: toDate,
      periodStartTotalViews: periodStartTotal.toString(),
      periodStartRecognizedViews: periodStartRecognized.toString(),
      periodEndTotalViews: periodEndTotal.toString(),
      periodEndRecognizedViews: periodEndRecognized.toString(),
      periodNetIncreaseViews: periodNetIncrease.toString(),
      periodRecognizedNetIncreaseViews: periodRecognizedNetIncrease.toString(),
      selectedTotalVideoCount: totalVideoIds.size,
      selectedRecognizedVideoCount: recognizedVideoIds.size,
      totalSeriesVideoCount: totalWithSeries.size,
      recognizedSeriesVideoCount: recognizedWithSeries.size,
      totalPointCount,
      recognizedPointCount,
      carryForwardCumulativeViews: true,
      partial: observedCount < selectedCount || points.length === 0,
      ...(unavailableReason ? { unavailableReason } : {}),
      freshnessWatermarkIso,
    },
  };
}

function trendUnavailableReason(
  selectedCount: number,
  pointCount: number,
): VideoPerformanceTrendCoverage["unavailableReason"] | undefined {
  if (selectedCount === 0) {
    return "no_selected_videos";
  }
  if (pointCount === 0) {
    return "no_series_points_in_period";
  }
  return undefined;
}

export function summarizeDescriptiveTracking(rows: readonly PersistedDescriptiveRow[]): DescriptiveTrackingSummary {
  let total = 0n;
  let attributed = 0;
  let approvedEvidence = 0;
  for (const row of rows) {
    if (UINT_RE.test(row.metrics.totalViews)) total += BigInt(row.metrics.totalViews);
    if (row.attributed) attributed += 1;
    if (row.hasApprovedSubmissionEvidence) approvedEvidence += 1;
  }
  return {
    trackedVideoCount: rows.length,
    attributedCount: attributed,
    unattributedCount: rows.length - attributed,
    approvedEvidenceCount: approvedEvidence,
    totalViews: total.toString(),
  };
}

// Bounded, deterministic pagination over an already-fetched (bounded) descriptive row set. Mirrors the
// settlement ledger's cursor discipline (resolveCursorPageRequest clamps limit; buildCursorPage fails
// closed if the store over-fetches) but with the descriptive (views-desc) comparator.
export function listDescriptiveTrackingRows(
  rows: readonly VideoPerformanceReportRow[],
  cursorRequest: CursorPageRequest | undefined,
): CursorPage<VideoPerformanceReportRow> {
  const { cursor, limit } = resolveCursorPageRequest(cursorRequest);
  const sorted = rows.slice().sort(compareDescriptiveRows);
  let startIndex = 0;
  if (cursor) {
    const foundIndex = sorted.findIndex((row) => descriptiveCursor(row) === cursor);
    if (foundIndex === -1) startIndex = 0;
    else startIndex = foundIndex + 1;
  }
  const windowRows = sorted.slice(startIndex, startIndex + limit + 1);
  return buildCursorPage(windowRows, limit, descriptiveCursor);
}
