import type {
  DescriptiveTrackingSummary,
  SettlementDisplayState,
  VideoPerformanceReportRow,
  VideoPerformanceSummary,
} from "./videoPerformanceData";

export type VideoPerformanceUniverse = "settlementEligible" | "descriptive";

export interface VideoPerformanceUniverseSummary {
  universe: VideoPerformanceUniverse;
  label: string;
  rowCount: number;
  totalViews: string;
  recognizedViews: string;
  dailyDeltaViews: string;
  updatedAtIso: string | null;
  exact168hOperational: false;
}

export interface VideoPerformanceReconciliationSummary {
  settlementEligibleRows: number;
  descriptiveRows: number;
  descriptiveAttributedRows: number;
  descriptiveUnattributedRows: number;
  approvedEvidenceInDescriptiveRows: number;
  globalFetchTruncated: boolean;
  pageTruncated: boolean;
  reconciledAtIso: string;
}

export interface VideoPerformanceTrendPoint {
  label: string;
  totalViews: string;
  recognizedViews: string;
  dailyDeltaViews: string;
}

export interface SettlementPipelineStage {
  key: string;
  label: string;
  count: number;
  tone: "blue" | "green" | "purple" | "amber" | "red" | "neutral";
}

const UINT_RE = /^\d+$/;

function uint(value: unknown): bigint {
  if (typeof value === "string" && UINT_RE.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return BigInt(Math.trunc(value));
  return 0n;
}

function sum(values: Iterable<unknown>): string {
  let total = 0n;
  for (const value of values) total += uint(value);
  return total.toString();
}

function maxIso(values: Iterable<unknown>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) continue;
    if (latest === null || value > latest) latest = value;
  }
  return latest;
}

export function summarizeSettlementUniverse(
  summary: VideoPerformanceSummary | null,
  rows: readonly VideoPerformanceReportRow[],
): VideoPerformanceUniverseSummary {
  return {
    universe: "settlementEligible",
    label: "정산 대상 · 최신 승인본",
    rowCount: rows.length,
    totalViews: summary?.totalViews ?? sum(rows.map((row) => row.metrics.totalViews)),
    recognizedViews: summary?.eligibleViews ?? sum(rows.map((row) => row.metrics.eligibleViews)),
    dailyDeltaViews: summary?.periodDeltaViews ?? sum(rows.map((row) => row.metrics.periodDeltaViews)),
    updatedAtIso: maxIso(rows.map((row) => row.lastSyncedAt)),
    exact168hOperational: false,
  };
}

export function summarizeDescriptiveUniverse(
  summary: DescriptiveTrackingSummary | null,
  rows: readonly VideoPerformanceReportRow[],
): VideoPerformanceUniverseSummary {
  return {
    universe: "descriptive",
    label: "조회 추적 전체 · 참고 지표",
    rowCount: summary?.trackedVideoCount ?? rows.length,
    totalViews: summary?.totalViews ?? sum(rows.map((row) => row.metrics.totalViews)),
    // 조회 추적 행은 참고 지표로만 인정되며 정산 인정 조회수로 승격되지 않는다.
    recognizedViews: summary?.totalViews ?? sum(rows.map((row) => row.metrics.totalViews)),
    dailyDeltaViews: sum(rows.map((row) => row.metrics.periodDeltaViews)),
    updatedAtIso: maxIso(rows.map((row) => row.lastSyncedAt)),
    exact168hOperational: false,
  };
}

export function reconcileVideoPerformanceUniverses(input: {
  settlementRows: readonly VideoPerformanceReportRow[];
  descriptiveRows: readonly VideoPerformanceReportRow[];
  descriptiveSummary: DescriptiveTrackingSummary | null;
  globalFetchTruncated?: boolean;
  pageTruncated?: boolean;
  reconciledAtIso: string;
}): VideoPerformanceReconciliationSummary {
  return {
    settlementEligibleRows: input.settlementRows.filter((row) => row.isApproved && row.isCurrentRevision).length,
    descriptiveRows: input.descriptiveSummary?.trackedVideoCount ?? input.descriptiveRows.length,
    descriptiveAttributedRows: input.descriptiveSummary?.attributedCount ?? input.descriptiveRows.filter((row) => row.creator.fluCreatorId).length,
    descriptiveUnattributedRows: input.descriptiveSummary?.unattributedCount ?? input.descriptiveRows.filter((row) => !row.creator.fluCreatorId).length,
    approvedEvidenceInDescriptiveRows: input.descriptiveSummary?.approvedEvidenceCount ?? 0,
    globalFetchTruncated: input.globalFetchTruncated === true,
    pageTruncated: input.pageTruncated === true,
    reconciledAtIso: input.reconciledAtIso,
  };
}

export function buildTrendPoints(rows: readonly VideoPerformanceReportRow[], universe: VideoPerformanceUniverse): VideoPerformanceTrendPoint[] {
  void rows;
  void universe;
  // The report row read model currently contains one current snapshot per video, not canonical
  // video_view_series/monitor history. Cross-video snapshot dates are not time-series evidence, so the
  // chart must remain unavailable until a historical-series read model is plumbed in explicitly.
  return [];
}

const PIPELINE: Array<{ key: string; label: string; states: SettlementDisplayState[]; tone: SettlementPipelineStage["tone"] }> = [
  { key: "tracking", label: "추적 중", states: ["estimated", "measurement_pending"], tone: "blue" },
  { key: "cutoff", label: "마감 대기", states: ["country_verification_pending"], tone: "blue" },
  { key: "calculation", label: "계산 완료", states: ["calculation_ready", "delivery_pending"], tone: "green" },
  { key: "confirmed", label: "정산 확정", states: ["portal_review", "portal_confirmed"], tone: "purple" },
  { key: "payable", label: "지급 가능", states: ["payable", "paid"], tone: "amber" },
  { key: "exception", label: "예외", states: ["disputed", "adjustment_required", "void"], tone: "red" },
];

export function buildSettlementPipeline(rows: readonly VideoPerformanceReportRow[]): SettlementPipelineStage[] {
  return PIPELINE.map((stage) => ({
    key: stage.key,
    label: stage.label,
    tone: stage.tone,
    count: rows.filter((row) => stage.states.includes(row.settlement.state)).length,
  }));
}

export function excludedViewsForRow(row: VideoPerformanceReportRow): string {
  const total = uint(row.metrics.totalViews);
  const eligible = uint(row.metrics.eligibleViews);
  const explicit = uint(row.metrics.excludedViews);
  if (explicit > 0n) return explicit.toString();
  const diff = total - eligible;
  return (diff > 0n ? diff : 0n).toString();
}

export function rowUniverse(row: VideoPerformanceReportRow): VideoPerformanceUniverse {
  return row.isApproved && row.isCurrentRevision && row.settlement.state !== "not_eligible" ? "settlementEligible" : "descriptive";
}
