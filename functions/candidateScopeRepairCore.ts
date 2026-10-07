import { campaignCandidateLinkId, candidateIdFromCandidate, candidatePoolRefForCandidate } from "./candidateScope";
import { resolveCanonicalProgramId } from "./programCanonical";

type RepairPlan =
  | {
      status: "repair";
      reason: "legacy_scope_exact_run_verified";
      guessedScope: false;
      target: {
        collection: "campaign_candidates";
        documentId: string;
        merge: true;
        data: Record<string, unknown>;
      };
    }
  | {
      status: "human_gate";
      reason: string;
      scope: "unscoped";
      guessedScope: false;
      target: null;
    };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function runId(value: unknown): string {
  const raw = text(value);
  const match = /^(?:discovery_runs\/)?([A-Za-z0-9_-]{1,180})$/.exec(raw);
  return match?.[1] ?? "";
}

function canonicalIds(...values: unknown[]): string[] {
  return Array.from(new Set(values.map((value) => resolveCanonicalProgramId(value)).filter(Boolean)));
}

function unscoped(reason: string): RepairPlan {
  return { status: "human_gate", reason, scope: "unscoped", guessedScope: false, target: null };
}

function identityVariants(value: unknown): string[] {
  const raw = text(value);
  if (!raw) return [];
  const tail = raw.includes("/") ? raw.split("/").filter(Boolean).at(-1) ?? "" : "";
  return Array.from(new Set([raw, tail].filter(Boolean)));
}

function snapshotContainsCandidate(snapshot: unknown, candidate: Record<string, unknown>): boolean {
  if (!Array.isArray(snapshot)) return false;
  const expected = new Set([
    candidate.id,
    candidate.candidateId,
    candidate.candidateRef,
    candidate.channelRef,
  ].flatMap(identityVariants));
  return snapshot.some((value) => {
    const row = record(value);
    return [row.id, row.candidateId, row.candidateRef, row.channelRef, row.creatorId]
      .flatMap(identityVariants)
      .some((identity) => expected.has(identity));
  });
}

export function planLegacyCandidateScopeRepair(input: {
  legacyCandidate: unknown;
  discoveryRuns: unknown[];
}): RepairPlan {
  const legacyCandidate = record(input.legacyCandidate);
  let candidateId = "";
  let candidateRef = "";
  try {
    candidateId = candidateIdFromCandidate(legacyCandidate);
    candidateRef = candidatePoolRefForCandidate(legacyCandidate);
  } catch {
    return unscoped("legacy_candidate_identity_invalid");
  }

  const programIds = canonicalIds(legacyCandidate.canonicalProgramId, legacyCandidate.programId);
  if (programIds.length !== 1) return unscoped("legacy_program_scope_ambiguous");
  const canonicalProgramId = programIds[0];
  const campaignId = text(legacyCandidate.campaignId);
  if (!campaignId) return unscoped("legacy_campaign_scope_missing");

  const claimedRunIds = Array.from(new Set([
    legacyCandidate.sourceRunId,
    legacyCandidate.sourceRunRef,
    legacyCandidate.runRef,
  ].map(runId).filter(Boolean)));
  if (claimedRunIds.length > 1) return unscoped("legacy_source_run_ambiguous");
  if (claimedRunIds.length === 0) return unscoped("legacy_source_run_missing");
  const sourceRunId = claimedRunIds[0];
  const discoveryRuns = Array.isArray(input.discoveryRuns) ? input.discoveryRuns.map(record) : [];
  const matchingRuns = discoveryRuns.filter((run) => runId(run.id) === sourceRunId);
  if (matchingRuns.length !== 1) return unscoped("legacy_source_run_missing");
  const sourceRun = matchingRuns[0];

  const runProgramIds = canonicalIds(sourceRun.canonicalProgramId, sourceRun.programId);
  if (runProgramIds.length !== 1 || runProgramIds[0] !== canonicalProgramId) {
    return unscoped("legacy_source_run_program_mismatch");
  }
  if (text(sourceRun.campaignId) !== campaignId) {
    return unscoped("legacy_source_run_campaign_mismatch");
  }
  if (!snapshotContainsCandidate(sourceRun.candidateSnapshot, legacyCandidate)) {
    return unscoped("legacy_source_run_candidate_missing");
  }

  const documentId = campaignCandidateLinkId(canonicalProgramId, campaignId, candidateId);
  return {
    status: "repair",
    reason: "legacy_scope_exact_run_verified",
    guessedScope: false,
    target: {
      collection: "campaign_candidates",
      documentId,
      merge: true,
      data: {
        candidateId,
        candidateRef,
        canonicalProgramId,
        programId: canonicalProgramId,
        programRef: `programs/${canonicalProgramId}`,
        campaignId,
        campaignRef: `campaigns/${campaignId}`,
        sourceRunId,
        sourceRunRef: `discovery_runs/${sourceRunId}`,
        stage: "discovered",
        eligibility: {
          verdict: "human_gate",
          reasonCodes: ["legacy_scope_repaired_requires_evaluation"],
        },
        repairVersion: "candidate_scope_repair_v2",
      },
    },
  };
}
