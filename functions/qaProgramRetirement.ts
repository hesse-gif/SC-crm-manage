import { createHash } from "node:crypto";
import {
  FieldPath,
  FieldValue,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Query,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
  type Transaction,
} from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { isOperationalFixtureRecord } from "./operationalFixtureProvenance";
import {
  confirmedProgramAliasMap,
  resolveCanonicalProgramId,
  scpAliasIds,
  SCP_CANONICAL_PROGRAM_ID,
} from "./programCanonical";
import {
  asRecord,
  assertNonGuestAuth,
  makeBehaviorLog,
  type AuthContext,
  type CallableRequestShape,
} from "./shared";

const ACTION = "programs.retire_legacy_qa_fixtures";
const ADMIN_ROLES = ["super_admin", "admin"] as const;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;
const REFERENCE_PAGE_SIZE = 250;
const REFERENCE_AUDIT_ROW_BUDGET = 5_000;
const REFERENCE_AUDIT_PAGE_BUDGET = 16_384;
const RECEIPT_COLLECTION = "qa_program_retirement_receipts";
const AUDIT_COLLECTION = "qa_program_retirement_audits";
const EXACT_LEAKED_QA_PROGRAM_ID = /^pg-prodqa-threadbreak-\d{10,}$/;

export const QA_PROGRAM_RETIREMENT_VERSION =
  "qa-program-retirement-v1" as const;
export const QA_PROGRAM_RETIREMENT_REASON =
  "retired_exact_operational_qa_fixture" as const;
export const QA_PROGRAM_RETIREMENT_REFERENCE_AUDIT_VERSION =
  "qa-program-reference-audit-v2" as const;

type ReferenceSpec = {
  readonly collection: string;
  readonly fields: readonly string[];
  readonly collectionGroup?: boolean;
};

// This is the reviewed program-reference surface. Each query is an exact
// single-field lookup and every result is de-duplicated by document path. A
// future collection that introduces a program reference must extend this
// registry and therefore changes the version-bound preview digest.
const PROGRAM_REFERENCE_SPECS: readonly ReferenceSpec[] = [
  { collection: "programs", fields: ["programId", "canonicalProgramId", "aliases", "legacyProgramIds"] },
  { collection: "program_aliases", fields: ["canonicalProgramId", "alias", "sourceRefs"] },
  { collection: "program_registry", fields: ["canonicalProgramId", "aliases", "legacyProgramIds", "sourceRefs"] },
  { collection: "program_applications", fields: ["programId", "canonicalProgramId", "rawProgramIdAlias", "programIdAlias", "programRef"] },
  { collection: "program_application_rate_limits", fields: ["programId", "canonicalProgramId"] },
  {
    collection: "program_sheet_leads",
    fields: [
      "programId",
      "canonicalProgramId",
      "bridgedProgramId",
      "rawProgramIdAlias",
      "programIdAlias",
      "program",
      "programSlug",
      "programRef",
      "sourceContract.canonicalProgramId",
    ],
  },
  { collection: "intake_sources", fields: ["programId", "canonicalProgramId", "sourceContract.canonicalProgramId"] },
  { collection: "sheet_sync_runs", fields: ["sourceContract.canonicalProgramId"] },
  { collection: "sheet_source_rows", fields: ["programId", "canonicalProgramId", "sourceContract.canonicalProgramId"] },
  { collection: "participant_roster_entries", fields: ["programId", "canonicalProgramId"] },
  { collection: "participant_roster_sync_audits", fields: ["canonicalProgramId"] },
  { collection: "campaigns", fields: ["programId", "canonicalProgramId", "program", "programSlug", "programRef"] },
  { collection: "campaign_priority_audit", fields: ["programId", "canonicalProgramId"] },
  { collection: "campaign_candidates", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "campaign_outreach", fields: ["programId", "canonicalProgramId", "campaignProgramId", "programRef"] },
  { collection: "campaign_outreach_reservations", fields: ["programId", "canonicalProgramId"] },
  { collection: "campaign_creator_leases", fields: ["programId", "canonicalProgramId"] },
  { collection: "campaign_arbiter_decisions", fields: ["programId", "canonicalProgramId"] },
  { collection: "campaign_arbiter_program_counters", fields: ["programId", "canonicalProgramId", "scopeId"] },
  { collection: "program_outreach_dedup", fields: ["programId", "canonicalProgramId"] },
  { collection: "discovery_runs", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "workflow_jobs", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "community_post_artifacts", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "community_candidate_artifacts", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "community_posts", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "community_candidate_generations", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "community_publication_generations", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "community_publication_heads", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "candidate_pool", fields: ["programId", "canonicalProgramId", "programIds", "rawProgramIdAlias", "programRef"] },
  { collection: "creator_links", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "submission_tasks", fields: ["programId", "canonicalProgramId", "rawProgramIdAlias", "programIdAlias", "programRef"] },
  { collection: "submissions", fields: ["programId", "canonicalProgramId", "rawProgramIdAlias", "programIdAlias", "programRef"] },
  { collection: "submission_review_counts", fields: ["programId", "canonicalProgramId", "lastRawProgramIdAlias", "programIdAlias"] },
  { collection: "submission_review_count_reconciliation_runs", fields: ["programId", "canonicalProgramId"] },
  { collection: "submission_review_count_reconciliation_audits", fields: ["programId", "canonicalProgramId"] },
  { collection: "video_review_automation_outbox", fields: ["programId", "canonicalProgramId", "claimedCanonicalProgramId"] },
  { collection: "video_review_decisions", fields: ["programId", "canonicalProgramId"] },
  { collection: "video_review_multimodal_decisions", fields: ["programId", "canonicalProgramId"] },
  { collection: "review_ledger", fields: ["programId", "canonicalProgramId", "rawProgramIdAlias", "programIdAlias", "programRef"] },
  { collection: "reviews", fields: ["programId", "canonicalProgramId", "rawProgramIdAlias", "programIdAlias", "programRef"] },
  { collection: "contracts", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "conversations", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "messages", fields: ["programId", "canonicalProgramId", "programRef"], collectionGroup: true },
  { collection: "qualification_decisions", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "scp_coldmail_history", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "scp_outreach", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "scp_mail_results", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "mail_outbound_log", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "message_sources", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "auto_reply_queue", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "gem_grants", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "scp_lifecycle_profiles", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "ad_proposals", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "llm_usage_events", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "videos", fields: ["programId", "canonicalProgramId", "scpReviewMeta.programId"] },
  { collection: "youtube_authorizations", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "youtube_authorization_events", fields: ["programId", "canonicalProgramId", "programRef"] },
  { collection: "feedback", fields: ["programId", "canonicalProgramId", "scope.programId"] },
  { collection: "feedback_graph_projection_outbox", fields: ["programId", "canonicalProgramId", "scope.programId"] },
  { collection: "feedback_review_events", fields: ["programId", "canonicalProgramId", "scope.programId"] },
  { collection: "fine_tune_outbox", fields: ["programId", "canonicalProgramId", "scope.programId"] },
  { collection: "fine_tune_release_events", fields: ["programId", "canonicalProgramId", "scope.programId"] },
  { collection: "fine_tune_compensation_outbox", fields: ["programId", "canonicalProgramId", "scope.programId"] },
  { collection: "kb_review", fields: ["programId", "canonicalProgramId", "scope.programId"] },
  { collection: "feedback_kb_entries", fields: ["programId", "canonicalProgramId", "scope.programId"], collectionGroup: true },
  { collection: "retrievals", fields: ["programId", "canonicalProgramId", "scope.programId"], collectionGroup: true },
  { collection: "knowledge_nodes", fields: ["entityRefs"] },
  { collection: "knowledge_edges", fields: ["from", "to"] },
  { collection: "feed_proposal_learning_events", fields: ["programId"] },
] as const;

type ReferenceAuditBudget = {
  readonly rowLimit: number;
  readonly pageLimit: number;
  rowsRead: number;
  pagesRead: number;
  exceeded: boolean;
};

type ReferenceAuditUsage = {
  rowLimit: number;
  pageLimit: number;
  rowsRead: number;
  pagesRead: number;
  exceeded: boolean;
};

type ReferenceEvidence = {
  ref: string;
  collection: string;
  fixture: boolean;
  fingerprint: string;
  matchedFields: string[];
  confirmedAliasMap: Record<string, string>;
};

type CandidatePlan = {
  programId: string;
  programRef: string;
  fingerprint: string;
  referenceFingerprint: string;
  referenceAuditVersion: typeof QA_PROGRAM_RETIREMENT_REFERENCE_AUDIT_VERSION;
  referenceAuditComplete: boolean;
  referenceAuditUsage: ReferenceAuditUsage;
  referenceCounts: {
    total: number;
    fixture: number;
    live: number;
    publicApplications: number;
  };
  references: string[];
  blockedReasons: string[];
  eligible: boolean;
  humanGateRequired: boolean;
  alreadyRetired: boolean;
};

type PagePlan = {
  version: typeof QA_PROGRAM_RETIREMENT_VERSION;
  referenceAuditVersion: typeof QA_PROGRAM_RETIREMENT_REFERENCE_AUDIT_VERSION;
  actorUid: string;
  afterProgramId: string | null;
  limit: number;
  scannedCount: number;
  scannedFingerprints: Array<{ programRef: string; fingerprint: string }>;
  complete: boolean;
  nextCursor: string | null;
  auditComplete: boolean;
  humanGateRequired: boolean;
  referenceAuditBudget: ReferenceAuditUsage;
  candidates: CandidatePlan[];
  digest: string;
};

type ExpectedCandidate = {
  programRef: string;
  fingerprint: string;
  referenceFingerprint: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bool(value: unknown): boolean {
  return value === true;
}

function hasOwn(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function boundedPageSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(value)))
    : DEFAULT_PAGE_SIZE;
}

function createReferenceAuditBudget(): ReferenceAuditBudget {
  return {
    rowLimit: REFERENCE_AUDIT_ROW_BUDGET,
    pageLimit: REFERENCE_AUDIT_PAGE_BUDGET,
    rowsRead: 0,
    pagesRead: 0,
    exceeded: false,
  };
}

function referenceAuditUsage(
  budget: ReferenceAuditBudget,
  startRows = 0,
  startPages = 0,
): ReferenceAuditUsage {
  return {
    rowLimit: budget.rowLimit,
    pageLimit: budget.pageLimit,
    rowsRead: budget.rowsRead - startRows,
    pagesRead: budget.pagesRead - startPages,
    exceeded: budget.exceeded,
  };
}

function cursorId(value: unknown): string {
  const cursor = text(value);
  if (!cursor) return "";
  if (cursor.length > 1_500 || cursor.includes("/")) {
    throw Object.assign(new Error("invalid-argument: afterProgramId is invalid"), {
      code: "invalid-argument", errorCode: "cursor_id_after_program_id_invalid",
    });
  }
  return cursor;
}

function canonicalValue(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const object = value as Record<string, unknown> & {
      path?: unknown;
      toDate?: unknown;
      toMillis?: unknown;
    };
    if (typeof object.path === "string") return { $ref: object.path };
    if (typeof object.toDate === "function") {
      const date = (object.toDate as () => Date)();
      if (date instanceof Date && !Number.isNaN(date.getTime())) return { $timestamp: date.toISOString() };
    }
    if (typeof object.toMillis === "function") {
      const millis = (object.toMillis as () => number)();
      if (Number.isFinite(millis)) return { $timestampMillis: millis };
    }
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, canonicalValue(object[key])]),
    );
  }
  return String(value);
}

export function qaProgramRetirementHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function programFingerprint(programRef: string, data: Record<string, unknown>): string {
  return qaProgramRetirementHash({ programRef, data });
}

function isProtectedProgram(programId: string, data: Record<string, unknown>): boolean {
  const protectedAliases = new Set(scpAliasIds());
  const aliases = Array.isArray(data.aliases) ? data.aliases.map(text).filter(Boolean) : [];
  const legacyProgramIds = Array.isArray(data.legacyProgramIds)
    ? data.legacyProgramIds.map(text).filter(Boolean)
    : [];
  const declaredIds = [
    programId,
    data.id,
    data.programId,
    data.canonicalProgramId,
    ...aliases,
    ...legacyProgramIds,
  ];
  if (declaredIds.some((value) => {
    const id = text(value);
    return id && (protectedAliases.has(id) || resolveCanonicalProgramId(id) === SCP_CANONICAL_PROGRAM_ID);
  })) return true;
  return data.protected === true
    || data.seedWrite === false
    || data.systemManaged === true
    || data.retirementProtected === true
    || data.immutable === true;
}

function isExactLeakedQaProgramCandidate(
  programId: string,
  data: Record<string, unknown>,
): boolean {
  return EXACT_LEAKED_QA_PROGRAM_ID.test(programId)
    && isOperationalFixtureRecord(data, "programs");
}

export function isQaProgramRetiredRecord(value: unknown): boolean {
  const row = asRecord(value);
  const marker = asRecord(row.qaProgramRetirement);
  const receiptRef = text(marker.receiptRef);
  const auditRef = text(marker.auditRef);
  return marker.immutable === true
    && marker.version === QA_PROGRAM_RETIREMENT_VERSION
    && marker.reason === QA_PROGRAM_RETIREMENT_REASON
    && /^qa_program_retirement_receipts\/[a-f0-9]{64}$/.test(receiptRef)
    && /^qa_program_retirement_audits\/[a-f0-9]{64}$/.test(auditRef)
    && row.qaProgramRetirementVersion === QA_PROGRAM_RETIREMENT_VERSION
    && row.qaProgramRetirementReason === QA_PROGRAM_RETIREMENT_REASON
    && row.qaProgramRetirementReceiptRef === receiptRef
    && row.qaProgramRetirementAuditRef === auditRef;
}

export function assertQaProgramRetirementNotRevived(value: unknown): void {
  if (!isQaProgramRetiredRecord(value)) return;
  throw Object.assign(
    new Error("failed-precondition: retired QA fixture programs require an explicit restore engine"),
    { code: "failed-precondition", errorCode: "assert_qa_program_retirement_not_revived_retired_qa_fixture_programs" },
  );
}

async function querySnapshot(
  query: Query<DocumentData>,
  transaction?: Transaction,
): Promise<QuerySnapshot<DocumentData>> {
  return transaction ? transaction.get(query) : query.get();
}

function rowForSnapshot(snapshot: DocumentSnapshot<DocumentData>): Record<string, unknown> {
  // The Firestore path is authoritative. A stale or hostile stored `id` field
  // must not redirect fixture classification or a reference fingerprint.
  return { ...(snapshot.data() ?? {}), id: snapshot.id };
}

function referenceEvidenceForSnapshot(
  snapshot: DocumentSnapshot<DocumentData>,
  collection: string,
  matchedField: string,
): ReferenceEvidence {
  const row = rowForSnapshot(snapshot);
  return {
    ref: snapshot.ref.path,
    collection,
    fixture: isOperationalFixtureRecord(row, collection),
    fingerprint: qaProgramRetirementHash({ ref: snapshot.ref.path, data: row }),
    matchedFields: [matchedField],
    confirmedAliasMap: collection === "program_aliases"
      ? confirmedProgramAliasMap([row])
      : {},
  };
}

async function collectReferenceQuery(
  query: Query<DocumentData>,
  collection: string,
  matchedField: string,
  budget: ReferenceAuditBudget,
  transaction?: Transaction,
): Promise<{ rows: ReferenceEvidence[]; complete: boolean }> {
  const rows: ReferenceEvidence[] = [];
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  while (true) {
    const remainingRows = budget.rowLimit - budget.rowsRead;
    const remainingPages = budget.pageLimit - budget.pagesRead;
    if (remainingRows <= 0 || remainingPages <= 0) {
      budget.exceeded = true;
      return { rows, complete: false };
    }
    const limit = Math.min(REFERENCE_PAGE_SIZE, remainingRows);
    let pageQuery = query.orderBy(FieldPath.documentId()).limit(limit);
    if (cursor) pageQuery = pageQuery.startAfter(cursor);
    budget.pagesRead += 1;
    const page = await querySnapshot(pageQuery, transaction);
    if (page.empty) return { rows, complete: true };
    for (const snapshot of page.docs) {
      rows.push(referenceEvidenceForSnapshot(snapshot, collection, matchedField));
    }
    budget.rowsRead += page.size;
    cursor = page.docs.at(-1) ?? null;
    if (page.size < limit || !cursor) return { rows, complete: true };
    if (budget.rowsRead >= budget.rowLimit || budget.pagesRead >= budget.pageLimit) {
      budget.exceeded = true;
      return { rows, complete: false };
    }
  }
}

type ReferenceQueryOperator = "==" | "array-contains";

type ReferenceQueryPlan = {
  collection: string;
  field: string;
  query: Query<DocumentData>;
};

const PROGRAM_ID_ARRAY_REFERENCE_FIELDS = new Set([
  "aliases",
  "legacyProgramIds",
  "programIds",
]);
const PROGRAM_REF_ARRAY_REFERENCE_FIELDS = new Set(["sourceRefs", "entityRefs"]);
const PROGRAM_REF_SCALAR_REFERENCE_FIELDS = new Set(["programRef", "from", "to"]);

function referenceQueryPlansForField(
  spec: ReferenceSpec,
  field: string,
  programId: string,
  programData: Record<string, unknown>,
): ReferenceQueryPlan[] {
  const programRef = `programs/${programId}`;
  const programSlug = text(programData.slug);
  let operator: ReferenceQueryOperator = "==";
  let expectedValues: unknown[];

  if (PROGRAM_REF_SCALAR_REFERENCE_FIELDS.has(field)) {
    expectedValues = [programRef, adminDb.doc(programRef)];
  } else if (field === "program") {
    expectedValues = [programId, programSlug].filter(Boolean);
  } else if (field === "programSlug") {
    expectedValues = programSlug ? [programSlug] : [];
  } else if (PROGRAM_ID_ARRAY_REFERENCE_FIELDS.has(field)) {
    operator = "array-contains";
    expectedValues = [programId];
  } else if (PROGRAM_REF_ARRAY_REFERENCE_FIELDS.has(field)) {
    operator = "array-contains";
    expectedValues = [programRef, adminDb.doc(programRef)];
  } else {
    expectedValues = [programId];
  }

  const queryRoot: Query<DocumentData> = spec.collectionGroup
    ? adminDb.collectionGroup(spec.collection)
    : adminDb.collection(spec.collection);
  const uniqueValues = expectedValues.filter((value, index, values) => values.indexOf(value) === index);
  return uniqueValues.map((expected) => ({
    collection: spec.collection,
    field,
    query: queryRoot.where(field, operator, expected),
  }));
}

async function referenceEvidenceForProgram(
  programId: string,
  programData: Record<string, unknown>,
  budget: ReferenceAuditBudget,
  transaction?: Transaction,
): Promise<{ rows: ReferenceEvidence[]; complete: boolean; usage: ReferenceAuditUsage }> {
  const startRows = budget.rowsRead;
  const startPages = budget.pagesRead;
  const chunks: Array<{ rows: ReferenceEvidence[]; complete: boolean }> = [];
  const queryPlans = PROGRAM_REFERENCE_SPECS.flatMap((spec) => (
    spec.fields.flatMap((field) => referenceQueryPlansForField(spec, field, programId, programData))
  ));
  // Alias documents are keyed by alias. Querying the denormalized `alias`
  // field is not sufficient for legacy rows that only persisted the document
  // id, so bind that direct document into the same reference audit.
  const directAliasRef = adminDb.collection("program_aliases").doc(programId);
  if (budget.pagesRead >= budget.pageLimit || budget.rowsRead >= budget.rowLimit) {
    budget.exceeded = true;
    chunks.push({ rows: [], complete: false });
  } else {
    budget.pagesRead += 1;
    const directAlias = transaction
      ? await transaction.get(directAliasRef)
      : await directAliasRef.get();
    if (directAlias.exists) {
      budget.rowsRead += 1;
      chunks.push({
        rows: [referenceEvidenceForSnapshot(directAlias, "program_aliases", "__name__")],
        complete: true,
      });
    }
  }

  let completedQueryPlans = 0;
  for (const plan of queryPlans) {
    if (budget.exceeded) break;
    const chunk = await collectReferenceQuery(
      plan.query,
      plan.collection,
      plan.field,
      budget,
      transaction,
    );
    chunks.push(chunk);
    completedQueryPlans += 1;
    if (!chunk.complete) break;
  }

  const byRef = new Map<string, ReferenceEvidence>();
  for (const row of chunks.flatMap((chunk) => chunk.rows)) {
    const existing = byRef.get(row.ref);
    if (!existing) {
      byRef.set(row.ref, row);
      continue;
    }
    existing.matchedFields = Array.from(new Set([...existing.matchedFields, ...row.matchedFields])).sort();
    existing.confirmedAliasMap = {
      ...existing.confirmedAliasMap,
      ...row.confirmedAliasMap,
    };
    if (existing.fingerprint !== row.fingerprint || existing.fixture !== row.fixture) {
      throw Object.assign(new Error("aborted: reference evidence changed during audit"), {
        code: "aborted", errorCode: "reference_evidence_for_program_reference_evidence_changed_during_audit",
      });
    }
  }
  return {
    rows: [...byRef.values()].sort((left, right) => left.ref.localeCompare(right.ref)),
    complete: completedQueryPlans === queryPlans.length
      && chunks.every((chunk) => chunk.complete)
      && !budget.exceeded,
    usage: referenceAuditUsage(budget, startRows, startPages),
  };
}

async function candidatePlanForSnapshot(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  budget: ReferenceAuditBudget,
  transaction?: Transaction,
): Promise<CandidatePlan | null> {
  const data = rowForSnapshot(snapshot);
  const programId = snapshot.id;
  if (!isExactLeakedQaProgramCandidate(programId, data)) return null;

  const referenceAudit = await referenceEvidenceForProgram(programId, data, budget, transaction);
  const liveRows = referenceAudit.rows.filter((row) => !row.fixture);
  const publicApplications = liveRows.filter((row) => row.collection === "program_applications");
  const confirmedAliasMap = Object.assign(
    {},
    ...referenceAudit.rows.map((row) => row.confirmedAliasMap),
  ) as Record<string, string>;
  const declaredAliases = Array.isArray(data.aliases)
    ? data.aliases.map(text).filter((alias) => alias && alias !== programId)
    : [];
  const declaredLegacyProgramIds = Array.isArray(data.legacyProgramIds)
    ? data.legacyProgramIds.map(text).filter((alias) => alias && alias !== programId)
    : [];
  const confirmedAliasMember = resolveCanonicalProgramId(programId, confirmedAliasMap) !== programId
    || Object.entries(confirmedAliasMap).some(([alias, canonicalProgramId]) => (
      alias !== programId
      && resolveCanonicalProgramId(canonicalProgramId, confirmedAliasMap) === programId
    ));
  const blockedReasons = new Set<string>();
  const alreadyRetired = isQaProgramRetiredRecord(data);
  if (isProtectedProgram(programId, data)) blockedReasons.add("protected_program");
  if (declaredAliases.length > 0 || declaredLegacyProgramIds.length > 0 || confirmedAliasMember) {
    blockedReasons.add("protected_program_alias");
  }
  if (!referenceAudit.complete) blockedReasons.add("reference_audit_incomplete");
  if (referenceAudit.usage.exceeded) blockedReasons.add("reference_audit_budget_exceeded");
  if (liveRows.length > 0) blockedReasons.add("live_non_fixture_references");
  if (publicApplications.length > 0) blockedReasons.add("public_application_reference");
  if (hasOwn(data, "qaProgramRetirement") && !alreadyRetired) blockedReasons.add("retirement_marker_conflict");
  if (alreadyRetired) blockedReasons.add("already_retired");

  const references = referenceAudit.rows.map((row) => row.ref);
  const referenceFingerprint = qaProgramRetirementHash({
    auditVersion: QA_PROGRAM_RETIREMENT_REFERENCE_AUDIT_VERSION,
    complete: referenceAudit.complete,
    usage: referenceAudit.usage,
    rows: referenceAudit.rows,
  });
  const reasons = [...blockedReasons].sort();
  return {
    programId,
    programRef: snapshot.ref.path,
    fingerprint: programFingerprint(snapshot.ref.path, data),
    referenceFingerprint,
    referenceAuditVersion: QA_PROGRAM_RETIREMENT_REFERENCE_AUDIT_VERSION,
    referenceAuditComplete: referenceAudit.complete,
    referenceAuditUsage: referenceAudit.usage,
    referenceCounts: {
      total: referenceAudit.rows.length,
      fixture: referenceAudit.rows.length - liveRows.length,
      live: liveRows.length,
      publicApplications: publicApplications.length,
    },
    references,
    blockedReasons: reasons,
    eligible: reasons.length === 0,
    humanGateRequired: !referenceAudit.complete,
    alreadyRetired,
  };
}

async function buildPagePlan(
  auth: AuthContext,
  afterProgramId: string,
  limit: number,
  transaction?: Transaction,
): Promise<PagePlan> {
  let query = adminDb.collection("programs")
    .orderBy(FieldPath.documentId())
    .limit(limit + 1);
  if (afterProgramId) query = query.startAfter(afterProgramId);
  const page = await querySnapshot(query, transaction);
  const scanned = page.docs.slice(0, limit);
  const complete = page.docs.length <= limit;
  const nextCursor = complete ? null : scanned.at(-1)?.id ?? null;
  const candidates: CandidatePlan[] = [];
  const referenceBudget = createReferenceAuditBudget();
  for (const snapshot of scanned) {
    const candidate = await candidatePlanForSnapshot(snapshot, referenceBudget, transaction);
    if (candidate) candidates.push(candidate);
  }
  const auditComplete = candidates.every((candidate) => candidate.referenceAuditComplete);
  const unsigned = {
    version: QA_PROGRAM_RETIREMENT_VERSION,
    referenceAuditVersion: QA_PROGRAM_RETIREMENT_REFERENCE_AUDIT_VERSION,
    actorUid: auth.userId,
    afterProgramId: afterProgramId || null,
    limit,
    scannedCount: scanned.length,
    scannedFingerprints: scanned.map((snapshot) => ({
      programRef: snapshot.ref.path,
      fingerprint: programFingerprint(snapshot.ref.path, rowForSnapshot(snapshot)),
    })),
    complete,
    nextCursor,
    auditComplete,
    humanGateRequired: !auditComplete,
    referenceAuditBudget: referenceAuditUsage(referenceBudget),
    candidates,
  };
  return { ...unsigned, digest: qaProgramRetirementHash(unsigned) };
}

function expectedCandidates(value: unknown): ExpectedCandidate[] {
  if (!Array.isArray(value)) {
    throw Object.assign(new Error("invalid-argument: expectedCandidates is required"), {
      code: "invalid-argument", errorCode: "expected_candidates_expected_candidates_required",
    });
  }
  const rows = value.map((item) => {
    const row = asRecord(item);
    const programRef = text(row.programRef);
    const fingerprint = text(row.fingerprint);
    const referenceFingerprint = text(row.referenceFingerprint);
    if (
      !/^programs\/[^/]{1,1500}$/.test(programRef)
      || !/^[a-f0-9]{64}$/.test(fingerprint)
      || !/^[a-f0-9]{64}$/.test(referenceFingerprint)
    ) {
      throw Object.assign(new Error("invalid-argument: expected candidate binding is invalid"), {
        code: "invalid-argument", errorCode: "expected_candidates_expected_candidate_binding_invalid",
      });
    }
    return { programRef, fingerprint, referenceFingerprint };
  });
  const sorted = [...rows].sort((left, right) => left.programRef.localeCompare(right.programRef));
  if (new Set(sorted.map((row) => row.programRef)).size !== sorted.length) {
    throw Object.assign(new Error("invalid-argument: expectedCandidates contains duplicates"), {
      code: "invalid-argument", errorCode: "expected_candidates_expected_candidates_contains_duplicates",
    });
  }
  return sorted;
}

function candidateBindings(plan: PagePlan): ExpectedCandidate[] {
  return plan.candidates
    .map((candidate) => ({
      programRef: candidate.programRef,
      fingerprint: candidate.fingerprint,
      referenceFingerprint: candidate.referenceFingerprint,
    }))
    .sort((left, right) => left.programRef.localeCompare(right.programRef));
}

function exactCandidateBindings(left: ExpectedCandidate[], right: ExpectedCandidate[]): boolean {
  return qaProgramRetirementHash(left) === qaProgramRetirementHash(right);
}

function operationError(
  auth: AuthContext,
  code: "aborted" | "failed-precondition" | "invalid-argument",
  message: string,
): Error {
  return Object.assign(new Error(`${code}: ${message}`), {
    code,
    behaviorLog: makeBehaviorLog(auth, ACTION, "denied", "programs"),
  });
}

function applyContract(plan: PagePlan) {
  return {
    expectedVersion: plan.version,
    expectedDigest: plan.digest,
    afterProgramId: plan.afterProgramId,
    limit: plan.limit,
    expectedCandidates: candidateBindings(plan),
  };
}

function exactLedgerStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !/^programs\/[^/]{1,1500}$/.test(item))) {
    return null;
  }
  const rows = value as string[];
  const sorted = [...rows].sort();
  return new Set(rows).size === rows.length && rows.every((item, index) => item === sorted[index])
    ? rows
    : null;
}

function immutableLedgerCore(
  row: Record<string, unknown>,
  auth: AuthContext,
  digest: string,
  expected: ExpectedCandidate[],
  afterProgramId: string,
  limit: number,
  receiptRefPath: string,
  auditRefPath: string,
): Record<string, unknown> | null {
  let storedExpected: ExpectedCandidate[];
  try {
    storedExpected = expectedCandidates(row.expectedCandidates);
  } catch {
    return null;
  }
  const appliedProgramRefs = exactLedgerStringArray(row.appliedProgramRefs);
  const blockedProgramRefs = exactLedgerStringArray(row.blockedProgramRefs);
  if (!appliedProgramRefs || !blockedProgramRefs) return null;
  const expectedRefs = expected.map((candidate) => candidate.programRef).sort();
  const partition = [...appliedProgramRefs, ...blockedProgramRefs].sort();
  if (
    qaProgramRetirementHash(partition) !== qaProgramRetirementHash(expectedRefs)
    || appliedProgramRefs.some((programRef) => blockedProgramRefs.includes(programRef))
  ) return null;
  const storedAfter = row.afterProgramId === null
    ? null
    : typeof row.afterProgramId === "string"
      ? row.afterProgramId
      : undefined;
  const storedNext = row.nextCursor === null
    ? null
    : typeof row.nextCursor === "string"
      ? row.nextCursor
      : undefined;
  const createdAtIso = text(row.createdAtIso);
  if (
    row.schemaVersion !== QA_PROGRAM_RETIREMENT_VERSION
    || row.version !== QA_PROGRAM_RETIREMENT_VERSION
    || row.referenceAuditVersion !== QA_PROGRAM_RETIREMENT_REFERENCE_AUDIT_VERSION
    || row.reason !== QA_PROGRAM_RETIREMENT_REASON
    || row.immutable !== true
    || row.digest !== digest
    || row.actorUid !== auth.userId
    || !ADMIN_ROLES.includes(row.actorRole as typeof ADMIN_ROLES[number])
    || !exactCandidateBindings(storedExpected, expected)
    || storedAfter === undefined
    || storedAfter !== (afterProgramId || null)
    || row.limit !== limit
    || typeof row.pageComplete !== "boolean"
    || storedNext === undefined
    || row.appliedCount !== appliedProgramRefs.length
    || row.blockedCount !== blockedProgramRefs.length
    || !createdAtIso
    || !Number.isFinite(Date.parse(createdAtIso))
    || row.receiptRef !== receiptRefPath
    || row.auditRef !== auditRefPath
  ) return null;
  return {
    schemaVersion: row.schemaVersion,
    version: row.version,
    referenceAuditVersion: row.referenceAuditVersion,
    reason: row.reason,
    immutable: row.immutable,
    digest: row.digest,
    actorUid: row.actorUid,
    actorRole: row.actorRole,
    expectedCandidates: storedExpected,
    afterProgramId: storedAfter,
    limit: row.limit,
    pageComplete: row.pageComplete,
    nextCursor: storedNext,
    appliedProgramRefs,
    blockedProgramRefs,
    appliedCount: row.appliedCount,
    blockedCount: row.blockedCount,
    receiptRef: row.receiptRef,
    auditRef: row.auditRef,
    createdAtIso,
  };
}

function immutableLedgerMatches(
  row: Record<string, unknown>,
  expectedKind: "qa_program_retirement_receipt" | "qa_program_retirement_audit",
  core: Record<string, unknown> | null,
): core is Record<string, unknown> {
  return core !== null
    && row.kind === expectedKind
    && /^[a-f0-9]{64}$/.test(text(row.integrityHash))
    && row.integrityHash === qaProgramRetirementHash(core);
}

export async function retireLegacyQaPrograms(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, ACTION, ADMIN_ROLES);
  const data = asRecord(request.data);
  const afterProgramId = cursorId(data.afterProgramId);
  const limit = boundedPageSize(data.limit);
  const dryRun = data.dryRun !== false;
  const actual = data.actual === true;

  if (dryRun) {
    if (actual) throw operationError(auth, "invalid-argument", "dry-run cannot set actual:true");
    const plan = await buildPagePlan(auth, afterProgramId, limit);
    return {
      ok: true,
      mode: "dry_run" as const,
      dryRun: true,
      actual: false,
      version: plan.version,
      referenceAuditVersion: plan.referenceAuditVersion,
      digest: plan.digest,
      scannedCount: plan.scannedCount,
      candidateCount: plan.candidates.length,
      eligibleCount: plan.candidates.filter((candidate) => candidate.eligible).length,
      blockedCount: plan.candidates.filter((candidate) => !candidate.eligible).length,
      auditComplete: plan.auditComplete,
      humanGateRequired: plan.humanGateRequired,
      referenceAuditBudget: plan.referenceAuditBudget,
      complete: plan.complete,
      nextCursor: plan.nextCursor,
      candidates: plan.candidates,
      applyContract: applyContract(plan),
      behaviorLog: makeBehaviorLog(auth, ACTION, "success", "programs"),
    };
  }

  if (!actual) throw operationError(auth, "failed-precondition", "actual:true is required when dryRun is false");
  if (data.expectedVersion !== QA_PROGRAM_RETIREMENT_VERSION) {
    throw operationError(auth, "failed-precondition", "expected retirement version is stale or missing");
  }
  const expectedDigest = text(data.expectedDigest);
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw operationError(auth, "invalid-argument", "expectedDigest is invalid");
  }
  const expected = expectedCandidates(data.expectedCandidates);
  const receiptRef = adminDb.collection(RECEIPT_COLLECTION).doc(expectedDigest);
  const auditRef = adminDb.collection(AUDIT_COLLECTION).doc(expectedDigest);

  const result = await adminDb.runTransaction(async (transaction) => {
    const [existingReceipt, existingAudit] = await Promise.all([
      transaction.get(receiptRef),
      transaction.get(auditRef),
    ]);
    if (existingReceipt.exists || existingAudit.exists) {
      const receiptRow = asRecord(existingReceipt.data());
      const auditRow = asRecord(existingAudit.data());
      const receiptCore = immutableLedgerCore(
        receiptRow,
        auth,
        expectedDigest,
        expected,
        afterProgramId,
        limit,
        receiptRef.path,
        auditRef.path,
      );
      const auditCore = immutableLedgerCore(
        auditRow,
        auth,
        expectedDigest,
        expected,
        afterProgramId,
        limit,
        receiptRef.path,
        auditRef.path,
      );
      if (
        !existingReceipt.exists
        || !existingAudit.exists
        || !immutableLedgerMatches(receiptRow, "qa_program_retirement_receipt", receiptCore)
        || !immutableLedgerMatches(auditRow, "qa_program_retirement_audit", auditCore)
        || receiptRow.integrityHash !== auditRow.integrityHash
        || qaProgramRetirementHash(receiptCore) !== qaProgramRetirementHash(auditCore)
      ) {
        throw operationError(auth, "failed-precondition", "retirement receipt or audit is incomplete or conflicts with this replay");
      }
      const appliedProgramRefs = receiptCore.appliedProgramRefs as string[];
      const expectedByRef = new Map(expected.map((candidate) => [candidate.programRef, candidate]));
      for (const programRef of appliedProgramRefs) {
        const program = await transaction.get(adminDb.doc(programRef));
        const row = asRecord(program.data());
        const marker = asRecord(row.qaProgramRetirement);
        const binding = expectedByRef.get(programRef);
        if (
          !program.exists
          || !binding
          || !isQaProgramRetiredRecord(row)
          || row.status !== "archived"
          || row.visible !== false
          || text(row.archivedAtIso) !== text(marker.retiredAtIso)
          || marker.digest !== expectedDigest
          || marker.priorFingerprint !== binding.fingerprint
          || marker.referenceFingerprint !== binding.referenceFingerprint
          || marker.receiptRef !== receiptRef.path
          || marker.auditRef !== auditRef.path
        ) {
          throw operationError(auth, "failed-precondition", "retired program state conflicts with this replay");
        }
      }
      return {
        replay: true,
        appliedProgramRefs,
        blockedProgramRefs: receiptCore.blockedProgramRefs as string[],
      };
    }

    const plan = await buildPagePlan(auth, afterProgramId, limit, transaction);
    if (plan.digest !== expectedDigest) {
      throw operationError(auth, "aborted", "preview digest is stale, renamed, missing, or belongs to another operator");
    }
    if (!plan.auditComplete) {
      throw operationError(auth, "failed-precondition", "reference audit is incomplete");
    }
    const currentBindings = candidateBindings(plan);
    if (!exactCandidateBindings(currentBindings, expected)) {
      throw operationError(auth, "aborted", "program references or fingerprints changed after preview");
    }
    const actionable = plan.candidates.filter((candidate) => candidate.eligible);
    if (actionable.length === 0) {
      throw operationError(auth, "failed-precondition", "preview has no eligible exact QA fixture programs");
    }

    const nowIso = new Date().toISOString();
    const appliedProgramRefs = actionable.map((candidate) => candidate.programRef).sort();
    const blockedProgramRefs = plan.candidates
      .filter((candidate) => !candidate.eligible)
      .map((candidate) => candidate.programRef)
      .sort();
    const immutableCore = {
      schemaVersion: QA_PROGRAM_RETIREMENT_VERSION,
      version: QA_PROGRAM_RETIREMENT_VERSION,
      referenceAuditVersion: QA_PROGRAM_RETIREMENT_REFERENCE_AUDIT_VERSION,
      reason: QA_PROGRAM_RETIREMENT_REASON,
      immutable: true,
      digest: expectedDigest,
      actorUid: auth.userId,
      actorRole: auth.role,
      expectedCandidates: expected,
      afterProgramId: afterProgramId || null,
      limit,
      pageComplete: plan.complete,
      nextCursor: plan.nextCursor,
      appliedProgramRefs,
      blockedProgramRefs,
      appliedCount: appliedProgramRefs.length,
      blockedCount: blockedProgramRefs.length,
      receiptRef: receiptRef.path,
      auditRef: auditRef.path,
      createdAtIso: nowIso,
    };
    const immutableBase = {
      ...immutableCore,
      integrityHash: qaProgramRetirementHash(immutableCore),
      createdAt: FieldValue.serverTimestamp(),
    };

    for (const candidate of actionable) {
      const ref = adminDb.doc(candidate.programRef) as DocumentReference<DocumentData>;
      transaction.set(ref, {
        status: "archived",
        visible: false,
        archivedAtIso: nowIso,
        archivedAt: FieldValue.serverTimestamp(),
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
        qaProgramRetirementVersion: QA_PROGRAM_RETIREMENT_VERSION,
        qaProgramRetirementReason: QA_PROGRAM_RETIREMENT_REASON,
        qaProgramRetirementReceiptRef: receiptRef.path,
        qaProgramRetirementAuditRef: auditRef.path,
        qaProgramRetirement: {
          version: QA_PROGRAM_RETIREMENT_VERSION,
          reason: QA_PROGRAM_RETIREMENT_REASON,
          immutable: true,
          digest: expectedDigest,
          priorFingerprint: candidate.fingerprint,
          referenceFingerprint: candidate.referenceFingerprint,
          receiptRef: receiptRef.path,
          auditRef: auditRef.path,
          retiredAtIso: nowIso,
          retiredBy: auth.userId,
        },
      }, { merge: true });
    }
    transaction.create(receiptRef, { ...immutableBase, kind: "qa_program_retirement_receipt" });
    transaction.create(auditRef, { ...immutableBase, kind: "qa_program_retirement_audit" });
    return { replay: false, appliedProgramRefs, blockedProgramRefs };
  });

  return {
    ok: true,
    mode: result.replay ? "idempotent_noop" as const : "actual" as const,
    dryRun: false,
    actual: true,
    idempotent: result.replay,
    version: QA_PROGRAM_RETIREMENT_VERSION,
    digest: expectedDigest,
    receiptRef: receiptRef.path,
    auditRef: auditRef.path,
    appliedCount: result.replay ? 0 : result.appliedProgramRefs.length,
    originallyAppliedCount: result.appliedProgramRefs.length,
    blockedCount: result.blockedProgramRefs.length,
    appliedProgramRefs: result.appliedProgramRefs,
    blockedProgramRefs: result.blockedProgramRefs,
    behaviorLog: makeBehaviorLog(auth, ACTION, "success", "programs"),
  };
}
