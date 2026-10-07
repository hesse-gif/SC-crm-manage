import { canonicalCreatorId } from "./creator-identity.ts";
import { SCP_CANONICAL_PROGRAM_ID, resolveCanonicalProgramId } from "./program-canonical.ts";
import type { Campaign } from "./mock/campaigns";
import type { Program, ProgramApplication, ProgramApplicationStatus } from "./mock/programs";
import type { ChatConversation } from "./chat-normalization";

type ProgramDedupeContext = {
  readonly applications?: readonly ProgramApplication[];
  readonly campaigns?: readonly Campaign[];
  readonly conversations?: readonly ChatConversation[];
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function programDedupeKey(program: Program): string {
  const declaredCanonical = resolveCanonicalProgramId(program.canonicalProgramId);
  const canonicalId = declaredCanonical || resolveCanonicalProgramId(program.id);
  return canonicalId ? `canonical:${canonicalId}` : `id:${program.id}`;
}

function programReferenceScore(program: Program, context: ProgramDedupeContext): number {
  const applicationRefs = (context.applications ?? []).filter((application) => application.programId === program.id).length;
  const campaignRefs = (context.campaigns ?? []).filter((campaign) => campaign.programId === program.id).length;
  const conversationRefs = (context.conversations ?? []).filter((conversation) => conversation.programId === program.id).length;
  const counterRefs =
    numberValue(program.applicationCount) +
    numberValue(program.approvedCount) +
    numberValue(program.contractCount) +
    numberValue(program.reviewCount);
  return applicationRefs * 100 + campaignRefs * 50 + conversationRefs * 10 + counterRefs;
}

function updatedMillis(program: Program): number {
  const value = text((program as unknown as { updatedAtIso?: unknown }).updatedAtIso);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function preferredProgram(left: Program, right: Program, context: ProgramDedupeContext): Program {
  const leftCanonical = resolveCanonicalProgramId(left.canonicalProgramId || left.id);
  const rightCanonical = resolveCanonicalProgramId(right.canonicalProgramId || right.id);
  if (leftCanonical === SCP_CANONICAL_PROGRAM_ID && rightCanonical === SCP_CANONICAL_PROGRAM_ID) {
    if (left.id === SCP_CANONICAL_PROGRAM_ID && right.id !== SCP_CANONICAL_PROGRAM_ID) return left;
    if (right.id === SCP_CANONICAL_PROGRAM_ID && left.id !== SCP_CANONICAL_PROGRAM_ID) return right;
  }
  const leftScore = programReferenceScore(left, context);
  const rightScore = programReferenceScore(right, context);
  if (rightScore !== leftScore) return rightScore > leftScore ? right : left;
  const leftUpdated = updatedMillis(left);
  const rightUpdated = updatedMillis(right);
  if (rightUpdated !== leftUpdated) return rightUpdated > leftUpdated ? right : left;
  return left.id.localeCompare(right.id) <= 0 ? left : right;
}

export function canonicalProgramIdMap(
  programs: readonly Program[],
  _context: ProgramDedupeContext = {},
): Map<string, string> {
  const proposed = new Map<string, Set<string>>();
  const propose = (alias: string, canonicalProgramId: string) => {
    const cleanAlias = text(alias);
    const cleanCanonical = resolveCanonicalProgramId(canonicalProgramId);
    if (!cleanAlias || !cleanCanonical) return;
    proposed.set(cleanAlias, new Set([...(proposed.get(cleanAlias) ?? []), cleanCanonical]));
  };

  for (const program of programs) {
    const declaredCanonical = resolveCanonicalProgramId(program.canonicalProgramId);
    const canonicalProgramId = declaredCanonical || resolveCanonicalProgramId(program.id);
    propose(program.id, canonicalProgramId);
    // Aliases carried by listPrograms/operational snapshots are trusted only when
    // the row also declares its canonical identity. A same-title/same-slug client
    // row can never invent an alias relationship.
    if (declaredCanonical || canonicalProgramId === SCP_CANONICAL_PROGRAM_ID) {
      for (const alias of [...(program.aliases ?? []), ...(program.legacyProgramIds ?? [])]) {
        propose(alias, canonicalProgramId);
      }
    }
  }

  const map = new Map<string, string>();
  for (const [alias, candidates] of proposed) {
    if (candidates.size === 1) map.set(alias, [...candidates][0]);
  }
  for (const program of programs) {
    if (!map.has(program.id)) map.set(program.id, resolveCanonicalProgramId(program.id) || program.id);
  }
  return map;
}

export function dedupeProgramsByIdentity(
  programs: readonly Program[],
  context: ProgramDedupeContext = {},
): Program[] {
  const idMap = canonicalProgramIdMap(programs, context);
  const byKey = new Map<string, Program>();
  const order: string[] = [];
  for (const program of programs) {
    const canonicalProgramId = idMap.get(program.id) ?? resolveCanonicalProgramId(program.id) ?? program.id;
    const key = `canonical:${canonicalProgramId}`;
    if (!byKey.has(key)) {
      order.push(key);
      byKey.set(key, { ...program, id: canonicalProgramId, canonicalProgramId });
      continue;
    }
    const current = byKey.get(key) ?? program;
    const preferred = preferredProgram(current, program, context);
    byKey.set(key, {
      ...preferred,
      id: canonicalProgramId,
      canonicalProgramId,
      aliases: uniqueProgramRefs([canonicalProgramId, ...(current.aliases ?? []), current.id, ...(program.aliases ?? []), program.id]),
      legacyProgramIds: uniqueProgramRefs([...(current.legacyProgramIds ?? []), ...(program.legacyProgramIds ?? []), current.id, program.id])
        .filter((id) => id !== canonicalProgramId),
    });
  }
  return order.map((key) => byKey.get(key)).filter((program): program is Program => Boolean(program));
}

function uniqueProgramRefs(values: readonly unknown[]): string[] {
  return [...new Set(values.map(text).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

export function mergeSnapshotAndLiveProgramsByIdentity(
  snapshotPrograms: readonly Program[],
  livePrograms: readonly Program[],
): Program[] {
  // The live list is the server's current confirmed registry projection. A stale
  // snapshot may still contain one row per pre-registry alias, so live mappings
  // deliberately override fallback snapshot self-identities.
  const idMap = canonicalProgramIdMap(snapshotPrograms);
  for (const [alias, canonicalProgramId] of canonicalProgramIdMap(livePrograms)) {
    idMap.set(alias, canonicalProgramId);
  }
  const grouped = (rows: readonly Program[]) => {
    const map = new Map<string, Program[]>();
    for (const row of rows) {
      const canonicalProgramId = idMap.get(row.id) ?? resolveCanonicalProgramId(row.canonicalProgramId || row.id) ?? row.id;
      map.set(canonicalProgramId, [...(map.get(canonicalProgramId) ?? []), row]);
    }
    return map;
  };
  const snapshots = grouped(snapshotPrograms);
  const live = grouped(livePrograms);
  const canonicalIds = uniqueProgramRefs([...snapshots.keys(), ...live.keys()]);
  const collapseRows = (rows: readonly Program[], canonicalProgramId: string): Program | undefined => {
    if (rows.length === 0) return undefined;
    const preferred = rows.reduce((left, right) => preferredProgram(left, right, {}));
    const aliases = uniqueProgramRefs(rows.flatMap((row) => [row.id, ...(row.aliases ?? []), ...(row.legacyProgramIds ?? [])]));
    const liveCounter = (key: "applicationCount" | "approvedCount" | "contractCount" | "reviewCount") => numberValue(preferred[key]);
    return {
      ...preferred,
      id: canonicalProgramId,
      canonicalProgramId,
      aliases: uniqueProgramRefs([canonicalProgramId, ...aliases]),
      legacyProgramIds: aliases.filter((id) => id !== canonicalProgramId),
      applicationCount: liveCounter("applicationCount"),
      approvedCount: liveCounter("approvedCount"),
      contractCount: liveCounter("contractCount"),
      reviewCount: liveCounter("reviewCount"),
    };
  };
  return canonicalIds.map((canonicalProgramId) => {
    const snapshotRows = snapshots.get(canonicalProgramId) ?? [];
    const liveRows = live.get(canonicalProgramId) ?? [];
    const snapshot = collapseRows(snapshotRows, canonicalProgramId);
    const liveProgram = collapseRows(liveRows, canonicalProgramId);
    const base = liveProgram ?? snapshot;
    if (!base) throw new Error("canonical program merge lost its source row");
    const aliases = uniqueProgramRefs([
      canonicalProgramId,
      ...snapshotRows.flatMap((row) => [row.id, ...(row.aliases ?? []), ...(row.legacyProgramIds ?? [])]),
      ...liveRows.flatMap((row) => [row.id, ...(row.aliases ?? []), ...(row.legacyProgramIds ?? [])]),
    ]);
    return {
      ...base,
      id: canonicalProgramId,
      canonicalProgramId,
      aliases,
      legacyProgramIds: aliases.filter((id) => id !== canonicalProgramId),
      ...(liveProgram ? {
        applicationCount: liveProgram.applicationCount,
        approvedCount: liveProgram.approvedCount,
        contractCount: liveProgram.contractCount,
        reviewCount: liveProgram.reviewCount,
      } : snapshot ? {
        applicationCount: snapshot.applicationCount,
        approvedCount: snapshot.approvedCount,
        contractCount: snapshot.contractCount,
        reviewCount: snapshot.reviewCount,
      } : {}),
    };
  });
}

export function canonicalizeProgramScopedRecords<T extends Record<string, unknown>>(
  rows: readonly T[],
  idMap: ReadonlyMap<string, string>,
): T[] {
  return rows.map((row) => {
    const rawProgramId = text(row.canonicalProgramId) || text(row.programId) || text(row.bridgedProgramId) || text(row.program);
    if (!rawProgramId) return row;
    const canonicalProgramId = idMap.get(rawProgramId) ?? resolveCanonicalProgramId(rawProgramId);
    if (!canonicalProgramId || (row.programId === canonicalProgramId && row.canonicalProgramId === canonicalProgramId)) return row;
    return { ...row, programId: canonicalProgramId, canonicalProgramId };
  });
}

// ---- Program application identity de-duplication -----------------------------
// One real person can surface as several program_application rows: the SCP bridge
// writes a `source: "scp"` record for a qualified lead (a real, "반응있는" applicant),
// sheet-lead ingest can add another representation, and the seeded mock adds a fixed
// one. Left unmerged, the list renders one row per record while the stat tiles count
// something else — the "숫자가 안 맞음" report — and the inflated list makes the modal
// scroll endlessly. We collapse rows that resolve to the same creator identity while
// keeping the most progressed / real record, so SCP-sourced applicants are never
// dropped and workflow progress (creator link, contract, review) is preserved.

function applicationIdentityKey(application: ProgramApplication): string {
  return (
    canonicalCreatorId({
      creatorId: application.creatorId,
      email: application.email,
      handle: application.handle,
      name: application.name,
      youtubeUrl: application.youtubeUrl,
    }) ||
    text(application.email).toLowerCase() ||
    text(application.handle).toLowerCase() ||
    text(application.youtubeUrl).toLowerCase() ||
    text(application.name).toLowerCase() ||
    application.id
  );
}

const APPLICATION_STATUS_RANK: Record<ProgramApplicationStatus, number> = {
  approved: 40,
  hold: 20,
  pending: 10,
  rejected: 0,
};

// Higher score = more authoritative record. Workflow progress (review > contract >
// creator link) dominates, then real SCP origin, then status, then a conversation
// link. This deliberately favours real, progressed data over the seeded mock.
function applicationProgressScore(application: ProgramApplication): number {
  let score = 0;
  if (text(application.reviewId)) score += 1000;
  if (text(application.contractId)) score += 500;
  if (text(application.creatorId)) score += 100;
  if ((application as { source?: unknown }).source === "scp") score += 50;
  score += APPLICATION_STATUS_RANK[application.status] ?? 0;
  if (text(application.conversationId)) score += 5;
  return score;
}

function applicationSubmittedMillis(application: ProgramApplication): number {
  const parsed = Date.parse(text(application.submittedAtIso));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function preferredApplication(left: ProgramApplication, right: ProgramApplication): ProgramApplication {
  const leftScore = applicationProgressScore(left);
  const rightScore = applicationProgressScore(right);
  if (rightScore !== leftScore) return rightScore > leftScore ? right : left;
  const leftAt = applicationSubmittedMillis(left);
  const rightAt = applicationSubmittedMillis(right);
  if (rightAt !== leftAt) return rightAt > leftAt ? right : left;
  return left.id.localeCompare(right.id) <= 0 ? left : right;
}

// Fill any workflow reference the canonical record is missing from its duplicates,
// so merging never loses an approval / contract / review / conversation link.
function mergeApplicationWorkflow(base: ProgramApplication, duplicates: readonly ProgramApplication[]): ProgramApplication {
  const merged: ProgramApplication = { ...base };
  for (const duplicate of duplicates) {
    if (!text(merged.creatorId) && text(duplicate.creatorId)) merged.creatorId = duplicate.creatorId;
    if (!text(merged.conversationId) && text(duplicate.conversationId)) merged.conversationId = duplicate.conversationId;
    if (!text(merged.contractId) && text(duplicate.contractId)) merged.contractId = duplicate.contractId;
    if (!text(merged.reviewId) && text(duplicate.reviewId)) merged.reviewId = duplicate.reviewId;
    if (!text(merged.campaignId) && text(duplicate.campaignId)) {
      merged.campaignId = duplicate.campaignId;
      if (!text(merged.campaignTitle) && text(duplicate.campaignTitle)) merged.campaignTitle = duplicate.campaignTitle;
    }
  }
  return merged;
}

// Collapse duplicate representations of the same person into one canonical row.
// Preserves original first-seen order and never drops a distinct identity.
export function dedupeProgramApplicationsByIdentity(
  applications: readonly ProgramApplication[],
): ProgramApplication[] {
  const groups = new Map<string, ProgramApplication[]>();
  const order: string[] = [];
  for (const application of applications) {
    const key = applicationIdentityKey(application);
    const group = groups.get(key);
    if (group) {
      group.push(application);
    } else {
      order.push(key);
      groups.set(key, [application]);
    }
  }
  return order
    .map((key) => {
      const group = groups.get(key) ?? [];
      if (group.length <= 1) return group[0];
      const base = group.reduce((left, right) => preferredApplication(left, right));
      return mergeApplicationWorkflow(base, group.filter((application) => application !== base));
    })
    .filter((application): application is ProgramApplication => Boolean(application));
}
