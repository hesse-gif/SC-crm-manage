// Outbox + scheduled-drain + accepted-receipt STORE for the `scp-creator-pipeline-v3`
// `application.management.acknowledged` PURE sender/builder (./scpCreatorPipelineV3ManagementAckClient).
// Mirrors two proven patterns:
//   - the video-review v3 callback drain (./scpVideoReviewV3Callbacks): durable outbox with
//     lease/retry/backoff/dead-letter (RETRY_BACKOFF_MINUTES/MAX_DELIVERY_ATTEMPTS/LEASE_MS identical),
//     queued row shape mirrors ./videoReviewTransitionStore's enqueue writes.
//   - the receiver's reserve/idempotency ledger (./scpCreatorPipelineV3Receiver:
//     reserveCreatorPipelineV3Receipt): deterministic doc ids, reserve-before-effect, never regress.
//
// This module is the ONLY writer of SCP_CREATOR_PIPELINE_V3_MANAGEMENT_ACK_RECEIPTS_COLLECTION, the
// collection ./scpOutboxMailWorkers.ts already reads via loadCreatorPipelineV3OnboardingGrantBinding
// (WHERE applicationId==, grantIssued==true; reads {grantId, managementEventId, managementReceiptId}).
// The write shape below is FIXED to satisfy that reader.
//
// FLU-DOMAIN GAP (fail-closed by omission): `fluCreatorId`, `partnerId`, `enrollmentId` (and
// `sourceEventId`/`status`/`settlementCreatorCode`/`channelId`) are Flu-domain enrollment-identity facts
// this module does not derive — until the leader's enrollment-identity source lands, real applications
// will be missing one or more of these, `evaluateManagementAckEnqueueEligibility` reports them in
// `missing`, and `enqueueManagementAck` skips (no write) rather than fabricating them. This module is
// dormant-by-construction for every application until that GAP is closed upstream.
//
// PRIVACY P0: only opaque ids/revisions/hashes ever cross into this module or its writes — no raw
// application answers, no raw email/UID. Nothing here is ever fabricated or patched to look complete.
import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";
import { sha256Hex } from "./integrationEventV2";
import { projectDeclaredAudienceCountry, SCP_APPLICATION_MANAGEMENT_COLLECTION } from "./applicationManagementStore";
import {
  fetchCreatorPipelineV3ManagementEvent,
  type CreatorPipelineV3ManagementAckReceipt,
  type ManagementAckEventInput,
} from "./scpCreatorPipelineV3ManagementAckClient";
import {
  fetchCreatorPipelineV3ApplicationMaterial,
  type CreatorPipelineV3ApplicationMaterial,
} from "./scpCreatorPipelineV3MaterialClient";
// R25-B: reuse the SAME intake-material lookup the (mostly-dormant, see FLU-DOMAIN GAP note above)
// ack enqueue path already uses — it has no classification/eligibility gate of its own.
// W63: 상세 로더(하위 사유 포함)가 기본이고, 구 계약 로더는 옵션 주입 경로로만 남는다.
import {
  loadManagementAckIntakeMaterial,
  loadManagementAckIntakeMaterialDetailed,
} from "./scpCreatorPipelineV3ManagementAckWiring";
// W63(리더 L2026-0810-42): 초기 국가 사다리·종결 판정의 정본은 리프 모듈이다. 이 파일은 조회와
//   쓰기만 한다 — 판정을 여기 복제하면 노드 레인에서 행위 테스트가 불가능해진다.
import {
  isDeclaredCountryBackfillCandidate,
  resolveDeclaredCountryTerminal,
  resolveInitialAudienceCountry,
  type InitialAudienceCountryLookups,
  type InitialAudienceCountryResolution,
  type IntakeMaterialCase,
} from "./applicationInitialAudienceCountry";
import { SCP_APPLICATION_CONFIRMED_MAIL_OUTBOX_COLLECTION, applicationConfirmedMailOutboxDocId } from "./scpReceiptMailOutbox";

// Collection scpOutboxMailWorkers.ts already reads via a private literal — exported here so the leader
// can later replace that private literal with this constant (no behavior change, single source of truth).
export const SCP_CREATOR_PIPELINE_V3_MANAGEMENT_ACK_RECEIPTS_COLLECTION =
  "scp_creator_pipeline_v3_management_ack_receipts";
export const SCP_CREATOR_PIPELINE_V3_MANAGEMENT_ACK_OUTBOX_COLLECTION =
  "scp_creator_pipeline_v3_management_ack_outbox";

const DEFAULT_CALLER_ID = "scp-flu-management-ack-v1";
const DEFAULT_MATERIAL_CALLER_ID = "scp-creator-pipeline-v3-management-ack-store-v1";

// Mirrors ./scpVideoReviewV3Callbacks.ts drain constants exactly.
const MAX_DELIVERY_ATTEMPTS = 6;
const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60, 180];
const LEASE_MS = 2 * 60 * 1000;

// Bounded lead time for the application-material verification request, well under Portal's 600s ceiling.
const MATERIAL_REQUEST_TTL_SECONDS = 540;

export type ManagementAckOutboxDeliveryState = "queued" | "leased" | "delivered" | "retryable_failed" | "dead_letter";
export type ManagementAckMaterializationStatus = "materialized" | "materialization_pending" | "materialization_conflict";

// Identity/material snapshot captured at enqueue time (application.management assign/materialize path).
// The enrollment-identity fields are the FLU-DOMAIN GAP: absent/null until the real source lands.
export type ManagementAckEnqueueInput = Readonly<{
  applicationId: string;
  traceId: string;
  revision: number;
  applicationRevision: number;
  materialEventId: string;
  materialHash: string;
  portalCreatorId: string;
  programId: string;
  campaignId?: string | null;
  outreachId?: string | null;
  assignmentMode: "signed_attribution" | "operator_assigned";
  policyVersion: string;
  // ---- GAP fields: Flu-domain enrollment-identity facts, never fabricated ----
  fluCreatorId?: string | null;
  partnerId?: string | null;
  enrollmentId?: string | null;
  sourceEventId?: string | null;
  status?: "active" | "closed" | "revoked" | null;
  settlementCreatorCode?: string | null;
  channelId?: string | null;
  // Pinned at ENQUEUE time (P2#1 fix): the exact `now.toISOString()` captured when this revision was
  // first enqueued (or re-enqueued at a strictly-higher revision). The drain MUST build+send using
  // `new Date(acknowledgedAtIso)` — NEVER drain-time `now` — for every attempt of the same outbox row,
  // so `managedEnrollment.acknowledgedAt`/the event `occurredAt` (and therefore the deterministic
  // eventId, which hashes payload.managedEnrollment) are byte-identical across every retry. Absent only
  // for outbox rows enqueued before this fix landed (drain falls back to drain-time `now` for those).
  acknowledgedAtIso?: string | null;
}>;

// Required for eligibility (present + non-empty), excluding `status` (checked separately) and the
// derived `receiptId` (always derivable from applicationId+revision, never itself a gap).
const REQUIRED_ENQUEUE_IDENTIFIER_FIELDS = [
  "applicationId",
  "traceId",
  "materialEventId",
  "materialHash",
  "portalCreatorId",
  "programId",
  "campaignId",
  "fluCreatorId",
  "partnerId",
  "enrollmentId",
  "sourceEventId",
] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Pure fail-closed eligibility gate. Eligible ONLY when status === "active" AND every required
 * identifier field is present + non-empty. Lists exactly which required fields are missing — for real
 * applications today, `fluCreatorId`/`partnerId`/`enrollmentId` (the enrollment-identity GAP) populate
 * `missing` and the application is ineligible until the leader's identity source lands. NEVER fabricates
 * a missing value to make an application eligible.
 */
export function evaluateManagementAckEnqueueEligibility(
  input: ManagementAckEnqueueInput,
): { eligible: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!input || typeof input !== "object") return { eligible: false, missing: ["input"] };
  const record = input as unknown as Record<string, unknown>;
  for (const field of REQUIRED_ENQUEUE_IDENTIFIER_FIELDS) {
    if (!isNonEmptyString(record[field])) missing.push(field);
  }
  if (!isPositiveInteger(input.revision)) missing.push("revision");
  if (!isPositiveInteger(input.applicationRevision)) missing.push("applicationRevision");
  if (input.status !== "active") missing.push("status");
  return { eligible: missing.length === 0, missing };
}

/**
 * Pure materialization-status derivation. `fetchedMaterialHash` is the hash Portal's application-material
 * response itself reports for the materialized content (or `null` when Portal returned nothing usable);
 * `storedMaterialHash` is Flu's own intake-recorded hash. Never hardcodes "materialized" — absent/null
 * fetched hash fails closed to "materialization_pending", and any mismatch is a "materialization_conflict",
 * never silently treated as materialized.
 */
export function deriveMaterializationStatus(
  fetchedMaterialHash: string | null,
  storedMaterialHash: string,
): ManagementAckMaterializationStatus {
  if (!isNonEmptyString(fetchedMaterialHash)) return "materialization_pending";
  return fetchedMaterialHash === storedMaterialHash ? "materialized" : "materialization_conflict";
}

// Deterministic receiptId, matching Portal's IDENTIFIER_PATTERN (^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$).
function deriveReceiptId(applicationId: string, revision: number): string {
  return `flu_mgmtack_${sha256Hex(`${applicationId}:${revision}`).slice(0, 32)}`;
}

/**
 * Pure builder: assembles the client's `ManagementAckEventInput` (subject + payload + managedEnrollment)
 * from a caller-captured snapshot, or returns `null` when the snapshot is ineligible (fail-closed;
 * mirrors evaluateManagementAckEnqueueEligibility — never fabricates a GAP identity to force eligibility).
 * `receiptId` is deterministic from (applicationId, revision). `acknowledgedAt` is set to `now.toISOString()`
 * so it exactly equals the `occurredAt` the client's `buildApplicationManagementAcknowledgedEvent` will
 * generate from the SAME `now` — the client fails closed if these ever drift.
 */
export function buildManagementAckEventInputFromSnapshot(
  snapshot: ManagementAckEnqueueInput,
  materializationStatus: ManagementAckMaterializationStatus,
  now: Date = new Date(),
): ManagementAckEventInput | null {
  const evaluation = evaluateManagementAckEnqueueEligibility(snapshot);
  if (!evaluation.eligible) return null;

  const acknowledgedAt = now.toISOString();
  const receiptId = deriveReceiptId(snapshot.applicationId, snapshot.revision);

  return {
    traceId: snapshot.traceId,
    revision: snapshot.revision,
    subject: {
      applicationId: snapshot.applicationId,
      portalCreatorId: snapshot.portalCreatorId,
      programId: snapshot.programId,
      ...(snapshot.campaignId ? { campaignId: snapshot.campaignId } : {}),
      ...(snapshot.outreachId ? { outreachId: snapshot.outreachId } : {}),
      traceId: snapshot.traceId,
    },
    payload: {
      applicationRevision: snapshot.applicationRevision,
      materialEventId: snapshot.materialEventId,
      materialHash: snapshot.materialHash,
      managedEnrollment: {
        source: "flu_signed",
        sourceEventId: snapshot.sourceEventId as string,
        revision: snapshot.revision,
        status: "active",
        applicationId: snapshot.applicationId,
        portalCreatorId: snapshot.portalCreatorId,
        fluCreatorId: snapshot.fluCreatorId as string,
        partnerId: snapshot.partnerId as string,
        programId: snapshot.programId,
        campaignId: snapshot.campaignId as string,
        ...(snapshot.outreachId ? { outreachId: snapshot.outreachId } : {}),
        enrollmentId: snapshot.enrollmentId as string,
        ...(snapshot.settlementCreatorCode ? { settlementCreatorCode: snapshot.settlementCreatorCode } : {}),
        ...(snapshot.channelId ? { channelId: snapshot.channelId } : {}),
        acknowledgedAt,
      },
      materializationStatus,
      assignmentMode: snapshot.assignmentMode,
      policyVersion: snapshot.policyVersion,
      receiptId,
    },
  };
}

// ---- Firestore doc-id helpers (mirrors scpCreatorPipelineV3Receiver.ts's `docId`) ------------------

function docId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 48);
}

function outboxDocId(applicationId: string, revision: number): string {
  return docId(`${applicationId}:${revision}`);
}

function receiptDocId(managementEventId: string): string {
  return docId(`evt:${managementEventId}`);
}

// ---- enqueue ----------------------------------------------------------------------------------------

export type EnqueueManagementAckOptions = {
  firestore?: FirebaseFirestore.Firestore;
  now?: Date;
};

/**
 * Fail-closed-by-omission enqueue: when the snapshot is ineligible (GAP fields absent, or status not
 * "active"), returns `{ enqueued: false, reason: "missing:<fields>" }` WITHOUT writing anything — no
 * partial/placeholder outbox row is ever created. When eligible, transactionally upserts a deterministic
 * (applicationId, revision)-keyed outbox row (reserve pattern) so re-enqueuing the same revision is
 * idempotent; a strictly-higher revision reopens the outbox row for redelivery, a same-or-lower revision
 * is a no-op against whatever delivery state already exists.
 */
export async function enqueueManagementAck(
  input: ManagementAckEnqueueInput,
  options: EnqueueManagementAckOptions = {},
): Promise<{ enqueued: boolean; reason?: string }> {
  const evaluation = evaluateManagementAckEnqueueEligibility(input);
  if (!evaluation.eligible) {
    return { enqueued: false, reason: `missing:${evaluation.missing.join(",")}` };
  }

  const db = options.firestore ?? adminDb;
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const ref = db
    .collection(SCP_CREATOR_PIPELINE_V3_MANAGEMENT_ACK_OUTBOX_COLLECTION)
    .doc(outboxDocId(input.applicationId, input.revision));

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data() ?? {};
      // Idempotent no-op: never regress or reset a delivery already at/ahead of this revision.
      if (Number(data.sourceRevision ?? 0) >= input.revision) return;
    }
    tx.set(ref, {
      applicationId: input.applicationId,
      deliveryState: "queued" satisfies ManagementAckOutboxDeliveryState,
      attempts: 0,
      nextAttemptAtIso: nowIso,
      leaseExpiresAtIso: null,
      lastErrorCode: null,
      // P2#1 fix: pin acknowledgedAt/occurredAt at ENQUEUE time (this `nowIso`), never at drain time —
      // the drain reads this back and reuses it verbatim for every attempt of this outbox row so the
      // deterministic eventId is byte-stable across retries.
      snapshot: { ...input, acknowledgedAtIso: nowIso },
      sourceRevision: input.revision,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  return { enqueued: true };
}

// ---- drain --------------------------------------------------------------------------------------------

export type DrainCreatorPipelineV3ManagementAckOptions = {
  firestore?: FirebaseFirestore.Firestore;
  now?: Date;
  batchLimit?: number;
  callerId?: string;
  materialCallerId?: string;
  materialFetcher?: typeof fetchCreatorPipelineV3ApplicationMaterial;
  sendManagementEvent?: typeof fetchCreatorPipelineV3ManagementEvent;
  /** R1 테스트 주입점: 신고 국가 current projection. 기본값은 정본 `projectDeclaredAudienceCountry`. */
  declaredCountryProjector?: typeof projectDeclaredAudienceCountry;
};

export type DrainCreatorPipelineV3ManagementAckResult = {
  processed: number;
  delivered: number;
  failed: number;
  deadLettered: number;
  skipped: number;
};

// Portal-defined application-material shape is unpinned (see ./scpCreatorPipelineV3MaterialClient); this
// extracts ONLY a plain `materialHash` string field if present, never fabricating or re-deriving a hash
// from unrelated fields.
function extractFetchedMaterialHash(material: CreatorPipelineV3ApplicationMaterial | null): string | null {
  if (!material) return null;
  const hash = asString((material as Record<string, unknown>).materialHash);
  return hash || null;
}

// P2#2 fix: the material fetcher fails closed to `null` for BOTH a genuine "not yet materialized"
// response AND a transient transport/config failure (ring unconfigured, non-2xx, network error) —
// see ./scpCreatorPipelineV3MaterialClient.ts's fail-closed enumeration. Collapsing that `null` into a
// terminal "materialization_pending" ack would deliver a no-grant terminal receipt for what may only be
// a transient blip. So a `null` material is classified `"retry"` (drain releases the row for
// retry/backoff, never sends an ack for this attempt) and is NEVER treated as positive evidence of
// "pending". Only once the fetch actually SUCCEEDS (a material object comes back) do we derive a
// terminal status: exact hash match => "materialized"; hash absent OR mismatched on a present object =>
// "materialization_conflict" (terminal — Portal returned material without the hash Flu's intake
// recorded, which is itself a conflict signal, never silently treated as "pending" or "materialized").
// `deriveMaterializationStatus`'s own null-input contract is left intact for its existing callers/tests;
// this helper only defers to it once a fetched hash is known to be present.
export type MaterialFetchClassification = "retry" | ManagementAckMaterializationStatus;

export function classifyMaterialFetch(
  material: CreatorPipelineV3ApplicationMaterial | null,
  storedMaterialHash: string,
): MaterialFetchClassification {
  if (!material) return "retry";
  const fetchedHash = extractFetchedMaterialHash(material);
  if (!isNonEmptyString(fetchedHash)) return "materialization_conflict";
  return deriveMaterializationStatus(fetchedHash, storedMaterialHash);
}

async function releaseForRetry(
  db: FirebaseFirestore.Firestore,
  ref: FirebaseFirestore.DocumentReference,
  attempts: number,
  code: string,
  forceTerminal: boolean,
  now: Date,
): Promise<"retryable_failed" | "dead_letter"> {
  const nowIso = now.toISOString();
  const nextAttempts = attempts + 1;
  const deadLetter = forceTerminal || nextAttempts >= MAX_DELIVERY_ATTEMPTS;
  const backoffMinutes = RETRY_BACKOFF_MINUTES[Math.min(attempts, RETRY_BACKOFF_MINUTES.length - 1)];
  await ref.set({
    deliveryState: (deadLetter ? "dead_letter" : "retryable_failed") satisfies ManagementAckOutboxDeliveryState,
    attempts: nextAttempts,
    leaseExpiresAtIso: null,
    lastErrorCode: code,
    nextAttemptAtIso: deadLetter ? null : new Date(now.getTime() + backoffMinutes * 60_000).toISOString(),
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return deadLetter ? "dead_letter" : "retryable_failed";
}

// Idempotent on managementEventId (deterministic doc id) — a re-drain of an already-accepted delivery
// never double-writes or drifts the receipt.
async function writeAcceptedReceipt(
  db: FirebaseFirestore.Firestore,
  snapshot: ManagementAckEnqueueInput,
  eventInput: ManagementAckEventInput,
  receipt: CreatorPipelineV3ManagementAckReceipt,
  materializationStatus: ManagementAckMaterializationStatus,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  const record = receipt.receipt;
  const managementEventId = asString(record.eventId);
  const managementReceiptId = asString(record.receiptId);
  if (!managementEventId || !managementReceiptId) {
    // Defensive — the client already validates this echo before returning; never write a receipt with
    // an unresolved binding id.
    throw Object.assign(new Error("management_ack_receipt_incomplete"), { code: "management_ack_receipt_incomplete", errorCode: "write_accepted_receipt_management_ack_receipt_incomplete" });
  }
  const grantId = isNonEmptyString(record.grantId) ? record.grantId : null;
  const grantIssued = Boolean(grantId)
    && eventInput.payload.managedEnrollment.status === "active"
    && materializationStatus === "materialized";

  const ref = db
    .collection(SCP_CREATOR_PIPELINE_V3_MANAGEMENT_ACK_RECEIPTS_COLLECTION)
    .doc(receiptDocId(managementEventId));

  await db.runTransaction(async (tx) => {
    tx.set(ref, {
      applicationId: snapshot.applicationId,
      grantId,
      grantIssued,
      managementEventId,
      managementReceiptId,
      receiptId: managementReceiptId,
      applicationRevision: snapshot.applicationRevision,
      materialEventId: snapshot.materialEventId,
      materialHash: snapshot.materialHash,
      materializationStatus,
      managedEnrollmentRevision: snapshot.revision,
      callerId: asString(record.callerId) || DEFAULT_CALLER_ID,
      eventHash: asString(record.eventHash),
      issuedAtIso: asString(record.issuedAt),
      requestId: asString(receipt.requestId),
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

/**
 * Durable drain: leases due outbox rows, verifies application-material against the stored intake hash
 * (materialization status), builds + sends the signed management-ack event, and on a 201 receipt writes
 * the accepted-receipt record `./scpOutboxMailWorkers.ts` reads. Never throws out of the drain — every
 * failure mode (ineligible snapshot, build failure, send failure/rejection, transport error) releases the
 * lease into the same retry/backoff/dead-letter ladder as ./scpVideoReviewV3Callbacks.ts.
 */
export async function drainCreatorPipelineV3ManagementAck(
  options: DrainCreatorPipelineV3ManagementAckOptions = {},
): Promise<DrainCreatorPipelineV3ManagementAckResult> {
  const db = options.firestore ?? adminDb;
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const batchLimit = Math.min(Math.max(options.batchLimit ?? 10, 1), 25);
  const callerId = options.callerId ?? DEFAULT_CALLER_ID;
  const materialCallerId = options.materialCallerId ?? DEFAULT_MATERIAL_CALLER_ID;
  const materialFetcher = options.materialFetcher ?? fetchCreatorPipelineV3ApplicationMaterial;
  const sendManagementEvent = options.sendManagementEvent ?? fetchCreatorPipelineV3ManagementEvent;
  // R1: 기존 materialFetcher/sendManagementEvent 와 같은 주입 패턴. 실 드레인은 정본 프로젝터를 쓴다.
  const declaredCountryProjector = options.declaredCountryProjector ?? projectDeclaredAudienceCountry;

  const result: DrainCreatorPipelineV3ManagementAckResult = {
    processed: 0, delivered: 0, failed: 0, deadLettered: 0, skipped: 0,
  };

  const due = await db.collection(SCP_CREATOR_PIPELINE_V3_MANAGEMENT_ACK_OUTBOX_COLLECTION)
    .where("deliveryState", "in", ["queued", "leased", "retryable_failed"])
    .orderBy("nextAttemptAtIso", "asc")
    .limit(batchLimit)
    .get();

  for (const doc of due.docs) {
    const row = doc.data() ?? {};
    if (asString(row.nextAttemptAtIso) > nowIso) { result.skipped += 1; continue; }
    const leaseExpires = asString(row.leaseExpiresAtIso);
    if (asString(row.deliveryState) === "leased" && leaseExpires && leaseExpires > nowIso) { result.skipped += 1; continue; }

    const leased = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const data = fresh.data() ?? {};
      const state = asString(data.deliveryState);
      const freshLease = asString(data.leaseExpiresAtIso);
      if (!["queued", "leased", "retryable_failed"].includes(state)) return false;
      if (state === "leased" && freshLease && freshLease > nowIso) return false;
      if (asString(data.nextAttemptAtIso) > nowIso) return false;
      tx.set(doc.ref, {
        deliveryState: "leased" satisfies ManagementAckOutboxDeliveryState,
        leaseExpiresAtIso: new Date(now.getTime() + LEASE_MS).toISOString(),
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return true;
    });
    if (!leased) { result.skipped += 1; continue; }

    result.processed += 1;
    const attempts = Number(row.attempts ?? 0);
    const snapshot = asRecord(row.snapshot) as unknown as ManagementAckEnqueueInput;

    try {
      // Re-check eligibility at drain time — the GAP may still be open (dormant by construction) even
      // though it was eligible at enqueue time is a precondition for the row existing at all; this is a
      // defensive re-derivation, never a fabrication.
      const evaluation = evaluateManagementAckEnqueueEligibility(snapshot);
      if (!evaluation.eligible) {
        const state = await releaseForRetry(db, doc.ref, attempts, "management_ack_ineligible", false, now);
        if (state === "dead_letter") result.deadLettered += 1; else result.failed += 1;
        continue;
      }

      const materialExpiresAt = new Date(now.getTime() + MATERIAL_REQUEST_TTL_SECONDS * 1_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
      const material = await materialFetcher({
        applicationId: snapshot.applicationId,
        applicationRevision: snapshot.applicationRevision,
        callerId: materialCallerId,
        eventId: snapshot.materialEventId,
        expiresAt: materialExpiresAt,
        materialHash: snapshot.materialHash,
      }, { now });

      // P2#2 fix: a `null` material fetch (genuinely-not-yet-materialized AND transient transport/config
      // failure are indistinguishable at this boundary — see classifyMaterialFetch) is TRANSIENT: release
      // for retry/backoff and send NO ack this attempt, rather than burning the row on a terminal
      // no-grant "materialization_pending" ack.
      const classification = classifyMaterialFetch(material, snapshot.materialHash);
      if (classification === "retry") {
        const state = await releaseForRetry(db, doc.ref, attempts, "management_ack_material_fetch_failed", false, now);
        if (state === "dead_letter") result.deadLettered += 1; else result.failed += 1;
        continue;
      }
      const materializationStatus = classification;

      // B2-7 + R1: 보호 자료를 이미 손에 든 이 지점에서만 Apply 신고 오디언스 국가를 current
      // projection 에 얹는다(계약 §2.1: normalized allowlist 필드만, raw answers 복사 금지).
      //
      // ⚠️ R1(배포 블로커): 이 실패를 삼키고 ack 를 완료 처리하면 행이 `delivered` 로 닫혀 **다음
      // 드레인이 오지 않는다** — 그 revision 의 Apply 신고 국가(권위 A)가 영구 유실된다. 실패는
      // 다른 실패 모드와 똑같이 retryable 로 반환하고(attempts 증가 + nextAttemptAtIso 백오프),
      // receipts 의 materialized 는 projection 이 성공한 경로에서만 기록된다(아래 writeAcceptedReceipt
      // 는 이 지점을 통과해야 도달한다).
      // F4(a): 문자열 sentinel 은 빈 Error message 일 때 falsy 가 되어 재시도 사다리를 우회한다.
      // 실패 여부는 boolean 으로만 판정하고 메시지는 로그용으로만 쓴다.
      let declaredProjectionFailed = false;
      let declaredProjectionFailureMessage = "";
      try {
        await declaredCountryProjector({
          applicationId: snapshot.applicationId,
          applicationRevision: snapshot.applicationRevision,
          materialEventId: snapshot.materialEventId,
          materialHash: snapshot.materialHash,
          material,
        }, now);
      } catch (error) {
        declaredProjectionFailed = true;
        declaredProjectionFailureMessage = error instanceof Error && error.message ? error.message : "unknown";
      }
      if (declaredProjectionFailed) {
        console.warn("[management-ack] declared_audience_country_projection_failed", JSON.stringify({
          applicationId: snapshot.applicationId,
          error: declaredProjectionFailureMessage,
        }));
        const state = await releaseForRetry(
          db,
          doc.ref,
          attempts,
          "management_ack_declared_country_projection_failed",
          false,
          now,
        );
        if (state === "dead_letter") result.deadLettered += 1; else result.failed += 1;
        continue;
      }

      // P2#1 fix: build + send using the ENQUEUE-pinned acknowledgedAt/occurredAt — never drain-time
      // `now` — so the deterministic eventId (which hashes payload.managedEnrollment.acknowledgedAt) is
      // byte-stable across every retry of this outbox row. Legacy rows enqueued before this fix carry no
      // `acknowledgedAtIso`; those fall back to drain-time `now` (their pre-fix behavior, unchanged).
      const pinnedNow = isNonEmptyString(snapshot.acknowledgedAtIso) ? new Date(snapshot.acknowledgedAtIso) : now;

      const eventInput = buildManagementAckEventInputFromSnapshot(snapshot, materializationStatus, pinnedNow);
      if (!eventInput) {
        const state = await releaseForRetry(db, doc.ref, attempts, "management_ack_build_failed", false, now);
        if (state === "dead_letter") result.deadLettered += 1; else result.failed += 1;
        continue;
      }

      // `now: pinnedNow` is required here too — the client fails closed unless
      // `payload.managedEnrollment.acknowledgedAt` exactly equals the `occurredAt` it derives from this
      // same `now` (see buildApplicationManagementAcknowledgedEvent). `callerId` is the only per-attempt
      // input; expiresAt/timestamp are consequently derived from the same pinned anchor as occurredAt.
      const receipt = await sendManagementEvent(eventInput, { now: pinnedNow, callerId });
      if (!receipt) {
        const state = await releaseForRetry(db, doc.ref, attempts, "management_ack_send_failed", false, now);
        if (state === "dead_letter") result.deadLettered += 1; else result.failed += 1;
        continue;
      }

      await writeAcceptedReceipt(db, snapshot, eventInput, receipt, materializationStatus, now);
      await doc.ref.set({
        deliveryState: "delivered" satisfies ManagementAckOutboxDeliveryState,
        attempts: attempts + 1,
        leaseExpiresAtIso: null,
        lastErrorCode: null,
        managementEventId: asString(receipt.receipt.eventId),
        deliveredAtIso: nowIso,
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      result.delivered += 1;
    } catch (error) {
      const code = asString(asRecord(error).code) || "management_ack_delivery_failed";
      const state = await releaseForRetry(db, doc.ref, attempts, code, false, now);
      if (state === "dead_letter") result.deadLettered += 1; else result.failed += 1;
    }
  }

  return result;
}

// ---- R25-B: declared-audience-country backfill (path-gap fix) --------------------------------------
//
// Defect: projectDeclaredAudienceCountry's only caller was drainCreatorPipelineV3ManagementAck above,
// which only ever processes rows that made it into the ack OUTBOX — and enqueueManagementAck is
// fail-closed-by-omission on the FLU-DOMAIN GAP (fluCreatorId/partnerId/enrollmentId) AND requires
// classification==="managed". Real applications are overwhelmingly unclassified/token_absent (14/17
// observed) or missing the GAP fields, so the outbox stays near-empty (observed: 1 row total) and
// declaredPrimaryAudienceCountry never gets projected (observed: 0/17).
//
// Fix: a SEPARATE small backfill pass, reusing (not duplicating) this file's existing material-fetch
// signing pattern and the SAME 1-minute schedule (index.ts's drainScpCreatorPipelineV3ManagementAck —
// see the sibling call there) — no new scheduler, no new collection, no new state machine. It scans a
// bounded window of scp_application_management records, and for whichever ones are still missing
// declaredPrimaryAudienceCountry — REGARDLESS of classification/manageInbox/GAP-field completeness —
// resolves intake material via loadManagementAckIntakeMaterial (the receipt ledger that function reads
// has no classification gate; scpCreatorPipelineV3Receiver.ts writes it for every submission) and
// projects. Firestore has no "field is absent" query, so the window is scanned and filtered in memory;
// at the current/near-term scale a single pass's scanLimit already covers the whole
// collection, so this converges within a few 1-minute ticks with zero dedicated migration commit.
// [W63 2차 델타 M3] 이 전제("17 real records")는 2026-08-10 실측 **71건**으로 깨졌다 — 한 창이
// 컬렉션을 못 덮으면 tail 은 영원히 차례를 못 받는다. 아래 스캔이 회전 창으로 그 구멍을 막는다.
//
// HIGH-1 [적대적 리뷰 REQUEST CHANGES 실측]: 위 설계에 시도 마커가 없어 세 가지가 재발했다 —
//  ① 전원 declared 보유 정상상태에서도 매 pass scanLimit(옛 50) 개를 무조건 다시 훑는다(종료
//     조건 없음, 실측 24,480 reads/일).
//  ② 영구 투영 불가 후보(자료 자체에 국가가 없음)를 매 pass 다시 material fetch 한다 — 포털
//     서명 호출을 하루 최대 SCAN_LIMIT×1440/일까지 낭비 반복할 수 있다.
//  ③ 앞자리 영구실패 N건이 processLimit 을 매번 소진해, 뒤쪽의 실제 투영 가능 후보가 영원히
//     차례를 못 받는다(기아 — BLOCKER-B·이전 라운드 HIGH 와 같은 클래스: "예산이 진행이 아니라
//     선택에서 소모"된다. projectDeclaredAudienceCountry 는 실패해도 아무것도 안 써서 후보가
//     영구 잔류했다).
// declaredAudienceCountryAttempt 시도 마커(additive, merge, 새 컬렉션 0)로 세 가지를 동시에
// 고친다 — 실패 원인·누적 횟수를 관리 doc 에 남기고, 재방문 간격을 지수 백오프(상한 24시간)로
// 늘린다. 후보 산정을 "declared 없음 ∧ (마커 없음 ∨ 백오프 경과)"로 좁혀서, 영구실패는 시간이
// 지날수록 스스로 뒤로 밀려나 앞자리를 영구 점유하지 못한다 — processLimit 예산이 실제로 투영
// 가능한 후보에게 정상적으로 넘어간다. 성공(projected:true)은 declaredPrimaryAudienceCountry
// 자신이 다음 pass 스캔의 "이미 완료" 필터에 걸리므로 별도 마커가 필요 없다(마커는 실패에만
// 쓴다). 스캔 자체 reads 도 줄인다 — Firestore 는 "필드 부재" 쿼리를 지원하지 않아(부정 조건
// 불가) 완전한 스킵은 못 하지만, scanLimit 기본값을 50→20 으로 낮췄다.
// W63 2차 델타 M3 [실측 갱신]: 이 주석이 근거로 삼던 "현재 규모 17건"은 **더 이상 사실이 아니다**
//   (2026-08-10 실측 71건). 한 창 20 으로는 컬렉션을 못 덮으므로 아래 스캔이 회전 창을 함께 연다.
//   scanned===scanLimit 이면 다음 정책 검토 신호로 result 에 그대로 남는다 — 조용히 잘리지 않는다.
export const DECLARED_AUDIENCE_COUNTRY_BACKFILL_SCAN_LIMIT = 20;
export const DECLARED_AUDIENCE_COUNTRY_BACKFILL_PROCESS_LIMIT = 5;
const DEFAULT_BACKFILL_MATERIAL_CALLER_ID = "scp-creator-pipeline-v3-declared-country-backfill-v1";
// HIGH-1②: 첫 재시도는 5분 뒤 — attempts 가 쌓일 때마다 두 배로 늘어(1×,2×,4×,...) 24시간(지시
// 상한)에서 멈춘다. 5분×2^(attempts-1), attempts=1 → 5분, attempts=9 → 약 21.3시간, attempts≥10 →
// 24시간 고정.
const DECLARED_AUDIENCE_COUNTRY_BACKFILL_RETRY_BACKOFF_BASE_MS = 5 * 60 * 1000;
const DECLARED_AUDIENCE_COUNTRY_BACKFILL_RETRY_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

function declaredAudienceCountryBackfillBackoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.trunc(attempts) - 1);
  const backoff = DECLARED_AUDIENCE_COUNTRY_BACKFILL_RETRY_BACKOFF_BASE_MS * Math.pow(2, exponent);
  return Math.min(DECLARED_AUDIENCE_COUNTRY_BACKFILL_RETRY_BACKOFF_MAX_MS, backoff);
}

// ---- W63: 초기 오디언스 국가 사다리의 **조회 구현** ------------------------------------------------
//
// 판정은 리프 모듈이, 조회는 여기가 갖는다. 조인 키는 확인메일 아웃박스가 남긴
// `recipientEmailHash`(sha256 전체, 원문은 발송 후 삭제됨)이고, 콜드메일 이력의 `emailHash` 가
// 같은 다이제스트의 앞 24자다 — **원문 이메일을 어디서도 읽지 않고** 아웃리치 행에 도달한다.
// 후보 1건당 읽기는 최대 3(아웃박스 1 + 이력 쿼리 1 + 아웃리치 1)이고, 2·3단은 필요할 때만 읽는다.
const SCP_COLDMAIL_HISTORY_COLLECTION = "scp_coldmail_history";
const CAMPAIGN_OUTREACH_COLLECTION = "campaign_outreach";
const COLDMAIL_HISTORY_JOIN_LIMIT = 5;

function outreachCountryDecision(data: Record<string, unknown>): string {
  // 이 필드는 문자열일 때도, `{decision}` 객체일 때도 있다(admin.ts 두 계보). 둘 다 받는다.
  return asString(data.countryDecision) || asString(asRecord(data.countryDecision).decision);
}

export function createInitialAudienceCountryLookups(
  db: FirebaseFirestore.Firestore,
): InitialAudienceCountryLookups {
  return {
    recipientEmailHash: async (applicationId) => {
      const snap = await db
        .collection(SCP_APPLICATION_CONFIRMED_MAIL_OUTBOX_COLLECTION)
        .doc(applicationConfirmedMailOutboxDocId(applicationId))
        .get();
      return snap.exists ? asString(snap.data()?.recipientEmailHash) || null : null;
    },
    outreachByEmailHash: async (emailHashPrefix) => {
      // W63 2차 델타 M2 [적대 리뷰 · 리더 L2026-0810-44 최소 해법]: 종전 구현은 `limit(5)` 결과를
      //   메모리 정렬해 "최신 발송"이라고 불렀다. Firestore 가 orderBy 없이 주는 5건은 `__name__`
      //   순이라, 발송이 5건을 넘는 사람에게는 **문서 id 하위 5건 중 최신**이 나온다 — stale 국가가
      //   최신인 척한다. 이 리포가 W34 F-1(admin.ts 재촉 대상 선정)에서 이미 근인으로 확정한 클래스다.
      //
      //   최소안을 쓴다(리더 결정): **새 복합 색인을 만들지 않는다.** 현재 규모에서 한 이메일당
      //   이력은 실측상 1~2건이고(4,792행 중 중복 9건), 상한 5는 이미 여유가 크다. 대신 상한에
      //   닿은 사실을 **증거에 표식으로 남긴다** — 그때의 값은 "전수 중 최신"이 아니라 "본 것 중
      //   최신"이라는 다른 사실이고, 조용히 같은 값처럼 쓰이는 게 이 클래스의 핵심 결함이다.
      //   규모가 커져 이 표식이 실제로 뜨기 시작하면 그때 색인을 만들면 된다(지금은 과설계다).
      const historySnap = await db
        .collection(SCP_COLDMAIL_HISTORY_COLLECTION)
        .where("emailHash", "==", emailHashPrefix)
        .limit(COLDMAIL_HISTORY_JOIN_LIMIT)
        .get();
      if (historySnap.empty) return null;
      const truncated = historySnap.size >= COLDMAIL_HISTORY_JOIN_LIMIT;
      // 본 것 안에서는 발송 시각 최신이 이긴다(빈 값은 뒤로 밀린다). 판정은 종전과 같고,
      // 달라진 것은 **상한에 닿았다는 사실을 숨기지 않는다**는 점 하나다.
      const latest = historySnap.docs
        .map((historyDoc) => historyDoc.data() ?? {})
        .sort((left, right) => asString(right.sentAtIso).localeCompare(asString(left.sentAtIso)))[0];
      const sourceRef = asString(latest?.sourceRef);
      if (!sourceRef.startsWith(`${CAMPAIGN_OUTREACH_COLLECTION}/`)) return null;
      const outreachSnap = await db.doc(sourceRef).get();
      if (!outreachSnap.exists) return null;
      const data = outreachSnap.data() ?? {};
      return {
        sourceRef,
        country: data.country,
        creatorRegion: data.creatorRegion,
        countryDecision: outreachCountryDecision(data),
        candidateRef: asString(data.candidateRef) || asString(data.campaignCandidateRef),
        ...(truncated ? { truncated: true } : {}),
      };
    },
    candidateByRef: async (candidateRef) => {
      if (!candidateRef.includes("/")) return null;
      const collection = candidateRef.split("/")[0];
      if (collection !== "candidate_pool" && collection !== "campaign_candidates") return null;
      const snap = await db.doc(candidateRef).get();
      if (!snap.exists) return null;
      const data = snap.data() ?? {};
      return {
        sourceRef: candidateRef,
        source: collection,
        creatorCountry: data.creatorCountry,
        country: data.country,
        region: data.region,
      };
    },
    creatorByIdentity: async (identity) => {
      if (identity.fluCreatorId) {
        const snap = await db.collection("creators").doc(identity.fluCreatorId).get();
        if (snap.exists) {
          const data = snap.data() ?? {};
          // W63 2차 델타: 문서를 **그대로** 넘긴다 — 필드 사다리 해석은 정본(creatorCountryProjection)이 한다.
          return { sourceRef: `creators/${snap.id}`, data };
        }
      }
      if (!identity.channelId) return null;
      // creators 작성자 계보가 셋이라 세 필드를 다 물어보고 **유일할 때만** 쓴다(같은 채널을
      // 다른 creator 에 붙이지 않는다 — applicationManagementStore 의 신원 해석과 같은 규칙).
      const matches = new Map<string, Record<string, unknown>>();
      for (const field of ["channelId", "youtubeChannelId", "canonicalChannelId"]) {
        const snap = await db.collection("creators").where(field, "==", identity.channelId).limit(2).get();
        for (const creatorDoc of snap.docs) matches.set(creatorDoc.id, creatorDoc.data() ?? {});
        if (matches.size > 1) return null;
      }
      if (matches.size !== 1) return null;
      const [docId, data] = [...matches.entries()][0];
      return { sourceRef: `creators/${docId}`, data };
    },
  };
}

/**
 * HIGH-1①③: "declared 없음 ∧ (마커 없음 ∨ 백오프 경과)". 마커가 없으면(첫 시도) 항상 대상이다 —
 * 신규 지원서가 굶지 않는다. 마커의 atIso 가 파싱 불가(손상값)면 fail-open 으로 다시 대상에
 * 넣는다(영구 봉쇄보다 재시도 쪽이 안전하다).
 *
 * W63(리더 L2026-0810-42 결정 2): 여기에 **종결 축**이 붙는다. 판정 자체는 순수 모듈
 * (applicationInitialAudienceCountry)이 소유한다 — 이 파일은 문서에서 필드를 꺼내 넘기기만 한다.
 */
function isDeclaredAudienceCountryBackfillEligible(data: Record<string, unknown>, nowMs: number): boolean {
  const attempt = asRecord(data.declaredAudienceCountryAttempt);
  return isDeclaredCountryBackfillCandidate({
    hasDeclaredCountry: isNonEmptyString(asString(data.declaredPrimaryAudienceCountry)),
    attemptAtIso: asString(attempt.atIso) || null,
    attempts: typeof attempt.attempts === "number" ? attempt.attempts : 0,
    terminal: attempt.terminal === true,
    terminalAtIso: asString(attempt.terminalAtIso) || null,
    nowMs,
    backoffMs: declaredAudienceCountryBackfillBackoffMs,
  });
}

export type BackfillDeclaredAudienceCountryOptions = {
  firestore?: FirebaseFirestore.Firestore;
  now?: Date;
  materialCallerId?: string;
  materialFetcher?: typeof fetchCreatorPipelineV3ApplicationMaterial;
  declaredCountryProjector?: typeof projectDeclaredAudienceCountry;
  /** 구 계약(자재만 돌려주는 로더). 주입되면 하위 사유를 알 수 없으므로 **종결하지 않는다**. */
  intakeMaterialLoader?: typeof loadManagementAckIntakeMaterial;
  /** W63: 하위 사유까지 돌려주는 로더가 기본값이다. */
  intakeMaterialCaseLoader?: typeof loadManagementAckIntakeMaterialDetailed;
  /** W63: 초기 국가 사다리 조회. 주입은 테스트용이고 기본값은 서버 소유 컬렉션이다. */
  initialCountryLookups?: InitialAudienceCountryLookups;
  /** Bounded scan window (Firestore can't filter "field absent" — filtered in memory, capped). */
  scanLimit?: number;
  /** Upper bound on material-fetch calls THIS pass makes (the "pass 당 소수" requirement). */
  processLimit?: number;
};

export type BackfillDeclaredAudienceCountryResult = {
  scanned: number;
  candidates: number;
  processed: number;
  projected: number;
  skipped: number;
  /** W63: 신고값이 아니라 **관측 초기 국가**를 채운 건수. 두 축을 한 카운터로 합치지 않는다. */
  initialCountryProjected: number;
  /**
   * W63 MINOR-2 [적대 재리뷰]: 이력 조회가 상한에 걸린 채 만들어진 초기 국가의 건수.
   * "표식이 뜨기 시작하면 그때 색인을 만든다"는 판단 기준이 수동 쿼리에 기대고 있었다 —
   * pass 결과에 실어 로그만 봐도 트리거가 보이게 한다(값이 0 이면 아직 그 시점이 아니다).
   */
  sourceTruncated: number;
  /** W63: 이번 pass 에서 결정적 실패로 종결한 건수. */
  terminalized: number;
};

export async function backfillDeclaredAudienceCountry(
  options: BackfillDeclaredAudienceCountryOptions = {},
): Promise<BackfillDeclaredAudienceCountryResult> {
  const db = options.firestore ?? adminDb;
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const materialCallerId = options.materialCallerId ?? DEFAULT_BACKFILL_MATERIAL_CALLER_ID;
  const materialFetcher = options.materialFetcher ?? fetchCreatorPipelineV3ApplicationMaterial;
  const declaredCountryProjector = options.declaredCountryProjector ?? projectDeclaredAudienceCountry;
  // W63: 하위 사유를 아는 로더가 기본이다. 구 계약 로더가 주입되면 사유를 알 수 없으므로
  //   "결정적"이라고 단정하지 않는다(intakeCase="unknown_absent") — 모르는 것을 종결 근거로 쓰지 않는다.
  const intakeMaterialCaseLoader: typeof loadManagementAckIntakeMaterialDetailed = options.intakeMaterialCaseLoader
    ?? (options.intakeMaterialLoader
      ? async (database, applicationId) => {
        const material = await options.intakeMaterialLoader!(database, applicationId);
        return { material, intakeCase: material ? "resolvable" : "unknown_absent" };
      }
      : loadManagementAckIntakeMaterialDetailed);
  const initialCountryLookups = options.initialCountryLookups ?? createInitialAudienceCountryLookups(db);
  const scanLimit = Math.min(Math.max(options.scanLimit ?? DECLARED_AUDIENCE_COUNTRY_BACKFILL_SCAN_LIMIT, 1), 200);
  const processLimit = Math.min(Math.max(options.processLimit ?? DECLARED_AUDIENCE_COUNTRY_BACKFILL_PROCESS_LIMIT, 1), 25);

  const result: BackfillDeclaredAudienceCountryResult = {
    scanned: 0, candidates: 0, processed: 0, projected: 0, skipped: 0,
    initialCountryProjected: 0, sourceTruncated: 0, terminalized: 0,
  };

  // W63 2차 델타 M3 [적대 리뷰]: 스캔이 `updatedAtIso desc` **한 창**뿐이라 tail 이 굶었다.
  //   종결·시도 마커 쓰기는 `updatedAtIso` 를 갱신하지 않으므로(의도적이다 — 백필이 문서의
  //   "마지막 변경 시각"을 흔들면 다른 소비자가 그걸 사용자 활동으로 읽는다) 창이 **고정**된다.
  //   프로드 71건 · scanLimit 20 이면 뒤쪽 ~51건은 자동 종결도, 자동 해제도 영원히 못 받는다.
  //   커서를 저장하는 대신 **두 번째 창**을 연다: 가장 오래 안 본 시도 마커 순(asc).
  //   처리하면 atIso 가 갱신되어 스스로 뒤로 밀리므로, 상태 없이 회전이 성립한다.
  //   마커가 없는 신규 문서는 첫 창(최신 갱신순)이 덮는다 — 두 창이 서로의 사각을 메운다.
  const freshSnapshot = await db.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION)
    .orderBy("updatedAtIso", "desc")
    .limit(scanLimit)
    .get();
  const scannedDocs = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  for (const doc of freshSnapshot.docs) scannedDocs.set(doc.id, doc);
  // 첫 창이 컬렉션 전체를 덮었으면(문서가 창보다 적다) 두 번째 창은 아예 열지 않는다 —
  // 규모가 작을 때 같은 문서를 두 번 읽는 비용을 내지 않는다.
  if (freshSnapshot.size >= scanLimit) {
    const rotationSnapshot = await db.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION)
      .orderBy("declaredAudienceCountryAttempt.atIso", "asc")
      .limit(scanLimit)
      .get();
    for (const doc of rotationSnapshot.docs) scannedDocs.set(doc.id, doc);
  }
  result.scanned = scannedDocs.size;

  // HIGH-1①②③: declared 보유(완료)·백오프 미경과(영구/최근 실패)를 한 번에 걸러낸다 — 정상상태
  // (전원 declared)에서는 candidates 가 실질 0 으로 수렴하고, 영구실패는 백오프가 풀릴 때까지
  // processLimit 예산을 두고 뒤쪽 후보와 경쟁하지 않는다.
  const candidates = [...scannedDocs.values()]
    .filter((doc) => isDeclaredAudienceCountryBackfillEligible(doc.data(), nowMs))
    // 오래 안 본 것부터 처리한다(마커 없는 신규는 맨 앞). 회전이 실제로 앞으로 나아가야 한다.
    .sort((left, right) => {
      const leftAt = asString(asRecord(left.data().declaredAudienceCountryAttempt).atIso);
      const rightAt = asString(asRecord(right.data().declaredAudienceCountryAttempt).atIso);
      if (!leftAt && !rightAt) return 0;
      if (!leftAt) return -1;
      if (!rightAt) return 1;
      return leftAt.localeCompare(rightAt);
    });
  result.candidates = candidates.length;

  const materialExpiresAt = new Date(nowMs + MATERIAL_REQUEST_TTL_SECONDS * 1_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

  for (const doc of candidates.slice(0, processLimit)) {
    result.processed += 1;
    const data = doc.data();
    // identity.applicationId is the authoritative applicationId (buildIdentityMapping,
    // applicationManagementStore.ts) — storeDocId() only ever differs from it for characters outside
    // [A-Za-z0-9_-], so this never silently substitutes a mismatched id.
    const applicationId = asString(asRecord(data.identity).applicationId) || doc.id;
    // HIGH-1: 실패 사유를 여기 채우면 아래에서 시도 마커를 additive 로 남긴다. 성공하면 null 로
    // 남는다 — R26-6: 이전 실패로 마커가 이미 남아 있었다면 아래에서 지운다(declaredPrimaryAudienceCountry
    // 자신이 "완료" 신호라 마커가 더 남아 있을 이유가 없다 — 순수 위생 정리, 판정 로직에는 영향 없음).
    let failureReason: string | null = null;
    // W63: 인테이크 하위 사유. 종결은 **결정적 사유일 때만** 선다(순수 모듈이 판정한다).
    let intakeCase: IntakeMaterialCase = "unknown_absent";
    try {
      const intake = await intakeMaterialCaseLoader(db, applicationId);
      intakeCase = intake.intakeCase;
      if (!intake.material) {
        // 사유를 하위 케이스까지 남긴다. 종전에는 다섯 사실이 `no_intake_material` 하나였고,
        // 운영자는 "기다리면 되는 것"과 "영원히 안 되는 것"을 구분할 수 없었다.
        failureReason = `no_intake_material:${intakeCase}`;
        result.skipped += 1;
      } else {
        const material = await materialFetcher({
          applicationId,
          applicationRevision: intake.material.applicationRevision,
          callerId: materialCallerId,
          eventId: intake.material.materialEventId,
          expiresAt: materialExpiresAt,
          materialHash: intake.material.materialHash,
        });
        if (!material) {
          failureReason = "no_material";
          result.skipped += 1;
        } else {
          const projection = await declaredCountryProjector({
            applicationId,
            applicationRevision: intake.material.applicationRevision,
            materialEventId: intake.material.materialEventId,
            materialHash: intake.material.materialHash,
            material,
          }, now);
          if (projection.projected) result.projected += 1;
          else { failureReason = projection.reason; result.skipped += 1; }
        }
      }
    } catch (error) {
      // Never throws out of the pass — one application's failure must not block the rest of this
      // batch or the caller's (drain's) own processing this tick.
      failureReason = asString(asRecord(error).code) || "backfill_attempt_failed";
      console.warn("[declared-audience-country-backfill] projection attempt failed", {
        applicationId,
        errorCode: failureReason,
      });
      result.skipped += 1;
    }

    // W63(결정 1): 신고값을 못 얻은 문서에만 **관측 초기 국가**를 시도한다. 신고값이 있으면 그 축이
    //   이미 있으므로 관측값을 덧씌우지 않는다 — 두 축은 대체 관계가 아니다.
    //   조회 실패는 "원천 없음"이 아니다(종결 근거로 쓰면 장애가 영구 종결이 된다) → null 로 둔다.
    let initial: InitialAudienceCountryResolution | null = null;
    if (failureReason) {
      try {
        const identity = asRecord(data.identity);
        initial = await resolveInitialAudienceCountry(
          {
            applicationId,
            nowIso,
            identity: { fluCreatorId: asString(identity.fluCreatorId), channelId: asString(identity.channelId) },
          },
          initialCountryLookups,
        );
      } catch (error) {
        console.warn("[declared-audience-country-backfill] initial country lookup failed", {
          applicationId,
          errorCode: asString(asRecord(error).code) || "initial_country_lookup_failed",
        });
        initial = null;
      }
    }

    if (failureReason) {
      const priorAttempt = asRecord(data.declaredAudienceCountryAttempt);
      const priorAttempts = typeof priorAttempt.attempts === "number" && Number.isFinite(priorAttempt.attempts) && priorAttempt.attempts > 0
        ? priorAttempt.attempts
        : 0;
      // W63 2차 델타 M1: 종결 판정은 **신고 축만** 본다. 관측 조회가 실패했거나 아예 못 돌았어도
      //   신고 축의 결정적 부재는 그대로 결정적이다(종전에는 initial 이 null 이면 종결 자체를
      //   건너뛰어, 조회 장애가 종결을 막았다).
      const terminal = resolveDeclaredCountryTerminal({
        intakeCase,
        submittedAtIso: asString(data.submittedAtIso) || null,
        nowMs,
      });
      if (terminal) result.terminalized += 1;
      // 관측 축의 결과는 **따로** 기록한다 — 성공이면 값+증거, 실패면 miss 사유.
      //   두 축을 한 필드에 섞으면(옛 terminalReason) 손상 영수증이 "원천 없음"으로 은폐된다.
      const initialCountryPatch = initial?.resolved
        ? {
          initialAudienceCountry: initial.code,
          initialAudienceCountryEvidence: initial.evidence,
          initialAudienceCountryMiss: FieldValue.delete(),
        }
        : {
          initialAudienceCountryMiss: initial
            ? { reason: initial.reason, atIso: nowIso }
            : { reason: "lookup_failed", atIso: nowIso },
        };
      if (initial?.resolved) result.initialCountryProjected += 1;
      // MINOR-2: 상한에 걸린 조회에서 나온 값이면 함께 센다 — 색인 신설 트리거를 pass 결과가 말한다.
      if (initial?.resolved && initial.evidence.sourceTruncated === true) result.sourceTruncated += 1;
      await doc.ref.set({
        declaredAudienceCountryAttempt: {
          atIso: nowIso,
          reason: failureReason,
          attempts: priorAttempts + 1,
          // 종결 축은 **매 pass 다시 계산**한다. merge 는 중첩 맵을 깊게 병합하므로, 종결이 아닌
          // 판정이 나오면 명시적으로 지워야 옛 종결이 남아 영구 배제되지 않는다(자동 해제).
          ...(terminal
            ? { terminal: true, terminalReason: terminal.terminalReason, terminalAtIso: nowIso }
            : {
              terminal: FieldValue.delete(),
              terminalReason: FieldValue.delete(),
              terminalAtIso: FieldValue.delete(),
            }),
        },
        ...initialCountryPatch,
      }, { merge: true });
    } else if (data.declaredAudienceCountryAttempt !== undefined) {
      // R26-6 [LOW-1 적대적 리뷰 실측]: 이번 pass 가 성공했는데 이전 pass 의 실패 마커가 남아 있으면
      // 지운다 — 정상상태 스캔·판정(isDeclaredAudienceCountryBackfillEligible)은 이미
      // declaredPrimaryAudienceCountry 보유로 걸러지므로 이 삭제는 판정에 영향을 주지 않는다.
      await doc.ref.set({
        declaredAudienceCountryAttempt: FieldValue.delete(),
      }, { merge: true });
    }
  }

  return result;
}
