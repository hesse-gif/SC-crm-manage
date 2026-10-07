// Explicit revocation callable (spec_partner_activation_from_video_approval §7.2, §9). Standalone,
// permissioned, audited CAS command — NEVER invoked automatically by content correction/replacement/
// rejection/callback failure (see partnerActivationStore.ts header). Diagnosable, fail-closed error
// mapping mirrors videoReviewTransitionCallables.ts's pattern.

import { assertNonGuestAuth, makeBehaviorLog, asRecord, asString, type CallableRequestShape, type Role } from "./shared";
import { revokePartnerActivation, PartnerActivationError } from "./partnerActivationStore";
import type { PartnerRevocationReasonCode } from "./partnerActivationCore";

// spec §7.2 table: same operator allowlist as transitionVideoReviewDecision.
const OPERATOR_ROLES: readonly Exclude<Role, "guest">[] = ["super_admin", "admin", "manager"];

const REVOCATION_REASON_CODES: readonly PartnerRevocationReasonCode[] = [
  "policy_violation",
  "fraud_confirmed",
  "program_removed",
  "creator_requested",
  "operator_correction",
];

// The exact confirmation literal the caller must echo (spec §7.2) — never accepted case-insensitively
// or fuzzily; planPartnerRevocation enforces the same literal again inside the transaction.
const REVOKE_CONFIRMATION_LITERAL = "REVOKE_PARTNER";

// spec §9 error contract for this command; anything else collapses to a generic fail-closed fallback
// (never the raw internal Error.message/stack).
const ALLOWLISTED_PARTNER_ACTIVATION_ERROR_CODES: ReadonlySet<string> = new Set([
  "partner_activation_stale_version",
  "partner_activation_already_revoked",
  "partner_activation_counter_drift",
  "partner_activation_unparseable",
  "invalid-argument",
]);

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode: "invalid_argument_unauthorized" });
}

function integerField(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) ? n : Number.NaN;
}

export async function revokePartnerActivationHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "partner_activation.revoke", OPERATOR_ROLES);
  const data = asRecord(request.data);
  const enrollmentId = asString(data.enrollmentId);
  const expectedVersion = integerField(data.expectedVersion);
  const reasonCode = asString(data.reasonCode);
  const confirmation = asString(data.confirmation);

  if (!enrollmentId) throw invalidArgument("enrollmentId is required");
  if (!Number.isInteger(expectedVersion)) throw invalidArgument("expectedVersion is required");
  if (!(REVOCATION_REASON_CODES as readonly string[]).includes(reasonCode)) throw invalidArgument("valid reasonCode is required");
  if (confirmation !== REVOKE_CONFIRMATION_LITERAL) throw invalidArgument(`confirmation must be exactly "${REVOKE_CONFIRMATION_LITERAL}"`);

  try {
    const result = await revokePartnerActivation(
      {
        enrollmentId,
        expectedVersion,
        reasonCode: reasonCode as PartnerRevocationReasonCode,
        actorId: auth.userId,
        confirmation,
      },
      new Date(),
    );
    return { ...result, behaviorLog: makeBehaviorLog(auth, "partner_activation.revoke", "success") };
  } catch (error) {
    if (error instanceof PartnerActivationError) {
      if (error.code === "partner_activation_not_found") {
        throw Object.assign(new Error("not-found: partner activation does not exist"), { code: "not-found", errorCode: "revoke_partner_activation_handler_partner_activation_exist" });
      }
      const errorCode = ALLOWLISTED_PARTNER_ACTIVATION_ERROR_CODES.has(error.code) ? error.code : "partner_activation_revocation_rejected";
      throw Object.assign(new Error(`failed-precondition: ${errorCode}`), { code: "failed-precondition", errorCode });
    }
    throw error;
  }
}
