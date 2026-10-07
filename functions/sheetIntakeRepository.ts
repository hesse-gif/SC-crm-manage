import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { resolveCanonicalProgramId } from "./programCanonical";
import type {
  IntakeSourceRecord,
  PreparedSheetLead,
  PreparedSheetProjection,
  PreparedSheetRow,
  SheetConflictState,
  SheetSyncRunRecord,
} from "./sheetIntakeTypes";

export interface SheetIntakeWriteInput {
  source: IntakeSourceRecord;
  run: SheetSyncRunRecord;
  preparedRows: PreparedSheetRow[];
  preparedLeads: PreparedSheetLead[];
  preparedProjections?: PreparedSheetProjection[];
  conflictState?: SheetConflictState | null;
  operationId?: string | null;
}

export interface SheetIntakeWriteResult {
  runId: string;
  insertedRawRows: number;
  duplicateRawRows: number;
  rawRowRefs: string[];
  leadRefs: string[];
}

export function rawRowPath(docId: string): string {
  return `sheet_raw_rows/${docId}`;
}

export function leadPath(docId: string): string {
  return `program_sheet_leads/${docId}`;
}

export function projectionPath(docId: string): string {
  return `sheet_source_rows/${docId}`;
}

export async function readIntakeSourceConfig(sourceId: string): Promise<Partial<IntakeSourceRecord> | null> {
  const snapshot = await adminDb.collection("intake_sources").doc(sourceId).get();
  return snapshot.exists ? (snapshot.data() as Partial<IntakeSourceRecord>) : null;
}

export async function writeSheetIntakeRun(input: SheetIntakeWriteInput): Promise<SheetIntakeWriteResult> {
  const sourceRef = adminDb.collection("intake_sources").doc(input.source.id);
  const runRef = adminDb.collection("sheet_sync_runs").doc(input.run.id);
  const rawRefs = input.preparedRows.map((row) => adminDb.collection("sheet_raw_rows").doc(row.rawDocId));
  const leadRefs = input.preparedLeads.map((lead) => adminDb.collection("program_sheet_leads").doc(lead.docId));
  const preparedProjections = input.preparedProjections ?? [];
  const projectionRefs = preparedProjections.map((projection) => adminDb.collection("sheet_source_rows").doc(projection.docId));
  const conflictRef = input.conflictState
    ? adminDb.collection("sheet_intake_conflicts").doc(input.run.id)
    : null;
  const existingRaw = new Set<string>();
  const existingLeads = new Set<string>();

  await adminDb.runTransaction(async (tx: Transaction) => {
    const [sourceSnapshot, rawSnapshots, leadSnapshots, projectionSnapshots] = await Promise.all([
      tx.get(sourceRef),
      Promise.all(rawRefs.map((ref) => tx.get(ref))),
      Promise.all(leadRefs.map((ref) => tx.get(ref))),
      Promise.all(projectionRefs.map((ref) => tx.get(ref))),
    ]);
    rawSnapshots.forEach((snapshot) => {
      if (snapshot.exists) existingRaw.add(snapshot.ref.id);
    });
    // Legacy dedup: rows captured before the docId scheme dropped tabName
    // (P1-16) live under `sourceId:tabName:rowNumber:hash`. The rowHash
    // equality query keeps a tab rename from re-inserting the same row.
    const unseenRows = input.preparedRows.filter((row) => !existingRaw.has(row.rawDocId));
    const legacySnapshots = await Promise.all(unseenRows.map((row) =>
      tx.get(
        adminDb.collection("sheet_raw_rows")
          .where("sourceId", "==", input.source.id)
          .where("rowNumber", "==", row.rowNumber)
          .where("rowHash", "==", row.rowHash)
          .limit(1),
      ),
    ));
    legacySnapshots.forEach((snapshot, index) => {
      if (!snapshot.empty) existingRaw.add(unseenRows[index].rawDocId);
    });
    leadSnapshots.forEach((snapshot, index) => {
      if (!snapshot.exists) return;
      assertExistingLeadProgramScopeCompatible(
        snapshot.data() ?? {},
        input.preparedLeads[index].record.canonicalProgramId,
      );
      existingLeads.add(snapshot.ref.id);
    });

    const currentSourceVersion = nonNegativeInteger(sourceSnapshot.get("sourceVersion"));
    const expectedSourceVersion = nonNegativeInteger(input.source.sourceVersion);
    if (currentSourceVersion !== expectedSourceVersion) {
      throw Object.assign(
        new Error(
          `Sheet intake source version changed while the run was in flight: expected ${expectedSourceVersion}, actual ${currentSourceVersion}`,
        ),
        { code: "aborted", errorCode: "write_sheet_intake_run_sheet_intake_source_version_changed" },
      );
    }
    const sourceVersion = currentSourceVersion + 1;
    const projectionRevision = nonNegativeInteger(sourceSnapshot.get("projectionRevision")) +
      (preparedProjections.length > 0 ? 1 : 0);
    const sourcePatch: Record<string, unknown> = {
      ...input.source,
      sourceVersion,
      projectionRevision,
      reconciliationVersion: nonNegativeInteger(sourceSnapshot.get("reconciliationVersion")),
      lastReconciliationRef: sourceSnapshot.get("lastReconciliationRef") ?? null,
      lastSyncRunId: input.run.id,
      lastSyncStatus: input.run.status,
      lastSyncAtIso: input.run.finishedAtIso,
      ...(input.operationId
        ? {
            lastOperationalSync: {
              operationId: input.operationId,
              runId: input.run.id,
              sourceVersion,
              originFingerprint: input.run.originFingerprint ?? "",
            },
          }
        : {}),
      // A sync may have read intake_sources before a concurrent cutover. Keep
      // the transaction's current control-plane value instead of replaying a
      // stale cutover object from the earlier read.
      cutover: sourceSnapshot.get("cutover") ?? input.source.cutover,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!sourceSnapshot.exists) sourcePatch.createdAt = FieldValue.serverTimestamp();
    tx.set(sourceRef, sourcePatch, { merge: true });

    tx.set(runRef, {
      ...input.run,
      insertedRawRows: input.preparedRows.length - existingRaw.size,
      duplicateRawRows: existingRaw.size,
      rawRowRefs: rawRefs.map((ref) => ref.path),
      leadRefs: leadRefs.map((ref) => ref.path),
      projectionRefs: projectionRefs.map((ref) => ref.path),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (conflictRef && input.conflictState) {
      tx.set(conflictRef, {
        id: conflictRef.id,
        sourceId: input.source.id,
        runId: input.run.id,
        code: input.conflictState.code,
        message: input.conflictState.message,
        masked: input.conflictState.masked,
        createdAtIso: input.run.finishedAtIso,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    input.preparedRows.forEach((row, index) => {
      if (existingRaw.has(row.rawDocId)) return;
      tx.set(rawRefs[index], {
        id: row.rawDocId,
        sourceId: input.source.id,
        syncRunId: input.run.id,
        spreadsheetId: input.source.spreadsheetId,
        tabName: input.source.tabName,
        rowNumber: row.rowNumber,
        rowHash: row.rowHash,
        rawCells: row.rawCells,
        capturedAtIso: input.run.finishedAtIso,
        immutable: true,
        sourceType: "google_sheet",
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    input.preparedLeads.forEach((lead, index) => {
      const leadData: Record<string, unknown> = {
        ...lead.record,
        sourceRef: rawRefs[index].path,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (existingLeads.has(lead.docId)) {
        delete leadData.metrics;
        delete leadData.qualificationStatus;
        delete leadData.latestDecisionRef;
      }
      tx.set(leadRefs[index], leadData, { merge: true });
    });

    preparedProjections.forEach((projection, index) => {
      const existing = projectionSnapshots[index];
      const previousCurrent = existing.exists
        ? {
            rowNumber: Number(existing.get("rowProvenance.current.rowNumber")) || projection.record.rowProvenance.current.rowNumber,
            sourceRevision: String(existing.get("rowProvenance.current.sourceRevision") || projection.record.rowProvenance.current.sourceRevision),
          }
        : null;
      const importedAt = existing.exists
        ? String(existing.get("importedAt") || projection.record.importedAt)
        : projection.record.importedAt;
      tx.set(projectionRefs[index], {
        ...projection.record,
        importedAt,
        rowProvenance: {
          previous: previousCurrent &&
            (previousCurrent.rowNumber !== projection.record.rowProvenance.current.rowNumber ||
              previousCurrent.sourceRevision !== projection.record.rowProvenance.current.sourceRevision)
            ? previousCurrent
            : existing.get("rowProvenance.previous") ?? null,
          current: projection.record.rowProvenance.current,
        },
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  });

  return {
    runId: runRef.id,
    insertedRawRows: input.preparedRows.length - existingRaw.size,
    duplicateRawRows: existingRaw.size,
    rawRowRefs: rawRefs.map((ref) => ref.path),
    leadRefs: leadRefs.map((ref) => ref.path),
  };
}

export function assertExistingLeadProgramScopeCompatible(
  existing: Record<string, unknown>,
  expectedCanonicalProgramId: string,
): void {
  const expected = resolveCanonicalProgramId(expectedCanonicalProgramId);
  if (!expected || expected !== expectedCanonicalProgramId) {
    throw scopeConflict("prepared Sheet lead does not carry an exact canonical program scope");
  }

  const declared = ["canonicalProgramId", "programId"] as const;
  const candidates: string[] = [];
  for (const field of declared) {
    if (!Object.prototype.hasOwnProperty.call(existing, field)) continue;
    const raw = typeof existing[field] === "string" ? existing[field].trim() : "";
    if (!raw) throw scopeConflict(`existing Sheet lead has a blank ${field}`);
    candidates.push(resolveCanonicalProgramId(raw));
  }

  const sourceContract = existing.sourceContract;
  if (sourceContract && typeof sourceContract === "object" && !Array.isArray(sourceContract)) {
    const contract = sourceContract as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(contract, "canonicalProgramId")) {
      const raw = typeof contract.canonicalProgramId === "string"
        ? contract.canonicalProgramId.trim()
        : "";
      if (!raw) throw scopeConflict("existing Sheet lead has a blank source contract scope");
      if (raw !== expected) {
        throw scopeConflict("existing Sheet lead source contract conflicts with its reviewed source profile");
      }
      candidates.push(raw);
    }
  }

  const unique = Array.from(new Set(candidates.filter(Boolean)));
  if (unique.length > 1 || (unique.length === 1 && unique[0] !== expected)) {
    throw scopeConflict("existing Sheet lead program scope conflicts with its reviewed source profile");
  }
}

function scopeConflict(message: string): Error {
  return Object.assign(new Error(message), { code: "failed-precondition", errorCode: "scope_conflict_unauthorized" });
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}
