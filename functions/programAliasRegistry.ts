import type { DocumentSnapshot, Query, Transaction } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  confirmedProgramAliasMap,
  confirmedProgramAliasRegistryRevision,
  confirmedProgramIdentitySet,
  programAliasTargetDigest,
  programReconciliationOperationReceiptDigest,
  programRegistryTargetDigest,
  resolveCanonicalProgramId,
} from "./programCanonical";

// Keep mutation/read authorization on the same bounded registry contract used by
// operational snapshot construction. A registry that can be built but cannot be
// authorized/read would make every consumer fail inconsistently.
export const PROGRAM_ALIAS_READ_LIMIT = 50_000;
export const PROGRAM_ALIAS_PROJECTION_FIELDS = [
  "alias",
  "canonicalProgramId",
  "reason",
  "confirmationStatus",
  "evidenceType",
  "sourceRefs",
  "sourceRevisionHash",
  "confirmedAtIso",
  "confirmedBy",
  "confirmedByRole",
  "createdAtIso",
  "createdBy",
  "registryVersion",
  "reconciliationOperationRef",
  "reconciliationConfirmationToken",
  "aliasTargetDigest",
  "canonicalTargetDigest",
  "operationReceiptDigest",
] as const;

type ProgramAliasProjectionRow = {
  id: string;
} & Record<(typeof PROGRAM_ALIAS_PROJECTION_FIELDS)[number], unknown>;

export type ConfirmedProgramAliasRegistryState = {
  aliasMap: Record<string, string>;
  revision: string;
};

let registryCache: { expiresAt: number; state: ConfirmedProgramAliasRegistryState } | null = null;
const REGISTRY_CACHE_MS = 15_000;

function isEmulatorRuntime(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true" || Boolean(process.env.FIRESTORE_EMULATOR_HOST);
}

function aliasRegistryQuery(): Query {
  return adminDb.collection("program_aliases")
    .select(...PROGRAM_ALIAS_PROJECTION_FIELDS)
    .limit(PROGRAM_ALIAS_READ_LIMIT + 1);
}

function programAliasProjectionRow(
  doc: FirebaseFirestore.QueryDocumentSnapshot,
): ProgramAliasProjectionRow {
  const data: Record<string, unknown> = doc.data();
  return {
    id: doc.id,
    alias: data.alias,
    canonicalProgramId: data.canonicalProgramId,
    reason: data.reason,
    confirmationStatus: data.confirmationStatus,
    evidenceType: data.evidenceType,
    sourceRefs: data.sourceRefs,
    sourceRevisionHash: data.sourceRevisionHash,
    confirmedAtIso: data.confirmedAtIso,
    confirmedBy: data.confirmedBy,
    confirmedByRole: data.confirmedByRole,
    createdAtIso: data.createdAtIso,
    createdBy: data.createdBy,
    registryVersion: data.registryVersion,
    reconciliationOperationRef: data.reconciliationOperationRef,
    reconciliationConfirmationToken: data.reconciliationConfirmationToken,
    aliasTargetDigest: data.aliasTargetDigest,
    canonicalTargetDigest: data.canonicalTargetDigest,
    operationReceiptDigest: data.operationReceiptDigest,
  };
}

async function stateFromSnapshot(
  snapshot: FirebaseFirestore.QuerySnapshot,
  getOperations: (refs: FirebaseFirestore.DocumentReference[]) => Promise<DocumentSnapshot[]>,
): Promise<ConfirmedProgramAliasRegistryState> {
  if (snapshot.size > PROGRAM_ALIAS_READ_LIMIT) {
    throw Object.assign(
      new Error("failed-precondition: confirmed program alias registry exceeds the bounded read contract"),
      { code: "failed-precondition", errorCode: "program_alias_registry_read_limit_exceeded" },
    );
  }
  const rows = snapshot.docs.map(programAliasProjectionRow);
  const genericRows = rows.filter((row) => row.confirmationStatus === "confirmed" && row.reason === "explicit_admin_confirmation");
  const operationRefs = [...new Set(genericRows.map((row) => String(row.reconciliationOperationRef ?? "")))];
  if (operationRefs.some((path) => !/^program_registry_operations\/[a-f0-9]{40}$/.test(path))) {
    throw registryVerificationError("generic alias is not bound to an exact reconciliation operation", "program_alias_operation_ref_invalid");
  }
  const refs = operationRefs.map((path) => adminDb.doc(path));
  const operations = refs.length > 0 ? await getOperations(refs) : [];
  const operationByPath = new Map(operations.map((doc) => [doc.ref.path, doc]));
  for (const row of genericRows) verifyGenericAliasReceipt(row, operationByPath.get(String(row.reconciliationOperationRef)));
  const genericAliases = new Set(genericRows.map((row) => row.id));
  if (genericRows.some((row) => genericAliases.has(String(row.canonicalProgramId)))) {
    throw registryVerificationError("generic alias chains are forbidden", "program_alias_chain_forbidden");
  }
  const aliasMap = confirmedProgramAliasMap(genericRows);
  return {
    aliasMap,
    revision: confirmedProgramAliasRegistryRevision(aliasMap),
  };
}

/**
 * R34-2 [운영 진단 갭 수리]: 이 계열은 **모든 캠페인의 refill 초입**에서 던진다
 * (createCampaignWithPreparedTargets → resolveAuthoritativeCampaignProgramPolicy →
 * readConfirmedProgramAliasRegistryState). errorCode 가 없어서 운영 로그에는
 * `errorCode: failed-precondition` 이라는 무의미한 사유만 남았고(스윕 catch 가 code 로 폴백한다),
 * 준비 단계 카운터도 없어 "어디서 막혔는지"를 코드 읽기로 되짚어야 했다. 사유마다 고유 코드를 준다.
 * ⚠️ 진단 컨텍스트는 **식별자만** 남긴다 — 영수증 원문·시크릿·프롬프트는 싣지 않는다(SEC-P0-009).
 */
function registryVerificationError(reason: string, errorCode: string, context: Record<string, string> = {}): Error {
  return Object.assign(new Error(`failed-precondition: ${reason}`), {
    code: "failed-precondition",
    errorCode,
    ...(Object.keys(context).length > 0 ? { details: context } : {}),
  });
}

function verifyGenericAliasReceipt(row: Record<string, unknown> & { id: string }, operationSnapshot?: DocumentSnapshot): void {
  if (row.alias !== row.id) {
    throw registryVerificationError(
      "program alias field must equal its document id",
      "program_alias_id_mismatch",
      { aliasId: row.id },
    );
  }
  if (!operationSnapshot?.exists) {
    throw registryVerificationError(
      "program alias reconciliation operation is missing",
      "program_alias_operation_missing",
      { aliasId: row.id },
    );
  }
  const operation = operationSnapshot.data() ?? {};
  const token = operationSnapshot.id;
  const proposalWrites = Array.isArray(operation.proposedAliasWrites) ? operation.proposedAliasWrites : [];
  const registryWrites = Array.isArray(operation.proposedRegistryWrites) ? operation.proposedRegistryWrites : [];
  const target = proposalWrites.find((value) => value && typeof value === "object" && (value as Record<string, unknown>).alias === row.id) as Record<string, unknown> | undefined;
  const canonicalTarget = registryWrites.find((value) => value && typeof value === "object" && (value as Record<string, unknown>).canonicalProgramId === row.canonicalProgramId) as Record<string, unknown> | undefined;
  const proposals = Array.isArray(operation.ambiguousProposals) ? operation.ambiguousProposals : [];
  const proposal = proposals.find((value) => value && typeof value === "object"
    && (value as Record<string, unknown>).alias === row.id
    && (value as Record<string, unknown>).canonicalProgramId === row.canonicalProgramId) as Record<string, unknown> | undefined;
  const confirmedProposalIds = Array.isArray(operation.confirmationProposalIds) ? operation.confirmationProposalIds : [];
  const valid = operation.action === "program_registry.reconcile"
    && operation.status === "applied"
    && operation.confirmationToken === token
    && row.reconciliationConfirmationToken === token
    && row.reconciliationOperationRef === operationSnapshot.ref.path
    && operation.actorId === row.confirmedBy
    && operation.actorRole === row.confirmedByRole
    && proposal?.sourceRevisionHash === row.sourceRevisionHash
    && confirmedProposalIds.includes(proposal?.proposalId)
    && Array.isArray(operation.sourceProgramIds)
    && operation.sourceProgramIds.includes(row.id)
    && operation.sourceProgramIds.includes(row.canonicalProgramId)
    && Array.isArray(operation.sourceAliasIds)
    && operation.sourceAliasIds.includes(row.id)
    && Array.isArray(operation.sourceRegistryIds)
    && operation.sourceRegistryIds.includes(row.canonicalProgramId)
    && programAliasTargetDigest(row) === row.aliasTargetDigest
    && programAliasTargetDigest(target) === row.aliasTargetDigest
    && programRegistryTargetDigest(canonicalTarget) === row.canonicalTargetDigest
    && (operation.aliasTargetDigests as Record<string, unknown> | undefined)?.[row.id] === row.aliasTargetDigest
    && (operation.registryTargetDigests as Record<string, unknown> | undefined)?.[String(row.canonicalProgramId)] === row.canonicalTargetDigest
    && operation.receiptDigest === row.operationReceiptDigest
    && programReconciliationOperationReceiptDigest(operation) === operation.receiptDigest;
  if (!valid) {
    throw registryVerificationError(
      "program alias receipt/source/target binding is invalid",
      "program_alias_receipt_binding_invalid",
      { aliasId: row.id },
    );
  }
}

export async function readConfirmedProgramAliasRegistryState(
  options: { bypassCache?: boolean } = {},
): Promise<ConfirmedProgramAliasRegistryState> {
  const now = Date.now();
  if (!options.bypassCache && !isEmulatorRuntime() && registryCache && registryCache.expiresAt > now) return registryCache.state;
  const state = await stateFromSnapshot(await aliasRegistryQuery().get(), (refs) => adminDb.getAll(...refs));
  if (!isEmulatorRuntime()) registryCache = { expiresAt: now + REGISTRY_CACHE_MS, state };
  return state;
}

/** Transactions never use the process cache: mutation authorization must bind live registry state. */
export async function readConfirmedProgramAliasRegistryStateInTransaction(
  transaction: Transaction,
): Promise<ConfirmedProgramAliasRegistryState> {
  return stateFromSnapshot(await transaction.get(aliasRegistryQuery()), (refs) => transaction.getAll(...refs));
}

export function confirmedProgramScope(
  rawProgramId: unknown,
  state: ConfirmedProgramAliasRegistryState,
  maxIdentities?: number,
): { canonicalProgramId: string; identityProgramIds: string[]; aliasRegistryRevision: string } {
  const canonicalProgramId = resolveCanonicalProgramId(rawProgramId, state.aliasMap);
  if (!canonicalProgramId) {
    throw Object.assign(new Error("failed-precondition: program identity is not canonicalizable"), {
      code: "failed-precondition",
      errorCode: "program_identity_not_canonicalizable",
    });
  }
  return {
    canonicalProgramId,
    identityProgramIds: confirmedProgramIdentitySet(canonicalProgramId, state.aliasMap, maxIdentities),
    aliasRegistryRevision: state.revision,
  };
}
