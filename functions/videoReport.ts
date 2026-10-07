// FLU-0538 pixel-clone (surface 10 영상 성과, operator decision B). Read-only video-report snapshot for the
// demo-gated overlay on /flu/report/video-performance. RBAC manager+ (mirrors the report gate). Snapshot at
// video_report_snapshots/current — today DEMO-only screen-fill (scripts/seed-flu-0538-demo.mjs,
// demoSeed:true, reversible); a real report projection later writes the same shape. No external side
// effects; a missing doc returns an honest empty snapshot (present:false) so the real report renders untouched.
import { adminDb } from "./firebaseAdmin";
import {
  assertNonGuestAuth,
  asRecord,
  makeBehaviorLog,
  makeCache,
  makeCostLog,
  type CallableRequestShape,
} from "./shared";

export const VIDEO_REPORT_DOC = "video_report_snapshots/current";
const READ_ROLES = ["super_admin", "admin", "manager"] as const;
const CACHE_TTL_SECONDS = 30;

export type ReportTone = "green" | "blue" | "amber" | "red" | "purple";
const TONES = new Set<ReportTone>(["green", "blue", "amber", "red", "purple"]);
function toTone(v: unknown): ReportTone {
  return typeof v === "string" && TONES.has(v as ReportTone) ? (v as ReportTone) : "blue";
}
function toStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function toNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function toArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function toStrArr(v: unknown): string[] {
  return toArr(v).map(toStr);
}
function toLines(v: unknown): { label: string; value: string }[] {
  return toArr(v).map((l) => {
    const r = asRecord(l);
    return { label: toStr(r.label), value: toStr(r.value) };
  });
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
  kpis: { label: string; value: string; delta: string; compare: string; updated: string }[];
  chartTitle: string;
  chartLegend: string[];
  chartPoints: { label: string; cumulative: number; daily: number; eligible: number }[];
  chartTodayNote: string;
  chartDeadlineNote: string;
  funnelTitle: string;
  funnelStages: { label: string; value: number; tone: ReportTone }[];
  funnelNote: string;
  funnelLink: string;
  tableTitle: string;
  tableCount: string;
  tableColumns: string[];
  tableRows: {
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
  }[];
  detailVideoTitle: string;
  detailCreator: string;
  detailCampaign: string;
  detailPublished: string;
  detailLink: string;
  detailTabs: string[];
  detailActiveTab: string;
  detailDiagnosis: string[];
  detailMeasure: { label: string; value: string }[];
  detailExclusions: { label: string; value: string }[];
  detailCountry: { label: string; value: string }[];
  detailLedger: { label: string; value: string }[];
  updatedAt: string | null;
}

export const EMPTY_VIDEO_REPORT: VideoReportSnapshot = {
  present: false,
  tabs: [],
  activeTab: "",
  title: "",
  subtitle: "",
  periodModes: [],
  activePeriod: "",
  dateRange: "",
  filters: [],
  kpis: [],
  chartTitle: "",
  chartLegend: [],
  chartPoints: [],
  chartTodayNote: "",
  chartDeadlineNote: "",
  funnelTitle: "",
  funnelStages: [],
  funnelNote: "",
  funnelLink: "",
  tableTitle: "",
  tableCount: "",
  tableColumns: [],
  tableRows: [],
  detailVideoTitle: "",
  detailCreator: "",
  detailCampaign: "",
  detailPublished: "",
  detailLink: "",
  detailTabs: [],
  detailActiveTab: "",
  detailDiagnosis: [],
  detailMeasure: [],
  detailExclusions: [],
  detailCountry: [],
  detailLedger: [],
  updatedAt: null,
};

export function normalizeVideoReport(raw: unknown): VideoReportSnapshot {
  const d = asRecord(raw);
  return {
    present: true,
    tabs: toStrArr(d.tabs),
    activeTab: toStr(d.activeTab),
    title: toStr(d.title),
    subtitle: toStr(d.subtitle),
    periodModes: toStrArr(d.periodModes),
    activePeriod: toStr(d.activePeriod),
    dateRange: toStr(d.dateRange),
    filters: toStrArr(d.filters),
    kpis: toArr(d.kpis).map((k) => {
      const r = asRecord(k);
      return { label: toStr(r.label), value: toStr(r.value), delta: toStr(r.delta), compare: toStr(r.compare), updated: toStr(r.updated) };
    }),
    chartTitle: toStr(d.chartTitle),
    chartLegend: toStrArr(d.chartLegend),
    chartPoints: toArr(d.chartPoints).map((p) => {
      const r = asRecord(p);
      return { label: toStr(r.label), cumulative: toNum(r.cumulative), daily: toNum(r.daily), eligible: toNum(r.eligible) };
    }),
    chartTodayNote: toStr(d.chartTodayNote),
    chartDeadlineNote: toStr(d.chartDeadlineNote),
    funnelTitle: toStr(d.funnelTitle),
    funnelStages: toArr(d.funnelStages).map((st) => {
      const r = asRecord(st);
      return { label: toStr(r.label), value: toNum(r.value), tone: toTone(r.tone) };
    }),
    funnelNote: toStr(d.funnelNote),
    funnelLink: toStr(d.funnelLink),
    tableTitle: toStr(d.tableTitle),
    tableCount: toStr(d.tableCount),
    tableColumns: toStrArr(d.tableColumns),
    tableRows: toArr(d.tableRows).map((row) => {
      const r = asRecord(row);
      return {
        creatorName: toStr(r.creatorName),
        creatorHandle: toStr(r.creatorHandle),
        program: toStr(r.program),
        campaign: toStr(r.campaign),
        videoTitle: toStr(r.videoTitle),
        videoDuration: toStr(r.videoDuration),
        country: toStr(r.country),
        countrySource: toStr(r.countrySource),
        totalViews: toStr(r.totalViews),
        dailyDelta: toStr(r.dailyDelta),
        eligibleViews: toStr(r.eligibleViews),
        deadline: toStr(r.deadline),
        cpm: toStr(r.cpm),
        amount: toStr(r.amount),
        statusLabel: toStr(r.statusLabel),
        statusTone: toTone(r.statusTone),
        lastSync: toStr(r.lastSync),
        selected: r.selected === true,
      };
    }),
    detailVideoTitle: toStr(d.detailVideoTitle),
    detailCreator: toStr(d.detailCreator),
    detailCampaign: toStr(d.detailCampaign),
    detailPublished: toStr(d.detailPublished),
    detailLink: toStr(d.detailLink),
    detailTabs: toStrArr(d.detailTabs),
    detailActiveTab: toStr(d.detailActiveTab),
    detailDiagnosis: toStrArr(d.detailDiagnosis),
    detailMeasure: toLines(d.detailMeasure),
    detailExclusions: toLines(d.detailExclusions),
    detailCountry: toLines(d.detailCountry),
    detailLedger: toLines(d.detailLedger),
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : null,
  };
}

export async function getVideoReportSnapshot(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "video_report.snapshot.get", READ_ROLES);
  const snap = await adminDb.doc(VIDEO_REPORT_DOC).get();
  const snapshot = snap.exists ? normalizeVideoReport(snap.data() ?? {}) : EMPTY_VIDEO_REPORT;
  return {
    ok: true,
    snapshot,
    cache: makeCache("video_report:snapshot", false, CACHE_TTL_SECONDS),
    costLog: makeCostLog("video_report.snapshot.get", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(auth, "video_report.snapshot.get", "success"),
  };
}
