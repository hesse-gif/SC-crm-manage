// Sheet3(Typeform 영상 제출 시트) → submissions durable 브리지.
// 실행 모델: 스케줄러가 시트 rows 전량을 읽어 row별 트랜잭션 처리한다 — lease 큐가 아니므로
// 계획 인덱스 매트릭스의 sheet3_submission_bridge(status, processingLeaseExpiresAtIso) 인덱스는
// 의도적으로 생략(해당 쿼리 패턴 미사용). lease 큐 전환 시 인덱스와 함께 재도입할 것.
import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  readScpVideoReviewSheetRows,
  type ScpVideoReviewSheetRow,
  type ScpVideoSheetStatus,
} from "./scpSheetReviewService";
import { extractYouTubeVideoIdFromSubmissionUrl } from "./scpApprovedFeed";
// 2026-09-05 다타이틀: 시트 행/체크포인트의 게임 값을 레지스트리 id 로 확정한다(분기 없음).
import { resolveSubmissionGameId } from "./programTitles";
import { loadProgramTitleRegistry } from "./programTitlesStore";
import { canonicalScpProgramId } from "./scpProgramAlias";
import { resolveCanonicalProgramIdentity, type CanonicalProgramIdentity } from "./programCanonical";
import { safeDocId } from "./sheetIntakeService";
import { normalizedReminderEmailHash } from "./scpVideoSubmissionReminderStore";
import {
  knownSheetSourceProfileByKey,
  type SheetSourceProfile,
} from "./sheetIntakeRuntime";
import {
  beginSheetOperationApply,
  createSheetOperationPreview,
  inspectSheetOperationPreview,
  sheetOperationFingerprint,
} from "./sheetOperationalPreview";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  makeCache,
  type AuthContext,
  type CallableRequestShape,
} from "./shared";
import {
  readScpIdentityConflictAutomationGate,
  type ScpIdentityAutomationAliasInput,
  type ScpIdentityConflictAutomationReceipt,
} from "./scpLifecycleProfiles";
import { enqueueVideoReviewAutomationOutboxInTransaction } from "./videoReviewAutomationOutbox";
import { videoReviewEvidenceIdentityFingerprints } from "./videoReviewEvidence";
import {
  resolveAuthoritativeVideoReviewProgramScope,
  videoReviewScopePreservingSubmissionUpdate,
} from "./videoReviewProgramScope";
import {
  planVideoReviewSourceInvalidation,
  type VideoReviewSourceInvalidationPlan,
} from "./videoReviewSourceInvalidation";
import {
  datasetSourceProfile,
  nextScpSheetProjectionGeneration,
  replaceScpSheetPublicProjection,
  reserveScpSheetPublicProjectionBuild,
  SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD,
  type ScpSheetPublicProjectionBuildReservation,
} from "./scpSheetPublicProjection";

const SUBMISSION_TASKS_COLLECTION = "submission_tasks";
const SUBMISSIONS_COLLECTION = "submissions";
const BRIDGE_COLLECTION = "sheet3_submission_bridge";
const REVIEW_COUNTS_COLLECTION = "submission_review_counts";
const DEFAULT_PROGRAM_ID = "scp";
const ADMIN_ROLES = ["super_admin", "admin"] as const;
const PREVIEW_ROLES = ["super_admin", "admin", "manager"] as const;
const SHEET3_MANUAL_SOURCE_KEY = "content_review";
const SHEET3_MANUAL_OPERATION = "sheet_source.video_submission_bridge";
const SHEET3_MANUAL_PREVIEW_TOKEN_VERSION = "sheet3-submission-bridge-v1";
const SHEET3_MANUAL_CHECKPOINT_COLLECTION = "sheet3_manual_plan_checkpoints";
const SHEET3_MANUAL_CHECKPOINT_SCHEMA_VERSION = "sheet3-manual-plan-checkpoint-v2";
const SHEET3_MANUAL_CHECKPOINT_CHUNK_SCHEMA_VERSION = "sheet3-manual-plan-checkpoint-chunk-v1";
// v3: ScpVideoReviewSheetRow gained `gameIdDefaulted` (2026-10-14 — 선언 없는 행이 기본
// 타이틀 필터에 걸리지 않게 하는 스탬프 마커). The row fingerprint hashes the whole row,
// so the shape change rotates the row schema version; an in-flight checkpoint from the
// previous version fails resume with checkpointMismatch and is simply re-planned.
const SHEET3_MANUAL_CHECKPOINT_ROW_FINGERPRINT_VERSION = "sheet3-manual-plan-checkpoint-row-v3";
const SHEET3_MANUAL_CHECKPOINT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SHEET3_MANUAL_CHECKPOINT_CHUNK_MAX_BYTES = 700 * 1024;
const SHEET3_MANUAL_CHECKPOINT_CHUNK_MAX_ROWS = 100;
const SHEET3_MANUAL_CHECKPOINT_WRITE_BATCH_SIZE = 400;
const SHEET3_MANUAL_CHECKPOINT_DELETE_BATCH_SIZE = 400;
const SHEET3_SCHEDULED_OPERATION_PREFIX = "sheet3-scheduled-";
const SHEET3_SCHEDULED_RESERVATION_STALE_MS = 12 * 60 * 1000;
export const SHEET3_MANUAL_APPLY_CONFIRMATION = "APPLY SHEET SOURCE content_review";
const forbiddenManualInputKeys = [
  "rows",
  "spreadsheetId",
  "tabName",
  "startRow",
  "endRow",
  "gid",
  "nowIso",
  "sourceId",
] as const;

type BridgeOutcome = "created" | "merged" | "skipped";

type ProcessBridgeRowResult = {
  outcome: BridgeOutcome;
  conflict: boolean;
  submissionId?: string;
  automationGate?: ScpIdentityConflictAutomationReceipt;
};

type BridgeSubmissionMutationPlan = {
  nextSubmission: Record<string, unknown>;
  sourceInvalidation: VideoReviewSourceInvalidationPlan;
};

type RowSourceRef = {
  spreadsheetId: string;
  tabName: string;
  rowNumber: number;
};

type Sheet3ManualSourceControl = {
  sourceVersion: number;
  cutoverVersion: number;
  projectionRevision: number;
  controlFingerprint: string;
};

type Sheet3ManualSnapshot = Sheet3ManualSourceControl & {
  rows: ScpVideoReviewSheetRow[];
  originFingerprint: string;
  planFingerprint: string;
  summary: {
    scanned: number;
    eligible: number;
    ineligible: number;
    projectionRows: number;
  };
};

type Sheet3ManualCheckpoint = Sheet3ManualSnapshot & {
  operationId: string;
  previewExpiresAtIso: string;
  rowsFingerprint: string;
  reservation: ScpSheetPublicProjectionBuildReservation | null;
};

type Sheet3ManualCheckpointChunkEntry = {
  index: number;
  rowFingerprint: string;
  row: ScpVideoReviewSheetRow;
};

type Sheet3ManualCheckpointChunk = {
  schemaVersion: typeof SHEET3_MANUAL_CHECKPOINT_CHUNK_SCHEMA_VERSION;
  checkpointId: string;
  chunkIndex: number;
  startIndex: number;
  rowCount: number;
  chunkFingerprint: string;
  entries: Sheet3ManualCheckpointChunkEntry[];
};

type Sheet3ManualPreviewClaim = {
  previewToken: string;
  previewExpiresAtIso: string;
  sourceVersion: number;
  originFingerprint: string;
  planFingerprint: string;
  status: "pending" | "applying" | "completed" | "failed";
};

export interface RunSheet3SubmissionBridgeOptions {
  rows?: ScpVideoReviewSheetRow[];
  spreadsheetId?: string;
  tabName?: string;
  startRow?: number;
  nowIso?: string;
}

export interface Sheet3SubmissionBridgeResult {
  scanned: number;
  created: number;
  merged: number;
  skipped: number;
  conflicts: number;
}

function authorizeSheet3ManualRequest(
  request: CallableRequestShape,
  actual: boolean,
): AuthContext {
  return assertNonGuestAuth(
    request,
    "sheet3_submission_bridge.run",
    actual ? ADMIN_ROLES : PREVIEW_ROLES,
  );
}

export async function runSheet3SubmissionBridge(options: RunSheet3SubmissionBridgeOptions = {}): Promise<Sheet3SubmissionBridgeResult> {
  const nowIso = cleanText(options.nowIso, new Date().toISOString(), 80);
  if (options.rows === undefined && isConfiguredVideoSheetRead(options)) {
    return runScheduledSheet3SubmissionBridge(nowIso);
  }
  const rows = options.rows ?? await readScpVideoReviewSheetRows({
    spreadsheetId: options.spreadsheetId,
    tabName: options.tabName,
    startRow: options.startRow,
  });
  return applySheet3SubmissionRows(rows, nowIso);
}

async function applySheet3SubmissionRows(
  rows: ScpVideoReviewSheetRow[],
  nowIso: string,
): Promise<Sheet3SubmissionBridgeResult> {
  const result: Sheet3SubmissionBridgeResult = { scanned: rows.length, created: 0, merged: 0, skipped: 0, conflicts: 0 };

  for (const row of rows) {
    const outcome = await processBridgeRow(row, nowIso);
    result[outcome.outcome] += 1;
    if (outcome.conflict) result.conflicts += 1;
  }
  return result;
}

async function runScheduledSheet3SubmissionBridge(
  nowIso: string,
): Promise<Sheet3SubmissionBridgeResult> {
  const profile = requiredContentReviewSourceProfile();
  const snapshot = await readStableSheet3ManualSnapshot(profile);
  const operationId = sheet3ScheduledOperationId(profile, snapshot);
  const reservation =
    await takeOverStaleScheduledSheet3Reservation(profile, snapshot, operationId, nowIso) ??
    await reserveScpSheetPublicProjectionBuild({
      datasetKey: "scpVideoRows",
      projectedAtIso: nowIso,
      expectedSourceVersion: snapshot.sourceVersion,
      expectedCutoverVersion: snapshot.cutoverVersion,
      expectedProjectionRevision: snapshot.projectionRevision,
      operationId,
    });

  // Keep a failed scheduled reservation. The same snapshot operation can
  // immediately resume its exact generation; a changed snapshot may take it
  // over only after the bounded stale interval. Releasing here would allow a
  // later snapshot to reuse a partially-written generation.
  const result = await applySheet3SubmissionRows(snapshot.rows, nowIso);
  const verified = await readStableSheet3ManualSnapshot(
    profile,
    snapshot.sourceVersion,
  );
  assertSheet3ManualSnapshotStable(verified, snapshot);
  await replaceScpSheetPublicProjection({
    datasetKey: "scpVideoRows",
    rows: snapshot.rows as unknown as Record<string, unknown>[],
    projectedAtIso: nowIso,
    expectedSourceVersion: snapshot.sourceVersion,
    expectedCutoverVersion: snapshot.cutoverVersion,
    expectedProjectionRevision: snapshot.projectionRevision,
    operationId,
    reservation,
  });
  return result;
}

export async function runSheet3SubmissionBridgeCallable(request: CallableRequestShape) {
  const data = asRecord(request.data);
  rejectManualSourceOverrides(data);
  const dryRun = data.dryRun !== false;
  const actual = data.actual === true;
  const auth = authorizeSheet3ManualRequest(request, actual);
  if (asString(data.sourceKey) && asString(data.sourceKey) !== SHEET3_MANUAL_SOURCE_KEY) {
    throw failedPrecondition("Sheet3 manual sync is bound to the content_review source.");
  }
  if (actual && dryRun) {
    throw failedPrecondition("Sheet3 actual apply requires dryRun:false.");
  }
  if (!dryRun && !actual) {
    throw failedPrecondition("Sheet3 manual sync is dry-run-first; actual:true is required to apply.");
  }

  const profile = requiredContentReviewSourceProfile();
  const identity = sheet3ManualPreviewIdentity(auth, profile);
  if (dryRun) {
    const snapshot = await readStableSheet3ManualSnapshot(profile);
    const preview = await createSheetOperationPreview({
      ...identity,
      sourceVersion: snapshot.sourceVersion,
      originFingerprint: snapshot.originFingerprint,
      planFingerprint: snapshot.planFingerprint,
      summary: snapshot.summary,
    });
    await persistSheet3ManualCheckpoint({
      identity,
      preview,
      snapshot,
      operationId: sheet3ManualOperationId(preview.previewToken),
      registryOverride: await loadProgramTitleRegistry(canonicalScpProgramId),
    });
    return {
      ok: true,
      dryRun: true,
      actual: false,
      status: "preview_ready",
      canApply: true,
      businessWritesApplied: false,
      confirmation: SHEET3_MANUAL_APPLY_CONFIRMATION,
      ...snapshot.summary,
      sourceVersion: snapshot.sourceVersion,
      originFingerprint: snapshot.originFingerprint,
      planFingerprint: snapshot.planFingerprint,
      previewToken: preview.previewToken,
      previewExpiresAtIso: preview.previewExpiresAtIso,
      cache: makeCache("sheet3_submission_bridge:preview", false, 0),
      behaviorLog: makeBehaviorLog(auth, "sheet3_submission_bridge.run", "success", "scp-automation"),
    };
  }

  if (asString(data.confirm) !== SHEET3_MANUAL_APPLY_CONFIRMATION) {
    throw failedPrecondition("Sheet3 source-bound confirmation is required.");
  }
  const expectedSourceVersion = exactNonNegativeInteger(
    data.expectedSourceVersion,
    "expectedSourceVersion",
  );
  const inspected = await inspectSheetOperationPreview({
    ...identity,
    previewToken: data.previewToken,
  });
  if (inspected.sourceVersion !== expectedSourceVersion) {
    throw previewDrift();
  }
  if (inspected.status === "completed") {
    const replay = replayedSheet3ManualResult(auth, inspected.completedResult ?? {});
    await deleteSheet3ManualCheckpointBestEffort(inspected.previewToken);
    return replay;
  }

  const operationId = sheet3ManualOperationId(inspected.previewToken);
  const checkpoint = await readSheet3ManualCheckpoint({
    identity,
    profile,
    claim: inspected,
    operationId,
    registryOverride: await loadProgramTitleRegistry(canonicalScpProgramId),
  });
  if (inspected.status === "pending") {
    // A pending capability has not started business writes, so preserve the
    // original freshness contract by comparing the live Sheet with the saved
    // reviewed plan immediately before acquiring the execution lease.
    const current = await readStableSheet3ManualSnapshot(profile, expectedSourceVersion);
    assertSheet3ManualSnapshotMatchesCheckpoint(current, checkpoint);
  } else if (inspected.status === "applying") {
    // Once business writes start, the exact reviewed rows and projection
    // reservation, when already bound, are the durable resume plan. Re-reading
    // a mutable Sheet here would strand an idempotent partial operation. A
    // missing reservation is recoverable after the execution lease expires:
    // the previous attempt may have stopped between begin and reserve.
  } else {
    throw checkpointMismatch();
  }

  // Claim the attempt before reserving the shared projection fence. If a
  // concurrent attempt already owns the live lease, this rejects without
  // leaving a newly-created manual reservation behind.
  const begun = await beginSheetOperationApply({
    ...identity,
    previewToken: data.previewToken,
    sourceVersion: checkpoint.sourceVersion,
    originFingerprint: checkpoint.originFingerprint,
    planFingerprint: checkpoint.planFingerprint,
  });
  if (begun.kind === "replay") {
    const replay = replayedSheet3ManualResult(auth, begun.result);
    await deleteSheet3ManualCheckpointBestEffort(inspected.previewToken);
    return replay;
  }

  let reservation = checkpoint.reservation;
  if (!reservation) {
    // The reservation remains the business-write gate. A process stop between
    // begin and bind is recovered by the same receipt after its bounded lease;
    // no row mutation occurs until this reservation is durably checkpointed.
    reservation = await reserveScpSheetPublicProjectionBuild({
      datasetKey: "scpVideoRows",
      projectedAtIso: new Date().toISOString(),
      expectedSourceVersion: checkpoint.sourceVersion,
      expectedCutoverVersion: checkpoint.cutoverVersion,
      expectedProjectionRevision: checkpoint.projectionRevision,
      operationId,
    });
    await bindSheet3ManualCheckpointReservation({
      identity,
      previewToken: inspected.previewToken,
      checkpoint,
      reservation,
    });
  }

  const appliedAtIso = new Date().toISOString();
  // Bridge first. Its row transactions are idempotent; if execution stops,
  // the receipt remains applying and the same operation can safely resume.
  const result = await runSheet3SubmissionBridge({
    rows: checkpoint.rows,
    nowIso: appliedAtIso,
  });
  const completedBase = {
    ok: true,
    dryRun: false,
    actual: true,
    status: "applied",
    replayed: false,
    businessWritesApplied: true,
    ...result,
    sourceVersionBefore: checkpoint.sourceVersion,
    appliedAtIso,
  };
  const projection = await replaceScpSheetPublicProjection({
    datasetKey: "scpVideoRows",
    rows: checkpoint.rows as unknown as Record<string, unknown>[],
    projectedAtIso: appliedAtIso,
    expectedSourceVersion: checkpoint.sourceVersion,
    expectedCutoverVersion: checkpoint.cutoverVersion,
    expectedProjectionRevision: checkpoint.projectionRevision,
    operationId,
    reservation,
    completion: {
      ...identity,
      previewToken: begun.previewToken,
      result: completedBase,
      nowIso: appliedAtIso,
    },
  });
  const response = {
    ...completedBase,
    sourceVersion: projection.sourceVersion,
    projectionGeneration: projection.generation,
    projectionRevision: projection.projectionRevision,
    cache: makeCache("sheet3_submission_bridge:apply", false, 0),
    behaviorLog: makeBehaviorLog(auth, "sheet3_submission_bridge.run", "success", "scp-automation"),
  };
  await deleteSheet3ManualCheckpointBestEffort(inspected.previewToken);
  return response;
}

function rejectManualSourceOverrides(data: Record<string, unknown>): void {
  const supplied = forbiddenManualInputKeys.filter((key) =>
    Object.prototype.hasOwnProperty.call(data, key),
  );
  if (supplied.length > 0) {
    throw invalidArgument(
      `Sheet3 manual sync uses the reviewed server source; caller overrides are forbidden (${supplied.join(", ")}).`,
    );
  }
}

function requiredContentReviewSourceProfile(): SheetSourceProfile {
  const profile = knownSheetSourceProfileByKey("content_review");
  if (!profile) {
    throw failedPrecondition("The reviewed content_review Sheet source profile is unavailable.");
  }
  return profile;
}

function sheet3ManualPreviewIdentity(
  actor: AuthContext,
  profile: SheetSourceProfile,
) {
  return {
    tokenVersion: SHEET3_MANUAL_PREVIEW_TOKEN_VERSION,
    operation: SHEET3_MANUAL_OPERATION,
    sourceKey: SHEET3_MANUAL_SOURCE_KEY,
    sourceId: profile.sourceId,
    actor,
  };
}

function sheet3ManualOperationId(previewToken: string): string {
  return `sheet3-manual-${sheetOperationFingerprint({
    operation: SHEET3_MANUAL_OPERATION,
    previewToken,
  }).slice(0, 40)}`;
}

function sheet3ScheduledOperationId(
  profile: SheetSourceProfile,
  snapshot: Sheet3ManualSnapshot,
): string {
  return `${SHEET3_SCHEDULED_OPERATION_PREFIX}${sheetOperationFingerprint({
    schemaVersion: "sheet3-scheduled-operation-v2",
    sourceId: profile.sourceId,
    sourceTopology: publicSheetSourceTopology(profile),
    sourceVersion: snapshot.sourceVersion,
    cutoverVersion: snapshot.cutoverVersion,
    projectionRevision: snapshot.projectionRevision,
    controlFingerprint: snapshot.controlFingerprint,
    originFingerprint: snapshot.originFingerprint,
    planFingerprint: snapshot.planFingerprint,
    rowFingerprint: sheetOperationFingerprint({
      schemaVersion: "sheet3-scheduled-rows-v1",
      rowFingerprints: snapshot.rows.map(sheet3OperationalRowFingerprint).sort(),
    }),
  }).slice(0, 40)}`;
}

async function takeOverStaleScheduledSheet3Reservation(
  profile: SheetSourceProfile,
  snapshot: Sheet3ManualSnapshot,
  operationId: string,
  nowIso: string,
): Promise<ScpSheetPublicProjectionBuildReservation | null> {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) throw invalidArgument("nowIso must be a valid ISO timestamp.");
  const sourceRef = adminDb.collection("intake_sources").doc(profile.sourceId);
  return adminDb.runTransaction(async (transaction) => {
    const sourceSnapshot = await transaction.get(sourceRef);
    if (!sourceSnapshot.exists) return null;
    const source = asRecord(sourceSnapshot.data());
    validateStoredSheet3Topology(source, profile);
    const current = materializeSheet3ManualSourceControl(profile, true, source);
    if (
      current.sourceVersion !== snapshot.sourceVersion ||
      current.cutoverVersion !== snapshot.cutoverVersion ||
      current.projectionRevision !== snapshot.projectionRevision ||
      current.controlFingerprint !== snapshot.controlFingerprint
    ) {
      return null;
    }

    const builds = asRecord(source.publicProjectionBuilds);
    const existing = scheduledSheet3Reservation(asRecord(builds.scpVideoRows), profile);
    if (
      !existing ||
      existing.operationId === operationId ||
      !existing.operationId.startsWith(SHEET3_SCHEDULED_OPERATION_PREFIX)
    ) {
      return null;
    }
    const reservedAtMs = Date.parse(existing.reservedAtIso);
    if (
      !Number.isFinite(reservedAtMs) ||
      nowMs - reservedAtMs < SHEET3_SCHEDULED_RESERVATION_STALE_MS
    ) {
      return null;
    }

    // A snapshot read that lost a race must never steal a newer fence. Equal
    // fences are intentionally eligible: changed Sheet rows do not themselves
    // advance sourceVersion, so the operation fingerprint is the discriminator.
    if (
      existing.sourceVersionBefore > snapshot.sourceVersion ||
      existing.cutoverVersion > snapshot.cutoverVersion ||
      existing.projectionRevisionBefore > snapshot.projectionRevision
    ) {
      return null;
    }

    const activeProjection = asRecord(asRecord(source.publicProjections).scpVideoRows);
    const activeGeneration = optionalNonNegativeInteger(activeProjection.generation) ?? 0;
    const generationWatermarks = asRecord(
      source[SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD],
    );
    const generation = nextScpSheetProjectionGeneration({
      activeGeneration,
      reservedGeneration: existing.generation,
      sourceVersion: snapshot.sourceVersion,
      generationWatermark: generationWatermarks.scpVideoRows,
    });
    const reservation: ScpSheetPublicProjectionBuildReservation = {
      buildToken: createHash("sha256").update(
        `${operationId}\u0000${existing.buildToken}\u0000${randomUUID()}\u0000${nowIso}`,
      ).digest("hex"),
      operationId,
      datasetKey: "scpVideoRows",
      sourceId: profile.sourceId,
      generation,
      sourceVersionBefore: snapshot.sourceVersion,
      sourceVersion: snapshot.sourceVersion + 1,
      cutoverVersion: snapshot.cutoverVersion,
      projectionRevisionBefore: snapshot.projectionRevision,
      projectionRevision: snapshot.projectionRevision + 1,
      reservedAtIso: nowIso,
    };
    transaction.update(sourceRef, {
      "publicProjectionBuilds.scpVideoRows": reservation,
      [SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD]: {
        ...generationWatermarks,
        scpVideoRows: generation,
      },
      updatedAtIso: nowIso,
      updatedBy: "sheet3_submission_bridge",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return reservation;
  });
}

function scheduledSheet3Reservation(
  value: Record<string, unknown>,
  profile: SheetSourceProfile,
): ScpSheetPublicProjectionBuildReservation | null {
  const operationId = asString(value.operationId);
  const buildToken = asString(value.buildToken);
  const generation = Number(value.generation);
  const sourceVersionBefore = Number(value.sourceVersionBefore);
  const sourceVersion = Number(value.sourceVersion);
  const cutoverVersion = Number(value.cutoverVersion);
  const projectionRevisionBefore = Number(value.projectionRevisionBefore);
  const projectionRevision = Number(value.projectionRevision);
  const reservedAtIso = asString(value.reservedAtIso);
  if (
    !operationId ||
    !/^[a-f0-9]{64}$/.test(buildToken) ||
    value.datasetKey !== "scpVideoRows" ||
    asString(value.sourceId) !== profile.sourceId ||
    !Number.isInteger(generation) || generation <= 0 ||
    !Number.isInteger(sourceVersionBefore) || sourceVersionBefore < 0 ||
    sourceVersion !== sourceVersionBefore + 1 ||
    !Number.isInteger(cutoverVersion) || cutoverVersion < 0 ||
    !Number.isInteger(projectionRevisionBefore) || projectionRevisionBefore < 0 ||
    projectionRevision !== projectionRevisionBefore + 1 ||
    !Number.isFinite(Date.parse(reservedAtIso))
  ) {
    return null;
  }
  return {
    buildToken,
    operationId,
    datasetKey: "scpVideoRows",
    sourceId: profile.sourceId,
    generation,
    sourceVersionBefore,
    sourceVersion,
    cutoverVersion,
    projectionRevisionBefore,
    projectionRevision,
    reservedAtIso,
  };
}

function sheet3ManualCheckpointReference(previewToken: string) {
  return adminDb.collection(SHEET3_MANUAL_CHECKPOINT_COLLECTION).doc(
    `checkpoint-${createHash("sha256").update(previewToken).digest("hex").slice(0, 40)}`,
  );
}

function sheet3ManualActorFingerprint(
  actor: Pick<AuthContext, "userId" | "role" | "team">,
): string {
  return sheetOperationFingerprint({
    userId: actor.userId,
    role: actor.role,
    team: actor.team,
  });
}

async function persistSheet3ManualCheckpoint(input: {
  identity: ReturnType<typeof sheet3ManualPreviewIdentity>;
  preview: {
    previewToken: string;
    previewExpiresAtIso: string;
    sourceVersion: number;
    originFingerprint: string;
    planFingerprint: string;
  };
  snapshot: Sheet3ManualSnapshot;
  operationId: string;
  registryOverride?: unknown;
}): Promise<void> {
  assertSheet3ManualClaimMatchesSnapshot(input.preview, input.snapshot);
  const checkpointRef = sheet3ManualCheckpointReference(input.preview.previewToken);
  const rows = input.snapshot.rows.map((row) => serializableSheet3CheckpointRow(row, input.registryOverride));
  const rowFingerprints = rows.map((row, index) =>
    sheet3ManualCheckpointRowFingerprint(index, row));
  const rowsFingerprint = sheet3ManualCheckpointRowsFingerprint(rowFingerprints);
  const chunks = buildSheet3ManualCheckpointChunks(checkpointRef.id, rows, rowFingerprints);
  const createdAtIso = new Date().toISOString();
  const deleteAfterIso = new Date(
    Date.parse(createdAtIso) + SHEET3_MANUAL_CHECKPOINT_RETENTION_MS,
  ).toISOString();

  // Persist the manifest first. If a later chunk write fails, the bounded
  // `building` record remains discoverable by scpCleanup instead of leaving an
  // unqueryable subcollection orphan.
  await checkpointRef.create({
    schemaVersion: SHEET3_MANUAL_CHECKPOINT_SCHEMA_VERSION,
    status: "building",
    tokenVersion: input.identity.tokenVersion,
    operation: input.identity.operation,
    operationId: input.operationId,
    sourceKey: input.identity.sourceKey,
    sourceId: input.identity.sourceId,
    actorFingerprint: sheet3ManualActorFingerprint(input.identity.actor),
    previewTokenHash: createHash("sha256").update(input.preview.previewToken).digest("hex"),
    previewExpiresAtIso: input.preview.previewExpiresAtIso,
    deleteAfterIso,
    sourceVersion: input.snapshot.sourceVersion,
    cutoverVersion: input.snapshot.cutoverVersion,
    projectionRevision: input.snapshot.projectionRevision,
    controlFingerprint: input.snapshot.controlFingerprint,
    originFingerprint: input.snapshot.originFingerprint,
    planFingerprint: input.snapshot.planFingerprint,
    summary: input.snapshot.summary,
    rowCount: rows.length,
    chunkCount: chunks.length,
    rowsFingerprint,
    reservation: null,
    createdAtIso,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  for (let offset = 0; offset < chunks.length; offset += SHEET3_MANUAL_CHECKPOINT_WRITE_BATCH_SIZE) {
    const batch = adminDb.batch();
    for (
      let index = offset;
      index < Math.min(chunks.length, offset + SHEET3_MANUAL_CHECKPOINT_WRITE_BATCH_SIZE);
      index += 1
    ) {
      const chunk = chunks[index];
      batch.create(
        checkpointRef.collection("chunks").doc(sheet3ManualCheckpointChunkId(index)),
        {
          ...chunk,
          createdAt: FieldValue.serverTimestamp(),
        },
      );
    }
    await batch.commit();
  }

  await checkpointRef.update({
    status: "ready",
    readyAtIso: new Date().toISOString(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function readSheet3ManualCheckpoint(input: {
  identity: ReturnType<typeof sheet3ManualPreviewIdentity>;
  profile: SheetSourceProfile;
  claim: Sheet3ManualPreviewClaim;
  operationId: string;
  registryOverride?: unknown;
}): Promise<Sheet3ManualCheckpoint> {
  const checkpointRef = sheet3ManualCheckpointReference(input.claim.previewToken);
  const [manifestSnapshot, chunkSnapshot] = await Promise.all([
    checkpointRef.get(),
    checkpointRef.collection("chunks").get(),
  ]);
  if (!manifestSnapshot.exists) throw checkpointMismatch();
  const manifest = asRecord(manifestSnapshot.data());
  assertSheet3ManualCheckpointManifest({
    manifest,
    checkpointId: checkpointRef.id,
    identity: input.identity,
    claim: input.claim,
    operationId: input.operationId,
  });
  const rowCount = exactNonNegativeInteger(manifest.rowCount, "checkpoint rowCount");
  const chunkCount = exactPositiveInteger(manifest.chunkCount, "checkpoint chunkCount");
  if (rowCount <= 0 || chunkSnapshot.size !== chunkCount) throw checkpointMismatch();
  const documents = [...chunkSnapshot.docs].sort((left, right) => left.id.localeCompare(right.id));
  const rows: ScpVideoReviewSheetRow[] = [];
  const rowFingerprints: string[] = [];
  for (let chunkIndex = 0; chunkIndex < documents.length; chunkIndex += 1) {
    const document = documents[chunkIndex];
    const stored = asRecord(document.data());
    if (
      document.id !== sheet3ManualCheckpointChunkId(chunkIndex) ||
      stored.schemaVersion !== SHEET3_MANUAL_CHECKPOINT_CHUNK_SCHEMA_VERSION ||
      asString(stored.checkpointId) !== checkpointRef.id ||
      exactNonNegativeInteger(stored.chunkIndex, "checkpoint chunk index") !== chunkIndex ||
      exactNonNegativeInteger(stored.startIndex, "checkpoint chunk startIndex") !== rows.length ||
      !Array.isArray(stored.entries)
    ) {
      throw checkpointMismatch();
    }
    const chunkRowCount = exactPositiveInteger(stored.rowCount, "checkpoint chunk rowCount");
    if (stored.entries.length !== chunkRowCount) throw checkpointMismatch();
    const chunkRowFingerprints: string[] = [];
    for (let offset = 0; offset < stored.entries.length; offset += 1) {
      const entry = asRecord(stored.entries[offset]);
      const index = rows.length;
      if (exactNonNegativeInteger(entry.index, "checkpoint row index") !== index) {
        throw checkpointMismatch();
      }
      const row = parseSheet3CheckpointRow(entry.row, input.registryOverride);
      const rowFingerprint = sheet3ManualCheckpointRowFingerprint(index, row);
      if (asString(entry.rowFingerprint) !== rowFingerprint) throw checkpointMismatch();
      rows.push(row);
      rowFingerprints.push(rowFingerprint);
      chunkRowFingerprints.push(rowFingerprint);
    }
    if (
      asString(stored.chunkFingerprint) !== sheet3ManualCheckpointChunkFingerprint({
        chunkIndex,
        startIndex: rows.length - chunkRowCount,
        rowFingerprints: chunkRowFingerprints,
      })
    ) {
      throw checkpointMismatch();
    }
  }
  if (rows.length !== rowCount) throw checkpointMismatch();
  const rowsFingerprint = sheet3ManualCheckpointRowsFingerprint(rowFingerprints);
  if (asString(manifest.rowsFingerprint) !== rowsFingerprint) throw checkpointMismatch();

  const control: Sheet3ManualSourceControl = {
    sourceVersion: exactNonNegativeInteger(manifest.sourceVersion, "checkpoint sourceVersion"),
    cutoverVersion: exactNonNegativeInteger(manifest.cutoverVersion, "checkpoint cutoverVersion"),
    projectionRevision: exactNonNegativeInteger(manifest.projectionRevision, "checkpoint projectionRevision"),
    controlFingerprint: requiredSheet3CheckpointFingerprint(
      manifest.controlFingerprint,
      "checkpoint controlFingerprint",
    ),
  };
  const snapshot = materializeSheet3ManualSnapshot(input.profile, control, rows);
  assertSheet3ManualClaimMatchesSnapshot(input.claim, snapshot);
  if (
    snapshot.originFingerprint !== asString(manifest.originFingerprint) ||
    snapshot.planFingerprint !== asString(manifest.planFingerprint) ||
    sheetOperationFingerprint(snapshot.summary) !==
      sheetOperationFingerprint(asRecord(manifest.summary))
  ) {
    throw checkpointMismatch();
  }
  const checkpoint: Sheet3ManualCheckpoint = {
    ...snapshot,
    operationId: input.operationId,
    previewExpiresAtIso: input.claim.previewExpiresAtIso,
    rowsFingerprint,
    reservation: null,
  };
  checkpoint.reservation = parseSheet3ManualCheckpointReservation(
    manifest.reservation,
    checkpoint,
  );
  if (
    checkpoint.reservation &&
    asString(manifest.reservationFingerprint) !==
      sheetOperationFingerprint(checkpoint.reservation)
  ) {
    throw checkpointMismatch();
  }
  assertSheet3ManualCheckpointRetentionActive(manifest);
  return checkpoint;
}

async function bindSheet3ManualCheckpointReservation(input: {
  identity: ReturnType<typeof sheet3ManualPreviewIdentity>;
  previewToken: string;
  checkpoint: Sheet3ManualCheckpoint;
  reservation: ScpSheetPublicProjectionBuildReservation;
}): Promise<void> {
  const reservation = parseSheet3ManualCheckpointReservation(
    input.reservation,
    input.checkpoint,
  );
  if (!reservation) throw checkpointMismatch();
  const reservationFingerprint = sheetOperationFingerprint(reservation);
  const checkpointRef = sheet3ManualCheckpointReference(input.previewToken);
  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(checkpointRef);
    if (!snapshot.exists) throw checkpointMismatch();
    const manifest = asRecord(snapshot.data());
    if (
      manifest.schemaVersion !== SHEET3_MANUAL_CHECKPOINT_SCHEMA_VERSION ||
      manifest.status !== "ready" ||
      asString(manifest.operationId) !== input.checkpoint.operationId ||
      asString(manifest.actorFingerprint) !==
        sheet3ManualActorFingerprint(input.identity.actor) ||
      asString(manifest.originFingerprint) !== input.checkpoint.originFingerprint ||
      asString(manifest.planFingerprint) !== input.checkpoint.planFingerprint ||
      asString(manifest.rowsFingerprint) !== input.checkpoint.rowsFingerprint
    ) {
      throw checkpointMismatch();
    }
    assertSheet3ManualCheckpointRetentionActive(manifest);
    const existing = parseSheet3ManualCheckpointReservation(
      manifest.reservation,
      input.checkpoint,
    );
    if (existing && sheetOperationFingerprint(existing) !== reservationFingerprint) {
      throw checkpointMismatch();
    }
    transaction.update(checkpointRef, {
      reservation,
      reservationFingerprint,
      reservationBoundAtIso: new Date().toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

function assertSheet3ManualCheckpointManifest(input: {
  manifest: Record<string, unknown>;
  checkpointId: string;
  identity: ReturnType<typeof sheet3ManualPreviewIdentity>;
  claim: Sheet3ManualPreviewClaim;
  operationId: string;
}): void {
  const manifest = input.manifest;
  assertSheet3ManualCheckpointRetentionActive(manifest);
  if (
    manifest.schemaVersion !== SHEET3_MANUAL_CHECKPOINT_SCHEMA_VERSION ||
    manifest.status !== "ready" ||
    asString(manifest.tokenVersion) !== input.identity.tokenVersion ||
    asString(manifest.operation) !== input.identity.operation ||
    asString(manifest.operationId) !== input.operationId ||
    asString(manifest.sourceKey) !== input.identity.sourceKey ||
    asString(manifest.sourceId) !== input.identity.sourceId ||
    asString(manifest.actorFingerprint) !==
      sheet3ManualActorFingerprint(input.identity.actor) ||
    asString(manifest.previewTokenHash) !==
      createHash("sha256").update(input.claim.previewToken).digest("hex") ||
    asString(manifest.previewExpiresAtIso) !== input.claim.previewExpiresAtIso ||
    exactNonNegativeInteger(manifest.sourceVersion, "checkpoint sourceVersion") !==
      input.claim.sourceVersion ||
    asString(manifest.originFingerprint) !== input.claim.originFingerprint ||
    asString(manifest.planFingerprint) !== input.claim.planFingerprint ||
    input.checkpointId !== sheet3ManualCheckpointReference(input.claim.previewToken).id
  ) {
    throw checkpointMismatch();
  }
}

function assertSheet3ManualCheckpointRetentionActive(
  manifest: Record<string, unknown>,
): void {
  const createdAtMs = Date.parse(requiredCheckpointIso(
    manifest.createdAtIso,
    "checkpoint createdAtIso",
  ));
  const deleteAfterMs = Date.parse(requiredCheckpointIso(
    manifest.deleteAfterIso,
    "checkpoint deleteAfterIso",
  ));
  if (
    deleteAfterMs <= createdAtMs ||
    deleteAfterMs - createdAtMs > SHEET3_MANUAL_CHECKPOINT_RETENTION_MS ||
    deleteAfterMs <= Date.now()
  ) {
    throw checkpointMismatch();
  }
}

function assertSheet3ManualClaimMatchesSnapshot(
  claim: Pick<Sheet3ManualPreviewClaim, "sourceVersion" | "originFingerprint" | "planFingerprint">,
  snapshot: Sheet3ManualSnapshot,
): void {
  if (
    claim.sourceVersion !== snapshot.sourceVersion ||
    claim.originFingerprint !== snapshot.originFingerprint ||
    claim.planFingerprint !== snapshot.planFingerprint
  ) {
    throw checkpointMismatch();
  }
}

function assertSheet3ManualSnapshotMatchesCheckpoint(
  current: Sheet3ManualSnapshot,
  checkpoint: Sheet3ManualCheckpoint,
): void {
  assertSheet3ManualSnapshotStable(current, checkpoint);
}

function assertSheet3ManualSnapshotStable(
  current: Sheet3ManualSnapshot,
  expected: Sheet3ManualSnapshot,
): void {
  if (
    current.sourceVersion !== expected.sourceVersion ||
    current.cutoverVersion !== expected.cutoverVersion ||
    current.projectionRevision !== expected.projectionRevision ||
    current.controlFingerprint !== expected.controlFingerprint ||
    current.originFingerprint !== expected.originFingerprint ||
    current.planFingerprint !== expected.planFingerprint
  ) {
    throw previewDrift();
  }
}

function parseSheet3ManualCheckpointReservation(
  value: unknown,
  checkpoint: Pick<
    Sheet3ManualCheckpoint,
    "operationId" | "sourceVersion" | "cutoverVersion" | "projectionRevision"
  >,
): ScpSheetPublicProjectionBuildReservation | null {
  if (value === null || value === undefined) return null;
  const candidate = asRecord(value);
  const reservation: ScpSheetPublicProjectionBuildReservation = {
    buildToken: requiredSheet3CheckpointFingerprint(candidate.buildToken, "checkpoint buildToken"),
    operationId: requiredCheckpointString(candidate.operationId, "checkpoint operationId"),
    datasetKey: candidate.datasetKey === "scpVideoRows"
      ? "scpVideoRows"
      : (() => { throw checkpointMismatch(); })(),
    sourceId: requiredCheckpointString(candidate.sourceId, "checkpoint sourceId"),
    generation: exactPositiveInteger(candidate.generation, "checkpoint generation"),
    sourceVersionBefore: exactNonNegativeInteger(candidate.sourceVersionBefore, "checkpoint sourceVersionBefore"),
    sourceVersion: exactNonNegativeInteger(candidate.sourceVersion, "checkpoint reserved sourceVersion"),
    cutoverVersion: exactNonNegativeInteger(candidate.cutoverVersion, "checkpoint reserved cutoverVersion"),
    projectionRevisionBefore: exactNonNegativeInteger(candidate.projectionRevisionBefore, "checkpoint projectionRevisionBefore"),
    projectionRevision: exactNonNegativeInteger(candidate.projectionRevision, "checkpoint reserved projectionRevision"),
    reservedAtIso: requiredCheckpointIso(candidate.reservedAtIso, "checkpoint reservedAtIso"),
  };
  const profile = datasetSourceProfile("scpVideoRows");
  if (
    reservation.operationId !== checkpoint.operationId ||
    reservation.sourceId !== profile.sourceId ||
    reservation.sourceVersionBefore !== checkpoint.sourceVersion ||
    reservation.sourceVersion !== checkpoint.sourceVersion + 1 ||
    reservation.cutoverVersion !== checkpoint.cutoverVersion ||
    reservation.projectionRevisionBefore !== checkpoint.projectionRevision ||
    reservation.projectionRevision !== checkpoint.projectionRevision + 1
  ) {
    throw checkpointMismatch();
  }
  return reservation;
}

function sheet3ManualCheckpointChunkId(index: number): string {
  return `chunk-${String(index).padStart(6, "0")}`;
}

function sheet3ManualCheckpointRowFingerprint(
  index: number,
  row: ScpVideoReviewSheetRow,
): string {
  return sheetOperationFingerprint({
    schemaVersion: SHEET3_MANUAL_CHECKPOINT_ROW_FINGERPRINT_VERSION,
    index,
    row,
  });
}

function sheet3ManualCheckpointRowsFingerprint(rowFingerprints: string[]): string {
  return sheetOperationFingerprint({
    schemaVersion: SHEET3_MANUAL_CHECKPOINT_SCHEMA_VERSION,
    rowFingerprints,
  });
}

function sheet3ManualCheckpointChunkFingerprint(input: {
  chunkIndex: number;
  startIndex: number;
  rowFingerprints: string[];
}): string {
  return sheetOperationFingerprint({
    schemaVersion: SHEET3_MANUAL_CHECKPOINT_CHUNK_SCHEMA_VERSION,
    ...input,
  });
}

function buildSheet3ManualCheckpointChunks(
  checkpointId: string,
  rows: ScpVideoReviewSheetRow[],
  rowFingerprints: string[],
): Sheet3ManualCheckpointChunk[] {
  if (rows.length !== rowFingerprints.length || rows.length === 0) {
    throw checkpointMismatch();
  }
  const chunks: Sheet3ManualCheckpointChunk[] = [];
  let entries: Sheet3ManualCheckpointChunkEntry[] = [];

  const finalize = () => {
    if (entries.length === 0) return;
    const chunkIndex = chunks.length;
    const startIndex = entries[0].index;
    const chunk = materializeSheet3ManualCheckpointChunk(
      checkpointId,
      chunkIndex,
      startIndex,
      entries,
    );
    assertSheet3ManualCheckpointChunkSize(chunk);
    chunks.push(chunk);
    entries = [];
  };

  for (let index = 0; index < rows.length; index += 1) {
    const entry: Sheet3ManualCheckpointChunkEntry = {
      index,
      rowFingerprint: rowFingerprints[index],
      row: rows[index],
    };
    const candidate = [...entries, entry];
    const candidateChunk = materializeSheet3ManualCheckpointChunk(
      checkpointId,
      chunks.length,
      candidate[0].index,
      candidate,
    );
    if (
      entries.length > 0 &&
      (candidate.length > SHEET3_MANUAL_CHECKPOINT_CHUNK_MAX_ROWS ||
        sheet3ManualCheckpointChunkByteLength(candidateChunk) >
          SHEET3_MANUAL_CHECKPOINT_CHUNK_MAX_BYTES)
    ) {
      finalize();
      entries = [entry];
      assertSheet3ManualCheckpointChunkSize(materializeSheet3ManualCheckpointChunk(
        checkpointId,
        chunks.length,
        index,
        entries,
      ));
    } else {
      entries = candidate;
    }
  }
  finalize();
  return chunks;
}

function materializeSheet3ManualCheckpointChunk(
  checkpointId: string,
  chunkIndex: number,
  startIndex: number,
  entries: Sheet3ManualCheckpointChunkEntry[],
): Sheet3ManualCheckpointChunk {
  return {
    schemaVersion: SHEET3_MANUAL_CHECKPOINT_CHUNK_SCHEMA_VERSION,
    checkpointId,
    chunkIndex,
    startIndex,
    rowCount: entries.length,
    chunkFingerprint: sheet3ManualCheckpointChunkFingerprint({
      chunkIndex,
      startIndex,
      rowFingerprints: entries.map((entry) => entry.rowFingerprint),
    }),
    entries,
  };
}

function sheet3ManualCheckpointChunkByteLength(chunk: Sheet3ManualCheckpointChunk): number {
  return Buffer.byteLength(JSON.stringify(chunk), "utf8");
}

function assertSheet3ManualCheckpointChunkSize(chunk: Sheet3ManualCheckpointChunk): void {
  if (
    chunk.entries.length === 0 ||
    chunk.entries.length > SHEET3_MANUAL_CHECKPOINT_CHUNK_MAX_ROWS ||
    sheet3ManualCheckpointChunkByteLength(chunk) > SHEET3_MANUAL_CHECKPOINT_CHUNK_MAX_BYTES
  ) {
    throw failedPrecondition("Sheet3 reviewed plan row exceeds the safe checkpoint chunk limit.");
  }
}

async function deleteSheet3ManualCheckpointBestEffort(previewToken: string): Promise<void> {
  try {
    const checkpointRef = sheet3ManualCheckpointReference(previewToken);
    for (const childCollection of ["chunks", "rows"] as const) {
      while (true) {
        const snapshot = await checkpointRef
          .collection(childCollection)
          .limit(SHEET3_MANUAL_CHECKPOINT_DELETE_BATCH_SIZE)
          .get();
        if (snapshot.empty) break;
        const batch = adminDb.batch();
        snapshot.docs.forEach((document) => batch.delete(document.ref));
        await batch.commit();
        if (snapshot.size < SHEET3_MANUAL_CHECKPOINT_DELETE_BATCH_SIZE) break;
      }
    }
    // Parent last: if any child deletion fails, the manifest remains queryable
    // for the bounded scheduled cleanup path.
    await checkpointRef.delete();
  } catch {
    // The completed preview is the durable replay receipt. Checkpoint cleanup
    // is privacy/cost housekeeping and must never turn a committed operation
    // into an apparent apply failure; scpCleanup retries after deleteAfterIso.
  }
}

function serializableSheet3CheckpointRow(row: ScpVideoReviewSheetRow, registryOverride?: unknown): ScpVideoReviewSheetRow {
  return parseSheet3CheckpointRow(JSON.parse(JSON.stringify(row)) as unknown, registryOverride);
}

function parseSheet3CheckpointRow(value: unknown, registryOverride?: unknown): ScpVideoReviewSheetRow {
  const candidate = asRecord(value);
  const status = candidate.status;
  const reviewStatus = candidate.reviewStatus;
  const contentUrls = candidate.contentUrls;
  const rawCells = asRecord(candidate.rawCells);
  if (
    candidate.sourceType !== "google_sheet" ||
    (status !== "approved" && status !== "rejected" && status !== "pending") ||
    (reviewStatus !== "approved" && reviewStatus !== "rejected" && reviewStatus !== "pending") ||
    !Array.isArray(contentUrls) ||
    !contentUrls.every((entry) => typeof entry === "string")
  ) {
    throw checkpointMismatch();
  }
  return {
    id: requiredCheckpointString(candidate.id, "checkpoint row id"),
    rowNumber: exactPositiveInteger(candidate.rowNumber, "checkpoint rowNumber"),
    sheetUrl: requiredCheckpointString(candidate.sheetUrl, "checkpoint sheetUrl", true),
    sourceType: "google_sheet",
    spreadsheetId: requiredCheckpointString(candidate.spreadsheetId, "checkpoint spreadsheetId"),
    tabName: requiredCheckpointString(candidate.tabName, "checkpoint tabName"),
    email: requiredCheckpointString(candidate.email, "checkpoint email", true),
    app: requiredCheckpointString(candidate.app, "checkpoint app", true),
    youtubeUrl: requiredCheckpointString(candidate.youtubeUrl, "checkpoint youtubeUrl", true),
    tiktokUrl: requiredCheckpointString(candidate.tiktokUrl, "checkpoint tiktokUrl", true),
    instagramUrl: requiredCheckpointString(candidate.instagramUrl, "checkpoint instagramUrl", true),
    uploadedFileUrl: requiredCheckpointString(candidate.uploadedFileUrl, "checkpoint uploadedFileUrl", true),
    contentType: requiredCheckpointString(candidate.contentType, "checkpoint contentType", true),
    submittedAtIso: requiredCheckpointString(candidate.submittedAtIso, "checkpoint submittedAtIso", true),
    token: requiredCheckpointString(candidate.token, "checkpoint token", true),
    rawStatus: requiredCheckpointString(
      candidate.rawStatus ??
        (status === "approved"
          ? "approval"
          : status === "rejected"
            ? "disapproval"
            : ""),
      "checkpoint rawStatus",
      true,
    ),
    status,
    reviewStatus,
    rejectedReason: requiredCheckpointString(candidate.rejectedReason, "checkpoint rejectedReason", true),
    mail: requiredCheckpointString(candidate.mail, "checkpoint mail", true),
    // 다타이틀: 체크포인트에 gameId 가 없던 시절(전량)에도 같은 해석기로 재유도해 값이 흔들리지
    // 않게 한다 — 저장된 gameId 우선, 없으면 게임명(app) 정규화, 없으면 프로그램 기본 타이틀.
    ...resolveSubmissionGameId(
      canonicalScpProgramId,
      (typeof candidate.gameId === "string" ? candidate.gameId : "")
        || (typeof candidate.app === "string" ? candidate.app : ""),
      registryOverride,
    ),
    contentUrls: [...contentUrls],
    rawCells: Object.fromEntries(
      Object.entries(rawCells).flatMap(([column, value]) =>
        typeof value === "string" ? [[column, value]] : []),
    ),
    updatedAtIso: requiredCheckpointString(candidate.updatedAtIso, "checkpoint updatedAtIso", true),
  };
}

function requiredSheet3CheckpointFingerprint(value: unknown, field: string): string {
  const normalized = requiredCheckpointString(value, field);
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw checkpointMismatch();
  return normalized;
}

function requiredCheckpointString(
  value: unknown,
  field: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    void field;
    throw checkpointMismatch();
  }
  return value;
}

function requiredCheckpointIso(value: unknown, field: string): string {
  const normalized = requiredCheckpointString(value, field);
  if (!Number.isFinite(Date.parse(normalized))) throw checkpointMismatch();
  return normalized;
}

function exactPositiveInteger(value: unknown, field: string): number {
  const parsed = exactNonNegativeInteger(value, field);
  if (parsed <= 0) throw checkpointMismatch();
  return parsed;
}

function checkpointMismatch(): Error {
  return failedPrecondition(
    "Sheet3 reviewed plan checkpoint is missing or no longer matches its preview and reservation.",
  );
}

async function readStableSheet3ManualSnapshot(
  profile: SheetSourceProfile,
  expectedSourceVersion?: number,
): Promise<Sheet3ManualSnapshot> {
  const before = await readSheet3ManualSourceControl(profile);
  if (
    expectedSourceVersion !== undefined &&
    before.sourceVersion !== expectedSourceVersion
  ) {
    throw previewDrift();
  }

  // No caller-supplied range, rows, source identity, or clock enters this read.
  const rows = await readScpVideoReviewSheetRows();
  if (rows.length === 0) {
    throw failedPrecondition(
      "Sheet3 returned no review rows; manual projection replacement is blocked.",
    );
  }
  for (const row of rows) {
    if (
      row.spreadsheetId !== profile.spreadsheetId ||
      row.tabName !== profile.tabName
    ) {
      throw failedPrecondition("Sheet3 returned rows outside the reviewed content_review topology.");
    }
  }
  const after = await readSheet3ManualSourceControl(profile);
  if (
    before.sourceVersion !== after.sourceVersion ||
    before.controlFingerprint !== after.controlFingerprint
  ) {
    throw previewDrift();
  }

  return materializeSheet3ManualSnapshot(profile, before, rows);
}

function materializeSheet3ManualSnapshot(
  profile: SheetSourceProfile,
  control: Sheet3ManualSourceControl,
  rows: ScpVideoReviewSheetRow[],
): Sheet3ManualSnapshot {
  if (rows.length === 0) {
    throw failedPrecondition(
      "Sheet3 returned no review rows; manual projection replacement is blocked.",
    );
  }
  for (const row of rows) {
    if (
      row.spreadsheetId !== profile.spreadsheetId ||
      row.tabName !== profile.tabName
    ) {
      throw failedPrecondition("Sheet3 returned rows outside the reviewed content_review topology.");
    }
  }
  const eligible = rows.filter(sheet3BridgeRowEligible).length;
  const summary = {
    scanned: rows.length,
    eligible,
    ineligible: rows.length - eligible,
    projectionRows: rows.length,
  };
  const originFingerprint = sheetOperationFingerprint({
    schemaVersion: "sheet3-manual-origin-v1",
    sourceKey: SHEET3_MANUAL_SOURCE_KEY,
    sourceId: profile.sourceId,
    sourceVersion: control.sourceVersion,
    controlFingerprint: control.controlFingerprint,
    topology: publicSheetSourceTopology(profile),
    rowFingerprints: rows.map(sheet3OperationalRowFingerprint).sort(),
  });
  const planFingerprint = sheetOperationFingerprint({
    schemaVersion: "sheet3-manual-plan-v1",
    operation: SHEET3_MANUAL_OPERATION,
    sourceKey: SHEET3_MANUAL_SOURCE_KEY,
    sourceId: profile.sourceId,
    sourceVersion: control.sourceVersion,
    cutoverVersion: control.cutoverVersion,
    projectionRevision: control.projectionRevision,
    originFingerprint,
    summary,
  });
  return {
    ...control,
    rows,
    originFingerprint,
    planFingerprint,
    summary,
  };
}

async function readSheet3ManualSourceControl(
  profile: SheetSourceProfile,
): Promise<Sheet3ManualSourceControl> {
  const snapshot = await adminDb.collection("intake_sources").doc(profile.sourceId).get();
  const source = snapshot.exists ? asRecord(snapshot.data()) : {};
  return materializeSheet3ManualSourceControl(profile, snapshot.exists, source);
}

function materializeSheet3ManualSourceControl(
  profile: SheetSourceProfile,
  exists: boolean,
  source: Record<string, unknown>,
): Sheet3ManualSourceControl {
  if (exists) validateStoredSheet3Topology(source, profile);
  const sourceVersion = Object.prototype.hasOwnProperty.call(source, "sourceVersion")
    ? exactNonNegativeInteger(source.sourceVersion, "sourceVersion")
    : 0;
  const cutover = asRecord(source.cutover);
  const cutoverVersion = Object.prototype.hasOwnProperty.call(cutover, "version")
    ? exactNonNegativeInteger(cutover.version, "cutover.version")
    : 0;
  const projectionRevision = Object.prototype.hasOwnProperty.call(source, "projectionRevision")
    ? exactNonNegativeInteger(source.projectionRevision, "projectionRevision")
    : 0;
  const projection = asRecord(asRecord(source.publicProjections).scpVideoRows);
  const controlFingerprint = sheetOperationFingerprint({
    schemaVersion: "sheet3-manual-control-v1",
    exists,
    topology: publicSheetSourceTopology(profile),
    sourceVersion,
    cutover: {
      state: asString(cutover.state, "shadow"),
      version: cutoverVersion,
    },
    projectionRevision,
    activeProjection: {
      schemaVersion: asString(projection.schemaVersion),
      datasetKey: asString(projection.datasetKey),
      sourceId: asString(projection.sourceId),
      generation: optionalNonNegativeInteger(projection.generation),
      sourceVersion: optionalNonNegativeInteger(projection.sourceVersion),
      cutoverVersion: optionalNonNegativeInteger(projection.cutoverVersion),
      projectionRevision: optionalNonNegativeInteger(projection.projectionRevision),
      canonicalFingerprint: asString(projection.canonicalFingerprint),
    },
  });
  return {
    sourceVersion,
    cutoverVersion,
    projectionRevision,
    controlFingerprint,
  };
}

function validateStoredSheet3Topology(
  source: Record<string, unknown>,
  profile: SheetSourceProfile,
): void {
  for (const [field, expected] of [
    ["id", profile.sourceId],
    ["sourceId", profile.sourceId],
    ["spreadsheetId", profile.spreadsheetId],
    ["tabName", profile.tabName],
    ["gid", profile.gid],
    ["domain", profile.domain],
    ["projectionStrategy", profile.projectionStrategy],
  ] as const) {
    if (
      Object.prototype.hasOwnProperty.call(source, field) &&
      asString(source[field]) !== expected
    ) {
      throw failedPrecondition(`Stored content_review Sheet ${field} drifted from the reviewed topology.`);
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(source, "startRow") &&
    exactNonNegativeInteger(source.startRow, "startRow") !== profile.startRow
  ) {
    throw failedPrecondition("Stored content_review Sheet startRow drifted from the reviewed topology.");
  }
}

function publicSheetSourceTopology(profile: SheetSourceProfile) {
  return {
    key: profile.key,
    sourceId: profile.sourceId,
    spreadsheetId: profile.spreadsheetId,
    tabName: profile.tabName,
    gid: profile.gid,
    startRow: profile.startRow,
    domain: profile.domain,
    projectionStrategy: profile.projectionStrategy,
    canonicalProgramId: profile.canonicalProgramId,
    tabNamePattern: profile.tabNamePattern,
    headerContract: profile.headerContract,
    syncSupported: profile.syncSupported,
  };
}

function sheet3OperationalRowFingerprint(row: ScpVideoReviewSheetRow): string {
  return sheetOperationFingerprint({
    rowNumber: Number.isFinite(row.rowNumber) ? Math.trunc(row.rowNumber) : 0,
    spreadsheetId: cleanText(row.spreadsheetId, "", 160),
    tabName: cleanText(row.tabName, "", 160),
    email: normalizeEmail(row.email),
    app: cleanText(row.app, "", 120),
    contentUrls: contentUrlList(row),
    contentType: cleanText(row.contentType, "", 120),
    submittedAtIso: normalizeSubmittedAtIso(row.submittedAtIso),
    token: cleanToken(row.token),
    status: row.status,
    rejectedReason: cleanText(row.rejectedReason, "", 500),
    mail: cleanText(row.mail, "", 500),
  });
}

function replayedSheet3ManualResult(
  auth: AuthContext,
  stored: Record<string, unknown>,
) {
  return {
    ...stored,
    ok: true,
    dryRun: false,
    actual: true,
    status: "replayed",
    replayed: true,
    businessWritesApplied: false,
    cache: makeCache("sheet3_submission_bridge:apply_replay", true, 0),
    behaviorLog: makeBehaviorLog(auth, "sheet3_submission_bridge.run", "cache_hit", "scp-automation"),
  };
}

function exactNonNegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw invalidArgument(`${field} must be a non-negative integer.`);
  }
  return parsed;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  return exactNonNegativeInteger(value, "stored projection version");
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid-argument", errorCode: "invalid_argument_unauthorized" });
}

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(message), { code: "failed-precondition", errorCode: "failed_precondition_unauthorized" });
}

function previewDrift(): Error {
  return failedPrecondition(
    "Sheet3 source changed after preview; refresh and create a new preview.",
  );
}

export function sheet3BridgeKeyForRow(row: Pick<ScpVideoReviewSheetRow, "token" | "email" | "contentUrls" | "youtubeUrl" | "tiktokUrl" | "instagramUrl" | "uploadedFileUrl" | "submittedAtIso">): string {
  const token = cleanToken(row.token);
  if (token) return `token:${token}`;
  const email = normalizeEmail(row.email);
  const contentUrl = normalizeContentUrl(primaryContentUrl(row));
  const submittedAtIso = normalizeSubmittedAtIso(row.submittedAtIso);
  const digest = createHash("sha256").update(`${email}|${contentUrl}|${submittedAtIso}`).digest("hex").slice(0, 32);
  return `stable:${digest}`;
}

async function processBridgeRow(row: ScpVideoReviewSheetRow, nowIso: string): Promise<ProcessBridgeRowResult> {
  const token = cleanToken(row.token);
  if (!token && !hasStableKeyInputs(row)) return { outcome: "skipped", conflict: false };
  return token ? processTokenRow(row, token, nowIso) : processTokenlessRow(row, nowIso);
}

async function processTokenRow(row: ScpVideoReviewSheetRow, token: string, nowIso: string): Promise<ProcessBridgeRowResult> {
  const bridgeKey = sheet3BridgeKeyForRow(row);
  const ledgerRef = adminDb.collection(BRIDGE_COLLECTION).doc(bridgeKey);
  const taskQuery = adminDb.collection(SUBMISSION_TASKS_COLLECTION).where("submitToken", "==", token).limit(1);

  return adminDb.runTransaction(async (transaction) => {
    const ledgerSnapshot = await transaction.get(ledgerRef);
    if (ledgerSnapshot.exists && asString(ledgerSnapshot.data()?.status) !== "blocked") {
      const refresh = await mergeLedgerHitConflict(
        transaction,
        ledgerRef,
        ledgerSnapshot.data() ?? {},
        row,
        nowIso,
      );
      return {
        outcome: refresh.changed ? "merged" as const : "skipped" as const,
        conflict: refresh.conflict,
        ...(refresh.automationGate ? { automationGate: refresh.automationGate } : {}),
      };
    }

    const taskSnapshot = await transaction.get(taskQuery);
    if (taskSnapshot.empty) {
      // 실프로드: Typeform 토큰은 있으나 앱에서 발급한 submission_tasks가 없는 리드가 정상 케이스다
      // (2026-07-06 실측: Sheet3 103행 전부 태스크 미존재로 skip → 브리지 무용지물).
      // 태스크 미스 시 토큰 bridgeKey를 유지한 채 tokenless 생성 경로와 동일하게 durable submission을 만든다.
      const orphanRef = adminDb.collection(SUBMISSIONS_COLLECTION).doc(bridgeKey);
      const orphanSnapshot = await transaction.get(orphanRef);
      const orphanExisting = orphanSnapshot.exists ? orphanSnapshot.data() ?? {} : null;
      const orphanRowRef = rowSourceRef(row);
      const orphanConflict = orphanExisting ? statusDrift(orphanExisting, row.status) : false;
      const programIdentity = sheet3ProgramIdentity();
      const automationGate = await readSheet3IdentityConflictAutomationGate(
        transaction,
        row,
        programIdentity,
        orphanExisting ?? {},
      );
      if (automationGate) {
        writeIdentityConflictBridgeLedger(
          transaction,
          ledgerRef,
          bridgeKey,
          row,
          programIdentity,
          automationGate,
          nowIso,
        );
        return { outcome: "skipped" as const, conflict: true, automationGate };
      }
      assertExistingProgramIdentity(orphanExisting, programIdentity);
      const orphanPatch = submissionPatch(row, orphanRef.id, nowIso, orphanExisting, {
        bridgeKey,
        rowRef: orphanRowRef,
        programIdentity,
      });
      const orphanMutation = await bridgeSubmissionMutationPlan(transaction, orphanRef.id, orphanExisting, orphanPatch, nowIso);
      await persistBridgeSubmissionMutation(transaction, orphanRef, orphanExisting, orphanMutation, nowIso);
      if (orphanConflict) mergeStatusConflict(transaction, orphanRef, row.status, nowIso);
      writeBridgeLedger(transaction, ledgerRef, bridgeKey, row, orphanRef.path, nowIso);
      if (!orphanExisting) incrementPendingCount(transaction, programIdentity, nowIso);
      return { outcome: orphanExisting ? "merged" as const : "created" as const, conflict: orphanConflict, submissionId: orphanRef.id };
    }
    const taskDoc = taskSnapshot.docs[0];
    const task = taskDoc.data() ?? {};
    const programIdentity = sheet3ProgramIdentity(task);
    const submissionRef = adminDb.collection(SUBMISSIONS_COLLECTION).doc(taskDoc.id);
    const submissionSnapshot = await transaction.get(submissionRef);
    const existing = submissionSnapshot.exists ? submissionSnapshot.data() ?? {} : null;
    const automationGate = await readSheet3IdentityConflictAutomationGate(
      transaction,
      row,
      programIdentity,
      { ...task, id: taskDoc.id, ...(existing ?? {}) },
    );
    if (automationGate) {
      writeIdentityConflictBridgeLedger(
        transaction,
        ledgerRef,
        bridgeKey,
        row,
        programIdentity,
        automationGate,
        nowIso,
        taskDoc.ref.path,
      );
      return { outcome: "skipped" as const, conflict: true, automationGate };
    }
    assertExistingProgramIdentity(existing, programIdentity);
    const rowRef = rowSourceRef(row);
    const conflict = existing ? statusDrift(existing, row.status) : false;
    const patch = submissionPatch(row, submissionRef.id, nowIso, existing, {
      taskId: taskDoc.id,
      taskRef: taskDoc.ref.path,
      task,
      programIdentity,
      bridgeKey,
      rowRef,
    });
    const mutation = await bridgeSubmissionMutationPlan(transaction, submissionRef.id, existing, patch, nowIso);

    if (existing && bridgeAlreadyApplied(existing, row, bridgeKey) && !mutation.sourceInvalidation.sourceChanged) {
      if (conflict) mergeStatusConflict(transaction, submissionRef, row.status, nowIso);
      writeBridgeLedger(transaction, ledgerRef, bridgeKey, row, submissionRef.path, nowIso, taskDoc.ref.path);
      return { outcome: "skipped" as const, conflict };
    }

    await persistBridgeSubmissionMutation(transaction, submissionRef, existing, mutation, nowIso);
    transaction.set(taskDoc.ref, {
      taskStatus: "submitted",
      submittedAtIso: asString(task.submittedAtIso, row.submittedAtIso || nowIso),
      submissionRef: submissionRef.path,
      source: asString(task.source, "scp_submission_task"),
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (conflict) mergeStatusConflict(transaction, submissionRef, row.status, nowIso);
    writeBridgeLedger(transaction, ledgerRef, bridgeKey, row, submissionRef.path, nowIso, taskDoc.ref.path);
    if (!existing) incrementPendingCount(transaction, programIdentity, nowIso);
    return { outcome: existing ? "merged" as const : "created" as const, conflict, submissionId: submissionRef.id };
  });
}

async function processTokenlessRow(row: ScpVideoReviewSheetRow, nowIso: string): Promise<ProcessBridgeRowResult> {
  const bridgeKey = sheet3BridgeKeyForRow(row);
  const ledgerRef = adminDb.collection(BRIDGE_COLLECTION).doc(bridgeKey);
  const submissionRef = adminDb.collection(SUBMISSIONS_COLLECTION).doc(bridgeKey);

  return adminDb.runTransaction(async (transaction) => {
    const ledgerSnapshot = await transaction.get(ledgerRef);
    if (ledgerSnapshot.exists && asString(ledgerSnapshot.data()?.status) !== "blocked") {
      const refresh = await mergeLedgerHitConflict(
        transaction,
        ledgerRef,
        ledgerSnapshot.data() ?? {},
        row,
        nowIso,
      );
      return {
        outcome: refresh.changed ? "merged" as const : "skipped" as const,
        conflict: refresh.conflict,
        ...(refresh.automationGate ? { automationGate: refresh.automationGate } : {}),
      };
    }

    const submissionSnapshot = await transaction.get(submissionRef);
    const existing = submissionSnapshot.exists ? submissionSnapshot.data() ?? {} : null;
    const programIdentity = sheet3ProgramIdentity();
    const automationGate = await readSheet3IdentityConflictAutomationGate(
      transaction,
      row,
      programIdentity,
      existing ?? {},
    );
    if (automationGate) {
      writeIdentityConflictBridgeLedger(
        transaction,
        ledgerRef,
        bridgeKey,
        row,
        programIdentity,
        automationGate,
        nowIso,
      );
      return { outcome: "skipped" as const, conflict: true, automationGate };
    }
    assertExistingProgramIdentity(existing, programIdentity);
    const rowRef = rowSourceRef(row);
    const conflict = existing ? statusDrift(existing, row.status) : false;
    const patch = submissionPatch(row, submissionRef.id, nowIso, existing, { bridgeKey, rowRef, programIdentity });
    const mutation = await bridgeSubmissionMutationPlan(transaction, submissionRef.id, existing, patch, nowIso);
    await persistBridgeSubmissionMutation(transaction, submissionRef, existing, mutation, nowIso);
    if (conflict) mergeStatusConflict(transaction, submissionRef, row.status, nowIso);
    writeBridgeLedger(transaction, ledgerRef, bridgeKey, row, submissionRef.path, nowIso);
    if (!existing) incrementPendingCount(transaction, programIdentity, nowIso);
    return { outcome: existing ? "merged" as const : "created" as const, conflict, submissionId: submissionRef.id };
  });
}

async function mergeLedgerHitConflict(
  transaction: FirebaseFirestore.Transaction,
  ledgerRef: FirebaseFirestore.DocumentReference,
  ledger: Record<string, unknown>,
  row: ScpVideoReviewSheetRow,
  nowIso: string,
): Promise<{
  conflict: boolean;
  changed: boolean;
  automationGate?: ScpIdentityConflictAutomationReceipt;
}> {
  const submissionRefPath = asString(ledger.submissionRef);
  if (!submissionRefPath.startsWith(`${SUBMISSIONS_COLLECTION}/`)) {
    return { conflict: false, changed: false };
  }
  const submissionId = submissionRefPath.slice(`${SUBMISSIONS_COLLECTION}/`.length);
  if (!submissionId || submissionId.includes("/")) {
    return { conflict: false, changed: false };
  }
  const submissionRef = adminDb.collection(SUBMISSIONS_COLLECTION).doc(submissionId);
  const submissionSnapshot = await transaction.get(submissionRef);
  if (!submissionSnapshot.exists) return { conflict: false, changed: false };
  const existing = submissionSnapshot.data() ?? {};
  const programIdentity = sheet3ProgramIdentity(existing);
  const automationGate = await readSheet3IdentityConflictAutomationGate(
    transaction,
    row,
    programIdentity,
    existing,
  );
  if (automationGate) {
    writeIdentityConflictBridgeLedger(
      transaction,
      ledgerRef,
      asString(ledger.bridgeKey, sheet3BridgeKeyForRow(row)),
      row,
      programIdentity,
      automationGate,
      nowIso,
      asString(ledger.taskRef) || undefined,
    );
    return { conflict: true, changed: false, automationGate };
  }
  const conflict = statusDrift(existing, row.status);
  const nextRowHash = sheetRowHash(row);
  const changed = asString(ledger.rowHash) !== nextRowHash;
  if (changed) {
    const taskId = safeIdentifier(existing.taskId);
    const taskRef = cleanText(existing.taskRef, "", 300);
    const patch = submissionPatch(
      row,
      submissionId,
      nowIso,
      existing,
      {
        bridgeKey: asString(ledger.bridgeKey, sheet3BridgeKeyForRow(row)),
        rowRef: rowSourceRef(row),
        ...(taskId ? { taskId } : {}),
        ...(taskRef ? { taskRef } : {}),
        task: existing,
        programIdentity,
      },
    );
    const mutation = await bridgeSubmissionMutationPlan(transaction, submissionId, existing, patch, nowIso);
    await persistBridgeSubmissionMutation(transaction, submissionRef, existing, mutation, nowIso);
    transaction.set(ledgerRef, {
      rowHash: nextRowHash,
      sheetStatus: row.status,
      sourceRowRefs: FieldValue.arrayUnion(rowSourceRef(row)),
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  if (conflict) mergeStatusConflict(transaction, submissionRef, row.status, nowIso);
  return { conflict, changed };
}

function submissionPatch(
  row: ScpVideoReviewSheetRow,
  submissionId: string,
  nowIso: string,
  existing: Record<string, unknown> | null,
  input: {
    bridgeKey: string;
    rowRef: RowSourceRef;
    taskId?: string;
    taskRef?: string;
    task?: Record<string, unknown>;
    programIdentity: CanonicalProgramIdentity;
  },
): Record<string, unknown> {
  const task = input.task ?? {};
  const programIdentity = input.programIdentity;
  const contentUrls = contentUrlList(row);
  const token = cleanToken(row.token);
  const email = normalizeEmail(row.email) || normalizeEmail(task.email);
  const submittedAtIso = normalizeSubmittedAtIso(row.submittedAtIso) || nowIso;
  const base: Record<string, unknown> = {
    id: submissionId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.taskRef ? { taskRef: input.taskRef } : {}),
    creatorId: safeIdentifier(task.creatorId) || `CR_${safeDocId(email || input.bridgeKey)}`,
    programId: programIdentity.canonicalProgramId,
    canonicalProgramId: programIdentity.canonicalProgramId,
    programIdAlias: programIdentity.rawProgramIdAlias,
    leadId: safeIdentifier(task.leadId) || null,
    creatorLinkRef: cleanText(task.creatorLinkRef, "", 300) || null,
    campaign: cleanText(task.campaign, "", 240) || null,
    email,
    normalizedEmailHash: normalizedReminderEmailHash(email) || null,
    app: cleanText(row.app, cleanText(task.app, cleanText(task.appName, "Weapon RPG SCP", 120), 120), 120),
    youtubeUrl: cleanText(row.youtubeUrl, "", 2000),
    tiktokUrl: cleanText(row.tiktokUrl, "", 2000),
    instaUrl: cleanText(row.instagramUrl, "", 2000),
    instagramUrl: cleanText(row.instagramUrl, "", 2000),
    uploadedFileUrl: cleanText(row.uploadedFileUrl, "", 2000),
    contentUrls,
    // 2026-09-05 P2 리뷰 수리: contentType 미선언 시 폴백은 이 행이 착지한 타이틀의 슬러그에서
    // 나온다(`<slug>_scp_video`) — "weaponrpg_scp_video" 는 사실 XP Hero 패키지명이었다. 과거에
    // 그 상수로 저장된 문서는 그대로 유효하다(아무 소비자도 contentType 값을 비교하지 않는다).
    contentType: cleanText(
      row.contentType,
      cleanText(task.contentType, `${(row.gameId || "").replace(/-/g, "_") || "scp"}_scp_video`, 120),
      120,
    ),
    // 다타이틀: 행이 확정한 레지스트리 타이틀 id 를 제출 문서에 그대로 싣는다(검수 루브릭 입력).
    // gameIdDefaulted 도 항상 명시한다 — update/merge 쓰기에서 키를 빼면 이전 스탬프가
    // stale true 로 남아 해석된 gameId 까지 필터 증거에서 빠진다.
    gameId: row.gameId,
    gameIdUnresolved: row.gameIdUnresolved,
    gameIdDefaulted: row.gameIdDefaulted === true,
    submittedAtIso,
    token,
    source: "sheet3_bridge",
    bridgeKey: input.bridgeKey,
    sourceRowRefs: existing ? FieldValue.arrayUnion(input.rowRef) : [input.rowRef],
    sheetStatus: row.status,
    sheetRejectedReason: cleanText(row.rejectedReason, "", 500),
    sheetMail: cleanText(row.mail, "", 500),
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  };
  base.videoReviewEvidenceIdentityFingerprints = videoReviewEvidenceIdentityFingerprints(base);

  if (!existing) {
    return {
      ...base,
      reviewStatus: "pending",
      rejectedReason: "",
      reviewNotes: [],
      reviewMemo: "",
      aiRecommendation: null,
      aiRecommendationMultimodal: null,
      videoReviewEvidence: null,
      videoReviewEvidenceBinding: null,
      latestVideoReviewDecisionRef: null,
      payment: null,
      payableStatus: "not_payable",
      revisions: [],
      resubmissionCount: 0,
      countsInitialized: true,
      submittedAt: FieldValue.serverTimestamp(),
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    };
  }

  return base;
}

async function bridgeSubmissionMutationPlan(
  transaction: FirebaseFirestore.Transaction,
  submissionId: string,
  existing: Record<string, unknown> | null,
  patch: Record<string, unknown>,
  nowIso: string,
): Promise<BridgeSubmissionMutationPlan> {
  const nextSubmission = {
    ...(existing ?? {}),
    ...patch,
    id: submissionId,
  };
  const programScope = await resolveAuthoritativeVideoReviewProgramScope(nextSubmission, {
    recordReader: async (collection, documentId) => {
      const related = await transaction.get(adminDb.collection(collection).doc(documentId));
      return related.exists ? { id: related.id, ...(related.data() ?? {}) } : null;
    },
  });
  return {
    nextSubmission,
    sourceInvalidation: planVideoReviewSourceInvalidation({
      existingSubmission: existing,
      nextSubmission,
      nowIso,
      programScope,
    }),
  };
}

async function persistBridgeSubmissionMutation(
  transaction: FirebaseFirestore.Transaction,
  submissionRef: FirebaseFirestore.DocumentReference,
  existing: Record<string, unknown> | null,
  mutation: BridgeSubmissionMutationPlan,
  nowIso: string,
): Promise<void> {
  const { sourceInvalidation } = mutation;
  if (!existing || sourceInvalidation.sourceChanged) {
    await enqueueVideoReviewAutomationOutboxInTransaction(transaction, {
      submissionId: submissionRef.id,
      kind: "ai_recommendation",
      nowIso,
      source: mutation.nextSubmission,
      sourceFingerprint: sourceInvalidation.nextAutomationSourceFingerprint,
      programScope: sourceInvalidation.programScope,
    });
  }
  const patch = {
    ...mutation.nextSubmission,
    ...sourceInvalidation.submissionPatch,
  };
  // Existing submissions may carry review projections for multiple programs. Only the exact
  // program/policy generation whose source changed is replaced; sibling scopes remain intact.
  if (existing) {
    transaction.update(submissionRef, videoReviewScopePreservingSubmissionUpdate(patch));
  } else {
    transaction.set(submissionRef, patch, { merge: true });
  }
}

async function readSheet3IdentityConflictAutomationGate(
  transaction: FirebaseFirestore.Transaction,
  row: ScpVideoReviewSheetRow,
  programIdentity: CanonicalProgramIdentity,
  record: Record<string, unknown>,
): Promise<ScpIdentityConflictAutomationReceipt | null> {
  const aliases: ScpIdentityAutomationAliasInput[] = [
    { kind: "leadId", value: record.leadId },
    { kind: "creatorId", value: record.creatorId },
    { kind: "channelId", value: record.channelId },
    { kind: "channelId", value: record.youtubeChannelId },
    { kind: "email", value: row.email },
    { kind: "email", value: record.email },
    { kind: "email", value: record.creatorEmail },
    { kind: "submissionId", value: record.submissionId },
    { kind: "submissionId", value: record.id },
    { kind: "trackingId", value: record.trackingId },
    { kind: "conversationId", value: record.conversationId },
  ];
  return readScpIdentityConflictAutomationGate({
    programId: programIdentity.canonicalProgramId,
    aliases,
  }, transaction);
}

function writeIdentityConflictBridgeLedger(
  transaction: FirebaseFirestore.Transaction,
  ledgerRef: FirebaseFirestore.DocumentReference,
  bridgeKey: string,
  row: ScpVideoReviewSheetRow,
  programIdentity: CanonicalProgramIdentity,
  automationGate: ScpIdentityConflictAutomationReceipt,
  nowIso: string,
  taskRef?: string,
): void {
  transaction.set(ledgerRef, {
    id: bridgeKey,
    bridgeKey,
    status: "blocked",
    processingLeaseExpiresAtIso: null,
    source: "sheet3_bridge",
    programId: programIdentity.canonicalProgramId,
    canonicalProgramId: programIdentity.canonicalProgramId,
    programIdAlias: programIdentity.rawProgramIdAlias,
    ...(taskRef ? { taskRef } : {}),
    automationBlocked: true,
    automationBlockReasonCode: automationGate.reasonCode,
    reasonCode: automationGate.reasonCode,
    canonicalIdentityHash: automationGate.canonicalIdentityHash,
    resolutionState: automationGate.resolutionState,
    identityConflictSourceRefs: automationGate.sourceRefs,
    automationGate,
    sourceRowRefs: [rowSourceRef(row)],
    rowHash: sheetRowHash(row),
    sheetStatus: row.status,
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

function writeBridgeLedger(
  transaction: FirebaseFirestore.Transaction,
  ledgerRef: FirebaseFirestore.DocumentReference,
  bridgeKey: string,
  row: ScpVideoReviewSheetRow,
  submissionRef: string,
  nowIso: string,
  taskRef?: string,
) {
  transaction.set(ledgerRef, {
    id: bridgeKey,
    bridgeKey,
    status: "processed",
    automationBlocked: false,
    processingLeaseExpiresAtIso: null,
    source: "sheet3_bridge",
    submissionRef,
    ...(taskRef ? { taskRef } : {}),
    sourceRowRefs: [rowSourceRef(row)],
    rowHash: sheetRowHash(row),
    sheetStatus: row.status,
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

function mergeStatusConflict(
  transaction: FirebaseFirestore.Transaction,
  submissionRef: FirebaseFirestore.DocumentReference,
  sheetStatus: ScpVideoSheetStatus,
  nowIso: string,
) {
  transaction.set(submissionRef, {
    sheetStatusConflict: { sheetStatus, observedAtIso: nowIso },
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

function incrementPendingCount(
  transaction: FirebaseFirestore.Transaction,
  programIdentity: CanonicalProgramIdentity,
  nowIso: string,
) {
  transaction.set(adminDb.collection(REVIEW_COUNTS_COLLECTION).doc(programIdentity.canonicalProgramId), {
    id: programIdentity.canonicalProgramId,
    programId: programIdentity.canonicalProgramId,
    canonicalProgramId: programIdentity.canonicalProgramId,
    programIdAlias: programIdentity.rawProgramIdAlias,
    statuses: { pending: FieldValue.increment(1) },
    payments: { not_payable: FieldValue.increment(1) },
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}
function sheet3ProgramIdentity(record: Record<string, unknown> = {}): CanonicalProgramIdentity {
  return resolveCanonicalProgramIdentity({
    programId: record.programId,
    canonicalProgramId: record.canonicalProgramId,
    programIdAlias: record.programIdAlias,
    fallbackProgramId: DEFAULT_PROGRAM_ID,
  });
}

function assertExistingProgramIdentity(
  existing: Record<string, unknown> | null,
  expected: CanonicalProgramIdentity,
): void {
  if (!existing) return;
  const existingIdentity = sheet3ProgramIdentity(existing);
  if (existingIdentity.canonicalProgramId !== expected.canonicalProgramId) {
    throw Object.assign(new Error("program_identity_conflict"), { code: "program_identity_conflict", errorCode: "assert_existing_program_identity_program_identity_conflict" });
  }
}

function bridgeAlreadyApplied(existing: Record<string, unknown>, row: ScpVideoReviewSheetRow, bridgeKey: string): boolean {
  if (asString(existing.bridgeKey) === bridgeKey) return true;
  const rowRef = rowSourceRef(row);
  const refs = Array.isArray(existing.sourceRowRefs) ? existing.sourceRowRefs : [];
  return refs.some((value) => {
    const record = asRecord(value);
    return asString(record.spreadsheetId) === rowRef.spreadsheetId &&
      asString(record.tabName) === rowRef.tabName &&
      Number(record.rowNumber) === rowRef.rowNumber;
  });
}

function statusDrift(existing: Record<string, unknown>, sheetStatus: ScpVideoSheetStatus): boolean {
  const current = canonicalReviewStatus(existing.reviewStatus);
  const sheet = canonicalReviewStatus(sheetStatus);
  return Boolean(current && sheet && current !== "pending" && sheet !== "pending" && current !== sheet);
}

function canonicalReviewStatus(value: unknown): string {
  const status = cleanText(value, "", 80).toLowerCase();
  if (status === "pass" || status === "passed" || status === "approved") return "approved";
  return status;
}

function rowSourceRef(row: ScpVideoReviewSheetRow): RowSourceRef {
  return {
    spreadsheetId: cleanText(row.spreadsheetId, "", 160),
    tabName: cleanText(row.tabName, "", 160),
    rowNumber: Number.isFinite(row.rowNumber) ? Math.trunc(row.rowNumber) : 0,
  };
}

function sheetRowHash(row: ScpVideoReviewSheetRow): string {
  return createHash("sha256").update(JSON.stringify({
    email: normalizeEmail(row.email),
    contentUrls: contentUrlList(row),
    submittedAtIso: normalizeSubmittedAtIso(row.submittedAtIso),
    token: cleanToken(row.token),
    status: row.status,
    rejectedReason: cleanText(row.rejectedReason, "", 500),
  })).digest("hex");
}

function isConfiguredVideoSheetRead(
  options: RunSheet3SubmissionBridgeOptions,
): boolean {
  const profile = datasetSourceProfile("scpVideoRows");
  const spreadsheetId = cleanText(
    options.spreadsheetId,
    profile.spreadsheetId,
    160,
  );
  const tabName = cleanText(options.tabName, profile.tabName, 160);
  return spreadsheetId === profile.spreadsheetId && tabName === profile.tabName;
}

// 백필 스크립트와 공유하는 tokenless 자격 가드 — 라이브 브리지가 만들지 않을 submission을
// 백필도 만들지 않도록 동일 조건(email+대표 콘텐츠 URL+submittedAt)을 단일 소스로 export한다.
export function sheet3BridgeRowEligible(row: Pick<ScpVideoReviewSheetRow, "token" | "email" | "contentUrls" | "youtubeUrl" | "tiktokUrl" | "instagramUrl" | "uploadedFileUrl" | "submittedAtIso">): boolean {
  return Boolean(cleanToken(row.token)) || hasStableKeyInputs(row as ScpVideoReviewSheetRow);
}

function hasStableKeyInputs(row: ScpVideoReviewSheetRow): boolean {
  return Boolean(normalizeEmail(row.email) && primaryContentUrl(row) && normalizeSubmittedAtIso(row.submittedAtIso));
}

function contentUrlList(row: Pick<ScpVideoReviewSheetRow, "contentUrls" | "youtubeUrl" | "tiktokUrl" | "instagramUrl" | "uploadedFileUrl">): string[] {
  const source = Array.isArray(row.contentUrls) && row.contentUrls.length
    ? row.contentUrls
    : [row.youtubeUrl, row.tiktokUrl, row.instagramUrl, row.uploadedFileUrl];
  const out: string[] = [];
  for (const value of source) {
    const normalized = normalizeContentUrl(value);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function primaryContentUrl(row: Pick<ScpVideoReviewSheetRow, "contentUrls" | "youtubeUrl" | "tiktokUrl" | "instagramUrl" | "uploadedFileUrl">): string {
  return contentUrlList(row)[0] ?? "";
}

function normalizeContentUrl(value: unknown): string {
  const raw = cleanText(value, "", 2000);
  if (!raw) return "";
  const youtubeVideoId = extractYouTubeVideoIdFromSubmissionUrl(raw);
  if (youtubeVideoId) return `yt:${youtubeVideoId}`;
  try {
    const parsed = new URL(raw);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";
    parsed.search = "";
    const path = parsed.pathname.replace(/\/+$/, "");
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${parsed.protocol}//${parsed.hostname}${port}${path}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

function normalizeSubmittedAtIso(value: unknown): string {
  const raw = cleanText(value, "", 120);
  if (!raw) return "";
  // epoch 숫자 문자열(초 10자리/밀리초 13자리)은 Date.parse가 NaN이라 우회 키가 되므로 명시 처리한다.
  if (/^\d{10}(\d{3})?$/.test(raw)) {
    const epochMs = raw.length === 13 ? Number(raw) : Number(raw) * 1000;
    if (Number.isFinite(epochMs)) return new Date(Math.floor(epochMs / 1000) * 1000).toISOString();
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return raw;
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

function normalizeEmail(value: unknown): string {
  return cleanText(value, "", 240).toLowerCase();
}

function cleanToken(value: unknown): string {
  return cleanText(value, "", 160).replace(/[^a-zA-Z0-9_-]/g, "");
}

function safeIdentifier(value: unknown): string {
  const raw = cleanText(value, "", 240);
  return raw ? safeDocId(raw) : "";
}

function cleanText(value: unknown, fallback = "", max = 1000): string {
  if (typeof value === "string") return (value.trim() || fallback).slice(0, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value).slice(0, max);
  return fallback.slice(0, max);
}
