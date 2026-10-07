// scp.integration-event.v2 contract library — vendored from the Portal repo with W2's additive
// optional application identity fields (`portalCreatorId`/`channelId`).
//
// Portal G013 base handoff plus the W2 additive schema:
//   schemaSha256           = 9bfa43d3505e681b1d5cc72cfda86e9e3f16704f2f13f33aee3491436f79d188
//   fixtureAggregateSha256 = d20e4506a5879bd66cbd7dcdede743016ad7d2a93fd313cb190e3c24cfeb574c
//
// The canonical JSON / identity / HMAC signing functions remain byte-identical to the Portal producer.
// Consumer validation preserves the e3dd217f base gates (safe-integer bounds, deterministic eventId,
// exact canonicalVideoUrl equality) and accepts only W2's two optional identity fields.
// Portal-producer-only helpers that depend on Portal-internal modules
// intentionally NOT vendored — Flu is the consumer + flu->portal callback producer.
// Do NOT hand-edit the canonical/identity/signing algorithms; re-vendor if the contract SHA changes.
// Fidelity is enforced by tests/integration-event-v2-contract.test.mjs (SHAs + Portal test vector).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const INTEGRATION_EVENT_V2_SCHEMA_VERSION = "scp.integration-event.v2" as const;
export const INTEGRATION_EVENT_V2_UID_POLICY = "required_before_gem" as const;
export const INTEGRATION_EVENT_V2_OUTBOX_COLLECTION = "scp_integration_event_v2_outbox";
export const integrationEventV2Names = [
  "application.submitted",
  "uid.guide-email.requested",
  "uid.submitted",
  "video.submitted",
  "video.review-status.changed",
  "video.view-snapshot.updated",
  "creator.channel-verified"
] as const;
export type IntegrationEventV2Name = (typeof integrationEventV2Names)[number];
export type IntegrationEventV2Source = "portal" | "flu";

export type IntegrationEventV2Subject = Readonly<{
  programId: string;
  applicationId: string;
  portalCreatorId?: string;
  channelId?: string;
  campaignId?: string;
  outreachId?: string;
  uidGrantId?: string;
  uidSubmissionId?: string;
  videoSubmissionId?: string;
  youtubeVideoId?: string;
  reviewId?: string;
  trackingId?: string;
}>;

type SubjectWith<Keys extends keyof IntegrationEventV2Subject> =
  IntegrationEventV2Subject & Required<Pick<IntegrationEventV2Subject, Keys>>;

type Envelope<
  Name extends IntegrationEventV2Name,
  Source extends IntegrationEventV2Source,
  Payload,
  Subject extends IntegrationEventV2Subject = IntegrationEventV2Subject
> = Readonly<{
  schemaVersion: typeof INTEGRATION_EVENT_V2_SCHEMA_VERSION;
  eventId: `evt_${string}`;
  eventName: Name;
  occurredAt: string;
  source: Source;
  traceId: `tr_${string}`;
  revision: number;
  subject: Readonly<Subject>;
  payload: Readonly<Payload>;
}>;

export type ApplicationSubmittedEventV2 = Envelope<"application.submitted", "portal", {
  applicationStatus: "submitted";
  locale: "en" | "ja" | "ko";
  uidPolicy: typeof INTEGRATION_EVENT_V2_UID_POLICY;
}, SubjectWith<"uidGrantId">>;
export type UidGuideEmailRequestedEventV2 = Envelope<"uid.guide-email.requested", "portal", {
  deliveryReason: "initial" | "resend";
  locale: "en" | "ja" | "ko";
}, SubjectWith<"uidGrantId">>;
export type UidSubmittedEventV2 = Envelope<"uid.submitted", "portal", {
  maskedUid: string;
  uidLookupHmac: string;
  validationStatus: "submitted" | "validating" | "verified" | "rejected" | "human_required";
}, SubjectWith<"uidGrantId" | "uidSubmissionId">>;
export type VideoSubmittedEventV2 = Envelope<"video.submitted", "portal", {
  canonicalVideoUrl: string;
  youtubeVideoId: string;
  reportedViews: number;
  contentType: "short" | "long_form" | "live";
  publishedAt: string;
  title?: string;
  uidPolicy: typeof INTEGRATION_EVENT_V2_UID_POLICY;
}, SubjectWith<"videoSubmissionId" | "youtubeVideoId">>;
export type VideoReviewStatusChangedEventV2 = Envelope<"video.review-status.changed", "flu", {
  reviewStatus: "pending" | "approved" | "rejected" | "changes_requested";
  reasonCode?: string;
}, SubjectWith<"videoSubmissionId" | "youtubeVideoId" | "reviewId">>;
export type VideoViewSnapshotUpdatedEventV2 = Envelope<"video.view-snapshot.updated", "flu", {
  viewCount: number;
  collectedAt: string;
  reviewStatus: "approved";
}, SubjectWith<"videoSubmissionId" | "youtubeVideoId" | "trackingId">>;
/**
 * Emitted by the portal the first time a creator's own YouTube OAuth connection and the audience
 * fetch that runs on that connection agree on a channel id (portal `verifiedChannelId` gate).
 * Neither of the two portal fields behind that gate is operator-writable, which is what lets Flu
 * treat this event as an authority root for `creators.youtubeChannelId` rather than a circular
 * one. Carries no handle: an applicant's self-reported handle is a typo axis (prod: `@codic3-g`
 * does not resolve, the same creator's real handle does), so Flu takes the display name from
 * YouTube keyed by the verified channel id instead.
 */
export type CreatorChannelVerifiedEventV2 = Envelope<"creator.channel-verified", "portal", {
  verifiedChannelId: string;
  verifiedAt: string;
  oauthConnectedAt: string;
  audienceFetchedAt: string;
  policyVersion: string;
}, SubjectWith<"portalCreatorId">>;
export type IntegrationEventV2 =
  | ApplicationSubmittedEventV2
  | UidGuideEmailRequestedEventV2
  | UidSubmittedEventV2
  | VideoSubmittedEventV2
  | VideoReviewStatusChangedEventV2
  | VideoViewSnapshotUpdatedEventV2
  | CreatorChannelVerifiedEventV2;

type IntegrationEventV2IdentityMaterialFor<Event extends IntegrationEventV2> =
  Event extends IntegrationEventV2
    ? Omit<Event, "schemaVersion" | "eventId" | "occurredAt">
    : never;

/**
 * The complete deterministic event identity input. Envelope version, generated ID, and
 * occurrence time are deliberately absent so callers cannot accidentally hash them.
 */
export type IntegrationEventV2IdentityMaterial = IntegrationEventV2IdentityMaterialFor<IntegrationEventV2>;
export type IntegrationEventV2BuildInput<Event extends IntegrationEventV2> =
  IntegrationEventV2IdentityMaterialFor<Event> & Readonly<{ occurredAt: string }>;

const RAW_EMAIL_LOOKING_STRING = /(^|[^A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}([^A-Za-z0-9._%+-]|$)/;
const RAW_UID_LABELLED_NUMERIC_STRING = /\buid[\s_:#=-]*[0-9]{8,20}\b/i;
const BARE_UID_LENGTH_NUMERIC_RUN = /(^|\D)[0-9]{8,20}(\D|$)/;
const STRICT_RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

export const integrationEventV2HeaderNames = {
  contentSha256: "x-scp-content-sha256",
  eventId: "x-scp-event-id",
  keyId: "x-scp-key-id",
  signature: "x-scp-signature",
  timestamp: "x-scp-timestamp"
} as const;

export type IntegrationEventV2SigningKey = Readonly<{ keyId: string; secret: string }>;
export type IntegrationEventV2KeyRing = Readonly<{
  current: IntegrationEventV2SigningKey;
  previous?: IntegrationEventV2SigningKey;
}>;

export class IntegrationEventV2Error extends Error {
  constructor(readonly code:
    | "invalid_event"
    | "sensitive_field_forbidden"
    | "signature_invalid"
    | "signature_stale"
    | "replay_rejected"
    | "idempotency_conflict"
    | "revision_not_monotonic"
    | "trace_mismatch") {
    super(code);
    this.name = "IntegrationEventV2Error";
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new IntegrationEventV2Error("invalid_event");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareJsonObjectKeysOrdinal(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new IntegrationEventV2Error("invalid_event");
}

function compareJsonObjectKeysOrdinal(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftCodeUnit = left.charCodeAt(index);
    const rightCodeUnit = right.charCodeAt(index);
    if (leftCodeUnit !== rightCodeUnit) return leftCodeUnit < rightCodeUnit ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function integrationEventV2Body(event: IntegrationEventV2): string {
  assertIntegrationEventV2(event);
  return canonicalJson(event);
}

export function integrationEventV2SigningBytes(timestamp: number, body: string): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new IntegrationEventV2Error("invalid_event");
  return `${timestamp}.${body}`;
}

function integrationEventV2HmacSha256(secret: string, timestamp: number, body: string): string {
  const message = integrationEventV2SigningBytes(timestamp, body);
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.from(message, "utf8"))
    .digest("hex");
}

export function deterministicIntegrationEventV2Id(input: IntegrationEventV2IdentityMaterial): `evt_${string}` {
  return `evt_${sha256Hex(canonicalJson(input)).slice(0, 32)}`;
}

export function integrationEventV2IdentityMaterial(event: IntegrationEventV2): IntegrationEventV2IdentityMaterial {
  const {
    schemaVersion: _schemaVersion,
    eventId: _eventId,
    occurredAt: _occurredAt,
    ...identityMaterial
  } = event;
  return identityMaterial;
}

export function identitySha256(event: IntegrationEventV2): string {
  assertIntegrationEventV2(event);
  return sha256Hex(canonicalJson(integrationEventV2IdentityMaterial(event)));
}

export function buildIntegrationEventV2(input: IntegrationEventV2BuildInput<ApplicationSubmittedEventV2>): ApplicationSubmittedEventV2;
export function buildIntegrationEventV2(input: IntegrationEventV2BuildInput<UidGuideEmailRequestedEventV2>): UidGuideEmailRequestedEventV2;
export function buildIntegrationEventV2(input: IntegrationEventV2BuildInput<UidSubmittedEventV2>): UidSubmittedEventV2;
export function buildIntegrationEventV2(input: IntegrationEventV2BuildInput<VideoSubmittedEventV2>): VideoSubmittedEventV2;
export function buildIntegrationEventV2(input: IntegrationEventV2BuildInput<VideoReviewStatusChangedEventV2>): VideoReviewStatusChangedEventV2;
export function buildIntegrationEventV2(input: IntegrationEventV2BuildInput<VideoViewSnapshotUpdatedEventV2>): VideoViewSnapshotUpdatedEventV2;
export function buildIntegrationEventV2(input: IntegrationEventV2BuildInput<IntegrationEventV2>): IntegrationEventV2 {
  const { occurredAt, ...identityMaterial } = input;
  const event = {
    ...identityMaterial,
    schemaVersion: INTEGRATION_EVENT_V2_SCHEMA_VERSION,
    eventId: deterministicIntegrationEventV2Id(identityMaterial),
    occurredAt
  };
  assertIntegrationEventV2(event);
  return event;
}

export function buildIntegrationEventV2Request(
  url: string,
  event: IntegrationEventV2,
  key: IntegrationEventV2SigningKey,
  timestamp = Math.floor(Date.now() / 1000)
): Readonly<{ url: string; method: "POST"; body: string; headers: Readonly<Record<string, string>> }> {
  const body = integrationEventV2Body(event);
  const contentSha256 = sha256Hex(body);
  const signature = integrationEventV2HmacSha256(key.secret, timestamp, body);
  return {
    url,
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      [integrationEventV2HeaderNames.contentSha256]: contentSha256,
      [integrationEventV2HeaderNames.eventId]: event.eventId,
      [integrationEventV2HeaderNames.keyId]: key.keyId,
      [integrationEventV2HeaderNames.signature]: `sha256=${signature}`,
      [integrationEventV2HeaderNames.timestamp]: String(timestamp)
    }
  };
}

export function verifyIntegrationEventV2Request(input: {
  body: string;
  headers: Headers | Readonly<Record<string, string | undefined>>;
  keys: IntegrationEventV2KeyRing;
  now?: Date;
  maxSkewSeconds?: number;
}): Readonly<{
  event: IntegrationEventV2;
  keySlot: "current" | "previous";
  identitySha256: string;
  bodySha256: string;
  timestamp: number;
}> {
  const timestampText = readHeader(input.headers, integrationEventV2HeaderNames.timestamp);
  if (!/^(0|[1-9][0-9]*)$/.test(timestampText)) throw new IntegrationEventV2Error("signature_stale");
  const timestamp = Number(timestampText);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > (input.maxSkewSeconds ?? 300)) {
    throw new IntegrationEventV2Error("signature_stale");
  }
  const contentSha256 = sha256Hex(input.body);
  if (!safeEqual(contentSha256, readHeader(input.headers, integrationEventV2HeaderNames.contentSha256))) {
    throw new IntegrationEventV2Error("signature_invalid");
  }
  const keyId = readHeader(input.headers, integrationEventV2HeaderNames.keyId);
  const keySlot = keyId === input.keys.current.keyId
    ? "current"
    : keyId === input.keys.previous?.keyId ? "previous" : null;
  if (!keySlot) throw new IntegrationEventV2Error("signature_invalid");
  const key = keySlot === "current" ? input.keys.current : input.keys.previous!;
  const expected = `sha256=${integrationEventV2HmacSha256(key.secret, timestamp, input.body)}`;
  if (!safeEqual(expected, readHeader(input.headers, integrationEventV2HeaderNames.signature))) {
    throw new IntegrationEventV2Error("signature_invalid");
  }
  let event: IntegrationEventV2;
  try {
    event = JSON.parse(input.body) as IntegrationEventV2;
  } catch {
    throw new IntegrationEventV2Error("invalid_event");
  }
  assertIntegrationEventV2(event);
  if (integrationEventV2Body(event) !== input.body) throw new IntegrationEventV2Error("invalid_event");
  if (event.eventId !== readHeader(input.headers, integrationEventV2HeaderNames.eventId)) {
    throw new IntegrationEventV2Error("signature_invalid");
  }
  return { event, keySlot, identitySha256: identitySha256(event), bodySha256: contentSha256, timestamp };
}

export type IntegrationEventV2Receipt = Readonly<{
  eventId: string;
  eventName: IntegrationEventV2Name;
  pipelineKey: string;
  identitySha256: string;
  bodySha256: string;
  revision: number;
  subjectKey: string;
  traceId: string;
}>;

export class IntegrationEventV2ReceiptLedger {
  private readonly eventReceipts = new Map<string, IntegrationEventV2Receipt>();
  private readonly subjectReceipts = new Map<string, IntegrationEventV2Receipt>();
  private readonly pipelineReceipts = new Map<string, IntegrationEventV2Receipt>();
  private readonly signatures = new Map<string, Readonly<{
    eventId: string;
    identitySha256: string;
    bodySha256: string;
    accepted: boolean;
  }>>();

  guardSignatureReplay(
    signature: string,
    event: IntegrationEventV2,
    bodySha256 = sha256Hex(integrationEventV2Body(event)),
    eventIdentitySha256 = identitySha256(event)
  ): void {
    const existingSignature = this.signatures.get(signature);
    if (existingSignature) {
      if (
        existingSignature.accepted &&
        existingSignature.eventId === event.eventId &&
        existingSignature.identitySha256 === eventIdentitySha256 &&
        existingSignature.bodySha256 === bodySha256
      ) return;
      throw new IntegrationEventV2Error("replay_rejected");
    }
    this.signatures.set(signature, {
      eventId: event.eventId,
      identitySha256: eventIdentitySha256,
      bodySha256,
      accepted: false
    });
  }

  markSignatureAccepted(
    signature: string,
    event: IntegrationEventV2,
    bodySha256 = sha256Hex(integrationEventV2Body(event)),
    eventIdentitySha256 = identitySha256(event)
  ): void {
    const existingSignature = this.signatures.get(signature);
    if (
      !existingSignature ||
      existingSignature.eventId !== event.eventId ||
      existingSignature.identitySha256 !== eventIdentitySha256 ||
      existingSignature.bodySha256 !== bodySha256
    ) throw new IntegrationEventV2Error("replay_rejected");
    this.signatures.set(signature, { ...existingSignature, accepted: true });
  }

  receive(
    event: IntegrationEventV2,
    bodySha256 = sha256Hex(integrationEventV2Body(event))
  ): Readonly<{ kind: "accepted" | "duplicate"; receipt: IntegrationEventV2Receipt }> {
    assertIntegrationEventV2(event);
    const eventIdentitySha256 = identitySha256(event);
    const existingEvent = this.eventReceipts.get(event.eventId);
    if (existingEvent) {
      if (existingEvent.identitySha256 !== eventIdentitySha256) {
        throw new IntegrationEventV2Error("idempotency_conflict");
      }
      return { kind: "duplicate", receipt: existingEvent };
    }
    const subjectKey = integrationEventV2SubjectKey(event);
    const pipelineKey = integrationEventV2PipelineKey(event);
    const previousPipeline = this.pipelineReceipts.get(pipelineKey);
    if (previousPipeline && event.traceId !== previousPipeline.traceId) {
      throw new IntegrationEventV2Error("trace_mismatch");
    }
    const previous = this.subjectReceipts.get(subjectKey);
    if (previous) {
      if (event.revision <= previous.revision) throw new IntegrationEventV2Error("revision_not_monotonic");
    }
    const receipt = {
      eventId: event.eventId,
      eventName: event.eventName,
      pipelineKey,
      identitySha256: eventIdentitySha256,
      bodySha256,
      revision: event.revision,
      subjectKey,
      traceId: event.traceId
    };
    this.eventReceipts.set(event.eventId, receipt);
    this.subjectReceipts.set(subjectKey, receipt);
    this.pipelineReceipts.set(pipelineKey, receipt);
    return { kind: "accepted", receipt };
  }
}

export function integrationEventV2SubjectKey(event: IntegrationEventV2): string {
  const common = [event.eventName, event.subject.programId, event.subject.applicationId] as const;
  switch (event.eventName) {
    case "application.submitted":
    case "uid.guide-email.requested":
      return canonicalJson([...common, event.subject.uidGrantId]);
    case "uid.submitted":
      return canonicalJson([...common, event.subject.uidGrantId, event.subject.uidSubmissionId]);
    case "video.submitted":
      return canonicalJson([...common, event.subject.videoSubmissionId, event.subject.youtubeVideoId]);
    case "video.review-status.changed":
      return canonicalJson([
        ...common,
        event.subject.videoSubmissionId,
        event.subject.youtubeVideoId,
        event.subject.reviewId
      ]);
    case "video.view-snapshot.updated":
      return canonicalJson([
        ...common,
        event.subject.videoSubmissionId,
        event.subject.youtubeVideoId,
        event.subject.trackingId
      ]);
    // Keyed on the portal creator rather than on the channel: the portal's backfill emitter
    // re-sends this event for creators who verified before the contract shipped, and redelivery
    // must collapse onto the same receipt instead of looking like a second verification.
    case "creator.channel-verified":
      return canonicalJson([...common, event.subject.portalCreatorId]);
  }
}

export function integrationEventV2PipelineKey(event: IntegrationEventV2): string {
  return canonicalJson([event.subject.programId, event.subject.applicationId]);
}

export function isSuccessfulIntegrationEventV2Status(status: number): boolean {
  return status >= 200 && status < 300 && status !== 409;
}

export type IntegrationEventV2OutboxRecord = Readonly<{
  id: string;
  schemaVersion: typeof INTEGRATION_EVENT_V2_SCHEMA_VERSION;
  event: IntegrationEventV2;
  body: string;
  identitySha256: string;
  bodySha256: string;
  state: "delivery_queued";
  createdAt: string;
}>;

export function createIntegrationEventV2OutboxRecord(event: IntegrationEventV2): IntegrationEventV2OutboxRecord {
  const body = integrationEventV2Body(event);
  return {
    id: event.eventId,
    schemaVersion: INTEGRATION_EVENT_V2_SCHEMA_VERSION,
    event,
    body,
    identitySha256: identitySha256(event),
    bodySha256: sha256Hex(body),
    state: "delivery_queued",
    createdAt: event.occurredAt
  };
}

export function createApplicationSubmittedEventsV2(input: {
  occurredAt: string;
  traceId: `tr_${string}`;
  revision: number;
  subject: SubjectWith<"uidGrantId">;
  locale: "en" | "ja" | "ko";
}): readonly [ApplicationSubmittedEventV2, UidGuideEmailRequestedEventV2] {
  const common = {
    occurredAt: input.occurredAt,
    source: "portal" as const,
    traceId: input.traceId,
    revision: input.revision,
    subject: omitUnverifiedPortalSubjectIds(input.subject)
  };
  return [
    buildIntegrationEventV2({ ...common, eventName: "application.submitted", payload: { applicationStatus: "submitted", locale: input.locale, uidPolicy: INTEGRATION_EVENT_V2_UID_POLICY } }),
    buildIntegrationEventV2({ ...common, eventName: "uid.guide-email.requested", payload: { deliveryReason: "initial", locale: input.locale } })
  ];
}

export function createVideoSubmittedEventV2(input: {
  occurredAt: string;
  traceId: `tr_${string}`;
  revision: number;
  subject: SubjectWith<"videoSubmissionId" | "youtubeVideoId">;
  payload: Omit<VideoSubmittedEventV2["payload"], "uidPolicy">;
}): VideoSubmittedEventV2 {
  return buildIntegrationEventV2({
    occurredAt: input.occurredAt,
    source: "portal",
    traceId: input.traceId,
    revision: input.revision,
    subject: omitUnverifiedPortalSubjectIds(input.subject),
    eventName: "video.submitted",
    payload: { ...input.payload, uidPolicy: INTEGRATION_EVENT_V2_UID_POLICY }
  });
}

export function assertIntegrationEventV2(value: unknown): asserts value is IntegrationEventV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IntegrationEventV2Error("invalid_event");
  assertExactObjectKeys(value as Record<string, unknown>, [
    "schemaVersion",
    "eventId",
    "eventName",
    "occurredAt",
    "source",
    "traceId",
    "revision",
    "subject",
    "payload"
  ]);
  assertNoSensitiveIntegrationFields(value);
  const event = value as Partial<IntegrationEventV2>;
  const eventName = event.eventName as IntegrationEventV2Name;
  if (event.schemaVersion !== INTEGRATION_EVENT_V2_SCHEMA_VERSION || !integrationEventV2Names.includes(eventName)) throw new IntegrationEventV2Error("invalid_event");
  if (!/^evt_[a-f0-9]{32}$/.test(String(event.eventId)) || !/^tr_[A-Za-z0-9._:-]{8,120}$/.test(String(event.traceId))) throw new IntegrationEventV2Error("invalid_event");
  if (!Number.isSafeInteger(event.revision) || Number(event.revision) < 1 || !isIntegrationEventV2Rfc3339DateTime(event.occurredAt)) throw new IntegrationEventV2Error("invalid_event");
  if (!event.subject || typeof event.subject.programId !== "string" || typeof event.subject.applicationId !== "string" || !event.payload || typeof event.payload !== "object") throw new IntegrationEventV2Error("invalid_event");
  assertSubjectIdentifiers(event.subject);
  const expectedSource: IntegrationEventV2Source = eventName.startsWith("video.") && eventName !== "video.submitted" ? "flu" : "portal";
  if (event.source !== expectedSource) throw new IntegrationEventV2Error("invalid_event");
  assertEventSpecificShape(event as IntegrationEventV2);
  // e3dd217f: deterministic-eventId gate — the eventId must equal the SHA-256 of the identity material,
  // so a tampered/forged eventId (used as the idempotency key) is rejected as invalid_event.
  if (event.eventId !== deterministicIntegrationEventV2Id(integrationEventV2IdentityMaterial(event as IntegrationEventV2))) {
    throw new IntegrationEventV2Error("invalid_event");
  }
}

export function assertNoSensitiveIntegrationFields(value: unknown, path = "$"): void {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSensitiveIntegrationFields(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") {
    if (
      typeof value === "string" &&
      (
        /\bbearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(value) ||
        RAW_EMAIL_LOOKING_STRING.test(value) ||
        (isRawUidCheckPath(path) && RAW_UID_LABELLED_NUMERIC_STRING.test(value)) ||
        (path.endsWith(".title") && BARE_UID_LENGTH_NUMERIC_RUN.test(value))
      )
    ) throw new IntegrationEventV2Error("sensitive_field_forbidden");
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[-_]/g, "").toLowerCase();
    const allowedUidIdentifier = [
      "uidgrantid",
      "uidsubmissionid",
      "maskeduid",
      "uidlookuphmac",
      "uidpolicy",
      "uidstatus",
      "uidkind"
    ].includes(normalized);
    const allowedEmailDigest = normalized.endsWith("emailhmac") || normalized.endsWith("emailhash");
    if (
      ["email", "emailaddress", "rawemail", "rawuid", "uidvalue", "bearertoken", "authorization", "secret"].includes(normalized) ||
      (!allowedEmailDigest && (normalized.endsWith("email") || normalized.includes("emailaddress"))) ||
      (!allowedUidIdentifier && (normalized === "uid" || normalized.endsWith("uid")))
    ) {
      throw new IntegrationEventV2Error("sensitive_field_forbidden");
    }
    assertNoSensitiveIntegrationFields(item, `${path}.${key}`);
  }
}

function isRawUidCheckPath(path: string): boolean {
  return ![
    ".youtubeVideoId",
    ".canonicalVideoUrl",
    ".occurredAt",
    ".publishedAt",
    ".collectedAt",
    ".maskedUid",
    ".uidLookupHmac"
  ].some((suffix) => path.endsWith(suffix));
}

function assertSubjectIdentifiers(subject: IntegrationEventV2Subject): void {
  for (const [key, value] of Object.entries(subject)) {
    if (
      value !== undefined &&
      (key === "youtubeVideoId" ? !isIntegrationEventV2YoutubeVideoId(value) : !isIntegrationEventV2Identifier(value))
    ) {
      throw new IntegrationEventV2Error("invalid_event");
    }
    if (![
      "programId",
      "campaignId",
      "outreachId",
      "applicationId",
      "portalCreatorId",
      "channelId",
      "uidGrantId",
      "uidSubmissionId",
      "videoSubmissionId",
      "youtubeVideoId",
      "reviewId",
      "trackingId"
    ].includes(key)) {
      throw new IntegrationEventV2Error("invalid_event");
    }
  }
}

/** 타이틀 레지스트리 id 형식(portal <-> flu 공유). 값의 존재 여부는 레지스트리가 판정한다. */
export const INTEGRATION_EVENT_V2_GAME_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function assertEventSpecificShape(event: IntegrationEventV2): void {
  const payload = event.payload as Record<string, unknown>;
  switch (event.eventName) {
    case "application.submitted":
      requireSubject(event.subject, ["uidGrantId"]);
      requirePayloadKeys(payload, ["applicationStatus", "locale", "uidPolicy"]);
      if (payload.applicationStatus !== "submitted" || payload.uidPolicy !== INTEGRATION_EVENT_V2_UID_POLICY || !["en", "ja", "ko"].includes(String(payload.locale))) throw new IntegrationEventV2Error("invalid_event");
      return;
    case "uid.guide-email.requested":
      requireSubject(event.subject, ["uidGrantId"]);
      requirePayloadKeys(payload, ["deliveryReason", "locale"]);
      if (!["initial", "resend"].includes(String(payload.deliveryReason)) || !["en", "ja", "ko"].includes(String(payload.locale))) throw new IntegrationEventV2Error("invalid_event");
      return;
    case "uid.submitted":
      requireSubject(event.subject, ["uidGrantId", "uidSubmissionId"]);
      requirePayloadKeys(payload, ["maskedUid", "uidLookupHmac", "validationStatus"]);
      if (
        typeof payload.maskedUid !== "string" ||
        !/^\*{3,16}[A-Za-z0-9_-]{2,4}$/.test(payload.maskedUid) ||
        typeof payload.uidLookupHmac !== "string" ||
        !/^[a-f0-9]{64}$/.test(payload.uidLookupHmac) ||
        !["submitted", "validating", "verified", "rejected", "human_required"].includes(String(payload.validationStatus))
      ) throw new IntegrationEventV2Error("invalid_event");
      return;
    case "video.submitted":
      requireSubject(event.subject, ["videoSubmissionId", "youtubeVideoId"]);
      requirePayloadKeys(payload, ["canonicalVideoUrl", "youtubeVideoId", "reportedViews", "contentType", "publishedAt", "uidPolicy"], ["title", "gameId"]);
      if (
        payload.uidPolicy !== INTEGRATION_EVENT_V2_UID_POLICY ||
        payload.youtubeVideoId !== event.subject.youtubeVideoId ||
        typeof payload.canonicalVideoUrl !== "string" ||
        !/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{6,20}$/.test(payload.canonicalVideoUrl) ||
        payload.canonicalVideoUrl !== `https://www.youtube.com/watch?v=${payload.youtubeVideoId}` ||
        typeof payload.youtubeVideoId !== "string" ||
        !/^[A-Za-z0-9_-]{6,20}$/.test(payload.youtubeVideoId) ||
        !Number.isSafeInteger(payload.reportedViews) ||
        Number(payload.reportedViews) < 0 ||
        !["short", "long_form", "live"].includes(String(payload.contentType)) ||
        !isIntegrationEventV2Rfc3339DateTime(payload.publishedAt)
      ) throw new IntegrationEventV2Error("invalid_event");
      if (
        payload.title !== undefined &&
        (typeof payload.title !== "string" || payload.title.length < 1 || payload.title.length > 200)
      ) throw new IntegrationEventV2Error("invalid_event");
      // gameId: 다타이틀 프로그램의 타이틀 레지스트리 id(functions/programTitles.json). 선택 키 —
      // 없으면 수신자가 프로그램 기본 타이틀로 착지시키되 `gameIdDefaulted` 스탬프를 붙인다
      // (strict 필터는 스탬프를 게임 증거로 세지 않는다 — 레거시 제출의 오늘 동작은 착지
      // 자체가 보존 대상). 값은 형식만 검증하고 미등록 id 도 거부하지 않는다: 레지스트리
      // 편집이 배포보다 앞설 수 있으므로 미해석은 human gate(`gameIdUnresolved`)로 보내고
      // 수신 자체는 막지 않는다.
      if (
        payload.gameId !== undefined &&
        (typeof payload.gameId !== "string" || !INTEGRATION_EVENT_V2_GAME_ID_RE.test(payload.gameId))
      ) throw new IntegrationEventV2Error("invalid_event");
      return;
    case "video.review-status.changed":
      requireSubject(event.subject, ["videoSubmissionId", "youtubeVideoId", "reviewId"]);
      requirePayloadKeys(payload, ["reviewStatus"], ["reasonCode"]);
      if (
        !["pending", "approved", "rejected", "changes_requested"].includes(String(payload.reviewStatus)) ||
        (payload.reasonCode !== undefined && !isIntegrationEventV2Identifier(payload.reasonCode))
      ) throw new IntegrationEventV2Error("invalid_event");
      return;
    case "video.view-snapshot.updated":
      requireSubject(event.subject, ["videoSubmissionId", "youtubeVideoId", "trackingId"]);
      requirePayloadKeys(payload, ["viewCount", "collectedAt", "reviewStatus"]);
      if (!Number.isSafeInteger(payload.viewCount) || Number(payload.viewCount) < 0 || !isIntegrationEventV2Rfc3339DateTime(payload.collectedAt) || payload.reviewStatus !== "approved") throw new IntegrationEventV2Error("invalid_event");
      return;
  }
}

/**
 * Strict contract profile for JSON Schema `format: date-time`: uppercase RFC3339 date-time,
 * a mandatory Z/numeric timezone, a real proleptic-Gregorian calendar date, and no leap second.
 */
export function isIntegrationEventV2Rfc3339DateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = STRICT_RFC3339_DATE_TIME.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , timezone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > daysInGregorianMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (timezone !== "Z") {
    const timezoneHour = Number(timezone.slice(1, 3));
    const timezoneMinute = Number(timezone.slice(4, 6));
    if (timezoneHour > 23 || timezoneMinute > 59) return false;
  }
  return true;
}

function requireSubject(subject: IntegrationEventV2Subject, keys: readonly (keyof IntegrationEventV2Subject)[]): void {
  for (const key of keys) {
    if (!subject[key]) throw new IntegrationEventV2Error("invalid_event");
  }
}

function requirePayloadKeys(payload: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set(keys.concat(optional));
  for (const key of keys) {
    if (!(key in payload)) throw new IntegrationEventV2Error("invalid_event");
  }
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new IntegrationEventV2Error("invalid_event");
  }
}

function assertExactObjectKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const expected = [...keys].sort();
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new IntegrationEventV2Error("invalid_event");
  }
}

function isIntegrationEventV2Identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isIntegrationEventV2YoutubeVideoId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,20}$/.test(value);
}

function readHeader(headers: Headers | Readonly<Record<string, string | undefined>>, name: string): string {
  const value = headers instanceof Headers ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()];
  if (!value) throw new IntegrationEventV2Error("signature_invalid");
  return value;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function daysInGregorianMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function omitUnverifiedPortalSubjectIds<Subject extends IntegrationEventV2Subject>(
  subject: Subject
): Omit<Subject, "campaignId" | "outreachId"> {
  const { campaignId: _campaignId, outreachId: _outreachId, ...verifiedSubject } = subject;
  return verifiedSubject;
}
