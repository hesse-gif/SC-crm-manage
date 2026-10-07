// W122 — pure decision core for repairing `unclassified:` identity sentinels in a
// `scp_video_review_state` document's `subject` bag. Deterministic, no I/O.
//
// WHY THIS EXISTS
// ---------------
// `scpIntegrationEventV2.canonicalVideoGraph` stamps FIVE subject ids
// (portalCreatorId / fluCreatorId / partnerId / enrollmentId / channelId) with the
// `unclassified:<kind>:<hash>` sentinel whenever `resolveCreatorTupleByApplication`
// finds anything other than EXACTLY ONE `scp_portal_creator_bindings` row for the
// event's applicationId (scpIntegrationEventV2.ts:812-818). A rejection never reaches
// Partner activation, so a sentinel subject is harmless there; an APPROVAL does, and
// `planPartnerActivation` fail-closes on it with
// `partner_activation_identity_incomplete` (partnerActivationCore.ts:145-163, :300-301).
//
// HARD DESIGN RULE: DO NOT BYPASS THE GUARD — SATISFY IT WITH EVIDENCE.
// A Partner activation record is a settlement record. Identity is NEVER invented here:
//   * The ONLY authority is the immutable `scp_portal_creator_bindings` registry — the
//     same registry the ingress itself treats as the sole source of truth
//     ("매핑: scp_portal_creator_bindings … 만 정본", scpPortalSubmissionIngress.ts:22).
//     Bindings are minted only by audited authority engines (scpPortalCreatorBinding.ts
//     over the approved-application/creator/lead chain, or scpPortalApplyBindingAuthority.ts
//     under an explicit, byte-scoped user authorization).
//   * Handles, emails, channel URLs, portal `loginRequest.creatorId`, legacy roster codes
//     and fuzzy matching are NOT authority and are never read by this core.
//   * A field with no authoritative source is not repaired, and its absence skips the
//     WHOLE document (never a partial identity).
//
// WHAT IS NEVER TOUCHED: `state`, `revision`, `contentFingerprint`, the review ledger,
// decision history, and AI evidence. This core only ever proposes `subject.<field>`
// leaf writes. In particular it NEVER copies the head's revision/fingerprint into an
// incomplete subject — that would defeat the P3#8 quarantine documented at
// videoReviewTransitionStore.ts:88-97.
//
// AUTHORITY QUERY, AND ONE DELIBERATE ASYMMETRY WITH THE INGRESS: the ingress helper
// `resolveCreatorTupleByApplication` (scpIntegrationEventV2.ts:802-840) matches on
// `sourceApplicationId` ALONE, while this repair additionally requires `status == "active"`
// (matching the stricter fail-closed resolver at
// scpCreatorPipelineV3ManagementAckWiring.ts:66-101). In principle that lets an
// applicationId with one active and one non-active row read as "ambiguous" to the ingress
// but "uniquely authoritative" here. That state is unreachable: `scp_portal_creator_bindings`
// is a create-only, immutable registry — every writer stamps the literal `status: "active"`
// (scpPortalCreatorBinding.ts:46/97, scpPortalApplyBindingAuthority.ts,
// scpCreatorPipelineV3ManagementAckWiring.ts:202), no code path anywhere issues an update or
// delete against the collection, and a replay must byte-match the existing row
// (`assertExactBinding`). Production agrees: 22/22 rows are `active`. If a deactivation path
// is ever introduced, this repair must be revisited before that path ships.
//
// PRIVACY (SEC-P0-009): only opaque ids cross this boundary. No email, handle, channel
// title, video title or prompt/response text is read, returned, or logged.

import {
  planPartnerActivation,
  type PartnerActivationDocument,
  type VideoReviewSubject,
} from "./partnerActivationCore";
import { asRecord, asString } from "./shared";
import { reviewDocId, subjectFromReviewStateData } from "./videoReviewSubjectShape";

export { reviewDocId, subjectFromReviewStateData };

export const VIDEO_REVIEW_SUBJECT_REPAIR_SCHEMA_VERSION =
  "flu.video-review-subject-repair.v1" as const;

export const VIDEO_REVIEW_SUBJECT_REPAIR_AUTHORITY =
  "scp_portal_creator_bindings" as const;

/**
 * The four ids that BOTH the activation guard (partnerActivationCore.ts:130-139
 * REQUIRED_IDENTITY_FIELDS) and the deployed authority resolver
 * (scpCreatorPipelineV3ManagementAckWiring.ts:66-101) treat as mandatory. These are
 * all-or-nothing: if the authority cannot supply every one of them, the document is
 * skipped rather than partially repaired.
 */
export const REQUIRED_REPAIR_IDENTITY_FIELDS = [
  "portalCreatorId",
  "fluCreatorId",
  "partnerId",
  "enrollmentId",
] as const;

/**
 * `channelId` is NOT in REQUIRED_IDENTITY_FIELDS and the authority resolver treats it as
 * optional (conditional spread, excluded from its completeness check). Treating it as
 * mandatory here would make this repair reject bindings that the deployed resolver
 * considers complete. So it is repaired only when the authority actually carries it, and
 * only when the stored subject actually has the key — a document that simply omits
 * `channelId` is not carrying a sentinel and must not acquire repair lineage for it.
 */
export const OPTIONAL_REPAIR_IDENTITY_FIELDS = ["channelId"] as const;

/**
 * The five subject ids that `canonicalVideoGraph` sentinel-izes together. `campaignId`
 * is deliberately NOT in this list: a bare `"unclassified"` campaign is an ACCEPTED
 * activation identity (partnerActivationCore.ts:151), so rewriting it would change
 * activation lineage without being required by any guard.
 */
export const REPAIRABLE_SUBJECT_IDENTITY_FIELDS = [
  ...REQUIRED_REPAIR_IDENTITY_FIELDS,
  ...OPTIONAL_REPAIR_IDENTITY_FIELDS,
] as const;

export type RepairableSubjectIdentityField =
  (typeof REPAIRABLE_SUBJECT_IDENTITY_FIELDS)[number];

/** Field names that must all be present and resolved for activation to be possible. */
export type VideoReviewSubjectRepairSkipReason =
  | "review_state_missing"
  | "subject_absent"
  | "subject_application_id_missing"
  | "subject_head_divergent"
  | "head_withdrawn_revision"
  | "head_cas_mismatch"
  | "authority_binding_absent"
  | "authority_binding_ambiguous"
  | "authority_binding_inactive"
  | "authority_binding_application_mismatch"
  | "authority_binding_program_mismatch"
  | "authority_field_unresolved"
  | "authority_conflicts_resolved_subject"
  | "activation_already_revoked"
  | "activation_identity_conflict"
  | "guard_still_incomplete";

export type VideoReviewSubjectRepairAction =
  | "repair"
  | "noop"
  | "skip"
  /**
   * The identity is derivable, but the caller has not supplied the `scp_partner_activations`
   * document for the candidate enrollment yet. The guard branches on that document
   * (partnerActivationCore.ts:302-320), so a plan can NEVER reach `repair` without it — the
   * caller must read `scp_partner_activations/partnerActivationId(candidateEnrollmentId)`
   * and re-plan. This is a structural requirement, not an error.
   */
  | "needs_activation_lookup";

/**
 * What the REAL guard returns for the post-repair subject against the REAL activation
 * document. `activate` unblocks a first activation; `already_active` is the legitimate
 * idempotent outcome when another submission for the same enrollment already activated —
 * the approval will succeed but create no new activation and no KPI increment, which the
 * operator must see rather than infer.
 */
export type VideoReviewSubjectActivationOutcome =
  | "activate"
  | "already_active"
  | "already_revoked"
  | "identity_conflict"
  | "identity_incomplete"
  | "not_applicable";

export interface PortalCreatorBindingAuthority {
  /** `scp_portal_creator_bindings` document id — the provenance anchor. */
  docId: string;
  sourceApplicationId: string;
  programId: string;
  status: string;
  portalCreatorId: string;
  fluCreatorId: string;
  partnerId: string;
  enrollmentId: string;
  channelId: string;
}

export interface VideoReviewSubjectRepairFieldEvidence {
  field: RepairableSubjectIdentityField;
  /** The id being written. Ids only — never a handle, email, or display name. */
  value: string;
  /** `collection/docId#field` — where this exact value came from. */
  sourceRef: string;
}

export interface VideoReviewSubjectRepairEvidence {
  schemaVersion: typeof VIDEO_REVIEW_SUBJECT_REPAIR_SCHEMA_VERSION;
  authority: typeof VIDEO_REVIEW_SUBJECT_REPAIR_AUTHORITY;
  authorityDocId: string;
  applicationId: string;
  /** Head values the repair was planned against (CAS anchor, never rewritten). */
  observedRevision: number;
  observedContentFingerprint: string;
  fields: VideoReviewSubjectRepairFieldEvidence[];
}

export interface VideoReviewSubjectRepairHead {
  state: string;
  revision: number;
  contentFingerprint: string;
  canonicalProgramId: string;
  policyConfigHash: string;
  withdrawn: boolean;
}

export interface VideoReviewSubjectRepairPlanInputActivation {
  activation: PartnerActivationDocument | null;
}

export interface PlanVideoReviewSubjectRepairInput {
  submissionId: string;
  /** `null` when the review-state document does not exist. */
  head: VideoReviewSubjectRepairHead | null;
  /** Raw stored `subject` bag, exactly as read from Firestore. */
  subject: unknown;
  /**
   * Every `scp_portal_creator_bindings` row whose `sourceApplicationId` equals the
   * subject's applicationId. Callers MUST fetch with a limit of at least 2 so that
   * ambiguity is observable rather than silently truncated to one.
   */
  bindings: readonly PortalCreatorBindingAuthority[];
  /**
   * Optional caller-supplied CAS anchor. Required by the apply lane; a dry run may
   * omit it and read the anchor back out of the returned plan.
   */
  expected?: { revision: number; contentFingerprint: string } | null;
  /**
   * The `scp_partner_activations` document for the CANDIDATE enrollment id (null when the
   * document does not exist). Omit it entirely on the first pass: the plan will come back
   * as `needs_activation_lookup` with `candidateEnrollmentId` set, and the caller re-plans
   * with the real document. Never synthesize this — passing `{ activation: null }` when the
   * document was not actually read reintroduces exactly the blind spot this field closes.
   */
  activationLookup?: VideoReviewSubjectRepairPlanInputActivation;
}

export interface VideoReviewSubjectRepairPlan {
  action: VideoReviewSubjectRepairAction;
  submissionId: string;
  applicationId: string;
  skipReason: VideoReviewSubjectRepairSkipReason | null;
  /** Subject fields that are currently sentinels and would change. */
  repairedFields: RepairableSubjectIdentityField[];
  /** Dotted Firestore field paths -> new value. Only `subject.*` leaves, ever. */
  updates: Record<string, string>;
  evidence: VideoReviewSubjectRepairEvidence | null;
  /**
   * The enrollment id the post-repair subject would carry. Set as soon as it is derivable,
   * including on `needs_activation_lookup`, so the caller knows which activation to read.
   */
  candidateEnrollmentId: string | null;
  /**
   * What the real guard returned for the post-repair subject against the REAL activation
   * document. `null` until the activation lookup has been supplied.
   */
  activationOutcome: VideoReviewSubjectActivationOutcome | null;
  /**
   * True only when `planPartnerActivation` — the real guard, imported unmodified, and given
   * the REAL existing activation document — accepted the post-repair identity, i.e. returned
   * `activate` or `already_active`. It is NOT a promise that a new activation will be
   * created; read `activationOutcome` for that. A repair is never proposed without it.
   */
  guardVerified: boolean;
  /** CAS anchor observed on the head; feed this back into the apply lane. */
  observedRevision: number | null;
  observedContentFingerprint: string | null;
}

const SENTINEL_PREFIX = "unclassified:";

/**
 * Mirrors `isResolvedIdentityString` (partnerActivationCore.ts:145-163) for the identity
 * fields this core repairs (the REQUIRED four plus the OPTIONAL channelId).
 * `campaignId`'s bare-`"unclassified"` exemption is intentionally absent because
 * `campaignId` is not repairable here.
 *
 * `tests/w122-video-review-subject-repair.test.mjs` pins this predicate against the real
 * guard so the mirror can never drift silently.
 */
const UNRESOLVED_IDENTITY_LITERALS: readonly string[] = [
  "unclassified",
  "portal-unresolved",
  "CR_UNRESOLVED",
  "partner-unresolved",
  "enrollment-unresolved",
  "channel-unresolved",
];

export function isUnresolvedIdentityValue(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const normalized = value.trim();
  if (!normalized) return true;
  return (
    normalized.startsWith(SENTINEL_PREFIX) ||
    UNRESOLVED_IDENTITY_LITERALS.includes(normalized)
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Backwards-compatible alias for the canonical normalizer. There is no local copy: this is
 * re-exported from ./videoReviewSubjectShape, which is the SAME function
 * videoReviewTransitionStore uses to build the subject it hands to the activation guard.
 */
export const subjectFromStoredBag = subjectFromReviewStateData;

/**
 * The identity fields this document is actually carrying a sentinel for. An OPTIONAL field
 * whose key is absent is NOT a sentinel: the document simply never had it, so it must not be
 * counted as broken, repaired, or given repair lineage. (The normalizer maps both "absent"
 * and "empty" to undefined, which is why presence is read from the RAW bag.)
 */
export function sentinelIdentityFields(
  rawSubject: unknown,
): RepairableSubjectIdentityField[] {
  const bag = asRecord(rawSubject);
  const subject = subjectFromReviewStateData(rawSubject);
  return REPAIRABLE_SUBJECT_IDENTITY_FIELDS.filter((field) => {
    if (
      (OPTIONAL_REPAIR_IDENTITY_FIELDS as readonly string[]).includes(field) &&
      !Object.prototype.hasOwnProperty.call(bag, field)
    ) {
      return false;
    }
    return isUnresolvedIdentityValue(subject[field]);
  });
}

function skip(
  submissionId: string,
  applicationId: string,
  reason: VideoReviewSubjectRepairSkipReason,
  head: VideoReviewSubjectRepairHead | null,
): VideoReviewSubjectRepairPlan {
  return {
    action: "skip",
    submissionId,
    applicationId,
    skipReason: reason,
    repairedFields: [],
    updates: {},
    evidence: null,
    candidateEnrollmentId: null,
    activationOutcome: null,
    guardVerified: false,
    observedRevision: head ? head.revision : null,
    observedContentFingerprint: head ? head.contentFingerprint : null,
  };
}

/**
 * Runs the REAL activation guard against a candidate subject AND the REAL existing
 * activation document. Imported from partnerActivationCore unmodified — the repair proves
 * the guard passes rather than relaxing it.
 *
 * Passing the real `existingActivation` is load-bearing, not defensive: the guard branches
 * on it (partnerActivationCore.ts:302-320) into identity_conflict / already_active /
 * already_revoked. Probing with a hardcoded `null` would prove only the identity-completeness
 * branch while the caller reports it as "approval will activate" — a revoked or conflicting
 * enrollment would then be repaired, the evidence block would vouch for it, and the approval
 * would still pass through with no activation, no KPI, and no operator signal.
 *
 * The decisionRef/actor values are probe-only and never persisted.
 */
export function activationGuardOutcome(
  subject: VideoReviewSubject,
  head: VideoReviewSubjectRepairHead,
  existingActivation: PartnerActivationDocument | null,
): VideoReviewSubjectActivationOutcome {
  const plan = planPartnerActivation({
    review: {
      previousState: "queued",
      nextState: "approved",
      revision: head.revision,
      contentFingerprint: head.contentFingerprint,
      canonicalProgramId: head.canonicalProgramId,
      policyConfigHash: head.policyConfigHash,
      withdrawn: head.withdrawn,
      subject,
    },
    command: {
      expectedRevision: head.revision,
      expectedContentFingerprint: head.contentFingerprint,
      expectedCanonicalProgramId: head.canonicalProgramId,
      expectedPolicyConfigHash: head.policyConfigHash,
      // Inert probe values: planPartnerActivation reads neither actorType nor actorId
      // (only buildPartnerActivationDocument does, and that is never called here). They
      // exist to satisfy the input type and are never persisted anywhere.
      decisionRef: "video-review-subject-repair:guard-probe",
      actorType: "ai",
      actorId: "video-review-subject-repair",
    },
    existingActivation,
  });
  if (plan.action === "activate") return "activate";
  if (plan.action === "already_active") return "already_active";
  if (plan.action === "already_revoked") return "already_revoked";
  if (plan.action === "reject") {
    return plan.errorCode === "partner_activation_identity_conflict"
      ? "identity_conflict"
      : "identity_incomplete";
  }
  return "not_applicable";
}

/** The guard accepted the identity: a first activation, or the idempotent replay of one. */
export function activationOutcomeAccepts(
  outcome: VideoReviewSubjectActivationOutcome,
): boolean {
  return outcome === "activate" || outcome === "already_active";
}

/**
 * Judgement order (fail-closed at every step):
 *  1. head/subject present, subject carries its own applicationId.
 *  2. subject is self-consistent with the head it belongs to (revision + fingerprint +
 *     programId). A divergent subject is migration quarantine, never repaired.
 *  3. head not withdrawn; caller CAS anchor (if supplied) matches the head.
 *  4. no repairable sentinel left (REQUIRED four + OPTIONAL channelId when the key exists)
 *     => `noop` (idempotent re-run).
 *  5. EXACTLY ONE active binding for this applicationId, at this program.
 *  6. every REQUIRED sentinel field has a resolved value on that binding (all-or-nothing);
 *     OPTIONAL fields are repaired only when the authority carries them; a resolved subject
 *     field that disagrees with the binding is a conflict, never overwritten.
 *  7. the caller must supply the REAL `scp_partner_activations` document (pass 1 returns
 *     `needs_activation_lookup`), and `planPartnerActivation` must then return `activate`
 *     or `already_active` for the post-repair subject. `already_active` additionally has to
 *     agree on `integrationPartnerId`, which the guard's own conflict test does not compare.
 */
export function planVideoReviewSubjectRepair(
  input: PlanVideoReviewSubjectRepairInput,
): VideoReviewSubjectRepairPlan {
  const submissionId = text(input.submissionId);
  const head = input.head;
  if (!head) return skip(submissionId, "", "review_state_missing", null);

  const hasSubjectBag =
    Boolean(input.subject) &&
    typeof input.subject === "object" &&
    !Array.isArray(input.subject);
  if (!hasSubjectBag) return skip(submissionId, "", "subject_absent", head);

  const subject = subjectFromStoredBag(input.subject);
  const applicationId = text(subject.applicationId);
  if (!applicationId) {
    return skip(submissionId, "", "subject_application_id_missing", head);
  }

  // P3#8 / P3#10d quarantine: a subject that does not agree with its own head is
  // incomplete evidence. Repairing identity on top of it would launder that defect.
  //
  // `storedSubmissionId` is checked for emptiness BEFORE reviewDocId is called: reviewDocId
  // THROWS when its sanitized result is empty (videoReviewSubjectShape.ts), and a subject
  // that omits `videoSubmissionId` (or carries only whitespace) is precisely the
  // legacy/incomplete shape this quarantine exists for — the same migration class that can
  // omit `videoRevision`/`contentFingerprint`. Letting it throw would convert a designed
  // fail-closed skip into an unhandled exception that aborts a whole scan page.
  const storedSubmissionId = text(subject.videoSubmissionId);
  const subjectAgreesWithHead =
    Number.isInteger(subject.videoRevision) &&
    subject.videoRevision === head.revision &&
    subject.contentFingerprint === head.contentFingerprint &&
    subject.programId === head.canonicalProgramId &&
    storedSubmissionId !== "" &&
    // Compared through reviewDocId on BOTH sides: `submissionId` here is a review-state
    // DOCUMENT id, and the document id is the sanitized form of the submission id. A raw
    // `subject.videoSubmissionId` containing `.` or `:` (both legal, both sanitized to `_`)
    // would otherwise read as "divergent" and a repairable document would be falsely
    // reported as migration quarantine.
    reviewDocId(storedSubmissionId) === reviewDocId(submissionId);
  if (!subjectAgreesWithHead) {
    return skip(submissionId, applicationId, "subject_head_divergent", head);
  }

  if (head.withdrawn === true) {
    return skip(submissionId, applicationId, "head_withdrawn_revision", head);
  }

  if (input.expected) {
    const casAgrees =
      Number.isInteger(input.expected.revision) &&
      input.expected.revision === head.revision &&
      input.expected.contentFingerprint === head.contentFingerprint;
    if (!casAgrees) {
      return skip(submissionId, applicationId, "head_cas_mismatch", head);
    }
  }

  const sentinelFields = sentinelIdentityFields(input.subject);
  if (sentinelFields.length === 0) {
    const settled = text(subject.enrollmentId);
    if (!input.activationLookup) {
      return {
        action: "needs_activation_lookup",
        submissionId,
        applicationId,
        skipReason: null,
        repairedFields: [],
        updates: {},
        evidence: null,
        candidateEnrollmentId: settled || null,
        activationOutcome: null,
        guardVerified: false,
        observedRevision: head.revision,
        observedContentFingerprint: head.contentFingerprint,
      };
    }
    const outcome = activationGuardOutcome(subject, head, input.activationLookup.activation);
    return {
      action: "noop",
      submissionId,
      applicationId,
      skipReason: null,
      repairedFields: [],
      updates: {},
      evidence: null,
      candidateEnrollmentId: settled || null,
      activationOutcome: outcome,
      guardVerified: activationOutcomeAccepts(outcome),
      observedRevision: head.revision,
      observedContentFingerprint: head.contentFingerprint,
    };
  }

  const scoped = input.bindings.filter(
    (binding) => text(binding.sourceApplicationId) === applicationId,
  );
  if (scoped.length !== input.bindings.length) {
    return skip(submissionId, applicationId, "authority_binding_application_mismatch", head);
  }
  if (scoped.length === 0) {
    return skip(submissionId, applicationId, "authority_binding_absent", head);
  }
  if (scoped.length > 1) {
    return skip(submissionId, applicationId, "authority_binding_ambiguous", head);
  }

  const binding = scoped[0]!;
  // Defense in depth, CORE-ONLY: the deployed I/O lane already constrains the query with
  // `status == "active"`, so this branch is unreachable from `videoReviewSubjectRepair.ts`
  // (the emulator test seeds a revoked binding and correctly observes
  // `authority_binding_absent`). It exists so a caller that hands this core UNFILTERED
  // registry rows still fails closed instead of trusting an inactive binding.
  if (text(binding.status) !== "active") {
    return skip(submissionId, applicationId, "authority_binding_inactive", head);
  }
  if (text(binding.programId) !== head.canonicalProgramId) {
    return skip(submissionId, applicationId, "authority_binding_program_mismatch", head);
  }

  const evidenceFields: VideoReviewSubjectRepairFieldEvidence[] = [];
  const updates: Record<string, string> = {};
  const repaired: VideoReviewSubject = { ...subject };
  const storedBag = asRecord(input.subject);

  const take = (field: RepairableSubjectIdentityField, authoritative: string): void => {
    updates[`subject.${field}`] = authoritative;
    repaired[field] = authoritative;
    evidenceFields.push({
      field,
      value: authoritative,
      sourceRef: `${VIDEO_REVIEW_SUBJECT_REPAIR_AUTHORITY}/${binding.docId}#${field}`,
    });
  };

  for (const field of REQUIRED_REPAIR_IDENTITY_FIELDS) {
    const authoritative = text(binding[field]);
    const current = subject[field];
    if (!isUnresolvedIdentityValue(current)) {
      // Already real. Never overwritten — but it must not contradict the authority.
      if (authoritative && text(current) !== authoritative) {
        return skip(submissionId, applicationId, "authority_conflicts_resolved_subject", head);
      }
      continue;
    }
    if (!authoritative || isUnresolvedIdentityValue(authoritative)) {
      // No provenance for a REQUIRED field => the WHOLE document is skipped. A partially
      // repaired identity is never written.
      return skip(submissionId, applicationId, "authority_field_unresolved", head);
    }
    take(field, authoritative);
  }

  for (const field of OPTIONAL_REPAIR_IDENTITY_FIELDS) {
    // Key absent entirely => the document is not carrying a sentinel for this field, so it
    // must not acquire repair lineage for it. (The normalizer maps both "absent" and
    // "empty" to undefined, which is why presence is checked on the RAW bag.)
    if (!Object.prototype.hasOwnProperty.call(storedBag, field)) continue;
    const current = subject[field];
    const authoritative = text(binding[field]);
    if (!isUnresolvedIdentityValue(current)) {
      if (authoritative && text(current) !== authoritative) {
        return skip(submissionId, applicationId, "authority_conflicts_resolved_subject", head);
      }
      continue;
    }
    // Optional by contract: an authority that does not carry it is still complete, and the
    // sentinel simply stays. Never a reason to reject the whole document.
    if (!authoritative || isUnresolvedIdentityValue(authoritative)) continue;
    take(field, authoritative);
  }

  if (evidenceFields.length === 0) {
    // Every sentinel that remains is optional and unsupported by the authority — nothing to
    // write, and no claim to make.
    return skip(submissionId, applicationId, "authority_field_unresolved", head);
  }

  const candidateEnrollmentId = text(repaired.enrollmentId) || null;
  if (!input.activationLookup) {
    return {
      action: "needs_activation_lookup",
      submissionId,
      applicationId,
      skipReason: null,
      repairedFields: [],
      updates: {},
      evidence: null,
      candidateEnrollmentId,
      activationOutcome: null,
      guardVerified: false,
      observedRevision: head.revision,
      observedContentFingerprint: head.contentFingerprint,
    };
  }

  const outcome = activationGuardOutcome(repaired, head, input.activationLookup.activation);
  if (outcome === "already_revoked") {
    // The enrollment was deliberately revoked. Writing the identity here would leave a
    // vouched-for subject whose approval silently produces no activation and no KPI.
    return skip(submissionId, applicationId, "activation_already_revoked", head);
  }
  if (outcome === "identity_conflict") {
    // Another creator already owns this enrollment's activation. Never rewrite a subject
    // into someone else's settlement lineage.
    return skip(submissionId, applicationId, "activation_identity_conflict", head);
  }
  if (!activationOutcomeAccepts(outcome)) {
    return skip(submissionId, applicationId, "guard_still_incomplete", head);
  }
  // `already_active` means "an activation for this enrollment already exists and does not
  // CONFLICT". But the guard's conflict test (partnerActivationCore.ts:215-224) compares only
  // enrollmentId / applicationId / programId / campaignId / portalCreatorId / fluCreatorId —
  // it never looks at `integrationPartnerId`. partnerId IS one of the four ids this repair
  // writes, so accepting `already_active` on the guard's word alone would let the repair
  // stamp a partnerId that permanently disagrees with the settlement record the activation
  // already holds. The repair must prove what it claims, so it checks that field itself.
  if (outcome === "already_active") {
    const settledPartnerId = text(input.activationLookup.activation?.identity.integrationPartnerId);
    if (settledPartnerId !== text(repaired.partnerId)) {
      return skip(submissionId, applicationId, "activation_identity_conflict", head);
    }
  }

  return {
    action: "repair",
    submissionId,
    applicationId,
    skipReason: null,
    repairedFields: evidenceFields.map((item) => item.field),
    updates,
    evidence: {
      schemaVersion: VIDEO_REVIEW_SUBJECT_REPAIR_SCHEMA_VERSION,
      authority: VIDEO_REVIEW_SUBJECT_REPAIR_AUTHORITY,
      authorityDocId: binding.docId,
      applicationId,
      observedRevision: head.revision,
      observedContentFingerprint: head.contentFingerprint,
      fields: evidenceFields,
    },
    candidateEnrollmentId,
    activationOutcome: outcome,
    guardVerified: true,
    observedRevision: head.revision,
    observedContentFingerprint: head.contentFingerprint,
  };
}

/** Compact, PII-free per-document row for the dry-run report. */
export interface VideoReviewSubjectRepairReportRow {
  submissionId: string;
  applicationId: string;
  action: VideoReviewSubjectRepairAction;
  skipReason: VideoReviewSubjectRepairSkipReason | null;
  repairable: boolean;
  repairedFields: RepairableSubjectIdentityField[];
  sentinelFields: RepairableSubjectIdentityField[];
  evidence: VideoReviewSubjectRepairFieldEvidence[];
  candidateEnrollmentId: string | null;
  /**
   * `activate` = the approval will create a first activation. `already_active` = the
   * approval will succeed but create NO new activation and NO KPI increment (another
   * submission for this enrollment already activated). Never inferred from `repairable`.
   */
  activationOutcome: VideoReviewSubjectActivationOutcome | null;
  guardVerified: boolean;
  expectedRevision: number | null;
  expectedContentFingerprint: string | null;
}

export function subjectRepairReportRow(
  plan: VideoReviewSubjectRepairPlan,
  storedSubject: unknown,
): VideoReviewSubjectRepairReportRow {
  return {
    submissionId: plan.submissionId,
    applicationId: plan.applicationId,
    action: plan.action,
    skipReason: plan.skipReason,
    repairable: plan.action === "repair",
    repairedFields: plan.repairedFields,
    sentinelFields: sentinelIdentityFields(storedSubject),
    evidence: plan.evidence ? plan.evidence.fields : [],
    candidateEnrollmentId: plan.candidateEnrollmentId,
    activationOutcome: plan.activationOutcome,
    guardVerified: plan.guardVerified,
    expectedRevision: plan.observedRevision,
    expectedContentFingerprint: plan.observedContentFingerprint,
  };
}


// ---- callable input contract (pure; kept here so the node lane can pin it without
// pulling in firebase-admin) --------------------------------------------------------

export const VIDEO_REVIEW_SUBJECT_REPAIR_CONFIRMATION =
  "repair-video-review-subject-identity-v1" as const;

export const VIDEO_REVIEW_SUBJECT_REPAIR_DEFAULT_PAGE_SIZE = 25;
export const VIDEO_REVIEW_SUBJECT_REPAIR_MAX_PAGE_SIZE = 50;

const SUBMISSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;

export function subjectRepairError(code: string, errorCode: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code, errorCode });
}

export function boundedSubjectRepairLimit(value: unknown): number {
  const parsed = Math.trunc(Number(value ?? VIDEO_REVIEW_SUBJECT_REPAIR_DEFAULT_PAGE_SIZE));
  if (!Number.isFinite(parsed) || parsed <= 0) return VIDEO_REVIEW_SUBJECT_REPAIR_DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(VIDEO_REVIEW_SUBJECT_REPAIR_MAX_PAGE_SIZE, parsed));
}

export interface VideoReviewSubjectRepairTarget {
  submissionId: string;
  expectedRevision: number;
  expectedContentFingerprint: string;
}

export interface VideoReviewSubjectRepairInput {
  dryRun: boolean;
  limit: number;
  cursor: string;
  submissionIds: string[];
  targets: VideoReviewSubjectRepairTarget[];
}

function repairSubmissionId(value: unknown, field: string): string {
  const id = asString(value);
  if (!SUBMISSION_ID_RE.test(id)) {
    throw subjectRepairError(
      "invalid-argument",
      "video_review_subject_repair_submission_id_invalid",
      `${field} must be a canonical submission id`,
    );
  }
  return id;
}

function repairCursorId(value: unknown): string {
  const id = asString(value);
  if (!id) return "";
  if (id.length > 400 || id.includes("/")) {
    throw subjectRepairError(
      "invalid-argument",
      "video_review_subject_repair_cursor_invalid",
      "cursor is invalid",
    );
  }
  return id;
}

/**
 * `dryRun` defaults TRUE. Applying additionally needs `actual:true`, the confirmation
 * literal, and an explicit `targets` list where every entry carries a head CAS anchor —
 * a cursor scan can never become a write.
 */
export function parseVideoReviewSubjectRepairInput(value: unknown): VideoReviewSubjectRepairInput {
  const data = asRecord(value);
  const dryRun = data.dryRun !== false;
  const limit = boundedSubjectRepairLimit(data.limit);

  if (!dryRun) {
    if (data.actual !== true) {
      throw subjectRepairError(
        "invalid-argument",
        "video_review_subject_repair_actual_required",
        "actual:true is required when dryRun is false",
      );
    }
    if (asString(data.confirm) !== VIDEO_REVIEW_SUBJECT_REPAIR_CONFIRMATION) {
      throw subjectRepairError(
        "failed-precondition",
        "video_review_subject_repair_confirmation_required",
        "apply confirmation is required",
      );
    }
  }

  const rawTargets = Array.isArray(data.targets) ? data.targets : [];
  if (rawTargets.length > limit) {
    throw subjectRepairError(
      "invalid-argument",
      "video_review_subject_repair_targets_over_limit",
      "targets exceeds the requested limit",
    );
  }
  const targets: VideoReviewSubjectRepairTarget[] = rawTargets.map((entry) => {
    const row = asRecord(entry);
    const revision = Number(row.expectedRevision);
    const fingerprint = asString(row.expectedContentFingerprint);
    if (!Number.isSafeInteger(revision) || revision < 1 || !fingerprint) {
      throw subjectRepairError(
        "invalid-argument",
        "video_review_subject_repair_target_cas_required",
        "each target requires expectedRevision and expectedContentFingerprint",
      );
    }
    return {
      submissionId: repairSubmissionId(row.submissionId, "targets[].submissionId"),
      expectedRevision: revision,
      expectedContentFingerprint: fingerprint,
    };
  });

  if (!dryRun && targets.length === 0) {
    throw subjectRepairError(
      "invalid-argument",
      "video_review_subject_repair_targets_required",
      "targets with head CAS anchors are required when dryRun is false",
    );
  }

  const rawIds = Array.isArray(data.submissionIds) ? data.submissionIds : [];
  if (rawIds.length > limit) {
    throw subjectRepairError(
      "invalid-argument",
      "video_review_subject_repair_submission_ids_over_limit",
      "submissionIds exceeds the requested limit",
    );
  }
  const submissionIds = rawIds.map((entry) => repairSubmissionId(entry, "submissionIds[]"));

  return { dryRun, limit, cursor: repairCursorId(data.cursor), submissionIds, targets };
}

/** Reads the CAS-relevant head fields out of a raw `scp_video_review_state` document. */
export function headFromReviewStateData(raw: unknown): VideoReviewSubjectRepairHead | null {
  const data = asRecord(raw);
  const revision = Number(data.revision);
  const contentFingerprint = asString(data.contentFingerprint);
  const canonicalProgramId = asString(data.canonicalProgramId);
  const policyConfigHash = asString(data.policyConfigHash);
  if (!Number.isSafeInteger(revision) || !contentFingerprint || !canonicalProgramId) return null;
  return {
    state: asString(data.state),
    revision,
    contentFingerprint,
    canonicalProgramId,
    policyConfigHash,
    withdrawn: data.withdrawn === true,
  };
}
