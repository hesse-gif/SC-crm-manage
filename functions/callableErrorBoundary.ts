import { HttpsError } from "firebase-functions/v2/https";

const CALLABLE_DETAIL_ERROR_CODES = new Set([
  // Case reply errors expose only stable reason codes, so a true CAS conflict can be
  // distinguished from runtime/provider conditions without returning raw mail or model data.
  "chat_auto_case_reply_revision_conflict",
  "chat_auto_case_reply_failed_precondition",
  "chat_auto_case_reply_dispatch_in_flight",
  "chat_auto_case_reply_rate_limited",
  "chat_auto_case_reply_invalid_argument",
  "chat_auto_case_reply_auto_send_refused",

  // sendEmail 사전 접근 검사 거부 — 코드만 통과(문서 id·수신자 미포함). UI 가 "Manager 이상" 대신 정확한 안내를 보여준다.
  "send_email_conversation_not_accessible",
  "send_email_reply_source_not_accessible",

  "scp_lifecycle_refresh_invalid_source",
  "scp_lifecycle_refresh_missing_source_ref",
  "scp_lifecycle_refresh_enqueue_failed",
  "scp_lifecycle_refresh_failed",
  "scp_lifecycle_refresh_failure_record_write_failed",
  "mail_signature_settings_read_failed",
  "mail_outbox_invalid_tracking_id",
  "mail_outbox_write_failed",
  "mail_outbox_lifecycle_enqueue_failed",
  "mail_outbox_reply_memoize_failed",
  "mail_open_event_write_failed",
  "mail_outbound_invalid_recipient",
  "mail_outbound_no_mx",
  "mail_outbound_hard_bounce",
  "mail_outbound_provider_suspension",
  "mail_outbound_rate_limit",
  "mail_outbound_temporary",
  "mail_outbound_safety_lock",
  "mail-safety.sent-import-imap-runtime-failed",
  "mail-safety.sent-import-mailbox-not-allowed",
  "mail-safety.sent-import-from-not-allowed",
  "mail-safety.sent-import-preview-required",
  "mail-safety.sent-import-preview-mismatch",
  "mail-safety.sent-import-preview-expired",
  "campaign_targets_program_not_open",
  "campaign_targets_kpi_filled",
  "application_management_revision_conflict",
  "application_management_revoked",
  "video_review_stale_precondition",
  "video_review_invalid_transition",
  "video_review_reason_required",
  "video_review_customer_message_required",
  "video_review_ai_not_permitted",
  "video_review_rejected",
  // W86-B: 검수 결정이 **이미 있는 아웃박스 행을 덮으려다** 되감긴 경우. 코드가 안 나가면 화면에는
  //   "현재 상태에서는 처리할 수 없습니다"만 남아, 운영자가 재시도만 반복하고 진짜 사유(같은 키의
  //   이전 결정 행이 살아 있다)를 끝내 못 본다. 코드만 통과시킨다 — 문서 id·수신자는 담기지 않는다.
  "video_review_outbox_grain_collision",
  // RAF 진단: 승인 확정이 PartnerActivationError 로 막힐 때 서버가 만든 안정 코드가 여기서
  // 걸러지면 화면에는 "현재 상태에서는 요청을 처리할 수 없습니다"만 남아 운영자가 진짜 사유를
  // 끝내 못 본다. 코드만 통과시킨다 — 원문 메시지·식별자·기술값은 담기지 않는다.
  "partner_activation_identity_incomplete",
  "partner_activation_identity_conflict",
  "partner_activation_not_current_revision",
  "partner_activation_withdrawn_revision",
  "partner_activation_already_revoked",
  "partner_activation_counter_drift",
  "partner_activation_unparseable",
  "partner_activation_rejected",
  "video_duplicate_fingerprint_absent",
  "video_duplicate_fingerprint_stale",
  // W8-11/W8-10: 콜드메일 웨이브 생성 실패 사유. 화면이 하류 필터명을 추측해 나열하지 않고
  // 서버가 센 **단계별 탈락 카운트**를 그대로 보여줄 수 있게 코드+counts 를 통과시킨다.
  "campaign_live_wave_no_targets",
  "campaign_live_wave_cap_exceeded",
  "campaign_targets_no_email_ready",
  "campaign_targets_all_suppressed",
  "campaign_targets_all_already_touched",
  // W8-FINAL R6: 국가 화이트리스트를 없앤 뒤에도 live-send 의사표시는 명시적이어야 한다. 두 거부는
  // 원인이 서로 다르므로(제외 적용 후 대상 0건 vs scope 자체가 비명시) 화면이 구분할 수 있게
  // 코드를 통과시킨다 — 국가값·수신자 정보는 담기지 않는다.
  "campaign_live_country_include_scope_empty",
  "campaign_live_country_scope_not_explicit",
  // R12: 라이브 콜드메일 템플릿 부재로 거부됐다는 사실은 운영자가 알아야 고칠 수 있다(조용한 폴백이
  // 실제 오발송을 냈다). programId 는 details 로 서버 로그에만 남기고 코드만 통과시킨다.
  "campaign_live_coldmail_template_missing",
  // W8-FIX C-2: 저장본이 서명 링크 변수를 쓰지 않는 구 마스터면 라이브 웨이브를 막는다.
  // 본문은 노출하지 않고 운영자가 저장본을 재발행할 수 있도록 고유 코드만 통과시킨다.
  "campaign_live_coldmail_template_stale",
  // W8-FINAL R8⑤: 콜드메일 본문 상한 초과는 이제 조용한 절단이 아니라 거부다. 무엇이 막혔는지
  // 알 수 없으면 운영자는 "왜 캠페인이 안 만들어지지"로 남는다 — 코드만 통과시킨다(본문 비노출).
  "coldmail_body_too_large",
  // W8-1b: 영수증/오버라이드 메일 템플릿의 저장·미리보기 거절 사유. 편집기가 "입력값을 확인해
  // 주세요" 대신 무엇이 막혔는지 보여줄 수 있게 **코드만** 통과시킨다(원문 메시지는 계속 비노출).
  "mail_template_field_required",
  "mail_template_subject_too_large",
  "mail_template_variables_invalid",
  "mail_template_unsafe_html",
  "mail_template_image_rejected",
  // W91 [헤세 · admin-bridge]: scpPortalCreatorCommand 가 그대로 통과시키는 포털 커맨드 거부 코드.
  //   operator UI 가 사유별로 다른 문구·행동(예: stale_revision → 새로고침)을 보여줘야 하므로
  //   실패 사유를 코드로 구분할 수 있어야 한다(원문 메시지는 계속 비노출).
  "stale_revision",
  "receipt_conflict",
  "application_workflow_required",
  "flu_creator_mapping_conflict",
  "superadmin_required",
  "program_forbidden",
  "scp_admin_bridge_command_unavailable",
  "scp_admin_bridge_command_rejected",
  // W91 정정(적대적 리뷰 MEDIUM-2): 콜러블 자체가 던지는 역할 부족 코드(creator.data-link 는
  //   admin/super_admin 만 — manager 는 여기서 거부된다).
  "scp_admin_bridge_command_role_forbidden",
  // W91 정정(적대적 리뷰 LOW): programEnrollments 필드별 검증 실패 코드. 편집기가 "어느 필드가
  //   틀렸는지" 힌트를 보여줄 수 있게 각각 등록한다(원문 메시지는 계속 비노출).
  "scp_admin_bridge_enrollment_empty",
  "scp_admin_bridge_enrollment_id_invalid",
  "scp_admin_bridge_enrollment_program_id_invalid",
  "scp_admin_bridge_enrollment_guide_release_id_invalid",
  "scp_admin_bridge_enrollment_policy_version_invalid",
  "scp_admin_bridge_enrollment_status_invalid",
  "scp_admin_bridge_enrollment_valid_from_invalid",
  "scp_admin_bridge_enrollment_valid_to_invalid",
  "scp_admin_bridge_enrollment_duplicate_pair",
  "scp_admin_bridge_enrollment_duplicate_active_program",
  "scp_admin_bridge_enrollment_default_conflict",
  "scp_admin_bridge_enrollment_default_requires_active",
]);
const CALLABLE_CORRELATION_HASH_RE = /^[a-f0-9]{24}$/;
type CallablePublicCode =
  | "unauthenticated"
  | "cancelled"
  | "unknown"
  | "invalid-argument"
  | "deadline-exceeded"
  | "failed-precondition"
  | "resource-exhausted"
  | "not-found"
  | "already-exists"
  | "permission-denied"
  | "aborted"
  | "out-of-range"
  | "unimplemented"
  | "internal"
  | "unavailable"
  | "data-loss";

const CALLABLE_PUBLIC_MESSAGES: Record<CallablePublicCode, string> = {
  unauthenticated: "Authentication is required.",
  cancelled: "The request was cancelled.",
  unknown: "The request could not be completed.",
  "invalid-argument": "The request contains invalid input.",
  "deadline-exceeded": "The request timed out. Try again later.",
  "failed-precondition": "The request cannot be completed in its current state.",
  "resource-exhausted": "The request limit has been reached. Try again later.",
  "not-found": "The requested resource was not found.",
  "already-exists": "The requested resource already exists.",
  "permission-denied": "You do not have permission to perform this request.",
  aborted: "The request was interrupted. Try again.",
  "out-of-range": "The request contains a value outside the allowed range.",
  unimplemented: "This request is not supported.",
  internal: "The request could not be completed.",
  unavailable: "The service is temporarily unavailable. Try again later.",
  "data-loss": "The request could not be completed safely.",
};

function ownDataField(value: unknown, field: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

const CALLABLE_DETAIL_COUNT_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;
const CALLABLE_DETAIL_COUNT_MAX_KEYS = 20;

/**
 * W8-10: 허용된 errorCode 에 한해 **정수 카운트만** 통과시킨다. 사유를 숫자로 보여주지 못하면
 * 화면이 "아마 이런 필터에 걸렸을 것"이라고 추측해 나열하게 되고(오도), 운영자는 어느 단계에서
 * 몇 건이 떨어졌는지 끝까지 알 수 없다. 문자열·중첩 객체·PII 는 통과하지 않는다.
 */
function callableErrorCounts(error: unknown): Record<string, number> | undefined {
  const raw = ownDataField(error, "counts");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!CALLABLE_DETAIL_COUNT_KEY_RE.test(key)) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) continue;
    counts[key] = value;
    if (Object.keys(counts).length >= CALLABLE_DETAIL_COUNT_MAX_KEYS) break;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function callableErrorDetails(error: unknown): Record<string, unknown> | undefined {
  const rawErrorCode = ownDataField(error, "errorCode");
  const rawCorrelationHash = ownDataField(error, "correlationIdHash");
  const errorCode = typeof rawErrorCode === "string"
    && CALLABLE_DETAIL_ERROR_CODES.has(rawErrorCode)
    ? rawErrorCode
    : "";
  const correlationIdHash = typeof rawCorrelationHash === "string"
    && CALLABLE_CORRELATION_HASH_RE.test(rawCorrelationHash.toLowerCase())
    ? rawCorrelationHash.toLowerCase()
    : "";
  if (!errorCode) return undefined;
  const counts = callableErrorCounts(error);
  return {
    errorCode,
    ...(correlationIdHash ? { correlationIdHash } : {}),
    ...(counts ? { counts } : {}),
  };
}

export function toHttpsError(error: unknown): HttpsError {
  const rawMessage = ownDataField(error, "message");
  const message = typeof rawMessage === "string"
    ? rawMessage
    : "Callable request denied.";
  const messageCode = message.match(/^([a-z-]+):/)?.[1];
  const rawOwnCode = ownDataField(error, "code");
  // Firestore surfaces missing-index failures as numeric gRPC status 9. Treat
  // that exact status as failed-precondition instead of letting the privacy
  // fallback mislabel an operational index defect as an authorization 403.
  const grpcCode = rawOwnCode === 9 ? "failed-precondition" : undefined;
  const rawCode = typeof rawOwnCode === "string" ? rawOwnCode : grpcCode ?? messageCode;
  const code = typeof rawCode === "string"
    && Object.prototype.hasOwnProperty.call(CALLABLE_PUBLIC_MESSAGES, rawCode)
    ? rawCode as CallablePublicCode
    : "permission-denied";
  return new HttpsError(code, CALLABLE_PUBLIC_MESSAGES[code], callableErrorDetails(error));
}

export function toCallableResponse<T>(result: T): T {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const descriptors = Object.getOwnPropertyDescriptors(result);
  if (!Object.prototype.hasOwnProperty.call(descriptors, "behaviorLog")) return result;
  delete descriptors.behaviorLog;
  return Object.defineProperties({}, descriptors) as T;
}
