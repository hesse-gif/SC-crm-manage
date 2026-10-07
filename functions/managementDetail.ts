// FLU-0538 pixel-clone (surface 06 management detail Journey, operator decision B: app-font structural
// reproduction of the real /flu/influencers/{id} content region, shell = allowed deviation). Read-only
// snapshot for the demo-gated overlay. RBAC manager+. The snapshot lives at
// management_detail_snapshots/current — today DEMO-only screen-fill (scripts/seed-flu-0538-demo.mjs,
// demoSeed:true, reversible). No external side effects; a missing doc returns an honest empty snapshot
// (present:false) so the UI keeps the real influencer detail page untouched.
import { adminDb } from "./firebaseAdmin";
import {
  assertNonGuestAuth,
  asRecord,
  makeBehaviorLog,
  makeCache,
  makeCostLog,
  type CallableRequestShape,
} from "./shared";

export const MANAGEMENT_DETAIL_DOC = "management_detail_snapshots/current";
const READ_ROLES = ["super_admin", "admin", "manager"] as const;
const CACHE_TTL_SECONDS = 30;

export type StepState = "done" | "current" | "pending";
export interface ManagementStatusCell {
  label: string;
  value: string;
  sub: string;
  accent: boolean;
}
export interface ManagementStep {
  no: string;
  label: string;
  sub: string;
  state: StepState;
}
export interface ManagementInflowRow {
  label: string;
  value: string;
}
export interface ManagementActivity {
  iconTone: string;
  title: string;
  time: string;
  right: string;
  button: string;
}
export interface ManagementDetailSnapshot {
  present: boolean;
  name: string;
  handle: string;
  platform: string;
  subscribers: string;
  subscribersLabel: string;
  regionFlag: string;
  region: string;
  regionLabel: string;
  statusBadge: string;
  updatedAt: string;
  statusCells: ManagementStatusCell[];
  tabs: string[];
  activeTab: string;
  steps: ManagementStep[];
  inflowTitle: string;
  inflowRows: ManagementInflowRow[];
  activityTitle: string;
  activities: ManagementActivity[];
  syncStatus: string;
  syncSource: string;
  memoTitle: string;
  footerNote: string;
  footerLink: string;
  updatedAtIso: string | null;
}

export const EMPTY_MANAGEMENT_DETAIL: ManagementDetailSnapshot = {
  present: false,
  name: "",
  handle: "",
  platform: "",
  subscribers: "",
  subscribersLabel: "",
  regionFlag: "",
  region: "",
  regionLabel: "",
  statusBadge: "",
  updatedAt: "",
  statusCells: [],
  tabs: [],
  activeTab: "Journey",
  steps: [],
  inflowTitle: "",
  inflowRows: [],
  activityTitle: "",
  activities: [],
  syncStatus: "",
  syncSource: "",
  memoTitle: "",
  footerNote: "",
  footerLink: "",
  updatedAtIso: null,
};

const STATES = new Set<StepState>(["done", "current", "pending"]);
function toState(value: unknown): StepState {
  return typeof value === "string" && STATES.has(value as StepState) ? (value as StepState) : "pending";
}
function toStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function toArr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function toStrArr(value: unknown): string[] {
  return toArr(value).map(toStr);
}

export function normalizeManagementDetail(raw: unknown): ManagementDetailSnapshot {
  const d = asRecord(raw);
  return {
    present: true,
    name: toStr(d.name),
    handle: toStr(d.handle),
    platform: toStr(d.platform),
    subscribers: toStr(d.subscribers),
    subscribersLabel: toStr(d.subscribersLabel),
    regionFlag: toStr(d.regionFlag),
    region: toStr(d.region),
    regionLabel: toStr(d.regionLabel),
    statusBadge: toStr(d.statusBadge),
    updatedAt: toStr(d.updatedAt),
    statusCells: toArr(d.statusCells).map((c) => {
      const r = asRecord(c);
      return { label: toStr(r.label), value: toStr(r.value), sub: toStr(r.sub), accent: r.accent === true };
    }),
    tabs: toStrArr(d.tabs),
    activeTab: toStr(d.activeTab) || "Journey",
    steps: toArr(d.steps).map((s) => {
      const r = asRecord(s);
      return { no: toStr(r.no), label: toStr(r.label), sub: toStr(r.sub), state: toState(r.state) };
    }),
    inflowTitle: toStr(d.inflowTitle),
    inflowRows: toArr(d.inflowRows).map((r) => {
      const row = asRecord(r);
      return { label: toStr(row.label), value: toStr(row.value) };
    }),
    activityTitle: toStr(d.activityTitle),
    activities: toArr(d.activities).map((a) => {
      const r = asRecord(a);
      return { iconTone: toStr(r.iconTone), title: toStr(r.title), time: toStr(r.time), right: toStr(r.right), button: toStr(r.button) };
    }),
    syncStatus: toStr(d.syncStatus),
    syncSource: toStr(d.syncSource),
    memoTitle: toStr(d.memoTitle),
    footerNote: toStr(d.footerNote),
    footerLink: toStr(d.footerLink),
    updatedAtIso: typeof d.updatedAt === "string" ? d.updatedAt : null,
  };
}

export async function getManagementDetailSnapshot(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "management_detail.snapshot.get", READ_ROLES);
  const snap = await adminDb.doc(MANAGEMENT_DETAIL_DOC).get();
  const snapshot = snap.exists ? normalizeManagementDetail(snap.data() ?? {}) : EMPTY_MANAGEMENT_DETAIL;
  return {
    ok: true,
    snapshot,
    cache: makeCache("management_detail:snapshot", false, CACHE_TTL_SECONDS),
    costLog: makeCostLog("management_detail.snapshot.get", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(auth, "management_detail.snapshot.get", "success"),
  };
}
