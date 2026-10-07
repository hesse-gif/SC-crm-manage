// FLU-0538 pixel-clone (surface 08 SCP 자동화, operator decision 2026-07-21: real-page reproduction,
// shell = allowed deviation). Read-only control-tower snapshot for /flu/scp. RBAC manager+ (mirrors the
// automation panels' gate in /flu/scp). The snapshot lives at scp_automation_control/current — today it is
// DEMO-only screen-fill (scripts/seed-flu-0538-demo.mjs, demoSeed:true, reversible); when a real
// control-plane aggregation lands it writes the same doc shape. No external side effects; a missing doc
// returns an honest empty snapshot (present:false) so the UI can render a waiting state instead of fabricating.
import {
  assertNonGuestAuth,
  asRecord,
  makeBehaviorLog,
  makeCache,
  makeCostLog,
  type CallableRequestShape,
} from "./shared";
import { buildRealScpAutomationControlReadModel, type ScpControlRealReadModel } from "./scpAutomationControlReadModel";
// 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): see scpAutomationSettings.ts.
import { assertScpEntitled } from "./mailAccounts";

export const SCP_AUTOMATION_CONTROL_DOC = "scp_automation_control/current";
const READ_ROLES = ["super_admin", "admin", "manager"] as const;
const CACHE_TTL_SECONDS = 30;

export type ScpControlTone = "green" | "blue" | "amber" | "red" | "purple";

export interface ScpControlCard {
  key: string;
  label: string;
  tone: ScpControlTone;
  statusLabel: string;
  value: number;
  sub: string;
}
export interface ScpControlPipelineStep {
  step: string;
  desc: string;
  tone: ScpControlTone;
  count: number;
}
export interface ScpControlWorker {
  key: string;
  ok: boolean;
  status: string;
}
export interface ScpControlFailure {
  code: string;
  count: string;
  tone: ScpControlTone;
  action: string;
  hint: string;
}
export interface ScpControlChip {
  tone: ScpControlTone;
  label: string;
}
export interface ScpControlHumanReview {
  total: number;
  chips: ScpControlChip[];
  note: string;
  cta: string;
}
export interface ScpAutomationControlSnapshot {
  present: boolean;
  badge: string;
  subtitle: string;
  cards: ScpControlCard[];
  pipeline: ScpControlPipelineStep[];
  workers: ScpControlWorker[];
  failures: ScpControlFailure[];
  humanReview: ScpControlHumanReview;
  footerNote: string;
  updatedAt: string | null;
  readModel?: ScpControlRealReadModel;
  realRows?: ScpControlRealReadModel["rows"];
  demoSeed?: false;
  source?: {
    schemaVersion?: string | null;
    generatedAt?: string | null;
    dataAsOf?: string | null;
    sourceWatermark?: string | null;
    completeness?: "complete" | "partial" | "stale" | "blocked" | "unknown" | null;
    provenance?: string[];
  };
}

export const EMPTY_SCP_AUTOMATION_CONTROL: ScpAutomationControlSnapshot = {
  present: false,
  badge: "",
  subtitle: "",
  cards: [],
  pipeline: [],
  workers: [],
  failures: [],
  humanReview: { total: 0, chips: [], note: "", cta: "" },
  footerNote: "",
  updatedAt: null,
};

const TONES = new Set<ScpControlTone>(["green", "blue", "amber", "red", "purple"]);
function toTone(value: unknown): ScpControlTone {
  return typeof value === "string" && TONES.has(value as ScpControlTone) ? (value as ScpControlTone) : "blue";
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

export function normalizeScpAutomationControl(raw: unknown): ScpAutomationControlSnapshot {
  const d = asRecord(raw);
  const hr = asRecord(d.humanReview);
  return {
    present: true,
    badge: toStr(d.badge),
    subtitle: toStr(d.subtitle),
    cards: toArr(d.cards).map((c) => {
      const r = asRecord(c);
      return { key: toStr(r.key), label: toStr(r.label), tone: toTone(r.tone), statusLabel: toStr(r.statusLabel), value: toNum(r.value), sub: toStr(r.sub) };
    }),
    pipeline: toArr(d.pipeline).map((p) => {
      const r = asRecord(p);
      return { step: toStr(r.step), desc: toStr(r.desc), tone: toTone(r.tone), count: toNum(r.count) };
    }),
    workers: toArr(d.workers).map((w) => {
      const r = asRecord(w);
      return { key: toStr(r.key), ok: r.ok === true, status: toStr(r.status) };
    }),
    failures: toArr(d.failures).map((f) => {
      const r = asRecord(f);
      return { code: toStr(r.code), count: toStr(r.count), tone: toTone(r.tone), action: toStr(r.action), hint: toStr(r.hint) };
    }),
    humanReview: {
      total: toNum(hr.total),
      chips: toArr(hr.chips).map((c) => {
        const r = asRecord(c);
        return { tone: toTone(r.tone), label: toStr(r.label) };
      }),
      note: toStr(hr.note),
      cta: toStr(hr.cta),
    },
    footerNote: toStr(d.footerNote),
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : null,
  };
}

export function scpControlCardsFromReadModel(readModel: ScpControlRealReadModel): ScpControlCard[] {
  return [
    { key: "intake", label: "real rows", tone: "blue", statusLabel: "bounded", value: readModel.aggregates.totalRows, sub: `latest ${readModel.bounded.effectiveLimit}` },
    { key: "review", label: "needs review", tone: readModel.aggregates.humanReviewRequired > 0 ? "amber" : "green", statusLabel: "human gate", value: readModel.aggregates.humanReviewRequired, sub: "canonical states" },
    { key: "approved", label: "approved current", tone: "green", statusLabel: "current only", value: readModel.aggregates.approvedCurrent, sub: "feed/report eligible" },
    { key: "tracking", label: "tracking eligible", tone: "amber", statusLabel: "168h blocked", value: readModel.aggregates.trackingEligible, sub: readModel.operationalReadiness.blockerCode },
  ];
}

export function scpControlPipelineFromReadModel(readModel: ScpControlRealReadModel): ScpControlPipelineStep[] {
  return [
    { step: "queued", desc: "Revision received", tone: "blue", count: readModel.aggregates.queued },
    { step: "review", desc: "In review / human", tone: "amber", count: readModel.aggregates.inReview + readModel.aggregates.humanReviewRequired },
    { step: "approved", desc: "Current revision approved", tone: "green", count: readModel.aggregates.approvedCurrent },
    { step: "tracking", desc: "Downstream confirmed", tone: "purple", count: readModel.aggregates.trackingEligible },
  ];
}

export function snapshotFromRealReadModel(readModel: ScpControlRealReadModel): ScpAutomationControlSnapshot {
  const missingAuthority = readModel.aggregates.missingAuthority;
  return {
    present: readModel.rows.length > 0,
    source: {
      schemaVersion: readModel.version,
      generatedAt: readModel.generatedAtIso,
      dataAsOf: readModel.sourceWatermarkIso,
      sourceWatermark: readModel.sourceWatermarkIso,
      completeness: readModel.operationalReadiness.exact168hOperational ? "partial" : "blocked",
      provenance: readModel.bounded.indexBackedQueries,
    },
    badge: "SCP automation · real Firestore",
    subtitle: `${readModel.aggregates.totalRows} canonical video review rows · bounded read model ${readModel.version}`,
    cards: scpControlCardsFromReadModel(readModel),
    pipeline: scpControlPipelineFromReadModel(readModel),
    workers: [
      { key: "canonical_review_transition", ok: missingAuthority === 0, status: missingAuthority === 0 ? "CAS evidence present" : "missing authority evidence" },
      { key: "approved_only_downstream", ok: true, status: "current approved only" },
      { key: "read_budget", ok: readModel.bounded.documentReadUpperBound <= readModel.bounded.maxLimit * 10 + 1, status: `≤${readModel.bounded.documentReadUpperBound} doc reads` },
      { key: "exact_168h_operational", ok: false, status: readModel.operationalReadiness.blockerCode },
    ],
    failures: [
      ...(missingAuthority > 0 ? [{ code: "missing_authority", count: String(missingAuthority), tone: "red" as const, action: "block automation", hint: "revision/fingerprint/policy evidence missing" }] : []),
      { code: "exact_168h_not_operational", count: "1", tone: "amber" as const, action: "hide operational tracking claims", hint: readModel.operationalReadiness.blockerCode },
    ],
    humanReview: {
      total: readModel.aggregates.humanReviewRequired,
      chips: [
        { tone: "amber", label: `${readModel.aggregates.changesRequested} changes` },
        { tone: "red", label: `${readModel.aggregates.rejected} rejected` },
      ],
      note: "Decisions must use the canonical video_review.transition callable.",
      cta: "Open review queue",
    },
    footerNote: `Bounded Firestore reads: ${readModel.bounded.indexBackedQueries.join(" | ")} · fullyAttributed=${readModel.aggregates.fullyAttributed}/${readModel.aggregates.totalRows} · exact168hOperational=false`,
    updatedAt: readModel.generatedAtIso,
    readModel,
    realRows: readModel.rows,
    demoSeed: false,
  };
}

export async function getScpAutomationControl(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_automation.control.get", READ_ROLES);
  await assertScpEntitled(auth, request, "scp_automation.control.get");
  const data = asRecord(request.data);
  const readModel = await buildRealScpAutomationControlReadModel({ limit: data.limit });
  const snapshot = snapshotFromRealReadModel(readModel);
  return {
    ok: true,
    snapshot,
    cache: makeCache("scp_automation:control:real", false, CACHE_TTL_SECONDS),
    costLog: makeCostLog("scp_automation.control.get", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(auth, "scp_automation.control.get", "success"),
  };
}
