// FLU-0538 pixel-clone surface 06 (/flu/influencers/{id} — Journey tab, 관리 상세) — typed client contract
// for the getManagementDetailSnapshot read callable. Mirrors the server snapshot shape 1:1. Reads go
// through the Functions callable (SEC-P0-004: no client Firestore direct read). DEMO-seeded today
// (scripts/seed-flu-0538-demo.mjs, demoSeed:true, single --rollback); values port the frozen mockup
// 06-manage-detail-proposal-final.png verbatim (PNG-only; geometry reverse-engineered).
export type StepState = "done" | "current" | "pending";
export interface ManagementStatusCell {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
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
  button?: string;
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
export interface ManagementDetailEnvelope {
  ok: boolean;
  snapshot: ManagementDetailSnapshot;
}

// ---- callable transport (mirrors callSettlementCallable in ./partnerSettlementData.ts; standalone so
// data.ts + its tested FLU_CALLABLES union stay untouched) ----
async function callManagementDetailCallable<TResponse>(name: string, payload: Record<string, unknown> = {}): Promise<TResponse> {
  if (typeof window === "undefined") {
    throw new Error(`Management-detail callable "${name}" must be invoked from a client interaction.`);
  }
  const [{ httpsCallable }, { functions, getFluCallableName }] = await Promise.all([
    import("firebase/functions"),
    import("./firebase"),
  ]);
  const callable = httpsCallable<Record<string, unknown>, TResponse>(functions, getFluCallableName(name));
  const result = await callable(payload);
  return result.data;
}

// Demo-gated overlay fetch for surface 06: present:false when unseeded → caller renders the real detail page.
export async function getManagementDetailSnapshot(): Promise<ManagementDetailSnapshot> {
  const env = await callManagementDetailCallable<ManagementDetailEnvelope>("getManagementDetailSnapshot");
  return env.snapshot;
}

// FLU-0540 gap-closure: honest present:false shell for `ManagementDetailCloneView`'s own loading/empty/
// error states (paired with its `emptyMessage` prop) — never a fallback to a different layout. The real-
// data adapter (`buildManagementDetailSnapshotFromReal`) lives in the route page itself, since it depends
// on that page's local `ScpLifecycleProfile`/`ResolvedScpLifecycleFlow` types.
export function emptyManagementDetailSnapshot(): ManagementDetailSnapshot {
  return {
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
}
