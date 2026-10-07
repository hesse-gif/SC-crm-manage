// FLU-0538 pixel-clone (surface 05 partner detail 개요, operator decision B: app-font structural
// reproduction of the real /flu/partners/{id} content region, shell = allowed deviation). Read-only
// snapshot for the demo-gated overview overlay. RBAC manager+ (mirrors the partner detail gate). The
// snapshot lives at partner_detail_snapshots/current — today DEMO-only screen-fill
// (scripts/seed-flu-0538-demo.mjs, demoSeed:true, reversible). No external side effects; a missing doc
// returns an honest empty snapshot (present:false) so the UI keeps the real activation overview tab.
import { adminDb } from "./firebaseAdmin";
import {
  assertNonGuestAuth,
  asRecord,
  makeBehaviorLog,
  makeCache,
  makeCostLog,
  type CallableRequestShape,
} from "./shared";

export const PARTNER_DETAIL_DOC = "partner_detail_snapshots/current";
const READ_ROLES = ["super_admin", "admin", "manager"] as const;
const CACHE_TTL_SECONDS = 30;

export interface PartnerDetailStep {
  label: string;
  sub: string;
  active: boolean;
}
export interface PartnerDetailMoreRow {
  label: string;
}
export interface PartnerDetailSnapshot {
  present: boolean;
  backLabel: string;
  techInfoLabel: string;
  avatarInitial: string;
  handle: string;
  statusBadge: string;
  name: string;
  tags: string[];
  steps: PartnerDetailStep[];
  activeAt: string;
  tabs: string[];
  activeTab: string;
  reasonTitle: string;
  reasonLabel: string;
  reasonText: string;
  reasonProgramLabel: string;
  reasonProgram: string;
  reasonCampaignLabel: string;
  reasonCampaign: string;
  videoTitle: string;
  videoThumbLabel: string;
  videoDuration: string;
  videoCanon: string;
  videoType: string;
  videoButton: string;
  nextTitle: string;
  nextStepLabel: string;
  nextStepText: string;
  nextButton: string;
  recommendLabel: string;
  recommendText: string;
  moreTitle: string;
  moreSub: string;
  moreRowsLeft: PartnerDetailMoreRow[];
  moreRowsMid: PartnerDetailMoreRow[];
  warnTitle: string;
  warnText: string;
  warnButton: string;
  footerNote: string;
  updatedAt: string | null;
}

export const EMPTY_PARTNER_DETAIL: PartnerDetailSnapshot = {
  present: false,
  backLabel: "",
  techInfoLabel: "",
  avatarInitial: "",
  handle: "",
  statusBadge: "",
  name: "",
  tags: [],
  steps: [],
  activeAt: "",
  tabs: [],
  activeTab: "개요",
  reasonTitle: "",
  reasonLabel: "",
  reasonText: "",
  reasonProgramLabel: "",
  reasonProgram: "",
  reasonCampaignLabel: "",
  reasonCampaign: "",
  videoTitle: "",
  videoThumbLabel: "",
  videoDuration: "",
  videoCanon: "",
  videoType: "",
  videoButton: "",
  nextTitle: "",
  nextStepLabel: "",
  nextStepText: "",
  nextButton: "",
  recommendLabel: "",
  recommendText: "",
  moreTitle: "",
  moreSub: "",
  moreRowsLeft: [],
  moreRowsMid: [],
  warnTitle: "",
  warnText: "",
  warnButton: "",
  footerNote: "",
  updatedAt: null,
};

function toStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function toArr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function toStrArr(value: unknown): string[] {
  return toArr(value).map(toStr);
}
function toRows(value: unknown): PartnerDetailMoreRow[] {
  return toArr(value).map((r) => ({ label: toStr(asRecord(r).label) }));
}

export function normalizePartnerDetail(raw: unknown): PartnerDetailSnapshot {
  const d = asRecord(raw);
  return {
    present: true,
    backLabel: toStr(d.backLabel),
    techInfoLabel: toStr(d.techInfoLabel),
    avatarInitial: toStr(d.avatarInitial),
    handle: toStr(d.handle),
    statusBadge: toStr(d.statusBadge),
    name: toStr(d.name),
    tags: toStrArr(d.tags),
    steps: toArr(d.steps).map((s) => {
      const r = asRecord(s);
      return { label: toStr(r.label), sub: toStr(r.sub), active: r.active === true };
    }),
    activeAt: toStr(d.activeAt),
    tabs: toStrArr(d.tabs),
    activeTab: toStr(d.activeTab) || "개요",
    reasonTitle: toStr(d.reasonTitle),
    reasonLabel: toStr(d.reasonLabel),
    reasonText: toStr(d.reasonText),
    reasonProgramLabel: toStr(d.reasonProgramLabel),
    reasonProgram: toStr(d.reasonProgram),
    reasonCampaignLabel: toStr(d.reasonCampaignLabel),
    reasonCampaign: toStr(d.reasonCampaign),
    videoTitle: toStr(d.videoTitle),
    videoThumbLabel: toStr(d.videoThumbLabel),
    videoDuration: toStr(d.videoDuration),
    videoCanon: toStr(d.videoCanon),
    videoType: toStr(d.videoType),
    videoButton: toStr(d.videoButton),
    nextTitle: toStr(d.nextTitle),
    nextStepLabel: toStr(d.nextStepLabel),
    nextStepText: toStr(d.nextStepText),
    nextButton: toStr(d.nextButton),
    recommendLabel: toStr(d.recommendLabel),
    recommendText: toStr(d.recommendText),
    moreTitle: toStr(d.moreTitle),
    moreSub: toStr(d.moreSub),
    moreRowsLeft: toRows(d.moreRowsLeft),
    moreRowsMid: toRows(d.moreRowsMid),
    warnTitle: toStr(d.warnTitle),
    warnText: toStr(d.warnText),
    warnButton: toStr(d.warnButton),
    footerNote: toStr(d.footerNote),
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : null,
  };
}

export async function getPartnerDetailSnapshot(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "partner_detail.snapshot.get", READ_ROLES);
  const snap = await adminDb.doc(PARTNER_DETAIL_DOC).get();
  const snapshot = snap.exists ? normalizePartnerDetail(snap.data() ?? {}) : EMPTY_PARTNER_DETAIL;
  return {
    ok: true,
    snapshot,
    cache: makeCache("partner_detail:snapshot", false, CACHE_TTL_SECONDS),
    costLog: makeCostLog("partner_detail.snapshot.get", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(auth, "partner_detail.snapshot.get", "success"),
  };
}
