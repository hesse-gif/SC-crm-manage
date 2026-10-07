import { createHash } from "node:crypto";
import {
  applicationDefault,
  getApp,
  initializeApp,
} from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import {
  LEGACY_SHEET_PORTAL_ATTEMPT_AUDIT_COLLECTION,
  LEGACY_SHEET_PORTAL_OUTBOX_COLLECTION,
  LEGACY_SHEET_PORTAL_RECEIPTS_COLLECTION,
  LEGACY_SHEET_PORTAL_REVISIONS_COLLECTION,
  LEGACY_SHEET_PORTAL_SUBMISSIONS_COLLECTION,
  type LegacySheetContentMigrationProjection,
  type LegacySheetFluEventPolicy,
  type LegacySheetPortalWrite,
} from "./legacySheetContentMigrationProjection";

export const LEGACY_SHEET_CONTENT_MIGRATION_RECEIPT_VERSION =
  "flu.legacy-sheet-content-stage-receipt.v1" as const;

type ReceiptStatus =
  | "staged"
  | "partially_released"
  | "released"
  | "recovery_required";

export interface LegacySheetMigrationPathDigest {
  path: string;
  digest: string;
}

export interface LegacySheetContentMigrationReceipt {
  schemaVersion: typeof LEGACY_SHEET_CONTENT_MIGRATION_RECEIPT_VERSION;
  sensitivity: "restricted_private_rollback_receipt";
  manifestId: string;
  sourceManifestId: string;
  sourceArtifactDigests:
    LegacySheetContentMigrationProjection["sourceArtifactDigests"];
  projectionDigest: string;
  legacyEventPolicyDigest: string;
  legacyEventPolicyCount: number;
  operationId: string;
  status: ReceiptStatus;
  stageWrites: LegacySheetMigrationPathDigest[];
  releaseWrites: LegacySheetMigrationPathDigest[];
  releasedWrites: LegacySheetMigrationPathDigest[];
  releasedCount: number;
  canary?: {
    eventId: string;
    submissionId: string;
    applicationId: string;
    fluCreatorId: string;
    enrollmentId: string;
    channelId: string | null;
    releasedAtIso: string;
  };
  counts: LegacySheetContentMigrationProjection["counts"];
  stagedAtIso: string;
  releasedAtIso?: string;
}

type PlannedWrite = LegacySheetMigrationPathDigest & {
  data: Readonly<Record<string, unknown>>;
};

const PORTAL_MIGRATION_APP_NAME = "legacy-sheet-content-portal-migration";

function defaultPortalDb(): Firestore {
  const projectId =
    clean(process.env.SCP_PORTAL_PROJECT_ID) || "scp-creator-portal";
  try {
    return getFirestore(getApp(PORTAL_MIGRATION_APP_NAME));
  } catch {
    return getFirestore(
      initializeApp(
        { credential: applicationDefault(), projectId },
        PORTAL_MIGRATION_APP_NAME,
      ),
    );
  }
}

function defaultFluControlDb(): Firestore {
  const projectId =
    clean(process.env.SCP_FLU_PROJECT_ID) ||
    clean(process.env.GCLOUD_PROJECT) ||
    clean(process.env.GOOGLE_CLOUD_PROJECT) ||
    "influchat-77db6";
  try {
    return getFirestore(getApp());
  } catch {
    return getFirestore(
      initializeApp(
        { credential: applicationDefault(), projectId },
      ),
    );
  }
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function controlDocId(manifestId: string): string {
  return `legacy_sheet_content_${createHash("sha256")
    .update(manifestId)
    .digest("hex")
    .slice(0, 40)}`;
}

function chunks<T>(values: readonly T[], size = 350): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function toPlannedWrites(
  collection: string,
  writes: readonly LegacySheetPortalWrite[],
): PlannedWrite[] {
  return writes.map((write) => ({
    path: `${collection}/${write.docId}`,
    digest: digest(write.data),
    data: write.data,
  }));
}

function stageWrites(
  projection: LegacySheetContentMigrationProjection,
): PlannedWrite[] {
  return [
    ...toPlannedWrites(
      LEGACY_SHEET_PORTAL_ATTEMPT_AUDIT_COLLECTION,
      projection.attemptAuditWrites,
    ),
    ...toPlannedWrites(
      LEGACY_SHEET_PORTAL_SUBMISSIONS_COLLECTION,
      projection.submissionWrites,
    ),
    ...toPlannedWrites(
      LEGACY_SHEET_PORTAL_REVISIONS_COLLECTION,
      projection.revisionWrites,
    ),
  ].sort((left, right) => left.path.localeCompare(right.path));
}

function releaseWrites(
  projection: LegacySheetContentMigrationProjection,
): PlannedWrite[] {
  return toPlannedWrites(
    LEGACY_SHEET_PORTAL_OUTBOX_COLLECTION,
    projection.outboxWrites,
  ).sort((left, right) => left.path.localeCompare(right.path));
}

function legacyEventPoliciesByEventId(
  projection: LegacySheetContentMigrationProjection,
): Record<string, LegacySheetFluEventPolicy> {
  const policies: Record<string, LegacySheetFluEventPolicy> = {};
  for (const policy of projection.privateFluPolicies) {
    const eventId = clean(policy.eventId);
    if (!eventId || policies[eventId]) {
      throw new Error("legacy_sheet_migration_policy_event_id_invalid");
    }
    policies[eventId] = policy;
  }
  return policies;
}

function legacyEventPolicyDigest(
  projection: LegacySheetContentMigrationProjection,
): string {
  return digest(legacyEventPoliciesByEventId(projection));
}

function releaseEventId(write: PlannedWrite): string {
  return clean(
    (
      write.data.event as Record<string, unknown> | undefined
    )?.eventId,
  );
}

function releaseEvent(
  write: PlannedWrite,
): Record<string, unknown> {
  const event = write.data.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("legacy_sheet_migration_release_event_invalid");
  }
  return event as Record<string, unknown>;
}

function releasedPathsFromControl(
  control: Record<string, unknown>,
): string[] {
  return Array.isArray(control.releasedWritePaths)
    ? [...new Set(
        control.releasedWritePaths.map(clean).filter(Boolean),
      )].sort()
    : [];
}

function refForPath(db: Firestore, path: string) {
  const [collection, documentId, ...rest] = path.split("/");
  if (!collection || !documentId || rest.length > 0) {
    throw new Error(`legacy_sheet_migration_path_invalid:${path}`);
  }
  return db.collection(collection).doc(documentId);
}

function pathDigests(writes: readonly PlannedWrite[]): LegacySheetMigrationPathDigest[] {
  return writes.map(({ path, digest: value }) => ({ path, digest: value }));
}

function exactControl(
  value: Record<string, unknown>,
  projection: LegacySheetContentMigrationProjection,
): void {
  if (
    clean(value.schemaVersion) !==
      LEGACY_SHEET_CONTENT_MIGRATION_RECEIPT_VERSION ||
    clean(value.manifestId) !== projection.projectionManifestId ||
    clean(value.projectionDigest) !== projection.projectionDigest
  ) {
    throw new Error("legacy_sheet_migration_projection_drift");
  }
  if (
    clean(value.legacyEventPolicyDigest) &&
    clean(value.legacyEventPolicyDigest) !== legacyEventPolicyDigest(projection)
  ) {
    throw new Error("legacy_sheet_migration_policy_drift");
  }
}

async function createOnlyWrites(
  db: Firestore,
  projection: LegacySheetContentMigrationProjection,
  writes: readonly PlannedWrite[],
): Promise<void> {
  for (const writeChunk of chunks(writes)) {
    await db.runTransaction(async (transaction) => {
      const refs = writeChunk.map((write) => refForPath(db, write.path));
      const snapshots = await transaction.getAll(...refs);
      for (let index = 0; index < writeChunk.length; index += 1) {
        const write = writeChunk[index];
        const snapshot = snapshots[index];
        if (snapshot.exists) {
          const existing = snapshot.data() ?? {};
          const existingDigest = digest(existing);
          if (existingDigest === write.digest) {
            continue;
          }
          const ownedManifest =
            clean(existing.manifestId) ||
            clean((existing.historicalImport as Record<string, unknown> | undefined)?.manifestId);
          if (ownedManifest !== projection.sourceManifestId) {
            throw new Error(
              `legacy_sheet_migration_create_conflict:${write.path}`,
            );
          }
          throw new Error(
            `legacy_sheet_migration_create_conflict:${write.path}`,
          );
        }
        transaction.create(refs[index], write.data);
      }
    });
  }
}

function receiptFrom(
  projection: LegacySheetContentMigrationProjection,
  control: Record<string, unknown>,
): LegacySheetContentMigrationReceipt {
  const status = clean(control.status);
  if (
    ![
      "staged",
      "partially_released",
      "released",
      "recovery_required",
    ].includes(status)
  ) {
    throw new Error("legacy_sheet_migration_control_incomplete");
  }
  const plannedReleaseWrites = releaseWrites(projection);
  const plannedByPath = new Map(
    plannedReleaseWrites.map((write) => [write.path, write]),
  );
  const releasedPaths = releasedPathsFromControl(control);
  if (
    status === "released" &&
    releasedPaths.length !== plannedReleaseWrites.length
  ) {
    throw new Error("legacy_sheet_migration_released_ledger_incomplete");
  }
  const releasedWrites = releasedPaths.map((path) => {
    const write = plannedByPath.get(path);
    if (!write) {
      throw new Error("legacy_sheet_migration_released_path_drift");
    }
    return { path: write.path, digest: write.digest };
  });
  const canary =
    control.canary &&
    typeof control.canary === "object" &&
    !Array.isArray(control.canary)
      ? control.canary as Record<string, unknown>
      : null;
  return {
    schemaVersion: LEGACY_SHEET_CONTENT_MIGRATION_RECEIPT_VERSION,
    sensitivity: "restricted_private_rollback_receipt",
    manifestId: projection.projectionManifestId,
    sourceManifestId: projection.sourceManifestId,
    sourceArtifactDigests: projection.sourceArtifactDigests,
    projectionDigest: projection.projectionDigest,
    legacyEventPolicyDigest: legacyEventPolicyDigest(projection),
    legacyEventPolicyCount: projection.privateFluPolicies.length,
    operationId: clean(control.operationId),
    status: status as ReceiptStatus,
    stageWrites: pathDigests(stageWrites(projection)),
    releaseWrites: pathDigests(plannedReleaseWrites),
    releasedWrites,
    releasedCount: releasedWrites.length,
    ...(canary
      ? {
          canary: {
            eventId: clean(canary.eventId),
            submissionId: clean(canary.submissionId),
            applicationId: clean(canary.applicationId),
            fluCreatorId: clean(canary.fluCreatorId),
            enrollmentId: clean(canary.enrollmentId),
            channelId: clean(canary.channelId) || null,
            releasedAtIso: clean(canary.releasedAtIso),
          },
        }
      : {}),
    counts: projection.counts,
    stagedAtIso: clean(control.stagedAtIso),
    ...(clean(control.releasedAtIso)
      ? { releasedAtIso: clean(control.releasedAtIso) }
      : {}),
  };
}

export async function applyLegacySheetContentMigrationProjection(
  projection: LegacySheetContentMigrationProjection,
  input: {
    operationId: string;
    now: Date;
    firestore?: Firestore;
    portalFirestore?: Firestore;
    controlFirestore?: Firestore;
    afterControlPreparedForTest?: () => Promise<void>;
  },
): Promise<LegacySheetContentMigrationReceipt> {
  const portalDb = input.portalFirestore ?? input.firestore ?? defaultPortalDb();
  const controlDb =
    input.controlFirestore ?? input.firestore ?? defaultFluControlDb();
  const operationId = clean(input.operationId);
  if (!operationId) {
    throw new Error("legacy_sheet_migration_operation_id_required");
  }
  const nowIso = input.now.toISOString();
  const controlRef = controlDb
    .collection(LEGACY_SHEET_PORTAL_RECEIPTS_COLLECTION)
    .doc(controlDocId(projection.projectionManifestId));
  const plannedStageWrites = stageWrites(projection);
  const plannedReleaseWrites = releaseWrites(projection);
  const eventPoliciesByEventId = legacyEventPoliciesByEventId(projection);
  const initialControl = {
    schemaVersion: LEGACY_SHEET_CONTENT_MIGRATION_RECEIPT_VERSION,
    manifestId: projection.projectionManifestId,
    sourceManifestId: projection.sourceManifestId,
    projectionDigest: projection.projectionDigest,
    legacyEventPolicyDigest: digest(eventPoliciesByEventId),
    legacyEventPolicyCount: projection.privateFluPolicies.length,
    legacyEventIds: Object.keys(eventPoliciesByEventId).sort(),
    legacyEventPoliciesByEventId: eventPoliciesByEventId,
    operationId,
    status: "staging",
    stageWritesDigest: digest(pathDigests(plannedStageWrites)),
    releaseWritesDigest: digest(pathDigests(plannedReleaseWrites)),
    counts: projection.counts,
    preparedAtIso: nowIso,
  };
  const existing: Record<string, unknown> = await controlDb.runTransaction(
    async (transaction): Promise<Record<string, unknown>> => {
    const snapshot = await transaction.get(controlRef);
    if (!snapshot.exists) {
      transaction.create(controlRef, initialControl);
      return initialControl;
    }
    const value = snapshot.data() ?? {};
    exactControl(value, projection);
    if (clean(value.operationId) !== operationId) {
      throw new Error("legacy_sheet_migration_operation_conflict");
    }
    return value;
    },
  );
  if (clean(existing.status) === "released") {
    return receiptFrom(projection, existing);
  }
  if (clean(existing.status) === "partially_released") {
    return receiptFrom(projection, existing);
  }
  if (clean(existing.status) === "staged") {
    return receiptFrom(projection, existing);
  }
  if (clean(existing.status) !== "staging") {
    throw new Error("legacy_sheet_migration_not_stageable");
  }
  await input.afterControlPreparedForTest?.();
  await createOnlyWrites(portalDb, projection, plannedStageWrites);
  await controlDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(controlRef);
    if (!snapshot.exists) {
      throw new Error("legacy_sheet_migration_control_missing");
    }
    const current = snapshot.data() ?? {};
    exactControl(current, projection);
    if (
      clean(current.operationId) !== operationId ||
      clean(current.status) !== "staging"
    ) {
      throw new Error("legacy_sheet_migration_stage_finalize_conflict");
    }
    transaction.set(
      controlRef,
      {
        status: "staged",
        stagedAtIso: clean(current.stagedAtIso) || nowIso,
        updatedAtIso: nowIso,
      },
      { merge: true },
    );
  });
  const staged = (await controlRef.get()).data() ?? {};
  return receiptFrom(projection, staged);
}

export async function releaseLegacySheetContentMigrationProjection(
  projection: LegacySheetContentMigrationProjection,
  input: {
    operationId: string;
    now: Date;
    eventIds: readonly string[];
    canary?: boolean;
    firestore?: Firestore;
    portalFirestore?: Firestore;
    controlFirestore?: Firestore;
    afterReleaseWritesCreatedForTest?: () => Promise<void>;
  },
): Promise<LegacySheetContentMigrationReceipt> {
  const portalDb = input.portalFirestore ?? input.firestore ?? defaultPortalDb();
  const controlDb =
    input.controlFirestore ?? input.firestore ?? defaultFluControlDb();
  const controlRef = controlDb
    .collection(LEGACY_SHEET_PORTAL_RECEIPTS_COLLECTION)
    .doc(controlDocId(projection.projectionManifestId));
  const operationId = clean(input.operationId);
  if (!operationId) {
    throw new Error("legacy_sheet_migration_operation_id_required");
  }
  const eventIds = [...new Set(input.eventIds.map(clean).filter(Boolean))];
  if (!eventIds.length) {
    throw new Error("legacy_sheet_migration_release_event_ids_required");
  }
  if (eventIds.length > 20) {
    throw new Error("legacy_sheet_migration_release_batch_exceeds_20");
  }
  const plannedReleaseWrites = releaseWrites(projection);
  const byEventId = new Map(
    plannedReleaseWrites.map((write) => [releaseEventId(write), write]),
  );
  if (
    byEventId.has("") ||
    eventIds.some((eventId) => !byEventId.has(eventId))
  ) {
    throw new Error("legacy_sheet_migration_release_event_id_unknown");
  }
  const selectedWrites = eventIds
    .map((eventId) => byEventId.get(eventId)!)
    .sort((left, right) => left.path.localeCompare(right.path));
  const selectedEffects = selectedWrites.map((write) => {
    const event = releaseEvent(write);
    const subject =
      event.subject &&
      typeof event.subject === "object" &&
      !Array.isArray(event.subject)
        ? event.subject as Record<string, unknown>
        : {};
    const submissionId = clean(subject.videoSubmissionId);
    const effect = projection.expectedFluEffects.find(
      (candidate) => candidate.submissionId === submissionId,
    );
    if (!effect) {
      throw new Error("legacy_sheet_migration_release_effect_missing");
    }
    return effect;
  });
  if (
    selectedEffects.some(
      (effect) =>
        effect.identitySource === "human_review" ||
        effect.targetStatus === "human_review_required",
    )
  ) {
    throw new Error(
      "legacy_sheet_migration_human_review_event_quarantined",
    );
  }
  let canaryIdentity: {
    eventId: string;
    submissionId: string;
    applicationId: string;
    fluCreatorId: string;
    enrollmentId: string;
    channelId: string | null;
  } | null = null;
  if (input.canary) {
    if (selectedWrites.length !== 1) {
      throw new Error("legacy_sheet_migration_canary_requires_one_event");
    }
    const effect = selectedEffects[0];
    if (
      !effect ||
      effect.targetStatus !== "approved" ||
      effect.identitySource === "human_review" ||
      !effect.fluCreatorId ||
      !effect.enrollmentId
    ) {
      throw new Error(
        "legacy_sheet_migration_canary_must_be_approved_canonical_identity",
      );
    }
    canaryIdentity = {
      eventId: releaseEventId(selectedWrites[0]),
      submissionId: effect.submissionId,
      applicationId: effect.applicationId,
      fluCreatorId: effect.fluCreatorId,
      enrollmentId: effect.enrollmentId,
      channelId: effect.channelId,
    };
  }
  const selectedWritePaths = selectedWrites.map((write) => write.path);
  const selectedWriteDigest = digest(pathDigests(selectedWrites));
  const selectedCanaryDigest = digest(canaryIdentity);
  const preparation = await controlDb.runTransaction(
    async (transaction): Promise<{
      alreadyReleased: boolean;
      control: Record<string, unknown>;
    }> => {
      const snapshot = await transaction.get(controlRef);
      if (!snapshot.exists) {
        throw new Error("legacy_sheet_migration_not_staged");
      }
      const current = snapshot.data() ?? {};
      exactControl(current, projection);
      if (clean(current.operationId) !== operationId) {
        throw new Error("legacy_sheet_migration_operation_conflict");
      }
      const status = clean(current.status);
      const releasedPaths = releasedPathsFromControl(current);
      const releasedPathSet = new Set(releasedPaths);
      const selectedReleasedCount = selectedWritePaths.filter((path) =>
        releasedPathSet.has(path)
      ).length;
      if (selectedReleasedCount === selectedWritePaths.length) {
        if (!["partially_released", "released"].includes(status)) {
          throw new Error("legacy_sheet_migration_release_ledger_conflict");
        }
        if (input.canary) {
          const existingCanary =
            current.canary &&
            typeof current.canary === "object" &&
            !Array.isArray(current.canary)
              ? current.canary as Record<string, unknown>
              : null;
          if (
            !existingCanary ||
            clean(existingCanary.eventId) !== eventIds[0]
          ) {
            throw new Error(
              "legacy_sheet_migration_canary_identity_conflict",
            );
          }
        }
        return { alreadyReleased: true, control: current };
      }
      if (selectedReleasedCount > 0) {
        throw new Error("legacy_sheet_migration_release_batch_overlap");
      }
      if (status === "release_prepared") {
        const pendingPaths = Array.isArray(current.pendingReleaseWritePaths)
          ? current.pendingReleaseWritePaths.map(clean).filter(Boolean)
          : [];
        const pendingEventIds = Array.isArray(current.pendingReleaseEventIds)
          ? current.pendingReleaseEventIds.map(clean).filter(Boolean)
          : [];
        if (
          clean(current.pendingReleaseWriteDigest) !== selectedWriteDigest ||
          clean(current.pendingReleaseCanaryDigest) !== selectedCanaryDigest ||
          canonicalJson(pendingPaths) !== canonicalJson(selectedWritePaths) ||
          canonicalJson(pendingEventIds) !== canonicalJson(eventIds)
        ) {
          throw new Error(
            "legacy_sheet_migration_release_prepared_batch_conflict",
          );
        }
        return { alreadyReleased: false, control: current };
      }
      if (!["staged", "partially_released"].includes(status)) {
        throw new Error("legacy_sheet_migration_not_staged");
      }
      const existingCanary =
        current.canary &&
        typeof current.canary === "object" &&
        !Array.isArray(current.canary)
          ? current.canary as Record<string, unknown>
          : null;
      if (canaryIdentity && existingCanary) {
        throw new Error("legacy_sheet_migration_canary_already_released");
      }
      const prepared = {
        status: "release_prepared",
        releasePreparedFromStatus: status,
        pendingReleaseEventIds: eventIds,
        pendingReleaseWritePaths: selectedWritePaths,
        pendingReleaseWriteDigest: selectedWriteDigest,
        pendingReleaseCanaryDigest: selectedCanaryDigest,
        preparedReleaseAtIso: input.now.toISOString(),
        updatedAtIso: input.now.toISOString(),
      };
      transaction.set(controlRef, prepared, { merge: true });
      return {
        alreadyReleased: false,
        control: { ...current, ...prepared },
      };
    },
  );
  if (preparation.alreadyReleased) {
    return receiptFrom(projection, preparation.control);
  }
  await createOnlyWrites(portalDb, projection, selectedWrites);
  await input.afterReleaseWritesCreatedForTest?.();
  const releasedAtIso = input.now.toISOString();
  await controlDb.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(controlRef);
    if (!currentSnapshot.exists) {
      throw new Error("legacy_sheet_migration_not_staged");
    }
    const current = currentSnapshot.data() ?? {};
    exactControl(current, projection);
    if (clean(current.operationId) !== operationId) {
      throw new Error("legacy_sheet_migration_operation_conflict");
    }
    if (
      clean(current.status) !== "release_prepared" ||
      clean(current.pendingReleaseWriteDigest) !== selectedWriteDigest ||
      clean(current.pendingReleaseCanaryDigest) !== selectedCanaryDigest ||
      canonicalJson(
        Array.isArray(current.pendingReleaseWritePaths)
          ? current.pendingReleaseWritePaths.map(clean).filter(Boolean)
          : [],
      ) !== canonicalJson(selectedWritePaths) ||
      canonicalJson(
        Array.isArray(current.pendingReleaseEventIds)
          ? current.pendingReleaseEventIds.map(clean).filter(Boolean)
          : [],
      ) !== canonicalJson(eventIds)
    ) {
      throw new Error("legacy_sheet_migration_release_finalize_conflict");
    }
    const releasedWritePaths = [
      ...new Set([
        ...releasedPathsFromControl(current),
        ...selectedWrites.map((write) => write.path),
      ]),
    ].sort();
    const complete =
      releasedWritePaths.length === plannedReleaseWrites.length;
    const existingCanary =
      current.canary &&
      typeof current.canary === "object" &&
      !Array.isArray(current.canary)
        ? current.canary as Record<string, unknown>
        : null;
    const nextCanary = canaryIdentity
      ? { ...canaryIdentity, releasedAtIso }
      : null;
    if (
      existingCanary &&
      nextCanary &&
      canonicalJson({
        eventId: clean(existingCanary.eventId),
        submissionId: clean(existingCanary.submissionId),
        applicationId: clean(existingCanary.applicationId),
        fluCreatorId: clean(existingCanary.fluCreatorId),
        enrollmentId: clean(existingCanary.enrollmentId),
        channelId: clean(existingCanary.channelId) || null,
      }) !== canonicalJson(canaryIdentity)
    ) {
      throw new Error("legacy_sheet_migration_canary_identity_conflict");
    }
    transaction.set(
      controlRef,
      {
        status: complete ? "released" : "partially_released",
        releasedWritePaths,
        releasedCount: releasedWritePaths.length,
        lastReleasedAtIso: releasedAtIso,
        ...(nextCanary && !existingCanary ? { canary: nextCanary } : {}),
        ...(complete ? { releasedAtIso } : {}),
        releasePreparedFromStatus: FieldValue.delete(),
        pendingReleaseEventIds: FieldValue.delete(),
        pendingReleaseWritePaths: FieldValue.delete(),
        pendingReleaseWriteDigest: FieldValue.delete(),
        pendingReleaseCanaryDigest: FieldValue.delete(),
        preparedReleaseAtIso: FieldValue.delete(),
        updatedAtIso: releasedAtIso,
      },
      { merge: true },
    );
  });
  return receiptFrom(
    projection,
    (await controlRef.get()).data() ?? {},
  );
}

export async function createLegacySheetContentMigrationRecoveryReceipt(
  projection: LegacySheetContentMigrationProjection,
  input: { firestore?: Firestore; controlFirestore?: Firestore } = {},
): Promise<LegacySheetContentMigrationReceipt> {
  const db = input.controlFirestore ?? input.firestore ?? defaultFluControlDb();
  const controlRef = db
    .collection(LEGACY_SHEET_PORTAL_RECEIPTS_COLLECTION)
    .doc(controlDocId(projection.projectionManifestId));
  const control = await db.runTransaction(
    async (transaction): Promise<Record<string, unknown>> => {
      const snapshot = await transaction.get(controlRef);
      if (!snapshot.exists) {
        throw new Error("legacy_sheet_migration_recovery_not_started");
      }
      const current = snapshot.data() ?? {};
      exactControl(current, projection);
      const status = clean(current.status);
      if (status === "release_prepared") {
        throw new Error("legacy_sheet_migration_release_retry_required");
      }
      if (
        ["partially_released", "released"].includes(status) ||
        releasedPathsFromControl(current).length > 0
      ) {
        throw new Error("legacy_sheet_migration_release_irreversible");
      }
      if (status === "rolling_back") {
        throw new Error("legacy_sheet_migration_rollback_in_progress");
      }
      if (!["staging", "staged", "recovery_required"].includes(status)) {
        throw new Error("legacy_sheet_migration_recovery_not_available");
      }
      transaction.set(
        controlRef,
        { status: "recovery_required" },
        { merge: true },
      );
      return { ...current, status: "recovery_required" };
    },
  );
  return receiptFrom(projection, control);
}

export async function rollbackLegacySheetContentMigrationReceipt(
  receipt: LegacySheetContentMigrationReceipt,
  input: {
    firestore?: Firestore;
    portalFirestore?: Firestore;
    controlFirestore?: Firestore;
    afterRollbackPreparedForTest?: () => Promise<void>;
  } = {},
): Promise<{ deleted: number; alreadyAbsent: number }> {
  if (
    receipt.schemaVersion !==
      LEGACY_SHEET_CONTENT_MIGRATION_RECEIPT_VERSION ||
    !["staged", "recovery_required"].includes(receipt.status)
  ) {
    throw new Error("legacy_sheet_migration_receipt_invalid");
  }
  const portalDb = input.portalFirestore ?? input.firestore ?? defaultPortalDb();
  const controlDb =
    input.controlFirestore ?? input.firestore ?? defaultFluControlDb();
  const controlRef = controlDb
    .collection(LEGACY_SHEET_PORTAL_RECEIPTS_COLLECTION)
    .doc(controlDocId(receipt.manifestId));
  const prepared = await controlDb.runTransaction(
    async (transaction): Promise<boolean> => {
      const snapshot = await transaction.get(controlRef);
      if (!snapshot.exists) return false;
      const control = snapshot.data() ?? {};
      if (
        clean(control.manifestId) !== receipt.manifestId ||
        clean(control.projectionDigest) !== receipt.projectionDigest ||
        clean(control.operationId) !== receipt.operationId
      ) {
        throw new Error("legacy_sheet_migration_rollback_control_drift");
      }
      const status = clean(control.status);
      if (
        ["release_prepared", "partially_released", "released"].includes(status) ||
        releasedPathsFromControl(control).length > 0
      ) {
        throw new Error("legacy_sheet_migration_release_irreversible");
      }
      if (!["staged", "recovery_required", "rolling_back"].includes(status)) {
        throw new Error("legacy_sheet_migration_rollback_not_available");
      }
      if (status !== "rolling_back") {
        transaction.set(
          controlRef,
          { status: "rolling_back" },
          { merge: true },
        );
      }
      return true;
    },
  );
  if (!prepared) {
    return { deleted: 0, alreadyAbsent: receipt.stageWrites.length };
  }
  await input.afterRollbackPreparedForTest?.();

  let alreadyAbsent = 0;
  for (const pathChunk of chunks(receipt.stageWrites)) {
    const snapshots = await portalDb.getAll(
      ...pathChunk.map((item) => refForPath(portalDb, item.path)),
    );
    for (let index = 0; index < pathChunk.length; index += 1) {
      const expected = pathChunk[index];
      const snapshot = snapshots[index];
      if (!snapshot.exists) {
        alreadyAbsent += 1;
        continue;
      }
      if (digest(snapshot.data() ?? {}) !== expected.digest) {
        throw new Error(
          `legacy_sheet_migration_rollback_drift:${expected.path}`,
        );
      }
    }
  }

  let deleted = 0;
  for (const pathChunk of chunks(receipt.stageWrites)) {
    const result = await portalDb.runTransaction(async (transaction) => {
      const refs = pathChunk.map((item) => refForPath(portalDb, item.path));
      const snapshots = await transaction.getAll(...refs);
      let chunkDeleted = 0;
      for (let index = 0; index < pathChunk.length; index += 1) {
        const expected = pathChunk[index];
        const snapshot = snapshots[index];
        if (!snapshot.exists) continue;
        if (digest(snapshot.data() ?? {}) !== expected.digest) {
          throw new Error(
            `legacy_sheet_migration_rollback_drift:${expected.path}`,
          );
        }
        transaction.delete(refs[index]);
        chunkDeleted += 1;
      }
      return chunkDeleted;
    });
    deleted += result;
  }
  await controlRef.delete();
  return { deleted, alreadyAbsent };
}
