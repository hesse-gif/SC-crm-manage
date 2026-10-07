// Flu-owned mail DRAIN workers (v2 handoff §3 onboarding send / §4 video-result mail). NEW FILE ONLY.
//
// Both workers compose EXISTING infrastructure — they never clone a renderer, a suppression check,
// or a transport:
//   - §3 onboarding: the durable state machine in ./onboardingOutboxStore + ./onboardingOutboxCore
//     (managed-gate, idempotent send-generation, retry/backoff/dead-letter via planOnboardingSend).
//     RENDER reuses the campaign composer prepareScpResultMail (./scpMail) in its side-effect-free
//     draft_only+dryRun preview branch — this file never re-implements template resolution.
//   - §4 video-result mail: the durable outbox in ./videoReviewTransitionStore
//     (scp_video_result_mail_outbox), drained with the SAME lease/backoff/dead-letter shape as the
//     proven ./scpVideoReviewV3Callbacks drain (queued/leased/retryable_failed, lease TTL, exponential
//     backoff, terminal dead-letter). Recipient email for BOTH workers is resolved through the
//     deployed signed material contracts. Immediate Apply/content receipts use the exact accepted
//     event-bound receipt-material endpoint; older onboarding/result mail keeps its existing v1/v3
//     material lookup.
//   - The actual SEND (both workers) delegates to the exported chat-ai.ts `sendEmail` — the identical
//     transport prepareScpResultMail itself calls for a real result-mail send — so mailProfiles/
//     mailSuppression/mailSafetyPolicy/mailOutboundSafety/mailHumanGate all run unmodified. The provider
//     outcome is classified with the reused `classifyScpResultMailDelivery` (./scpMail) so "sent" here
//     means the exact same provider-confirmed truth the result-mail ledger uses (never `ok:true` alone).
//
// FAIL-CLOSED, always:
//   - `liveIntegrationsEnabled("smtp")` gates every real send; FUNCTIONS_EMULATOR=true forces it false
//     unconditionally (./liveIntegrations), so no test in this repo can ever emit real mail.
//   - The Portal MATERIAL fetch never throws — fetchCreatorPipelineV3OnboardingMaterial itself is
//     fail-closed to `null` whenever the material ring secret/base-URL are unbound, the binding is
//     unresolved, or the request fails. Until Portal binds, EVERY row is skipped, never consumed.
//   - A receipt-material read failure becomes explicit recipient_pending without consuming a provider
//     attempt. The raw address stays in memory only; its hash pins the recipient across retries and a
//     changed Portal address fails closed instead of silently redirecting an accepted event.
//   - Only a genuine transport failure consumes a provider attempt and can advance retry -> dead_letter.
//     Raw provider ids and full private mail bodies are never persisted.
import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  asRecord,
  asString,
  maskEmail,
  type AuthContext,
  type CallableRequestShape,
} from "./shared";
import { liveIntegrationsEnabled } from "./liveIntegrations";
import { evaluateE2eMailFence, readE2eMailFenceConfig } from "./e2eMailFence";
import { readReceiptMailGoLiveConfig, receiptMailGoLiveAllows } from "./receiptMailGoLive";
import {
  ONBOARDING_OUTBOX_COLLECTION,
  planOnboardingSend,
  type OnboardingOutboxState,
} from "./onboardingOutboxCore";
import { markOnboardingSent, markOnboardingFailed } from "./onboardingOutboxStore";
import type { AttributionClassification } from "./applicationManagementAttributionCore";
import {
  SCP_VIDEO_RESULT_MAIL_OUTBOX_COLLECTION,
  SCP_VIDEO_REVIEW_STATE_COLLECTION,
} from "./videoReviewTransitionStore";
import type { VideoReviewMailKind } from "./videoReviewTransitionCore";
import {
  SCP_APPLICATION_CONFIRMED_MAIL_OUTBOX_COLLECTION,
  SCP_CONTENT_SUBMITTED_MAIL_OUTBOX_COLLECTION,
  SCP_LOGIN_APPROVED_MAIL_OUTBOX_COLLECTION,
  SCP_LOGIN_REJECTED_MAIL_OUTBOX_COLLECTION,
  SCP_RECEIPT_MAIL_AUTOMATION_VERSION,
  LOGIN_REJECTED_REASON_TEMPLATE_KINDS,
  isLoginRejectedMailReasonCode,
  loginRejectedMaterialEventId,
  sanitizeLoginRejectedPublicReasonText,
  type LoginRejectedMailReasonCode,
} from "./scpReceiptMailOutbox";
import {
  FLU_APPLICATION_COMMAND_COLLECTION,
  fetchScpPortalDeliveryMaterial,
  fetchScpPortalReceiptMailMaterial,
  fluApplicationCommandId,
} from "./scpFluApplicationCommand";
// Task-35: re-exported for backward compatibility — callers/tests that read this symbol off the
// compiled worker module (worker.sanitizeLoginRejectedPublicReasonText) keep working after the
// sanitizer moved to the leaf module (shared with scripts/scp-login-rejected-portal-inventory.mjs).
export { sanitizeLoginRejectedPublicReasonText };

import { backfillApplicationManagementFromOutbox, SCP_APPLICATION_MANAGEMENT_COLLECTION } from "./applicationManagementStore";
import { fetchCreatorPipelineV3OnboardingMaterial } from "./scpCreatorPipelineV3MaterialClient";

import { prepareScpResultMail, classifyScpResultMailDelivery } from "./scpMail";
import { sendEmailFromCanonicalScpAccount, sendEmailFromTrustedWorker } from "./chat-ai";
import {
  CONTENT_SUBMITTED_EMAIL_EN_HTML,
  SCP_APPLICATION_CONFIRMED_EMAIL_EN_HTML,
  SCP_APPLICATION_VIDEO_REMINDER_EN_HTML,
  SCP_VIDEO_RESULT_APPROVED_EN_HTML,
  SCP_VIDEO_RESULT_CHANGES_REQUESTED_EN_HTML,
  SCP_VIDEO_RESULT_REJECTED_EN_HTML,
} from "./mailTemplatesGenerated";
import {
  SCP_APPLICATION_CONFIRMED_SUBJECT,
  SCP_CONTENT_SUBMITTED_RECEIPT_SUBJECT,
  SCP_CONTENT_SUBMITTED_RECEIPT_TEXT,
} from "./scpReceiptMailContracts";
import { buildScpBrandedMailHtml } from "./scpBrandedMailHtml";
import { mergeDeclineReasonCounts, summarizeVideoReviewLedger } from "./videoReviewHistorySummary";
import { loadProgramTitleRegistry } from "./programTitlesStore";
import { resolveSubjectGameId } from "./videoReviewGameFilter";
import {
  DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE,
  VIDEO_REVIEW_REASON_TAG_MAX,
  videoReviewRubricTitle,
  videoReviewRuleTagPhrase,
  type VideoReviewRubricTitle,
} from "./videoReviewCriteria";
import { resolveVideoTitleProjection } from "./videoTitleProjection";
import {
  RECEIPT_TEMPLATE_PRODUCTION_DEFAULT_VALUES,
  // 2026-09-05 다타이틀: 결과 메일의 게임 변수 3종을 만드는 정본(계약과 같은 모듈에 둔다).
  videoResultMailTitleValues,
  resolveScpMailTemplateOverride,
  SCP_APPLICATION_VIDEO_REMINDER_SUBJECT,
  SCP_APPLICATION_VIDEO_REMINDER_FALLBACK_TEXT,
  resolveScpReceiptMailTemplate,
  resolveNudgeSequenceTemplateByKey,
  nudgeDraftMailTemplateBaseKind,
  renderScpReceiptMailFallbackTemplate,
} from "./scpReceiptMailTemplates";
// W72-A: 레인별 개별 캡(리더 확정 250/일) + 캡 초과 식별 코드.
import {
  // W72 [R1 P1-3]: commitLaneDailySend 제거 — 레인 카운트는 쿼터 예약 트랜잭션이 올린다.
  laneDailyQuotaAllows,
  // [헤세 2026-09-03] 세 코호트 합산 배출 상한 판정.
  totalDailyQuotaAllows,
  OUTBOUND_QUOTA_EXCEEDED_ERROR_CODE,
  OUTBOUND_SAFETY_LOCK_ERROR_CODE,
  // W118: 레인 수동 정지 조회(패스당 1회 · 어댑터 가드).
  readMailLaneManualPause,
} from "./mailOutboundSafety";
import { resolveMailOutboundLane, serverOwnedMailLaneProvenance } from "./mailOutboundLanes";
import {
  NUDGE_COHORT2_KEY,
  NUDGE_TEMPLATE_UNMAPPED_REASON,
  readNudgeLaneQuotaConfig,
  readNudgeSequenceConfig,
  // [헤세 2026-09-03] 세 코호트 합산 배출 상한.
  readNudgeTotalDailyCap,
} from "./nudgeSequenceTemplates";
import { VIDEO_REMINDER_HISTORY_COLLECTION } from "./applicationVideoPending";
import { REPLY_LINK_SUBMIT } from "./mailReplyLinks";

export const SCP_OUTBOX_MAIL_WORKERS_VERSION = "scp_outbox_mail_workers_v1" as const;
// Append-only, hash-only receipts for human-review result mail. This is deliberately separate from
// the mutable outbox row so a retry/DLQ history remains reviewable without exposing recipients.
export const SCP_VIDEO_RESULT_MAIL_AUDIT_COLLECTION = "scp_video_result_mail_audit";

// ---- shared types -------------------------------------------------------------

export type OutboundMailMessage = {
  to: string;
  subject: string;
  text: string;
  // Optional HTML body (P5/P9). When present, the default send adapter passes it through to
  // sendEmail as `data.html` with `bodyFormat: "html"` — sendEmail's own compileMailArtifact ->
  // sanitizeEmailHtml gate still runs unmodified (never bypassed). Absent => plain-text send exactly
  // as before this field existed.
  html?: string;
  trackingId: string;
  draftRef: string;
  approvalRef: string;
  mailPurpose: string;
  templateKind: string;
  gameId: string;
  sourceRef: string;
  conversationId: string;
  mailType?: string;
  // Production-pilot fence identity (Portal G005 mail-fence requirement). Optional so injected
  // test adapters keep compiling, but the default adapter default-denies when identity is absent.
  fenceApplicationId?: string;
  fenceSubmissionId?: string;
  fenceTraceId?: string;
  fenceSendGeneration?: number;
  programId?: string;
  campaignId?: string;
  outreachId?: string;
  applicationId?: string;
  portalCreatorId?: string;
  fluCreatorId?: string;
  partnerId?: string;
  enrollmentId?: string;
  submissionId?: string;
  revision?: number;
  traceId?: string;
  eventId?: string;
  /** Task-94: mailOutboundLanes.ts 가 AI 저자 거래성 메일을 outbound cap 대상으로 돌리는 데 쓴다. */
  actorType?: "human" | "ai";
};

export type MailSendResult = {
  sent: boolean;
  providerMessageId?: string;
  reason?: string;
};

export type MailSendAdapter = (message: OutboundMailMessage) => Promise<MailSendResult>;

export type RecipientContext = {
  applicationId: string;
  kind: string;
  programId?: string;
  sourceContract?: string;
  eventId?: string;
  traceId?: string;
  videoSubmissionId?: string;
  videoRevision?: number;
  /**
   * NEW legacy-cutover gate. Video-result V1 receipt resolution is only allowed when an explicit
   * human-approved cutover predicate says so. Default (undefined/false) = deny: old queued rows
   * stay `recipient_unresolved` with zero attempts. This is a *resolution* gate, not SMTP approval.
   */
  allowLegacyVideoResultMail?: boolean;
};

export type ResolvedRecipient = {
  email: string;
  correctionLink?: string;
  emailSha256?: string;
  traceId?: string;
  campaignId?: string;
  outreachId?: string;
};

export type RecipientResolver = (
  context: RecipientContext,
) => Promise<ResolvedRecipient | null>;

function errorCode(error: unknown): string {
  const code = asString((error as { code?: unknown } | null)?.code);
  return code || "unknown_error";
}

// W72-A [리더 승인 2026-08-12]: 캡 초과·안전 잠금만 골라낸다. `code` 는 셋 다 `failed-precondition`
//   이라 구분자가 못 된다 — `errorCode` 를 본다(mailOutboundSafety 가 붙인다).
//   여기 없는 사유는 예전과 **완전히 동일한** 경로를 탄다(기존 레인 동작 불변).
function deferrableSendFailureCode(error: unknown): string {
  const specific = asString((error as { errorCode?: unknown } | null)?.errorCode);
  return specific === OUTBOUND_QUOTA_EXCEEDED_ERROR_CODE || specific === OUTBOUND_SAFETY_LOCK_ERROR_CODE
    ? specific
    : "";
}

function hashOpaque(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized ? createHash("sha256").update(normalized).digest("hex") : "";
}

function normalizedRecipient(value: string): string {
  const email = value.trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : "";
}

// W8-3: 발행본이 텍스트 전용이면 html 을 아예 싣지 않는다(어댑터 계약 "Absent => plain-text send").
// 마커가 없는 레거시 행은 예전과 똑같이 html 경로를 쓴다.
function receiptTextOnly(row: Record<string, unknown>): boolean {
  return asString(row.templateBodyFormat) === "text";
}

function renderedReceiptField(
  row: Record<string, unknown>,
  key: "renderedSubject" | "renderedText" | "renderedHtml",
  fallback: string,
): string {
  return asString(row[key], fallback);
}

async function resolveReceiptRecipient(
  docRef: FirebaseFirestore.DocumentReference,
  row: Record<string, unknown>,
  context: RecipientContext,
  resolver: RecipientResolver,
  now: Date,
): Promise<ResolvedRecipient | null> {
  const snapshotHash = asString(row.recipientEmailHash);
  let recipient: ResolvedRecipient | null = null;
  try {
    recipient = await resolver(context);
  } catch {
    recipient = null;
  }
  const email = normalizedRecipient(recipient?.email ?? "");
  const emailHash = hashOpaque(email);
  const recipientHashMismatch =
    Boolean(snapshotHash) && Boolean(emailHash) && snapshotHash !== emailHash;
  if (
    !recipient ||
    !email ||
    (recipient.emailSha256 && recipient.emailSha256 !== emailHash) ||
    recipientHashMismatch
  ) {
    const resolutionAttempts =
      Math.max(0, Number(row.recipientResolutionAttempts ?? 0)) + 1;
    const nowIso = now.toISOString();
    await docRef.set({
      deliveryState: "recipient_pending",
      recipientEmail: FieldValue.delete(),
      recipientMaterialState: "pending",
      recipientResolutionAttempts: resolutionAttempts,
      lastErrorCode: recipientHashMismatch
        ? "recipient_material_hash_mismatch"
        : "recipient_material_unavailable",
      nextAttemptAtIso: new Date(
        now.getTime() + Math.min(2 ** resolutionAttempts, 60) * 60_000,
      ).toISOString(),
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return null;
  }
  const traceId = recipient.traceId || asString(row.traceId);
  const campaignId = recipient.campaignId || asString(row.campaignId);
  const outreachId = recipient.outreachId || asString(row.outreachId);
  await docRef.set({
    recipientEmail: FieldValue.delete(),
    recipientEmailHash: emailHash,
    recipientMaterialState: "resolved",
    recipientMaterialResolvedAtIso: now.toISOString(),
    ...(traceId ? { traceId } : {}),
    ...(campaignId ? { campaignId } : {}),
    ...(outreachId ? { outreachId } : {}),
    lastErrorCode: null,
    updatedAtIso: now.toISOString(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  // W99(헤세): 서명 귀속(campaignId+outreachId)이 해석되면 관리 문서(unclassified+token_absent
  //   한정)에 역전파 — "실제로 이 신청자에게 발송했다"는 실증 기반 managed 승격. 발송 본류를
  //   깨지 않도록 실패는 삼킨다 (다음 해석·수동 백필에서 재시도 가능).
  const backfillApplicationId = asString(row.applicationId);
  if (backfillApplicationId && campaignId && outreachId) {
    try {
      await backfillApplicationManagementFromOutbox(backfillApplicationId, campaignId, outreachId, now);
    } catch {
      // fail-open: 메일 발송이 우선 — 역전파 실패는 관측 없이 통과 (idempotent, 재시도 가능)
    }
  }
  return {
    email,
    emailSha256: emailHash,
    traceId,
    campaignId: campaignId || undefined,
    outreachId: outreachId || undefined,
  };
}

function canonicalProviderMessageIdHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized)
    ? normalized
    : hashOpaque(normalized);
}

// ---- shared stale-"sending" reclaim (M2 fix) -----------------------------------------------------
//
// The content-submitted and uid-guide drains (this file's drainContentSubmittedMailOutbox and
// ./scpUidGuideMailWorker's drainUidGuideOutbox) each claim a row queued/retryable_failed -> "sending"
// inside a transaction, then a LATER write moves it to its terminal state (delivered/retryable_failed/
// dead_letter). If the process is killed (timeout/OOM) between those two writes, the row is stuck
// forever: neither drain's own due-query selects "sending" rows. Recover by scanning for "sending" rows
// whose last write (updatedAtIso, set at claim time) is older than a TTL and reverting them to
// retryable_failed WITHOUT incrementing attempts — the row simply re-enters the normal
// queued/retryable_failed claim cycle on the caller's own due-query, run immediately after this call.
// drainVideoResultMailOutbox never writes "sending" (it uses a TTL-bound "leased" state that its own
// due-query already re-selects once leaseExpiresAtIso has passed), so calling this for that collection
// is a defensive no-op, not a fix for a live bug there.
export const STALE_SENDING_RECLAIM_TTL_MS = 15 * 60 * 1000;

export async function reclaimStaleSendingOutboxRows(
  collection: string,
  now: Date,
  ttlMs: number = STALE_SENDING_RECLAIM_TTL_MS,
  requiredAutomationVersion?: string,
): Promise<number> {
  const cutoffIso = new Date(now.getTime() - ttlMs).toISOString();
  const stale = await adminDb.collection(collection).where("deliveryState", "==", "sending").limit(50).get();
  let reclaimed = 0;
  for (const doc of stale.docs) {
    const updatedAtIso = asString(doc.data()?.updatedAtIso);
    if (updatedAtIso && updatedAtIso > cutoffIso) continue;
    const reverted = await adminDb.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const freshData = fresh.data() ?? {};
      const freshState = asString(freshData.deliveryState);
      if (
        requiredAutomationVersion &&
        asString(freshData.automationVersion) !== requiredAutomationVersion
      ) {
        return false;
      }
      const freshUpdatedAtIso = asString(freshData.updatedAtIso);
      const freshNextAttemptAtIso = asString(freshData.nextAttemptAtIso);
      if (freshState !== "sending") return false;
      if (freshUpdatedAtIso && freshUpdatedAtIso > cutoffIso) return false;
      tx.set(
        doc.ref,
        {
          deliveryState: "retryable_failed",
          // Legacy/stale queued claims may not have a retry timestamp. Make them eligible for
          // the due-retry query immediately instead of creating a permanently invisible row.
          nextAttemptAtIso: freshNextAttemptAtIso || now.toISOString(),
          updatedAtIso: now.toISOString(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return true;
    });
    if (reverted) reclaimed += 1;
  }
  return reclaimed;
}

// A scheduled drain has no end-user; it acts as an auditable system operator, exactly like
// scpOutreach.ts's SYSTEM_ACTOR / chat-ai.ts's SCP_CANARY_SYSTEM_ACTOR pattern (the schedule itself is
// the authorization). Every mail it sends still runs the FULL sendEmail safety stack unmodified.
const SYSTEM_ACTOR: AuthContext = {
  userId: "scp-outbox-mail-worker",
  role: "manager",
  team: "scp",
  ip: "0.0.0.0",
  gameId: "scp-automation",
  email: "scp-outbox-mail-worker@supercent.io",
  name: "SCP Outbox Mail Worker",
};

/** 이 워커가 싣는 `source`. 레인 판정의 서버 소유 표식과 짝이다(mailOutboundLanes). */
const MAIL_WORKER_LANE_SOURCE = "scp_outbox_mail_worker";

// Build the CallableRequestShape the reused engines (prepareScpResultMail / sendEmail) expect —
// mirrors scpOutreach.ts's mailRequestFor exactly, just not exported from that module.
function mailWorkerRequest(data: Record<string, unknown>): CallableRequestShape {
  return {
    // 2026-09-05 적대 리뷰: 이 request 는 **서버가 만든다**(외부 페이로드가 아니다). 플래그가 없으면
    //   sendEmail/prepareScpResultMail 입구가 서버 소유 표식을 지워 버려, 이 드레인이 실은 거래성 메일이
    //   전부 outreach 레인으로 떨어진다 — 아웃리치 정지 하나가 온보딩·UID·접수 메일을 다시 죽인다.
    internalTrustedInvocation: true,
    auth: {
      uid: SYSTEM_ACTOR.userId,
      token: {
        role: SYSTEM_ACTOR.role,
        team: SYSTEM_ACTOR.team,
        gameId: SYSTEM_ACTOR.gameId,
        email: SYSTEM_ACTOR.email,
        name: SYSTEM_ACTOR.name,
      },
    },
    data,
    app: { appId: "scp-outbox-mail-worker" },
    rawRequest: { ip: SYSTEM_ACTOR.ip },
  };
}

// ---- default recipient resolver (scp-creator-pipeline-v3 MATERIAL ring; fail-closed) -----------

// Recovers the Portal `application.management.acknowledged` grant binding that Flu persisted after a
// 201 `scp.creator-pipeline.management-receipt.v1` acknowledgement (grantId issued), then calls the
// ATTESTED v3 MATERIAL ring (./scpCreatorPipelineV3MaterialClient: fetchCreatorPipelineV3OnboardingMaterial)
// — itself fail-closed (returns `null`, never throws) until Portal binds the material secret/base-URL.
//
// Portal's onboarding-material route REQUIRES {grantId, managementEventId, managementReceiptId}, which
// only exist once Flu has sent the signed management-ack event and stored Portal's accepted receipt.
// That sender/store is a Flu-owned P0 (see plans/flu-aggregate SESSION-LOG G009): until it writes
// SCP_CREATOR_PIPELINE_V3_MANAGEMENT_ACK_RECEIPTS_COLLECTION, this loader reads an empty collection and
// the resolver fail-closes to `null` (skip) — never inventing a binding or a second retrieval path.
const SCP_MAIL_WORKER_MATERIAL_CALLER_ID = "scp-outbox-mail-workers-v1";

// Flu-side store of accepted Portal management-ack receipts (written by the P0 management-ack sender,
// not yet built). Queried by applicationId; only rows carrying an issued grant are eligible.
const SCP_CREATOR_PIPELINE_V3_MANAGEMENT_ACK_RECEIPTS_COLLECTION =
  "scp_creator_pipeline_v3_management_ack_receipts";

// Bounded onboarding-material request lifetime, strictly < Portal's 10-minute cap, emitted as a
// no-millisecond RFC3339 timestamp to match Portal's strict RFC3339 profile.
const ONBOARDING_MATERIAL_REQUEST_TTL_SECONDS = 540;

export type CreatorPipelineV3OnboardingGrantBinding = Readonly<{
  grantId: string;
  managementEventId: string;
  managementReceiptId: string;
}>;

async function loadCreatorPipelineV3OnboardingGrantBinding(
  applicationId: string,
): Promise<CreatorPipelineV3OnboardingGrantBinding | null> {
  const snap = await adminDb
    .collection(SCP_CREATOR_PIPELINE_V3_MANAGEMENT_ACK_RECEIPTS_COLLECTION)
    .where("applicationId", "==", applicationId)
    .where("grantIssued", "==", true)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const data = snap.docs[0].data();
  const grantId = asString(data.grantId);
  const managementEventId = asString(data.managementEventId);
  const managementReceiptId = asString(data.managementReceiptId);
  if (!grantId || !managementEventId || !managementReceiptId) return null;
  return { grantId, managementEventId, managementReceiptId };
}

function onboardingMaterialExpiresAt(now: number = Date.now()): string {
  return new Date(now + ONBOARDING_MATERIAL_REQUEST_TTL_SECONDS * 1_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

export type SignedMaterialRecipientSources = Readonly<{
  loadV3Binding: (
    applicationId: string,
  ) => Promise<CreatorPipelineV3OnboardingGrantBinding | null>;
  fetchV3Material: typeof fetchCreatorPipelineV3OnboardingMaterial;
  loadV1CommandId: (applicationId: string) => Promise<string | null>;
  fetchV1Material: typeof fetchScpPortalDeliveryMaterial;
  loadApplicationManagementRecord?: (
    applicationId: string,
  ) => Promise<Record<string, unknown> | null>;
}>;

const DEFAULT_SIGNED_MATERIAL_RECIPIENT_SOURCES: SignedMaterialRecipientSources =
  {
    loadV3Binding: loadCreatorPipelineV3OnboardingGrantBinding,
    fetchV3Material: fetchCreatorPipelineV3OnboardingMaterial,
    loadV1CommandId: async (applicationId) => {
      const commandId = fluApplicationCommandId(applicationId);
      const command = await adminDb
        .collection(FLU_APPLICATION_COMMAND_COLLECTION)
        .doc(commandId)
        .get();
      return command.exists &&
        asString(command.data()?.applicationId) === applicationId
        ? commandId
        : null;
    },
    fetchV1Material: fetchScpPortalDeliveryMaterial,
    loadApplicationManagementRecord: async (applicationId) => {
      const docId = applicationId
        .replace(/[^A-Za-z0-9_-]/g, "_")
        .slice(0, 180);
      if (!docId) return null;
      const snapshot = await adminDb
        .collection(SCP_APPLICATION_MANAGEMENT_COLLECTION)
        .doc(docId)
        .get();
      return snapshot.exists
        ? ((snapshot.data() ?? {}) as Record<string, unknown>)
        : null;
    },
  };

function httpsPortalLink(value: unknown): string {
  const candidate = asString(value).trim();
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? candidate
      : "";
  } catch {
    return "";
  }
}

function recipientFromApplicationManagement(
  applicationId: string,
  record: Record<string, unknown>,
): ResolvedRecipient | null {
  const identity = asRecord(record.identity);
  const portalMaterial = asRecord(record.portalMaterial);
  const recordedApplicationId =
    asString(identity.applicationId) || asString(record.applicationId);
  if (recordedApplicationId && recordedApplicationId !== applicationId) {
    return null;
  }
  const hasPortalMaterialGrant =
    asString(portalMaterial.grantState) === "granted" ||
    Boolean(
      asString(portalMaterial.grantRef) ||
        asString(portalMaterial.materialHash) ||
        asString(record.grantRef) ||
        asString(record.privateMaterialHash),
    );
  if (!hasPortalMaterialGrant) return null;
  const email = normalizedRecipient(
    asString(portalMaterial.recipientEmail) ||
      asString(portalMaterial.email) ||
      asString(identity.email) ||
      asString(record.recipientEmail) ||
      asString(record.email),
  );
  if (!email) return null;
  const correctionLink = httpsPortalLink(
    portalMaterial.correctionLink ||
      portalMaterial.resubmissionUrl ||
      portalMaterial.uidGuideUrl ||
      record.correctionLink,
  );
  return {
    email,
    ...(correctionLink ? { correctionLink } : {}),
  };
}

// NEW legacy video-result cutover gate. Default-deny: no config, malformed config, future cutover,
// AI/unknown actor, non-video kind, or missing/out-of-window server-authored timestamps all deny.
const LEGACY_VIDEO_RESULT_MAIL_KINDS: ReadonlySet<string> = new Set([
  "content_approved",
  "content_rejected",
  "content_changes_requested",
]);

const SCP_VIDEO_RESULT_MAIL_ROLLOUT_SETTINGS_DOC_PATH =
  "settings/scp_video_result_mail_rollout";

// Strict ISO-8601 UTC instant. Anything that is not an exact `…Z` timestamp (or that does not
// parse to a real instant) is rejected — no age fallback, no undefined-allow.
function strictIsoMs(value: unknown): number | null {
  const raw = asString(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(raw)) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 19) === raw.slice(0, 19) ? ms : null;
}

/**
 * NEW pure predicate: may a queued video-result outbox row be resolved through the *legacy* V1
 * command-material ladder? Default deny. Enabling requires the rollout settings doc to opt in
 * (`legacyCommandMailEnabled === true`) with a strict-ISO cutover (`legacyCommandMailNotBeforeIso`)
 * that is already in the past, plus a row that is an explicitly-human video-result decision whose
 * both server-authored timestamps (`createdAtIso`, `reviewedAt`) fall inside `[cutover, now]`.
 */
export function legacyVideoResultMailAllowed(
  row: unknown,
  config: unknown,
  now: Date,
): boolean {
  const configRecord =
    config && typeof config === "object"
      ? (config as Record<string, unknown>)
      : {};
  if (configRecord.legacyCommandMailEnabled !== true) return false;
  const cutoverMs = strictIsoMs(configRecord.legacyCommandMailNotBeforeIso);
  if (cutoverMs === null) return false;
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs) || cutoverMs > nowMs) return false;

  const rowRecord =
    row && typeof row === "object" ? (row as Record<string, unknown>) : {};
  if (asString(rowRecord.actorType) !== "human") return false;
  const kind = asString(rowRecord.mailKind) || asString(rowRecord.kind);
  if (!LEGACY_VIDEO_RESULT_MAIL_KINDS.has(kind)) return false;

  const createdAtMs = strictIsoMs(rowRecord.createdAtIso);
  const reviewedAtMs = strictIsoMs(rowRecord.reviewedAt);
  if (createdAtMs === null || reviewedAtMs === null) return false;
  if (createdAtMs > nowMs || reviewedAtMs > nowMs) return false;
  if (configRecord.legacyRecoveryEnabled === true) {
    const authorizedAtMs = strictIsoMs(rowRecord.legacyRecoveryAuthorizedAtIso);
    if (
      authorizedAtMs !== null &&
      authorizedAtMs >= createdAtMs &&
      authorizedAtMs >= reviewedAtMs &&
      authorizedAtMs <= nowMs &&
      asString(rowRecord.legacyRecoveryAuthorizedBy).trim() &&
      asString(rowRecord.legacyRecoveryReason).trim()
    ) {
      return true;
    }
  }
  if (createdAtMs < cutoverMs || reviewedAtMs < cutoverMs) return false;
  return true;
}

export async function resolveSignedMaterialRecipient(
  context: RecipientContext,
  sources: SignedMaterialRecipientSources =
    DEFAULT_SIGNED_MATERIAL_RECIPIENT_SOURCES,
): Promise<ResolvedRecipient | null> {
  if (!context.applicationId) return null;
  let binding: CreatorPipelineV3OnboardingGrantBinding | null;
  try {
    binding = await sources.loadV3Binding(context.applicationId);
  } catch {
    return null;
  }
  if (binding) {
    try {
      const material = await sources.fetchV3Material({
        applicationId: context.applicationId,
        callerId: SCP_MAIL_WORKER_MATERIAL_CALLER_ID,
        expiresAt: onboardingMaterialExpiresAt(),
        grantId: binding.grantId,
        managementEventId: binding.managementEventId,
        managementReceiptId: binding.managementReceiptId,
      });
      if (material?.recipientEmail) {
        const correctionLink = httpsPortalLink(material.uidGuideUrl);
        return {
          email: material.recipientEmail,
          ...(correctionLink ? { correctionLink } : {}),
        };
      }
      return null;
    } catch {
      return null;
    }
  }
  let commandId: string | null;
  // NEW legacy-cutover gate (resolution gate, NOT SMTP approval): for the three video-result
  // kinds, no non-V3 legacy resolution runs at all — neither the V1 command-material ladder nor
  // the application-management fallback — unless an explicit human-approved cutover predicate said
  // so. Old queued rows therefore stay `recipient_unresolved` with zero attempts. V3 resolution
  // (above) and other non-video receipts are byte-for-byte unchanged.
  if (
    LEGACY_VIDEO_RESULT_MAIL_KINDS.has(context.kind) &&
    context.allowLegacyVideoResultMail !== true
  ) {
    return null;
  }
  try {
    commandId = await sources.loadV1CommandId(context.applicationId);
  } catch {
    return null;
  }
  if (commandId) {
    try {
      const material = await sources.fetchV1Material(commandId);
      const correctionLink = httpsPortalLink(material.uidGuideUrl);
      return material.recipientEmail
        ? {
            email: material.recipientEmail,
            ...(correctionLink ? { correctionLink } : {}),
          }
        : null;
    } catch {
      return null;
    }
  }
  if (!sources.loadApplicationManagementRecord) return null;
  try {
    const record = await sources.loadApplicationManagementRecord(
      context.applicationId,
    );
    return record
      ? recipientFromApplicationManagement(context.applicationId, record)
      : null;
  } catch {
    return null;
  }
}

export const defaultRecipientResolver: RecipientResolver = async (context) => {
  // Portal keys application_confirmed material on the application-command event id, and that id is
  // a pure function of applicationId. Deriving it here instead of trusting the stored row is what
  // makes this correct for rows that were enqueued by management materialization: those carry the
  // triggering integration event (scp.integration-event.v2 + evt_…) in sourceContract/lastEventId,
  // which is audit truth about *why* the row exists, not the lookup key Portal needs. Gating the
  // lookup on sourceContract sent those rows down neither branch, so they never reached Portal at
  // all and retried forever on recipient_material_unavailable.
  // For command-originated rows the derived value equals the stored one, so v1 is unchanged.
  if (
    context.kind === "application_confirmed" &&
    context.applicationId &&
    context.programId
  ) {
    const material = await fetchScpPortalReceiptMailMaterial({
      schemaVersion: "scp.receipt-mail.delivery-material-request.v1",
      kind: "application_confirmed",
      sourceContract: "scp.flu.application-command.v1",
      sourceEventId: fluApplicationCommandId(context.applicationId),
      applicationId: context.applicationId,
      programId: context.programId,
    });
    return material
      ? {
          email: material.recipientEmail,
          emailSha256: material.recipientEmailSha256,
          traceId: material.traceId,
          campaignId: material.campaignId,
          outreachId: material.outreachId,
        }
      : null;
  }
  if (
    context.kind === "content_submitted" &&
    context.sourceContract === "scp.integration-event.v2" &&
    context.eventId &&
    context.programId &&
    context.traceId &&
    context.videoSubmissionId &&
    Number(context.videoRevision) > 0
  ) {
    const material = await fetchScpPortalReceiptMailMaterial({
      schemaVersion: "scp.receipt-mail.delivery-material-request.v1",
      kind: "content_submitted",
      sourceContract: context.sourceContract,
      sourceEventId: context.eventId,
      applicationId: context.applicationId,
      programId: context.programId,
      traceId: context.traceId,
      videoSubmissionId: context.videoSubmissionId,
      videoRevision: Number(context.videoRevision),
    });
    return material
      ? {
          email: material.recipientEmail,
          emailSha256: material.recipientEmailSha256,
          traceId: material.traceId,
          campaignId: material.campaignId,
          outreachId: material.outreachId,
        }
      : null;
  }
  return resolveSignedMaterialRecipient(context);
};

// ---- default send adapter (fail-closed; reuses chat-ai.ts sendEmail + scpMail.ts classifier) ---

/**
 * W118 — 비소모 스킵 사유. 이 사유로 돌아온 행은 **상태·시도횟수를 건드리지 않고** 큐로 돌린다.
 * 종전에는 각 드레인이 같은 조건식을 문자 그대로 6번 복제하고 있었다 — 새 비소모 사유를 하나
 * 추가하려면 6곳을 동시에 고쳐야 하고, 한 곳만 빠뜨리면 그 레인이 조용히 dead_letter 를 만든다.
 */
export function isNonConsumingSendSkipReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return reason === "provider_unconfigured"
    || reason.startsWith("pilot_fence_denied")
    || reason.startsWith(LANE_PAUSED_SKIP_REASON_PREFIX);
}

export const LANE_PAUSED_SKIP_REASON_PREFIX = "lane_paused:";

export const defaultMailSendAdapter: MailSendAdapter = async (message) => {
  // W118: 레인 수동 정지 가드(범용). 독려·아웃리치 드레인은 패스 단위 clean-skip 이 앞단에서
  // 막지만, 이 어댑터를 쓰는 **모든** 레인이 같은 규칙을 받도록 여기서도 확인한다.
  // 거래성 레인은 resolveMailLaneManualPause 가 항상 false 라 이 가드에 걸리지 않는다.
  // 반환은 **비소모 스킵**이다 — 정지 때문에 시도를 소모하면 풀렸을 때 dead_letter 만 남는다.
  const lane = resolveMailOutboundLane({
    mailPurpose: message.mailPurpose,
    // Task-94: AI 저자 거래성 메일(video_result_mail)을 outreach 레인으로 돌리는 신호.
    actorType: message.actorType,
    // 서버 소유 표식이 없으면 레인은 outreach 로 닫힌다 — 이 어댑터는 서버 드레인이므로 명시한다.
    ...serverOwnedMailLaneProvenance(MAIL_WORKER_LANE_SOURCE),
  });
  if (await readMailLaneManualPause(lane)) {
    return { sent: false, reason: `${LANE_PAUSED_SKIP_REASON_PREFIX}${lane}` };
  }
  // GA 스위치(settings/scp_receipt_mail_golive): 파일럿 펜스 평가 **직전**에만 본다.
  // 열려 있고 이 메일의 purpose 가 목록에 있으면 **파일럿 핀 요구만** 건너뛰고, 아래 SMTP 게이트와
  // sendEmail 파이프라인(승인·분류기·킬스위치)은 전부 그대로 통과해야 한다.
  // 스위치가 없거나 purpose 가 없으면 아래 기존 default-deny 경로가 그대로 돈다.
  const goLiveAllows = receiptMailGoLiveAllows(
    await readReceiptMailGoLiveConfig(),
    message.mailPurpose,
  );
  // Production-pilot fence (Portal G005): evaluated IMMEDIATELY before the provider send, ahead of
  // every other gate. Default-deny: absent/disabled fence config, non-pinned recipient, purpose,
  // identity, trace or over-generation all return pilot_fence_denied — the drains treat that as a
  // skip WITHOUT state/attempt mutation (same contract as provider_unconfigured).
  if (!goLiveAllows) {
    const fenceVerdict = evaluateE2eMailFence(await readE2eMailFenceConfig(), {
      recipientEmail: message.to,
      mailPurpose: message.mailPurpose,
      applicationId: message.fenceApplicationId,
      submissionId: message.fenceSubmissionId,
      traceId: message.fenceTraceId,
      sendGeneration: message.fenceSendGeneration,
    });
    if (!fenceVerdict.allowed) {
      return { sent: false, reason: `pilot_fence_denied:${fenceVerdict.reason}` };
    }
  }
  if (!liveIntegrationsEnabled("smtp")) {
    return { sent: false, reason: "provider_unconfigured" };
  }
  let sendResult: unknown;
  try {
    // Video-result outcomes are always authored by SCP.  Pin only this purpose:
    // other existing worker lanes keep their established account-routing contract.
    const send = message.mailPurpose === "video_result_mail"
      ? sendEmailFromCanonicalScpAccount
      : sendEmailFromTrustedWorker;
    sendResult = await send(
      mailWorkerRequest({
        conversationId: message.conversationId,
        programId: message.programId || "scp",
        ...(message.campaignId ? { campaignId: message.campaignId } : {}),
        ...(message.outreachId ? { outreachId: message.outreachId } : {}),
        ...(message.applicationId
          ? { applicationId: message.applicationId }
          : {}),
        ...(message.portalCreatorId
          ? { portalCreatorId: message.portalCreatorId }
          : {}),
        ...(message.fluCreatorId
          ? { fluCreatorId: message.fluCreatorId }
          : {}),
        ...(message.partnerId ? { partnerId: message.partnerId } : {}),
        ...(message.enrollmentId
          ? { enrollmentId: message.enrollmentId }
          : {}),
        ...(message.submissionId
          ? { submissionId: message.submissionId }
          : {}),
        ...(message.revision ? { revision: message.revision } : {}),
        ...(message.traceId ? { traceId: message.traceId } : {}),
        ...(message.eventId ? { eventId: message.eventId } : {}),
        ...(message.actorType ? { actorType: message.actorType } : {}),
        programTitle: "Super Creator Partners",
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        bodyFormat: message.html ? "html" : undefined,
        draftRef: message.draftRef,
        trackingId: message.trackingId,
        approvalRef: message.approvalRef,
        approval: "approved",
        gameId: message.gameId,
        author: SYSTEM_ACTOR.userId,
        fromRole: "ai",
        // 레인은 payload 로 정해지지 않는다 — 서버 소유 표식과 함께 실어야 sendEmail 하류의
        //   evaluateMailSafety·assertOutboundSendPermitted·도달성 재검사가 같은 레인을 본다.
        ...serverOwnedMailLaneProvenance(MAIL_WORKER_LANE_SOURCE),
        sourceRef: message.sourceRef,
        mailPurpose: message.mailPurpose,
        templateKind: message.templateKind,
        mailType: message.mailType || message.templateKind,
        dryRun: false,
        liveSend: true,
      }),
    );
  } catch (error) {
    const code = errorCode(error);
    // W72-A [리더 승인 2026-08-12]: 캡 초과·안전 잠금은 **일시적**이다. 일반 전송 실패와 같은
    //   `transport_error:` 로 내보내면 드레인이 시도를 소모해 6회 만에 dead_letter 로 죽인다.
    //   별도 접두사로 내보내 각 레인이 비소모 유예로 처리하게 한다.
    const detail = deferrableSendFailureCode(error);
    return {
      sent: false,
      reason:
        detail
          ? `quota_deferred:${detail}`
          : code === "mail_delivery_ambiguous"
            ? "delivery_unknown:mail_delivery_ambiguous"
            : `transport_error:${code}`,
    };
  }
  const record = asRecord(sendResult);
  const duplicateReservation = record.duplicate === true || asString(record.deliveryState) === "skipped_duplicate";
  // A duplicate reservation is sent only when the canonical outbound ledger independently proves
  // provider delivery; never infer success from the duplicate response alone.
  const canonicalOutbound = duplicateReservation
    ? (await adminDb.collection("mail_outbound_log").doc(message.trackingId).get()).data() ?? {}
    : {};
  if (
    duplicateReservation &&
    !(
      asString(canonicalOutbound.deliveryState) === "sent" &&
      canonicalOutbound.providerConfirmed === true &&
      canonicalOutbound.persisted === true
    )
  ) {
    return {
      sent: false,
      reason: "delivery_unknown:quota_reserved_without_provider_receipt",
    };
  }
  const delivery = classifyScpResultMailDelivery(sendResult, canonicalOutbound);
  if (!delivery.providerConfirmed) {
    return { sent: false, reason: delivery.reason };
  }
  return {
    sent: true,
    providerMessageId: asString(record.providerMessageIdHash) || message.trackingId,
  };
};

// ---- §3 onboarding send worker ------------------------------------------------------------------

export type DrainOnboardingOutboxOptions = {
  batchLimit?: number;
  now?: Date;
  sendAdapter?: MailSendAdapter;
  recipientResolver?: RecipientResolver;
};

export type DrainOnboardingOutboxResult = {
  scanned: number;
  sent: number;
  failed: number;
  deadLettered: number;
  skipped: number;
};

// Reuses prepareScpResultMail's own template-kind coercion (its normalizeKind) by simply passing the
// resolved templateRef's trailing segment through as `kind` — this file never re-implements template
// resolution/precedence, it only reads the composer's side-effect-free preview.
async function renderOnboardingMail(
  templateRef: string,
  email: string,
  applicationId: string,
): Promise<{ subject: string; body: string; html: string }> {
  const kind = templateRef.split("/").pop() || templateRef;
  const result = await prepareScpResultMail(
    mailWorkerRequest({
      leadId: applicationId,
      email,
      kind,
      mode: "draft_only",
      programId: "scp",
      dryRun: true,
      liveSend: false,
    }),
  );
  const draft = asRecord(asRecord(result).draft);
  const subject = asString(draft.subject);
  const body = asString(draft.body);
  // W7-3e: 온보딩 레인은 sendAdapter 호출에 html 키 자체가 없어 텍스트 전용으로 나갔다. 템플릿 본문
  // (운영자 편집 대상)은 그대로 두고, 정본 마스터의 600px 다크 셸에 담아 HTML 파트를 붙인다.
  // 본문 문장을 다시 쓰지 않는다 — 빈 줄 기준으로 단락만 나누고 이스케이프는 셸이 한다.
  // F2: 단락 분리만 하고 **단락 안의 단일 개행은 그대로 둔다**(셸이 <br> 로 보존한다).
  // 예전에는 공백으로 이어 붙여서 실발송 텍스트 파트의 줄바꿈이 통째로 사라졌다.
  const paragraphs = body
    .split(/\n{2,}/)
    .map((block) => block.replace(/\s+$/gm, "").trim())
    .filter((block) => block.length > 0);
  const html = paragraphs.length > 0
    ? buildScpBrandedMailHtml({
      heading: "Super Creator Partners",
      paragraphs,
    })
    : "";
  return { subject, body, html };
}

export async function drainOnboardingOutbox(
  options: DrainOnboardingOutboxOptions = {},
): Promise<DrainOnboardingOutboxResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const batchLimit = Math.min(Math.max(Math.trunc(options.batchLimit ?? 25), 1), 200);
  const sendAdapter = options.sendAdapter ?? defaultMailSendAdapter;
  const recipientResolver = options.recipientResolver ?? defaultRecipientResolver;

  const result: DrainOnboardingOutboxResult = {
    scanned: 0,
    sent: 0,
    failed: 0,
    deadLettered: 0,
    skipped: 0,
  };

  const due = await adminDb
    .collection(ONBOARDING_OUTBOX_COLLECTION)
    .where("state", "in", ["queued", "failed"])
    .limit(batchLimit)
    .get();

  for (const doc of due.docs) {
    result.scanned += 1;
    const data = doc.data() ?? {};
    const state = asString(data.state) as OnboardingOutboxState;
    const applicationId = asString(data.applicationId);
    const sendGeneration = Math.max(0, Math.trunc(Number(data.sendGeneration ?? 0)));
    const attempts = Math.max(0, Math.trunc(Number(data.attempts ?? 0)));
    const classification = (asString(data.classification, "unclassified") as AttributionClassification);

    if (!applicationId) {
      result.skipped += 1;
      continue;
    }

    // Reuse the pure retry/backoff/dead-letter planner instead of re-deriving the backoff formula:
    // this also naturally holds a "failed" row inside its backoff window without consuming an attempt.
    const plan = planOnboardingSend({
      classification,
      currentState: state,
      attempts,
      nowMs: now.getTime(),
      lastAttemptMs: data.lastAttemptIso ? Date.parse(asString(data.lastAttemptIso)) : null,
    });
    if (plan.action !== "send") {
      result.skipped += 1;
      continue;
    }

    const recipient = await recipientResolver({ applicationId, kind: "onboarding" });
    if (!recipient?.email) {
      result.skipped += 1;
      continue;
    }

    // Claim the row (queued/failed -> sending) so a concurrent drain can never double-send.
    const claimed = await adminDb.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const freshState = asString(fresh.data()?.state);
      if (freshState !== "queued" && freshState !== "failed") return false;
      tx.set(
        doc.ref,
        { state: "sending", updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return true;
    });
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    const templateRef = asString(data.templateRef, "qualification_pass");
    let rendered: { subject: string; body: string; html: string };
    try {
      rendered = await renderOnboardingMail(templateRef, recipient.email, applicationId);
    } catch (error) {
      const failure = await markOnboardingFailed(
        applicationId,
        sendGeneration,
        `render_error:${errorCode(error)}`,
        now,
      );
      result.failed += 1;
      if (failure.state === "dead_letter") result.deadLettered += 1;
      continue;
    }

    const trackingId = `onboarding-${hashOpaque(`${applicationId}:${sendGeneration}`)}`.slice(0, 60);
    // Fence identity: traceId comes from the exact management record for this application; a
    // missing record leaves traceId undefined and the fence default-denies trace-pinned configs.
    let fenceTraceId: string | undefined;
    try {
      const managementSnap = await adminDb
        .collection("scp_application_management")
        .doc(applicationId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180))
        .get();
      fenceTraceId = asString(managementSnap.data()?.traceId) || undefined;
    } catch {
      fenceTraceId = undefined;
    }
    const sendResult = await sendAdapter({
      to: recipient.email,
      subject: rendered.subject || "Welcome to Super Creator Partners",
      text: rendered.body || "",
      ...(rendered.html ? { html: rendered.html } : {}),
      trackingId,
      draftRef: `onboarding-outbox-${doc.id}`,
      approvalRef: `onboarding-outbox-${doc.id}-approval`,
      mailPurpose: "onboarding",
      templateKind: templateRef,
      gameId: "scp-automation",
      sourceRef: doc.ref.path,
      conversationId: `onboarding-${applicationId}`,
      fenceApplicationId: applicationId,
      fenceTraceId,
      fenceSendGeneration: sendGeneration > 0 ? sendGeneration : 1,
    });

    if (sendResult.sent) {
      await markOnboardingSent(
        applicationId,
        sendGeneration,
        sendResult.providerMessageId ?? trackingId,
        now,
      );
      result.sent += 1;
      continue;
    }
    if (isNonConsumingSendSkipReason(sendResult.reason)) {
      // Race/pilot fence: release the claim back to queued WITHOUT consuming an attempt — a
      // fence-denied nonmatch must never mutate state, attempts or receipts (Portal G005).
      await doc.ref.set(
        { state: "queued", updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      result.skipped += 1;
      continue;
    }
    // W62e-MAJ-A: 결정적 차단은 이 레인에서도 **비소모 종결**이다(재시도해도 결과가 같다).
    //
    // 상태 필드는 `state` 다 — 이 컬렉션(scp_onboarding_outbox)은 다른 메일 outbox 들과 달리
    // `deliveryState` 를 쓰지 않는다. 종전에는 여기만 `deliveryState: "suppressed"` 로 써서
    // 클레임된 행이 state="sending" 그대로 영구 고착됐다(스캔은 queued/failed 만 집는다).
    // 실측: 26-08-26 e4555a3d 행이 state=sending + deliveryState=suppressed 로 20분+ 정지.
    if (isTerminalSuppressionReason(sendResult.reason)) {
      await doc.ref.set({
        state: "suppressed",
        lastErrorCode: String(sendResult.reason).slice(0, 120),
        nextAttemptAtIso: null,
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      result.skipped += 1;
      continue;
    }
    const failure = await markOnboardingFailed(
      applicationId,
      sendGeneration,
      sendResult.reason ?? "send_failed",
      now,
    );
    result.failed += 1;
    if (failure.state === "dead_letter") result.deadLettered += 1;
  }

  return result;
}

// ---- §4 video-result mail worker ----------------------------------------------------------------
//
// W120 운영 주의(코드 아님 — 배포 시 사람이 확인할 것):
//   ① **승인 결과 메일 첫 배포**다. 승인 통지가 반려 통지와 같은 주간 발신 캡(mailOutboundSafety)을
//      공유하므로, 대량 승인 시 `quota_deferred` 로 발송이 지연될 수 있다. 캡 분리는 정책 판단이라
//      백로그(P2)로 둔다.
//   ② 시트 구레인(콘텐츠메일송부 탭)에는 **수동 승인 메일**이 있다("[SCP] Content has been
//      successfully approved."). flu 승인 메일 활성 후 그 수동 메뉴를 실행하면 이중 발송이다 —
//      실행 금지. 반려 쪽 이중 발송은 `settings/scp_video_result_mail_rollout` 게이트로 끈다
//      (videoReviewTransitionStore.readVideoResultMailRolloutGate).

const VIDEO_RESULT_MAIL_MAX_ATTEMPTS = 6;
const VIDEO_RESULT_MAIL_BACKOFF_MINUTES = [1, 5, 15, 60, 180];
const VIDEO_RESULT_MAIL_LEASE_MS = 2 * 60 * 1000;

const VIDEO_RESULT_MAIL_CUSTOMER_MESSAGES: Record<string, string> = {
  policy_violation: "the submission did not meet our content policy",
  low_engagement_risk: "the content did not meet the engagement criteria for this campaign",
  missing_disclosure: "a required sponsorship disclosure was missing",
  metadata_mismatch: "the submitted video did not match the required campaign details",
  // W120: 검수 화면 사유 코드(REVIEW_REASON_CODES). 종전에는 고객 안내 코드만 지도에 있어서,
  //   운영자가 자유 문안 없이 확정하면 세부 사유가 뭐였든 GENERIC 한 문장으로 뭉개졌다.
  //   문장 조각(fragment)이다 — "… it was not approved: <조각>." 문형에 그대로 들어간다.
  policy_gate_failed: "the submission did not meet the campaign content policy",
  content_quality: "the video did not meet the content quality bar for this campaign",
  wrong_video: "the submitted link points to a different video than the one registered",
  duplicate_content: "this video had already been submitted",
  video_unavailable: "the video at the submitted link could not be viewed",
  other_documented: "the submission did not meet the campaign requirements",
  // Canonical review UI codes. These stable values are persisted in the decision ledger and outbox;
  // map them here instead of leaking the operator token or falling back to a vague generic sentence.
  cm_fix_and_resubmit: "the video needs corrections before it can be reviewed again",
  cm_replace_video: "the submitted video must be replaced with a corrected video",
  cm_policy_guidance: "the video must be updated to follow the campaign content guidelines",
  // "final" applies to this revision's decision. A corrected higher revision is still allowed.
  cm_final_rejection: "the current revision could not be approved",
};
const GENERIC_VIDEO_RESULT_MESSAGE = "campaign content guidelines";
// F3: 승인 판정에는 "무엇이 문제였는지" 문구가 존재하지 않는다. 예전 폴백은 판정과 무관하게
// GENERIC(= 반려성 "campaign content guidelines")을 돌려줘서, 승인 메일이 {{video_result_message}}
// 를 쓰면 승인 안내에 반려 사유처럼 읽히는 문구가 주입됐다(3판정이 문서 1개를 공유하는 구조).
const APPROVED_VIDEO_RESULT_MESSAGE = "your submission meets the campaign requirements";

function videoResultCustomerMessage(code: string, mailKind = ""): string {
  // W120: 승인 메일은 사유 코드를 **보지 않는다**. 검수 화면은 판정 대상과 무관하게 사유·안내
  // 코드를 함께 보내므로(승인 확정에도 실려 온다), 코드 지도를 먼저 보면 승인 안내에
  // "the video needs corrections…" 같은 반려 문구가 주입된다 — F3 와 같은 결함 클래스다.
  if (mailKind === "content_approved") return APPROVED_VIDEO_RESULT_MESSAGE;
  const mapped = VIDEO_RESULT_MAIL_CUSTOMER_MESSAGES[code];
  if (mapped) return mapped;
  return GENERIC_VIDEO_RESULT_MESSAGE;
}

// New content (no pre-existing renderer covers content_approved/changes_requested/rejected) — but the
// customer-facing reason is ALWAYS resolved through a fixed code->phrase map (never free operator text),
// mirroring scpMail.ts's own reasonCode -> customer-safe-phrase discipline (P0-6 / SEC-P0-009).
//
// W7-3e: 이 레인은 html 자체가 없어 텍스트만 발송됐다. 정본 마스터의 600px 다크 셸을 재사용해
// 최소 브랜디드 HTML 을 붙인다(새 디자인 없음). 결과 상태·안내 문구·재제출 링크는 전부 변수로만
// 들어가고, 안내 문구는 계속 고정 코드 지도에서만 온다.
function videoResultStateLabel(mailKind: string): string {
  if (mailKind === "content_approved") return "Approved";
  if (mailKind === "content_changes_requested") return "Changes requested";
  return "Not approved";
}

/**
 * W120: 제출 참조 블록(어느 제출에 대한 결과인지). 결과 문장만 오는 메일은 며칠 새 여러 건을
 * 올린 크리에이터가 어느 영상 얘긴지 못 맞춘다 — 실데이터에서 같은 사람이 같은 영상을 파라미터만
 * 바꿔 재제출한 사례가 확인됐다. 값은 전부 원장에서 오고, 결손이면 발송을 죽이지 않고 중립 표기로
 * 대체한다(SC코드·채널핸들 없는 authenticated_portal 제출이 그 케이스다).
 */
export type VideoResultMailReference = {
  readonly videoTitle?: string;
  readonly youtubeUrl?: string;
  readonly submissionRef?: string;
  readonly decidedDate?: string;
  readonly priorRejectionCount?: number;
  /**
   * W126: **크리에이터 단위**로 같은 사유 코드가 반려된 총 횟수(이번 판정 포함). 2 이상일 때만
   * 에스컬레이션 문안이 붙는다. `priorRejectionCount` 와 축이 다르다 — 그쪽은 **이 제출 하나**의
   * 원장이라, 같은 사람이 서로 다른 영상 5건을 같은 사유로 반려당해도 전부 0 이다(실데이터의
   * 반복 제출자가 정확히 그 형태였다).
   */
  readonly sameReasonDeclineCount?: number;
};

const VIDEO_RESULT_REFERENCE_FILLER = "N/A";

/**
 * W126: 반복 반려 에스컬레이션 문안. **서버 사전 값만**으로 만든 완성 문장이다 —
 * 모델 자유 텍스트·퍼센트·룰 ID 는 이 경로에 들어올 수 없다(SEC-P0-009). 변수는 서버가 센
 * 정수 하나뿐이고, 그 정수도 사유 코드별 원장 엔트리 수라 식별자가 아니다.
 *
 * 하이픈은 **ASCII** 다(em dash 아님) — 이 레인의 크리에이터 문안은 전부 ASCII 로 맞춘다
 * (W121 사유 불릿과 같은 규율: 값이 escapeHtml 을 통과하고 htmlToText 로 파생된다).
 *
 * W126 [적대 리뷰 M1] 문구 선택: 정본 초안은 "N submissions **declined**" 였지만 계수 축인
 * `declineReasonCounts` 는 `rejected` + `changes_requested` 를 합친다(W120 M3 설계). 그래서
 * 이 문장은 **변경요청 메일에도** 붙고, 변경요청 1 + 반려 1 인 크리에이터가 "2 declined" 를
 * 읽게 된다. 두 선택지 중 **문구를 중립화**하는 쪽을 택했다 — 축을 `rejected` 로 좁히면
 * 반복 제출자를 놓치는데(변경요청도 같은 사유로 되돌아온 사실이다) 그게 이 기능의 목적이다.
 * "not approved" 는 두 상태 모두에 정확하고, 마스터 2종이 이미 쓰는 어휘라 문면도 일관된다.
 */
export const VIDEO_RESULT_MAIL_ESCALATION_MIN_COUNT = 2;

export function videoResultMailEscalationNotice(
  sameReasonDeclineCount: number | undefined,
): string {
  const count = Number(sameReasonDeclineCount ?? 0);
  if (!Number.isFinite(count) || count < VIDEO_RESULT_MAIL_ESCALATION_MIN_COUNT) return "";
  return `We've noticed ${Math.trunc(count)} submissions were not approved for the same reason - please review the guide before resubmitting.`;
}

function videoResultReferenceValues(
  reference: VideoResultMailReference = {},
): Record<string, string> {
  const trimmed = (value: unknown) => asString(value).trim();
  const count = Number(reference.priorRejectionCount ?? 0);
  return {
    video_title: trimmed(reference.videoTitle) || "Your submission",
    youtube_url: trimmed(reference.youtubeUrl) || VIDEO_RESULT_REFERENCE_FILLER,
    submission_ref: trimmed(reference.submissionRef) || VIDEO_RESULT_REFERENCE_FILLER,
    decided_date: trimmed(reference.decidedDate) || VIDEO_RESULT_REFERENCE_FILLER,
    prior_rejection_count: String(Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0),
  };
}

/**
 * 텍스트 파트의 참조 블록. 변수를 남기지 않는다 — 치환 실패가 수신자에게 새면 안 된다.
 *
 * 2026-09-05 다타이틀: 맨 위에 `Game: <게임명>` 한 줄이 붙는다. 종전 결과 메일은 게임 이름이
 * 한 글자도 없어서(감사 §b F3/F4 실측: 승인·반려 두 건 모두 게임명·스토어 링크·해시태그 전무),
 * 두 타이틀이 같은 화면을 지나가는 순간 크리에이터도 운영자도 **어느 게임 판정인지 알 수 없다**.
 * 이름은 레지스트리에서만 오고, 해석에 실패하면 줄 자체가 빠진다(잘못된 게임명보다 침묵이 낫다).
 *
 * E6 (2026-09-06 Aside 게이트 후속): 이 줄은 원래 `Program: <게임명>` 이었다 — 그런데 같은
 * 검수 화면의 상세 헤더(CanonicalVideoReviewPanel)는 "프로그램"(Flu program 엔티티)과
 * "타이틀"(게임명)을 분명히 구분해서 보여준다. 영어 단어 "Program"을 게임명 자리에 재사용하면
 * 운영자·크리에이터가 이 게임이 곧 자신이 등록한 프로그램인 줄 오인할 수 있어 `Game:` 으로
 * 바꾼다 — 뜻은 그대로(game_title 변수), 라벨만 화면 용어와 맞춘다.
 */
function videoResultReferenceLines(
  values: Record<string, string>,
  gameTitle = "",
): string {
  return [
    ...(gameTitle ? [`Game: ${gameTitle}`] : []),
    `Video: ${values.video_title}`,
    `Link: ${values.youtube_url}`,
    `Reference ${values.submission_ref} - reviewed ${values.decided_date}`,
  ].join("\n");
}

/**
 * 원장 문서 + 아웃박스 행에서 제출 참조를 만든다.
 *
 * 값의 출처는 전부 이미 저장된 사실이다 — 새 조회를 하지 않는다. `prior_rejection_count` 는
 * **이번 판정을 제외한** 과거 반려·변경요청 수다(원장 엔트리와 아웃박스 행이 같은 decisionRef 를
 * 들고 있어 정확히 그 한 건만 뺀다).
 */
export function videoResultMailReferenceFromLedger(
  stateData: Record<string, unknown>,
  row: Record<string, unknown>,
  submissionId: string,
  /** 있으면 제목을 승격할 수 있는 `videos` 문서(스냅샷 동기화 표식 포함). 드레인에는 없다. */
  videoDoc?: Record<string, unknown> | null,
): VideoResultMailReference {
  const revision = Number(
    asRecord(row.currentRevision).revision ?? stateData.revision ?? 0,
  );
  const submissionRef = revision > 0
    ? `${submissionId} - rev ${Math.trunc(revision)}`
    : submissionId;
  const decidedAtIso = asString(row.reviewedAt) || asString(row.createdAtIso);
  // W120 [적대 리뷰 M9]: 아웃박스 행에 decisionRef 가 없는 레거시 행은 제외할 대상을 특정할 수
  //   없어 **이번 판정까지 포함**해 세어질 수 있다(최대 +1). 현행 동작을 테스트로 못박아 두고
  //   보정은 P2 로 미룬다 — 여기서 seq 를 추측해 빼면 엉뚱한 판정이 빠질 위험이 더 크다.
  const summary = summarizeVideoReviewLedger(stateData.reviewLedger, {
    excludeDecisionRef: asString(row.decisionRef) || null,
  });
  // W120 [적대 리뷰 H2]: 원장 `title` 은 실측 118건 전부 **등록 시점 사내 라벨**이다. 그대로 실으면
  //   사내 라벨이 크리에이터 메일에 박힌다. 화면과 같은 정본 해석기를 태우고, YouTube 스냅샷이
  //   확인해 준 제목이 아니면 중립 문구로 내린다(드레인에는 `videos` 조인이 없다).
  const resolvedTitle = resolveVideoTitleProjection(stateData.title, videoDoc ?? null);
  return {
    videoTitle: resolvedTitle.source === "youtube_snapshot" ? resolvedTitle.title ?? "" : "",
    youtubeUrl: asString(stateData.youtubeUrl),
    submissionRef,
    // 수신자에게는 날짜만 보인다 — 시각·타임존은 판정 사실과 무관하고 오해만 만든다.
    decidedDate: decidedAtIso.slice(0, 10),
    priorRejectionCount: summary.declines,
  };
}

/**
 * W126: 크리에이터 단위 "같은 사유 반려" 횟수. **이번 판정을 포함**한 값이다.
 *
 * 축이 크리에이터인 이유: 이 제출 하나의 원장(`prior_rejection_count`)은 같은 사람이 **서로 다른**
 * 영상 5건을 같은 사유로 반려당한 실데이터 패턴을 전부 0 으로 본다 — 에스컬레이션이 겨냥하는
 * 바로 그 형태를 못 잡는다. 그래서 W120 의 크리에이터 스코프 쿼리(단일 필드 동등, 복합 인덱스
 * 불필요)와 같은 모양을 쓰고, 집계는 같은 순수 헬퍼(mergeDeclineReasonCounts)로 한다.
 *
 * COST-P0-006: 상한은 문서 `VIDEO_RESULT_MAIL_CREATOR_SCAN_LIMIT + 1` 건이고, **판정 1건의 메일이
 * 실제로 나갈 때만** 돈다(수신자 미해결로 스킵되는 행은 이 읽기를 사지 않는다). 읽은 건수는
 * 아래 로그 한 줄로 남긴다 — 식별자·본문은 싣지 않는다(SEC-P0-009).
 *
 * 실패는 열어 둔다(fail-open): 집계가 안 되면 에스컬레이션만 빠지고 결과 메일은 그대로 나간다.
 * 통지를 못 하는 것보다 경고 문장 하나가 빠지는 쪽이 낫다.
 */
const VIDEO_RESULT_MAIL_CREATOR_SCAN_LIMIT = 50;

/**
 * W126 [적대 리뷰 M6]: 드레인 **한 호출 수명** 동안의 크리에이터별 사유 집계 메모.
 *
 * 이게 없으면 워커가 `every 1 minutes` · batchLimit 25 라 최악 25 x 51 = 분당 1,275 문서를
 * 더 읽는다. 게다가 운영자가 한 크리에이터의 백로그를 일괄 반려하면 **같은 쿼리를 한 호출에
 * 25번** 쏜다 — 그 25번의 답은 전부 같다(호출 안에서 원장이 바뀌지 않는다). 캐시 수명을
 * 호출 하나로 묶는 이유도 그것이다: 다음 분(分)에는 새 판정이 반영돼야 하므로 살아남으면 안 된다.
 */
type CreatorDeclineCountsCache = Map<string, Map<string, number>>;

async function creatorNotifiedDeclineCounts(
  fluCreatorId: string,
  cache: CreatorDeclineCountsCache,
): Promise<Map<string, number>> {
  const cached = cache.get(fluCreatorId);
  if (cached) return cached;
  const counts = new Map<string, number>();
  // 실패해도 빈 맵을 **캐시에 넣는다** — 같은 호출 안에서 죽은 쿼리를 25번 재시도하지 않는다.
  cache.set(fluCreatorId, counts);
  const snapshot = await adminDb
    .collection(SCP_VIDEO_REVIEW_STATE_COLLECTION)
    .where("subject.fluCreatorId", "==", fluCreatorId)
    // 필요한 건 원장뿐이다. select 없이 뽑으면 evidence/evidencePacket 까지 딸려 와
    // 256MiB 함수에서 51개 풀 문서를 들고 있게 된다(read 과금은 같지만 메모리·전송은 아니다).
    .select("reviewLedger")
    .limit(VIDEO_RESULT_MAIL_CREATOR_SCAN_LIMIT + 1)
    .get();
  for (const doc of snapshot.docs.slice(0, VIDEO_RESULT_MAIL_CREATOR_SCAN_LIMIT)) {
    // 이번 판정은 **이미 원장에 있다**(아웃박스 행과 같은 트랜잭션에서 append 됐다). 그러니
    // 아무것도 빼지 않는 것이 "이번 판정 포함" 계수다.
    // notifiedOnly: 크리에이터가 실제로 통지받은 판정만 센다(컷오버 게이트·무메일 백필 제외).
    const summary = summarizeVideoReviewLedger(asRecord(doc.data()).reviewLedger, {
      notifiedOnly: true,
    });
    mergeDeclineReasonCounts(counts, summary.declineReasonCounts);
  }
  console.log("[video-result-mail]", JSON.stringify({
    section: "repeat_decline_escalation",
    docsRead: Math.min(snapshot.size, VIDEO_RESULT_MAIL_CREATOR_SCAN_LIMIT),
    scanLimit: VIDEO_RESULT_MAIL_CREATOR_SCAN_LIMIT,
    truncated: snapshot.size > VIDEO_RESULT_MAIL_CREATOR_SCAN_LIMIT,
  }));
  return counts;
}

async function countCreatorSameReasonDeclines(input: {
  readonly mailKind: string;
  readonly reasonCode: string;
  readonly fluCreatorId: string;
  readonly cache: CreatorDeclineCountsCache;
}): Promise<number> {
  // 승인에는 사유 축이 없고, 사유 코드가 없으면 "같은 사유"를 정의할 수 없다.
  if (input.mailKind === "content_approved" || !input.reasonCode) return 0;
  // `unclassified:` 센티널은 미분류끼리 뭉쳐 남의 이력이 섞인다(W120 규율 그대로).
  if (!input.fluCreatorId || input.fluCreatorId.startsWith("unclassified:")) return 0;
  try {
    const counts = await creatorNotifiedDeclineCounts(input.fluCreatorId, input.cache);
    return counts.get(input.reasonCode) ?? 0;
  } catch (error: unknown) {
    // 에러 **클래스**는 남긴다 — 인덱스 부재·권한·데드라인이 한 덩어리로 삼켜지면 운영자가
    // 조용한 미발화를 진단할 수 없다. 메시지 원문은 싣지 않는다(SEC-P0-009).
    console.warn("[video-result-mail]", JSON.stringify({
      outcome: "source_unavailable",
      section: "repeat_decline_escalation",
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: asString(asRecord(error).code) || null,
    }));
    return 0;
  }
}

/**
 * W121: 사유 태그 키 → **크리에이터 안전 문구 목록**. 이 함수가 태그 경로의 유일한 문장 출처다.
 *
 * 여기서 걸러지는 것: 사전 미등록 키(모델·클라가 만들어 낸 키), 중복, 상한 초과. 즉 태그 경로로
 * 크리에이터 메일에 닿을 수 있는 문자열은 서버 사전의 값뿐이고, 룰 ID·룰명·confidence 퍼센트는
 * 애초에 이 함수에 들어오지 않는다(SEC-P0-009).
 */
export function videoResultMailReasonTagPhrases(
  reasonTagKeys: readonly unknown[] | undefined,
  /** 2026-09-05 다타이틀: 문구의 게임명은 제출의 타이틀에서 온다(없으면 프로그램 기본 타이틀). */
  rubricTitle: VideoReviewRubricTitle = DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE,
): string[] {
  if (!Array.isArray(reasonTagKeys)) return [];
  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const raw of reasonTagKeys) {
    const key = asString(raw).trim();
    if (!key || seen.has(key)) continue;
    const phrase = videoReviewRuleTagPhrase(key, rubricTitle);
    if (!phrase) continue;
    seen.add(key);
    phrases.push(phrase);
    if (phrases.length >= VIDEO_REVIEW_REASON_TAG_MAX) break;
  }
  return phrases;
}

/**
 * 태그 순서 그대로의 사유 불릿 블록. 태그가 없으면 빈 문자열 = 종전(코드 지도) 경로.
 *
 * 불릿 마커는 **ASCII 하이픈**이다. HTML 엔티티(`&#8226;`)를 쓸 수 없는 이유는 이 문자열이
 * 템플릿 **값**으로 주입되기 때문이다 — replaceReceiptHtmlPlaceholders 의 escapeHtml 이
 * `&` 를 `&amp;` 로 바꿔서 수신자에게 `&#8226; …` 가 리터럴로 보인다(실측 확인).
 * 리터럴 `•`(U+2022)도 렌더는 되지만, 이 레인의 크리에이터 문안은 전부 ASCII 라
 * 사전 ASCII 가드와 같은 규율로 맞춘다.
 *
 * ⚠️ 여기서 넣는 `\n` 이 수신자에게 살아 남으려면 이 값을 받는 HTML 자리가 **`<pre>`** 여야 한다
 *   (W121 적대 리뷰 H1). 발송 어댑터는 드레인의 text 파트를 쓰지 않고 HTML 을 재컴파일하며,
 *   그 파생 text 를 만드는 htmlToText 는 CSS(white-space)를 보지 않는다 — `<p>` 로 되돌리면
 *   불릿이 한 줄로 뭉개진다. 마스터 2종과 발행 문서 모두 같은 제약을 받는다.
 */
export function videoResultMailReasonBlock(
  reasonTagKeys: readonly unknown[] | undefined,
  rubricTitle: VideoReviewRubricTitle = DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE,
): string {
  return videoResultMailReasonTagPhrases(reasonTagKeys, rubricTitle)
    .map((phrase) => `- ${phrase}`)
    .join("\n");
}

/**
 * 판정별 코드 폴백 렌더러(순수 함수 · Firestore 미접근). 테스트가 "재제출 링크가 없으면 마스터가
 * 아니라 범용 셸로 내려간다" 같은 분기를 직접 단정할 수 있도록 export 한다.
 *
 * 제목은 크리에이터가 이미 받아본 제목 패밀리에 맞춘다(W120 [M11]): 검수 탭 레인이 쓰던
 * "[SCP] Content review result notification" 계열 — 태그가 없으면 같은 프로그램 메일로 안 읽힌다.
 */
export function renderVideoResultMailFallback(
  mailKind: VideoReviewMailKind,
  messageCode: string,
  correctionLink?: string,
  operatorMessage?: string,
  reference: VideoResultMailReference = {},
  /** W121: 사유 태그 키(순서 = 불릿 순서). 비면 종전 messageCode 폴백 그대로다. */
  reasonTagKeys: readonly unknown[] = [],
  /** 2026-09-05 다타이틀: 사유 문구의 게임명 출처. 미지정이면 프로그램 기본 타이틀. */
  rubricTitle: VideoReviewRubricTitle = DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE,
): { subject: string; body: string; html: string; message: string } {
  // W120: HTML 은 판정별 정본 마스터(mailTemplates/src)다. 종전 범용 셸(buildScpBrandedMailHtml)은
  // 세 판정이 같은 문단 배열만 바꿔 쓰는 구조라 제출 참조·사유 블록을 실을 자리가 없었다.
  // 마스터는 `{{...}}` 를 그대로 두고, 치환은 발행 템플릿과 **같은 렌더러**가 한다
  // (renderScpReceiptMailTemplate: 미주입 변수 → 빈 문자열, 토큰 노출 없음).
  const referenceValues = videoResultReferenceValues(reference);
  const referenceLines = videoResultReferenceLines(referenceValues, rubricTitle.name);
  // W120 [적대 리뷰 C1]: 템플릿 변수 `{{video_result_message}}` 의 값. 우선순위는 HEAD 그대로
  //   **운영자 편집 문안이 먼저**이고, 없을 때만 고정 코드 지도 문구가 온다(F3: 승인은 판정 인지형).
  //   마스터 HTML 교체 전에는 이 문장이 HTML 안에 직접 구워져 있었다 — 변수로 빠지면서 값 계산이
  //   빠지면 운영자가 쓴 문장이 발송본에서 통째로 사라진다.
  // W121: 사유 태그가 있으면 `{{video_result_message}}` 는 **태그 불릿**이 되고, 운영자 문안은
  //   그 아래 보조 노트로 붙는다. 태그가 없으면 계산이 HEAD 그대로다(운영자 문안 → 코드 지도) —
  //   이미 발행된 `scp_mail_templates/video_result_mail` 문서가 `{{reason_tag_block}}` 을 모르는
  //   상태로도 사유가 사라지지 않게 하려면, 사유는 종전 변수 자리에 그대로 실려야 한다.
  const reasonBlock = mailKind === "content_approved"
    ? ""
    : videoResultMailReasonBlock(reasonTagKeys, rubricTitle);
  const operatorNote = (operatorMessage ?? "").trim();
  const customerPhrase = videoResultCustomerMessage(messageCode, mailKind);
  // W121 [적대 리뷰 M4]: 태그를 골랐다고 **고객 안내 코드(cm_*) 문구가 사라지면 안 된다**.
  //   화면의 드롭다운은 선택된 채로 남아 있는데 그 문구만 조용히 빠지면, 운영자가 고른 "다음
  //   행동" 안내가 통째로 유실된다. 그래서 두 축을 잇는다 — 불릿(왜 반려됐나) 뒤에 cm 문구
  //   (이제 무엇을 해야 하나)를, 그다음 운영자 노트를. cm 문구는 원래 "… it was not approved:
  //   <조각>." 문형에 들어가는 조각이라 단독으로 세울 때만 첫 글자를 올리고 마침표를 붙인다.
  //   GENERIC 폴백은 문장으로 세우면 뜻이 없어서(단순 명사구) 생략한다 — 사유는 이미 불릿에 있다.
  const customerSentence = reasonBlock && customerPhrase !== GENERIC_VIDEO_RESULT_MESSAGE
    ? `${customerPhrase.charAt(0).toUpperCase()}${customerPhrase.slice(1)}.`
    : "";
  // W126: 반복 반려 에스컬레이션. 승인에는 사유 축이 없으므로 태그·운영자 문안과 같은 게이트로
  //   떨군다. 값이 임계 미만이면 빈 문자열이라 **종전 발송본과 바이트 동일**이다(무회귀).
  //   자리는 사유(왜) 다음, 운영자 노트(건별 보충) 앞 — "반복이라는 사실"은 사유의 연장이고
  //   운영자 노트는 그 위에 얹는 보충이라는 W121 배치 규율 그대로다.
  const escalationNotice = mailKind === "content_approved"
    ? ""
    : videoResultMailEscalationNotice(reference.sameReasonDeclineCount);
  const message = reasonBlock
    ? [reasonBlock, customerSentence, escalationNotice, operatorNote].filter((part) => part).join("\n\n")
    : [operatorMessage || customerPhrase, escalationNotice].filter((part) => part).join("\n\n");
  if (mailKind === "content_approved") {
    return {
      subject: "[SCP] Content has been approved",
      message,
      body: [
        "Good news - your video submission has been approved.",
        "",
        referenceLines,
        "",
        "View tracking has started for this video, and you are paid per view at the CPM rate of your track. Keep the video public - a private or deleted video stops counting views.",
        "",
        `Open your creator portal: [Open your creator portal](${RECEIPT_TEMPLATE_PRODUCTION_DEFAULT_VALUES.portal_link})`,
      ].join("\n"),
      html: SCP_VIDEO_RESULT_APPROVED_EN_HTML,
    };
  }
  // W102(헤세): 건별 운영자 편집 문안. 종전 규율("고정 코드 지도만, 자유 문장 금지")은 제품 결정으로
  // 완화하되 좁게 연다 — 검증은 parseVideoReviewOperatorMessage(전이 콜러블)에서 끝난 값만 여기 온다.
  // 텍스트 파트의 재제출 링크는 raw URL 대신 마크다운 앵커 — Chat(W96)과 같은 라벨 치환 관례라
  // 운영 화면(tokenizeMailText)에서도, 발행 템플릿 컴파일에서도 같은 문법으로 읽힌다.
  if (mailKind === "content_changes_requested") {
    // W126: 태그 경로의 guidance 는 `message` 를 통째로 싣기 때문에 에스컬레이션이 딸려 오지만,
    //   무태그 경로는 문구를 **다시 조립**하므로 여기서 한 번 더 붙여야 텍스트 파트에 살아남는다.
    const guidance = reasonBlock
      ? ["We reviewed your video submission and changes are needed before it can be approved:", "", message].join("\n")
      : [
        operatorMessage || `We reviewed your video submission and changes are needed before it can be approved: ${videoResultCustomerMessage(messageCode)}.`,
        escalationNotice,
      ].filter((part) => part).join("\n\n");
    const linkLine = correctionLink
      ? `Please make the requested changes and resubmit here: [Resubmit your video](${correctionLink})`
      : "Please review your submission and resubmit once corrected.";
    return {
      subject: "[SCP] Content review result - changes requested",
      message,
      // 코드 fallback 의 텍스트 파트는 값을 이미 알고 있으므로 변수 없이 완성한다 — fallback 에
      // 변수를 남겨두면 치환 실패 시 `{{...}}` 가 그대로 수신자에게 간다.
      body: [guidance, "", referenceLines, "", linkLine].join("\n"),
      // 재제출 링크가 없으면 마스터의 CTA 가 빈 앵커(`href=""`)가 된다 — 죽은 버튼을 보내느니
      // 종전 범용 셸을 그대로 쓴다(오늘과 동일한 발송본, 무회귀).
      html: correctionLink
        ? SCP_VIDEO_RESULT_CHANGES_REQUESTED_EN_HTML
        : buildScpBrandedMailHtml({
          heading: "Changes requested",
          paragraphs: [guidance, "Please review your submission and resubmit once corrected."],
          cta: null,
        }),
    };
  }
  const guidance = reasonBlock
    ? ["We reviewed your video submission and it was not approved:", "", message].join("\n")
    : [
      operatorMessage || `We reviewed your video submission and it was not approved: ${videoResultCustomerMessage(messageCode)}.`,
      escalationNotice,
    ].filter((part) => part).join("\n\n");
  const linkLine = correctionLink
    ? `Please correct the issue and submit a new revision here: [Submit a corrected video](${correctionLink})`
    : "Please correct the issue and submit a new revision.";
  return {
    subject: "[SCP] Content review result notification",
    message,
    body: [guidance, "", referenceLines, "", linkLine].join("\n"),
    html: correctionLink
      ? SCP_VIDEO_RESULT_REJECTED_EN_HTML
      : buildScpBrandedMailHtml({
        heading: "Submission not approved",
        paragraphs: [guidance, "Please correct the issue and submit a new revision."],
        cta: null,
      }),
  };
}

export async function renderVideoResultMailForDelivery(input: {
  readonly mailKind: VideoReviewMailKind;
  readonly messageCode: string;
  readonly correctionLink?: string;
  /** W102: 검증 완료된 운영자 편집 문안 — 승인 메일에는 적용되지 않는다. */
  readonly operatorMessage?: string;
  /** W120: 원장에서 읽은 제출 참조(제목·링크·ref·판정일·이전 반려 수). */
  readonly reference?: VideoResultMailReference;
  /** W121: 사유 태그 키 — 미리보기·드레인이 **같은 값을 같은 함수에** 넣어야 WYSIWYG 이다. */
  readonly reasonTagKeys?: readonly unknown[];
  /**
   * 2026-09-05 다타이틀: 이 제출의 프로그램/게임 타이틀. 미지정이면 프로그램 기본 타이틀이라
   * 오늘의 발송본과 바이트가 같다(무회귀). 드레인은 review-state subject 에서 읽어 넘긴다.
   */
  readonly programId?: string;
  readonly gameId?: string;
}) {
  // 2026-09-05 P1 리뷰 수리: 운영 오버라이드(settings/program_titles)가 여기까지 닿지 않으면
  // 어드민이 타이틀 카피를 고쳐도 결과 메일은 코드 시드만 본다. loadProgramTitleRegistry 가
  // 반환하는 값은 이미 해석된 레지스트리지만 videoReviewRubricTitle 의 override 파서
  // (parseProgramTitleRegistry) 가 기대하는 것과 필드 형태가 같아 그대로 넘겨도 안전하게
  // 재검증-통과한다(60s 캐시 · 실패 시 시드로 폴백 — programTitlesStore.ts 문서 그대로).
  const rubricTitle = videoReviewRubricTitle(input.programId, input.gameId, await loadProgramTitleRegistry(input.programId));
  const operatorMessage = input.mailKind === "content_approved"
    ? undefined
    : (input.operatorMessage ?? "").trim() || undefined;
  // 승인 메일에는 사유 축이 없다 — 운영자 문안과 같은 게이트로 태그도 여기서 떨군다.
  const reasonTagKeys = input.mailKind === "content_approved"
    ? []
    : input.reasonTagKeys ?? [];
  const referenceValues = videoResultReferenceValues(input.reference);
  const fallbackMail = renderVideoResultMailFallback(
    input.mailKind,
    input.messageCode,
    input.correctionLink,
    operatorMessage,
    input.reference,
    reasonTagKeys,
    rubricTitle,
  );
  const reasonBlock = videoResultMailReasonBlock(reasonTagKeys, rubricTitle);
  // W126: 발행 템플릿이 에스컬레이션만 따로 배치하고 싶을 때 쓰는 변수. 코드 마스터는
  //   `{{video_result_message}}` 안에 이미 같은 문장을 싣는다 — 이미 발행된 문서가 이 변수를
  //   모르는 상태에서도 경고가 사라지지 않게 하려는 W121 `reason_tag_block` 규약 그대로다.
  const escalationNotice = input.mailKind === "content_approved"
    ? ""
    : videoResultMailEscalationNotice(input.reference?.sameReasonDeclineCount);
  return resolveScpMailTemplateOverride(
    // W120 [적대 리뷰 H3]: 승인은 전용 문서를 읽는다. 종전에는 반려 문안으로 발행된
    //   `scp_mail_templates/video_result_mail` 이 승인 통지에도 그대로 나갔다.
    //   반려·변경요청은 기존 키를 유지해 이미 발행된 문서가 계속 이긴다(하위호환).
    input.mailKind === "content_approved" ? "video_result_mail_approved" : "video_result_mail",
    {
      subject: fallbackMail.subject,
      text: fallbackMail.body,
      html: fallbackMail.html,
    },
    {
      video_result_state: videoResultStateLabel(input.mailKind),
      // W120 [적대 리뷰 C1]: 폴백 렌더러가 계산한 값 = `operatorMessage || videoResultCustomerMessage(
      //   messageCode, mailKind)`. 텍스트 파트·HTML 마스터·발행 템플릿이 같은 값을 본다.
      video_result_message: fallbackMail.message,
      // W120: 제출 참조 5종은 항상 주입한다(값이 없으면 중립 표기로 채운다) — 발행 템플릿과
      // 코드 폴백이 같은 값 집합을 본다.
      ...referenceValues,
      // 2026-09-05 다타이틀: 발행 템플릿이 게임명·스토어 링크·필수 해시태그를 **변수로** 쓸 수
      //   있게 항상 주입한다(허용/주입 계약은 scpReceiptMailTemplates 의 두 표에 있다).
      //   코드 폴백 텍스트는 위 `Game:` 줄로 같은 사실을 싣는다.
      ...videoResultMailTitleValues(rubricTitle),
      // W121: 사유 불릿만 따로 쓰고 싶은 **발행 템플릿**을 위한 변수(코드 마스터는
      // `{{video_result_message}}` 하나로 이미 같은 문장을 싣는다). 태그가 없으면 주입하지
      // 않는다 — 편집기 lint 가 조건부 변수로 경고할 수 있게 correction_link 와 같은 규약이다.
      ...(reasonBlock ? { reason_tag_block: reasonBlock } : {}),
      ...(escalationNotice ? { escalation_notice: escalationNotice } : {}),
      // 재제출 링크는 있을 때만 주입한다. 승인 메일에서 이 변수를 쓰면 빈 앵커가 되므로
      // 편집기 lint 가 조건부 변수 사용을 경고한다(F3).
      ...(input.correctionLink
        ? { correction_link: input.correctionLink }
        : {}),
    },
  );
}

export type VideoResultMailPreview = Readonly<{
  mailKind: VideoReviewMailKind;
  recipientResolved: boolean;
  recipientMasked: string | null;
  subject: string;
  text: string;
  bodyFormat: "html" | "text";
  templateSource: "published" | "fallback";
  correctionLinkAvailable: boolean;
}>;

/**
 * Read-only operator preview for the exact video-result mail path.
 *
 * The protected address is resolved in memory through the same signed-material resolver as the
 * worker, then masked before it leaves this module. Rendering also uses the exact fallback +
 * published-template path used by the drain. No outbox row, address, or mail body is persisted and
 * this function never calls the transport.
 */
export async function prepareVideoResultMailPreview(input: {
  readonly applicationId: string;
  readonly mailKind: VideoReviewMailKind;
  readonly reasonCode?: string | null;
  readonly customerMessageCode?: string | null;
  /** W102: 운영자가 편집 중인 문안의 실시간 미리보기 — 발송 경로와 같은 렌더러를 통과한다. */
  readonly operatorMessage?: string | null;
  /** W120: 발송 경로와 같은 제출 참조를 미리보기에도 넣는다(미리보기 ≠ 발송본 금지). */
  readonly reference?: VideoResultMailReference;
  /** W121: 사유 태그 키 — 드레인과 같은 렌더러·같은 정규화를 탄다(WYSIWYG 보증). */
  readonly reasonTagKeys?: readonly unknown[];
  /**
   * 2026-09-05 다타이틀: 드레인이 넘기는 것과 **같은 두 값**. 이게 없으면 미리보기는 프로그램
   * 기본 타이틀로 렌더되고 드레인은 제출의 실제 타이틀로 렌더돼, 두 번째 타이틀이 붙는 순간
   * "미리보기 ≠ 발송본" 이 된다(이 모듈의 W120/W121 규율 위반). 호출부가 원장 값을 그대로 넘긴다.
   */
  readonly programId?: string;
  readonly gameId?: string;
  readonly recipientResolver?: RecipientResolver;
}): Promise<VideoResultMailPreview> {
  const recipientResolver =
    input.recipientResolver ?? defaultRecipientResolver;
  let recipient: ResolvedRecipient | null = null;
  try {
    recipient = await recipientResolver({
      applicationId: input.applicationId,
      kind: input.mailKind,
    });
  } catch {
    // Recipient lookup is fail-closed. The operator can still inspect the exact message that would
    // wait in the outbox, but no private lookup error or address is exposed.
    recipient = null;
  }
  const messageCode =
    asString(input.customerMessageCode) || asString(input.reasonCode);
  const rendered = await renderVideoResultMailForDelivery({
    mailKind: input.mailKind,
    messageCode,
    ...(asString(input.programId) ? { programId: asString(input.programId) } : {}),
    ...(asString(input.gameId) ? { gameId: asString(input.gameId) } : {}),
    ...(asString(input.operatorMessage)
      ? { operatorMessage: asString(input.operatorMessage) }
      : {}),
    ...(input.reference ? { reference: input.reference } : {}),
    ...(input.reasonTagKeys?.length ? { reasonTagKeys: input.reasonTagKeys } : {}),
    ...(recipient?.correctionLink
      ? { correctionLink: recipient.correctionLink }
      : {}),
  });
  return {
    mailKind: input.mailKind,
    recipientResolved: Boolean(recipient?.email),
    recipientMasked: maskEmail(recipient?.email ?? null),
    subject: rendered.subject,
    text: rendered.text,
    bodyFormat: rendered.bodyFormat,
    templateSource: rendered.source,
    correctionLinkAvailable: Boolean(recipient?.correctionLink),
  };
}

export type DrainVideoResultMailOutboxOptions = {
  /** 테스트 전용: 렌더 이후·발송 직전 재검증 사이의 틈에서 상태 변경을 재현한다. */
  beforeDispatchHook?: (doc: FirebaseFirestore.QueryDocumentSnapshot) => Promise<void>;
  batchLimit?: number;
  now?: Date;
  sendAdapter?: MailSendAdapter;
  recipientResolver?: RecipientResolver;
};
const VIDEO_RESULT_MAIL_PILOT_SKIP_REASON_CODES = new Set([
  "pilot_fence_denied:pilot_fence_closed",
  "pilot_fence_denied:pilot_fence_recipient_denied",
  "pilot_fence_denied:pilot_fence_purpose_denied",
  "pilot_fence_denied:pilot_fence_identity_denied",
  "pilot_fence_denied:pilot_fence_trace_denied",
  "pilot_fence_denied:pilot_fence_generation_denied",
]);

function boundedVideoResultMailGateSkipReason(
  reason: string | undefined,
): string | null {
  if (reason === "provider_unconfigured") return reason;
  if (reason && VIDEO_RESULT_MAIL_PILOT_SKIP_REASON_CODES.has(reason)) {
    return reason;
  }
  // W118: 레인 정지도 비소모 스킵이다. 사유 문자열은 레인 이름 하나뿐이라 유계다(카디널리티 3).
  if (reason?.startsWith(LANE_PAUSED_SKIP_REASON_PREFIX)) return reason;
  return reason?.startsWith("pilot_fence_denied")
    ? "pilot_fence_denied:unknown"
    : null;
}

function incrementVideoResultMailSkipReason(
  result: DrainVideoResultMailOutboxResult,
  reason: string,
): void {
  result.skipReasonCounts[reason] =
    (result.skipReasonCounts[reason] ?? 0) + 1;
}

export type DrainVideoResultMailOutboxResult = {
  scanned: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  skipped: number;
  skipReasonCounts: Record<string, number>;
};

async function applyVideoResultMailFailure(
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  attempts: number,
  code: string,
  now: Date,
  readinessPatch: Record<string, unknown> = {},
): Promise<"retryable_failed" | "dead_letter" | "suppressed"> {
  const nowIso = now.toISOString();
  // W62e-MAJ-A: 결정적 차단은 비소모 종결이다(시도를 올리지 않는다).
  if (isTerminalSuppressionReason(code)) {
    await doc.ref.set({
      deliveryState: "suppressed",
      lastErrorCode: String(code).slice(0, 120),
      nextAttemptAtIso: null,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
      ...readinessPatch,
    }, { merge: true });
    return "suppressed";
  }
  const nextAttempts = attempts + 1;
  const deadLetter = nextAttempts >= VIDEO_RESULT_MAIL_MAX_ATTEMPTS;
  const backoffMinutes =
    VIDEO_RESULT_MAIL_BACKOFF_MINUTES[Math.min(attempts, VIDEO_RESULT_MAIL_BACKOFF_MINUTES.length - 1)];
  await persistVideoResultMailOutcome(
    doc,
    deadLetter ? "mail_dead_letter" : "mail_retryable_failed",
    {
      ...readinessPatch,
      deliveryState: deadLetter ? "dead_letter" : "retryable_failed",
      attempts: nextAttempts,
      leaseExpiresAtIso: null,
      lastErrorCode: code,
      nextAttemptAtIso: deadLetter
        ? null
        : new Date(now.getTime() + backoffMinutes * 60_000).toISOString(),
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { attempts: nextAttempts, errorCode: code },
    now,
  );
  return deadLetter ? "dead_letter" : "retryable_failed";
}

// The mutable outcome and immutable receipt commit in one transaction. This is intentionally after
// the provider call: a receipt persistence failure rolls back BOTH local writes, leaving the row
// leased rather than downgrading an already-sent message to retryable_failed (which would resend it).
async function persistVideoResultMailOutcome(
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  operation: "mail_delivered" | "mail_retryable_failed" | "mail_dead_letter",
  outcomePatch: Record<string, unknown>,
  auditFields: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const attempts = Math.max(0, Math.trunc(Number(auditFields.attempts ?? 0)));
  const auditId = hashOpaque(`video-result-mail-audit:${doc.id}:${operation}:${attempts}`);
  const auditRef = adminDb.collection(SCP_VIDEO_RESULT_MAIL_AUDIT_COLLECTION).doc(auditId);
  await adminDb.runTransaction(async (tx) => {
    const [fresh, existingAudit] = await Promise.all([tx.get(doc.ref), tx.get(auditRef)]);
    const row = fresh.data() ?? doc.data() ?? {};
    tx.set(doc.ref, outcomePatch, { merge: true });
    if (existingAudit.exists) return;
    tx.create(auditRef, {
      outboxDocId: doc.id,
      submissionId: asString(row.submissionId) || null,
      decisionRef: asString(row.decisionRef) || null,
      currentRevision: asRecord(row.currentRevision),
      mailKind: asString(row.mailKind) || null,
      operation,
      ...auditFields,
      recordedAtIso: now.toISOString(),
      recordedAt: FieldValue.serverTimestamp(),
    });
  });
}

async function releaseVideoResultMailLease(
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  now: Date,
  readinessPatch: Record<string, unknown> = {},
): Promise<void> {
  await doc.ref.set(
    {
      ...readinessPatch,
      deliveryState: "queued",
      leaseExpiresAtIso: null,
      updatedAtIso: now.toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/**
 * 승인 결과 메일 행이 큐에 있는 동안 정본이 바뀌었는지(철회·교체 리비전·후속 판정) 판정한다.
 * 승인 메일은 "트래킹/정산 시작"을 약속하므로 **현재 승인**에만 나가야 한다. 반려/변경요청 행에는
 * 적용하지 않는다 — 그 통지는 과거 판정의 사실이라 후속 리비전이 생겨도 여전히 유효하고, undo 로
 * 취소되는 경로는 전이 트랜잭션이 이미 행을 cancelled 로 닫는다.
 */
export function approvalMailRowStaleReason(
  row: Record<string, unknown>,
  stateData: Record<string, unknown>,
): string | null {
  if (asString(row.mailKind) !== "content_approved") return null;
  if (asString(stateData.state) !== "approved") return "not_approved";
  if (stateData.withdrawn === true || stateData.superseded === true) return "revision_withdrawn_or_superseded";
  const rowRevision = Number(asRecord(row.currentRevision).revision);
  if (Number.isFinite(rowRevision) && rowRevision > 0 && Number(stateData.revision) !== rowRevision) {
    return "revision_not_current";
  }
  const rowDecisionRef = asString(row.decisionRef);
  const ledger = Array.isArray(stateData.reviewLedger) ? (stateData.reviewLedger as unknown[]) : [];
  // 전이 경로는 항상 원장을 쓴다 — 원장이 비어 있으면(레거시/합성 상태) 판정 대조 대신 위 상태·리비전 검사만 쓴다.
  if (rowDecisionRef && ledger.length > 0) {
    const last = asRecord(ledger[ledger.length - 1]);
    if (asString(last.decisionRef) !== rowDecisionRef || asString(last.toState) !== "approved") {
      return "decision_superseded";
    }
  }
  return null;
}

// 클레임 이후에 승인이 무효가 된 행(철회·교체 리비전·후속 판정)을 발송 없이 cancelled 로 닫는다.
async function cancelStaleApprovalRow(
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  staleReason: string,
  now: Date,
): Promise<void> {
  await doc.ref.set({
    deliveryState: "cancelled",
    cancelled: "stale_approval",
    cancelReasonCode: staleReason,
    cancelledAtIso: now.toISOString(),
    leaseExpiresAtIso: null,
    nextAttemptAtIso: null,
    updatedAtIso: now.toISOString(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export async function drainVideoResultMailOutbox(
  options: DrainVideoResultMailOutboxOptions = {},
): Promise<DrainVideoResultMailOutboxResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const batchLimit = Math.min(Math.max(Math.trunc(options.batchLimit ?? 25), 1), 100);
  const sendAdapter = options.sendAdapter ?? defaultMailSendAdapter;
  const recipientResolver = options.recipientResolver ?? defaultRecipientResolver;

  // NEW: read the legacy video-result mail rollout switch ONCE per drain. Fail-closed null — a
  // missing doc, read error, or malformed shape denies every legacy video-result resolution below.
  let videoResultMailRolloutConfig: Record<string, unknown> | null = null;
  try {
    const rolloutSnap = await adminDb
      .doc(SCP_VIDEO_RESULT_MAIL_ROLLOUT_SETTINGS_DOC_PATH)
      .get();
    videoResultMailRolloutConfig = rolloutSnap.exists
      ? asRecord(rolloutSnap.data())
      : null;
  } catch {
    videoResultMailRolloutConfig = null;
  }

  const result: DrainVideoResultMailOutboxResult = {
    scanned: 0,
    delivered: 0,
    retried: 0,
    deadLettered: 0,
    skipped: 0,
    skipReasonCounts: {},
  };
  // W126 [M6]: 이 호출 안에서만 사는 크리에이터별 집계 캐시. 같은 크리에이터의 행이 한 배치에
  //   여러 개 있어도(일괄 반려) 51-doc 쿼리는 한 번만 돈다.
  const creatorDeclineCountsCache: CreatorDeclineCountsCache = new Map();

  // Audit-only recovery for provider-confirmed rows whose immutable receipt was interrupted.
  // Never resolves a recipient or calls the transport.
  const pendingEvidence = await adminDb.collection(SCP_VIDEO_RESULT_MAIL_OUTBOX_COLLECTION)
    .where("deliveryState", "==", "sent_evidence_pending").limit(batchLimit).get();
  for (const doc of pendingEvidence.docs) {
    const row = doc.data() ?? {};
    const attempts = Math.max(0, Math.trunc(Number(row.attempts ?? 0)));
    await persistVideoResultMailOutcome(doc, "mail_delivered", {
      deliveryState: "delivered", leaseExpiresAtIso: null, deliveredAtIso: asString(row.deliveredAtIso) || nowIso,
      updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp(),
    }, { attempts, providerMessageIdHash: asString(row.providerMessageIdHash) || null }, now);
    result.delivered += 1;
  }

  await reclaimStaleSendingOutboxRows(SCP_VIDEO_RESULT_MAIL_OUTBOX_COLLECTION, now);

  const due = await adminDb
    .collection(SCP_VIDEO_RESULT_MAIL_OUTBOX_COLLECTION)
    .where("deliveryState", "in", ["queued", "leased", "retryable_failed"])
    .orderBy("nextAttemptAtIso", "asc")
    .limit(batchLimit)
    .get();

  for (const doc of due.docs) {
    result.scanned += 1;
    const row = doc.data() ?? {};
    const state = asString(row.deliveryState);
    const leaseExpiresAtIso = asString(row.leaseExpiresAtIso);
    if (state === "leased" && leaseExpiresAtIso && leaseExpiresAtIso > nowIso) {
      result.skipped += 1;
      continue;
    }
    const nextAttemptAtIso = asString(row.nextAttemptAtIso);
    if (nextAttemptAtIso && nextAttemptAtIso > nowIso) {
      result.skipped += 1;
      continue;
    }

    const leased = await adminDb.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const freshData = fresh.data() ?? {};
      const freshState = asString(freshData.deliveryState);
      if (!["queued", "leased", "retryable_failed"].includes(freshState)) return false;
      const freshLease = asString(freshData.leaseExpiresAtIso);
      if (freshState === "leased" && freshLease && freshLease > nowIso) return false;
      const freshNext = asString(freshData.nextAttemptAtIso);
      if (freshNext && freshNext > nowIso) return false;
      // 발송 직전 정본 재검증(승인 행만): 큐 대기 중 철회/교체 리비전/후속 판정이 생겼으면 발송하지 않고
      // 같은 트랜잭션에서 cancelled 로 닫는다. 상태 문서가 없으면 종전 경로(review_state_missing 재시도)가 처리한다.
      if (asString(freshData.mailKind) === "content_approved") {
        const stateSnapshot = await tx.get(
          adminDb.collection(SCP_VIDEO_REVIEW_STATE_COLLECTION).doc(asString(freshData.submissionId)),
        );
        const staleReason = stateSnapshot.exists
          ? approvalMailRowStaleReason(freshData, asRecord(stateSnapshot.data()))
          : null;
        if (staleReason) {
          tx.set(doc.ref, {
            deliveryState: "cancelled",
            cancelled: "stale_approval",
            cancelReasonCode: staleReason,
            cancelledAtIso: nowIso,
            leaseExpiresAtIso: null,
            nextAttemptAtIso: null,
            updatedAtIso: nowIso,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          return "stale:" + staleReason;
        }
      }
      tx.set(
        doc.ref,
        {
          deliveryState: "leased",
          leaseExpiresAtIso: new Date(now.getTime() + VIDEO_RESULT_MAIL_LEASE_MS).toISOString(),
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return true;
    });
    if (typeof leased === "string") {
      incrementVideoResultMailSkipReason(result, `stale_approval:${leased.slice("stale:".length)}`);
      result.skipped += 1;
      continue;
    }
    if (!leased) {
      result.skipped += 1;
      continue;
    }

    const attempts = Math.max(0, Math.trunc(Number(row.attempts ?? 0)));
    const submissionId = asString(row.submissionId);
    const mailKind = asString(row.mailKind);
    let providerConfirmed = false;
    let providerMessageIdHash: string | null = null;
    let readinessPatch: Record<string, unknown> = {};
    let currentReasonCodes: string[] = [];

    try {
      const stateSnap = await adminDb
        .collection(SCP_VIDEO_REVIEW_STATE_COLLECTION)
        .doc(submissionId)
        .get();
      if (!stateSnap.exists) {
        throw Object.assign(new Error("review_state_missing"), { code: "review_state_missing", errorCode: "drain_video_result_mail_outbox_review_state_missing" });
      }
      const stateData = asRecord(stateSnap.data());
      // 클레임 이후 이 읽기 시점에 이미 무효인 승인 행은 수신자 해석·렌더 전에 닫는다.
      const staleAtRead = approvalMailRowStaleReason(row, stateData);
      if (staleAtRead) {
        await cancelStaleApprovalRow(doc, staleAtRead, now);
        incrementVideoResultMailSkipReason(result, `stale_approval:${staleAtRead}`);
        result.skipped += 1;
        continue;
      }
      const subject = asRecord(stateData.subject);
      const applicationId = asString(subject.applicationId);
      // W120 [적대 리뷰 R1]: 제목 승격 재료(`videos` 스냅샷)를 여기서 1건 조인한다.
      //   이걸 안 넘기면 resolveVideoTitleProjection 이 구조적으로 `youtube_snapshot` 을 낼 수 없어
      //   video_title 이 **항상** 중립 문구로 떨어지고, videos 조인을 타는 미리보기와 발송본이
      //   방향만 뒤집힌 채 계속 갈린다. 실패는 조용히 무시한다 — 제목은 있으면 좋은 값이지
      //   발송을 막을 이유가 아니다(원장 정본은 그대로 stateData 에서 온다).
      const referenceVideoId = asString(stateData.youtubeVideoId);
      const videoSnap = referenceVideoId
        ? await adminDb.collection("videos").doc(referenceVideoId).get().catch(() => null)
        : null;
      const reference = videoResultMailReferenceFromLedger(
        stateData,
        row,
        submissionId,
        videoSnap?.exists ? asRecord(videoSnap.data()) : null,
      );

      // NEW: the pure cutover predicate is computed from the row + rollout settings + drain clock.
      // Only the three video-result kinds consult it; the resolver ignores it for everything else.
      const recipient = await recipientResolver({
        applicationId,
        kind: mailKind,
        allowLegacyVideoResultMail: legacyVideoResultMailAllowed(
          row,
          videoResultMailRolloutConfig,
          now,
        ),
      });
      if (!recipient?.email) {
        // Recipient not resolvable (Portal material unbound) -> release lease, no attempt consumed.
        currentReasonCodes = ["recipient_unresolved"];
        incrementVideoResultMailSkipReason(result, "recipient_unresolved");
        readinessPatch = {
          recipientMaterialState: "pending",
          lastSkipReasonCodes: currentReasonCodes,
          recipientMaterialCheckedAtIso: nowIso,
        };
        await releaseVideoResultMailLease(doc, now, readinessPatch);
        result.skipped += 1;
        continue;
      }
      if (
        (mailKind === "content_rejected" ||
          mailKind === "content_changes_requested") &&
        !recipient.correctionLink
      ) {
        currentReasonCodes = ["correction_link_unavailable"];
        incrementVideoResultMailSkipReason(
          result,
          "correction_link_unavailable",
        );
      }
      readinessPatch = {
        recipientMaterialState: "resolved",
        lastSkipReasonCodes: currentReasonCodes,
        recipientMaterialCheckedAtIso: nowIso,
      };

      // W7-3c: `scp_mail_templates/video_result_mail` 문서가 있으면 그 템플릿이 이기고, 없거나
      // archived 면 위 코드 렌더가 fallback 이다(fail-closed — 세 판정 문안이 오늘과 동일).
      // 안내 문구는 계속 고정 코드 지도 결과만 변수로 넘긴다(운영자 자유 문장 유입 금지).
      const messageCode = asString(row.customerMessageCode) || asString(row.reasonCode);
      // W126: 반복 반려 에스컬레이션의 유일한 계수 지점. 수신자·재제출 링크가 정해진 **뒤**에
      //   센다 — 스킵될 행(recipient_unresolved)이 이 읽기를 사지 않게 하려는 배치다.
      const sameReasonDeclineCount = await countCreatorSameReasonDeclines({
        mailKind,
        reasonCode: asString(row.reasonCode),
        fluCreatorId: asString(subject.fluCreatorId),
        cache: creatorDeclineCountsCache,
      });
      const rendered = await renderVideoResultMailForDelivery({
        mailKind: mailKind as VideoReviewMailKind,
        messageCode,
        // 2026-09-05 다타이틀: 사유 문구의 게임명은 이 제출의 타이틀에서 온다. 원장에 gameId 가
        //   없는 기존 행(전량)은 프로그램 기본 타이틀로 읽혀 발송본이 종전과 동일하다.
        // B-2: subject.gameId 원문만 읽던 자리를 정본 헬퍼로 바꾼다 — judge 가 subject.game/
        //   subject.app 별칭으로 해석한 행도 여기서 같은 게임명으로 발송돼야 한다(레인 간
        //   판정 불일치 방지).
        programId: asString(subject.programId),
        gameId: resolveSubjectGameId(subject),
        // W102: 전이 시 검증·기록된 운영자 편집 문안(아웃박스 행 동봉) — 없으면 코드 지도 폴백.
        ...(asString(row.operatorMessage)
          ? { operatorMessage: asString(row.operatorMessage) }
          : {}),
        // W121: 전이 시 closed 카탈로그 검증을 끝낸 사유 태그 키(아웃박스 행 동봉). 문장은
        //   여기서 서버 사전이 만든다 — 아웃박스에는 키만 있으므로 자유 텍스트 유입 경로가 없다.
        ...(Array.isArray(row.reasonTagKeys) && row.reasonTagKeys.length
          ? { reasonTagKeys: row.reasonTagKeys as unknown[] }
          : {}),
        reference: sameReasonDeclineCount > 0
          ? { ...reference, sameReasonDeclineCount }
          : reference,
        ...(recipient.correctionLink
          ? { correctionLink: recipient.correctionLink }
          : {}),
      });
      const trackingId = `video-result-mail-${hashOpaque(`${submissionId}:${doc.id}`)}`.slice(0, 60);
      // 발송 직전 마지막 재검증(승인 행만, 읽기 1건): 수신자 해석·렌더 사이에 철회/교체 리비전/후속 판정이
      // 커밋됐으면 전송 어댑터를 부르지 않는다. 이 읽기와 SMTP 수락 사이의 잔여 경합은 분산 락 없이는
      // 제거할 수 없다 — 반려/변경요청 경로와 같은 의미론으로 수용한다.
      if (mailKind === "content_approved") {
        await options.beforeDispatchHook?.(doc);
        const finalSnap = await adminDb.collection(SCP_VIDEO_REVIEW_STATE_COLLECTION).doc(submissionId).get();
        // 상태 문서가 사라졌으면 fail-closed: 승인 근거를 확인할 수 없으므로 발송하지 않는다.
        const staleAtDispatch = finalSnap.exists
          ? approvalMailRowStaleReason(row, asRecord(finalSnap.data()))
          : "review_state_missing_at_dispatch";
        if (staleAtDispatch) {
          await cancelStaleApprovalRow(doc, staleAtDispatch, now);
          incrementVideoResultMailSkipReason(result, `stale_approval:${staleAtDispatch}`);
          result.skipped += 1;
          continue;
        }
      }
      const sendResult = await sendAdapter({
        to: recipient.email,
        subject: rendered.subject,
        // W8-1a: 와이어는 컴파일 입력(자산화 이전)을 싣는다 — sendEmail 이 유일한 컴파일러다.
        // W8-3: 텍스트 전용 발행본이면 html 을 싣지 않는다.
        text: rendered.text,
        ...(rendered.bodyFormat === "text" ? {} : { html: rendered.htmlSource || rendered.html }),
        trackingId,
        draftRef: `video-result-mail-${doc.id}`,
        approvalRef: `video-result-mail-${doc.id}-approval`,
        mailPurpose: "video_result_mail",
        // Task-94: legacy rows (written before this field existed) have no actorType — they were
        // always human decisions, so default to "human" preserves today's transactional exemption
        // byte-for-byte. Only a row explicitly stamped actorType:"ai" loses the exemption.
        actorType: row.actorType === "ai" ? "ai" : "human",
        templateKind: mailKind,
        gameId: "scp-automation",
        sourceRef: doc.ref.path,
        conversationId: `video-result-${submissionId}`,
        fenceApplicationId: applicationId || undefined,
        fenceSubmissionId: submissionId,
        fenceTraceId: asString(stateSnap.data()?.traceId) || undefined,
        fenceSendGeneration: attempts + 1,
      });

      if (sendResult.sent) {
        providerConfirmed = true;
        providerMessageIdHash = hashOpaque(sendResult.providerMessageId ?? trackingId);
        await persistVideoResultMailOutcome(
          doc,
          "mail_delivered",
          {
            ...readinessPatch,
            deliveryState: "delivered",
            attempts: attempts + 1,
            leaseExpiresAtIso: null,
            providerMessageIdHash,
            lastErrorCode: null,
            deliveredAtIso: nowIso,
            updatedAtIso: nowIso,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { attempts: attempts + 1 },
          now,
        );
        result.delivered += 1;
        continue;
      }
      const gateSkipReason = boundedVideoResultMailGateSkipReason(
        sendResult.reason,
      );
      if (gateSkipReason) {
        // Fence/provider gate skips release the lease with NO attempt consumption.
        currentReasonCodes = [...currentReasonCodes, gateSkipReason];
        incrementVideoResultMailSkipReason(result, gateSkipReason);
        readinessPatch = {
          ...readinessPatch,
          lastSkipReasonCodes: currentReasonCodes,
        };
        await releaseVideoResultMailLease(doc, now, readinessPatch);
        result.skipped += 1;
        continue;
      }
      const outcome = await applyVideoResultMailFailure(
        doc,
        attempts,
        sendResult.reason ?? "send_failed",
        now,
        readinessPatch,
      );
      if (outcome === "dead_letter") result.deadLettered += 1;
      else result.retried += 1;
    } catch (error) {
      if (providerConfirmed) {
        // The provider has accepted the mail. Never requeue it merely because local receipt
        // persistence failed; hold terminally for deterministic audit reconciliation without SMTP.
        await doc.ref.set({
          ...readinessPatch,
          deliveryState: "sent_evidence_pending",
          leaseExpiresAtIso: null,
          attempts: attempts + 1,
          providerMessageIdHash,
          lastErrorCode: `audit_pending:${errorCode(error)}`,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        result.delivered += 1;
        continue;
      }
      const outcome = await applyVideoResultMailFailure(
        doc,
        attempts,
        errorCode(error),
        now,
        readinessPatch,
      );
      if (outcome === "dead_letter") result.deadLettered += 1;
      else result.retried += 1;
    }
  }

  return result;
}

// ---- P6 content-submitted confirmation mail worker (FLU-0540) -----------------------------------
//
// Drains scp_content_submitted_mail_outbox (enqueued atomically with an accepted
// video.revision.submitted intake transaction in ./scpVideoRevisionIngress). Clones
// drainUidGuideOutbox's queued/retryable_failed/delivered/dead_letter lease-free claim + backoff
// shape exactly. Portal v2 events use the exact event-bound material endpoint; the pre-existing
// v3 ingress keeps its signed onboarding-material resolver instead of inventing a second Portal
// source contract.

const CONTENT_SUBMITTED_MAIL_MAX_ATTEMPTS = 6;

function contentSubmittedMailTrackingId(outboxDocId: string): string {
  return `content-submitted-${hashOpaque(outboxDocId)}`.slice(0, 60);
}

export type DrainContentSubmittedMailOutboxOptions = {
  batchLimit?: number;
  now?: Date;
  sendAdapter?: MailSendAdapter;
  recipientResolver?: RecipientResolver;
};

export type DrainContentSubmittedMailOutboxResult = {
  /** W62c-C1: 결정적 차단으로 **비소모 종결**된 건수. 재시도가 아니라 종결이므로 별도 축이다. */
  suppressed?: number;
  scanned: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  deliveryUnknown: number;
  skipped: number;
};

export async function drainContentSubmittedMailOutbox(
  options: DrainContentSubmittedMailOutboxOptions = {},
): Promise<DrainContentSubmittedMailOutboxResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const batchLimit = Math.min(Math.max(Math.trunc(options.batchLimit ?? 10), 1), 50);
  const sendAdapter = options.sendAdapter ?? defaultMailSendAdapter;
  const recipientResolver = options.recipientResolver ?? defaultRecipientResolver;

  const result: DrainContentSubmittedMailOutboxResult = {
    scanned: 0,
    delivered: 0,
    retried: 0,
    deadLettered: 0,
    deliveryUnknown: 0,
    skipped: 0,
  };

  await reclaimStaleSendingOutboxRows(
    SCP_CONTENT_SUBMITTED_MAIL_OUTBOX_COLLECTION,
    now,
    undefined,
    SCP_RECEIPT_MAIL_AUTOMATION_VERSION,
  );

  // A mixed-state batch can be monopolized in either direction: future retries used to hide
  // queued mail, while queued-first selection can hide due retries under continuous intake.
  // Reserve half the batch for the oldest due retries, then fill all remaining capacity with
  // queued rows before spilling additional due retries into unused capacity.
  const retryableCandidates = await adminDb
    .collection(SCP_CONTENT_SUBMITTED_MAIL_OUTBOX_COLLECTION)
    .where("automationVersion", "==", SCP_RECEIPT_MAIL_AUTOMATION_VERSION)
    .where("deliveryState", "in", ["retryable_failed", "recipient_pending"])
    .where("nextAttemptAtIso", "<=", nowIso)
    .orderBy("nextAttemptAtIso", "asc")
    .limit(Math.max(batchLimit * 4, 50))
    .get();
  const retryable = retryableCandidates.docs;
  const reservedRetrySlots = Math.floor(batchLimit / 2);
  const reservedRetries = retryable.slice(0, reservedRetrySlots);
  const queued = await adminDb
    .collection(SCP_CONTENT_SUBMITTED_MAIL_OUTBOX_COLLECTION)
    .where("automationVersion", "==", SCP_RECEIPT_MAIL_AUTOMATION_VERSION)
    .where("deliveryState", "==", "queued")
    .limit(batchLimit - reservedRetries.length)
    .get();
  const retrySpill = retryable.slice(reservedRetries.length, reservedRetries.length + (batchLimit - reservedRetries.length - queued.size));
  // A one-row budget cannot serve both ready classes in the same call. Select the
  // oldest ready row deterministically, preserving the caller cap while ensuring a
  // continuously replenished queued stream cannot permanently outrank an older retry.
  const queuedFirst = queued.docs[0];
  const retryFirst = retryable[0];
  const due = batchLimit === 1
    ? [
      !queuedFirst ? retryFirst : !retryFirst ? queuedFirst : (
        (asString(queuedFirst.data()?.createdAtIso) || asString(queuedFirst.data()?.updatedAtIso) || nowIso)
          <= asString(retryFirst.data()?.nextAttemptAtIso)
          ? queuedFirst
          : retryFirst
      ),
    ].filter((doc): doc is FirebaseFirestore.QueryDocumentSnapshot => Boolean(doc))
    : [...reservedRetries, ...queued.docs, ...retrySpill];

  for (const doc of due) {
    result.scanned += 1;
    const row = doc.data() ?? {};
    const applicationId = asString(row.applicationId);
    const programId = asString(row.programId);
    const sourceContract = asString(row.sourceContract);
    const campaignId = asString(row.campaignId);
    const outreachId = asString(row.outreachId);
    const portalCreatorId = asString(row.portalCreatorId);
    const fluCreatorId = asString(row.fluCreatorId);
    const partnerId = asString(row.partnerId);
    const enrollmentId = asString(row.enrollmentId);
    const videoSubmissionId = asString(row.videoSubmissionId);
    const traceId = asString(row.traceId);
    const eventId = asString(row.lastEventId);
    const revision = Math.max(0, Math.trunc(Number(row.videoRevision ?? 0)));
    const attempts = Math.max(0, Math.trunc(Number(row.attempts ?? 0)));
    const nextAttemptAtIso = asString(row.nextAttemptAtIso);
    if (!applicationId || !videoSubmissionId) {
      result.skipped += 1;
      continue;
    }
    if (nextAttemptAtIso && nextAttemptAtIso > nowIso) {
      result.skipped += 1;
      continue;
    }

    // Claim (queued/retryable_failed -> sending) so concurrent drains can never double-send.
    const claimed = await adminDb.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const freshData = fresh.data() ?? {};
      const freshState = asString(freshData.deliveryState);
      const freshNextAttemptAtIso = asString(freshData.nextAttemptAtIso);
      if (
        asString(freshData.automationVersion) !==
        SCP_RECEIPT_MAIL_AUTOMATION_VERSION
      ) {
        return false;
      }
      if (!["queued", "retryable_failed", "recipient_pending"].includes(freshState)) return false;
      if (freshState !== "queued" && (!freshNextAttemptAtIso || freshNextAttemptAtIso > nowIso)) return false;
      tx.set(doc.ref, { deliveryState: "sending", updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return true;
    });
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    const releaseClaim = async (
      lastErrorCode?: string,
      clearRecipientMaterial = false,
    ) => {
      await doc.ref.set(
        {
          deliveryState: asString(row.deliveryState) === "retryable_failed"
            ? "retryable_failed"
            : "queued",
          ...(lastErrorCode ? { lastErrorCode } : {}),
          ...(clearRecipientMaterial
            ? {
                recipientEmail: FieldValue.delete(),
                recipientMaterialState: "pending",
                recipientMaterialResolvedAtIso: FieldValue.delete(),
              }
            : {}),
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    };

    const recipient = await resolveReceiptRecipient(
      doc.ref,
      row,
      {
        applicationId,
        kind: "content_submitted",
        programId,
        sourceContract,
        eventId,
        traceId,
        videoSubmissionId,
        videoRevision: revision,
      },
      recipientResolver,
      now,
    );
    if (!recipient?.email) {
      result.skipped += 1;
      continue;
    }
    const resolvedTraceId = recipient.traceId || traceId;
    const resolvedCampaignId = recipient.campaignId || campaignId;
    const resolvedOutreachId = recipient.outreachId || outreachId;

    const trackingId = contentSubmittedMailTrackingId(doc.id);
    const sendResult = await sendAdapter({
      to: recipient.email,
      subject: renderedReceiptField(row, "renderedSubject", SCP_CONTENT_SUBMITTED_RECEIPT_SUBJECT),
      text: renderedReceiptField(row, "renderedText", SCP_CONTENT_SUBMITTED_RECEIPT_TEXT),
      ...(receiptTextOnly(row)
        ? {}
        : { html: renderedReceiptField(row, "renderedHtml", CONTENT_SUBMITTED_EMAIL_EN_HTML) }),
      trackingId,
      draftRef: `content-submitted-outbox-${doc.id}`,
      approvalRef: `content-submitted-outbox-${doc.id}-approval`,
      mailPurpose: "content_submitted",
      templateKind: "content_submitted",
      gameId: "scp-automation",
      sourceRef: doc.ref.path,
      conversationId: `content-submitted-${videoSubmissionId}`,
      programId,
      campaignId: resolvedCampaignId,
      mailType: "scp_content_submission_received",
      outreachId: resolvedOutreachId,
      applicationId,
      portalCreatorId,
      fluCreatorId,
      partnerId,
      enrollmentId,
      submissionId: videoSubmissionId,
      revision,
      traceId: resolvedTraceId,
      eventId,
      fenceApplicationId: applicationId,
      fenceSubmissionId: videoSubmissionId,
      fenceTraceId: resolvedTraceId || undefined,
      fenceSendGeneration: attempts + 1,
    });

    if (sendResult.sent) {
      await doc.ref.set(
        {
          deliveryState: "delivered",
          transport: "smtp",
          attempts: attempts + 1,
          providerMessageIdHash: canonicalProviderMessageIdHash(
            sendResult.providerMessageId ?? trackingId,
          ),
          recipientEmailHash: hashOpaque(recipient.email),
          recipientEmail: FieldValue.delete(),
          lastErrorCode: null,
          deliveredAtIso: nowIso,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      result.delivered += 1;
      continue;
    }
    if (isNonConsumingSendSkipReason(sendResult.reason)) {
      // Fence-denied or provider race: release with ZERO state/attempt mutation (Portal G005/G008).
      await releaseClaim(undefined, true);
      result.skipped += 1;
      continue;
    }
    if (sendResult.reason?.startsWith("delivery_unknown:")) {
      await doc.ref.set(
        {
          deliveryState: "delivery_unknown",
          attempts: attempts + 1,
          recipientEmail: FieldValue.delete(),
          lastErrorCode: sendResult.reason.slice(0, 120),
          nextAttemptAtIso: null,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      result.deliveryUnknown += 1;
      continue;
    }
    // W62c-C1 [두 리뷰 수렴 · 재시도의 **근인**]: 아래 일반 폴스루는 사유와 무관하게 시도를 소모한다.
    //   결정적 차단(억제 목록·미승인)은 다시 시도해도 결과가 같다 — 같은 수신자, 같은 목록이다.
    //   그런데 종전에는 그게 재시도 상한을 태우고 dead_letter 로 갔다(확인 메일 29건이 그렇게 죽었다).
    //   **비소모 종결**로 끊는다: 상태는 suppressed, attempts 는 **그대로 두고**, nextAttempt 는 null.
    //   attempts 를 올리지 않는 것이 핵심이다 — 차단은 "실패한 시도"가 아니라 "보내면 안 되는 것"이다.
    //   억제가 풀리면(예외 승인) 재큐잉은 운영 결정으로 하고, 그때 시도 예산이 온전히 남아 있다.
    if (sendResult.reason === "suppressed_or_unapproved_not_sent") {
      await doc.ref.set(
        {
          deliveryState: "suppressed",
          lastErrorCode: sendResult.reason.slice(0, 120),
          nextAttemptAtIso: null,
          recipientEmail: FieldValue.delete(),
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      result.suppressed = (result.suppressed ?? 0) + 1;
      continue;
    }

    const nextAttempts = attempts + 1;
    const deadLetter = nextAttempts >= CONTENT_SUBMITTED_MAIL_MAX_ATTEMPTS;
    await doc.ref.set(
      {
        deliveryState: deadLetter ? "dead_letter" : "retryable_failed",
        attempts: nextAttempts,
        ...(deadLetter ? { recipientEmail: FieldValue.delete() } : {}),
        lastErrorCode: (sendResult.reason ?? "send_failed").slice(0, 120),
        nextAttemptAtIso: deadLetter ? null : new Date(now.getTime() + Math.min(2 ** nextAttempts, 60) * 60_000).toISOString(),
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    if (deadLetter) result.deadLettered += 1;
    else result.retried += 1;
  }

  return result;
}

// ---- application-confirmed receipt mail worker --------------------------------------------------
//
// The source row is created only inside a new application acceptance transaction.
// A replay of an already-accepted event never recreates a missing row, so this drain
// cannot become a retroactive bulk-mail path.

const APPLICATION_CONFIRMED_MAIL_MAX_ATTEMPTS = 6;

function applicationConfirmedMailTrackingId(outboxDocId: string): string {
  return `application-confirmed-${hashOpaque(outboxDocId)}`.slice(0, 60);
}

export type DrainApplicationConfirmedMailOutboxOptions = {
  batchLimit?: number;
  now?: Date;
  sendAdapter?: MailSendAdapter;
  recipientResolver?: RecipientResolver;
};

export type DrainApplicationConfirmedMailOutboxResult = {
  /** W62c-C1: 결정적 차단으로 **비소모 종결**된 건수. 재시도가 아니라 종결이므로 별도 축이다. */
  suppressed?: number;
  scanned: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  deliveryUnknown: number;
  skipped: number;
};

export async function drainApplicationConfirmedMailOutbox(
  options: DrainApplicationConfirmedMailOutboxOptions = {},
): Promise<DrainApplicationConfirmedMailOutboxResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const batchLimit = Math.min(
    Math.max(Math.trunc(options.batchLimit ?? 10), 1),
    50,
  );
  const sendAdapter = options.sendAdapter ?? defaultMailSendAdapter;
  const recipientResolver =
    options.recipientResolver ?? defaultRecipientResolver;
  const result: DrainApplicationConfirmedMailOutboxResult = {
    scanned: 0,
    delivered: 0,
    retried: 0,
    deadLettered: 0,
    deliveryUnknown: 0,
    skipped: 0,
  };

  await reclaimStaleSendingOutboxRows(
    SCP_APPLICATION_CONFIRMED_MAIL_OUTBOX_COLLECTION,
    now,
    undefined,
    SCP_RECEIPT_MAIL_AUTOMATION_VERSION,
  );

  const retryableCandidates = await adminDb
    .collection(SCP_APPLICATION_CONFIRMED_MAIL_OUTBOX_COLLECTION)
    .where("automationVersion", "==", SCP_RECEIPT_MAIL_AUTOMATION_VERSION)
    .where("deliveryState", "in", ["retryable_failed", "recipient_pending"])
    .where("nextAttemptAtIso", "<=", nowIso)
    .orderBy("nextAttemptAtIso", "asc")
    .limit(Math.max(batchLimit * 4, 50))
    .get();
  const retryable = retryableCandidates.docs;
  const reservedRetrySlots = Math.floor(batchLimit / 2);
  const reservedRetries = retryable.slice(0, reservedRetrySlots);
  const queued = await adminDb
    .collection(SCP_APPLICATION_CONFIRMED_MAIL_OUTBOX_COLLECTION)
    .where("automationVersion", "==", SCP_RECEIPT_MAIL_AUTOMATION_VERSION)
    .where("deliveryState", "==", "queued")
    .limit(batchLimit - reservedRetries.length)
    .get();
  const retrySpill = retryable.slice(
    reservedRetries.length,
    reservedRetries.length +
      (batchLimit - reservedRetries.length - queued.size),
  );
  const queuedFirst = queued.docs[0];
  const retryFirst = retryable[0];
  const due =
    batchLimit === 1
      ? [
          !queuedFirst
            ? retryFirst
            : !retryFirst
              ? queuedFirst
              : (asString(queuedFirst.data()?.createdAtIso) ||
                    asString(queuedFirst.data()?.updatedAtIso) ||
                    nowIso) <= asString(retryFirst.data()?.nextAttemptAtIso)
                ? queuedFirst
                : retryFirst,
        ].filter(
          (doc): doc is FirebaseFirestore.QueryDocumentSnapshot =>
            Boolean(doc),
        )
      : [...reservedRetries, ...queued.docs, ...retrySpill];

  for (const doc of due) {
    result.scanned += 1;
    const row = doc.data() ?? {};
    const applicationId = asString(row.applicationId);
    const programId = asString(row.programId);
    const sourceContract = asString(row.sourceContract);
    const campaignId = asString(row.campaignId);
    const outreachId = asString(row.outreachId);
    const portalCreatorId = asString(row.portalCreatorId);
    const fluCreatorId = asString(row.fluCreatorId);
    const partnerId = asString(row.partnerId);
    const enrollmentId = asString(row.enrollmentId);
    const traceId = asString(row.traceId);
    const eventId = asString(row.lastEventId);
    const attempts = Math.max(0, Math.trunc(Number(row.attempts ?? 0)));
    const nextAttemptAtIso = asString(row.nextAttemptAtIso);
    if (!applicationId || !programId) {
      result.skipped += 1;
      continue;
    }
    if (nextAttemptAtIso && nextAttemptAtIso > nowIso) {
      result.skipped += 1;
      continue;
    }

    const claimed = await adminDb.runTransaction(async (transaction) => {
      const fresh = await transaction.get(doc.ref);
      const freshData = fresh.data() ?? {};
      const state = asString(freshData.deliveryState);
      const retryAt = asString(freshData.nextAttemptAtIso);
      if (
        asString(freshData.automationVersion) !==
        SCP_RECEIPT_MAIL_AUTOMATION_VERSION
      ) {
        return false;
      }
      if (!["queued", "retryable_failed", "recipient_pending"].includes(state)) return false;
      if (state !== "queued" && (!retryAt || retryAt > nowIso)) {
        return false;
      }
      transaction.set(
        doc.ref,
        {
          deliveryState: "sending",
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return true;
    });
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    const releaseClaim = async (
      lastErrorCode?: string,
      clearRecipientMaterial = false,
    ) => {
      await doc.ref.set(
        {
          deliveryState:
            asString(row.deliveryState) === "retryable_failed"
              ? "retryable_failed"
              : "queued",
          ...(lastErrorCode ? { lastErrorCode } : {}),
          ...(clearRecipientMaterial
            ? {
                recipientEmail: FieldValue.delete(),
                recipientMaterialState: "pending",
                recipientMaterialResolvedAtIso: FieldValue.delete(),
              }
            : {}),
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    };

    const recipient = await resolveReceiptRecipient(
      doc.ref,
      row,
      {
        applicationId,
        kind: "application_confirmed",
        programId,
        sourceContract,
        eventId,
      },
      recipientResolver,
      now,
    );
    if (!recipient?.email) {
      result.skipped += 1;
      continue;
    }
    const resolvedTraceId = recipient.traceId || traceId;
    const resolvedCampaignId = recipient.campaignId || campaignId;
    const resolvedOutreachId = recipient.outreachId || outreachId;

    const trackingId = applicationConfirmedMailTrackingId(doc.id);
    const sendResult = await sendAdapter({
      to: recipient.email,
      subject: renderedReceiptField(row, "renderedSubject", SCP_APPLICATION_CONFIRMED_SUBJECT),
      text: renderedReceiptField(row, "renderedText", [
        "Hello from Super Creator Partners,",
        "",
        "Your application is confirmed. You can start creating and submit your content through the SCP Creator Portal.",
        "",
        "We're excited to create with you.",
      ].join("\n")),
      ...(receiptTextOnly(row)
        ? {}
        : { html: renderedReceiptField(row, "renderedHtml", SCP_APPLICATION_CONFIRMED_EMAIL_EN_HTML) }),
      trackingId,
      draftRef: `application-confirmed-outbox-${doc.id}`,
      approvalRef: `application-confirmed-outbox-${doc.id}-approval`,
      mailPurpose: "application_confirmed",
      templateKind: "scp_application_confirmed",
      mailType: "scp_application_confirmed",
      gameId: "scp-automation",
      sourceRef: doc.ref.path,
      conversationId: `application-confirmed-${applicationId}`,
      programId,
      campaignId: resolvedCampaignId,
      outreachId: resolvedOutreachId,
      applicationId,
      portalCreatorId,
      fluCreatorId,
      partnerId,
      enrollmentId,
      traceId: resolvedTraceId,
      eventId,
      fenceApplicationId: applicationId,
      fenceTraceId: resolvedTraceId || undefined,
      fenceSendGeneration: attempts + 1,
    });

    if (sendResult.sent) {
      await doc.ref.set(
        {
          deliveryState: "delivered",
          transport: "smtp",
          attempts: attempts + 1,
          providerMessageIdHash: canonicalProviderMessageIdHash(
            sendResult.providerMessageId ?? trackingId,
          ),
          recipientEmailHash: hashOpaque(recipient.email),
          recipientEmail: FieldValue.delete(),
          lastErrorCode: null,
          deliveredAtIso: nowIso,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      result.delivered += 1;
      continue;
    }
    if (isNonConsumingSendSkipReason(sendResult.reason)) {
      await releaseClaim(undefined, true);
      result.skipped += 1;
      continue;
    }
    if (sendResult.reason?.startsWith("delivery_unknown:")) {
      await doc.ref.set(
        {
          deliveryState: "delivery_unknown",
          attempts: attempts + 1,
          recipientEmail: FieldValue.delete(),
          lastErrorCode: sendResult.reason.slice(0, 120),
          nextAttemptAtIso: null,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      result.deliveryUnknown += 1;
      continue;
    }

    // W62c-C1 [두 리뷰 수렴 · 재시도의 **근인**]: 아래 일반 폴스루는 사유와 무관하게 시도를 소모한다.
    //   결정적 차단(억제 목록·미승인)은 다시 시도해도 결과가 같다 — 같은 수신자, 같은 목록이다.
    //   그런데 종전에는 그게 재시도 상한을 태우고 dead_letter 로 갔다(확인 메일 29건이 그렇게 죽었다).
    //   **비소모 종결**로 끊는다: 상태는 suppressed, attempts 는 **그대로 두고**, nextAttempt 는 null.
    //   attempts 를 올리지 않는 것이 핵심이다 — 차단은 "실패한 시도"가 아니라 "보내면 안 되는 것"이다.
    //   억제가 풀리면(예외 승인) 재큐잉은 운영 결정으로 하고, 그때 시도 예산이 온전히 남아 있다.
    if (sendResult.reason === "suppressed_or_unapproved_not_sent") {
      await doc.ref.set(
        {
          deliveryState: "suppressed",
          lastErrorCode: sendResult.reason.slice(0, 120),
          nextAttemptAtIso: null,
          recipientEmail: FieldValue.delete(),
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      result.suppressed = (result.suppressed ?? 0) + 1;
      continue;
    }

    const nextAttempts = attempts + 1;
    const deadLetter =
      nextAttempts >= APPLICATION_CONFIRMED_MAIL_MAX_ATTEMPTS;
    await doc.ref.set(
      {
        deliveryState: deadLetter
          ? "dead_letter"
          : "retryable_failed",
        attempts: nextAttempts,
        ...(deadLetter ? { recipientEmail: FieldValue.delete() } : {}),
        lastErrorCode: (sendResult.reason ?? "send_failed").slice(0, 120),
        nextAttemptAtIso: deadLetter
          ? null
          : new Date(
              now.getTime() + Math.min(2 ** nextAttempts, 60) * 60_000,
            ).toISOString(),
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    if (deadLetter) result.deadLettered += 1;
    else result.retried += 1;
  }

  return result;
}

// ---- W91 [헤세 · admin-bridge 승인 메일] §login_approved 드레인 --------------------------------
//
// scpPortalCreatorCommandHandler 가 `application.approve` 성공 시 적재한 의도를 소비한다. 형상은
// scpUidGuideMailWorker.drainUidGuideOutbox 와 같은 이유로 같다 — 수신자별 값(`loginUrl`)이
// Portal MATERIAL 회수 결과라 enqueue 시점에는 없고, 여기(발송 직전)에서만 정해진다. 그래서 템플릿
// 렌더도 이 드레인이 한다(enqueue-time 스냅샷이 아니라 send-time 오버라이드 렌더 — uid_guide 와
// 동일 패턴, resolveScpMailTemplateOverride).

const LOGIN_APPROVED_MAIL_MAX_ATTEMPTS = 6;

function isSafeLoginUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

const LOGIN_APPROVED_FALLBACK_HTML = buildScpBrandedMailHtml({
  heading: "Your login has been approved",
  paragraphs: [
    "Great news — your login request for the Creator Dashboard has been approved!",
    "You can now log in using the button below.",
    "If you have any questions, feel free to reach out anytime. Thank you!",
  ],
  cta: { label: "Log in to the Creator Dashboard", href: "{{loginUrl}}" },
  // 헤세 확정(26-08-26): 발신 브랜딩은 "Super Creator Partners" 로 통일 — "Supercent" 단독 표기 금지.
  closing: ["Best regards,", "Super Creator Partners"],
});

// Exported (not just used internally) so template-render tests can assert against the REAL fallback
// copy instead of a duplicated literal that could silently drift from what actually sends.
export function renderLoginApprovedMailFallback(): { subject: string; text: string; html: string } {
  return {
    subject: "[Super Creator Partners] Your Login Has Been Approved!",
    text: [
      "Hey there 🙂",
      "",
      "Great news — your login request for the Creator Dashboard has been approved!",
      "You can now log in using this link: {{loginUrl}}",
      "If you have any questions, feel free to reach out anytime. Thank you!",
      "",
      "Best regards,",
      "Super Creator Partners",
    ].join("\n"),
    html: LOGIN_APPROVED_FALLBACK_HTML,
  };
}

export type DrainLoginApprovedMailOutboxOptions = {
  batchLimit?: number;
  now?: Date;
  sendAdapter?: MailSendAdapter;
  materialFetcher?: typeof fetchScpPortalReceiptMailMaterial;
};

export type DrainLoginApprovedMailOutboxResult = {
  scanned: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  skipped: number;
};

export async function drainLoginApprovedMailOutbox(
  options: DrainLoginApprovedMailOutboxOptions = {},
): Promise<DrainLoginApprovedMailOutboxResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const batchLimit = Math.min(Math.max(Math.trunc(options.batchLimit ?? 10), 1), 50);
  const sendAdapter = options.sendAdapter ?? defaultMailSendAdapter;
  const materialFetcher = options.materialFetcher ?? fetchScpPortalReceiptMailMaterial;

  const result: DrainLoginApprovedMailOutboxResult = { scanned: 0, delivered: 0, retried: 0, deadLettered: 0, skipped: 0 };

  await reclaimStaleSendingOutboxRows(SCP_LOGIN_APPROVED_MAIL_OUTBOX_COLLECTION, now);

  const due = await adminDb
    .collection(SCP_LOGIN_APPROVED_MAIL_OUTBOX_COLLECTION)
    .where("deliveryState", "in", ["queued", "retryable_failed"])
    .limit(batchLimit)
    .get();

  for (const doc of due.docs) {
    result.scanned += 1;
    const row = doc.data() ?? {};
    const applicationId = asString(row.applicationId);
    const programId = asString(row.programId);
    const eventId = asString(row.lastEventId);
    const attempts = Math.max(0, Math.trunc(Number(row.attempts ?? 0)));
    if (!applicationId || !programId || !eventId) {
      result.skipped += 1;
      continue;
    }

    const claimed = await adminDb.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const freshState = asString(fresh.data()?.deliveryState);
      if (freshState !== "queued" && freshState !== "retryable_failed") return false;
      tx.set(doc.ref, { deliveryState: "sending", updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return true;
    });
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    const releaseClaim = async () => {
      await doc.ref.set(
        { deliveryState: asString(row.deliveryState, "queued") || "queued", updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    };

    const material = await materialFetcher({
      schemaVersion: "scp.receipt-mail.delivery-material-request.v1",
      kind: "login_approved",
      sourceContract: "scp.flu.admin-bridge.v1",
      sourceEventId: eventId,
      applicationId,
      programId,
    });
    if (!material?.recipientEmail || !material.loginUrl) {
      // Material unavailable/rejected: stay fail-closed with NO attempt mutation.
      await releaseClaim();
      result.skipped += 1;
      continue;
    }

    const recordRowFailure = async (reason: string) => {
      if (isTerminalSuppressionReason(reason)) {
        await doc.ref.set({
          deliveryState: "suppressed",
          lastErrorCode: reason.slice(0, 120),
          nextAttemptAtIso: null,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return;
      }
      const nextAttempts = attempts + 1;
      const deadLetter = nextAttempts >= LOGIN_APPROVED_MAIL_MAX_ATTEMPTS;
      await doc.ref.set(
        {
          deliveryState: deadLetter ? "dead_letter" : "retryable_failed",
          attempts: nextAttempts,
          lastErrorCode: reason.slice(0, 120),
          nextAttemptAtIso: deadLetter ? null : new Date(now.getTime() + Math.min(2 ** nextAttempts, 60) * 60_000).toISOString(),
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      if (deadLetter) result.deadLettered += 1;
      else result.retried += 1;
    };

    if (!isSafeLoginUrl(material.loginUrl)) {
      await recordRowFailure("login_url_scheme_rejected");
      continue;
    }

    let rendered: Awaited<ReturnType<typeof resolveScpMailTemplateOverride>>;
    let sendResult: Awaited<ReturnType<MailSendAdapter>>;
    try {
      const fallback = renderLoginApprovedMailFallback();
      rendered = await resolveScpMailTemplateOverride(
        "login_approved",
        fallback,
        { loginUrl: material.loginUrl },
      );
    } catch (error) {
      await recordRowFailure(`render_failed:${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const trackingId = `login-approved-${hashOpaque(`${applicationId}:${eventId}`).slice(0, 40)}`;
    try {
      sendResult = await sendAdapter({
        to: material.recipientEmail,
        subject: rendered.subject,
        text: rendered.text,
        ...(rendered.bodyFormat === "text" ? {} : { html: rendered.htmlSource || rendered.html }),
        trackingId,
        draftRef: `login-approved-outbox-${doc.id}`,
        approvalRef: `login-approved-outbox-${doc.id}-approval`,
        mailPurpose: "login_approved",
        templateKind: "login_approved",
        gameId: "scp-automation",
        sourceRef: doc.ref.path,
        conversationId: `login-approved-${applicationId}`,
        programId,
        applicationId,
        eventId,
        fenceApplicationId: applicationId,
        fenceSendGeneration: attempts + 1,
      });
    } catch (error) {
      await recordRowFailure(`send_threw:${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (sendResult.sent) {
      await doc.ref.set(
        {
          deliveryState: "delivered",
          transport: "smtp",
          attempts: attempts + 1,
          providerMessageIdHash: canonicalProviderMessageIdHash(sendResult.providerMessageId ?? trackingId),
          recipientEmailHash: hashOpaque(material.recipientEmail),
          lastErrorCode: null,
          deliveredAtIso: nowIso,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      result.delivered += 1;
      continue;
    }
    if (isNonConsumingSendSkipReason(sendResult.reason)) {
      await releaseClaim();
      result.skipped += 1;
      continue;
    }
    await recordRowFailure(sendResult.reason ?? "send_failed");
  }

  return result;
}

// ---- §login_rejected 드레인 (헤세 확정 카피, 26-08-27) -----------------------------------------
//
// scpPortalCreatorCommandHandler 가 `application.reject` 성공 시(메일 대상 사유 2종만) 적재한
// 의도를 소비한다. login_approved 드레인의 미러지만 두 가지가 다르다:
//  ① 수신자: 전용 material kind "application_rejected"(계약 26-08-27, cod-92 합의)로 회수한다.
//     v1 delivery-material 사다리는 못 쓴다 — canEnterOnboarding 게이트가 rejected 를 403 으로
//     하드 차단한다(포털 실측, 전수 146/146 v1 계보). 회수 키는 결정적 파생 앵커
//     (loginRejectedMaterialEventId)이고 포털 reject 트랜잭션이 같은 키로 영수증을 민팅한다.
//     포털 레인이 열리기 전에는 회수가 null → 비소모 skip(fail-closed, queued 유지) — flu 를
//     먼저 배포해도 안전하고, 포털 레인 + GA 개방 후 별도 재배포 없이 발송이 시작된다.
//  ② 템플릿: 사유(reasonCode)별로 kind 가 갈린다. 행의 reasonCode 가 분기 정본이다 —
//     포털은 reasonCode 를 검증 후 버리므로(포털 실측 26-08-27) 이 행 밖에는 기록이 없다.

const LOGIN_REJECTED_MAIL_MAX_ATTEMPTS = 6;

// 카피는 헤세 원문 그대로(26-08-27 확정). "The Supercent Team" 맺음은 셸 푸터가 담당한다 —
// buildScpBrandedMailHtml 이 항상 "Thank you. / The Supercent Team" 을 푸터에 싣는다.
// ("Supercent 단독 맺음 금지" 브랜딩 룰의 예외: 이 맺음은 헤세가 직접 쓴 카피다.)
const LOGIN_REJECTED_SUBSCRIBER_MINIMUM_PARAGRAPHS = [
  "Thank you for your interest in joining the Super Creator Partners program!",
  "We have carefully reviewed your application for the Creator Dashboard. Unfortunately, we are unable to approve your login request at this time because your channel currently does not meet our minimum requirement of 100+ subscribers.",
  "We truly appreciate your effort and passion for creating content. Once your channel reaches 100 subscribers, we warmly invite you to apply again!",
  "If you have any questions or need further clarification, feel free to reach out to us anytime.",
] as const;

const LOGIN_REJECTED_CHANNEL_NOT_FOUND_PARAGRAPHS = [
  "Thank you for applying to the Super Creator Partners program!",
  "While reviewing your application for the Creator Dashboard, we were unable to locate your channel using the link or information provided.",
  "As a result, we could not approve your login request at this stage. Please double-check your channel URL or username and submit a new application so we can review it again.",
  "If you believe this was an error or if you need assistance, please feel free to reach out to us anytime.",
] as const;

const LOGIN_REJECTED_FALLBACKS: Partial<Record<
  LoginRejectedMailReasonCode,
  { subject: string; paragraphs: readonly string[] }
>> = {
  subscriber_below_minimum: {
    subject: "[Super Creator Partners] Update on Your Creator Dashboard Application",
    paragraphs: LOGIN_REJECTED_SUBSCRIBER_MINIMUM_PARAGRAPHS,
  },
  channel_not_found: {
    subject: "[Super Creator Partners] Action Required: Unable to Locate Your Channel",
    paragraphs: LOGIN_REJECTED_CHANNEL_NOT_FOUND_PARAGRAPHS,
  },
};

// Task-35: moved to ./scpReceiptMailOutbox (leaf module) so scripts/scp-login-rejected-portal-inventory.mjs can share it too; re-exported above.

// Exported (not just used internally) so template-render tests can assert against the REAL fallback
// copy instead of a duplicated literal that could silently drift from what actually sends.
export function renderLoginRejectedMailFallback(
  reasonCode: LoginRejectedMailReasonCode,
  publicReasonText?: string,
): { subject: string; text: string; html: string } {
  const fallback = LOGIN_REJECTED_FALLBACKS[reasonCode] ?? {
    subject: "[Super Creator Partners] Update on Your Creator Dashboard Application",
    paragraphs: [
      "Thank you for your interest in joining the Super Creator Partners program.",
      publicReasonText || "After reviewing your application, we are unable to approve your login request at this time.",
      "You may apply again when the issue has been resolved.",
      "If you have any questions or need further clarification, feel free to reach out to us anytime.",
    ],
  };
  return {
    subject: fallback.subject,
    text: [
      "Super Creator Partners / Update on Your Application",
      "",
      ...fallback.paragraphs,
      "",
      "Thank you,",
      "The Supercent Team",
    ].join("\n"),
    html: buildScpBrandedMailHtml({
      heading: "Update on Your Application",
      paragraphs: fallback.paragraphs,
    }),
  };
}

export type DrainLoginRejectedMailOutboxOptions = {
  batchLimit?: number;
  now?: Date;
  sendAdapter?: MailSendAdapter;
  materialFetcher?: typeof fetchScpPortalReceiptMailMaterial;
};

export type DrainLoginRejectedMailOutboxResult = {
  scanned: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  skipped: number;
};

export async function drainLoginRejectedMailOutbox(
  options: DrainLoginRejectedMailOutboxOptions = {},
): Promise<DrainLoginRejectedMailOutboxResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const batchLimit = Math.min(Math.max(Math.trunc(options.batchLimit ?? 10), 1), 50);
  const sendAdapter = options.sendAdapter ?? defaultMailSendAdapter;
  const materialFetcher = options.materialFetcher ?? fetchScpPortalReceiptMailMaterial;

  const result: DrainLoginRejectedMailOutboxResult = { scanned: 0, delivered: 0, retried: 0, deadLettered: 0, skipped: 0 };

  await reclaimStaleSendingOutboxRows(SCP_LOGIN_REJECTED_MAIL_OUTBOX_COLLECTION, now);

  const due = await adminDb
    .collection(SCP_LOGIN_REJECTED_MAIL_OUTBOX_COLLECTION)
    .where("deliveryState", "in", ["queued", "retryable_failed"])
    .limit(batchLimit)
    .get();

  for (const doc of due.docs) {
    result.scanned += 1;
    const row = doc.data() ?? {};
    const applicationId = asString(row.applicationId);
    const programId = asString(row.programId);
    const reasonCode = asString(row.reasonCode);
    const attempts = Math.max(0, Math.trunc(Number(row.attempts ?? 0)));
    if (!applicationId || !programId || !reasonCode) {
      result.skipped += 1;
      continue;
    }

    const claimed = await adminDb.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const freshState = asString(fresh.data()?.deliveryState);
      if (freshState !== "queued" && freshState !== "retryable_failed") return false;
      tx.set(doc.ref, { deliveryState: "sending", updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return true;
    });
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    const releaseClaim = async () => {
      await doc.ref.set(
        { deliveryState: asString(row.deliveryState, "queued") || "queued", updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    };

    if (!isLoginRejectedMailReasonCode(reasonCode)) {
      // enqueue 는 아는 사유만 쓴다 — 이 상태는 수동 조작/드리프트다. 재시도해도 결과가 같으니
      // 즉시 종결한다(queued 영구 잔류 + 매분 재스캔 루프 방지).
      await doc.ref.set(
        {
          deliveryState: "dead_letter",
          lastErrorCode: "unknown_reason_code",
          nextAttemptAtIso: null,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      result.deadLettered += 1;
      continue;
    }
    const templateKind = LOGIN_REJECTED_REASON_TEMPLATE_KINDS[reasonCode];
    const publicReasonText = sanitizeLoginRejectedPublicReasonText(row.publicReasonText);
    if (templateKind === "login_rejected_public_reason" && !publicReasonText) {
      await doc.ref.set(
        {
          deliveryState: "dead_letter",
          lastErrorCode: "invalid_public_reason_text",
          nextAttemptAtIso: null,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      result.deadLettered += 1;
      continue;
    }

    const sourceEventId = loginRejectedMaterialEventId(applicationId);
    const material = await materialFetcher({
      schemaVersion: "scp.receipt-mail.delivery-material-request.v1",
      kind: "application_rejected",
      sourceContract: "scp.flu.admin-bridge.v1",
      sourceEventId,
      applicationId,
      programId,
    });
    if (!material?.recipientEmail) {
      // Material unavailable/rejected: stay fail-closed with NO attempt mutation.
      // (포털 application_rejected 레인 미배포 상태에서도 이 분기다 — queued 유지.)
      await releaseClaim();
      result.skipped += 1;
      continue;
    }
    const recipient = await resolveReceiptRecipient(
      doc.ref,
      row,
      {
        applicationId,
        kind: "application_rejected",
        programId,
        sourceContract: "scp.flu.admin-bridge.v1",
        eventId: sourceEventId,
      },
      async () => ({
        email: material.recipientEmail,
        emailSha256: material.recipientEmailSha256,
      }),
      now,
    );
    if (!recipient?.email) {
      result.skipped += 1;
      continue;
    }

    const recordRowFailure = async (reason: string) => {
      if (isTerminalSuppressionReason(reason)) {
        await doc.ref.set({
          deliveryState: "suppressed",
          lastErrorCode: reason.slice(0, 120),
          nextAttemptAtIso: null,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return;
      }
      const nextAttempts = attempts + 1;
      const deadLetter = nextAttempts >= LOGIN_REJECTED_MAIL_MAX_ATTEMPTS;
      await doc.ref.set(
        {
          deliveryState: deadLetter ? "dead_letter" : "retryable_failed",
          attempts: nextAttempts,
          lastErrorCode: reason.slice(0, 120),
          nextAttemptAtIso: deadLetter ? null : new Date(now.getTime() + Math.min(2 ** nextAttempts, 60) * 60_000).toISOString(),
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      if (deadLetter) result.deadLettered += 1;
      else result.retried += 1;
    };

    let rendered: Awaited<ReturnType<typeof resolveScpMailTemplateOverride>>;
    let sendResult: Awaited<ReturnType<MailSendAdapter>>;
    try {
      rendered = await resolveScpMailTemplateOverride(
        templateKind,
        renderLoginRejectedMailFallback(reasonCode, publicReasonText),
        publicReasonText ? { public_reason_text: publicReasonText } : {},
      );
    } catch (error) {
      await recordRowFailure(`render_failed:${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const trackingId = `login-rejected-${hashOpaque(`${applicationId}:${reasonCode}`).slice(0, 40)}`;
    try {
      sendResult = await sendAdapter({
        to: recipient.email,
        subject: rendered.subject,
        text: rendered.text,
        ...(rendered.bodyFormat === "text" ? {} : { html: rendered.htmlSource || rendered.html }),
        trackingId,
        draftRef: `login-rejected-outbox-${doc.id}`,
        approvalRef: `login-rejected-outbox-${doc.id}-approval`,
        mailPurpose: "login_rejected",
        templateKind,
        gameId: "scp-automation",
        sourceRef: doc.ref.path,
        conversationId: `login-rejected-${applicationId}`,
        programId,
        applicationId,
        fenceApplicationId: applicationId,
        fenceSendGeneration: attempts + 1,
      });
    } catch (error) {
      await recordRowFailure(`send_threw:${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (sendResult.sent) {
      await doc.ref.set(
        {
          deliveryState: "delivered",
          transport: "smtp",
          attempts: attempts + 1,
          providerMessageIdHash: canonicalProviderMessageIdHash(sendResult.providerMessageId ?? trackingId),
          recipientEmailHash: hashOpaque(recipient.email),
          recipientEmail: FieldValue.delete(),
          lastErrorCode: null,
          deliveredAtIso: nowIso,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      result.delivered += 1;
      continue;
    }
    if (isNonConsumingSendSkipReason(sendResult.reason)) {
      await releaseClaim();
      result.skipped += 1;
      continue;
    }
    await recordRowFailure(sendResult.reason ?? "send_failed");
  }

  return result;
}

// ---- W62c-C2 §영상 제출 재촉 메일 드레인 ------------------------------------------------------
//
// 두 리뷰 수렴 지적: 아웃박스와 버튼만 있고 **소비자가 없었다.** 여기서 그 구멍을 닫는다.
// 형상은 확인 메일 드레인을 그대로 따른다 — 클레임(트랜잭션) → 수신자 해석 → sendAdapter
// (승인·쿼터·suppression·dedup 전 게이트를 지나는 그 어댑터) → 결과별 상태 전이.
// C1 의 **비소모 종결** 분기를 처음부터 포함한다: 결정적 차단은 재시도 예산을 태우지 않는다.

/**
 * W62e-MAJ-A [Codex 델타]: 결정적 차단의 **비소모 종결** 판정을 한 곳에 둔다.
 * 종전에는 확인 메일·콘텐츠 제출 두 레인에만 분기가 있었다 — 나머지 레인은 같은 차단에
 * 여전히 재시도 예산을 태운다. 레인마다 분기를 복제하면 다음 레인에서 또 빠진다.
 *
 * ⚠️ 이 판정은 **결정적 억제만** 참이다(W62e-CRIT-A). 일시 잠금(긴급 셧다운·아웃바운드 잠금·
 * 승인 미비·휴먼 게이트)은 분류기가 `mail_blocked_retryable:` 로 내려주므로 여기서 거짓이 되고,
 * 각 레인의 기존 재시도 경로를 그대로 탄다.
 */
export function isTerminalSuppressionReason(reason: unknown): boolean {
  return reason === "suppressed_or_unapproved_not_sent";
}

/** W72-A: 캡/잠금으로 유예된 전송인가. `quota_deferred:` 접두사는 어댑터만 만든다. */
export function isQuotaDeferredReason(reason: unknown): boolean {
  return typeof reason === "string" && reason.startsWith("quota_deferred:");
}

/**
 * W72-A [리더 승인 · 헤세 추가 조건 "무한 재시도 금지"]: 캡/잠금 유예를 **비소모**로 처리하되
 * 유예 자체에 상한을 건다. `attempts` 는 건드리지 않고 `quotaDeferrals` 만 올린다 —
 * 그래야 캡이 풀렸을 때 전송 예산이 온전히 남아 있다.
 *
 * 상한을 넘으면 `handled:false` 를 돌려주고 호출자의 **기존 소비 경로**로 떨어진다.
 * 즉 최악의 경우에도 종전과 같은 곳에서 끝난다 — 새 종결 상태를 만들지 않는다.
 *
 * 백오프는 `attempts` 가 아니라 `quotaDeferrals` 기준이다(attempts 가 안 오르므로 종전 식은 상수가 된다).
 */
export async function applyQuotaDeferral(input: {
  ref: FirebaseFirestore.DocumentReference;
  row: Record<string, unknown>;
  reason: string;
  now: Date;
  deferralCap: number;
}): Promise<{ handled: boolean; deferrals: number }> {
  const deferrals = Math.max(0, Math.trunc(Number(input.row.quotaDeferrals ?? 0)));
  const next = deferrals + 1;
  if (input.deferralCap <= 0 || next > input.deferralCap) {
    return { handled: false, deferrals };
  }
  const nowIso = input.now.toISOString();
  await input.ref.set({
    deliveryState: "retryable_failed",
    // attempts 를 **의도적으로 건드리지 않는다**. 이 한 줄이 이 수리의 전부다.
    quotaDeferrals: next,
    lastErrorCode: input.reason.slice(0, 120),
    nextAttemptAtIso: new Date(
      input.now.getTime() + Math.min(2 ** next, 60) * 60_000,
    ).toISOString(),
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { handled: true, deferrals: next };
}

/**
 * W72 [R1 P1-1]: **소비 종결**을 한 곳에 둔다.
 *
 * 종전에는 드레인 루프 꼬리에만 있어서, 루프 중간에서 `continue` 로 빠지는 분기(레인 캡 차단)는
 * 유예 상한을 넘겨도 여기 도달하지 못했다 — 행이 통째로 불변인 채 매 스케줄 재조회됐다.
 * "유예 상한 초과 시 기존 소비 경로로 떨어진다"는 계약이 그 분기에서 거짓이었다.
 */
export async function applyConsumingFailure(input: {
  ref: FirebaseFirestore.DocumentReference;
  attempts: number;
  reason: string;
  now: Date;
  maxAttempts: number;
}): Promise<{ deadLetter: boolean }> {
  const nextAttempts = input.attempts + 1;
  const deadLetter = nextAttempts >= input.maxAttempts;
  const nowIso = input.now.toISOString();
  await input.ref.set({
    deliveryState: deadLetter ? "dead_letter" : "retryable_failed",
    attempts: nextAttempts,
    ...(deadLetter ? { recipientEmail: FieldValue.delete() } : {}),
    lastErrorCode: (input.reason || "send_failed").slice(0, 120),
    nextAttemptAtIso: deadLetter
      ? null
      : new Date(input.now.getTime() + Math.min(2 ** nextAttempts, 60) * 60_000).toISOString(),
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { deadLetter };
}

export const APPLICATION_VIDEO_REMINDER_MAIL_MAX_ATTEMPTS = 6;
/** 재촉 메일의 파일럿/GA purpose. golive 스위치 목록에 이 값이 없으면 발송되지 않는다(배포 전제). */
export const APPLICATION_VIDEO_REMINDER_MAIL_PURPOSE = "application_video_reminder";

export type DrainApplicationVideoReminderOutboxOptions = {
  batchLimit?: number;
  now?: Date;
  sendAdapter?: MailSendAdapter;
  recipientResolver?: RecipientResolver;
  /** W72-A: 레인 일캡(리더 확정 250). 미지정이면 설정에서 읽는다. */
  laneDailyCap?: number;
  /** W72-A: 비소모 유예 상한(리더 확정: 레인 캡과 같은 값). 미지정이면 설정에서 읽는다. */
  quotaDeferralCap?: number;
  /** [헤세 2026-09-03] 테스트 주입용 — 기본은 실제 합산캡 조회(mailOutboundSafety.ts). */
  totalQuotaCheck?: typeof totalDailyQuotaAllows;
  /** W118 테스트 주입용 — 기본은 실제 레인 정지 조회(mailOutboundSafety.readMailLaneManualPause). */
  lanePauseCheck?: typeof readMailLaneManualPause;
};

export type DrainApplicationVideoReminderOutboxResult = {
  scanned: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  deliveryUnknown: number;
  suppressed: number;
  skipped: number;
  /** W72-A: 레인 일캡에 막혀 이번 회차에 손대지 않은 행 수. 0 이 아니면 캡이 실제로 물린 것이다. */
  laneCapped: number;
  /** [헤세 2026-09-03] 레인 캡은 통과했지만 세 코호트 합산 상한에 막혀(유예 상한까지 소진돼
   *  소비 종결로 떨어진) 행 수. laneCapped 와 같은 성격의 카운터다. */
  totalCapped: number;
  /** W72-A: 캡/잠금으로 비소모 유예한 행 수. dead_letter 와 반드시 구분해서 센다. 합산 상한
   *  유예도 여기 같이 잡힌다(레인 캡 유예와 같은 "quota_deferred:" 계열이라 축을 나누지 않는다). */
  quotaDeferred: number;
  /** W72: 회차 문안이 아직 발행되지 않아 대기시킨 행 수. 미설정 회차 측정의 정본이다. */
  templateUnmapped: number;
  /** W118: 독려 레인이 수동 정지여서 이번 패스가 조회조차 하지 않고 끝났는가. */
  lanePaused: boolean;
};

const VIDEO_REMINDER_OUTBOX_COLLECTION = "scp_application_video_reminder_outbox";
/** 제출 화면 링크. 템플릿은 정적 링크를 쓰지 않으므로(W48) 이 값이 `{{portal_link}}` 로 주입된다. */
const SCP_CREATOR_PORTAL_LINK = "https://creator.supercent.io/?locale=en";
/** W72 [리더 확정 2026-08-12]: 가이드북 정본 URL. 템플릿은 `{{guidebook_link}}` 로만 참조한다(리터럴 금지). */
const SCP_CREATOR_GUIDEBOOK_LINK = "https://creator.supercent.io/?locale=en&view=guide&track=fixed-cpm#guide-overview";

function applicationVideoReminderTrackingId(outboxDocId: string): string {
  return `application-video-reminder-${hashOpaque(outboxDocId).slice(0, 40)}`;
}

export async function drainApplicationVideoReminderOutbox(
  options: DrainApplicationVideoReminderOutboxOptions = {},
): Promise<DrainApplicationVideoReminderOutboxResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const batchLimit = Math.min(Math.max(Math.trunc(options.batchLimit ?? 10), 1), 50);
  const sendAdapter = options.sendAdapter ?? defaultMailSendAdapter;
  const recipientResolver = options.recipientResolver ?? defaultRecipientResolver;
  const totalQuotaCheck = options.totalQuotaCheck ?? totalDailyQuotaAllows;
  const lanePauseCheck = options.lanePauseCheck ?? readMailLaneManualPause;
  const result: DrainApplicationVideoReminderOutboxResult = {
    scanned: 0, delivered: 0, retried: 0, deadLettered: 0, deliveryUnknown: 0, suppressed: 0, skipped: 0,
    laneCapped: 0, totalCapped: 0, quotaDeferred: 0, templateUnmapped: 0, lanePaused: false,
  };
  /**
   * W118 [프로드 사고 2026-09-03~05] — **레인 정지 사전확인(clean-skip).**
   * 코호트2 도 독려 레인이다. 정지 중에 행을 집으면 시도마다 `mail_outbound_log` 차단 행이
   * 새로 생긴다(코호트1·3 에서 하루 2,773건이 그렇게 쌓였다). 정지는 행마다 달라지지 않으므로
   * **패스당 한 번** 읽고, 막히면 조회조차 하지 않는다 — 행은 "queued" 그대로 남는다.
   * 강제 자체는 발송 경로(resolveOutboundSafetyBlock)가 그대로 한다.
   */
  if (await lanePauseCheck("nudge")) {
    result.lanePaused = true;
    console.info(JSON.stringify({ event: "w118_video_reminder_outbox.lane_paused", lane: "nudge", nowIso }));
    return result;
  }
  await reclaimStaleSendingOutboxRows(VIDEO_REMINDER_OUTBOX_COLLECTION, now);

  // W62e-MAJ1 [독립 델타]: 형제 레인 2개와 **동형**으로 recipient_pending 을 포함한다.
  //   수신자 해석은 드레인에서 하고, 자재가 아직 없으면 그 상태로 남는다. 미제출자 56명 중 54명이
  //   신원 미해석이라 이 상태에 빠질 확률이 높은데, 빼 두면 그 행들이 **영원히 재시도되지 않는다.**
  const retryable = (await adminDb
    .collection(VIDEO_REMINDER_OUTBOX_COLLECTION)
    .where("deliveryState", "in", ["retryable_failed", "recipient_pending"])
    .where("nextAttemptAtIso", "<=", nowIso)
    .orderBy("nextAttemptAtIso", "asc")
    .limit(Math.max(batchLimit * 2, 20))
    .get()).docs;
  const reservedRetries = retryable.slice(0, Math.floor(batchLimit / 2));
  const queued = (await adminDb
    .collection(VIDEO_REMINDER_OUTBOX_COLLECTION)
    .where("deliveryState", "==", "queued")
    // W62d-minor: 정렬을 명시한다. 없으면 문서 ID 순이라 오래된 재촉이 뒤로 밀릴 수 있다.
    .orderBy("createdAtIso", "asc")
    .limit(Math.max(1, batchLimit - reservedRetries.length))
    .get()).docs;
  const due = [...reservedRetries, ...queued];

  // W72-A [리더 확정 2026-08-12 · 레인별 개별 캡 250/일]: 전역 캡 스택을 **우회하지 않는다**.
  //   그 위에 얹는 추가 상한이라 독려가 콜드메일 일캡을 잠식하기 전에 스스로 멈춘다.
  // T1-4 [읽기 비용 · 2026-08-29]: 이 조회를 **드레인 대상이 있을 때만** 한다. 종전에는 함수
  //   맨 앞에서 무조건 읽어 **빈 배치에도 1 read/분**(하루 1,440)이 나갔다 — 이 워커는 1분
  //   스케줄이고 큐가 비어 있는 시간이 대부분이다. 소비처는 아래 루프 4곳(3375·3382·3466·3584)
  //   뿐이라 due 가 비면 값 자체가 안 쓰인다. 순서 변경도 무해하다 — 위 reclaim·두 쿼리 중
  //   laneConfig 를 읽는 코드가 없다.
  const laneConfig = due.length > 0
    ? await readNudgeLaneQuotaConfig(NUDGE_COHORT2_KEY)
    : { dailyCap: 0, quotaDeferralCap: 0 };
  const laneDailyCap = options.laneDailyCap ?? laneConfig.dailyCap;
  const quotaDeferralCap = options.quotaDeferralCap ?? laneConfig.quotaDeferralCap;
  // 2026-08-29: 드레인 cadence 게이트의 기준값. laneConfig 와 같은 결로 due 가 비면 읽지 않는다.
  //   설정 정본(settings/scp_nudge_sequence_templates.cadenceDays, 현재 7)을 그대로 쓴다 —
  //   여기에 숫자를 복제하면 설정과 코드가 다른 말을 하게 된다.
  const nudgeCadenceDays = due.length > 0
    ? ((await readNudgeSequenceConfig()).cohorts.get(NUDGE_COHORT2_KEY)?.cadenceDays ?? 0)
    : 0;
  // [헤세 2026-09-03] 세 코호트 합산 상한. 코호트 무관 단일 값이라(레인 캡과 달리 코호트별로
  //   갈리지 않는다) due 가 있을 때 한 번만 읽는다 — 위 두 값과 같은 절약 원칙(T1-4).
  const totalDailyCap = due.length > 0 ? await readNudgeTotalDailyCap() : null;

  for (const doc of due) {
    result.scanned += 1;
    const row = doc.data() ?? {};
    const applicationId = asString(row.applicationId);
    const programId = asString(row.programId);
    const attempts = Math.max(0, Math.trunc(Number(row.attempts ?? 0)));
    // W72-A: 레인 캡은 클레임 **전에** 본다. 클레임하고 나서 막으면 행이 sending 으로 잠긴다.
    //   적대 리뷰 P1: 종전에는 여기서 `continue` 만 해서 attempts 도 quotaDeferrals 도 안 올랐다 —
    //   캡이 계속 차 있으면 그 행이 매분 영원히 재조회된다(무한 재시도). 캡 차단도 **유예로 계상**해
    //   백오프를 걸고 같은 상한을 공유한다. 상한을 넘으면 laneCapped 로만 세고 다음 주기로 넘긴다.
    const laneQuota = await laneDailyQuotaAllows(APPLICATION_VIDEO_REMINDER_MAIL_PURPOSE, laneDailyCap, now);
    if (!laneQuota.allowed) {
      const deferral = await applyQuotaDeferral({
        ref: doc.ref,
        row,
        reason: `quota_deferred:lane_daily_cap_reached:${laneQuota.used}/${laneQuota.cap}`,
        now,
        deferralCap: quotaDeferralCap,
      });
      if (deferral.handled) {
        result.quotaDeferred += 1;
        continue;
      }
      // W72 [R1 P1-1]: 유예 상한 초과 → **소비 종결로 떨어뜨린다.** 종전에는 여기서 그냥
      //   continue 라 행이 불변인 채 매 스케줄 재조회됐다(무한 재시도 금지 조건 위반).
      const laneOutcome = await applyConsumingFailure({
        ref: doc.ref,
        attempts,
        reason: `lane_daily_cap_deferral_exhausted:${laneQuota.used}/${laneQuota.cap}`,
        now,
        maxAttempts: APPLICATION_VIDEO_REMINDER_MAIL_MAX_ATTEMPTS,
      });
      result.laneCapped += 1;
      if (laneOutcome.deadLetter) result.deadLettered += 1;
      else result.retried += 1;
      continue;
    }
    // [헤세 2026-09-03] 레인 캡을 통과해도 세 코호트 합산 상한을 넘으면 보내지 않는다 — 레인 캡과
    //   같은 원칙: 클레임 **전**에 보고, 캡 차단도 유예로 계상해(같은 상한 공유) 무한 재조회를 막는다.
    const totalQuota = await totalQuotaCheck(totalDailyCap, now);
    if (!totalQuota.allowed) {
      const totalDeferral = await applyQuotaDeferral({
        ref: doc.ref,
        row,
        reason: `quota_deferred:total_daily_cap_reached:${totalQuota.used}/${totalQuota.cap}`,
        now,
        deferralCap: quotaDeferralCap,
      });
      if (totalDeferral.handled) {
        result.quotaDeferred += 1;
        continue;
      }
      // 유예 상한 초과 → 레인 캡과 같은 소비 종결 경로로 떨어뜨린다(무한 재시도 금지).
      const totalOutcome = await applyConsumingFailure({
        ref: doc.ref,
        attempts,
        reason: `total_daily_cap_deferral_exhausted:${totalQuota.used}/${totalQuota.cap}`,
        now,
        maxAttempts: APPLICATION_VIDEO_REMINDER_MAIL_MAX_ATTEMPTS,
      });
      result.totalCapped += 1;
      if (totalOutcome.deadLetter) result.deadLettered += 1;
      else result.retried += 1;
      continue;
    }
    if (!applicationId || !programId) { result.skipped += 1; continue; }

    /**
     * W118 TOCTOU 수리 — 코호트2도 클레임 직전 독려 레인 정지를 다시 본다.
     * 패스 시작 때 열려 있었더라도 앞 행 처리 중 운영자가 스위치를 내릴 수 있다.
     * 이 지점은 아직 `sending` claim 전이라 행·시도·메일 로그를 건드리지 않고 깨끗하게 멈춘다.
     */
    if (await lanePauseCheck("nudge")) {
      result.lanePaused = true;
      console.info(JSON.stringify({
        event: "w118_video_reminder_outbox.lane_paused_mid_batch", lane: "nudge", nowIso,
      }));
      break;
    }

    // 클레임은 트랜잭션으로 — 두 인스턴스가 같은 행을 동시에 집어 두 번 보내지 않는다.
    const claimed = await adminDb.runTransaction(async (transaction) => {
      const fresh = await transaction.get(doc.ref);
      const state = asString((fresh.data() ?? {}).deliveryState);
      const retryAt = asString((fresh.data() ?? {}).nextAttemptAtIso);
      if (!["queued", "retryable_failed", "recipient_pending"].includes(state)) return false;
      if (state !== "queued" && (!retryAt || retryAt > nowIso)) return false;
      transaction.set(doc.ref, {
        deliveryState: "sending", updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return true;
    });
    if (!claimed) { result.skipped += 1; continue; }

    // 템플릿 해석을 **수신자 회수보다 먼저** 한다. 언매핑은 운영자 발행 대기(비소모 유예)라
    // 행이 오래 머무는데, 종전 순서에서는 그 행들이 매분 포털 재료 API 를 회수한 뒤에야
    // 언매핑으로 접혔다 — 실측(26-08-26): 언매핑 89건이 분당 ~5콜을 최소 일주일째 유출했다.
    // 렌더 입력은 행·상수뿐이라(수신자 주소 불사용) 이 이동은 의미 불변이다.
    const trackingId = applicationVideoReminderTrackingId(doc.id);
    // W62d-minor [변수표 정합]: 적재 시점에는 렌더 스냅샷이 없다(수신자·링크를 그때 모른다).
    //   그래서 **발송 직전에** 값을 넣어 렌더한다 — 안 하면 수신자가 리터럴 `{{portal_link}}` 를 받는다.
    //   값은 허용 변수표(RECEIPT_TEMPLATE_RULES.application_video_reminder)와 정확히 같은 이름을 쓴다.
    const templateValues = {
      application_id: applicationId,
      program_name: "Super Creator Partners",
      portal_link: SCP_CREATOR_PORTAL_LINK,
      // W72 교정 [헤세 지적 2026-08-13]: 해니 문안의 CTA 는 **제출 폼**이다.
      //   `portal_link`(포털 홈)에는 폼이 없다(실측: form 0 · input[type=file] 0).
      //   이 값이 빠진 채 매핑을 해니 문안으로 바꾸면 `{{submit_link}}` 가 미치환으로 남아
      //   코호트2 라이브 레인이 통째로 거절된다 — 매핑 교체와 **같은 릴리스**에 들어가야 한다.
      submit_link: REPLY_LINK_SUBMIT,
      guidebook_link: SCP_CREATOR_GUIDEBOOK_LINK,
      // 헤세 확정(26-08-26): 크리에이터 대상 메일 브랜딩은 "Super Creator Partners" 로 통일.
      supercent_brand: "Super Creator Partners",
      ...(asString(row.referenceCode) ? { reference_code: asString(row.referenceCode) } : {}),
    };
    // W72 [R2-1]: **모든** 회차 키가 active-only resolver 를 탄다. 종전에는 기본 키만
    //   legacy resolver 로 빠져 `draft`·빈 status 문서의 본문이 그대로 발송될 수 있었다
    //   (P1-5③ 수리가 사용자 정의 키에만 적용된 상태였다).
    //   active 문서가 없을 때만 기본 키에 한해 **코드 폴백**(검수된 생성물)으로 내려간다 —
    //   비활성 문서의 본문은 어떤 경로로도 쓰이지 않는다.
    const nudgeTemplateKey = asString(row.nudgeTemplateKey) || APPLICATION_VIDEO_REMINDER_MAIL_PURPOSE;
    // 2026-08-29 [프로드 재현]: 여기 kind 가 `"application_video_reminder"` 로 **하드코딩**돼 있어
    //   독려 회차 문안이 통째로 렌더에서 던졌다 — 변수 계약은 문안이 쓰는 placeholder 를 **kind 기준**
    //   으로 검증하는데, 코호트 문안은 `submit_link`/`apply_link` 를 쓰고 그 계약은 `portal_link`·
    //   `supercent_brand` 를 요구하며 `submit_link` 를 금지한다. 결과:
    //     receipt mail template variables invalid: unknown:submit_link, missing:portal_link, ...
    //   그 throw 를 resolveNudgeSequenceTemplateByKey 의 catch 가 삼켜 null 을 돌려주고, 드레인은
    //   그것을 `nudge_template_unmapped`(= 매핑 없음/미발행)로 기록했다. **매핑도 발행도 정상인데**
    //   사유가 원인을 가려, 진단이 "템플릿 결손"으로 두 번 잘못 갔다.
    //   실측: 코호트2 아웃박스 107건이 전량 이 경로. `attempts:0`(provider 미호출) ·
    //   `quotaDeferrals` 231회(8/19 생성분이 열흘 넘게 매 드레인 유예).
    //   base kind 로 검증하면 같은 문안이 정상 렌더된다(재현 확인). nudgeDraftMailTemplateBaseKind 는
    //   바로 이 용도로 이미 존재한다 — "변수 계약 조회가 base 기준이라 필요하다"(scpReceiptMailTemplates).
    const nudgeRenderKind = nudgeDraftMailTemplateBaseKind(nudgeTemplateKey)
      || "application_video_reminder";
    let rendered = await resolveNudgeSequenceTemplateByKey(
      nudgeTemplateKey,
      nudgeRenderKind,
      templateValues,
    );
    if (!rendered && nudgeTemplateKey === APPLICATION_VIDEO_REMINDER_MAIL_PURPOSE) {
      rendered = renderScpReceiptMailFallbackTemplate("application_video_reminder", templateValues);
    }
    if (!rendered) {
      // 매핑은 됐는데 발행 문서가 없다/렌더에 실패했다 → **비소모 대기**. 사유를 남겨 측정 가능하게 한다.
      //   운영자가 템플릿을 발행하면 다음 주기에 그대로 나간다.
      //
      // W72 [R1 P1-5②]: `queued` 로 되돌리면 backoff 가 안 걸려 **매분 앞 배치를 점유**하고
      //   정상 행이 굶는다(queued 쿼리는 nextAttemptAtIso 를 안 본다). 비소모는 유지하되
      //   `retryable_failed` + backoff 로 두어 재조회 간격을 벌린다 — attempts 는 올리지 않는다.
      const unmappedDeferral = await applyQuotaDeferral({
        ref: doc.ref,
        row,
        reason: NUDGE_TEMPLATE_UNMAPPED_REASON,
        now,
        deferralCap: quotaDeferralCap,
      });
      if (!unmappedDeferral.handled) {
        // 유예 상한까지 소진 — 운영자가 끝내 발행하지 않은 것이다. 소비 종결로 끊는다.
        const unmappedOutcome = await applyConsumingFailure({
          ref: doc.ref,
          attempts,
          reason: `${NUDGE_TEMPLATE_UNMAPPED_REASON}_exhausted`,
          now,
          maxAttempts: APPLICATION_VIDEO_REMINDER_MAIL_MAX_ATTEMPTS,
        });
        if (unmappedOutcome.deadLetter) result.deadLettered += 1; else result.retried += 1;
      }
      result.templateUnmapped += 1;
      continue;
    }

    // 수신자는 **여기서** 해석한다 — 적재 시점에는 주소를 다루지 않는다(PII 비노출 설계).
    const recipient = await resolveReceiptRecipient(
      doc.ref,
      row,
      { applicationId, kind: "application_confirmed", programId, sourceContract: asString(row.sourceContract), eventId: asString(row.lastEventId) },
      recipientResolver,
      now,
    );
    if (!recipient?.email) { result.skipped += 1; continue; }

    // W62e-MAJ-B [Codex 델타]: **발송 직전** 제출 여부를 다시 본다.
    //   적재와 발송 사이에 1분 창이 있고, 그 사이에 영상을 낸 사람에게 "아직 안 내셨네요"가 나가면
    //   그 한 통이 신뢰를 깎는다. 적재 시점 검사(enqueue)만으로는 이 창을 못 막는다.
    //   제출이 확인되면 재시도 대상이 아니다 — 비소모 종결(cancelled)로 닫는다.
    const submittedNow = await adminDb.collection("scp_video_review_state")
      .where("applicationId", "==", applicationId)
      .limit(1)
      .get();
    if (!submittedNow.empty) {
      await doc.ref.set({
        deliveryState: "cancelled",
        lastErrorCode: "already_submitted_before_send",
        nextAttemptAtIso: null,
        recipientEmail: FieldValue.delete(),
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      result.skipped += 1;
      continue;
    }

    // ── 2026-08-29 사고 후속 · 드레인 발송 게이트 2종 ────────────────────────────────
    // 130차가 렌더 차단을 풀자, 열흘 넘게 아웃박스에 앉아 있던 서로 다른 회차 행들이 **동시에**
    // 발송 가능해져 같은 사람에게 17~29분 간격으로 연달아 나갔다(실측: 120건 중 30명이 2건 이상,
    // 누적 3건이 20명). cadence 는 7일인데 그렇게 됐다.
    //
    // 근인은 두 검사가 **적재 시점에만** 있었다는 것이다. 적재와 발송이 붙어 있을 때는 같은 말이지만,
    // 행이 오래 머무는 레인에서는 전혀 다른 말이 된다 — 적재 때 통과한 사실이 발송 때도 참이라는
    // 보장이 없다. 바로 위 `already_submitted_before_send` 가 같은 이유로 이미 발송 직전 재확인을
    // 하고 있었다(그 주석: "적재와 발송 사이 1분 창"). 그 창이 실제로는 열흘이었다.
    //
    // 코호트1·3 스윕은 이 두 축을 이미 발송 직전에 본다(nudgeCohortSweep.nudgeStopConditionBeforeSend).
    // 코호트2 드레인만 빠져 있었다 — 같은 축을 같은 자리에 건다.

    // (1) 회신 중단. 회신한 사람에게 자동 독려가 계속 나가면 관계가 상한다 — 실제로 협상 의사를
    //     밝힌 회신자가 그 뒤로도 대상으로 남아 있었다. 비소모 종결(cancelled)이다.
    const replyConversationIds = [
      `program-${programId}-application-video-reminder-${applicationId}`,
      `application-video-reminder-${applicationId}`,
    ];
    let repliedBeforeSend = false;
    for (const conversationId of replyConversationIds) {
      const inbound = await adminDb.collection("message_sources")
        .where("conversationId", "==", conversationId)
        .where("direction", "==", "inbound")
        .limit(1)
        .get();
      if (!inbound.empty) { repliedBeforeSend = true; break; }
    }
    if (repliedBeforeSend) {
      await doc.ref.set({
        deliveryState: "cancelled",
        lastErrorCode: "replied_before_send",
        nextAttemptAtIso: null,
        recipientEmail: FieldValue.delete(),
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      result.skipped += 1;
      continue;
    }

    // (2) cadence 간격. **실제 마지막 발송 시각**으로 잰다 — 이력의 `lastReminderAtIso` 는 적재
    //     시점에 쓰이므로 오래 앉아 있던 행에겐 이미 낡은 값이라 이 판정에 쓸 수 없다(그래서
    //     사고가 났다). 아웃박스의 delivered 행이 실제 발송의 정본이다.
    //     미달이면 **비소모 유예**다 — 회차를 태우지 않고 다음 주기에 그대로 나간다.
    const deliveredRows = await adminDb.collection(VIDEO_REMINDER_OUTBOX_COLLECTION)
      .where("applicationId", "==", applicationId)
      .where("deliveryState", "==", "delivered")
      .get();
    let lastDeliveredMs = 0;
    deliveredRows.forEach((delivered) => {
      const at = Date.parse(asString((delivered.data() ?? {}).updatedAtIso));
      if (Number.isFinite(at) && at > lastDeliveredMs) lastDeliveredMs = at;
    });
    const cadenceMs = Math.max(1, nudgeCadenceDays) * 24 * 60 * 60 * 1000;
    if (lastDeliveredMs > 0 && now.getTime() - lastDeliveredMs < cadenceMs) {
      const cadenceDeferral = await applyQuotaDeferral({
        ref: doc.ref,
        row,
        reason: "nudge_cadence_not_elapsed",
        now,
        deferralCap: quotaDeferralCap,
      });
      if (!cadenceDeferral.handled) {
        await applyConsumingFailure({
          ref: doc.ref,
          attempts: Math.max(0, Math.trunc(Number(row.attempts ?? 0))),
          reason: "nudge_cadence_not_elapsed_exhausted",
          now,
          maxAttempts: APPLICATION_VIDEO_REMINDER_MAIL_MAX_ATTEMPTS,
        });
      }
      result.skipped += 1;
      continue;
    }

    const sendResult = await sendAdapter({
      to: recipient.email,
      subject: renderedReceiptField(row, "renderedSubject", rendered.subject),
      text: renderedReceiptField(row, "renderedText", rendered.text),
      ...(receiptTextOnly(row)
        ? {}
        : { html: renderedReceiptField(row, "renderedHtml", rendered.htmlSource || rendered.html) }),
      trackingId,
      draftRef: `application-video-reminder-outbox-${doc.id}`,
      approvalRef: `application-video-reminder-outbox-${doc.id}-approval`,
      mailPurpose: APPLICATION_VIDEO_REMINDER_MAIL_PURPOSE,
      templateKind: "application_video_reminder",
      mailType: "application_video_reminder",
      gameId: "scp-automation",
      sourceRef: doc.ref.path,
      conversationId: `application-video-reminder-${applicationId}`,
      programId,
      applicationId,
      enrollmentId: asString(row.enrollmentId),
      traceId: asString(row.traceId),
      eventId: asString(row.lastEventId),
      fenceApplicationId: applicationId,
      fenceSendGeneration: attempts + 1,
    });

    if (sendResult.sent) {
      await doc.ref.set({
        deliveryState: "delivered",
        transport: "smtp",
        attempts: attempts + 1,
        providerMessageIdHash: canonicalProviderMessageIdHash(sendResult.providerMessageId ?? trackingId),
        recipientEmailHash: hashOpaque(recipient.email),
        recipientEmail: FieldValue.delete(),
        lastErrorCode: null,
        deliveredAtIso: nowIso,
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      // W72 [R1 P1-3]: post-send 레인 증분을 **제거**했다. 이제 레인 카운트는 쿼터 예약
      //   트랜잭션의 `lane` 차원이 발송 직전에 원자적으로 올린다 — 발송 후 별도 증분은
      //   (a) 커밋 실패 시 카운트 유실로 캡이 1 열리고 (b) 드레인 밖 경로가 아예 안 탄다.
      // W72-B: 회차 판정의 정본은 아웃박스지만, 목록 화면이 200행마다 쿼리를 돌 수는 없다.
      //   delivered 가 확정된 이 자리에서 이력 투영을 함께 올린다. 적재가 아니라 **전달**이 올린다.
      await adminDb.collection(VIDEO_REMINDER_HISTORY_COLLECTION).doc(applicationId).set({
        applicationId,
        deliveredCount: FieldValue.increment(1),
        lastDeliveredAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      result.delivered += 1;
      continue;
    }

    // 게이트가 아직 안 열렸거나 provider 미구성 — **시도를 소모하지 않고** 그대로 둔다.
    if (isNonConsumingSendSkipReason(sendResult.reason)) {
      await doc.ref.set({
        deliveryState: "queued", lastErrorCode: (sendResult.reason ?? "").slice(0, 120),
        updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      result.skipped += 1;
      continue;
    }
    // W72-A [리더 승인 · 헤세 조건 "무한 재시도 금지"]: 캡/잠금은 비소모 유예 — 단 상한이 있다.
    //   상한을 넘으면 아래 기존 소비 경로로 떨어진다(새 종결 상태를 만들지 않는다).
    if (isQuotaDeferredReason(sendResult.reason)) {
      const deferral = await applyQuotaDeferral({
        ref: doc.ref,
        row,
        reason: sendResult.reason ?? "",
        now,
        deferralCap: quotaDeferralCap,
      });
      if (deferral.handled) {
        result.quotaDeferred += 1;
        continue;
      }
    }
    if (sendResult.reason?.startsWith("delivery_unknown:")) {
      await doc.ref.set({
        deliveryState: "delivery_unknown", attempts: attempts + 1,
        recipientEmail: FieldValue.delete(),
        lastErrorCode: sendResult.reason.slice(0, 120), nextAttemptAtIso: null,
        updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      result.deliveryUnknown += 1;
      continue;
    }
    // W62c-C1 형상: 결정적 차단은 **비소모 종결**이다(attempts 를 올리지 않는다).
    if (sendResult.reason === "suppressed_or_unapproved_not_sent") {
      await doc.ref.set({
        deliveryState: "suppressed", lastErrorCode: sendResult.reason.slice(0, 120),
        nextAttemptAtIso: null, recipientEmail: FieldValue.delete(),
        updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      result.suppressed += 1;
      continue;
    }

    const tailOutcome = await applyConsumingFailure({
      ref: doc.ref,
      attempts,
      reason: sendResult.reason ?? "send_failed",
      now,
      maxAttempts: APPLICATION_VIDEO_REMINDER_MAIL_MAX_ATTEMPTS,
    });
    if (tailOutcome.deadLetter) result.deadLettered += 1; else result.retried += 1;
  }

  return result;
}
