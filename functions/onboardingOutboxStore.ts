// Firestore-backed Flu-owned onboarding outbox (spec D). Durable state machine over the pure
// onboardingOutboxCore. Managed-only enqueue (§4.4); idempotent per send-generation; retry/backoff/
// dead-letter transitions; provider receipt stored as a HASH only (no raw message id).
//
// The actual mail RENDER/SEND is delegated to the campaign composer (prepareScpResultMail) — this
// store NEVER clones the renderer (D.2) and NEVER performs a live send on its own; the caller reports
// the provider outcome via markOnboardingSent/markOnboardingFailed. Real send stays fail-closed until
// the provider binding + staging + attestation gates are satisfied.

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  ONBOARDING_OUTBOX_COLLECTION,
  ONBOARDING_OUTBOX_MAX_ATTEMPTS_DEFAULT,
  hashProviderMessageId,
  onboardingSendGenerationKey,
  resolveOnboardingTemplateRef,
  planOnboardingSend,
  type OnboardingOutboxState,
} from "./onboardingOutboxCore";
import { onboardingSendGate } from "./onboardingSendGateCore";
import type { AttributionClassification } from "./applicationManagementAttributionCore";
import { SCP_APPLICATION_MANAGEMENT_COLLECTION } from "./applicationManagementStore";

export const ONBOARDING_OUTBOX_STORE_VERSION = "onboarding_outbox_store_v2" as const;

function outboxDocId(applicationId: string, sendGeneration: number): string {
  const app = String(applicationId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160);
  if (!app) throw new Error("invalid-argument: applicationId is required");
  return `${app}__${Math.max(0, Math.trunc(sendGeneration))}`;
}

export type EnqueueOnboardingInput = {
  applicationId: string;
  classification: AttributionClassification;
  templateRef: string;
  templateRevision: string;
  sendGeneration: number;
  /**
   * 세대 교차 가드(양방향): 지정한 다른 세대의 행을 **같은 트랜잭션에서** 읽어 sent 면
   * "other_generation_sent", live(queued/sending/failed)면 "other_generation_live" 로
   * 큐잉을 거부한다 — 드레인이 두 세대를 같은 패스에서 집어 동일 수신자에게 두 통을
   * 보내는 창을 원자적으로 닫는다. 승인 큐잉(gen 1)은 0 을, test_send(gen 0)는 1 을
   * 가드한다. dead_letter/부재는 통과.
   */
  guardAgainstGeneration?: number;
};

export type EnqueueOnboardingResult = {
  state: OnboardingOutboxState;
  generationKey: string;
  blockedReason: string | null;
  idempotent: boolean;
};

export async function enqueueOnboardingOutbox(input: EnqueueOnboardingInput, now: Date): Promise<EnqueueOnboardingResult> {
  const ref = adminDb.collection(ONBOARDING_OUTBOX_COLLECTION).doc(outboxDocId(input.applicationId, input.sendGeneration));
  const nowIso = now.toISOString();
  const gate = onboardingSendGate(input.classification);
  const generationKey = onboardingSendGenerationKey({
    applicationId: input.applicationId,
    templateRevision: input.templateRevision,
    sendGeneration: input.sendGeneration,
  });
  let idempotent = false;
  let guardReason: "other_generation_sent" | "other_generation_live" | null = null;
  let state: OnboardingOutboxState = gate.autoSendEligible ? "queued" : "blocked";
  await adminDb.runTransaction(async (transaction) => {
    // 트랜잭션 재시도 안전: 콜백 밖 let 들은 재실행 시 이전 시도 값을 물려받는다 — 리셋.
    idempotent = false;
    guardReason = null;
    state = gate.autoSendEligible ? "queued" : "blocked";
    if (input.guardAgainstGeneration !== undefined) {
      const guardRef = adminDb
        .collection(ONBOARDING_OUTBOX_COLLECTION)
        .doc(outboxDocId(input.applicationId, input.guardAgainstGeneration));
      const guardSnap = await transaction.get(guardRef);
      const guardState = String(guardSnap.data()?.state ?? "");
      if (guardState === "sent") {
        guardReason = "other_generation_sent";
        state = "blocked";
        return;
      }
      if (guardState === "queued" || guardState === "sending" || guardState === "failed") {
        guardReason = "other_generation_live";
        state = "blocked";
        return;
      }
    }
    const snap = await transaction.get(ref);
    if (snap.exists) {
      const prior = (snap.data()?.state ?? "") as OnboardingOutboxState;
      // Idempotent: a live/terminal row is not re-enqueued (a genuine resend uses a new sendGeneration).
      // A genuine resend uses a NEW sendGeneration; a prior attempt (incl. failed) is never re-enqueued/reset.
      if (prior === "queued" || prior === "sending" || prior === "sent" || prior === "dead_letter" || prior === "failed") {
        idempotent = true;
        state = prior;
        return;
      }
    }
    transaction.set(ref, {
      storeVersion: ONBOARDING_OUTBOX_STORE_VERSION,
      applicationId: input.applicationId,
      classification: input.classification,
      templateRef: input.templateRef,
      templateRevision: input.templateRevision,
      sendGeneration: Math.max(0, Math.trunc(input.sendGeneration)),
      generationKey,
      state,
      blockedReason: gate.autoSendEligible ? null : (gate.blockedReason ?? "classification_not_managed"),
      attempts: 0,
      providerMessageIdHash: "",
      createdAtIso: snap.exists ? (snap.data()?.createdAtIso ?? nowIso) : nowIso,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return {
    state,
    generationKey,
    blockedReason: guardReason ?? (gate.autoSendEligible ? null : (gate.blockedReason ?? "classification_not_managed")),
    idempotent,
  };
}

export async function markOnboardingSent(applicationId: string, sendGeneration: number, providerMessageId: string, now: Date): Promise<void> {
  const ref = adminDb.collection(ONBOARDING_OUTBOX_COLLECTION).doc(outboxDocId(applicationId, sendGeneration));
  await adminDb.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new Error("not-found: onboarding outbox row does not exist");
    const state = String(snap.data()?.state ?? "") as OnboardingOutboxState;
    // Only a live attempt may transition to sent — never resurrect a terminal dead_letter (or clobber sent).
    if (state !== "queued" && state !== "sending" && state !== "failed") return;
    transaction.set(ref, {
      state: "sent" satisfies OnboardingOutboxState,
      providerMessageIdHash: hashProviderMessageId(providerMessageId),
      sentAtIso: now.toISOString(),
      updatedAtIso: now.toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

export type MarkFailedResult = { state: OnboardingOutboxState; attempts: number; retryAtMs?: number };

// Records a failed attempt and computes the next state via the pure planner (retry vs dead_letter).
export async function markOnboardingFailed(applicationId: string, sendGeneration: number, reason: string, now: Date): Promise<MarkFailedResult> {
  const ref = adminDb.collection(ONBOARDING_OUTBOX_COLLECTION).doc(outboxDocId(applicationId, sendGeneration));
  return adminDb.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new Error("not-found: onboarding outbox row does not exist");
    const data = snap.data() ?? {};
    const priorState = String(data.state ?? "") as OnboardingOutboxState;
    // Terminal states are immutable (symmetric with markOnboardingSent): never resurrect a
    // sent/dead_letter row into failed.
    if (priorState === "sent" || priorState === "dead_letter") {
      return { state: priorState, attempts: Math.max(0, Math.trunc(Number(data.attempts ?? 0))) };
    }
    const attempts = Math.max(0, Math.trunc(Number(data.attempts ?? 0))) + 1;
    const classification = String(data.classification ?? "unclassified") as AttributionClassification;
    const plan = planOnboardingSend({
      classification,
      currentState: "failed",
      attempts,
      maxAttempts: ONBOARDING_OUTBOX_MAX_ATTEMPTS_DEFAULT,
      nowMs: now.getTime(),
      lastAttemptMs: now.getTime(),
    });
    const nextState: OnboardingOutboxState = plan.action === "dead_letter" ? "dead_letter" : "failed";
    transaction.set(ref, {
      state: nextState,
      attempts,
      lastFailureReason: String(reason).slice(0, 200),
      lastAttemptIso: now.toISOString(),
      updatedAtIso: now.toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { state: nextState, attempts, ...(plan.retryAtMs ? { retryAtMs: plan.retryAtMs } : {}) };
  });
}

export async function getOnboardingOutbox(applicationId: string, sendGeneration: number): Promise<Record<string, unknown> | null> {
  const snap = await adminDb.collection(ONBOARDING_OUTBOX_COLLECTION).doc(outboxDocId(applicationId, sendGeneration)).get();
  return snap.exists ? (snap.data() ?? null) : null;
}

export type ManagedOnboardingEnqueueResult = {
  enqueued: boolean;
  idempotent: boolean;
  state: OnboardingOutboxState | "not_enqueued";
  reason?: string;
  templateRef?: string;
};

// Bridge F2 -> F3 (spec D.4): when an application-management record is `managed`, resolve the
// onboarding template (precedence campaign>program>global) and enqueue the onboarding outbox.
// Non-managed / missing records are NEVER enqueued (fail-closed §4.4). NO mail is sent here — enqueue
// only; the gated render/send (prepareScpResultMail reuse) happens downstream once staging/provider
// binding + attestation are satisfied.
export async function enqueueOnboardingForManagedApplication(
  input: {
    applicationId: string;
    campaignOverrideTemplateRef?: string | null;
    programDefaultTemplateRef?: string | null;
    globalDefaultTemplateRef: string;
    sendGeneration?: number;
    guardAgainstGeneration?: number;
  },
  now: Date,
): Promise<ManagedOnboardingEnqueueResult> {
  const docId = String(input.applicationId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180);
  if (!docId) throw new Error("invalid-argument: applicationId is required");
  const snap = await adminDb.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION).doc(docId).get();
  if (!snap.exists) return { enqueued: false, idempotent: false, state: "not_enqueued", reason: "application_record_missing" };
  const classification = String(snap.data()?.classification ?? "unclassified") as AttributionClassification;
  if (classification !== "managed") {
    return { enqueued: false, idempotent: false, state: "not_enqueued", reason: "classification_not_managed" };
  }
  const templateRef = resolveOnboardingTemplateRef({
    campaignOverrideTemplateRef: input.campaignOverrideTemplateRef,
    programDefaultTemplateRef: input.programDefaultTemplateRef,
    globalDefaultTemplateRef: input.globalDefaultTemplateRef,
  });
  const templateRevision = String(snap.data()?.sourceRevision ?? 1);
  const enq = await enqueueOnboardingOutbox(
    {
      applicationId: input.applicationId,
      classification,
      templateRef,
      templateRevision,
      sendGeneration: input.sendGeneration ?? 0,
      ...(input.guardAgainstGeneration === undefined ? {} : { guardAgainstGeneration: input.guardAgainstGeneration }),
    },
    now,
  );
  return { enqueued: enq.state === "queued", idempotent: enq.idempotent, state: enq.state, reason: enq.blockedReason ?? undefined, templateRef };
}
