// Pure core for the frozen `scp-flu-application-management-attribution.v2` contract (§2.3, §3, §7).
// Deterministic classification, append-only assignment ledger, and KPI attribution projection.
// NO Firestore / side effects here — the Firestore + callable wiring (v2 receiver dispatchApplicationEvent)
// composes these functions. Kept pure so it is unit-pinned by
// tests/flu-application-management-attribution-spec.test.mjs without an emulator.

export const APPLICATION_MANAGEMENT_ATTRIBUTION_VERSION = "application_management_attribution_v2" as const;

// §3.3 classification states + Manage-inbox routing.
export type AttributionClassification = "managed" | "unclassified" | "ambiguous" | "conflict";

export const ATTRIBUTION_CLASSIFICATION_STATES: readonly AttributionClassification[] = [
  "managed",
  "unclassified",
  "ambiguous",
  "conflict",
] as const;

export const MANAGE_INBOX_STATES: readonly AttributionClassification[] = [
  "unclassified",
  "ambiguous",
  "conflict",
] as const;

export type AttributionReasonCode =
  | "exact_signed_match"
  | "token_absent"
  | "signature_unverified"
  | "token_expired"
  | "token_revoked"
  | "no_candidate"
  | "multiple_candidates"
  | "signed_evidence_conflict";

// §2.3 identity mapping. Unknown / unresolved fields are null — NEVER fabricated.
export type ApplicationIdentityMapping = {
  applicationId: string;
  portalCreatorId: string | null;
  fluCreatorId: string | null;
  programId: string | null;
  campaignId: string | null;
  outreachId: string | null;
  enrollmentId: string | null;
  settlementCreatorCode: string | null;
  channelId: string | null;
};

// §3.1/§3.2 classification is deterministic from the VERIFIED SIGNED outreach token only.
// No email/name/handle inputs are accepted by design — fuzzy matching cannot bind.
export type SignedTokenEvidence = {
  tokenPresent: boolean;
  signatureVerified: boolean;
  expired: boolean;
  revoked: boolean;
  candidateCount: number; // distinct program/campaign/outreach candidates the signed token resolves to
  conflictingSignedEvidence: boolean;
};

export type ClassificationResult = {
  classification: AttributionClassification;
  reasonCode: AttributionReasonCode;
  autoManagedEligible: boolean; // §3.4 exact+signed+unexpired+unrevoked MAY auto-transition to managed
  routeToManageInbox: boolean; // §3.3
};

function normalizeCandidateCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export function classifyApplication(ev: SignedTokenEvidence): ClassificationResult {
  const candidateCount = normalizeCandidateCount(ev.candidateCount);
  let classification: AttributionClassification;
  let reasonCode: AttributionReasonCode;

  if (!ev.tokenPresent) {
    classification = "unclassified";
    reasonCode = "token_absent";
  } else if (!ev.signatureVerified) {
    // Never fall back to fuzzy email/name matching (§3.2).
    classification = "unclassified";
    reasonCode = "signature_unverified";
  } else if (ev.expired) {
    classification = "unclassified";
    reasonCode = "token_expired";
  } else if (ev.revoked) {
    classification = "unclassified";
    reasonCode = "token_revoked";
  } else if (ev.conflictingSignedEvidence) {
    classification = "conflict";
    reasonCode = "signed_evidence_conflict";
  } else if (candidateCount > 1) {
    classification = "ambiguous";
    reasonCode = "multiple_candidates";
  } else if (candidateCount === 1) {
    classification = "managed";
    reasonCode = "exact_signed_match";
  } else {
    classification = "unclassified";
    reasonCode = "no_candidate";
  }

  return {
    classification,
    reasonCode,
    autoManagedEligible: classification === "managed",
    routeToManageInbox: (MANAGE_INBOX_STATES as readonly string[]).includes(classification),
  };
}

// §3.5 append-only assignment ledger; §3.6 revoke blocks new revisions but preserves history.
export type AssignmentRevision = {
  revision: number; // monotonic, starts at 1
  actor: string;
  reason: string;
  programId: string | null;
  campaignId: string | null;
  classification: AttributionClassification;
  atIso: string;
};

export type AssignmentLedger = {
  applicationId: string;
  revisions: AssignmentRevision[]; // append-only
  revoked: boolean;
};

export type AppendRevisionInput = {
  actor: string;
  reason: string;
  programId: string | null;
  campaignId: string | null;
  classification: AttributionClassification;
  atIso: string;
  expectedRevision: number; // optimistic concurrency: must equal current head (0 when empty)
};

export class AttributionLedgerError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "AttributionLedgerError";
  }
}

export function emptyLedger(applicationId: string): AssignmentLedger {
  return { applicationId, revisions: [], revoked: false };
}

export function currentRevisionNumber(ledger: AssignmentLedger): number {
  const last = ledger.revisions[ledger.revisions.length - 1];
  return last ? last.revision : 0;
}

export function currentAssignment(ledger: AssignmentLedger): AssignmentRevision | null {
  const last = ledger.revisions[ledger.revisions.length - 1];
  return last ?? null;
}

export function appendAssignmentRevision(
  ledger: AssignmentLedger,
  input: AppendRevisionInput,
): AssignmentLedger {
  if (ledger.revoked) {
    throw new AttributionLedgerError("revoked", "assignment ledger is revoked; new revisions are blocked");
  }
  const head = currentRevisionNumber(ledger);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== head) {
    throw new AttributionLedgerError("revision_conflict", "expectedRevision does not match ledger head");
  }
  if (!input.actor) throw new AttributionLedgerError("actor_required", "actor is required");
  if (!input.reason) throw new AttributionLedgerError("reason_required", "reason is required");

  const next: AssignmentRevision = {
    revision: head + 1,
    actor: input.actor,
    reason: input.reason,
    programId: input.programId,
    campaignId: input.campaignId,
    classification: input.classification,
    atIso: input.atIso,
  };
  // Append-only: return a NEW ledger; prior revisions are never mutated or dropped.
  return { ...ledger, revisions: [...ledger.revisions, next] };
}

export function revokeLedger(ledger: AssignmentLedger): AssignmentLedger {
  // §3.6 blocks future revisions; the existing revision history is preserved verbatim.
  return { ...ledger, revisions: [...ledger.revisions], revoked: true };
}

// §7 KPI / attribution projection: derived from the CURRENT assignment, keyed on the ORIGINAL Apply
// submittedAt. Each application is counted once toward its current campaign, so a reassignment moves
// the count exactly once (old campaign -1, new campaign +1) by recomputation.
export type ApplicationProjectionInput = {
  applicationId: string;
  submittedAtIso: string; // ORIGINAL apply submittedAt — bucket key (§7.3)
  currentCampaignId: string | null;
  currentProgramId: string | null;
  classification: AttributionClassification;
};

export type CampaignBucketCount = {
  campaignId: string;
  programId: string | null;
  bucket: string;
  count: number;
};

export type AttributionKpiProjection = {
  perCampaign: Record<string, number>;
  perCampaignByBucket: CampaignBucketCount[];
  crossCampaignTotal: number; // applications counted once toward a current campaign
  unattributed: number; // no current campaign (e.g. unclassified/ambiguous/conflict pending assignment)
};

export function dayBucket(submittedAtIso: string): string {
  return submittedAtIso.slice(0, 10);
}

export function computeAttributionKpi(
  apps: ReadonlyArray<ApplicationProjectionInput>,
  bucketOf: (submittedAtIso: string) => string = dayBucket,
): AttributionKpiProjection {
  const perCampaign: Record<string, number> = {};
  const byBucket = new Map<string, CampaignBucketCount>();
  let crossCampaignTotal = 0;
  let unattributed = 0;

  for (const app of apps) {
    if (!app.currentCampaignId) {
      unattributed += 1;
      continue;
    }
    crossCampaignTotal += 1;
    perCampaign[app.currentCampaignId] = (perCampaign[app.currentCampaignId] ?? 0) + 1;
    const bucket = bucketOf(app.submittedAtIso);
    const key = `${app.currentCampaignId}|${bucket}`;
    const existing = byBucket.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byBucket.set(key, {
        campaignId: app.currentCampaignId,
        programId: app.currentProgramId,
        bucket,
        count: 1,
      });
    }
  }

  const perCampaignByBucket = [...byBucket.values()].sort((a, b) =>
    a.campaignId === b.campaignId ? a.bucket.localeCompare(b.bucket) : a.campaignId.localeCompare(b.campaignId),
  );

  return { perCampaign, perCampaignByBucket, crossCampaignTotal, unattributed };
}

const NON_EMPTY = (value: string | null | undefined): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export function buildIdentityMapping(
  input: Partial<ApplicationIdentityMapping> & { applicationId: string },
): ApplicationIdentityMapping {
  return {
    applicationId: input.applicationId,
    portalCreatorId: NON_EMPTY(input.portalCreatorId),
    fluCreatorId: NON_EMPTY(input.fluCreatorId),
    programId: NON_EMPTY(input.programId),
    campaignId: NON_EMPTY(input.campaignId),
    outreachId: NON_EMPTY(input.outreachId),
    enrollmentId: NON_EMPTY(input.enrollmentId),
    settlementCreatorCode: NON_EMPTY(input.settlementCreatorCode),
    channelId: NON_EMPTY(input.channelId),
  };
}

// Portal v3 adoption: map the frozen `scp.creator-pipeline.v3` application.intake.recorded
// signedAttributionEvidence block → SignedTokenEvidence for classifyApplication. This upgrades
// classification from fail-closed unclassified to real signed evidence. Deterministic, no I/O.
// The subject identity is cross-checked against the signed identity (mismatch => conflict).
export type V3SignedAttributionEvidence = {
  programId?: string | null;
  campaignId?: string | null;
  outreachId?: string | null;
  candidateCount?: number | null;
  verification?: string | null;
  revocationStatus?: string | null;
  signedExpiresAt?: string | null;
} | null | undefined;

export function signedTokenEvidenceFromV3Attribution(input: {
  signedAttributionEvidence: V3SignedAttributionEvidence;
  subject: { programId?: string | null; campaignId?: string | null; outreachId?: string | null };
  nowMs: number;
}): SignedTokenEvidence {
  const ev = input.signedAttributionEvidence;
  if (!ev) {
    return {
      tokenPresent: false,
      signatureVerified: false,
      expired: false,
      revoked: false,
      candidateCount: 0,
      conflictingSignedEvidence: false,
    };
  }
  const signatureVerified = ev.verification === "verified_outreach_token_v2";
  const parsedExpiry = typeof ev.signedExpiresAt === "string" ? Date.parse(ev.signedExpiresAt) : NaN;
  // Fail-closed: an unparseable/absent expiry is treated as expired.
  const expired = !Number.isFinite(parsedExpiry) || parsedExpiry <= input.nowMs;
  const revoked = ev.revocationStatus !== "checked_not_revoked";
  const candidateCount = Number.isFinite(ev.candidateCount as number) ? Math.max(0, Math.trunc(ev.candidateCount as number)) : 0;
  const mismatch = (a?: string | null, b?: string | null): boolean =>
    typeof a === "string" && a.length > 0 && typeof b === "string" && b.length > 0 && a !== b;
  const conflictingSignedEvidence =
    mismatch(input.subject.programId, ev.programId) ||
    mismatch(input.subject.campaignId, ev.campaignId) ||
    mismatch(input.subject.outreachId, ev.outreachId);
  return { tokenPresent: true, signatureVerified, expired, revoked, candidateCount, conflictingSignedEvidence };
}
