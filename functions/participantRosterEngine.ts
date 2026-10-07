import { createHash, randomUUID } from "node:crypto";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  canonicalProgramIdForSheetSourceProfile,
  knownSheetSourceProfileByKey,
  resolveSheetIntakeWriteGate,
  validateSheetSourceHeaderContract,
  validateSheetSourceTabContract,
  type SheetRuntimeEnvironment,
  type SheetSourceProfile,
} from "./sheetIntakeRuntime";
import type { SheetCutoverRecord, SheetCutoverState } from "./sheetIntakeTypes";
import {
  beginSheetOperationApply,
  completeSheetOperationApplyInTransaction,
  createSheetOperationPreview,
  failSheetOperationApply,
  inspectSheetOperationPreview,
  sheetOperationFingerprint,
  sheetOperationPreviewReference,
} from "./sheetOperationalPreview";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  makeBehaviorLog,
  type AuthContext,
  type CallableRequestShape,
} from "./shared";

const ACTION = "sheet_intake.participant_roster_sync";
const STATUS_ACTION = "sheet_intake.participant_roster_status";
const ADMIN_ROLES = ["super_admin", "admin"] as const;
const READ_ROLES = ["super_admin", "admin", "manager", "viewer"] as const;
const MAX_PRIMARY_ROWS = 400;
const MAX_MATERIALIZED_ROWS = 2_000;
const ROSTER_SCHEMA_VERSION = "participant-roster-projection-v1";
const PARTICIPANT_ROSTER_COLUMNS = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
] as const;

type ParticipantRosterActivityState =
  | "active"
  | "active_limited"
  | "onboarded_no_submission"
  | "dormant"
  | "withdrawn"
  | "reactivation_requested"
  | "unknown";

interface ParticipantRosterCollections {
  source: string;
  entries: string;
  audits: string;
}

const DEFAULT_COLLECTIONS: Readonly<ParticipantRosterCollections> = Object.freeze({
  source: "intake_sources",
  entries: "participant_roster_entries",
  audits: "participant_roster_sync_audits",
});

export const PARTICIPANT_ROSTER_APPLY_CONFIRMATION =
  "APPLY SHEET SOURCE participant_registry";
const PARTICIPANT_ROSTER_PREVIEW_TOKEN_VERSION = "participant-roster-sync-v1";
const PARTICIPANT_ROSTER_OPERATION = "sheet_source.participant_roster_sync";

type ParticipantRosterSourceRole = "primary" | "legacy";

export interface ParticipantRosterSheetSource {
  role: ParticipantRosterSourceRole;
  sourceId: string;
  spreadsheetId: string;
  tabName: string;
  gid: string;
}

export interface ParticipantRosterSheetSnapshot {
  source: {
    role?: unknown;
    sourceId?: unknown;
    spreadsheetId?: unknown;
    tabName?: unknown;
    gid?: unknown;
  };
  headers: Readonly<Record<string, unknown>>;
  rows: ReadonlyArray<{
    rowNumber?: unknown;
    cells?: unknown;
  }>;
}

export interface ParticipantRosterEntry {
  id: string;
  sourceId: string;
  schemaVersion: typeof ROSTER_SCHEMA_VERSION;
  identityHash: string;
  participantFingerprint: string;
  canonicalProgramId: string;
  programId: string;
  creatorId: string;
  email: string;
  emailId: string;
  channelName: string;
  channelId: string;
  channelUrl: string;
  country: string;
  adjustLink: string;
  appsflyerLink: string;
  userId: string;
  legacyCampaignLinkRaw: string;
  legacyCampaignLink: string;
  legacyCampaignName: string;
  legacyStartedPeriodRaw: string;
  legacyStartedPeriod: string;
  activityStateRaw: string;
  activityState: ParticipantRosterActivityState;
  programName: string;
  campaignName: string;
  source: {
    role: ParticipantRosterSourceRole;
    sourceId: string;
    spreadsheetId: string;
    tabName: string;
    gid: string;
    rowNumber: number;
    rowHash: string;
  };
}

export interface NormalizedParticipantRosterSnapshot {
  source: ParticipantRosterSheetSource;
  canonicalProgramId: string;
  headerFingerprint: string;
  canonicalFingerprint: string;
  rows: ParticipantRosterEntry[];
}

export interface ParticipantRosterParity {
  status: "match" | "mismatch";
  primaryCount: number;
  legacyCount: number;
  matchingCount: number;
  changedCount: number;
  primaryOnlyCount: number;
  legacyOnlyCount: number;
  changedIdentityHashes: string[];
  primaryOnlyIdentityHashes: string[];
  legacyOnlyIdentityHashes: string[];
}

interface ParticipantRosterParityUnavailable {
  status: "unavailable";
  primaryCount: number;
  legacyCount: null;
  matchingCount: 0;
  changedCount: 0;
  primaryOnlyCount: 0;
  legacyOnlyCount: 0;
  changedIdentityHashes: [];
  primaryOnlyIdentityHashes: [];
  legacyOnlyIdentityHashes: [];
  reason: "legacy_read_failed";
}

export interface ParticipantRosterProjectionPlan {
  upserts: ParticipantRosterEntry[];
  deletes: never[];
  newEntryCount: number;
  retainedAbsentCount: number;
  retainedAbsentIdentityHashes: string[];
  currentVersion: number;
  nextVersion: number;
  idempotent: boolean;
}

export interface ParticipantRosterEngineDependencies {
  db?: Firestore;
  collections?: Partial<ParticipantRosterCollections>;
  readSheet?: (
    source: ParticipantRosterSheetSource,
  ) => Promise<ParticipantRosterSheetSnapshot>;
  environment?: SheetRuntimeEnvironment;
  now?: () => Date;
  auditId?: () => string;
}

interface MaterializedRosterState {
  control: Record<string, unknown>;
  existing: Record<string, unknown>[];
}

interface ParsedEngineInput {
  dryRun: boolean;
  actual: boolean;
  confirm: string;
  previewToken: string;
  targetCutoverState: SheetCutoverState | null;
  expectedCutoverVersion: number | null;
  expectedProjectionVersion: number | null;
  expectedSourceVersion: number | null;
}

export function normalizeParticipantRosterSnapshot(
  input: ParticipantRosterSheetSnapshot,
): NormalizedParticipantRosterSnapshot {
  const profile = participantRosterProfile();
  const source = normalizeAndValidateSource(input.source, profile);
  const headerValidation = validateSheetSourceHeaderContract(
    profile,
    asRecord(input.headers),
  );
  if (!headerValidation.valid) {
    throw failedPrecondition(
      `Participant roster schema drift at columns ${[
        ...headerValidation.missingColumns,
        ...headerValidation.mismatchedColumns,
      ].join(",") || "unknown"}.`,
    );
  }
  if (!Array.isArray(input.rows)) {
    throw invalidArgument("Participant roster rows must be an array.");
  }
  if (input.rows.length > MAX_PRIMARY_ROWS) {
    throw failedPrecondition(
      `Participant roster exceeds the reviewed ${MAX_PRIMARY_ROWS}-row transaction limit.`,
    );
  }

  const canonicalProgramId = canonicalProgramIdForSheetSourceProfile(profile);
  const rows: ParticipantRosterEntry[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < input.rows.length; index += 1) {
    const raw = asRecord(input.rows[index]);
    const cells = normalizeCells(raw.cells);
    if (Object.values(cells).every((value) => !value)) continue;
    const rowNumber = positiveInteger(raw.rowNumber, profile.startRow + index);
    const participant = normalizeParticipantRow({
      source,
      sourceId: profile.sourceId,
      canonicalProgramId,
      rowNumber,
      cells,
    });
    if (ids.has(participant.id)) {
      throw failedPrecondition(
        `Duplicate stable identity in participant roster at row ${rowNumber}.`,
      );
    }
    ids.add(participant.id);
    rows.push(participant);
  }
  rows.sort((left, right) => left.id.localeCompare(right.id));

  return {
    source,
    canonicalProgramId,
    headerFingerprint: headerValidation.actualFingerprint,
    canonicalFingerprint: sha256(
      rows.map((entry) => `${entry.id}:${entry.participantFingerprint}`).join("\n"),
    ),
    rows,
  };
}

export function compareParticipantRosterParity(
  primary: NormalizedParticipantRosterSnapshot,
  legacy: NormalizedParticipantRosterSnapshot,
): ParticipantRosterParity {
  assertSnapshotRole(primary, "primary");
  assertSnapshotRole(legacy, "legacy");
  const primaryByIdentity = new Map(
    primary.rows.map((entry) => [entry.identityHash, entry] as const),
  );
  const legacyByIdentity = new Map(
    legacy.rows.map((entry) => [entry.identityHash, entry] as const),
  );
  const changedIdentityHashes: string[] = [];
  const primaryOnlyIdentityHashes: string[] = [];
  const legacyOnlyIdentityHashes: string[] = [];
  let matchingCount = 0;

  for (const [identityHash, entry] of primaryByIdentity) {
    const legacyEntry = legacyByIdentity.get(identityHash);
    if (!legacyEntry) {
      primaryOnlyIdentityHashes.push(identityHash);
    } else if (legacyEntry.participantFingerprint === entry.participantFingerprint) {
      matchingCount += 1;
    } else {
      changedIdentityHashes.push(identityHash);
    }
  }
  for (const identityHash of legacyByIdentity.keys()) {
    if (!primaryByIdentity.has(identityHash)) {
      legacyOnlyIdentityHashes.push(identityHash);
    }
  }
  changedIdentityHashes.sort();
  primaryOnlyIdentityHashes.sort();
  legacyOnlyIdentityHashes.sort();
  const mismatchCount =
    changedIdentityHashes.length +
    primaryOnlyIdentityHashes.length +
    legacyOnlyIdentityHashes.length;

  return {
    status: mismatchCount === 0 ? "match" : "mismatch",
    primaryCount: primary.rows.length,
    legacyCount: legacy.rows.length,
    matchingCount,
    changedCount: changedIdentityHashes.length,
    primaryOnlyCount: primaryOnlyIdentityHashes.length,
    legacyOnlyCount: legacyOnlyIdentityHashes.length,
    changedIdentityHashes,
    primaryOnlyIdentityHashes,
    legacyOnlyIdentityHashes,
  };
}

export function planParticipantRosterProjection(input: {
  primary: NormalizedParticipantRosterSnapshot;
  existing: ReadonlyArray<Record<string, unknown> | ParticipantRosterEntry>;
  currentVersion: number;
}): ParticipantRosterProjectionPlan {
  assertSnapshotRole(input.primary, "primary");
  const currentVersion = nonNegativeInteger(input.currentVersion, 0);
  const existingById = new Map(
    input.existing
      .map((entry) => asRecord(entry))
      .filter((entry) => asString(entry.id))
      .map((entry) => [asString(entry.id), entry] as const),
  );
  const primaryIds = new Set(input.primary.rows.map((entry) => entry.id));
  const upserts = input.primary.rows.filter(
    (entry) => !sameMaterializedEntry(existingById.get(entry.id), entry),
  );
  const newEntryCount = upserts.filter((entry) => !existingById.has(entry.id)).length;
  const retainedAbsentIdentityHashes = [...existingById.entries()]
    .filter(([id]) => !primaryIds.has(id))
    .map(([, entry]) => asString(entry.identityHash))
    .filter(Boolean)
    .sort();
  const idempotent = upserts.length === 0;

  return {
    upserts,
    deletes: [],
    newEntryCount,
    retainedAbsentCount: [...existingById.keys()].filter((id) => !primaryIds.has(id)).length,
    retainedAbsentIdentityHashes,
    currentVersion,
    nextVersion: idempotent ? currentVersion : currentVersion + 1,
    idempotent,
  };
}

export async function runParticipantRosterEngine(
  request: CallableRequestShape,
  dependencies: ParticipantRosterEngineDependencies = {},
) {
  const auth = assertNonGuestAuth(request, ACTION, ADMIN_ROLES);
  const data = asRecord(request.data);
  const parsed = parseEngineInput(data);
  if (!parsed.dryRun) {
    if (!parsed.actual) {
      throw failedPrecondition("Participant roster apply requires actual:true.");
    }
    if (parsed.confirm !== PARTICIPANT_ROSTER_APPLY_CONFIRMATION) {
      throw failedPrecondition("Participant roster source-bound confirmation is required.");
    }
    if (!parsed.previewToken) {
      throw failedPrecondition("Participant roster apply requires a previewToken.");
    }
  }

  const profile = participantRosterProfile();
  const collections = resolveCollections(dependencies.collections);
  const db = dependencies.db ?? adminDb;
  const now = dependencies.now ?? (() => new Date());
  const operationNowIso = now().toISOString();
  const previewIdentity = {
    tokenVersion: PARTICIPANT_ROSTER_PREVIEW_TOKEN_VERSION,
    operation: PARTICIPANT_ROSTER_OPERATION,
    sourceKey: profile.key,
    sourceId: profile.sourceId,
    actor: auth,
  };
  if (!parsed.dryRun) {
    const prior = await inspectSheetOperationPreview({
      ...previewIdentity,
      db,
      previewToken: parsed.previewToken,
      nowIso: operationNowIso,
    });
    if (prior.status === "completed" && prior.completedResult) {
      return {
        ok: true,
        ...prior.completedResult,
        canApply: false,
        businessWritesApplied: false,
        idempotentReplay: true,
        behaviorLog: makeBehaviorLog(auth, ACTION, "success", "scp-automation"),
      };
    }
  }
  const readSheet = dependencies.readSheet ?? readParticipantRosterSheet;
  const auditId = dependencies.auditId ?? (() => `participant-roster-${randomUUID()}`);
  const primarySource = primarySheetSource(profile);
  const legacySource = legacySheetSource(profile);

  const [sheetReads, state] = await Promise.all([
    readRosterSnapshots(readSheet, primarySource, legacySource),
    readMaterializedState(db, collections, profile.sourceId),
  ]);
  const primary = normalizeParticipantRosterSnapshot(sheetReads.primary);
  const legacy = sheetReads.legacy
    ? normalizeParticipantRosterSnapshot(sheetReads.legacy)
    : null;
  const parity: ParticipantRosterParity | ParticipantRosterParityUnavailable = legacy
    ? compareParticipantRosterParity(primary, legacy)
    : unavailableParity(primary.rows.length);
  const currentProjectionVersion = projectionVersion(state.control);
  const plan = planParticipantRosterProjection({
    primary,
    existing: state.existing,
    currentVersion: currentProjectionVersion,
  });
  const currentCutover = readCutover(state.control.cutover, operationNowIso);
  const proposedCutover = proposeCutover({
    current: currentCutover,
    target: parsed.targetCutoverState,
    parity,
    primaryCount: primary.rows.length,
    legacyAvailable: Boolean(legacy),
    actor: auth.userId,
    nowIso: operationNowIso,
  });
  const baseResult = publicEngineResult({
    dryRun: parsed.dryRun,
    primary,
    parity,
    plan,
    cutover: proposedCutover,
    currentMaterializedCount: state.existing.length,
    legacyReadError: sheetReads.legacyReadError,
  });
  const currentSourceVersion = nonNegativeInteger(state.control.sourceVersion, 0);
  const originFingerprint = participantRosterOriginFingerprint(primary, legacy);
  const planFingerprint = participantRosterPlanFingerprint({
    primary,
    parity,
    plan,
    currentSourceVersion,
    currentProjectionVersion,
    currentCutover,
    targetCutoverState: parsed.targetCutoverState,
  });
  if (parsed.dryRun) {
    validateExpectedCutoverVersion(parsed, currentCutover);
    const claim = await createSheetOperationPreview({
      ...previewIdentity,
      db,
      nowIso: operationNowIso,
      sourceVersion: currentSourceVersion,
      originFingerprint,
      planFingerprint,
      summary: {
        primaryCount: primary.rows.length,
        materializedCount: state.existing.length,
        upsertCount: plan.upserts.length,
        retainedAbsentCount: plan.retainedAbsentCount,
        parityStatus: parity.status,
        sourceVersion: currentSourceVersion,
        projectionVersion: currentProjectionVersion,
        cutoverVersion: currentCutover.version,
      },
    });
    return {
      ok: true,
      ...baseResult,
      ...claim,
      expectedSourceVersion: currentSourceVersion,
      expectedProjectionVersion: currentProjectionVersion,
      expectedCutoverVersion: currentCutover.version,
      confirmation: PARTICIPANT_ROSTER_APPLY_CONFIRMATION,
      canApply: true,
      businessWritesApplied: false,
      idempotentReplay: false,
      appliedCount: 0,
      behaviorLog: makeBehaviorLog(
        auth,
        ACTION,
        "success",
        "scp-automation",
      ),
    };
  }

  validateExpectedCutoverVersion(parsed, currentCutover);
  if (
    parsed.expectedSourceVersion === null ||
    parsed.expectedProjectionVersion === null ||
    parsed.expectedCutoverVersion === null
  ) {
    throw failedPrecondition(
      "Participant roster apply requires the source, projection, and cutover versions returned by preview.",
    );
  }
  if (
    parsed.expectedSourceVersion !== currentSourceVersion ||
    parsed.expectedProjectionVersion !== currentProjectionVersion ||
    parsed.expectedCutoverVersion !== currentCutover.version
  ) {
    throw failedPrecondition("Participant roster state changed after preview; create a new preview.");
  }

  resolveSheetIntakeWriteGate({
    action: "participant_roster_sync",
    sourceKey: profile.key,
    spreadsheetId: profile.spreadsheetId,
    sourceId: profile.sourceId,
    environment: dependencies.environment,
  });

  const begin = await beginSheetOperationApply({
    ...previewIdentity,
    db,
    previewToken: parsed.previewToken,
    nowIso: operationNowIso,
    sourceVersion: currentSourceVersion,
    originFingerprint,
    planFingerprint,
  });
  if (begin.kind === "replay") {
    return {
      ok: true,
      ...begin.result,
      canApply: false,
      businessWritesApplied: false,
      idempotentReplay: true,
      behaviorLog: makeBehaviorLog(auth, ACTION, "success", "scp-automation"),
    };
  }

  try {
    const applied = await applyParticipantRosterProjection({
      db,
      collections,
      profile,
      auth,
      primary,
      parity,
      parsed,
      expectedSourceVersion: currentSourceVersion,
      expectedProjectionVersion: currentProjectionVersion,
      expectedCutoverVersion: currentCutover.version,
      materializedExisting: state.existing,
      legacyAvailable: Boolean(legacy),
      legacyReadError: sheetReads.legacyReadError,
      nowIso: operationNowIso,
      auditId: auditId(),
      previewToken: begin.previewToken,
    });
    return {
      ok: true,
      ...applied.result,
      canApply: false,
      businessWritesApplied: true,
      idempotentReplay: false,
      behaviorLog: makeBehaviorLog(auth, ACTION, "success", "scp-automation"),
    };
  } catch (error) {
    await failSheetOperationApply({
      db,
      previewToken: begin.previewToken,
      tokenVersion: PARTICIPANT_ROSTER_PREVIEW_TOKEN_VERSION,
      failureCode: errorCode(error),
      nowIso: operationNowIso,
    });
    const recovered = await inspectSheetOperationPreview({
      ...previewIdentity,
      db,
      previewToken: begin.previewToken,
      nowIso: operationNowIso,
    }).catch(() => null);
    if (recovered?.status === "completed" && recovered.completedResult) {
      return {
        ok: true,
        ...recovered.completedResult,
        canApply: false,
        businessWritesApplied: false,
        idempotentReplay: true,
        behaviorLog: makeBehaviorLog(auth, ACTION, "success", "scp-automation"),
      };
    }
    throw error;
  }
}

export async function syncParticipantRoster(request: CallableRequestShape) {
  return runParticipantRosterEngine(request);
}

export async function getParticipantRosterStatus(
  request: CallableRequestShape,
) {
  const auth = assertNonGuestAuth(request, STATUS_ACTION, READ_ROLES);
  const profile = participantRosterProfile();
  const source = await adminDb.collection(DEFAULT_COLLECTIONS.source).doc(profile.sourceId).get();
  const record = asRecord(source.data());
  const projection = asRecord(record.participantRosterProjection);
  const parity = asRecord(projection.parity);
  const nowIso = new Date().toISOString();

  return {
    ok: true,
    sourceReady: source.exists,
    sourceKey: profile.key,
    canonicalProgramId: canonicalProgramIdForSheetSourceProfile(profile),
    topology: {
      primary: publicSource(primarySheetSource(profile)),
      legacy: publicSource(legacySheetSource(profile)),
      legacyRole: "parity_rollback_only" as const,
      sheetWriteAllowed: false,
    },
    projection: {
      schemaVersion: optionalText(projection.schemaVersion),
      version: nonNegativeInteger(projection.version, 0),
      primaryRowCount: nonNegativeInteger(projection.primaryRowCount, 0),
      materializedRowCount: nonNegativeInteger(projection.materializedRowCount, 0),
      retainedAbsentCount: nonNegativeInteger(projection.retainedAbsentCount, 0),
      primaryFingerprint: hashOrNull(projection.primaryFingerprint),
      completedAtIso: isoOrNull(projection.completedAtIso),
      parity: {
        status: parityStatus(parity.status),
        primaryCount: nonNegativeInteger(parity.primaryCount, 0),
        legacyCount: nullableCount(parity.legacyCount),
        matchingCount: nonNegativeInteger(parity.matchingCount, 0),
        changedCount: nonNegativeInteger(parity.changedCount, 0),
        primaryOnlyCount: nonNegativeInteger(parity.primaryOnlyCount, 0),
        legacyOnlyCount: nonNegativeInteger(parity.legacyOnlyCount, 0),
      },
    },
    cutover: publicCutover(readCutover(record.cutover, nowIso)),
    behaviorLog: makeBehaviorLog(
      auth,
      STATUS_ACTION,
      "success",
      "scp-automation",
    ),
  };
}

async function applyParticipantRosterProjection(input: {
  db: Firestore;
  collections: ParticipantRosterCollections;
  profile: SheetSourceProfile;
  auth: AuthContext;
  primary: NormalizedParticipantRosterSnapshot;
  parity: ParticipantRosterParity | ParticipantRosterParityUnavailable;
  parsed: ParsedEngineInput;
  expectedSourceVersion: number;
  expectedProjectionVersion: number;
  expectedCutoverVersion: number;
  materializedExisting: Record<string, unknown>[];
  legacyAvailable: boolean;
  legacyReadError: string | null;
  nowIso: string;
  auditId: string;
  previewToken: string;
}) {
  const sourceRef = input.db.collection(input.collections.source).doc(input.profile.sourceId);
  const auditRef = input.db.collection(input.collections.audits).doc(safeDocumentId(input.auditId));

  return input.db.runTransaction(async (transaction) => {
    const previewRef = sheetOperationPreviewReference({
      db: input.db,
      previewToken: input.previewToken,
      tokenVersion: PARTICIPANT_ROSTER_PREVIEW_TOKEN_VERSION,
    });
    const [sourceSnapshot, previewSnapshot] = await Promise.all([
      transaction.get(sourceRef),
      transaction.get(previewRef),
    ]);
    const control = asRecord(sourceSnapshot.data());
    const actualSourceVersion = nonNegativeInteger(control.sourceVersion, 0);
    if (actualSourceVersion !== input.expectedSourceVersion) {
      throw failedPrecondition(
        "Participant roster source changed after preview; run dry-run again.",
      );
    }
    const actualProjectionVersion = projectionVersion(control);
    if (actualProjectionVersion !== input.expectedProjectionVersion) {
      throw failedPrecondition(
        "Participant roster projection changed after preview; run dry-run again.",
      );
    }
    const currentCutover = readCutover(control.cutover, input.nowIso);
    if (currentCutover.version !== input.expectedCutoverVersion) {
      throw failedPrecondition(
        "Participant roster cutover changed after preview; run dry-run again.",
      );
    }
    validateExpectedCutoverVersion(input.parsed, currentCutover);

    const entryRefs = input.primary.rows.map((entry) =>
      input.db.collection(input.collections.entries).doc(entry.id),
    );
    const entrySnapshots = entryRefs.length
      ? await transaction.getAll(...entryRefs)
      : [];
    const currentPrimaryEntries = entrySnapshots
      .filter((snapshot) => snapshot.exists)
      .map((snapshot) => ({ id: snapshot.id, ...(snapshot.data() ?? {}) }));
    const primaryIds = new Set(input.primary.rows.map((entry) => entry.id));
    const transactionExisting = [
      ...input.materializedExisting.filter(
        (existing) => !primaryIds.has(asString(existing.id)),
      ),
      ...currentPrimaryEntries,
    ];
    const plan = planParticipantRosterProjection({
      primary: input.primary,
      existing: transactionExisting,
      currentVersion: actualProjectionVersion,
    });
    const cutover = proposeCutover({
      current: currentCutover,
      target: input.parsed.targetCutoverState,
      parity: input.parity,
      primaryCount: input.primary.rows.length,
      legacyAvailable: input.legacyAvailable,
      actor: input.auth.userId,
      nowIso: input.nowIso,
    });
    const previousProjection = asRecord(control.participantRosterProjection);
    const previousMaterializedCount = Math.max(
      transactionExisting.length,
      nonNegativeInteger(
        previousProjection.materializedRowCount,
        transactionExisting.length,
      ),
    );
    const materializedRowCount = previousMaterializedCount + plan.newEntryCount;

    for (const entry of plan.upserts) {
      const ref = input.db.collection(input.collections.entries).doc(entry.id);
      transaction.set(
        ref,
        {
          ...entry,
          projectionVersion: plan.nextVersion,
          projectedAtIso: input.nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    const cutoverChanged = cutover.version !== currentCutover.version;
    const sourceVersion = actualSourceVersion +
      (plan.idempotent && !cutoverChanged ? 0 : 1);
    transaction.set(
      sourceRef,
      {
        id: input.profile.sourceId,
        sourceType: "google_sheet",
        spreadsheetId: input.profile.spreadsheetId,
        tabName: input.profile.tabName,
        gid: input.profile.gid,
        status: "active",
        canonicalProgramId: input.primary.canonicalProgramId,
        programId: input.primary.canonicalProgramId,
        sourceContract: {
          domain: input.profile.domain,
          projectionStrategy: input.profile.projectionStrategy,
          canonicalProgramId: input.primary.canonicalProgramId,
          primaryAuthoritative: true,
          legacyRole: "parity_rollback_only",
          sheetWriteAllowed: false,
        },
        cutover,
        sourceVersion,
        projectionRevision: plan.nextVersion,
        participantRosterProjection: {
          schemaVersion: ROSTER_SCHEMA_VERSION,
          version: plan.nextVersion,
          primaryFingerprint: input.primary.canonicalFingerprint,
          primaryHeaderFingerprint: input.primary.headerFingerprint,
          primaryRowCount: input.primary.rows.length,
          materializedRowCount,
          retainedAbsentCount: plan.retainedAbsentCount,
          idempotent: plan.idempotent,
          legacyReadErrorCode: input.legacyReadError ? "legacy_read_failed" : null,
          parity: publicParityCounts(input.parity),
          completedAtIso: input.nowIso,
        },
        lastSyncStatus: "success",
        lastSyncAtIso: input.nowIso,
        updatedAtIso: input.nowIso,
        updatedBy: input.auth.userId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.set(auditRef, {
      action: ACTION,
      schemaVersion: ROSTER_SCHEMA_VERSION,
      sourceId: input.profile.sourceId,
      canonicalProgramId: input.primary.canonicalProgramId,
      actorUid: input.auth.userId,
      actorRole: input.auth.role,
      actorTeam: input.auth.team,
      mode: "apply",
      projectionVersionBefore: actualProjectionVersion,
      projectionVersionAfter: plan.nextVersion,
      cutoverVersionBefore: currentCutover.version,
      cutoverVersionAfter: cutover.version,
      cutoverStateBefore: currentCutover.state,
      cutoverStateAfter: cutover.state,
      primaryFingerprint: input.primary.canonicalFingerprint,
      primaryCount: input.primary.rows.length,
      appliedCount: plan.upserts.length,
      retainedAbsentCount: plan.retainedAbsentCount,
      parity: publicParityCounts(input.parity),
      diff: {
        changedIdentityHashes:
          input.parity.status === "unavailable" ? [] : input.parity.changedIdentityHashes,
        primaryOnlyIdentityHashes:
          input.parity.status === "unavailable" ? [] : input.parity.primaryOnlyIdentityHashes,
        legacyOnlyIdentityHashes:
          input.parity.status === "unavailable" ? [] : input.parity.legacyOnlyIdentityHashes,
        retainedAbsentIdentityHashes: plan.retainedAbsentIdentityHashes,
      },
      createdAtIso: input.nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });

    const result = {
      ...publicEngineResult({
        dryRun: false,
        primary: input.primary,
        parity: input.parity,
        plan,
        cutover,
        currentMaterializedCount: input.materializedExisting.length,
        legacyReadError: input.legacyReadError,
      }),
      sourceVersion,
      appliedCount: plan.upserts.length,
      auditRef: `participant_roster_audit_${sha256(auditRef.path).slice(0, 16)}`,
    };
    completeSheetOperationApplyInTransaction({
      transaction,
      snapshot: previewSnapshot,
      previewToken: input.previewToken,
      tokenVersion: PARTICIPANT_ROSTER_PREVIEW_TOKEN_VERSION,
      operation: PARTICIPANT_ROSTER_OPERATION,
      sourceKey: input.profile.key,
      sourceId: input.profile.sourceId,
      actor: input.auth,
      result,
      nowIso: input.nowIso,
    });

    return { plan, cutover, sourceVersion, auditPath: auditRef.path, result };
  });
}

async function readRosterSnapshots(
  readSheet: NonNullable<ParticipantRosterEngineDependencies["readSheet"]>,
  primarySource: ParticipantRosterSheetSource,
  legacySource: ParticipantRosterSheetSource,
) {
  const [primaryResult, legacyResult] = await Promise.allSettled([
    readSheet(primarySource),
    readSheet(legacySource),
  ]);
  if (primaryResult.status === "rejected") {
    throw failedPrecondition(
      `Primary participant roster read failed: ${safeErrorMessage(primaryResult.reason)}`,
    );
  }
  if (legacyResult.status === "rejected") {
    return {
      primary: primaryResult.value,
      legacy: null,
      legacyReadError: safeErrorMessage(legacyResult.reason),
    };
  }
  return {
    primary: primaryResult.value,
    legacy: legacyResult.value,
    legacyReadError: null,
  };
}

async function readMaterializedState(
  db: Firestore,
  collections: ParticipantRosterCollections,
  sourceId: string,
): Promise<MaterializedRosterState> {
  const [control, entries] = await Promise.all([
    db.collection(collections.source).doc(sourceId).get(),
    db.collection(collections.entries)
      .where("sourceId", "==", sourceId)
      .limit(MAX_MATERIALIZED_ROWS + 1)
      .get(),
  ]);
  if (entries.size > MAX_MATERIALIZED_ROWS) {
    throw failedPrecondition(
      "Participant roster materialization exceeds the reviewed safety limit.",
    );
  }
  return {
    control: asRecord(control.data()),
    existing: entries.docs.map((snapshot) => ({
      id: snapshot.id,
      ...(snapshot.data() ?? {}),
    })),
  };
}

async function readParticipantRosterSheet(
  source: ParticipantRosterSheetSource,
): Promise<ParticipantRosterSheetSnapshot> {
  const credentials = await sheetCredentials();
  const resolvedTabName = await resolveSheetTitleByGid(source, credentials);
  if (resolvedTabName !== source.tabName) {
    throw failedPrecondition(
      `Participant roster gid ${source.gid} resolved to an unreviewed tab.`,
    );
  }
  const title = quoteSheetTitle(resolvedTabName);
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheetId)}/values:batchGet`,
  );
  url.searchParams.append("ranges", `${title}!A1:N1`);
  url.searchParams.append("ranges", `${title}!A2:N${MAX_PRIMARY_ROWS + 2}`);
  url.searchParams.set("majorDimension", "ROWS");
  applyApiKey(url, credentials);
  const response = await fetchWithTimeout(url, credentials);
  if (!response.ok) {
    throw failedPrecondition(
      `Participant roster values read failed with HTTP ${response.status}.`,
    );
  }
  const body = await response.json() as {
    valueRanges?: Array<{ values?: unknown[] }>;
  };
  const ranges = Array.isArray(body.valueRanges) ? body.valueRanges : [];
  const headerValues = Array.isArray(ranges[0]?.values) ? ranges[0]?.values : [];
  const dataValues = Array.isArray(ranges[1]?.values) ? ranges[1]?.values : [];
  const headers = cellsAtoN(headerValues[0]);
  const rows = dataValues.map((values, index) => ({
    rowNumber: 2 + index,
    cells: cellsAtoN(values),
  }));
  if (rows.length > MAX_PRIMARY_ROWS) {
    throw failedPrecondition(
      `Participant roster exceeds the reviewed ${MAX_PRIMARY_ROWS}-row transaction limit.`,
    );
  }
  return { source, headers, rows };
}

async function resolveSheetTitleByGid(
  source: ParticipantRosterSheetSource,
  credentials: SheetCredentials,
): Promise<string> {
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheetId)}`,
  );
  url.searchParams.set("includeGridData", "false");
  url.searchParams.set("fields", "sheets.properties(sheetId,title)");
  applyApiKey(url, credentials);
  const response = await fetchWithTimeout(url, credentials);
  if (!response.ok) {
    throw failedPrecondition(
      `Participant roster metadata read failed with HTTP ${response.status}.`,
    );
  }
  const body = await response.json() as {
    sheets?: Array<{ properties?: { sheetId?: unknown; title?: unknown } }>;
  };
  const expected = Number(source.gid);
  const match = Array.isArray(body.sheets)
    ? body.sheets.find((sheet) => Number(sheet.properties?.sheetId) === expected)
    : undefined;
  return normalizedText(match?.properties?.title);
}

interface SheetCredentials {
  accessToken: string;
  apiKey: string;
}

async function sheetCredentials(): Promise<SheetCredentials> {
  const accessToken =
    environmentText("GOOGLE_SHEETS_ACCESS_TOKEN") ||
    environmentText("SHEETS_ACCESS_TOKEN") ||
    await metadataAccessToken();
  const apiKey =
    environmentText("GOOGLE_SHEETS_API_KEY") || environmentText("SHEETS_API_KEY");
  if (!accessToken && !apiKey) {
    throw failedPrecondition(
      "Google Sheets credentials are not configured for participant roster read.",
    );
  }
  return { accessToken, apiKey };
}

async function metadataAccessToken(): Promise<string> {
  if (process.env.FUNCTIONS_EMULATOR === "true" || process.env.FIRESTORE_EMULATOR_HOST) {
    return "";
  }
  if (!process.env.K_SERVICE && !process.env.FUNCTION_TARGET && !process.env.FUNCTION_NAME) {
    return "";
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      {
        headers: { "Metadata-Flavor": "Google" },
        signal: controller.signal,
      },
    );
    if (!response.ok) return "";
    const body = await response.json() as { access_token?: unknown };
    return asString(body.access_token);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithTimeout(
  url: URL,
  credentials: SheetCredentials,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    return await fetch(url, {
      headers: credentials.accessToken
        ? { Authorization: `Bearer ${credentials.accessToken}` }
        : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeAndValidateSource(
  rawSource: ParticipantRosterSheetSnapshot["source"],
  profile: SheetSourceProfile,
): ParticipantRosterSheetSource {
  const rawRole = asString(rawSource.role);
  const role: ParticipantRosterSourceRole = rawRole === "primary"
    ? "primary"
    : rawRole === "legacy" || rawRole === "parity_rollback_only"
      ? "legacy"
      : invalidSourceRole();
  const expected = role === "primary"
    ? primarySheetSource(profile)
    : legacySheetSource(profile);
  const source: ParticipantRosterSheetSource = {
    role,
    sourceId: asString(rawSource.sourceId, expected.sourceId),
    spreadsheetId: asString(rawSource.spreadsheetId),
    tabName: asString(rawSource.tabName),
    gid: asString(rawSource.gid),
  };
  if (
    source.sourceId !== expected.sourceId ||
    source.spreadsheetId !== expected.spreadsheetId ||
    source.tabName !== expected.tabName ||
    source.gid !== expected.gid
  ) {
    throw failedPrecondition(
      `Participant roster ${role} source does not match the reviewed topology.`,
    );
  }
  if (role === "primary" && !validateSheetSourceTabContract(profile, source.tabName).valid) {
    throw failedPrecondition("Participant roster primary tab contract drifted.");
  }
  return source;
}

function normalizeParticipantRow(input: {
  source: ParticipantRosterSheetSource;
  sourceId: string;
  canonicalProgramId: string;
  rowNumber: number;
  cells: Record<string, string>;
}): ParticipantRosterEntry {
  const creatorId = normalizedIdentityText(input.cells.A);
  const email = normalizeEmail(input.cells.B);
  const emailId = normalizedIdentityText(input.cells.C);
  const channelName = normalizedText(input.cells.D);
  const channelUrl = normalizeUrl(input.cells.E);
  const channelId = (() => {
    if (!channelUrl) return "";
    try {
      const url = new URL(channelUrl);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const parts = url.pathname.split("/").filter(Boolean);
      const candidate =
        (host === "youtube.com" || host === "m.youtube.com")
        && parts[0] === "channel"
          ? parts[1] ?? ""
          : "";
      return /^UC[A-Za-z0-9_-]{22}$/.test(candidate) ? candidate : "";
    } catch {
      return "";
    }
  })();
  const country = normalizedText(input.cells.F).toLocaleUpperCase("en-US");
  const adjustLink = normalizeUrl(input.cells.G);
  const appsflyerLink = normalizeUrl(input.cells.H);
  const userId = normalizedIdentityText(input.cells.I);
  const legacyCampaignLinkRaw = normalizedText(input.cells.J);
  const legacyCampaignLink = normalizeStrictUrl(legacyCampaignLinkRaw);
  const legacyCampaignName = legacyCampaignLink ? "" : legacyCampaignLinkRaw;
  const legacyStartedPeriodRaw = normalizedText(input.cells.K);
  const legacyStartedPeriod = normalizeLegacyStartedPeriod(legacyStartedPeriodRaw);
  const activityStateRaw = normalizedText(input.cells.L);
  const activityState = normalizeActivityState(activityStateRaw);
  const programName = normalizedText(input.cells.M);
  const campaignName = normalizedText(input.cells.N) || "unclassified";
  const identitySeed = channelId
    ? `youtube_channel_id:${channelId}`
    : creatorId
      ? `creator_id:${creatorId}`
      : email
        ? `email:${email}`
        : channelUrl
          ? `channel_url:${channelUrl}`
        : userId
          ? `user_id:${userId}`
          : emailId
            ? `email_id:${emailId}`
            : "";
  if (!identitySeed) {
    throw failedPrecondition(
      `Participant roster row ${input.rowNumber} has no stable identity.`,
    );
  }
  const identityHash = sha256(identitySeed);
  const participantFields = {
    identityHash,
    canonicalProgramId: input.canonicalProgramId,
    creatorId,
    email,
    emailId,
    channelName,
    channelId,
    channelUrl,
    country,
    adjustLink,
    appsflyerLink,
    userId,
    legacyCampaignLinkRaw,
    legacyCampaignLink,
    legacyCampaignName,
    legacyStartedPeriodRaw,
    legacyStartedPeriod,
    activityStateRaw,
    activityState,
    programName,
    campaignName,
  };
  const rowHash = sha256(
    PARTICIPANT_ROSTER_COLUMNS
      .map((column) => `${column}:${input.cells[column] ?? ""}`)
      .join("\n"),
  );
  const sourceId = input.source.role === "primary"
    ? input.sourceId
    : input.source.sourceId;

  return {
    id: `participant-${identityHash.slice(0, 40)}`,
    sourceId: input.sourceId,
    schemaVersion: ROSTER_SCHEMA_VERSION,
    identityHash,
    participantFingerprint: sha256(stableJson(participantFields)),
    canonicalProgramId: input.canonicalProgramId,
    programId: input.canonicalProgramId,
    creatorId,
    email,
    emailId,
    channelName,
    channelId,
    channelUrl,
    country,
    adjustLink,
    appsflyerLink,
    userId,
    legacyCampaignLinkRaw,
    legacyCampaignLink,
    legacyCampaignName,
    legacyStartedPeriodRaw,
    legacyStartedPeriod,
    activityStateRaw,
    activityState,
    programName,
    campaignName,
    source: {
      role: input.source.role,
      sourceId,
      spreadsheetId: input.source.spreadsheetId,
      tabName: input.source.tabName,
      gid: input.source.gid,
      rowNumber: input.rowNumber,
      rowHash,
    },
  };
}

function sameMaterializedEntry(
  existing: Record<string, unknown> | undefined,
  expected: ParticipantRosterEntry,
): boolean {
  if (!existing) return false;
  const source = asRecord(existing.source);
  return (
    asString(existing.participantFingerprint) === expected.participantFingerprint &&
    asString(existing.identityHash) === expected.identityHash &&
    asString(existing.canonicalProgramId) === expected.canonicalProgramId &&
    asString(existing.programId) === expected.programId &&
    asString(existing.sourceId) === expected.sourceId &&
    asString(existing.schemaVersion) === expected.schemaVersion &&
    asString(source.role) === "primary" &&
    asString(source.sourceId) === expected.source.sourceId &&
    asString(source.spreadsheetId) === expected.source.spreadsheetId &&
    asString(source.tabName) === expected.source.tabName &&
    asString(source.gid) === expected.source.gid &&
    nonNegativeInteger(source.rowNumber, 0) === expected.source.rowNumber &&
    asString(source.rowHash) === expected.source.rowHash
  );
}

function parseEngineInput(data: Record<string, unknown>): ParsedEngineInput {
  const dryRun = data.dryRun !== false;
  const targetCutoverState = optionalCutoverState(data.targetCutoverState);
  if (data.targetCutoverState !== undefined && !targetCutoverState) {
    throw invalidArgument("targetCutoverState is invalid.");
  }
  const expectedCutoverVersion = data.expectedCutoverVersion === undefined
    ? null
    : exactNonNegativeInteger(data.expectedCutoverVersion);
  const expectedProjectionVersion = data.expectedProjectionVersion === undefined
    ? null
    : exactNonNegativeInteger(data.expectedProjectionVersion);
  const expectedSourceVersion = data.expectedSourceVersion === undefined
    ? null
    : exactNonNegativeInteger(data.expectedSourceVersion);
  if (targetCutoverState && expectedCutoverVersion === null) {
    throw failedPrecondition(
      "expectedCutoverVersion is required for a cutover transition.",
    );
  }
  return {
    dryRun,
    actual: data.actual === true,
    confirm: asString(data.confirm),
    previewToken: asString(data.previewToken),
    targetCutoverState,
    expectedCutoverVersion,
    expectedProjectionVersion,
    expectedSourceVersion,
  };
}

function validateExpectedCutoverVersion(
  input: ParsedEngineInput,
  current: SheetCutoverRecord,
): void {
  if (
    input.targetCutoverState &&
    input.expectedCutoverVersion !== current.version
  ) {
    throw failedPrecondition(
      "Participant roster cutover version mismatch; run dry-run again.",
    );
  }
}

function proposeCutover(input: {
  current: SheetCutoverRecord;
  target: SheetCutoverState | null;
  parity: ParticipantRosterParity | ParticipantRosterParityUnavailable;
  primaryCount: number;
  legacyAvailable: boolean;
  actor: string;
  nowIso: string;
}): SheetCutoverRecord {
  if (!input.target || input.target === input.current.state) return input.current;
  const allowed = allowedCutoverTargets(input.current.state);
  if (!allowed.includes(input.target)) {
    throw failedPrecondition(
      `Participant roster cutover cannot move from ${input.current.state} to ${input.target}.`,
    );
  }
  if (input.target !== "shadow" && !input.legacyAvailable) {
    throw failedPrecondition(
      "Participant roster legacy parity source must be readable before cutover.",
    );
  }
  if (
    (input.target === "rollbackable_primary" || input.target === "primary") &&
    (input.primaryCount === 0 || input.parity.status !== "match")
  ) {
    throw failedPrecondition(
      "Participant roster parity must match with a non-empty primary source before promotion.",
    );
  }
  const rollingBack = cutoverRank(input.target) < cutoverRank(input.current.state);
  return {
    state: input.target,
    version: input.current.version + 1,
    owner: input.actor,
    enteredAtIso: input.nowIso,
    updatedAtIso: input.nowIso,
    targetExitAt: null,
    rollbackCheckpoint: rollingBack
      ? input.target
      : input.current.state === "shadow"
        ? "shadow"
        : input.current.rollbackCheckpoint ?? input.current.state,
    lastRollbackAtIso: rollingBack ? input.nowIso : input.current.lastRollbackAtIso,
  };
}

function allowedCutoverTargets(state: SheetCutoverState): SheetCutoverState[] {
  switch (state) {
    case "shadow":
      return ["dual_read"];
    case "dual_read":
      return ["shadow", "rollbackable_primary"];
    case "rollbackable_primary":
      return ["dual_read", "primary"];
    case "primary":
      return ["rollbackable_primary"];
    case "retired":
      return [];
  }
}

function cutoverRank(state: SheetCutoverState): number {
  return {
    shadow: 0,
    dual_read: 1,
    rollbackable_primary: 2,
    primary: 3,
    retired: 4,
  }[state];
}

function readCutover(value: unknown, nowIso: string): SheetCutoverRecord {
  const record = asRecord(value);
  const state = optionalCutoverState(record.state) ?? "shadow";
  return {
    state,
    version: nonNegativeInteger(record.version, 0),
    owner: asString(record.owner, "system"),
    enteredAtIso: validIso(record.enteredAtIso, nowIso),
    updatedAtIso: validIso(record.updatedAtIso, nowIso),
    targetExitAt: isoOrNull(record.targetExitAt),
    rollbackCheckpoint: optionalCutoverState(record.rollbackCheckpoint),
    lastRollbackAtIso: isoOrNull(record.lastRollbackAtIso),
  };
}

function publicEngineResult(input: {
  dryRun: boolean;
  primary: NormalizedParticipantRosterSnapshot;
  parity: ParticipantRosterParity | ParticipantRosterParityUnavailable;
  plan: ParticipantRosterProjectionPlan;
  cutover: SheetCutoverRecord;
  currentMaterializedCount: number;
  legacyReadError: string | null;
}) {
  const estimatedMaterializedCount =
    input.currentMaterializedCount + input.plan.newEntryCount;
  return {
    dryRun: input.dryRun,
    schemaVersion: ROSTER_SCHEMA_VERSION,
    canonicalProgramId: input.primary.canonicalProgramId,
    primaryFingerprint: input.primary.canonicalFingerprint,
    metrics: {
      primaryCount: input.primary.rows.length,
      currentMaterializedCount: input.currentMaterializedCount,
      estimatedMaterializedCount,
      upsertCount: input.plan.upserts.length,
      retainedAbsentCount: input.plan.retainedAbsentCount,
    },
    parity: publicParityCounts(input.parity),
    cutover: publicCutover(input.cutover),
    projectionVersion: input.plan.nextVersion,
    idempotent: input.plan.idempotent,
    retainedAbsentCount: input.plan.retainedAbsentCount,
    legacyReadStatus: input.legacyReadError ? "unavailable" as const : "available" as const,
  };
}

function publicCutover(record: SheetCutoverRecord) {
  return {
    state: record.state,
    version: record.version,
    enteredAtIso: record.enteredAtIso,
    updatedAtIso: record.updatedAtIso,
    targetExitAt: record.targetExitAt,
    rollbackCheckpoint: record.rollbackCheckpoint,
    lastRollbackAtIso: record.lastRollbackAtIso,
    ownerHash: record.owner ? `operator_${sha256(record.owner).slice(0, 12)}` : null,
  };
}

function publicParityCounts(
  parity: ParticipantRosterParity | ParticipantRosterParityUnavailable,
) {
  return {
    status: parity.status,
    primaryCount: parity.primaryCount,
    legacyCount: parity.legacyCount,
    matchingCount: parity.matchingCount,
    changedCount: parity.changedCount,
    primaryOnlyCount: parity.primaryOnlyCount,
    legacyOnlyCount: parity.legacyOnlyCount,
  };
}

function unavailableParity(primaryCount: number): ParticipantRosterParityUnavailable {
  return {
    status: "unavailable",
    primaryCount,
    legacyCount: null,
    matchingCount: 0,
    changedCount: 0,
    primaryOnlyCount: 0,
    legacyOnlyCount: 0,
    changedIdentityHashes: [],
    primaryOnlyIdentityHashes: [],
    legacyOnlyIdentityHashes: [],
    reason: "legacy_read_failed",
  };
}

function participantRosterOriginFingerprint(
  primary: NormalizedParticipantRosterSnapshot,
  legacy: NormalizedParticipantRosterSnapshot | null,
): string {
  return sheetOperationFingerprint({
    topology: {
      primary: primary.source,
      legacy: legacy?.source ?? null,
    },
    primary: {
      headerFingerprint: primary.headerFingerprint,
      canonicalFingerprint: primary.canonicalFingerprint,
      rowCount: primary.rows.length,
    },
    legacy: legacy
      ? {
          headerFingerprint: legacy.headerFingerprint,
          canonicalFingerprint: legacy.canonicalFingerprint,
          rowCount: legacy.rows.length,
        }
      : { status: "unavailable" },
  });
}

function participantRosterPlanFingerprint(input: {
  primary: NormalizedParticipantRosterSnapshot;
  parity: ParticipantRosterParity | ParticipantRosterParityUnavailable;
  plan: ParticipantRosterProjectionPlan;
  currentSourceVersion: number;
  currentProjectionVersion: number;
  currentCutover: SheetCutoverRecord;
  targetCutoverState: SheetCutoverState | null;
}): string {
  return sheetOperationFingerprint({
    canonicalProgramId: input.primary.canonicalProgramId,
    primaryFingerprint: input.primary.canonicalFingerprint,
    sourceVersion: input.currentSourceVersion,
    projectionVersion: input.currentProjectionVersion,
    // A source with no persisted cutover record receives request-time fallback
    // timestamps from readCutover(). Those presentation timestamps must not make
    // an otherwise unchanged preview drift between preview and apply.
    currentCutover: participantRosterCutoverFingerprint(input.currentCutover),
    targetCutoverState: input.targetCutoverState,
    parity: publicParityCounts(input.parity),
    plan: {
      upsertIds: input.plan.upserts.map((entry) => entry.id),
      newEntryCount: input.plan.newEntryCount,
      retainedAbsentCount: input.plan.retainedAbsentCount,
      nextVersion: input.plan.nextVersion,
      idempotent: input.plan.idempotent,
    },
  });
}

function participantRosterCutoverFingerprint(record: SheetCutoverRecord) {
  const cutover = publicCutover(record);
  return {
    state: cutover.state,
    version: cutover.version,
    targetExitAt: cutover.targetExitAt,
    rollbackCheckpoint: cutover.rollbackCheckpoint,
    lastRollbackAtIso: cutover.lastRollbackAtIso,
    ownerHash: cutover.ownerHash,
  };
}

function participantRosterProfile(): SheetSourceProfile {
  const profile = knownSheetSourceProfileByKey("participant_registry");
  if (
    !profile ||
    profile.projectionStrategy !== "participant_registry_projection" ||
    !profile.legacySource
  ) {
    throw failedPrecondition(
      "Reviewed participant roster topology is unavailable.",
    );
  }
  return profile;
}

function primarySheetSource(profile: SheetSourceProfile): ParticipantRosterSheetSource {
  return {
    role: "primary",
    sourceId: profile.sourceId,
    spreadsheetId: profile.spreadsheetId,
    tabName: profile.tabName,
    gid: profile.gid,
  };
}

function legacySheetSource(profile: SheetSourceProfile): ParticipantRosterSheetSource {
  if (!profile.legacySource) {
    throw failedPrecondition("Participant roster legacy parity source is unavailable.");
  }
  return {
    role: "legacy",
    sourceId: `participant-roster-legacy-${sha256(
      `${profile.legacySource.spreadsheetId}:${profile.legacySource.gid}`,
    ).slice(0, 32)}`,
    spreadsheetId: profile.legacySource.spreadsheetId,
    tabName: profile.legacySource.tabName,
    gid: profile.legacySource.gid,
  };
}

function publicSource(source: ParticipantRosterSheetSource) {
  return {
    role: source.role,
    spreadsheetIdHash: sha256(source.spreadsheetId).slice(0, 16),
    tabName: source.tabName,
    gid: source.gid,
  };
}

function resolveCollections(
  override: ParticipantRosterEngineDependencies["collections"],
): ParticipantRosterCollections {
  return {
    source: safeCollectionName(override?.source, DEFAULT_COLLECTIONS.source),
    entries: safeCollectionName(override?.entries, DEFAULT_COLLECTIONS.entries),
    audits: safeCollectionName(override?.audits, DEFAULT_COLLECTIONS.audits),
  };
}

function safeCollectionName(value: unknown, fallback: string): string {
  const normalized = asString(value, fallback);
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(normalized)) {
    throw invalidArgument("Internal participant roster collection override is invalid.");
  }
  return normalized;
}

function safeDocumentId(value: unknown): string {
  const normalized = asString(value);
  if (!normalized || normalized.length > 500 || normalized.includes("/")) {
    throw invalidArgument("Internal participant roster audit id is invalid.");
  }
  return normalized;
}

function normalizeCells(value: unknown): Record<string, string> {
  const record = asRecord(value);
  return cellsAtoN(record);
}

function cellsAtoN(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      PARTICIPANT_ROSTER_COLUMNS.map((column, index) => [
        column,
        normalizedText(value[index]),
      ]),
    );
  }
  const record = asRecord(value);
  return Object.fromEntries(
    PARTICIPANT_ROSTER_COLUMNS.map((column) => [
      column,
      normalizedText(record[column]),
    ]),
  );
}

function normalizedText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  return text.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function normalizedIdentityText(value: unknown): string {
  return normalizedText(value).toLocaleLowerCase("en-US");
}

function normalizeEmail(value: unknown): string {
  const email = normalizedIdentityText(value);
  return email.length <= 320 ? email : email.slice(0, 320);
}

function normalizeUrl(value: unknown): string {
  const text = normalizedText(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return text;
  }
}

function normalizeStrictUrl(value: unknown): string {
  const text = normalizedText(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeLegacyStartedPeriod(value: unknown): string {
  const text = normalizedText(value);
  if (!text) return "";
  const yearMonth = text.match(/(20\d{2})\D{0,3}(0?[1-9]|1[0-2])(?:\D|$)/);
  if (!yearMonth) return "";
  return `${yearMonth[1]}-${yearMonth[2].padStart(2, "0")}`;
}

function normalizeActivityState(value: unknown): ParticipantRosterActivityState {
  switch (normalizedText(value)) {
    case "꾸준히 활동중":
      return "active";
    case "하나 업로드":
      return "active_limited";
    case "아직 업로드 전":
      return "onboarded_no_submission";
    case "활동 안하고 있음":
      return "dormant";
    case "중도포기":
      return "withdrawn";
    case "마케팅 참여 원함":
      return "reactivation_requested";
    case "":
      return "unknown";
    default:
      return "unknown";
  }
}

function stableJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])),
  );
}

function projectionVersion(control: Record<string, unknown>): number {
  return nonNegativeInteger(asRecord(control.participantRosterProjection).version, 0);
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function exactNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw invalidArgument("expectedCutoverVersion must be a non-negative integer.");
  }
  return parsed;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalCutoverState(value: unknown): SheetCutoverState | null {
  return value === "shadow" ||
    value === "dual_read" ||
    value === "rollbackable_primary" ||
    value === "primary" ||
    value === "retired"
    ? value
    : null;
}

function validIso(value: unknown, fallback: string): string {
  return isoOrNull(value) ?? fallback;
}

function isoOrNull(value: unknown): string | null {
  const text = asString(value);
  if (!text || !Number.isFinite(Date.parse(text))) return null;
  return new Date(text).toISOString();
}

function hashOrNull(value: unknown): string | null {
  const text = asString(value);
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function optionalText(value: unknown): string | null {
  const text = asString(value);
  return text ? text.slice(0, 120) : null;
}

function nullableCount(value: unknown): number | null {
  return value === null ? null : nonNegativeInteger(value, 0);
}

function parityStatus(value: unknown): "match" | "mismatch" | "unavailable" | "unknown" {
  return value === "match" || value === "mismatch" || value === "unavailable"
    ? value
    : "unknown";
}

function applyApiKey(url: URL, credentials: SheetCredentials): void {
  if (credentials.apiKey && !credentials.accessToken) {
    url.searchParams.set("key", credentials.apiKey);
  }
}

function quoteSheetTitle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function environmentText(name: string): string {
  return typeof process.env[name] === "string" ? process.env[name]!.trim() : "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\r\n]+/g, " ").slice(0, 240)
    : "unknown error";
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? asString((error as { code?: unknown }).code) || "operation_failed"
    : "operation_failed";
}

function invalidSourceRole(): never {
  throw failedPrecondition("Participant roster source role is invalid.");
}

function assertSnapshotRole(
  snapshot: NormalizedParticipantRosterSnapshot,
  expected: ParticipantRosterSourceRole,
): void {
  if (snapshot.source.role !== expected) {
    throw invalidArgument(`Expected participant roster ${expected} snapshot.`);
  }
}

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(`failed-precondition: ${message}`), {
    code: "failed-precondition", errorCode: "failed_precondition_unauthorized",
  });
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument", errorCode: "invalid_argument_unauthorized",
  });
}
