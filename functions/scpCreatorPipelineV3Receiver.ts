// scp.creator-pipeline.v3 inbound receiver (Portal -> Flu) for `application.intake.recorded`.
//
// This is a SEPARATE semantic family from `scp.integration-event.v2` (./scpIntegrationEventV2.ts) —
// it does not read or write any v2 collection and does not modify the v2 schema/fixtures. It replaces
// the fail-closed `token_absent` classification path with real signed-token-evidence classification
// by mapping the Portal v3 `signedAttributionEvidence` block onto the frozen application-management
// attribution core (./applicationManagementAttributionCore) via `signedTokenEvidenceFromV3Attribution`,
// then materializes through the existing store (./applicationManagementStore) — never bypassing it.
//
// Wire authentication (Portal signs, Flu verifies):
//   message = `${timestamp}\n${eventId}\n${exactCanonicalBody}`
//   header x-scp-signature = `sha256=` + hex HMAC-SHA256(secret, message)
//   headers: x-scp-event-id (== body.eventId), x-scp-idempotency-key (== eventId),
//            x-scp-key-id (current|previous), x-scp-timestamp (unix seconds, <=300s skew)
// Secrets are absent until deploy-time binding (env-only, never hand-supplied) — fail-closed 401 with
// no configured current key.
//
// Status semantics (handoff):
//   201 accepted (only when the exact bounded receipt validates) | 200 idempotent duplicate |
//   202 retryable/not-accepted (reserved but the materialize/receipt-build step failed transiently —
//       Portal must retry; the durable receipt ledger keeps the reservation so retries converge) |
//   400 invalid/privacy | 401 signature invalid/stale/unknown-keyId/unconfigured |
//   409 same-eventId-different-identity conflict / replay / revision-non-monotonic / trace mismatch.
//
// PRIVACY (P0): only opaque Portal IDs, sha256 hashes, and the constrained reasonCode/classification
// enums ever reach Firestore or logs here — never raw email/UID/OAuth/bearer/recipient data. The
// vendored contract already forbids raw answers/contact data on the wire (see contracts/scp-creator-
// pipeline-v3/README.md); this module additionally fails closed on any unrecognized (extra) key,
// which is what actually rejects the raw-PII negative fixture (NEG-APPV3-001) since the schema's
// every object is `additionalProperties:false`.

import type { Response } from "express";
import type { Request } from "firebase-functions/v2/https";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";
import { canonicalJson, isIntegrationEventV2Rfc3339DateTime, sha256Hex } from "./integrationEventV2";
import {
  materializeApplicationManagementRecord,
  type MaterializeResult,
} from "./applicationManagementStore";
import { enqueueManagementAckForApplication } from "./scpCreatorPipelineV3ManagementAckWiring";
import {
  signedTokenEvidenceFromV3Attribution,
  type V3SignedAttributionEvidence,
} from "./applicationManagementAttributionCore";
import { PORTAL_PROGRAM_ID } from "./scpPortalApplyBindingAuthority";

export const SCP_CREATOR_PIPELINE_V3_CONTRACT = "scp.creator-pipeline.v3" as const;
export const SCP_CREATOR_PIPELINE_V3_CURRENT_KEY_ID_ENV = "SCP_CREATOR_PIPELINE_V3_CURRENT_KEY_ID";
export const SCP_CREATOR_PIPELINE_V3_CURRENT_KEY_SECRET_ENV = "SCP_CREATOR_PIPELINE_V3_CURRENT_KEY_SECRET";
export const SCP_CREATOR_PIPELINE_V3_PREVIOUS_KEY_ID_ENV = "SCP_CREATOR_PIPELINE_V3_PREVIOUS_KEY_ID";
export const SCP_CREATOR_PIPELINE_V3_PREVIOUS_KEY_SECRET_ENV = "SCP_CREATOR_PIPELINE_V3_PREVIOUS_KEY_SECRET";
export const SCP_CREATOR_PIPELINE_V3_MAX_BODY_BYTES = 16 * 1024;
export const SCP_CREATOR_PIPELINE_V3_MAX_SKEW_SECONDS = 300;
export const SCP_CREATOR_PIPELINE_V3_MAX_RECEIPT_BYTES = 4096;

// Single new Firestore collection. Two doc-id namespaces (prefixed, non-colliding) carry the ledger's
// three logical roles so the durable state stays in exactly one collection:
//   `sig:<hash(signatureHeader)>` — authenticated-signature replay guard (mirrors scpIntegrationEventV2)
//   `evt:<hash(eventId)>`         — per-eventId idempotency + the persisted bounded intake receipt
//   `app:<hash(applicationId)>`   — per-application revision/trace continuity (subject+pipeline key)
export const CREATOR_PIPELINE_V3_RECEIPTS_COLLECTION = "scp_creator_pipeline_v3_receipts";

export const CREATOR_PIPELINE_V3_RECEIPT_SCHEMA_VERSION = "scp.creator-pipeline.v3.intake-receipt.v1" as const;

export type CreatorPipelineV3AttributionStatus = "attributed" | "unclassified" | "ambiguous" | "conflict";

export type CreatorPipelineV3SignedAttributionEvidence = Readonly<{
  verification: "verified_outreach_token_v2";
  programId: string;
  campaignId: string;
  outreachId: string;
  traceId: string;
  keyId: string;
  signedExpiresAt: string;
  verifiedAt: string;
  tokenFingerprintSha256: string;
  signatureFingerprintSha256: string;
  signatureAlgorithm: "hmac-sha256";
  candidateResolution: "signed_expected_email_hmac_exact";
  candidateCount: 1;
  revocationStatus: "checked_not_revoked";
  revocationEvidenceRef: string;
}>;

export type CreatorPipelineV3ApplicationSubject = Readonly<{
  applicationId: string;
  portalCreatorId: string;
  channelId?: string;
  programId: string;
  campaignId?: string;
  outreachId?: string;
  traceId?: string;
  materialRequestId?: string;
  managementAckId?: string;
}>;

export type CreatorPipelineV3MaterialLocator = Readonly<{
  endpointPath: "/api/internal/flu/scp-creator-pipeline-v3/application-material";
  requestBodyKeys: readonly ["applicationId", "applicationRevision", "callerId", "eventId", "expiresAt", "materialHash"];
}>;

export type CreatorPipelineV3ApplicationIntakeRecordedEvent = Readonly<{
  schemaVersion: "scp.creator-pipeline.v3";
  eventId: string;
  eventName: "application.intake.recorded";
  occurredAt: string;
  source: "portal";
  traceId: string;
  revision: number;
  subject: CreatorPipelineV3ApplicationSubject;
  payload: Readonly<{
    applicationRevision: number;
    applicationStatus: CreatorPipelineV3AttributionStatus;
    attributionStatus: CreatorPipelineV3AttributionStatus;
    signedAttributionEvidence?: CreatorPipelineV3SignedAttributionEvidence;
    materialHash: string;
    materialLocator: CreatorPipelineV3MaterialLocator;
  }>;
}>;

export type CreatorPipelineV3IntakeReceipt = Readonly<{
  schemaVersion: "scp.creator-pipeline.v3.intake-receipt.v1";
  receiver: "flu";
  status: "received";
  eventId: string;
  applicationId: string;
  applicationRevision: number;
  materialHash: string;
  receivedAt: string;
  receiptId: string;
}>;

export type CreatorPipelineV3ErrorCode =
  | "creator_pipeline_v3_unconfigured"
  | "creator_pipeline_v3_signature_invalid"
  | "creator_pipeline_v3_signature_stale"
  | "creator_pipeline_v3_body_too_large"
  | "creator_pipeline_v3_request_invalid"
  | "non_canonical_bytes"
  | "creator_pipeline_v3_state_conflict";

export class CreatorPipelineV3Error extends Error {
  readonly code: CreatorPipelineV3ErrorCode;
  constructor(code: CreatorPipelineV3ErrorCode, message: string = code) {
    super(message);
    this.name = "CreatorPipelineV3Error";
    this.code = code;
  }
}

// Map every error code to the pinned HTTP status semantics.
export function creatorPipelineV3ErrorStatus(code: string | undefined): number {
  switch (code) {
    case "creator_pipeline_v3_signature_invalid":
    case "creator_pipeline_v3_signature_stale":
    case "creator_pipeline_v3_unconfigured":
      return 401;
    case "creator_pipeline_v3_state_conflict":
      return 409;
    case "creator_pipeline_v3_request_invalid":
    case "non_canonical_bytes":
    case "creator_pipeline_v3_body_too_large":
      return 400;
    default:
      return 500;
  }
}

function docId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 48);
}

// W47: event.subject.programId is the signed envelope's Portal-wide apply-gate scope (view-cpm
// since the mint fix), never the actual attributed program — resolve the real program from the
// signed campaignId instead. Missing/unknown campaign, or a campaign whose own programId is itself
// the portal alias, resolves to null (unattributed) — never guessed.
async function resolveAttributedProgramId(campaignId: string | null): Promise<string | null> {
  if (!campaignId) return null;
  const snap = await adminDb.collection("campaigns").doc(campaignId).get();
  if (!snap.exists) return null;
  const programId = snap.data()?.programId;
  if (typeof programId !== "string" || !programId || programId === PORTAL_PROGRAM_ID) return null;
  return programId;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

// ---- shape validators --------------------------------------------------------------------------

function assertExactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) {
    if (!(key in record)) throw new CreatorPipelineV3Error("creator_pipeline_v3_request_invalid", `missing required key ${key}`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new CreatorPipelineV3Error("creator_pipeline_v3_request_invalid", `unexpected key ${key}`);
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isTraceId(value: unknown): value is string {
  return typeof value === "string" && /^tr_[A-Za-z0-9._:-]{8,120}$/.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isPositiveRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

const REQUEST_INVALID = (message: string) => new CreatorPipelineV3Error("creator_pipeline_v3_request_invalid", message);

function assertSignedAttributionEvidence(value: unknown, subject: CreatorPipelineV3ApplicationSubject): asserts value is CreatorPipelineV3SignedAttributionEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw REQUEST_INVALID("signedAttributionEvidence must be an object");
  const record = value as Record<string, unknown>;
  assertExactKeys(record, [
    "verification",
    "programId",
    "campaignId",
    "outreachId",
    "traceId",
    "keyId",
    "signedExpiresAt",
    "verifiedAt",
    "tokenFingerprintSha256",
    "signatureFingerprintSha256",
    "signatureAlgorithm",
    "candidateResolution",
    "candidateCount",
    "revocationStatus",
    "revocationEvidenceRef",
  ]);
  if (record.verification !== "verified_outreach_token_v2") throw REQUEST_INVALID("invalid verification const");
  if (!isIdentifier(record.programId) || !isIdentifier(record.campaignId) || !isIdentifier(record.outreachId) || !isIdentifier(record.keyId)) {
    throw REQUEST_INVALID("invalid signedAttributionEvidence identifier");
  }
  if (!isTraceId(record.traceId)) throw REQUEST_INVALID("invalid signedAttributionEvidence traceId");
  if (!isIntegrationEventV2Rfc3339DateTime(record.signedExpiresAt) || !isIntegrationEventV2Rfc3339DateTime(record.verifiedAt)) {
    throw REQUEST_INVALID("invalid signedAttributionEvidence rfc3339 field");
  }
  if (!isSha256(record.tokenFingerprintSha256) || !isSha256(record.signatureFingerprintSha256)) {
    throw REQUEST_INVALID("invalid signedAttributionEvidence fingerprint");
  }
  if (record.signatureAlgorithm !== "hmac-sha256") throw REQUEST_INVALID("invalid signatureAlgorithm const");
  if (record.candidateResolution !== "signed_expected_email_hmac_exact") throw REQUEST_INVALID("invalid candidateResolution const");
  if (record.candidateCount !== 1) throw REQUEST_INVALID("invalid candidateCount const");
  if (record.revocationStatus !== "checked_not_revoked") throw REQUEST_INVALID("invalid revocationStatus const");
  if (
    typeof record.revocationEvidenceRef !== "string" ||
    !/^portal-outreach-revocations:[A-Za-z0-9][A-Za-z0-9._:-]{2,63}:[a-f0-9]{64}$/.test(record.revocationEvidenceRef)
  ) {
    throw REQUEST_INVALID("invalid revocationEvidenceRef");
  }
  // Impossible verification clock: a token cannot be verified as not-yet-expired after its own signed expiry.
  if (Date.parse(record.verifiedAt as string) > Date.parse(record.signedExpiresAt as string)) {
    throw REQUEST_INVALID("verifiedAt is after signedExpiresAt");
  }
  if (subject.traceId !== undefined && subject.traceId !== record.traceId) {
    throw REQUEST_INVALID("signedAttributionEvidence traceId does not match subject traceId");
  }
}

function assertApplicationSubject(value: unknown, envelopeTraceId: string): asserts value is CreatorPipelineV3ApplicationSubject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw REQUEST_INVALID("subject must be an object");
  const record = value as Record<string, unknown>;
  assertExactKeys(
    record,
    ["applicationId", "portalCreatorId", "programId"],
    ["campaignId", "outreachId", "channelId", "traceId", "materialRequestId", "managementAckId"],
  );
  if (!isIdentifier(record.applicationId) || !isIdentifier(record.portalCreatorId) || !isIdentifier(record.programId)) {
    throw REQUEST_INVALID("invalid subject identifier");
  }
  for (const optionalKey of ["campaignId", "outreachId", "channelId", "materialRequestId", "managementAckId"] as const) {
    if (record[optionalKey] !== undefined && !isIdentifier(record[optionalKey])) throw REQUEST_INVALID(`invalid subject.${optionalKey}`);
  }
  if (record.traceId !== undefined) {
    if (!isTraceId(record.traceId)) throw REQUEST_INVALID("invalid subject.traceId");
    if (record.traceId !== envelopeTraceId) throw REQUEST_INVALID("subject.traceId must equal envelope traceId");
  }
}

function assertMaterialLocator(value: unknown): asserts value is CreatorPipelineV3MaterialLocator {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw REQUEST_INVALID("materialLocator must be an object");
  const record = value as Record<string, unknown>;
  assertExactKeys(record, ["endpointPath", "requestBodyKeys"]);
  if (record.endpointPath !== "/api/internal/flu/scp-creator-pipeline-v3/application-material") {
    throw REQUEST_INVALID("invalid materialLocator.endpointPath const");
  }
  const expectedKeys = ["applicationId", "applicationRevision", "callerId", "eventId", "expiresAt", "materialHash"];
  const actualKeys = record.requestBodyKeys;
  if (!Array.isArray(actualKeys) || actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw REQUEST_INVALID("invalid materialLocator.requestBodyKeys const");
  }
}

const ATTRIBUTION_STATUS_VALUES: readonly CreatorPipelineV3AttributionStatus[] = ["attributed", "unclassified", "ambiguous", "conflict"];

/**
 * Validates the exact `application.intake.recorded` shape (schemaSha256 e9b0c96e…), including
 * the deterministic eventId gate (identity material = canonical JSON of the event excluding
 * schemaVersion/eventId/occurredAt). Throws `creator_pipeline_v3_request_invalid` on any mismatch —
 * this is what rejects raw-PII fields (extra keys), missing/extra keys, invalid RFC3339, and
 * ambiguous/unclassified/conflict statuses carrying signed evidence.
 */
export function assertCreatorPipelineV3ApplicationIntakeRecorded(value: unknown): asserts value is CreatorPipelineV3ApplicationIntakeRecordedEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw REQUEST_INVALID("event must be an object");
  const record = value as Record<string, unknown>;
  assertExactKeys(record, ["schemaVersion", "eventId", "eventName", "occurredAt", "source", "traceId", "revision", "subject", "payload"]);
  if (record.schemaVersion !== SCP_CREATOR_PIPELINE_V3_CONTRACT) throw REQUEST_INVALID("invalid schemaVersion const");
  if (record.eventName !== "application.intake.recorded") throw REQUEST_INVALID("invalid eventName const");
  if (record.source !== "portal") throw REQUEST_INVALID("invalid source const");
  if (typeof record.eventId !== "string" || !/^evt_[a-f0-9]{32}$/.test(record.eventId)) throw REQUEST_INVALID("invalid eventId shape");
  if (!isTraceId(record.traceId)) throw REQUEST_INVALID("invalid traceId shape");
  if (!isPositiveRevision(record.revision)) throw REQUEST_INVALID("invalid revision");
  if (!isIntegrationEventV2Rfc3339DateTime(record.occurredAt)) throw REQUEST_INVALID("invalid occurredAt");
  assertApplicationSubject(record.subject, record.traceId as string);
  const subject = record.subject as CreatorPipelineV3ApplicationSubject;

  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) throw REQUEST_INVALID("payload must be an object");
  const payload = record.payload as Record<string, unknown>;
  assertExactKeys(
    payload,
    ["applicationRevision", "applicationStatus", "attributionStatus", "materialHash", "materialLocator"],
    ["signedAttributionEvidence"],
  );
  if (!isPositiveRevision(payload.applicationRevision)) throw REQUEST_INVALID("invalid payload.applicationRevision");
  if (!ATTRIBUTION_STATUS_VALUES.includes(payload.applicationStatus as CreatorPipelineV3AttributionStatus)) {
    throw REQUEST_INVALID("invalid payload.applicationStatus");
  }
  if (!ATTRIBUTION_STATUS_VALUES.includes(payload.attributionStatus as CreatorPipelineV3AttributionStatus)) {
    throw REQUEST_INVALID("invalid payload.attributionStatus");
  }
  if (!isSha256(payload.materialHash)) throw REQUEST_INVALID("invalid payload.materialHash");
  assertMaterialLocator(payload.materialLocator);

  if (payload.attributionStatus === "attributed") {
    if (payload.signedAttributionEvidence === undefined) throw REQUEST_INVALID("attributed intake requires signedAttributionEvidence");
    assertSignedAttributionEvidence(payload.signedAttributionEvidence, subject);
  } else if (payload.signedAttributionEvidence !== undefined) {
    throw REQUEST_INVALID("non-attributed intake must not carry signedAttributionEvidence");
  }

  // Deterministic-eventId gate (e3dd217f-style, per this contract's README): identity material is the
  // canonical JSON of the event excluding schemaVersion/eventId/occurredAt. A supplied eventId that does
  // not match its own derived hash is rejected as invalid, never silently accepted or auto-corrected.
  const derived = deterministicCreatorPipelineV3EventId(creatorPipelineV3IdentityMaterial(record));
  if (record.eventId !== derived) throw REQUEST_INVALID("eventId does not match its deterministic derivation");
}

export function creatorPipelineV3IdentityMaterial(event: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { schemaVersion: _schemaVersion, eventId: _eventId, occurredAt: _occurredAt, ...identityMaterial } = event;
  return identityMaterial;
}

export function deterministicCreatorPipelineV3EventId(identityMaterial: unknown): string {
  return `evt_${sha256Hex(canonicalJson(identityMaterial)).slice(0, 32)}`;
}

// ---- bounded intake receipt --------------------------------------------------------------------

function receiptId(eventId: string, applicationId: string, applicationRevision: number): string {
  return `rcpt_${sha256Hex(`${eventId}|${applicationId}|${applicationRevision}`).slice(0, 32)}`;
}

export function buildCreatorPipelineV3IntakeReceipt(input: {
  eventId: string;
  applicationId: string;
  applicationRevision: number;
  materialHash: string;
  receivedAtIso: string;
}): CreatorPipelineV3IntakeReceipt {
  return {
    schemaVersion: CREATOR_PIPELINE_V3_RECEIPT_SCHEMA_VERSION,
    receiver: "flu",
    status: "received",
    eventId: input.eventId,
    applicationId: input.applicationId,
    applicationRevision: input.applicationRevision,
    materialHash: input.materialHash,
    receivedAt: input.receivedAtIso,
    receiptId: receiptId(input.eventId, input.applicationId, input.applicationRevision),
  };
}

const RECEIPT_KEYS = ["schemaVersion", "receiver", "status", "eventId", "applicationId", "applicationRevision", "materialHash", "receivedAt", "receiptId"] as const;

/** Fail-closed guard: the bounded receipt must have EXACTLY these keys, the pinned consts, and fit the byte budget. */
export function assertBoundedCreatorPipelineV3IntakeReceipt(receipt: CreatorPipelineV3IntakeReceipt): void {
  const record = receipt as unknown as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...RECEIPT_KEYS].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("invariant: bounded intake receipt has unexpected keys");
  }
  if (receipt.schemaVersion !== CREATOR_PIPELINE_V3_RECEIPT_SCHEMA_VERSION || receipt.receiver !== "flu" || receipt.status !== "received") {
    throw new Error("invariant: bounded intake receipt const mismatch");
  }
  const bytes = Buffer.byteLength(canonicalJson(receipt), "utf8");
  if (bytes > SCP_CREATOR_PIPELINE_V3_MAX_RECEIPT_BYTES) {
    throw new Error("invariant: bounded intake receipt exceeds the byte budget");
  }
}

// ---- HMAC verification --------------------------------------------------------------------------

export type CreatorPipelineV3SigningKey = Readonly<{ keyId: string; secret: string }>;
export type CreatorPipelineV3KeyRing = Readonly<{ current: CreatorPipelineV3SigningKey; previous?: CreatorPipelineV3SigningKey }>;

export function resolveCreatorPipelineV3KeyRing(input: {
  currentKeyId?: string;
  currentSecret?: string;
  previousKeyId?: string;
  previousSecret?: string;
}): CreatorPipelineV3KeyRing {
  const currentKeyId = input.currentKeyId ?? process.env[SCP_CREATOR_PIPELINE_V3_CURRENT_KEY_ID_ENV] ?? "";
  const currentSecret = input.currentSecret ?? process.env[SCP_CREATOR_PIPELINE_V3_CURRENT_KEY_SECRET_ENV] ?? "";
  if (!currentKeyId || currentSecret.length < 32) {
    throw new CreatorPipelineV3Error("creator_pipeline_v3_unconfigured", "creator-pipeline-v3 current key is not configured");
  }
  const previousKeyId = input.previousKeyId ?? process.env[SCP_CREATOR_PIPELINE_V3_PREVIOUS_KEY_ID_ENV] ?? "";
  const previousSecret = input.previousSecret ?? process.env[SCP_CREATOR_PIPELINE_V3_PREVIOUS_KEY_SECRET_ENV] ?? "";
  const ring: { current: CreatorPipelineV3SigningKey; previous?: CreatorPipelineV3SigningKey } = {
    current: { keyId: currentKeyId, secret: currentSecret },
  };
  if (previousKeyId && previousSecret.length >= 32) ring.previous = { keyId: previousKeyId, secret: previousSecret };
  return ring;
}

export function creatorPipelineV3SigningBytes(timestamp: string, eventId: string, body: string): string {
  return `${timestamp}\n${eventId}\n${body}`;
}

function creatorPipelineV3HmacHex(secret: string, timestamp: string, eventId: string, body: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.from(creatorPipelineV3SigningBytes(timestamp, eventId, body), "utf8"))
    .digest("hex");
}

/** Test-only helper mirroring the Portal producer, so unit tests can sign a fixture without a live secret exchange. */
export function signCreatorPipelineV3ForTest(secret: string, timestamp: string, eventId: string, body: string): string {
  return `sha256=${creatorPipelineV3HmacHex(secret, timestamp, eventId, body)}`;
}

export type CreatorPipelineV3VerifiedRequest = Readonly<{
  timestamp: number;
  eventIdHeader: string;
  keySlot: "current" | "previous";
}>;

export function verifyCreatorPipelineV3Signature(input: {
  rawBody: string;
  headers: Readonly<Record<string, string | undefined>>;
  keys: CreatorPipelineV3KeyRing;
  now: Date;
  maxSkewSeconds?: number;
}): CreatorPipelineV3VerifiedRequest {
  const eventIdHeader = input.headers["x-scp-event-id"];
  const idempotencyKeyHeader = input.headers["x-scp-idempotency-key"];
  const keyIdHeader = input.headers["x-scp-key-id"];
  const signatureHeader = input.headers["x-scp-signature"];
  const timestampHeader = input.headers["x-scp-timestamp"];
  if (!eventIdHeader || !idempotencyKeyHeader || !keyIdHeader || !signatureHeader || !timestampHeader) {
    throw new CreatorPipelineV3Error("creator_pipeline_v3_signature_invalid", "missing required signature headers");
  }
  if (idempotencyKeyHeader !== eventIdHeader) {
    throw new CreatorPipelineV3Error("creator_pipeline_v3_signature_invalid", "x-scp-idempotency-key must equal x-scp-event-id");
  }
  if (!/^evt_[a-f0-9]{32}$/.test(eventIdHeader)) {
    throw new CreatorPipelineV3Error("creator_pipeline_v3_signature_invalid", "invalid x-scp-event-id shape");
  }
  if (!/^(0|[1-9][0-9]*)$/.test(timestampHeader)) {
    throw new CreatorPipelineV3Error("creator_pipeline_v3_signature_stale", "invalid x-scp-timestamp shape");
  }
  const timestamp = Number(timestampHeader);
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const maxSkewSeconds = input.maxSkewSeconds ?? SCP_CREATOR_PIPELINE_V3_MAX_SKEW_SECONDS;
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > maxSkewSeconds) {
    throw new CreatorPipelineV3Error("creator_pipeline_v3_signature_stale", "timestamp is outside the allowed skew");
  }
  const keySlot: "current" | "previous" | null = keyIdHeader === input.keys.current.keyId
    ? "current"
    : keyIdHeader === input.keys.previous?.keyId ? "previous" : null;
  if (!keySlot) throw new CreatorPipelineV3Error("creator_pipeline_v3_signature_invalid", "unknown x-scp-key-id");
  const key = keySlot === "current" ? input.keys.current : input.keys.previous!;
  const expected = `sha256=${creatorPipelineV3HmacHex(key.secret, timestampHeader, eventIdHeader, input.rawBody)}`;
  if (!safeEqual(expected, signatureHeader)) {
    throw new CreatorPipelineV3Error("creator_pipeline_v3_signature_invalid", "signature mismatch");
  }
  return { timestamp, eventIdHeader, keySlot };
}

// ---- durable receipt ledger ----------------------------------------------------------------------

type LedgerDecision = { decision: "accepted" | "duplicate"; runEffect: boolean };

async function reserveCreatorPipelineV3Receipt(
  event: CreatorPipelineV3ApplicationIntakeRecordedEvent,
  signatureHeader: string,
  identitySha256: string,
  bodySha256: string,
  now: Date,
): Promise<LedgerDecision> {
  const nowIso = now.toISOString();
  const signatureRef = adminDb.collection(CREATOR_PIPELINE_V3_RECEIPTS_COLLECTION).doc(`sig:${docId(signatureHeader)}`);
  const eventRef = adminDb.collection(CREATOR_PIPELINE_V3_RECEIPTS_COLLECTION).doc(`evt:${docId(event.eventId)}`);
  const appRef = adminDb.collection(CREATOR_PIPELINE_V3_RECEIPTS_COLLECTION).doc(`app:${docId(event.subject.applicationId)}`);

  return adminDb.runTransaction<LedgerDecision>(async (transaction) => {
    const [signatureSnap, eventSnap, appSnap] = await Promise.all([
      transaction.get(signatureRef),
      transaction.get(eventRef),
      transaction.get(appRef),
    ]);

    // (1) authenticated-signature replay guard — before any effect (mirrors scpIntegrationEventV2).
    if (signatureSnap.exists) {
      const sig = signatureSnap.data() ?? {};
      const exactAcceptedRetry = sig.accepted === true
        && asString(sig.eventId) === event.eventId
        && asString(sig.identitySha256) === identitySha256
        && asString(sig.bodySha256) === bodySha256;
      if (!exactAcceptedRetry) {
        throw new CreatorPipelineV3Error("creator_pipeline_v3_state_conflict", "signature replay rejected");
      }
      const runEffect = !eventSnap.exists || asString(eventSnap.data()?.effectState) !== "done";
      return { decision: "duplicate", runEffect };
    }

    // (2) global eventId idempotency + logical identity equality.
    if (eventSnap.exists) {
      const receipt = eventSnap.data() ?? {};
      if (asString(receipt.identitySha256) !== identitySha256) {
        throw new CreatorPipelineV3Error("creator_pipeline_v3_state_conflict", "same eventId with a different identity");
      }
      transaction.set(signatureRef, {
        kind: "signature",
        eventId: event.eventId,
        identitySha256,
        bodySha256,
        accepted: true,
        createdAtIso: nowIso,
        createdAt: FieldValue.serverTimestamp(),
      });
      return { decision: "duplicate", runEffect: asString(receipt.effectState) !== "done" };
    }

    // (3) per-application trace continuity.
    if (appSnap.exists && asString(appSnap.data()?.lastTraceId) !== event.traceId) {
      throw new CreatorPipelineV3Error("creator_pipeline_v3_state_conflict", "traceId does not match the application's prior events");
    }
    // (4) per-application revision monotonicity.
    if (appSnap.exists && event.revision <= Number(appSnap.data()?.lastRevision ?? 0)) {
      throw new CreatorPipelineV3Error("creator_pipeline_v3_state_conflict", "revision is not strictly greater than the last accepted revision");
    }

    // (5) reserve — persisted before any effect.
    transaction.set(eventRef, {
      kind: "receipt",
      eventId: event.eventId,
      eventName: event.eventName,
      identitySha256,
      bodySha256,
      applicationId: event.subject.applicationId,
      revision: event.revision,
      applicationRevision: event.payload.applicationRevision,
      traceId: event.traceId,
      effectState: "pending",
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.set(appRef, {
      kind: "pipeline",
      applicationId: event.subject.applicationId,
      lastEventId: event.eventId,
      lastRevision: event.revision,
      lastTraceId: event.traceId,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(signatureRef, {
      kind: "signature",
      eventId: event.eventId,
      identitySha256,
      bodySha256,
      accepted: true,
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { decision: "accepted", runEffect: true };
  });
}

// ---- ingest orchestration ------------------------------------------------------------------------

export type IngestScpCreatorPipelineV3Input = {
  rawBody: string;
  headers: Readonly<Record<string, string | undefined>>;
  isHttps: boolean;
  hasBearerCookieOrOrigin: boolean;
  now?: Date;
  currentKeyId?: string;
  currentSecret?: string;
  previousKeyId?: string;
  previousSecret?: string;
};

export type IngestScpCreatorPipelineV3Result = {
  status: 201 | 200 | 202;
  duplicate: boolean;
  eventId: string;
  applicationId: string;
  classification: MaterializeResult["classification"] | null;
  receipt: CreatorPipelineV3IntakeReceipt | null;
};

export async function ingestScpCreatorPipelineV3(input: IngestScpCreatorPipelineV3Input): Promise<IngestScpCreatorPipelineV3Result> {
  if (!input.isHttps) throw new CreatorPipelineV3Error("creator_pipeline_v3_signature_invalid", "https required");
  if (input.hasBearerCookieOrOrigin) throw new CreatorPipelineV3Error("creator_pipeline_v3_signature_invalid", "service auth is HMAC only");
  if (Buffer.byteLength(input.rawBody, "utf8") > SCP_CREATOR_PIPELINE_V3_MAX_BODY_BYTES) {
    throw new CreatorPipelineV3Error("creator_pipeline_v3_body_too_large", "request body exceeds the maximum size");
  }
  const now = input.now ?? new Date();
  const keys = resolveCreatorPipelineV3KeyRing({
    currentKeyId: input.currentKeyId,
    currentSecret: input.currentSecret,
    previousKeyId: input.previousKeyId,
    previousSecret: input.previousSecret,
  });

  const verified = verifyCreatorPipelineV3Signature({ rawBody: input.rawBody, headers: input.headers, keys, now });

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    throw new CreatorPipelineV3Error("creator_pipeline_v3_request_invalid", "body is not valid JSON");
  }
  // Exact-canonical-bytes gate: pretty-printed / reordered / whitespace-varied JSON is rejected even
  // though it parses, because the wire contract requires byte-identical Portal canonical JSON.
  let canonicalBody: string;
  try {
    canonicalBody = canonicalJson(parsed);
  } catch {
    throw new CreatorPipelineV3Error("non_canonical_bytes", "body is not canonical JSON");
  }
  if (canonicalBody !== input.rawBody) {
    throw new CreatorPipelineV3Error("non_canonical_bytes", "body bytes are not Portal canonical JSON");
  }

  assertCreatorPipelineV3ApplicationIntakeRecorded(parsed);
  const event = parsed;

  if (event.eventId !== verified.eventIdHeader) {
    throw new CreatorPipelineV3Error("creator_pipeline_v3_signature_invalid", "x-scp-event-id does not match the body eventId");
  }

  const identitySha256 = sha256Hex(canonicalJson(creatorPipelineV3IdentityMaterial(event)));
  const bodySha256 = sha256Hex(input.rawBody);
  const signatureHeader = String(input.headers["x-scp-signature"]);

  const ledgerDecision = await reserveCreatorPipelineV3Receipt(event, signatureHeader, identitySha256, bodySha256, now);

  const eventRef = adminDb.collection(CREATOR_PIPELINE_V3_RECEIPTS_COLLECTION).doc(`evt:${docId(event.eventId)}`);

  if (!ledgerDecision.runEffect) {
    const snap = await eventRef.get();
    const persisted = asRecord(snap.data()?.receipt);
    return {
      status: 200,
      duplicate: true,
      eventId: event.eventId,
      applicationId: event.subject.applicationId,
      classification: (typeof snap.data()?.classification === "string" ? snap.data()?.classification : null) as MaterializeResult["classification"] | null,
      receipt: Object.keys(persisted).length > 0 ? (persisted as unknown as CreatorPipelineV3IntakeReceipt) : null,
    };
  }

  const signedTokenEvidence = signedTokenEvidenceFromV3Attribution({
    signedAttributionEvidence: (event.payload.signedAttributionEvidence ?? null) as V3SignedAttributionEvidence,
    subject: { programId: event.subject.programId, campaignId: event.subject.campaignId ?? null, outreachId: event.subject.outreachId ?? null },
    nowMs: now.getTime(),
  });

  try {
    const resolvedProgramId = await resolveAttributedProgramId(event.subject.campaignId ?? null);
    const manage = await materializeApplicationManagementRecord({
      applicationId: event.subject.applicationId,
      programId: event.subject.programId ?? null,
      campaignId: event.subject.campaignId ?? null,
      outreachId: event.subject.outreachId ?? null,
      portalCreatorId: event.subject.portalCreatorId ?? null,
      resolvedProgramId,
      channelId: event.subject.channelId ?? null,
      submittedAtIso: event.occurredAt,
      traceId: event.traceId,
      eventId: event.eventId,
      revision: event.payload.applicationRevision,
      sourceContract: SCP_CREATOR_PIPELINE_V3_CONTRACT,
      signedTokenEvidence,
    }, now);

    const receipt = buildCreatorPipelineV3IntakeReceipt({
      eventId: event.eventId,
      applicationId: event.subject.applicationId,
      applicationRevision: event.payload.applicationRevision,
      materialHash: event.payload.materialHash,
      receivedAtIso: now.toISOString(),
    });
    assertBoundedCreatorPipelineV3IntakeReceipt(receipt);

    await eventRef.set(
      { effectState: "done", classification: manage.classification, reasonCode: manage.reasonCode, receipt, effectAtIso: now.toISOString() },
      { merge: true },
    );
    if (manage.classification === "managed") {
      // Auto-managed (v3 signed-attribution) intake: enqueue the Flu->Portal management-ack ONLY after
      // the intake material (effectState:"done" + receipt) is committed above, so the resolver reads
      // committed material (not the pending doc). Fail-closed fire-and-forget: never throws; dormant
      // without an active scp_portal_creator_bindings binding.
      void enqueueManagementAckForApplication(event.subject.applicationId, {}).catch(() => {});
    }

    return {
      status: ledgerDecision.decision === "accepted" ? 201 : 200,
      duplicate: ledgerDecision.decision === "duplicate",
      eventId: event.eventId,
      applicationId: event.subject.applicationId,
      classification: manage.classification,
      receipt,
    };
  } catch (error) {
    // Fail-closed: the ledger reservation is already durable (never re-run against a different body),
    // but materialization/receipt-build did not complete. Never fabricate a 201 — signal retryable so
    // Portal resends and the next attempt (duplicate path, runEffect still true) converges.
    console.warn("[creator-pipeline-v3] materialize_pending", JSON.stringify({
      code: asString(asRecord(error).code) || "unknown",
      applicationId: event.subject.applicationId,
    }));
    return {
      status: 202,
      duplicate: ledgerDecision.decision === "duplicate",
      eventId: event.eventId,
      applicationId: event.subject.applicationId,
      classification: null,
      receipt: null,
    };
  }
}

// ---- HTTP handler ---------------------------------------------------------------------------------

// Portal consumes status codes + the bounded receipt only. Mirrors the scpIntegrationEventV2 onRequest
// response/error-status pattern in index.ts. Registration snippet for the parent (index.ts owns this):
//
//   export const scpCreatorPipelineV3Intake = onRequest(
//     {
//       invoker: "public",
//       maxInstances: 3,
//       concurrency: 20,
//       timeoutSeconds: 30,
//       memory: "256MiB",
//       secrets: [
//         SCP_CREATOR_PIPELINE_V3_CURRENT_KEY_ID_ENV,
//         SCP_CREATOR_PIPELINE_V3_CURRENT_KEY_SECRET_ENV,
//         SCP_CREATOR_PIPELINE_V3_PREVIOUS_KEY_ID_ENV,
//         SCP_CREATOR_PIPELINE_V3_PREVIOUS_KEY_SECRET_ENV,
//       ],
//     },
//     scpCreatorPipelineV3IntakeHandler,
//   );
export async function scpCreatorPipelineV3IntakeHandler(request: Request, response: Response): Promise<void> {
  response.set("Cache-Control", "private, no-store, max-age=0");
  response.set("X-Content-Type-Options", "nosniff");
  if (request.method !== "POST") {
    response.set("Allow", "POST");
    response.status(405).send({ ok: false, code: "method_not_allowed" });
    return;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.get("content-type") ?? "")) {
    response.status(415).send({ ok: false, code: "unsupported_media_type" });
    return;
  }
  const rawBody = Buffer.isBuffer(request.rawBody) ? request.rawBody.toString("utf8") : "";
  if (Buffer.byteLength(rawBody, "utf8") > SCP_CREATOR_PIPELINE_V3_MAX_BODY_BYTES) {
    response.status(400).send({ ok: false, code: "creator_pipeline_v3_body_too_large" });
    return;
  }
  const forwardedProtocol = (request.get("x-forwarded-proto") ?? "").split(",", 1)[0]?.trim().toLowerCase();
  const emulatorHttpsException = process.env.FUNCTIONS_EMULATOR === "true"
    && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(request.get("host") ?? "");
  try {
    const result = await ingestScpCreatorPipelineV3({
      rawBody,
      headers: {
        "x-scp-event-id": request.get("x-scp-event-id"),
        "x-scp-idempotency-key": request.get("x-scp-idempotency-key"),
        "x-scp-key-id": request.get("x-scp-key-id"),
        "x-scp-signature": request.get("x-scp-signature"),
        "x-scp-timestamp": request.get("x-scp-timestamp"),
      },
      isHttps: request.secure || request.protocol === "https" || forwardedProtocol === "https" || emulatorHttpsException,
      hasBearerCookieOrOrigin: Boolean(request.get("authorization") || request.get("cookie") || request.get("origin")),
    });
    response.status(result.status).send({
      ok: true,
      duplicate: result.duplicate,
      eventId: result.eventId,
      receipt: result.receipt,
    });
  } catch (error) {
    const code = asRecord(error).code;
    const codeText = typeof code === "string" ? code : undefined;
    response.status(creatorPipelineV3ErrorStatus(codeText)).send({
      ok: false,
      code: codeText && /^[a-z][a-z0-9_]{2,79}$/.test(codeText) ? codeText : "temporarily_unavailable",
    });
  }
}
