import { createHash, randomBytes } from "node:crypto";
import {
  FieldValue,
  type DocumentReference,
  type DocumentSnapshot,
  type Query,
  type QuerySnapshot,
  type Transaction,
} from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  knownSheetSourceProfileBySourceId,
  resolveSheetIntakeWriteGate,
  type SheetSourceProfile,
} from "./sheetIntakeRuntime";
import { evaluateSheetCutoverTransition } from "./sheetIntakeCutoverPolicy";
import type {
  SheetCutoverRecord,
  SheetCutoverState,
  SheetProjectionStrategy,
  SheetSourceDomain,
} from "./sheetIntakeTypes";
import { asRecord, asString } from "./shared";
import {
  canonicalScpSheetRowsFingerprint,
  SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD,
  type ScpSheetDatasetKey,
} from "./scpSheetPublicProjection";
import {
  readScpQualificationReviewRows,
  readScpVideoReviewSheetRows,
} from "./scpSheetReviewService";
import { syncSheetIntake } from "./sheetIntakeService";
import {
  publicProjectionReady,
  sheetSourceOperationalCapabilities,
} from "./sheetIntakeStatus";

const PREVIEW_CLAIMS_COLLECTION = "sheet_intake_preview_claims";
const AUDITS_COLLECTION = "sheet_intake_operation_audits";
const RECONCILIATION_RUNS_COLLECTION = "sheet_reconciliation_runs";
const RECONCILIATION_TOKEN_VERSION = "sheet-reconcile-v1";
const CUTOVER_TOKEN_VERSION = "sheet-cutover-v1";
const PREVIEW_TTL_MS = 10 * 60 * 1000;

export interface SheetReconciliationCounts {
  missing: number;
  extra: number;
  stale: number;
  conflict: number;
  activeCurrent: number;
  rowMoved: number;
}

type ControlActor = {
  requestedBy: string;
  requestedRole?: string;
  requestedTeam?: string;
};

type SourceContext = {
  sourceId: string;
  spreadsheetId: string;
  domain: SheetSourceDomain;
  projectionStrategy: SheetProjectionStrategy;
  profile: SheetSourceProfile | null;
  sourceRef: DocumentReference;
  sourceSnapshot: DocumentSnapshot;
};

type ReconciliationPlan = {
  counts: SheetReconciliationCounts;
  fingerprint: string;
  observedRows: number;
  parityEligible: boolean;
  reviewedSheetSnapshot: ReviewedSheetSnapshot | null;
};

export type ReviewedSheetSnapshot = {
  schemaVersion: "reviewed-sheet-snapshot-v1";
  sourceKey: SheetSourceProfile["key"];
  sourceId: string;
  spreadsheetIdHash: string;
  datasetKey: ScpSheetDatasetKey | null;
  rowCount: number;
  canonicalFingerprint: string;
};

type SheetIntakeControlDependencies = {
  readReviewedSheetSnapshot?: (
    context: Readonly<SourceContext>,
  ) => Promise<ReviewedSheetSnapshot | null>;
  afterPrepare?: () => Promise<void>;
  nowMs?: () => number;
};

type ControlReader = {
  getQuery(query: Query): Promise<QuerySnapshot>;
};

type ReconciliationInput = ControlActor & {
  sourceId: string;
  expectedVersion: number;
  dryRun?: boolean;
  actual?: boolean;
  previewToken?: string;
  confirmation?: string;
};

type CutoverInput = ControlActor & {
  sourceId: string;
  expectedVersion: number;
  targetState: SheetCutoverState;
  targetExitAt?: string | null;
  rollbackCheckpoint?: SheetCutoverState | null;
  dryRun?: boolean;
  actual?: boolean;
  previewToken?: string;
  confirmation?: string;
};

export async function reconcileSheetIntakeSource(
  input: ReconciliationInput,
  dependencies: SheetIntakeControlDependencies = {},
) {
  const dryRun = input.dryRun !== false;
  assertActualFlag(dryRun, input.actual);
  const expectedVersion = nonNegativeInteger(input.expectedVersion, "expectedVersion");
  const nowMs = effectiveNowMs(dependencies);
  const nowIso = new Date(nowMs).toISOString();
  assertGenericControlOperationSupported(
    knownSheetSourceProfileBySourceId(input.sourceId),
    "reconcile",
  );
  const context = await resolveSourceContext(input.sourceId, "reconcile");
  const confirmation = reconciliationConfirmation(context, expectedVersion);

  if (dryRun) {
    const sourceSnapshot = context.sourceSnapshot;
    const currentVersion = nonNegativeIntegerOrZero(sourceSnapshot.get("reconciliationVersion"));
    if (currentVersion !== expectedVersion) throw versionMismatch("reconciliation", expectedVersion, currentVersion);
    const projectionRevision = nonNegativeIntegerOrZero(sourceSnapshot.get("projectionRevision"));
    const reviewedSheetSnapshot = await readCurrentReviewedSheetSnapshot(context, dependencies);
    const plan = await buildReconciliationPlan(
      directReader(),
      context,
      sourceSnapshot,
      reviewedSheetSnapshot,
    );
    const previewToken = capabilityToken(RECONCILIATION_TOKEN_VERSION);
    const claimRef = claimDocument(previewToken);
    const expiresAtIso = new Date(nowMs + PREVIEW_TTL_MS).toISOString();
    await claimRef.create({
      schemaVersion: "sheet-intake-reconciliation-preview-v1",
      tokenVersion: RECONCILIATION_TOKEN_VERSION,
      operation: "reconcile",
      status: "pending",
      actorHash: actorHash(input),
      sourceId: context.sourceId,
      spreadsheetIdHash: hashHex(context.spreadsheetId, 32),
      projectionStrategy: context.projectionStrategy,
      expectedVersion,
      projectionRevision,
      planFingerprint: plan.fingerprint,
      confirmationFingerprint: hashHex(confirmation, 64),
      counts: plan.counts,
      observedRows: plan.observedRows,
      parityEligible: plan.parityEligible,
      reviewedSheetSnapshot: plan.reviewedSheetSnapshot,
      issuedAtIso: nowIso,
      expiresAtIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    return {
      sourceId: context.sourceId,
      runId: "preview",
      mode: "preview" as const,
      counts: plan.counts,
      observedRows: plan.observedRows,
      parityEligible: plan.parityEligible,
      masked: true as const,
      previewToken,
      previewExpiresAtIso: expiresAtIso,
      confirmation,
      businessWritesApplied: false,
      idempotentReplay: false,
    };
  }

  assertExactConfirmation(input.confirmation, confirmation);
  const previewToken = requiredCapability(input.previewToken, RECONCILIATION_TOKEN_VERSION);
  const claimRef = claimDocument(previewToken);
  const runId = `sheet-reconcile-${hashHex(previewToken, 40)}`;
  const runRef = adminDb.collection(RECONCILIATION_RUNS_COLLECTION).doc(runId);
  const auditRef = adminDb.collection(AUDITS_COLLECTION).doc(runId);
  const preflightClaim = validateClaim({
    snapshot: await claimRef.get(),
    tokenVersion: RECONCILIATION_TOKEN_VERSION,
    operation: "reconcile",
    actor: input,
    sourceId: context.sourceId,
    nowMs,
  });
  assertClaimInteger(preflightClaim, "expectedVersion", expectedVersion);
  if (asString(preflightClaim.confirmationFingerprint) !== hashHex(confirmation, 64)) {
    throw previewMismatch();
  }
  if (asString(preflightClaim.projectionStrategy) !== context.projectionStrategy) {
    throw previewMismatch();
  }
  if (asString(preflightClaim.status) === "completed") {
    return {
      sourceId: context.sourceId,
      runId,
      mode: "actual" as const,
      counts: reconciliationCounts(preflightClaim.counts),
      masked: true as const,
      businessWritesApplied: false,
      idempotentReplay: true,
      auditRef: auditRef.path,
    };
  }
  const claimedReviewedSheetSnapshot = reviewedSheetSnapshotFromClaim(
    context,
    preflightClaim.reviewedSheetSnapshot,
  );
  const prepared = await adminDb.runTransaction(async (tx) => {
    const claimSnapshot = await tx.get(claimRef);
    const claim = validateClaim({
      snapshot: claimSnapshot,
      tokenVersion: RECONCILIATION_TOKEN_VERSION,
      operation: "reconcile",
      actor: input,
      sourceId: context.sourceId,
      nowMs,
    });
    assertClaimInteger(claim, "expectedVersion", expectedVersion);
    if (asString(claim.confirmationFingerprint) !== hashHex(confirmation, 64)) {
      throw previewMismatch();
    }
    if (asString(claim.projectionStrategy) !== context.projectionStrategy) {
      throw previewMismatch();
    }
    if (asString(claim.status) === "completed") {
      return { kind: "replay" as const, counts: reconciliationCounts(claim.counts) };
    }
    if (asString(claim.status) === "verifying") {
      return {
        kind: "resume" as const,
        counts: reconciliationCounts(claim.counts),
      };
    }
    assertReviewedSheetSnapshotMatch(
      claim.reviewedSheetSnapshot,
      claimedReviewedSheetSnapshot,
    );
    const currentSource = await tx.get(context.sourceRef);
    const actualVersion = nonNegativeIntegerOrZero(currentSource.get("reconciliationVersion"));
    if (actualVersion !== expectedVersion) {
      return { kind: "version_mismatch" as const, actualVersion };
    }
    const currentProjectionRevision = nonNegativeIntegerOrZero(currentSource.get("projectionRevision"));
    if (currentProjectionRevision !== nonNegativeIntegerOrZero(claim.projectionRevision)) {
      return { kind: "drift" as const };
    }
    const transactionPlan = await buildReconciliationPlan(
      transactionReader(tx),
      context,
      currentSource,
      claimedReviewedSheetSnapshot,
    );
    if (transactionPlan.fingerprint !== asString(claim.planFingerprint)) {
      return { kind: "drift" as const };
    }

    const nextVersion = actualVersion + 1;
    const runRecord = {
      schemaVersion: "sheet-intake-reconciliation-run-v1",
      id: runId,
      status: "verifying",
      sourceId: context.sourceId,
      spreadsheetIdHash: hashHex(context.spreadsheetId, 32),
      domain: context.domain,
      projectionStrategy: context.projectionStrategy,
      reconciliationVersion: nextVersion,
      projectionRevision: currentProjectionRevision,
      counts: transactionPlan.counts,
      observedRows: transactionPlan.observedRows,
      parityEligible: transactionPlan.parityEligible,
      planFingerprint: transactionPlan.fingerprint,
      reviewedSheetSnapshot: transactionPlan.reviewedSheetSnapshot,
      masked: true,
      requestedByHash: actorHash(input),
      reconciledAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.set(runRef, runRecord);
    tx.set(auditRef, {
      id: auditRef.id,
      operation: "reconcile",
      sourceId: context.sourceId,
      result: "verifying",
      fromVersion: actualVersion,
      toVersion: nextVersion,
      planFingerprint: transactionPlan.fingerprint,
      reviewedSheetSnapshot: transactionPlan.reviewedSheetSnapshot,
      requestedByHash: actorHash(input),
      requestedRole: cleanRole(input.requestedRole),
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(claimRef, {
      status: "verifying",
      runRef: runRef.path,
      auditRef: auditRef.path,
      counts: transactionPlan.counts,
      nextVersion,
      preparedSourceVersion: nonNegativeIntegerOrZero(currentSource.get("sourceVersion")),
      preparedReconciliationVersion: actualVersion,
      preparedProjectionRevision: currentProjectionRevision,
      preparedLastReconciliationRef:
        asString(currentSource.get("lastReconciliationRef")) || null,
      preparedCutover: parseCutoverRecord(currentSource.get("cutover"), nowIso),
      verificationStartedAtIso: nowIso,
      verificationStartedAt: FieldValue.serverTimestamp(),
    });
    return { kind: "prepared" as const, counts: transactionPlan.counts };
  });

  if (prepared.kind === "version_mismatch") {
    throw versionMismatch("reconciliation", expectedVersion, prepared.actualVersion);
  }
  if (prepared.kind === "drift") {
    throw failedPrecondition(
      "Sheet reconciliation preview drifted because the source changed; run preview again.",
    );
  }
  if (prepared.kind === "replay") {
    return {
      sourceId: context.sourceId,
      runId,
      mode: "actual" as const,
      counts: prepared.counts,
      masked: true as const,
      businessWritesApplied: false,
      idempotentReplay: true,
      auditRef: auditRef.path,
    };
  }

  await dependencies.afterPrepare?.();
  let verifiedSheetSnapshot: ReviewedSheetSnapshot | null;
  try {
    verifiedSheetSnapshot = await readCurrentReviewedSheetSnapshot(
      context,
      dependencies,
    );
    assertReviewedSheetSnapshotMatch(
      preflightClaim.reviewedSheetSnapshot,
      verifiedSheetSnapshot,
    );
  } catch {
    const failure = await failPreparedSheetControlOperation({
      claimRef,
      auditRef,
      runRef,
      failureCode: "reviewed_sheet_verification_failed",
      nowIso,
    });
    if (failure === "completed") {
      const completedClaim = asRecord((await claimRef.get()).data());
      return {
        sourceId: context.sourceId,
        runId,
        mode: "actual" as const,
        counts: reconciliationCounts(completedClaim.counts),
        masked: true as const,
        businessWritesApplied: false,
        idempotentReplay: true,
        auditRef: auditRef.path,
      };
    }
    throw failedPrecondition(
      "Reviewed Google Sheet changed or could not be verified after prepare; source state was not changed.",
    );
  }
  const committed = await adminDb.runTransaction(async (tx) => {
    const claimSnapshot = await tx.get(claimRef);
    const claim = validateClaim({
      snapshot: claimSnapshot,
      tokenVersion: RECONCILIATION_TOKEN_VERSION,
      operation: "reconcile",
      actor: input,
      sourceId: context.sourceId,
      nowMs,
    });
    if (asString(claim.status) === "completed") {
      return { kind: "replay" as const, counts: reconciliationCounts(claim.counts) };
    }
    if (asString(claim.status) !== "verifying") {
      return { kind: "drift" as const };
    }
    const currentSource = await tx.get(context.sourceRef);
    let nextVersion = -1;
    try {
      const currentCutover = parseCutoverRecord(currentSource.get("cutover"), nowIso);
      const preparedCutover = parseCutoverRecord(claim.preparedCutover, nowIso);
      if (
        nonNegativeIntegerOrZero(currentSource.get("reconciliationVersion")) !==
          nonNegativeIntegerOrZero(claim.preparedReconciliationVersion) ||
        nonNegativeIntegerOrZero(currentSource.get("sourceVersion")) !==
          nonNegativeIntegerOrZero(claim.preparedSourceVersion) ||
        nonNegativeIntegerOrZero(currentSource.get("projectionRevision")) !==
          nonNegativeIntegerOrZero(claim.preparedProjectionRevision) ||
        asString(currentSource.get("lastReconciliationRef")) !==
          asString(claim.preparedLastReconciliationRef) ||
        !cutoverRecordsEqual(currentCutover, preparedCutover)
      ) {
        return { kind: "drift" as const };
      }
      const verificationPlan = await buildReconciliationPlan(
        transactionReader(tx),
        context,
        currentSource,
        verifiedSheetSnapshot,
      );
      if (verificationPlan.fingerprint !== asString(claim.planFingerprint)) {
        return { kind: "drift" as const };
      }
      nextVersion = nonNegativeIntegerOrZero(claim.preparedReconciliationVersion) + 1;
      if (nextVersion !== nonNegativeIntegerOrZero(claim.nextVersion)) {
        return { kind: "drift" as const };
      }
    } catch (error) {
      if (isFailedPreconditionError(error)) return { kind: "drift" as const };
      throw error;
    }
    tx.set(context.sourceRef, {
      ...(currentSource.exists ? {} : sourceBootstrap(context, nowIso)),
      reconciliationVersion: nextVersion,
      lastReconciliationRef: runRef.path,
      lastReconciledAtIso: nowIso,
      updatedAtIso: nowIso,
      updatedBy: input.requestedBy,
      updatedAt: FieldValue.serverTimestamp(),
      ...(currentSource.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    }, { merge: true });
    tx.update(runRef, {
      status: "applied",
      sourceVerifiedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(auditRef, {
      result: "success",
      sourceVerifiedAtIso: nowIso,
      sourceVerifiedAt: FieldValue.serverTimestamp(),
    });
    tx.update(claimRef, {
      status: "completed",
      completedAtIso: nowIso,
      completedAt: FieldValue.serverTimestamp(),
    });
    return { kind: "applied" as const, counts: reconciliationCounts(claim.counts) };
  });
  if (committed.kind === "drift") {
    const failure = await failPreparedSheetControlOperation({
      claimRef,
      auditRef,
      runRef,
      failureCode: "source_drift_before_commit",
      nowIso,
    });
    if (failure === "completed") {
      const completedClaim = asRecord((await claimRef.get()).data());
      return {
        sourceId: context.sourceId,
        runId,
        mode: "actual" as const,
        counts: reconciliationCounts(completedClaim.counts),
        masked: true as const,
        businessWritesApplied: false,
        idempotentReplay: true,
        auditRef: auditRef.path,
      };
    }
    throw failedPrecondition(
      "Sheet reconciliation source changed before the authoritative commit; source state was not changed.",
    );
  }
  return {
    sourceId: context.sourceId,
    runId,
    mode: "actual" as const,
    counts: committed.counts,
    masked: true as const,
    businessWritesApplied: committed.kind === "applied",
    idempotentReplay: committed.kind === "replay",
    auditRef: auditRef.path,
  };
}

export async function updateSheetIntakeCutoverState(
  input: CutoverInput,
  dependencies: SheetIntakeControlDependencies = {},
) {
  const dryRun = input.dryRun !== false;
  assertActualFlag(dryRun, input.actual);
  const expectedVersion = nonNegativeInteger(input.expectedVersion, "expectedVersion");
  const targetState = parseCutoverState(input.targetState);
  if (!targetState) throw failedPrecondition("invalid cutover state");
  const nowMs = effectiveNowMs(dependencies);
  const nowIso = new Date(nowMs).toISOString();
  assertGenericControlOperationSupported(
    knownSheetSourceProfileBySourceId(input.sourceId),
    "cutover",
    targetState,
  );
  const context = await resolveSourceContext(input.sourceId, "cutover");
  const confirmation = cutoverConfirmation(context, expectedVersion, targetState);
  const requestedCheckpoint = parseOptionalCutoverState(input.rollbackCheckpoint);
  const requestedTargetExitAt = normalizedOptionalIso(input.targetExitAt);

  if (dryRun) {
    const sourceSnapshot = context.sourceSnapshot;
    const current = parseCutoverRecord(sourceSnapshot.get("cutover"), nowIso);
    if (current.version !== expectedVersion) throw versionMismatch("cutover", expectedVersion, current.version);
    const transition = evaluateSheetCutoverTransition({
      current,
      targetState,
      requestedCheckpoint,
      requestedTargetExitAt,
      nowMs,
    });
    const reviewedSheetSnapshot = await readCurrentReviewedSheetSnapshot(context, dependencies);
    const plan = await buildReconciliationPlan(
      directReader(),
      context,
      sourceSnapshot,
      reviewedSheetSnapshot,
    );
    const reconciliation = await readLatestReconciliation(sourceSnapshot);
    assertCutoverEvidence({
      context,
      current,
      targetState,
      isRollback: transition.isRollback,
      plan,
      reconciliation,
      sourceSnapshot,
      nowMs,
    });
    const transitionFingerprint = cutoverFingerprint({
      current,
      targetState,
      checkpoint: transition.rollbackCheckpoint,
      targetExitAt: transition.targetExitAt,
      projectionRevision: nonNegativeIntegerOrZero(sourceSnapshot.get("projectionRevision")),
      reconciliation,
      plan,
      sourceSnapshot,
    });
    const previewToken = capabilityToken(CUTOVER_TOKEN_VERSION);
    const claimRef = claimDocument(previewToken);
    const expiresAtIso = new Date(nowMs + PREVIEW_TTL_MS).toISOString();
    await claimRef.create({
      schemaVersion: "sheet-intake-cutover-preview-v1",
      tokenVersion: CUTOVER_TOKEN_VERSION,
      operation: "cutover",
      status: "pending",
      actorHash: actorHash(input),
      sourceId: context.sourceId,
      spreadsheetIdHash: hashHex(context.spreadsheetId, 32),
      expectedVersion,
      targetState,
      checkpoint: transition.rollbackCheckpoint,
      targetExitAt: transition.targetExitAt,
      isRollback: transition.isRollback,
      transitionFingerprint,
      reviewedSheetSnapshot: plan.reviewedSheetSnapshot,
      projectionRevision: nonNegativeIntegerOrZero(sourceSnapshot.get("projectionRevision")),
      sourceVersion: nonNegativeIntegerOrZero(sourceSnapshot.get("sourceVersion")),
      lastReconciliationRef: asString(sourceSnapshot.get("lastReconciliationRef")) || null,
      confirmationFingerprint: hashHex(confirmation, 64),
      issuedAtIso: nowIso,
      expiresAtIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    return {
      sourceId: context.sourceId,
      mode: "preview" as const,
      current,
      targetState,
      planned: {
        rollbackCheckpoint: transition.rollbackCheckpoint,
        targetExitAt: transition.targetExitAt,
        isRollback: transition.isRollback,
      },
      previewToken,
      previewExpiresAtIso: expiresAtIso,
      confirmation,
      businessWritesApplied: false,
      idempotentReplay: false,
    };
  }

  assertExactConfirmation(input.confirmation, confirmation);
  const previewToken = requiredCapability(input.previewToken, CUTOVER_TOKEN_VERSION);
  const claimRef = claimDocument(previewToken);
  const auditRef = adminDb.collection(AUDITS_COLLECTION).doc(`sheet-cutover-${hashHex(previewToken, 40)}`);
  const preflightClaim = validateClaim({
    snapshot: await claimRef.get(),
    tokenVersion: CUTOVER_TOKEN_VERSION,
    operation: "cutover",
    actor: input,
    sourceId: context.sourceId,
    nowMs,
  });
  assertClaimInteger(preflightClaim, "expectedVersion", expectedVersion);
  if (
    asString(preflightClaim.confirmationFingerprint) !== hashHex(confirmation, 64) ||
    asString(preflightClaim.targetState) !== targetState
  ) {
    throw previewMismatch();
  }
  if (
    requestedCheckpoint &&
    asString(preflightClaim.checkpoint) !== requestedCheckpoint
  ) {
    throw previewMismatch();
  }
  if (
    requestedTargetExitAt &&
    asString(preflightClaim.targetExitAt) !== requestedTargetExitAt
  ) {
    throw previewMismatch();
  }
  if (asString(preflightClaim.status) === "completed") {
    const next = parseCutoverRecord(preflightClaim.next, nowIso);
    if (next.state !== targetState || next.version !== expectedVersion + 1) {
      throw previewMismatch();
    }
    return {
      sourceId: context.sourceId,
      mode: "actual" as const,
      ...next,
      businessWritesApplied: false,
      idempotentReplay: true,
      auditRef: auditRef.path,
    };
  }
  const claimedReviewedSheetSnapshot = reviewedSheetSnapshotFromClaim(
    context,
    preflightClaim.reviewedSheetSnapshot,
  );
  const prepared = await adminDb.runTransaction(async (tx) => {
    const claimSnapshot = await tx.get(claimRef);
    const claim = validateClaim({
      snapshot: claimSnapshot,
      tokenVersion: CUTOVER_TOKEN_VERSION,
      operation: "cutover",
      actor: input,
      sourceId: context.sourceId,
      nowMs,
    });
    assertClaimInteger(claim, "expectedVersion", expectedVersion);
    if (asString(claim.confirmationFingerprint) !== hashHex(confirmation, 64)) {
      throw previewMismatch();
    }
    if (asString(claim.targetState) !== targetState) throw previewMismatch();
    if (
      requestedCheckpoint &&
      asString(claim.checkpoint) !== requestedCheckpoint
    ) {
      throw previewMismatch();
    }
    if (
      requestedTargetExitAt &&
      asString(claim.targetExitAt) !== requestedTargetExitAt
    ) {
      throw previewMismatch();
    }
    if (asString(claim.status) === "completed") {
      const next = parseCutoverRecord(claim.next, nowIso);
      if (next.state !== targetState || next.version !== expectedVersion + 1) {
        throw previewMismatch();
      }
      return { kind: "replay" as const, next };
    }
    if (asString(claim.status) === "verifying") {
      const next = parseCutoverRecord(claim.next, nowIso);
      if (next.state !== targetState || next.version !== expectedVersion + 1) {
        throw previewMismatch();
      }
      return { kind: "resume" as const, next };
    }
    assertReviewedSheetSnapshotMatch(
      claim.reviewedSheetSnapshot,
      claimedReviewedSheetSnapshot,
    );
    const currentSource = await tx.get(context.sourceRef);
    const transactionCurrent = parseCutoverRecord(currentSource.get("cutover"), nowIso);
    if (transactionCurrent.version !== expectedVersion) {
      return { kind: "version_mismatch" as const, actualVersion: transactionCurrent.version };
    }
    const transactionTransition = evaluateSheetCutoverTransition({
      current: transactionCurrent,
      targetState,
      requestedCheckpoint,
      requestedTargetExitAt,
      nowMs,
    });
    if (
      asString(claim.checkpoint) !== (transactionTransition.rollbackCheckpoint ?? "") ||
      asString(claim.targetExitAt) !== (transactionTransition.targetExitAt ?? "") ||
      Boolean(claim.isRollback) !== transactionTransition.isRollback
    ) {
      throw previewMismatch();
    }
    const transactionPlan = await buildReconciliationPlan(
      transactionReader(tx),
      context,
      currentSource,
      claimedReviewedSheetSnapshot,
    );
    const transactionReconciliation = await readLatestReconciliation(currentSource, tx);
    assertCutoverEvidence({
      context,
      current: transactionCurrent,
      targetState,
      isRollback: transactionTransition.isRollback,
      plan: transactionPlan,
      reconciliation: transactionReconciliation,
      sourceSnapshot: currentSource,
      nowMs,
    });
    const currentFingerprint = cutoverFingerprint({
      current: transactionCurrent,
      targetState,
      checkpoint: transactionTransition.rollbackCheckpoint,
      targetExitAt: transactionTransition.targetExitAt,
      projectionRevision: nonNegativeIntegerOrZero(currentSource.get("projectionRevision")),
      reconciliation: transactionReconciliation,
      plan: transactionPlan,
      sourceSnapshot: currentSource,
    });
    if (currentFingerprint !== asString(claim.transitionFingerprint)) {
      return { kind: "drift" as const };
    }
    const next: SheetCutoverRecord = {
      state: targetState,
      version: transactionCurrent.version + 1,
      owner: input.requestedBy,
      enteredAtIso: nowIso,
      updatedAtIso: nowIso,
      targetExitAt: transactionTransition.targetExitAt,
      rollbackCheckpoint: transactionTransition.rollbackCheckpoint,
      lastRollbackAtIso: transactionTransition.isRollback
        ? nowIso
        : transactionCurrent.lastRollbackAtIso,
    };
    tx.set(auditRef, {
      id: auditRef.id,
      operation: "cutover",
      sourceId: context.sourceId,
      result: "verifying",
      fromState: transactionCurrent.state,
      toState: next.state,
      fromVersion: transactionCurrent.version,
      toVersion: next.version,
      rollback: transactionTransition.isRollback,
      transitionFingerprint: currentFingerprint,
      reviewedSheetSnapshot: transactionPlan.reviewedSheetSnapshot,
      requestedByHash: actorHash(input),
      requestedRole: cleanRole(input.requestedRole),
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(claimRef, {
      status: "verifying",
      next,
      auditRef: auditRef.path,
      preparedCurrentCutover: transactionCurrent,
      preparedSourceVersion: nonNegativeIntegerOrZero(currentSource.get("sourceVersion")),
      preparedProjectionRevision:
        nonNegativeIntegerOrZero(currentSource.get("projectionRevision")),
      preparedLastReconciliationRef:
        asString(currentSource.get("lastReconciliationRef")) || null,
      preparedTransitionFingerprint: currentFingerprint,
      verificationStartedAtIso: nowIso,
      verificationStartedAt: FieldValue.serverTimestamp(),
    });
    return { kind: "prepared" as const, next };
  });

  if (prepared.kind === "version_mismatch") throw versionMismatch("cutover", expectedVersion, prepared.actualVersion);
  if (prepared.kind === "drift") {
    throw failedPrecondition("Sheet cutover preview drifted because the source or reconciliation changed; run preview again.");
  }
  if (prepared.kind === "replay") {
    return {
      sourceId: context.sourceId,
      mode: "actual" as const,
      ...prepared.next,
      businessWritesApplied: false,
      idempotentReplay: true,
      auditRef: auditRef.path,
    };
  }

  await dependencies.afterPrepare?.();
  let verifiedSheetSnapshot: ReviewedSheetSnapshot | null;
  try {
    verifiedSheetSnapshot = await readCurrentReviewedSheetSnapshot(
      context,
      dependencies,
    );
    assertReviewedSheetSnapshotMatch(
      preflightClaim.reviewedSheetSnapshot,
      verifiedSheetSnapshot,
    );
  } catch {
    const failure = await failPreparedSheetControlOperation({
      claimRef,
      auditRef,
      failureCode: "reviewed_sheet_verification_failed",
      nowIso,
    });
    if (failure === "completed") {
      const completedClaim = asRecord((await claimRef.get()).data());
      const next = parseCutoverRecord(completedClaim.next, nowIso);
      return {
        sourceId: context.sourceId,
        mode: "actual" as const,
        ...next,
        businessWritesApplied: false,
        idempotentReplay: true,
        auditRef: auditRef.path,
      };
    }
    throw failedPrecondition(
      "Reviewed Google Sheet changed or could not be verified after prepare; cutover state was not changed.",
    );
  }
  const committed = await adminDb.runTransaction(async (tx) => {
    const claimSnapshot = await tx.get(claimRef);
    const claim = validateClaim({
      snapshot: claimSnapshot,
      tokenVersion: CUTOVER_TOKEN_VERSION,
      operation: "cutover",
      actor: input,
      sourceId: context.sourceId,
      nowMs,
    });
    if (asString(claim.status) === "completed") {
      const next = parseCutoverRecord(claim.next, nowIso);
      return { kind: "replay" as const, next };
    }
    if (asString(claim.status) !== "verifying") {
      return { kind: "drift" as const };
    }
    const currentSource = await tx.get(context.sourceRef);
    let expectedNext: SheetCutoverRecord;
    let nextSourceVersion = -1;
    let reboundPublicProjections: Record<string, unknown> | null = null;
    try {
      const currentCutover = parseCutoverRecord(currentSource.get("cutover"), nowIso);
      const preparedCurrent = parseCutoverRecord(claim.preparedCurrentCutover, nowIso);
      expectedNext = parseCutoverRecord(claim.next, nowIso);
      if (
        !cutoverRecordsEqual(currentCutover, preparedCurrent) ||
        nonNegativeIntegerOrZero(currentSource.get("sourceVersion")) !==
          nonNegativeIntegerOrZero(claim.preparedSourceVersion) ||
        nonNegativeIntegerOrZero(currentSource.get("projectionRevision")) !==
          nonNegativeIntegerOrZero(claim.preparedProjectionRevision) ||
        asString(currentSource.get("lastReconciliationRef")) !==
          asString(claim.preparedLastReconciliationRef)
      ) {
        return { kind: "drift" as const };
      }
      const transactionTransition = evaluateSheetCutoverTransition({
        current: currentCutover,
        targetState,
        requestedCheckpoint,
        requestedTargetExitAt,
        nowMs,
      });
      if (
        asString(claim.checkpoint) !== (transactionTransition.rollbackCheckpoint ?? "") ||
        asString(claim.targetExitAt) !== (transactionTransition.targetExitAt ?? "") ||
        Boolean(claim.isRollback) !== transactionTransition.isRollback
      ) {
        return { kind: "drift" as const };
      }
      const transactionPlan = await buildReconciliationPlan(
        transactionReader(tx),
        context,
        currentSource,
        verifiedSheetSnapshot,
      );
      const transactionReconciliation = await readLatestReconciliation(currentSource, tx);
      assertCutoverEvidence({
        context,
        current: currentCutover,
        targetState,
        isRollback: transactionTransition.isRollback,
        plan: transactionPlan,
        reconciliation: transactionReconciliation,
        sourceSnapshot: currentSource,
        nowMs,
      });
      const currentFingerprint = cutoverFingerprint({
        current: currentCutover,
        targetState,
        checkpoint: transactionTransition.rollbackCheckpoint,
        targetExitAt: transactionTransition.targetExitAt,
        projectionRevision: nonNegativeIntegerOrZero(currentSource.get("projectionRevision")),
        reconciliation: transactionReconciliation,
        plan: transactionPlan,
        sourceSnapshot: currentSource,
      });
      if (
        currentFingerprint !== asString(claim.transitionFingerprint) ||
        currentFingerprint !== asString(claim.preparedTransitionFingerprint) ||
        expectedNext.state !== targetState ||
        expectedNext.version !== currentCutover.version + 1
      ) {
        return { kind: "drift" as const };
      }
      nextSourceVersion = nonNegativeIntegerOrZero(currentSource.get("sourceVersion")) + 1;
      reboundPublicProjections = rebindCurrentPublicProjectionForCutover({
        context,
        sourceSnapshot: currentSource,
        next: expectedNext,
        nextSourceVersion,
        reviewedSheetSnapshot: verifiedSheetSnapshot,
      });
      if (
        publicDatasetKeyForSource(context) &&
        (targetState === "primary" ||
          targetState === "rollbackable_primary" ||
          targetState === "retired") &&
        !reboundPublicProjections
      ) {
        return { kind: "drift" as const };
      }
    } catch (error) {
      if (isFailedPreconditionError(error)) return { kind: "drift" as const };
      throw error;
    }
    tx.set(context.sourceRef, {
      ...(currentSource.exists ? {} : sourceBootstrap(context, nowIso)),
      cutover: expectedNext,
      sourceVersion: nextSourceVersion,
      ...(reboundPublicProjections
        ? { publicProjections: reboundPublicProjections }
        : {}),
      updatedAtIso: nowIso,
      updatedBy: input.requestedBy,
      updatedAt: FieldValue.serverTimestamp(),
      ...(currentSource.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    }, { merge: true });
    tx.update(auditRef, {
      result: "success",
      sourceVerifiedAtIso: nowIso,
      sourceVerifiedAt: FieldValue.serverTimestamp(),
    });
    tx.update(claimRef, {
      status: "completed",
      completedAtIso: nowIso,
      completedAt: FieldValue.serverTimestamp(),
    });
    return { kind: "applied" as const, next: expectedNext };
  });
  if (committed.kind === "drift") {
    const failure = await failPreparedSheetControlOperation({
      claimRef,
      auditRef,
      failureCode: "source_drift_before_commit",
      nowIso,
    });
    if (failure === "completed") {
      const completedClaim = asRecord((await claimRef.get()).data());
      const next = parseCutoverRecord(completedClaim.next, nowIso);
      return {
        sourceId: context.sourceId,
        mode: "actual" as const,
        ...next,
        businessWritesApplied: false,
        idempotentReplay: true,
        auditRef: auditRef.path,
      };
    }
    throw failedPrecondition(
      "Sheet cutover source changed before the authoritative commit; cutover state was not changed.",
    );
  }
  return {
    sourceId: context.sourceId,
    mode: "actual" as const,
    ...committed.next,
    businessWritesApplied: committed.kind === "applied",
    idempotentReplay: committed.kind === "replay",
    auditRef: auditRef.path,
  };
}

async function resolveSourceContext(
  sourceIdValue: unknown,
  action: "reconcile" | "cutover",
): Promise<SourceContext> {
  const sourceId = cleanSourceId(sourceIdValue);
  if (!sourceId) throw invalidArgument("sourceId is required");
  const profile = knownSheetSourceProfileBySourceId(sourceId);
  assertGenericControlOperationSupported(profile, action);
  const sourceRef = adminDb.collection("intake_sources").doc(sourceId);
  const sourceSnapshot = await sourceRef.get();
  const source = asRecord(sourceSnapshot.data());
  const spreadsheetId = cleanSpreadsheetId(source.spreadsheetId) || profile?.spreadsheetId || spreadsheetIdFromSourceId(sourceId);
  if (!spreadsheetId) throw failedPrecondition("Sheet source has no spreadsheet contract.");
  const gate = resolveSheetIntakeWriteGate({ action, spreadsheetId, sourceId });
  const sourceContract = asRecord(source.sourceContract);
  const domain = parseDomain(sourceContract.domain) ?? profile?.domain ?? "staging_fixture";
  const projectionStrategy = parseProjectionStrategy(sourceContract.projectionStrategy)
    ?? profile?.projectionStrategy
    ?? "applicant_projection";
  if (
    gate.sourceProfile &&
    (gate.sourceProfile.projectionStrategy !== projectionStrategy ||
      gate.sourceProfile.domain !== domain)
  ) {
    throw failedPrecondition("Stored Sheet source contract differs from the reviewed source topology.");
  }
  return {
    sourceId,
    spreadsheetId,
    domain,
    projectionStrategy,
    profile,
    sourceRef,
    sourceSnapshot,
  };
}

function assertGenericControlOperationSupported(
  profile: SheetSourceProfile | null,
  action: "reconcile" | "cutover",
  targetState?: SheetCutoverState,
): void {
  if (!profile || profile.key === "staging_fixture") return;
  const operations = sheetSourceOperationalCapabilities(profile.key);
  const capability = action === "reconcile"
    ? operations.reconciliation
    : operations.cutover;
  if (!capability.genericCallableSupported) {
    // R14-8: 예전 문구는 **어떤 source 든** "참가자 명부 엔진이 소유한다"고 단정해, 폐기된
    // content_review 에서도 "명부 엔진에 가라"는 오진을 냈다(그 엔진 소유가 아니라 폐기다).
    // capability 가 이미 사유를 들고 있으므로 그것을 그대로 쓰고, 없을 때만 중립 문구로 떨어진다.
    throw failedPrecondition(
      capability.reason
        ?? `${profile.key} ${action} is not available through the generic Sheet control path.`,
    );
  }
  if (
    action === "cutover" &&
    targetState &&
    !operations.cutover.allowedTargetStates.includes(targetState)
  ) {
    throw failedPrecondition(
      `${profile.key} cannot transition to ${targetState} because a primary read consumer has not been proven. ` +
      "Blocked targets are primary, rollbackable_primary, and retired.",
    );
  }
}

function reconciliationConfirmation(
  context: SourceContext,
  expectedVersion: number,
): string {
  return `RECONCILE SHEET SOURCE ${controlSourceLabel(context)} VERSION ${expectedVersion}`;
}

function cutoverConfirmation(
  context: SourceContext,
  expectedVersion: number,
  targetState: SheetCutoverState,
): string {
  return `CUTOVER SHEET SOURCE ${controlSourceLabel(context)} VERSION ${expectedVersion} TO ${targetState}`;
}

function controlSourceLabel(context: SourceContext): string {
  return context.profile?.key ?? context.sourceId;
}

function assertExactConfirmation(value: unknown, expected: string): void {
  if (typeof value !== "string" || value !== expected) {
    throw invalidArgument(`confirmation must exactly equal: ${expected}`);
  }
}

async function buildReconciliationPlan(
  reader: ControlReader,
  context: SourceContext,
  sourceSnapshot: DocumentSnapshot,
  reviewedSheetSnapshot: ReviewedSheetSnapshot | null,
): Promise<ReconciliationPlan> {
  const firestorePlan = context.projectionStrategy === "video_submission_bridge"
    ? buildVideoBridgePlan(reader, context)
    : buildApplicantProjectionPlan(reader, context);
  return bindReviewedSheetSnapshot(
    await firestorePlan,
    context,
    sourceSnapshot,
    reviewedSheetSnapshot,
  );
}

async function readCurrentReviewedSheetSnapshot(
  context: SourceContext,
  dependencies: SheetIntakeControlDependencies,
): Promise<ReviewedSheetSnapshot | null> {
  const snapshot = await (
    dependencies.readReviewedSheetSnapshot ?? readReviewedSheetSnapshot
  )(context);
  if (!context.profile) {
    if (snapshot) throw failedPrecondition("Unreviewed Sheet sources cannot supply reviewed snapshot evidence.");
    return null;
  }
  if (!snapshot) {
    throw failedPrecondition("Reviewed Google Sheet snapshot evidence is required for this source contract.");
  }
  if (!reviewedSheetSnapshotEvidenceMatches(snapshot, {
    ...snapshot,
    sourceKey: context.profile.key,
    sourceId: context.sourceId,
    spreadsheetIdHash: hashHex(context.spreadsheetId, 32),
    datasetKey: context.profile.key === "participant_selection"
      ? "scpQualificationRows"
      : context.profile.key === "content_review"
        ? "scpVideoRows"
        : null,
  })) {
    throw failedPrecondition("Reviewed Google Sheet snapshot evidence is invalid for this source contract.");
  }
  return snapshot;
}

async function readReviewedSheetSnapshot(
  context: Readonly<SourceContext>,
): Promise<ReviewedSheetSnapshot | null> {
  const profile = context.profile;
  if (!profile) return null;
  if (profile.key === "participant_registry" || profile.key === "staging_fixture") {
    throw failedPrecondition(`${profile.key} requires its dedicated Sheet evidence engine.`);
  }

  if (profile.key === "scp_apply") {
    const preview = await syncSheetIntake({
      sourceKey: profile.key,
      spreadsheetId: profile.spreadsheetId,
      tabName: profile.tabName,
      gid: profile.gid,
      startRow: profile.startRow,
      dryRun: true,
      operationalPreview: true,
      requestedBy: "sheet-intake-control-snapshot",
    });
    if (preview.status !== "success") {
      throw failedPrecondition("Reviewed SCP_APPLY Sheet snapshot could not be normalized safely.");
    }
    return createReviewedSheetSnapshot({
      context,
      datasetKey: null,
      rowCount: preview.rowCount,
      canonicalFingerprint: hashHex(JSON.stringify({
        schemaVersion: "scp-apply-reviewed-snapshot-v1",
        sourceId: preview.sourceId,
        resolvedTabName: preview.tabName,
        startRow: preview.startRow,
        schemaFingerprint: preview.schemaFingerprint,
        rawRowRefs: [...preview.rawRowRefs].sort(),
      }), 64),
    });
  }

  const datasetKey: ScpSheetDatasetKey = profile.key === "participant_selection"
    ? "scpQualificationRows"
    : "scpVideoRows";
  const rows = profile.key === "participant_selection"
    ? await readScpQualificationReviewRows({
        spreadsheetId: profile.spreadsheetId,
        tabName: profile.tabName,
        startRow: profile.startRow,
      }) as unknown as Record<string, unknown>[]
    : await readScpVideoReviewSheetRows({
        spreadsheetId: profile.spreadsheetId,
        tabName: profile.tabName,
        startRow: profile.startRow,
      }) as unknown as Record<string, unknown>[];
  return createReviewedSheetSnapshot({
    context,
    datasetKey,
    rowCount: rows.length,
    canonicalFingerprint: canonicalScpSheetRowsFingerprint(rows),
  });
}

function createReviewedSheetSnapshot(input: {
  context: Readonly<SourceContext>;
  datasetKey: ScpSheetDatasetKey | null;
  rowCount: number;
  canonicalFingerprint: string;
}): ReviewedSheetSnapshot {
  if (!input.context.profile) {
    throw failedPrecondition("Reviewed Google Sheet snapshot requires a source registry profile.");
  }
  return {
    schemaVersion: "reviewed-sheet-snapshot-v1",
    sourceKey: input.context.profile.key,
    sourceId: input.context.sourceId,
    spreadsheetIdHash: hashHex(input.context.spreadsheetId, 32),
    datasetKey: input.datasetKey,
    rowCount: nonNegativeInteger(input.rowCount, "reviewed Sheet rowCount"),
    canonicalFingerprint: requiredSha256(
      input.canonicalFingerprint,
      "reviewed Sheet canonical fingerprint",
    ),
  };
}

function bindReviewedSheetSnapshot(
  plan: ReconciliationPlan,
  context: SourceContext,
  sourceSnapshot: DocumentSnapshot,
  reviewedSheetSnapshot: ReviewedSheetSnapshot | null,
): ReconciliationPlan {
  if (!reviewedSheetSnapshot) return { ...plan, reviewedSheetSnapshot: null };
  const counts = { ...plan.counts };
  const datasetKey = reviewedSheetSnapshot.datasetKey;
  const publicProjection = datasetKey
    ? asRecord(asRecord(sourceSnapshot.get("publicProjections"))[datasetKey])
    : null;
  const publicProjectionCurrent = datasetKey
    ? publicProjectionMatchesReviewedSheet({
        context,
        datasetKey,
        sourceSnapshot,
        projection: publicProjection ?? {},
        reviewedSheetSnapshot,
      })
    : null;
  if (publicProjectionCurrent === false) counts.stale += 1;
  const observedRows = Math.max(plan.observedRows, reviewedSheetSnapshot.rowCount);
  const anomalies = counts.missing + counts.extra + counts.stale + counts.conflict;
  const parityEligible = observedRows > 0 && anomalies === 0 && counts.activeCurrent > 0 &&
    publicProjectionCurrent !== false;
  return {
    counts,
    observedRows,
    parityEligible,
    reviewedSheetSnapshot,
    fingerprint: hashHex(JSON.stringify({
      firestorePlanFingerprint: plan.fingerprint,
      reviewedSheetSnapshot,
      publicProjection: publicProjectionEvidence(publicProjection),
    }), 64),
  };
}

function publicProjectionMatchesReviewedSheet(input: {
  context: SourceContext;
  datasetKey: ScpSheetDatasetKey;
  sourceSnapshot: DocumentSnapshot;
  projection: Record<string, unknown>;
  reviewedSheetSnapshot: ReviewedSheetSnapshot;
}): boolean {
  const cutoverVersion = nonNegativeIntegerOrZero(
    asRecord(input.sourceSnapshot.get("cutover")).version,
  );
  const generation = nonNegativeIntegerOrZero(input.projection.generation);
  const watermarks = asRecord(
    input.sourceSnapshot.get(SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD),
  );
  const storedWatermark = watermarks[input.datasetKey];
  // A durable watermark is a lease epoch: once present, only the exact
  // generation it fences may become active. Missing watermarks remain
  // compatible with pre-watermark sources and are repaired by the next build.
  const watermarkMatches = storedWatermark === undefined ||
    nonNegativeIntegerOrZero(storedWatermark) === generation;
  return watermarkMatches && publicProjectionReady({
    datasetKey: input.datasetKey,
    sourceId: input.context.sourceId,
    sourceVersion: nonNegativeIntegerOrZero(input.sourceSnapshot.get("sourceVersion")),
    cutoverVersion,
    projectionRevision: nonNegativeIntegerOrZero(input.sourceSnapshot.get("projectionRevision")),
    projection: input.projection,
  }) &&
    nonNegativeIntegerOrZero(input.projection.rowCount) === input.reviewedSheetSnapshot.rowCount &&
    asString(input.projection.canonicalFingerprint) === input.reviewedSheetSnapshot.canonicalFingerprint;
}

function publicProjectionEvidence(
  projection: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!projection) return null;
  return {
    schemaVersion: asString(projection.schemaVersion),
    datasetKey: asString(projection.datasetKey),
    sourceId: asString(projection.sourceId),
    generation: nonNegativeIntegerOrZero(projection.generation),
    rowCount: nonNegativeIntegerOrZero(projection.rowCount),
    canonicalFingerprint: asString(projection.canonicalFingerprint),
    sourceVersion: nonNegativeIntegerOrZero(projection.sourceVersion),
    cutoverVersion: nonNegativeIntegerOrZero(projection.cutoverVersion),
    projectionRevision: nonNegativeIntegerOrZero(projection.projectionRevision),
    completedAtIso: asString(projection.completedAtIso),
  };
}

export function reviewedSheetSnapshotEvidenceMatches(
  storedValue: unknown,
  currentValue: unknown,
): boolean {
  if (storedValue == null && currentValue == null) return true;
  const stored = asRecord(storedValue);
  const current = asRecord(currentValue);
  for (const value of [stored, current]) {
    if (
      value.schemaVersion !== "reviewed-sheet-snapshot-v1" ||
      !asString(value.sourceKey) ||
      !asString(value.sourceId) ||
      !/^[a-f0-9]{32}$/.test(asString(value.spreadsheetIdHash)) ||
      !Number.isInteger(Number(value.rowCount)) ||
      Number(value.rowCount) < 0 ||
      !/^[a-f0-9]{64}$/.test(asString(value.canonicalFingerprint))
    ) {
      return false;
    }
  }
  return asString(stored.schemaVersion) === asString(current.schemaVersion) &&
    asString(stored.sourceKey) === asString(current.sourceKey) &&
    asString(stored.sourceId) === asString(current.sourceId) &&
    asString(stored.spreadsheetIdHash) === asString(current.spreadsheetIdHash) &&
    (stored.datasetKey ?? null) === (current.datasetKey ?? null) &&
    Number(stored.rowCount) === Number(current.rowCount) &&
    asString(stored.canonicalFingerprint) === asString(current.canonicalFingerprint);
}

function assertReviewedSheetSnapshotMatch(
  storedValue: unknown,
  currentValue: ReviewedSheetSnapshot | null,
): void {
  if (!reviewedSheetSnapshotEvidenceMatches(storedValue, currentValue)) {
    throw failedPrecondition(
      "Reviewed Google Sheet changed after preview; create a new preview and reconciliation.",
    );
  }
}

function reviewedSheetSnapshotFromClaim(
  context: SourceContext,
  value: unknown,
): ReviewedSheetSnapshot | null {
  if (!context.profile) {
    if (value != null) throw previewMismatch();
    return null;
  }
  const record = asRecord(value);
  const expectedDatasetKey: ScpSheetDatasetKey | null =
    context.profile.key === "participant_selection"
      ? "scpQualificationRows"
      : context.profile.key === "content_review"
        ? "scpVideoRows"
        : null;
  if ((record.datasetKey ?? null) !== expectedDatasetKey) throw previewMismatch();
  const snapshot: ReviewedSheetSnapshot = {
    schemaVersion: "reviewed-sheet-snapshot-v1",
    sourceKey: context.profile.key,
    sourceId: context.sourceId,
    spreadsheetIdHash: hashHex(context.spreadsheetId, 32),
    datasetKey: expectedDatasetKey,
    rowCount: nonNegativeInteger(record.rowCount, "reviewed Sheet rowCount"),
    canonicalFingerprint: requiredSha256(
      record.canonicalFingerprint,
      "reviewed Sheet canonical fingerprint",
    ),
  };
  if (!reviewedSheetSnapshotEvidenceMatches(value, snapshot)) {
    throw previewMismatch();
  }
  return snapshot;
}

async function failPreparedSheetControlOperation(input: {
  claimRef: DocumentReference;
  auditRef: DocumentReference;
  runRef?: DocumentReference;
  failureCode: string;
  nowIso: string;
}): Promise<"failed" | "completed" | "unchanged"> {
  return adminDb.runTransaction(async (tx) => {
    const claimSnapshot = await tx.get(input.claimRef);
    const claim = asRecord(claimSnapshot.data());
    if (asString(claim.status) === "completed") return "completed" as const;
    if (asString(claim.status) !== "verifying") return "unchanged" as const;
    tx.update(input.claimRef, {
      status: "failed",
      failureCode: input.failureCode,
      failedAtIso: input.nowIso,
      failedAt: FieldValue.serverTimestamp(),
    });
    tx.set(input.auditRef, {
      result: "failed",
      failureCode: input.failureCode,
      sourceVerificationFailureAtIso: input.nowIso,
      sourceVerificationFailureAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (input.runRef) {
      tx.set(input.runRef, {
        status: "failed",
        failureCode: input.failureCode,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return "failed" as const;
  });
}

function cutoverRecordsEqual(
  left: SheetCutoverRecord,
  right: SheetCutoverRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isFailedPreconditionError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    asString((error as { code?: unknown }).code) === "failed-precondition";
}

async function buildApplicantProjectionPlan(
  reader: ControlReader,
  context: SourceContext,
): Promise<ReconciliationPlan> {
  const [leadSnapshot, projectionSnapshot] = await Promise.all([
    reader.getQuery(adminDb.collection("program_sheet_leads").where("sourceId", "==", context.sourceId)),
    reader.getQuery(adminDb.collection("sheet_source_rows").where("sourceId", "==", context.sourceId)),
  ]);
  const leads = new Map(leadSnapshot.docs.map((doc) => [doc.id, doc]));
  const projections = new Map(projectionSnapshot.docs.map((doc) => [doc.id, doc]));
  const counts: SheetReconciliationCounts = emptyCounts();
  const states: Array<Record<string, unknown>> = [];
  for (const [id, lead] of leads) {
    const projection = projections.get(id);
    const leadRevision = asString(lead.get("sourceRevision"), asString(lead.get("sourceRef")));
    const leadSourceFingerprint = asString(lead.get("sourceFingerprint"), asString(lead.get("rowHash")));
    const leadApplicantFingerprint = applicantFingerprint(lead, false);
    if (!projection) counts.missing += 1;
    else {
      const projectionRevision = asString(projection.get("sourceRevision"));
      const projectionSourceFingerprint = asString(projection.get("sourceFingerprint"));
      const projectionApplicantFingerprint = applicantFingerprint(projection, true);
      if (
        !leadRevision ||
        !projectionRevision ||
        leadRevision !== projectionRevision ||
        !leadSourceFingerprint ||
        leadSourceFingerprint !== projectionSourceFingerprint ||
        leadApplicantFingerprint !== projectionApplicantFingerprint
      ) {
        counts.stale += 1;
      }
    }
    states.push({
      id: hashHex(id, 24),
      kind: "lead",
      revision: hashHex(leadRevision, 24),
      sourceFingerprint: hashHex(leadSourceFingerprint, 24),
      applicantFingerprint: leadApplicantFingerprint,
    });
  }
  for (const [id, projection] of projections) {
    if (!leads.has(id)) counts.extra += 1;
    if (projection.get("status") === "conflict") counts.conflict += 1;
    if (projection.get("status") === "current") counts.activeCurrent += 1;
    if (projection.get("rowProvenance.previous")) counts.rowMoved += 1;
    states.push({
      id: hashHex(id, 24),
      kind: "projection",
      revision: hashHex(asString(projection.get("sourceRevision")), 24),
      sourceFingerprint: hashHex(asString(projection.get("sourceFingerprint")), 24),
      applicantFingerprint: applicantFingerprint(projection, true),
      status: asString(projection.get("status")),
    });
  }
  return finalizePlan(counts, states, Math.max(leads.size, projections.size));
}

const APPLICANT_SOURCE_FIELDS = [
  "email",
  "name",
  "country",
  "ageGroup",
  "youtubeUrl",
  "tiktokUrl",
  "instagramUrl",
  "mostViewedUrl",
  "sponsoredCount",
  "category",
  "format",
  "language",
  "motivation",
  "submittedAt",
  "token",
] as const;

function applicantFingerprint(
  snapshot: FirebaseFirestore.QueryDocumentSnapshot,
  nestedOnly: boolean,
): string {
  const nested = asRecord(snapshot.get("applicant"));
  const canonical = APPLICANT_SOURCE_FIELDS.map((field) => [
    field,
    asString(nested[field], nestedOnly ? "" : asString(snapshot.get(field))),
  ]);
  return hashHex(JSON.stringify(canonical), 32);
}

async function buildVideoBridgePlan(
  reader: ControlReader,
  context: SourceContext,
): Promise<ReconciliationPlan> {
  const [bridgeSnapshot, submissionSnapshot] = await Promise.all([
    reader.getQuery(adminDb.collection("sheet3_submission_bridge").where("source", "==", "sheet3_bridge")),
    reader.getQuery(adminDb.collection("submissions").where("source", "==", "sheet3_bridge")),
  ]);
  const bridgeDocs = bridgeSnapshot.docs.filter((doc) => docReferencesSpreadsheet(doc, context.spreadsheetId));
  const submissionDocs = submissionSnapshot.docs.filter((doc) => docReferencesSpreadsheet(doc, context.spreadsheetId));
  const bridges = new Map(bridgeDocs.map((doc) => [doc.id, doc]));
  const submissionsByPath = new Map(submissionDocs.map((doc) => [doc.ref.path, doc]));
  const referencedSubmissionPaths = new Set<string>();
  const counts: SheetReconciliationCounts = emptyCounts();
  const states: Array<Record<string, unknown>> = [];

  for (const [id, bridge] of bridges) {
    const submissionRef = asString(bridge.get("submissionRef"));
    if (submissionRef) referencedSubmissionPaths.add(submissionRef);
    const submission = submissionsByPath.get(submissionRef);
    if (!submission) counts.missing += 1;
    else if (canonicalStatus(bridge.get("sheetStatus")) !== canonicalStatus(submission.get("sheetStatus"))) counts.stale += 1;
    if (bridge.get("status") === "processed") counts.activeCurrent += 1;
    if (sourceRowRefs(bridge).length > 1) counts.rowMoved += 1;
    states.push({
      id: hashHex(id, 24),
      kind: "bridge",
      rowHash: hashHex(asString(bridge.get("rowHash")), 24),
      status: canonicalStatus(bridge.get("sheetStatus")),
      submissionRef: hashHex(submissionRef, 24),
    });
  }
  for (const submission of submissionDocs) {
    if (!referencedSubmissionPaths.has(submission.ref.path)) counts.extra += 1;
    if (submission.get("sheetStatusConflict")) counts.conflict += 1;
    states.push({
      id: hashHex(submission.id, 24),
      kind: "submission",
      status: canonicalStatus(submission.get("sheetStatus")),
      conflict: Boolean(submission.get("sheetStatusConflict")),
    });
  }
  return finalizePlan(counts, states, Math.max(bridgeDocs.length, submissionDocs.length));
}

function finalizePlan(
  counts: SheetReconciliationCounts,
  states: Array<Record<string, unknown>>,
  observedRows: number,
): ReconciliationPlan {
  const anomalies = counts.missing + counts.extra + counts.stale + counts.conflict;
  return {
    counts,
    observedRows,
    parityEligible: observedRows > 0 && anomalies === 0 && counts.activeCurrent > 0,
    fingerprint: hashHex(JSON.stringify(states.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))), 64),
    reviewedSheetSnapshot: null,
  };
}

function assertCutoverEvidence(input: {
  context: SourceContext;
  current: SheetCutoverRecord;
  targetState: SheetCutoverState;
  isRollback: boolean;
  plan: ReconciliationPlan;
  reconciliation: Record<string, unknown> | null;
  sourceSnapshot: DocumentSnapshot;
  nowMs: number;
}): void {
  const requiresParity = !input.isRollback && (
    input.targetState === "primary" ||
    input.targetState === "rollbackable_primary" ||
    input.targetState === "retired"
  );
  if (!requiresParity) return;
  if (
    input.context.projectionStrategy === "applicant_projection" &&
    asString(input.sourceSnapshot.get("lastSyncStatus")) !== "success"
  ) {
    throw failedPrecondition(
      "cutover requires the latest applicant Sheet sync to have succeeded",
    );
  }
  if (!input.reconciliation) {
    throw failedPrecondition("cutover requires an applied reconciliation report");
  }
  if (
    asString(input.reconciliation.schemaVersion) !== "sheet-intake-reconciliation-run-v1" ||
    asString(input.reconciliation.status) !== "applied" ||
    asString(input.reconciliation.sourceId) !== input.context.sourceId ||
    asString(input.reconciliation.projectionStrategy) !== input.context.projectionStrategy
  ) {
    throw failedPrecondition("cutover reconciliation does not belong to this Sheet source contract");
  }
  if (!input.plan.parityEligible || input.reconciliation.parityEligible !== true) {
    throw failedPrecondition("cutover requires zero missing/extra/stale/conflict rows and non-empty parity evidence");
  }
  if (asString(input.reconciliation.planFingerprint) !== input.plan.fingerprint) {
    throw failedPrecondition("cutover reconciliation is stale; run reconciliation again");
  }
  assertReviewedSheetSnapshotMatch(
    input.reconciliation.reviewedSheetSnapshot,
    input.plan.reviewedSheetSnapshot,
  );
  if (
    nonNegativeIntegerOrZero(input.reconciliation.projectionRevision) !==
    nonNegativeIntegerOrZero(input.sourceSnapshot.get("projectionRevision"))
  ) {
    throw failedPrecondition("cutover reconciliation projection revision is stale");
  }
  assertPublicReadProjectionEvidence(input.context, input.sourceSnapshot, input.current);
  if (input.targetState === "retired") {
    const targetExitAt = input.current.targetExitAt ? Date.parse(input.current.targetExitAt) : Number.NaN;
    if (!Number.isFinite(targetExitAt) || targetExitAt > input.nowMs) {
      throw failedPrecondition("retiring a Sheet source requires the observed targetExitAt to have passed");
    }
    const lastRollbackAt = input.current.lastRollbackAtIso
      ? Date.parse(input.current.lastRollbackAtIso)
      : Number.NaN;
    const enteredAt = Date.parse(input.current.enteredAtIso);
    if (
      !Number.isFinite(lastRollbackAt) ||
      !Number.isFinite(enteredAt) ||
      lastRollbackAt >= enteredAt
    ) {
      throw failedPrecondition(
        "retiring a Sheet source requires a successful rollback drill followed by re-promotion",
      );
    }
  }
}

function assertPublicReadProjectionEvidence(
  context: SourceContext,
  sourceSnapshot: DocumentSnapshot,
  current: SheetCutoverRecord,
): void {
  const datasetKey = publicDatasetKeyForSource(context);
  if (!datasetKey) return;
  const projection = asRecord(
    asRecord(sourceSnapshot.get("publicProjections"))[datasetKey],
  );
  if (!publicProjectionReady({
    datasetKey,
    sourceId: context.sourceId,
    sourceVersion: nonNegativeIntegerOrZero(sourceSnapshot.get("sourceVersion")),
    cutoverVersion: current.version,
    projectionRevision: nonNegativeIntegerOrZero(sourceSnapshot.get("projectionRevision")),
    projection,
  })) {
    throw failedPrecondition(
      "cutover requires a complete, non-empty, current public Sheet row projection",
    );
  }
}

function publicDatasetKeyForSource(
  context: SourceContext,
): ScpSheetDatasetKey | null {
  if (context.domain === "participant_selection") return "scpQualificationRows";
  if (context.domain === "content_review") return "scpVideoRows";
  return null;
}

function rebindCurrentPublicProjectionForCutover(input: {
  context: SourceContext;
  sourceSnapshot: DocumentSnapshot;
  next: SheetCutoverRecord;
  nextSourceVersion: number;
  reviewedSheetSnapshot: ReviewedSheetSnapshot | null;
}): Record<string, unknown> | null {
  const datasetKey = publicDatasetKeyForSource(input.context);
  if (
    !datasetKey ||
    !input.reviewedSheetSnapshot ||
    input.reviewedSheetSnapshot.datasetKey !== datasetKey
  ) {
    return null;
  }
  const publicProjections = asRecord(input.sourceSnapshot.get("publicProjections"));
  const projection = asRecord(publicProjections[datasetKey]);
  if (!publicProjectionMatchesReviewedSheet({
    context: input.context,
    datasetKey,
    sourceSnapshot: input.sourceSnapshot,
    projection,
    reviewedSheetSnapshot: input.reviewedSheetSnapshot,
  })) {
    return null;
  }
  return {
    ...publicProjections,
    [datasetKey]: {
      ...projection,
      sourceVersion: input.nextSourceVersion,
      cutoverVersion: input.next.version,
    },
  };
}

async function readLatestReconciliation(
  sourceSnapshot: DocumentSnapshot,
  transaction?: Transaction,
): Promise<Record<string, unknown> | null> {
  const path = asString(sourceSnapshot.get("lastReconciliationRef"));
  if (!path.startsWith(`${RECONCILIATION_RUNS_COLLECTION}/`) || path.split("/").length !== 2) return null;
  const ref = adminDb.doc(path);
  const snapshot = transaction ? await transaction.get(ref) : await ref.get();
  return snapshot.exists ? asRecord(snapshot.data()) : null;
}

function cutoverFingerprint(input: {
  current: SheetCutoverRecord;
  targetState: SheetCutoverState;
  checkpoint: SheetCutoverState | null;
  targetExitAt: string | null;
  projectionRevision: number;
  reconciliation: Record<string, unknown> | null;
  plan: ReconciliationPlan;
  sourceSnapshot: DocumentSnapshot;
}): string {
  const publicProjections = asRecord(input.sourceSnapshot.get("publicProjections"));
  return hashHex(JSON.stringify({
    current: input.current,
    targetState: input.targetState,
    checkpoint: input.checkpoint,
    targetExitAt: input.targetExitAt,
    projectionRevision: input.projectionRevision,
    reconciliationFingerprint: asString(input.reconciliation?.planFingerprint),
    currentPlanFingerprint: input.plan.fingerprint,
    publicProjections,
  }), 64);
}

function sourceBootstrap(context: SourceContext, nowIso: string): Record<string, unknown> {
  return {
    id: context.sourceId,
    sourceType: "google_sheet",
    spreadsheetId: context.spreadsheetId,
    tabName: context.profile?.tabName ?? "fixture",
    firstTabPolicy: "metadata_order",
    startRow: context.profile?.startRow ?? 1,
    status: "active",
    syncMode: "poll",
    gid: context.profile?.gid ?? "0",
    tabNamePattern: null,
    headerAliases: null,
    domain: context.domain,
    projectionStrategy: context.projectionStrategy,
    updatedAtIso: nowIso,
  };
}

function parseCutoverRecord(value: unknown, nowIso: string): SheetCutoverRecord {
  const record = asRecord(value);
  const updatedAtIso = normalizedStoredIso(record.updatedAtIso, nowIso);
  return {
    state: parseCutoverState(record.state) ?? "shadow",
    version: nonNegativeIntegerOrZero(record.version),
    owner: asString(record.owner, "system"),
    enteredAtIso: normalizedStoredIso(record.enteredAtIso, updatedAtIso),
    updatedAtIso,
    targetExitAt: normalizedOptionalIso(record.targetExitAt),
    rollbackCheckpoint: parseCutoverState(record.rollbackCheckpoint),
    lastRollbackAtIso: normalizedOptionalIso(record.lastRollbackAtIso),
  };
}

function parseCutoverState(value: unknown): SheetCutoverState | null {
  return value === "shadow" || value === "dual_read" || value === "primary" ||
    value === "rollbackable_primary" || value === "retired" ? value : null;
}

function parseOptionalCutoverState(value: unknown): SheetCutoverState | null {
  const raw = asString(value);
  if (!raw) return null;
  const parsed = parseCutoverState(raw);
  if (!parsed) throw invalidArgument("rollbackCheckpoint is invalid");
  return parsed;
}

function directReader(): ControlReader {
  return { getQuery: (query) => query.get() };
}

function transactionReader(transaction: Transaction): ControlReader {
  return { getQuery: (query) => transaction.get(query) };
}

function claimDocument(previewToken: string): DocumentReference {
  return adminDb.collection(PREVIEW_CLAIMS_COLLECTION).doc(`claim-${hashHex(previewToken, 40)}`);
}

function validateClaim(input: {
  snapshot: DocumentSnapshot;
  tokenVersion: string;
  operation: string;
  actor: ControlActor;
  sourceId: string;
  nowMs: number;
}): Record<string, unknown> {
  if (!input.snapshot.exists) throw previewMismatch();
  const claim = asRecord(input.snapshot.data());
  const status = asString(claim.status);
  const expiresAtMs = Date.parse(asString(claim.expiresAtIso));
  if (
    asString(claim.tokenVersion) !== input.tokenVersion ||
    asString(claim.operation) !== input.operation ||
    asString(claim.actorHash) !== actorHash(input.actor) ||
    asString(claim.sourceId) !== input.sourceId ||
    (status !== "pending" && status !== "verifying" && status !== "completed") ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= input.nowMs
  ) {
    throw previewMismatch();
  }
  return claim;
}

function assertClaimInteger(
  claim: Record<string, unknown>,
  field: string,
  expected: number,
): void {
  const actual = Number(claim[field]);
  if (!Number.isInteger(actual) || actual !== expected) throw previewMismatch();
}

function requiredCapability(value: unknown, version: string): string {
  const token = asString(value);
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^${escapedVersion}\\.[a-f0-9]{32}$`).test(token)) throw previewMismatch();
  return token;
}

function capabilityToken(version: string): string {
  return `${version}.${randomBytes(16).toString("hex")}`;
}

function reconciliationCounts(value: unknown): SheetReconciliationCounts {
  const record = asRecord(value);
  return {
    missing: nonNegativeIntegerOrZero(record.missing),
    extra: nonNegativeIntegerOrZero(record.extra),
    stale: nonNegativeIntegerOrZero(record.stale),
    conflict: nonNegativeIntegerOrZero(record.conflict),
    activeCurrent: nonNegativeIntegerOrZero(record.activeCurrent),
    rowMoved: nonNegativeIntegerOrZero(record.rowMoved),
  };
}

function emptyCounts(): SheetReconciliationCounts {
  return { missing: 0, extra: 0, stale: 0, conflict: 0, activeCurrent: 0, rowMoved: 0 };
}

function docReferencesSpreadsheet(doc: FirebaseFirestore.QueryDocumentSnapshot, spreadsheetId: string): boolean {
  return sourceRowRefs(doc).some((row) => asString(row.spreadsheetId) === spreadsheetId);
}

function sourceRowRefs(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown>[] {
  const refs = doc.get("sourceRowRefs");
  return Array.isArray(refs) ? refs.map(asRecord) : [];
}

function canonicalStatus(value: unknown): string {
  const status = asString(value).toLowerCase();
  if (status === "pass" || status === "passed" || status === "approved") return "approved";
  if (status === "fail" || status === "failed" || status === "rejected") return "rejected";
  return status || "pending";
}

function parseDomain(value: unknown): SheetSourceDomain | null {
  return value === "scp_apply" || value === "participant_selection" ||
    value === "content_review" || value === "staging_fixture" ? value : null;
}

function parseProjectionStrategy(value: unknown): SheetProjectionStrategy | null {
  return value === "applicant_projection" || value === "video_submission_bridge" ? value : null;
}

function cleanSourceId(value: unknown): string {
  return asString(value).replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 180);
}

function cleanSpreadsheetId(value: unknown): string {
  return asString(value).replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 160);
}

function spreadsheetIdFromSourceId(sourceId: string): string {
  return sourceId.startsWith("google_sheet-") ? cleanSpreadsheetId(sourceId.slice("google_sheet-".length)) : "";
}

function normalizedOptionalIso(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw invalidArgument("targetExitAt must be an ISO date");
  return new Date(ms).toISOString();
}

function normalizedStoredIso(value: unknown, fallback: string): string {
  const raw = asString(value, fallback);
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw failedPrecondition("stored Sheet cutover timestamp is invalid");
  }
  return new Date(ms).toISOString();
}

function effectiveNowMs(dependencies: SheetIntakeControlDependencies): number {
  const nowMs = dependencies.nowMs?.() ?? Date.now();
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw failedPrecondition("Sheet control server clock is unavailable.");
  }
  return Math.trunc(nowMs);
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw invalidArgument(`${field} must be a non-negative integer`);
  return parsed;
}

function nonNegativeIntegerOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function requiredSha256(value: unknown, field: string): string {
  const normalized = asString(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw failedPrecondition(`${field} is invalid`);
  }
  return normalized;
}

function actorHash(actor: ControlActor): string {
  return hashHex(JSON.stringify({
    requestedBy: asString(actor.requestedBy),
    role: cleanRole(actor.requestedRole),
    team: asString(actor.requestedTeam),
  }), 40);
}

function cleanRole(value: unknown): string {
  const role = asString(value);
  return role === "super_admin" || role === "admin" ? role : "unknown";
}

function hashHex(value: string, length = 64): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function assertActualFlag(dryRun: boolean, actual: unknown): void {
  if (!dryRun && actual !== true) throw invalidArgument("actual:true is required when dryRun is false");
}

function versionMismatch(kind: string, expected: number, actual: number): Error {
  return Object.assign(new Error(`${kind} version mismatch: expected ${expected}, actual ${actual}`), { code: "aborted", errorCode: "version_mismatch_version_mismatch_expected_actual" });
}

function previewMismatch(): Error {
  return failedPrecondition("Sheet operation preview token is missing, expired, consumed, or does not match the current scope.");
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid-argument", errorCode: "invalid_argument_unauthorized" });
}

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(message), { code: "failed-precondition", errorCode: "failed_precondition_unauthorized" });
}
