import {
  type DocumentReference,
  type DocumentSnapshot,
  FieldPath,
  FieldValue,
} from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { globalCandidateIdentityData } from "./candidateScope";
import { planLegacyCandidateScopeRepair } from "./candidateScopeRepairCore";
import { resolveCanonicalProgramId } from "./programCanonical";

type RepairRequest = {
  auth?: { uid?: string; token?: { role?: string; team?: string } };
  data?: unknown;
};

type CandidateRow = {
  id: string;
  ref: DocumentReference;
  data: Record<string, unknown>;
  identityConflict?: {
    reason: "legacy_candidate_snapshot_identity_conflict";
    evidence: Record<string, unknown>;
  };
};

type CoreRepairPlan = Extract<
  ReturnType<typeof planLegacyCandidateScopeRepair>,
  { status: "repair" }
>;

type PreparedCandidate =
  | {
      row: CandidateRow;
      status: "unchanged" | "human_gate";
      reason: string;
      deleteFields: string[];
    }
  | {
      row: CandidateRow;
      status: "repair";
      reason: string;
      deleteFields: string[];
      plan: CoreRepairPlan;
      targetRef: DocumentReference;
    };

type RepairResult = {
  candidateId: string;
  status: "repair" | "human_gate" | "unchanged" | "skipped";
  reason: string;
  targetRef?: string;
  targetExists?: boolean;
  participationPatch?: Record<string, unknown>;
  deleteFields?: string[];
  rowRef?: DocumentReference;
  gateRef?: DocumentReference;
  gateExists?: boolean;
  gateEvidence?: Record<string, unknown>;
};

export const CANDIDATE_SCOPE_REPAIR_CONFIRMATION =
  "repair-legacy-candidate-scopes-v2";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function claimedRunIds(candidate: Record<string, unknown>): string[] {
  return Array.from(new Set([
    candidate.sourceRunId,
    candidate.sourceRunRef,
    candidate.runRef,
  ].map(text).map((value) => value.replace(/^discovery_runs\//, "")).filter((value) => /^[A-Za-z0-9_-]{1,180}$/.test(value))));
}

function declaredLegacyEvidenceConflict(candidate: Record<string, unknown>): string {
  for (const field of ["canonicalProgramId", "programId"] as const) {
    if (hasOwn(candidate, field) && !text(candidate[field])) {
      return "legacy_program_scope_blank";
    }
  }
  for (const field of ["sourceRunId", "sourceRunRef", "runRef"] as const) {
    if (!hasOwn(candidate, field)) continue;
    const value = text(candidate[field]);
    if (!value || !/^(?:discovery_runs\/)?[A-Za-z0-9_-]{1,180}$/.test(value)) {
      return "legacy_source_run_invalid";
    }
  }
  return "";
}

function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(50, Math.trunc(value)))
    : 25;
}

function cursorId(value: unknown): string {
  const id = text(value);
  if (!id) return "";
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(id)) {
    throw Object.assign(new Error("invalid-argument: afterCandidateId is invalid"), {
      code: "invalid-argument", errorCode: "cursor_id_after_candidate_id_invalid",
    });
  }
  return id;
}

function candidateRowFromSnapshot(snapshot: DocumentSnapshot): CandidateRow {
  const stored = record(snapshot.data());
  const authoritativeId = snapshot.id;
  const authoritativeRef = snapshot.ref.path;
  const expectedClaims: Record<string, string> = {
    id: authoritativeId,
    candidateId: authoritativeId,
    candidateRef: authoritativeRef,
  };
  const conflictingFields = Object.entries(expectedClaims)
    .filter(([field, expected]) => hasOwn(stored, field) && text(stored[field]) !== expected)
    .map(([field]) => field);
  const storedClaims = Object.fromEntries(
    Object.keys(expectedClaims)
      .filter((field) => hasOwn(stored, field))
      .map((field) => [field, stored[field]]),
  );

  return {
    id: authoritativeId,
    ref: snapshot.ref,
    // Firestore document identity is authoritative. Raw legacy fields are read
    // first so they can never redirect a repair to another participation.
    data: {
      ...stored,
      id: authoritativeId,
      candidateId: authoritativeId,
      candidateRef: authoritativeRef,
    },
    ...(conflictingFields.length > 0
      ? {
          identityConflict: {
            reason: "legacy_candidate_snapshot_identity_conflict" as const,
            evidence: {
              authoritative: { id: authoritativeId, candidateRef: authoritativeRef },
              stored: storedClaims,
              conflictingFields,
            },
          },
        }
      : {}),
  };
}

/**
 * Derive the cleanup fields from the same executable contract that writes global
 * candidate identities. This deliberately avoids a second hand-maintained field
 * list: when globalCandidateIdentityData omits another scoped/evaluation field,
 * the repair engine follows it automatically.
 */
export function candidateScopeFieldsForCleanup(value: unknown): string[] {
  const candidate = record(value);
  const identityData = globalCandidateIdentityData(candidate);
  return Object.keys(candidate)
    .filter((field) => !hasOwn(identityData, field))
    .sort();
}

function exactClaimConflict(
  source: Record<string, unknown>,
  field: string,
  expected: string,
  canonicalProgram = false,
): boolean {
  if (!hasOwn(source, field)) return false;
  const actual = canonicalProgram
    ? resolveCanonicalProgramId(source[field])
    : text(source[field]);
  return !actual || actual !== expected;
}

function supplementaryLegacyScopeConflict(
  candidate: Record<string, unknown>,
  plan: CoreRepairPlan,
  targetRef: DocumentReference,
): string {
  const expected = plan.target.data;
  const canonicalProgramId = text(expected.canonicalProgramId);
  const campaignId = text(expected.campaignId);
  const candidateId = text(expected.candidateId);
  const candidateRef = text(expected.candidateRef);
  const sourceRunId = text(expected.sourceRunId);
  const checks: Array<[string, string, boolean?]> = [
    ["programRef", text(expected.programRef)],
    ["campaignRef", text(expected.campaignRef)],
    ["campaignCandidateRef", targetRef.path],
    ["sourceCampaignId", campaignId],
  ];
  if (checks.some(([field, value, canonical]) => exactClaimConflict(candidate, field, value, canonical))) {
    return "legacy_scope_reference_conflict";
  }

  if (hasOwn(candidate, "candidateProvenance")) {
    if (!isRecord(candidate.candidateProvenance)) {
      return "legacy_candidate_provenance_invalid";
    }
    const provenance = candidate.candidateProvenance;
    const provenanceChecks: Array<[string, string, boolean?]> = [
      ["candidateId", candidateId],
      ["candidateRef", candidateRef],
      ["canonicalProgramId", canonicalProgramId, true],
      ["programId", canonicalProgramId, true],
      ["programRef", text(expected.programRef)],
      ["campaignId", campaignId],
      ["sourceCampaignId", campaignId],
      ["campaignRef", text(expected.campaignRef)],
      ["campaignCandidateRef", targetRef.path],
      ["sourceRunId", sourceRunId],
      ["sourceRunRef", text(expected.sourceRunRef)],
      ["runRef", text(expected.sourceRunRef)],
    ];
    if (provenanceChecks.some(([field, value, canonical]) =>
      exactClaimConflict(provenance, field, value, canonical))) {
      return "legacy_candidate_provenance_conflict";
    }
  }

  if (hasOwn(candidate, "programScopeEvidence")) {
    if (!isRecord(candidate.programScopeEvidence)) {
      return "legacy_program_scope_evidence_invalid";
    }
    const evidence = candidate.programScopeEvidence;
    if (
      exactClaimConflict(evidence, "canonicalProgramId", canonicalProgramId, true)
      || exactClaimConflict(evidence, "programId", canonicalProgramId, true)
      || exactClaimConflict(evidence, "campaignId", campaignId)
    ) {
      return "legacy_program_scope_evidence_conflict";
    }
  }

  return "";
}

function prepareCandidateRows(
  rows: CandidateRow[],
  runsById: Map<string, Record<string, unknown>>,
): PreparedCandidate[] {
  return rows.map((row): PreparedCandidate => {
    let deleteFields: string[];
    try {
      deleteFields = candidateScopeFieldsForCleanup(row.data);
    } catch {
      return {
        row,
        status: "human_gate",
        reason: "legacy_candidate_identity_invalid",
        deleteFields: [],
      };
    }
    if (row.identityConflict) {
      return {
        row,
        status: "human_gate",
        reason: row.identityConflict.reason,
        deleteFields,
      };
    }
    if (deleteFields.length === 0) {
      return {
        row,
        status: "unchanged",
        reason: "global_identity_already_clean",
        deleteFields,
      };
    }

    const declaredConflict = declaredLegacyEvidenceConflict(row.data);
    if (declaredConflict) {
      return { row, status: "human_gate", reason: declaredConflict, deleteFields };
    }
    const plan = planLegacyCandidateScopeRepair({
      legacyCandidate: row.data,
      discoveryRuns: claimedRunIds(row.data).map((runId) => runsById.get(runId)).filter(Boolean),
    });
    if (plan.status !== "repair") {
      return { row, status: "human_gate", reason: plan.reason, deleteFields };
    }
    const targetRef = adminDb.collection(plan.target.collection).doc(plan.target.documentId);
    const conflict = supplementaryLegacyScopeConflict(row.data, plan, targetRef);
    if (conflict) {
      return { row, status: "human_gate", reason: conflict, deleteFields };
    }
    return {
      row,
      status: "repair",
      reason: plan.reason,
      deleteFields,
      plan,
      targetRef,
    };
  });
}

function compatibleClaim(
  current: unknown,
  expected: unknown,
  canonicalProgram = false,
): boolean {
  if (canonicalProgram) {
    return resolveCanonicalProgramId(current) === resolveCanonicalProgramId(expected);
  }
  return text(current) === text(expected);
}

/**
 * Fill only missing participation fields. Existing stage and eligibility are
 * never replaced, and any conflicting exact-scope claim is routed to review.
 */
export function planParticipationPreservingPatch(input: {
  existing: unknown | null;
  targetDocumentId: string;
  targetRef: string;
  plannedData: Record<string, unknown>;
}):
  | { status: "write"; targetExists: boolean; patch: Record<string, unknown> }
  | { status: "human_gate"; reason: string } {
  const targetExists = input.existing !== null;
  const existing = record(input.existing);
  const expected: Record<string, unknown> = {
    ...input.plannedData,
    id: input.targetDocumentId,
    campaignCandidateRef: input.targetRef,
  };
  if (!targetExists) {
    return { status: "write", targetExists: false, patch: expected };
  }

  const patch: Record<string, unknown> = {};
  const exactFields = [
    "id",
    "campaignCandidateRef",
    "candidateId",
    "candidateRef",
    "canonicalProgramId",
    "programId",
    "programRef",
    "campaignId",
    "campaignRef",
    "sourceRunId",
    "sourceRunRef",
  ] as const;
  for (const field of exactFields) {
    if (!hasOwn(existing, field) || existing[field] === null || text(existing[field]) === "") {
      patch[field] = expected[field];
      continue;
    }
    const canonicalProgram = field === "canonicalProgramId" || field === "programId";
    if (!compatibleClaim(existing[field], expected[field], canonicalProgram)) {
      return { status: "human_gate", reason: "existing_participation_scope_conflict" };
    }
  }

  if (!hasOwn(existing, "stage") || existing.stage === null || text(existing.stage) === "") {
    patch.stage = expected.stage;
  } else if (typeof existing.stage !== "string") {
    return { status: "human_gate", reason: "existing_participation_stage_invalid" };
  }

  if (!hasOwn(existing, "eligibility") || existing.eligibility === null) {
    patch.eligibility = expected.eligibility;
  } else if (!isRecord(existing.eligibility)) {
    return { status: "human_gate", reason: "existing_participation_eligibility_invalid" };
  }

  if (!hasOwn(existing, "repairVersion")) {
    patch.repairVersion = expected.repairVersion;
  }
  return { status: "write", targetExists: true, patch };
}

function snapshotsByPath(snapshots: DocumentSnapshot[]): Map<string, DocumentSnapshot> {
  return new Map(snapshots.map((snapshot) => [snapshot.ref.path, snapshot]));
}

function finalizePreparedCandidates(
  prepared: PreparedCandidate[],
  snapshots: Map<string, DocumentSnapshot>,
): RepairResult[] {
  return prepared.map((item): RepairResult => {
    const gateRef = adminDb.collection("candidate_scope_repair_gates").doc(item.row.id);
    const gateExists = snapshots.get(gateRef.path)?.exists === true;
    if (item.status !== "repair") {
      return {
        candidateId: item.row.id,
        status: item.status,
        reason: item.reason,
        deleteFields: item.deleteFields,
        rowRef: item.row.ref,
        gateRef,
        gateExists,
        gateEvidence: item.row.identityConflict?.evidence,
      };
    }
    if (gateExists) {
      return {
        candidateId: item.row.id,
        status: "human_gate",
        reason: "existing_candidate_scope_gate_requires_review",
        targetRef: item.targetRef.path,
        deleteFields: item.deleteFields,
        rowRef: item.row.ref,
        gateRef,
        gateExists,
      };
    }

    const targetSnapshot = snapshots.get(item.targetRef.path);
    const participation = planParticipationPreservingPatch({
      existing: targetSnapshot?.exists ? targetSnapshot.data() ?? {} : null,
      targetDocumentId: item.targetRef.id,
      targetRef: item.targetRef.path,
      plannedData: item.plan.target.data,
    });
    if (participation.status === "human_gate") {
      return {
        candidateId: item.row.id,
        status: "human_gate",
        reason: participation.reason,
        targetRef: item.targetRef.path,
        deleteFields: item.deleteFields,
        rowRef: item.row.ref,
        gateRef,
        gateExists,
      };
    }
    return {
      candidateId: item.row.id,
      status: "repair",
      reason: item.reason,
      targetRef: item.targetRef.path,
      targetExists: participation.targetExists,
      participationPatch: participation.patch,
      deleteFields: item.deleteFields,
      rowRef: item.row.ref,
      gateRef,
      gateExists,
    };
  });
}

async function readDryRunResults(rows: CandidateRow[]): Promise<RepairResult[]> {
  const runIds = Array.from(new Set(rows.flatMap((row) => claimedRunIds(row.data))));
  const runSnapshots = runIds.length > 0
    ? await adminDb.getAll(...runIds.map((runId) => adminDb.collection("discovery_runs").doc(runId)))
    : [];
  const runsById = new Map(runSnapshots.filter((snapshot) => snapshot.exists).map((snapshot) => [
    snapshot.id,
    { ...(snapshot.data() ?? {}), id: snapshot.id },
  ]));
  const prepared = prepareCandidateRows(rows, runsById);
  const refs = Array.from(new Map(prepared.flatMap((item) => {
    const gateRef = adminDb.collection("candidate_scope_repair_gates").doc(item.row.id);
    return item.status === "repair"
      ? [[gateRef.path, gateRef], [item.targetRef.path, item.targetRef]] as const
      : [[gateRef.path, gateRef]] as const;
  })).values());
  const snapshots = refs.length > 0 ? await adminDb.getAll(...refs) : [];
  return finalizePreparedCandidates(prepared, snapshotsByPath(snapshots));
}

async function applyRepairs(
  pageRefs: DocumentReference[],
  uid: string,
): Promise<RepairResult[]> {
  if (pageRefs.length === 0) return [];
  return adminDb.runTransaction(async (transaction) => {
    const candidateSnapshots = await transaction.getAll(...pageRefs);
    const missingResults: RepairResult[] = candidateSnapshots
      .filter((snapshot) => !snapshot.exists)
      .map((snapshot) => ({
        candidateId: snapshot.id,
        status: "skipped",
        reason: "candidate_missing_during_apply",
      }));
    const rows: CandidateRow[] = candidateSnapshots
      .filter((snapshot) => snapshot.exists)
      .map(candidateRowFromSnapshot);
    const runIds = Array.from(new Set(rows.flatMap((row) => claimedRunIds(row.data))));
    const runSnapshots = runIds.length > 0
      ? await transaction.getAll(...runIds.map((runId) => adminDb.collection("discovery_runs").doc(runId)))
      : [];
    const runsById = new Map(runSnapshots.filter((snapshot) => snapshot.exists).map((snapshot) => [
      snapshot.id,
      { ...(snapshot.data() ?? {}), id: snapshot.id },
    ]));
    const prepared = prepareCandidateRows(rows, runsById);
    const refs = Array.from(new Map(prepared.flatMap((item) => {
      const gateRef = adminDb.collection("candidate_scope_repair_gates").doc(item.row.id);
      return item.status === "repair"
        ? [[gateRef.path, gateRef], [item.targetRef.path, item.targetRef]] as const
        : [[gateRef.path, gateRef]] as const;
    })).values());
    const relatedSnapshots = refs.length > 0 ? await transaction.getAll(...refs) : [];
    const results = finalizePreparedCandidates(prepared, snapshotsByPath(relatedSnapshots));
    const nowIso = new Date().toISOString();

    for (const result of results) {
      if (result.status === "repair") {
        if (!result.rowRef || !result.targetRef || !result.participationPatch || !result.deleteFields) {
          throw new Error("internal: incomplete candidate scope repair plan");
        }
        transaction.set(adminDb.doc(result.targetRef), {
          ...result.participationPatch,
          candidateScopeRepairedAtIso: nowIso,
          candidateScopeRepairedBy: uid,
          ...(result.targetExists ? {} : { updatedAtIso: nowIso }),
        }, { merge: true });
        transaction.set(result.rowRef, {
          ...Object.fromEntries(result.deleteFields.map((field) => [field, FieldValue.delete()])),
          candidateScopeRepairVersion: "candidate_scope_repair_v2",
          candidateScopeMigratedAtIso: nowIso,
          candidateScopeMigratedBy: uid,
          updatedAtIso: nowIso,
        }, { merge: true });
        continue;
      }
      if (result.status !== "human_gate" || !result.gateRef || result.gateExists) continue;
      transaction.set(result.gateRef, {
        id: result.candidateId,
        candidateId: result.candidateId,
        candidateRef: `candidate_pool/${result.candidateId}`,
        status: "pending",
        scope: "unscoped",
        guessedScope: false,
        reason: result.reason,
        ...(result.gateEvidence ? { legacyIdentityEvidence: result.gateEvidence } : {}),
        repairVersion: "candidate_scope_repair_v2",
        reviewedAtIso: null,
        createdAtIso: nowIso,
        updatedAtIso: nowIso,
      });
    }
    return [...results, ...missingResults];
  });
}

function publicResult(result: RepairResult) {
  return {
    candidateId: result.candidateId,
    status: result.status,
    reason: result.reason,
    ...(result.targetRef ? { targetRef: result.targetRef } : {}),
    ...(result.status === "repair" ? { targetExists: result.targetExists === true } : {}),
  };
}

// Bounded, idempotent maintenance engine. It never guesses a scope: only an exact
// legacy program/campaign/run snapshot match is projected into campaign_candidates.
// Clean global identities remain untouched; ambiguous/conflicting evidence is kept
// on candidate_pool and routed to a durable human gate.
export async function repairLegacyCandidateScopes(request: RepairRequest) {
  const uid = request.auth?.uid;
  const role = request.auth?.token?.role ?? "guest";
  if (!uid || !new Set(["super_admin", "admin"]).has(role)) {
    throw Object.assign(new Error(!uid ? "unauthenticated" : "permission-denied: admin role required"), {
      code: !uid ? "unauthenticated" : "permission-denied", errorCode: "repair_legacy_candidate_scopes_unauthorized",
    });
  }
  const data = record(request.data);
  const limit = boundedLimit(data.limit);
  const afterCandidateId = cursorId(data.afterCandidateId);
  const dryRun = data.dryRun !== false;
  if (!dryRun && text(data.confirm) !== CANDIDATE_SCOPE_REPAIR_CONFIRMATION) {
    throw Object.assign(new Error("failed-precondition: apply confirmation is required"), {
      code: "failed-precondition", errorCode: "repair_legacy_candidate_scopes_apply_confirmation_required",
    });
  }

  let query = adminDb.collection("candidate_pool").orderBy(FieldPath.documentId()).limit(limit);
  if (afterCandidateId) query = query.startAfter(afterCandidateId);
  const candidatesSnapshot = await query.get();
  const pageRefs = candidatesSnapshot.docs.map((doc) => doc.ref);
  const rows = candidatesSnapshot.docs.map(candidateRowFromSnapshot);
  const results = dryRun
    ? await readDryRunResults(rows)
    : await applyRepairs(pageRefs, uid);
  const repairCount = results.filter((result) => result.status === "repair").length;
  const humanGateCount = results.filter((result) => result.status === "human_gate").length;
  const unchangedCount = results.filter((result) => result.status === "unchanged").length;
  const skippedCount = results.filter((result) => result.status === "skipped").length;

  return {
    ok: true,
    dryRun,
    scannedCount: results.length,
    repairCount,
    repairedCount: dryRun ? 0 : repairCount,
    appliedCount: dryRun ? 0 : repairCount,
    humanGateCount,
    humanGateCreatedCount: dryRun
      ? 0
      : results.filter((result) => result.status === "human_gate" && !result.gateExists).length,
    unchangedCount,
    skippedCount,
    nextCandidateId: candidatesSnapshot.docs.at(-1)?.id ?? null,
    done: candidatesSnapshot.size < limit,
    results: results.map(publicResult),
  };
}
