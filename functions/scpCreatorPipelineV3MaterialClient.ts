// Flu -> Portal signed material client for the ATTESTED `scp-creator-pipeline-v3` MATERIAL ring.
//
// Reconciled to Portal's PINNED contract (Portal source commit 5b12110,
// src/lib/creatorPipelineV3InboundRoutes.ts: readOnboardingMaterialRequest / readApplicationMaterialRequest /
// handleCreatorPipelineV3OnboardingMaterialRequest / handleCreatorPipelineV3ApplicationMaterialRequest +
// src/lib/creatorPipelineV3Auth.ts: verifyCreatorPipelineV3SignedRequest). Supersedes both the legacy
// Portal application-command delivery-material channel (./scpFluApplicationCommand) and the
// previously-assumed `${timestamp}.${body}` / x-scp-content-sha256 envelope this module used to send.
//
// Wire (Portal-pinned, both endpoints):
//   - POST `<SCP_PORTAL_CREATOR_PIPELINE_V3_BASE_URL><endpointPath>`
//     (onboarding-material: /api/internal/flu/scp-creator-pipeline-v3/onboarding-material;
//      application-material: /api/internal/flu/scp-creator-pipeline-v3/application-material)
//   - HTTPS only. No query string, no hash, no origin/cookie/authorization/content-encoding/
//     transfer-encoding headers (Portal's assertRequestBoundary rejects the request outright).
//   - request body: exact canonical JSON (deterministic key order via canonicalJson), <= 4096 bytes.
//     Onboarding-material body keys (exactly): applicationId, callerId, expiresAt, grantId,
//     managementEventId, managementReceiptId.
//     Application-material body keys (exactly): applicationId, applicationRevision, callerId,
//     eventId, expiresAt, materialHash.
//   - headers: content-type: application/json, x-scp-idempotency-key = <the event id>,
//     x-scp-event-id = <the same event id>, x-scp-key-id = MATERIAL-ring CURRENT key id,
//     x-scp-timestamp (unix seconds), x-scp-signature = "sha256=" + HMAC-SHA256(materialCurrentSecret,
//     `${timestamp}\n${eventId}\n${rawBody}`) — a 3-part newline-joined message, NOT the
//     `${timestamp}.${body}` scheme ./integrationEventV2's integrationEventV2SigningBytes produces
//     (that helper is deliberately not reused here: it does not produce this 3-part message).
//     The event id in the signature/headers is managementEventId for onboarding-material and eventId
//     for application-material.
//   - REPLAY: the raw body is built exactly once per call and reused for both the signature and the
//     send, so a retry of the same call is byte-identical (Portal's HMAC verification would otherwise
//     reject a re-serialized/re-timestamped retry).
//   - response is `private, no-store`.
//
// FAIL-CLOSED, always: both exported fetchers return `null` — NEVER throw to the caller/drain — when
// the MATERIAL ring CURRENT key id/secret or the Portal base URL are unconfigured, any required
// binding input is missing or fails Portal's own format regexes, expiresAt is not a strict RFC3339
// future timestamp <= 600s ahead, the canonical request body would exceed the 4096-byte budget, the
// transport fails, the response is a non-2xx (Portal's failure body is a stable
// `{ error: "onboarding_material_unavailable" | "application_material_unavailable", requestId }` 403),
// or the response envelope drifts from the bounded/echoed contract below. Nothing here is ever
// fabricated. PRIVACY P0: the recovered recipientEmail / uidGuideUrl are never logged or persisted by
// this module, success or failure.
import { createHmac } from "node:crypto";
import { canonicalJson, isIntegrationEventV2Rfc3339DateTime } from "./integrationEventV2";
import { asRecord, asString } from "./shared";

export const SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_ID_ENV = "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_ID";
export const SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_SECRET_ENV = "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_SECRET";
export const SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_ID_ENV = "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_ID";
export const SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_SECRET_ENV = "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_SECRET";
export const SCP_PORTAL_CREATOR_PIPELINE_V3_BASE_URL_ENV = "SCP_PORTAL_CREATOR_PIPELINE_V3_BASE_URL";

export const SCP_CREATOR_PIPELINE_V3_ONBOARDING_MATERIAL_PATH = "/api/internal/flu/scp-creator-pipeline-v3/onboarding-material" as const;
export const SCP_CREATOR_PIPELINE_V3_APPLICATION_MATERIAL_PATH = "/api/internal/flu/scp-creator-pipeline-v3/application-material" as const;

export const SCP_CREATOR_PIPELINE_V3_MATERIAL_MAX_REQUEST_BYTES = 4096;
export const SCP_CREATOR_PIPELINE_V3_MATERIAL_MAX_EXPIRY_SECONDS = 600;

const ONBOARDING_MATERIAL_RESPONSE_SCHEMA_VERSION = "scp.creator-pipeline.onboarding-material-response.v1" as const;
const APPLICATION_MATERIAL_RESPONSE_SCHEMA_VERSION = "scp.creator-pipeline.application-material-response.v1" as const;
// Defensive bound on the response body — the wire contract does not pin a response size, but a
// `private, no-store` recipient-material response must never be allowed to balloon in memory.
const MATERIAL_RESPONSE_MAX_BYTES = 16 * 1024;

// Portal's own pinned format regexes (creatorPipelineV3InboundRoutes.ts readOnboardingMaterialRequest /
// readApplicationMaterialRequest) — validated client-side so an invalid binding fails closed before
// any network call, never surfacing as a signed-but-rejected round trip.
const MANAGEMENT_EVENT_ID_PATTERN = /^evt_[a-f0-9]{32}$/;
const APPLICATION_MATERIAL_EVENT_ID_PATTERN = /^evt_[a-f0-9]{32}$/;
const GRANT_ID_PATTERN = /^v1_[A-Za-z0-9_-]{43}$/;
const APPLICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MANAGEMENT_RECEIPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CALLER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const MATERIAL_HASH_PATTERN = /^[a-f0-9]{64}$/;

export type CreatorPipelineV3MaterialFetchOptions = Readonly<{
  baseUrl?: string;
  keyId?: string;
  secret?: string;
  now?: Date;
  fetcher?: typeof fetch;
}>;

export type CreatorPipelineV3Material = Readonly<{
  recipientEmail: string;
  uidGuideUrl: string;
  expiresAt: string;
}>;

// Portal-defined, not fully pinned in the read-only source this module could inspect (the
// `readMaterial` dependency return shape for application-material is Portal-internal). Kept as a
// bounded, schema/echo-validated record rather than a fabricated shape — see receipt notes.
export type CreatorPipelineV3ApplicationMaterial = Readonly<Record<string, unknown>>;

export type CreatorPipelineV3OnboardingMaterialInput = Readonly<{
  applicationId: string;
  callerId: string;
  expiresAt: string;
  grantId: string;
  managementEventId: string;
  managementReceiptId: string;
}>;

export type CreatorPipelineV3ApplicationMaterialInput = Readonly<{
  applicationId: string;
  applicationRevision: number;
  callerId: string;
  eventId: string;
  expiresAt: string;
  materialHash: string;
}>;

// Strict RFC3339, in the future, and no more than SCP_CREATOR_PIPELINE_V3_MATERIAL_MAX_EXPIRY_SECONDS
// ahead of `now`. Reused from ./integrationEventV2 (Portal-identical strict RFC3339 profile) rather
// than re-implemented.
function validExpiresAt(expiresAt: string, now: Date): boolean {
  if (!isIntegrationEventV2Rfc3339DateTime(expiresAt)) return false;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return false;
  const deltaSeconds = (expiresAtMs - now.getTime()) / 1000;
  return deltaSeconds > 0 && deltaSeconds <= SCP_CREATOR_PIPELINE_V3_MATERIAL_MAX_EXPIRY_SECONDS;
}

function materialSigningKey(options: CreatorPipelineV3MaterialFetchOptions): { keyId: string; secret: string } | null {
  const keyId = options.keyId ?? process.env[SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_ID_ENV] ?? "";
  const secret = options.secret ?? process.env[SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_SECRET_ENV] ?? "";
  if (!keyId || Buffer.byteLength(secret, "utf8") < 32) return null;
  return { keyId, secret };
}

function materialBaseUrl(options: CreatorPipelineV3MaterialFetchOptions): URL | null {
  const raw = options.baseUrl ?? process.env[SCP_PORTAL_CREATOR_PIPELINE_V3_BASE_URL_ENV] ?? "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) return null;
    return url;
  } catch {
    return null;
  }
}

// Portal-pinned signing message: `${timestamp}\n${eventId}\n${rawBody}` (NOT `${timestamp}.${body}`).
function materialSignature(secret: string, timestamp: number, eventId: string, body: string): string {
  const message = `${timestamp}\n${eventId}\n${body}`;
  return `sha256=${createHmac("sha256", Buffer.from(secret, "utf8")).update(Buffer.from(message, "utf8")).digest("hex")}`;
}

async function fetchCreatorPipelineV3Material<T>(
  endpointPath: string,
  eventId: string,
  requestBody: Readonly<Record<string, unknown>>,
  options: CreatorPipelineV3MaterialFetchOptions,
  parseResponse: (envelope: Record<string, unknown>) => T | null,
): Promise<T | null> {
  try {
    const key = materialSigningKey(options);
    if (!key) return null;
    const base = materialBaseUrl(options);
    if (!base) return null;

    // Built exactly once: the identical raw bytes are signed AND sent, so a retry of this same call
    // is byte-identical (never re-serialized/re-timestamped per attempt).
    const body = canonicalJson(requestBody);
    if (Buffer.byteLength(body, "utf8") > SCP_CREATOR_PIPELINE_V3_MATERIAL_MAX_REQUEST_BYTES) return null;

    const timestamp = Math.floor((options.now ?? new Date()).getTime() / 1000);
    const url = new URL(endpointPath, base);
    if (url.protocol !== "https:" || url.search || url.hash) return null;
    const fetcher = options.fetcher ?? fetch;

    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-scp-idempotency-key": eventId,
          "x-scp-event-id": eventId,
          "x-scp-key-id": key.keyId,
          "x-scp-timestamp": String(timestamp),
          "x-scp-signature": materialSignature(key.secret, timestamp, eventId, body),
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;

    let raw: string;
    try {
      raw = await response.text();
    } catch {
      return null;
    }
    if (Buffer.byteLength(raw, "utf8") > MATERIAL_RESPONSE_MAX_BYTES) return null;

    let envelope: Record<string, unknown>;
    try {
      envelope = asRecord(JSON.parse(raw));
    } catch {
      return null;
    }
    return parseResponse(envelope);
  } catch {
    return null;
  }
}

/**
 * Portal onboarding-material route — signed UID/content-guide URL + recipient email, gated on an
 * EXACT management-event/grant/receipt binding (Portal readOnboardingMaterialRequest). Fail-closed
 * `null` on any unconfigured/invalid/rejected condition; never throws, never logs the recovered
 * recipientEmail/uidGuideUrl.
 */
export async function fetchCreatorPipelineV3OnboardingMaterial(
  input: CreatorPipelineV3OnboardingMaterialInput,
  options: CreatorPipelineV3MaterialFetchOptions = {},
): Promise<CreatorPipelineV3Material | null> {
  if (
    !MANAGEMENT_EVENT_ID_PATTERN.test(input.managementEventId)
    || !GRANT_ID_PATTERN.test(input.grantId)
    || !APPLICATION_ID_PATTERN.test(input.applicationId)
    || !MANAGEMENT_RECEIPT_ID_PATTERN.test(input.managementReceiptId)
    || !CALLER_ID_PATTERN.test(input.callerId)
    || typeof input.expiresAt !== "string"
    || !validExpiresAt(input.expiresAt, options.now ?? new Date())
  ) {
    return null;
  }

  const requestBody = {
    applicationId: input.applicationId,
    callerId: input.callerId,
    expiresAt: input.expiresAt,
    grantId: input.grantId,
    managementEventId: input.managementEventId,
    managementReceiptId: input.managementReceiptId,
  };

  return fetchCreatorPipelineV3Material<CreatorPipelineV3Material>(
    SCP_CREATOR_PIPELINE_V3_ONBOARDING_MATERIAL_PATH,
    input.managementEventId,
    requestBody,
    options,
    (envelope) => {
      if (
        envelope.schemaVersion !== ONBOARDING_MATERIAL_RESPONSE_SCHEMA_VERSION
        || asString(envelope.managementEventId) !== input.managementEventId
        || asString(envelope.applicationId) !== input.applicationId
        || asString(envelope.grantId) !== input.grantId
        || asString(envelope.managementReceiptId) !== input.managementReceiptId
      ) {
        return null;
      }
      const delivery = asRecord(envelope.delivery);
      const recipientEmail = asString(delivery.recipientEmail);
      const uidGuideUrl = asString(delivery.uidGuideUrl);
      const deliveryExpiresAt = asString(delivery.expiresAt);
      if (!recipientEmail.includes("@") || !uidGuideUrl || !deliveryExpiresAt) return null;
      return { recipientEmail, uidGuideUrl, expiresAt: deliveryExpiresAt };
    },
  );
}

/**
 * Portal application-material route — raw (privacy-minimized) application answers, gated on a
 * delivered `application.intake.recorded` event whose materialLocator.requestBodyKeys is exactly
 * `["applicationId","applicationRevision","callerId","eventId","expiresAt","materialHash"]`
 * (Portal readApplicationMaterialRequest). Fail-closed `null` on any unconfigured/invalid/rejected
 * condition; never throws. The success response's `material` payload shape is Portal-internal and not
 * pinned here — this fetcher validates the schemaVersion + full request-field echo and returns the
 * bounded `material` record verbatim, never fabricating fields it cannot see.
 */
export async function fetchCreatorPipelineV3ApplicationMaterial(
  input: CreatorPipelineV3ApplicationMaterialInput,
  options: CreatorPipelineV3MaterialFetchOptions = {},
): Promise<CreatorPipelineV3ApplicationMaterial | null> {
  if (
    !APPLICATION_MATERIAL_EVENT_ID_PATTERN.test(input.eventId)
    || !APPLICATION_ID_PATTERN.test(input.applicationId)
    || !Number.isSafeInteger(input.applicationRevision) || input.applicationRevision < 1
    || !CALLER_ID_PATTERN.test(input.callerId)
    || !MATERIAL_HASH_PATTERN.test(input.materialHash)
    || typeof input.expiresAt !== "string"
    || !validExpiresAt(input.expiresAt, options.now ?? new Date())
  ) {
    return null;
  }

  const requestBody = {
    applicationId: input.applicationId,
    applicationRevision: input.applicationRevision,
    callerId: input.callerId,
    eventId: input.eventId,
    expiresAt: input.expiresAt,
    materialHash: input.materialHash,
  };

  return fetchCreatorPipelineV3Material<CreatorPipelineV3ApplicationMaterial>(
    SCP_CREATOR_PIPELINE_V3_APPLICATION_MATERIAL_PATH,
    input.eventId,
    requestBody,
    options,
    (envelope) => {
      if (
        envelope.schemaVersion !== APPLICATION_MATERIAL_RESPONSE_SCHEMA_VERSION
        || asString(envelope.eventId) !== input.eventId
        || asString(envelope.applicationId) !== input.applicationId
        || Number(envelope.applicationRevision) !== input.applicationRevision
        || asString(envelope.materialHash) !== input.materialHash
      ) {
        return null;
      }
      const material = asRecord(envelope.material);
      if (Object.keys(material).length === 0) return null;
      // G008 false-conflict fix (2026-07-20): Portal's application-material response
      // carries `materialHash` at the ENVELOPE level (an echo this parser has just
      // byte-verified against the intake hash above) while the inner `material` record
      // is the raw privacy-minimized answers WITHOUT a hash field. The ack drain's
      // `extractFetchedMaterialHash` reads the returned record's own `materialHash`,
      // so returning the inner record bare misclassified every successful, hash-equal
      // fetch as `materialization_conflict` (proven live: receipt
      // flu_mgmtack_4f5b828cd86ae15042bfbd6a92d9c6c8). Attach the VERIFIED envelope
      // hash — never fabricated, already proven equal — while letting an inner-record
      // hash (if Portal ever adds one) take precedence so a genuine inner mismatch
      // still fails closed downstream.
      return { materialHash: input.materialHash, ...material };
    },
  );
}
