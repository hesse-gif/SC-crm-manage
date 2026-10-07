// scp.video-submission-review.v3 outbound callbacks (Flu -> Portal).
//
// Flu SCP Automation produces two flu->portal callback events defined by the frozen v3 contract
// (functions/contracts/scp-video-submission-review-v3/, schema 651b1811...):
//   - video.review.status_observed      (source: scp_automation) -> Portal /api/internal/flu/video-submission-review-v3/events
//   - video.downstream.status_observed  (source: flu)            -> Portal /api/internal/flu/video-downstream-v3/events
//
// Delivery is a durable outbox with leases, retry/backoff, dead-letter, per-doc idempotency, and
// secret rotation. Transport is FAIL-CLOSED until the Portal base URL AND the signing secret bind
// (contract_only). Canonicalization + sha256 reuse the vendored integration-event-v2 primitives (the
// v3 handoff canonicalJson rule is identical: ascending UTF-16 code-unit key order, no whitespace).
// v3 wire HMAC message form: `${unixTimestamp}.${exactCanonicalBody}` (distinct from v2's builder).
//
// PRIVACY: only contract subject/payload fields cross the wire. No raw email/UID/OAuth/bearer/
// reportedViews/title/description. publicReasonCode is a constrained id, never operator free text.
//
// The downstream callback is the SEPARATE accepted step that flips trackingEligible/settlementEligible
// true (review approval alone leaves them false — see downstreamEligibilityCore + the v3 approvalGate).
// On successful downstream delivery the review-state doc's downstreamProjectionConfirmed is set true and
// eligibility recomputed, so view collection / settlement can begin ONLY after Portal accepts.

import { createHmac } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";
import { canonicalJson, sha256Hex } from "./integrationEventV2";
import { computeDownstreamEligibility } from "./downstreamEligibilityCore";
import {
  SCP_VIDEO_REVIEW_STATE_COLLECTION,
  SCP_VIDEO_REVIEW_CALLBACK_OUTBOX_COLLECTION,
  SCP_VIDEO_DOWNSTREAM_CALLBACK_OUTBOX_COLLECTION,
} from "./videoReviewTransitionStore";
import type {
  ScpAutomationReviewCallbackEvent,
  ScpAutomationReviewStatus,
  FluDownstreamProjectionCallbackEvent,
  VideoReviewSubject,
} from "./contracts/scp-video-submission-review-v3/types";

export const SCP_VIDEO_REVIEW_V3_CALLBACK_AUDIT_COLLECTION =
  "scp_video_review_v3_callback_audit";

// Flu-side config (Portal-owned VALUES are [확인 필요] until the paired handoff binds them).
export const SCP_PORTAL_VIDEO_REVIEW_V3_BASE_URL_ENV =
  "SCP_PORTAL_VIDEO_REVIEW_V3_BASE_URL";
export const SCP_VIDEO_REVIEW_CALLBACK_CURRENT_KEY_ID_ENV =
  "SCP_VIDEO_REVIEW_CALLBACK_CURRENT_KEY_ID";
export const SCP_VIDEO_REVIEW_CALLBACK_CURRENT_KEY_SECRET_ENV =
  "SCP_VIDEO_REVIEW_CALLBACK_CURRENT_KEY_SECRET";
export const SCP_VIDEO_REVIEW_CALLBACK_PREVIOUS_KEY_ID_ENV =
  "SCP_VIDEO_REVIEW_CALLBACK_PREVIOUS_KEY_ID";
export const SCP_VIDEO_REVIEW_CALLBACK_PREVIOUS_KEY_SECRET_ENV =
  "SCP_VIDEO_REVIEW_CALLBACK_PREVIOUS_KEY_SECRET";
export const SCP_VIDEO_DOWNSTREAM_CALLBACK_CURRENT_KEY_ID_ENV =
  "SCP_VIDEO_DOWNSTREAM_CALLBACK_CURRENT_KEY_ID";
export const SCP_VIDEO_DOWNSTREAM_CALLBACK_CURRENT_KEY_SECRET_ENV =
  "SCP_VIDEO_DOWNSTREAM_CALLBACK_CURRENT_KEY_SECRET";
export const SCP_VIDEO_DOWNSTREAM_CALLBACK_PREVIOUS_KEY_ID_ENV =
  "SCP_VIDEO_DOWNSTREAM_CALLBACK_PREVIOUS_KEY_ID";
export const SCP_VIDEO_DOWNSTREAM_CALLBACK_PREVIOUS_KEY_SECRET_ENV =
  "SCP_VIDEO_DOWNSTREAM_CALLBACK_PREVIOUS_KEY_SECRET";

export const REVIEW_CALLBACK_PATH =
  "/api/internal/flu/video-submission-review-v3/events";
export const DOWNSTREAM_CALLBACK_PATH =
  "/api/internal/flu/video-downstream-v3/events";

const MAX_DELIVERY_ATTEMPTS = 6;
const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60, 180];
const LEASE_MS = 2 * 60 * 1000;
// publicReasonCode / policyVersion / ids must be contract id-shaped, never free text.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export type VideoReviewV3CallbackState =
  "queued" | "leased" | "delivered" | "retryable_failed" | "dead_letter";
export type VideoReviewV3CallbackKind = "review" | "downstream";

type CallbackError = Error & { code: string };
function callbackError(code: string, message: string): CallbackError {
  return Object.assign(new Error(message), { code });
}

function idOrNull(value: unknown): string | null {
  const s = asString(value);
  return s && ID_PATTERN.test(s) ? s : null;
}

// ---- signing / key ring -----------------------------------------------------

export type CallbackKeyRing = {
  currentKeyId: string;
  currentSecret: string;
  previousKeyId?: string;
  previousSecret?: string;
};

function resolveCallbackKeyRing(
  kind: VideoReviewV3CallbackKind,
  override?: Partial<CallbackKeyRing>,
): CallbackKeyRing | null {
  const env = process.env;
  const currentKeyId =
    override?.currentKeyId ??
    env[
      kind === "review"
        ? SCP_VIDEO_REVIEW_CALLBACK_CURRENT_KEY_ID_ENV
        : SCP_VIDEO_DOWNSTREAM_CALLBACK_CURRENT_KEY_ID_ENV
    ] ??
    "";
  const currentSecret =
    override?.currentSecret ??
    env[
      kind === "review"
        ? SCP_VIDEO_REVIEW_CALLBACK_CURRENT_KEY_SECRET_ENV
        : SCP_VIDEO_DOWNSTREAM_CALLBACK_CURRENT_KEY_SECRET_ENV
    ] ??
    "";
  // Fail-closed: a provisioned-but-unbound placeholder ("unconfigured"/empty) is treated as absent.
  if (
    !currentKeyId ||
    !currentSecret ||
    currentSecret === "unconfigured" ||
    currentKeyId === "unconfigured"
  )
    return null;
  const previousKeyId =
    override?.previousKeyId ??
    env[
      kind === "review"
        ? SCP_VIDEO_REVIEW_CALLBACK_PREVIOUS_KEY_ID_ENV
        : SCP_VIDEO_DOWNSTREAM_CALLBACK_PREVIOUS_KEY_ID_ENV
    ];
  const previousSecret =
    override?.previousSecret ??
    env[
      kind === "review"
        ? SCP_VIDEO_REVIEW_CALLBACK_PREVIOUS_KEY_SECRET_ENV
        : SCP_VIDEO_DOWNSTREAM_CALLBACK_PREVIOUS_KEY_SECRET_ENV
    ];
  return {
    currentKeyId,
    currentSecret,
    ...(previousKeyId && previousSecret
      ? { previousKeyId, previousSecret }
      : {}),
  };
}

// v3 wire signature: sha256=HMAC-SHA256(secret, `${unixSeconds}.${canonicalBody}`).
export function videoReviewV3Signature(
  secret: string,
  unixSeconds: number,
  canonicalBody: string,
): string {
  return `sha256=${createHmac("sha256", secret).update(`${unixSeconds}.${canonicalBody}`, "utf8").digest("hex")}`;
}

// deterministic eventId: evt_ + first 32 lowercase hex of sha256(canonicalJson(identity material)).
function deterministicEventId(
  identityMaterial: Record<string, unknown>,
): `evt_${string}` {
  return `evt_${sha256Hex(canonicalJson(identityMaterial)).slice(0, 32)}` as `evt_${string}`;
}

// ---- transport --------------------------------------------------------------

export type CallbackDeliverer = (
  request: Readonly<{
    url: string;
    method: "POST";
    body: string;
    headers: Readonly<Record<string, string>>;
  }>,
) => Promise<{ status: number }>;

export const unconfiguredCallbackDeliverer: CallbackDeliverer = async () => {
  throw callbackError(
    "callback_transport_unconfigured",
    "Portal video-review v3 base URL is not configured",
  );
};

async function httpCallbackDeliverer(
  request: Readonly<{
    url: string;
    method: "POST";
    body: string;
    headers: Readonly<Record<string, string>>;
  }>,
): Promise<{ status: number }> {
  const response = await fetch(request.url, {
    method: "POST",
    body: request.body,
    headers: { ...request.headers },
  });
  return { status: response.status };
}

function resolveBaseUrl(override?: string): string {
  return override ?? process.env[SCP_PORTAL_VIDEO_REVIEW_V3_BASE_URL_ENV] ?? "";
}

function resolveDeliverer(
  baseUrl: string,
  explicit?: CallbackDeliverer,
): CallbackDeliverer {
  if (explicit) return explicit;
  return /^https:\/\//.test(baseUrl)
    ? httpCallbackDeliverer
    : unconfiguredCallbackDeliverer;
}

// 2xx (non-409) delivered; transient => retry; everything else terminal => dead-letter.
function classifyDeliveryStatus(
  status: number,
): "delivered" | "retry" | "terminal" {
  if (status >= 200 && status < 300 && status !== 409) return "delivered";
  if (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status < 600)
  )
    return "retry";
  return "terminal";
}

// ---- subject reconstruction (fail-closed; never fabricated) -----------------

function extractSubject(
  stateData: Record<string, unknown>,
): VideoReviewSubject | null {
  const s = asRecord(stateData.subject);
  const required = [
    "videoSubmissionId",
    "applicationId",
    "programId",
    "portalCreatorId",
    "fluCreatorId",
    "partnerId",
    "campaignId",
    "enrollmentId",
    "contentFingerprint",
    "policyVersion",
  ] as const;
  for (const k of required) {
    if (!asString(s[k])) return null;
  }
  const revision = Number(s.videoRevision);
  if (!Number.isInteger(revision) || revision < 0) return null;
  const subject: Record<string, unknown> = {
    videoSubmissionId: asString(s.videoSubmissionId),
    videoRevision: revision,
    applicationId: asString(s.applicationId),
    programId: asString(s.programId),
    portalCreatorId: asString(s.portalCreatorId),
    fluCreatorId: asString(s.fluCreatorId),
    partnerId: asString(s.partnerId),
    campaignId: asString(s.campaignId),
    enrollmentId: asString(s.enrollmentId),
    contentFingerprint: asString(s.contentFingerprint),
    policyVersion: asString(s.policyVersion),
  };
  if (asString(s.outreachId)) subject.outreachId = asString(s.outreachId);
  if (asString(s.settlementCreatorCode))
    subject.settlementCreatorCode = asString(s.settlementCreatorCode);
  if (asString(s.channelId)) subject.channelId = asString(s.channelId);
  if (asString(s.sourceSubmissionId))
    subject.sourceSubmissionId = asString(s.sourceSubmissionId);
  return subject as unknown as VideoReviewSubject;
}

function traceIdOf(stateData: Record<string, unknown>): `tr_${string}` | null {
  const t = asString(stateData.traceId);
  return /^tr_.+/.test(t) ? (t as `tr_${string}`) : null;
}

// ---- event builders ---------------------------------------------------------

export function buildReviewStatusObservedEvent(input: {
  subject: VideoReviewSubject;
  traceId: `tr_${string}`;
  revision: number;
  reviewId: string;
  status: ScpAutomationReviewStatus;
  policyVersion: string;
  reviewedAt: string;
  publicReasonCode?: string | null;
  occurredAt: string;
}): ScpAutomationReviewCallbackEvent {
  const payload = {
    reviewId: input.reviewId,
    status: input.status,
    policyVersion: input.policyVersion,
    reviewedAt: input.reviewedAt,
    ...(idOrNull(input.publicReasonCode)
      ? { publicReasonCode: idOrNull(input.publicReasonCode) as string }
      : {}),
  };
  const identityMaterial = {
    eventName: "video.review.status_observed",
    source: "scp_automation",
    traceId: input.traceId,
    revision: input.revision,
    subject: input.subject,
    payload,
  };
  return {
    schemaVersion: "scp.video-review-callback.v3",
    eventId: deterministicEventId(identityMaterial),
    eventName: "video.review.status_observed",
    occurredAt: input.occurredAt,
    source: "scp_automation",
    traceId: input.traceId,
    revision: input.revision,
    subject: input.subject,
    payload,
  };
}

export function buildDownstreamStatusObservedEvent(input: {
  subject: VideoReviewSubject;
  traceId: `tr_${string}`;
  revision: number;
  projectionId: string;
  policyVersion: string;
  projectedAt: string;
  occurredAt: string;
}): FluDownstreamProjectionCallbackEvent {
  const payload = {
    projectionId: input.projectionId,
    status: "eligible" as const,
    policyVersion: input.policyVersion,
    projectedAt: input.projectedAt,
    trackingEligible: true as const,
    settlementEligible: true as const,
  };
  const identityMaterial = {
    eventName: "video.downstream.status_observed",
    source: "flu",
    traceId: input.traceId,
    revision: input.revision,
    subject: input.subject,
    payload,
  };
  return {
    schemaVersion: "scp.video-downstream-callback.v3",
    eventId: deterministicEventId(identityMaterial),
    eventName: "video.downstream.status_observed",
    occurredAt: input.occurredAt,
    source: "flu",
    traceId: input.traceId,
    revision: input.revision,
    subject: input.subject,
    payload,
  };
}

// ---- drain ------------------------------------------------------------------

export type DrainVideoReviewV3CallbacksOptions = {
  kind: VideoReviewV3CallbackKind;
  batchLimit?: number;
  now?: Date;
  deliverer?: CallbackDeliverer;
  baseUrl?: string;
  keyRing?: Partial<CallbackKeyRing>;
};

export type DrainVideoReviewV3CallbacksResult = {
  kind: VideoReviewV3CallbackKind;
  scanned: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  skipped: number;
  results: Array<{
    docId: string;
    state: VideoReviewV3CallbackState;
    code: string;
    status?: number;
  }>;
};

function outboxCollection(kind: VideoReviewV3CallbackKind): string {
  return kind === "review"
    ? SCP_VIDEO_REVIEW_CALLBACK_OUTBOX_COLLECTION
    : SCP_VIDEO_DOWNSTREAM_CALLBACK_OUTBOX_COLLECTION;
}

export async function drainVideoReviewV3Callbacks(
  options: DrainVideoReviewV3CallbacksOptions,
): Promise<DrainVideoReviewV3CallbacksResult> {
  const kind = options.kind;
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const unixSeconds = Math.floor(now.getTime() / 1000);
  const batchLimit = Math.min(Math.max(options.batchLimit ?? 10, 1), 25);
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const deliverer = resolveDeliverer(baseUrl, options.deliverer);
  const keyRing = resolveCallbackKeyRing(kind, options.keyRing);
  const path =
    kind === "review" ? REVIEW_CALLBACK_PATH : DOWNSTREAM_CALLBACK_PATH;
  const col = outboxCollection(kind);

  const due = await adminDb
    .collection(col)
    .where("deliveryState", "in", ["queued", "leased", "retryable_failed"])
    .orderBy("nextAttemptAtIso", "asc")
    .limit(batchLimit)
    .get();

  const result: DrainVideoReviewV3CallbacksResult = {
    kind,
    scanned: due.size,
    delivered: 0,
    retried: 0,
    deadLettered: 0,
    skipped: 0,
    results: [],
  };

  for (const doc of due.docs) {
    const row = doc.data() ?? {};
    if (asString(row.nextAttemptAtIso) > nowIso) {
      result.skipped += 1;
      continue;
    }
    const leaseExpires = asString(row.leaseExpiresAtIso);
    if (
      asString(row.deliveryState) === "leased" &&
      leaseExpires &&
      leaseExpires > nowIso
    ) {
      result.skipped += 1;
      continue;
    }

    const leased = await adminDb.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const data = fresh.data() ?? {};
      const state = asString(data.deliveryState);
      const freshLease = asString(data.leaseExpiresAtIso);
      if (!["queued", "leased", "retryable_failed"].includes(state))
        return false;
      if (state === "leased" && freshLease && freshLease > nowIso) return false;
      if (asString(data.nextAttemptAtIso) > nowIso) return false;
      tx.set(
        doc.ref,
        {
          deliveryState: "leased" satisfies VideoReviewV3CallbackState,
          leaseExpiresAtIso: new Date(now.getTime() + LEASE_MS).toISOString(),
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return true;
    });
    if (!leased) {
      result.skipped += 1;
      continue;
    }

    const attempts = Number(row.attempts ?? 0);
    const submissionId = asString(row.submissionId);
    try {
      if (!keyRing)
        throw callbackError(
          "callback_secret_unconfigured",
          "v3 callback signing secret is not configured",
        );
      if (!/^https:\/\//.test(baseUrl))
        throw callbackError(
          "callback_transport_unconfigured",
          "Portal base URL is not configured",
        );

      const stateSnap = await adminDb
        .collection(SCP_VIDEO_REVIEW_STATE_COLLECTION)
        .doc(submissionId)
        .get();
      if (!stateSnap.exists)
        throw callbackError(
          "review_state_missing",
          "review-state doc not found for callback",
        );
      const stateData = stateSnap.data() ?? {};
      const subject = extractSubject(stateData);
      const traceId = traceIdOf(stateData);
      if (!subject || !traceId)
        throw callbackError(
          "subject_unresolved",
          "review-state subject/traceId incomplete; cannot build callback",
        );
      const policyVersion = idOrNull(subject.policyVersion) ?? "";
      if (!policyVersion)
        throw callbackError("subject_unresolved", "policyVersion invalid");
      const revision = Number(row.revision ?? subject.videoRevision);

      let event:
        ScpAutomationReviewCallbackEvent | FluDownstreamProjectionCallbackEvent;
      if (kind === "review") {
        const status = asString(row.reviewStatus) as ScpAutomationReviewStatus;
        event = buildReviewStatusObservedEvent({
          subject,
          traceId,
          revision,
          reviewId:
            idOrNull(row.reviewId) ??
            idOrNull(stateData.reviewId) ??
            `review_${submissionId}`,
          status,
          policyVersion,
          reviewedAt: asString(row.createdAtIso) || nowIso,
          publicReasonCode: idOrNull(row.publicReasonCode),
          occurredAt: nowIso,
        });
      } else {
        // Downstream projection callback is emitted ONLY for the current approved revision.
        if (asString(stateData.state) !== "approved")
          throw callbackError(
            "downstream_not_approved",
            "downstream callback requires approved review state",
          );
        event = buildDownstreamStatusObservedEvent({
          subject,
          traceId,
          revision,
          projectionId:
            idOrNull(row.projectionId) ?? `proj_${submissionId}_r${revision}`,
          policyVersion,
          projectedAt: asString(row.createdAtIso) || nowIso,
          occurredAt: nowIso,
        });
      }

      const body = canonicalJson(event);
      const signature = videoReviewV3Signature(
        keyRing.currentSecret,
        unixSeconds,
        body,
      );
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-scp-event-id": event.eventId,
        "x-scp-idempotency-key": event.eventId,
        "x-scp-key-id": keyRing.currentKeyId,
        "x-scp-signature": signature,
        "x-scp-timestamp": String(unixSeconds),
        "x-scp-content-sha256": sha256Hex(body),
      };
      const { status } = await deliverer({
        url: `${baseUrl}${path}`,
        method: "POST",
        body,
        headers,
      });
      const disposition = classifyDeliveryStatus(status);
      if (disposition === "delivered") {
        await doc.ref.set(
          {
            deliveryState: "delivered" satisfies VideoReviewV3CallbackState,
            attempts: attempts + 1,
            leaseExpiresAtIso: null,
            providerStatus: status,
            lastErrorCode: null,
            eventId: event.eventId,
            deliveredAtIso: nowIso,
            updatedAtIso: nowIso,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        await writeCallbackAudit(
          kind,
          doc.id,
          event.eventId,
          submissionId,
          { operation: "callback_delivered", status, attempts: attempts + 1 },
          now,
        );
        // Downstream delivery is the accepted step that enables tracking/settlement.
        if (kind === "downstream")
          await confirmDownstreamProjection(submissionId, revision, now);
        result.delivered += 1;
        result.results.push({
          docId: doc.id,
          state: "delivered",
          code: "",
          status,
        });
        continue;
      }
      const terminal = disposition === "terminal";
      await applyCallbackFailure(
        kind,
        doc,
        attempts,
        terminal ? "callback_rejected" : "callback_retryable",
        terminal,
        now,
        status,
      );
      if (terminal) {
        result.deadLettered += 1;
        result.results.push({
          docId: doc.id,
          state: "dead_letter",
          code: "callback_rejected",
          status,
        });
      } else {
        result.retried += 1;
        result.results.push({
          docId: doc.id,
          state: "retryable_failed",
          code: "callback_retryable",
          status,
        });
      }
    } catch (error) {
      const code = asString(asRecord(error).code) || "callback_delivery_failed";
      // Terminal contract preconditions (never satisfiable by retry) dead-letter immediately.
      const terminal = code === "downstream_not_approved";
      await applyCallbackFailure(kind, doc, attempts, code, terminal, now);
      if (terminal) {
        result.deadLettered += 1;
        result.results.push({ docId: doc.id, state: "dead_letter", code });
      } else {
        result.retried += 1;
        result.results.push({ docId: doc.id, state: "retryable_failed", code });
      }
    }
  }
  return result;
}

async function applyCallbackFailure(
  kind: VideoReviewV3CallbackKind,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  attempts: number,
  code: string,
  forceTerminal: boolean,
  now: Date,
  status?: number,
): Promise<void> {
  const nowIso = now.toISOString();
  const nextAttempts = attempts + 1;
  const deadLetter = forceTerminal || nextAttempts >= MAX_DELIVERY_ATTEMPTS;
  const backoffMinutes =
    RETRY_BACKOFF_MINUTES[Math.min(attempts, RETRY_BACKOFF_MINUTES.length - 1)];
  await doc.ref.set(
    {
      deliveryState: (deadLetter
        ? "dead_letter"
        : "retryable_failed") satisfies VideoReviewV3CallbackState,
      attempts: nextAttempts,
      leaseExpiresAtIso: null,
      lastErrorCode: code,
      providerStatus: status ?? null,
      nextAttemptAtIso: deadLetter
        ? null
        : new Date(now.getTime() + backoffMinutes * 60_000).toISOString(),
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await writeCallbackAudit(
    kind,
    doc.id,
    asString(doc.data()?.eventId),
    asString(doc.data()?.submissionId),
    {
      operation: deadLetter
        ? "callback_dead_letter"
        : "callback_retryable_failed",
      status: status ?? null,
      attempts: nextAttempts,
      errorCode: code,
    },
    now,
  );
}

// Flip downstreamProjectionConfirmed => recompute eligibility (tracking/settlement enabled).
async function confirmDownstreamProjection(
  submissionId: string,
  revision: number,
  now: Date,
): Promise<void> {
  const ref = adminDb
    .collection(SCP_VIDEO_REVIEW_STATE_COLLECTION)
    .doc(submissionId);
  const nowIso = now.toISOString();
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data() ?? {};
    if (asString(data.state) !== "approved") return; // fail-closed: only current approved revision
    const eligibility = computeDownstreamEligibility(
      {
        reviewState: "approved",
        isCurrentRevision: true,
        superseded: false,
        withdrawn: false,
        downstreamProjectionConfirmed: true,
      },
      {
        videoSubmissionId: submissionId,
        revision: Number(data.revision ?? revision),
      },
    );
    tx.set(
      ref,
      {
        downstreamProjectionConfirmed: true,
        feedEligible: eligibility.feedEligible,
        reportEligible: eligibility.reportEligible,
        trackingEligible: eligibility.trackingEligible,
        settlementEligible: eligibility.settlementEligible,
        eligibilityToken: eligibility.eligibilityToken,
        downstreamConfirmedAtIso: nowIso,
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

// Hash-only audit: never persists a raw body, only the eventId + contract-safe metadata.
async function writeCallbackAudit(
  kind: VideoReviewV3CallbackKind,
  docId: string,
  eventId: string,
  submissionId: string,
  fields: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  await adminDb
    .collection(SCP_VIDEO_REVIEW_V3_CALLBACK_AUDIT_COLLECTION)
    .doc()
    .set({
      kind,
      outboxDocId: docId,
      eventId: eventId || null,
      submissionId: submissionId || null,
      ...fields,
      recordedAtIso: nowIso,
      recordedAt: FieldValue.serverTimestamp(),
    });
}
