import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import {
  CANONICAL_OPERATIONAL_MAILBOX_V1,
  type MailIdentitySnapshot,
} from "./mailIdentity";
import { asRecord, asString } from "./shared";

export const MAIL_PROVIDER_ATTESTATION_PATH =
  "integration_attestations/mail-provider-subject";
export const MAIL_PROVIDER_ATTESTATION_AUDIT_PATH =
  "integration_attestation_audit/mail-provider-subject";
export const MAIL_PROVIDER_ATTESTATION_SCHEMA_VERSION =
  "mail-provider-subject-attestation-v1" as const;
export const MAIL_PROVIDER_ATTESTATION_AUDIT_SCHEMA_VERSION =
  "mail-provider-subject-attestation-audit-v1" as const;
export const MAIL_PROVIDER_ATTESTATION_PUBLIC_SCHEMA_VERSION =
  "mail-provider-subject-attestation-public-v1" as const;
export const MAIL_PROVIDER_ATTESTATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAIL_PROVIDER_ATTESTATION_AUDIT_LIMIT = 50;

export type MailProviderAttestationStatus =
  | "active"
  | "expired"
  | "revoked"
  | "missing"
  | "config_changed";

export type MailProviderAttestationReasonCode =
  | "attestation_active"
  | "attestation_missing"
  | "attestation_expired"
  | "attestation_revoked"
  | "attestation_config_changed"
  | "attestation_invalid_receipt";

export type MailProviderAttestationPublicProjection = {
  readonly schemaVersion: typeof MAIL_PROVIDER_ATTESTATION_PUBLIC_SCHEMA_VERSION;
  readonly status: MailProviderAttestationStatus;
  readonly providerSubjectVerified: boolean;
  // PLAN-ORG-MAIL-IDENTITY Slice 1: widened from `typeof CANONICAL_OPERATIONAL_MAILBOX_V1`
  // to `string` so future per-account contexts can carry a non-canonical mailbox. Every
  // runtime assignment below still writes CANONICAL_OPERATIONAL_MAILBOX_V1 — no behavior change.
  readonly canonicalMailbox: string;
  readonly attestedAt: string | null;
  readonly expiresAt: string | null;
  readonly diagnosticCheckedAt: string | null;
  readonly diagnosticExpiresAt: string | null;
  readonly fingerprintPrefix: string;
  readonly currentFingerprintPrefix: string;
  readonly correlationReceipt: string | null;
  readonly reasonCode: MailProviderAttestationReasonCode;
  readonly reasonKo: string;
};

export type MailProviderAttestationDiagnosticEvidence = {
  readonly configFingerprint: string;
  readonly diagnosticReceiptHash: string;
  readonly checkedAtIso: string;
  readonly expiresAtIso: string;
};

export type MailProviderAttestationReceipt = {
  readonly schemaVersion: typeof MAIL_PROVIDER_ATTESTATION_SCHEMA_VERSION;
  readonly receiptId: string;
  readonly canonicalMailbox: string;
  readonly configFingerprint: string;
  readonly diagnosticReceiptHash: string;
  readonly diagnosticCheckedAt: string;
  readonly diagnosticExpiresAt: string;
  readonly attestedAt: string;
  readonly actorHash: string;
  readonly expiresAt: string;
  readonly state: "active" | "revoked";
  readonly revokedAt?: string;
  readonly revokedByActorHash?: string;
  readonly receiptBindingHash: string;
  readonly stateBindingHash: string;
};

export type MailProviderAttestationAuditRecord = {
  readonly schemaVersion: typeof MAIL_PROVIDER_ATTESTATION_AUDIT_SCHEMA_VERSION;
  readonly action: "attest" | "revoke";
  readonly status: "active" | "revoked" | "already_revoked" | "missing" | "invalid_receipt";
  readonly fingerprintPrefix: string;
  readonly correlationReceipt: string;
  readonly actorHash: string;
  readonly occurredAt: string;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const REASON_COPY: Record<
  MailProviderAttestationReasonCode,
  { status: MailProviderAttestationStatus; reasonKo: string }
> = {
  attestation_active: {
    status: "active",
    reasonKo: "현재 메일 설정과 진단 영수증에 바인딩된 제공자 주체 확인이 유효합니다.",
  },
  attestation_missing: {
    status: "missing",
    reasonKo: "SMTP·IMAP 연결 진단을 다시 실행한 뒤 canonical 메일함을 확인해 주세요.",
  },
  attestation_expired: {
    status: "expired",
    reasonKo: "제공자 주체 확인이 만료되었습니다. 연결 진단 후 다시 확인해 주세요.",
  },
  attestation_revoked: {
    status: "revoked",
    reasonKo: "제공자 주체 확인이 해제되었습니다. 연결 진단 후 다시 확인해 주세요.",
  },
  attestation_config_changed: {
    status: "config_changed",
    reasonKo: "SMTP·IMAP 또는 발신자 설정이 변경되었습니다. 연결 진단과 확인을 다시 실행해 주세요.",
  },
  attestation_invalid_receipt: {
    status: "missing",
    reasonKo: "확인 영수증이 올바르지 않습니다. 연결 진단 후 제공자 주체 확인을 다시 실행해 주세요.",
  },
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function validIso(value: string): boolean {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}

export function hashMailProviderAttestationActor(userId: string): string {
  return sha256(`mail-provider-attestation-actor-v1:${userId}`);
}

export function mailProviderFingerprintPrefix(value: unknown): string {
  return typeof value === "string" && SHA256_PATTERN.test(value)
    ? value.slice(0, 12)
    : "";
}

function receiptBindingHash(input: {
  readonly receiptId: string;
  readonly canonicalMailbox: string;
  readonly configFingerprint: string;
  readonly diagnosticReceiptHash: string;
  readonly diagnosticCheckedAt: string;
  readonly diagnosticExpiresAt: string;
  readonly attestedAt: string;
  readonly actorHash: string;
  readonly expiresAt: string;
}): string {
  return sha256(JSON.stringify({
    schemaVersion: MAIL_PROVIDER_ATTESTATION_SCHEMA_VERSION,
    receiptId: input.receiptId,
    canonicalMailbox: input.canonicalMailbox,
    configFingerprint: input.configFingerprint,
    diagnosticReceiptHash: input.diagnosticReceiptHash,
    diagnosticCheckedAt: input.diagnosticCheckedAt,
    diagnosticExpiresAt: input.diagnosticExpiresAt,
    attestedAt: input.attestedAt,
    actorHash: input.actorHash,
    expiresAt: input.expiresAt,
  }));
}

function stateBindingHash(input: {
  readonly receiptBindingHash: string;
  readonly state: "active" | "revoked";
  readonly revokedAt?: string;
  readonly revokedByActorHash?: string;
}): string {
  return sha256(JSON.stringify({
    schemaVersion: MAIL_PROVIDER_ATTESTATION_SCHEMA_VERSION,
    receiptBindingHash: input.receiptBindingHash,
    state: input.state,
    revokedAt: input.revokedAt ?? "",
    revokedByActorHash: input.revokedByActorHash ?? "",
  }));
}

function safeStoredReceipt(value: unknown): MailProviderAttestationReceipt | null {
  const record = asRecord(value);
  const schemaVersion = asString(record.schemaVersion);
  const receiptId = asString(record.receiptId);
  const canonicalMailbox = asString(record.canonicalMailbox);
  const configFingerprint = asString(record.configFingerprint);
  const diagnosticReceiptHash = asString(record.diagnosticReceiptHash);
  const diagnosticCheckedAt = asString(record.diagnosticCheckedAt);
  const diagnosticExpiresAt = asString(record.diagnosticExpiresAt);
  const attestedAt = asString(record.attestedAt);
  const actorHash = asString(record.actorHash);
  const expiresAt = asString(record.expiresAt);
  const state = asString(record.state);
  const revokedAt = asString(record.revokedAt);
  const revokedByActorHash = asString(record.revokedByActorHash);
  const storedReceiptBindingHash = asString(record.receiptBindingHash);
  const storedStateBindingHash = asString(record.stateBindingHash);

  if (
    schemaVersion !== MAIL_PROVIDER_ATTESTATION_SCHEMA_VERSION
    || !UUID_PATTERN.test(receiptId)
    || canonicalMailbox !== CANONICAL_OPERATIONAL_MAILBOX_V1
    || !SHA256_PATTERN.test(configFingerprint)
    || !SHA256_PATTERN.test(diagnosticReceiptHash)
    || !validIso(diagnosticCheckedAt)
    || !validIso(diagnosticExpiresAt)
    || !validIso(attestedAt)
    || !SHA256_PATTERN.test(actorHash)
    || !validIso(expiresAt)
    || (state !== "active" && state !== "revoked")
  ) {
    return null;
  }
  const diagnosticCheckedAtMs = Date.parse(diagnosticCheckedAt);
  const diagnosticExpiresAtMs = Date.parse(diagnosticExpiresAt);
  const attestedAtMs = Date.parse(attestedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (
    diagnosticCheckedAtMs > attestedAtMs
    || diagnosticExpiresAtMs <= attestedAtMs
    || expiresAtMs <= attestedAtMs
  ) {
    return null;
  }
  if (
    (state === "active" && (revokedAt || revokedByActorHash))
    || (
      state === "revoked"
      && (
        !validIso(revokedAt)
        || Date.parse(revokedAt) < attestedAtMs
        || !SHA256_PATTERN.test(revokedByActorHash)
      )
    )
  ) {
    return null;
  }

  const expectedReceiptBindingHash = receiptBindingHash({
    receiptId,
    canonicalMailbox,
    configFingerprint,
    diagnosticReceiptHash,
    diagnosticCheckedAt,
    diagnosticExpiresAt,
    attestedAt,
    actorHash,
    expiresAt,
  });
  const expectedStateBindingHash = stateBindingHash({
    receiptBindingHash: storedReceiptBindingHash,
    state,
    ...(revokedAt ? { revokedAt } : {}),
    ...(revokedByActorHash ? { revokedByActorHash } : {}),
  });
  if (
    !safeHashEqual(storedReceiptBindingHash, expectedReceiptBindingHash)
    || !safeHashEqual(storedStateBindingHash, expectedStateBindingHash)
  ) {
    return null;
  }

  return {
    schemaVersion: MAIL_PROVIDER_ATTESTATION_SCHEMA_VERSION,
    receiptId,
    canonicalMailbox: CANONICAL_OPERATIONAL_MAILBOX_V1,
    configFingerprint,
    diagnosticReceiptHash,
    diagnosticCheckedAt,
    diagnosticExpiresAt,
    attestedAt,
    actorHash,
    expiresAt,
    state,
    ...(revokedAt ? { revokedAt } : {}),
    ...(revokedByActorHash ? { revokedByActorHash } : {}),
    receiptBindingHash: storedReceiptBindingHash,
    stateBindingHash: storedStateBindingHash,
  };
}

function projection(
  reasonCode: MailProviderAttestationReasonCode,
  identity: MailIdentitySnapshot,
  receipt?: MailProviderAttestationReceipt,
): MailProviderAttestationPublicProjection {
  const reason = REASON_COPY[reasonCode];
  return {
    schemaVersion: MAIL_PROVIDER_ATTESTATION_PUBLIC_SCHEMA_VERSION,
    status: reason.status,
    providerSubjectVerified: reasonCode === "attestation_active",
    canonicalMailbox: CANONICAL_OPERATIONAL_MAILBOX_V1,
    attestedAt: receipt?.attestedAt ?? null,
    expiresAt: receipt?.expiresAt ?? null,
    diagnosticCheckedAt: receipt?.diagnosticCheckedAt ?? null,
    diagnosticExpiresAt: receipt?.diagnosticExpiresAt ?? null,
    fingerprintPrefix: mailProviderFingerprintPrefix(
      receipt?.configFingerprint ?? identity.configFingerprint,
    ),
    currentFingerprintPrefix: mailProviderFingerprintPrefix(identity.configFingerprint),
    correlationReceipt: receipt?.receiptId ?? null,
    reasonCode,
    reasonKo: reason.reasonKo,
  };
}

export function safeMailProviderAttestationProjection(
  value: unknown,
  identity: MailIdentitySnapshot,
  now = new Date(),
): MailProviderAttestationPublicProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return projection("attestation_missing", identity);
  }
  const receipt = safeStoredReceipt(value);
  if (!receipt) return projection("attestation_invalid_receipt", identity);
  if (receipt.state === "revoked") return projection("attestation_revoked", identity, receipt);
  if (
    !identity.identityMatch
    || receipt.canonicalMailbox !== CANONICAL_OPERATIONAL_MAILBOX_V1
    || receipt.configFingerprint !== identity.configFingerprint
  ) {
    return projection("attestation_config_changed", identity, receipt);
  }
  if (Date.parse(receipt.expiresAt) <= now.getTime()) {
    return projection("attestation_expired", identity, receipt);
  }
  return projection("attestation_active", identity, receipt);
}

export async function readMailProviderAttestationProjection(
  identity: MailIdentitySnapshot,
  now = new Date(),
): Promise<MailProviderAttestationPublicProjection> {
  const snapshot = await adminDb.doc(MAIL_PROVIDER_ATTESTATION_PATH).get();
  return safeMailProviderAttestationProjection(
    snapshot.exists ? snapshot.data() : null,
    identity,
    now,
  );
}

export function buildMailProviderAttestationReceipt(input: {
  readonly identity: MailIdentitySnapshot;
  readonly diagnostic: MailProviderAttestationDiagnosticEvidence;
  readonly actorHash: string;
  readonly now?: Date;
  readonly receiptId?: string;
}): MailProviderAttestationReceipt {
  const now = input.now ?? new Date();
  const attestedAt = now.toISOString();
  const receiptId = input.receiptId ?? randomUUID();
  const expiresAt = new Date(now.getTime() + MAIL_PROVIDER_ATTESTATION_TTL_MS).toISOString();
  if (
    !input.identity.identityMatch
    || !SHA256_PATTERN.test(input.identity.configFingerprint)
    || input.diagnostic.configFingerprint !== input.identity.configFingerprint
    || !SHA256_PATTERN.test(input.diagnostic.diagnosticReceiptHash)
    || !validIso(input.diagnostic.checkedAtIso)
    || !validIso(input.diagnostic.expiresAtIso)
    || Date.parse(input.diagnostic.checkedAtIso) > now.getTime()
    || Date.parse(input.diagnostic.expiresAtIso) <= now.getTime()
    || !SHA256_PATTERN.test(input.actorHash)
    || !UUID_PATTERN.test(receiptId)
  ) {
    throw new Error("invalid mail provider attestation receipt input");
  }
  const immutable = {
    receiptId,
    canonicalMailbox: CANONICAL_OPERATIONAL_MAILBOX_V1,
    configFingerprint: input.identity.configFingerprint,
    diagnosticReceiptHash: input.diagnostic.diagnosticReceiptHash,
    diagnosticCheckedAt: input.diagnostic.checkedAtIso,
    diagnosticExpiresAt: input.diagnostic.expiresAtIso,
    attestedAt,
    actorHash: input.actorHash,
    expiresAt,
  };
  const binding = receiptBindingHash(immutable);
  return {
    schemaVersion: MAIL_PROVIDER_ATTESTATION_SCHEMA_VERSION,
    ...immutable,
    state: "active",
    receiptBindingHash: binding,
    stateBindingHash: stateBindingHash({
      receiptBindingHash: binding,
      state: "active",
    }),
  };
}

export function revokeMailProviderAttestationReceipt(
  value: unknown,
  actorHash: string,
  now = new Date(),
): MailProviderAttestationReceipt | null {
  const receipt = safeStoredReceipt(value);
  if (!receipt) return null;
  if (receipt.state === "revoked") return receipt;
  const revokedAt = now.toISOString();
  return {
    ...receipt,
    state: "revoked",
    revokedAt,
    revokedByActorHash: actorHash,
    stateBindingHash: stateBindingHash({
      receiptBindingHash: receipt.receiptBindingHash,
      state: "revoked",
      revokedAt,
      revokedByActorHash: actorHash,
    }),
  };
}

export function buildMailProviderAttestationAuditRecord(input: {
  readonly action: MailProviderAttestationAuditRecord["action"];
  readonly status: MailProviderAttestationAuditRecord["status"];
  readonly configFingerprint: string;
  readonly correlationReceipt?: string;
  readonly actorHash: string;
  readonly now?: Date;
}): MailProviderAttestationAuditRecord {
  return {
    schemaVersion: MAIL_PROVIDER_ATTESTATION_AUDIT_SCHEMA_VERSION,
    action: input.action,
    status: input.status,
    fingerprintPrefix: mailProviderFingerprintPrefix(input.configFingerprint),
    correlationReceipt: (input.correlationReceipt ?? "none").slice(0, 64),
    actorHash: input.actorHash,
    occurredAt: (input.now ?? new Date()).toISOString(),
  };
}

export function appendBoundedMailProviderAttestationAudit(
  value: unknown,
  record: MailProviderAttestationAuditRecord,
): {
  readonly schemaVersion: typeof MAIL_PROVIDER_ATTESTATION_AUDIT_SCHEMA_VERSION;
  readonly records: MailProviderAttestationAuditRecord[];
} {
  const existing = asRecord(value);
  const records = Array.isArray(existing.records)
    ? existing.records
      .map((item) => {
        const row = asRecord(item);
        const schemaVersion = asString(row.schemaVersion);
        const action = asString(row.action);
        const status = asString(row.status);
        const fingerprintPrefix = asString(row.fingerprintPrefix).slice(0, 12);
        const correlationReceipt = asString(row.correlationReceipt).slice(0, 64);
        const actorHash = asString(row.actorHash);
        const occurredAt = asString(row.occurredAt);
        if (
          schemaVersion !== MAIL_PROVIDER_ATTESTATION_AUDIT_SCHEMA_VERSION
          || (action !== "attest" && action !== "revoke")
          || !["active", "revoked", "already_revoked", "missing", "invalid_receipt"].includes(status)
          || !/^[a-f0-9]{0,12}$/.test(fingerprintPrefix)
          || !correlationReceipt
          || !SHA256_PATTERN.test(actorHash)
          || !validIso(occurredAt)
        ) {
          return null;
        }
        return {
          schemaVersion: MAIL_PROVIDER_ATTESTATION_AUDIT_SCHEMA_VERSION,
          action,
          status: status as MailProviderAttestationAuditRecord["status"],
          fingerprintPrefix,
          correlationReceipt,
          actorHash,
          occurredAt,
        } satisfies MailProviderAttestationAuditRecord;
      })
      .filter((item): item is MailProviderAttestationAuditRecord => item !== null)
    : [];
  return {
    schemaVersion: MAIL_PROVIDER_ATTESTATION_AUDIT_SCHEMA_VERSION,
    records: [...records, record].slice(-MAIL_PROVIDER_ATTESTATION_AUDIT_LIMIT),
  };
}
