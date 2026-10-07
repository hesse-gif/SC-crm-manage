// FLU-0538 pixel-clone surface 10 (/flu/report/video-performance — 영상 성과) — typed client contract for
// the getVideoReportSnapshot read callable. Mirrors the server snapshot shape 1:1. Reads go through the
// Functions callable (SEC-P0-004: no client Firestore direct read). DEMO-seeded today
// (scripts/seed-flu-0538-demo.mjs, demoSeed:true, single --rollback); values port the frozen mockup
// 10-video-performance-settlement-ledger-selected.png verbatim (PNG-only; geometry reverse-engineered).
export type ReportTone = "green" | "blue" | "amber" | "red" | "purple";

export interface ReportKpi {
  label: string;
  value: string;
  delta: string;
  compare: string;
  updated: string;
}
export interface ReportChartPoint {
  label: string;
  cumulative: number; // 총 조회수 누적 (line)
  daily: number; // 일일 증가 (bar)
  eligible: number; // 인정 조회수 (dashed line)
}
export interface ReportFunnelStage {
  label: string;
  value: number;
  tone: ReportTone;
}
export interface ReportTableRow {
  creatorName: string;
  creatorHandle: string;
  program: string;
  campaign: string;
  videoTitle: string;
  videoDuration: string;
  country: string;
  countrySource: string;
  totalViews: string;
  dailyDelta: string;
  eligibleViews: string;
  deadline: string;
  cpm: string;
  amount: string;
  statusLabel: string;
  statusTone: ReportTone;
  lastSync: string;
  selected: boolean;
}
export interface ReportDetailLine {
  label: string;
  value: string;
}
export interface VideoReportSnapshot {
  present: boolean;
  tabs: string[];
  activeTab: string;
  title: string;
  subtitle: string;
  periodModes: string[];
  activePeriod: string;
  dateRange: string;
  filters: string[];
  kpis: ReportKpi[];
  chartTitle: string;
  chartLegend: string[];
  chartPoints: ReportChartPoint[];
  chartTodayNote: string;
  chartDeadlineNote: string;
  funnelTitle: string;
  funnelStages: ReportFunnelStage[];
  funnelNote: string;
  funnelLink: string;
  tableTitle: string;
  tableCount: string;
  tableColumns: string[];
  tableRows: ReportTableRow[];
  detailVideoTitle: string;
  detailCreator: string;
  detailCampaign: string;
  detailPublished: string;
  detailLink: string;
  detailTabs: string[];
  detailActiveTab: string;
  detailDiagnosis: string[];
  detailMeasure: ReportDetailLine[];
  detailExclusions: ReportDetailLine[];
  detailCountry: ReportDetailLine[];
  detailLedger: ReportDetailLine[];
  updatedAt: string | null;
}
export interface VideoReportEnvelope {
  ok: boolean;
  snapshot: VideoReportSnapshot;
}

// ---- callable transport (standalone; data.ts + its tested FLU_CALLABLES union stay untouched) ----
async function callVideoReportCallable<TResponse>(name: string, payload: Record<string, unknown> = {}): Promise<TResponse> {
  if (typeof window === "undefined") {
    throw new Error(`Video report callable "${name}" must be invoked from a client interaction.`);
  }
  const [{ httpsCallable }, { functions, getFluCallableName }] = await Promise.all([
    import("firebase/functions"),
    import("./firebase"),
  ]);
  const callable = httpsCallable<Record<string, unknown>, TResponse>(functions, getFluCallableName(name));
  const result = await callable(payload);
  return result.data;
}

// Demo-gated overlay fetch for surface 10: present:false when unseeded → caller renders the real report.
export async function getVideoReportSnapshot(): Promise<VideoReportSnapshot> {
  const env = await callVideoReportCallable<VideoReportEnvelope>("getVideoReportSnapshot");
  return env.snapshot;
}
