// Signed Portal Apply landing link (outreach_token_v2) — Flu mint side (TASK 3).
//
// Contract-of-record: scp-creator-portal src/lib/outreachAttribution.ts (G002). Portal verifies by
// re-signing the exact payload bytes, so mint fidelity requires: token = base64url(JSON(envelope))
// + "." + base64url(HMAC-SHA256(secret, payloadBase64url)); canonical envelope EXACT keys
// { purpose:"creator_application", keyId, expiresAt(ms epoch, <= now+90d), programId, campaignId,
//   outreachId, traceId:tr_..., expectedEmailHmac } with expectedEmailHmac =
// "v2_" + base64url(HMAC-SHA256(secret, "scp.outreach.expected-email.v2" + NUL + normalizedEmail)).
// The URL carries only the opaque signed token — never a raw email; the expected email crosses only
// as an HMAC digest inside the signed envelope.
//
// Shared key ring (Portal env names): SCP_OUTREACH_HMAC_KEY_ID + SCP_OUTREACH_HMAC_SECRET
// (+ _PREVIOUS pair). Flu binds the same values via Secret Manager; minting is fail-closed until
// both the secret pair and the Portal Apply origin are configured.

import { createHmac } from "node:crypto";

export const SCP_OUTREACH_HMAC_KEY_ID_ENV = "SCP_OUTREACH_HMAC_KEY_ID";
export const SCP_OUTREACH_HMAC_SECRET_ENV = "SCP_OUTREACH_HMAC_SECRET";
export const SCP_PORTAL_APPLY_ORIGIN_ENV = "SCP_PORTAL_APPLY_ORIGIN";
export const OUTREACH_TOKEN_V2_EMAIL_HMAC_CONTEXT = "scp.outreach.expected-email.v2" as const;
export const OUTREACH_TOKEN_V2_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 90;
// Flu mints 30-day links by default (well inside the Portal 90-day verification cap).
export const OUTREACH_LANDING_LINK_TTL_MS = 1000 * 60 * 60 * 24 * 30;

const IDENTIFIER_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const TRACE_RE = /^tr_[A-Za-z0-9._:-]{8,120}$/;

type LandingLinkError = Error & { code: string };
function landingLinkError(code: string, message: string): LandingLinkError {
  return Object.assign(new Error(message), { code });
}

// Mirrors Portal normalizeOutreachExpectedEmail exactly (trim -> NFKC -> lowercase, shape check).
export function normalizeOutreachExpectedEmail(value: string): string {
  const normalized = value.trim().normalize("NFKC").toLowerCase();
  if (normalized.length < 3 || normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw landingLinkError("invalid_outreach_expected_email", "expected email shape is invalid");
  }
  return normalized;
}

// Mirrors Portal createOutreachExpectedEmailHmac exactly.
export function createOutreachExpectedEmailHmac(email: string, secret: string): string {
  const normalizedEmail = normalizeOutreachExpectedEmail(email);
  const digest = createHmac("sha256", secret)
    .update(OUTREACH_TOKEN_V2_EMAIL_HMAC_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(normalizedEmail, "utf8")
    .digest("base64url");
  return `v2_${digest}`;
}

export type MintScpOutreachLandingLinkInput = {
  programId: string;
  campaignId: string;
  outreachId: string;
  traceId: `tr_${string}`;
  expectedEmail: string;
  now?: Date;
  ttlMs?: number;
  /** Overrides for tests; production reads the env/secret bindings. */
  keyId?: string;
  secret?: string;
  portalApplyOrigin?: string;
};

export type MintedScpOutreachLandingLink = {
  url: string;
  token: string;
  outreachId: string;
  traceId: string;
  expiresAt: number;
};

export function isScpOutreachLandingLinkConfigured(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const keyId = (env[SCP_OUTREACH_HMAC_KEY_ID_ENV] ?? "").trim();
  const secret = env[SCP_OUTREACH_HMAC_SECRET_ENV] ?? "";
  const origin = env[SCP_PORTAL_APPLY_ORIGIN_ENV] ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/.test(keyId) && secret.length >= 32 && /^https:\/\/[^\s/]+$/.test(origin);
}

// Fail-closed mint: throws landing_link_unconfigured until the shared key ring + Portal origin are
// bound. The URL is `${origin}/apply?outreach=<token>` — the pinned Portal Apply surface.
export function mintScpOutreachLandingLink(input: MintScpOutreachLandingLinkInput): MintedScpOutreachLandingLink {
  const keyId = (input.keyId ?? process.env[SCP_OUTREACH_HMAC_KEY_ID_ENV] ?? "").trim();
  const secret = input.secret ?? process.env[SCP_OUTREACH_HMAC_SECRET_ENV] ?? "";
  const origin = input.portalApplyOrigin ?? process.env[SCP_PORTAL_APPLY_ORIGIN_ENV] ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/.test(keyId) || secret.length < 32) {
    throw landingLinkError("landing_link_unconfigured", "outreach HMAC key ring is not configured");
  }
  if (!/^https:\/\/[^\s/]+$/.test(origin)) {
    throw landingLinkError("landing_link_unconfigured", "Portal Apply origin is not configured");
  }
  for (const [field, value] of [["programId", input.programId], ["campaignId", input.campaignId], ["outreachId", input.outreachId]] as const) {
    if (!IDENTIFIER_RE.test(value)) throw landingLinkError("invalid_landing_link_input", `${field} is not a safe identifier`);
  }
  if (!TRACE_RE.test(input.traceId)) throw landingLinkError("invalid_landing_link_input", "traceId shape is invalid");
  const now = input.now ?? new Date();
  const ttlMs = Math.min(Math.max(input.ttlMs ?? OUTREACH_LANDING_LINK_TTL_MS, 60_000), OUTREACH_TOKEN_V2_MAX_AGE_MS);
  const expiresAt = now.getTime() + ttlMs;
  const envelope = {
    purpose: "creator_application" as const,
    keyId,
    expiresAt,
    programId: input.programId,
    campaignId: input.campaignId,
    outreachId: input.outreachId,
    traceId: input.traceId,
    expectedEmailHmac: createOutreachExpectedEmailHmac(input.expectedEmail, secret),
  };
  const payload = Buffer.from(JSON.stringify(envelope)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  const token = `${payload}.${signature}`;
  return {
    url: `${origin}/apply?outreach=${token}`,
    token,
    outreachId: input.outreachId,
    traceId: input.traceId,
    expiresAt,
  };
}

// Verification mirror (test fidelity only — Portal owns runtime verification). Re-signs the exact
// payload bytes, enforces the canonical exact-key envelope, expiry window, and identifier shapes.
export function verifyScpOutreachLandingTokenForTest(
  token: string,
  secretByKeyId: Readonly<Record<string, string>>,
  now = Date.now(),
): Record<string, unknown> | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || payload.length > 2_000
    || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const keys = ["purpose", "keyId", "expiresAt", "programId", "campaignId", "outreachId", "traceId", "expectedEmailHmac"];
  if (Object.keys(parsed).length !== keys.length || keys.some((key) => !(key in parsed))) return null;
  const secret = secretByKeyId[String(parsed.keyId)];
  if (!secret) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (signature !== expected) return null;
  if (!Number.isSafeInteger(parsed.expiresAt) || Number(parsed.expiresAt) <= now
    || Number(parsed.expiresAt) > now + OUTREACH_TOKEN_V2_MAX_AGE_MS) return null;
  if (parsed.purpose !== "creator_application" || !/^v2_[A-Za-z0-9_-]{43}$/.test(String(parsed.expectedEmailHmac))) return null;
  return parsed;
}
