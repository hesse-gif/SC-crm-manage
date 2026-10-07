/**
 * PLAN-ORG-MAIL-IDENTITY Slice 3 — per-account outbound mail transport.
 * See docs/PLAN-ORG-MAIL-IDENTITY.md for the data model and rollout plan.
 *
 * This module owns the single seam that turns a `mail_accounts/{accountId}` doc
 * (functions/mailAccounts.ts) into a ready-to-send nodemailer transport:
 *   - canonical_scp / external_smtp_imap: SMTP host/port/secure resolved through
 *     resolveMailIdentityContextForAccount (functions/mailProfiles.ts) — for the
 *     synthesized `scp` account this is the exact same call chat-ai.ts used to make
 *     directly, so the resulting config is byte-identical to the pre-Slice-3 path —
 *     with the password read from the env secret named by account.secretRef.
 *   - workspace_oauth: XOAUTH2 against smtp.gmail.com:465 (overridable from
 *     account.smtp) using a live access token from functions/mailOAuth.ts.
 * Every kind goes through the same canonical mailbox identity gate
 * (mailIdentityBlocksMode) before a transporter is ever constructed — fail closed,
 * never send. Never logs a password or access token (SEC-P0-009); callers get only
 * a short, non-reversible transportFingerprint for logs/evidence.
 */
import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import type { MailAccount } from "./mailAccounts";
import {
  resolveMailIdentityContextForAccount,
  type OperationalMailIdentityContext,
} from "./mailProfiles";
import {
  mailIdentityBlockedError,
  mailIdentityBlocksMode,
  type MailIdentityMode,
  type MailIdentitySnapshot,
} from "./mailIdentity";
import { envSecret as defaultEnvSecret } from "./liveIntegrations";
import {
  getMailOAuthAccessToken as defaultGetMailOAuthAccessToken,
  MailOAuthError,
  type GetMailOAuthAccessTokenDeps,
} from "./mailOAuth";

// ---------- minimal transporter seam (mirrors the Firestore seams in mailAccounts.ts/mailOAuth.ts) ----------

export type MailTransportSendResult = {
  readonly messageId?: unknown;
  readonly accepted?: unknown;
  readonly rejected?: unknown;
};

export type MailTransporterLike = {
  sendMail(options: Record<string, unknown>): Promise<MailTransportSendResult>;
  verify?: () => Promise<unknown>;
  close?: () => void;
};

export type CreateMailTransportFn = (options: Record<string, unknown>) => MailTransporterLike;

function defaultCreateTransport(options: Record<string, unknown>): MailTransporterLike {
  return nodemailer.createTransport(options) as unknown as MailTransporterLike;
}

export type MailTransport = {
  readonly transporter: MailTransporterLike;
  readonly from: string;
  readonly replyTo: string;
  readonly identity: MailIdentitySnapshot;
  /** sha256(kind:host:user), first 16 hex chars — safe to log, never reverses to the secret. */
  readonly transportFingerprint: string;
};

/**
 * 2026-09-10 adversarial review MEDIUM-8: `code` is the HttpsError-style code
 * (`"failed-precondition"`, matching this codebase's established `{code, errorCode}` shape —
 * see e.g. functions/mailImapLive.ts's throws) so generic error-handling/logging that expects
 * `code` to be a valid callable error code works for this class too; `errorCode` carries the
 * specific reason (`mail_transport_secret_missing` / `mail_transport_oauth_revoked` /
 * `mail_transport_oauth_unavailable`) that callers previously read off `code` directly.
 */
export class MailTransportError extends Error {
  readonly code: string;
  readonly errorCode: string;
  constructor(errorCode: string, message?: string) {
    super(message ?? errorCode);
    this.name = "MailTransportError";
    this.code = "failed-precondition";
    this.errorCode = errorCode;
  }
}

export type BuildMailTransportDeps = {
  readonly resolveIdentityContext?: (account: MailAccount) => Promise<OperationalMailIdentityContext>;
  readonly getMailOAuthAccessToken?: typeof defaultGetMailOAuthAccessToken;
  readonly oauthDeps?: GetMailOAuthAccessTokenDeps;
  readonly envSecret?: (envName: string) => string;
  readonly createTransport?: CreateMailTransportFn;
};

/**
 * 2026-09-10 adversarial review CRITICAL-1: an external account's secretRef must name ONLY a
 * secret Ops deliberately provisioned for this purpose — never an arbitrary existing bound
 * secret (e.g. an unrelated OAuth credential encryption key). Without this constraint an admin
 * could set secretRef to any bound env var name plus a self-controlled smtp.host and receive
 * that secret's value via SMTP AUTH. Enforced here (transport-build time), at write time in
 * mailAccountCallables.ts upsertMailAccount, and at read time in mailAccounts.ts
 * parseMailAccountDoc; mirrored client-side in the admin console
 * (src/app/(app)/admin/integrations/page.tsx). Binding a new MAIL_EXT_* secret to the functions
 * that need it (mailImapIngest's processImapIngestQueue, mailImapBackfill's
 * runMailBackfillJobsSchedule, chat-ai's sendEmail) requires editing their `secrets:` list —
 * deliberate; an admin cannot do this from the UI (see docs/PLAN-ORG-MAIL-IDENTITY.md).
 */
export const MAIL_EXT_SECRET_NAME_PATTERN = /^MAIL_EXT_[A-Z0-9_]{3,50}$/;
const SCP_SMTP_PASSWORD_ENV_NAME = "SMTP_PASSWORD";
const OAUTH_SMTP_HOST_DEFAULT = "smtp.gmail.com";
const OAUTH_SMTP_PORT_DEFAULT = 465;
const TRANSPORT_TIMEOUTS_MS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
} as const;

function transportFingerprint(host: string, user: string, kind: string): string {
  return createHash("sha256").update(`${kind}:${host}:${user}`).digest("hex").slice(0, 16);
}

/**
 * account.secretRef for an external account must be exactly "env:<ENV_NAME>". Exported for
 * reuse by functions/mailImapLive.ts (PLAN-ORG-MAIL-IDENTITY Slice 4 — per-account IMAP read
 * uses the exact same secretRef contract as the send-side transport built here).
 */
export function resolveExternalSecretEnvName(accountId: string, secretRef: string): string {
  const separatorIndex = secretRef.indexOf(":");
  const prefix = separatorIndex > 0 ? secretRef.slice(0, separatorIndex) : "";
  const name = separatorIndex > 0 ? secretRef.slice(separatorIndex + 1) : "";
  if (prefix !== "env" || !MAIL_EXT_SECRET_NAME_PATTERN.test(name)) {
    throw new MailTransportError(
      "mail_transport_secret_missing",
      `mail account ${accountId} has no usable env secretRef (got "${secretRef}")`,
    );
  }
  return name;
}

/** Exported for reuse by functions/mailImapLive.ts (Slice 4). */
export function requireTransportSecret(readEnvSecret: (envName: string) => string, envName: string, accountId: string): string {
  const value = readEnvSecret(envName);
  if (!value) {
    throw new MailTransportError(
      "mail_transport_secret_missing",
      `mail transport secret ${envName} is not configured for account ${accountId}`,
    );
  }
  return value;
}

/**
 * 2026-09-10 adversarial review MEDIUM-8: cheap presence-only precheck — checks that the env
 * secret this account's transport will need is actually configured, WITHOUT resolving identity
 * context, building a transporter, or touching the network. Mirrors the fail-fast guarantee the
 * pre-Slice-3 `requireEnvSecret` call gave chat-ai.ts's sendEmailLiveCore before any other
 * live-send work (artifact/asset persistence included) happened. workspace_oauth has no env
 * secret to check here (XOAUTH2 token liveness is only knowable by actually requesting one), so
 * this is a no-op for that kind.
 */
export function assertTransportSecretAvailable(
  account: MailAccount,
  deps: { readonly envSecret?: (envName: string) => string } = {},
): void {
  if (account.kind === "workspace_oauth") return;
  const readEnvSecret = deps.envSecret ?? defaultEnvSecret;
  const envName = account.kind === "canonical_scp"
    ? SCP_SMTP_PASSWORD_ENV_NAME
    : resolveExternalSecretEnvName(account.accountId, account.secretRef);
  requireTransportSecret(readEnvSecret, envName, account.accountId);
}

/**
 * Builds a ready-to-send transport for one mail_accounts/{accountId} doc.
 *
 * `mode` gates the canonical mailbox identity check the exact same way the
 * legacy chat-ai.ts send gate did (mailIdentityBlocksMode) — pass the same
 * "auto_send" | "manual_send" value the caller already derives from the
 * outbound payload's fromRole.
 */
export async function buildMailTransportForAccount(
  account: MailAccount,
  mode: MailIdentityMode,
  deps: BuildMailTransportDeps = {},
): Promise<MailTransport> {
  const resolveIdentityContext = deps.resolveIdentityContext ?? resolveMailIdentityContextForAccount;
  const createTransport = deps.createTransport ?? defaultCreateTransport;
  const readEnvSecret = deps.envSecret ?? defaultEnvSecret;
  const getAccessToken = deps.getMailOAuthAccessToken ?? defaultGetMailOAuthAccessToken;

  const context = await resolveIdentityContext(account);
  if (mailIdentityBlocksMode(context.identity, mode)) {
    throw mailIdentityBlockedError(context.identity, "mail_transport_construction");
  }

  if (account.kind === "workspace_oauth") {
    let accessToken: string;
    try {
      const token = await getAccessToken(account.accountId, deps.oauthDeps);
      accessToken = token.accessToken;
    } catch (error) {
      if (error instanceof MailOAuthError && error.code === "revoked") {
        throw new MailTransportError(
          "mail_transport_oauth_revoked",
          `mail OAuth credential for account ${account.accountId} has been revoked`,
        );
      }
      throw new MailTransportError(
        "mail_transport_oauth_unavailable",
        `mail OAuth access token is unavailable for account ${account.accountId}`,
      );
    }
    const smtpOverride = account.smtp ?? {};
    const host = typeof smtpOverride.host === "string" && smtpOverride.host.trim()
      ? smtpOverride.host.trim()
      : OAUTH_SMTP_HOST_DEFAULT;
    const port = typeof smtpOverride.port === "number" && Number.isFinite(smtpOverride.port)
      ? smtpOverride.port
      : OAUTH_SMTP_PORT_DEFAULT;
    const secure = typeof smtpOverride.secure === "boolean" ? smtpOverride.secure : true;
    const transporter = createTransport({
      host,
      port,
      secure,
      auth: { type: "OAuth2", user: account.mailbox, accessToken },
      ...TRANSPORT_TIMEOUTS_MS,
    });
    return {
      transporter,
      from: account.mailbox,
      replyTo: account.mailbox,
      identity: context.identity,
      transportFingerprint: transportFingerprint(host, account.mailbox, account.kind),
    };
  }

  // canonical_scp and external_smtp_imap: password-authenticated SMTP.
  const envName = account.kind === "canonical_scp"
    ? SCP_SMTP_PASSWORD_ENV_NAME
    : resolveExternalSecretEnvName(account.accountId, account.secretRef);
  const pass = requireTransportSecret(readEnvSecret, envName, account.accountId);

  const { host, port, secure, authUser: user, from, replyTo } = context.smtp;
  if (!host || !user || !from) {
    throw new MailTransportError(
      "mail_transport_secret_missing",
      `mail transport SMTP configuration is incomplete for account ${account.accountId}`,
    );
  }
  const transporter = createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    ...TRANSPORT_TIMEOUTS_MS,
  });
  return {
    transporter,
    from,
    replyTo,
    identity: context.identity,
    transportFingerprint: transportFingerprint(host, user, account.kind),
  };
}
