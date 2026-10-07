import { randomUUID } from "node:crypto";
import {
  FieldPath,
  FieldValue,
  type DocumentSnapshot,
} from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { SCP_CANONICAL_PROGRAM_ID, resolveCanonicalProgramId } from "./programCanonical";
import {
  confirmedProgramScope,
  readConfirmedProgramAliasRegistryState,
  readConfirmedProgramAliasRegistryStateInTransaction,
  type ConfirmedProgramAliasRegistryState,
} from "./programAliasRegistry";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type AuthContext, type CallableRequestShape } from "./shared";
import { assertScpEntitled } from "./mailAccounts";
import {
  SUBMISSION_REVIEW_COUNT_ALIAS_LIMIT,
  SUBMISSION_REVIEW_COUNT_PAGE_SIZE_DEFAULT,
  SUBMISSION_REVIEW_COUNT_PAGE_SIZE_MAX,
  SUBMISSION_REVIEW_COUNT_RECONCILIATION_VERSION,
  accumulateSubmissionReviewCountPage,
  aggregateDocumentFingerprint,
  buildSubmissionReviewCountAliasScope,
  emptySubmissionReviewCountPass,
  stableSubmissionReviewCountHash,
  submissionReviewCountPassesMatch,
  type SubmissionReviewCountAliasScope,
  type SubmissionReviewCountPassState,
  type SubmissionReviewCounts,
} from "./submissionReviewCountReconciliationCore";

const ACTION = "submission_review_counts.reconcile";
const WRITE_ROLES = ["super_admin", "admin"] as const;
const RUNS_COLLECTION = "submission_review_count_reconciliation_runs";
const AUDITS_COLLECTION = "submission_review_count_reconciliation_audits";
const COUNTS_COLLECTION = "submission_review_counts";
const SOURCE_COLLECTION = "submissions";

type ReconciliationPhase = "scan" | "verify" | "ready" | "done" | "failed";
type ReconciliationStatus = "scanning" | "verifying" | "ready_to_finalize" | "completed" | "failed";

type AggregateBaseline = {
  exists: boolean;
  fingerprint: string;
  updateToken: string | null;
};

type StoredRun = {
  schemaVersion: typeof SUBMISSION_REVIEW_COUNT_RECONCILIATION_VERSION;
  runId: string;
  canonicalProgramId: string;
  aliases: string[];
  aliasMap: Record<string, string>;
  aliasHash: string;
  aliasRegistryRevision: string;
  resolverVersion: string;
  sourceCollection: typeof SOURCE_COLLECTION;
  dryRun: boolean;
  actual: boolean;
  pageSize: number;
  status: ReconciliationStatus;
  phase: ReconciliationPhase;
  revision: number;
  scan: SubmissionReviewCountPassState;
  verify: SubmissionReviewCountPassState;
  aggregateBaselines: Record<string, AggregateBaseline>;
  createdBy: string;
  createdByRole: string;
  createdAtIso: string;
  updatedAtIso: string;
  completedAtIso?: string | null;
  failureReason?: string | null;
  written?: boolean;
  supersededLegacyAggregateIds?: string[];
  lastOperation?: {
    key: string;
    expectedRevision: number;
    resultingRevision: number;
  } | null;
};

export type SubmissionReviewCountReconciliationEnvelope = {
  ok: true;
  runId: string;
  dryRun: boolean;
  actual: boolean;
  written: boolean;
  idempotent: boolean;
  canonicalProgramId: string;
  aliases: string[];
  status: ReconciliationStatus;
  phase: ReconciliationPhase;
  revision: number;
  nextExpectedRevision: number | null;
  progress: {
    scan: Pick<SubmissionReviewCountPassState, "scannedRows" | "matchedRows" | "unscopedRows" | "otherProgramRows" | "cursor">;
    verify: Pick<SubmissionReviewCountPassState, "scannedRows" | "matchedRows" | "unscopedRows" | "otherProgramRows" | "cursor">;
  };
  counts: SubmissionReviewCounts | null;
  failureReason: string | null;
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
};

export async function reconcileSubmissionReviewCounts(
  request: CallableRequestShape,
): Promise<SubmissionReviewCountReconciliationEnvelope> {
  const auth = assertNonGuestAuth(request, ACTION, WRITE_ROLES);
  // 2026-09-27 codex adversarial review round 4 sweep: scp canonical-program submission-count
  // reconciliation/migration tool with no general-purpose UI (grep of src/ found zero callers) —
  // same bucket as the other admin-only backstop tools gated in round 2's sweep.
  await assertScpEntitled(auth, request, ACTION);
  const data = asRecord(request.data);
  const requestedRunId = asString(data.runId);
  if (!requestedRunId) return startRun(auth, data);

  assertRunId(requestedRunId);
  const runRef = adminDb.collection(RUNS_COLLECTION).doc(requestedRunId);
  const runSnapshot = await runRef.get();
  if (!runSnapshot.exists) throw operationError(auth, "not-found", "reconciliation_run_not_found");
  const run = parseRun(runSnapshot.data() ?? {});
  assertRequestMatchesRun(auth, data, run);

  if (run.status === "completed") return envelope(auth, run, true);
  if (run.status === "failed") {
    throw operationError(auth, "failed-precondition", run.failureReason || "reconciliation_run_failed");
  }

  const expectedRevision = requiredRevision(data.expectedRevision, auth);
  if (data.finalize === true) {
    return finalizeRun(auth, data, run, expectedRevision);
  }
  if (run.phase !== "scan" && run.phase !== "verify") {
    throw operationError(auth, "failed-precondition", "reconciliation_not_pageable");
  }

  const liveScope = await loadAliasScope(run.canonicalProgramId);
  if (liveScope.aliasHash !== run.aliasHash) {
    await failRun(auth, run, expectedRevision, "program_alias_scope_drift");
    throw operationError(auth, "failed-precondition", "program_alias_scope_drift");
  }

  return processPage(auth, run, liveScope, expectedRevision);
}

async function startRun(
  auth: AuthContext,
  data: Record<string, unknown>,
): Promise<SubmissionReviewCountReconciliationEnvelope> {
  const dryRun = data.dryRun !== false;
  const actual = data.actual === true;
  if ((dryRun && actual) || (!dryRun && !actual)) {
    throw operationError(auth, "failed-precondition", "actual_reconciliation_requires_dryRun_false_and_actual_true");
  }
  const pageSize = boundedPageSize(data.pageSize, auth);
  const requestedProgramId = asString(data.programId, SCP_CANONICAL_PROGRAM_ID);
  if (!requestedProgramId) throw operationError(auth, "invalid-argument", "program_identity_unresolved");
  const runId = asString(data.newRunId, `src-${randomUUID()}`);
  assertRunId(runId);
  const runRef = adminDb.collection(RUNS_COLLECTION).doc(runId);
  const nowIso = new Date().toISOString();

  const result = await adminDb.runTransaction(async (transaction) => {
    const aliasRegistry = await readConfirmedProgramAliasRegistryStateInTransaction(transaction);
    const scope = aliasScopeFromRegistry(requestedProgramId, aliasRegistry);
    const canonicalProgramId = scope.canonicalProgramId;
    const existing = await transaction.get(runRef);
    if (existing.exists) {
      const existingRun = parseRun(existing.data() ?? {});
      if (
        existingRun.canonicalProgramId !== canonicalProgramId
        || existingRun.dryRun !== dryRun
        || existingRun.actual !== actual
        || existingRun.pageSize !== pageSize
      ) {
        throw operationError(auth, "already-exists", "reconciliation_run_id_conflict");
      }
      return { run: existingRun, idempotent: true };
    }

    const aggregateRefs = scope.aliases.map((alias) => adminDb.collection(COUNTS_COLLECTION).doc(alias));
    const aggregateSnapshots = await Promise.all(aggregateRefs.map((ref) => transaction.get(ref)));
    const aggregateBaselines = Object.fromEntries(
      aggregateSnapshots.map((snapshot) => [snapshot.id, aggregateBaseline(snapshot)]),
    );
    const run: StoredRun = {
      schemaVersion: SUBMISSION_REVIEW_COUNT_RECONCILIATION_VERSION,
      runId,
      canonicalProgramId: scope.canonicalProgramId,
      aliases: scope.aliases,
      aliasMap: scope.aliasMap,
      aliasHash: scope.aliasHash,
      aliasRegistryRevision: scope.aliasRegistryRevision,
      resolverVersion: scope.resolverVersion,
      sourceCollection: SOURCE_COLLECTION,
      dryRun,
      actual,
      pageSize,
      status: "scanning",
      phase: "scan",
      revision: 0,
      scan: emptySubmissionReviewCountPass(),
      verify: emptySubmissionReviewCountPass(),
      aggregateBaselines,
      createdBy: auth.userId,
      createdByRole: auth.role,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      completedAtIso: null,
      failureReason: null,
      written: false,
      supersededLegacyAggregateIds: [],
      lastOperation: null,
    };
    transaction.create(runRef, {
      ...run,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(auditRef(runId, "start"), auditRecord(auth, run, "started", "start", nowIso));
    return { run, idempotent: false };
  });
  return envelope(auth, result.run, result.idempotent);
}

async function processPage(
  auth: AuthContext,
  run: StoredRun,
  scope: SubmissionReviewCountAliasScope,
  expectedRevision: number,
): Promise<SubmissionReviewCountReconciliationEnvelope> {
  const pass = run.phase === "scan" ? run.scan : run.verify;
  let query: FirebaseFirestore.Query = adminDb.collection(SOURCE_COLLECTION)
    .orderBy(FieldPath.documentId())
    .limit(run.pageSize + 1);
  if (pass.cursor) query = query.startAfter(pass.cursor);
  const snapshot = await query.get();
  const pageDocs = snapshot.docs.slice(0, run.pageSize);
  const hasMore = snapshot.docs.length > run.pageSize;
  let nextPass: SubmissionReviewCountPassState;
  try {
    nextPass = accumulateSubmissionReviewCountPage(
      pass,
      pageDocs.map((doc) => ({ id: doc.id, data: doc.data() ?? {} })),
      scope,
    );
  } catch (error) {
    const reason = safeReason(error, "submission_scope_or_status_drift");
    await failRun(auth, run, expectedRevision, reason);
    throw operationError(auth, "failed-precondition", reason);
  }
  if (!hasMore) nextPass = { ...nextPass, cursor: null };

  const operationKey = stableSubmissionReviewCountHash({
    runId: run.runId,
    phase: run.phase,
    expectedRevision,
    cursor: pass.cursor,
    pageSize: run.pageSize,
  });
  const nowIso = new Date().toISOString();
  const transactionResult = await adminDb.runTransaction(async (transaction) => {
    const runRef = adminDb.collection(RUNS_COLLECTION).doc(run.runId);
    const currentSnapshot = await transaction.get(runRef);
    if (!currentSnapshot.exists) throw operationError(auth, "not-found", "reconciliation_run_not_found");
    const current = parseRun(currentSnapshot.data() ?? {});
    if (current.revision !== expectedRevision) {
      if (current.lastOperation?.key === operationKey) return { run: current, idempotent: true };
      throw operationError(auth, "aborted", "reconciliation_revision_stale");
    }
    const currentPass = run.phase === "scan" ? current.scan : current.verify;
    if (
      current.status !== run.status
      || current.phase !== run.phase
      || current.aliasHash !== run.aliasHash
      || current.pageSize !== run.pageSize
      || currentPass.cursor !== pass.cursor
    ) {
      throw operationError(auth, "aborted", "reconciliation_scope_or_cursor_drift");
    }

    const nextRevision = current.revision + 1;
    const patch: Partial<StoredRun> = {
      revision: nextRevision,
      updatedAtIso: nowIso,
      lastOperation: {
        key: operationKey,
        expectedRevision,
        resultingRevision: nextRevision,
      },
    };
    let auditResult = "page_processed";
    if (run.phase === "scan") {
      patch.scan = nextPass;
      if (!hasMore) {
        patch.phase = "verify";
        patch.status = "verifying";
        patch.verify = emptySubmissionReviewCountPass();
        auditResult = "scan_completed";
      }
    } else {
      patch.verify = nextPass;
      if (!hasMore) {
        if (!submissionReviewCountPassesMatch(current.scan, nextPass)) {
          patch.phase = "failed";
          patch.status = "failed";
          patch.failureReason = "authoritative_submission_source_drift";
          auditResult = "source_drift_failed";
        } else if (current.dryRun) {
          patch.phase = "done";
          patch.status = "completed";
          patch.completedAtIso = nowIso;
          patch.written = false;
          auditResult = "dry_run_completed";
        } else {
          patch.phase = "ready";
          patch.status = "ready_to_finalize";
          auditResult = "verification_completed";
        }
      }
    }
    const next = parseRun({ ...current, ...patch });
    transaction.update(runRef, {
      ...patch,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(
      auditRef(run.runId, operationKey),
      auditRecord(auth, next, auditResult, operationKey, nowIso),
    );
    return { run: next, idempotent: false };
  });

  if (transactionResult.run.status === "failed") {
    throw operationError(auth, "failed-precondition", transactionResult.run.failureReason || "reconciliation_run_failed");
  }
  return envelope(auth, transactionResult.run, transactionResult.idempotent);
}

async function finalizeRun(
  auth: AuthContext,
  data: Record<string, unknown>,
  run: StoredRun,
  expectedRevision: number,
): Promise<SubmissionReviewCountReconciliationEnvelope> {
  if (run.dryRun || !run.actual || data.dryRun !== false || data.actual !== true) {
    throw operationError(auth, "failed-precondition", "finalize_requires_dryRun_false_and_actual_true");
  }
  if (run.phase !== "ready" || run.status !== "ready_to_finalize") {
    throw operationError(auth, "failed-precondition", "reconciliation_not_ready_to_finalize");
  }
  const nowIso = new Date().toISOString();
  const operationKey = stableSubmissionReviewCountHash({ runId: run.runId, operation: "finalize", expectedRevision });
  const result = await adminDb.runTransaction(async (transaction) => {
    const runRef = adminDb.collection(RUNS_COLLECTION).doc(run.runId);
    const currentSnapshot = await transaction.get(runRef);
    if (!currentSnapshot.exists) throw operationError(auth, "not-found", "reconciliation_run_not_found");
    const current = parseRun(currentSnapshot.data() ?? {});
    if (current.status === "completed") return { run: current, idempotent: true, drifted: false };
    if (current.revision !== expectedRevision) {
      if (current.lastOperation?.key === operationKey) return { run: current, idempotent: true, drifted: false };
      throw operationError(auth, "aborted", "reconciliation_revision_stale");
    }
    if (current.phase !== "ready" || current.status !== "ready_to_finalize") {
      throw operationError(auth, "failed-precondition", "reconciliation_not_ready_to_finalize");
    }

    let liveScope: SubmissionReviewCountAliasScope;
    try {
      const aliasRegistry = await readConfirmedProgramAliasRegistryStateInTransaction(transaction);
      liveScope = aliasScopeFromRegistry(current.canonicalProgramId, aliasRegistry);
    } catch {
      return failFinalizationTransaction(transaction, auth, current, operationKey, nowIso, "program_alias_scope_drift");
    }
    if (liveScope.aliasHash !== current.aliasHash) {
      return failFinalizationTransaction(transaction, auth, current, operationKey, nowIso, "program_alias_scope_drift");
    }

    const aggregateRefs = current.aliases.map((alias) => adminDb.collection(COUNTS_COLLECTION).doc(alias));
    const aggregateSnapshots = await Promise.all(aggregateRefs.map((ref) => transaction.get(ref)));
    const aggregateDrift = aggregateSnapshots.some((snapshot) => {
      const baseline = current.aggregateBaselines[snapshot.id];
      return !baseline || aggregateBaseline(snapshot).fingerprint !== baseline.fingerprint;
    });
    if (aggregateDrift) {
      return failFinalizationTransaction(transaction, auth, current, operationKey, nowIso, "aggregate_cas_drift");
    }

    const canonicalRef = adminDb.collection(COUNTS_COLLECTION).doc(current.canonicalProgramId);
    const legacySnapshots = aggregateSnapshots.filter((snapshot) => snapshot.id !== current.canonicalProgramId && snapshot.exists);
    const nextRevision = current.revision + 1;
    const next: StoredRun = parseRun({
      ...current,
      phase: "done",
      status: "completed",
      revision: nextRevision,
      written: true,
      completedAtIso: nowIso,
      updatedAtIso: nowIso,
      failureReason: null,
      supersededLegacyAggregateIds: legacySnapshots.map((snapshot) => snapshot.id).sort(),
      lastOperation: { key: operationKey, expectedRevision, resultingRevision: nextRevision },
    });
    transaction.set(canonicalRef, {
      id: current.canonicalProgramId,
      programId: current.canonicalProgramId,
      canonicalProgramId: current.canonicalProgramId,
      statuses: current.scan.counts.statuses,
      payments: current.scan.counts.payments,
      totalSubmissions: current.scan.matchedRows,
      reconciliation: {
        runId: current.runId,
        schemaVersion: SUBMISSION_REVIEW_COUNT_RECONCILIATION_VERSION,
        sourceCollection: SOURCE_COLLECTION,
        sourceFingerprint: current.scan.fingerprint,
        aliases: current.aliases,
        aliasRegistryRevision: current.aliasRegistryRevision,
        completedAtIso: nowIso,
      },
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    });
    for (const legacySnapshot of legacySnapshots) {
      transaction.set(legacySnapshot.ref, {
        superseded: true,
        supersededBy: canonicalRef.path,
        supersededByRunId: current.runId,
        supersededAtIso: nowIso,
        supersededAt: FieldValue.serverTimestamp(),
        reconciliationStatus: "superseded",
        legacyCountsPreserved: true,
      }, { merge: true });
    }
    transaction.update(runRef, {
      phase: next.phase,
      status: next.status,
      revision: next.revision,
      written: true,
      completedAtIso: nowIso,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
      failureReason: null,
      supersededLegacyAggregateIds: next.supersededLegacyAggregateIds,
      lastOperation: next.lastOperation,
    });
    transaction.create(
      auditRef(current.runId, operationKey),
      auditRecord(auth, next, "finalized", operationKey, nowIso),
    );
    return { run: next, idempotent: false, drifted: false };
  });
  if (result.drifted || result.run.status === "failed") {
    throw operationError(auth, "failed-precondition", result.run.failureReason || "reconciliation_finalization_failed");
  }
  return envelope(auth, result.run, result.idempotent);
}

function failFinalizationTransaction(
  transaction: FirebaseFirestore.Transaction,
  auth: AuthContext,
  current: StoredRun,
  operationKey: string,
  nowIso: string,
  reason: string,
) {
  const nextRevision = current.revision + 1;
  const failed = parseRun({
    ...current,
    phase: "failed",
    status: "failed",
    revision: nextRevision,
    failureReason: reason,
    updatedAtIso: nowIso,
    lastOperation: { key: operationKey, expectedRevision: current.revision, resultingRevision: nextRevision },
  });
  transaction.update(adminDb.collection(RUNS_COLLECTION).doc(current.runId), {
    phase: failed.phase,
    status: failed.status,
    revision: failed.revision,
    failureReason: failed.failureReason,
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
    lastOperation: failed.lastOperation,
  });
  transaction.create(
    auditRef(current.runId, operationKey),
    auditRecord(auth, failed, "finalization_failed", operationKey, nowIso),
  );
  return { run: failed, idempotent: false, drifted: true };
}

async function failRun(
  auth: AuthContext,
  run: StoredRun,
  expectedRevision: number,
  reason: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const operationKey = stableSubmissionReviewCountHash({ runId: run.runId, operation: "fail", expectedRevision, reason });
  await adminDb.runTransaction(async (transaction) => {
    const runRef = adminDb.collection(RUNS_COLLECTION).doc(run.runId);
    const snapshot = await transaction.get(runRef);
    if (!snapshot.exists) return;
    const current = parseRun(snapshot.data() ?? {});
    if (current.status === "failed" || current.status === "completed") return;
    if (current.revision !== expectedRevision) {
      throw operationError(auth, "aborted", "reconciliation_revision_stale");
    }
    const nextRevision = current.revision + 1;
    const failed = parseRun({
      ...current,
      phase: "failed",
      status: "failed",
      revision: nextRevision,
      failureReason: reason,
      updatedAtIso: nowIso,
      lastOperation: { key: operationKey, expectedRevision, resultingRevision: nextRevision },
    });
    transaction.update(runRef, {
      phase: failed.phase,
      status: failed.status,
      revision: failed.revision,
      failureReason: reason,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
      lastOperation: failed.lastOperation,
    });
    transaction.create(
      auditRef(run.runId, operationKey),
      auditRecord(auth, failed, "failed", operationKey, nowIso),
    );
  });
}

async function loadAliasScope(canonicalProgramId: string): Promise<SubmissionReviewCountAliasScope> {
  const aliasRegistry = await readConfirmedProgramAliasRegistryState({ bypassCache: true });
  return aliasScopeFromRegistry(canonicalProgramId, aliasRegistry);
}

function aliasScopeFromRegistry(
  rawProgramId: string,
  aliasRegistry: ConfirmedProgramAliasRegistryState,
): SubmissionReviewCountAliasScope {
  const scope = confirmedProgramScope(rawProgramId, aliasRegistry, SUBMISSION_REVIEW_COUNT_ALIAS_LIMIT);
  return buildSubmissionReviewCountAliasScope(scope, aliasRegistry.aliasMap);
}

function aggregateBaseline(snapshot: DocumentSnapshot): AggregateBaseline {
  const updateToken = snapshotUpdateToken(snapshot);
  const exists = snapshot.exists;
  const data = exists ? snapshot.data() ?? {} : null;
  return {
    exists,
    updateToken,
    fingerprint: aggregateDocumentFingerprint({ exists, data, updateToken }),
  };
}

function snapshotUpdateToken(snapshot: DocumentSnapshot): string | null {
  const updateTime = snapshot.updateTime;
  return updateTime ? `${updateTime.seconds}:${updateTime.nanoseconds}` : null;
}

function parseRun(value: Record<string, unknown>): StoredRun {
  const run = value as unknown as StoredRun;
  const validPhase = run.phase === "scan" || run.phase === "verify" || run.phase === "ready" || run.phase === "done" || run.phase === "failed";
  const validStatus = run.status === "scanning" || run.status === "verifying" || run.status === "ready_to_finalize" || run.status === "completed" || run.status === "failed";
  const phaseStatusPairValid = (run.phase === "scan" && run.status === "scanning")
    || (run.phase === "verify" && run.status === "verifying")
    || (run.phase === "ready" && run.status === "ready_to_finalize")
    || (run.phase === "done" && run.status === "completed")
    || (run.phase === "failed" && run.status === "failed");
  const aliasesValid = Array.isArray(run.aliases)
    && run.aliases.length > 0
    && run.aliases.length <= SUBMISSION_REVIEW_COUNT_ALIAS_LIMIT
    && run.aliases.every((alias) => typeof alias === "string" && alias.length > 0)
    && run.aliases.every((alias) => run.aliasMap?.[alias] === run.canonicalProgramId)
    && /^[a-f0-9]{64}$/.test(run.aliasRegistryRevision)
    && run.aliasHash === stableSubmissionReviewCountHash({
      canonicalProgramId: run.canonicalProgramId,
      aliases: run.aliases,
      aliasRegistryRevision: run.aliasRegistryRevision,
      resolverVersion: run.resolverVersion,
    });
  const baselinesValid = run.aggregateBaselines
    && typeof run.aggregateBaselines === "object"
    && run.aliases?.every((alias) => validAggregateBaseline(run.aggregateBaselines[alias]));
  if (
    run.schemaVersion !== SUBMISSION_REVIEW_COUNT_RECONCILIATION_VERSION
    || !run.runId
    || !run.canonicalProgramId
    || !aliasesValid
    || !run.aliasMap
    || !run.aliasHash
    || !run.aliasRegistryRevision
    || run.sourceCollection !== SOURCE_COLLECTION
    || typeof run.dryRun !== "boolean"
    || typeof run.actual !== "boolean"
    || run.dryRun === run.actual
    || !Number.isInteger(run.pageSize)
    || run.pageSize < 1
    || run.pageSize > SUBMISSION_REVIEW_COUNT_PAGE_SIZE_MAX
    || !Number.isInteger(run.revision)
    || run.revision < 0
    || !validPhase
    || !validStatus
    || !phaseStatusPairValid
    || !validPass(run.scan)
    || !validPass(run.verify)
    || !baselinesValid
  ) {
    throw Object.assign(new Error("reconciliation_run_state_invalid"), { code: "failed-precondition", errorCode: "parse_run_reconciliation_run_state_invalid" });
  }
  return run;
}

function validPass(value: SubmissionReviewCountPassState): boolean {
  if (!value || typeof value !== "object") return false;
  const numbers = [value.scannedRows, value.matchedRows, value.unscopedRows, value.otherProgramRows];
  const countNumbers = [
    value.counts?.statuses?.pending,
    value.counts?.statuses?.approved,
    value.counts?.statuses?.rejected,
    value.counts?.statuses?.needs_review,
    value.counts?.payments?.not_payable,
    value.counts?.payments?.payable,
    value.counts?.payments?.paid,
    value.counts?.payments?.hold,
  ];
  const statusTotal = countNumbers.slice(0, 4).reduce((sum, entry) => sum + Number(entry), 0);
  const paymentTotal = countNumbers.slice(4).reduce((sum, entry) => sum + Number(entry), 0);
  return numbers.concat(countNumbers).every((entry) => Number.isInteger(entry) && Number(entry) >= 0)
    && value.scannedRows === value.matchedRows + value.unscopedRows + value.otherProgramRows
    && statusTotal === value.matchedRows
    && paymentTotal === value.matchedRows
    && (value.cursor === null || typeof value.cursor === "string")
    && typeof value.fingerprint === "string"
    && /^[a-f0-9]{64}$/.test(value.fingerprint);
}

function validAggregateBaseline(value: AggregateBaseline | undefined): boolean {
  return Boolean(value)
    && typeof value!.exists === "boolean"
    && (value!.updateToken === null || typeof value!.updateToken === "string")
    && typeof value!.fingerprint === "string"
    && /^[a-f0-9]{64}$/.test(value!.fingerprint);
}

function assertRequestMatchesRun(
  auth: AuthContext,
  data: Record<string, unknown>,
  run: StoredRun,
) {
  if (data.dryRun !== undefined && data.dryRun !== run.dryRun) {
    throw operationError(auth, "failed-precondition", "reconciliation_mode_drift");
  }
  if (data.actual !== undefined && data.actual !== run.actual) {
    throw operationError(auth, "failed-precondition", "reconciliation_mode_drift");
  }
  if (data.pageSize !== undefined && boundedPageSize(data.pageSize, auth) !== run.pageSize) {
    throw operationError(auth, "failed-precondition", "reconciliation_page_size_drift");
  }
  const requestedProgramId = asString(data.programId);
  if (requestedProgramId && resolveCanonicalProgramId(requestedProgramId, run.aliasMap) !== run.canonicalProgramId) {
    throw operationError(auth, "failed-precondition", "reconciliation_program_scope_drift");
  }
}

function boundedPageSize(value: unknown, auth: AuthContext): number {
  if (value === undefined || value === null || value === "") return SUBMISSION_REVIEW_COUNT_PAGE_SIZE_DEFAULT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > SUBMISSION_REVIEW_COUNT_PAGE_SIZE_MAX) {
    throw operationError(auth, "invalid-argument", `pageSize_must_be_1_to_${SUBMISSION_REVIEW_COUNT_PAGE_SIZE_MAX}`);
  }
  return value;
}

function requiredRevision(value: unknown, auth: AuthContext): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw operationError(auth, "invalid-argument", "expectedRevision_required");
  }
  return value;
}

function assertRunId(runId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(runId)) {
    throw Object.assign(new Error("invalid_reconciliation_run_id"), { code: "invalid-argument", errorCode: "assert_run_id_invalid_reconciliation_run_id" });
  }
}

function auditRef(runId: string, operationKey: string) {
  const suffix = stableSubmissionReviewCountHash(operationKey).slice(0, 24);
  return adminDb.collection(AUDITS_COLLECTION).doc(`${runId}_${suffix}`);
}

function auditRecord(
  auth: AuthContext,
  run: StoredRun,
  result: string,
  operationKey: string,
  nowIso: string,
) {
  return {
    action: ACTION,
    runId: run.runId,
    canonicalProgramId: run.canonicalProgramId,
    aliases: run.aliases,
    aliasRegistryRevision: run.aliasRegistryRevision,
    dryRun: run.dryRun,
    actual: run.actual,
    phase: run.phase,
    status: run.status,
    revision: run.revision,
    result,
    operationKey,
    actorUid: auth.userId,
    actorRole: auth.role,
    matchedRows: run.phase === "scan" ? run.scan.matchedRows : run.verify.matchedRows,
    createdAtIso: nowIso,
    createdAt: FieldValue.serverTimestamp(),
  };
}

function envelope(
  auth: AuthContext,
  run: StoredRun,
  idempotent: boolean,
): SubmissionReviewCountReconciliationEnvelope {
  const counts = run.status === "completed" || run.status === "ready_to_finalize"
    ? run.scan.counts
    : null;
  return {
    ok: true,
    runId: run.runId,
    dryRun: run.dryRun,
    actual: run.actual,
    written: run.written === true,
    idempotent,
    canonicalProgramId: run.canonicalProgramId,
    aliases: run.aliases,
    status: run.status,
    phase: run.phase,
    revision: run.revision,
    nextExpectedRevision: run.status === "completed" || run.status === "failed" ? null : run.revision,
    progress: {
      scan: progress(run.scan),
      verify: progress(run.verify),
    },
    counts,
    failureReason: run.failureReason ?? null,
    behaviorLog: makeBehaviorLog(auth, ACTION, "success", run.canonicalProgramId),
  };
}

function progress(pass: SubmissionReviewCountPassState) {
  return {
    scannedRows: pass.scannedRows,
    matchedRows: pass.matchedRows,
    unscopedRows: pass.unscopedRows,
    otherProgramRows: pass.otherProgramRows,
    cursor: pass.cursor,
  };
}

function operationError(auth: AuthContext, code: string, reason: string): Error {
  return Object.assign(new Error(reason), {
    code,
    reasonCode: reason,
    behaviorLog: makeBehaviorLog(auth, ACTION, "denied", auth.gameId),
  });
}

function safeReason(error: unknown, fallback: string): string {
  const reason = error && typeof error === "object" && "reasonCode" in error
    ? asString((error as { reasonCode?: unknown }).reasonCode)
    : "";
  return reason && /^[a-z0-9_:-]{1,160}$/.test(reason) ? reason : fallback;
}
