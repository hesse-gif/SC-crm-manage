// SCP Creator Portal Daily Outreach v2 producer.
//
// Produces KST send-date cohort metrics for
// POST /api/internal/flu/v2/outreach-funnel-snapshots.
//
// Privacy boundary: payload rows are aggregated by date/program/campaign/country only.
// Raw email, handle, creator id, tracking id, application id, and conversation ids never
// leave Flu.

import { createHash, createHmac } from "node:crypto";
import type { DocumentSnapshot, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";

export const SCP_OUTREACH_FUNNEL_INGEST_PATH = "/api/internal/flu/v2/outreach-funnel-snapshots";
export const SCP_OUTREACH_FUNNEL_SECRET_ENV = "SCP_FLU_OUTREACH_FUNNEL_SECRET";
export const SCP_OUTREACH_FUNNEL_FALLBACK_SECRET_ENV = "SCP_FLU_INGEST_SECRET";
export const SCP_OUTREACH_FUNNEL_MIN_SECRET_BYTES = 32;
export const SCP_OUTREACH_FUNNEL_MAX_BODY_BYTES = 128 * 1024;
export const SCP_OUTREACH_FUNNEL_ATTRIBUTION_WINDOW_DAYS = 7;
export const SCP_OUTREACH_FUNNEL_RECOMPUTE_DATE_COUNT = 9;
export const SCP_OUTREACH_FUNNEL_MAX_ROWS = 500;
// The daily pass walks nine dates sequentially inside one 300s scheduler invocation, so isolation
// is a wall-clock property, not just a control-flow one: attempt count alone does not stop one
// date from eating the whole budget, and then the later dates are never attempted — the exact
// blast radius this isolation exists to remove.
//
// Three unbounded axes had to be closed, and the last one is not the obvious one:
//   1. delivery retries — four honoured Retry-After: 60 waits cost 240s on a single date;
//   2. the Portal request — fetch has no deadline of its own, so a hung response hangs the pass;
//   3. the Firestore aggregation — measured: against an unreachable backend the gRPC client burns
//      ~42s per date on its own internal retries before surfacing UNAVAILABLE, so nine dates cost
//      ~380s and the invocation dies before the later dates are tried.
//
// Delivery bound per date is
//   attempts x requestTimeout + (attempts - 1) x retryDelay = 2 x 8s + 1 x 3s = 19s,
// and the per-date deadline covers aggregation on top of that. Nine dates therefore cost at most
// 9 x 25s = 225s against the 300s timeout. Measured production aggregation for the same nine dates
// is 4.7s total (2026-08-11, read-only), so the deadline only ever bites on a stalled backend.
//
// Two attempts rather than one is deliberate: the oldest date of today's window drops out of
// tomorrow's window, so a transient failure there is not recoverable by the next daily pass.
// Both transient classes now consume that second attempt — a retryable Portal answer and a
// transport failure with no answer at all (socket reset, request deadline). Contract rejections
// still spend exactly one attempt, so a poison date cannot use the budget to re-earn the same
// refusal. The worst case per date is therefore unchanged at
//   2 x 8s request + 1 x 3s wait = 19s < 25s per-date deadline.
export const SCP_OUTREACH_FUNNEL_BATCH_ATTEMPTS_PER_DATE = 2;
export const SCP_OUTREACH_FUNNEL_BATCH_REQUEST_TIMEOUT_MS = 8_000;
export const SCP_OUTREACH_FUNNEL_BATCH_MAX_RETRY_DELAY_MS = 3_000;
export const SCP_OUTREACH_FUNNEL_BATCH_DATE_DEADLINE_MS = 25_000;
export const SCP_OUTREACH_FUNNEL_BATCH_WORST_CASE_MS =
  SCP_OUTREACH_FUNNEL_RECOMPUTE_DATE_COUNT * SCP_OUTREACH_FUNNEL_BATCH_DATE_DEADLINE_MS;
export const SCP_OUTREACH_FUNNEL_SCHEMA_VERSION = "flu.outreach-funnel-snapshot.v2";
export const SCP_OUTREACH_FUNNEL_SOURCE_SYSTEM = "flu";

// Retryability is decided by retryableStatus() plus the one explicitly stale-marked auth code, so
// a positive-code allowlist would only be a second, weaker copy of that rule; the code side keeps
// only the terminal set below.

// Codes that describe the payload itself, so the Portal answers the same way to a byte-identical
// retry. They are terminal no matter what status or retryable flag rides along: the request body
// is fixed for the whole attempt loop, so a second attempt can only re-earn the same refusal while
// spending the date's budget — that is precisely how a poison date starves the dates behind it.
// The status guard alone is not enough; it covers 409 but a 400 carrying `retryable: true` would
// otherwise be retried.
const TERMINAL_CODES = new Set([
  "contract_mismatch",
  "idempotency_conflict",
  "stale_source_revision",
  "snapshot_conflict",
  "duplicate_grain",
]);

type RawRecord = Record<string, unknown>;

export type OutreachFunnelSnapshotRow = {
  campaignId: string;
  clicks: number;
  delivered: number;
  eligibleReplies: number;
  exactReplyLinks: number;
  matureAttributionRecipients: number;
  openAttributionRecipients: number;
  openSignals: number;
  programId: string;
  recipientCountryCode: string;
  repliedThenApplied: number;
  replies: number;
  sent: number;
  verifiedApplications: number;
};

export type OutreachFunnelSnapshotWire = {
  rows: OutreachFunnelSnapshotRow[];
  schemaVersion: typeof SCP_OUTREACH_FUNNEL_SCHEMA_VERSION;
  sourceDate: string;
  sourceRevision: string;
  sourceSystem: typeof SCP_OUTREACH_FUNNEL_SOURCE_SYSTEM;
  sourceUpdatedAt: string;
};

export type OutreachFunnelDeliveryResult =
  | {
      outcome: "accepted" | "duplicate";
      httpStatus: number;
      requestId: string;
      code: "";
      attempts: number;
      idempotencyKey: string;
    }
  | {
      outcome: "rejected" | "exhausted";
      httpStatus: number;
      requestId: string;
      code: string;
      retryable: boolean;
      attempts: number;
      idempotencyKey: string;
    };

export type OutreachFunnelDateOutcome = {
  sourceDate: string;
  outcome: "accepted" | "duplicate" | "rejected" | "exhausted" | "failed";
  code: string;
  httpStatus: number;
};

export type OutreachFunnelPassResult = {
  accepted: number;
  duplicate: number;
  failed: number;
  dates: string[];
  results: OutreachFunnelDateOutcome[];
};

// Raised once per pass when at least one date did not reach accepted/duplicate. It carries the
// whole per-date ledger so the scheduler can log which dates moved before it rethrows: the pass
// must stay loud (scheduler retry + alerting) without hiding the dates that actually succeeded.
export class OutreachFunnelPassError extends Error {
  readonly code = "outreach_funnel_delivery_incomplete";
  constructor(readonly pass: OutreachFunnelPassResult) {
    super(`outreach_funnel_delivery_incomplete:${pass.results
      .filter((entry) => entry.outcome !== "accepted" && entry.outcome !== "duplicate")
      .map((entry) => `${entry.sourceDate}=${entry.code || entry.httpStatus}`)
      .join(",")}`);
  }
}

export class OutreachFunnelConfigError extends Error {
  readonly code = "outreach_funnel_config_invalid";
}

export type OutreachSendRecord = RawRecord & {
  id: string;
  ref?: string;
};

export type OutreachReplyRecord = RawRecord & {
  id: string;
  ref?: string;
};

export type OutreachApplicationRecord = RawRecord & {
  id: string;
  ref?: string;
};

export type BuildOutreachFunnelSnapshotInput = {
  sourceDate: string;
  sourceUpdatedAt: string;
  sends: OutreachSendRecord[];
  replies?: OutreachReplyRecord[];
  applications?: OutreachApplicationRecord[];
  attributionWindowDays?: number;
};

type SendUnit = {
  key: string;
  outreachId: string;
  messageRef: string;
  campaignCandidateRef: string;
  sentAtMs: number;
  programId: string;
  campaignId: string;
  country: string;
  openSignals: number;
  clicks: number;
  delivered: boolean;
  trackingId: string;
  conversationId: string;
};

type ReplySignal = {
  key: string;
  repliedAtMs: number;
  identityKeys: Set<string>;
};

type ApplicationSignal = {
  key: string;
  submittedAtMs: number;
  identityKeys: Set<string>;
  campaignId: string;
  programId: string;
};

type MutableRow = OutreachFunnelSnapshotRow & {
  sentKeys: Set<string>;
  deliveredKeys: Set<string>;
  openKeys: Set<string>;
  clickKeys: Set<string>;
  replyKeys: Set<string>;
  eligibleReplyKeys: Set<string>;
  exactReplyKeys: Set<string>;
  verifiedApplicationKeys: Set<string>;
  repliedThenAppliedKeys: Set<string>;
  matureKeys: Set<string>;
  openAttributionKeys: Set<string>;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function positiveIntegerString(value: number): string {
  return String(Math.max(1, Math.floor(value)));
}

function toMillis(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const record = asRecord(value);
  const seconds = typeof record.seconds === "number" ? record.seconds : NaN;
  const nanoseconds = typeof record.nanoseconds === "number" ? record.nanoseconds : 0;
  if (Number.isFinite(seconds)) return seconds * 1_000 + Math.floor(nanoseconds / 1_000_000);
  return 0;
}

function sourceDateKst(ms: number): string {
  return new Date(ms + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

export function previousKstDate(now: Date): string {
  return sourceDateKst(now.getTime() - 24 * 60 * 60 * 1_000);
}

export function recentKstDates(
  now: Date,
  count = SCP_OUTREACH_FUNNEL_RECOMPUTE_DATE_COUNT,
): string[] {
  // A non-finite count must not collapse the bounds: Math.trunc(NaN) survives min/max as NaN and
  // Array.from({ length: NaN }) yields an empty list, which would let a pass "succeed" having sent
  // nothing at all.
  const requestedCount = Number.isFinite(count) ? Math.trunc(count) : SCP_OUTREACH_FUNNEL_RECOMPUTE_DATE_COUNT;
  const boundedCount = Math.min(Math.max(requestedCount, 1), 31);
  return Array.from({ length: boundedCount }, (_, index) =>
    sourceDateKst(now.getTime() - index * 24 * 60 * 60 * 1_000)).reverse();
}

function sourceDateRangeUtc(sourceDate: string): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)) {
    throw new OutreachFunnelConfigError("sourceDate must be YYYY-MM-DD");
  }
  const start = Date.parse(`${sourceDate}T00:00:00.000+09:00`);
  const end = start + 24 * 60 * 60 * 1_000;
  return { start: new Date(start), end: new Date(end) };
}

function textFrom(record: RawRecord, keys: string[]): string {
  for (const key of keys) {
    const value = asString(record[key], "");
    if (value) return value;
  }
  return "";
}

function numFrom(record: RawRecord, keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return 0;
}

function normalizedCountry(value: string): string {
  const cleaned = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(cleaned) ? cleaned : "ZZ";
}

function portalIdentifier(value: string, prefix: "campaign" | "program"): string {
  const normalized = value.trim();
  if (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)
    && !/^(?:[A-F0-9]{32,}|[A-Z0-9_-]{48,})$/i.test(normalized)
    && !/(?:^|[._-])(?:api[_-]?key|authorization|bearer|password|passwd|secret|token)(?:$|[._-])/i.test(normalized)
    && !/^\+?\d[\d._-]{7,}\d$/.test(normalized)
  ) return normalized;
  return normalized ? `${prefix}-${sha256Hex(normalized).slice(0, 24)}` : "";
}

function conversationIdFromRef(ref: string): string {
  return /^conversations\/[^/]+$/.test(ref) ? ref.split("/")[1] ?? "" : "";
}

function exactIdentityKeys(record: RawRecord & { id?: string }): Set<string> {
  const keys = new Set<string>();
  const outreachId = textFrom(record, ["outreachId"]);
  if (outreachId) keys.add(`outreach:${outreachId}`);
  const trackingId = textFrom(record, ["trackingId", "externalTrackingId", "matchedOutboundTrackingId"]);
  if (trackingId) keys.add(`tracking:${trackingId}`);
  const conversationId = textFrom(record, ["conversationId"]) || conversationIdFromRef(textFrom(record, ["conversationRef"]));
  if (conversationId) keys.add(`conversation:${conversationId}`);
  const messageRef = textFrom(record, ["messageRef", "matchedOutboundRef"]);
  if (/^message_sources\/[^/]+$/.test(messageRef)) keys.add(`message:${messageRef}`);
  const campaignCandidateRef = textFrom(record, ["campaignCandidateRef"]);
  if (/^campaign_candidates\/[^/]+$/.test(campaignCandidateRef)) {
    keys.add(`campaign-candidate:${campaignCandidateRef}`);
  }
  const sourceRef = textFrom(record, ["sourceRef", "mailOutboxRef", "outboundLogRef", "matchedOutboundRef"]);
  if (/^mail_outbound_log\/[^/]+$/.test(sourceRef)) keys.add(`tracking:${sourceRef.split("/")[1] ?? ""}`);
  if (/^message_sources\/[^/]+$/.test(sourceRef)) keys.add(`message:${sourceRef}`);
  return keys;
}

function sent(record: RawRecord): boolean {
  const state = textFrom(record, ["deliveryState", "status"]).toLowerCase();
  if (!toMillis(textFrom(record, ["sentAtIso", "sentAt"]))) return false;
  return (
    (state === "sent" || state === "delivered" || state === "sent_evidence_pending")
    && (record.providerConfirmed === true || numFrom(record, ["acceptedCount"]) > 0)
  );
}

function delivered(record: RawRecord): boolean {
  const state = textFrom(record, ["deliveryState", "status"]).toLowerCase();
  return state === "delivered" || record.providerConfirmed === true || numFrom(record, ["acceptedCount"]) > 0;
}

function sendUnit(record: OutreachSendRecord): SendUnit | null {
  if (!sent(record)) return null;
  const sentAtMs = toMillis(textFrom(record, ["sentAtIso", "sentAt", "createdAtIso", "updatedAtIso"]));
  if (!sentAtMs) return null;
  const programId = portalIdentifier(textFrom(record, ["programId", "canonicalProgramId"]), "program");
  const campaignId = portalIdentifier(textFrom(record, ["campaignId", "campaign"]), "campaign");
  if (!programId || !campaignId) return null;
  const trackingId = textFrom(record, ["trackingId"]) || record.id;
  const conversationId = textFrom(record, ["conversationId"]) || conversationIdFromRef(textFrom(record, ["conversationRef"]));
  const messageRef = textFrom(record, ["messageRef"]);
  const campaignCandidateRef = textFrom(record, ["campaignCandidateRef"]);
  const key = trackingId ? `tracking:${trackingId}` : `send:${record.ref ?? record.id}`;
  return {
    key,
    outreachId: record.id,
    messageRef,
    campaignCandidateRef,
    sentAtMs,
    programId,
    campaignId,
    country: normalizedCountry(textFrom(record, ["recipientCountryCode", "countryCode", "country", "creatorRegion", "localeCountry"])),
    openSignals: numFrom(record, ["openCount", "rawOpenCount"]),
    clicks: numFrom(record, ["clickCount", "clicks", "linkClickCount"]),
    delivered: delivered(record),
    trackingId,
    conversationId,
  };
}

function replySignal(record: OutreachReplyRecord): ReplySignal | null {
  if (textFrom(record, ["direction"]).toLowerCase() !== "inbound") return null;
  if (record.inboundAttributionAmbiguous === true) return null;
  const matchedOutboundRef = textFrom(record, ["matchedOutboundRef"]);
  if (!/^message_sources\/[^/]+$/.test(matchedOutboundRef)) return null;
  const repliedAtMs = toMillis(textFrom(record, [
    "receivedAtIso",
    "replyReceivedAtIso",
    "repliedAtIso",
    "hasReplyAtIso",
    "lastInboundAtIso",
    "lastReplyAtIso",
    "lastMessageAtIso",
    "updatedAtIso",
  ]));
  if (!repliedAtMs) return null;
  const route = textFrom(record, ["route", "inboundRoute"]).toLowerCase();
  if (route && route !== "creator_reply") return null;
  const identityKeys = exactIdentityKeys(record);
  if (identityKeys.size === 0) return null;
  const dedupeKey = textFrom(record, ["dedupeKey", "providerMessageIdHash"]);
  return {
    key: `reply:${dedupeKey || record.ref || record.id}`,
    repliedAtMs,
    identityKeys,
  };
}

// W73 scheduled reports must use the exact same reply eligibility as the Portal outreach funnel.
// Keep the predicate here so "inbound" alone can never silently become a reply metric.
export function isEligibleOutreachReply(record: OutreachReplyRecord): boolean {
  return replySignal(record) !== null;
}

function applicationSignal(record: OutreachApplicationRecord): ApplicationSignal | null {
  const submittedAtMs = toMillis(textFrom(record, ["submittedAtIso", "createdAtIso", "updatedAtIso"]));
  if (!submittedAtMs) return null;
  const sourceType = textFrom(record, ["sourceType"]);
  const identity = asRecord(record.identity);
  const normalized = sourceType === "scp_application_management"
    ? {
        outreachId: asString(identity.outreachId, ""),
        campaignId: asString(record.currentCampaignId, "") || asString(identity.campaignId, ""),
        programId: asString(record.currentProgramId, ""),
      }
    : record;
  if (sourceType === "scp_application_management") {
    if (record.classification !== "managed" || !normalized.outreachId || !normalized.campaignId) return null;
  } else {
    if (
      !textFrom(record, ["campaignId"])
      || !/^campaigns\/[^/]+$/.test(textFrom(record, ["campaignRef"]))
      || !/^campaign_candidates\/[^/]+$/.test(textFrom(record, ["campaignCandidateRef"]))
    ) return null;
  }
  const identityKeys = exactIdentityKeys(normalized);
  if (identityKeys.size === 0) return null;
  return {
    key: `application:${sourceType || "program_applications"}:${record.id}`,
    submittedAtMs,
    identityKeys,
    campaignId: portalIdentifier(textFrom(normalized, ["campaignId"]), "campaign"),
    programId: portalIdentifier(textFrom(normalized, ["programId", "canonicalProgramId"]), "program"),
  };
}

function mutableRow(unit: SendUnit): MutableRow {
  return {
    campaignId: unit.campaignId,
    clicks: 0,
    delivered: 0,
    eligibleReplies: 0,
    exactReplyLinks: 0,
    matureAttributionRecipients: 0,
    openAttributionRecipients: 0,
    openSignals: 0,
    programId: unit.programId,
    recipientCountryCode: unit.country,
    repliedThenApplied: 0,
    replies: 0,
    sent: 0,
    verifiedApplications: 0,
    sentKeys: new Set(),
    deliveredKeys: new Set(),
    openKeys: new Set(),
    clickKeys: new Set(),
    replyKeys: new Set(),
    eligibleReplyKeys: new Set(),
    exactReplyKeys: new Set(),
    verifiedApplicationKeys: new Set(),
    repliedThenAppliedKeys: new Set(),
    matureKeys: new Set(),
    openAttributionKeys: new Set(),
  };
}

function countInto(set: Set<string>, key: string): boolean {
  const before = set.size;
  set.add(key);
  return set.size !== before;
}

function finalize(row: MutableRow): OutreachFunnelSnapshotRow {
  return {
    campaignId: row.campaignId,
    clicks: row.clickKeys.size,
    delivered: row.deliveredKeys.size,
    eligibleReplies: row.eligibleReplyKeys.size,
    exactReplyLinks: row.exactReplyKeys.size,
    matureAttributionRecipients: row.matureKeys.size,
    openAttributionRecipients: row.openAttributionKeys.size,
    openSignals: row.openKeys.size,
    programId: row.programId,
    recipientCountryCode: row.recipientCountryCode,
    repliedThenApplied: row.repliedThenAppliedKeys.size,
    replies: row.replyKeys.size,
    sent: row.sentKeys.size,
    verifiedApplications: row.verifiedApplicationKeys.size,
  };
}

function dedupeSignals<T extends { key: string }>(signals: T[]): T[] {
  return [...new Map(signals.map((signal) => [signal.key, signal])).values()];
}

export function buildOutreachFunnelSnapshot(input: BuildOutreachFunnelSnapshotInput): OutreachFunnelSnapshotWire {
  const updatedAtMs = toMillis(input.sourceUpdatedAt);
  if (!updatedAtMs) throw new OutreachFunnelConfigError("sourceUpdatedAt must be ISO");
  const windowMs = Math.max(1, input.attributionWindowDays ?? SCP_OUTREACH_FUNNEL_ATTRIBUTION_WINDOW_DAYS) * 24 * 60 * 60 * 1_000;

  const repliesByKey = new Map<string, ReplySignal[]>();
  for (const replyRecord of input.replies ?? []) {
    const signal = replySignal(replyRecord);
    if (!signal) continue;
    for (const key of signal.identityKeys) {
      const bucket = repliesByKey.get(key) ?? [];
      bucket.push(signal);
      repliesByKey.set(key, bucket);
    }
  }

  const applicationsByKey = new Map<string, ApplicationSignal[]>();
  for (const application of input.applications ?? []) {
    const signal = applicationSignal(application);
    if (!signal) continue;
    for (const key of signal.identityKeys) {
      const bucket = applicationsByKey.get(key) ?? [];
      bucket.push(signal);
      applicationsByKey.set(key, bucket);
    }
  }

  const rows = new Map<string, MutableRow>();
  for (const rawSend of input.sends) {
    const unit = sendUnit(rawSend);
    if (!unit || sourceDateKst(unit.sentAtMs) !== input.sourceDate) continue;

    const rowKey = [unit.programId, unit.campaignId, unit.country].join("\u0000");
    const row = rows.get(rowKey) ?? mutableRow(unit);
    rows.set(rowKey, row);
    countInto(row.sentKeys, unit.key);
    if (unit.delivered) countInto(row.deliveredKeys, unit.key);
    if (unit.openSignals > 0) countInto(row.openKeys, unit.key);
    if (unit.clicks > 0) countInto(row.clickKeys, unit.key);

    const unitIdentityKeys = exactIdentityKeys({
      outreachId: unit.outreachId,
      trackingId: unit.trackingId,
      conversationId: unit.conversationId,
      messageRef: unit.messageRef,
      campaignCandidateRef: unit.campaignCandidateRef,
    });
    const windowEnd = unit.sentAtMs + windowMs;
    const matured = updatedAtMs >= windowEnd;
    const replies = dedupeSignals(
      [...unitIdentityKeys].flatMap((key) => repliesByKey.get(key) ?? []),
    ).filter((reply) => reply.repliedAtMs >= unit.sentAtMs && reply.repliedAtMs <= windowEnd);
    const applications = dedupeSignals(
      [...unitIdentityKeys].flatMap((key) => applicationsByKey.get(key) ?? []),
    ).filter((application) => (
      application.submittedAtMs >= unit.sentAtMs
      && application.submittedAtMs <= windowEnd
      && application.campaignId === unit.campaignId
      && (!application.programId || application.programId === unit.programId)
    ));

    if (matured) countInto(row.matureKeys, unit.key);
    else countInto(row.openAttributionKeys, unit.key);

    for (const reply of replies) {
      countInto(row.replyKeys, reply.key);
      countInto(row.eligibleReplyKeys, reply.key);
    }
    if (applications.length > 0) {
      countInto(row.verifiedApplicationKeys, unit.key);
    }
    if (applications.length === 1 && replies.length > 0) {
      countInto(row.exactReplyKeys, unit.key);
      if (replies.some((reply) => reply.repliedAtMs <= applications[0].submittedAtMs)) {
        countInto(row.repliedThenAppliedKeys, unit.key);
      }
    }
  }

  const publicRows = [...rows.values()]
    .map(finalize)
    .sort((a, b) =>
      a.programId.localeCompare(b.programId)
      || a.campaignId.localeCompare(b.campaignId)
      || a.recipientCountryCode.localeCompare(b.recipientCountryCode));
  if (publicRows.length > SCP_OUTREACH_FUNNEL_MAX_ROWS) {
    throw new OutreachFunnelConfigError("snapshot exceeds the 500-row Portal contract");
  }
  const sourceRevision = positiveIntegerString(updatedAtMs);
  return {
    rows: publicRows,
    schemaVersion: SCP_OUTREACH_FUNNEL_SCHEMA_VERSION,
    sourceDate: input.sourceDate,
    sourceRevision,
    sourceSystem: SCP_OUTREACH_FUNNEL_SOURCE_SYSTEM,
    sourceUpdatedAt: new Date(updatedAtMs).toISOString(),
  };
}

export function stableOutreachFunnelIdempotencyKey(snapshot: OutreachFunnelSnapshotWire): string {
  return `flu-outreach-${sha256Hex([
    snapshot.schemaVersion,
    snapshot.sourceSystem,
    snapshot.sourceDate,
    snapshot.sourceRevision,
    sha256Hex(JSON.stringify(snapshot.rows)),
  ].join("\n")).slice(0, 40)}`;
}

export function signOutreachFunnelRequest(input: {
  rawBody: string;
  idempotencyKey: string;
  secret: string;
  timestampSeconds: number;
}): { "Content-Type": string; "X-SCP-Timestamp": string; "X-SCP-Idempotency-Key": string; "X-SCP-Signature": string } {
  if (Buffer.byteLength(input.secret, "utf8") < SCP_OUTREACH_FUNNEL_MIN_SECRET_BYTES) {
    throw new OutreachFunnelConfigError("outreach ingest secret must be at least 32 bytes");
  }
  if (Buffer.byteLength(input.rawBody, "utf8") > SCP_OUTREACH_FUNNEL_MAX_BODY_BYTES) {
    throw new OutreachFunnelConfigError("request body exceeds the 128 KiB ingest limit");
  }
  if (!Number.isInteger(input.timestampSeconds)) {
    throw new OutreachFunnelConfigError("timestamp must be integer Unix seconds");
  }
  const timestamp = String(input.timestampSeconds);
  const signature = createHmac("sha256", input.secret)
    .update(`${timestamp}\n${input.idempotencyKey}\n${input.rawBody}`)
    .digest("hex");
  return {
    "Content-Type": "application/json",
    "X-SCP-Timestamp": timestamp,
    "X-SCP-Idempotency-Key": input.idempotencyKey,
    "X-SCP-Signature": `sha256=${signature}`,
  };
}

type DeliverOutreachFunnelSnapshotOptions = {
  baseUrl: string;
  secret: string;
  snapshot: OutreachFunnelSnapshotWire;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  log?: (entry: { operation: "scp_outreach_funnel_snapshot_delivery"; requestId: string; code: string; duplicate: boolean; httpStatus: number; attempt: number }) => void;
};

function parsePortalResponse(body: unknown): { requestId: string; code: string; duplicate: boolean; retryable: boolean } {
  const record = asRecord(body);
  return {
    requestId: asString(record.requestId, ""),
    code: asString(record.code, ""),
    duplicate: record.duplicate === true,
    retryable: record.retryable === true,
  };
}

// Retry is an allowlist, not a denylist. The request body and idempotency key are fixed for the
// whole attempt loop, so the only failures a second attempt can fix are the ones whose cause is
// outside the payload: the Portal being busy or briefly broken.
//
// Enumerating the transient side rather than the terminal side is what makes the invariant total.
// A denylist has to name every repeatable refusal, and the ones it misses (413 payload_too_large,
// 415 content-type, a non-stale 401) burn the date's budget re-earning the same answer the moment
// a response carries a contradictory `retryable: true` — that is the poison-date shape.
//
// Portal dab1221 emits 200/201/400/401/409/413/415/429/503 on this route; the retryable members of
// that set are exactly 429, 503, and the 401 it explicitly marks stale (a clock-window rejection
// that a re-signed attempt genuinely fixes, since each attempt carries a fresh timestamp).
function retryableStatus(status: number): boolean {
  // The question each status has to answer is "did this payload get a verdict". 429 and 5xx are
  // the Portal's own busy/broken answers. The rest are not Portal answers at all — a gateway in
  // front of it can emit them, and each one means the request never reached the Portal:
  //   408 the gateway gave up waiting for the request,
  //   421 the connection was routed to a server that cannot answer for this origin,
  //   425 the server refused early data.
  // All three are resolved by sending again, so they are transient here rather than refusals.
  return status === 408
    || status === 421
    || status === 425
    || status === 429
    || (status >= 500 && status <= 599);
}

// Reading Retry-After must not be able to end the attempt loop. A malformed adapter whose header
// accessor throws would otherwise escape past the retry decision already made above and silently
// forfeit the remaining attempts.
function readRetryAfter(response: Response): string | null {
  try {
    return response.headers?.get?.("Retry-After") ?? null;
  } catch {
    return null;
  }
}

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSeconds = Number(retryAfterHeader);
  if (retryAfterHeader !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1_000, 60_000);
  }
  const base = Math.min(1_000 * 2 ** (attempt - 1), 30_000);
  return base + Math.floor(Math.random() * 250);
}

export async function deliverOutreachFunnelSnapshot(
  options: DeliverOutreachFunnelSnapshotOptions,
): Promise<OutreachFunnelDeliveryResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? 5;
  const log = options.log ?? (() => {});
  let endpoint: URL;
  try {
    endpoint = new URL(SCP_OUTREACH_FUNNEL_INGEST_PATH, options.baseUrl);
  } catch {
    throw new OutreachFunnelConfigError("portal base URL is invalid");
  }
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost") {
    throw new OutreachFunnelConfigError("portal base URL must use HTTPS outside loopback test hosts");
  }

  const rawBody = JSON.stringify(options.snapshot);
  const idempotencyKey = stableOutreachFunnelIdempotencyKey(options.snapshot);
  let lastStatus = 0;
  let lastCode = "";
  let lastRequestId = "";
  let lastTransportError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // The idempotency key is derived once from the snapshot and reused on every attempt. That is
    // what makes retrying safe: a retry of a request the Portal already stored comes back as
    // 200 duplicate, never as a second row.
    const headers = signOutreachFunnelRequest({
      rawBody,
      idempotencyKey,
      secret: options.secret,
      timestampSeconds: Math.floor(now() / 1_000),
    });
    let response: Response | null = null;
    let bodyReadable = true;
    let parsed = { requestId: "", code: "", duplicate: false, retryable: false };
    try {
      const resolved = await fetchImpl(endpoint, { method: "POST", headers, body: rawBody });
      // Validate the shape, not the truthiness. Anything that cannot present an HTTP status and a
      // body reader carries no verdict to classify, so it takes the same path as no answer at all
      // rather than being read as a rejection with an undefined status. NaN passes `typeof`, so
      // finiteness and the status range are the real tests, and the body reader has to exist
      // before an unreadable body may be interpreted as "the Portal answered without evidence".
      if (
        !resolved
        || !Number.isFinite(resolved.status)
        || resolved.status < 100
        || resolved.status > 599
        || typeof resolved.json !== "function"
      ) {
        throw new OutreachFunnelConfigError("portal fetch resolved without a response");
      }
      response = resolved;
      try {
        parsed = parsePortalResponse(await response.json());
      } catch {
        // Header arrived, body did not. Swallowing this used to erase code/retryable and turn a
        // retryable 429 into a terminal rejection; the status-based classification below now
        // carries the decision instead.
        bodyReadable = false;
      }
    } catch (error) {
      lastTransportError = error;
    }

    if (!response) {
      // No response at all: socket reset, DNS failure, or the caller's request deadline firing.
      // This is the transient class the per-date attempt budget exists for, so it consumes an
      // attempt instead of ending the date on the first blip. Exhausting the budget rethrows the
      // original error, so callers see exactly what they saw before this retry existed.
      lastStatus = 0;
      lastRequestId = "";
      lastCode = outreachFunnelErrorCode(lastTransportError);
      log({
        operation: "scp_outreach_funnel_snapshot_delivery",
        requestId: "",
        code: lastCode,
        duplicate: false,
        httpStatus: 0,
        attempt,
      });
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs(attempt, null));
        continue;
      }
      // A fetch implementation that resolves something other than a Response leaves no error to
      // rethrow; surface a real one rather than `throw null`.
      throw lastTransportError
        ?? new OutreachFunnelConfigError("portal fetch resolved without a response");
    }

    lastStatus = response.status;
    lastCode = parsed.code;
    lastRequestId = parsed.requestId;
    log({
      operation: "scp_outreach_funnel_snapshot_delivery",
      requestId: parsed.requestId,
      code: parsed.code,
      duplicate: parsed.duplicate,
      httpStatus: response.status,
      attempt,
    });
    if (response.status === 201) {
      return { outcome: "accepted", httpStatus: 201, requestId: parsed.requestId, code: "", attempts: attempt, idempotencyKey };
    }
    if (response.status === 200) {
      return { outcome: "duplicate", httpStatus: 200, requestId: parsed.requestId, code: "", attempts: attempt, idempotencyKey };
    }
    // Terminal deny takes precedence over any positive retry hint the response carries.
    // Terminal is the default; only an enumerated transient class earns the second attempt.
    // TERMINAL_CODES still overrides on top of that, so a contract refusal wearing a 5xx cannot
    // buy a retry either.
    const retryable = !TERMINAL_CODES.has(parsed.code)
      && (
        retryableStatus(response.status)
        || (bodyReadable && parsed.code === "ingest_auth_stale")
      );
    if (!retryable) {
      return {
        outcome: "rejected",
        httpStatus: response.status,
        requestId: parsed.requestId,
        code: parsed.code || `http_${response.status}${bodyReadable ? "" : "_body_unreadable"}`,
        retryable: false,
        attempts: attempt,
        idempotencyKey,
      };
    }
    if (attempt < maxAttempts && parsed.code !== "ingest_auth_stale") {
      // A response without usable headers must not throw past the loop and skip the remaining
      // attempts; treat a missing Retry-After the same as an absent one.
      await sleep(retryDelayMs(attempt, readRetryAfter(response)));
    }
  }
  return {
    outcome: "exhausted",
    httpStatus: lastStatus,
    requestId: lastRequestId,
    code: lastCode || `http_${lastStatus}`,
    retryable: true,
    attempts: maxAttempts,
    idempotencyKey,
  };
}

function docData(doc: DocumentSnapshot | QueryDocumentSnapshot): RawRecord & { id: string; ref: string } {
  return { id: doc.id, ref: doc.ref.path, ...(doc.data() ?? {}) };
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function readDocumentsById(collection: string, ids: readonly string[]): Promise<Map<string, RawRecord>> {
  const result = new Map<string, RawRecord>();
  for (const idChunk of chunk([...new Set(ids.filter(Boolean))], 100)) {
    const snapshots = await adminDb.getAll(...idChunk.map((id) => adminDb.collection(collection).doc(id)));
    for (const snapshot of snapshots) {
      if (snapshot.exists) result.set(snapshot.id, docData(snapshot));
    }
  }
  return result;
}

export async function buildOutreachFunnelSnapshotFromFirestore(input: {
  sourceDate: string;
  sourceUpdatedAt?: string;
}): Promise<OutreachFunnelSnapshotWire> {
  const range = sourceDateRangeUtc(input.sourceDate);
  const sourceUpdatedAt = input.sourceUpdatedAt ?? new Date().toISOString();
  const sourceUpdatedAtMs = toMillis(sourceUpdatedAt);
  if (!sourceUpdatedAtMs) throw new OutreachFunnelConfigError("sourceUpdatedAt must be ISO");
  const attributionReadEndMs = Math.min(
    sourceUpdatedAtMs,
    range.end.getTime() + SCP_OUTREACH_FUNNEL_ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
  );

  // campaign_outreach is the canonical per-recipient campaign send row. The
  // duplicate mail ledgers are used only to enrich open/click/provider evidence.
  const sendsSnapshot = await adminDb.collection("campaign_outreach")
    .where("sentAtIso", ">=", range.start.toISOString())
    .where("sentAtIso", "<", range.end.toISOString())
    .select(
      "acceptedCount", "campaignCandidateRef", "campaignId", "canonicalProgramId",
      "conversationId", "country", "creatorRegion", "deliveryState", "messageRef",
      "programId", "providerConfirmed", "sentAtIso", "status", "trackingId",
    )
    .get();
  const canonicalSendCandidates = sendsSnapshot.docs.map(docData);
  const outboxByTrackingId = await readDocumentsById(
    "mail_outbound_log",
    canonicalSendCandidates.map((sendRecord) => textFrom(sendRecord, ["trackingId"])),
  );
  const sends = canonicalSendCandidates.map((sendRecord) => {
    const outbox = outboxByTrackingId.get(textFrom(sendRecord, ["trackingId"])) ?? {};
    return {
      ...sendRecord,
      acceptedCount: Math.max(numFrom(sendRecord, ["acceptedCount"]), numFrom(outbox, ["acceptedCount"])),
      clickCount: numFrom(outbox, ["clickCount"]),
      openCount: numFrom(outbox, ["openCount"]),
      providerConfirmed: sendRecord.providerConfirmed === true || outbox.providerConfirmed === true,
    };
  }).filter(sent);

  let replies: OutreachReplyRecord[] = [];
  let applications: OutreachApplicationRecord[] = [];
  if (attributionReadEndMs >= range.start.getTime()) {
    const readEndIso = new Date(attributionReadEndMs).toISOString();
    const [replySnapshot, managementApplicationSnapshot, programApplicationSnapshot] = await Promise.all([
      adminDb.collection("message_sources")
        .where("receivedAtIso", ">=", range.start.toISOString())
        .where("receivedAtIso", "<=", readEndIso)
        .select(
          "dedupeKey", "direction", "inboundAttributionAmbiguous", "matchedOutboundMatchBasis",
          "matchedOutboundRef", "matchedOutboundTrackingId", "providerMessageIdHash", "receivedAtIso",
          "route", "inboundRoute",
        )
        .get(),
      adminDb.collection("scp_application_management")
        .where("submittedAtIso", ">=", range.start.toISOString())
        .where("submittedAtIso", "<=", readEndIso)
        .select("classification", "currentCampaignId", "currentProgramId", "identity", "submittedAtIso")
        .get(),
      adminDb.collection("program_applications")
        .where("submittedAtIso", ">=", range.start.toISOString())
        .where("submittedAtIso", "<=", readEndIso)
        .select(
          "campaignCandidateRef", "campaignId", "campaignRef", "canonicalProgramId",
          "programId", "submittedAtIso",
        )
        .get(),
    ]);
    replies = replySnapshot.docs.map(docData);
    applications = [
      ...managementApplicationSnapshot.docs.map((snapshot) => ({
        ...docData(snapshot),
        sourceType: "scp_application_management",
      })),
      ...programApplicationSnapshot.docs.map((snapshot) => ({
        ...docData(snapshot),
        sourceType: "program_applications",
      })),
    ];
  }
  return buildOutreachFunnelSnapshot({
    sourceDate: input.sourceDate,
    sourceUpdatedAt,
    sends,
    replies,
    applications,
  });
}

export async function deliverOutreachFunnelSnapshotForDate(input: {
  sourceDate?: string;
  baseUrl: string;
  secret?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<OutreachFunnelDeliveryResult> {
  const now = input.now ?? new Date();
  const secret = input.secret
    ?? process.env[SCP_OUTREACH_FUNNEL_SECRET_ENV]
    ?? process.env[SCP_OUTREACH_FUNNEL_FALLBACK_SECRET_ENV]
    ?? "";
  const snapshot = await buildOutreachFunnelSnapshotFromFirestore({
    sourceDate: input.sourceDate ?? previousKstDate(now),
    sourceUpdatedAt: now.toISOString(),
  });
  return deliverOutreachFunnelSnapshot({
    baseUrl: input.baseUrl,
    secret,
    snapshot,
    fetchImpl: input.fetchImpl,
    maxAttempts: input.maxAttempts,
    sleep: input.sleep,
  });
}

// recentKstDates() runs oldest -> newest, so a fail-fast loop lets the single oldest date that the
// Portal refuses (contract_mismatch, stale revision) or that fails to read block every newer date
// for good: the next scheduled pass rebuilds the same list in the same order and stops on the same
// poison date. Every date is therefore attempted and a per-date failure is recorded instead of
// aborting the pass.
//
// The opposite failure mode is worse than the poison date: a pass that swallows failures reports
// success while the Portal never received the data. Failures are collected, never dropped, and
// rethrown as OutreachFunnelPassError once the whole list has been attempted, so the scheduler
// retry and alerting still fire and the per-date ledger is still available to the caller.
export async function deliverRecentOutreachFunnelSnapshots(input: {
  baseUrl: string;
  secret?: string;
  now?: Date;
  dateCount?: number;
  fetchImpl?: typeof fetch;
  attemptsPerDate?: number;
}): Promise<OutreachFunnelPassResult> {
  const now = input.now ?? new Date();
  // Clamp rather than trust: a caller passing 0, a fraction, NaN or Infinity would otherwise turn
  // the bounded budget below into "no request at all" or "no bound at all".
  const requestedAttempts = Number.isFinite(input.attemptsPerDate)
    ? Math.trunc(input.attemptsPerDate as number)
    : SCP_OUTREACH_FUNNEL_BATCH_ATTEMPTS_PER_DATE;
  const attemptsPerDate = Math.min(Math.max(requestedAttempts, 1), 5);
  const baseFetch = input.fetchImpl ?? fetch;
  // A hung Portal request has no deadline of its own, and a sequential nine-date walk turns one
  // hang into "the later dates were never attempted". Bound the request and the inter-attempt
  // wait so the whole pass stays inside the scheduler invocation.
  const boundedFetch: typeof fetch = (url, init) => baseFetch(url, {
    ...init,
    signal: AbortSignal.timeout(SCP_OUTREACH_FUNNEL_BATCH_REQUEST_TIMEOUT_MS),
  });
  const boundedSleep = (ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, Math.min(ms, SCP_OUTREACH_FUNNEL_BATCH_MAX_RETRY_DELAY_MS));
  });
  const dates = recentKstDates(now, input.dateCount);
  // An empty list would make the loop below report success without sending anything, which is the
  // swallow shape this function exists to prevent.
  if (dates.length === 0) throw new OutreachFunnelConfigError("recent date list resolved to zero dates");
  const results: OutreachFunnelDateOutcome[] = [];
  let accepted = 0;
  let duplicate = 0;
  for (const sourceDate of dates) {
    try {
      const result = await withDateDeadline(sourceDate, deliverOutreachFunnelSnapshotForDate({
        sourceDate,
        baseUrl: input.baseUrl,
        secret: input.secret,
        now,
        fetchImpl: boundedFetch,
        maxAttempts: attemptsPerDate,
        sleep: boundedSleep,
      }));
      if (result.outcome === "accepted") accepted += 1;
      else if (result.outcome === "duplicate") duplicate += 1;
      results.push({
        sourceDate,
        outcome: result.outcome,
        code: result.code,
        httpStatus: result.httpStatus,
      });
    } catch (error) {
      // A snapshot build/read/config throw is one date's failure, not the pass's. Keep the reason
      // on the date so the scheduler log names what broke.
      results.push({
        sourceDate,
        outcome: "failed",
        code: outreachFunnelErrorCode(error),
        httpStatus: 0,
      });
    }
  }
  const failed = results.length - accepted - duplicate;
  const pass: OutreachFunnelPassResult = { accepted, duplicate, failed, dates, results };
  if (failed > 0) throw new OutreachFunnelPassError(pass);
  return pass;
}

// The Firestore aggregation has no deadline of its own — against an unreachable backend the gRPC
// client spends ~42s per date on internal retries before it surfaces UNAVAILABLE, which alone
// would push nine dates past the scheduler timeout. Racing a timer bounds the loop even when the
// underlying read cannot be cancelled: the pass moves on to the next date and records why.
async function withDateDeadline<T>(sourceDate: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(
            new Error(`outreach funnel date ${sourceDate} exceeded the per-date deadline`),
            { code: "date_deadline_exceeded" },
          )),
          SCP_OUTREACH_FUNNEL_BATCH_DATE_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function outreachFunnelErrorCode(error: unknown): string {
  const record = asRecord(error);
  // AbortSignal.timeout raises a DOMException with no .code, so name is the only stable label for
  // the request-deadline case the batch relies on.
  const code = asString(record.code, "") || asString(record.errorCode, "") || asString(record.name, "");
  if (code && code !== "Error") return code;
  return error instanceof Error && error.message ? error.message.slice(0, 120) : "unknown_error";
}
