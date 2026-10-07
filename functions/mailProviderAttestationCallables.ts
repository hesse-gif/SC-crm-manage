import { adminDb } from "./firebaseAdmin";
import {
  CANONICAL_OPERATIONAL_MAILBOX_V1,
  mailIdentityBlockReason,
} from "./mailIdentity";
import type { RuntimeIntegration } from "./liveIntegrations";
import {
  appendBoundedMailProviderAttestationAudit,
  buildMailProviderAttestationAuditRecord,
  buildMailProviderAttestationReceipt,
  hashMailProviderAttestationActor,
  MAIL_PROVIDER_ATTESTATION_AUDIT_PATH,
  MAIL_PROVIDER_ATTESTATION_PATH,
  readMailProviderAttestationProjection,
  revokeMailProviderAttestationReceipt,
  safeMailProviderAttestationProjection,
} from "./mailProviderAttestation";
import {
  resolveOperationalMailIdentityContext,
  resolveOperationalMailIdentityContextFromConfigs,
} from "./mailProfiles";
import {
  MAIL_TRANSPORT_PROBE_STATUS_PATH,
  mailTransportDiagnosticChallengeMatches,
  safeMailTransportProbeProjection,
} from "./mailTransportDiagnostics";
import {
  assertNonGuestAuth,
  asRecord,
  makeBehaviorLog,
  type CallableRequestShape,
} from "./shared";

function failedPrecondition(message: string, ruleId: string): Error {
  return Object.assign(new Error(message), {
    code: "failed-precondition", errorCode: "failed_precondition_unauthorized",
    ruleId,
    humanRequired: true,
  });
}

function runtimeIntegration(
  key: "mailSmtp" | "mailImap",
  root: Record<string, unknown>,
): RuntimeIntegration {
  const stored = asRecord(root[key]);
  return {
    key,
    public: asRecord(stored.public),
    secrets: asRecord(stored.secrets),
  };
}

function requireCanonicalConfirmation(request: CallableRequestShape): void {
  const data = asRecord(request.data);
  if (data.canonicalMailboxConfirmation !== CANONICAL_OPERATIONAL_MAILBOX_V1) {
    throw Object.assign(
      new Error(`canonicalMailboxConfirmation must exactly equal ${CANONICAL_OPERATIONAL_MAILBOX_V1}`),
      { code: "invalid-argument", errorCode: "require_canonical_confirmation_canonical_mailbox_confirmation_must", ruleId: "mail_provider_attestation_confirmation_mismatch" },
    );
  }
}

export async function getMailProviderAttestationStatus(
  request: CallableRequestShape,
) {
  const auth = assertNonGuestAuth(
    request,
    "integrations.mail_provider_attestation.read",
    ["super_admin", "admin", "manager", "viewer"],
  );
  const context = await resolveOperationalMailIdentityContext();
  const attestation = await readMailProviderAttestationProjection(context.identity);
  return {
    ok: true,
    attestation,
    behaviorLog: makeBehaviorLog(
      auth,
      "integrations.mail_provider_attestation.read",
      "success",
      "global",
      0,
    ),
  };
}

export async function attestMailProviderSubject(
  request: CallableRequestShape,
) {
  const auth = assertNonGuestAuth(
    request,
    "integrations.mail_provider_attestation.attest",
    ["super_admin"],
  );
  requireCanonicalConfirmation(request);
  const diagnosticChallengeToken = asRecord(request.data).diagnosticChallengeToken;
  const actorHash = hashMailProviderAttestationActor(auth.userId);
  const now = new Date();

  const attestation = await adminDb.runTransaction(async (transaction) => {
    const integrationRef = adminDb.doc("integrations/default");
    const diagnosticRef = adminDb.doc(MAIL_TRANSPORT_PROBE_STATUS_PATH);
    const attestationRef = adminDb.doc(MAIL_PROVIDER_ATTESTATION_PATH);
    const auditRef = adminDb.doc(MAIL_PROVIDER_ATTESTATION_AUDIT_PATH);
    const [integrationSnapshot, diagnosticSnapshot, auditSnapshot] = await Promise.all([
      transaction.get(integrationRef),
      transaction.get(diagnosticRef),
      transaction.get(auditRef),
    ]);
    const integrationRoot = integrationSnapshot.exists
      ? asRecord(integrationSnapshot.data())
      : {};
    const context = resolveOperationalMailIdentityContextFromConfigs(
      runtimeIntegration("mailSmtp", integrationRoot),
      runtimeIntegration("mailImap", integrationRoot),
      false,
    );
    if (!context.identity.identityMatch) {
      throw failedPrecondition(
        mailIdentityBlockReason(context.identity),
        context.identity.identityCode,
      );
    }

    const diagnosticData = diagnosticSnapshot.exists
      ? diagnosticSnapshot.data()
      : null;
    const diagnostic = diagnosticData
      ? safeMailTransportProbeProjection(
        diagnosticData,
        now,
        context.identity,
      )
      : null;
    if (
      !diagnostic
      || !diagnostic.valid
      || diagnostic.receiptIntegrityValid !== true
      || !diagnostic.receiptHash
      || diagnostic.probeState !== "fresh"
      || diagnostic.configFingerprint !== context.identity.configFingerprint
      || diagnostic.smtp.status !== "ok"
      || diagnostic.imap.status !== "ok"
      || !mailTransportDiagnosticChallengeMatches(
        diagnosticData,
        diagnosticChallengeToken,
      )
    ) {
      throw failedPrecondition(
        "fresh persisted SMTP and IMAP diagnostics are required before provider attestation",
        "mail_provider_attestation_fresh_diagnostic_required",
      );
    }

    const receipt = buildMailProviderAttestationReceipt({
      identity: context.identity,
      diagnostic: {
        configFingerprint: diagnostic.configFingerprint,
        diagnosticReceiptHash: diagnostic.receiptHash,
        checkedAtIso: diagnostic.checkedAtIso,
        expiresAtIso: diagnostic.expiresAtIso,
      },
      actorHash,
      now,
    });
    const auditRecord = buildMailProviderAttestationAuditRecord({
      action: "attest",
      status: "active",
      configFingerprint: context.identity.configFingerprint,
      correlationReceipt: receipt.receiptId,
      actorHash,
      now,
    });
    transaction.set(attestationRef, receipt);
    transaction.set(
      auditRef,
      appendBoundedMailProviderAttestationAudit(
        auditSnapshot.exists ? auditSnapshot.data() : null,
        auditRecord,
      ),
    );
    return safeMailProviderAttestationProjection(receipt, context.identity, now);
  });

  return {
    ok: true,
    attestation,
    behaviorLog: makeBehaviorLog(
      auth,
      "integrations.mail_provider_attestation.attest",
      "success",
      "global",
      0,
    ),
  };
}

export async function revokeMailProviderSubject(
  request: CallableRequestShape,
) {
  const auth = assertNonGuestAuth(
    request,
    "integrations.mail_provider_attestation.revoke",
    ["super_admin"],
  );
  requireCanonicalConfirmation(request);
  const actorHash = hashMailProviderAttestationActor(auth.userId);
  const now = new Date();

  const attestation = await adminDb.runTransaction(async (transaction) => {
    const integrationRef = adminDb.doc("integrations/default");
    const attestationRef = adminDb.doc(MAIL_PROVIDER_ATTESTATION_PATH);
    const auditRef = adminDb.doc(MAIL_PROVIDER_ATTESTATION_AUDIT_PATH);
    const [integrationSnapshot, attestationSnapshot, auditSnapshot] = await Promise.all([
      transaction.get(integrationRef),
      transaction.get(attestationRef),
      transaction.get(auditRef),
    ]);
    const integrationRoot = integrationSnapshot.exists
      ? asRecord(integrationSnapshot.data())
      : {};
    const context = resolveOperationalMailIdentityContextFromConfigs(
      runtimeIntegration("mailSmtp", integrationRoot),
      runtimeIntegration("mailImap", integrationRoot),
      false,
    );
    const stored = attestationSnapshot.exists ? attestationSnapshot.data() : null;
    const before = safeMailProviderAttestationProjection(stored, context.identity, now);
    const revoked = revokeMailProviderAttestationReceipt(stored, actorHash, now);
    const auditStatus = !attestationSnapshot.exists
      ? "missing"
      : before.reasonCode === "attestation_invalid_receipt"
        ? "invalid_receipt"
        : before.status === "revoked"
          ? "already_revoked"
          : "revoked";
    const correlationReceipt = revoked?.receiptId ?? before.correlationReceipt ?? "none";
    const auditRecord = buildMailProviderAttestationAuditRecord({
      action: "revoke",
      status: auditStatus,
      configFingerprint: revoked?.configFingerprint ?? context.identity.configFingerprint,
      correlationReceipt,
      actorHash,
      now,
    });

    if (revoked) {
      transaction.set(attestationRef, revoked);
    } else if (attestationSnapshot.exists) {
      transaction.delete(attestationRef);
    }
    transaction.set(
      auditRef,
      appendBoundedMailProviderAttestationAudit(
        auditSnapshot.exists ? auditSnapshot.data() : null,
        auditRecord,
      ),
    );
    return revoked
      ? safeMailProviderAttestationProjection(revoked, context.identity, now)
      : safeMailProviderAttestationProjection(null, context.identity, now);
  });

  return {
    ok: true,
    attestation,
    behaviorLog: makeBehaviorLog(
      auth,
      "integrations.mail_provider_attestation.revoke",
      "success",
      "global",
      0,
    ),
  };
}
