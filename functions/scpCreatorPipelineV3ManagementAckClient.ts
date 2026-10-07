// Flu -> Portal signed sender/builder for the `scp-creator-pipeline-v3` `application.management.acknowledged`
// event, reconciled to Portal's PINNED contract (functions/contracts/scp-creator-pipeline-v3/schema.json
// `$defs.applicationManagementAcknowledged` + `$defs.managedEnrollment`, fixture
// contracts/scp-creator-pipeline-v3/fixtures/application.management.acknowledged.json). Mirrors the
// structure of ./scpCreatorPipelineV3MaterialClient.ts (build-once-send harness, fail-closed discipline)
// and reuses the deterministic-eventId / 3-part signing-message algorithms pinned in
// ./scpCreatorPipelineV3Receiver.ts (creatorPipelineV3IdentityMaterial / deterministicCreatorPipelineV3EventId /
// creatorPipelineV3SigningBytes / resolveCreatorPipelineV3KeyRing).
//
// This module is a PURE sender/builder: no Firestore, no outbox/drain state. It only builds the signed
// envelope and, optionally, POSTs it once to Portal's management-events route. The outbox/drain/store
// that decides WHEN to call this and records the resulting receipt is a separate, leader-owned module.
//
// Wire (Portal-pinned):
//   - POST `<SCP_PORTAL_CREATOR_PIPELINE_V3_BASE_URL>/api/internal/flu/scp-creator-pipeline-v3/management-events`
//   - HTTPS only. No query string, no hash, no origin/cookie/authorization/content-encoding/
//     transfer-encoding headers.
//   - request body: exact canonical JSON (deterministic key order via canonicalJson), <= 32768 bytes,
//     exactly the three keys `callerId`, `event`, `expiresAt`.
//   - headers: content-type: application/json, x-scp-idempotency-key = event.eventId,
//     x-scp-event-id = event.eventId, x-scp-key-id = INBOUND-ring CURRENT key id, x-scp-timestamp
//     (unix seconds), x-scp-signature = "sha256=" + HMAC-SHA256(inboundCurrentSecret,
//     `${timestamp}\n${eventId}\n${rawBody}`) — the SAME 3-part newline-joined message the MATERIAL
//     client and the receiver's `creatorPipelineV3SigningBytes` use. This is deliberately NOT the 2-part
//     `${timestamp}.${body}` form (videoReviewV3Signature / integrationEventV2SigningBytes) — that wrong
//     message shape gets a Portal 403.
//   - REPLAY: the raw body is built exactly once per call and reused for both the signature and the
//     send, so a retry of the same call is byte-identical.
//   - success response: 201, `{ schemaVersion: "scp.creator-pipeline.management-receipt.v1", status:
//     "accepted", receipt: {...}, onboardingMaterial?, requestId }`. The receipt echoes eventId and
//     receiptId (and, defensively, applicationId/applicationRevision/materialEventId/materialHash) —
//     any drift from the request is treated as a hostile/broken response and fails closed.
//
// FAIL-CLOSED, always: `buildApplicationManagementAcknowledgedEvent` and
// `fetchCreatorPipelineV3ManagementEvent` return `null` — NEVER throw to the caller/drain — when any
// required binding field is missing/malformed, `acknowledgedAt` does not exactly equal the generated
// `occurredAt`, `managedEnrollment.revision` does not equal the event `revision`, the INBOUND ring
// CURRENT key or Portal base URL are unconfigured, `expiresAt` is not a strict RFC3339 future timestamp
// <= SCP_CREATOR_PIPELINE_V3_MANAGEMENT_MAX_EXPIRY_SECONDS ahead, the canonical request body would
// exceed the byte budget, the transport fails, the response is not exactly 201, or the response
// envelope drifts from the bounded/echoed contract above. Nothing here is ever fabricated or patched.
//
// PRIVACY P0: this module never receives or handles raw application answers, raw email, or UID values —
// only stable identifiers, revisions, and hashes. Nothing is logged.
//
// FLU-DOMAIN GAP: `fluCreatorId`, `partnerId`, and `enrollmentId` (plus `sourceEventId`,
// `settlementCreatorCode`, `channelId`) are Flu-domain campaign-assignment/materialization facts this
// module does not derive — the caller (leader's applicationManagementStore/outbox) MUST supply them.
// Missing/invalid values here fail closed to `null`; this module never fabricates them.
import { createHmac } from "node:crypto";
import { canonicalJson, isIntegrationEventV2Rfc3339DateTime, sha256Hex } from "./integrationEventV2";
import { asRecord, asString } from "./shared";

export const SCP_CREATOR_PIPELINE_V3_INBOUND_CURRENT_KEY_ID_ENV = "SCP_CREATOR_PIPELINE_V3_INBOUND_CURRENT_KEY_ID";
export const SCP_CREATOR_PIPELINE_V3_INBOUND_CURRENT_KEY_SECRET_ENV = "SCP_CREATOR_PIPELINE_V3_INBOUND_CURRENT_KEY_SECRET";
export const SCP_CREATOR_PIPELINE_V3_INBOUND_PREVIOUS_KEY_ID_ENV = "SCP_CREATOR_PIPELINE_V3_INBOUND_PREVIOUS_KEY_ID";
export const SCP_CREATOR_PIPELINE_V3_INBOUND_PREVIOUS_KEY_SECRET_ENV = "SCP_CREATOR_PIPELINE_V3_INBOUND_PREVIOUS_KEY_SECRET";
export const SCP_PORTAL_CREATOR_PIPELINE_V3_BASE_URL_ENV = "SCP_PORTAL_CREATOR_PIPELINE_V3_BASE_URL";

export const SCP_CREATOR_PIPELINE_V3_MANAGEMENT_EVENTS_PATH = "/api/internal/flu/scp-creator-pipeline-v3/management-events" as const;

export const SCP_CREATOR_PIPELINE_V3_MANAGEMENT_MAX_REQUEST_BYTES = 32768;
export const SCP_CREATOR_PIPELINE_V3_MANAGEMENT_MAX_EXPIRY_SECONDS = 600;

// Bounded default lead time for the auto-generated `expiresAt` when the caller does not supply one —
// comfortably under the max so clock skew between build and send never tips it over the 600s ceiling.
const DEFAULT_EXPIRY_SECONDS = 540;

const MANAGEMENT_RECEIPT_RESPONSE_SCHEMA_VERSION = "scp.creator-pipeline.management-receipt.v1" as const;

// Defensive bound on the response body — the wire contract does not pin a response size, matching the
// bound already applied to the MATERIAL client's `private, no-store` responses.
const MANAGEMENT_RESPONSE_MAX_BYTES = 16 * 1024;

// Portal's own pinned format regexes (functions/contracts/scp-creator-pipeline-v3/schema.json).
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const EVENT_ID_PATTERN = /^evt_[a-f0-9]{32}$/;
const TRACE_ID_PATTERN = /^tr_[A-Za-z0-9._:-]{8,120}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CALLER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

const DEFAULT_CALLER_ID = "scp-flu-management-ack-v1";

export type ManagementAckEnrollmentInput = Readonly<{
  source: "flu_signed";
  sourceEventId: string;
  revision: number;
  status: "active" | "closed" | "revoked";
  applicationId: string;
  portalCreatorId: string;
  fluCreatorId: string;
  partnerId: string;
  programId: string;
  campaignId: string;
  outreachId?: string;
  enrollmentId: string;
  settlementCreatorCode?: string;
  channelId?: string;
  acknowledgedAt: string;
}>;

export type ManagementAckEventInput = Readonly<{
  traceId: string;
  revision: number;
  subject: Readonly<{
    applicationId: string;
    portalCreatorId: string;
    programId: string;
    campaignId?: string;
    outreachId?: string;
    traceId?: string;
    managementAckId?: string;
  }>;
  payload: Readonly<{
    applicationRevision: number;
    materialEventId: string;
    materialHash: string;
    managedEnrollment: ManagementAckEnrollmentInput;
    materializationStatus: "materialized" | "materialization_pending" | "materialization_conflict";
    assignmentMode: "signed_attribution" | "operator_assigned";
    policyVersion: string;
    receiptId: string;
  }>;
}>;

export type CreatorPipelineV3ManagementAckEvent = Readonly<{
  schemaVersion: "scp.creator-pipeline.v3";
  eventId: string;
  eventName: "application.management.acknowledged";
  occurredAt: string;
  source: "flu";
  traceId: string;
  revision: number;
  subject: ManagementAckEventInput["subject"];
  payload: ManagementAckEventInput["payload"];
}>;

export type CreatorPipelineV3ManagementAckReceiptRecord = Readonly<{
  id: string;
  applicationId: string;
  applicationRevision: number;
  eventId: string;
  eventHash: string;
  materialEventId: string;
  receiptId: string;
  callerId: string;
  materialHash: string;
  materializationStatus: "materialized" | "materialization_pending" | "materialization_conflict";
  managedEnrollmentRevision: number;
  grantId?: string;
  issuedAt: string;
}>;

export type CreatorPipelineV3ManagementAckReceipt = Readonly<{
  status: "accepted";
  receipt: CreatorPipelineV3ManagementAckReceiptRecord;
  onboardingMaterial?: unknown;
  requestId: string;
}>;

export type CreatorPipelineV3ManagementAckFetchOptions = Readonly<{
  baseUrl?: string;
  keyId?: string;
  secret?: string;
  now?: Date;
  fetcher?: typeof fetch;
  callerId?: string;
  // Caller-supplied expiry override (e.g. for tests exercising the expiry gate). When omitted, a
  // bounded no-millisecond RFC3339 timestamp DEFAULT_EXPIRY_SECONDS ahead of `now` is generated.
  expiresAt?: string;
}>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function toRfc3339NoMillis(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

// Strict RFC3339, in the future, and no more than SCP_CREATOR_PIPELINE_V3_MANAGEMENT_MAX_EXPIRY_SECONDS
// ahead of `now`. Reused profile from ./integrationEventV2 (Portal-identical strict RFC3339).
function validExpiresAt(expiresAt: string, now: Date): boolean {
  if (!isIntegrationEventV2Rfc3339DateTime(expiresAt)) return false;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return false;
  const deltaSeconds = (expiresAtMs - now.getTime()) / 1000;
  return deltaSeconds > 0 && deltaSeconds <= SCP_CREATOR_PIPELINE_V3_MANAGEMENT_MAX_EXPIRY_SECONDS;
}

function isValidManagedEnrollment(enrollment: ManagementAckEnrollmentInput, eventRevision: number): boolean {
  if (!enrollment || typeof enrollment !== "object") return false;
  if (enrollment.source !== "flu_signed") return false;
  if (!isNonEmptyString(enrollment.sourceEventId) || !IDENTIFIER_PATTERN.test(enrollment.sourceEventId)) return false;
  if (!isPositiveInteger(enrollment.revision) || enrollment.revision !== eventRevision) return false;
  if (enrollment.status !== "active" && enrollment.status !== "closed" && enrollment.status !== "revoked") return false;
  const requiredIdentifiers: readonly string[] = [
    enrollment.applicationId,
    enrollment.portalCreatorId,
    enrollment.fluCreatorId,
    enrollment.partnerId,
    enrollment.programId,
    enrollment.campaignId,
    enrollment.enrollmentId,
  ];
  if (requiredIdentifiers.some((value) => !isNonEmptyString(value) || !IDENTIFIER_PATTERN.test(value))) return false;
  if (enrollment.outreachId !== undefined && (!isNonEmptyString(enrollment.outreachId) || !IDENTIFIER_PATTERN.test(enrollment.outreachId))) return false;
  if (enrollment.settlementCreatorCode !== undefined && (!isNonEmptyString(enrollment.settlementCreatorCode) || !IDENTIFIER_PATTERN.test(enrollment.settlementCreatorCode))) return false;
  if (enrollment.channelId !== undefined && (!isNonEmptyString(enrollment.channelId) || !IDENTIFIER_PATTERN.test(enrollment.channelId))) return false;
  if (!isNonEmptyString(enrollment.acknowledgedAt) || !isIntegrationEventV2Rfc3339DateTime(enrollment.acknowledgedAt)) return false;
  return true;
}

/**
 * Builds the signed `application.management.acknowledged` envelope from caller-supplied bindings, or
 * returns `null` on ANY validation failure (fail-closed; never fabricates or patches a partial event).
 * `eventId` is deterministic: `evt_` + first 32 hex chars of sha256(canonicalJson(identity material)),
 * where identity material is exactly `{ eventName, source, traceId, revision, subject, payload }`
 * (schemaVersion/eventId/occurredAt excluded — mirrors
 * scpCreatorPipelineV3Receiver.ts:creatorPipelineV3IdentityMaterial /
 * deterministicCreatorPipelineV3EventId).
 */
export function buildApplicationManagementAcknowledgedEvent(
  input: ManagementAckEventInput,
  now: Date,
): CreatorPipelineV3ManagementAckEvent | null {
  if (!input || typeof input !== "object") return null;
  if (!isNonEmptyString(input.traceId) || !TRACE_ID_PATTERN.test(input.traceId)) return null;
  if (!isPositiveInteger(input.revision)) return null;

  const subject = input.subject;
  if (!subject || typeof subject !== "object") return null;
  if (!isNonEmptyString(subject.applicationId) || !IDENTIFIER_PATTERN.test(subject.applicationId)) return null;
  if (!isNonEmptyString(subject.portalCreatorId) || !IDENTIFIER_PATTERN.test(subject.portalCreatorId)) return null;
  if (!isNonEmptyString(subject.programId) || !IDENTIFIER_PATTERN.test(subject.programId)) return null;
  if (subject.campaignId !== undefined && (!isNonEmptyString(subject.campaignId) || !IDENTIFIER_PATTERN.test(subject.campaignId))) return null;
  if (subject.outreachId !== undefined && (!isNonEmptyString(subject.outreachId) || !IDENTIFIER_PATTERN.test(subject.outreachId))) return null;
  if (subject.traceId !== undefined && (!isNonEmptyString(subject.traceId) || !TRACE_ID_PATTERN.test(subject.traceId))) return null;
  if (subject.managementAckId !== undefined && (!isNonEmptyString(subject.managementAckId) || !IDENTIFIER_PATTERN.test(subject.managementAckId))) return null;

  const payload = input.payload;
  if (!payload || typeof payload !== "object") return null;
  if (!isPositiveInteger(payload.applicationRevision)) return null;
  if (!isNonEmptyString(payload.materialEventId) || !EVENT_ID_PATTERN.test(payload.materialEventId)) return null;
  if (!isNonEmptyString(payload.materialHash) || !SHA256_PATTERN.test(payload.materialHash)) return null;
  if (
    payload.materializationStatus !== "materialized"
    && payload.materializationStatus !== "materialization_pending"
    && payload.materializationStatus !== "materialization_conflict"
  ) {
    return null;
  }
  if (payload.assignmentMode !== "signed_attribution" && payload.assignmentMode !== "operator_assigned") return null;
  if (!isNonEmptyString(payload.policyVersion) || !POLICY_VERSION_PATTERN.test(payload.policyVersion)) return null;
  if (!isNonEmptyString(payload.receiptId) || !IDENTIFIER_PATTERN.test(payload.receiptId)) return null;
  if (!isValidManagedEnrollment(payload.managedEnrollment, input.revision)) return null;

  const occurredAt = now.toISOString();
  if (payload.managedEnrollment.acknowledgedAt !== occurredAt) return null;

  const subjectRecord: Record<string, unknown> = {
    applicationId: subject.applicationId,
    portalCreatorId: subject.portalCreatorId,
    programId: subject.programId,
    campaignId: subject.campaignId,
    outreachId: subject.outreachId,
    traceId: subject.traceId,
    managementAckId: subject.managementAckId,
  };

  const managedEnrollmentRecord: Record<string, unknown> = {
    source: payload.managedEnrollment.source,
    sourceEventId: payload.managedEnrollment.sourceEventId,
    revision: payload.managedEnrollment.revision,
    status: payload.managedEnrollment.status,
    applicationId: payload.managedEnrollment.applicationId,
    portalCreatorId: payload.managedEnrollment.portalCreatorId,
    fluCreatorId: payload.managedEnrollment.fluCreatorId,
    partnerId: payload.managedEnrollment.partnerId,
    programId: payload.managedEnrollment.programId,
    campaignId: payload.managedEnrollment.campaignId,
    outreachId: payload.managedEnrollment.outreachId,
    enrollmentId: payload.managedEnrollment.enrollmentId,
    settlementCreatorCode: payload.managedEnrollment.settlementCreatorCode,
    channelId: payload.managedEnrollment.channelId,
    acknowledgedAt: payload.managedEnrollment.acknowledgedAt,
  };

  const payloadRecord: Record<string, unknown> = {
    applicationRevision: payload.applicationRevision,
    materialEventId: payload.materialEventId,
    materialHash: payload.materialHash,
    managedEnrollment: managedEnrollmentRecord,
    materializationStatus: payload.materializationStatus,
    assignmentMode: payload.assignmentMode,
    policyVersion: payload.policyVersion,
    receiptId: payload.receiptId,
  };

  const identityMaterial = {
    eventName: "application.management.acknowledged",
    source: "flu",
    traceId: input.traceId,
    revision: input.revision,
    subject: subjectRecord,
    payload: payloadRecord,
  };
  const eventId = `evt_${sha256Hex(canonicalJson(identityMaterial)).slice(0, 32)}`;

  return {
    schemaVersion: "scp.creator-pipeline.v3",
    eventId,
    eventName: "application.management.acknowledged",
    occurredAt,
    source: "flu",
    traceId: input.traceId,
    revision: input.revision,
    subject: subject,
    payload: payload,
  };
}

export type CreatorPipelineV3InboundKeyRing = Readonly<{
  currentKeyId: string;
  currentSecret: string;
  previousKeyId?: string;
  previousSecret?: string;
}>;

/**
 * Reads the INBOUND signing ring from env (mirrors scpCreatorPipelineV3Receiver.ts's
 * resolveCreatorPipelineV3KeyRing guards: keyId non-empty AND secret.length>=32; current is REQUIRED —
 * missing/short current fails closed to `null` rather than throwing; previous is included only when
 * BOTH previous fields are present and the secret meets the same length bound).
 */
export function resolveCreatorPipelineV3InboundKeyRing(
  env: NodeJS.ProcessEnv = process.env,
): CreatorPipelineV3InboundKeyRing | null {
  const currentKeyId = env[SCP_CREATOR_PIPELINE_V3_INBOUND_CURRENT_KEY_ID_ENV] ?? "";
  const currentSecret = env[SCP_CREATOR_PIPELINE_V3_INBOUND_CURRENT_KEY_SECRET_ENV] ?? "";
  if (!currentKeyId || currentSecret.length < 32) return null;

  const ring: { currentKeyId: string; currentSecret: string; previousKeyId?: string; previousSecret?: string } = {
    currentKeyId,
    currentSecret,
  };
  const previousKeyId = env[SCP_CREATOR_PIPELINE_V3_INBOUND_PREVIOUS_KEY_ID_ENV] ?? "";
  const previousSecret = env[SCP_CREATOR_PIPELINE_V3_INBOUND_PREVIOUS_KEY_SECRET_ENV] ?? "";
  if (previousKeyId && previousSecret.length >= 32) {
    ring.previousKeyId = previousKeyId;
    ring.previousSecret = previousSecret;
  }
  return ring;
}

function resolveSigningKey(options: CreatorPipelineV3ManagementAckFetchOptions): { keyId: string; secret: string } | null {
  if (options.keyId !== undefined || options.secret !== undefined) {
    const keyId = options.keyId ?? "";
    const secret = options.secret ?? "";
    if (!keyId || secret.length < 32) return null;
    return { keyId, secret };
  }
  const ring = resolveCreatorPipelineV3InboundKeyRing(process.env);
  if (!ring) return null;
  return { keyId: ring.currentKeyId, secret: ring.currentSecret };
}

function managementBaseUrl(options: CreatorPipelineV3ManagementAckFetchOptions): URL | null {
  const raw = options.baseUrl ?? process.env[SCP_PORTAL_CREATOR_PIPELINE_V3_BASE_URL_ENV] ?? "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) return null;
    return url;
  } catch {
    return null;
  }
}

// Signing message: `${timestamp}\n${eventId}\n${rawBody}` — the SAME 3-part form used by the MATERIAL
// client and pinned in the receiver's creatorPipelineV3SigningBytes (NOT the 2-part
// `${timestamp}.${body}` scheme).
function managementSignature(secret: string, timestamp: number, eventId: string, body: string): string {
  const message = `${timestamp}\n${eventId}\n${body}`;
  return `sha256=${createHmac("sha256", Buffer.from(secret, "utf8")).update(Buffer.from(message, "utf8")).digest("hex")}`;
}

/**
 * Signs and sends the `application.management.acknowledged` event to Portal's management-events route.
 * Fail-closed `null` — NEVER throws — on any unconfigured/invalid/rejected condition; see module header
 * for the full fail-closed enumeration. Never logs or persists anything from the input or response.
 */
export async function fetchCreatorPipelineV3ManagementEvent(
  input: ManagementAckEventInput,
  options: CreatorPipelineV3ManagementAckFetchOptions = {},
): Promise<CreatorPipelineV3ManagementAckReceipt | null> {
  try {
    const key = resolveSigningKey(options);
    if (!key) return null;
    const base = managementBaseUrl(options);
    if (!base) return null;

    const now = options.now ?? new Date();
    const event = buildApplicationManagementAcknowledgedEvent(input, now);
    if (!event) return null;

    const callerId = options.callerId ?? DEFAULT_CALLER_ID;
    if (!CALLER_ID_PATTERN.test(callerId)) return null;

    const expiresAt = options.expiresAt ?? toRfc3339NoMillis(new Date(now.getTime() + DEFAULT_EXPIRY_SECONDS * 1000));
    if (!validExpiresAt(expiresAt, now)) return null;

    // Built exactly once: the identical raw bytes are signed AND sent, so a retry of this same call is
    // byte-identical (never re-serialized/re-timestamped per attempt).
    const requestBody = { callerId, event, expiresAt };
    const body = canonicalJson(requestBody);
    if (Buffer.byteLength(body, "utf8") > SCP_CREATOR_PIPELINE_V3_MANAGEMENT_MAX_REQUEST_BYTES) return null;

    const timestamp = Math.floor(now.getTime() / 1000);
    const url = new URL(SCP_CREATOR_PIPELINE_V3_MANAGEMENT_EVENTS_PATH, base);
    if (url.protocol !== "https:" || url.search || url.hash) return null;
    const fetcher = options.fetcher ?? fetch;

    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-scp-idempotency-key": event.eventId,
          "x-scp-event-id": event.eventId,
          "x-scp-key-id": key.keyId,
          "x-scp-timestamp": String(timestamp),
          "x-scp-signature": managementSignature(key.secret, timestamp, event.eventId, body),
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return null;
    }
    if (response.status !== 201) return null;

    let raw: string;
    try {
      raw = await response.text();
    } catch {
      return null;
    }
    if (Buffer.byteLength(raw, "utf8") > MANAGEMENT_RESPONSE_MAX_BYTES) return null;

    let envelope: Record<string, unknown>;
    try {
      envelope = asRecord(JSON.parse(raw));
    } catch {
      return null;
    }

    if (envelope.schemaVersion !== MANAGEMENT_RECEIPT_RESPONSE_SCHEMA_VERSION || envelope.status !== "accepted") return null;

    const receiptRecord = asRecord(envelope.receipt);
    if (
      asString(receiptRecord.eventId) !== event.eventId
      || asString(receiptRecord.receiptId) !== input.payload.receiptId
      || asString(receiptRecord.applicationId) !== input.subject.applicationId
      || Number(receiptRecord.applicationRevision) !== input.payload.applicationRevision
      || asString(receiptRecord.materialEventId) !== input.payload.materialEventId
      || asString(receiptRecord.materialHash) !== input.payload.materialHash
    ) {
      return null;
    }

    const id = asString(receiptRecord.id);
    const eventHash = asString(receiptRecord.eventHash);
    const callerIdEcho = asString(receiptRecord.callerId);
    const issuedAt = asString(receiptRecord.issuedAt);
    const materializationStatus = receiptRecord.materializationStatus;
    const managedEnrollmentRevision = Number(receiptRecord.managedEnrollmentRevision);
    if (!id || !eventHash || !callerIdEcho || !issuedAt) return null;
    if (
      materializationStatus !== "materialized"
      && materializationStatus !== "materialization_pending"
      && materializationStatus !== "materialization_conflict"
    ) {
      return null;
    }
    if (!isPositiveInteger(managedEnrollmentRevision)) return null;

    const requestId = asString(envelope.requestId);
    if (!requestId) return null;

    const grantId = receiptRecord.grantId !== undefined ? asString(receiptRecord.grantId) : "";

    const receipt: CreatorPipelineV3ManagementAckReceiptRecord = {
      id,
      applicationId: input.subject.applicationId,
      applicationRevision: input.payload.applicationRevision,
      eventId: event.eventId,
      eventHash,
      materialEventId: input.payload.materialEventId,
      receiptId: input.payload.receiptId,
      callerId: callerIdEcho,
      materialHash: input.payload.materialHash,
      materializationStatus,
      managedEnrollmentRevision,
      issuedAt,
      ...(grantId ? { grantId } : {}),
    };

    return {
      status: "accepted",
      receipt,
      ...(envelope.onboardingMaterial !== undefined ? { onboardingMaterial: envelope.onboardingMaterial } : {}),
      requestId,
    };
  } catch {
    return null;
  }
}
