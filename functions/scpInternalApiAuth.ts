// G007-L03 — application-layer auth / IAM ownership gate (REQ-API-002..005).
// Platform IAM already restricts the invoker to the Portal runtime service account; this
// layer independently re-verifies the caller subject against an allowlist and checks
// entitlement BEFORE partner<->program ownership BEFORE any read. Pure logic.

import { apiError } from "./scpInternalApiErrors";

export type PortalAllowlistEntry = {
  subject: string; // stable OIDC subject of the Portal runtime service account
  serviceAccountEmail: string;
  partnerIds: string[]; // partner scopes this Portal identity may serve
};

export type PortalAuthConfig = {
  issuer: string; // expected Google workload issuer
  audience: string; // expected audience (the internal API URL / configured aud)
  allowlist: PortalAllowlistEntry[];
};

export type VerifiedCaller = {
  subject: string;
  serviceAccountEmail: string;
  allowedPartnerIds: string[];
};

export type IncomingHeaders = Record<string, string | string[] | undefined>;

function header(headers: IncomingHeaders, name: string): string {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? "";
  return typeof value === "string" ? value : "";
}

// REQ-API-002: only a Bearer workload OIDC token is accepted. Browser/client credentials —
// API key, cookie, Firebase client token, or a token smuggled via query — are rejected.
export function extractBearerToken(headers: IncomingHeaders, query: Record<string, unknown> = {}): string {
  if (header(headers, "cookie")) {
    throw apiError.unauthenticated("cookie credentials are not accepted");
  }
  if (header(headers, "x-api-key") || header(headers, "x-firebase-appcheck") || header(headers, "x-goog-api-key")) {
    throw apiError.unauthenticated("api-key credentials are not accepted");
  }
  if (query.access_token || query.token || query.id_token) {
    throw apiError.unauthenticated("query-string tokens are not accepted");
  }
  const authorization = header(headers, "authorization");
  if (!authorization) throw apiError.unauthenticated("missing Authorization header");
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/.exec(authorization.trim());
  if (!match) throw apiError.unauthenticated("Authorization must be a Bearer OIDC token");
  return match[1];
}

// Decoded OIDC claims are supplied by the verified token layer (platform + firebase-admin).
// This function performs the independent allowlist/issuer/audience checks (REQ-API-003).
export type OidcClaims = {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  exp?: unknown;
};

export function verifyPortalSubject(claims: OidcClaims, config: PortalAuthConfig, nowSec: number): VerifiedCaller {
  const iss = typeof claims.iss === "string" ? claims.iss : "";
  const aud = typeof claims.aud === "string" ? claims.aud : "";
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  const exp = typeof claims.exp === "number" ? claims.exp : 0;

  if (iss !== config.issuer) throw apiError.unauthenticated("unexpected token issuer");
  if (aud !== config.audience) throw apiError.unauthenticated("unexpected token audience");
  if (!exp || exp <= nowSec) throw apiError.unauthenticated("token is expired");
  if (!sub) throw apiError.unauthenticated("token is missing a subject");
  if (claims.email_verified !== true) throw apiError.unauthenticated("workload email is not verified");

  const entry = config.allowlist.find((candidate) => candidate.subject === sub);
  if (!entry) throw apiError.forbidden("caller subject is not in the Portal allowlist");
  if (entry.serviceAccountEmail.toLowerCase() !== email) {
    throw apiError.forbidden("caller subject does not match its allowlisted service account");
  }
  return { subject: sub, serviceAccountEmail: entry.serviceAccountEmail, allowedPartnerIds: entry.partnerIds };
}

// REQ-API-004: subject -> partner entitlement is checked before partner<->program ownership,
// and both happen before any submission/performance read.
export function assertPartnerEntitlement(caller: VerifiedCaller, partnerId: string): void {
  if (!partnerId) throw apiError.invalidRequest([{ field: "partnerId", reason: "missing partner id" }]);
  const entitled = caller.allowedPartnerIds.includes(partnerId) || caller.allowedPartnerIds.includes("*");
  if (!entitled) throw apiError.forbidden("caller is not entitled to this partner");
}

export type PartnerProgramOwnership = { partnerId: string; programIds: string[] };

export function assertPartnerProgramOwnership(
  ownership: PartnerProgramOwnership | undefined,
  partnerId: string,
  programId: string,
): void {
  if (!programId) throw apiError.invalidRequest([{ field: "programId", reason: "missing program id" }]);
  // A partner/program pair the caller is entitled to but that does not exist or is not owned
  // is a 404 within-scope, never a data leak about other partners (REQ-API-004).
  if (!ownership || ownership.partnerId !== partnerId || !ownership.programIds.includes(programId)) {
    throw apiError.notFound("partner does not own this program within the caller scope");
  }
}
