// scp.video-submission-review.v3 inbound receiver (Portal -> Flu) for canonical video-revision
// delivery (`video.revision.submitted` / `video.revision.withdrawn`, vendored contract schema SHA
// 651b1811..., ./contracts/scp-video-submission-review-v3/). This seeds the canonical
// `scp_video_review_state` doc (./videoReviewTransitionStore.SCP_VIDEO_REVIEW_STATE_COLLECTION) that
// the §4 human/AI review transition engine, the Portal review-status callback, and the Flu downstream
// projection callback all consume as their single source of truth for a submission's current revision.
//
// This module is a SEPARATE semantic family from `scp.creator-pipeline.v3`
// (./scpCreatorPipelineV3Receiver.ts) and `scp.integration-event.v2` (./scpIntegrationEventV2.ts) — it
// does not read or write their collections. It composes (never re-implements) the existing §4/§6
// stores: ./videoReviewTransitionStore (review-state collection constant + docId sanitizer
// convention), ./duplicateDetectionStore (fingerprint upsert + stale-fingerprint invalidation), and
// ./videoReviewAutomationOutbox (§5 immediate-analysis trigger).
//
// Wire authentication (Portal signs, Flu verifies) — distinct scheme from scp-creator-pipeline-v3:
//   message = `${unixTimestamp}.${exactCanonicalBody}` (no eventId in the signed message; matches the
//   sibling outbound module ./scpVideoReviewV3Callbacks.ts's `videoReviewV3Signature` convention and the
//   vendored ./integrationEventV2.ts HMAC message shape)
//   header x-scp-signature      = `sha256=` + hex HMAC-SHA256(secret, message)
//   header x-scp-content-sha256 = hex sha256(exactCanonicalBody)
//   headers: x-scp-event-id (== body.eventId), x-scp-idempotency-key (== eventId),
//            x-scp-key-id (current|previous), x-scp-timestamp (unix seconds, <=300s skew)
// Secrets (SCP_VIDEO_REVIEW_CURRENT_KEY_ID/SECRET, SCP_VIDEO_REVIEW_PREVIOUS_KEY_ID/SECRET) are env-only
// and absent until deploy-time binding — fail-closed 401 with no configured current key.
//
// Deterministic eventId: empirically re-derived against all three vendored fixtures (see
// tests/flu-video-revision-ingress-spec.test.mjs), the identity material for THIS contract excludes
// only {eventId, occurredAt} — schemaVersion IS included (this differs from scp-creator-pipeline-v3,
// whose identity material also excludes schemaVersion; the two contracts are independently versioned
// and must not be assumed to share an identity-material convention).
//
// Status semantics (handoff):
//   201 accepted (new higher revision materialized, exact bounded receipt validates) |
//   200 idempotent (same eventId+identity duplicate, OR same-revision+same-payloadHash logical no-op) |
//   202 retryable/not-accepted (ledger reserved but the commit step failed transiently) |
//   400 invalid/privacy | 401 signature invalid/stale/unknown-keyId/unconfigured |
//   409 same-eventId-different-identity conflict / revision non-monotonic / same-revision-different-
//       payload conflict / traceId mismatch.
//
// PRIVACY (P0): only opaque Portal/Flu ids, sha256 hashes, and constrained enum/reasonCode strings ever
// reach Firestore or logs here — never raw email/UID/OAuth/bearer/recipient/title/description/
// reportedViews. Every object in the vendored schema is `additionalProperties:false`; this module
// additionally fails closed on any unrecognized (extra) key and rejects bare 8-20-digit numeric
// identifier values (raw-UID-shaped), which is what rejects the `outbound.raw-uid-numeric-identifier`
// and `outbound.pii-reported-views` negative fixtures.

import type { Response } from "express";
import type { Request } from "firebase-functions/v2/https";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";
import {
  canonicalJson,
  isIntegrationEventV2Rfc3339DateTime,
  sha256Hex,
} from "./integrationEventV2";
import { SCP_VIDEO_REVIEW_STATE_COLLECTION } from "./videoReviewTransitionStore";
// Task-100 갭 ①: 리비전 증가 = 결정적 재제출 관측. 이 파일이 이미 review-state 문서를 만지는
// 유일한 리비전 수락 경로이므로, 여기서 "resubmitted" 전이를 같은 트랜잭션에 얹는다.
import {
  buildResubmissionCycleResubmittedPatch,
  resubmissionCycleDocId,
  VIDEO_RESUBMISSION_CYCLE_COLLECTION,
} from "./videoResubmissionCycleCore";
import {
  invalidateStaleFingerprintsOnRevision,
  upsertVideoFingerprint,
} from "./duplicateDetectionStore";
import { enqueueVideoReviewAutomationOutbox } from "./videoReviewAutomationOutbox";
import { initialVideoReviewRuleEvidenceLedger } from "./videoReviewRuleEvidenceLedger";
import {
  SCP_CONTENT_SUBMITTED_MAIL_OUTBOX_COLLECTION,
  contentSubmittedMailOutboxDocId,
  contentSubmittedMailOutboxRow,
} from "./scpReceiptMailOutbox";
import { resolveScpReceiptMailTemplate } from "./scpReceiptMailTemplates";
import type {
  PortalVideoRevisionEvent,
  PortalVideoRevisionSubmittedEvent,
  PortalVideoRevisionWithdrawnEvent,
  ScpAutomationReceipt,
  VideoReviewSubject,
} from "./contracts/scp-video-submission-review-v3/types";
import {
  defaultReviewStateProgramResolutionDeps,
  resolveReviewStateProgramId,
} from "./reviewStateProgramResolution";
// Task-53: `reserveAndUpsertVideoRevision` below writes `canonicalProgramId`/`state` straight to the
// review-state doc (transaction.set(stateRef, ...)), bypassing transitionVideoReviewDecision
// entirely — so it must call the same low-level cache-invalidation entry point itself (see that
// module's header for why both writers must call it).
import {
  invalidateReviewQueueCachesForCommittedWriteScopes,
  type ReviewQueueCacheInvalidationScope,
} from "./reviewQueueCountsCache";

export const SCP_VIDEO_REVISION_INGRESS_CONTRACT =
  "scp.video-submission-review.v3" as const;
export const SCP_VIDEO_REVIEW_CURRENT_KEY_ID_ENV =
  "SCP_VIDEO_REVIEW_CURRENT_KEY_ID";
export const SCP_VIDEO_REVIEW_CURRENT_KEY_SECRET_ENV =
  "SCP_VIDEO_REVIEW_CURRENT_KEY_SECRET";
export const SCP_VIDEO_REVIEW_PREVIOUS_KEY_ID_ENV =
  "SCP_VIDEO_REVIEW_PREVIOUS_KEY_ID";
export const SCP_VIDEO_REVIEW_PREVIOUS_KEY_SECRET_ENV =
  "SCP_VIDEO_REVIEW_PREVIOUS_KEY_SECRET";
export const SCP_VIDEO_REVISION_INGRESS_MAX_BODY_BYTES = 16 * 1024;
export const SCP_VIDEO_REVISION_INGRESS_MAX_SKEW_SECONDS = 300;
export const SCP_VIDEO_REVISION_INGRESS_MAX_RECEIPT_BYTES = 4096;

// Single new Firestore collection for the durable ingress ledger. Two doc-id namespaces (prefixed,
// non-colliding), mirroring ./scpCreatorPipelineV3Receiver.ts's convention:
//   `sig:<hash(signatureHeader)>` — authenticated-signature replay guard
//   `evt:<hash(eventId)>`         — per-eventId idempotency + the persisted bounded receipt
// The canonical review-state doc itself (in the EXISTING scp_video_review_state collection) carries the
// per-submission revision/traceId/payloadHash continuity used for monotonicity + trace-mismatch gates,
// so no separate per-submission ledger namespace is needed here.
export const SCP_VIDEO_REVISION_INGRESS_RECEIPTS_COLLECTION =
  "scp_video_submission_review_receipts";

export const SCP_AUTOMATION_RECEIPT_SCHEMA_VERSION =
  "scp.video-submission-review.receipt.v1" as const;

export type ScpVideoRevisionIngressErrorCode =
  | "video_revision_ingress_unconfigured"
  | "video_revision_ingress_signature_invalid"
  | "video_revision_ingress_signature_stale"
  | "video_revision_ingress_body_too_large"
  | "video_revision_ingress_request_invalid"
  | "non_canonical_bytes"
  | "video_revision_ingress_state_conflict";

export class ScpVideoRevisionIngressError extends Error {
  readonly code: ScpVideoRevisionIngressErrorCode;
  constructor(code: ScpVideoRevisionIngressErrorCode, message: string = code) {
    super(message);
    this.name = "ScpVideoRevisionIngressError";
    this.code = code;
  }
}

// Map every error code to the pinned HTTP status semantics.
export function scpVideoRevisionIngressErrorStatus(
  code: string | undefined,
): number {
  switch (code) {
    case "video_revision_ingress_signature_invalid":
    case "video_revision_ingress_signature_stale":
    case "video_revision_ingress_unconfigured":
      return 401;
    case "video_revision_ingress_state_conflict":
      return 409;
    case "video_revision_ingress_request_invalid":
    case "non_canonical_bytes":
    case "video_revision_ingress_body_too_large":
      return 400;
    default:
      return 500;
  }
}

function docId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 48);
}

export {
  SCP_CONTENT_SUBMITTED_MAIL_OUTBOX_COLLECTION,
  contentSubmittedMailOutboxDocId,
} from "./scpReceiptMailOutbox";

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

// Sanitizer copy — MUST stay byte-identical to the private `reviewDocId` in ./videoReviewTransitionStore
// (not exported there) so both modules address the exact same review-state document.
export function videoReviewStateDocId(videoSubmissionId: string): string {
  const safe = String(videoSubmissionId)
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 180);
  if (!safe) throw REQUEST_INVALID("videoSubmissionId is required");
  return safe;
}

// ---- shape validators --------------------------------------------------------------------------

const REQUEST_INVALID = (message: string) =>
  new ScpVideoRevisionIngressError(
    "video_revision_ingress_request_invalid",
    message,
  );

function assertExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of required) {
    if (!(key in record)) throw REQUEST_INVALID(`missing required key ${key}`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw REQUEST_INVALID(`unexpected key ${key}`);
  }
}

function assertForbiddenKeys(
  record: Record<string, unknown>,
  forbidden: readonly string[],
): void {
  for (const key of forbidden) {
    if (key in record) throw REQUEST_INVALID(`forbidden key ${key} present`);
  }
}

// A bare 8-20 digit numeric run is a raw-UID-shaped value (rejects NEG `outbound.raw-uid-numeric-
// identifier`) even though it otherwise matches the wire schema's loose identifier pattern.
const BARE_UID_LENGTH_NUMERIC_RUN = /^[0-9]{8,20}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{3,160}$/;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9_:-]{2,80}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TRACE_ID_PATTERN = /^tr_[A-Za-z0-9._:-]{8,160}$/;
const EVENT_ID_PATTERN = /^evt_[a-f0-9]{32}$/;
const YOUTUBE_URL_PATTERN = /^https:\/\/((www\.)?youtube\.com|youtu\.be)\//;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,32}$/;

function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    IDENTIFIER_PATTERN.test(value) &&
    !BARE_UID_LENGTH_NUMERIC_RUN.test(value)
  );
}

function isPolicyVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    POLICY_VERSION_PATTERN.test(value) &&
    !BARE_UID_LENGTH_NUMERIC_RUN.test(value)
  );
}

function isReasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_PATTERN.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID_PATTERN.test(value);
}

function isEventId(value: unknown): value is string {
  return typeof value === "string" && EVENT_ID_PATTERN.test(value);
}

function isPositiveRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isYoutubeUrl(value: unknown): value is string {
  return typeof value === "string" && YOUTUBE_URL_PATTERN.test(value);
}

function isYoutubeVideoId(value: unknown): value is string {
  return typeof value === "string" && YOUTUBE_VIDEO_ID_PATTERN.test(value);
}

const SUBJECT_REQUIRED = [
  "applicationId",
  "campaignId",
  "contentFingerprint",
  "enrollmentId",
  "fluCreatorId",
  "partnerId",
  "policyVersion",
  "portalCreatorId",
  "programId",
  "videoRevision",
  "videoSubmissionId",
] as const;
const SUBJECT_OPTIONAL = [
  "outreachId",
  "sourceSubmissionId",
  "settlementCreatorCode",
  "channelId",
] as const;
const SUBJECT_IDENTIFIER_KEYS = [
  "applicationId",
  "campaignId",
  "enrollmentId",
  "fluCreatorId",
  "partnerId",
  "portalCreatorId",
  "programId",
  "videoSubmissionId",
  "outreachId",
  "sourceSubmissionId",
  "settlementCreatorCode",
  "channelId",
] as const;

function assertVideoReviewSubject(
  value: unknown,
): asserts value is VideoReviewSubject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw REQUEST_INVALID("subject must be an object");
  const record = value as Record<string, unknown>;
  assertExactKeys(record, SUBJECT_REQUIRED, SUBJECT_OPTIONAL);
  for (const key of SUBJECT_IDENTIFIER_KEYS) {
    if (record[key] === undefined) continue; // optional field absent
    if (!isSafeIdentifier(record[key]))
      throw REQUEST_INVALID(`invalid subject.${key}`);
  }
  if (!isPositiveRevision(record.videoRevision))
    throw REQUEST_INVALID("invalid subject.videoRevision");
  if (!isSha256(record.contentFingerprint))
    throw REQUEST_INVALID("invalid subject.contentFingerprint");
  if (!isPolicyVersion(record.policyVersion))
    throw REQUEST_INVALID("invalid subject.policyVersion");
}

const PAYLOAD_REQUIRED = [
  "correctionReasonCode",
  "operation",
  "payloadHash",
  "sourceUpdatedAt",
] as const;
const PAYLOAD_OPTIONAL = [
  "canonicalVideoUrl",
  "youtubeVideoId",
  "publishedAt",
  "contentType",
  "invalidatesApprovedRevision",
] as const;
const SUBMITTED_VIDEO_FIELDS = [
  "canonicalVideoUrl",
  "contentType",
  "publishedAt",
  "youtubeVideoId",
] as const;

/**
 * Validates the exact frozen `scp.video-submission-review.v3` Portal event shape (schemaSha256
 * 651b1811...), including the deterministic eventId gate. Throws `video_revision_ingress_request_
 * invalid` on any mismatch — this is what rejects raw-PII fields (extra keys / bare-numeric UID-shaped
 * identifiers), missing/extra keys, mutable video fields on a withdrawal, and same-eventId-different-
 * payload envelopes (NEG `outbound.same-id-different-payload`).
 */
export function assertPortalVideoRevisionEvent(
  value: unknown,
): asserts value is PortalVideoRevisionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw REQUEST_INVALID("event must be an object");
  const record = value as Record<string, unknown>;
  assertExactKeys(record, [
    "schemaVersion",
    "eventId",
    "eventName",
    "occurredAt",
    "payload",
    "revision",
    "source",
    "subject",
    "traceId",
  ]);
  if (record.schemaVersion !== SCP_VIDEO_REVISION_INGRESS_CONTRACT)
    throw REQUEST_INVALID("invalid schemaVersion const");
  if (
    record.eventName !== "video.revision.submitted" &&
    record.eventName !== "video.revision.withdrawn"
  ) {
    throw REQUEST_INVALID("invalid eventName const");
  }
  if (record.source !== "portal") throw REQUEST_INVALID("invalid source const");
  if (!isEventId(record.eventId))
    throw REQUEST_INVALID("invalid eventId shape");
  if (!isTraceId(record.traceId))
    throw REQUEST_INVALID("invalid traceId shape");
  if (!isPositiveRevision(record.revision))
    throw REQUEST_INVALID("invalid revision");
  if (!isIntegrationEventV2Rfc3339DateTime(record.occurredAt))
    throw REQUEST_INVALID("invalid occurredAt");

  assertVideoReviewSubject(record.subject);
  const subject = record.subject as VideoReviewSubject;
  if (subject.videoRevision !== record.revision)
    throw REQUEST_INVALID("envelope revision must equal subject.videoRevision");

  if (
    !record.payload ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload)
  )
    throw REQUEST_INVALID("payload must be an object");
  const payload = record.payload as Record<string, unknown>;
  assertExactKeys(payload, PAYLOAD_REQUIRED, PAYLOAD_OPTIONAL);
  if (!isReasonCode(payload.correctionReasonCode))
    throw REQUEST_INVALID("invalid payload.correctionReasonCode");
  if (!isIntegrationEventV2Rfc3339DateTime(payload.sourceUpdatedAt))
    throw REQUEST_INVALID("invalid payload.sourceUpdatedAt");
  if (!isSha256(payload.payloadHash))
    throw REQUEST_INVALID("invalid payload.payloadHash");
  if (
    payload.invalidatesApprovedRevision !== undefined &&
    !isPositiveRevision(payload.invalidatesApprovedRevision)
  ) {
    throw REQUEST_INVALID("invalid payload.invalidatesApprovedRevision");
  }
  if (
    payload.operation === "upsert" &&
    payload.invalidatesApprovedRevision !== undefined
  ) {
    throw REQUEST_INVALID("upsert must not carry invalidatesApprovedRevision");
  }

  if (record.eventName === "video.revision.submitted") {
    if (payload.operation !== "upsert" && payload.operation !== "replace")
      throw REQUEST_INVALID("invalid payload.operation for submitted");
    if (!isYoutubeUrl(payload.canonicalVideoUrl))
      throw REQUEST_INVALID("invalid payload.canonicalVideoUrl");
    if (!isYoutubeVideoId(payload.youtubeVideoId))
      throw REQUEST_INVALID("invalid payload.youtubeVideoId");
    if (!isIntegrationEventV2Rfc3339DateTime(payload.publishedAt))
      throw REQUEST_INVALID("invalid payload.publishedAt");
    if (
      payload.contentType !== "short" &&
      payload.contentType !== "long_form" &&
      payload.contentType !== "live"
    ) {
      throw REQUEST_INVALID("invalid payload.contentType");
    }
  } else {
    if (payload.operation !== "withdraw")
      throw REQUEST_INVALID("invalid payload.operation for withdrawn");
    assertForbiddenKeys(payload, SUBMITTED_VIDEO_FIELDS);
  }

  // Deterministic-eventId gate: identity material is the event excluding {eventId, occurredAt} only
  // (schemaVersion IS part of identity material for this contract — re-derived from the vendored
  // fixtures; see the module header comment). A supplied eventId that does not match its own derived
  // hash is rejected as invalid, never silently accepted or auto-corrected.
  const derived = deterministicVideoRevisionEventId(
    videoRevisionIdentityMaterial(record),
  );
  if (record.eventId !== derived)
    throw REQUEST_INVALID(
      "eventId does not match its deterministic derivation",
    );
}

export function videoRevisionIdentityMaterial(
  event: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const {
    eventId: _eventId,
    occurredAt: _occurredAt,
    ...identityMaterial
  } = event;
  return identityMaterial;
}

export function deterministicVideoRevisionEventId(
  identityMaterial: unknown,
): string {
  return `evt_${sha256Hex(canonicalJson(identityMaterial)).slice(0, 32)}`;
}

// ---- bounded SCP Automation receipt -------------------------------------------------------------

export function buildScpAutomationReceipt(input: {
  eventId: string;
  videoSubmissionId: string;
  videoRevision: number;
  contentFingerprint: string;
  receivedAtIso: string;
}): ScpAutomationReceipt {
  return {
    schemaVersion: SCP_AUTOMATION_RECEIPT_SCHEMA_VERSION,
    receiver: "scp_automation",
    status: "received",
    eventId: input.eventId as ScpAutomationReceipt["eventId"],
    videoSubmissionId: input.videoSubmissionId,
    videoRevision: input.videoRevision,
    contentFingerprint: input.contentFingerprint,
    receivedAt: input.receivedAtIso,
  };
}

const RECEIPT_KEYS = [
  "schemaVersion",
  "receiver",
  "status",
  "eventId",
  "videoSubmissionId",
  "videoRevision",
  "contentFingerprint",
  "receivedAt",
] as const;

/** Fail-closed guard: the bounded receipt must have EXACTLY these keys, the pinned consts, and fit the byte budget. */
export function assertBoundedScpAutomationReceipt(
  receipt: ScpAutomationReceipt,
): void {
  const record = receipt as unknown as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...RECEIPT_KEYS].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(
      "invariant: bounded SCP automation receipt has unexpected keys",
    );
  }
  if (
    receipt.schemaVersion !== SCP_AUTOMATION_RECEIPT_SCHEMA_VERSION ||
    receipt.receiver !== "scp_automation" ||
    receipt.status !== "received"
  ) {
    throw new Error("invariant: bounded SCP automation receipt const mismatch");
  }
  const bytes = Buffer.byteLength(canonicalJson(receipt), "utf8");
  if (bytes > SCP_VIDEO_REVISION_INGRESS_MAX_RECEIPT_BYTES) {
    throw new Error(
      "invariant: bounded SCP automation receipt exceeds the byte budget",
    );
  }
}

// ---- HMAC verification --------------------------------------------------------------------------

export type VideoRevisionIngressSigningKey = Readonly<{
  keyId: string;
  secret: string;
}>;
export type VideoRevisionIngressKeyRing = Readonly<{
  current: VideoRevisionIngressSigningKey;
  previous?: VideoRevisionIngressSigningKey;
}>;

export function resolveVideoRevisionIngressKeyRing(input: {
  currentKeyId?: string;
  currentSecret?: string;
  previousKeyId?: string;
  previousSecret?: string;
}): VideoRevisionIngressKeyRing {
  const currentKeyId =
    input.currentKeyId ??
    process.env[SCP_VIDEO_REVIEW_CURRENT_KEY_ID_ENV] ??
    "";
  const currentSecret =
    input.currentSecret ??
    process.env[SCP_VIDEO_REVIEW_CURRENT_KEY_SECRET_ENV] ??
    "";
  if (!currentKeyId || currentSecret.length < 32) {
    throw new ScpVideoRevisionIngressError(
      "video_revision_ingress_unconfigured",
      "video-revision-ingress current key is not configured",
    );
  }
  const previousKeyId =
    input.previousKeyId ??
    process.env[SCP_VIDEO_REVIEW_PREVIOUS_KEY_ID_ENV] ??
    "";
  const previousSecret =
    input.previousSecret ??
    process.env[SCP_VIDEO_REVIEW_PREVIOUS_KEY_SECRET_ENV] ??
    "";
  const ring: {
    current: VideoRevisionIngressSigningKey;
    previous?: VideoRevisionIngressSigningKey;
  } = {
    current: { keyId: currentKeyId, secret: currentSecret },
  };
  if (previousKeyId && previousSecret.length >= 32)
    ring.previous = { keyId: previousKeyId, secret: previousSecret };
  return ring;
}

// v3 wire signature: sha256=HMAC-SHA256(secret, `${unixSeconds}.${exactCanonicalBody}`) — matches the
// sibling outbound module (./scpVideoReviewV3Callbacks.ts's `videoReviewV3Signature`) and the vendored
// ./integrationEventV2.ts convention. Distinct from scp-creator-pipeline-v3's `${ts}\n${eventId}\n${body}`.
export function videoRevisionIngressSigningBytes(
  timestamp: string,
  body: string,
): string {
  return `${timestamp}.${body}`;
}

function videoRevisionIngressHmacHex(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(
      Buffer.from(videoRevisionIngressSigningBytes(timestamp, body), "utf8"),
    )
    .digest("hex");
}

/** Test-only helper mirroring the Portal producer, so unit tests can sign a fixture without a live secret exchange. */
export function signVideoRevisionIngressForTest(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return `sha256=${videoRevisionIngressHmacHex(secret, timestamp, body)}`;
}

export type VideoRevisionIngressVerifiedRequest = Readonly<{
  timestamp: number;
  eventIdHeader: string;
  keySlot: "current" | "previous";
}>;

export function verifyVideoRevisionIngressSignature(input: {
  rawBody: string;
  headers: Readonly<Record<string, string | undefined>>;
  keys: VideoRevisionIngressKeyRing;
  now: Date;
  maxSkewSeconds?: number;
}): VideoRevisionIngressVerifiedRequest {
  const eventIdHeader = input.headers["x-scp-event-id"];
  const idempotencyKeyHeader = input.headers["x-scp-idempotency-key"];
  const keyIdHeader = input.headers["x-scp-key-id"];
  const signatureHeader = input.headers["x-scp-signature"];
  const timestampHeader = input.headers["x-scp-timestamp"];
  const contentSha256Header = input.headers["x-scp-content-sha256"];
  if (
    !eventIdHeader ||
    !idempotencyKeyHeader ||
    !keyIdHeader ||
    !signatureHeader ||
    !timestampHeader ||
    !contentSha256Header
  ) {
    throw new ScpVideoRevisionIngressError(
      "video_revision_ingress_signature_invalid",
      "missing required signature headers",
    );
  }
  if (idempotencyKeyHeader !== eventIdHeader) {
    throw new ScpVideoRevisionIngressError(
      "video_revision_ingress_signature_invalid",
      "x-scp-idempotency-key must equal x-scp-event-id",
    );
  }
  if (!isEventId(eventIdHeader)) {
    throw new ScpVideoRevisionIngressError(
      "video_revision_ingress_signature_invalid",
      "invalid x-scp-event-id shape",
    );
  }
  if (!/^(0|[1-9][0-9]*)$/.test(timestampHeader)) {
    throw new ScpVideoRevisionIngressError(
      "video_revision_ingress_signature_stale",
      "invalid x-scp-timestamp shape",
    );
  }
  const timestamp = Number(timestampHeader);
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const maxSkewSeconds =
    input.maxSkewSeconds ?? SCP_VIDEO_REVISION_INGRESS_MAX_SKEW_SECONDS;
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(nowSeconds - timestamp) > maxSkewSeconds
  ) {
    throw new ScpVideoRevisionIngressError(
      "video_revision_ingress_signature_stale",
      "timestamp is outside the allowed skew",
    );
  }
  if (!safeEqual(contentSha256Header, sha256Hex(input.rawBody))) {
    throw new ScpVideoRevisionIngressError(
      "video_revision_ingress_signature_invalid",
      "x-scp-content-sha256 does not match the body",
    );
  }
  const keySlot: "current" | "previous" | null =
    keyIdHeader === input.keys.current.keyId
      ? "current"
      : keyIdHeader === input.keys.previous?.keyId
        ? "previous"
        : null;
  if (!keySlot)
    throw new ScpVideoRevisionIngressError(
      "video_revision_ingress_signature_invalid",
      "unknown x-scp-key-id",
    );
  const key = keySlot === "current" ? input.keys.current : input.keys.previous!;
  const expected = `sha256=${videoRevisionIngressHmacHex(key.secret, timestampHeader, input.rawBody)}`;
  if (!safeEqual(expected, signatureHeader)) {
    throw new ScpVideoRevisionIngressError(
      "video_revision_ingress_signature_invalid",
      "signature mismatch",
    );
  }
  return { timestamp, eventIdHeader, keySlot };
}

// ---- pure revision-monotonicity / state-patch planning (no I/O; unit-testable) -------------------

export type PriorReviewState = Readonly<{
  exists: boolean;
  revision: number;
  payloadHash: string;
  state: string;
  traceId: string;
  contentFingerprint: string;
}>;

export type VideoRevisionIngestPlan =
  | Readonly<{ outcome: "conflict"; reasonCode: string }>
  | Readonly<{
      outcome: "noop";
      newRevision: number;
    }>
  | Readonly<{
      outcome: "accept";
      newRevision: number;
      isCreate: boolean;
      statePatch: Record<string, unknown>;
      markSuperseded: boolean;
      markWithdrawn: boolean;
      invalidateFingerprints: boolean;
      upsertFingerprint: boolean;
      enqueueAutomation: boolean;
    }>;

/**
 * Program attribution the caller resolved BEFORE calling this pure function (same discipline as
 * scpIntegrationEventV2.ts's pre-transaction videoCreator resolution) — the Portal signs every
 * event with its single apply-gate tag (view-cpm, see reviewStateProgramResolution.ts), never a
 * real program. Omitted (legacy callers, existing tests): behavior is unchanged — the raw
 * `subject.programId` is used as-is and no `portalProgramId` field is added.
 */
export type VideoRevisionProgramResolution = Readonly<{
  programId: string;
  portalProgramId: string | null;
}>;

/**
 * Pure decision core: given the event, the prior canonical review-state snapshot (or absence), and now,
 * decide conflict / no-op / accept, and (for accept) the exact review-state merge patch. No Firestore
 * access — the caller (planAndPersistVideoRevisionIngest) is responsible for reading prior state and
 * committing the patch inside one transaction alongside the receipt ledger.
 */
export function planVideoRevisionIngest(
  event: PortalVideoRevisionEvent,
  prior: PriorReviewState,
  nowIso: string,
  programResolution?: VideoRevisionProgramResolution,
): VideoRevisionIngestPlan {
  const subject = event.subject;
  const newRevision = subject.videoRevision;
  const docIdValue = videoReviewStateDocId(subject.videoSubmissionId);
  // canonicalProgramId and subject.programId MUST agree (videoReviewProgramScopeFromTrustedRecords
  // reads both off this same doc and throws "ambiguous" when they resolve to different programs) —
  // so the resolved subject mirrors the resolved canonicalProgramId; the raw Portal tag survives in
  // portalProgramId (top-level) and subject.portalProgramId (audit), never lost.
  const resolvedProgramId = programResolution?.programId || subject.programId;
  const resolvedSubject: Record<string, unknown> = programResolution
    ? { ...subject, programId: resolvedProgramId, portalProgramId: programResolution.portalProgramId }
    : subject;

  if (prior.exists && prior.traceId && prior.traceId !== event.traceId) {
    return { outcome: "conflict", reasonCode: "trace_mismatch" };
  }
  if (prior.exists && newRevision < prior.revision) {
    return { outcome: "conflict", reasonCode: "revision_not_monotonic" };
  }
  if (prior.exists && newRevision === prior.revision) {
    if (event.payload.payloadHash === prior.payloadHash) {
      return { outcome: "noop", newRevision };
    }
    return { outcome: "conflict", reasonCode: "revision_conflicting_payload" };
  }

  const baseStatePatch: Record<string, unknown> = {
    revision: newRevision,
    contentFingerprint: subject.contentFingerprint,
    canonicalProgramId: resolvedProgramId,
    ...(programResolution ? { portalProgramId: programResolution.portalProgramId } : {}),
    policyConfigHash: subject.policyVersion,
    subject: resolvedSubject,
    // Explicit Portal projection identity only; legacy events remain unavailable and are never inferred.
    sourceSubmissionId: subject.sourceSubmissionId ?? null,
    traceId: event.traceId,
    reviewId: `review_${docIdValue}`,
    feedEligible: false,
    reportEligible: false,
    trackingEligible: false,
    settlementEligible: false,
    downstreamProjectionConfirmed: false,
    lastEventId: event.eventId,
    lastEventName: event.eventName,
    lastPayloadHash: event.payload.payloadHash,
    updatedAtIso: nowIso,
  };

  if (event.eventName === "video.revision.submitted") {
    const submitted = event as PortalVideoRevisionSubmittedEvent;
    const invalidates = submitted.payload.invalidatesApprovedRevision;
    // spec_partner_activation_from_video_approval §6.4: `superseded` is a fact about the PREVIOUS
    // approved revision being invalidated, never a property of the new current head itself. The new
    // submitted head ALWAYS carries superseded:false; the invalidation of the prior approved revision
    // is preserved separately via `invalidatedApprovedRevision` (the old revision number) plus an
    // append-only invalidation ledger entry (written below in reserveAndUpsertVideoRevision).
    const invalidatesApprovedRevision = Boolean(
      invalidates !== undefined &&
      prior.exists &&
      prior.state === "approved" &&
      prior.revision === invalidates,
    );
    return {
      outcome: "accept",
      newRevision,
      isCreate: !prior.exists,
      statePatch: {
        ...baseStatePatch,
        state: "queued",
        youtubeVideoId: submitted.payload.youtubeVideoId,
        youtubeUrl: submitted.payload.canonicalVideoUrl,
        contentType: submitted.payload.contentType,
        withdrawn: false,
        superseded: false,
        // B2 P1: 이 리비전의 제출 시각 정본. 같은 트랜잭션의 제출 원장(content-submitted outbox
        // createdAtIso)과 동일한 시계이며, 새 리비전이 올 때만 갱신된다(리비전 단위 immutable).
        // 판정·콜백으로 바뀌는 `updatedAtIso` 는 제출 시각 대체값으로 쓰지 않는다.
        currentRevisionSubmittedAtIso: nowIso,
        // A superseding revision MUST NOT inherit the previous media's AI outputs — otherwise the
        // operator sees an aiRecommendation/analysisEvidence generated against the OLD video and
        // the analysis drain's alreadyAnalyzed (schema+gameKey keyed, not revision keyed) skips
        // re-analysis forever. Mirrors the scp.integration-event.v2 supersede block
        // (scpIntegrationEventV2.ts) so both ingress lanes apply the same resubmission contract.
        ruleEvidenceLedger: initialVideoReviewRuleEvidenceLedger(nowIso),
        aiRecommendation: FieldValue.delete(),
        aiRecommendationMultimodal: FieldValue.delete(),
        videoReviewByScope: FieldValue.delete(),
        latestVideoReviewDecisionRef: FieldValue.delete(),
        lastDecisionEvidence: FieldValue.delete(),
        lastReviewEvidence: FieldValue.delete(),
        videoReviewEvidence: FieldValue.delete(),
        analysisEvidence: FieldValue.delete(),
        analysisSkip: FieldValue.delete(),
        analysisMediaRetry: FieldValue.delete(),
        previousRevision: prior.exists ? prior.revision : null,
        previousContentFingerprint: asString(prior.contentFingerprint) || null,
        revisionSupersededAtIso: prior.exists ? nowIso : null,
        ...(invalidatesApprovedRevision
          ? { invalidatedApprovedRevision: invalidates }
          : {}),
      },
      markSuperseded: invalidatesApprovedRevision,
      markWithdrawn: false,
      invalidateFingerprints: true,
      upsertFingerprint: true,
      enqueueAutomation: true,
    };
  }

  const withdrawn = event as PortalVideoRevisionWithdrawnEvent;
  const invalidates = withdrawn.payload.invalidatesApprovedRevision;
  const markWithdrawnApproved = Boolean(
    invalidates !== undefined &&
    prior.exists &&
    prior.state === "approved" &&
    prior.revision === invalidates,
  );
  return {
    outcome: "accept",
    newRevision,
    isCreate: !prior.exists,
    statePatch: {
      ...baseStatePatch,
      withdrawn: true,
      ...(markWithdrawnApproved
        ? { invalidatedApprovedRevision: invalidates }
        : {}),
    },
    markSuperseded: false,
    markWithdrawn: true,
    invalidateFingerprints: markWithdrawnApproved,
    upsertFingerprint: false,
    enqueueAutomation: false,
  };
}

// ---- durable receipt ledger + review-state upsert (one Firestore transaction) --------------------

export type VideoRevisionLedgerDecision =
  | Readonly<{ decision: "duplicate"; receipt: ScpAutomationReceipt }>
  | Readonly<{ decision: "noop"; receipt: ScpAutomationReceipt }>
  | Readonly<{
      decision: "accepted";
      receipt: ScpAutomationReceipt;
      plan: Extract<VideoRevisionIngestPlan, { outcome: "accept" }>;
      committedReviewStateScopes: ReviewQueueCacheInvalidationScope[];
    }>;

async function reserveAndUpsertVideoRevision(
  event: PortalVideoRevisionEvent,
  signatureHeader: string,
  identitySha256: string,
  bodySha256: string,
  now: Date,
  programResolution?: VideoRevisionProgramResolution,
): Promise<VideoRevisionLedgerDecision> {
  const nowIso = now.toISOString();
  const sigRef = adminDb
    .collection(SCP_VIDEO_REVISION_INGRESS_RECEIPTS_COLLECTION)
    .doc(`sig:${docId(signatureHeader)}`);
  const evtRef = adminDb
    .collection(SCP_VIDEO_REVISION_INGRESS_RECEIPTS_COLLECTION)
    .doc(`evt:${docId(event.eventId)}`);
  const stateRef = adminDb
    .collection(SCP_VIDEO_REVIEW_STATE_COLLECTION)
    .doc(videoReviewStateDocId(event.subject.videoSubmissionId));
  const contentMailRef =
    event.eventName === "video.revision.submitted"
      ? adminDb
          .collection(SCP_CONTENT_SUBMITTED_MAIL_OUTBOX_COLLECTION)
          .doc(
            contentSubmittedMailOutboxDocId(
              event.subject.videoSubmissionId,
              event.subject.videoRevision,
            ),
          )
      : null;
  const contentMailTemplate =
    event.eventName === "video.revision.submitted"
      ? await resolveScpReceiptMailTemplate("content_submitted", {
          application_id: event.subject.applicationId,
          program_name: event.subject.programId,
          video_submission_id: event.subject.videoSubmissionId,
          video_revision: String(event.subject.videoRevision),
        })
      : null;

  return adminDb.runTransaction<VideoRevisionLedgerDecision>(
    async (transaction) => {
      const [sigSnap, evtSnap, stateSnap, contentMailSnap] = await Promise.all([
        transaction.get(sigRef),
        transaction.get(evtRef),
        transaction.get(stateRef),
        contentMailRef ? transaction.get(contentMailRef) : Promise.resolve(null),
      ]);

      // (1) authenticated-signature replay guard — before any effect.
      if (sigSnap.exists) {
        const sig = sigSnap.data() ?? {};
        const exactAcceptedRetry =
          sig.accepted === true &&
          asString(sig.eventId) === event.eventId &&
          asString(sig.identitySha256) === identitySha256 &&
          asString(sig.bodySha256) === bodySha256;
        if (!exactAcceptedRetry) {
          throw new ScpVideoRevisionIngressError(
            "video_revision_ingress_state_conflict",
            "signature replay rejected",
          );
        }
        const persisted = asRecord(
          evtSnap.data()?.receipt,
        ) as unknown as ScpAutomationReceipt;
        return { decision: "duplicate", receipt: persisted };
      }

      // (2) global eventId idempotency + logical identity equality.
      if (evtSnap.exists) {
        const receipt = evtSnap.data() ?? {};
        if (asString(receipt.identitySha256) !== identitySha256) {
          throw new ScpVideoRevisionIngressError(
            "video_revision_ingress_state_conflict",
            "same eventId with a different identity",
          );
        }
        transaction.set(sigRef, {
          kind: "signature",
          eventId: event.eventId,
          identitySha256,
          bodySha256,
          accepted: true,
          createdAtIso: nowIso,
          createdAt: FieldValue.serverTimestamp(),
        });
        const persisted = asRecord(
          receipt.receipt,
        ) as unknown as ScpAutomationReceipt;
        return { decision: "duplicate", receipt: persisted };
      }

      const priorData = stateSnap.exists ? (stateSnap.data() ?? {}) : {};
      const priorSubject = asRecord(priorData.subject);
      const priorInvalidationScope = stateSnap.exists
        ? {
            canonicalProgramId:
              asString(priorData.canonicalProgramId) ||
              asString(priorSubject.programId) ||
              asString(priorData.programId),
            campaignId:
              asString(priorSubject.campaignId) ||
              asString(priorData.campaignId),
          }
        : null;
      const prior: PriorReviewState = {
        exists: stateSnap.exists,
        revision: Number(priorData.revision ?? 0),
        payloadHash: asString(priorData.lastPayloadHash),
        state: asString(priorData.state, "queued"),
        traceId: asString(priorData.traceId),
        contentFingerprint: asString(priorData.contentFingerprint),
      };

      const plan = planVideoRevisionIngest(event, prior, nowIso, programResolution);

      if (plan.outcome === "conflict") {
        throw new ScpVideoRevisionIngressError(
          "video_revision_ingress_state_conflict",
          plan.reasonCode,
        );
      }

      const receipt = buildScpAutomationReceipt({
        eventId: event.eventId,
        videoSubmissionId: event.subject.videoSubmissionId,
        videoRevision: event.subject.videoRevision,
        contentFingerprint: event.subject.contentFingerprint,
        receivedAtIso: nowIso,
      });
      assertBoundedScpAutomationReceipt(receipt);

      // Reserve the ledger BEFORE any state-doc effect so a mid-commit failure can never leave the
      // ledger silently absent (Firestore transactions are all-or-nothing, but this ordering documents
      // intent and matches ./scpCreatorPipelineV3Receiver.ts's convention).
      transaction.set(evtRef, {
        kind: "receipt",
        eventId: event.eventId,
        eventName: event.eventName,
        identitySha256,
        bodySha256,
        // Opaque Portal/Flu ids only (P0 PRIVACY, module header). Mail intent is written atomically
        // below; these receipts are never scanned to backfill historical mail.
        applicationId: event.subject.applicationId,
        programId: event.subject.programId,
        campaignId: event.subject.campaignId,
        ...(event.subject.outreachId
          ? { outreachId: event.subject.outreachId }
          : {}),
        portalCreatorId: event.subject.portalCreatorId,
        fluCreatorId: event.subject.fluCreatorId,
        partnerId: event.subject.partnerId,
        enrollmentId: event.subject.enrollmentId,
        videoSubmissionId: event.subject.videoSubmissionId,
        videoRevision: event.subject.videoRevision,
        traceId: event.traceId,
        effectState: "done",
        receipt,
        createdAtIso: nowIso,
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.set(sigRef, {
        kind: "signature",
        eventId: event.eventId,
        identitySha256,
        bodySha256,
        accepted: true,
        createdAtIso: nowIso,
        createdAt: FieldValue.serverTimestamp(),
      });

      if (plan.outcome === "noop") {
        return { decision: "noop", receipt };
      }

      if (
        contentMailRef &&
        !contentMailSnap?.exists &&
        event.eventName === "video.revision.submitted"
      ) {
        transaction.create(
          contentMailRef,
          contentSubmittedMailOutboxRow({
            applicationId: event.subject.applicationId,
            programId: event.subject.programId,
            campaignId: event.subject.campaignId,
            outreachId: event.subject.outreachId,
            portalCreatorId: event.subject.portalCreatorId,
            fluCreatorId: event.subject.fluCreatorId,
            partnerId: event.subject.partnerId,
            enrollmentId: event.subject.enrollmentId,
            sourceSubmissionId: event.subject.sourceSubmissionId,
            settlementCreatorCode: event.subject.settlementCreatorCode,
            channelId: event.subject.channelId,
            contentFingerprint: event.subject.contentFingerprint,
            policyVersion: event.subject.policyVersion,
            videoSubmissionId: event.subject.videoSubmissionId,
            videoRevision: event.subject.videoRevision,
            eventId: event.eventId,
            traceId: event.traceId,
            sourceContract: SCP_VIDEO_REVISION_INGRESS_CONTRACT,
            templateSnapshot: contentMailTemplate ?? undefined,
            nowIso,
          }),
        );
      }

      const patch: Record<string, unknown> = {
        ...plan.statePatch,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (plan.isCreate) {
        patch.reviewLedger = [];
        patch.appliedDecisionRefs = [];
      }
      // Append-only invalidation ledger event (spec §6.4): preserved separately from the new head's own
      // state so a legitimate replacement/withdrawal head can finalize while the invalidated PRIOR
      // approved revision never can (consumers key off `invalidatedApprovedRevision`, never off the new
      // head's own `superseded`, which is always false).
      const invalidatedApprovedRevision = (
        plan.statePatch as Record<string, unknown>
      ).invalidatedApprovedRevision;
      if (typeof invalidatedApprovedRevision === "number") {
        patch.revisionInvalidationLedger = FieldValue.arrayUnion({
          invalidatedRevision: invalidatedApprovedRevision,
          newRevision: plan.newRevision,
          reasonCode: plan.markWithdrawn ? "withdrawn" : "superseded",
          invalidatedAtIso: nowIso,
        });
      }
      transaction.set(stateRef, patch, { merge: true });

      // Task-100 갭 ①: 열린 재제출 사이클(rejected 로 닫혀 resubmissionCycleActive:true 로 남은
      // 직전 사이클)이 있을 때만 "resubmitted" 로 갱신한다. changes_requested 뒤의 재제출은 애초에
      // 사이클이 없으므로(videoReviewTransitionStore.ts 는 rejected 에만 사이클을 연다) 아무 일도
      // 하지 않는다 — 별도 조회 없이 이미 읽은 priorData 만으로 판단한다.
      if (
        event.eventName === "video.revision.submitted" &&
        priorData.resubmissionCycleActive === true &&
        Number(priorData.resubmissionCycleSeq ?? 0) > 0
      ) {
        const cycleSeq = Number(priorData.resubmissionCycleSeq);
        transaction.set(
          adminDb.collection(VIDEO_RESUBMISSION_CYCLE_COLLECTION)
            .doc(resubmissionCycleDocId(event.subject.videoSubmissionId, cycleSeq)),
          buildResubmissionCycleResubmittedPatch({
            resubmittedAtIso: nowIso,
            resubmittedRevision: plan.newRevision,
          }),
          { merge: true },
        );
      }

      return {
        decision: "accepted",
        receipt,
        plan,
        committedReviewStateScopes: [
          ...(priorInvalidationScope ? [priorInvalidationScope] : []),
          {
            canonicalProgramId:
              typeof plan.statePatch.canonicalProgramId === "string"
                ? plan.statePatch.canonicalProgramId
                : "",
            campaignId: event.subject.campaignId,
          },
        ],
      };
    },
  );
}

// ---- ingest orchestration ------------------------------------------------------------------------

export type IngestScpVideoRevisionInput = {
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

export type IngestScpVideoRevisionResult = {
  status: 201 | 200 | 202;
  duplicate: boolean;
  noOp: boolean;
  eventId: string;
  videoSubmissionId: string;
  videoRevision: number;
  receipt: ScpAutomationReceipt;
};

export async function ingestScpVideoRevision(
  input: IngestScpVideoRevisionInput,
): Promise<IngestScpVideoRevisionResult> {
  if (!input.isHttps)
    throw new ScpVideoRevisionIngressError(
      "video_revision_ingress_signature_invalid",
      "https required",
    );
  if (input.hasBearerCookieOrOrigin)
    throw new ScpVideoRevisionIngressError(
      "video_revision_ingress_signature_invalid",
      "service auth is HMAC only",
    );
  if (
    Buffer.byteLength(input.rawBody, "utf8") >
    SCP_VIDEO_REVISION_INGRESS_MAX_BODY_BYTES
  ) {
    throw new ScpVideoRevisionIngressError(
      "video_revision_ingress_body_too_large",
      "request body exceeds the maximum size",
    );
  }
  const now = input.now ?? new Date();

  // Fail-closed BEFORE touching the body: no configured current key => 401 unconfigured, never accept.
  const keys = resolveVideoRevisionIngressKeyRing({
    currentKeyId: input.currentKeyId,
    currentSecret: input.currentSecret,
    previousKeyId: input.previousKeyId,
    previousSecret: input.previousSecret,
  });

  const verified = verifyVideoRevisionIngressSignature({
    rawBody: input.rawBody,
    headers: input.headers,
    keys,
    now,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    throw REQUEST_INVALID("body is not valid JSON");
  }
  // Exact-canonical-bytes gate: pretty-printed / reordered / whitespace-varied JSON is rejected even
  // though it parses, because the wire contract requires byte-identical Portal canonical JSON.
  let canonicalBody: string;
  try {
    canonicalBody = canonicalJson(parsed);
  } catch {
    throw new ScpVideoRevisionIngressError(
      "non_canonical_bytes",
      "body is not canonical JSON",
    );
  }
  if (canonicalBody !== input.rawBody) {
    throw new ScpVideoRevisionIngressError(
      "non_canonical_bytes",
      "body bytes are not Portal canonical JSON",
    );
  }

  assertPortalVideoRevisionEvent(parsed);
  const event = parsed;

  if (event.eventId !== verified.eventIdHeader) {
    throw new ScpVideoRevisionIngressError(
      "video_revision_ingress_signature_invalid",
      "x-scp-event-id does not match the body eventId",
    );
  }

  const identitySha256 = sha256Hex(
    canonicalJson(videoRevisionIdentityMaterial(event)),
  );
  const bodySha256 = sha256Hex(input.rawBody);
  const signatureHeader = String(input.headers["x-scp-signature"]);

  // 2026-09-06: resolve the real program BEFORE the transaction (same discipline as
  // scpIntegrationEventV2.ts) — the Portal signs every revision event with its single apply-gate
  // tag (view-cpm, see reviewStateProgramResolution.ts), never a real program.
  const programResolutionResult = await resolveReviewStateProgramId(
    {
      canonicalProgramId: event.subject.programId,
      subject: {
        applicationId: event.subject.applicationId,
        programId: event.subject.programId,
        campaignId: event.subject.campaignId,
      },
    },
    defaultReviewStateProgramResolutionDeps(),
  );
  const programResolution = {
    programId: programResolutionResult.programId,
    portalProgramId: programResolutionResult.portalProgramId,
  };

  let ledgerDecision: VideoRevisionLedgerDecision;
  try {
    ledgerDecision = await reserveAndUpsertVideoRevision(
      event,
      signatureHeader,
      identitySha256,
      bodySha256,
      now,
      programResolution,
    );
  } catch (error) {
    if (error instanceof ScpVideoRevisionIngressError) throw error;
    throw error;
  }

  if (ledgerDecision.decision === "duplicate") {
    return {
      status: 200,
      duplicate: true,
      noOp: false,
      eventId: event.eventId,
      videoSubmissionId: event.subject.videoSubmissionId,
      videoRevision: event.subject.videoRevision,
      receipt: ledgerDecision.receipt,
    };
  }
  if (ledgerDecision.decision === "noop") {
    return {
      status: 200,
      duplicate: false,
      noOp: true,
      eventId: event.eventId,
      videoSubmissionId: event.subject.videoSubmissionId,
      videoRevision: event.subject.videoRevision,
      receipt: ledgerDecision.receipt,
    };
  }

  // Task-53: the state-doc write above just committed a (possibly new) canonicalProgramId/state —
  // invalidate only the queue-counts/splice cache entries that write could have changed.
  invalidateReviewQueueCachesForCommittedWriteScopes(
    ledgerDecision.committedReviewStateScopes,
  );

  // Accepted: the receipt + review-state commit are already durable. Post-commit best-effort work
  // (fingerprint registry + §5 immediate-analysis enqueue) never downgrades this accepted response —
  // a transient failure here is recorded and left to the 1-minute scheduler fallback to converge.
  await runPostCommitEffects(event, ledgerDecision.plan, now);

  return {
    status: 201,
    duplicate: false,
    noOp: false,
    eventId: event.eventId,
    videoSubmissionId: event.subject.videoSubmissionId,
    videoRevision: event.subject.videoRevision,
    receipt: ledgerDecision.receipt,
  };
}

async function runPostCommitEffects(
  event: PortalVideoRevisionEvent,
  plan: Extract<VideoRevisionIngestPlan, { outcome: "accept" }>,
  now: Date,
): Promise<void> {
  const submissionId = event.subject.videoSubmissionId;

  if (plan.invalidateFingerprints) {
    try {
      await invalidateStaleFingerprintsOnRevision(
        submissionId,
        plan.newRevision,
        now,
      );
    } catch (error) {
      console.warn(
        "[video-revision-ingress] invalidate_stale_fingerprints_pending",
        JSON.stringify({
          submissionId: docId(submissionId),
          code: asString(asRecord(error).code) || "unknown",
        }),
      );
    }
  }

  if (
    plan.upsertFingerprint &&
    event.eventName === "video.revision.submitted"
  ) {
    const submitted = event as PortalVideoRevisionSubmittedEvent;
    try {
      await upsertVideoFingerprint(
        {
          videoSubmissionId: submissionId,
          youtubeVideoId: submitted.payload.youtubeVideoId,
          fileHash: null,
          pHash: null,
          transcriptMinHash: null,
          revision: plan.newRevision,
          canonicalProgramId: event.subject.programId,
        },
        now,
      );
    } catch (error) {
      console.warn(
        "[video-revision-ingress] fingerprint_upsert_pending",
        JSON.stringify({
          submissionId: docId(submissionId),
          code: asString(asRecord(error).code) || "unknown",
        }),
      );
    }
  }

  if (plan.enqueueAutomation) {
    try {
      // sourceKind defaults to "legacy_submission", which resolves against the `submissions`
      // collection — a v3-native submission has no document there, so the enqueue silently died
      // as submission_not_found and no ai_recommendation/multimodal/auto-reject job was ever
      // created. The canonical source of truth is scp_video_review_state, addressed by the
      // sanitized doc id (videoReviewStateDocId), with the accepted revision pinned so a stale
      // drain can't reuse a superseded snapshot.
      await enqueueVideoReviewAutomationOutbox({
        submissionId: videoReviewStateDocId(submissionId),
        kind: "ai_recommendation",
        nowIso: now.toISOString(),
        sourceKind: "canonical_review_state",
        sourceRevision: plan.newRevision,
      });
    } catch (error) {
      // Best-effort: the 1-minute automation scheduler is the fallback path (handoff §5), so a
      // transiently-unavailable enqueue must never fail the already-accepted ingest.
      console.warn(
        "[video-revision-ingress] automation_enqueue_pending",
        JSON.stringify({
          submissionId: docId(submissionId),
          code: asString(asRecord(error).code) || "unknown",
        }),
      );
    }
  }

}

// ---- HTTP handler ---------------------------------------------------------------------------------

// Portal consumes status codes + the bounded receipt only. Mirrors ./scpCreatorPipelineV3Receiver.ts's
// onRequest response/error-status pattern. Registration snippet for the parent (index.ts owns this):
//
//   export const scpVideoRevisionIntake = onRequest(
//     {
//       invoker: "public",
//       maxInstances: 3,
//       concurrency: 20,
//       timeoutSeconds: 30,
//       memory: "256MiB",
//       secrets: [
//         SCP_VIDEO_REVIEW_CURRENT_KEY_ID_ENV,
//         SCP_VIDEO_REVIEW_CURRENT_KEY_SECRET_ENV,
//         SCP_VIDEO_REVIEW_PREVIOUS_KEY_ID_ENV,
//         SCP_VIDEO_REVIEW_PREVIOUS_KEY_SECRET_ENV,
//       ],
//     },
//     scpVideoRevisionIngressHandler,
//   );
export async function scpVideoRevisionIngressHandler(
  request: Request,
  response: Response,
): Promise<void> {
  response.set("Cache-Control", "private, no-store, max-age=0");
  response.set("X-Content-Type-Options", "nosniff");
  if (request.method !== "POST") {
    response.set("Allow", "POST");
    response.status(405).send({ ok: false, code: "method_not_allowed" });
    return;
  }
  if (
    !/^application\/json(?:\s*;|$)/i.test(request.get("content-type") ?? "")
  ) {
    response.status(415).send({ ok: false, code: "unsupported_media_type" });
    return;
  }
  const rawBody = Buffer.isBuffer(request.rawBody)
    ? request.rawBody.toString("utf8")
    : "";
  if (
    Buffer.byteLength(rawBody, "utf8") >
    SCP_VIDEO_REVISION_INGRESS_MAX_BODY_BYTES
  ) {
    response
      .status(400)
      .send({ ok: false, code: "video_revision_ingress_body_too_large" });
    return;
  }
  const forwardedProtocol = (request.get("x-forwarded-proto") ?? "")
    .split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  const emulatorHttpsException =
    process.env.FUNCTIONS_EMULATOR === "true" &&
    /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(request.get("host") ?? "");
  try {
    const result = await ingestScpVideoRevision({
      rawBody,
      headers: {
        "x-scp-event-id": request.get("x-scp-event-id"),
        "x-scp-idempotency-key": request.get("x-scp-idempotency-key"),
        "x-scp-key-id": request.get("x-scp-key-id"),
        "x-scp-signature": request.get("x-scp-signature"),
        "x-scp-timestamp": request.get("x-scp-timestamp"),
        "x-scp-content-sha256": request.get("x-scp-content-sha256"),
      },
      isHttps:
        request.secure ||
        request.protocol === "https" ||
        forwardedProtocol === "https" ||
        emulatorHttpsException,
      hasBearerCookieOrOrigin: Boolean(
        request.get("authorization") ||
        request.get("cookie") ||
        request.get("origin"),
      ),
    });
    response.status(result.status).send({
      ok: true,
      duplicate: result.duplicate,
      noOp: result.noOp,
      eventId: result.eventId,
      receipt: result.receipt,
    });
  } catch (error) {
    const code = asRecord(error).code;
    const codeText = typeof code === "string" ? code : undefined;
    response.status(scpVideoRevisionIngressErrorStatus(codeText)).send({
      ok: false,
      code:
        codeText && /^[a-z][a-z0-9_]{2,79}$/.test(codeText)
          ? codeText
          : "temporarily_unavailable",
    });
  }
}
