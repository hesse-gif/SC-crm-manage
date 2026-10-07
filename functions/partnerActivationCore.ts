// Pure decision core for Partner activation from the current approved video revision
// (.specs/spec_partner_activation_from_video_approval/spec.md §4, §6.1, §9). Deterministic, no I/O.
//
// Hard rule: a creator becomes an active Partner for an enrollment EXACTLY ONCE, the moment the
// CURRENT, non-withdrawn video revision for that enrollment is first approved by the review engine.
// Apply / qualification / onboarding / UID / Gem / submission-existence / Sheet3 row / callback /
// subject.partnerId (an integration scope id, never activation evidence) must NEVER activate a Partner.
// Replay of the same decisionRef, concurrent double-fire, and a pre-existing active/revoked doc must
// never create a second activation, event, or KPI increment.

import { createHash } from "crypto";
import type { ActorType, VideoReviewState } from "./videoReviewTransitionCore";

export const PARTNER_ACTIVATION_SCHEMA_VERSION = "flu.partner-activation.v1" as const;
export const PARTNER_ACTIVATION_EVENT_SCHEMA_VERSION = "flu.partner-activation-event.v1" as const;
export const PARTNER_ACTIVATION_EVIDENCE_SCHEMA_VERSION = "flu.partner-activation-evidence.v1" as const;

export type PartnerActivationStatus = "active" | "revoked";

export type PartnerActivationReason = "video_current_revision_approved";

export type PartnerRevocationReasonCode =
  | "policy_violation"
  | "fraud_confirmed"
  | "program_removed"
  | "creator_requested"
  | "operator_correction";

// The ONLY cross-system identity inputs Partner activation may use (spec §3). Never inferred from
// submission-token, email, handle, Sheet3 row, or fuzzy identity matching.
export interface VideoReviewSubject {
  enrollmentId: string;
  applicationId: string;
  programId: string;
  campaignId: string;
  outreachId?: string;
  portalCreatorId: string;
  fluCreatorId: string;
  partnerId: string; // v3 subject.partnerId — an integration SCOPE id, never activation evidence.
  videoSubmissionId: string;
  videoRevision: number;
  contentFingerprint: string;
  policyVersion: string;
  settlementCreatorCode?: string;
  channelId?: string;
  /**
   * 2026-09-05 다타이틀: 이 제출이 어느 프로그램 타이틀(functions/programTitles.json)의
   * 콘텐츠인지. **활성화 근거가 아니다** — 검수 루브릭/배지가 읽는 표시 사실이라 필수 신원
   * 필드가 아니다. 없으면 프로그램 기본 타이틀로 읽힌다(오늘의 원장 전체가 그렇다).
   */
  gameId?: string;
  /** 선언된 gameId 가 레지스트리에 없어 기본 타이틀로 착지했음 — 사람 게이트 신호. */
  gameIdUnresolved?: boolean;
  /**
   * `gameId` 가 선언 해석이 아니라 인제스트 기본값 스탬프임(선언 누락·빈 값·미등록 선언
   * 모두). strict 게임 필터는 이 마커가 붙은 gameId 를 행의 증거로 인정하지 않는다.
   */
  gameIdDefaulted?: boolean;
}

export interface PartnerActivationIdentity {
  enrollmentId: string;
  applicationId: string;
  programId: string;
  campaignId: string;
  outreachId?: string;
  portalCreatorId: string;
  fluCreatorId: string;
  integrationPartnerId: string; // v3 subject.partnerId; scope id, NOT an activation-status signal.
  settlementCreatorCode?: string;
  channelId?: string;
}

export interface PartnerActivationEvidence {
  schemaVersion: typeof PARTNER_ACTIVATION_EVIDENCE_SCHEMA_VERSION;
  submissionId: string;
  videoRevision: number;
  contentFingerprint: string;
  reviewDecisionRef: string;
  reviewTransitionSeq: number;
  reviewTransitionVersion: "video_review_transition_v3";
  actorType: ActorType;
  actorId: string;
  approvedAtIso: string;
  // The policy under which this approval became activation evidence.  This is retained rather
  // than reconstructed from a later/current review policy so audit readers cannot silently
  // relabel a historical approval after policy configuration changes.
  policyVersion: string;
}

export interface PartnerActivationDocument {
  schemaVersion: typeof PARTNER_ACTIVATION_SCHEMA_VERSION;
  activationId: string; // deterministic: sanitize(enrollmentId)
  status: PartnerActivationStatus;
  identity: PartnerActivationIdentity;
  activationReason: PartnerActivationReason;
  evidence: PartnerActivationEvidence;
  version: number; // first active = 1, revoke = 2
  activatedAtIso: string;
  revokedAtIso?: string;
  revokedBy?: string;
  revocationReasonCode?: PartnerRevocationReasonCode;
  updatedAtIso: string;
}

export interface PartnerActivationEvent {
  schemaVersion: typeof PARTNER_ACTIVATION_EVENT_SCHEMA_VERSION;
  eventId: string; // deterministic
  enrollmentId: string;
  eventType: "activated" | "revoked";
  fromStatus: "absent" | "active";
  toStatus: "active" | "revoked";
  version: number;
  reasonCode: PartnerActivationReason | PartnerRevocationReasonCode;
  decisionRef?: string;
  actorId: string;
  atIso: string;
  // Redacted, immutable audit lineage copied from the first activation document.  These fields
  // deliberately contain IDs/revision metadata only—never email, OAuth material, or view counts.
  applicationId?: string;
  programId?: string;
  campaignId?: string;
  fluCreatorId?: string;
  submissionId?: string;
  videoRevision?: number;
  reviewTransitionSeq?: number;
  policyVersion?: string;
}

export interface PartnerActivationResult {
  status: "activated" | "already_active" | "already_revoked" | "not_applicable";
  enrollmentId: string | null;
  activationId: string | null;
  kpiApplied: boolean;
}

export type PartnerActivationErrorCode =
  | "partner_activation_identity_incomplete"
  | "partner_activation_identity_conflict"
  | "partner_activation_not_current_revision"
  | "partner_activation_withdrawn_revision";

const REQUIRED_IDENTITY_FIELDS: readonly (keyof VideoReviewSubject)[] = [
  "enrollmentId",
  "applicationId",
  "programId",
  "campaignId",
  "portalCreatorId",
  "fluCreatorId",
  "partnerId",
  "videoSubmissionId",
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isResolvedIdentityString(
  field: keyof VideoReviewSubject,
  value: unknown,
): value is string {
  if (!isNonEmptyString(value)) return false;
  const normalized = value.trim();
  if (field === "campaignId" && normalized === "unclassified") return true;
  return (
    !normalized.startsWith("unclassified:") &&
    ![
      "unclassified",
      "portal-unresolved",
      "CR_UNRESOLVED",
      "partner-unresolved",
      "enrollment-unresolved",
      "channel-unresolved",
    ].includes(normalized)
  );
}

function missingIdentityFields(subject: VideoReviewSubject): (keyof VideoReviewSubject)[] {
  return REQUIRED_IDENTITY_FIELDS.filter(
    (field) => !isResolvedIdentityString(field, subject[field] as unknown),
  );
}

// Sanitized 1:1 activation document id derived from enrollmentId (spec §5.1).
export function partnerActivationId(enrollmentId: string): string {
  const safe = String(enrollmentId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
  if (!safe) throw new Error("invalid-argument: enrollmentId is required to derive a partnerActivationId");
  return safe;
}

function shortHash(prefix: string, parts: readonly string[]): string {
  return createHash("sha256").update(`${prefix}:${parts.join(":")}`).digest("hex").slice(0, 48);
}

export function partnerActivationEventId(input: {
  enrollmentId: string;
  submissionId: string;
  videoRevision: number;
  decisionRef: string;
}): string {
  return shortHash("activate", [input.enrollmentId, input.submissionId, String(input.videoRevision), input.decisionRef]);
}

export function partnerRevocationEventId(input: {
  enrollmentId: string;
  expectedVersion: number;
  reasonCode: PartnerRevocationReasonCode;
}): string {
  return shortHash("revoke", [input.enrollmentId, String(input.expectedVersion), input.reasonCode]);
}

function identityFromSubject(subject: VideoReviewSubject): PartnerActivationIdentity {
  const identity: PartnerActivationIdentity = {
    enrollmentId: subject.enrollmentId,
    applicationId: subject.applicationId,
    programId: subject.programId,
    campaignId: subject.campaignId,
    portalCreatorId: subject.portalCreatorId,
    fluCreatorId: subject.fluCreatorId,
    integrationPartnerId: subject.partnerId,
  };
  if (isNonEmptyString(subject.outreachId)) identity.outreachId = subject.outreachId;
  if (isNonEmptyString(subject.settlementCreatorCode)) identity.settlementCreatorCode = subject.settlementCreatorCode;
  if (isNonEmptyString(subject.channelId)) identity.channelId = subject.channelId;
  return identity;
}

function identityConflicts(existing: PartnerActivationIdentity, next: PartnerActivationIdentity): boolean {
  return (
    existing.enrollmentId !== next.enrollmentId ||
    existing.applicationId !== next.applicationId ||
    existing.programId !== next.programId ||
    existing.campaignId !== next.campaignId ||
    existing.portalCreatorId !== next.portalCreatorId ||
    existing.fluCreatorId !== next.fluCreatorId
  );
}

export interface PlanPartnerActivationInput {
  review: {
    previousState: VideoReviewState;
    nextState: VideoReviewState;
    revision: number;
    contentFingerprint: string;
    canonicalProgramId: string;
    policyConfigHash: string;
    withdrawn: boolean;
    subject: VideoReviewSubject;
  };
  command: {
    expectedRevision: number;
    expectedContentFingerprint: string;
    expectedCanonicalProgramId: string;
    expectedPolicyConfigHash: string;
    decisionRef: string;
    actorType: ActorType;
    actorId: string;
  };
  existingActivation: PartnerActivationDocument | null;
}

export type PartnerActivationPlanAction = "activate" | "already_active" | "already_revoked" | "not_applicable" | "reject";

export interface PartnerActivationPlan {
  action: PartnerActivationPlanAction;
  errorCode: PartnerActivationErrorCode | null;
  activationId: string | null;
  eventId: string | null;
  identity: PartnerActivationIdentity | null;
  activationReason: PartnerActivationReason | null;
}

function notApplicable(): PartnerActivationPlan {
  return { action: "not_applicable", errorCode: null, activationId: null, eventId: null, identity: null, activationReason: null };
}

function reject(errorCode: PartnerActivationErrorCode): PartnerActivationPlan {
  return { action: "reject", errorCode, activationId: null, eventId: null, identity: null, activationReason: null };
}

// Judgement order mirrors spec §6.1 exactly:
//  1. nextState !== approved => not_applicable (never activates on human_review_required/rejected/etc).
//  2. Re-validate revision/fingerprint/program/policy across review head, subject, and command CAS
//     inputs — the current head must be the SAME revision the command approved.
//  3. withdrawn === true => reject (a withdrawn head can never approve or activate).
//  4. Required cross-system identity fields must all be present — never inferred.
//  5. No existing activation => activate.
//  6. Existing activation whose creator/program/application identity conflicts with the new subject
//     => reject (fail-closed; never silently overwrite a different identity under the same enrollment
//     id, and never treated as idempotent).
//  7. Existing activation active => already_active (idempotent, no write). revoked => already_revoked
//     (never auto-reactivates from a later approval).
export function planPartnerActivation(input: PlanPartnerActivationInput): PartnerActivationPlan {
  const { review, command, existingActivation } = input;

  if (review.nextState !== "approved") return notApplicable();

  const revisionsAgree =
    Number.isInteger(command.expectedRevision) &&
    command.expectedRevision === review.revision &&
    command.expectedRevision === review.subject.videoRevision;
  const fingerprintsAgree =
    command.expectedContentFingerprint === review.contentFingerprint &&
    command.expectedContentFingerprint === review.subject.contentFingerprint;
  const programsAgree = command.expectedCanonicalProgramId === review.canonicalProgramId;
  const policiesAgree = command.expectedPolicyConfigHash === review.policyConfigHash;
  if (!revisionsAgree || !fingerprintsAgree || !programsAgree || !policiesAgree) {
    return reject("partner_activation_not_current_revision");
  }

  if (review.withdrawn === true) return reject("partner_activation_withdrawn_revision");

  const missing = missingIdentityFields(review.subject);
  if (missing.length > 0) return reject("partner_activation_identity_incomplete");

  const identity = identityFromSubject(review.subject);

  if (existingActivation) {
    if (identityConflicts(existingActivation.identity, identity)) {
      return reject("partner_activation_identity_conflict");
    }
    if (existingActivation.status === "active") {
      return {
        action: "already_active",
        errorCode: null,
        activationId: existingActivation.activationId,
        eventId: null,
        identity: existingActivation.identity,
        activationReason: null,
      };
    }
    // existingActivation.status === "revoked": a later approval NEVER auto-reactivates.
    return {
      action: "already_revoked",
      errorCode: null,
      activationId: existingActivation.activationId,
      eventId: null,
      identity: existingActivation.identity,
      activationReason: null,
    };
  }

  const activationId = partnerActivationId(review.subject.enrollmentId);
  const eventId = partnerActivationEventId({
    enrollmentId: review.subject.enrollmentId,
    submissionId: review.subject.videoSubmissionId,
    videoRevision: review.subject.videoRevision,
    decisionRef: command.decisionRef,
  });

  return {
    action: "activate",
    errorCode: null,
    activationId,
    eventId,
    identity,
    activationReason: "video_current_revision_approved",
  };
}

export interface BuildPartnerActivationDocumentInput {
  plan: PartnerActivationPlan;
  subject: VideoReviewSubject;
  command: PlanPartnerActivationInput["command"];
  reviewTransitionSeq: number;
  nowIso: string;
}

// Builds the first-activation document + append-only event for a plan.action === "activate" plan.
// Pure — callers attach real Firestore Timestamp sentinels when persisting.
export function buildPartnerActivationDocument(input: BuildPartnerActivationDocumentInput): PartnerActivationDocument {
  if (input.plan.action !== "activate" || !input.plan.identity || !input.plan.activationId || !input.plan.activationReason) {
    throw new Error("invalid-argument: buildPartnerActivationDocument requires an activate plan");
  }
  return {
    schemaVersion: PARTNER_ACTIVATION_SCHEMA_VERSION,
    activationId: input.plan.activationId,
    status: "active",
    identity: input.plan.identity,
    activationReason: input.plan.activationReason,
    evidence: {
      schemaVersion: PARTNER_ACTIVATION_EVIDENCE_SCHEMA_VERSION,
      submissionId: input.subject.videoSubmissionId,
      videoRevision: input.subject.videoRevision,
      contentFingerprint: input.subject.contentFingerprint,
      reviewDecisionRef: input.command.decisionRef,
      reviewTransitionSeq: input.reviewTransitionSeq,
      reviewTransitionVersion: "video_review_transition_v3",
      actorType: input.command.actorType,
      actorId: input.command.actorId,
      approvedAtIso: input.nowIso,
      policyVersion: input.subject.policyVersion,
    },
    version: 1,
    activatedAtIso: input.nowIso,
    updatedAtIso: input.nowIso,
  };
}

export function buildPartnerActivationEvent(input: {
  plan: PartnerActivationPlan;
  subject: VideoReviewSubject;
  command: PlanPartnerActivationInput["command"];
  reviewTransitionSeq: number;
  nowIso: string;
}): PartnerActivationEvent {
  if (input.plan.action !== "activate" || !input.plan.eventId || !input.plan.identity) {
    throw new Error("invalid-argument: buildPartnerActivationEvent requires an activate plan");
  }
  return {
    schemaVersion: PARTNER_ACTIVATION_EVENT_SCHEMA_VERSION,
    eventId: input.plan.eventId,
    enrollmentId: input.plan.identity.enrollmentId,
    eventType: "activated",
    fromStatus: "absent",
    toStatus: "active",
    version: 1,
    reasonCode: "video_current_revision_approved",
    decisionRef: input.command.decisionRef,
    actorId: input.command.actorId,
    atIso: input.nowIso,
    applicationId: input.plan.identity.applicationId,
    programId: input.plan.identity.programId,
    campaignId: input.plan.identity.campaignId,
    fluCreatorId: input.plan.identity.fluCreatorId,
    submissionId: input.subject.videoSubmissionId,
    videoRevision: input.subject.videoRevision,
    reviewTransitionSeq: input.reviewTransitionSeq,
    policyVersion: input.subject.policyVersion,
  };
}

// ---- Explicit revocation (separate command; spec §7.2, §9). NEVER triggered automatically by
// content correction, replacement, rejection, or callback/mail delivery failure. ----

export type PartnerRevocationErrorCode =
  | "partner_activation_not_found"
  | "invalid-argument"
  | "partner_activation_stale_version"
  | "partner_activation_already_revoked"
  | "partner_activation_counter_drift";

export type PartnerRevocationPlanAction = "revoke" | "idempotent_replay" | "reject";

export interface PartnerRevocationPlan {
  action: PartnerRevocationPlanAction;
  errorCode: PartnerRevocationErrorCode | null;
  eventId: string | null;
  nextVersion: number | null;
}

export interface PlanPartnerRevocationInput {
  existingActivation: PartnerActivationDocument | null;
  command: {
    enrollmentId: string;
    expectedVersion: number;
    reasonCode: PartnerRevocationReasonCode;
    actorId: string;
    confirmation: string;
  };
}

const REVOKE_CONFIRMATION_LITERAL = "REVOKE_PARTNER";

export function planPartnerRevocation(input: PlanPartnerRevocationInput): PartnerRevocationPlan {
  const { existingActivation, command } = input;

  if (command.confirmation !== REVOKE_CONFIRMATION_LITERAL || !isNonEmptyString(command.actorId)) {
    return { action: "reject", errorCode: "invalid-argument", eventId: null, nextVersion: null };
  }

  if (!existingActivation) {
    return { action: "reject", errorCode: "partner_activation_not_found", eventId: null, nextVersion: null };
  }

  if (existingActivation.status === "revoked") {
    // Exact-same replay (same reason/actor/version) is idempotent; anything else is fail-closed.
    const sameReplay =
      existingActivation.revocationReasonCode === command.reasonCode &&
      existingActivation.revokedBy === command.actorId &&
      existingActivation.version === command.expectedVersion + 1;
    return sameReplay
      ? { action: "idempotent_replay", errorCode: null, eventId: null, nextVersion: null }
      : { action: "reject", errorCode: "partner_activation_already_revoked", eventId: null, nextVersion: null };
  }

  if (existingActivation.version !== command.expectedVersion) {
    return { action: "reject", errorCode: "partner_activation_stale_version", eventId: null, nextVersion: null };
  }

  const nextVersion = existingActivation.version + 1;
  const eventId = partnerRevocationEventId({
    enrollmentId: command.enrollmentId,
    expectedVersion: command.expectedVersion,
    reasonCode: command.reasonCode,
  });
  return { action: "revoke", errorCode: null, eventId, nextVersion };
}

export function buildPartnerRevocationEvent(input: {
  plan: PartnerRevocationPlan;
  command: PlanPartnerRevocationInput["command"];
  nowIso: string;
}): PartnerActivationEvent {
  if (input.plan.action !== "revoke" || !input.plan.eventId || input.plan.nextVersion === null) {
    throw new Error("invalid-argument: buildPartnerRevocationEvent requires a revoke plan");
  }
  return {
    schemaVersion: PARTNER_ACTIVATION_EVENT_SCHEMA_VERSION,
    eventId: input.plan.eventId,
    enrollmentId: input.command.enrollmentId,
    eventType: "revoked",
    fromStatus: "active",
    toStatus: "revoked",
    version: input.plan.nextVersion,
    reasonCode: input.command.reasonCode,
    decisionRef: undefined,
    actorId: input.command.actorId,
    atIso: input.nowIso,
  };
}

// Program/campaign active counters must never clamp to zero on drift — that drift is a reconciliation
// signal, never silently absorbed by a revoke (spec §6.3, error `partner_activation_counter_drift`).
export function nextActiveCounterAfterRevoke(currentActiveCount: number): number {
  if (!Number.isFinite(currentActiveCount) || currentActiveCount <= 0) {
    throw Object.assign(new Error("partner_activation_counter_drift: active count is not positive"), {
      code: "partner_activation_counter_drift", errorCode: "next_active_counter_after_revoke_partner_activation_counter_drift",
    });
  }
  return currentActiveCount - 1;
}

// ---- U7 P3: 활성화 이벤트 계보 판정(공용) --------------------------------------------------------
//
// 관리 상세의 감사 탭은 5개 필드를 전량 strict equality 로 비교해서, applicationId·campaignId 가 없는
// 레거시 활성화 이벤트를 **전부** 걸러냈다(실측: 같은 인물의 감사 1건 vs 0건). 파트너 상세는 반대로
// 필터가 없어 다른 계보의 이벤트까지 섞일 수 있었다.
//
// 공용 판정은 present-only equality 다: **양쪽에 값이 있는 필드만** 비교하고, 한쪽이 비어 있으면 그
// 필드로는 배제하지 않는다(없는 값을 불일치로 취급하지 않는다). 값이 하나도 겹치지 않으면 false.
const ACTIVATION_LINEAGE_FIELDS = [
  "applicationId",
  "fluCreatorId",
  "programId",
  "campaignId",
  "enrollmentId",
] as const;

function lineageText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function activationEventMatchesLineage(
  event: Record<string, unknown>,
  identity: Record<string, unknown>,
): boolean {
  let compared = 0;
  for (const field of ACTIVATION_LINEAGE_FIELDS) {
    const left = lineageText(event[field]);
    const right = lineageText(identity[field]);
    if (!left || !right) continue;
    if (left !== right) return false;
    compared += 1;
  }
  return compared > 0;
}
