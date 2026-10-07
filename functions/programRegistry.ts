import { createHash } from "node:crypto";
import { FieldValue, type QueryDocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { rowMatchesAccountScope } from "./readScope";
import { readConfirmedProgramAliasRegistryState } from "./programAliasRegistry";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type AuthContext, type CallableRequestShape } from "./shared";
import {
  aliasesForCanonicalProgramId,
  confirmedProgramAliasMap,
  programAliasTargetDigest,
  programReconciliationOperationReceiptDigest,
  programRegistryIdentityTargetDigest,
  programRegistryTargetDigest,
  PROGRAM_REGISTRY_VERSION,
  SCP_CANONICAL_PROGRAM_ID,
  resolveCanonicalProgramId,
  scpAliasIds,
  type ProgramAliasDoc,
  type ProgramRegistryDoc,
  uniqueSorted,
} from "./programCanonical";

const ACTION_RECONCILE = "program_registry.reconcile";
const RBAC_ROLES = ["super_admin", "admin", "manager"] as const;
const REGISTRY_COLLECTION = "program_registry";
const ALIAS_COLLECTION = "program_aliases";
const AUDIT_COLLECTION = "program_registry_audits";
const IDEMPOTENCY_COLLECTION = "program_registry_idempotency";
const OPERATION_COLLECTION = "program_registry_operations";
const SOURCE_LIMIT = 5_000;

const SCOPE_KEY_BY_COLLECTION: Record<string, string> = {
  program_applications: "programApplications",
  campaign_outreach: "campaigns",
};

const REFERENCE_COLLECTIONS: Record<string, string[]> = {
  program_applications: ["programId", "ownerUid", "ownerEmail", "ownerName", "createdBy", "updatedAtIso", "createdAtIso"],
  program_sheet_leads: ["programId", "program", "programSlug", "bridgedProgramId", "updatedAtIso", "createdAtIso"],
  scp_coldmail_history: ["programId", "updatedAtIso", "createdAtIso"],
  campaign_outreach: ["programId", "campaignProgramId", "campaignId", "ownerUid", "ownerEmail", "ownerName", "updatedAtIso", "createdAtIso"],
  scp_outreach: ["programId", "updatedAtIso", "createdAtIso"],
  campaigns: ["programId", "program", "programSlug", "ownerUid", "ownerEmail", "ownerName", "createdBy", "updatedAtIso", "createdAtIso"],
  conversations: ["programId", "campaignId", "ownerUid", "ownerEmail", "ownerName", "updatedAtIso", "createdAtIso"],
  submission_tasks: ["programId", "updatedAtIso", "createdAtIso"],
  submissions: ["programId", "updatedAtIso", "createdAtIso"],
  review_ledger: ["programId", "updatedAtIso", "createdAtIso"],
  scp_mail_results: ["programId", "updatedAtIso", "createdAtIso"],
};

type SourceRow = Record<string, unknown> & { id: string; ref: string };
type ReconcileGroup = {
  canonicalProgramId: string;
  aliases: string[];
  legacyProgramIds: string[];
  sourceRefs: string[];
  mergedCounts: Record<string, number>;
  proposedRegistry: ProgramRegistryDoc;
  proposedAliases: ProgramAliasDoc[];
};

export type ProgramAliasProposal = {
  proposalId: string;
  alias: string;
  canonicalProgramId: string;
  aliasSourceRef: string;
  canonicalSourceRef: string;
  evidenceType: "immutable_slug_owner" | "title_only_ambiguous";
  reason: "same_slug_same_owner_requires_admin_confirmation" | "title_only_requires_external_evidence";
  mergeEligible: boolean;
  status: "human_gate";
  sourceRevisionHash: string;
};

type AliasConfirmationInput = {
  proposalId: string;
};

type ReconcileBuild = {
  groups: ReconcileGroup[];
  proposals: ProgramAliasProposal[];
  sourceStateHash: string;
  sourceProgramStateHash: string;
  referenceStateHash: string;
  sourceProgramIds: string[];
  sourceAliasIds: string[];
  sourceRegistryIds: string[];
};

type StoredReconcileOperation = {
  action: typeof ACTION_RECONCILE;
  confirmationToken: string;
  scope: "global" | `manager:${string}`;
  actorId: string;
  actorRole: string;
  confirmationProposalIds: string[];
  idempotencyKey: string;
  sourceStateHash: string;
  sourceProgramStateHash: string;
  referenceStateHash: string;
  sourceProgramIds: string[];
  sourceAliasIds: string[];
  sourceRegistryIds: string[];
  proposedRegistryWrites: ProgramRegistryDoc[];
  proposedAliasWrites: ProgramAliasDoc[];
  ambiguousProposals: ProgramAliasProposal[];
  duplicateGroups: ProgramRegistryReconcileEnvelope["duplicateGroups"];
  affectedCollections: Record<string, number>;
  outputStateHash: string;
  semanticOutputStateHash: string;
  aliasTargetDigests: Record<string, string>;
  registryTargetDigests: Record<string, string>;
  targetIdentityDigest: string;
  receiptDigest: string;
  status: "previewed" | "applied";
};

export type ProgramRegistryReconcileEnvelope = {
  ok: true;
  dryRun: boolean;
  actual: boolean;
  written: boolean;
  idempotent?: boolean;
  scope: "global" | `manager:${string}`;
  idempotencyKey: string;
  confirmationToken: string;
  sourceStateHash: string;
  ambiguousProposals: ProgramAliasProposal[];
  duplicateGroups: Array<Pick<ReconcileGroup, "canonicalProgramId" | "aliases" | "legacyProgramIds" | "sourceRefs" | "mergedCounts">>;
  proposedRegistryWrites: ProgramRegistryDoc[];
  proposedAliasWrites: ProgramAliasDoc[];
  affectedCollections: Record<string, number>;
  paths?: { registry: string[]; aliases: string[]; idempotency: string; audit: string };
  audit: { emitted: true; collection: string; result: string };
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
};

export async function reconcileProgramRegistry(request: CallableRequestShape): Promise<ProgramRegistryReconcileEnvelope> {
  const auth = assertNonGuestAuth(request, ACTION_RECONCILE, RBAC_ROLES);
  const data = asRecord(request.data);
  const dryRun = data.dryRun !== false;
  const actual = data.actual === true;
  const writeRequested = !dryRun && actual;
  const scope = deriveScope(auth, data.scope);
  if (!dryRun && !actual) {
    const error = new Error("failed-precondition: actual registry write requires dryRun:false and actual:true");
    Object.assign(error, { code: "failed-precondition", errorCode: "reconcile_program_registry_actual_registry_write_requires_dry", behaviorLog: makeBehaviorLog(auth, ACTION_RECONCILE, "denied", scope) });
    throw error;
  }
  if (writeRequested && auth.role === "manager") {
    const error = new Error("permission-denied: actual registry writes require admin or super_admin");
    Object.assign(error, { code: "permission-denied", errorCode: "reconcile_program_registry_actual_registry_write_requires_dry_2", behaviorLog: makeBehaviorLog(auth, ACTION_RECONCILE, "denied", scope) });
    throw error;
  }

  const nowIso = new Date().toISOString();
  const confirmationInputs = parseAliasConfirmations(data.aliasConfirmations);
  if (confirmationInputs.length > 0 && auth.role === "manager") {
    const error = new Error("permission-denied: alias confirmation requires admin or super_admin");
    Object.assign(error, { code: "permission-denied", errorCode: "reconcile_program_registry_alias_confirmation_requires_admin_super", behaviorLog: makeBehaviorLog(auth, ACTION_RECONCILE, "denied", scope) });
    throw error;
  }
  const providedConfirmationToken = asString(data.confirmationToken);
  if (writeRequested && /^[a-f0-9]{40}$/.test(providedConfirmationToken)) {
    const operationSnapshot = await adminDb.collection(OPERATION_COLLECTION).doc(providedConfirmationToken).get();
    if (operationSnapshot.exists) {
      const operation = validateStoredReconcileOperation(
        operationSnapshot.data(),
        providedConfirmationToken,
        auth,
        scope,
        confirmationInputs,
      );
      return executeStoredReconcileOperation(auth, operation);
    }
  }
  const built = await buildReconcileGroups(auth, nowIso, confirmationInputs);
  const groups = built.groups;
  const proposedRegistryWrites = groups.map((group) => group.proposedRegistry);
  let proposedAliasWrites = groups.flatMap((group) => group.proposedAliases);
  const affectedCollections = mergeAffectedCollections(groups);
  const idempotencyKey = registryIdempotencyKey(registryIdempotencyPayload(proposedRegistryWrites, proposedAliasWrites));
  const confirmationToken = registryIdempotencyKey({
    action: ACTION_RECONCILE,
    scope,
    sourceStateHash: built.sourceStateHash,
    confirmationProposalIds: confirmationInputs.map((item) => item.proposalId).sort(),
    idempotencyKey,
  });
  const aliasTargetDigests = Object.fromEntries(proposedAliasWrites.map((doc) => [doc.alias, programAliasTargetDigest(doc)]));
  const registryTargetDigests = Object.fromEntries(proposedRegistryWrites.map((doc) => [doc.canonicalProgramId, programRegistryTargetDigest(doc)]));
  const targetIdentityDigest = programRegistryIdentityTargetDigest(
    proposedRegistryWrites.map((doc) => ({ id: doc.canonicalProgramId, ...doc })),
    proposedAliasWrites.map((doc) => ({ id: doc.alias, ...doc })),
  );
  const receiptDigest = programReconciliationOperationReceiptDigest({
    action: ACTION_RECONCILE,
    confirmationToken,
    scope,
    actorId: safeActorId(auth.userId),
    actorRole: auth.role,
    confirmationProposalIds: confirmationInputs.map((item) => item.proposalId).sort(),
    idempotencyKey,
    sourceStateHash: built.sourceStateHash,
    sourceProgramStateHash: built.sourceProgramStateHash,
    referenceStateHash: built.referenceStateHash,
    sourceProgramIds: built.sourceProgramIds,
    sourceAliasIds: built.sourceAliasIds,
    sourceRegistryIds: built.sourceRegistryIds,
    aliasTargetDigests,
    registryTargetDigests,
    targetIdentityDigest,
  });
  proposedAliasWrites = proposedAliasWrites.map((doc) => doc.reason === "explicit_admin_confirmation" && !doc.reconciliationOperationRef
    ? {
        ...doc,
        reconciliationOperationRef: `${OPERATION_COLLECTION}/${confirmationToken}`,
        reconciliationConfirmationToken: confirmationToken,
        aliasTargetDigest: aliasTargetDigests[doc.alias],
        canonicalTargetDigest: registryTargetDigests[doc.canonicalProgramId],
        operationReceiptDigest: receiptDigest,
      }
    : doc);
  if (writeRequested && providedConfirmationToken !== confirmationToken) {
    const error = new Error("failed-precondition: actual registry write requires the exact dry-run confirmationToken");
    Object.assign(error, { code: "failed-precondition", errorCode: "reconcile_program_registry_actual_registry_write_requires_exact", behaviorLog: makeBehaviorLog(auth, ACTION_RECONCILE, "denied", scope) });
    throw error;
  }
  const duplicateGroups = groups.map(({ canonicalProgramId, aliases, legacyProgramIds, sourceRefs, mergedCounts }) => ({ canonicalProgramId, aliases, legacyProgramIds, sourceRefs, mergedCounts }));
  const operation: StoredReconcileOperation = {
    action: ACTION_RECONCILE,
    confirmationToken,
    scope,
    actorId: safeActorId(auth.userId),
    actorRole: auth.role,
    confirmationProposalIds: confirmationInputs.map((item) => item.proposalId).sort(),
    idempotencyKey,
    sourceStateHash: built.sourceStateHash,
    sourceProgramStateHash: built.sourceProgramStateHash,
    referenceStateHash: built.referenceStateHash,
    sourceProgramIds: built.sourceProgramIds,
    sourceAliasIds: built.sourceAliasIds,
    sourceRegistryIds: built.sourceRegistryIds,
    proposedRegistryWrites,
    proposedAliasWrites,
    ambiguousProposals: built.proposals,
    duplicateGroups,
    affectedCollections,
    outputStateHash: programRegistryOutputStateHash(proposedRegistryWrites, proposedAliasWrites),
    semanticOutputStateHash: programRegistrySemanticOutputStateHash(proposedRegistryWrites, proposedAliasWrites),
    aliasTargetDigests,
    registryTargetDigests,
    targetIdentityDigest,
    receiptDigest,
    status: "previewed",
  };
  if (Buffer.byteLength(stableStringify(operation), "utf8") > 900_000) {
    const error = new Error("failed-precondition: program registry operation receipt exceeds the bounded write contract");
    Object.assign(error, { code: "failed-precondition", errorCode: "reconcile_program_registry_program_registry_operation_receipt_exceeds" });
    throw error;
  }
  const auditBase = {
    action: ACTION_RECONCILE,
    scope,
    uid: safeActorId(auth.userId),
    role: auth.role,
    dryRun,
    actual,
    idempotencyKey,
    confirmationToken,
    sourceStateHash: built.sourceStateHash,
    aliasConfirmationProposalIds: confirmationInputs.map((item) => item.proposalId).sort(),
    canonicalProgramIds: proposedRegistryWrites.map((doc) => doc.canonicalProgramId),
    registryDocIds: proposedRegistryWrites.map((doc) => doc.canonicalProgramId),
    aliasDocIds: proposedAliasWrites.map((doc) => doc.alias),
    affectedCollections,
    registryVersion: PROGRAM_REGISTRY_VERSION,
    createdAtIso: nowIso,
    createdAt: FieldValue.serverTimestamp(),
  };

  if (!writeRequested) {
    const operationRef = adminDb.collection(OPERATION_COLLECTION).doc(confirmationToken);
    const auditRef = adminDb.collection(AUDIT_COLLECTION).doc();
    await adminDb.runTransaction(async (tx) => {
      const existing = await tx.get(operationRef);
      if (existing.exists) {
        validateStoredReconcileOperation(existing.data(), confirmationToken, auth, scope, confirmationInputs, operation);
      } else {
        tx.create(operationRef, {
          ...operation,
          createdAtIso: nowIso,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      tx.set(auditRef, { ...auditBase, result: "dry_run", operationPath: operationRef.path });
    });
    return {
      ok: true,
      dryRun: true,
      actual: false,
      written: false,
      scope,
      idempotencyKey,
      confirmationToken,
      sourceStateHash: built.sourceStateHash,
      ambiguousProposals: built.proposals,
      duplicateGroups,
      proposedRegistryWrites,
      proposedAliasWrites,
      affectedCollections,
      audit: { emitted: true, collection: AUDIT_COLLECTION, result: "dry_run" },
      behaviorLog: makeBehaviorLog(auth, ACTION_RECONCILE, "success", scope),
    };
  }

  const operationRef = adminDb.collection(OPERATION_COLLECTION).doc(confirmationToken);
  await adminDb.runTransaction(async (tx) => {
    const existing = await tx.get(operationRef);
    if (existing.exists) {
      validateStoredReconcileOperation(existing.data(), confirmationToken, auth, scope, confirmationInputs, operation);
      return;
    }
    tx.create(operationRef, {
      ...operation,
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  return executeStoredReconcileOperation(auth, operation);
}

function validateStoredReconcileOperation(
  value: unknown,
  confirmationToken: string,
  auth: AuthContext,
  scope: "global" | `manager:${string}`,
  confirmationInputs: AliasConfirmationInput[],
  expected?: StoredReconcileOperation,
): StoredReconcileOperation {
  const row = asRecord(value);
  const confirmationProposalIds = uniqueSorted(Array.isArray(row.confirmationProposalIds) ? row.confirmationProposalIds : []);
  const sourceProgramIds = uniqueSorted(Array.isArray(row.sourceProgramIds) ? row.sourceProgramIds : []);
  const sourceAliasIds = uniqueSorted(Array.isArray(row.sourceAliasIds) ? row.sourceAliasIds : []);
  const sourceRegistryIds = uniqueSorted(Array.isArray(row.sourceRegistryIds) ? row.sourceRegistryIds : []);
  const proposedRegistryWrites = Array.isArray(row.proposedRegistryWrites)
    ? row.proposedRegistryWrites.map((item) => asRecord(item) as unknown as ProgramRegistryDoc)
    : [];
  const proposedAliasWrites = Array.isArray(row.proposedAliasWrites)
    ? row.proposedAliasWrites.map((item) => asRecord(item) as unknown as ProgramAliasDoc)
    : [];
  const requestedProposalIds = confirmationInputs.map((item) => item.proposalId).sort();
  const immutable = {
    action: asString(row.action),
    confirmationToken: asString(row.confirmationToken),
    scope: asString(row.scope),
    actorId: asString(row.actorId),
    actorRole: asString(row.actorRole),
    confirmationProposalIds,
    idempotencyKey: asString(row.idempotencyKey),
    sourceStateHash: asString(row.sourceStateHash),
    sourceProgramStateHash: asString(row.sourceProgramStateHash),
    referenceStateHash: asString(row.referenceStateHash),
    sourceProgramIds,
    sourceAliasIds,
    sourceRegistryIds,
    proposedRegistryWrites,
    proposedAliasWrites,
    ambiguousProposals: Array.isArray(row.ambiguousProposals) ? row.ambiguousProposals : [],
    duplicateGroups: Array.isArray(row.duplicateGroups) ? row.duplicateGroups : [],
    affectedCollections: numberMap(row.affectedCollections),
    outputStateHash: asString(row.outputStateHash),
    semanticOutputStateHash: asString(row.semanticOutputStateHash),
    aliasTargetDigests: stringMap(row.aliasTargetDigests),
    registryTargetDigests: stringMap(row.registryTargetDigests),
    targetIdentityDigest: asString(row.targetIdentityDigest),
    receiptDigest: asString(row.receiptDigest),
  };
  const recomputedIdempotencyKey = registryIdempotencyKey(registryIdempotencyPayload(proposedRegistryWrites, proposedAliasWrites));
  const recomputedOutputStateHash = programRegistryOutputStateHash(proposedRegistryWrites, proposedAliasWrites);
  const recomputedSemanticOutputStateHash = programRegistrySemanticOutputStateHash(proposedRegistryWrites, proposedAliasWrites);
  const recomputedToken = registryIdempotencyKey({
    action: ACTION_RECONCILE,
    scope,
    sourceStateHash: immutable.sourceStateHash,
    confirmationProposalIds,
    idempotencyKey: immutable.idempotencyKey,
  });
  const recomputedTargetIdentityDigest = programRegistryIdentityTargetDigest(
    proposedRegistryWrites.map((doc) => ({ id: doc.canonicalProgramId, ...doc })),
    proposedAliasWrites.map((doc) => ({ id: doc.alias, ...doc })),
  );
  const recomputedAliasTargetDigests = Object.fromEntries(proposedAliasWrites.map((doc) => [doc.alias, programAliasTargetDigest(doc)]));
  const recomputedRegistryTargetDigests = Object.fromEntries(proposedRegistryWrites.map((doc) => [doc.canonicalProgramId, programRegistryTargetDigest(doc)]));
  const recomputedReceiptDigest = programReconciliationOperationReceiptDigest(immutable);
  const valid = immutable.action === ACTION_RECONCILE
    && immutable.confirmationToken === confirmationToken
    && immutable.scope === scope
    && immutable.actorId === safeActorId(auth.userId)
    && immutable.actorRole === auth.role
    && stableStringify(confirmationProposalIds) === stableStringify(requestedProposalIds)
    && /^[a-f0-9]{64}$/.test(immutable.sourceStateHash)
    && /^[a-f0-9]{64}$/.test(immutable.sourceProgramStateHash)
    && /^[a-f0-9]{64}$/.test(immutable.referenceStateHash)
    && immutable.idempotencyKey === recomputedIdempotencyKey
    && immutable.outputStateHash === recomputedOutputStateHash
    && immutable.semanticOutputStateHash === recomputedSemanticOutputStateHash
    && immutable.targetIdentityDigest === recomputedTargetIdentityDigest
    && stableStringify(immutable.aliasTargetDigests) === stableStringify(recomputedAliasTargetDigests)
    && stableStringify(immutable.registryTargetDigests) === stableStringify(recomputedRegistryTargetDigests)
    && immutable.receiptDigest === recomputedReceiptDigest
    && stableStringify(sourceAliasIds) === stableStringify(uniqueSorted(proposedAliasWrites.map((doc) => doc.alias)))
    && stableStringify(sourceRegistryIds) === stableStringify(uniqueSorted(proposedRegistryWrites.map((doc) => doc.canonicalProgramId)))
    && confirmationToken === recomputedToken
    && (row.status === "previewed" || row.status === "applied");
  if (!valid || (expected && operationImmutableHash(expected) !== sha256Hex(immutable))) {
    const error = new Error("failed-precondition: program registry operation receipt does not match the requested dry-run");
    Object.assign(error, { code: "failed-precondition", errorCode: "validate_stored_reconcile_operation_program_registry_operation" });
    throw error;
  }
  return {
    ...immutable,
    action: ACTION_RECONCILE,
    scope,
    actorRole: asString(row.actorRole),
    ambiguousProposals: immutable.ambiguousProposals as ProgramAliasProposal[],
    duplicateGroups: immutable.duplicateGroups as ProgramRegistryReconcileEnvelope["duplicateGroups"],
    aliasTargetDigests: immutable.aliasTargetDigests,
    registryTargetDigests: immutable.registryTargetDigests,
    targetIdentityDigest: immutable.targetIdentityDigest,
    receiptDigest: immutable.receiptDigest,
    status: row.status as "previewed" | "applied",
  };
}

function operationImmutableHash(operation: StoredReconcileOperation): string {
  const { status: _status, ...immutable } = operation;
  return sha256Hex(immutable);
}

async function executeStoredReconcileOperation(
  auth: AuthContext,
  requestedOperation: StoredReconcileOperation,
): Promise<ProgramRegistryReconcileEnvelope> {
  const operationRef = adminDb.collection(OPERATION_COLLECTION).doc(requestedOperation.confirmationToken);
  const idemRef = adminDb.collection(IDEMPOTENCY_COLLECTION).doc(requestedOperation.idempotencyKey);
  const auditRef = adminDb.collection(AUDIT_COLLECTION).doc();
  const registryRefs = requestedOperation.proposedRegistryWrites.map((doc) => adminDb.collection(REGISTRY_COLLECTION).doc(doc.canonicalProgramId));
  const aliasRefs = requestedOperation.proposedAliasWrites.map((doc) => adminDb.collection(ALIAS_COLLECTION).doc(doc.alias));
  let noOp = false;
  await adminDb.runTransaction(async (tx) => {
    const liveOperationSnapshot = await tx.get(operationRef);
    if (!liveOperationSnapshot.exists) {
      throw Object.assign(new Error("failed-precondition: program registry operation receipt disappeared"), { code: "failed-precondition", errorCode: "execute_stored_reconcile_operation_program_registry_operation_receipt" });
    }
    const operation = validateStoredReconcileOperation(
      liveOperationSnapshot.data(),
      requestedOperation.confirmationToken,
      auth,
      requestedOperation.scope,
      requestedOperation.confirmationProposalIds.map((proposalId) => ({ proposalId })),
      requestedOperation,
    );
    const sourceProgramRefs = operation.sourceProgramIds.map((id) => adminDb.collection("programs").doc(id));
    const sourceAliasRefs = operation.sourceAliasIds.map((id) => adminDb.collection(ALIAS_COLLECTION).doc(id));
    const sourceRegistryRefs = operation.sourceRegistryIds.map((id) => adminDb.collection(REGISTRY_COLLECTION).doc(id));
    const [programSnapshots, aliasSnapshots, registrySnapshots, idempotencySnapshot] = await Promise.all([
      Promise.all(sourceProgramRefs.map((ref) => tx.get(ref))),
      Promise.all(sourceAliasRefs.map((ref) => tx.get(ref))),
      Promise.all(sourceRegistryRefs.map((ref) => tx.get(ref))),
      tx.get(idemRef),
    ]);
    const programRows = programSnapshots.map((snapshot) => ({ id: snapshot.id, ref: snapshot.ref.path, exists: snapshot.exists, ...(snapshot.data() ?? {}) }));
    const aliasRows = aliasSnapshots.map((snapshot) => ({ id: snapshot.id, ref: snapshot.ref.path, exists: snapshot.exists, ...(snapshot.data() ?? {}) }));
    const registryRows = registrySnapshots.map((snapshot) => ({ id: snapshot.id, ref: snapshot.ref.path, exists: snapshot.exists, ...(snapshot.data() ?? {}) }));
    const liveRegistryById = new Map(registryRows.map((row) => [row.id, row]));
    const liveAliasById = new Map(aliasRows.map((row) => [row.id, row]));
    const liveRegistryWrites = operation.proposedRegistryWrites.map((expected) => liveRegistryById.get(expected.canonicalProgramId) ?? {}) as ProgramRegistryDoc[];
    const liveAliasWrites = operation.proposedAliasWrites.map((expected) => liveAliasById.get(expected.alias) ?? {}) as ProgramAliasDoc[];
    const idempotency = idempotencySnapshot.data() ?? {};

    if (operation.status === "applied") {
      if (
        !idempotencySnapshot.exists
        || !validOperationIdempotencyReceipt(idempotency, operation)
        || programRegistryIdentityTargetDigest(liveRegistryWrites, liveAliasWrites) !== operation.targetIdentityDigest
      ) {
        throw Object.assign(new Error("failed-precondition: applied program registry identity targets no longer match their immutable receipt"), { code: "failed-precondition", errorCode: "execute_stored_reconcile_operation_applied_program_registry_identity" });
      }
      noOp = true;
      tx.set(auditRef, operationAudit(operation, auth, "idempotent_noop"));
      return;
    }

    const aliasMap = confirmedProgramAliasMap([
      ...aliasRows,
      ...operation.proposedAliasWrites.map((doc) => ({ id: doc.alias, ref: `${ALIAS_COLLECTION}/${doc.alias}`, ...doc })),
    ]);
    const referenceRead = await readReferenceCounts(auth, aliasMap, tx);
    if (referenceRead.stateHash !== operation.referenceStateHash) {
      throw Object.assign(new Error("aborted: program registry reference state changed after dry-run"), { code: "aborted", errorCode: "execute_stored_reconcile_operation_program_registry_reference_state" });
    }
    const liveProgramStateHash = programRegistrySourceStateHash(programRows, [], []);
    if (liveProgramStateHash !== operation.sourceProgramStateHash) {
      throw Object.assign(new Error("aborted: program registry program source state changed after dry-run"), { code: "aborted", errorCode: "execute_stored_reconcile_operation_program_registry_program_source" });
    }

    if (idempotencySnapshot.exists) {
      if (
        asString(idempotency.semanticOutputStateHash) !== operation.semanticOutputStateHash
        || programRegistrySemanticOutputStateHash(liveRegistryWrites, liveAliasWrites) !== operation.semanticOutputStateHash
      ) {
        throw Object.assign(new Error("failed-precondition: existing program registry outputs do not match the requested semantic result"), { code: "failed-precondition", errorCode: "execute_stored_reconcile_operation_existing_program_registry_outputs" });
      }
      noOp = true;
      tx.set(auditRef, operationAudit(operation, auth, "idempotent_noop"));
      return;
    }

    const liveSourceStateHash = programRegistrySourceStateHash(programRows, aliasRows, registryRows);
    if (liveSourceStateHash !== operation.sourceStateHash) {
      throw Object.assign(new Error("aborted: program registry source or idempotency state changed after dry-run"), { code: "aborted", errorCode: "execute_stored_reconcile_operation_program_registry_source" });
    }
    operation.proposedRegistryWrites.forEach((doc, index) => tx.set(registryRefs[index], doc, { merge: true }));
    operation.proposedAliasWrites.forEach((doc, index) => tx.set(aliasRefs[index], doc, { merge: true }));
    tx.set(idemRef, operationIdempotencyReceipt(operation, auth));
    tx.update(operationRef, { status: "applied", appliedAtIso: new Date().toISOString(), appliedAt: FieldValue.serverTimestamp() });
    tx.set(auditRef, operationAudit(operation, auth, "written"));
  });

  return operationEnvelope(auth, requestedOperation, noOp, registryRefs, aliasRefs, idemRef, auditRef);
}

function operationIdempotencyReceipt(operation: StoredReconcileOperation, auth: AuthContext) {
  const receipt = {
    idempotencyKey: operation.idempotencyKey,
    confirmationToken: operation.confirmationToken,
    sourceStateHash: operation.sourceStateHash,
    sourceProgramStateHash: operation.sourceProgramStateHash,
    referenceStateHash: operation.referenceStateHash,
    outputStateHash: operation.outputStateHash,
    semanticOutputStateHash: operation.semanticOutputStateHash,
    targetIdentityDigest: operation.targetIdentityDigest,
    operationReceiptDigest: operation.receiptDigest,
    scope: operation.scope,
    registryPaths: operation.proposedRegistryWrites.map((doc) => `${REGISTRY_COLLECTION}/${doc.canonicalProgramId}`),
    aliasPaths: operation.proposedAliasWrites.map((doc) => `${ALIAS_COLLECTION}/${doc.alias}`),
    registryVersion: PROGRAM_REGISTRY_VERSION,
    createdBy: safeActorId(auth.userId),
    createdByRole: auth.role,
  };
  return {
    ...receipt,
    receiptDigest: sha256Hex(receipt),
    createdAtIso: new Date().toISOString(),
    createdAt: FieldValue.serverTimestamp(),
  };
}

function validOperationIdempotencyReceipt(value: unknown, operation: StoredReconcileOperation): boolean {
  const row = asRecord(value);
  const immutable = {
    idempotencyKey: row.idempotencyKey,
    confirmationToken: row.confirmationToken,
    sourceStateHash: row.sourceStateHash,
    sourceProgramStateHash: row.sourceProgramStateHash,
    referenceStateHash: row.referenceStateHash,
    outputStateHash: row.outputStateHash,
    semanticOutputStateHash: row.semanticOutputStateHash,
    targetIdentityDigest: row.targetIdentityDigest,
    operationReceiptDigest: row.operationReceiptDigest,
    scope: row.scope,
    registryPaths: row.registryPaths,
    aliasPaths: row.aliasPaths,
    registryVersion: row.registryVersion,
    createdBy: row.createdBy,
    createdByRole: row.createdByRole,
  };
  return row.receiptDigest === sha256Hex(immutable)
    && row.idempotencyKey === operation.idempotencyKey
    && row.confirmationToken === operation.confirmationToken
    && row.targetIdentityDigest === operation.targetIdentityDigest
    && row.operationReceiptDigest === operation.receiptDigest
    && row.createdBy === operation.actorId
    && row.createdByRole === operation.actorRole;
}

function operationAudit(operation: StoredReconcileOperation, auth: AuthContext, result: "written" | "idempotent_noop") {
  return {
    action: ACTION_RECONCILE,
    scope: operation.scope,
    uid: safeActorId(auth.userId),
    role: auth.role,
    dryRun: false,
    actual: true,
    idempotencyKey: operation.idempotencyKey,
    confirmationToken: operation.confirmationToken,
    sourceStateHash: operation.sourceStateHash,
    outputStateHash: operation.outputStateHash,
    semanticOutputStateHash: operation.semanticOutputStateHash,
    aliasConfirmationProposalIds: operation.confirmationProposalIds,
    affectedCollections: operation.affectedCollections,
    result,
    createdAtIso: new Date().toISOString(),
    createdAt: FieldValue.serverTimestamp(),
  };
}

function operationEnvelope(
  auth: AuthContext,
  operation: StoredReconcileOperation,
  noOp: boolean,
  registryRefs: FirebaseFirestore.DocumentReference[],
  aliasRefs: FirebaseFirestore.DocumentReference[],
  idemRef: FirebaseFirestore.DocumentReference,
  auditRef: FirebaseFirestore.DocumentReference,
): ProgramRegistryReconcileEnvelope {
  return {
    ok: true,
    dryRun: false,
    actual: true,
    written: !noOp,
    idempotent: noOp,
    scope: operation.scope,
    idempotencyKey: operation.idempotencyKey,
    confirmationToken: operation.confirmationToken,
    sourceStateHash: operation.sourceStateHash,
    ambiguousProposals: operation.ambiguousProposals,
    duplicateGroups: operation.duplicateGroups,
    proposedRegistryWrites: operation.proposedRegistryWrites,
    proposedAliasWrites: operation.proposedAliasWrites,
    affectedCollections: operation.affectedCollections,
    paths: { registry: registryRefs.map((ref) => ref.path), aliases: aliasRefs.map((ref) => ref.path), idempotency: idemRef.path, audit: auditRef.path },
    audit: { emitted: true, collection: AUDIT_COLLECTION, result: noOp ? "idempotent_noop" : "written" },
    behaviorLog: makeBehaviorLog(auth, ACTION_RECONCILE, "success", operation.scope),
  };
}

function deriveScope(auth: AuthContext, requestedScope: unknown): "global" | `manager:${string}` {
  if (auth.role === "manager") {
    const scope = `manager:${safeDocId(auth.userId)}` as const;
    if (requestedScope === undefined || requestedScope === "" || requestedScope === scope) return scope;
    const error = new Error("permission-denied: managers may only reconcile their own manager scope");
    Object.assign(error, { code: "permission-denied", errorCode: "derive_scope_managers_may_only_reconcile_their" });
    throw error;
  }
  const scope = asString(requestedScope, "global");
  if (scope !== "global") {
    const error = new Error("permission-denied: admin registry reconcile scope must be global");
    Object.assign(error, { code: "permission-denied", errorCode: "derive_scope_admin_registry_reconcile_scope_must" });
    throw error;
  }
  return "global";
}

async function buildReconcileGroups(
  auth: AuthContext,
  nowIso: string,
  confirmationInputs: AliasConfirmationInput[],
): Promise<ReconcileBuild> {
  const [programs, existingAliasRows, existingRegistryRows, confirmedRegistry] = await Promise.all([
    readProgramRows(auth),
    readAliasRows(),
    readRegistryRows(),
    readConfirmedProgramAliasRegistryState({ bypassCache: true }),
  ]);
  const existingAliasMap = confirmedRegistry.aliasMap;
  const proposals = buildProgramAliasProposals(programs, existingAliasMap);
  const proposalById = new Map(proposals.map((proposal) => [proposal.proposalId, proposal]));
  const confirmedProposals = confirmationInputs.map((input) => {
    const proposal = proposalById.get(input.proposalId);
    if (!proposal || !proposal.mergeEligible) {
      const error = new Error("failed-precondition: alias confirmation must reference an eligible current dry-run proposal");
      Object.assign(error, { code: "failed-precondition", errorCode: "build_reconcile_groups_alias_confirmation_must_reference_eligible" });
      throw error;
    }
    return proposal;
  });
  const generatedAliasDocs = confirmedProposals.map((proposal): ProgramAliasDoc => ({
    alias: proposal.alias,
    canonicalProgramId: proposal.canonicalProgramId,
    reason: "explicit_admin_confirmation",
    confirmationStatus: "confirmed",
    evidenceType: "immutable_slug_owner",
    sourceRefs: uniqueSorted([proposal.aliasSourceRef, proposal.canonicalSourceRef]),
    sourceRevisionHash: proposal.sourceRevisionHash,
    confirmedAtIso: nowIso,
    confirmedBy: safeActorId(auth.userId),
    confirmedByRole: auth.role === "super_admin" ? "super_admin" : "admin",
    createdAtIso: nowIso,
    createdBy: safeActorId(auth.userId),
    registryVersion: PROGRAM_REGISTRY_VERSION,
  }));
  const aliasMap = { ...existingAliasMap };
  for (const proposal of confirmedProposals) {
    const canonicalTarget = resolveCanonicalProgramId(proposal.canonicalProgramId, existingAliasMap);
    if (!canonicalTarget || canonicalTarget !== proposal.canonicalProgramId || existingAliasMap[canonicalTarget]) {
      throw Object.assign(new Error("failed-precondition: generic alias confirmation cannot create an alias chain"), { code: "failed-precondition", errorCode: "build_reconcile_groups_generic_alias_confirmation_cannot_create" });
    }
    aliasMap[proposal.alias] = canonicalTarget;
  }
  const referenceRead = await readReferenceCounts(auth, aliasMap);
  const refCounts = referenceRead.counts;
  const programsByCanonical = new Map<string, SourceRow[]>();
  for (const program of programs) {
    const rawId = asString(program.id);
    const mappedRawId = resolveCanonicalProgramId(rawId, aliasMap);
    const declaredCanonical = resolveCanonicalProgramId(program.canonicalProgramId, aliasMap);
    const canonicalProgramId = declaredCanonical && declaredCanonical !== mappedRawId ? rawId : (declaredCanonical || mappedRawId);
    if (!canonicalProgramId) continue;
    programsByCanonical.set(canonicalProgramId, [...(programsByCanonical.get(canonicalProgramId) ?? []), program]);
  }
  if (!programsByCanonical.has(SCP_CANONICAL_PROGRAM_ID)) programsByCanonical.set(SCP_CANONICAL_PROGRAM_ID, []);

  const existingAliasById = new Map(existingAliasRows.map((row) => [row.id, row]));
  const generatedAliasById = new Map(generatedAliasDocs.map((doc) => [doc.alias, doc]));
  const groups: ReconcileGroup[] = [];
  for (const [canonicalProgramId, programRows] of programsByCanonical) {
    const confirmedAliases = aliasesForCanonicalProgramId(canonicalProgramId, aliasMap);
    const aliases = uniqueSorted([
      canonicalProgramId,
      ...programRows.map((row) => row.id),
      ...confirmedAliases,
      ...(canonicalProgramId === SCP_CANONICAL_PROGRAM_ID ? scpAliasIds() : []),
    ]);
    if (canonicalProgramId !== SCP_CANONICAL_PROGRAM_ID && aliases.length < 2) continue;
    const legacyProgramIds = aliases.filter((id) => id !== canonicalProgramId);
    const canonicalRow = preferredCanonicalProgramRow(programRows, canonicalProgramId);
    const sourceRefs = uniqueSorted(programRows.map((row) => row.ref));
    const mergedCounts = mergedCountsForCanonical(refCounts, canonicalProgramId, programRows.length);
    const titleFallbackValue = canonicalProgramId === SCP_CANONICAL_PROGRAM_ID ? "Super Creator Partners" : canonicalProgramId;
    const slugFallbackValue = canonicalProgramId === SCP_CANONICAL_PROGRAM_ID ? "super-creator-partners" : canonicalProgramId;
    const registry: ProgramRegistryDoc = {
      canonicalProgramId,
      visible: canonicalRow?.visible !== false && !canonicalRow?.deletedAt && !canonicalRow?.archivedAt,
      title: safeText(canonicalRow?.title, titleFallbackValue, 120),
      slug: safeSlug(canonicalRow?.slug, slugFallbackValue),
      aliases,
      legacyProgramIds,
      sourceRefs,
      mergedCounts,
      lastReconciledAtIso: nowIso,
      registryVersion: PROGRAM_REGISTRY_VERSION,
    };
    const proposedAliases = legacyProgramIds.flatMap((alias): ProgramAliasDoc[] => {
      const generated = generatedAliasById.get(alias);
      if (generated) return [generated];
      const existing = existingAliasById.get(alias);
      if (existing && resolveCanonicalProgramId(alias, existingAliasMap) === canonicalProgramId) {
        return [programAliasDocFromExisting(existing)];
      }
      if (canonicalProgramId !== SCP_CANONICAL_PROGRAM_ID) return [];
      return [{
        alias,
        canonicalProgramId,
        reason: "scp_alias_contract",
        confirmationStatus: "confirmed",
        evidenceType: "scp_contract",
        sourceRefs: uniqueSorted([`programs/${alias}`, `programs/${canonicalProgramId}`]),
        sourceRevisionHash: sha256Hex({ contract: "scp_alias_contract", alias, canonicalProgramId }),
        confirmedAtIso: nowIso,
        confirmedBy: "system_scp_alias_contract",
        ...(auth.role === "super_admin" || auth.role === "admin"
          ? { confirmedByRole: auth.role }
          : {}),
        createdAtIso: nowIso,
        createdBy: safeActorId(auth.userId),
        registryVersion: PROGRAM_REGISTRY_VERSION,
      }];
    });
    groups.push({
      canonicalProgramId,
      aliases,
      legacyProgramIds,
      sourceRefs,
      mergedCounts,
      proposedRegistry: registry,
      proposedAliases,
    });
  }

  const sourceProgramIds = uniqueSorted(groups.flatMap((group) => group.sourceRefs.map((ref) => ref.replace(/^programs\//, ""))));
  const sourceAliasIds = uniqueSorted(groups.flatMap((group) => group.proposedAliases.map((doc) => doc.alias)));
  const sourceRegistryIds = uniqueSorted(groups.map((group) => group.canonicalProgramId));
  const programStateRows = stateRowsForIds("programs", sourceProgramIds, programs);
  const aliasStateRows = stateRowsForIds(ALIAS_COLLECTION, sourceAliasIds, existingAliasRows);
  const registryStateRows = stateRowsForIds(REGISTRY_COLLECTION, sourceRegistryIds, existingRegistryRows);
  return {
    groups: groups.sort((left, right) => left.canonicalProgramId.localeCompare(right.canonicalProgramId)),
    proposals,
    sourceStateHash: programRegistrySourceStateHash(programStateRows, aliasStateRows, registryStateRows),
    sourceProgramStateHash: programRegistrySourceStateHash(programStateRows, [], []),
    referenceStateHash: referenceRead.stateHash,
    sourceProgramIds,
    sourceAliasIds,
    sourceRegistryIds,
  };
}

async function readProgramRows(auth: AuthContext): Promise<SourceRow[]> {
  const snap = await adminDb.collection("programs")
    .select("canonicalProgramId", "title", "slug", "status", "visible", "aliases", "legacyProgramIds", "deletedAt", "archivedAt", "ownerUid", "ownerEmail", "ownerName", "createdBy", "updatedAtIso", "createdAtIso")
    .limit(SOURCE_LIMIT + 1)
    .get();
  assertBoundedSourceRead(snap, "programs");
  return snap.docs.map(rowFromDoc).filter((row) => rowMatchesAccountScope("programs", row, auth));
}

async function readAliasRows(): Promise<SourceRow[]> {
  const snap = await adminDb.collection(ALIAS_COLLECTION)
    .select("alias", "canonicalProgramId", "reason", "confirmationStatus", "evidenceType", "sourceRefs", "sourceRevisionHash", "confirmedAtIso", "confirmedBy", "confirmedByRole", "createdAtIso", "createdBy", "registryVersion", "reconciliationOperationRef", "reconciliationConfirmationToken", "aliasTargetDigest", "canonicalTargetDigest", "operationReceiptDigest")
    .limit(SOURCE_LIMIT + 1)
    .get();
  assertBoundedSourceRead(snap, ALIAS_COLLECTION);
  return snap.docs.map(rowFromDoc);
}

async function readRegistryRows(): Promise<SourceRow[]> {
  const snap = await adminDb.collection(REGISTRY_COLLECTION)
    .select("canonicalProgramId", "visible", "title", "slug", "aliases", "legacyProgramIds", "sourceRefs", "mergedCounts", "lastReconciledAtIso", "registryVersion")
    .limit(SOURCE_LIMIT + 1)
    .get();
  assertBoundedSourceRead(snap, REGISTRY_COLLECTION);
  return snap.docs.map(rowFromDoc);
}

function assertBoundedSourceRead(snapshot: { size: number }, collection: string): void {
  if (snapshot.size <= SOURCE_LIMIT) return;
  throw Object.assign(new Error(`failed-precondition: ${collection} exceeds the bounded program registry reconciliation contract`), { code: "failed-precondition", errorCode: "assert_bounded_source_read_exceeds_bounded_program_registry" });
}

function parseAliasConfirmations(value: unknown): AliasConfirmationInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw Object.assign(new Error("invalid-argument: aliasConfirmations must be an array with at most 100 entries"), { code: "invalid-argument", errorCode: "parse_alias_confirmations_alias_confirmations_must_be_array" });
  }
  const proposalIds = uniqueSorted(value.map((item) => asString(asRecord(item).proposalId)));
  if (proposalIds.length !== value.length || proposalIds.some((id) => !/^[a-f0-9]{40}$/.test(id))) {
    throw Object.assign(new Error("invalid-argument: aliasConfirmations require unique exact proposalId values"), { code: "invalid-argument", errorCode: "parse_alias_confirmations_alias_confirmations_require_unique_exact" });
  }
  return proposalIds.map((proposalId) => ({ proposalId }));
}

function normalizedSlug(value: unknown): string {
  return asString(value).trim().toLowerCase();
}

function normalizedTitle(value: unknown): string {
  return asString(value).trim().toLowerCase().replace(/\s+/g, " ");
}

function exactOwnerScopeKey(row: SourceRow): string {
  const uid = asString(row.ownerUid) || asString(row.createdBy);
  if (uid && !uid.includes("@")) return `uid:${uid}`;
  const email = asString(row.ownerEmail).toLowerCase();
  return email ? `email:${email}` : "";
}

function preferredProposalCanonical(rows: SourceRow[], slug: string): SourceRow {
  const exactGeneratedId = `pg-${slug}`;
  return rows.find((row) => row.id === exactGeneratedId)
    ?? [...rows].sort((left, right) => left.id.localeCompare(right.id))[0];
}

function proposalPairKey(alias: string, canonicalProgramId: string): string {
  return [alias, canonicalProgramId].sort().join("\u0000");
}

function makeAliasProposal(
  aliasRow: SourceRow,
  canonicalRow: SourceRow,
  evidenceType: ProgramAliasProposal["evidenceType"],
): ProgramAliasProposal {
  const sourceRevisionHash = createHash("sha256").update(stableStringify({
    alias: sourceRevisionProjection(aliasRow),
    canonical: sourceRevisionProjection(canonicalRow),
  })).digest("hex");
  const mergeEligible = evidenceType === "immutable_slug_owner";
  const payload = {
    alias: aliasRow.id,
    canonicalProgramId: canonicalRow.id,
    aliasSourceRef: aliasRow.ref,
    canonicalSourceRef: canonicalRow.ref,
    evidenceType,
    sourceRevisionHash,
  };
  return {
    proposalId: registryIdempotencyKey(payload),
    ...payload,
    reason: mergeEligible
      ? "same_slug_same_owner_requires_admin_confirmation"
      : "title_only_requires_external_evidence",
    mergeEligible,
    status: "human_gate",
  };
}

export function buildProgramAliasProposals(
  programs: SourceRow[],
  aliasMap: Record<string, string> = {},
): ProgramAliasProposal[] {
  const proposals: ProgramAliasProposal[] = [];
  const paired = new Set<string>();
  const slugOwnerGroups = new Map<string, SourceRow[]>();
  for (const program of programs) {
    const slug = normalizedSlug(program.slug);
    const owner = exactOwnerScopeKey(program);
    if (!slug || !owner) continue;
    const key = `${owner}\u0000${slug}`;
    slugOwnerGroups.set(key, [...(slugOwnerGroups.get(key) ?? []), program]);
  }
  for (const [key, rows] of slugOwnerGroups) {
    const uniqueCanonicals = new Set(rows.map((row) => resolveCanonicalProgramId(row.id, aliasMap)));
    if (rows.length < 2 || uniqueCanonicals.size < 2) continue;
    const slug = key.split("\u0000").at(-1) ?? "";
    const canonicalRow = preferredProposalCanonical(rows, slug);
    for (const aliasRow of rows) {
      if (aliasRow.id === canonicalRow.id) continue;
      const pairKey = proposalPairKey(aliasRow.id, canonicalRow.id);
      paired.add(pairKey);
      proposals.push(makeAliasProposal(aliasRow, canonicalRow, "immutable_slug_owner"));
    }
  }

  const titleGroups = new Map<string, SourceRow[]>();
  for (const program of programs) {
    const title = normalizedTitle(program.title);
    if (title) titleGroups.set(title, [...(titleGroups.get(title) ?? []), program]);
  }
  for (const rows of titleGroups.values()) {
    if (rows.length < 2) continue;
    const ordered = [...rows].sort((left, right) => left.id.localeCompare(right.id));
    const canonicalRow = ordered[0];
    for (const aliasRow of ordered.slice(1)) {
      const pairKey = proposalPairKey(aliasRow.id, canonicalRow.id);
      if (paired.has(pairKey)) continue;
      if (resolveCanonicalProgramId(aliasRow.id, aliasMap) === resolveCanonicalProgramId(canonicalRow.id, aliasMap)) continue;
      proposals.push(makeAliasProposal(aliasRow, canonicalRow, "title_only_ambiguous"));
    }
  }
  return proposals.sort((left, right) => left.proposalId.localeCompare(right.proposalId));
}

function sourceRevisionProjection(row: SourceRow): Record<string, unknown> {
  return {
    id: row.id,
    ref: row.ref,
    canonicalProgramId: asString(row.canonicalProgramId),
    status: asString(row.status),
    visible: row.visible !== false,
    deletedAt: asString(row.deletedAt),
    archivedAt: asString(row.archivedAt),
    slug: normalizedSlug(row.slug),
    title: normalizedTitle(row.title),
    ownerScopeKey: exactOwnerScopeKey(row),
    updatedAtIso: asString(row.updatedAtIso),
    createdAtIso: asString(row.createdAtIso),
    aliases: uniqueSorted(Array.isArray(row.aliases) ? row.aliases : []),
    legacyProgramIds: uniqueSorted(Array.isArray(row.legacyProgramIds) ? row.legacyProgramIds : []),
  };
}

function preferredCanonicalProgramRow(rows: SourceRow[], canonicalProgramId: string): SourceRow | null {
  return rows.find((row) => row.id === canonicalProgramId)
    ?? [...rows].sort((left, right) => {
      const leftAt = Date.parse(asString(left.updatedAtIso) || asString(left.createdAtIso));
      const rightAt = Date.parse(asString(right.updatedAtIso) || asString(right.createdAtIso));
      return (Number.isFinite(rightAt) ? rightAt : 0) - (Number.isFinite(leftAt) ? leftAt : 0)
        || left.id.localeCompare(right.id);
    })[0]
    ?? null;
}

function programAliasDocFromExisting(row: SourceRow): ProgramAliasDoc {
  const role = row.confirmedByRole === "super_admin" ? "super_admin" : row.confirmedByRole === "admin" ? "admin" : undefined;
  const evidenceType = row.evidenceType === "immutable_slug_owner" || row.evidenceType === "registry_binding" || row.evidenceType === "scp_contract"
    ? row.evidenceType
    : undefined;
  return {
    alias: asString(row.alias, row.id),
    canonicalProgramId: asString(row.canonicalProgramId),
    reason: asString(row.reason),
    createdAtIso: asString(row.createdAtIso),
    createdBy: asString(row.createdBy),
    registryVersion: PROGRAM_REGISTRY_VERSION,
    ...(row.confirmationStatus === "confirmed" ? { confirmationStatus: "confirmed" as const } : {}),
    ...(evidenceType ? { evidenceType } : {}),
    ...(Array.isArray(row.sourceRefs) ? { sourceRefs: uniqueSorted(row.sourceRefs) } : {}),
    ...(asString(row.sourceRevisionHash) ? { sourceRevisionHash: asString(row.sourceRevisionHash) } : {}),
    ...(asString(row.confirmedAtIso) ? { confirmedAtIso: asString(row.confirmedAtIso) } : {}),
    ...(asString(row.confirmedBy) ? { confirmedBy: asString(row.confirmedBy) } : {}),
    ...(role ? { confirmedByRole: role } : {}),
    ...(asString(row.reconciliationOperationRef) ? { reconciliationOperationRef: asString(row.reconciliationOperationRef) } : {}),
    ...(asString(row.reconciliationConfirmationToken) ? { reconciliationConfirmationToken: asString(row.reconciliationConfirmationToken) } : {}),
    ...(asString(row.aliasTargetDigest) ? { aliasTargetDigest: asString(row.aliasTargetDigest) } : {}),
    ...(asString(row.canonicalTargetDigest) ? { canonicalTargetDigest: asString(row.canonicalTargetDigest) } : {}),
    ...(asString(row.operationReceiptDigest) ? { operationReceiptDigest: asString(row.operationReceiptDigest) } : {}),
  };
}

function stateRowsForIds(collection: string, ids: string[], rows: SourceRow[]): SourceRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    return row
      ? { ...row, id, ref: `${collection}/${id}`, exists: true }
      : { id, ref: `${collection}/${id}`, exists: false };
  });
}

export function programRegistrySourceStateHash(
  programRows: SourceRow[],
  aliasRows: SourceRow[],
  registryRows: SourceRow[],
): string {
  const project = (rows: SourceRow[], kind: "program" | "alias" | "registry") => rows.map((row) => ({
    kind,
    id: row.id,
    ref: row.ref,
    exists: row.exists === true,
    ...(kind === "program" ? sourceRevisionProjection(row) : {}),
    ...(kind === "alias" ? {
      alias: asString(row.alias, row.id),
      canonicalProgramId: asString(row.canonicalProgramId),
      reason: asString(row.reason),
      confirmationStatus: asString(row.confirmationStatus),
      evidenceType: asString(row.evidenceType),
      sourceRefs: uniqueSorted(Array.isArray(row.sourceRefs) ? row.sourceRefs : []),
      sourceRevisionHash: asString(row.sourceRevisionHash),
      confirmedAtIso: asString(row.confirmedAtIso),
      confirmedBy: asString(row.confirmedBy),
      confirmedByRole: asString(row.confirmedByRole),
      createdAtIso: asString(row.createdAtIso),
      createdBy: asString(row.createdBy),
      registryVersion: asString(row.registryVersion),
      reconciliationOperationRef: asString(row.reconciliationOperationRef),
      reconciliationConfirmationToken: asString(row.reconciliationConfirmationToken),
      aliasTargetDigest: asString(row.aliasTargetDigest),
      canonicalTargetDigest: asString(row.canonicalTargetDigest),
      operationReceiptDigest: asString(row.operationReceiptDigest),
    } : {}),
    ...(kind === "registry" ? {
      canonicalProgramId: asString(row.canonicalProgramId, row.id),
      aliases: uniqueSorted(Array.isArray(row.aliases) ? row.aliases : []),
      legacyProgramIds: uniqueSorted(Array.isArray(row.legacyProgramIds) ? row.legacyProgramIds : []),
      sourceRefs: uniqueSorted(Array.isArray(row.sourceRefs) ? row.sourceRefs : []),
      title: asString(row.title),
      slug: asString(row.slug),
      visible: row.visible !== false,
      mergedCounts: numberMap(row.mergedCounts),
      lastReconciledAtIso: asString(row.lastReconciledAtIso),
      registryVersion: asString(row.registryVersion),
    } : {}),
  })).sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(stableStringify({
    programs: project(programRows, "program"),
    aliases: project(aliasRows, "alias"),
    registry: project(registryRows, "registry"),
  })).digest("hex");
}

type RefCountMap = Record<string, Record<string, number>>;

async function readReferenceCounts(
  auth: AuthContext,
  aliasMap: Record<string, string>,
  transaction?: Transaction,
): Promise<{ counts: RefCountMap; stateHash: string }> {
  const entries = await Promise.all(Object.entries(REFERENCE_COLLECTIONS).map(async ([collection, fields]) => [
    collection,
    await countCollectionRefs(collection, fields, auth, aliasMap, transaction),
  ] as const));
  return {
    counts: Object.fromEntries(entries.map(([collection, result]) => [collection, result.counts])),
    stateHash: sha256Hex(entries.map(([collection, result]) => ({
      collection,
      rows: result.rows.map(referenceStateProjection).sort((left, right) => left.id.localeCompare(right.id)),
    }))),
  };
}

async function countCollectionRefs(
  collection: string,
  fields: string[],
  auth: AuthContext,
  aliasMap: Record<string, string>,
  transaction?: Transaction,
): Promise<{ counts: Record<string, number>; rows: SourceRow[] }> {
  const query = adminDb.collection(collection).select(...uniqueSorted([...fields, "canonicalProgramId"])).limit(SOURCE_LIMIT + 1);
  const snap = transaction ? await transaction.get(query) : await query.get();
  assertBoundedSourceRead(snap, collection);
  const counts: Record<string, number> = {};
  const rows: SourceRow[] = [];
  for (const doc of snap.docs) {
    const row = rowFromDoc(doc);
    if (!rowMatchesAccountScope(scopeKey(collection), row, auth)) continue;
    rows.push(row);
    const canonical = resolvedProgramIdFrom(row, aliasMap);
    if (!canonical) continue;
    counts[canonical] = (counts[canonical] ?? 0) + 1;
  }
  return { counts, rows };
}

function referenceStateProjection(row: SourceRow): Record<string, unknown> & { id: string } {
  return Object.fromEntries(Object.entries(row)
    .filter(([key]) => key !== "ref")
    .sort(([left], [right]) => left.localeCompare(right))) as Record<string, unknown> & { id: string };
}

function scopeKey(collection: string): string {
  return SCOPE_KEY_BY_COLLECTION[collection] ?? collection;
}

function rowFromDoc(doc: QueryDocumentSnapshot): SourceRow {
  return { id: doc.id, ref: doc.ref.path, ...(doc.data() ?? {}) };
}

function resolvedProgramIdFrom(row: SourceRow, aliasMap: Record<string, string>): string {
  const declaredCanonical = resolveCanonicalProgramId(row.canonicalProgramId, aliasMap);
  const raw = asString(row.programId) || asString(row.campaignProgramId) || asString(row.program) || asString(row.programSlug) || asString(row.bridgedProgramId) || (resolveCanonicalProgramId(row.id, aliasMap) === SCP_CANONICAL_PROGRAM_ID ? asString(row.id) : "");
  const rawCanonical = resolveCanonicalProgramId(raw, aliasMap);
  if (declaredCanonical && rawCanonical && declaredCanonical !== rawCanonical) return "";
  return declaredCanonical || rawCanonical;
}

function mergedCountsForCanonical(refCounts: RefCountMap, canonicalProgramId: string, programDocCount: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [collection, counts] of Object.entries(refCounts)) {
    const count = counts[canonicalProgramId] ?? 0;
    if (count > 0) out[collection] = count;
  }
  if (programDocCount > 0) out.programs = programDocCount;
  return out;
}

function mergeAffectedCollections(groups: ReconcileGroup[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const group of groups) {
    for (const [collection, count] of Object.entries(group.mergedCounts)) out[collection] = (out[collection] ?? 0) + count;
  }
  return out;
}

export function registryIdempotencyKey(value: unknown): string {
  return sha256Hex(value).slice(0, 40);
}

function sha256Hex(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function registryIdempotencyPayload(registryDocs: ProgramRegistryDoc[], aliasDocs: ProgramAliasDoc[]) {
  return {
    registryVersion: PROGRAM_REGISTRY_VERSION,
    registry: registryDocs.map((doc) => ({
      canonicalProgramId: doc.canonicalProgramId,
      title: doc.title,
      slug: doc.slug,
      visible: doc.visible,
      aliases: doc.aliases,
      legacyProgramIds: doc.legacyProgramIds,
      sourceRefs: doc.sourceRefs,
      mergedCounts: doc.mergedCounts,
      registryVersion: doc.registryVersion,
    })),
    aliases: aliasDocs.map((doc) => ({
      alias: doc.alias,
      canonicalProgramId: doc.canonicalProgramId,
      reason: doc.reason,
      confirmationStatus: doc.confirmationStatus ?? "",
      evidenceType: doc.evidenceType ?? "",
      sourceRefs: doc.sourceRefs ?? [],
      sourceRevisionHash: doc.sourceRevisionHash ?? "",
      confirmedBy: doc.confirmedBy ?? "",
      confirmedByRole: doc.confirmedByRole ?? "",
      registryVersion: doc.registryVersion,
    })),
  };
}

function programRegistryOutputStateHash(registryDocs: ProgramRegistryDoc[], aliasDocs: ProgramAliasDoc[]): string {
  return sha256Hex({
    semantic: registryIdempotencyPayload(registryDocs, aliasDocs),
    registryTemporal: registryDocs.map((doc) => ({
      canonicalProgramId: doc.canonicalProgramId,
      lastReconciledAtIso: doc.lastReconciledAtIso,
    })),
    aliasTemporal: aliasDocs.map((doc) => ({
      alias: doc.alias,
      confirmedAtIso: doc.confirmedAtIso ?? "",
      createdAtIso: doc.createdAtIso,
      createdBy: doc.createdBy,
      reconciliationOperationRef: doc.reconciliationOperationRef ?? "",
      reconciliationConfirmationToken: doc.reconciliationConfirmationToken ?? "",
      aliasTargetDigest: doc.aliasTargetDigest ?? "",
      canonicalTargetDigest: doc.canonicalTargetDigest ?? "",
      operationReceiptDigest: doc.operationReceiptDigest ?? "",
    })),
  });
}

function programRegistrySemanticOutputStateHash(registryDocs: ProgramRegistryDoc[], aliasDocs: ProgramAliasDoc[]): string {
  return sha256Hex(registryIdempotencyPayload(registryDocs, aliasDocs));
}

function safeDocId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 160) || "unknown";
}

function safeActorId(value: string): string {
  const trimmed = asString(value, "system");
  if (!trimmed || trimmed === "system") return "system";
  return /[@\s]/.test(trimmed) ? `uid_hash_${registryIdempotencyKey(trimmed)}` : safeDocId(trimmed);
}

function safeText(value: unknown, fallback: string, max: number): string {
  return asString(value, fallback).replace(/[\r\n\t]+/g, " ").slice(0, max);
}

function safeSlug(value: unknown, fallback: string): string {
  return safeText(value, fallback, 120).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
}

function numberMap(value: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries(asRecord(value))
    .filter(([, nested]) => typeof nested === "number" && Number.isFinite(nested))
    .map(([key, nested]): [string, number] => [key, Math.trunc(nested as number)])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function stringMap(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(asRecord(value))
    .filter(([, nested]) => typeof nested === "string")
    .sort(([left], [right]) => left.localeCompare(right))) as Record<string, string>;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
