import { canonicalScpProgramId, isScpProgramId, normalizeScpProgramId, SCP_PROGRAM_ALIAS_IDS } from "./scp-program-alias.ts";

export const PROGRAM_REGISTRY_VERSION = "program_registry_v1" as const;
export const SCP_CANONICAL_PROGRAM_ID = canonicalScpProgramId;
export const SCP_LEGACY_PROGRAM_ID = "scp" as const;

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
};

export type ProgramCanonicalProjection = {
  canonicalProgramId: string;
  aliases: string[];
  legacyProgramIds: string[];
};

function cleanProgramId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueSorted(values: Iterable<unknown>): string[] {
  return Array.from(new Set(Array.from(values).map(cleanProgramId).filter(Boolean))).sort((a, b) => a.localeCompare(b));
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
    // Generic registry aliases are exact Firestore document identities. SCP is
    // handled above by its compatibility contract and remains case-insensitive.
    const mapped = cleanProgramId(aliasDocs[current]);
    if (!mapped || mapped === current) return current;
    current = isScpProgramId(mapped.toLowerCase()) ? normalizeScpProgramId(mapped) : mapped;
  }
}

export function isCanonicalScpProgramId(programId: unknown): boolean {
  return resolveCanonicalProgramId(programId) === SCP_CANONICAL_PROGRAM_ID;
}

export function canonicalProjectionForProgramIds(programIds: Iterable<unknown>, aliasDocs: Record<string, string> = {}): ProgramCanonicalProjection {
  const rawIds = uniqueSorted(programIds);
  const canonicalIds = uniqueSorted(rawIds.map((id) => resolveCanonicalProgramId(id, aliasDocs)));
  const canonicalProgramId = canonicalIds.includes(SCP_CANONICAL_PROGRAM_ID) ? SCP_CANONICAL_PROGRAM_ID : (canonicalIds[0] ?? "");
  const aliases = canonicalProgramId === SCP_CANONICAL_PROGRAM_ID
    ? uniqueSorted([...SCP_PROGRAM_ALIAS_IDS, ...rawIds])
    : uniqueSorted([canonicalProgramId, ...rawIds]);
  return {
    canonicalProgramId,
    aliases,
    legacyProgramIds: aliases.filter((id) => id !== canonicalProgramId),
  };
}
