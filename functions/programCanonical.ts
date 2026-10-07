import { createHash } from "node:crypto";
import { canonicalScpProgramId, isScpProgramId, normalizeScpProgramId, SCP_PROGRAM_ALIAS_IDS } from "./scpProgramAlias";

export const PROGRAM_REGISTRY_VERSION = "program_registry_v1" as const;
export const SCP_CANONICAL_PROGRAM_ID = canonicalScpProgramId;
export const SCP_LEGACY_PROGRAM_ID = "scp" as const;
export const MAX_CONFIRMED_PROGRAM_IDENTITIES = 15;

export type ProgramRegistryVersion = typeof PROGRAM_REGISTRY_VERSION;

export type ProgramRegistryDoc = {
  canonicalProgramId: string;
  visible: boolean;
  title: string;
  slug: string;
  aliases: string[];
  legacyProgramIds: string[];
  sourceRefs: string[];
  mergedCounts: Record<string, number>;
  lastReconciledAtIso: string;
  registryVersion: ProgramRegistryVersion;
};

export type ProgramAliasDoc = {
  alias: string;
  canonicalProgramId: string;
  reason: string;
  createdAtIso: string;
  createdBy: string;
  registryVersion: ProgramRegistryVersion;
  confirmationStatus?: "confirmed";
  evidenceType?: "immutable_slug_owner" | "registry_binding" | "scp_contract";
  sourceRefs?: string[];
  sourceRevisionHash?: string;
  confirmedAtIso?: string;
  confirmedBy?: string;
  confirmedByRole?: "super_admin" | "admin";
  reconciliationOperationRef?: string;
  reconciliationConfirmationToken?: string;
  aliasTargetDigest?: string;
  canonicalTargetDigest?: string;
  operationReceiptDigest?: string;
};

export type CanonicalProgramIdentity = {
  canonicalProgramId: string;
  rawProgramIdAlias: string | null;
};

function cleanProgramId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const PROGRAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,139}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(cleanProgramId).filter(Boolean)
    : [];
}

function isIso(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function confirmedGenericAlias(row: Record<string, unknown>, alias: string, canonicalProgramId: string): boolean {
  if (row.registryVersion !== PROGRAM_REGISTRY_VERSION) return false;
  if (row.confirmationStatus !== "confirmed") return false;
  if (row.reason !== "explicit_admin_confirmation") return false;
  if (row.confirmedByRole !== "admin" && row.confirmedByRole !== "super_admin") return false;
  if (!cleanProgramId(row.confirmedBy) || !isIso(row.confirmedAtIso)) return false;
  if (row.evidenceType !== "immutable_slug_owner" && row.evidenceType !== "registry_binding") return false;
  if (!SHA256_PATTERN.test(cleanProgramId(row.sourceRevisionHash))) return false;
  if (!/^program_registry_operations\/[a-f0-9]{40}$/.test(cleanProgramId(row.reconciliationOperationRef))) return false;
  if (!/^[a-f0-9]{40}$/.test(cleanProgramId(row.reconciliationConfirmationToken))) return false;
  if (!SHA256_PATTERN.test(cleanProgramId(row.aliasTargetDigest))) return false;
  if (!SHA256_PATTERN.test(cleanProgramId(row.canonicalTargetDigest))) return false;
  if (!SHA256_PATTERN.test(cleanProgramId(row.operationReceiptDigest))) return false;
  const sourceRefs = new Set(stringArray(row.sourceRefs));
  return sourceRefs.has(`programs/${alias}`) && sourceRefs.has(`programs/${canonicalProgramId}`);
}

function collapseAliasMap(direct: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const alias of Object.keys(direct)) {
    let current = alias;
    const seen = new Set<string>();
    while (direct[current] && direct[current] !== current) {
      if (seen.has(current)) {
        current = "";
        break;
      }
      seen.add(current);
      current = direct[current];
    }
    if (current && current !== alias) out[alias] = current;
  }
  return out;
}

/**
 * Builds the only generic alias map trusted by read projections. A title/slug on a
 * program row is deliberately insufficient: generic aliases require an admin
 * confirmation receipt bound to both immutable program document refs. SCP keeps
 * its pre-registry compatibility contract.
 */
export function confirmedProgramAliasMap(rows: Iterable<unknown>): Record<string, string> {
  const direct: Record<string, string> = {};
  for (const scpAlias of scpAliasIds()) {
    if (scpAlias !== SCP_CANONICAL_PROGRAM_ID) direct[scpAlias] = SCP_CANONICAL_PROGRAM_ID;
  }
  for (const value of rows) {
    const row = asRecord(value);
    const alias = cleanProgramId(row.alias) || cleanProgramId(row.id);
    const canonicalProgramId = cleanProgramId(row.canonicalProgramId);
    if (
      (cleanProgramId(row.id) && row.id !== row.alias)
      ||
      !PROGRAM_ID_PATTERN.test(alias)
      || !PROGRAM_ID_PATTERN.test(canonicalProgramId)
      || alias === canonicalProgramId
    ) continue;
    const scpContract = isScpProgramId(alias)
      && resolveCanonicalProgramId(canonicalProgramId) === SCP_CANONICAL_PROGRAM_ID
      && row.reason === "scp_alias_contract";
    // Reserved SCP identities can only participate in their built-in contract.
    // Otherwise a forged `scp -> another-program` receipt could make the other
    // program's detail query include SCP rows even though SCP resolution itself
    // remains canonicalized by the compatibility helper.
    if (isScpProgramId(alias) && !scpContract) continue;
    if (!scpContract && !confirmedGenericAlias(row, alias, canonicalProgramId)) continue;
    // Firestore document IDs are case-sensitive. Never widen a confirmed exact
    // source identity into a case-insensitive alias that was not in the receipt.
    direct[alias] = canonicalProgramId;
  }
  return collapseAliasMap(direct);
}

export function aliasesForCanonicalProgramId(
  canonicalProgramId: unknown,
  aliasDocs: Record<string, string> = {},
): string[] {
  const canonical = resolveCanonicalProgramId(canonicalProgramId, aliasDocs);
  if (!canonical) return [];
  return uniqueSorted([
    canonical,
    ...Object.entries(aliasDocs)
      .filter(([, target]) => resolveCanonicalProgramId(target, aliasDocs) === canonical)
      .map(([alias]) => alias),
    ...(canonical === SCP_CANONICAL_PROGRAM_ID ? scpAliasIds() : []),
  ]);
}

/**
 * Returns the complete, confirmed read identity set for one canonical program.
 * Callers must not slice this list: silently dropping a legacy identity creates
 * split-brain reads. A query surface with a smaller Firestore DNF budget passes
 * that exact budget and fails closed when the registry cannot fit it.
 */
export function confirmedProgramIdentitySet(
  canonicalProgramId: unknown,
  aliasDocs: Record<string, string> = {},
  maxIdentities = MAX_CONFIRMED_PROGRAM_IDENTITIES,
): string[] {
  const identities = aliasesForCanonicalProgramId(canonicalProgramId, aliasDocs);
  if (!Number.isInteger(maxIdentities) || maxIdentities < 1 || identities.length > maxIdentities) {
    const error = new Error("failed-precondition: canonical program has too many confirmed identities for the bounded read contract");
    Object.assign(error, { code: "failed-precondition", errorCode: "confirmed_program_identity_set_canonical_program_too_many_confirmed" });
    throw error;
  }
  return identities;
}

/** Semantic revision bound to the exact confirmed alias graph (including SCP). */
export function confirmedProgramAliasRegistryRevision(aliasDocs: Record<string, string>): string {
  const aliases = Object.entries(aliasDocs)
    .map(([alias, canonicalProgramId]) => [alias, resolveCanonicalProgramId(canonicalProgramId, aliasDocs)] as const)
    .filter(([alias, canonicalProgramId]) => alias && canonicalProgramId && alias !== canonicalProgramId)
    .sort(([leftAlias, leftCanonical], [rightAlias, rightCanonical]) => (
      leftAlias.localeCompare(rightAlias) || leftCanonical.localeCompare(rightCanonical)
    ));
  return createHash("sha256").update(stableStringify({
    registryVersion: PROGRAM_REGISTRY_VERSION,
    aliases,
  })).digest("hex");
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function updatedAtMillis(row: Record<string, unknown>): number {
  const value = cleanProgramId(row.updatedAtIso) || cleanProgramId(row.createdAtIso);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function preferredProgramProjectionRow(
  current: Record<string, unknown>,
  candidate: Record<string, unknown>,
  canonicalProgramId: string,
): Record<string, unknown> {
  const currentCanonical = cleanProgramId(current.id) === canonicalProgramId;
  const candidateCanonical = cleanProgramId(candidate.id) === canonicalProgramId;
  if (candidateCanonical !== currentCanonical) return candidateCanonical ? candidate : current;
  return updatedAtMillis(candidate) > updatedAtMillis(current) ? candidate : current;
}

/** Read-only projection used by listPrograms. It never mutates or deletes source rows. */
export function mergeConfirmedProgramRows(
  values: Iterable<unknown>,
  aliasMap: Record<string, string>,
): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  const conflictingRawIds = new Set<string>();
  for (const value of values) {
    const row = asRecord(value);
    const rawProgramId = cleanProgramId(row.id);
    if (!PROGRAM_ID_PATTERN.test(rawProgramId)) continue;
    const mappedRaw = resolveCanonicalProgramId(rawProgramId, aliasMap);
    const declared = cleanProgramId(row.canonicalProgramId)
      ? resolveCanonicalProgramId(row.canonicalProgramId, aliasMap)
      : "";
    // A contradictory denormalized field cannot pull the row into another group.
    const conflictsWithRegistry = Boolean(declared && declared !== mappedRaw);
    const canonicalProgramId = conflictsWithRegistry ? rawProgramId : (declared || mappedRaw);
    if (conflictsWithRegistry) conflictingRawIds.add(rawProgramId);
    groups.set(canonicalProgramId, [...(groups.get(canonicalProgramId) ?? []), row]);
  }

  return [...groups.entries()].map(([canonicalProgramId, rows]) => {
    const preferred = rows.reduce((current, candidate) => (
      preferredProgramProjectionRow(current, candidate, canonicalProgramId)
    ));
    const mayExpandConfirmedAliases = resolveCanonicalProgramId(canonicalProgramId, aliasMap) === canonicalProgramId;
    const aliases = uniqueSorted([
      ...(mayExpandConfirmedAliases
        ? aliasesForCanonicalProgramId(canonicalProgramId, aliasMap).filter((alias) => !conflictingRawIds.has(alias))
        : [canonicalProgramId]),
      ...rows.map((row) => row.id),
    ]);
    const maxCounter = (key: string) => Math.max(...rows.map((row) => finiteNonNegative(row[key])), 0);
    return {
      ...preferred,
      id: canonicalProgramId,
      canonicalProgramId,
      aliases,
      legacyProgramIds: aliases.filter((id) => id !== canonicalProgramId),
      sourceProgramIds: uniqueSorted(rows.map((row) => row.id)),
      applicationCount: maxCounter("applicationCount"),
      approvedCount: maxCounter("approvedCount"),
      contractCount: maxCounter("contractCount"),
      reviewCount: maxCounter("reviewCount"),
      registryVersion: PROGRAM_REGISTRY_VERSION,
    };
  }).sort((left, right) => cleanProgramId(left.id).localeCompare(cleanProgramId(right.id)));
}

export function uniqueSorted(values: Iterable<unknown>): string[] {
  return Array.from(new Set(Array.from(values).map(cleanProgramId).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

export function resolveCanonicalProgramIdentity(input: {
  programId?: unknown;
  canonicalProgramId?: unknown;
  programIdAlias?: unknown;
  fallbackProgramId?: unknown;
}, aliasDocs: Record<string, string> = {}): CanonicalProgramIdentity {
  const declaredCanonicalProgramId = cleanProgramId(input.canonicalProgramId);
  const declaredRawProgramAlias = cleanProgramId(input.programIdAlias);
  const rawProgramId = cleanProgramId(input.programId)
    || (!declaredCanonicalProgramId ? cleanProgramId(input.fallbackProgramId) : "");
  const canonicalCandidates = uniqueSorted([
    resolveCanonicalProgramId(rawProgramId, aliasDocs),
    resolveCanonicalProgramId(declaredCanonicalProgramId, aliasDocs),
    resolveCanonicalProgramId(declaredRawProgramAlias, aliasDocs),
  ]);
  if (canonicalCandidates.length !== 1) {
    const code = canonicalCandidates.length > 1 ? "program_identity_conflict" : "program_identity_unresolved";
    throw Object.assign(new Error(code), { code });
  }
  const canonicalProgramId = canonicalCandidates[0];
  const rawProgramIdAlias = [declaredRawProgramAlias, rawProgramId, declaredCanonicalProgramId]
    .find((programId) => (
      programId !== canonicalProgramId
      && resolveCanonicalProgramId(programId, aliasDocs) === canonicalProgramId
    ))
    ?? null;
  return { canonicalProgramId, rawProgramIdAlias };
}

export function resolveCanonicalProgramId(programId: unknown, aliasDocs: Record<string, string> = {}): string {
  const raw = cleanProgramId(programId);
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (isScpProgramId(lower)) return normalizeScpProgramId(lower);
  let current = raw;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current)) return raw;
    seen.add(current);
    const mapped = cleanProgramId(aliasDocs[current]);
    if (!mapped || mapped === current) return current;
    current = isScpProgramId(mapped.toLowerCase()) ? normalizeScpProgramId(mapped) : mapped;
  }
}

export function scpAliasIds(): string[] {
  return uniqueSorted(SCP_PROGRAM_ALIAS_IDS);
}

/** Exact immutable target digests. Do not trim/sort/repair fields before hashing. */
export function programAliasTargetDigest(value: unknown): string {
  const row = asRecord(value);
  return createHash("sha256").update(stableStringify({
    alias: row.alias,
    canonicalProgramId: row.canonicalProgramId,
    reason: row.reason,
    confirmationStatus: row.confirmationStatus,
    evidenceType: row.evidenceType,
    sourceRefs: row.sourceRefs,
    sourceRevisionHash: row.sourceRevisionHash,
    confirmedAtIso: row.confirmedAtIso,
    confirmedBy: row.confirmedBy,
    confirmedByRole: row.confirmedByRole,
    createdAtIso: row.createdAtIso,
    createdBy: row.createdBy,
    registryVersion: row.registryVersion,
  })).digest("hex");
}

export function programRegistryTargetDigest(value: unknown): string {
  const row = asRecord(value);
  return createHash("sha256").update(stableStringify({
    canonicalProgramId: row.canonicalProgramId,
    visible: row.visible,
    title: row.title,
    slug: row.slug,
    aliases: row.aliases,
    legacyProgramIds: row.legacyProgramIds,
    sourceRefs: row.sourceRefs,
    mergedCounts: row.mergedCounts,
    lastReconciledAtIso: row.lastReconciledAtIso,
    registryVersion: row.registryVersion,
  })).digest("hex");
}

export function programRegistryIdentityTargetDigest(
  registryRows: Iterable<unknown>,
  aliasRows: Iterable<unknown>,
): string {
  const registry = Array.from(registryRows).map((value) => {
    const row = asRecord(value);
    return { documentId: row.id, canonicalProgramId: row.canonicalProgramId };
  });
  const aliases = Array.from(aliasRows).map((value) => {
    const row = asRecord(value);
    return { documentId: row.id, alias: row.alias, canonicalProgramId: row.canonicalProgramId };
  });
  return createHash("sha256").update(stableStringify({ registry, aliases })).digest("hex");
}

export function programReconciliationOperationReceiptDigest(value: unknown): string {
  const row = asRecord(value);
  return createHash("sha256").update(stableStringify({
    action: row.action,
    confirmationToken: row.confirmationToken,
    scope: row.scope,
    actorId: row.actorId,
    actorRole: row.actorRole,
    confirmationProposalIds: row.confirmationProposalIds,
    idempotencyKey: row.idempotencyKey,
    sourceStateHash: row.sourceStateHash,
    sourceProgramStateHash: row.sourceProgramStateHash,
    referenceStateHash: row.referenceStateHash,
    sourceProgramIds: row.sourceProgramIds,
    sourceAliasIds: row.sourceAliasIds,
    sourceRegistryIds: row.sourceRegistryIds,
    aliasTargetDigests: row.aliasTargetDigests,
    registryTargetDigests: row.registryTargetDigests,
    targetIdentityDigest: row.targetIdentityDigest,
  })).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
