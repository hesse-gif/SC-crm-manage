// FLU-0538 pixel-clone (surface 07 partner 성과·정산, operator decision B: app-font structural
// reproduction of the real /flu/partners/{id}?tab=performance content region, shell = allowed deviation).
// Read-only settlement snapshot for the demo-gated overlay. RBAC manager+ (mirrors the partner detail
// gate). The snapshot lives at partner_settlement_snapshots/current — today DEMO-only screen-fill
// (scripts/seed-flu-0538-demo.mjs, demoSeed:true, reversible); a real settlement projection later writes
// the same doc shape. No external side effects; a missing doc returns an honest empty snapshot
// (present:false) so the UI keeps the real activation-tab envelope untouched and renders nothing extra.
import { adminDb } from "./firebaseAdmin";
import {
  assertNonGuestAuth,
  asRecord,
  makeBehaviorLog,
  makeCache,
  makeCostLog,
  type CallableRequestShape,
} from "./shared";

export const PARTNER_SETTLEMENT_DOC = "partner_settlement_snapshots/current";
const READ_ROLES = ["super_admin", "admin", "manager"] as const;
const CACHE_TTL_SECONDS = 30;

export type SettlementTone = "green" | "blue" | "amber" | "red" | "purple";

export interface SettlementKpi {
  label: string;
  pillTone: SettlementTone;
  pillText: string;
  value: string;
  micro: string;
}
export interface SettlementTableRow {
  video: string;
  status: string;
  totalViews: string;
  eligibleViews: string;
  countryCpm: string;
  amount: string;
  sync: string;
  muted: boolean;
}
export interface PartnerSettlementSnapshot {
  present: boolean;
  topline: string;
  handle: string;
  statusPillText: string;
  subtitle: string;
  activeTab: string;
  kpis: SettlementKpi[];
  chartTitle: string;
  chartSub: string;
  bars: number[];
  calcTitle: string;
  calcFormula: string[];
  calcResult: string;
  calcMicro: string[];
  tableTitle: string;
  tableSub: string;
  tableHead: string[];
  tableRows: SettlementTableRow[];
  footerNote: string;
  updatedAt: string | null;
}

export const EMPTY_PARTNER_SETTLEMENT: PartnerSettlementSnapshot = {
  present: false,
  topline: "",
  handle: "",
  statusPillText: "",
  subtitle: "",
  activeTab: "성과 · 정산",
  kpis: [],
  chartTitle: "",
  chartSub: "",
  bars: [],
  calcTitle: "",
  calcFormula: [],
  calcResult: "",
  calcMicro: [],
  tableTitle: "",
  tableSub: "",
  tableHead: [],
  tableRows: [],
  footerNote: "",
  updatedAt: null,
};

const TONES = new Set<SettlementTone>(["green", "blue", "amber", "red", "purple"]);
function toTone(value: unknown): SettlementTone {
  return typeof value === "string" && TONES.has(value as SettlementTone) ? (value as SettlementTone) : "blue";
}
function toStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function toNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function toArr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function toStrArr(value: unknown): string[] {
  return toArr(value).map(toStr);
}

export function normalizePartnerSettlement(raw: unknown): PartnerSettlementSnapshot {
  const d = asRecord(raw);
  return {
    present: true,
    topline: toStr(d.topline),
    handle: toStr(d.handle),
    statusPillText: toStr(d.statusPillText),
    subtitle: toStr(d.subtitle),
    activeTab: toStr(d.activeTab) || "성과 · 정산",
    kpis: toArr(d.kpis).map((k) => {
      const r = asRecord(k);
      return { label: toStr(r.label), pillTone: toTone(r.pillTone), pillText: toStr(r.pillText), value: toStr(r.value), micro: toStr(r.micro) };
    }),
    chartTitle: toStr(d.chartTitle),
    chartSub: toStr(d.chartSub),
    bars: toArr(d.bars).map(toNum),
    calcTitle: toStr(d.calcTitle),
    calcFormula: toStrArr(d.calcFormula),
    calcResult: toStr(d.calcResult),
    calcMicro: toStrArr(d.calcMicro),
    tableTitle: toStr(d.tableTitle),
    tableSub: toStr(d.tableSub),
    tableHead: toStrArr(d.tableHead),
    tableRows: toArr(d.tableRows).map((row) => {
      const r = asRecord(row);
      return {
        video: toStr(r.video),
        status: toStr(r.status),
        totalViews: toStr(r.totalViews),
        eligibleViews: toStr(r.eligibleViews),
        countryCpm: toStr(r.countryCpm),
        amount: toStr(r.amount),
        sync: toStr(r.sync),
        muted: r.muted === true,
      };
    }),
    footerNote: toStr(d.footerNote),
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : null,
  };
}

export async function getPartnerSettlementSnapshot(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "partner_settlement.snapshot.get", READ_ROLES);
  const snap = await adminDb.doc(PARTNER_SETTLEMENT_DOC).get();
  const snapshot = snap.exists ? normalizePartnerSettlement(snap.data() ?? {}) : EMPTY_PARTNER_SETTLEMENT;
  return {
    ok: true,
    snapshot,
    cache: makeCache("partner_settlement:snapshot", false, CACHE_TTL_SECONDS),
    costLog: makeCostLog("partner_settlement.snapshot.get", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(auth, "partner_settlement.snapshot.get", "success"),
  };
}
