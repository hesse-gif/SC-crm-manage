// Portal -> Flu application-command 수신기 + 보호 전달자료 회수 + UID 안내 메일 outbox.
//
// Portal 핀 계약(scp-creator-portal docs/architecture/application-onboarding-uid-adversarial-map.md
// "Exact Portal -> Flu application-command contract")을 그대로 구현한다:
// - 명령 본문에는 수신자 email/raw UID/bearer 토큰/안내 URL/쿠키/템플릿/자격증명이 절대 없다.
//   Flu 는 안전한 2xx accepted/queued 또는 409 duplicate 만 반환한다(전달 상세 무노출).
// - 명령 수락 후 Flu 가 별도 HMAC 서명 POST 로 Portal 의 material 엔드포인트에서
//   { recipientEmail, uidGuideUrl, expiresAt } 를 회수한다. 이 응답은 유일한 전달자료
//   전송 경로이며 Portal/Flu 어느 쪽에도 raw 로 영속·로그되지 않는다(전송 시점 메모리 한정).
// - 멱등 키 == 명령 문서 ID == `flu_application_command_<applicationId>_scp-application-onboarding-v1`.
// - Flu 가 메일 렌더링/transport/retry/backoff/dedupe/감사 전부를 소유한다. 기본 transport 는
//   delivery_transport_unconfigured 로 fail-closed — 실메일 바인딩은 별도 프로덕션 승인 항목.
//
// 환경 바인딩(Flu):
// - SCP_FLU_APPLICATION_COMMAND_SECRET(+_PREVIOUS): Portal 과 공유하는 명령/자료 채널 HMAC(32B+).
// - SCP_PORTAL_DELIVERY_MATERIAL_URL: Portal `/api/internal/flu/application-command-delivery` 전체 URL.

import { createHash, createHmac } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { assertScpEntitled } from "./mailAccounts";
import { verifyScpPortalIngressAuth } from "./scpPortalSubmissionIngress";
import {
  SCP_APPLICATION_CONFIRMED_MAIL_OUTBOX_COLLECTION,
  applicationConfirmedMailOutboxDocId,
  applicationConfirmedMailOutboxRow,
  enqueueLoginRejectedMailOutbox,
  isLoginRejectedMailReasonCode,
  loginRejectedMaterialEventId,
  recordLoginRejectedMailEnqueueFailure,
  recordLoginRejectedMailOutboxSlotOccupied,
} from "./scpReceiptMailOutbox";
import { materializeApplicationManagementRecord } from "./applicationManagementStore";
import {
  SCP_APPLICATION_ONBOARDING_FLOW_VERSION,
  FLU_APPLICATION_COMMAND_COLLECTION,
  FLU_APPLICATION_COMMAND_AUDIT_COLLECTION,
  fluApplicationCommandId,
  fluApplicationApprovalCommandId,
  recoverPendingApprovalOnboarding,
  runApprovalOnboardingEnqueue,
} from "./scpApprovalOnboarding";
import { enqueueLoginApprovedMailFromApprovalCommand } from "./scpAdminBridgeCallables";
import { resolveScpReceiptMailTemplate } from "./scpReceiptMailTemplates";

export const SCP_FLU_APPLICATION_COMMAND_CONTRACT = "scp.flu.application-command.v1" as const;
// v2 adds `portalCreatorId` on `applicationApproved` commands (Portal 계보 지원서 신원 연결).
// v1 은 그대로 유지 — 두 버전을 동시 수용한다(§A). 순서가 허용 여부를 결정하지 않는다.
export const SCP_FLU_APPLICATION_COMMAND_CONTRACT_V2 = "scp.flu.application-command.v2" as const;
export const SCP_FLU_APPLICATION_REJECTION_COMMAND_CONTRACT = "scp.flu.application-rejection-command.v1" as const;
const SCP_FLU_APPLICATION_COMMAND_CONTRACTS = [
  SCP_FLU_APPLICATION_COMMAND_CONTRACT,
  SCP_FLU_APPLICATION_COMMAND_CONTRACT_V2,
  SCP_FLU_APPLICATION_REJECTION_COMMAND_CONTRACT,
] as const;
export type FluApplicationCommandContractVersion =
  (typeof SCP_FLU_APPLICATION_COMMAND_CONTRACTS)[number];
export {
  SCP_APPLICATION_ONBOARDING_FLOW_VERSION,
  FLU_APPLICATION_COMMAND_COLLECTION,
  FLU_APPLICATION_COMMAND_AUDIT_COLLECTION,
  fluApplicationCommandId,
  fluApplicationApprovalCommandId,
  APPROVAL_ONBOARDING_SEND_GENERATION,
} from "./scpApprovalOnboarding";
export const SCP_FLU_DELIVERY_MATERIAL_CONTRACT = "scp.flu.application-delivery-material.v1" as const;
export const SCP_FLU_APPLICATION_COMMAND_SECRET_ENV = "SCP_FLU_APPLICATION_COMMAND_SECRET";
export const SCP_FLU_APPLICATION_COMMAND_PREVIOUS_SECRET_ENV = "SCP_FLU_APPLICATION_COMMAND_SECRET_PREVIOUS";
export const SCP_PORTAL_DELIVERY_MATERIAL_URL_ENV = "SCP_PORTAL_DELIVERY_MATERIAL_URL";
export const SCP_PORTAL_CREATOR_PIPELINE_V3_BASE_URL_ENV =
  "SCP_PORTAL_CREATOR_PIPELINE_V3_BASE_URL";
export const SCP_FLU_APPLICATION_COMMAND_MAX_BODY_BYTES = 8 * 1024;


const COMMAND_ID_RE = /^flu_application_command_[A-Za-z0-9_-]{1,128}_scp-application-onboarding-v1$/;
// Approval commands use a *prefix-separated* id space: after the shared "flu_application_"
// stem the two classes diverge at "command_" vs "approval_command_", so no applicationId
// value (the charset allows "_") can ever make a submission id equal an approval id.
const APPROVAL_COMMAND_ID_RE = /^flu_application_approval_command_[A-Za-z0-9_-]{1,128}_scp-application-onboarding-v1$/;
const REJECTION_COMMAND_ID_RE = /^flu_application_rejection_command_[a-f0-9]{32}$/;
// 승인자 principal id 의 허용 형식. 두 갈래를 **명시 열거**한다:
//   1. 콜론 없는 내부 principal (`admin_<64hex>` 등) — 최대 128자
//   2. flu 관리자 화면 경유 승인의 Portal 접두사 `flu-bridge:<fluUid>` (fluUid = Firebase UID)
// 두 갈래 모두 "@"·"."·공백을 불허한다(감사 로그 PII 원문 적재 차단). 콜론은 일반 허용이
// 아니라 1번 계보에만 열려 있다 — 근거는 아래 approval 파싱부 주석 참조.
const APPROVAL_ACTOR_ID_RE =
  /^(?:[A-Za-z0-9][A-Za-z0-9_-]{0,127}|flu-bridge:[A-Za-z0-9_-]{1,120})$/;

const COMMAND_TYPES = ["applicationSubmitted", "uidGuideRequested", "applicationApproved"] as const;
const REJECTION_COMMAND_TYPES = ["applicationRejected"] as const;
const LOCALES = ["ko", "en", "ja"] as const;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
// 명령 본문에 존재해서는 안 되는 전달 상세/자격증명 키(깊이 무관 방어).
const FORBIDDEN_COMMAND_KEYS = new Set([
  "email", "recipientEmail", "uidGuideUrl", "uidActionLink", "token", "bearer",
  "cookie", "template", "password", "credential", "uid",
]);
const FLU_APPLICATION_REJECTION_COMMAND_COLLECTION = "scp_flu_application_rejection_commands";
const PUBLIC_REJECTION_MESSAGE_MAX_LENGTH = 1_000;
const ADMIN_BRIDGE_EVENT_ID_RE = /^req_[a-f0-9]{32}$/;

type CommandError = Error & { code: string };

function commandError(code: string, message: string): CommandError {
  return Object.assign(new Error(message), { code });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requiredIdentifier(value: unknown, field: string): string {
  const text = asString(value);
  if (!IDENTIFIER_RE.test(text)) throw commandError("invalid_payload", `${field} is not an exact identifier`);
  return text;
}

function requiredIso(value: unknown, field: string): string {
  const text = asString(value);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw commandError("invalid_payload", `${field} must be an exact ISO-8601 timestamp`);
  }
  return text;
}

// portalCreatorId 는 Portal 이 부여하는 계보 지원서 신원 참조값이다 — IDENTIFIER_RE 보다 넓은
// 상한(200)을 허용하되, 값 없음을 뜻하는 센티널과 제어문자는 명시적으로 거부한다(조용한 무시 금지).
const PORTAL_CREATOR_ID_MAX_LENGTH = 200;
const PORTAL_CREATOR_ID_SENTINELS = new Set([
  "unclassified", "unknown", "none", "null", "undefined", "n/a", "na",
]);
// eslint-disable-next-line no-control-regex -- 제어문자 명시 배제가 검증 목적 그 자체.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function requiredPortalCreatorId(value: unknown): string {
  const text = asString(value);
  const trimmed = text.trim();
  if (
    trimmed.length === 0 ||
    text.length > PORTAL_CREATOR_ID_MAX_LENGTH ||
    CONTROL_CHAR_RE.test(text) ||
    PORTAL_CREATOR_ID_SENTINELS.has(trimmed.toLowerCase())
  ) {
    throw commandError("invalid_payload", "portalCreatorId failed validation");
  }
  return text;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw commandError("invalid_payload", `${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...keys, ...optional]);
  if (keys.some((key) => !(key in record)) || Object.keys(record).some((key) => !allowed.has(key))) {
    throw commandError("invalid_payload", `${label} keys drifted from the exact contract`);
  }
  return record;
}

function assertNoForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoForbiddenKeys(entry);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_COMMAND_KEYS.has(key)) {
        throw commandError("invalid_payload", "command contains forbidden delivery detail");
      }
      assertNoForbiddenKeys(entry);
    }
  }
}

export type NormalizedFluApplicationCommand = {
  schemaVersion: FluApplicationCommandContractVersion;
  commandTypes: string[];
  applicationId: string;
  referenceCode: string;
  programId: string;
  locale: (typeof LOCALES)[number];
  onboarding: { flowVersion: typeof SCP_APPLICATION_ONBOARDING_FLOW_VERSION; grantId: string; expiresAt: string };
  approval?: { actorId: string; approvedAt: string };
  portalCreatorId?: string;
  channelId?: string;
};

export type NormalizedFluApplicationRejectionCommand = {
  schemaVersion: typeof SCP_FLU_APPLICATION_REJECTION_COMMAND_CONTRACT;
  commandTypes: ["applicationRejected"];
  applicationId: string;
  applicationRevision: number;
  referenceCode: string;
  programId: string;
  locale: (typeof LOCALES)[number];
  rejection: {
    reasonCode: string;
    publicMessage: string;
    receiptSourceEventId: string;
  };
};

function publicRejectionMessage(value: unknown): string {
  if (typeof value !== "string") {
    throw commandError("invalid_payload", "rejection.publicMessage must be plain text");
  }
  const normalized = value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (
    normalized.length === 0 ||
    normalized.length > PUBLIC_REJECTION_MESSAGE_MAX_LENGTH ||
    /[<>]/.test(normalized) ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)
  ) {
    throw commandError("invalid_payload", "rejection.publicMessage must be bounded plain text");
  }
  return normalized;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw commandError("invalid_payload", `${field} must be a positive safe integer`);
  }
  return number;
}

export function fluApplicationRejectionCommandId(applicationId: string, applicationRevision: number): string {
  const identity = createHash("sha256")
    .update(`application-rejected:${applicationId}:v${applicationRevision}`)
    .digest("hex")
    .slice(0, 32);
  return `flu_application_rejection_command_${identity}`;
}

export function normalizeFluApplicationRejectionCommand(value: unknown): NormalizedFluApplicationRejectionCommand {
  const record = exactRecord(value, [
    "schemaVersion", "commandTypes", "applicationId", "applicationRevision", "referenceCode", "programId", "locale", "rejection",
  ], "application rejection command");
  if (record.schemaVersion !== SCP_FLU_APPLICATION_REJECTION_COMMAND_CONTRACT) {
    throw commandError("unsupported_contract", "unsupported rejection command schema version");
  }
  if (
    !Array.isArray(record.commandTypes) ||
    record.commandTypes.length !== 1 ||
    record.commandTypes[0] !== REJECTION_COMMAND_TYPES[0]
  ) {
    throw commandError("invalid_payload", "rejection commandTypes must be exactly applicationRejected");
  }
  assertNoForbiddenKeys(record);
  const applicationId = requiredIdentifier(record.applicationId, "applicationId");
  const applicationRevision = requiredPositiveInteger(record.applicationRevision, "applicationRevision");
  const locale = asString(record.locale);
  if (!LOCALES.includes(locale as (typeof LOCALES)[number])) {
    throw commandError("invalid_payload", "locale must be one of ko/en/ja");
  }
  const rejection = exactRecord(record.rejection, ["reasonCode", "publicMessage", "receiptSourceEventId"], "rejection");
  const reasonCode = asString(rejection.reasonCode);
  const receiptSourceEventId = asString(rejection.receiptSourceEventId);
  if (!isLoginRejectedMailReasonCode(reasonCode)) {
    throw commandError("unknown_reason_code", "rejection.reasonCode is not supported");
  }
  if (
    !ADMIN_BRIDGE_EVENT_ID_RE.test(receiptSourceEventId) ||
    receiptSourceEventId !== loginRejectedMaterialEventId(applicationId)
  ) {
    throw commandError("material_source_mismatch", "rejection.receiptSourceEventId does not match applicationId");
  }
  return {
    schemaVersion: SCP_FLU_APPLICATION_REJECTION_COMMAND_CONTRACT,
    commandTypes: ["applicationRejected"],
    applicationId,
    applicationRevision,
    referenceCode: requiredIdentifier(record.referenceCode, "referenceCode"),
    programId: requiredIdentifier(record.programId, "programId"),
    locale: locale as (typeof LOCALES)[number],
    rejection: {
      reasonCode,
      publicMessage: publicRejectionMessage(rejection.publicMessage),
      receiptSourceEventId,
    },
  };
}

export function normalizeFluApplicationCommand(value: unknown): NormalizedFluApplicationCommand {
  const record = exactRecord(value, [
    "schemaVersion", "commandTypes", "applicationId", "referenceCode", "programId", "locale", "onboarding",
  ], "application command", ["portalCreatorId", "channelId", "approval"]);
  if (!SCP_FLU_APPLICATION_COMMAND_CONTRACTS.includes(record.schemaVersion as FluApplicationCommandContractVersion)) {
    throw commandError("unsupported_contract", "unsupported command schema version");
  }
  const schemaVersion = record.schemaVersion as FluApplicationCommandContractVersion;
  if (!Array.isArray(record.commandTypes) || record.commandTypes.length === 0
    || record.commandTypes.some((type) => !COMMAND_TYPES.includes(type as (typeof COMMAND_TYPES)[number]))
    || new Set(record.commandTypes).size !== record.commandTypes.length) {
    throw commandError("invalid_payload", "commandTypes must be a distinct subset of the known command types");
  }
  // An approval command carries its own idempotency key, so it must not be mixed with
  // submission-keyed types in one payload — the two would need two different command ids.
  const isApproval = record.commandTypes.includes("applicationApproved");
  if (isApproval && record.commandTypes.length !== 1) {
    throw commandError("invalid_payload", "applicationApproved must be the only command type in its payload");
  }
  // v1 승인 커맨드는 portalCreatorId 를 모르는 계약이다(신규 §B 의미는 v2 전용) — 실려 오면
  // 조용히 무시하지 않고 거부한다. applicationSubmitted 의 portalCreatorId 는 별개의 기존
  // 신원 바인딩 용도로 v1 부터 이미 지원돼 왔으므로(scp_application_management.identity)
  // 이 제약에서 제외한다 — 건드리면 기존 회귀다.
  if (isApproval && schemaVersion === SCP_FLU_APPLICATION_COMMAND_CONTRACT && record.portalCreatorId !== undefined) {
    throw commandError("invalid_payload", "portalCreatorId is not part of the v1 applicationApproved contract");
  }
  // Approver identity is mandatory on approval commands (LOG-P0-010: permission changes must
  // be attributable) and forbidden elsewhere — a submission has no approver.
  if (isApproval && record.approval === undefined) {
    throw commandError("invalid_payload", "applicationApproved requires an approval block");
  }
  if (!isApproval && record.approval !== undefined) {
    throw commandError("invalid_payload", "approval is only valid on an applicationApproved command");
  }
  const locale = asString(record.locale);
  if (!LOCALES.includes(locale as (typeof LOCALES)[number])) {
    throw commandError("invalid_payload", "locale must be one of ko/en/ja");
  }
  const onboarding = exactRecord(record.onboarding, ["flowVersion", "grantId", "expiresAt"], "onboarding");
  if (onboarding.flowVersion !== SCP_APPLICATION_ONBOARDING_FLOW_VERSION) {
    throw commandError("invalid_payload", "onboarding.flowVersion drifted from the pinned flow version");
  }
  assertNoForbiddenKeys(record);
  const approval = record.approval === undefined
    ? undefined
    : (() => {
        const block = exactRecord(record.approval, ["actorId", "approvedAt"], "approval");
        // 감사에 남는 승인자 식별자는 내부 principal id 만 허용한다. 계약 공통
        // IDENTIFIER_RE 는 "@"·"." 를 허용해 이메일이 통과하므로(PII 원문 적재 경로)
        // 여기서만 더 좁은 문자셋을 강제한다.
        //
        // 길이 상한은 128 이다. 원래 64 였는데 Portal 의 실제 principal id 형식
        // `admin_` + sha256 hex(64) = 70자가 그 상한을 넘겨 **승인 커맨드가 전건 400 으로
        // 거절**됐다(2026-08-26 프로드, 7건). 64 라는 값에 계약적 근거가 없었고, 짧은 id 를
        // 가진 승인자는 통과하고 긴 id 를 가진 승인자는 막히는 — 값에 따라 갈리는 함정이었다.
        // PII 차단은 길이가 아니라 문자셋이 담당하므로("@"·"." 불허) 문자셋은 그대로 두고
        // 상한만 넉넉히 올린다.
        //
        // 2026-08-28: 같은 함정의 세 번째 변주가 났다. 위 수정은 **길이만** 올리고 문자셋은
        // 건드리지 않았는데, Portal 이 flu 관리자 화면 경유 승인에 붙이는 principal
        // `flu-bridge:<fluUid>` 는 **콜론을 포함**해 문자셋에서 걸렸다 — 8/27 09:10~09:13
        // 벌크 승인 21건이 전건 400(invalid_payload)으로 유실됐다. Portal UI/ops 승인
        // (`admin_<64hex>`, 콜론 없음)만 통과했으므로 또다시 "값에 따라 갈리는" 함정이다.
        //
        // 콜론을 일반 허용하지 않는다 — 그러면 PII 축이 다시 열릴 여지가 생긴다. 대신
        // **계보를 명시 열거**한다. Portal 이 와이어에 실을 수 있는 콜론 형식은
        // `flu-bridge:<fluUid>` 하나뿐임이 Portal 전수 grep 으로 확인됐고(그 외 승인 actor 는
        // `admin_<64hex>` 와 콜론 없는 내부 system actor 뿐), fluUid 는 Firebase UID 라
        // 영숫자다. 새 계보가 생기면 이 열거에 추가해야 한다 — 그게 감사 가능한 형태다.
        // "@"·"." ·공백 차단은 두 분기 모두에서 그대로 유지된다.
        const actorId = asString(block.actorId);
        if (!APPROVAL_ACTOR_ID_RE.test(actorId)) {
          throw commandError("invalid_payload", "approval.actorId must be an internal principal id");
        }
        return {
          actorId,
          approvedAt: requiredIso(block.approvedAt, "approval.approvedAt"),
        };
      })();
  return {
    schemaVersion,
    ...(approval === undefined ? {} : { approval }),
    commandTypes: record.commandTypes.map((type) => asString(type)),
    applicationId: requiredIdentifier(record.applicationId, "applicationId"),
    referenceCode: requiredIdentifier(record.referenceCode, "referenceCode"),
    programId: requiredIdentifier(record.programId, "programId"),
    // 승인 커맨드의 portalCreatorId 는 신규(§B) 전용 검증을 쓴다. applicationSubmitted 의
    // portalCreatorId 는 v1 부터 이미 신원 바인딩(scp_application_management.identity)에 쓰여
    // 온 기존 필드라 정확히 같은 검증(requiredIdentifier)을 유지한다 — 여기서 바꾸면 회귀다.
    ...(record.portalCreatorId === undefined
      ? {}
      : {
          portalCreatorId: isApproval
            ? requiredPortalCreatorId(record.portalCreatorId)
            : requiredIdentifier(record.portalCreatorId, "portalCreatorId"),
        }),
    ...(record.channelId === undefined
      ? {}
      : { channelId: requiredIdentifier(record.channelId, "channelId") }),
    locale: locale as (typeof LOCALES)[number],
    onboarding: {
      flowVersion: SCP_APPLICATION_ONBOARDING_FLOW_VERSION,
      grantId: requiredIdentifier(onboarding.grantId, "onboarding.grantId"),
      expiresAt: requiredIso(onboarding.expiresAt, "onboarding.expiresAt"),
    },
  };
}

export type FluApplicationCommandDeliveryState = "queued" | "processing" | "delivered" | "failed" | "dead_letter" | "handled_inline";

export type IngestScpFluApplicationCommandInput = {
  rawBody: string;
  timestamp: string;
  idempotencyKeyHeader: string;
  contractVersionHeader: string;
  signature: string;
  isHttps: boolean;
  hasBearerOrCookie: boolean;
  now?: Date;
  secret?: string;
  previousSecret?: string;
};

export type IngestScpFluApplicationCommandResult = {
  duplicate: boolean;
  deliveryState: FluApplicationCommandDeliveryState;
  attempts: number;
  commandId: string;
};

async function ingestFluApplicationRejectionCommand(
  parsed: unknown,
  input: IngestScpFluApplicationCommandInput,
): Promise<IngestScpFluApplicationCommandResult> {
  const command = normalizeFluApplicationRejectionCommand(parsed);
  const expectedKey = fluApplicationRejectionCommandId(command.applicationId, command.applicationRevision);
  if (input.idempotencyKeyHeader !== expectedKey || !REJECTION_COMMAND_ID_RE.test(input.idempotencyKeyHeader)) {
    throw commandError("idempotency_mismatch", "idempotency key must be the exact rejection command document id");
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const bodyHash = sha256(input.rawBody);
  const commandRef = adminDb.collection(FLU_APPLICATION_REJECTION_COMMAND_COLLECTION).doc(expectedKey);
  const auditRef = adminDb.collection(FLU_APPLICATION_COMMAND_AUDIT_COLLECTION).doc();
  const result = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(commandRef);
    if (snapshot.exists) {
      const existing = snapshot.data() ?? {};
      if (asString(existing.bodyHash) !== bodyHash) {
        transaction.create(auditRef, {
          operation: "application_rejection_command_conflict",
          commandId: commandRef.id,
          applicationId: command.applicationId,
          applicationRevision: command.applicationRevision,
          bodyHash,
          existingBodyHash: asString(existing.bodyHash),
          recordedAtIso: nowIso,
          recordedAt: FieldValue.serverTimestamp(),
        });
        throw commandError("command_conflict", "rejection command id was reused with different bytes");
      }
      return {
        duplicate: true,
        deliveryState: "handled_inline" as FluApplicationCommandDeliveryState,
        attempts: Number(existing.attempts ?? 0),
        commandId: commandRef.id,
      };
    }
    transaction.create(commandRef, {
      id: commandRef.id,
      contractVersion: command.schemaVersion,
      commandTypes: command.commandTypes,
      applicationId: command.applicationId,
      applicationRevision: command.applicationRevision,
      referenceCode: command.referenceCode,
      programId: command.programId,
      locale: command.locale,
      reasonCode: command.rejection.reasonCode,
      receiptSourceEventId: command.rejection.receiptSourceEventId,
      publicReasonText: command.rejection.publicMessage,
      bodyHash,
      deliveryState: "handled_inline",
      attempts: 0,
      nextAttemptAtIso: nowIso,
      lastErrorCode: null,
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(auditRef, {
      operation: "application_rejection_command_accepted",
      commandId: commandRef.id,
      applicationId: command.applicationId,
      applicationRevision: command.applicationRevision,
      referenceCode: command.referenceCode,
      programId: command.programId,
      reasonCode: command.rejection.reasonCode,
      recordedAtIso: nowIso,
      recordedAt: FieldValue.serverTimestamp(),
    });
    return {
      duplicate: false,
      deliveryState: "handled_inline" as FluApplicationCommandDeliveryState,
      attempts: 0,
      commandId: commandRef.id,
    };
  });

  try {
    // Task-35: 결과를 버리지 않는다 — wrote:false(기존 행이 queued 가 아니라 슬롯이 점유됨)를
    // 조용히 넘기면 이 정식(Portal 서명) 반려 메일이 감사 흔적 없이 영구 누락된다.
    const outcome = await enqueueLoginRejectedMailOutbox({
      applicationId: command.applicationId,
      programId: command.programId,
      reasonCode: command.rejection.reasonCode,
      sourceContract: command.schemaVersion,
      sourceEventId: command.rejection.receiptSourceEventId,
      applicationRevision: command.applicationRevision,
      publicReasonText: command.rejection.publicMessage,
      nowIso,
    });
    if (!outcome.wrote) {
      await recordLoginRejectedMailOutboxSlotOccupied({
        applicationId: command.applicationId,
        reasonCode: command.rejection.reasonCode,
        existingDeliveryState: outcome.existingDeliveryState,
        now,
        source: "portal_rejection_command",
      });
    }
  } catch (error) {
    await recordLoginRejectedMailEnqueueFailure({
      applicationId: command.applicationId,
      reasonCode: command.rejection.reasonCode,
      error,
      now,
      source: "portal_rejection_command",
    });
  }

  return result;
}

// 좁은 보강(enrichment) 경로 전용 헬퍼 — 신뢰 경계는 여기다.
//
// 기존 v1 문서는 원본 바디를 통째로 보관하지 않고 bodyHash 만 갖고 있을 수 있다. 그래서
// "새 v2 바디가 옛 v1 바디와 portalCreatorId·schemaVersion 을 뺀 나머지가 정확히 같다"를
// 확인하는 유일한 방법은, 새로 도착한(파싱된) v2 바디에서 portalCreatorId 키를 제거하고
// schemaVersion 값을 v1 로 되돌린 재구성 객체를 만들어 그 해시가 기존 bodyHash 와 맞는지 보는
// 것뿐이다. Object.entries 는 JSON.parse 가 만든 원래 키 순서를 그대로 보존하므로, Portal 이
// v1 바디를 그대로 쓰고 portalCreatorId 만 추가했다면(키 순서 불변) 재구성 결과가 원본과
// byte-identical 해진다. 다른 필드가 하나라도 바뀌었거나 키 순서가 달라지면 해시가 어긋나고,
// 그 경우 보수적으로 409 로 떨어진다(호출부에서 처리) — 여기서는 참/거짓만 보고한다.
function reconstructPriorContractBodyHash(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const reconstructed: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(record)) {
    if (key === "portalCreatorId") continue;
    reconstructed[key] = key === "schemaVersion" ? SCP_FLU_APPLICATION_COMMAND_CONTRACT : entryValue;
  }
  return sha256(JSON.stringify(reconstructed));
}

// 보강 자격 판정 — §C 4조건을 전부 만족해야 true. 하나라도 어긋나면 호출부가 기존과 동일하게
// 409 command_conflict 로 떨어뜨린다.
function evaluateFluApplicationCommandEnrichment(input: {
  parsed: unknown;
  command: NormalizedFluApplicationCommand;
  isApprovalCommand: boolean;
  existing: FirebaseFirestore.DocumentData;
}): boolean {
  const { parsed, command, isApprovalCommand, existing } = input;
  if (!isApprovalCommand) return false; // (4) applicationApproved 만.
  if (command.schemaVersion !== SCP_FLU_APPLICATION_COMMAND_CONTRACT_V2) return false; // (1) 새 바디는 v2.
  if (asString(existing.contractVersion) !== SCP_FLU_APPLICATION_COMMAND_CONTRACT) return false; // (1) 기존은 v1.
  if (command.portalCreatorId === undefined) return false; // 보강할 값이 없으면 보강이 아니다.
  const existingPortalCreatorId = asString(existing.portalCreatorId);
  if (existingPortalCreatorId && existingPortalCreatorId !== command.portalCreatorId) return false; // (3)
  const reconstructedHash = reconstructPriorContractBodyHash(parsed); // (2)
  return reconstructedHash !== null && reconstructedHash === asString(existing.bodyHash);
}

// 명령 수신 → Flu 소유 UID 안내 outbox 큐잉. 응답에는 전달 상세가 절대 없다
// (Portal 은 상태코드만 소비: 2xx/409 = accepted, 408/425/429/5xx = retry, 그 외 4xx = rejected).
export async function ingestScpFluApplicationCommand(
  input: IngestScpFluApplicationCommandInput,
): Promise<IngestScpFluApplicationCommandResult> {
  verifyScpPortalIngressAuth({
    rawBody: input.rawBody,
    timestamp: input.timestamp,
    idempotencyKey: input.idempotencyKeyHeader,
    signature: input.signature,
    isHttps: input.isHttps,
    hasBearerOrCookie: input.hasBearerOrCookie,
    contractVersionHeader: input.contractVersionHeader,
    expectedContractVersion: SCP_FLU_APPLICATION_COMMAND_CONTRACTS,
    secret: input.secret,
    previousSecret: input.previousSecret,
    secretEnv: SCP_FLU_APPLICATION_COMMAND_SECRET_ENV,
    previousSecretEnv: SCP_FLU_APPLICATION_COMMAND_PREVIOUS_SECRET_ENV,
    maxBodyBytes: SCP_FLU_APPLICATION_COMMAND_MAX_BODY_BYTES,
    now: input.now,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    throw commandError("invalid_payload", "invalid application-command JSON");
  }
  if (asString(asRecord(parsed).schemaVersion) === SCP_FLU_APPLICATION_REJECTION_COMMAND_CONTRACT) {
    return ingestFluApplicationRejectionCommand(parsed, input);
  }
  const command = normalizeFluApplicationCommand(parsed);
  const isApprovalCommand = command.commandTypes.includes("applicationApproved");
  const isApplicationSubmittedCommand = command.commandTypes.includes("applicationSubmitted");
  const expectedKey = isApprovalCommand
    ? fluApplicationApprovalCommandId(command.applicationId)
    : fluApplicationCommandId(command.applicationId);
  const expectedKeyRe = isApprovalCommand ? APPROVAL_COMMAND_ID_RE : COMMAND_ID_RE;
  if (input.idempotencyKeyHeader !== expectedKey || !expectedKeyRe.test(input.idempotencyKeyHeader)) {
    throw commandError("idempotency_mismatch", "idempotency key must be the exact command document id");
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const bodyHash = sha256(input.rawBody);
  const commandRef = adminDb.collection(FLU_APPLICATION_COMMAND_COLLECTION).doc(expectedKey);
  const confirmationMailRef = adminDb
    .collection(SCP_APPLICATION_CONFIRMED_MAIL_OUTBOX_COLLECTION)
    .doc(applicationConfirmedMailOutboxDocId(command.applicationId));
  const auditRef = adminDb.collection(FLU_APPLICATION_COMMAND_AUDIT_COLLECTION).doc();
  // 승인 명령은 접수확인 메일을 만들지 않으므로 템플릿 resolve 자체를 건너뛴다(트랜잭션 내
  // 사용처는 applicationSubmitted 조건 안에만 있다).
  const confirmationTemplate = !isApplicationSubmittedCommand
    ? undefined
    : await resolveScpReceiptMailTemplate(
      "application_confirmed",
      {
        application_id: command.applicationId,
        program_name: command.programId,
        reference_code: command.referenceCode,
      },
    );

  // 보강 여부는 응답 형태를 오염시키지 않도록 바깥 플래그로 든다(응답 계약은 4필드 고정).
  // 트랜잭션은 재시도될 수 있으므로 클로저 진입 시마다 초기화한다.
  let enrichedContract = false;
  const result = await adminDb.runTransaction(async (transaction) => {
    enrichedContract = false;
    const [snapshot, confirmationMailSnapshot] = await Promise.all([
      transaction.get(commandRef),
      transaction.get(confirmationMailRef),
    ]);
    if (snapshot.exists) {
      const existing = snapshot.data() ?? {};
      if (asString(existing.bodyHash) !== bodyHash) {
        const enrichmentEligible = evaluateFluApplicationCommandEnrichment({
          parsed,
          command,
          isApprovalCommand,
          existing,
        });
        if (!enrichmentEligible) {
          // 같은 명령 ID 로 다른 바이트 — grant 재발급 없이 내용이 바뀌는 것은 계약 위반.
          // 409 는 Portal 쪽에서 accepted(duplicate) 로 착지하므로 재시도 폭주 없이 감사로 남긴다.
          transaction.create(auditRef, {
            operation: "application_command_conflict",
            commandId: commandRef.id,
            applicationId: command.applicationId,
            bodyHash,
            existingBodyHash: asString(existing.bodyHash),
            recordedAtIso: nowIso,
            recordedAt: FieldValue.serverTimestamp(),
          });
          throw commandError("command_conflict", "command id was reused with different bytes");
        }
        // 좁은 보강: 신원 필드(portalCreatorId)·계약 버전·bodyHash 만 갱신한다. deliveryState·
        // attempts·onboardingEnqueueState 는 손대지 않는다 — 이건 커맨드 재실행이 아니다(§D).
        const existingBodyHash = asString(existing.bodyHash);
        transaction.update(commandRef, {
          portalCreatorId: command.portalCreatorId,
          contractVersion: command.schemaVersion,
          bodyHash,
          enrichedFromBodyHash: existingBodyHash,
          enrichedAtIso: nowIso,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.create(auditRef, {
          operation: "application_command_contract_enriched",
          commandId: commandRef.id,
          applicationId: command.applicationId,
          bodyHash,
          enrichedFromBodyHash: existingBodyHash,
          recordedAtIso: nowIso,
          recordedAt: FieldValue.serverTimestamp(),
        });
        enrichedContract = true;
        return {
          duplicate: true,
          deliveryState: (asString(existing.deliveryState) || "handled_inline") as FluApplicationCommandDeliveryState,
          attempts: Number(existing.attempts ?? 0),
          commandId: commandRef.id,
        };
      }
      return {
        duplicate: true,
        deliveryState: (asString(existing.deliveryState) || "queued") as FluApplicationCommandDeliveryState,
        attempts: Number(existing.attempts ?? 0),
        commandId: commandRef.id,
      };
    }
    transaction.create(commandRef, {
      id: commandRef.id,
      contractVersion: command.schemaVersion,
      commandTypes: command.commandTypes,
      applicationId: command.applicationId,
      referenceCode: command.referenceCode,
      programId: command.programId,
      locale: command.locale,
      onboardingFlowVersion: command.onboarding.flowVersion,
      // grantId 는 Portal opaque digest — 자료 회수는 commandId 로만 하므로 해시만 보관.
      grantIdHash: sha256(command.onboarding.grantId),
      grantExpiresAtIso: command.onboarding.expiresAt,
      bodyHash,
      ...(command.portalCreatorId ? { portalCreatorId: command.portalCreatorId } : {}),
      // Approval commands need no drain-based delivery (their work happens right below), so
      // they are stamped with their own terminal state at creation. "queued" would sit
      // forever in the drain's [queued,failed] pool; "delivered" would pollute any report
      // that reads delivered as drain success. "handled_inline" is outside every drain
      // query and unambiguous in the read model.
      deliveryState: (isApprovalCommand ? "handled_inline" : "queued") satisfies FluApplicationCommandDeliveryState,
      ...(command.approval
        ? { approvedByActorId: command.approval.actorId, approvedAtIso: command.approval.approvedAt }
        : {}),
      // 초기값을 항상 스탬프해 "필드 부재" 상태 자체를 없앤다 — 커밋 직후 크래시(C2-c)도
      // 적체 카운터(approvalOnboardingBacklog)에 즉시 잡힌다. 비종결이라 복구 대상.
      ...(isApprovalCommand ? { onboardingEnqueueState: "pending_enqueue" } : {}),
      attempts: 0,
      nextAttemptAtIso: nowIso,
      lastErrorCode: null,
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (
      isApplicationSubmittedCommand &&
      !confirmationMailSnapshot.exists
    ) {
      transaction.create(
        confirmationMailRef,
        applicationConfirmedMailOutboxRow({
          applicationId: command.applicationId,
          programId: command.programId,
          referenceCode: command.referenceCode,
          eventId: expectedKey,
          traceId: expectedKey,
          sourceContract: SCP_FLU_APPLICATION_COMMAND_CONTRACT,
          templateSnapshot: confirmationTemplate,
          nowIso,
        }),
      );
    }
    transaction.create(auditRef, {
      operation: "application_command_queued",
      commandId: commandRef.id,
      applicationId: command.applicationId,
      referenceCode: command.referenceCode,
      programId: command.programId,
      commandTypes: command.commandTypes,
      grantExpiresAtIso: command.onboarding.expiresAt,
      recordedAtIso: nowIso,
      recordedAt: FieldValue.serverTimestamp(),
    });
    return {
      duplicate: false,
      deliveryState: (isApprovalCommand ? "handled_inline" : "queued") as FluApplicationCommandDeliveryState,
      attempts: 0,
      commandId: commandRef.id,
    };
  });
  // 좁은 보강은 신원 필드만 추가하는 것이지 커맨드 재실행이 아니다(§D) — materialize 도
  // runApprovalOnboardingEnqueue 도 다시 태우지 않고 여기서 바로 반환한다.
  if (enrichedContract) {
    return result;
  }

  // B2-7: accepted Apply 의 완료 조건은 **지원 완료 메일 outbox + scp_application_management 두
  // projection 이 모두 존재**하는 것이다. v1 command 경로는 지금까지 메일만 만들고 management 를
  // 만들지 않아 "메일은 갔는데 관리에 안 보이는" 반쪽 상태가 실제로 가능했다.
  //
  // - fresh applicationSubmitted 만 v3 intake 와 **같은** materializeApplicationManagementRecord 로
  //   수렴한다(경로별 사본 금지). duplicate replay 는 기존 "historical accepted command receipts
  //   are not scanned/backfilled into mail" 계약을 보존한다.
  // - signed attribution 이 없는 v1 은 계약대로 unclassified/token_absent/manageInbox=true 로 남고
  //   campaign 을 추측하지 않는다(signedTokenEvidence 미전달 = fail-closed).
  // - 트랜잭션 밖에서 실행한다(자체 트랜잭션). 실패해도 명령 응답을 뒤집지 않는다: 포털은 같은
  //   fresh 제출 명령을 재시도할 수 있고, 커맨드 원장은 이미 durable 하다.
  // - **applicationApproved 는 materialize 를 태우지 않는다.** 배송 순서 역전(승인 명령이 제출
  //   명령보다 먼저 도착)으로 승인 명령이 첫 명령이 되면, fresh-create 가 승인 수신 시각을
  //   submittedAtIso 로 오염시키고 이미 승인된 크리에이터에게 application_confirmed(지원 접수)
  //   메일을 새로 쏠 수 있다. 생성은 제출 명령 전담이고, 역전 창의 승인 명령은
  //   onboardingEnqueueState="pending_application_record" 로 남았다가 **제출 명령이 도착해
  //   관리 레코드를 만든 직후 이 자리에서 복구 큐잉된다** — 스케줄러 없이 이벤트 주도로 닫히는
  //   복구 루프라, "커맨드는 수락됐는데 메일 큐잉이 영영 안 일어나는" 상태가 존재하지 않는다.
  if (isApplicationSubmittedCommand && !result.duplicate) {
  let materializedClassification: string | null = null;
  try {
    const materialized = await materializeApplicationManagementRecord(
      {
        applicationId: command.applicationId,
        programId: command.programId,
        // v1 command 에는 캠페인·아웃리치 귀속이 없다. 추측하지 않는다.
        campaignId: null,
        outreachId: null,
        portalCreatorId: command.portalCreatorId ?? null,
        channelId: command.channelId ?? null,
        // 포털 제출 시각이 명령에 없다 — 명령 수신 시각을 쓰되 출처를 함께 남겨서 화면이 이 값을
        // 포털 제출 시각으로 오해하지 않게 한다.
        submittedAtIso: nowIso,
        submittedAtSource: "flu_application_command_received",
        traceId: expectedKey,
        eventId: expectedKey,
        revision: 1,
        sourceContract: SCP_FLU_APPLICATION_COMMAND_CONTRACT,
      },
      now,
    );
    materializedClassification = materialized.classification;
  } catch (error) {
    console.warn(
      "[scp-flu-application-command] management_materialize_pending",
      JSON.stringify({
        applicationId: command.applicationId,
        commandId: commandRef.id,
        duplicate: result.duplicate,
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
  // managed materialize 는 자체 훅으로 이미 복구를 발사했다(HIGH-1) — 여기서 또 부르면
  // 감사가 2건 남는다(4차 리뷰 LOW). unclassified/실패 경로만 명시 복구로 pending 을
  // 관측 가능한 상태(blocked 등)로 전이시킨다.
  if (materializedClassification !== "managed") {
    await recoverPendingApprovalOnboarding(command.applicationId, now);
  }
  } else if (isApprovalCommand) {
    await runApprovalOnboardingEnqueue(
      {
        applicationId: command.applicationId,
        approvedByActorId: command.approval?.actorId ?? null,
        commandRef,
        duplicate: result.duplicate,
        programId: command.programId,
        trigger: "approval_command",
      },
      now,
    );
    // 헤세 확정(26-08-27): 승인이 flu 화면에서든 포털 admin 에서든 로그인 승인 메일이 자동으로
    // 나간다. flu 화면 경로는 admin-bridge callable 이 적재하고, 포털 경로는 승인 커맨드가
    // 여기 도착하므로 이 지점이 대칭 적재 자리다. 결정적 docId(login_approved_<appId>)라
    // 두 경로가 겹쳐도 한 행으로 수렴하고, 재전송(duplicate)도 멱등이다. fire-and-forget —
    // 실패는 커맨드 수락을 뒤집지 않는다.
    await enqueueLoginApprovedMailFromApprovalCommand(
      command.applicationId,
      command.programId,
      now,
    );
  }

  return result;
}

// ---- 보호 전달자료 회수 (Flu -> Portal, HMAC, private/no-store) -----------------

export type PortalDeliveryMaterial = {
  recipientEmail: string;
  uidGuideUrl: string;
  expiresAt: string;
};

export function signFluMaterialRequestForTest(
  rawBody: string,
  timestamp: string,
  commandId: string,
  secret: string,
): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}\n${commandId}\n${rawBody}`).digest("hex")}`;
}

export type FetchPortalDeliveryMaterialOptions = {
  materialUrl?: string;
  secret?: string;
  now?: Date;
  fetcher?: typeof fetch;
};

// Portal 자료 엔드포인트 호출 — 응답 본문은 메모리 한정. 어떤 필드도 로그/영속 금지.
export async function fetchScpPortalDeliveryMaterial(
  commandId: string,
  options: FetchPortalDeliveryMaterialOptions = {},
): Promise<PortalDeliveryMaterial> {
  if (!COMMAND_ID_RE.test(commandId)) {
    throw commandError("invalid_payload", "commandId shape is invalid");
  }
  const explicitMaterialUrl =
    options.materialUrl ??
    process.env[SCP_PORTAL_DELIVERY_MATERIAL_URL_ENV] ??
    "";
  const baseUrl =
    process.env[SCP_PORTAL_CREATOR_PIPELINE_V3_BASE_URL_ENV] ?? "";
  let materialUrl = explicitMaterialUrl;
  if (!materialUrl && baseUrl) {
    try {
      materialUrl = new URL(
        "/api/internal/flu/application-command-delivery",
        baseUrl,
      ).toString();
    } catch {
      materialUrl = "";
    }
  }
  const secret = options.secret ?? process.env[SCP_FLU_APPLICATION_COMMAND_SECRET_ENV] ?? "";
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(materialUrl);
  } catch {
    throw commandError("delivery_material_unconfigured", "portal material URL is not configured");
  }
  const loopbackEmulator = process.env.FUNCTIONS_EMULATOR === "true"
    && /^(?:localhost|127\.0\.0\.1)$/.test(parsedUrl.hostname);
  if ((parsedUrl.protocol !== "https:" && !loopbackEmulator) || parsedUrl.username || parsedUrl.password || parsedUrl.hash) {
    throw commandError("delivery_material_unconfigured", "portal material URL must be exact HTTPS");
  }
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw commandError("delivery_material_unconfigured", "portal material secret is not configured");
  }
  const rawBody = JSON.stringify({ commandId });
  const timestamp = String(Math.floor((options.now ?? new Date()).getTime() / 1000));
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(parsedUrl.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-scp-idempotency-key": commandId,
        "x-scp-timestamp": timestamp,
        "x-scp-signature": signFluMaterialRequestForTest(rawBody, timestamp, commandId, secret),
      },
      body: rawBody,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw commandError("delivery_material_unavailable", "portal material endpoint transport failure");
  }
  if (!response.ok) {
    // Portal 은 모든 거부를 generic 403 으로 응답한다 — 사유를 추측/로그하지 않는다.
    throw commandError("delivery_material_unavailable", "portal denied delivery material");
  }
  let envelope: Record<string, unknown>;
  try {
    envelope = asRecord(await response.json());
  } catch {
    throw commandError("delivery_material_unavailable", "portal material envelope is not JSON");
  }
  const delivery = asRecord(envelope.delivery);
  const material: PortalDeliveryMaterial = {
    recipientEmail: asString(delivery.recipientEmail),
    uidGuideUrl: asString(delivery.uidGuideUrl),
    expiresAt: asString(delivery.expiresAt),
  };
  if (
    envelope.schemaVersion !== SCP_FLU_DELIVERY_MATERIAL_CONTRACT
    || asString(envelope.commandId) !== commandId
    || !material.recipientEmail.includes("@")
    || !/^https:\/\//.test(material.uidGuideUrl)
    || !material.expiresAt
  ) {
    throw commandError("delivery_material_unavailable", "portal material envelope drifted from the contract");
  }
  return material;
}

export const SCP_RECEIPT_MAIL_DELIVERY_MATERIAL_PATH =
  "/api/internal/flu/receipt-mail-delivery-material" as const;
export const SCP_RECEIPT_MAIL_DELIVERY_MATERIAL_REQUEST_VERSION =
  "scp.receipt-mail.delivery-material-request.v1" as const;
export const SCP_RECEIPT_MAIL_DELIVERY_MATERIAL_RESPONSE_VERSION =
  "scp.receipt-mail.delivery-material-response.v1" as const;

export type PortalReceiptMailMaterialRequest =
  | Readonly<{
      schemaVersion: typeof SCP_RECEIPT_MAIL_DELIVERY_MATERIAL_REQUEST_VERSION;
      kind: "application_confirmed";
      sourceContract: typeof SCP_FLU_APPLICATION_COMMAND_CONTRACT;
      sourceEventId: string;
      applicationId: string;
      programId: string;
    }>
  | Readonly<{
      schemaVersion: typeof SCP_RECEIPT_MAIL_DELIVERY_MATERIAL_REQUEST_VERSION;
      kind: "content_submitted";
      sourceContract: "scp.integration-event.v2";
      sourceEventId: string;
      applicationId: string;
      programId: string;
      traceId: string;
      videoSubmissionId: string;
      videoRevision: number;
    }>
  // W91 [헤세 · admin-bridge 승인 메일]: sourceEventId 는 승인 커맨드가 Portal admin-bridge 로 보낸
  // 요청의 이벤트 id(scpAdminBridgeClient 가 만드는 `req_`+32hex) — 그 요청과 이 material 회수를
  // 같은 키로 묶어 두 번째 승인 없이는 material 이 나오지 않게 한다.
  | Readonly<{
      schemaVersion: typeof SCP_RECEIPT_MAIL_DELIVERY_MATERIAL_REQUEST_VERSION;
      kind: "login_approved";
      sourceContract: "scp.flu.admin-bridge.v1";
      sourceEventId: string;
      applicationId: string;
      programId: string;
    }>
  // 반려 안내 메일(계약 26-08-27, cod-92 합의): sourceEventId 는 포털 reject 트랜잭션이 민팅하는
  // 파생 앵커(`req_` + sha256("login_rejected_" + applicationId).hex[0:32]) — 브릿지 커맨드의
  // attempt-scoped 영수증과 별개다(그 자리는 파생 id 영수증이 없다, approve 와 같은 이유).
  // 반려자는 v1 delivery-material 을 못 쓴다(canEnterOnboarding 게이트가 rejected 를 403 차단,
  // 포털 실측) — 이 kind 가 반려 레인의 유일한 수신자 회수 경로다.
  | Readonly<{
      schemaVersion: typeof SCP_RECEIPT_MAIL_DELIVERY_MATERIAL_REQUEST_VERSION;
      kind: "application_rejected";
      sourceContract: "scp.flu.admin-bridge.v1";
      sourceEventId: string;
      applicationId: string;
      programId: string;
    }>;

export type PortalReceiptMailMaterial = Readonly<{
  recipientEmail: string;
  recipientEmailSha256: string;
  // W91: absent for "login_approved" — that material response carries no traceId (pinned shape is
  // exactly { recipientEmail, recipientEmailSha256, loginUrl }).
  traceId?: string;
  campaignId?: string;
  outreachId?: string;
  videoSubmissionId?: string;
  videoRevision?: number;
  /** W91: https login URL, present only for kind "login_approved". */
  loginUrl?: string;
}>;

export type FetchPortalReceiptMailMaterialOptions = Readonly<{
  baseUrl?: string;
  secret?: string;
  now?: Date;
  fetcher?: typeof fetch;
}>;

const RECEIPT_EVENT_ID_RE = /^evt_[a-f0-9]{32}$/;
const RECEIPT_TRACE_ID_RE = /^tr_[A-Za-z0-9._:-]{8,120}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

// Receipt-only material lookup for an already-accepted event. Portal remains the
// source of truth; Flu receives only the normalized address and bounded IDs.
export async function fetchScpPortalReceiptMailMaterial(
  input: PortalReceiptMailMaterialRequest,
  options: FetchPortalReceiptMailMaterialOptions = {},
): Promise<PortalReceiptMailMaterial | null> {
  try {
    if (
      input.schemaVersion !==
        SCP_RECEIPT_MAIL_DELIVERY_MATERIAL_REQUEST_VERSION ||
      !IDENTIFIER_RE.test(input.applicationId) ||
      !IDENTIFIER_RE.test(input.programId) ||
      (input.kind === "application_confirmed"
        ? input.sourceContract !== SCP_FLU_APPLICATION_COMMAND_CONTRACT ||
          !COMMAND_ID_RE.test(input.sourceEventId)
        : input.kind === "content_submitted"
          ? input.sourceContract !== "scp.integration-event.v2" ||
            !RECEIPT_EVENT_ID_RE.test(input.sourceEventId) ||
            !RECEIPT_TRACE_ID_RE.test(input.traceId) ||
            !IDENTIFIER_RE.test(input.videoSubmissionId) ||
            !Number.isSafeInteger(input.videoRevision) ||
            input.videoRevision < 1
          // W91 [헤세 · admin-bridge 승인 메일]: kind "login_approved".
          // 반려 레인(kind "application_rejected")도 같은 제약이다(admin-bridge 계보 + req_ 파생 id).
          : input.sourceContract !== "scp.flu.admin-bridge.v1" ||
            !ADMIN_BRIDGE_EVENT_ID_RE.test(input.sourceEventId))
    ) {
      return null;
    }
    const secret =
      options.secret ??
      process.env[SCP_FLU_APPLICATION_COMMAND_SECRET_ENV] ??
      "";
    const baseUrl = new URL(
      options.baseUrl ??
        process.env[SCP_PORTAL_CREATOR_PIPELINE_V3_BASE_URL_ENV] ??
        "",
    );
    const loopbackEmulator =
      process.env.FUNCTIONS_EMULATOR === "true" &&
      /^(?:localhost|127\.0\.0\.1)$/.test(baseUrl.hostname);
    if (
      Buffer.byteLength(secret, "utf8") < 32 ||
      (baseUrl.protocol !== "https:" && !loopbackEmulator) ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      return null;
    }
    const rawBody = JSON.stringify(input);
    const timestamp = String(
      Math.floor((options.now ?? new Date()).getTime() / 1_000),
    );
    const response = await (options.fetcher ?? fetch)(
      new URL(SCP_RECEIPT_MAIL_DELIVERY_MATERIAL_PATH, baseUrl).toString(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-scp-event-id": input.sourceEventId,
          "x-scp-idempotency-key": input.sourceEventId,
          "x-scp-timestamp": timestamp,
          "x-scp-signature": signFluMaterialRequestForTest(
            rawBody,
            timestamp,
            input.sourceEventId,
            secret,
          ),
        },
        body: rawBody,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return null;
    const responseBody = await response.text();
    if (Buffer.byteLength(responseBody, "utf8") > 8 * 1024) return null;
    const delivery = asRecord(asRecord(JSON.parse(responseBody)).delivery);
    const isLoginApproved = input.kind === "login_approved";
    // 계약 26-08-27: "application_rejected" material 은 exact 8키다 — traceId·loginUrl·referenceCode
    // 어느 것도 싣지 않는다(카피에 변수가 없다, 최소 계약).
    const isApplicationRejected = input.kind === "application_rejected";
    const required = [
      "applicationId",
      "kind",
      "programId",
      "recipientEmail",
      "recipientEmailSha256",
      "schemaVersion",
      "sourceContract",
      "sourceEventId",
      // W91: "login_approved" material carries no traceId — the pinned shape is exactly
      // { recipientEmail, recipientEmailSha256, loginUrl }.
      ...(isLoginApproved ? ["loginUrl"] : isApplicationRejected ? [] : ["traceId"]),
    ];
    const allowed = new Set(
      isLoginApproved || isApplicationRejected
        ? required
        : input.kind === "application_confirmed"
          ? [...required, "campaignId", "outreachId"]
          : [
              ...required,
              "campaignId",
              "outreachId",
              "videoSubmissionId",
              "videoRevision",
            ],
    );
    if (
      required.some((key) => !(key in delivery)) ||
      Object.keys(delivery).some((key) => !allowed.has(key))
    ) {
      return null;
    }
    const recipientEmail = asString(delivery.recipientEmail)
      .trim()
      .toLowerCase();
    const recipientEmailSha256 = asString(delivery.recipientEmailSha256);
    const traceId = asString(delivery.traceId);
    const campaignId = asString(delivery.campaignId);
    const outreachId = asString(delivery.outreachId);
    const loginUrl = asString(delivery.loginUrl);
    if (
      delivery.schemaVersion !==
        SCP_RECEIPT_MAIL_DELIVERY_MATERIAL_RESPONSE_VERSION ||
      delivery.kind !== input.kind ||
      delivery.sourceContract !== input.sourceContract ||
      asString(delivery.sourceEventId) !== input.sourceEventId ||
      asString(delivery.applicationId) !== input.applicationId ||
      asString(delivery.programId) !== input.programId ||
      (isLoginApproved
        ? !/^https:\/\//.test(loginUrl)
        : isApplicationRejected
          ? false
          : !RECEIPT_TRACE_ID_RE.test(traceId)) ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipientEmail) ||
      !SHA256_RE.test(recipientEmailSha256) ||
      recipientEmailSha256 !== sha256(recipientEmail) ||
      (campaignId !== "" && !IDENTIFIER_RE.test(campaignId)) ||
      (outreachId !== "" && !IDENTIFIER_RE.test(outreachId)) ||
      (input.kind === "content_submitted" &&
        (traceId !== input.traceId ||
          asString(delivery.videoSubmissionId) !==
            input.videoSubmissionId ||
          Number(delivery.videoRevision) !== input.videoRevision))
    ) {
      return null;
    }
    return {
      recipientEmail,
      recipientEmailSha256,
      ...(isLoginApproved || isApplicationRejected ? {} : { traceId }),
      ...(campaignId ? { campaignId } : {}),
      ...(outreachId ? { outreachId } : {}),
      ...(input.kind === "content_submitted"
        ? {
            videoSubmissionId: input.videoSubmissionId,
            videoRevision: input.videoRevision,
          }
        : {}),
      ...(isLoginApproved ? { loginUrl } : {}),
    };
  } catch {
    return null;
  }
}

// ---- 전달 drain: W124 에서 **정식 폐기** ------------------------------------------------
//
// `drainScpFluApplicationCommandOutbox` / `unconfiguredUidGuideDeliverer` / `UidGuideDeliverer` /
// `UidGuideMailIntent` 는 여기 있었다. 2026-08-24 에 삭제했다. 사유:
//
//  · **프로덕션 호출부가 처음부터 없었다.** onSchedule/onCall/onRequest 어디에도 연결된 적이 없고
//    (functions/index.ts 는 이 심볼을 import 조차 하지 않는다), 배포 산출물 functions/lib/index.js
//    에서 참조 0회다. 기본 deliverer 는 무조건 throw 하는 fail-closed 스텁이었다. 실측 결과
//    `scp_flu_application_commands` 136행 전량 queued · attempts 0 · 감사 원장 전량
//    `application_command_queued` — `uid_guide_delivered`/`_failed`/`_dead_letter` 0건.
//  · **살려 두면 이중 발송 경로다.** 같은 UID 안내 메일을 `scp_integration_event_v2_uid_guide_outbox`
//    (scpUidGuideMailWorker, 5분 스케줄로 실제 배선됨)도 보낸다. 두 원장 사이에 dedupe 가 없어
//    실측 60행 중 56행이 양쪽에 동시에 존재한다. 여기에 transport 를 붙이는 순간 그 56명은
//    **같은 메일을 두 번** 받는다.
//
// 수렴 결과: UID 안내 메일의 발송 주체는 `drainUidGuideOutbox` **하나뿐**이다. 이 레인이 갖고 있던
// 쓸모 있는 자산(Portal 전달자료 회수 `fetchScpPortalDeliveryMaterial`)은 그대로 남아 있고,
// 그 드레인이 material 사다리의 두 번째 단으로 호출한다 — 이미 receipt 메일 레인이
// `scpOutboxMailWorkers.resolveSignedMaterialRecipient` 에서 쓰던 것과 같은 순서다.
//
// `scp_flu_application_commands` 원장 자체는 유지한다: 접수 확인 메일 material 의 sourceEventId,
// UID 안내 material 의 commandId, 승인 온보딩 큐잉 상태가 전부 이 문서에 걸려 있다.

// ---- 운영 리포트 ---------------------------------------------------------------

const REPORT_ROLES = ["super_admin", "admin", "manager"] as const;

export async function getScpFluApplicationCommandReport(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_flu_application_command.report", REPORT_ROLES);
  // 2026-09-27 codex adversarial review round 2 sweep: no general-purpose UI reaches this report.
  await assertScpEntitled(auth, request, "scp_flu_application_command.report");
  const snapshot = await adminDb.collection(FLU_APPLICATION_COMMAND_COLLECTION)
    .orderBy("updatedAtIso", "desc")
    .limit(200)
    .get();
  const counts: Record<FluApplicationCommandDeliveryState, number> = {
    queued: 0, processing: 0, delivered: 0, failed: 0, dead_letter: 0, handled_inline: 0,
  };
  for (const doc of snapshot.docs) {
    const state = asString(doc.data()?.deliveryState) as FluApplicationCommandDeliveryState;
    if (state in counts) counts[state] += 1;
  }
  // 승인 온보딩 적체 관측면(M-1): 최근성 윈도우(limit 200, updatedAtIso desc)에 갇히면
  // **오래 주차된 것일수록 안 보인다** — 지표 목적과 정반대라 승인 명령만 전용 스캔한다.
  // array-contains 단일 필드 쿼리라 복합 인덱스가 필요 없고, 승인 명령 수는 작다.
  const approvalTerminal = new Set(["enqueued", "already_sent", "dead_letter"]);
  const approvalSnapshot = await adminDb.collection(FLU_APPLICATION_COMMAND_COLLECTION)
    .where("commandTypes", "array-contains", "applicationApproved")
    .limit(1000)
    .get();
  let approvalOnboardingBacklog = 0;
  for (const doc of approvalSnapshot.docs) {
    if (!approvalTerminal.has(asString(doc.data()?.onboardingEnqueueState))) approvalOnboardingBacklog += 1;
  }
  return {
    ok: true as const,
    scanned: snapshot.size,
    counts,
    approvalOnboardingBacklog,
    // W124: 이 원장의 `queued` 는 더 이상 "발송 대기"가 아니다 — 이 레인의 드레인은 폐기됐고
    // UID 안내 발송은 `drainUidGuideOutbox` 단일 레인이 담당한다. 리포트를 보는 사람이 이
    // 숫자를 발송 큐로 오독하지 않도록 사실을 그대로 싣는다(이 원장은 material 키·승인 온보딩
    // 상태의 보관처로 계속 쓰인다).
    uidGuideDrainRetired: true as const,
    transportConfigured: false,
    materialUrlConfigured: Boolean(
      process.env[SCP_PORTAL_DELIVERY_MATERIAL_URL_ENV] ||
        process.env[SCP_PORTAL_CREATOR_PIPELINE_V3_BASE_URL_ENV],
    ),
    behaviorLog: makeBehaviorLog(auth, "scp_flu_application_command.report", "success", "scp-automation"),
  };
}
