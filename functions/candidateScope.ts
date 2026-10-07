import { createHash } from "node:crypto";
import { resolveCanonicalProgramId } from "./programCanonical";

export const CANDIDATE_SCOPE_VERSION = "candidate_scope_v3" as const;

export const CANDIDATE_SOURCE_PURPOSE = {
  FEED_DISCOVERY: "feed_discovery",
  PROGRAM_CANDIDATE: "program_candidate",
  IDENTITY_ENRICHMENT: "identity_enrichment",
} as const;

export type CandidateSourcePurpose = typeof CANDIDATE_SOURCE_PURPOSE[keyof typeof CANDIDATE_SOURCE_PURPOSE];

const GLOBAL_IDENTITY_OMIT_FIELDS = new Set([
  "canonicalProgramId",
  "programId",
  "programRef",
  "campaignId",
  "sourceCampaignId",
  "campaignRef",
  "campaignCandidateRef",
  "candidateProvenance",
  "sourceRunId",
  "sourceRunRef",
  "runRef",
  "stage",
  "eligibility",
  "programScopeEvidence",
  "criteriaHash",
  "policyHash",
  "publicationStatus",
  "publicationGenerationId",
  "publicationGenerationRef",
  "publicationContractVersion",
  "publicationCandidateRef",
  "stableCampaignCandidateId",
  "communityStableHead",
  "communityGenerationRow",
  "communityActivatedHead",
  "sourceArtifactRef",
  "sourceRunStatus",
  "accountScopeVersion",
  "ownerUid",
  "ownerEmail",
  "ownerAuthTenantId",
  "ownerOrgId",
  "ownerMailAccountId",
  "ownerMailAccountIds",
  "ownerOrgResolutionStatus",
  "accountOwnerUid",
  "accountOwnerEmail",
  "accountOwnerOrgId",
  "accountOwnerMailAccountId",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeCandidateId(value: unknown): string {
  const candidateId = stringValue(value);
  return /^[A-Za-z0-9_-]{1,180}$/.test(candidateId) ? candidateId : "";
}

export function candidateIdFromCandidate(value: unknown): string {
  const candidate = asRecord(value);
  const explicit = safeCandidateId(candidate.candidateId) || safeCandidateId(candidate.id);
  if (explicit) return explicit;
  const candidateRef = stringValue(candidate.candidateRef);
  const match = /^candidate_pool\/([A-Za-z0-9_-]{1,180})$/.exec(candidateRef);
  return match?.[1] ?? "";
}

export function candidatePoolRefForCandidate(value: unknown): string {
  const candidate = asRecord(value);
  const candidateId = candidateIdFromCandidate(candidate);
  if (!candidateId) throw new Error("invalid-argument: candidate identity is required");
  const claimedRef = stringValue(candidate.candidateRef);
  if (claimedRef && claimedRef !== `candidate_pool/${candidateId}`) {
    throw new Error("failed-precondition: candidateRef does not match candidate identity");
  }
  return `candidate_pool/${candidateId}`;
}

export function campaignCandidateLinkId(programId: string, campaignId: string, candidateId: string): string {
  const canonicalProgramId = resolveCanonicalProgramId(programId);
  const safeCampaignId = stringValue(campaignId);
  const safeId = safeCandidateId(candidateId);
  if (!canonicalProgramId || !safeCampaignId || !safeId) {
    throw new Error("invalid-argument: program, campaign, and candidate identity are required");
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([canonicalProgramId, safeCampaignId, safeId]))
    .digest("hex")
    .slice(0, 40);
  return `ccl_${digest}`;
}

export function campaignCandidateRefFor(
  programId: string,
  campaignId: string,
  candidateId: string,
): string {
  return `campaign_candidates/${campaignCandidateLinkId(programId, campaignId, candidateId)}`;
}

export function globalCandidateIdentityData(value: unknown): Record<string, unknown> {
  const candidate = asRecord(value);
  const candidateId = candidateIdFromCandidate(candidate);
  const candidateRef = candidatePoolRefForCandidate(candidate);
  const identity: Record<string, unknown> = {
    id: candidateId,
    candidateId,
    candidateRef,
  };
  for (const [key, child] of Object.entries(candidate)) {
    if (GLOBAL_IDENTITY_OMIT_FIELDS.has(key) || child === undefined) continue;
    identity[key] = child;
  }
  return identity;
}

export type ProgramScopedCandidateWritePlan = {
  identityRef: string;
  identityData: Record<string, unknown>;
  participationRef: string;
  participationData: Record<string, unknown>;
};

export function buildProgramScopedCandidateParticipationWrites(input: {
  candidate: unknown;
  canonicalProgramId: string;
  campaignId: string;
  sourceRunId: string;
  sourceRunRef: string;
  stage?: string;
  eligibility?: Record<string, unknown>;
  programScopeEvidence?: Record<string, unknown>;
  candidateProvenance?: Record<string, unknown>;
  accountOwnership?: Record<string, unknown>;
}): ProgramScopedCandidateWritePlan {
  const canonicalProgramId = resolveCanonicalProgramId(input.canonicalProgramId);
  const campaignId = stringValue(input.campaignId);
  const sourceRunId = stringValue(input.sourceRunId);
  const sourceRunRef = stringValue(input.sourceRunRef);
  if (!canonicalProgramId || !campaignId || !sourceRunId || sourceRunRef !== `discovery_runs/${sourceRunId}`) {
    throw new Error("failed-precondition: exact program/campaign/run provenance is required");
  }
  const candidate = asRecord(input.candidate);
  const identityData = {
    ...globalCandidateIdentityData(candidate),
    candidateSourcePurpose: CANDIDATE_SOURCE_PURPOSE.PROGRAM_CANDIDATE,
    candidateSourcePurposeVersion: CANDIDATE_SCOPE_VERSION,
    programCandidateDiscovered: true,
  };
  const candidateId = candidateIdFromCandidate(identityData);
  const identityRef = candidatePoolRefForCandidate(identityData);
  const participationRef = campaignCandidateRefFor(canonicalProgramId, campaignId, candidateId);
  const candidateEligibility = asRecord(candidate.eligibility);
  const eligibility = input.eligibility ?? (Object.keys(candidateEligibility).length > 0 ? candidateEligibility : {
    verdict: "human_gate",
    reasonCodes: ["program_eligibility_pending"],
  });
  const optionalScopedEvidence: Record<string, unknown> = {};
  const accountOwnership = asRecord(input.accountOwnership);
  if (Object.keys(accountOwnership).length > 0) {
    for (const [key, value] of Object.entries(accountOwnership)) {
      if (value !== undefined) optionalScopedEvidence[key] = value;
    }
  }
  const recordEvidence = [
    ["programScopeEvidence", input.programScopeEvidence ?? asRecord(candidate.programScopeEvidence)],
    ["candidateProvenance", input.candidateProvenance ?? asRecord(candidate.candidateProvenance)],
  ] as const;
  for (const [key, value] of recordEvidence) {
    if (Object.keys(value).length > 0) optionalScopedEvidence[key] = value;
  }
  for (const key of ["criteriaHash", "policyHash"] as const) {
    const value = stringValue(candidate[key]);
    if (value) optionalScopedEvidence[key] = value;
  }
  return {
    identityRef,
    identityData,
    participationRef,
    participationData: {
      ...identityData,
      id: participationRef.slice("campaign_candidates/".length),
      campaignCandidateRef: participationRef,
      candidateId,
      candidateRef: identityRef,
      canonicalProgramId,
      programId: canonicalProgramId,
      programRef: `programs/${canonicalProgramId}`,
      campaignId,
      campaignRef: `campaigns/${campaignId}`,
      sourceRunId,
      sourceRunRef,
      stage: stringValue(input.stage) || stringValue(candidate.stage) || "discovered",
      eligibility,
      ...optionalScopedEvidence,
      candidateSourcePurpose: CANDIDATE_SOURCE_PURPOSE.PROGRAM_CANDIDATE,
      candidateScopeVersion: CANDIDATE_SCOPE_VERSION,
    },
  };
}
