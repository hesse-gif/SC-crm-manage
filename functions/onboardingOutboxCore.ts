// Pure state machine for the Flu-owned onboarding mail outbox (spec D). Deterministic, no side effects.
// Ownership: Flu Manage owns onboarding mail (D.1). Actual rendering/sending REUSES the campaign
// composer (prepareScpResultMail / compiled artifact) — this core NEVER clones the renderer (D.2).
// It owns only: managed-only gate (D.4/§4.4), stable send generation + idempotency (D.5),
// retry/backoff/dead-letter decisions (D.5). Real provider send stays fail-closed until the provider
// binding + staging gates are satisfied; auto-send trigger for exact-attribution waits for Portal evidence.

import { createHash } from "node:crypto";
import { onboardingSendGate } from "./onboardingSendGateCore";
import type { AttributionClassification } from "./applicationManagementAttributionCore";

export const ONBOARDING_OUTBOX_VERSION = "onboarding_outbox_v2" as const;
export const ONBOARDING_OUTBOX_COLLECTION = "scp_onboarding_outbox";
export const ONBOARDING_OUTBOX_MAX_ATTEMPTS_DEFAULT = 5;
export const ONBOARDING_OUTBOX_BACKOFF_BASE_MS_DEFAULT = 60_000;

export type OnboardingOutboxState = "queued" | "sending" | "sent" | "failed" | "dead_letter" | "blocked";

// Template resolution precedence (D.2): campaign override > program default > global default.
export function resolveOnboardingTemplateRef(input: {
  campaignOverrideTemplateRef?: string | null;
  programDefaultTemplateRef?: string | null;
  globalDefaultTemplateRef: string;
}): string {
  const pick = (v?: string | null): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return pick(input.campaignOverrideTemplateRef) ?? pick(input.programDefaultTemplateRef) ?? input.globalDefaultTemplateRef;
}

// Stable send generation / idempotency key. A change in templateRevision or sendGeneration mints a new
// key so a legitimate resend is distinct while a duplicate attempt is deduped.
export function onboardingSendGenerationKey(input: {
  applicationId: string;
  templateRevision: string;
  sendGeneration: number;
}): string {
  const material = `onboarding|${input.applicationId}|${input.templateRevision}|${Math.max(0, Math.trunc(input.sendGeneration))}`;
  return createHash("sha256").update(material).digest("hex");
}

// Store only a hash of the provider message id (PII/observability minimization).
export function hashProviderMessageId(providerMessageId: string): string {
  const normalized = String(providerMessageId).trim().toLowerCase();
  return normalized ? createHash("sha256").update(normalized).digest("hex") : "";
}

export type OnboardingSendPlanInput = {
  classification: AttributionClassification;
  currentState: OnboardingOutboxState;
  attempts: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  nowMs: number;
  lastAttemptMs?: number | null;
};

export type OnboardingSendAction =
  | "block_not_managed"
  | "skip_already_sent"
  | "skip_dead_letter"
  | "dead_letter"
  | "retry_wait"
  | "send";

export type OnboardingSendPlan = {
  action: OnboardingSendAction;
  nextState: OnboardingOutboxState;
  reason: string;
  retryAtMs?: number;
  attemptNumber?: number;
};

// Exponential backoff: base * 2^(attempts-1).
function backoffMs(base: number, attempts: number): number {
  const exp = Math.max(0, attempts - 1);
  return base * 2 ** Math.min(exp, 16);
}

export function planOnboardingSend(input: OnboardingSendPlanInput): OnboardingSendPlan {
  const maxAttempts = input.maxAttempts ?? ONBOARDING_OUTBOX_MAX_ATTEMPTS_DEFAULT;
  const backoffBase = input.backoffBaseMs ?? ONBOARDING_OUTBOX_BACKOFF_BASE_MS_DEFAULT;
  const attempts = Math.max(0, Math.trunc(input.attempts));

  // §4.4 / D.4: only managed records may send or receive a content grant.
  const gate = onboardingSendGate(input.classification);
  if (!gate.autoSendEligible) {
    return { action: "block_not_managed", nextState: "blocked", reason: gate.blockedReason ?? "classification_not_managed" };
  }
  // Idempotent terminal states.
  if (input.currentState === "sent") {
    return { action: "skip_already_sent", nextState: "sent", reason: "already_sent" };
  }
  if (input.currentState === "dead_letter") {
    return { action: "skip_dead_letter", nextState: "dead_letter", reason: "dead_letter" };
  }
  // Retry exhaustion → dead-letter (never silently drop).
  if (attempts >= maxAttempts) {
    return { action: "dead_letter", nextState: "dead_letter", reason: "max_attempts_exhausted" };
  }
  // Backoff window not elapsed → wait.
  if (attempts > 0 && typeof input.lastAttemptMs === "number") {
    const readyAt = input.lastAttemptMs + backoffMs(backoffBase, attempts);
    if (input.nowMs < readyAt) {
      return { action: "retry_wait", nextState: "failed", reason: "backoff_wait", retryAtMs: readyAt };
    }
  }
  return { action: "send", nextState: "sending", reason: "eligible", attemptNumber: attempts + 1 };
}
