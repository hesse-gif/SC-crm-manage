// Firestore CAS wiring for Partner activation (.specs/spec_partner_activation_from_video_approval/spec.md
// §5, §6.2, §6.3, §7.2). Composes the pure partnerActivationCore over two additive, server-write-only
// collections plus program/campaign KPI counters.
//
// Activation is NEVER its own standalone transaction: `applyPartnerActivationWrites` takes an
// already-open transaction-like object and pre-fetched snapshots so it can be folded into the SAME
// Firestore transaction as the approving review-state write (spec §6.2 — "partnerActivationStore가
// 내부에서 독립 transaction을 시작하면 안 됩니다"). Firestore forbids reads after any write in a
// transaction, so callers MUST perform every `read*Context` read before any `tx.set`/`tx.update` call,
// including their own review-state writes.
//
// Revocation is the one explicit, standalone command (spec §7.2) and owns its own transaction below.

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { expireAt180DaysFromIso } from "./firestoreTtl";
import {
  buildPartnerActivationDocument,
  buildPartnerActivationEvent,
  buildPartnerRevocationEvent,
  nextActiveCounterAfterRevoke,
  partnerActivationId,
  planPartnerActivation,
  planPartnerRevocation,
  type PartnerActivationDocument,
  type PartnerActivationResult,
  type PlanPartnerActivationInput,
  type PlanPartnerRevocationInput,
} from "./partnerActivationCore";

export const SCP_PARTNER_ACTIVATIONS_COLLECTION = "scp_partner_activations";
export const SCP_PARTNER_ACTIVATION_EVENTS_COLLECTION = "scp_partner_activation_events";
export const PROGRAMS_COLLECTION = "programs";
export const CAMPAIGNS_COLLECTION = "campaigns";

export class PartnerActivationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "PartnerActivationError";
  }
}

// ---- Minimal structural interfaces so the write-plan logic below is testable with in-memory fakes
// and satisfied as-is by real firebase-admin Transaction/DocumentReference/DocumentSnapshot objects. ----

export interface ActivationDocRef {
  readonly id?: string;
}

export interface ActivationDocSnapshot {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface ActivationTransactionSetter {
  set(ref: ActivationDocRef, data: Record<string, unknown>, options?: { merge?: boolean }): unknown;
  // Second fence (P2#7) for the first-activation create: a real Firestore `.create()` throws if the
  // doc already exists, backstopping the plan-level "no existing activation" check against a concurrent
  // write this same transaction attempt didn't observe.
  create(ref: ActivationDocRef, data: Record<string, unknown>): unknown;
}

export interface ActivationTransactionReader {
  get(ref: ActivationDocRef): Promise<ActivationDocSnapshot>;
}

function toTimestampIso(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Never fabricates an activation document from a partial/malformed snapshot — a doc that fails to
// parse cleanly is treated as absent-but-suspicious upstream by callers, never silently coerced.
export function parsePartnerActivationDocument(snap: ActivationDocSnapshot): PartnerActivationDocument | null {
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data || typeof data !== "object") return null;
  const identity = data.identity as PartnerActivationDocument["identity"] | undefined;
  const evidence = data.evidence as PartnerActivationDocument["evidence"] | undefined;
  if (!identity || !evidence) return null;
  const status = data.status;
  if (status !== "active" && status !== "revoked") return null;
  return {
    schemaVersion: "flu.partner-activation.v1",
    activationId: String(data.activationId ?? ""),
    status,
    identity,
    activationReason: data.activationReason === "video_current_revision_approved" ? "video_current_revision_approved" : "video_current_revision_approved",
    evidence,
    version: Number(data.version ?? 1),
    activatedAtIso: toTimestampIso(data.activatedAtIso),
    revokedAtIso: typeof data.revokedAtIso === "string" ? data.revokedAtIso : undefined,
    revokedBy: typeof data.revokedBy === "string" ? data.revokedBy : undefined,
    revocationReasonCode: data.revocationReasonCode as PartnerActivationDocument["revocationReasonCode"],
    updatedAtIso: toTimestampIso(data.updatedAtIso),
  };
}

export interface PartnerActivationCounterRefs {
  activationRef: ActivationDocRef;
  eventRef: ActivationDocRef;
  programRef: ActivationDocRef | null;
  campaignRef: ActivationDocRef | null;
}

function classifiedScopeId(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized !== "unclassified" ? normalized : null;
}

export function buildPartnerActivationRefs(
  db: Pick<FirebaseFirestore.Firestore, "collection">,
  params: { enrollmentId: string; eventId: string | null; programId?: string | null; campaignId?: string | null },
): PartnerActivationCounterRefs {
  const programId = classifiedScopeId(params.programId);
  const campaignId = classifiedScopeId(params.campaignId);
  return {
    activationRef: db.collection(SCP_PARTNER_ACTIVATIONS_COLLECTION).doc(partnerActivationId(params.enrollmentId)),
    eventRef: params.eventId
      ? db.collection(SCP_PARTNER_ACTIVATION_EVENTS_COLLECTION).doc(params.eventId)
      : db.collection(SCP_PARTNER_ACTIVATION_EVENTS_COLLECTION).doc(),
    programRef: programId ? db.collection(PROGRAMS_COLLECTION).doc(programId) : null,
    campaignRef: campaignId ? db.collection(CAMPAIGNS_COLLECTION).doc(campaignId) : null,
  };
}

export interface PartnerActivationTransactionContext {
  refs: PartnerActivationCounterRefs;
  existingActivation: PartnerActivationDocument | null;
  programActivePartnerCount: number;
  programPartnerActivatedTotal: number;
  campaignActivePartnerCount: number;
  campaignPartnerActivatedTotal: number;
}

// Every read this activation hook needs, gathered BEFORE any transaction write (Firestore requires
// all transaction reads to precede all transaction writes).
export async function readPartnerActivationTransactionContext(
  tx: ActivationTransactionReader,
  refs: PartnerActivationCounterRefs,
): Promise<PartnerActivationTransactionContext> {
  const [activationSnap, programSnap, campaignSnap] = await Promise.all([
    tx.get(refs.activationRef),
    refs.programRef ? tx.get(refs.programRef) : Promise.resolve(null),
    refs.campaignRef ? tx.get(refs.campaignRef) : Promise.resolve(null),
  ]);
  const programData = programSnap && programSnap.exists ? programSnap.data() ?? {} : {};
  const campaignData = campaignSnap && campaignSnap.exists ? campaignSnap.data() ?? {} : {};
  // P2#7 fix: a doc that EXISTS but fails to parse (malformed/partial) must abort to a reconciliation
  // error, never be silently treated as "absent" — parsePartnerActivationDocument returning null for an
  // existing snapshot is exactly the unparseable case (it already returns null for a genuinely absent
  // doc too, so `snap.exists` is what distinguishes them here).
  if (activationSnap.exists && parsePartnerActivationDocument(activationSnap) === null) {
    throw new PartnerActivationError("partner_activation_unparseable", "existing activation document failed to parse; reconciliation required");
  }
  return {
    refs,
    existingActivation: parsePartnerActivationDocument(activationSnap),
    programActivePartnerCount: Number(programData.activePartnerCount ?? 0),
    programPartnerActivatedTotal: Number(programData.partnerActivatedTotal ?? 0),
    campaignActivePartnerCount: Number(campaignData.activePartnerCount ?? 0),
    campaignPartnerActivatedTotal: Number(campaignData.partnerActivatedTotal ?? 0),
  };
}

export interface ApplyPartnerActivationInput {
  review: PlanPartnerActivationInput["review"];
  command: PlanPartnerActivationInput["command"];
  reviewTransitionSeq: number;
}

// Applies the write plan into an ALREADY-OPEN transaction (never opens its own). Idempotent by
// construction: already_active / already_revoked / not_applicable / reject never issue a single write,
// so replay and concurrent double-fire on the same enrollment can never create a second activation,
// event, or KPI increment (spec §6.3 — the activation-doc CAS create is what makes concurrent first
// approvals on different submissions converge on exactly one winner across transaction retries).
export function applyPartnerActivationWrites(
  tx: ActivationTransactionSetter,
  ctx: PartnerActivationTransactionContext,
  input: ApplyPartnerActivationInput,
  now: Date,
): PartnerActivationResult {
  const enrollmentId = input.review.subject.enrollmentId || null;
  const plan = planPartnerActivation({
    review: input.review,
    command: input.command,
    existingActivation: ctx.existingActivation,
  });

  if (plan.action !== "activate") {
    if (plan.action === "reject") {
      throw new PartnerActivationError(plan.errorCode ?? "partner_activation_rejected", "partner activation preconditions failed");
    }
    return {
      status: plan.action,
      enrollmentId,
      activationId: plan.activationId,
      kpiApplied: false,
    };
  }

  const nowIso = now.toISOString();
  const doc = buildPartnerActivationDocument({
    plan,
    subject: input.review.subject,
    command: input.command,
    reviewTransitionSeq: input.reviewTransitionSeq,
    nowIso,
  });
  const event = buildPartnerActivationEvent({
    plan,
    subject: input.review.subject,
    command: input.command,
    reviewTransitionSeq: input.reviewTransitionSeq,
    nowIso,
  });

  tx.create(ctx.refs.activationRef, {
    ...doc,
    activatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  tx.set(ctx.refs.eventRef, {
    ...event,
    createdAt: FieldValue.serverTimestamp(),
    expireAt: expireAt180DaysFromIso(event.atIso),
  });

  // Exactly-once KPI first-increment, folded into the same transaction as the activation create.
  if (ctx.refs.programRef) {
    tx.set(
      ctx.refs.programRef,
      {
        activePartnerCount: ctx.programActivePartnerCount + 1,
        partnerActivatedTotal: ctx.programPartnerActivatedTotal + 1,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
  if (ctx.refs.campaignRef) {
    tx.set(
      ctx.refs.campaignRef,
      {
        activePartnerCount: ctx.campaignActivePartnerCount + 1,
        partnerActivatedTotal: ctx.campaignPartnerActivatedTotal + 1,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  return {
    status: "activated",
    enrollmentId,
    activationId: plan.activationId,
    kpiApplied: true,
  };
}

// ---- Explicit revocation — a standalone, permissioned, audited CAS command with its own transaction.
// NEVER invoked automatically by content correction/replacement/rejection/callback failure, and NEVER
// rewrites or deletes prior activation/event history. ----

export interface RevokePartnerActivationCommandInput {
  enrollmentId: string;
  expectedVersion: number;
  reasonCode: import("./partnerActivationCore").PartnerRevocationReasonCode;
  actorId: string;
  confirmation: string;
  // P2#4 fix: program/campaign KPI refs are derived from the read activation doc's OWN
  // identity.programId/identity.campaignId (inside the transaction), never from caller input — a
  // caller can no longer point the KPI decrement at an arbitrary program/campaign.
}

export interface RevokePartnerActivationResult {
  applied: boolean;
  idempotent: boolean;
  status: PartnerActivationDocument["status"];
  version: number | null;
}

export async function revokePartnerActivation(
  input: RevokePartnerActivationCommandInput,
  now: Date,
  options: { firestore?: FirebaseFirestore.Firestore } = {},
): Promise<RevokePartnerActivationResult> {
  if (!input.enrollmentId) throw new PartnerActivationError("invalid-argument", "enrollmentId is required");
  const db = options.firestore ?? adminDb;

  return db.runTransaction(async (tx) => {
    const activationRef = db.collection(SCP_PARTNER_ACTIVATIONS_COLLECTION).doc(partnerActivationId(input.enrollmentId));

    // Phase 1: read the activation doc alone first — program/campaign KPI refs are derived from ITS
    // OWN identity below (P2#4 fix), never from caller-supplied programId/campaignId, so a caller
    // cannot decrement counters for a program/campaign the activation was never actually attributed to.
    const activationSnap = await tx.get(activationRef);
    if (activationSnap.exists && parsePartnerActivationDocument(activationSnap) === null) {
      throw new PartnerActivationError("partner_activation_unparseable", "existing activation document failed to parse; reconciliation required");
    }
    const existingActivation = parsePartnerActivationDocument(activationSnap);

    const derivedProgramId = classifiedScopeId(existingActivation?.identity.programId);
    const derivedCampaignId = classifiedScopeId(existingActivation?.identity.campaignId);
    const programRef = derivedProgramId ? db.collection(PROGRAMS_COLLECTION).doc(derivedProgramId) : null;
    const campaignRef = derivedCampaignId ? db.collection(CAMPAIGNS_COLLECTION).doc(derivedCampaignId) : null;

    // Phase 2: remaining reads (program/campaign), still before any write in this transaction.
    const [programSnap, campaignSnap] = await Promise.all([
      programRef ? tx.get(programRef) : Promise.resolve(null),
      campaignRef ? tx.get(campaignRef) : Promise.resolve(null),
    ]);

    const revocationInput: PlanPartnerRevocationInput = {
      existingActivation,
      command: {
        enrollmentId: input.enrollmentId,
        expectedVersion: input.expectedVersion,
        reasonCode: input.reasonCode,
        actorId: input.actorId,
        confirmation: input.confirmation,
      },
    };
    const plan = planPartnerRevocation(revocationInput);

    if (plan.action === "reject") {
      throw new PartnerActivationError(plan.errorCode ?? "partner_activation_revocation_rejected", "partner revocation preconditions failed");
    }
    if (plan.action === "idempotent_replay") {
      return { applied: false, idempotent: true, status: "revoked", version: existingActivation?.version ?? null };
    }

    const nowIso = now.toISOString();
    const event = buildPartnerRevocationEvent({ plan, command: revocationInput.command, nowIso });

    tx.set(
      activationRef,
      {
        status: "revoked",
        version: plan.nextVersion,
        revokedAtIso: nowIso,
        revokedAt: FieldValue.serverTimestamp(),
        revokedBy: input.actorId,
        revocationReasonCode: input.reasonCode,
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    tx.set(db.collection(SCP_PARTNER_ACTIVATION_EVENTS_COLLECTION).doc(event.eventId), {
      ...event,
      createdAt: FieldValue.serverTimestamp(),
      expireAt: expireAt180DaysFromIso(event.atIso),
    });

    // partnerActivatedTotal never decrements on revoke; activePartnerCount drops by exactly one, and
    // drift (<=0) fails closed to reconciliation rather than clamping to zero (spec §6.3).
    if (programRef) {
      const programData = programSnap && programSnap.exists ? programSnap.data() ?? {} : {};
      const nextActive = nextActiveCounterAfterRevoke(Number(programData.activePartnerCount ?? 0));
      tx.set(programRef, { activePartnerCount: nextActive, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    if (campaignRef) {
      const campaignData = campaignSnap && campaignSnap.exists ? campaignSnap.data() ?? {} : {};
      const nextActive = nextActiveCounterAfterRevoke(Number(campaignData.activePartnerCount ?? 0));
      tx.set(campaignRef, { activePartnerCount: nextActive, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }

    return { applied: true, idempotent: false, status: "revoked", version: plan.nextVersion };
  });
}
