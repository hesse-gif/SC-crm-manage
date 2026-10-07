export const OPERATIONAL_SNAPSHOT_SCHEMA_VERSION = "operational_snapshot_v2" as const;
export const OPERATIONAL_SNAPSHOT_LEGACY_SCHEMA_VERSION = "operational_snapshot_v1" as const;
export const OPERATIONAL_SNAPSHOT_AGGREGATE_VERSION = "g005_operational_snapshot_canonical_2026_07_11" as const;

export const OPERATIONAL_SNAPSHOT_SURFACES = [
  "flu_dashboard",
  "programs",
  "scp_pipeline",
  "mail_signals",
  "video_review",
] as const;

export type OperationalSnapshotSurface = (typeof OPERATIONAL_SNAPSHOT_SURFACES)[number];
export type OperationalSnapshotScope = "global" | `manager:${string}`;
export type OperationalSnapshotStatus = "fresh" | "stale" | "rebuilding" | "partial";
export type OperationalSnapshotCompleteness = {
  state: "complete" | "truncated";
  truncatedSources: string[];
  sourceLimit: number | null;
};

export type OperationalSnapshotTotals = {
  programs: number;
  activePrograms: number;
  creators: number;
  scpLeads: number;
  qualified: number;
  rejected: number;
  coldmailSent: number;
  replies: number;
  clicks: number;
  videosSubmitted: number;
  videosApproved: number;
  paid: number;
};

export type OperationalProgramSummary = {
  canonicalProgramId: string;
  title: string;
  slug: string;
  status: string;
  aliases: string[];
  legacyProgramIds: string[];
  visible: boolean;
  counts: Record<"applications" | "sheetLeads" | "qualified" | "rejected" | "coldmailSent" | "replies" | "videosSubmitted" | "videosApproved" | "paid" | "respondedOrApplied" | "appliedWithPortal", number>;
  lastActivityAtIso: string;
};

export type OperationalSnapshotV2 = {
  schemaVersion: typeof OPERATIONAL_SNAPSHOT_SCHEMA_VERSION;
  snapshotVersion: number;
  scope: OperationalSnapshotScope;
  surface: OperationalSnapshotSurface;
  generatedAtIso: string;
  lastSourceEventAtIso: string;
  staleAfterIso: string;
  status: OperationalSnapshotStatus;
  piiFree: true;
  sourceCollections: string[];
  sourceRowCounts: Record<string, number>;
  sourceWatermarks: Record<string, string>;
  completeness: OperationalSnapshotCompleteness;
  totals: OperationalSnapshotTotals;
  programSummaries: OperationalProgramSummary[];
  scpFunnel: Record<"lead" | "qualified" | "rejected" | "contacted" | "replied" | "videoSubmitted" | "approved" | "paid", number>;
  mailSignals: { sent: number; pixelSignals: number; replies: number; clicks: number };
  videoAiHumanMatrix: {
    aiApproveHumanApprove: number;
    aiApproveHumanReject: number;
    aiHoldRejectHumanApprove: number;
    aiHoldRejectHumanReject: number;
    unknown: number;
  };
  build: { appVersion: string; aggregateVersion: string };
};

// Kept as a source-compatible alias while downstream screens migrate their type imports.
export type OperationalSnapshotV1 = OperationalSnapshotV2;

export const EMPTY_OPERATIONAL_TOTALS: OperationalSnapshotTotals = {
  programs: 0,
  activePrograms: 0,
  creators: 0,
  scpLeads: 0,
  qualified: 0,
  rejected: 0,
  coldmailSent: 0,
  replies: 0,
  clicks: 0,
  videosSubmitted: 0,
  videosApproved: 0,
  paid: 0,
};

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "snapshotVersion",
  "scope",
  "surface",
  "generatedAtIso",
  "lastSourceEventAtIso",
  "staleAfterIso",
  "status",
  "piiFree",
  "sourceCollections",
  "sourceRowCounts",
  "sourceWatermarks",
  "completeness",
  "totals",
  "programSummaries",
  "scpFunnel",
  "mailSignals",
  "videoAiHumanMatrix",
  "build",
] as const;

const LEGACY_TOP_LEVEL_KEYS = TOP_LEVEL_KEYS.filter((key) => key !== "completeness");

const TOTAL_KEYS = Object.keys(EMPTY_OPERATIONAL_TOTALS).sort();
const PROGRAM_SUMMARY_KEYS = ["aliases", "canonicalProgramId", "counts", "lastActivityAtIso", "legacyProgramIds", "slug", "status", "title", "visible"].sort();
const PROGRAM_COUNT_KEYS = ["applications", "appliedWithPortal", "coldmailSent", "paid", "qualified", "rejected", "replies", "respondedOrApplied", "sheetLeads", "videosApproved", "videosSubmitted"].sort();
// A genuinely old v1 document predates respondedOrApplied/appliedWithPortal too — same treatment as qualified/rejected.
const LEGACY_PROGRAM_COUNT_KEYS = PROGRAM_COUNT_KEYS.filter((key) => key !== "qualified" && key !== "rejected" && key !== "respondedOrApplied" && key !== "appliedWithPortal");
const COMPLETENESS_KEYS = ["sourceLimit", "state", "truncatedSources"].sort();
const SCP_FUNNEL_KEYS = ["approved", "contacted", "lead", "paid", "qualified", "rejected", "replied", "videoSubmitted"].sort();
const MAIL_SIGNAL_KEYS = ["clicks", "pixelSignals", "replies", "sent"].sort();
const VIDEO_MATRIX_KEYS = ["aiApproveHumanApprove", "aiApproveHumanReject", "aiHoldRejectHumanApprove", "aiHoldRejectHumanReject", "unknown"].sort();
const BUILD_KEYS = ["aggregateVersion", "appVersion"].sort();

const FORBIDDEN_PII_KEYS = new Set([
  "email",
  "name",
  "phone",
  "message",
  "body",
  "html",
  "comment",
  "raw",
  "recipient",
  "address",
]);

const ALLOWED_FORBIDDEN_WORD_KEYS = new Set([
  "canonicalProgramId",
  "programSummaries",
  "programs",
  "activePrograms",
]);

export function isOperationalSnapshotSurface(value: unknown): value is OperationalSnapshotSurface {
  return typeof value === "string" && (OPERATIONAL_SNAPSHOT_SURFACES as readonly string[]).includes(value);
}

export function isOperationalSnapshotScope(value: unknown): value is OperationalSnapshotScope {
  return value === "global" || (typeof value === "string" && /^manager:[A-Za-z0-9_-]{1,160}$/.test(value));
}

export function makeEmptyOperationalSnapshot(
  scope: OperationalSnapshotScope,
  surface: OperationalSnapshotSurface,
  generatedAtIso = new Date().toISOString(),
): OperationalSnapshotV1 {
  return {
    schemaVersion: OPERATIONAL_SNAPSHOT_SCHEMA_VERSION,
    snapshotVersion: 0,
    scope,
    surface,
    generatedAtIso,
    lastSourceEventAtIso: generatedAtIso,
    staleAfterIso: generatedAtIso,
    status: "stale",
    piiFree: true,
    sourceCollections: [],
    sourceRowCounts: {},
    sourceWatermarks: {},
    completeness: { state: "complete", truncatedSources: [], sourceLimit: null },
    totals: { ...EMPTY_OPERATIONAL_TOTALS },
    programSummaries: [],
    scpFunnel: { lead: 0, qualified: 0, rejected: 0, contacted: 0, replied: 0, videoSubmitted: 0, approved: 0, paid: 0 },
    mailSignals: { sent: 0, pixelSignals: 0, replies: 0, clicks: 0 },
    videoAiHumanMatrix: { aiApproveHumanApprove: 0, aiApproveHumanReject: 0, aiHoldRejectHumanApprove: 0, aiHoldRejectHumanReject: 0, unknown: 0 },
    build: { appVersion: "unknown", aggregateVersion: OPERATIONAL_SNAPSHOT_AGGREGATE_VERSION },
  };
}

export function validateOperationalSnapshotV1(snapshot: unknown): OperationalSnapshotV1 {
  const wireRecord = assertRecord(snapshot, "snapshot");
  rejectForbiddenPiiKeys(wireRecord);
  const record = wireRecord.schemaVersion === OPERATIONAL_SNAPSHOT_LEGACY_SCHEMA_VERSION
    ? normalizeLegacyOperationalSnapshot(wireRecord)
    : wireRecord;
  assertExactKeys(record, TOP_LEVEL_KEYS as unknown as string[], "snapshot");

  if (record.schemaVersion !== OPERATIONAL_SNAPSHOT_SCHEMA_VERSION) throw new Error("invalid schemaVersion");
  if (!Number.isInteger(record.snapshotVersion) || (record.snapshotVersion as number) < 0) throw new Error("invalid snapshotVersion");
  if (!isOperationalSnapshotScope(record.scope)) throw new Error("invalid scope");
  if (!isOperationalSnapshotSurface(record.surface)) throw new Error("invalid surface");
  for (const key of ["generatedAtIso", "lastSourceEventAtIso", "staleAfterIso"]) assertIsoString(record[key], key);
  if (!["fresh", "stale", "rebuilding", "partial"].includes(String(record.status))) throw new Error("invalid status");
  if (record.piiFree !== true) throw new Error("piiFree must be true");
  assertStringArray(record.sourceCollections, "sourceCollections");
  assertNumberRecord(record.sourceRowCounts, "sourceRowCounts");
  assertStringRecord(record.sourceWatermarks, "sourceWatermarks");
  validateCompleteness(record.completeness);
  assertExactKeys(assertRecord(record.totals, "totals"), TOTAL_KEYS, "totals");
  assertNumberRecord(record.totals, "totals");
  validateProgramSummaries(record.programSummaries);
  assertExactKeys(assertRecord(record.scpFunnel, "scpFunnel"), SCP_FUNNEL_KEYS, "scpFunnel");
  assertNumberRecord(record.scpFunnel, "scpFunnel");
  assertExactKeys(assertRecord(record.mailSignals, "mailSignals"), MAIL_SIGNAL_KEYS, "mailSignals");
  assertNumberRecord(record.mailSignals, "mailSignals");
  assertExactKeys(assertRecord(record.videoAiHumanMatrix, "videoAiHumanMatrix"), VIDEO_MATRIX_KEYS, "videoAiHumanMatrix");
  assertNumberRecord(record.videoAiHumanMatrix, "videoAiHumanMatrix");
  assertExactKeys(assertRecord(record.build, "build"), BUILD_KEYS, "build");
  assertStringRecord(record.build, "build");
  return record as OperationalSnapshotV1;
}

function normalizeLegacyOperationalSnapshot(record: Record<string, unknown>): Record<string, unknown> {
  assertExactKeys(record, LEGACY_TOP_LEVEL_KEYS, "legacy snapshot");
  const summaries = Array.isArray(record.programSummaries) ? record.programSummaries : [];
  const normalizedSummaries = summaries.map((item, index) => {
    const row = assertRecord(item, `legacy programSummaries[${index}]`);
    assertExactKeys(row, PROGRAM_SUMMARY_KEYS, `legacy programSummaries[${index}]`);
    const counts = assertRecord(row.counts, `legacy programSummaries[${index}].counts`);
    assertExactKeys(counts, LEGACY_PROGRAM_COUNT_KEYS, `legacy programSummaries[${index}].counts`);
    assertNumberRecord(counts, `legacy programSummaries[${index}].counts`);
    // No reply signal to derive a real union from at this schema age — same replies-only
    // fallback the server applies when reading a pre-respondedOrApplied stored snapshot.
    const respondedOrApplied = typeof counts.replies === "number" ? counts.replies : 0;
    // Same treatment as respondedOrApplied above: pre-existing max(applications, sheetLeads)
    // reading, matching the server's sanitizeProgramSummary fallback for this schema age.
    const appliedWithPortal = Math.max(
      typeof counts.applications === "number" ? counts.applications : 0,
      typeof counts.sheetLeads === "number" ? counts.sheetLeads : 0,
    );
    return { ...row, counts: { ...counts, qualified: 0, rejected: 0, respondedOrApplied, appliedWithPortal } };
  });
  const sources = Array.isArray(record.sourceCollections)
    ? record.sourceCollections.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...record,
    schemaVersion: OPERATIONAL_SNAPSHOT_SCHEMA_VERSION,
    status: record.status === "rebuilding" ? "rebuilding" : "partial",
    completeness: {
      state: "truncated",
      truncatedSources: sources.length > 0 ? sources : ["legacy_unknown"],
      sourceLimit: 5_000,
    },
    programSummaries: normalizedSummaries,
  };
}

function validateCompleteness(value: unknown): void {
  const row = assertRecord(value, "completeness");
  assertExactKeys(row, COMPLETENESS_KEYS, "completeness");
  if (row.state !== "complete" && row.state !== "truncated") throw new Error("invalid completeness state");
  assertStringArray(row.truncatedSources, "truncatedSources");
  if (row.sourceLimit !== null && (!Number.isInteger(row.sourceLimit) || (row.sourceLimit as number) <= 0)) {
    throw new Error("invalid completeness sourceLimit");
  }
  if (row.state === "complete" && ((row.truncatedSources as string[]).length > 0 || row.sourceLimit !== null)) {
    throw new Error("complete snapshot cannot declare truncation");
  }
  if (row.state === "truncated" && (row.truncatedSources as string[]).length === 0) {
    throw new Error("truncated snapshot must name its sources");
  }
}

export function assertOperationalSnapshotPiiFree(snapshot: unknown): void {
  rejectForbiddenPiiKeys(snapshot);
}

function validateProgramSummaries(value: unknown): void {
  if (!Array.isArray(value)) throw new Error("programSummaries must be an array");
  for (const [index, item] of value.entries()) {
    const row = assertRecord(item, `programSummaries[${index}]`);
    assertExactKeys(row, PROGRAM_SUMMARY_KEYS, `programSummaries[${index}]`);
    for (const key of ["canonicalProgramId", "title", "slug", "status", "lastActivityAtIso"]) {
      if (typeof row[key] !== "string") throw new Error(`${key} must be a string`);
    }
    if (typeof row.visible !== "boolean") throw new Error("visible must be boolean");
    assertStringArray(row.aliases, "aliases");
    assertStringArray(row.legacyProgramIds, "legacyProgramIds");
    const counts = assertRecord(row.counts, "counts");
    assertExactKeys(counts, PROGRAM_COUNT_KEYS, "counts");
    assertNumberRecord(counts, "counts");
  }
}

function rejectForbiddenPiiKeys(value: unknown, path = "snapshot"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbiddenPiiKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenPiiKey(key)) throw new Error(`PII-bearing key rejected at ${path}.${key}`);
    rejectForbiddenPiiKeys(nested, `${path}.${key}`);
  }
}

function isForbiddenPiiKey(key: string): boolean {
  if (ALLOWED_FORBIDDEN_WORD_KEYS.has(key)) return false;
  const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
  return Array.from(FORBIDDEN_PII_KEYS).some((token) => normalized.includes(token));
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected keys: ${actual.join(",")}`);
  }
}

function assertStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be string[]`);
}

function assertNumberRecord(value: unknown, label: string): void {
  const record = assertRecord(value, label);
  for (const [key, nested] of Object.entries(record)) {
    if (typeof nested !== "number" || !Number.isFinite(nested) || nested < 0) throw new Error(`${label}.${key} must be a non-negative number`);
  }
}

function assertStringRecord(value: unknown, label: string): void {
  const record = assertRecord(value, label);
  for (const [key, nested] of Object.entries(record)) {
    if (typeof nested !== "string") throw new Error(`${label}.${key} must be a string`);
  }
}

function assertIsoString(value: unknown, label: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO string`);
}
