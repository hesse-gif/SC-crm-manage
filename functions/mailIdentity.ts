import { createHash } from "node:crypto";

export const CANONICAL_OPERATIONAL_MAILBOX_V1 = "scp@supercent.io" as const;
export const MAIL_IDENTITY_POLICY_VERSION = "mail-identity-v2" as const;

export const MAIL_IDENTITY_CODES = [
  "identity_ok_unverified_subject",
  "identity_mismatch",
  "identity_unknown",
  // Flu/Task-51 P0-1 (적대 리뷰): not an identity MISMATCH — the queue (auto-reply/campaign_outreach)
  // resolved a send to the canonical scp account for a conversation whose org is confidently
  // excluded from settings/mail_routing.scpAllowedOrgIds. Reuses the SAME "blocked, not failed,
  // humanRequired, no wasted retry attempt" queue state machine (markAutoReplyIdentityBlocked /
  // markCampaignOutreachIdentityBlocked via mailIdentityCodeFromError) instead of a new one.
  "org_scp_not_assigned",
] as const;

export type MailIdentityCode = typeof MAIL_IDENTITY_CODES[number];
export type MailIdentityMode = "receive" | "auto_reply" | "auto_send" | "manual_send";
export type MailProbeFingerprintState = "fresh" | "probe_stale_config_changed";

export type ResolvedMailIdentityInput = {
  readonly smtp?: {
    readonly host?: unknown;
    readonly port?: unknown;
    readonly secure?: unknown;
    readonly authUser?: unknown;
    readonly from?: unknown;
    readonly credentialFingerprint?: unknown;
  };
  readonly replyTo?: unknown;
  readonly imap?: {
    readonly host?: unknown;
    readonly port?: unknown;
    readonly secure?: unknown;
    readonly authUser?: unknown;
    readonly mailbox?: unknown;
    readonly credentialFingerprint?: unknown;
  };
  /**
   * Optional deployment/config hook. It may repeat the canonical mailbox, but
   * any different value disables identity resolution instead of authorizing an
   * alias. This makes the hook availability-narrowing only.
   */
  readonly canonicalMailboxOverride?: unknown;
  /**
   * PLAN-ORG-MAIL-IDENTITY Slice 1: the mailbox every identity field is compared
   * against. Defaults to CANONICAL_OPERATIONAL_MAILBOX_V1, so every existing call
   * site (none of which passes this) resolves byte-identically to before. Only
   * per-account resolution (mailProfiles.ts resolveMailIdentityContextForAccount)
   * supplies a non-default value.
   */
  readonly expectedMailbox?: unknown;
};

export type MailIdentitySnapshot = {
  readonly identityMatch: boolean;
  readonly identityCode: MailIdentityCode;
  readonly configFingerprint: string;
  readonly providerSubjectVerified: boolean;
  readonly mismatches: string[];
};

const IDENTITY_FIELDS = [
  "smtp.authUser",
  "smtp.from",
  "replyTo",
  "imap.authUser",
] as const;

const SAFE_MISMATCH_FIELDS = new Set<string>([
  "canonicalMailboxOverride",
  ...IDENTITY_FIELDS,
]);

const MAILBOX_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Normalize one RFC-style mailbox value without retaining its display name. */
export function normalizeMailboxAddress(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const angleMatches = [...trimmed.matchAll(/<\s*([^<>]+?)\s*>/g)];
  if (angleMatches.length > 1) return "";
  const angleAddress = angleMatches[0]?.[1] ?? "";
  if (angleMatches.length === 1) {
    const displayName = trimmed.replace(angleMatches[0]?.[0] ?? "", "").trim();
    if (displayName.includes("@") || /[<>]/.test(displayName)) return "";
  } else if (/[<>]/.test(trimmed)) {
    return "";
  }
  const candidate = (angleAddress || trimmed)
    .replace(/^mailto:/i, "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
  const normalized = candidate.trim().toLowerCase();
  return MAILBOX_PATTERN.test(normalized) ? normalized : "";
}

function fingerprint(normalized: {
  readonly canonicalMailbox: string;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly smtpSecure: boolean;
  readonly smtpAuthUser: string;
  readonly smtpFrom: string;
  readonly smtpCredentialFingerprint: string;
  readonly replyTo: string;
  readonly imapHost: string;
  readonly imapPort: number;
  readonly imapSecure: boolean;
  readonly imapAuthUser: string;
  readonly imapMailbox: string;
  readonly imapCredentialFingerprint: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: MAIL_IDENTITY_POLICY_VERSION, ...normalized }))
    .digest("hex");
}

function normalizeHost(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, 255) : "";
}

function normalizePort(value: unknown): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : 0;
  return Number.isInteger(numeric) && numeric > 0 && numeric <= 65_535 ? numeric : 0;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeConfigToken(value: unknown, maxLength = 180): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

/**
 * Resolve the canonical SMTP/Reply-To/IMAP identity using strings only.
 * Connectivity and From equality never prove the authenticated provider
 * subject on their own, so providerSubjectVerified stays false (fail-closed)
 * unless the caller supplies the result of the persisted attestation validator
 * as the second argument. Configuration/public/env values have no authorization
 * field and therefore cannot directly activate live sends.
 */
export function resolveMailIdentity(
  input: ResolvedMailIdentityInput,
  providerSubjectAttested = false,
): MailIdentitySnapshot {
  const expectedMailbox = normalizeMailboxAddress(input.expectedMailbox) || CANONICAL_OPERATIONAL_MAILBOX_V1;
  const requestedOverride = normalizeMailboxAddress(input.canonicalMailboxOverride);
  const overrideProvided = input.canonicalMailboxOverride !== undefined;
  const overrideRejected = overrideProvided
    && requestedOverride !== expectedMailbox;
  const canonicalMailbox = overrideRejected ? "" : expectedMailbox;
  const normalized = {
    canonicalMailbox,
    smtpHost: normalizeHost(input.smtp?.host),
    smtpPort: normalizePort(input.smtp?.port),
    smtpSecure: normalizeBoolean(input.smtp?.secure),
    smtpAuthUser: normalizeMailboxAddress(input.smtp?.authUser),
    smtpFrom: normalizeMailboxAddress(input.smtp?.from),
    smtpCredentialFingerprint: normalizeConfigToken(input.smtp?.credentialFingerprint),
    replyTo: normalizeMailboxAddress(input.replyTo),
    imapHost: normalizeHost(input.imap?.host),
    imapPort: normalizePort(input.imap?.port),
    imapSecure: normalizeBoolean(input.imap?.secure),
    imapAuthUser: normalizeMailboxAddress(input.imap?.authUser),
    imapMailbox: normalizeConfigToken(input.imap?.mailbox, 255),
    imapCredentialFingerprint: normalizeConfigToken(input.imap?.credentialFingerprint),
  };
  const values = [
    normalized.smtpAuthUser,
    normalized.smtpFrom,
    normalized.replyTo,
    normalized.imapAuthUser,
  ] as const;
  const missingFields = IDENTITY_FIELDS.filter((_field, index) => !values[index]);
  const mismatchedFields = IDENTITY_FIELDS.filter(
    (_field, index) => Boolean(values[index]) && values[index] !== expectedMailbox,
  );
  const mismatches = [
    ...(overrideRejected ? ["canonicalMailboxOverride"] : []),
    ...missingFields,
    ...mismatchedFields,
  ];
  const identityCode: MailIdentityCode = overrideRejected || missingFields.length > 0
    ? "identity_unknown"
    : mismatchedFields.length > 0
      ? "identity_mismatch"
      : "identity_ok_unverified_subject";

  return {
    identityMatch: identityCode === "identity_ok_unverified_subject",
    identityCode,
    configFingerprint: fingerprint(normalized),
    providerSubjectVerified:
      identityCode === "identity_ok_unverified_subject" && providerSubjectAttested === true,
    mismatches,
  };
}

export function mailIdentityBlocksMode(
  snapshot: MailIdentitySnapshot,
  mode: MailIdentityMode,
): boolean {
  if (mode === "receive") return !snapshot.identityMatch;
  return !snapshot.identityMatch || !snapshot.providerSubjectVerified;
}

/** Connectivity probes are useful after string equality, even though sends remain blocked. */
export function mailIdentityAllowsTransportProbe(snapshot: MailIdentitySnapshot): boolean {
  return snapshot.identityMatch
    && snapshot.identityCode === "identity_ok_unverified_subject";
}

export function mailIdentityBlockReason(snapshot: MailIdentitySnapshot): string {
  if (snapshot.identityCode === "identity_mismatch") {
    return "canonical mailbox identity does not match the resolved SMTP/IMAP configuration";
  }
  if (snapshot.identityCode === "identity_unknown") {
    return "canonical mailbox identity cannot be resolved from the SMTP/IMAP configuration";
  }
  return "canonical mailbox strings match, but the authenticated provider subject is unverified";
}

export function mailIdentityBlockedError(
  snapshot: MailIdentitySnapshot,
  operation: string,
): Error {
  return Object.assign(
    new Error(`outbound mail safety lock active: ${snapshot.identityCode} (${operation})`),
    {
      code: "failed-precondition", errorCode: "mail_identity_blocked_error_outbound_mail_safety_lock_active",
      ruleId: snapshot.identityCode,
      mailIdentityCode: snapshot.identityCode,
      humanRequired: true,
    },
  );
}

export function isMailIdentityCode(value: unknown): value is MailIdentityCode {
  return typeof value === "string"
    && (MAIL_IDENTITY_CODES as readonly string[]).includes(value);
}

export function mailIdentityCodeFromError(error: unknown): MailIdentityCode | null {
  if (error && typeof error === "object") {
    const explicit = (error as Record<string, unknown>).mailIdentityCode;
    if (isMailIdentityCode(explicit)) return explicit;
  }
  const text = error instanceof Error ? error.message : String(error ?? "");
  return MAIL_IDENTITY_CODES.find((code) => text.includes(code)) ?? null;
}

export function resolveMailProbeFingerprintState(
  storedConfigFingerprint: unknown,
  currentConfigFingerprint: unknown,
): MailProbeFingerprintState {
  if (typeof currentConfigFingerprint !== "string" || !SHA256_PATTERN.test(currentConfigFingerprint)) {
    return "probe_stale_config_changed";
  }
  return typeof storedConfigFingerprint === "string"
    && storedConfigFingerprint === currentConfigFingerprint
    ? "fresh"
    : "probe_stale_config_changed";
}

export function safeMailIdentitySnapshot(value: unknown): MailIdentitySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isMailIdentityCode(record.identityCode)) return null;
  if (typeof record.configFingerprint !== "string" || !SHA256_PATTERN.test(record.configFingerprint)) return null;
  const mismatches = Array.isArray(record.mismatches)
    ? record.mismatches.filter((item): item is string => typeof item === "string" && SAFE_MISMATCH_FIELDS.has(item))
    : [];
  return {
    identityMatch: record.identityMatch === true,
    identityCode: record.identityCode,
    configFingerprint: record.configFingerprint,
    providerSubjectVerified: record.providerSubjectVerified === true,
    mismatches,
  };
}
