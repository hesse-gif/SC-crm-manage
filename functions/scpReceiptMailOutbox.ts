import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import type {
  RenderedScpReceiptMailTemplate,
  ScpReceiptMailTemplateKind,
} from "./scpReceiptMailTemplates";

export const SCP_RECEIPT_MAIL_AUTOMATION_VERSION =
  "scp_receipt_mail_automation_v2" as const;

export const SCP_APPLICATION_CONFIRMED_MAIL_OUTBOX_COLLECTION =
  "scp_application_confirmed_mail_outbox";
export const SCP_CONTENT_SUBMITTED_MAIL_OUTBOX_COLLECTION =
  "scp_content_submitted_mail_outbox";
// W91 [헤세 · admin-bridge 승인 메일]: login_approved 아웃박스. 다른 두 레인과 달리 doc id 는
// 해시가 아니라 `login_approved_<applicationId>` 리터럴이다 — 승인 커맨드 핸들러가 재시도해도
// 항상 같은 문서를 가리켜야 한다(멱등 enqueue, 중복 문서 0).
export const SCP_LOGIN_APPROVED_MAIL_OUTBOX_COLLECTION =
  "scp_login_approved_mail_outbox";
// 반려 안내 메일(구독자 미달·채널 확인 불가) 아웃박스. doc id 규약은 login_approved 와 같은
// 리터럴(`login_rejected_<applicationId>`) — 재반려가 몇 번 와도 문서 하나로 수렴한다(1반려 1통).
// 포털은 reasonCode 를 검증 후 버리므로(포털 실측, 26-08-27) 사유의 기록 정본은 이 행이다.
export const SCP_LOGIN_REJECTED_MAIL_OUTBOX_COLLECTION =
  "scp_login_rejected_mail_outbox";
export const SCP_LOGIN_REJECTED_MAIL_ENQUEUE_FAILURES_COLLECTION =
  "scp_login_rejected_mail_enqueue_failures";

function docId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 48);
}

export function contentSubmittedMailOutboxDocId(
  videoSubmissionId: string,
  videoRevision: number,
): string {
  return docId(`${videoSubmissionId}:${videoRevision}`);
}

export function applicationConfirmedMailOutboxDocId(
  applicationId: string,
): string {
  return docId(applicationId);
}

export type ApplicationConfirmedMailOutboxInput = Readonly<{
  applicationId: string;
  programId: string;
  eventId: string;
  traceId: string;
  sourceContract: string;
  nowIso: string;
  referenceCode?: string;
  campaignId?: string;
  outreachId?: string;
  portalCreatorId?: string;
  fluCreatorId?: string;
  partnerId?: string;
  enrollmentId?: string;
  templateSnapshot?: RenderedScpReceiptMailTemplate;
}>;

function templateSnapshotFields(
  kind: ScpReceiptMailTemplateKind,
  snapshot?: RenderedScpReceiptMailTemplate,
): Record<string, unknown> {
  if (!snapshot) return { templateKind: kind };
  return {
    templateKind: snapshot.kind,
    templateSource: snapshot.source,
    templateRevision: snapshot.revision,
    templateHash: snapshot.hash,
    // W8-3: 드레인이 "텍스트 전용 선택"과 "스냅샷 없음"을 구분할 수 있어야 한다 — 빈 renderedHtml
    // 만 보고 판단하면 fallback 이 정본 마스터 HTML 을 되살려 운영자가 고른 형식을 무시한다.
    // 레거시 행(마커 없음)은 기존 html 유무로 해석한다.
    templateBodyFormat: snapshot.bodyFormat ?? (snapshot.htmlSource || snapshot.html ? "html" : "text"),
    renderedSubject: snapshot.subject,
    renderedText: snapshot.text,
    // W8-1a: 드레인이 이 값을 그대로 sendAdapter 의 html 로 싣는다 → 컴파일 입력(자산화 이전)이어야
    // 한다. 자산화된 cid html 을 실으면 sendEmail 재컴파일이 매니페스트 대조에서 fail-closed 된다.
    // 옛 행·스냅샷 스텁(htmlSource 없음)은 기존 compiled html 로 폴백한다.
    renderedHtml: snapshot.htmlSource || snapshot.html,
    templateSnapshot: {
      kind: snapshot.kind,
      source: snapshot.source,
      revision: snapshot.revision,
      hash: snapshot.hash,
      subject: snapshot.subject,
      text: snapshot.text,
      html: snapshot.html,
    },
  };
}

export function applicationConfirmedMailOutboxRow(
  input: ApplicationConfirmedMailOutboxInput,
): Record<string, unknown> {
  return {
    automationVersion: SCP_RECEIPT_MAIL_AUTOMATION_VERSION,
    sourceContract: input.sourceContract,
    applicationId: input.applicationId,
    programId: input.programId,
    ...(input.referenceCode ? { referenceCode: input.referenceCode } : {}),
    ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    ...(input.outreachId ? { outreachId: input.outreachId } : {}),
    ...(input.portalCreatorId
      ? { portalCreatorId: input.portalCreatorId }
      : {}),
    ...(input.fluCreatorId ? { fluCreatorId: input.fluCreatorId } : {}),
    ...(input.partnerId ? { partnerId: input.partnerId } : {}),
    ...(input.enrollmentId ? { enrollmentId: input.enrollmentId } : {}),
    locale: "en",
    traceId: input.traceId,
    lastEventId: input.eventId,
    deliveryState: "queued",
    transport: "unconfigured",
    attempts: 0,
    ...templateSnapshotFields("application_confirmed", input.templateSnapshot),
    createdAtIso: input.nowIso,
    updatedAtIso: input.nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export type ContentSubmittedMailOutboxInput = Readonly<{
  applicationId: string;
  programId: string;
  videoSubmissionId: string;
  videoRevision: number;
  eventId: string;
  traceId: string;
  sourceContract: string;
  nowIso: string;
  campaignId?: string;
  portalCreatorId?: string;
  fluCreatorId?: string;
  partnerId?: string;
  enrollmentId?: string;
  contentFingerprint?: string;
  policyVersion?: string;
  outreachId?: string;
  sourceSubmissionId?: string;
  settlementCreatorCode?: string;
  channelId?: string;
  templateSnapshot?: RenderedScpReceiptMailTemplate;
}>;

// W91 [헤세 · admin-bridge 승인 메일]: login_approved 아웃박스 행 빌더. applicationConfirmedMailOutboxRow
// 와 같은 관례지만 templateSnapshot 이 없다 — `loginUrl` 은 Portal material 회수 결과라 enqueue
// 시점(승인 커맨드 처리 중)에는 아직 없고, 드레인(scpOutboxMailWorkers.drainLoginApprovedMailOutbox)이
// 발송 직전에 회수 + 렌더한다(uid_guide 레인과 동일 이유).
export type LoginApprovedMailOutboxInput = Readonly<{
  applicationId: string;
  programId: string;
  eventId: string;
  traceId?: string;
  sourceContract: string;
  nowIso: string;
  portalCreatorId?: string;
  fluCreatorId?: string;
  partnerId?: string;
  enrollmentId?: string;
}>;

/** `login_approved_<applicationId>` — 승인 커맨드가 재시도해도 같은 문서를 가리키는 멱등 doc id. */
export function loginApprovedMailOutboxDocId(applicationId: string): string {
  const safe = String(applicationId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180);
  return `login_approved_${safe}`;
}

// 반려 레인은 material 파생 eventId 가 없다(수신자 회수가 v1 delivery-material 사다리 —
// resolveSignedMaterialRecipient — 라 applicationId 만으로 닿는다). 대신 reasonCode 가 필수다:
// 포털이 버리는 값이라 이 행이 사유의 유일한 기록이고, 드레인의 템플릿 분기 근거다.
//
// 매핑이 이 파일(leaf)에 있는 이유: enqueue(scpAdminBridgeCallables)와 드레인(scpOutboxMailWorkers)
// 둘 다 쓰는데, 워커 모듈은 scpFluApplicationCommand 를 거쳐 콜러블을 이미 import 한다 —
// 콜러블이 워커를 되-import 하면 순환이다.
export const LOGIN_REJECTED_REASON_TEMPLATE_KINDS = {
  subscriber_below_minimum: "login_rejected_subscriber_minimum",
  channel_not_found: "login_rejected_channel_not_found",
  not_eligible: "login_rejected_public_reason",
} as const;

export type LoginRejectedMailReasonCode = keyof typeof LOGIN_REJECTED_REASON_TEMPLATE_KINDS;

/** 메일이 나가는 반려 사유인가. Portal 계약 밖 사유는 fail-closed 된다. */
export function isLoginRejectedMailReasonCode(value: unknown): value is LoginRejectedMailReasonCode {
  return value === "subscriber_below_minimum" ||
    value === "channel_not_found" ||
    value === "not_eligible";
}

export type LoginRejectedMailOutboxInput = Readonly<{
  applicationId: string;
  programId: string;
  reasonCode: string;
  sourceContract: string;
  nowIso: string;
  /** 구독자 미달 반려의 판단 근거 — 반려 시점 UI 가 보던 값(LOG-P0-010 결). 없으면 미저장. */
  subscriberCountAtRejection?: number;
  /** Portal/Flu operator-reviewed public guidance. Plain text only; never internal notes. */
  publicReasonText?: string;
  sourceEventId?: string;
  applicationRevision?: number;
  portalCreatorId?: string;
  fluCreatorId?: string;
}>;

/**
 * 반려 material 회수 키(계약 26-08-27, cod-92 합의·픽스처 상호 확인).
 * 포털 reject 트랜잭션이 같은 파생식으로 앵커 영수증을 민팅한다 — salt 는 `login_rejected_`
 * (approved 계약의 `login_approved_resend_` 와 동형, resend 흔적 없는 깨끗한 salt).
 * 픽스처 핀: applicationId "cc4da06f-7c03-474f-8c28-4753a55b9928"
 *   → "req_879f8129baf528024e1bd4e001e9ea38".
 */
export function loginRejectedMaterialEventId(applicationId: string): string {
  return `req_${createHash("sha256").update(`login_rejected_${applicationId}`).digest("hex").slice(0, 32)}`;
}

/** `login_rejected_<applicationId>` — 재반려가 와도 같은 문서를 가리키는 멱등 doc id. */
export function loginRejectedMailOutboxDocId(applicationId: string): string {
  const safe = String(applicationId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180);
  return `login_rejected_${safe}`;
}

export function loginRejectedMailOutboxRow(
  input: LoginRejectedMailOutboxInput,
): Record<string, unknown> {
  return {
    automationVersion: SCP_RECEIPT_MAIL_AUTOMATION_VERSION,
    sourceContract: input.sourceContract,
    applicationId: input.applicationId,
    programId: input.programId,
    reasonCode: input.reasonCode,
    ...(input.sourceEventId ? { sourceEventId: input.sourceEventId, lastEventId: input.sourceEventId } : {}),
    ...(input.applicationRevision !== undefined ? { applicationRevision: input.applicationRevision } : {}),
    ...(input.publicReasonText ? { publicReasonText: input.publicReasonText } : {}),
    ...(input.subscriberCountAtRejection !== undefined
      ? { subscriberCountAtRejection: input.subscriberCountAtRejection }
      : {}),
    ...(input.portalCreatorId ? { portalCreatorId: input.portalCreatorId } : {}),
    ...(input.fluCreatorId ? { fluCreatorId: input.fluCreatorId } : {}),
    locale: "en",
    deliveryState: "queued",
    transport: "unconfigured",
    attempts: 0,
    createdAtIso: input.nowIso,
    updatedAtIso: input.nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/** `enqueueLoginRejectedMailOutbox` 의 결과 — wrote:false 일 때 감사에 남길 근거(기존 상태)를 함께 낸다. */
export type LoginRejectedMailOutboxWriteResult = Readonly<{
  wrote: boolean;
  /** 이 applicationId 로 기존 outbox 행이 이미 있었는가(성공/실패 무관). */
  existed: boolean;
  /** wrote:false 일 때만: 슬롯을 점유한 기존 행의 deliveryState. */
  existingDeliveryState?: string;
}>;

async function writeLoginRejectedMailOutboxIfSafe(
  applicationId: string,
  row: Record<string, unknown>,
): Promise<LoginRejectedMailOutboxWriteResult> {
  const outboxRef = adminDb
    .collection(SCP_LOGIN_REJECTED_MAIL_OUTBOX_COLLECTION)
    .doc(loginRejectedMailOutboxDocId(applicationId));
  return adminDb.runTransaction(async (tx) => {
    const existing = await tx.get(outboxRef);
    if (existing.exists) {
      const state = String(existing.data()?.deliveryState ?? "");
      if (state !== "queued") return { wrote: false, existed: true, existingDeliveryState: state };
    }
    tx.set(outboxRef, row, { merge: true });
    return { wrote: true, existed: existing.exists };
  });
}

function enqueueFailureCode(error: unknown): string {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return code || "unknown_error";
}

export async function recordLoginRejectedMailEnqueueFailure(input: Readonly<{
  applicationId: string;
  reasonCode: string;
  error: unknown;
  now: Date;
  source?: string;
}>): Promise<void> {
  try {
    await adminDb.collection(SCP_LOGIN_REJECTED_MAIL_ENQUEUE_FAILURES_COLLECTION).add({
      applicationId: input.applicationId,
      reasonCode: input.reasonCode,
      code: enqueueFailureCode(input.error),
      ...(input.source ? { source: input.source } : {}),
      atIso: input.now.toISOString(),
    });
  } catch (auditError) {
    console.warn("[login_rejected] enqueue failure audit write failed", {
      applicationId: input.applicationId,
      message: auditError instanceof Error ? auditError.message : String(auditError),
    });
  }
}

/**
 * Task-35 수리: `enqueueLoginRejectedMailOutbox` 가 `wrote:false` 로 끝나면(기존 행이 `queued` 가
 * 아니라 결정적 슬롯이 점유됨) 조용히 넘기지 않고 구조화 로그 + 감사 문서를 남긴다. 같은
 * enqueue-failures 컬렉션을 재사용한다 — "이 반려는 메일이 안 나갔다"는 관측 의미가 같다.
 * 문구 원문(publicReasonText)은 절대 싣지 않는다(SEC-P0-009) — 상태·docId 만.
 */
export async function recordLoginRejectedMailOutboxSlotOccupied(input: Readonly<{
  applicationId: string;
  reasonCode: string;
  existingDeliveryState: string | undefined;
  now: Date;
  source?: string;
}>): Promise<void> {
  const docId = loginRejectedMailOutboxDocId(input.applicationId);
  const existingDeliveryState = input.existingDeliveryState || "unknown";
  console.warn("[login_rejected] outbox slot occupied — enqueue skipped", {
    applicationId: input.applicationId,
    reasonCode: input.reasonCode,
    docId,
    existingDeliveryState,
    ...(input.source ? { source: input.source } : {}),
  });
  try {
    await adminDb.collection(SCP_LOGIN_REJECTED_MAIL_ENQUEUE_FAILURES_COLLECTION).add({
      applicationId: input.applicationId,
      reasonCode: input.reasonCode,
      code: "login_rejected_outbox_slot_occupied",
      docId,
      existingDeliveryState,
      ...(input.source ? { source: input.source } : {}),
      atIso: input.now.toISOString(),
    });
  } catch (auditError) {
    console.warn("[login_rejected] outbox slot occupied audit write failed", {
      applicationId: input.applicationId,
      message: auditError instanceof Error ? auditError.message : String(auditError),
    });
  }
}

export async function enqueueLoginRejectedMailOutbox(
  input: LoginRejectedMailOutboxInput,
): Promise<LoginRejectedMailOutboxWriteResult> {
  if (!isLoginRejectedMailReasonCode(input.reasonCode)) {
    throw Object.assign(new Error("invalid login rejection reasonCode"), {
      code: "unknown_reason_code",
    });
  }
  return writeLoginRejectedMailOutboxIfSafe(
    input.applicationId,
    loginRejectedMailOutboxRow(input),
  );
}

// 26-08-27 계약 + Task-35: Portal 공개 반려 문구 새니타이저. login_rejected 드레인(scpOutboxMailWorkers)
// 과 백필 스크립트(scripts/scp-login-rejected-portal-inventory.mjs) 둘 다 쓴다 — 이 leaf 모듈에
// 두는 이유는 파일 상단 LOGIN_REJECTED_REASON_TEMPLATE_KINDS 주석과 같다(순환 회피).
export function sanitizeLoginRejectedPublicReasonText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (!text || text.length > 1000) return "";
  if (/[<>]/.test(text) || text.includes("{{") || text.includes("}}")) return "";
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return "";
  if (/\b(?:token|secret|signature|rule id|confidence|probability|internal note|operator memo)\b/i.test(text)) return "";
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join("\n");
}

export function loginApprovedMailOutboxRow(
  input: LoginApprovedMailOutboxInput,
): Record<string, unknown> {
  return {
    automationVersion: SCP_RECEIPT_MAIL_AUTOMATION_VERSION,
    sourceContract: input.sourceContract,
    applicationId: input.applicationId,
    programId: input.programId,
    ...(input.portalCreatorId ? { portalCreatorId: input.portalCreatorId } : {}),
    ...(input.fluCreatorId ? { fluCreatorId: input.fluCreatorId } : {}),
    ...(input.partnerId ? { partnerId: input.partnerId } : {}),
    ...(input.enrollmentId ? { enrollmentId: input.enrollmentId } : {}),
    locale: "en",
    ...(input.traceId ? { traceId: input.traceId } : {}),
    lastEventId: input.eventId,
    deliveryState: "queued",
    transport: "unconfigured",
    attempts: 0,
    templateKind: "login_approved",
    createdAtIso: input.nowIso,
    updatedAtIso: input.nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export function contentSubmittedMailOutboxRow(
  input: ContentSubmittedMailOutboxInput,
): Record<string, unknown> {
  return {
    automationVersion: SCP_RECEIPT_MAIL_AUTOMATION_VERSION,
    sourceContract: input.sourceContract,
    applicationId: input.applicationId,
    programId: input.programId,
    ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    ...(input.portalCreatorId
      ? { portalCreatorId: input.portalCreatorId }
      : {}),
    ...(input.fluCreatorId ? { fluCreatorId: input.fluCreatorId } : {}),
    ...(input.partnerId ? { partnerId: input.partnerId } : {}),
    ...(input.enrollmentId ? { enrollmentId: input.enrollmentId } : {}),
    videoSubmissionId: input.videoSubmissionId,
    videoRevision: input.videoRevision,
    ...(input.contentFingerprint
      ? { contentFingerprint: input.contentFingerprint }
      : {}),
    ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
    ...(input.outreachId ? { outreachId: input.outreachId } : {}),
    ...(input.sourceSubmissionId
      ? { sourceSubmissionId: input.sourceSubmissionId }
      : {}),
    ...(input.settlementCreatorCode
      ? { settlementCreatorCode: input.settlementCreatorCode }
      : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
    locale: "en",
    traceId: input.traceId,
    lastEventId: input.eventId,
    deliveryState: "queued",
    transport: "unconfigured",
    attempts: 0,
    ...templateSnapshotFields("content_submitted", input.templateSnapshot),
    createdAtIso: input.nowIso,
    updatedAtIso: input.nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  };
}
