// G007-L02 — additive projection mapping internal submission/review/creator records
// into the public scp-video-submissions.v1 shape (REQ-API-009/010/011/012/013).
// Pure functions only: no Firestore, no mutation of internal semantics. The internal
// documents keep their meaning; this layer is a read adapter for the Portal.

import { apiError, type ApiErrorDetail } from "./scpInternalApiErrors";

export type RawSubmissionRow = Record<string, unknown>;
export type RawCreatorRow = Record<string, unknown>;

export type VideoSubmissionItem = {
  submissionId: string;
  partnerId: string;
  programId: string;
  portalCreatorId: string;
  enrollmentId: string;
  videoUrl: string;
  reviewStatus: "pending" | "approved" | "rejected" | "needs_review";
  reviewRevision: string;
  sourceUpdatedAt: string;
  removed: false;
  performance?: VideoPerformance;
};

export type VideoSubmissionTombstone = {
  submissionId: string;
  partnerId: string;
  programId: string;
  sourceUpdatedAt: string;
  removed: true;
  reason: string;
};

export type VideoPerformance = {
  coverage: "complete" | "partial";
  eligibleViews: string; // decimal string (REQ-API-009)
  excludedViews: string;
  performanceDays: number;
  primaryAudienceCountry: string; // raw country only (REQ-API-013)
  dailyViewerCountries: Array<{ date: string; country: string; views: string }>;
};

export type CreatorRef = { portalCreatorId: string; displayName: string; handle: string };

export type ProjectionOptions = {
  partnerId: string;
  programId: string;
  includePerformance: boolean;
  maxCountryRows: number;
  maxPerformanceDays: number;
};

const REVIEW_STATUSES = new Set(["pending", "approved", "rejected", "needs_review"]);
// Fields Flu must never expose to the Portal (REQ-API-013).
const FORBIDDEN_PERF_FIELDS = ["cpm", "tier", "policy", "reward", "payout", "rewardKrw", "payoutKrw"];

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstStr(row: RawSubmissionRow, keys: string[]): string {
  for (const key of keys) {
    const value = str(row[key]);
    if (value) return value;
  }
  return "";
}

// Decimal string with no scientific notation, no NaN/Infinity, no JSON number (REQ-API-009/012).
function decimalString(value: unknown, field: string, gaps: ApiErrorDetail[]): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      gaps.push({ field, reason: "non-finite or negative numeric value" });
      return "0";
    }
    return Number.isInteger(value) ? value.toString() : value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) return value.trim();
  gaps.push({ field, reason: "missing decimal metric" });
  return "0";
}

function reviewStatus(row: RawSubmissionRow): VideoSubmissionItem["reviewStatus"] {
  const raw = firstStr(row, ["reviewStatus", "status"]).toLowerCase();
  return (REVIEW_STATUSES.has(raw) ? raw : "pending") as VideoSubmissionItem["reviewStatus"];
}

function sourceUpdatedAt(row: RawSubmissionRow): string {
  return firstStr(row, ["sourceUpdatedAt", "updatedAtIso", "reviewedAtIso", "submittedAtIso", "createdAtIso"]);
}

export function isTombstoneRow(row: RawSubmissionRow): boolean {
  return row.removed === true || row.deleted === true || str(row.lifecycleState) === "removed";
}

export function projectTombstone(row: RawSubmissionRow, opts: ProjectionOptions): VideoSubmissionTombstone {
  return {
    submissionId: firstStr(row, ["submissionId", "id", "taskId"]),
    partnerId: opts.partnerId,
    programId: opts.programId,
    sourceUpdatedAt: sourceUpdatedAt(row) || "1970-01-01T00:00:00.000Z",
    removed: true,
    reason: firstStr(row, ["removalReason", "reason"]) || "source_removed",
  };
}

function projectPerformance(row: RawSubmissionRow, opts: ProjectionOptions, gaps: ApiErrorDetail[]): VideoPerformance {
  const perf = (row.performance && typeof row.performance === "object" ? row.performance : {}) as Record<string, unknown>;
  for (const forbidden of FORBIDDEN_PERF_FIELDS) {
    if (forbidden in perf) {
      // Defensive: never let a monetization field leak even if an upstream row carries one.
      delete (perf as Record<string, unknown>)[forbidden];
    }
  }
  const rawDaily = Array.isArray(perf.dailyViewerCountries) ? perf.dailyViewerCountries : [];
  const dailyViewerCountries = rawDaily
    .slice(0, Math.max(0, opts.maxCountryRows))
    .map((entry) => {
      const record = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      return {
        date: str(record.date),
        country: str(record.country),
        views: decimalString(record.views, "performance.dailyViewerCountries.views", gaps),
      };
    })
    .filter((entry) => entry.date && entry.country);
  const coverage = str(perf.coverage) === "complete" ? "complete" : "partial";
  const performanceDays = Number.isInteger(perf.performanceDays)
    ? Math.min(perf.performanceDays as number, opts.maxPerformanceDays)
    : dailyViewerCountries.length;
  return {
    coverage,
    eligibleViews: decimalString(perf.eligibleViews, "performance.eligibleViews", gaps),
    excludedViews: decimalString(perf.excludedViews, "performance.excludedViews", gaps),
    performanceDays,
    primaryAudienceCountry: str(perf.primaryAudienceCountry),
    dailyViewerCountries,
  };
}

// Returns a live item, or throws unprocessable_source (422) when a required mapping is
// missing (REQ-API-011). No fabricated empty strings, zeros, or guessed URLs.
export function projectVideoSubmission(
  row: RawSubmissionRow,
  opts: ProjectionOptions,
): VideoSubmissionItem {
  const gaps: ApiErrorDetail[] = [];
  const submissionId = firstStr(row, ["submissionId", "id", "taskId"]);
  const portalCreatorId = firstStr(row, ["portalCreatorId", "creatorId"]);
  const enrollmentId = firstStr(row, ["enrollmentId", "leadId", "programSheetLeadId"]);
  const videoUrl = firstStr(row, ["videoUrl", "youtubeUrl", "sourceUrl"]);
  const reviewRevision = firstStr(row, ["reviewRevision", "revision"]);
  const updated = sourceUpdatedAt(row);

  if (!submissionId) gaps.push({ field: "submissionId", reason: "missing submission id" });
  if (!portalCreatorId) gaps.push({ field: "portalCreatorId", reason: "missing portal creator id" });
  if (!enrollmentId) gaps.push({ field: "enrollmentId", reason: "missing enrollment id" });
  if (!videoUrl) gaps.push({ field: "videoUrl", reason: "missing submitted video url" });
  if (!updated) gaps.push({ field: "sourceUpdatedAt", reason: "missing source update timestamp" });
  if (!reviewRevision) gaps.push({ field: "reviewRevision", reason: "missing review revision" });

  const performance = opts.includePerformance ? projectPerformance(row, opts, gaps) : undefined;

  if (gaps.length > 0) throw apiError.unprocessableSource(gaps);

  const item: VideoSubmissionItem = {
    submissionId,
    partnerId: opts.partnerId,
    programId: opts.programId,
    portalCreatorId,
    enrollmentId,
    videoUrl,
    reviewStatus: reviewStatus(row),
    reviewRevision,
    sourceUpdatedAt: updated,
    removed: false,
  };
  if (performance) item.performance = performance;
  return item;
}

export function projectCreatorRef(row: RawCreatorRow): CreatorRef {
  const portalCreatorId = str(row.portalCreatorId) || str(row.creatorId) || str(row.id);
  return {
    portalCreatorId,
    displayName: str(row.displayName) || str(row.name) || str(row.channelName) || "SCP Creator",
    handle: str(row.handle) || "",
  };
}
