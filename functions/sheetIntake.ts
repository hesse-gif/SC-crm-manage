import { createHash } from "node:crypto";
import { asRecord, asString, assertNonGuestAuth, makeBehaviorLog } from "./shared";
import type { CallableRequestShape } from "./shared";
import { syncSheetIntake } from "./sheetIntakeService";
import { readScpQualificationReviewRows } from "./scpSheetReviewService";
import {
  canonicalScpSheetRowsFingerprint,
  replaceScpSheetPublicProjection,
  reserveScpSheetPublicProjectionBuild,
} from "./scpSheetPublicProjection";
import {
  reconcileSheetIntakeSource,
  updateSheetIntakeCutoverState,
} from "./sheetIntakeControl";
import {
  knownSheetSourceProfileByKey,
  knownSheetSourceProfileBySourceId,
  resolveSheetControlSourceId,
} from "./sheetIntakeRuntime";
import {
  beginSheetOperationApply,
  completeSheetOperationApply,
  createSheetOperationPreview,
  inspectSheetOperationPreview,
  sheetOperationFingerprint,
} from "./sheetOperationalPreview";
import type { SheetCutoverRecord, SheetCutoverState } from "./sheetIntakeTypes";

type SyncGoogleSheetIntakeEnvelope = ReturnType<typeof publicSyncResult> & {
  ok: true;
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
  canApply?: boolean;
  businessWritesApplied?: boolean;
  idempotentReplay?: boolean;
  previewToken?: string;
  previewExpiresAtIso?: string;
  planFingerprint?: string;
  summary?: Record<string, unknown>;
  confirmation?: string;
  sourceVersionBefore?: number;
  projectionGeneration?: number;
  projectionRevision?: number;
};

const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;
const CONTROL_ROLES = ["super_admin", "admin"] as const;
const INTAKE_SYNC_PREVIEW_TOKEN_VERSION = "sheet-source-sync-v1";
const INTAKE_SYNC_OPERATION = "sheet_source.sync";

export function sheetSourceSyncConfirmation(sourceKey: string): string {
  return `APPLY SHEET SOURCE ${sourceKey}`;
}

export async function syncGoogleSheetIntake(request: CallableRequestShape): Promise<SyncGoogleSheetIntakeEnvelope> {
  const input = asRecord(request.data);
  const profile = knownSheetSourceProfileByKey(input.sourceKey);
  const reviewedSource = Boolean(profile && profile.key !== "staging_fixture");
  const dryRun = reviewedSource ? input.dryRun !== false : input.dryRun === true;
  const auth = assertNonGuestAuth(
    request,
    "sheet_intake.sync_google_sheet",
    reviewedSource && !dryRun ? CONTROL_ROLES : WRITE_ROLES,
  );
  try {
    if (reviewedSource && profile) {
      assertReviewedSourceRequest(input, profile.key, dryRun);
      if (!profile.syncSupported) {
        // R14-8: "전용 운영 엔진이 필요하다"는 문구는 그 엔진이 존재할 때만 참이다. Sheet3
        // (content_review)는 폐기돼 엔진 자체가 없으므로, 운영자가 없는 엔진을 찾아다니게 된다.
        throw failedPrecondition(
          `Sheet source ${profile.key} has no active sync engine (the source may be decommissioned).`,
        );
      }
      return await runReviewedSourceSync({ input, profile, auth, dryRun });
    }
    const result = await syncSheetIntake(legacySyncInput(input, auth.userId, dryRun));
    if (
      result.status === "success" &&
      result.mode !== "dry_run" &&
      result.sourceContract.domain === "participant_selection"
    ) {
      const reviewRows = await readScpQualificationReviewRows({
        spreadsheetId: result.spreadsheetId,
        tabName: result.tabName,
        startRow: 1,
        rows: result.mode === "production_write" ? undefined : input.rows,
      });
      await replaceScpSheetPublicProjection({
        datasetKey: "scpQualificationRows",
        rows: reviewRows as unknown as Record<string, unknown>[],
        expectedSourceVersion: result.sourceVersion,
      });
    }

    return {
      ok: true,
      ...publicSyncResult(result),
      behaviorLog: makeBehaviorLog(auth, "sheet_intake.sync_google_sheet", "success", "scp-automation"),
    };
  } catch (error) {
    if (error && typeof error === "object" && !("behaviorLog" in error)) {
      Object.assign(error, {
        behaviorLog: makeBehaviorLog(auth, "sheet_intake.sync_google_sheet", "blocked", "scp-automation"),
      });
    }
    throw error;
  }
}

async function runReviewedSourceSync(input: {
  input: Record<string, unknown>;
  profile: NonNullable<ReturnType<typeof knownSheetSourceProfileByKey>>;
  auth: ReturnType<typeof assertNonGuestAuth>;
  dryRun: boolean;
}): Promise<SyncGoogleSheetIntakeEnvelope> {
  const { profile, auth } = input;
  const identity = {
    tokenVersion: INTAKE_SYNC_PREVIEW_TOKEN_VERSION,
    operation: INTAKE_SYNC_OPERATION,
    sourceKey: profile.key,
    sourceId: profile.sourceId,
    actor: auth,
  };

  if (input.dryRun) {
    const preview = await syncSheetIntake({
      sourceKey: profile.key,
      dryRun: true,
      operationalPreview: true,
      requestedBy: auth.userId,
    });
    const safe = publicSyncResult(preview);
    if (preview.status !== "success") {
      return {
        ok: true,
        ...safe,
        canApply: false,
        businessWritesApplied: false,
        idempotentReplay: false,
        behaviorLog: makeBehaviorLog(auth, "sheet_intake.sync_google_sheet", "blocked", "scp-automation"),
      };
    }
    const projectionPreview = profile.key === "participant_selection"
      ? await readParticipantSelectionProjection(profile.spreadsheetId, profile.tabName)
      : null;
    const planFingerprint = syncPlanFingerprint(
      preview,
      projectionPreview?.fingerprint ?? null,
    );
    const claim = await createSheetOperationPreview({
      ...identity,
      sourceVersion: preview.sourceVersion,
      originFingerprint: preview.originFingerprint,
      planFingerprint,
      summary: syncPreviewSummary(preview, projectionPreview?.fingerprint ?? null),
    });
    return {
      ok: true,
      ...safe,
      ...claim,
      canApply: true,
      businessWritesApplied: false,
      idempotentReplay: false,
      confirmation: sheetSourceSyncConfirmation(profile.key),
      behaviorLog: makeBehaviorLog(auth, "sheet_intake.sync_google_sheet", "success", "scp-automation"),
    };
  }

  assertActualSourceApply(input.input, sheetSourceSyncConfirmation(profile.key));
  const inspected = await inspectSheetOperationPreview({
    ...identity,
    previewToken: input.input.previewToken,
  });
  if (inspected.status === "completed" && inspected.completedResult) {
    return {
      ok: true,
      ...(inspected.completedResult as ReturnType<typeof publicSyncResult>),
      canApply: false,
      businessWritesApplied: false,
      idempotentReplay: true,
      behaviorLog: makeBehaviorLog(auth, "sheet_intake.sync_google_sheet", "success", "scp-automation"),
    };
  }
  const projectionApply = profile.key === "participant_selection"
    ? await readParticipantSelectionProjection(profile.spreadsheetId, profile.tabName)
    : null;
  if (
    projectionApply &&
    asString(inspected.summary.publicProjectionFingerprint) !== projectionApply.fingerprint
  ) {
    throw previewDrift();
  }
  const recomputed = inspected.status === "pending"
    ? await syncSheetIntake({
        sourceKey: profile.key,
        dryRun: true,
        operationalPreview: true,
        requestedBy: auth.userId,
      })
    : null;
  if (recomputed && recomputed.status !== "success") throw previewDrift();
  const begin = await beginSheetOperationApply({
    ...identity,
    previewToken: input.input.previewToken,
    sourceVersion: recomputed?.sourceVersion ?? inspected.sourceVersion,
    originFingerprint: recomputed?.originFingerprint ?? inspected.originFingerprint,
    planFingerprint: recomputed
      ? syncPlanFingerprint(recomputed, projectionApply?.fingerprint ?? null)
      : inspected.planFingerprint,
  });
  if (begin.kind === "replay") {
    return {
      ok: true,
      ...(begin.result as ReturnType<typeof publicSyncResult>),
      canApply: false,
      businessWritesApplied: false,
      idempotentReplay: true,
      behaviorLog: makeBehaviorLog(auth, "sheet_intake.sync_google_sheet", "success", "scp-automation"),
    };
  }

  // begin.previewToken is attempt-scoped so a lease takeover can prove
  // completion ownership. Business idempotency must remain bound to the
  // stable base capability inspected before that attempt began.
  const operationId = sheetSourceSyncOperationId(inspected.previewToken);
  const applied = await syncSheetIntake({
    sourceKey: profile.key,
    dryRun: false,
    expectedSourceVersion: inspected.sourceVersion,
    expectedOriginFingerprint: inspected.originFingerprint,
    operationId,
    requestedBy: auth.userId,
  });
  let safe: ReturnType<typeof publicSyncResult> & {
    sourceVersionBefore?: number;
    projectionGeneration?: number;
    projectionRevision?: number;
  } = publicSyncResult(applied);
  let completedWithProjection = false;
  if (
    applied.status === "success" &&
    applied.sourceContract.domain === "participant_selection"
  ) {
    if (!projectionApply) throw previewDrift();
    const reservation = await reserveScpSheetPublicProjectionBuild({
      datasetKey: "scpQualificationRows",
      expectedSourceVersion: applied.sourceVersion,
      operationId,
    });
    const projectionMetadata = await replaceScpSheetPublicProjection({
      datasetKey: "scpQualificationRows",
      rows: projectionApply.rows,
      expectedSourceVersion: applied.sourceVersion,
      operationId,
      reservation,
      completion: {
        ...identity,
        previewToken: begin.previewToken,
        result: safe,
      },
    });
    // The stable operation ID deliberately lets a lease-takeover attempt reuse
    // this exact reservation. A failing older attempt must not release it;
    // recovery or lease-aware stale cleanup owns abandoned-reservation cleanup.
    // Projection activation is a second source-control transition (N+1 to
    // N+2). Mirror the atomically completed preview result so the first
    // response and every same-token replay expose the same version evidence.
    safe = {
      ...safe,
      sourceVersionBefore: applied.sourceVersion,
      sourceVersion: projectionMetadata.sourceVersion,
      projectionGeneration: projectionMetadata.generation,
      projectionRevision: projectionMetadata.projectionRevision,
    };
    completedWithProjection = true;
  }
  if (!completedWithProjection) {
    await completeSheetOperationApply({
      previewToken: begin.previewToken,
      tokenVersion: INTAKE_SYNC_PREVIEW_TOKEN_VERSION,
      result: safe,
    });
  }
  const execution = reviewedSourceApplyExecutionFlags({
    recoveredOperation: applied.recoveredOperation === true,
    projectionApplied: completedWithProjection,
  });
  return {
    ok: true,
    ...safe,
    canApply: false,
    ...execution,
    behaviorLog: makeBehaviorLog(auth, "sheet_intake.sync_google_sheet", "success", "scp-automation"),
  };
}

export function reviewedSourceApplyExecutionFlags(input: {
  recoveredOperation: boolean;
  projectionApplied: boolean;
}): { businessWritesApplied: boolean; idempotentReplay: boolean } {
  // A recovered intake can still perform the missing public projection in
  // this request. Only a recovery that performs no projection is a true
  // no-write replay.
  const businessWritesApplied = !input.recoveredOperation || input.projectionApplied;
  return {
    businessWritesApplied,
    idempotentReplay: !businessWritesApplied,
  };
}

function legacySyncInput(
  input: Record<string, unknown>,
  requestedBy: string,
  dryRun: boolean,
) {
  return {
    sourceKey: input.sourceKey,
    spreadsheetId: input.spreadsheetId,
    tabName: input.tabName,
    gid: input.gid,
    startRow: input.startRow,
    rows: input.rows,
    headerRow: input.headerRow,
    acceptNewSchema: input.acceptNewSchema,
    dryRun,
    requestedBy,
  };
}

function assertReviewedSourceRequest(
  input: Record<string, unknown>,
  sourceKey: string,
  dryRun: boolean,
): void {
  if (asString(input.sourceKey) !== sourceKey) throw invalidArgument("A reviewed sourceKey is required.");
  for (const field of ["spreadsheetId", "tabName", "gid", "startRow", "rows", "headerRow", "acceptNewSchema", "nowIso"]) {
    if (input[field] !== undefined) {
      throw invalidArgument(`Reviewed Sheet ${field} overrides are not allowed; the server source registry is authoritative.`);
    }
  }
  if (!dryRun && input.dryRun !== false) throw invalidArgument("dryRun:false is required for apply.");
}

function assertActualSourceApply(input: Record<string, unknown>, expectedConfirmation: string): void {
  if (input.actual !== true) throw invalidArgument("actual:true is required for Sheet source apply.");
  if (asString(input.confirm) !== expectedConfirmation) {
    throw invalidArgument("The source-bound Sheet apply confirmation does not match.");
  }
  if (!asString(input.previewToken)) throw invalidArgument("previewToken is required for Sheet source apply.");
}

function syncPlanFingerprint(
  result: Awaited<ReturnType<typeof syncSheetIntake>>,
  publicProjectionFingerprint: string | null = null,
): string {
  return sheetOperationFingerprint({
    sourceKey: result.sourceContract.domain,
    sourceVersion: result.sourceVersion,
    originFingerprint: result.originFingerprint,
    schemaFingerprint: result.schemaFingerprint,
    status: result.status,
    startRow: result.startRow,
    rowCount: result.rowCount,
    normalizedLeadCount: result.normalizedLeadCount,
    rawRowCount: result.rawRowRefs.length,
    publicProjectionFingerprint,
  });
}

function syncPreviewSummary(
  result: Awaited<ReturnType<typeof syncSheetIntake>>,
  publicProjectionFingerprint: string | null = null,
) {
  return {
    status: result.status,
    rowCount: result.rowCount,
    normalizedLeadCount: result.normalizedLeadCount,
    rawRowCount: result.rawRowRefs.length,
    sourceVersion: result.sourceVersion,
    publicProjectionFingerprint,
  };
}

async function readParticipantSelectionProjection(
  spreadsheetId: string,
  tabName: string,
) {
  const rows = await readScpQualificationReviewRows({
    spreadsheetId,
    tabName,
    startRow: 1,
  }) as unknown as Record<string, unknown>[];
  return {
    rows,
    fingerprint: canonicalScpSheetRowsFingerprint(rows),
  };
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid-argument", errorCode: "invalid_argument_unauthorized" });
}

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(message), { code: "failed-precondition", errorCode: "failed_precondition_unauthorized" });
}

function previewDrift(): Error {
  return Object.assign(new Error("Sheet source changed after preview; create a new preview."), { code: "failed-precondition", errorCode: "preview_drift_sheet_source_changed_after_preview" });
}

function publicSyncResult(
  result: Awaited<ReturnType<typeof syncSheetIntake>>,
) {
  const {
    sourceId,
    runId,
    spreadsheetId: _spreadsheetId,
    tabName: _tabName,
    sourceContract: _sourceContract,
    rawRowRefs,
    leadRefs,
    ...safe
  } = result;
  return {
    ...safe,
    sourceKey: publicSourceKey(sourceId),
    runRef: `sheet_sync_${hash(`${sourceId}:${runId}`).slice(0, 16)}`,
    rawRowCount: rawRowRefs.length,
    leadCount: leadRefs.length,
  };
}

export async function reconcileGoogleSheetIntake(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(
    request,
    "sheet_intake.reconcile",
    CONTROL_ROLES,
  );
  const input = asRecord(request.data);
  try {
    const sourceId = resolveSheetControlSourceId({
      sourceKey: input.sourceKey,
      sourceId: input.sourceId,
    });
    const result = await reconcileSheetIntakeSource({
      sourceId,
      expectedVersion: Number(input.expectedVersion),
      dryRun: input.dryRun !== false,
      actual: input.actual === true,
      previewToken: asString(input.previewToken),
      confirmation: asString(input.confirm),
      requestedBy: auth.userId,
      requestedRole: auth.role,
      requestedTeam: auth.team,
    });
    return {
      ok: true,
      ...publicReconciliationResult(result, sourceId),
      behaviorLog: makeBehaviorLog(
        auth,
        "sheet_intake.reconcile",
        "success",
        "scp-automation",
      ),
    };
  } catch (error) {
    attachBlockedBehaviorLog(error, auth, "sheet_intake.reconcile");
    throw error;
  }
}

export async function updateGoogleSheetIntakeCutover(
  request: CallableRequestShape,
) {
  const auth = assertNonGuestAuth(
    request,
    "sheet_intake.cutover",
    CONTROL_ROLES,
  );
  const input = asRecord(request.data);
  try {
    const sourceId = resolveSheetControlSourceId({
      sourceKey: input.sourceKey,
      sourceId: input.sourceId,
    });
    const result = await updateSheetIntakeCutoverState({
      sourceId,
      expectedVersion: Number(input.expectedVersion),
      targetState: asString(input.targetState) as SheetCutoverState,
      targetExitAt: asString(input.targetExitAt) || null,
      rollbackCheckpoint: (asString(input.rollbackCheckpoint) || null) as SheetCutoverState | null,
      dryRun: input.dryRun !== false,
      actual: input.actual === true,
      previewToken: asString(input.previewToken),
      confirmation: asString(input.confirm),
      requestedBy: auth.userId,
      requestedRole: auth.role,
      requestedTeam: auth.team,
    });
    return {
      ok: true,
      ...publicCutoverResult(result, sourceId),
      behaviorLog: makeBehaviorLog(
        auth,
        "sheet_intake.cutover",
        "success",
        "scp-automation",
      ),
    };
  } catch (error) {
    attachBlockedBehaviorLog(error, auth, "sheet_intake.cutover");
    throw error;
  }
}

function publicReconciliationResult(
  result: Awaited<ReturnType<typeof reconcileSheetIntakeSource>>,
  sourceId: string,
) {
  const { sourceId: _sourceId, auditRef, ...safe } = result;
  return {
    ...safe,
    sourceKey: publicSourceKey(sourceId),
    auditRef: maskedReference(auditRef),
  };
}

function publicCutoverResult(
  result: Awaited<ReturnType<typeof updateSheetIntakeCutoverState>>,
  sourceId: string,
) {
  const auditRef = "auditRef" in result ? result.auditRef : undefined;
  const { sourceId: _sourceId, ...restWithAudit } = result;
  const { auditRef: _auditRef, ...rest } = restWithAudit as typeof restWithAudit & {
    auditRef?: string;
  };
  if (rest.mode === "preview") {
    return {
      ...rest,
      sourceKey: publicSourceKey(sourceId),
      current: publicCutoverRecord(rest.current),
      auditRef: maskedReference(auditRef),
    };
  }
  const { owner: _owner, ...actual } = rest;
  return {
    ...actual,
    sourceKey: publicSourceKey(sourceId),
    auditRef: maskedReference(auditRef),
  };
}

function publicCutoverRecord(record: SheetCutoverRecord) {
  const { owner, ...safe } = record;
  return {
    ...safe,
    ownerHash: owner ? `operator_${hash(owner).slice(0, 12)}` : null,
  };
}

function publicSourceKey(sourceId: string): string {
  return knownSheetSourceProfileBySourceId(sourceId)?.key ?? "staging_fixture";
}

function maskedReference(value: unknown): string | null {
  const reference = asString(value);
  return reference ? `audit_${hash(reference).slice(0, 16)}` : null;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sheetSourceSyncOperationId(previewToken: string): string {
  return `sheet-source-sync-${hash(previewToken).slice(0, 40)}`;
}

function attachBlockedBehaviorLog(
  error: unknown,
  auth: ReturnType<typeof assertNonGuestAuth>,
  action: string,
): void {
  if (error && typeof error === "object" && !("behaviorLog" in error)) {
    Object.assign(error, {
      behaviorLog: makeBehaviorLog(
        auth,
        action,
        "blocked",
        "scp-automation",
      ),
    });
  }
}
