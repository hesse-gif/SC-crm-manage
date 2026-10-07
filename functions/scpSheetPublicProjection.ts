import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  knownSheetSourceProfileByKey,
  type SheetSourceProfile,
} from "./sheetIntakeRuntime";
import {
  completeSheetOperationApplyInTransaction,
  sheetOperationPreviewReference,
  type SheetOperationPreviewIdentity,
} from "./sheetOperationalPreview";
import type { SheetCutoverState } from "./sheetIntakeTypes";

export type ScpSheetDatasetKey = "scpQualificationRows" | "scpVideoRows";

export const SCP_SHEET_PUBLIC_PROJECTION_SCHEMA_VERSION =
  "scp-sheet-public-row-v1";
export const SCP_SHEET_PUBLIC_PROJECTION_COLLECTION =
  "scp_sheet_public_rows";
export const SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD =
  "publicProjectionGenerationWatermarks";

const PRIVATE_ROW_KEYS = new Set([
  "spreadsheetId",
  "sourceSpreadsheetId",
  "sheetUrl",
  "tabName",
  "gid",
  "rawCells",
  "rowHash",
  "sourceRef",
  "sourceId",
]);
// Sheet2 AG/AH are human judgement/output columns. They are writeback-only
// compatibility fields and must never enter the Firestore public projection.
const SHEET2_OUTPUT_KEYS = new Set(["AG", "AH"]);
const VOLATILE_FINGERPRINT_KEYS = new Set([
  "createdAt",
  "createdAtIso",
  "projectedAt",
  "projectedAtIso",
  "updatedAt",
  "updatedAtIso",
]);

export interface ScpSheetPublicProjectionMetadata {
  schemaVersion: typeof SCP_SHEET_PUBLIC_PROJECTION_SCHEMA_VERSION;
  datasetKey: ScpSheetDatasetKey;
  sourceId: string;
  generation: number;
  rowCount: number;
  canonicalFingerprint: string;
  sourceVersion: number;
  cutoverVersion: number;
  projectionRevision: number;
  completedAtIso: string;
  operationId?: string;
}

export interface ScpSheetPublicProjectionDocument {
  id: string;
  schemaVersion: typeof SCP_SHEET_PUBLIC_PROJECTION_SCHEMA_VERSION;
  datasetKey: ScpSheetDatasetKey;
  sourceId: string;
  generation: number;
  rowKey: string;
  sourceRowFingerprint: string;
  publicRow: Record<string, unknown>;
  projectedAtIso: string;
}

export type ScpSheetPublicProjectionBuildReservation = {
  buildToken: string;
  operationId: string;
  datasetKey: ScpSheetDatasetKey;
  sourceId: string;
  generation: number;
  sourceVersionBefore: number;
  sourceVersion: number;
  cutoverVersion: number;
  projectionRevisionBefore: number;
  projectionRevision: number;
  reservedAtIso: string;
};

export type ScpSheetReadSource = "google_sheet" | "firestore_projection";
export type ScpSheetReadParity =
  | "not_checked"
  | "match"
  | "mismatch"
  | "unavailable"
  | "activated";

export interface ScpSheetDatasetControl {
  exists?: boolean;
  sourceId?: string;
  sourceVersion?: number;
  cutover?: unknown;
  publicProjections?: unknown;
  projectionRevision?: number;
  [key: string]: unknown;
}

export interface ScpSheetDatasetReadResult<T extends Record<string, unknown>> {
  rows: T[];
  sourceRead: ScpSheetReadSource;
  parity: ScpSheetReadParity;
  cutoverState: SheetCutoverState;
  cutoverVersion: number;
  projectionGeneration: number | null;
}

type ReadProjectionInput = {
  datasetKey: ScpSheetDatasetKey;
  sourceId: string;
  metadata: ScpSheetPublicProjectionMetadata;
};

export class ScpSheetDatasetEngineError extends Error {
  readonly code:
    | "scp_sheet_cutover_invalid"
    | "scp_sheet_projection_unavailable"
    | "scp_sheet_cutover_changed";
  readonly publicFailureReason:
    | "sheet_cutover_invalid"
    | "firestore_projection_unavailable"
    | "sheet_cutover_changed";

  constructor(
    code: ScpSheetDatasetEngineError["code"],
    publicFailureReason: ScpSheetDatasetEngineError["publicFailureReason"],
    message: string,
  ) {
    super(message);
    this.name = "ScpSheetDatasetEngineError";
    this.code = code;
    this.publicFailureReason = publicFailureReason;
  }
}

export function prepareScpSheetPublicProjection(input: {
  datasetKey: ScpSheetDatasetKey;
  sourceId: string;
  generation: number;
  rows: Record<string, unknown>[];
  projectedAtIso: string;
  sourceVersion: number;
  cutoverVersion: number;
  projectionRevision: number;
  operationId?: string;
}): {
  metadata: ScpSheetPublicProjectionMetadata;
  documents: ScpSheetPublicProjectionDocument[];
} {
  const profile = sourceProfileForDataset(input.datasetKey);
  if (input.sourceId !== profile.sourceId) {
    throw projectionUnavailable("Sheet public projection source does not match its reviewed dataset contract.");
  }
  const generation = positiveInteger(input.generation, "projection generation");
  const projectedAtIso = requiredIso(input.projectedAtIso, "projectedAtIso");
  const rows = sortPublicRows(input.rows.map((row) => publicProjectionRow(row, input.datasetKey)));
  const documents: ScpSheetPublicProjectionDocument[] = rows.map((publicRow, index) => {
    const rowKey = stablePublicRowKey(publicRow, index);
    return {
      id: projectionDocumentId(input.sourceId, input.datasetKey, generation, rowKey),
      schemaVersion: SCP_SHEET_PUBLIC_PROJECTION_SCHEMA_VERSION,
      datasetKey: input.datasetKey,
      sourceId: input.sourceId,
      generation,
      rowKey,
      sourceRowFingerprint: canonicalScpSheetRowFingerprint(publicRow),
      publicRow,
      projectedAtIso,
    };
  });
  return {
    metadata: {
      schemaVersion: SCP_SHEET_PUBLIC_PROJECTION_SCHEMA_VERSION,
      datasetKey: input.datasetKey,
      sourceId: input.sourceId,
      generation,
      rowCount: documents.length,
      canonicalFingerprint: canonicalScpSheetRowsFingerprint(rows),
      sourceVersion: nonNegativeInteger(input.sourceVersion),
      cutoverVersion: nonNegativeInteger(input.cutoverVersion),
      projectionRevision: nonNegativeInteger(input.projectionRevision),
      completedAtIso: projectedAtIso,
      ...(input.operationId
        ? { operationId: requiredOperationId(input.operationId) }
        : {}),
    },
    documents,
  };
}

export function validateScpSheetPublicProjection(input: {
  datasetKey: ScpSheetDatasetKey;
  sourceId: string;
  metadata: unknown;
  documents: unknown[];
}): Record<string, unknown>[] {
  const metadata = parseProjectionMetadata(input.metadata, input.datasetKey, input.sourceId);
  if (input.documents.length !== metadata.rowCount) {
    throw projectionUnavailable("Sheet public projection row count does not match activated metadata.");
  }
  const rowKeys = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const value of input.documents) {
    const document = record(value);
    if (
      document.schemaVersion !== SCP_SHEET_PUBLIC_PROJECTION_SCHEMA_VERSION ||
      document.datasetKey !== input.datasetKey ||
      document.sourceId !== input.sourceId ||
      nonNegativeInteger(document.generation) !== metadata.generation
    ) {
      throw projectionUnavailable("Sheet public projection document contract is stale or mixed.");
    }
    const rowKey = cleanString(document.rowKey, 320);
    if (!rowKey || rowKeys.has(rowKey)) {
      throw projectionUnavailable("Sheet public projection contains a duplicate or missing row key.");
    }
    rowKeys.add(rowKey);
    const publicRow = publicProjectionRow(record(document.publicRow), input.datasetKey);
    if (
      cleanHash(document.sourceRowFingerprint) !==
      canonicalScpSheetRowFingerprint(publicRow)
    ) {
      throw projectionUnavailable("Sheet public projection row fingerprint is stale.");
    }
    rows.push(publicRow);
  }
  const sorted = sortPublicRows(rows);
  if (
    canonicalScpSheetRowsFingerprint(sorted) !==
    metadata.canonicalFingerprint
  ) {
    throw projectionUnavailable("Sheet public projection aggregate fingerprint is stale.");
  }
  return sorted;
}

export function canonicalScpSheetRowsFingerprint(
  rows: Record<string, unknown>[],
): string {
  const canonicalRows = rows
    .map((row) => canonicalValue(publicProjectionRow(row), true))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return hash(JSON.stringify(canonicalRows));
}

export function canonicalScpSheetRowFingerprint(
  row: Record<string, unknown>,
): string {
  return hash(JSON.stringify(canonicalValue(publicProjectionRow(row), true)));
}

export function nextScpSheetProjectionGeneration(input: {
  activeGeneration?: unknown;
  reservedGeneration?: unknown;
  sourceVersion?: unknown;
  generationWatermark?: unknown;
}): number {
  return Math.max(
    nonNegativeInteger(input.activeGeneration),
    nonNegativeInteger(input.reservedGeneration),
    nonNegativeInteger(input.sourceVersion),
    nonNegativeInteger(input.generationWatermark),
  ) + 1;
}

export async function readScpSheetDatasetWithCutover<
  T extends Record<string, unknown>,
>(input: {
  datasetKey: ScpSheetDatasetKey;
  readControl: () => Promise<ScpSheetDatasetControl | null>;
  readGoogle: () => Promise<T[]>;
  readProjection: (input: ReadProjectionInput) => Promise<T[]>;
}): Promise<ScpSheetDatasetReadResult<T>> {
  const profile = sourceProfileForDataset(input.datasetKey);
  const beforeRaw = await input.readControl();
  const before = parseControl(beforeRaw, profile, input.datasetKey);
  let rows: T[];
  let sourceRead: ScpSheetReadSource;
  let parity: ScpSheetReadParity;

  if (before.state === "shadow") {
    rows = await input.readGoogle();
    sourceRead = "google_sheet";
    parity = "not_checked";
  } else if (before.state === "dual_read") {
    const googleRowsPromise = input.readGoogle();
    const projectionRowsPromise = before.metadata
      ? input.readProjection({
          datasetKey: input.datasetKey,
          sourceId: profile.sourceId,
          metadata: before.metadata,
        }).then(
          (projectionRows) => ({ ok: true as const, rows: projectionRows }),
          () => ({ ok: false as const, rows: [] as T[] }),
        )
      : Promise.resolve({ ok: false as const, rows: [] as T[] });
    const [googleRows, projection] = await Promise.all([
      googleRowsPromise,
      projectionRowsPromise,
    ]);
    rows = googleRows;
    sourceRead = "google_sheet";
    parity = !projection.ok
      ? "unavailable"
      : canonicalScpSheetRowsFingerprint(googleRows) ===
          canonicalScpSheetRowsFingerprint(projection.rows)
        ? "match"
        : "mismatch";
  } else {
    if (!before.metadata) {
      throw projectionUnavailable(
        "Sheet cutover requires activated Firestore projection metadata.",
      );
    }
    rows = await input.readProjection({
      datasetKey: input.datasetKey,
      sourceId: profile.sourceId,
      metadata: before.metadata,
    });
    sourceRead = "firestore_projection";
    parity = "activated";
  }

  const afterRaw = await input.readControl();
  const after = parseControl(afterRaw, profile, input.datasetKey);
  if (before.fence !== after.fence) {
    throw new ScpSheetDatasetEngineError(
      "scp_sheet_cutover_changed",
      "sheet_cutover_changed",
      "Sheet cutover state changed while the dataset was being read.",
    );
  }

  return {
    rows: rows.map((row) => publicProjectionRow(row, input.datasetKey)) as T[],
    sourceRead,
    parity,
    cutoverState: before.state,
    cutoverVersion: before.version,
    projectionGeneration: before.metadata?.generation ?? null,
  };
}

export async function readScpSheetDatasetControl(
  datasetKey: ScpSheetDatasetKey,
): Promise<ScpSheetDatasetControl | null> {
  const profile = sourceProfileForDataset(datasetKey);
  const snapshot = await adminDb.collection("intake_sources").doc(profile.sourceId).get();
  return snapshot.exists
    ? {
        exists: true,
        sourceId: profile.sourceId,
        ...record(snapshot.data()),
      }
    : null;
}

export async function readScpSheetPublicProjection(input: ReadProjectionInput): Promise<Record<string, unknown>[]> {
  const snapshot = await adminDb
    .collection(SCP_SHEET_PUBLIC_PROJECTION_COLLECTION)
    .where("sourceId", "==", input.sourceId)
    .where("datasetKey", "==", input.datasetKey)
    .where("generation", "==", input.metadata.generation)
    .get();
  return validateScpSheetPublicProjection({
    datasetKey: input.datasetKey,
    sourceId: input.sourceId,
    metadata: input.metadata,
    documents: snapshot.docs.map((document) => document.data()),
  });
}

export async function reserveScpSheetPublicProjectionBuild(input: {
  datasetKey: ScpSheetDatasetKey;
  projectedAtIso?: string;
  expectedSourceVersion?: number;
  expectedCutoverVersion?: number;
  expectedProjectionRevision?: number;
  operationId?: string;
}): Promise<ScpSheetPublicProjectionBuildReservation> {
  const profile = sourceProfileForDataset(input.datasetKey);
  const sourceRef = adminDb.collection("intake_sources").doc(profile.sourceId);
  const projectedAtIso = input.projectedAtIso ?? new Date().toISOString();
  const expectedSourceVersion = input.expectedSourceVersion === undefined
    ? null
    : requiredNonNegativeInteger(input.expectedSourceVersion, "expected source version");
  const expectedCutoverVersion = input.expectedCutoverVersion === undefined
    ? null
    : requiredNonNegativeInteger(input.expectedCutoverVersion, "expected cutover version");
  const expectedProjectionRevision = input.expectedProjectionRevision === undefined
    ? null
    : requiredNonNegativeInteger(input.expectedProjectionRevision, "expected projection revision");
  const operationId = requiredOperationId(input.operationId ??
    `projection-${hash(`${input.datasetKey}\u0000${randomUUID()}\u0000${projectedAtIso}`).slice(0, 40)}`);
  const buildToken = hash(`${operationId}\u0000${randomUUID()}\u0000${projectedAtIso}`);

  return adminDb.runTransaction(async (transaction): Promise<ScpSheetPublicProjectionBuildReservation> => {
    const snapshot = await transaction.get(sourceRef);
    const raw: ScpSheetDatasetControl | null = snapshot.exists
      ? { exists: true, sourceId: profile.sourceId, ...record(snapshot.data()) }
      : null;
    const control = parseControl(raw, profile, input.datasetKey);
    const currentSource = record(snapshot.data());
    if (
      expectedSourceVersion !== null ||
      expectedCutoverVersion !== null ||
      expectedProjectionRevision !== null
    ) {
      assertReviewedSourceTopologyForCas(currentSource, profile);
    }
    const currentSourceVersionForCas = expectedSourceVersion !== null &&
      Object.prototype.hasOwnProperty.call(currentSource, "sourceVersion")
      ? requiredNonNegativeInteger(currentSource.sourceVersion, "source version")
      : control.sourceVersion;
    const storedProjectionRevision = snapshot.get("projectionRevision");
    const currentProjectionRevision = expectedProjectionRevision !== null && storedProjectionRevision !== undefined
      ? requiredNonNegativeInteger(storedProjectionRevision, "projection revision")
      : nonNegativeInteger(storedProjectionRevision);
    if (
      (expectedSourceVersion !== null && (
        control.sourceVersion !== expectedSourceVersion ||
        currentSourceVersionForCas !== expectedSourceVersion
      )) ||
      (expectedCutoverVersion !== null && control.version !== expectedCutoverVersion) ||
      (expectedProjectionRevision !== null && currentProjectionRevision !== expectedProjectionRevision)
    ) {
      throw projectionChanged("Sheet source changed after the operational preview; create a new preview.");
    }

    const currentBuilds = record(currentSource.publicProjectionBuilds);
    const currentWatermarks = record(
      currentSource[SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD],
    );
    const currentGenerationWatermark = nonNegativeInteger(
      currentWatermarks[input.datasetKey],
    );
    const existing = parseBuildReservation(currentBuilds[input.datasetKey]);
    assertScpSheetPublicProjectionReservationOwnership(existing, operationId);
    if (existing) {
      if (
        existing.datasetKey !== input.datasetKey ||
        existing.sourceId !== profile.sourceId ||
        existing.sourceVersionBefore !== control.sourceVersion ||
        existing.sourceVersion !== control.sourceVersion + 1 ||
        existing.cutoverVersion !== control.version ||
        existing.projectionRevisionBefore !== currentProjectionRevision ||
        existing.projectionRevision !== (input.datasetKey === "scpVideoRows"
          ? currentProjectionRevision + 1
          : currentProjectionRevision)
      ) {
        throw projectionChanged("The existing projection reservation drifted from its source fence.");
      }
      if (currentGenerationWatermark < existing.generation) {
        transaction.set(sourceRef, {
          [SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD]: {
            ...currentWatermarks,
            [input.datasetKey]: existing.generation,
          },
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      return existing;
    }

    const nextProjectionRevision = input.datasetKey === "scpVideoRows"
      ? currentProjectionRevision + 1
      : currentProjectionRevision;
    const nextSourceVersion = control.sourceVersion + 1;
    const nextGeneration = nextScpSheetProjectionGeneration({
      activeGeneration: control.metadata?.generation,
      sourceVersion: control.sourceVersion,
      generationWatermark: currentGenerationWatermark,
    });
    const reservation: ScpSheetPublicProjectionBuildReservation = {
      buildToken,
      operationId,
      datasetKey: input.datasetKey,
      sourceId: profile.sourceId,
      generation: nextGeneration,
      sourceVersionBefore: control.sourceVersion,
      sourceVersion: nextSourceVersion,
      cutoverVersion: control.version,
      projectionRevisionBefore: currentProjectionRevision,
      projectionRevision: nextProjectionRevision,
      reservedAtIso: projectedAtIso,
    };
    transaction.set(sourceRef, {
      ...(snapshot.exists ? {} : sourceBootstrap(profile, projectedAtIso)),
      publicProjectionBuilds: {
        ...currentBuilds,
        [input.datasetKey]: reservation,
      },
      [SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD]: {
        ...currentWatermarks,
        [input.datasetKey]: nextGeneration,
      },
      updatedAtIso: projectedAtIso,
      updatedBy: "sheet_public_projection_engine",
      updatedAt: FieldValue.serverTimestamp(),
      ...(snapshot.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    }, { merge: true });
    return reservation;
  });
}

export async function releaseScpSheetPublicProjectionBuild(input: {
  datasetKey: ScpSheetDatasetKey;
  operationId: string;
  buildToken?: string;
  releasedAtIso?: string;
}): Promise<boolean> {
  const profile = sourceProfileForDataset(input.datasetKey);
  const sourceRef = adminDb.collection("intake_sources").doc(profile.sourceId);
  const operationId = requiredOperationId(input.operationId);
  const buildToken = input.buildToken === undefined
    ? null
    : requiredBuildToken(input.buildToken);
  const releasedAtIso = input.releasedAtIso ?? new Date().toISOString();
  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(sourceRef);
    if (!snapshot.exists) return false;
    const source = record(snapshot.data());
    const builds = record(source.publicProjectionBuilds);
    const watermarks = record(
      source[SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD],
    );
    const existing = parseBuildReservation(builds[input.datasetKey]);
    if (
      !existing ||
      existing.operationId !== operationId ||
      (buildToken !== null && existing.buildToken !== buildToken)
    ) return false;
    const generationWatermark = Math.max(
      nonNegativeInteger(watermarks[input.datasetKey]),
      existing.generation,
    );
    transaction.update(sourceRef, {
      [`publicProjectionBuilds.${input.datasetKey}`]: FieldValue.delete(),
      [`${SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD}.${input.datasetKey}`]:
        generationWatermark,
      updatedAtIso: releasedAtIso,
      updatedBy: "sheet_public_projection_engine",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

export async function replaceScpSheetPublicProjection(input: {
  datasetKey: ScpSheetDatasetKey;
  rows: Record<string, unknown>[];
  projectedAtIso?: string;
  expectedSourceVersion?: number;
  expectedCutoverVersion?: number;
  expectedProjectionRevision?: number;
  operationId?: string;
  reservation?: ScpSheetPublicProjectionBuildReservation;
  completion?: SheetOperationPreviewIdentity & {
    previewToken: unknown;
    result: Record<string, unknown>;
    nowIso?: string;
  };
}): Promise<ScpSheetPublicProjectionMetadata> {
  const profile = sourceProfileForDataset(input.datasetKey);
  const sourceRef = adminDb.collection("intake_sources").doc(profile.sourceId);
  const projectedAtIso = input.projectedAtIso ?? new Date().toISOString();
  const reservation = input.reservation ?? await reserveScpSheetPublicProjectionBuild({
    datasetKey: input.datasetKey,
    projectedAtIso,
    expectedSourceVersion: input.expectedSourceVersion,
    expectedCutoverVersion: input.expectedCutoverVersion,
    expectedProjectionRevision: input.expectedProjectionRevision,
    operationId: input.operationId,
  });
  validateProvidedReservation(reservation, input, profile);
  const prepared = prepareScpSheetPublicProjection({
    datasetKey: input.datasetKey,
    sourceId: profile.sourceId,
    generation: reservation.generation,
    rows: input.rows,
    projectedAtIso,
    sourceVersion: reservation.sourceVersion,
    cutoverVersion: reservation.cutoverVersion,
    projectionRevision: reservation.projectionRevision,
    operationId: reservation.operationId,
  });

  for (let offset = 0; offset < prepared.documents.length; offset += 400) {
    const batch = adminDb.batch();
    for (const document of prepared.documents.slice(offset, offset + 400)) {
      batch.set(
        adminDb.collection(SCP_SHEET_PUBLIC_PROJECTION_COLLECTION).doc(document.id),
        {
          ...document,
          projectedAt: FieldValue.serverTimestamp(),
        },
      );
    }
    await batch.commit();
  }

  const previewRef = input.completion
    ? sheetOperationPreviewReference({
        previewToken: input.completion.previewToken,
        tokenVersion: input.completion.tokenVersion,
      })
    : null;
  const activated = await adminDb.runTransaction(async (transaction): Promise<ScpSheetPublicProjectionMetadata> => {
    const currentSnapshot = await transaction.get(sourceRef);
    const previewSnapshot = previewRef ? await transaction.get(previewRef) : null;
    const currentRaw: ScpSheetDatasetControl | null = currentSnapshot.exists
      ? { exists: true, sourceId: profile.sourceId, ...record(currentSnapshot.data()) }
      : null;
    const current = parseControl(currentRaw, profile, input.datasetKey);
    const currentSource = record(currentSnapshot.data());
    const currentBuilds = record(currentSource.publicProjectionBuilds);
    const currentWatermarks = record(
      currentSource[SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD],
    );
    const activeMetadataRaw = record(currentSource.publicProjections)[input.datasetKey];
    if (cleanString(record(activeMetadataRaw).operationId, 160) === reservation.operationId) {
      const activeMetadata = parseProjectionMetadata(activeMetadataRaw, input.datasetKey, profile.sourceId);
      if (
        activeMetadata.generation !== prepared.metadata.generation ||
        activeMetadata.sourceVersion !== reservation.sourceVersion ||
        activeMetadata.cutoverVersion !== reservation.cutoverVersion ||
        activeMetadata.projectionRevision !== reservation.projectionRevision ||
        activeMetadata.canonicalFingerprint !== prepared.metadata.canonicalFingerprint ||
        (input.completion && cleanString(record(previewSnapshot?.data()).status, 32) !== "completed")
      ) {
        throw projectionChanged("The completed projection does not match this operation.");
      }
      return activeMetadata;
    }
    const activeReservation = parseBuildReservation(currentBuilds[input.datasetKey]);
    if (
      !sameBuildReservation(activeReservation, reservation) ||
      current.sourceVersion !== reservation.sourceVersionBefore ||
      current.version !== reservation.cutoverVersion ||
      nonNegativeInteger(currentSnapshot.get("projectionRevision")) !== reservation.projectionRevisionBefore
    ) {
      throw projectionChanged("Sheet source changed before its public projection could be activated.");
    }
    const publicProjections = {
      ...record(currentSource.publicProjections),
      [input.datasetKey]: prepared.metadata,
    };
    const publicProjectionBuilds = { ...currentBuilds };
    delete publicProjectionBuilds[input.datasetKey];
    transaction.set(sourceRef, {
      sourceVersion: reservation.sourceVersion,
      projectionRevision: reservation.projectionRevision,
      publicProjections,
      publicProjectionBuilds,
      [SCP_SHEET_PUBLIC_PROJECTION_GENERATION_WATERMARKS_FIELD]: {
        ...currentWatermarks,
        [input.datasetKey]: Math.max(
          nonNegativeInteger(currentWatermarks[input.datasetKey]),
          reservation.generation,
        ),
      },
      lastSyncStatus: "success",
      lastSyncAtIso: prepared.metadata.completedAtIso,
      updatedAtIso: prepared.metadata.completedAtIso,
      updatedBy: "sheet_public_projection_engine",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (input.completion && previewSnapshot) {
      completeSheetOperationApplyInTransaction({
        ...input.completion,
        transaction,
        snapshot: previewSnapshot,
        result: {
          ...input.completion.result,
          sourceVersionBefore: reservation.sourceVersionBefore,
          sourceVersion: reservation.sourceVersion,
          projectionGeneration: reservation.generation,
          projectionRevision: reservation.projectionRevision,
        },
        nowIso: input.completion.nowIso ?? prepared.metadata.completedAtIso,
      });
    }
    return prepared.metadata;
  });

  await deleteInactiveProjectionRows(
    profile.sourceId,
    input.datasetKey,
    activated.generation,
  );
  return activated;
}

function parseBuildReservation(value: unknown): ScpSheetPublicProjectionBuildReservation | null {
  const candidate = record(value);
  if (!cleanString(candidate.operationId, 160)) return null;
  const buildToken = cleanHash(candidate.buildToken);
  const datasetKey = candidate.datasetKey;
  if (
    !buildToken ||
    (datasetKey !== "scpQualificationRows" && datasetKey !== "scpVideoRows")
  ) {
    throw projectionChanged("Stored public projection reservation is invalid.");
  }
  return {
    buildToken,
    operationId: requiredOperationId(candidate.operationId),
    datasetKey,
    sourceId: cleanString(candidate.sourceId, 240),
    generation: positiveInteger(candidate.generation, "projection generation"),
    sourceVersionBefore: requiredNonNegativeInteger(candidate.sourceVersionBefore, "source version before"),
    sourceVersion: requiredNonNegativeInteger(candidate.sourceVersion, "source version"),
    cutoverVersion: requiredNonNegativeInteger(candidate.cutoverVersion, "cutover version"),
    projectionRevisionBefore: requiredNonNegativeInteger(candidate.projectionRevisionBefore, "projection revision before"),
    projectionRevision: requiredNonNegativeInteger(candidate.projectionRevision, "projection revision"),
    reservedAtIso: requiredIso(candidate.reservedAtIso, "reservation timestamp"),
  };
}

export function assertScpSheetPublicProjectionReservationOwnership(
  existing: ScpSheetPublicProjectionBuildReservation | null,
  operationId: string,
): void {
  const requestedOperationId = requiredOperationId(operationId);
  if (existing && existing.operationId !== requestedOperationId) {
    throw projectionChanged(
      "The Sheet public projection source fence is already reserved by another operation.",
    );
  }
}

function sameBuildReservation(
  left: ScpSheetPublicProjectionBuildReservation | null,
  right: ScpSheetPublicProjectionBuildReservation,
): boolean {
  return Boolean(left) && Object.keys(right).every(
    (key) => left?.[key as keyof ScpSheetPublicProjectionBuildReservation] ===
      right[key as keyof ScpSheetPublicProjectionBuildReservation],
  );
}

function validateProvidedReservation(
  reservation: ScpSheetPublicProjectionBuildReservation,
  input: {
    datasetKey: ScpSheetDatasetKey;
    expectedSourceVersion?: number;
    expectedCutoverVersion?: number;
    expectedProjectionRevision?: number;
    operationId?: string;
  },
  profile: SheetSourceProfile,
): void {
  const normalized = parseBuildReservation(reservation);
  if (
    !sameBuildReservation(normalized, reservation) ||
    reservation.datasetKey !== input.datasetKey ||
    reservation.sourceId !== profile.sourceId ||
    (input.operationId !== undefined && reservation.operationId !== requiredOperationId(input.operationId)) ||
    (input.expectedSourceVersion !== undefined &&
      reservation.sourceVersionBefore !== requiredNonNegativeInteger(input.expectedSourceVersion, "expected source version")) ||
    (input.expectedCutoverVersion !== undefined &&
      reservation.cutoverVersion !== requiredNonNegativeInteger(input.expectedCutoverVersion, "expected cutover version")) ||
    (input.expectedProjectionRevision !== undefined &&
      reservation.projectionRevisionBefore !== requiredNonNegativeInteger(input.expectedProjectionRevision, "expected projection revision"))
  ) {
    throw projectionChanged("The supplied public projection reservation does not match its source fence.");
  }
}

export function datasetSourceProfile(
  datasetKey: ScpSheetDatasetKey,
): SheetSourceProfile {
  return sourceProfileForDataset(datasetKey);
}

function assertReviewedSourceTopologyForCas(
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
      cleanString(source[field], 240) !== expected
    ) {
      throw new ScpSheetDatasetEngineError(
        "scp_sheet_cutover_changed",
        "sheet_cutover_changed",
        `Sheet source ${field} changed after the operational preview.`,
      );
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(source, "startRow") &&
    requiredNonNegativeInteger(source.startRow, "start row") !== profile.startRow
  ) {
    throw new ScpSheetDatasetEngineError(
      "scp_sheet_cutover_changed",
      "sheet_cutover_changed",
      "Sheet source start row changed after the operational preview.",
    );
  }
}

function sourceProfileForDataset(datasetKey: ScpSheetDatasetKey): SheetSourceProfile {
  const key = datasetKey === "scpQualificationRows"
    ? "participant_selection"
    : "content_review";
  const profile = knownSheetSourceProfileByKey(key);
  if (!profile) {
    throw new ScpSheetDatasetEngineError(
      "scp_sheet_cutover_invalid",
      "sheet_cutover_invalid",
      "Reviewed Sheet dataset source profile is missing.",
    );
  }
  return profile;
}

function parseControl(
  value: ScpSheetDatasetControl | null,
  profile: SheetSourceProfile,
  datasetKey: ScpSheetDatasetKey,
): {
  state: SheetCutoverState;
  version: number;
  sourceVersion: number;
  metadata: ScpSheetPublicProjectionMetadata | null;
  fence: string;
} {
  if (!value) {
    return {
      state: "shadow",
      version: 0,
      sourceVersion: 0,
      metadata: null,
      fence: hash("absent"),
    };
  }
  if (value.sourceId && value.sourceId !== profile.sourceId) {
    throw invalidCutover("Stored Sheet source ID does not match its reviewed dataset contract.");
  }
  const cutover = record(value.cutover);
  const hasExplicitState = Object.prototype.hasOwnProperty.call(cutover, "state") && cutover.state !== "";
  const state = hasExplicitState ? parseCutoverState(cutover.state) : "shadow";
  if (!state) throw invalidCutover("Stored Sheet cutover state is invalid.");
  const version = nonNegativeInteger(cutover.version);
  if (cutover.version !== undefined && Number(cutover.version) !== version) {
    throw invalidCutover("Stored Sheet cutover version is invalid.");
  }
  const sourceVersion = nonNegativeInteger(value.sourceVersion);
  const rawMetadata = record(value.publicProjections)[datasetKey];
  const metadata = rawMetadata
    ? parseProjectionMetadata(rawMetadata, datasetKey, profile.sourceId)
    : null;
  const fence = hash(JSON.stringify({
    exists: value.exists !== false,
    sourceId: profile.sourceId,
    sourceVersion,
    state,
    version,
    projection: metadata
      ? {
          schemaVersion: metadata.schemaVersion,
          generation: metadata.generation,
          canonicalFingerprint: metadata.canonicalFingerprint,
          sourceVersion: metadata.sourceVersion,
          cutoverVersion: metadata.cutoverVersion,
          projectionRevision: metadata.projectionRevision,
        }
      : null,
  }));
  return { state, version, sourceVersion, metadata, fence };
}

function parseProjectionMetadata(
  value: unknown,
  datasetKey: ScpSheetDatasetKey,
  sourceId: string,
): ScpSheetPublicProjectionMetadata {
  const metadata = record(value);
  if (
    metadata.schemaVersion !== SCP_SHEET_PUBLIC_PROJECTION_SCHEMA_VERSION ||
    metadata.datasetKey !== datasetKey ||
    metadata.sourceId !== sourceId
  ) {
    throw projectionUnavailable("Sheet public projection metadata contract is invalid.");
  }
  const generation = positiveInteger(metadata.generation, "projection generation");
  const rowCount = nonNegativeInteger(metadata.rowCount);
  if (Number(metadata.rowCount) !== rowCount) {
    throw projectionUnavailable("Sheet public projection row count metadata is invalid.");
  }
  const canonicalFingerprint = cleanHash(metadata.canonicalFingerprint);
  if (!canonicalFingerprint) {
    throw projectionUnavailable("Sheet public projection aggregate fingerprint is invalid.");
  }
  return {
    schemaVersion: SCP_SHEET_PUBLIC_PROJECTION_SCHEMA_VERSION,
    datasetKey,
    sourceId,
    generation,
    rowCount,
    canonicalFingerprint,
    sourceVersion: nonNegativeInteger(metadata.sourceVersion),
    cutoverVersion: nonNegativeInteger(metadata.cutoverVersion),
    projectionRevision: nonNegativeInteger(metadata.projectionRevision),
    completedAtIso: requiredIso(metadata.completedAtIso, "projection completedAtIso"),
    ...(cleanString(metadata.operationId, 160)
      ? { operationId: requiredOperationId(metadata.operationId) }
      : {}),
  };
}

function publicProjectionRow(value: Record<string, unknown>, datasetKey?: ScpSheetDatasetKey): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_ROW_KEYS.has(key) || (datasetKey === "scpQualificationRows" && SHEET2_OUTPUT_KEYS.has(key)) || item === undefined) continue;
    out[key] = clonePublicValue(item, datasetKey);
  }
  return out;
}

function clonePublicValue(value: unknown, datasetKey?: ScpSheetDatasetKey): unknown {
  if (Array.isArray(value)) return value.map((item) => clonePublicValue(item, datasetKey));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_ROW_KEYS.has(key) || (datasetKey === "scpQualificationRows" && SHEET2_OUTPUT_KEYS.has(key)) || item === undefined) continue;
    out[key] = clonePublicValue(item, datasetKey);
  }
  return out;
}

function canonicalValue(value: unknown, omitVolatile: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, omitVolatile));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => item !== undefined && !(omitVolatile && VOLATILE_FINGERPRINT_KEYS.has(key)))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item, omitVolatile)]),
  );
}

function sortPublicRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((left, right) => {
    const leftKey = stablePublicRowKey(left, 0);
    const rightKey = stablePublicRowKey(right, 0);
    return leftKey.localeCompare(rightKey) ||
      JSON.stringify(canonicalValue(left, true)).localeCompare(
        JSON.stringify(canonicalValue(right, true)),
      );
  });
}

function stablePublicRowKey(row: Record<string, unknown>, index: number): string {
  const id = cleanString(row.id, 240);
  if (id) return `id:${id}`;
  const rowNumber = nonNegativeInteger(row.rowNumber);
  if (rowNumber > 0) return `row:${rowNumber}`;
  return `hash:${canonicalScpSheetRowFingerprint(row).slice(0, 32)}:${index}`;
}

function projectionDocumentId(
  sourceId: string,
  datasetKey: ScpSheetDatasetKey,
  generation: number,
  rowKey: string,
): string {
  return `scp-sheet-public-${hash(`${sourceId}\u0000${datasetKey}\u0000${generation}\u0000${rowKey}`).slice(0, 48)}`;
}

async function deleteInactiveProjectionRows(
  sourceId: string,
  datasetKey: ScpSheetDatasetKey,
  cleanupGeneration: number,
): Promise<void> {
  try {
    const sourceRef = adminDb.collection("intake_sources").doc(sourceId);
    const snapshot = await adminDb
      .collection(SCP_SHEET_PUBLIC_PROJECTION_COLLECTION)
      .where("sourceId", "==", sourceId)
      .where("datasetKey", "==", datasetKey)
      .get();
    const olderCandidates = snapshot.docs.filter(
      (document) => shouldDeleteScpSheetProjectionGeneration(
        document.get("generation"),
        cleanupGeneration,
      ),
    );
    for (let offset = 0; offset < olderCandidates.length; offset += 400) {
      const candidates = olderCandidates.slice(offset, offset + 400);
      await adminDb.runTransaction(async (transaction) => {
        // Reading the control document in the same transaction makes activation a CAS
        // boundary. The strict generation ordering below independently guarantees that
        // delayed cleanup for generation N cannot select N+1 or an in-flight successor.
        const sourceSnapshot = await transaction.get(sourceRef);
        const protectedGenerations = projectionGenerationsToPreserve(
          sourceSnapshot.data(),
          datasetKey,
          cleanupGeneration,
        );
        for (const document of candidates) {
          if (
            shouldDeleteScpSheetProjectionGeneration(
              document.get("generation"),
              cleanupGeneration,
              protectedGenerations,
            )
          ) {
            transaction.delete(document.ref);
          }
        }
      });
    }
  } catch {
    // Inactive generations are never readable without activated metadata.
    // Cleanup is best-effort so an index/transient cleanup failure cannot undo
    // an already-validated projection activation.
  }
}

export function shouldDeleteScpSheetProjectionGeneration(
  candidateGeneration: unknown,
  cleanupGeneration: number,
  protectedGenerations: ReadonlySet<number> = new Set<number>(),
): boolean {
  const candidate = Number(candidateGeneration);
  return Number.isInteger(candidate) && candidate > 0 &&
    Number.isInteger(cleanupGeneration) && cleanupGeneration > 0 &&
    candidate < cleanupGeneration &&
    !protectedGenerations.has(candidate);
}

function projectionGenerationsToPreserve(
  sourceValue: unknown,
  datasetKey: ScpSheetDatasetKey,
  cleanupGeneration: number,
): ReadonlySet<number> {
  const source = record(sourceValue);
  const activeMetadata = record(record(source.publicProjections)[datasetKey]);
  const activeReservation = record(record(source.publicProjectionBuilds)[datasetKey]);
  const protectedGenerations = new Set<number>([cleanupGeneration]);
  for (const value of [activeMetadata.generation, activeReservation.generation]) {
    const generation = Number(value);
    if (Number.isInteger(generation) && generation > 0) {
      protectedGenerations.add(generation);
    }
  }
  return protectedGenerations;
}

function sourceBootstrap(
  profile: SheetSourceProfile,
  nowIso: string,
): Record<string, unknown> {
  return {
    id: profile.sourceId,
    sourceType: "google_sheet",
    spreadsheetId: profile.spreadsheetId,
    tabName: profile.tabName,
    firstTabPolicy: "metadata_order",
    startRow: profile.startRow,
    status: "active",
    syncMode: "poll",
    gid: profile.gid,
    tabNamePattern: null,
    headerAliases: null,
    domain: profile.domain,
    projectionStrategy: profile.projectionStrategy,
    cutover: {
      state: "shadow",
      version: 0,
      owner: "system",
      enteredAtIso: nowIso,
      updatedAtIso: nowIso,
      targetExitAt: null,
      rollbackCheckpoint: null,
      lastRollbackAtIso: null,
    },
  };
}

function parseCutoverState(value: unknown): SheetCutoverState | null {
  return value === "shadow" || value === "dual_read" || value === "primary" ||
    value === "rollbackable_primary" || value === "retired"
    ? value
    : null;
}

function invalidCutover(message: string): ScpSheetDatasetEngineError {
  return new ScpSheetDatasetEngineError(
    "scp_sheet_cutover_invalid",
    "sheet_cutover_invalid",
    message,
  );
}

function projectionUnavailable(message: string): ScpSheetDatasetEngineError {
  return new ScpSheetDatasetEngineError(
    "scp_sheet_projection_unavailable",
    "firestore_projection_unavailable",
    message,
  );
}

function projectionChanged(message: string): ScpSheetDatasetEngineError {
  return new ScpSheetDatasetEngineError(
    "scp_sheet_cutover_changed",
    "sheet_cutover_changed",
    message,
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw projectionUnavailable(`Sheet public ${field} is invalid.`);
  }
  return parsed;
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw projectionUnavailable(`Sheet public ${field} is invalid.`);
  }
  return parsed;
}

function cleanString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanHash(value: unknown): string {
  const normalized = cleanString(value, 64).toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

function requiredBuildToken(value: unknown): string {
  const normalized = cleanHash(value);
  if (!normalized) {
    throw projectionUnavailable("Sheet public projection build token is invalid.");
  }
  return normalized;
}

function requiredOperationId(value: unknown): string {
  const normalized = cleanString(value, 160);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,159}$/.test(normalized)) {
    throw projectionUnavailable("Sheet public projection operation ID is invalid.");
  }
  return normalized;
}

function requiredIso(value: unknown, field: string): string {
  const text = cleanString(value, 80);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw projectionUnavailable(`Sheet public ${field} is invalid.`);
  }
  return new Date(parsed).toISOString();
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
