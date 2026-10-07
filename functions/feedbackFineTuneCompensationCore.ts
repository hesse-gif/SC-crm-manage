import { createHash } from "node:crypto";

export const FINE_TUNE_COMPENSATION_MAX_ATTEMPTS = 5;
export const FINE_TUNE_COMPENSATION_LEASE_MS = 60_000;

export type FineTuneCompensationStatus =
  | "pending"
  | "cancelling"
  | "retryable"
  | "cancelled"
  | "dead_letter";

export type FineTuneCompensationState = {
  status?: unknown;
  revision?: unknown;
  attemptCount?: unknown;
  leaseId?: unknown;
  leaseUntil?: unknown;
};

function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function safeInteger(value: unknown, fallback = 0): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function safeStatus(value: unknown): FineTuneCompensationStatus {
  const allowed: FineTuneCompensationStatus[] = ["pending", "cancelling", "retryable", "cancelled", "dead_letter"];
  return typeof value === "string" && allowed.includes(value as FineTuneCompensationStatus)
    ? value as FineTuneCompensationStatus
    : "pending";
}

export function fineTuneCompensationIdentity(queueId: string, externalJobRefHash: string) {
  const identitySeed = `${queueId.trim()}\u0000${externalJobRefHash.trim() || "unverified"}`;
  const outboxId = `fine-tune-compensation-${digest(identitySeed, 32)}`;
  return {
    outboxId,
    outboxRef: `fine_tune_compensation_outbox/${outboxId}`,
    handleRef: `fine_tune_cancellation_handles/${outboxId}`,
    idempotencyKey: `fine-tune-cancel-${digest(`cancel\u0000${identitySeed}`, 48)}`,
  } as const;
}

export function requireCancellationHandle(value: unknown): string {
  if (typeof value !== "string") {
    throw Object.assign(new Error("aihub_cancellation_handle_missing"), { code: "aihub_cancellation_handle_missing", errorCode: "require_cancellation_handle_aihub_cancellation_handle_missing" });
  }
  const handle = value.trim();
  if (!handle || handle.length > 2_048 || /[\u0000-\u001f\u007f]/.test(handle)) {
    throw Object.assign(new Error("aihub_cancellation_handle_invalid"), { code: "aihub_cancellation_handle_invalid", errorCode: "require_cancellation_handle_aihub_cancellation_handle_invalid" });
  }
  return handle;
}

export function planFineTuneCompensationClaim(
  current: FineTuneCompensationState,
  input: { nowMs: number; leaseId: string },
) {
  const status = safeStatus(current.status);
  const revision = safeInteger(current.revision);
  const attemptCount = safeInteger(current.attemptCount);
  const leaseUntilMs = Date.parse(typeof current.leaseUntil === "string" ? current.leaseUntil : "");
  const leaseExpired = status === "cancelling" && (!Number.isFinite(leaseUntilMs) || leaseUntilMs <= input.nowMs);
  if (status === "cancelled" || status === "dead_letter" || (status === "cancelling" && !leaseExpired)) {
    return { claimed: false as const, status, revision, attemptCount };
  }
  if (attemptCount >= FINE_TUNE_COMPENSATION_MAX_ATTEMPTS) {
    return {
      claimed: false as const,
      status: "dead_letter" as const,
      revision: revision + 1,
      attemptCount,
      terminalize: true as const,
    };
  }
  const nextAttemptCount = attemptCount + 1;
  return {
    claimed: true as const,
    status: "cancelling" as const,
    revision: revision + 1,
    attemptCount: nextAttemptCount,
    leaseId: input.leaseId,
    leaseUntil: new Date(input.nowMs + FINE_TUNE_COMPENSATION_LEASE_MS).toISOString(),
  };
}

export function planFineTuneCompensationFailure(
  current: FineTuneCompensationState,
  input: { permanent?: boolean } = {},
) {
  const revision = safeInteger(current.revision) + 1;
  const attemptCount = safeInteger(current.attemptCount);
  const terminal = input.permanent === true || attemptCount >= FINE_TUNE_COMPENSATION_MAX_ATTEMPTS;
  return {
    status: terminal ? "dead_letter" as const : "retryable" as const,
    revision,
    attemptCount,
    leaseId: null,
    leaseUntil: null,
  };
}

export function planFineTuneCompensationSuccess(current: FineTuneCompensationState) {
  return {
    status: "cancelled" as const,
    revision: safeInteger(current.revision) + 1,
    attemptCount: safeInteger(current.attemptCount),
    leaseId: null,
    leaseUntil: null,
  };
}
