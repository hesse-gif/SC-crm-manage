// G007-L01 — deterministic opaque cursor (REQ-API-007/008).
// The cursor is an opaque, HMAC-signed, scope/filter/generation-bound, expiring token.
// Encoding is deterministic (idempotent): the same position + scope + secret always
// yields the identical string, so a retried final page returns a stable nextCursor.

import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { apiError } from "./scpInternalApiErrors";

export type CursorScope = {
  partnerId: string;
  programId: string;
  updatedAfter: string; // canonical ISO or "" (inclusive lower bound)
  includePerformance: boolean;
  generation: string; // read-model generation the page was produced against
};

export type CursorPosition = {
  sourceUpdatedAt: string; // ISO of the last item on the emitted page
  submissionId: string; // tiebreak of the last item on the emitted page
};

const CURSOR_VERSION = "v1";
const DEFAULT_TTL_MS = 15 * 60 * 1000; // cursors expire; they are not durable checkpoints (REQ-API-008)

function b64urlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

// Stable fingerprint of the query scope. Any change to partner/program/filter/generation
// changes the hash, so a cursor minted for one scope is rejected on another (REQ-API-007).
export function scopeHash(scope: CursorScope): string {
  const canonical = JSON.stringify([
    scope.partnerId,
    scope.programId,
    scope.updatedAfter,
    scope.includePerformance ? 1 : 0,
    scope.generation,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function encodeCursor(
  scope: CursorScope,
  position: CursorPosition,
  secret: string,
  options: { nowMs?: number; ttlMs?: number } = {},
): string {
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const payload = {
    v: CURSOR_VERSION,
    s: scopeHash(scope),
    u: position.sourceUpdatedAt,
    i: position.submissionId,
    x: nowMs + ttlMs,
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

export function decodeCursor(
  cursor: string,
  scope: CursorScope,
  secret: string,
  options: { nowMs?: number } = {},
): CursorPosition {
  const nowMs = options.nowMs ?? Date.now();
  const parts = cursor.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw apiError.invalidRequest([{ field: "cursor", reason: "malformed cursor" }]);
  }
  const [payloadB64, signature] = parts;
  if (!safeEqual(signature, sign(payloadB64, secret))) {
    throw apiError.invalidRequest([{ field: "cursor", reason: "cursor signature mismatch" }]);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64)) as Record<string, unknown>;
  } catch {
    throw apiError.invalidRequest([{ field: "cursor", reason: "cursor payload is not decodable" }]);
  }
  if (payload.v !== CURSOR_VERSION) {
    throw apiError.invalidRequest([{ field: "cursor", reason: "unsupported cursor version" }]);
  }
  if (payload.s !== scopeHash(scope)) {
    // Scope/filter/generation drift — surfaced as 409 so the consumer restarts cleanly.
    throw apiError.cursorConflict("cursor scope, filter, or generation no longer matches");
  }
  if (typeof payload.x !== "number" || payload.x <= nowMs) {
    throw apiError.cursorConflict("cursor has expired");
  }
  if (typeof payload.u !== "string" || typeof payload.i !== "string") {
    throw apiError.invalidRequest([{ field: "cursor", reason: "cursor position is incomplete" }]);
  }
  return { sourceUpdatedAt: payload.u, submissionId: payload.i };
}

// Total ordering used for both server-side sort and cursor comparison:
// sourceUpdatedAt ASC, then submissionId ASC (REQ-API-007).
export function compareByPosition(a: CursorPosition, b: CursorPosition): number {
  if (a.sourceUpdatedAt < b.sourceUpdatedAt) return -1;
  if (a.sourceUpdatedAt > b.sourceUpdatedAt) return 1;
  if (a.submissionId < b.submissionId) return -1;
  if (a.submissionId > b.submissionId) return 1;
  return 0;
}

export function isAfterPosition(candidate: CursorPosition, cursor: CursorPosition): boolean {
  return compareByPosition(candidate, cursor) > 0;
}
