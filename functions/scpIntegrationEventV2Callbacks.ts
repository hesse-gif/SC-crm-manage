// scp.integration-event.v2 outbound status callbacks (Flu -> Portal, signed_callback_producer role).
//
// Flu produces two flu->portal events defined by the pinned contract:
//   - video.review-status.changed  (source: flu)
//   - video.view-snapshot.updated  (source: flu; payload.reviewStatus is const "approved")
// Signing / canonicalization / identity come from the vendored, byte-identical contract library so
// Portal's signed_callback_receiver verifies them with the shared v2 HMAC key ring. Delivery is a
// durable outbox with leases, retry/backoff, dead-letter, per-eventId idempotency, and secret
// rotation. Transport is fail-closed until the Portal callback URL is bound (contract_only in G013).
//
// Only contract payload fields cross the wire: no internal model reasoning, operator notes, or raw
// PII. reasonCode is constrained to the contract id pattern, not free text.

import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { expireAt180DaysFromIso } from "./firestoreTtl";
import { asRecord, asString } from "./shared";
import {
  buildIntegrationEventV2,
  buildIntegrationEventV2Request,
  identitySha256 as computeIdentitySha256,
  integrationEventV2Body,
  isSuccessfulIntegrationEventV2Status,
  sha256Hex,
  type IntegrationEventV2,
  type VideoReviewStatusChangedEventV2,
  type VideoViewSnapshotUpdatedEventV2,
} from "./integrationEventV2";
import {
  resolveIntegrationEventV2KeyRing,
  SCP_INTEGRATION_EVENT_V2_CONTRACT,
  INTEGRATION_EVENT_V2_VIDEO_LINKS_COLLECTION,
} from "./scpIntegrationEventV2";
// 판정 원장(canonical review ledger)의 컬렉션 상수와 상태축은 원장 소유 모듈에서 그대로 가져온다.
// 문자열/상태 목록을 여기서 복제하면 W125 를 만든 축 어긋남이 다시 생긴다(읽기 전용 의존).
import { reviewDocId, SCP_VIDEO_REVIEW_STATE_COLLECTION } from "./videoReviewTransitionStore";
import { normalizeLegacyReviewState, VIDEO_REVIEW_STATES } from "./videoReviewTransitionCore";

export const SCP_INTEGRATION_EVENT_V2_CALLBACK_URL_ENV = "SCP_PORTAL_INTEGRATION_EVENT_V2_CALLBACK_URL";
export const INTEGRATION_EVENT_V2_CALLBACK_OUTBOX_COLLECTION = "scp_integration_event_v2_callback_outbox";
export const INTEGRATION_EVENT_V2_CALLBACK_AUDIT_COLLECTION = "scp_integration_event_v2_callback_audit";

const MAX_DELIVERY_ATTEMPTS = 6;
const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60, 180];
const LEASE_MS = 2 * 60 * 1000;

export type IntegrationEventV2CallbackState = "queued" | "leased" | "delivered" | "retryable_failed" | "dead_letter";

type CallbackError = Error & { code: string };
function callbackError(code: string, message: string): CallbackError {
  return Object.assign(new Error(message), { code });
}

export type IntegrationEventV2CallbackDeliverer = (
  request: Readonly<{ url: string; method: "POST"; body: string; headers: Readonly<Record<string, string>> }>,
) => Promise<{ status: number }>;

// Fail-closed default transport: no configured Portal callback URL -> retryable, never silently dropped.
export const unconfiguredIntegrationEventV2CallbackDeliverer: IntegrationEventV2CallbackDeliverer = async () => {
  throw callbackError("callback_transport_unconfigured", "Portal v2 callback URL is not configured");
};

async function httpCallbackDeliverer(
  request: Readonly<{ url: string; method: "POST"; body: string; headers: Readonly<Record<string, string>> }>,
): Promise<{ status: number }> {
  const response = await fetch(request.url, { method: "POST", body: request.body, headers: { ...request.headers } });
  return { status: response.status };
}

function resolveDeliverer(explicit?: IntegrationEventV2CallbackDeliverer): IntegrationEventV2CallbackDeliverer {
  if (explicit) return explicit;
  const url = process.env[SCP_INTEGRATION_EVENT_V2_CALLBACK_URL_ENV] ?? "";
  // Only a real https URL activates the transport; a provisioned-but-unbound placeholder secret
  // value (e.g. "unconfigured") stays fail-closed exactly like an absent binding.
  return /^https:\/\//.test(url) ? httpCallbackDeliverer : unconfiguredIntegrationEventV2CallbackDeliverer;
}

// A retryable transport failure (transient); everything else terminal 4xx is dead-lettered.
function classifyDeliveryStatus(status: number): "delivered" | "retry" | "terminal" {
  if (isSuccessfulIntegrationEventV2Status(status)) return "delivered"; // 2xx and not 409
  if (status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600)) return "retry";
  return "terminal";
}

// ---- event builders ---------------------------------------------------------

export function buildVideoReviewStatusChangedEventV2(input: {
  programId: string;
  applicationId: string;
  videoSubmissionId: string;
  youtubeVideoId: string;
  reviewId: string;
  reviewStatus: VideoReviewStatusChangedEventV2["payload"]["reviewStatus"];
  reasonCode?: string;
  campaignId?: string;
  outreachId?: string;
  traceId: `tr_${string}`;
  revision: number;
  occurredAt: string;
}): VideoReviewStatusChangedEventV2 {
  const subject = {
    programId: input.programId,
    applicationId: input.applicationId,
    videoSubmissionId: input.videoSubmissionId,
    youtubeVideoId: input.youtubeVideoId,
    reviewId: input.reviewId,
    ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    ...(input.outreachId ? { outreachId: input.outreachId } : {}),
  };
  return buildIntegrationEventV2({
    occurredAt: input.occurredAt,
    source: "flu",
    eventName: "video.review-status.changed",
    traceId: input.traceId,
    revision: input.revision,
    subject,
    payload: input.reasonCode
      ? { reviewStatus: input.reviewStatus, reasonCode: input.reasonCode }
      : { reviewStatus: input.reviewStatus },
  });
}

export function buildVideoViewSnapshotUpdatedEventV2(input: {
  programId: string;
  applicationId: string;
  videoSubmissionId: string;
  youtubeVideoId: string;
  trackingId: string;
  viewCount: number;
  collectedAt: string;
  reviewStatus: "approved";
  campaignId?: string;
  outreachId?: string;
  traceId: `tr_${string}`;
  revision: number;
  occurredAt: string;
}): VideoViewSnapshotUpdatedEventV2 {
  // Approved-only invariant at the contract boundary: view snapshots only exist for approved review.
  if (input.reviewStatus !== "approved") {
    throw callbackError("view_snapshot_requires_approved", "view snapshots are only emitted for approved review");
  }
  const subject = {
    programId: input.programId,
    applicationId: input.applicationId,
    videoSubmissionId: input.videoSubmissionId,
    youtubeVideoId: input.youtubeVideoId,
    trackingId: input.trackingId,
    ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    ...(input.outreachId ? { outreachId: input.outreachId } : {}),
  };
  return buildIntegrationEventV2({
    occurredAt: input.occurredAt,
    source: "flu",
    eventName: "video.view-snapshot.updated",
    traceId: input.traceId,
    revision: input.revision,
    subject,
    payload: { viewCount: input.viewCount, collectedAt: input.collectedAt, reviewStatus: "approved" },
  });
}

// ---- durable outbox ---------------------------------------------------------

// Idempotent enqueue keyed by deterministic eventId. Re-enqueuing the same event is a no-op; a
// different logical identity under the same eventId can never occur (eventId derives from identity).
export async function enqueueIntegrationEventV2Callback(
  event: IntegrationEventV2,
  now: Date = new Date(),
): Promise<{ enqueued: boolean; eventId: string }> {
  if (event.source !== "flu") throw callbackError("invalid_callback_event", "only flu-sourced events are callbacks");
  const body = integrationEventV2Body(event);
  const ref = adminDb.collection(INTEGRATION_EVENT_V2_CALLBACK_OUTBOX_COLLECTION).doc(event.eventId);
  const nowIso = now.toISOString();
  return adminDb.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (snap.exists) return { enqueued: false, eventId: event.eventId };
    transaction.set(ref, {
      id: event.eventId,
      schemaVersion: SCP_INTEGRATION_EVENT_V2_CONTRACT,
      eventName: event.eventName,
      event,
      body,
      bodySha256: sha256Hex(body),
      identitySha256: computeIdentitySha256(event),
      traceId: event.traceId,
      deliveryState: "queued" satisfies IntegrationEventV2CallbackState,
      attempts: 0,
      leaseExpiresAtIso: null,
      nextAttemptAtIso: nowIso,
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { enqueued: true, eventId: event.eventId };
  });
}

export type DrainIntegrationEventV2CallbacksOptions = {
  batchLimit?: number;
  now?: Date;
  deliverer?: IntegrationEventV2CallbackDeliverer;
  secret?: string;
  previousSecret?: string;
  callbackUrl?: string;
};

export type DrainIntegrationEventV2CallbacksResult = {
  scanned: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  skipped: number;
  results: Array<{ eventId: string; state: IntegrationEventV2CallbackState; code: string; status?: number }>;
};

export async function drainIntegrationEventV2Callbacks(
  options: DrainIntegrationEventV2CallbacksOptions = {},
): Promise<DrainIntegrationEventV2CallbacksResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const deliverer = resolveDeliverer(options.deliverer);
  const batchLimit = Math.min(Math.max(options.batchLimit ?? 10, 1), 25);
  const callbackUrl = options.callbackUrl ?? process.env[SCP_INTEGRATION_EVENT_V2_CALLBACK_URL_ENV] ?? "";
  let keyRing: ReturnType<typeof resolveIntegrationEventV2KeyRing> | null = null;
  try {
    keyRing = resolveIntegrationEventV2KeyRing({ secret: options.secret, previousSecret: options.previousSecret });
  } catch {
    keyRing = null; // secret unconfigured -> treat like fail-closed transport (retryable, never dropped).
  }

  const due = await adminDb.collection(INTEGRATION_EVENT_V2_CALLBACK_OUTBOX_COLLECTION)
    .where("deliveryState", "in", ["queued", "leased", "retryable_failed"])
    .orderBy("nextAttemptAtIso", "asc")
    .limit(batchLimit)
    .get();
  const result: DrainIntegrationEventV2CallbacksResult = {
    scanned: due.size, delivered: 0, retried: 0, deadLettered: 0, skipped: 0, results: [],
  };

  for (const doc of due.docs) {
    const row = doc.data() ?? {};
    if (asString(row.nextAttemptAtIso) > nowIso) { result.skipped += 1; continue; }
    const leaseExpires = asString(row.leaseExpiresAtIso);
    if (asString(row.deliveryState) === "leased" && leaseExpires && leaseExpires > nowIso) { result.skipped += 1; continue; }

    // Acquire a lease atomically (guards against concurrent drains stealing the same row).
    const leased = await adminDb.runTransaction(async (transaction) => {
      const fresh = await transaction.get(doc.ref);
      const data = fresh.data() ?? {};
      const state = asString(data.deliveryState);
      const freshLease = asString(data.leaseExpiresAtIso);
      if (!["queued", "leased", "retryable_failed"].includes(state)) return false;
      if (state === "leased" && freshLease && freshLease > nowIso) return false;
      if (asString(data.nextAttemptAtIso) > nowIso) return false;
      transaction.set(doc.ref, {
        deliveryState: "leased" satisfies IntegrationEventV2CallbackState,
        leaseExpiresAtIso: new Date(now.getTime() + LEASE_MS).toISOString(),
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return true;
    });
    if (!leased) { result.skipped += 1; continue; }

    const attempts = Number(row.attempts ?? 0);
    const event = row.event as IntegrationEventV2;
    try {
      if (!keyRing) throw callbackError("callback_secret_unconfigured", "v2 callback signing secret is not configured");
      if (!/^https:\/\//.test(callbackUrl)) throw callbackError("callback_transport_unconfigured", "Portal callback URL is not configured");
      const request = buildIntegrationEventV2Request(callbackUrl, event, keyRing.current, Math.floor(now.getTime() / 1000));
      const { status } = await deliverer(request);
      const disposition = classifyDeliveryStatus(status);
      if (disposition === "delivered") {
        await doc.ref.set({
          deliveryState: "delivered" satisfies IntegrationEventV2CallbackState,
          attempts: attempts + 1,
          leaseExpiresAtIso: null,
          providerStatus: status,
          lastErrorCode: null,
          deliveredAtIso: nowIso,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        await writeCallbackAudit(doc.id, event, { operation: "callback_delivered", status, attempts: attempts + 1 }, now);
        result.delivered += 1;
        result.results.push({ eventId: doc.id, state: "delivered", code: "", status });
        continue;
      }
      const terminal = disposition === "terminal";
      await applyCallbackFailure(doc, event, attempts, terminal ? "callback_rejected" : "callback_retryable", terminal, now, status);
      if (terminal) { result.deadLettered += 1; result.results.push({ eventId: doc.id, state: "dead_letter", code: "callback_rejected", status }); }
      else { result.retried += 1; result.results.push({ eventId: doc.id, state: "retryable_failed", code: "callback_retryable", status }); }
    } catch (error) {
      const code = asString(asRecord(error).code) || "callback_delivery_failed";
      await applyCallbackFailure(doc, event, attempts, code, false, now);
      result.retried += 1;
      result.results.push({ eventId: doc.id, state: "retryable_failed", code });
    }
  }
  return result;
}

async function applyCallbackFailure(
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  event: IntegrationEventV2,
  attempts: number,
  code: string,
  forceTerminal: boolean,
  now: Date,
  status?: number,
): Promise<void> {
  const nowIso = now.toISOString();
  const nextAttempts = attempts + 1;
  const deadLetter = forceTerminal || nextAttempts >= MAX_DELIVERY_ATTEMPTS;
  const backoffMinutes = RETRY_BACKOFF_MINUTES[Math.min(attempts, RETRY_BACKOFF_MINUTES.length - 1)];
  await doc.ref.set({
    deliveryState: (deadLetter ? "dead_letter" : "retryable_failed") satisfies IntegrationEventV2CallbackState,
    attempts: nextAttempts,
    leaseExpiresAtIso: null,
    lastErrorCode: code,
    providerStatus: status ?? null,
    nextAttemptAtIso: deadLetter ? null : new Date(now.getTime() + backoffMinutes * 60_000).toISOString(),
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await writeCallbackAudit(doc.id, event, {
    operation: deadLetter ? "callback_dead_letter" : "callback_retryable_failed",
    status: status ?? null,
    attempts: nextAttempts,
    errorCode: code,
  }, now);
}

// Hash-only audit: never persists the raw body, only its digests + contract-safe metadata.
async function writeCallbackAudit(
  eventId: string,
  event: IntegrationEventV2,
  fields: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  await adminDb.collection(INTEGRATION_EVENT_V2_CALLBACK_AUDIT_COLLECTION).doc().set({
    eventId,
    eventName: event.eventName,
    traceId: event.traceId,
    identitySha256: computeIdentitySha256(event),
    bodySha256: sha256Hex(integrationEventV2Body(event)),
    ...fields,
    recordedAtIso: nowIso,
    recordedAt: FieldValue.serverTimestamp(),
    expireAt: expireAt180DaysFromIso(nowIso),
  });
}

// ---- review-status reconciler (canonical ledger = scp_video_review_state) ---------------------
//
// W125 근인 (2026-08-24 프로덕션 읽기 전용 실측): 이 리콘실러는 `submissions/{link.fluSubmissionId}`
// 의 `reviewStatus` 를 판정 원장으로 읽고 있었는데, 그 축이 두 겹으로 틀렸다.
//   ① 키가 존재하지 않는다. 링크의 `fluSubmissionId` 는 v2 인입 시점에 합성한
//      `portal:<videoSubmissionId>` 문자열이고(scpIntegrationEventV2.dispatchVideoSubmitted),
//      프로드 링크 182건 전부 `submissions/portal:<id>` 도 `submissions/<id>` 도 부재였다.
//      → 매 사이클 `!submissionSnap.exists` 로 전량 skip, `emitted` 구조적 0 (두 달간 0건 발신).
//   ② 원장 자체가 틀렸다. 영상 판정의 정본은 `submissions.reviewStatus` 가 아니라 canonical
//      리뷰 원장 `scp_video_review_state.state` 다(videoReviewTransitionStore 가 CAS 로 쓴다).
// 조인 키는 링크 문서 id 그 자체다 — 링크는 `subject.videoSubmissionId` 로 찍히고
// (dispatchVideoSubmitted 의 `.doc(subject.videoSubmissionId!)`), 리뷰 원장도 같은
// videoSubmissionId 를 `reviewDocId` 로 살균해 찍는다. 살균 규칙은 원장 소유 모듈에서 import 한다
// (W122 가 videoReviewSubjectShape 로 추출) — 이 사고가 문자열 복제에서 나왔으므로 사본을 두지 않는다.
// 실측: 링크 182건 전부 docId == videoSubmissionId, 그중 181건이 리뷰 원장과 1:1 로 붙었다.
//
// reviewId 정본 (2026-08-24 포털 회신으로 확정): **링크의 `reviewId` 가 유일 정본이다.**
// 포털 인그레스는 형식 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`(언더스코어 허용)만 보고, 살균 여부는
// 보지 않는다. 대신 같은 videoSubmissionId 의 첫 수용 이벤트가 쓴 reviewId 원문을 저장하고 후속에
// 정확 일치를 요구한다(불일치 → review_id_mismatch). 리뷰 원장 문서에도 `reviewId` 필드가 있지만
// (scpIntegrationEventV2:456 은 비살균, scpVideoRevisionIngress:757 은 살균) 인입 경로에 따라 형태가
// 갈릴 수 있어 정본으로 쓰지 않는다 — 두 값을 대조하면 무해한 형태 차이에 fail-closed 로 막힌다.
// ⚠️ 링크의 `reviewId` 를 바꾸는 코드가 생기면 포털의 일관성 계약이 깨진다(발신 이력이 있는 링크는
//    영구히 같은 문자열이어야 한다). 형태는 테스트로 고정돼 있다(w125 pure 테스트).

export const INTEGRATION_EVENT_V2_REVIEW_RECONCILE_SETTINGS_DOC =
  "settings/scp_integration_event_v2_review_reconcile" as const;

/** W127 [적대 리뷰 L4 정정]: scp.integration-event.v2 콜백 파이프라인 **한 사이클**의 주기(분).
 *  ⚠️ 이 한 스케줄이 ①리뷰 콜백 리콘실(reconcileIntegrationEventV2ReviewCallbacks) ②조회수
 *  스냅샷 리콘실(reconcileIntegrationEventV2ViewSnapshotCallbacks) ③아웃박스 배달 드레인
 *  (drainIntegrationEventV2Callbacks)을 **순차로** 돌린다(functions/index.ts
 *  drainScpIntegrationEventV2Callbacks) — 어느 한 레인의 주기가 아니다. 이름을 리뷰 레인 기준으로
 *  붙이면 나중에 "리뷰 주기만 바꾸자"며 건드렸을 때 배달 드레인·스냅샷 레인 주기까지 조용히
 *  같이 바뀐다. 회전시간·capEffective·maxCorpus 세 판정이 전부 이 값에 걸려 있어 사본을 두면
 *  드라이런이 조용히 거짓말한다. 스케줄 문자열도 여기서 조립한다(functions/index.ts 는 이 문자열을
 *  그대로 쓴다). */
export const INTEGRATION_EVENT_V2_CALLBACK_CYCLE_INTERVAL_MINUTES = 5;
export const INTEGRATION_EVENT_V2_CALLBACK_CYCLE_SCHEDULE =
  `every ${INTEGRATION_EVENT_V2_CALLBACK_CYCLE_INTERVAL_MINUTES} minutes` as const;

// 밸브 기본값. 문서 부재 = **닫힘**: 이 리콘실러는 "백로그" 개념이 없어서, 조인 키가 고쳐지는 순간
// 두 달치 판정분이 **다음 회전**에 한꺼번에 나간다. 배포가 곧 백필이 되는 것을 막고 사람이 창을 연다.
// W127: "사이클"이 아니라 "회전"이다 — 스캔은 회전 커서라 전수 1바퀴는 ⌈코퍼스 ÷ scanLimit⌉ 사이클이다.
// 프로드 실측(2026-08-24, 링크 182건): 이 기본값 25 면 8사이클(40분), 현재 설정값 10 이면 19사이클
// (95분)이다. 대응 시간을 "다음 사이클(5분)"로 잡으면 런북 기대치가 한 자릿수 배로 어긋난다.
export const REVIEW_RECONCILE_DEFAULT_SCAN_LIMIT = 25;
export const REVIEW_RECONCILE_MAX_SCAN_LIMIT = 500;
// dead_letter 로 떨어진 발신은 원장 기준으로 재도출하되, 무한 재시도로 revision 을 태우지 않게
// 링크당 회수 횟수를 묶는다. 상한을 넘으면 사람이 볼 수 있게 사유를 남기고 멈춘다.
export const REVIEW_CALLBACK_DEAD_LETTER_RECLAIM_LIMIT = 3;
/**
 * W127: 회수 카운터의 **관측 창**. 이 창 밖의 과거 회수는 세지 않는다.
 *
 * 왜 필요한가: 카운터가 생애 누적이면 서로 다른 시점에 각각 **복구된** 사고 3건만으로 그 링크가
 * 영구 동결된다(`dead_letter_exhausted`). 이 상한은 "지금 계속 실패하고 있으니 멈춰라"는 장치지
 * "이 링크는 과거에 3번 아팠으니 영영 포기하라"는 장치가 아니다 — 후자는 포털 뱃지가 그 제출만
 * 영원히 옛 상태로 굳는다는 뜻이고, 그게 W125 가 끝내려던 그 형상이다.
 *
 * 24시간인 이유: 스케줄은 5분 주기이고 회수는 한 회전에 한 번뿐이므로(아래 회전 커서 주석) 진짜
 * 반복 실패라면 하루 안에 3회가 쌓인다. 그 안에 3회를 못 채웠다면 그건 반복이 아니라 산발이다.
 *
 * `lastReviewCallbackDeadLetterAtIso` 가 없는 과거 행(이 창이 생기기 전에 카운터만 오른 링크)은
 * 창 밖으로 본다 — 한 번은 다시 시도해 보는 쪽이 영구 동결보다 낫고, 그 뒤로는 창이 적용된다.
 */
export const REVIEW_CALLBACK_DEAD_LETTER_RECLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * W127 [적대 리뷰 M6]: 이 창은 **회전 주기와 결합돼 있다** — 무보호로 두면 상한이 사라진다.
 *
 * 한 링크는 커서가 한 바퀴 돌 때마다 최대 한 번 회수된다. 그래서 상한 3회에 도달하려면
 * **3회전이 창 안에** 들어와야 한다. 회전이 길어지면(코퍼스 증가 · scanLimit 축소) 카운터가
 * 3에 닿기 전에 창이 먼저 리셋되고, 그 링크는 영원히 회수·재발신을 반복한다 — 상한이 막으려던
 * 바로 그 형상이다. 런북 자신이 "코퍼스는 계속 늘어난다"고 적고 있으므로 가정이 아니다.
 *
 * 그래서 이 관계를 **드라이런이 매번 판정**한다(scripts/w125-portal-video-review-backfill-dry-run.mjs
 * 의 `deadLetterReclaimWindowVsRotation`): `3 × 회전시간 >= 창` 이면 상한이 무력하다고 경고한다.
 * 회전시간은 코퍼스와 scanLimit 로 정해지는데 리콘실러는 코퍼스 전체를 모르므로(창 단위 스캔),
 * 그 판정은 코퍼스를 세는 쪽에 둔다.
 */
export const REVIEW_CALLBACK_DEAD_LETTER_RECLAIM_MIN_ROTATIONS = 3;

/**
 * 이 링크의 **유효** 회수 횟수. 창 밖의 과거 회수는 0으로 본다.
 *
 * 순수 함수로 떼어 둔 이유: 경계(정확히 창 길이 = 리셋)와 레거시 갈래(시각 필드 부재 + 카운터 상한)는
 * 에뮬레이터 없이도 고정돼야 하는 판정이다.
 */
export function reviewCallbackReclaimAttempts(link: unknown, nowMs: number): number {
  const row = asRecord(link);
  // ⚠️ `Math.max(0, NaN)` 은 NaN 이다 — 오염된 카운터가 NaN 이면 `attempts >= LIMIT` 이 항상 거짓이라
  //   상한이 조용히 사라진다. 유한값이 아니면 0 으로 접는다(모름 = 아직 회수 안 함).
  const raw = Math.trunc(Number(row.reviewCallbackDeadLetterCount ?? 0));
  const recorded = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const lastAtMs = Date.parse(asString(row.lastReviewCallbackDeadLetterAtIso));
  const withinWindow = Number.isFinite(lastAtMs)
    && nowMs - lastAtMs < REVIEW_CALLBACK_DEAD_LETTER_RECLAIM_WINDOW_MS;
  return withinWindow ? recorded : 0;
}

export type IntegrationEventV2ReviewReconcileGate = {
  enabled: boolean;
  scanLimit: number;
  cursor: string | null;
};

// 런타임 밸브. env 가 아니라 settings 문서인 이유: 사고 중에 끄는 데 재배포가 필요하면 안 된다
// (videoReviewTransitionStore.readVideoResultMailRolloutGate 와 같은 관례).
export async function readIntegrationEventV2ReviewReconcileGate(
  db: FirebaseFirestore.Firestore = adminDb,
): Promise<IntegrationEventV2ReviewReconcileGate> {
  const [collection, docId] = INTEGRATION_EVENT_V2_REVIEW_RECONCILE_SETTINGS_DOC.split("/");
  const snapshot = await db.collection(collection).doc(docId).get().catch(() => null);
  const data = snapshot?.exists ? snapshot.data() ?? {} : {};
  const rawLimit = Math.trunc(Number(data.scanLimit));
  return {
    // 명시적 true 일 때만 열린다(부재·오타·null 전부 닫힘) — 롤아웃 게이트와 반대 방향의 기본값이다.
    enabled: data.enabled === true,
    scanLimit: Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(rawLimit, REVIEW_RECONCILE_MAX_SCAN_LIMIT)
      : REVIEW_RECONCILE_DEFAULT_SCAN_LIMIT,
    cursor: asString(data.cursor) || null,
  };
}

export type IntegrationEventV2ContractReviewStatus =
  VideoReviewStatusChangedEventV2["payload"]["reviewStatus"];

// Flu 원장 상태축(videoReviewTransitionCore.VideoReviewState, 6종) → v2 계약 상태축
// (integrationEventV2.VideoReviewStatusChangedEventV2.payload.reviewStatus, 4종) 전수 매핑.
// 미판정 내부 상태(queued / in_review / human_review_required)는 전부 "pending" 으로 접는다 —
// Portal 은 "심사 대기" 만 알면 되고, 어느 내부 레인에 있는지는 운영 정보라 계약 밖이다(P0: 내부
// 심사 경로·모델 판단을 크리에이터 면에 노출하지 않는다).
// 알 수 없는 상태값은 null(fail-closed): "pending" 으로 접어 잘못된 계약 이벤트를 쏘느니 skip 한다.
export function mapReviewStateToContractStatus(
  rawState: string,
): IntegrationEventV2ContractReviewStatus | null {
  // 레거시 호환(pending→queued, needs_review→human_review_required)은 원장 정의를 그대로 쓰되,
  // normalizeLegacyReviewState 는 미지의 값도 "queued" 로 접기 때문에 소속 검사를 먼저 한다.
  const known =
    (VIDEO_REVIEW_STATES as readonly string[]).includes(rawState) ||
    rawState === "pending" ||
    rawState === "needs_review";
  if (!known) return null;
  switch (normalizeLegacyReviewState(rawState)) {
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "changes_requested":
      return "changes_requested";
    case "queued":
    case "in_review":
    case "human_review_required":
      return "pending";
  }
}

export type IntegrationEventV2ReviewCallbackSkipReason =
  // 리콘실러에서는 도달 불가(문서 id 가 곧 videoSubmissionId 라 빈 값이 없다). 판정부를 직접 부르는
  // 드라이런/테스트를 위한 계약 조항으로 남긴다.
  | "link_video_submission_id_missing"
  | "review_state_missing"
  | "review_state_unmappable"
  | "already_emitted";

export type IntegrationEventV2ReviewCallbackPlan =
  | {
      emit: true;
      contractStatus: IntegrationEventV2ContractReviewStatus;
      videoSubmissionId: string;
      reviewId: string;
      revision: number;
    }
  | { emit: false; reason: IntegrationEventV2ReviewCallbackSkipReason };

// 순수 판정부: 링크 1건 + 그 리뷰 원장 1건 → 발신 여부/내용. I/O 없음(드라이런이 프로덕션 경로와
// 같은 규칙을 쓰게 하려고 분리했다 — 백필 수치가 실제 발신과 어긋나면 안 된다).
export function planIntegrationEventV2ReviewCallback(input: {
  linkId: string;
  link: Record<string, unknown>;
  reviewState: Record<string, unknown> | null;
}): IntegrationEventV2ReviewCallbackPlan {
  const videoSubmissionId = asString(input.link.videoSubmissionId) || input.linkId;
  if (!videoSubmissionId) return { emit: false, reason: "link_video_submission_id_missing" };
  if (!input.reviewState) return { emit: false, reason: "review_state_missing" };
  const contractStatus = mapReviewStateToContractStatus(asString(input.reviewState.state));
  if (!contractStatus) return { emit: false, reason: "review_state_unmappable" };
  // 링크가 유일 정본이다(위 헤더의 reviewId 절 참조). 링크에 값이 없을 때만 원장 관례로 유도한다.
  const reviewId = asString(input.link.reviewId) || `review_${videoSubmissionId}`;
  if (asString(input.link.lastReviewStatusEmitted) === contractStatus) {
    return { emit: false, reason: "already_emitted" };
  }
  // revision 은 subject 당 단조 증가여야 한다(같거나 낮은 revision 은 수신 측에서
  // revision_not_monotonic). 링크에 적힌 "다음 revision" 을 존중하되, 백필이 역행시키지 못하도록
  // 하한 1 로 바닥을 깐다(부재/NaN/0/음수 → 1).
  const storedRevision = Math.trunc(Number(input.link.reviewCallbackRevision));
  const revision = Number.isFinite(storedRevision) && storedRevision >= 1 ? storedRevision : 1;
  return { emit: true, contractStatus, videoSubmissionId, reviewId, revision };
}

export type ReconcileIntegrationEventV2ReviewCallbacksResult = {
  enabled: boolean;
  scanLimit: number;
  scanned: number;
  emitted: number;
  duplicateSuppressed: number;
  deadLetterReclaimed: number;
  skipped: number;
  emittedByStatus: Record<string, number>;
  skippedByReason: Record<string, number>;
  cursorWrapped: boolean;
  nextCursor: string | null;
};

const EMPTY_RECONCILE_RESULT = (
  gate: IntegrationEventV2ReviewReconcileGate,
): ReconcileIntegrationEventV2ReviewCallbacksResult => ({
  enabled: gate.enabled,
  scanLimit: gate.scanLimit,
  scanned: 0,
  emitted: 0,
  duplicateSuppressed: 0,
  deadLetterReclaimed: 0,
  skipped: 0,
  emittedByStatus: {},
  skippedByReason: {},
  cursorWrapped: false,
  nextCursor: gate.cursor,
});

async function getAllChunked(
  refs: FirebaseFirestore.DocumentReference[],
): Promise<FirebaseFirestore.DocumentSnapshot[]> {
  const out: FirebaseFirestore.DocumentSnapshot[] = [];
  // 순차 단건 get 은 링크 수만큼 왕복해서 스케줄 예산(120초)을 태운다 — 창이 커질수록 먼저 터진다.
  for (let index = 0; index < refs.length; index += 100) {
    const chunk = refs.slice(index, index + 100);
    if (chunk.length === 0) continue;
    out.push(...(await adminDb.getAll(...chunk)));
  }
  return out;
}

// Trigger reconciler (TASK 6/7): scans v2 video links, projects the canonical review ledger state
// onto the contract status axis, and enqueues a signed video.review-status.changed callback
// (monotonic revision per subject). Idempotent: re-emits only when the contract status actually
// changes, so a re-run is a no-op. reasonCode is omitted to avoid leaking operator notes / model
// reasoning. skip 은 사유별로 센다 — W125 가 두 달간 안 보인 이유가 "skip 만 세고 사유가 없어서" 다.
//
// 스캔은 문서 id 순 **회전 커서**다. `.limit()` 만 두면 매 사이클 같은 앞 N 건만 보게 되고, 링크가
// 창보다 많아지는 순간 그 뒤 제출은 영원히 리콘실되지 않으면서 로그는 `emitted:0, skipped:N` 으로
// 건강해 보인다 — W125 가 끝내려던 바로 그 관측 실패다.
export async function reconcileIntegrationEventV2ReviewCallbacks(opts: {
  now?: Date;
  /**
   * 밸브를 읽지 않고 주입한다(테스트·도구 경로).
   *
   * ⚠️ W127: 주입해도 **커서는 실제 settings 문서에 쓴다**(아래 마지막 블록). 게이트 주입은 "이
   * 회차가 무엇을 볼지"만 바꾸는 것이지 드라이런 스위치가 아니다 — 주입 호출로 회차를 한 번 돌리면
   * 프로드 커서가 그만큼 전진해 스케줄 회차가 그 구간을 건너뛴다. 읽기만 하고 싶으면 이 함수가
   * 아니라 `scripts/w125-portal-video-review-backfill-dry-run.mjs` 를 쓴다(쓰기 0).
   */
  gate?: IntegrationEventV2ReviewReconcileGate;
} = {}): Promise<ReconcileIntegrationEventV2ReviewCallbacksResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const gate = opts.gate ?? await readIntegrationEventV2ReviewReconcileGate();
  if (!gate.enabled) return EMPTY_RECONCILE_RESULT(gate);

  const linksCollection = adminDb.collection(INTEGRATION_EVENT_V2_VIDEO_LINKS_COLLECTION);
  const scanFrom = async (cursor: string | null): Promise<FirebaseFirestore.QuerySnapshot> => {
    let query = linksCollection.orderBy(FieldPath.documentId()).limit(gate.scanLimit);
    if (cursor) query = query.startAfter(linksCollection.doc(cursor));
    return query.get();
  };
  let links = await scanFrom(gate.cursor);
  let cursorWrapped = false;
  if (links.empty && gate.cursor) {
    // 창 끝에 도달했다 — 처음으로 되감아 다음 사이클이 다시 전수를 돈다.
    cursorWrapped = true;
    links = await scanFrom(null);
  }

  const result: ReconcileIntegrationEventV2ReviewCallbacksResult = {
    ...EMPTY_RECONCILE_RESULT(gate),
    scanned: links.size,
    cursorWrapped,
  };
  const countSkip = (reason: string): void => {
    result.skippedByReason[reason] = (result.skippedByReason[reason] ?? 0) + 1;
    result.skipped += 1;
  };

  const rows = links.docs.map((doc) => {
    const link = doc.data() ?? {};
    return { doc, link, videoSubmissionId: asString(link.videoSubmissionId) || doc.id };
  });
  const stateSnaps = await getAllChunked(
    rows.map((row) => adminDb.collection(SCP_VIDEO_REVIEW_STATE_COLLECTION).doc(reviewDocId(row.videoSubmissionId))),
  );
  const plans = rows.map((row, index) => ({
    ...row,
    plan: planIntegrationEventV2ReviewCallback({
      linkId: row.doc.id,
      link: row.link,
      reviewState: stateSnaps[index]?.exists ? (stateSnaps[index].data() ?? {}) : null,
    }),
  }));

  // dead_letter 회수: `already_emitted` 로 접히는 링크의 in-flight 이벤트가 dead_letter 면 그 발신은
  // 영구 유실이다(드레인 due 쿼리가 dead_letter 를 다시 집지 않고, 링크 원장은 이미 발신했다고
  // 기록돼 있다). 링크의 발신 기록을 지워 **다음 회전**이 더 높은 revision 으로 재도출하게 한다.
  // W127: 사이클이 아니라 회전이다 — 이 링크가 다시 스캔 창에 들어오는 것은 커서가 한 바퀴 돈 뒤라
  //   ⌈코퍼스 ÷ scanLimit⌉ 사이클 뒤다(프로드 실측 182링크 기준 8~19사이클 = 40~95분). 즉시가 아니다.
  const reclaimCandidates = plans.filter(
    (row) => !row.plan.emit && row.plan.reason === "already_emitted" && asString(row.link.lastReviewCallbackEventId),
  );
  const outboxSnaps = await getAllChunked(
    reclaimCandidates.map((row) =>
      adminDb.collection(INTEGRATION_EVENT_V2_CALLBACK_OUTBOX_COLLECTION).doc(asString(row.link.lastReviewCallbackEventId))),
  );
  const reclaimed = new Set<string>();
  for (const [index, row] of reclaimCandidates.entries()) {
    const snap = outboxSnaps[index];
    if (!snap?.exists || asString(snap.data()?.deliveryState) !== "dead_letter") continue;
    // W127: 상한은 **최근 24시간의 반복 실패**에만 건다. 창 밖이면 카운터를 0 부터 다시 센다 —
    //   각각 복구된 산발 사고 3건으로 링크가 영구 동결되면 그 제출의 포털 뱃지는 영영 안 고쳐진다.
    //   그 창이 회전 주기와 어긋나면 상한 자체가 무력해진다(위 MIN_ROTATIONS 주석 · 드라이런이 판정).
    const attempts = reviewCallbackReclaimAttempts(row.link, now.getTime());
    if (attempts >= REVIEW_CALLBACK_DEAD_LETTER_RECLAIM_LIMIT) {
      // 사람이 봐야 한다. 조용히 성공처럼 보이지 않게 사유를 남기고 멈춘다.
      countSkip("dead_letter_exhausted");
      reclaimed.add(row.doc.id);
      continue;
    }
    await row.doc.ref.set({
      lastReviewStatusEmitted: FieldValue.delete(),
      lastReviewCallbackEventId: FieldValue.delete(),
      reviewCallbackDeadLetterCount: attempts + 1,
      lastReviewCallbackDeadLetterAtIso: nowIso,
      updatedAtIso: nowIso,
    }, { merge: true });
    result.deadLetterReclaimed += 1;
    countSkip("dead_letter_reclaimed");
    reclaimed.add(row.doc.id);
  }

  for (const row of plans) {
    if (reclaimed.has(row.doc.id)) continue;
    if (!row.plan.emit) { countSkip(row.plan.reason); continue; }
    const plan = row.plan;
    let event: VideoReviewStatusChangedEventV2;
    try {
      event = buildVideoReviewStatusChangedEventV2({
        programId: asString(row.link.programId),
        applicationId: asString(row.link.applicationId),
        videoSubmissionId: plan.videoSubmissionId,
        youtubeVideoId: asString(row.link.youtubeVideoId),
        reviewId: plan.reviewId,
        reviewStatus: plan.contractStatus,
        ...(asString(row.link.campaignId) ? { campaignId: asString(row.link.campaignId) } : {}),
        ...(asString(row.link.outreachId) ? { outreachId: asString(row.link.outreachId) } : {}),
        traceId: asString(row.link.traceId) as `tr_${string}`,
        revision: plan.revision,
        occurredAt: nowIso,
      });
    } catch (error) {
      // 계약 위반(예: traceId 형식 붕괴)만 여기서 격리한다. Firestore 오류까지 함께 삼키면
      // 인프라 장애가 `event_build_failed` 로 위장돼 사이클이 정상 반환한다.
      countSkip(`event_build_failed:${asString(asRecord(error).code) || "unknown"}`);
      continue;
    }
    // enqueue / write-back 오류는 전파한다 — eventId 가 결정적이고 enqueue 가 doc(eventId) 트랜잭션이라
    // 중간에 끊겨도 **다음 회전**이 중복 없이 자가 치유한다(그 링크를 다시 보는 것은 커서가 한
    // 바퀴 돈 뒤다 — 위 회전 커서 주석). 삼키면 인프라 장애가 안 보인다.
    const { enqueued } = await enqueueIntegrationEventV2Callback(event, now);
    await row.doc.ref.set({
      lastReviewStatusEmitted: plan.contractStatus,
      // 실제로 실어 보낸 subject 신원·이벤트·시각을 링크에 남긴다. eventId 는 dead_letter 회수의
      // 조인 키이고, `updatedAtIso` 는 인입 경로도 같이 써서 "이 레인의 마지막 발신"을 못 가리킨다.
      lastReviewCallbackReviewId: plan.reviewId,
      lastReviewCallbackEventId: event.eventId,
      lastReviewCallbackEmittedAtIso: nowIso,
      reviewCallbackRevision: plan.revision + 1,
      updatedAtIso: nowIso,
    }, { merge: true });
    if (enqueued) {
      result.emittedByStatus[plan.contractStatus] = (result.emittedByStatus[plan.contractStatus] ?? 0) + 1;
      result.emitted += 1;
    } else {
      // 같은 eventId 가 이미 아웃박스에 있다(직전 사이클의 중단 복구). 발신 지표에 섞지 않는다.
      result.duplicateSuppressed += 1;
    }
  }

  result.nextCursor = links.empty ? null : links.docs[links.docs.length - 1].id;
  // ⚠️ W127: `opts.gate` 로 밸브를 주입한 호출도 여기 도달한다 — 커서는 언제나 **실제** settings
  //   문서에 쓴다. 회전 커서가 프로세스마다 갈리면 같은 구간이 두 번 돌거나 한 구간이 통째로
  //   건너뛰어지므로, 커서만은 단일 정본이어야 한다. 부수효과 없는 관측은 드라이런 스크립트로 한다.
  const [settingsCollection, settingsDoc] = INTEGRATION_EVENT_V2_REVIEW_RECONCILE_SETTINGS_DOC.split("/");
  await adminDb.collection(settingsCollection).doc(settingsDoc).set({
    cursor: result.nextCursor,
    lastRunAtIso: nowIso,
  }, { merge: true });
  return result;
}

// ⚠ W125 미수리 잔여: 아래 스냅샷 리콘실러는 approved 판정을 여전히 `submissions/{fluSubmissionId}`
// 로 확인한다 — 위에서 고친 것과 **같은 조인 키 결함**이라, 이 레인도 구조적으로 전량 skip 중이다
// (프로드 실측 2026-08-24: 해당 키의 submissions 문서 182건 전부 부재). W125 는 심사 뱃지(리뷰 상태)
// 복구로 범위를 한정했고, 조회수 스냅샷 레인은 발신 모수·영향이 달라 별건으로 남긴다. 고칠 때는 위와
// 같이 `scp_video_review_state` 의 state === "approved" 를 정본으로 읽어야 한다.
// ⚠️ 이 조인 키 결함은 이 커밋에서도 그대로 둔다 — 아래 변경은 비용/커버리지 형상만 고친다. 같은 이유로
// submissionSnap 조회 자체를 "항상 실패하니 없애자"고 지우지 않는다 — 조인 키가 고쳐지는 순간 이
// 조회가 다시 유의미해진다(그때 fail-open 으로 새는 코드가 있으면 안 된다).
//
// Trigger reconciler (TASK 6/7/8): for APPROVED v2-linked submissions only, read the current view
// projection (video_view_series/{youtubeVideoId}) and enqueue a signed video.view-snapshot.updated
// callback when a new snapshot has landed. Approved-only is enforced twice: the submission must be
// approved AND the contract payload.reviewStatus is const "approved". Idempotent by collectedAt.
//
// COST (2026-09-27 비용 감사): 고정 창(무-orderBy `.limit(200)`)이 항상 **문서 순서상 앞쪽 링크만**
// 스캔했다 — 프로드 실측 코퍼스 354건 기준 뒤쪽 154건은 이 레인에 영원히 안 닿는다(위 리뷰
// 리콘실러가 W125 에서 이미 겪은 것과 같은 종류의 창 정체). 게다가 매 5분 틱이 **같은** 앞쪽 200건을
// submissionSnap/seriesSnap 까지 다시 읽어 하루 최대 ~115K read 를 태웠다(구조적으로 전량 skip 인
// submissionSnap 조회 포함). 위 리뷰 리콘실러가 쓰는 것과 **같은 회전 커서**(orderBy(documentId())
// + startAfter + 끝에서 처음으로 wrap)를 이 컬렉션(같은 INTEGRATION_EVENT_V2_VIDEO_LINKS_COLLECTION)
// 에 적용한다 — 창 밖 154건도 결국 방문되고, 이미 처리한 창을 매 틱 재방문하지 않는다.
// 게이트는 리뷰 리콘실러와 **반대 기본값**이다: 이 레인은 지금 항상 켜져 있었으므로(게이트 자체가
// 없었다) 문서 부재 = **열림**으로 시작해 이 리팩터가 배포와 동시에 레인을 끄지 않는다. 필요하면
// `settings/scp_integration_event_v2_view_snapshot_reconcile` 에 `enabled:false` 를 써서 끌 수 있다.
export const INTEGRATION_EVENT_V2_VIEW_SNAPSHOT_RECONCILE_SETTINGS_DOC =
  "settings/scp_integration_event_v2_view_snapshot_reconcile" as const;
// 적대 리뷰(2026-09-27): 리뷰 리콘실러의 기본값(25)을 그대로 가져오면 프로드 실측 코퍼스 354건
// 기준 한 링크가 ~75분(354÷25 창 × 5분)에 한 번만 재방문된다. 이 레인은 조회수 스냅샷의 **최신
// updatedAtIso 한 값만** 비교하는 구조라(중간 이력을 안 남긴다) 승인 후 24h 이내 적응형 수집 주기
// (15분, videoViewSnapshotAdaptiveIntervalMs)보다 재방문 간격이 길어지면 그 사이 갱신된 조회수가
// 콜백 없이 스킵된다 — 창을 줄인 것 자체가 커버리지 회귀다. 원래 이 함수의 기본 스캔폭은 200
// 이었다(회전 커서가 없던 시절부터) — 그 값을 그대로 유지해 회전 커서 도입 전과 **같은 재방문
// 간격**(354÷200 ≈ 2창 × 5분 ≈ 10분)을 지킨다. 비용 절감은 창 크기가 아니라 회전 커서 자체(같은
// 200건을 매틱 재읽기 vs 전체 354건을 10분마다 한 바퀴) 에서 나온다 — 리뷰 리콘실러와 굳이 같은
// 상수를 쓸 이유가 없다(코퍼스 크기·수집 주기가 다르다).
export const VIEW_SNAPSHOT_RECONCILE_DEFAULT_SCAN_LIMIT = 200;
export const VIEW_SNAPSHOT_RECONCILE_MAX_SCAN_LIMIT = REVIEW_RECONCILE_MAX_SCAN_LIMIT;

export type IntegrationEventV2ViewSnapshotReconcileGate = {
  enabled: boolean;
  scanLimit: number;
  cursor: string | null;
};

export async function readIntegrationEventV2ViewSnapshotReconcileGate(
  db: FirebaseFirestore.Firestore = adminDb,
): Promise<IntegrationEventV2ViewSnapshotReconcileGate> {
  const [collection, docId] = INTEGRATION_EVENT_V2_VIEW_SNAPSHOT_RECONCILE_SETTINGS_DOC.split("/");
  // 적대 리뷰(2026-09-27): "문서 부재 = 열림"과 "읽기 실패도 조용히 null 로 접어 부재처럼 다룬다"를
  // 합치면, 운영자가 enabled:false 로 꺼 둔 상태에서 일시적 Firestore 읽기 장애가 터지면 그 틱만
  // 조용히 다시 열린다 — 리뷰 리콘실러(반대 극성: 부재=닫힘)에서는 무해했던 바로 그 catch 가 여기서는
  // 위험하다. 그래서 "진짜 부재"(exists:false)와 "읽기 자체가 실패"를 구분한다 — 후자는 열지 않고
  // **닫힘**으로 fail-safe 한다(무음 재개보다 무음 정지가 안전한 방향).
  let readFailed = false;
  const snapshot = await db.collection(collection).doc(docId).get().catch((error: unknown) => {
    readFailed = true;
    console.warn("[integration-event-v2-view-snapshot-reconcile] gate read failed — defaulting closed this tick", {
      errorCode: (error as { code?: unknown } | null)?.code ?? "unknown",
    });
    return null;
  });
  const data = snapshot?.exists ? snapshot.data() ?? {} : {};
  const rawLimit = Math.trunc(Number(data.scanLimit));
  return {
    // 리뷰 리콘실러와 반대 극성: 문서 부재/오타 = **열림**(이 레인은 게이트 신설 전부터 항상 켜져
    // 있었다 — 부재를 닫힘으로 두면 이 리팩터 배포 자체가 무음 정지가 된다). 끄려면 명시적 false.
    // 읽기 실패는 부재가 아니다 — 위 주석대로 이 경우만 닫힘으로 fail-safe 한다.
    enabled: readFailed ? false : data.enabled !== false,
    scanLimit: Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(rawLimit, VIEW_SNAPSHOT_RECONCILE_MAX_SCAN_LIMIT)
      : VIEW_SNAPSHOT_RECONCILE_DEFAULT_SCAN_LIMIT,
    cursor: asString(data.cursor) || null,
  };
}

export type ReconcileIntegrationEventV2ViewSnapshotCallbacksResult = {
  enabled: boolean;
  scanLimit: number;
  scanned: number;
  emitted: number;
  skipped: number;
  cursorWrapped: boolean;
  nextCursor: string | null;
};

export async function reconcileIntegrationEventV2ViewSnapshotCallbacks(opts: {
  now?: Date;
  scanLimit?: number;
  gate?: IntegrationEventV2ViewSnapshotReconcileGate;
} = {}): Promise<ReconcileIntegrationEventV2ViewSnapshotCallbacksResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const gate = opts.gate ?? await readIntegrationEventV2ViewSnapshotReconcileGate();
  const scanLimit = opts.scanLimit !== undefined
    ? Math.min(Math.max(Math.trunc(opts.scanLimit), 1), VIEW_SNAPSHOT_RECONCILE_MAX_SCAN_LIMIT)
    : gate.scanLimit;
  const empty = (cursorWrapped: boolean): ReconcileIntegrationEventV2ViewSnapshotCallbacksResult => ({
    enabled: gate.enabled, scanLimit, scanned: 0, emitted: 0, skipped: 0, cursorWrapped, nextCursor: gate.cursor,
  });
  if (!gate.enabled) return empty(false);

  const linksCollection = adminDb.collection(INTEGRATION_EVENT_V2_VIDEO_LINKS_COLLECTION);
  const scanFrom = async (cursor: string | null): Promise<FirebaseFirestore.QuerySnapshot> => {
    let query = linksCollection.orderBy(FieldPath.documentId()).limit(scanLimit);
    if (cursor) query = query.startAfter(linksCollection.doc(cursor));
    return query.get();
  };
  let links = await scanFrom(gate.cursor);
  let cursorWrapped = false;
  if (links.empty && gate.cursor) {
    // 창 끝에 도달했다 — 처음으로 되감아 다음 사이클이 다시 전수를 돈다(리뷰 리콘실러와 동형).
    cursorWrapped = true;
    links = await scanFrom(null);
  }
  if (links.empty) return empty(cursorWrapped);

  const rows = links.docs.map((doc) => {
    const link = doc.data() ?? {};
    return {
      doc,
      link,
      fluSubmissionId: asString(link.fluSubmissionId),
      youtubeVideoId: asString(link.youtubeVideoId),
    };
  });

  // 두 단건 조회(submission·series)를 doc 별로 순차 await 하지 않고 배치로 당긴다 — 왕복 수는
  // 그대로지만(같은 read 과금) 벽시계 지연이 창 크기에 비례해 쌓이지 않는다(리뷰 리콘실러의
  // getAllChunked 와 동형). fluSubmissionId/youtubeVideoId 가 없는 행은 애초에 조회 대상이 아니다.
  const lookupRows = rows.filter((row) => row.fluSubmissionId && row.youtubeVideoId);
  const submissionSnaps = await getAllChunked(
    lookupRows.map((row) => adminDb.collection("submissions").doc(row.fluSubmissionId)),
  );
  const approvedRows = lookupRows.filter((_row, index) =>
    submissionSnaps[index]?.exists && asString(submissionSnaps[index].data()?.reviewStatus) === "approved");
  const seriesSnaps = await getAllChunked(
    approvedRows.map((row) => adminDb.collection("video_view_series").doc(row.youtubeVideoId)),
  );
  const seriesByVideoId = new Map(approvedRows.map((row, index) => [row.youtubeVideoId, seriesSnaps[index]]));

  let emitted = 0;
  let skipped = 0;
  const approvedIds = new Set(approvedRows.map((row) => row.doc.id));
  for (const row of rows) {
    const { doc, link, youtubeVideoId } = row;
    if (!row.fluSubmissionId || !youtubeVideoId || !approvedIds.has(doc.id)) { skipped += 1; continue; }
    const seriesSnap = seriesByVideoId.get(youtubeVideoId);
    if (!seriesSnap?.exists) { skipped += 1; continue; }
    const series = seriesSnap.data() ?? {};
    const collectedAt = asString(series.updatedAtIso);
    const viewCount = Number(series.totalViews ?? 0);
    if (!collectedAt || !Number.isFinite(viewCount)) { skipped += 1; continue; }
    if (asString(link.lastViewSnapshotCollectedAt) === collectedAt) { skipped += 1; continue; }
    const revision = Number(link.snapshotCallbackRevision ?? 1);
    const event = buildVideoViewSnapshotUpdatedEventV2({
      programId: asString(link.programId),
      applicationId: asString(link.applicationId),
      videoSubmissionId: asString(link.videoSubmissionId),
      youtubeVideoId,
      trackingId: asString(link.trackingId) || `tracking_${asString(link.videoSubmissionId)}`,
      viewCount: Math.max(0, Math.trunc(viewCount)),
      collectedAt,
      reviewStatus: "approved",
      ...(asString(link.campaignId) ? { campaignId: asString(link.campaignId) } : {}),
      ...(asString(link.outreachId) ? { outreachId: asString(link.outreachId) } : {}),
      traceId: asString(link.traceId) as `tr_${string}`,
      revision,
      occurredAt: nowIso,
    });
    await enqueueIntegrationEventV2Callback(event, now);
    await doc.ref.set({
      lastViewSnapshotCollectedAt: collectedAt,
      lastViewSnapshotCount: viewCount,
      snapshotCallbackRevision: revision + 1,
      updatedAtIso: nowIso,
    }, { merge: true });
    emitted += 1;
  }

  // 적대 리뷰(2026-09-27, 3차): 회전 주기가 코퍼스 크기에 비례해 길어진다 — 링크가 늘면
  // (scanLimit 대비) 한 링크의 재방문 간격도 늘어나, 승인 후 24h 이내 적응형 수집 주기(15분,
  // videoViewSnapshots.ts videoViewSnapshotAdaptiveIntervalMs)보다 길어지면 이 레인이 **최신값만
  // 비교**하는 구조상 그 사이 중간 스냅샷이 콜백 없이 조용히 스킵될 수 있다. 코드로 막지는 않는다
  // (히스토리 소비로 바꾸는 건 계약 형태를 건드리는 별도 설계 결정) — 대신 기준을 넘으면 즉시
  // 보이게 경고한다. count() 는 문서를 안 내려받아 이 관측 자체의 비용은 무시할 만하다.
  const ADAPTIVE_MIN_CADENCE_MINUTES = 15;
  const corpusCount = await linksCollection.count().get();
  const corpusSize = Math.max(0, Math.round(corpusCount.data().count ?? 0));
  const rotationMinutes = corpusSize > 0
    ? Math.ceil(corpusSize / scanLimit) * INTEGRATION_EVENT_V2_CALLBACK_CYCLE_INTERVAL_MINUTES
    : 0;
  if (rotationMinutes > ADAPTIVE_MIN_CADENCE_MINUTES) {
    console.warn("[integration-event-v2-view-snapshot-reconcile] rotation period exceeds the 15-minute adaptive snapshot cadence — intermediate snapshots between visits can be silently skipped", {
      corpusSize, scanLimit, rotationMinutes,
    });
  }

  const nextCursor = links.empty ? null : links.docs[links.docs.length - 1].id;
  const [settingsCollection, settingsDoc] = INTEGRATION_EVENT_V2_VIEW_SNAPSHOT_RECONCILE_SETTINGS_DOC.split("/");
  await adminDb.collection(settingsCollection).doc(settingsDoc).set({
    cursor: nextCursor,
    lastRunAtIso: nowIso,
  }, { merge: true });

  return { enabled: gate.enabled, scanLimit, scanned: links.size, emitted, skipped, cursorWrapped, nextCursor };
}
