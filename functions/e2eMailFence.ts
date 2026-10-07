// Production-pilot mail fence (Portal G005 mail-fence requirement, user-approved E2E safety
// override). Default-deny recipient/scope fence evaluated IMMEDIATELY before any provider send in
// the Flu-owned SCP outbox drains (onboarding + video-result). While the joint production-pilot
// E2E is the only authorized traffic on these NEW v3 mail lanes, every send must match the exact
// pinned scope — recipient, applicationId/submissionId, traceId, purpose, one-shot generation —
// or be skipped WITHOUT any state/attempt mutation. Absent or disabled config = fence CLOSED
// (deny all): these lanes carry zero legacy traffic, so closed-by-default is safe and reviewed.
// The fence config doc contains NO secret values (identifiers only).

import { adminDb } from "./firebaseAdmin";

export const E2E_MAIL_FENCE_DOC_PATH = "settings/scp_e2e_mail_fence";

export type E2eMailFenceConfig = {
  enabled: boolean;
  recipientEmail: string;
  applicationId: string;
  submissionId: string;
  traceId: string;
  purposes: readonly string[];
  maxSendGeneration: number;
};

export type E2eMailFenceCandidate = {
  recipientEmail: string;
  mailPurpose: string;
  applicationId?: string;
  submissionId?: string;
  traceId?: string;
  sendGeneration?: number;
};

export type E2eMailFenceVerdict = { allowed: boolean; reason: string };

export function normalizeFenceRecipient(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function text(value: unknown, max = 500): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function parseE2eMailFenceConfig(record: Record<string, unknown> | null | undefined): E2eMailFenceConfig | null {
  if (!record || record.enabled !== true) return null;
  const purposes = Array.isArray(record.purposes)
    ? record.purposes.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const maxSendGeneration = Number(record.maxSendGeneration ?? 1);
  return {
    enabled: true,
    recipientEmail: normalizeFenceRecipient(record.recipientEmail),
    applicationId: text(record.applicationId),
    submissionId: text(record.submissionId),
    traceId: text(record.traceId),
    purposes,
    maxSendGeneration: Number.isInteger(maxSendGeneration) && maxSendGeneration > 0 ? maxSendGeneration : 1,
  };
}

// Default-deny evaluation. Every rule below can only DENY relative to an exact-match pass:
// - closed (no enabled config) denies everything;
// - recipient must equal the single pinned normalized address;
// - purpose must be explicitly allowlisted;
// - the candidate must positively identify itself with at least one pinned identity
//   (applicationId or submissionId) that exactly matches the fence;
// - when the fence pins a traceId the candidate must carry the identical traceId;
// - one-shot: sendGeneration beyond maxSendGeneration is denied (missing generation counts as 1).
export function evaluateE2eMailFence(
  config: E2eMailFenceConfig | null,
  candidate: E2eMailFenceCandidate,
): E2eMailFenceVerdict {
  if (!config) return { allowed: false, reason: "pilot_fence_closed" };
  if (!config.recipientEmail || normalizeFenceRecipient(candidate.recipientEmail) !== config.recipientEmail) {
    return { allowed: false, reason: "pilot_fence_recipient_denied" };
  }
  if (!config.purposes.includes(candidate.mailPurpose)) {
    return { allowed: false, reason: "pilot_fence_purpose_denied" };
  }
  const candidateApplicationId = text(candidate.applicationId);
  const candidateSubmissionId = text(candidate.submissionId);
  const applicationMatch = Boolean(config.applicationId) && candidateApplicationId === config.applicationId;
  const submissionMatch = Boolean(config.submissionId) && candidateSubmissionId === config.submissionId;
  if (!applicationMatch && !submissionMatch) {
    return { allowed: false, reason: "pilot_fence_identity_denied" };
  }
  if (candidateApplicationId && config.applicationId && candidateApplicationId !== config.applicationId) {
    return { allowed: false, reason: "pilot_fence_identity_denied" };
  }
  if (candidateSubmissionId && config.submissionId && candidateSubmissionId !== config.submissionId) {
    return { allowed: false, reason: "pilot_fence_identity_denied" };
  }
  if (config.traceId) {
    if (!candidate.traceId || candidate.traceId !== config.traceId) {
      return { allowed: false, reason: "pilot_fence_trace_denied" };
    }
  }
  const generation = Number.isInteger(candidate.sendGeneration) && (candidate.sendGeneration as number) > 0
    ? (candidate.sendGeneration as number)
    : 1;
  if (generation > config.maxSendGeneration) {
    return { allowed: false, reason: "pilot_fence_generation_denied" };
  }
  return { allowed: true, reason: "pilot_fence_exact_match" };
}

export async function readE2eMailFenceConfig(): Promise<E2eMailFenceConfig | null> {
  try {
    const snapshot = await adminDb.doc(E2E_MAIL_FENCE_DOC_PATH).get();
    return parseE2eMailFenceConfig(snapshot.exists ? (snapshot.data() ?? null) : null);
  } catch {
    return null; // read failure = fence closed (default-deny)
  }
}
