import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { adminDb } from "./firebaseAdmin";
import { resolveImapMailbox, safeImapMailboxName } from "./mailImapConfiguration";
import {
  mailIdentityAllowsTransportProbe,
  resolveMailProbeFingerprintState,
  safeMailIdentitySnapshot,
  type MailIdentitySnapshot,
  type MailProbeFingerprintState,
} from "./mailIdentity";
import {
  resolveOperationalMailIdentity,
  resolveOperationalMailIdentityContext,
  type OperationalMailIdentityContext,
} from "./mailProfiles";
import {
  envSecret,
  liveIntegrationsEnabled,
} from "./liveIntegrations";
import { assertStagingExternalSideEffectAllowed } from "./stagingSafety";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";

export const MAIL_TRANSPORT_PROBE_STATUS_PATH = "integration_probe_status/mail-transport";
export const DIAGNOSTIC_TIMEOUT_MS = 10_000;
const DIAGNOSTIC_PROBE_MAX_BYTES = 64_000;
const DIAGNOSTIC_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export const MAIL_DIAGNOSTIC_CODES = [
  "smtp_ok",
  "imap_ok",
  "imap_empty",
  "runtime_disabled",
  "configuration_missing",
  "secret_not_bound",
  "timeout",
  "authentication_failed",
  "tls_failed",
  "connection_failed",
  "mailbox_not_found",
  "mailbox_list_failed",
  "mailbox_open_failed",
  "message_probe_failed",
  "identity_mismatch",
  "identity_unknown",
  "probe_stale_config_changed",
  "unexpected_failure",
] as const;

export type MailDiagnosticCode = typeof MAIL_DIAGNOSTIC_CODES[number];
export type MailDiagnosticLaneStatus = "ok" | "failed" | "skipped";

export type MailTransportProbeLane = {
  readonly status: MailDiagnosticLaneStatus;
  readonly code: MailDiagnosticCode;
  readonly checkedAtIso: string;
  readonly latencyMs: number;
  readonly runtimeSecretBound: boolean;
  readonly mailbox?: string;
  readonly messageProbe?: "parsed" | "empty" | "not_run";
};

export type MailTransportProbeStatus = {
  readonly valid: boolean;
  readonly checkedAtIso: string;
  readonly expiresAtIso: string;
  readonly operationalReady: boolean;
  readonly smtp: MailTransportProbeLane;
  readonly imap: MailTransportProbeLane;
  readonly configFingerprint?: string;
  readonly probeState?: MailProbeFingerprintState;
  readonly identity?: MailIdentitySnapshot;
  readonly attestationChallengeHash?: string;
  readonly receiptHash?: string;
  readonly receiptIntegrityValid?: boolean;
};

const DIAGNOSTIC_CODE_SET = new Set<string>(MAIL_DIAGNOSTIC_CODES);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isMailDiagnosticLaneStatus(value: string): value is MailDiagnosticLaneStatus {
  return value === "ok" || value === "failed" || value === "skipped";
}

function isMailDiagnosticCode(value: string): value is MailDiagnosticCode {
  return DIAGNOSTIC_CODE_SET.has(value);
}

function diagnosticError(code: MailDiagnosticCode): Error {
  return Object.assign(new Error(code), { diagnosticCode: code });
}

function diagnosticCode(error: unknown, fallback: MailDiagnosticCode): MailDiagnosticCode {
  const record = asRecord(error);
  const explicit = asString(record.diagnosticCode, "");
  if (DIAGNOSTIC_CODE_SET.has(explicit)) return explicit as MailDiagnosticCode;

  const providerCode = asString(record.code, "").toUpperCase();
  const providerCommand = asString(record.command, "").toUpperCase();
  const responseCode = Number(record.responseCode ?? 0);
  if (providerCode === "EAUTH" || providerCode.includes("AUTH") || providerCommand.includes("AUTH") || responseCode === 534 || responseCode === 535) {
    return "authentication_failed";
  }
  if (providerCode.includes("CERT") || providerCode.includes("TLS") || providerCode === "ERR_SSL") {
    return "tls_failed";
  }
  if (providerCode === "ETIMEDOUT" || providerCode === "ESOCKET" || providerCode === "ECONNRESET") {
    return "timeout";
  }
  if (providerCode === "ECONNREFUSED" || providerCode === "ENOTFOUND" || providerCode === "ECONNECTION") {
    return "connection_failed";
  }
  return fallback;
}

async function withDiagnosticTimeout<T>(
  operation: () => Promise<T>,
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(diagnosticError("timeout"));
        }, DIAGNOSTIC_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function laneResult(
  startedAtMs: number,
  checkedAtIso: string,
  status: MailDiagnosticLaneStatus,
  code: MailDiagnosticCode,
  runtimeSecretBound: boolean,
  extra: Pick<MailTransportProbeLane, "mailbox" | "messageProbe"> = {},
): MailTransportProbeLane {
  return {
    status,
    code,
    checkedAtIso,
    latencyMs: Math.max(0, Math.min(Date.now() - startedAtMs, DIAGNOSTIC_TIMEOUT_MS)),
    runtimeSecretBound,
    ...extra,
  };
}

async function probeSmtp(
  checkedAtIso: string,
  context: OperationalMailIdentityContext,
): Promise<MailTransportProbeLane> {
  const startedAtMs = Date.now();
  const runtimeSecretBound = envSecret("SMTP_PASSWORD").length > 0;
  if (!liveIntegrationsEnabled("smtp")) {
    return laneResult(startedAtMs, checkedAtIso, "skipped", "runtime_disabled", runtimeSecretBound);
  }

  const { host, port, secure, authUser: user, from } = context.smtp;
  if (!host || !user || !from) {
    return laneResult(startedAtMs, checkedAtIso, "failed", "configuration_missing", runtimeSecretBound);
  }
  if (!runtimeSecretBound) {
    return laneResult(startedAtMs, checkedAtIso, "failed", "secret_not_bound", false);
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass: envSecret("SMTP_PASSWORD") },
    connectionTimeout: DIAGNOSTIC_TIMEOUT_MS,
    greetingTimeout: DIAGNOSTIC_TIMEOUT_MS,
    socketTimeout: DIAGNOSTIC_TIMEOUT_MS,
  });
  try {
    await withDiagnosticTimeout(() => transporter.verify(), () => transporter.close());
    return laneResult(startedAtMs, checkedAtIso, "ok", "smtp_ok", true);
  } catch (error) {
    return laneResult(startedAtMs, checkedAtIso, "failed", diagnosticCode(error, "connection_failed"), true);
  } finally {
    transporter.close();
  }
}

async function probeImap(
  checkedAtIso: string,
  context: OperationalMailIdentityContext,
): Promise<MailTransportProbeLane> {
  const startedAtMs = Date.now();
  const runtimeSecretBound = envSecret("IMAP_PASSWORD").length > 0;
  const mailbox = resolveImapMailbox(context.imap.config);
  const safeMailbox = safeImapMailboxName(mailbox);
  if (!liveIntegrationsEnabled("imap")) {
    return laneResult(startedAtMs, checkedAtIso, "skipped", "runtime_disabled", runtimeSecretBound, { mailbox: safeMailbox, messageProbe: "not_run" });
  }

  const { host, port, secure, authUser: user } = context.imap;
  if (!host || !user) {
    return laneResult(startedAtMs, checkedAtIso, "failed", "configuration_missing", runtimeSecretBound, { mailbox: safeMailbox, messageProbe: "not_run" });
  }
  if (!runtimeSecretBound) {
    return laneResult(startedAtMs, checkedAtIso, "failed", "secret_not_bound", false, { mailbox: safeMailbox, messageProbe: "not_run" });
  }

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass: envSecret("IMAP_PASSWORD") },
    logger: false,
    connectionTimeout: DIAGNOSTIC_TIMEOUT_MS,
    greetingTimeout: DIAGNOSTIC_TIMEOUT_MS,
    socketTimeout: DIAGNOSTIC_TIMEOUT_MS,
    maxLiteralSize: DIAGNOSTIC_PROBE_MAX_BYTES,
  });

  try {
    const messageProbe = await withDiagnosticTimeout(async (): Promise<"parsed" | "empty"> => {
      try {
        await client.connect();
      } catch (error) {
        throw diagnosticError(diagnosticCode(error, "connection_failed"));
      }

      let mailboxes: Awaited<ReturnType<ImapFlow["list"]>>;
      try {
        mailboxes = await client.list();
      } catch {
        throw diagnosticError("mailbox_list_failed");
      }
      const listed = mailboxes.some((entry) => entry.path.toLocaleLowerCase() === mailbox.toLocaleLowerCase());
      if (!listed) throw diagnosticError("mailbox_not_found");

      let opened: Awaited<ReturnType<ImapFlow["mailboxOpen"]>>;
      try {
        opened = await client.mailboxOpen(mailbox, { readOnly: true });
      } catch {
        throw diagnosticError("mailbox_open_failed");
      }
      if (opened.exists <= 0) return "empty";

      try {
        const fetched = await client.fetchOne(
          "*",
          { source: { maxLength: DIAGNOSTIC_PROBE_MAX_BYTES } },
          { uid: false },
        );
        if (!fetched || !fetched.source) throw diagnosticError("message_probe_failed");
        await simpleParser(fetched.source, {
          skipHtmlToText: true,
          skipTextToHtml: true,
          maxHtmlLengthToParse: DIAGNOSTIC_PROBE_MAX_BYTES,
        });
        return "parsed";
      } catch (error) {
        const explicit = diagnosticCode(error, "message_probe_failed");
        throw diagnosticError(explicit);
      }
    }, () => client.close());

    return laneResult(
      startedAtMs,
      checkedAtIso,
      "ok",
      messageProbe === "empty" ? "imap_empty" : "imap_ok",
      true,
      { mailbox: safeMailbox, messageProbe },
    );
  } catch (error) {
    return laneResult(
      startedAtMs,
      checkedAtIso,
      "failed",
      diagnosticCode(error, "unexpected_failure"),
      true,
      { mailbox: safeMailbox, messageProbe: "not_run" },
    );
  } finally {
    client.close();
  }
}

function safeLaneProjection(value: unknown, lane: "smtp" | "imap"): MailTransportProbeLane | null {
  const record = asRecord(value);
  const status = asString(record.status, "");
  const code = asString(record.code, "");
  const checkedAtIso = asString(record.checkedAtIso, "");
  if (!isMailDiagnosticLaneStatus(status) || !isMailDiagnosticCode(code) || !Number.isFinite(Date.parse(checkedAtIso))) {
    return null;
  }
  const latency = Number(record.latencyMs ?? 0);
  const base: MailTransportProbeLane = {
    status,
    code,
    checkedAtIso,
    latencyMs: Number.isFinite(latency) ? Math.max(0, Math.min(Math.round(latency), DIAGNOSTIC_TIMEOUT_MS)) : 0,
    runtimeSecretBound: record.runtimeSecretBound === true,
  };
  if (lane !== "imap") return base;
  const messageProbe = asString(record.messageProbe, "");
  return {
    ...base,
    mailbox: safeImapMailboxName(record.mailbox),
    messageProbe: messageProbe === "parsed" || messageProbe === "empty" ? messageProbe : "not_run",
  };
}

function staleProbeLane(lane: MailTransportProbeLane): MailTransportProbeLane {
  return {
    ...lane,
    status: "failed",
    code: "probe_stale_config_changed",
    ...(lane.messageProbe ? { messageProbe: "not_run" } : {}),
  };
}

export function buildMailTransportProbeReceiptHash(
  status: Pick<
    MailTransportProbeStatus,
    "valid" | "checkedAtIso" | "expiresAtIso" | "smtp" | "imap" | "configFingerprint" | "attestationChallengeHash"
  >,
): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: "mail-transport-probe-receipt-v1",
    valid: status.valid === true,
    checkedAtIso: status.checkedAtIso,
    expiresAtIso: status.expiresAtIso,
    configFingerprint: status.configFingerprint ?? "",
    attestationChallengeHash: status.attestationChallengeHash ?? "",
    smtp: {
      status: status.smtp.status,
      code: status.smtp.code,
      checkedAtIso: status.smtp.checkedAtIso,
      latencyMs: status.smtp.latencyMs,
      runtimeSecretBound: status.smtp.runtimeSecretBound,
    },
    imap: {
      status: status.imap.status,
      code: status.imap.code,
      checkedAtIso: status.imap.checkedAtIso,
      latencyMs: status.imap.latencyMs,
      runtimeSecretBound: status.imap.runtimeSecretBound,
      mailbox: status.imap.mailbox ?? "",
      messageProbe: status.imap.messageProbe ?? "not_run",
    },
  })).digest("hex");
}

function mailTransportDiagnosticChallengeHash(token: string): string {
  return createHash("sha256")
    .update(`mail-transport-attestation-challenge-v1:${token}`)
    .digest("hex");
}

export function mailTransportDiagnosticChallengeMatches(
  value: unknown,
  token: unknown,
): boolean {
  const storedHash = asString(asRecord(value).attestationChallengeHash, "");
  if (
    !SHA256_PATTERN.test(storedHash)
    || typeof token !== "string"
    || !SHA256_PATTERN.test(token)
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(storedHash, "hex"),
    Buffer.from(mailTransportDiagnosticChallengeHash(token), "hex"),
  );
}

export function safeMailTransportProbeProjection(
  value: unknown,
  now = new Date(),
  currentIdentity?: MailIdentitySnapshot,
): MailTransportProbeStatus | null {
  const record = asRecord(value);
  const checkedAtIso = asString(record.checkedAtIso, "");
  const expiresAtIso = asString(record.expiresAtIso, "");
  const projectedSmtp = safeLaneProjection(record.smtp, "smtp");
  const projectedImap = safeLaneProjection(record.imap, "imap");
  if (!projectedSmtp || !projectedImap || !Number.isFinite(Date.parse(checkedAtIso)) || !Number.isFinite(Date.parse(expiresAtIso))) return null;

  const storedIdentity = safeMailIdentitySnapshot(record.identity) ?? undefined;
  const identity = currentIdentity ?? storedIdentity;
  const rawFingerprint = asString(record.configFingerprint, storedIdentity?.configFingerprint ?? "");
  const configFingerprint = SHA256_PATTERN.test(rawFingerprint) ? rawFingerprint : undefined;
  const storedReceiptHash = asString(record.receiptHash, "");
  const attestationChallengeHash = asString(record.attestationChallengeHash, "");
  const receiptShape = {
    valid: record.valid === true,
    checkedAtIso,
    expiresAtIso,
    smtp: projectedSmtp,
    imap: projectedImap,
    ...(configFingerprint ? { configFingerprint } : {}),
    ...(SHA256_PATTERN.test(attestationChallengeHash)
      ? { attestationChallengeHash }
      : {}),
  };
  const expectedReceiptHash = buildMailTransportProbeReceiptHash(receiptShape);
  const receiptIntegrityValid = SHA256_PATTERN.test(storedReceiptHash)
    && SHA256_PATTERN.test(attestationChallengeHash)
    && storedReceiptHash === expectedReceiptHash;
  const probeState = currentIdentity
    ? resolveMailProbeFingerprintState(configFingerprint, currentIdentity.configFingerprint)
    : undefined;
  const stale = probeState === "probe_stale_config_changed";
  const smtp = stale ? staleProbeLane(projectedSmtp) : projectedSmtp;
  const imap = stale ? staleProbeLane(projectedImap) : projectedImap;
  const valid = record.valid === true
    && receiptIntegrityValid
    && Date.parse(expiresAtIso) > now.getTime()
    && !stale;
  const providerSubjectVerified = Boolean(identity?.providerSubjectVerified);
  const operationalReady = valid
    && smtp.status === "ok"
    && imap.status === "ok"
    && Boolean(identity)
    && providerSubjectVerified;
  return {
    valid,
    checkedAtIso,
    expiresAtIso,
    operationalReady,
    smtp,
    imap,
    ...(configFingerprint ? { configFingerprint } : {}),
    ...(probeState ? { probeState } : {}),
    ...(identity ? { identity } : {}),
    ...(SHA256_PATTERN.test(storedReceiptHash) ? { receiptHash: storedReceiptHash } : {}),
    receiptIntegrityValid,
  };
}

export async function readMailTransportProbeStatus(
  identity?: MailIdentitySnapshot,
): Promise<MailTransportProbeStatus | null> {
  const currentIdentity = identity ?? await resolveOperationalMailIdentity();
  const snapshot = await adminDb.doc(MAIL_TRANSPORT_PROBE_STATUS_PATH).get();
  return snapshot.exists
    ? safeMailTransportProbeProjection(snapshot.data(), new Date(), currentIdentity)
    : null;
}

export async function diagnoseMailTransport(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(
    request,
    "integrations.mail_transport_diagnose",
    ["super_admin", "admin"],
  );
  // A diagnostic still performs external authentication/network egress. Hosted
  // staging must fail closed before either adapter is instantiated.
  assertStagingExternalSideEffectAllowed("smtp");
  assertStagingExternalSideEffectAllowed("imap");

  const checkedAt = new Date();
  const checkedAtIso = checkedAt.toISOString();
  const attestationChallengeToken = randomBytes(32).toString("hex");
  const attestationChallengeHash = mailTransportDiagnosticChallengeHash(
    attestationChallengeToken,
  );
  const context = await resolveOperationalMailIdentityContext();
  const identity = context.identity;
  const [smtp, imap] = mailIdentityAllowsTransportProbe(identity)
    ? await Promise.all([
      probeSmtp(checkedAtIso, context),
      probeImap(checkedAtIso, context),
    ])
    : [
      laneResult(
        checkedAt.getTime(),
        checkedAtIso,
        "skipped",
        identity.identityCode === "identity_mismatch" ? "identity_mismatch" : "identity_unknown",
        false,
      ),
      laneResult(
        checkedAt.getTime(),
        checkedAtIso,
        "skipped",
        identity.identityCode === "identity_mismatch" ? "identity_mismatch" : "identity_unknown",
        false,
        { mailbox: safeImapMailboxName(resolveImapMailbox(context.imap.config)), messageProbe: "not_run" },
      ),
    ];
  const unsignedStatus: MailTransportProbeStatus = {
    valid: true,
    checkedAtIso,
    expiresAtIso: new Date(checkedAt.getTime() + DIAGNOSTIC_FRESHNESS_MS).toISOString(),
    operationalReady: Boolean(identity.providerSubjectVerified)
      && smtp.status === "ok"
      && imap.status === "ok",
    smtp,
    imap,
    configFingerprint: identity.configFingerprint,
    probeState: "fresh",
    identity,
    attestationChallengeHash,
  };
  const status: MailTransportProbeStatus = {
    ...unsignedStatus,
    receiptHash: buildMailTransportProbeReceiptHash(unsignedStatus),
    receiptIntegrityValid: true,
  };

  let statusPersisted = true;
  try {
    await adminDb.doc(MAIL_TRANSPORT_PROBE_STATUS_PATH).set({
      ...status,
      actorHash: createHash("sha256").update(auth.userId).digest("hex").slice(0, 20),
      schemaVersion: "mail-transport-probe-v2",
    });
  } catch {
    statusPersisted = false;
  }

  return {
    ok: true,
    probe: status,
    statusPersisted,
    noMailSent: true,
    attestationChallengeToken,
    behaviorLog: makeBehaviorLog(auth, "integrations.mail_transport_diagnose", "success", "global", 0),
  };
}
