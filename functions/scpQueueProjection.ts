import { createHash } from "node:crypto";
import { FieldPath } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { rowMatchesAccountScope } from "./readScope";
import { readScpLifecycleSources } from "./scpLifecycleProfiles";
import {
  projectScpLifecycleProfiles,
  SCP_IDENTITY_CONFLICT_AUTOMATION_REASON_CODE,
  SCP_IDENTITY_CONFLICT_STATE,
  type ScpLifecycleProfile,
  type ScpLifecycleSources,
  type ScpSourceRow,
} from "./scpLifecycleProjection";
import { normalizeScpProgramId } from "./scpProgramAlias";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type AuthContext, type CallableRequestShape } from "./shared";
// 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): see scpAutomationSettings.ts.
import { assertScpEntitled } from "./mailAccounts";

const ACTION = "scp_qualification_queue.list";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const SOURCE_LIMIT = 5000;
const CURSOR_VERSION = "scp_qualification_queue_v1";

type QueueCursor = {
  v: typeof CURSOR_VERSION;
  key: string;
};

type ProgramLabel = {
  canonicalProgramId: string;
  label: string;
};

type QualificationEvidence = {
  sourceRef: string;
  source: "program_applications" | "program_sheet_leads" | "qualification_decisions";
  verdict: "pass" | "fail" | "pending";
  authority: number;
  at: string;
  row: ScpSourceRow;
};

export type ScpQualificationQueueCard = {
  id: string;
  queue: "qualification";
  canonicalProgramId: string;
  programLabel: string;
  canonicalIdentityHash: string;
  lifecycleProfileId: string;
  state: string;
  verdict: "pass" | "fail" | "pending" | "identity_conflict";
  membershipState: ScpLifecycleProfile["membershipState"];
  identityConflict: boolean;
  resolutionState: ScpLifecycleProfile["resolutionState"];
  automationBlocked: boolean;
  automationBlockReasonCode: typeof SCP_IDENTITY_CONFLICT_AUTOMATION_REASON_CODE | null;
  reasons: string[];
  sourceRefs: {
    all: string[];
    applications: string[];
    sheetRows: string[];
    decisions: string[];
  };
  applicationIds: string[];
  sheetRowRefs: string[];
  decisionRefs: string[];
  timestamps: string[];
  metricSnapshots: Array<Record<string, unknown>>;
  verdictEvidence: {
    pass: string[];
    fail: string[];
    pending: string[];
  };
  capabilityFlags: {
    canJudgeQualification: boolean;
    canPrepareResultMail: boolean;
    canIssueOneLink: boolean;
    canRunEncouragement: boolean;
    canAdvanceAutomation: boolean;
  };
};

export type ScpQualificationQueueEnvelope = {
  ok: true;
  queue: "qualification";
  rows: ScpQualificationQueueCard[];
  counts: {
    returned: number;
    total: number;
    byProgram: Record<string, number>;
  };
  pageInfo: {
    limit: number;
    truncated: boolean;
    nextCursor: string | null;
  };
  cache: {
    generatedAtIso: string;
    maxAgeSeconds: number;
  };
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
};

export function buildScpQualificationQueueCards(input: {
  sources: ScpLifecycleSources;
  programs?: ProgramLabel[];
  allowedProgramIds?: string[] | null;
  computedAtIso?: string;
}): ScpQualificationQueueCard[] {
  const projection = projectScpLifecycleProfiles(input.sources, {
    computedAtIso: input.computedAtIso,
  });
  const rowsByRef = indexLifecycleSourceRows(input.sources);
  const programLabels = new Map((input.programs ?? []).map((program) => [program.canonicalProgramId, program.label]));
  const allowed = input.allowedProgramIds === null || input.allowedProgramIds === undefined
    ? null
    : new Set(input.allowedProgramIds.map(normalizeScpProgramId).filter(Boolean));

  return projection.profiles
    .filter((profile) => (
      profile.activeServing
      && (profile.membershipState === "active" || profile.membershipState === "reactivated")
    ))
    .filter((profile) => !allowed || allowed.has(profile.programId))
    .flatMap((profile) => {
      const evidence = qualificationEvidenceForProfile(profile, rowsByRef);
      if (evidence.length === 0 && !isQualificationState(profile.currentState)) return [];
      const verdict = cardVerdict(profile, evidence);
      const sourceRefs = sourceRefsByKind(evidence, profile);
      const blocked = profile.automationBlocked || verdict === "identity_conflict";
      const applicationIds = evidence
        .filter((item) => item.source === "program_applications")
        .map((item) => asString(item.row.applicationId) || asString(item.row.id))
        .filter(Boolean);
      const timestamps = [...new Set(evidence.map((item) => item.at).filter(Boolean))].sort();
      const card: ScpQualificationQueueCard = {
        id: queueCardId(profile),
        queue: "qualification",
        canonicalProgramId: profile.programId,
        programLabel: programLabels.get(profile.programId) ?? programLabelFallback(profile.programId),
        canonicalIdentityHash: profile.canonicalIdentityHash,
        lifecycleProfileId: profile.profileId,
        state: profile.currentState,
        verdict,
        membershipState: profile.membershipState,
        identityConflict: profile.identityConflict,
        resolutionState: profile.resolutionState,
        automationBlocked: blocked,
        automationBlockReasonCode: blocked ? SCP_IDENTITY_CONFLICT_AUTOMATION_REASON_CODE : null,
        reasons: blocked ? [SCP_IDENTITY_CONFLICT_AUTOMATION_REASON_CODE] : [],
        sourceRefs,
        applicationIds: [...new Set(applicationIds)].sort(),
        sheetRowRefs: sourceRefs.sheetRows,
        decisionRefs: sourceRefs.decisions,
        timestamps,
        metricSnapshots: metricSnapshots(evidence),
        verdictEvidence: {
          pass: evidence.filter((item) => item.verdict === "pass").map((item) => item.sourceRef).sort(),
          fail: evidence.filter((item) => item.verdict === "fail").map((item) => item.sourceRef).sort(),
          pending: evidence.filter((item) => item.verdict === "pending").map((item) => item.sourceRef).sort(),
        },
        capabilityFlags: {
          canJudgeQualification: !blocked,
          canPrepareResultMail: !blocked && (verdict === "pass" || verdict === "fail"),
          canIssueOneLink: !blocked && verdict === "pass",
          canRunEncouragement: !blocked,
          canAdvanceAutomation: !blocked,
        },
      };
      return [card];
    })
    .sort((left, right) => cardSortKey(left).localeCompare(cardSortKey(right)));
}

export async function listScpQualificationQueue(request: CallableRequestShape): Promise<ScpQualificationQueueEnvelope> {
  const auth = assertNonGuestAuth(request, ACTION, ["super_admin", "admin", "manager"]);
  await assertScpEntitled(auth, request, ACTION);
  const data = asRecord(request.data);
  if (asString(data.queue, "qualification") !== "qualification") {
    throw Object.assign(new Error("invalid-argument: unsupported SCP queue"), { code: "invalid-argument", errorCode: "list_scp_qualification_queue_unsupported_scp" });
  }
  const limit = pageSize(data.pageSize ?? data.limit);
  const requestedPrograms = Array.isArray(data.programIds)
    ? data.programIds.map((item) => normalizeScpProgramId(asString(item))).filter(Boolean)
    : null;
  const programAccess = await authorizedPrograms(auth, requestedPrograms);
  const sources = await readScpLifecycleSources(SOURCE_LIMIT);
  const cards = buildScpQualificationQueueCards({
    sources,
    programs: programAccess.labels,
    allowedProgramIds: programAccess.allowedProgramIds,
  });
  const cursor = decodeCursor(data.cursor);
  let startIndex = 0;
  if (cursor) {
    const matched = cards.findIndex((card) => cardSortKey(card) === cursor.key);
    if (matched < 0) {
      throw Object.assign(new Error("failed-precondition: SCP queue cursor is stale"), { code: "failed-precondition", errorCode: "list_scp_qualification_queue_scp_cursor_stale" });
    }
    startIndex = matched + 1;
  }
  const rows = cards.slice(startIndex, startIndex + limit);
  const nextCursor = startIndex + rows.length < cards.length && rows.length > 0
    ? encodeCursor({ v: CURSOR_VERSION, key: cardSortKey(rows[rows.length - 1]) })
    : null;
  return {
    ok: true,
    queue: "qualification",
    rows,
    counts: {
      returned: rows.length,
      total: cards.length,
      byProgram: countByProgram(cards),
    },
    pageInfo: {
      limit,
      truncated: Boolean(nextCursor),
      nextCursor,
    },
    cache: {
      generatedAtIso: new Date().toISOString(),
      maxAgeSeconds: 60,
    },
    behaviorLog: makeBehaviorLog(auth, ACTION, "success"),
  };
}

function qualificationEvidenceForProfile(
  profile: ScpLifecycleProfile,
  rowsByRef: Map<string, ScpSourceRow>,
): QualificationEvidence[] {
  return profile.sourceRefs.flatMap((sourceRef): QualificationEvidence[] => {
    const source = sourceRef.split("/")[0] as QualificationEvidence["source"];
    if (source !== "program_applications" && source !== "program_sheet_leads" && source !== "qualification_decisions") {
      return [];
    }
    const row = rowsByRef.get(sourceRef);
    if (!row) return [];
    return [{
      sourceRef,
      source,
      verdict: evidenceVerdict(source, row),
      authority: source === "qualification_decisions" ? 3 : source === "program_sheet_leads" ? 2 : 1,
      at: evidenceTimestamp(source, row),
      row,
    }];
  });
}

function cardVerdict(
  profile: ScpLifecycleProfile,
  evidence: QualificationEvidence[],
): ScpQualificationQueueCard["verdict"] {
  if (profile.currentState === SCP_IDENTITY_CONFLICT_STATE) return "identity_conflict";
  const terminal = evidence
    .filter((item) => item.verdict === "pass" || item.verdict === "fail")
    .sort((left, right) => right.authority - left.authority || right.at.localeCompare(left.at));
  if (terminal[0]) return terminal[0].verdict;
  if (profile.currentState === "qualification_passed") return "pass";
  if (profile.currentState === "qualification_failed") return "fail";
  return "pending";
}

function sourceRefsByKind(evidence: QualificationEvidence[], profile: ScpLifecycleProfile) {
  const all = new Set(profile.sourceRefs);
  return {
    all: [...all].sort(),
    applications: evidence.filter((item) => item.source === "program_applications").map((item) => item.sourceRef).sort(),
    sheetRows: evidence.filter((item) => item.source === "program_sheet_leads").map((item) => item.sourceRef).sort(),
    decisions: evidence.filter((item) => item.source === "qualification_decisions").map((item) => item.sourceRef).sort(),
  };
}

function metricSnapshots(evidence: QualificationEvidence[]): Array<Record<string, unknown>> {
  return evidence
    .map((item) => metricSnapshot(item))
    .sort((left, right) => Number(right.authority) - Number(left.authority) || String(right.at).localeCompare(String(left.at)))
    .slice(0, 20);
}

function metricSnapshot(item: QualificationEvidence): Record<string, unknown> {
  const row = item.row;
  const metrics = sanitizedMetrics(row);
  return compactRecord({
    sourceRef: item.sourceRef,
    source: item.source,
    authority: item.authority,
    at: item.at,
    name: asString(row.name) || asString(row.creatorName) || asString(row.channelName) || asString(asRecord(row.applicant).name),
    subscribers: numericField(metrics, ["subscribers"]) ?? numericField(row, ["subscribers", "subscriberCount", "youtubeSubscribers"]),
    views: numericField(row, ["views", "viewCount", "avgViews"]),
    country: asString(row.country) || asString(asRecord(row.applicant).country),
    metrics,
    latestAiRecommendation: sanitizedQualificationRecommendation(row, item),
  });
}

function sanitizedMetrics(row: ScpSourceRow): Record<string, unknown> {
  const metrics = asRecord(row.metrics);
  return compactRecord({
    subscribers: numericField(metrics, ["subscribers"]) ?? numericField(row, ["subscribers", "subscriberCount", "youtubeSubscribers"]),
    videoCount: metricTriplet(asRecord(metrics.videoCount)),
    uploadFreq: metricTriplet(asRecord(metrics.uploadFreq)),
    longViews: metricStats(asRecord(metrics.longViews)),
    shortViews: metricStats(asRecord(metrics.shortViews)),
    totalViews: metricStats(asRecord(metrics.totalViews)),
    engagement: metricTriplet(asRecord(metrics.engagement)),
  });
}

function sanitizedQualificationRecommendation(row: ScpSourceRow, item: QualificationEvidence): Record<string, unknown> | undefined {
  const raw = asRecord(item.source === "qualification_decisions"
    ? row.aiRecommendation
    : row.latestAiRecommendation ?? row.latestQualificationRecommendation);
  const verdict = asString(raw.verdict);
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "hold") return undefined;
  return compactRecord({
    verdict,
    rejectionProbability: numericField(raw, ["rejectionProbability"]),
    reasons: stringList(raw.reasons, 8),
    policyFlags: stringList(raw.policyFlags, 8),
    missingFields: stringList(raw.missingFields, 8),
    modelId: asString(raw.modelId),
    decisionRef: asString(raw.decisionRef) || (item.source === "qualification_decisions" ? item.sourceRef : ""),
    source: item.source === "qualification_decisions" || asString(raw.source) === "ledger" ? "ledger" : asString(raw.source) === "dry_run" ? "dry_run" : undefined,
    generatedAtIso: asString(raw.generatedAtIso) || (item.source === "qualification_decisions" ? item.at : ""),
  });
}

function metricTriplet(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const triplet = compactRecord({
    long: numericField(value, ["long"]),
    short: numericField(value, ["short"]),
    total: numericField(value, ["total"]),
  });
  return Object.keys(triplet).length > 0 ? triplet : undefined;
}

function metricStats(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const stats = compactRecord({
    median: numericField(value, ["median"]),
    mean: numericField(value, ["mean"]),
    max: numericField(value, ["max"]),
  });
  return Object.keys(stats).length > 0 ? stats : undefined;
}

function stringList(value: unknown, limit: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, limit);
  return items.length > 0 ? items : undefined;
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (item === undefined || item === null || item === "") return false;
    if (Array.isArray(item)) return item.length > 0;
    if (typeof item === "object") return Object.keys(item as Record<string, unknown>).length > 0;
    return true;
  }));
}

function evidenceVerdict(source: QualificationEvidence["source"], row: ScpSourceRow): QualificationEvidence["verdict"] {
  const aiRecommendation = asRecord(row.aiRecommendation);
  const value = source === "qualification_decisions"
    ? row.finalVerdict ?? row.decision ?? row.status ?? row.result ?? aiRecommendation.verdict
    : row.qualificationStatus ?? row.applicationStatus ?? row.status ?? row.finalVerdict;
  const key = statusKey(value);
  if (["pass", "passed", "qualified", "qualification_passed", "approved", "accepted"].includes(key)) return "pass";
  if (["fail", "failed", "qualification_failed", "rejected", "reject"].includes(key)) return "fail";
  return "pending";
}

function evidenceTimestamp(source: QualificationEvidence["source"], row: ScpSourceRow): string {
  const keys = source === "qualification_decisions"
    ? ["decidedAtIso", "createdAtIso", "updatedAtIso"]
    : ["qualifiedAtIso", "qualificationUpdatedAtIso", "submittedAtIso", "appliedAtIso", "updatedAtIso", "createdAtIso", "createdAt"];
  for (const key of keys) {
    const value = asString(row[key]);
    if (value) return value;
  }
  return new Date(0).toISOString();
}

function isQualificationState(state: string): boolean {
  return state === SCP_IDENTITY_CONFLICT_STATE
    || state === "form_submitted"
    || state === "qualification_pending"
    || state === "qualification_passed"
    || state === "qualification_failed"
    || state === "pass_mail_pending"
    || state === "fail_mail_pending";
}

function indexLifecycleSourceRows(sources: ScpLifecycleSources): Map<string, ScpSourceRow> {
  const indexed = new Map<string, ScpSourceRow>();
  for (const [source, rows] of Object.entries(sources)) {
    (rows ?? []).forEach((row, index) => {
      indexed.set(`${source}/${docId(row, index)}`, row);
    });
  }
  return indexed;
}

async function authorizedPrograms(
  auth: AuthContext,
  requestedProgramIds: string[] | null,
): Promise<{ allowedProgramIds: string[] | null; labels: ProgramLabel[] }> {
  const programRows = await readProgramLabels(auth);
  const labels = programRows.map((row) => ({
    canonicalProgramId: normalizeScpProgramId(asString(row.canonicalProgramId) || asString(row.id)),
    label: asString(row.title) || asString(row.name) || programLabelFallback(asString(row.canonicalProgramId) || asString(row.id)),
  })).filter((row) => row.canonicalProgramId);
  const accessible = new Set(labels.map((row) => row.canonicalProgramId));
  if (requestedProgramIds) {
    const allowed = requestedProgramIds.filter((programId) => auth.role !== "manager" || accessible.has(programId));
    return { allowedProgramIds: allowed, labels };
  }
  return {
    allowedProgramIds: auth.role === "manager" ? [...accessible].sort() : null,
    labels,
  };
}

async function readProgramLabels(auth: AuthContext): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  while (true) {
    let query = adminDb.collection("programs").orderBy(FieldPath.documentId()).limit(500);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    for (const doc of snapshot.docs) {
      const row = { id: doc.id, ...doc.data() };
      if (auth.role !== "manager" || rowMatchesAccountScope("programs", row, auth)) rows.push(row);
    }
    if (snapshot.size < 500) break;
    cursor = snapshot.docs.at(-1)?.id ?? null;
    if (!cursor) break;
  }
  return rows;
}

function countByProgram(cards: ScpQualificationQueueCard[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const card of cards) out[card.canonicalProgramId] = (out[card.canonicalProgramId] ?? 0) + 1;
  return out;
}

function encodeCursor(cursor: QueueCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): QueueCursor | null {
  const raw = asString(value);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return parsed?.v === CURSOR_VERSION && typeof parsed.key === "string" ? parsed as QueueCursor : null;
  } catch {
    throw Object.assign(new Error("invalid-argument: SCP queue cursor is invalid"), { code: "invalid-argument", errorCode: "decode_cursor_scp_cursor_invalid" });
  }
}

function pageSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(value)))
    : DEFAULT_PAGE_SIZE;
}

function cardSortKey(card: ScpQualificationQueueCard): string {
  return `${card.canonicalProgramId}\u0000${card.canonicalIdentityHash}\u0000${card.lifecycleProfileId}`;
}

function queueCardId(profile: ScpLifecycleProfile): string {
  return `scpq_${shortHash([profile.programId, profile.canonicalIdentityHash, profile.profileId].join("\u0000"))}`;
}

function docId(row: ScpSourceRow, index: number): string {
  return asString(row.id) || asString(row.docId) || asString(row.leadId) || String(index);
}

function numericField(row: ScpSourceRow, keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function statusKey(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function programLabelFallback(programId: string): string {
  return programId === "scp" ? "Super Creator Partners" : programId || "Unknown program";
}
