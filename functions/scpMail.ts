import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { isDeterministicMailBlockRule } from "./mailSafetyPolicy";
import { selectOutboundMailAccountForData, sendEmailFromTrustedWorker } from "./chat-ai";
import { resolveConversationMailAccessScope } from "./conversationMailAccessScope";
import { CANONICAL_SCP_MAIL_ACCOUNT_ID, canReadScpConversationRowForOrg } from "./mailConversationAuthorization";
import { canonicalConversationIdForData } from "./conversationScope";
import {
  isHumanGateRequiredFromSettings,
  readScpAutomationSettings,
} from "./scpAutomationSettings";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  makeCache,
  makeCostLog,
  maskEmail,
  type CallableRequestShape,
} from "./shared";
import { safeDocId } from "./sheetIntakeService";
import { resolveMailDeliverability } from "./mailDeliverabilityVerification";
import { readSettings } from "./settings";
import { enqueueScpLifecycleRefreshEvent } from "./scpLifecycleProfiles";
// 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): see scpAutomationSettings.ts.
import { assertScpEntitled } from "./mailAccounts";
import {
  isStrictScpProviderConfirmed,
  SCP_RESULT_PROVIDER_VERIFIED_MIGRATION_MARKER,
} from "./scpResultMailDelivery";
import { enqueueProviderConfirmedReminderTriggerInBatch } from "./scpVideoSubmissionReminderStore";
import {
  RECEIPT_TEMPLATE_PREVIEW_VALUES,
  RECEIPT_TEMPLATE_RULES,
  evaluateScpMailTemplateLints,
  isScpEditableMailTemplateKind,
  renderScpReceiptMailTemplate,
  validateScpReceiptMailTemplate,
  type ScpEditableMailTemplateKind,
  isNudgeDraftMailTemplateKind,
  nudgeDraftMailTemplateBaseKind,
  SCP_MAIL_PLACEHOLDER_PATTERN,
  SCP_MAIL_RESIDUAL_PLACEHOLDER_PATTERN,
} from "./scpReceiptMailTemplates";
// W72 교정: 링크 정본은 하나여야 한다 — 복제하면 한쪽만 고쳐져 홈으로 가는 CTA 가 남는다.
import { REPLY_LINK_SUBMIT } from "./mailReplyLinks";
import {
  NUDGE_INTERNAL_PROVENANCE_FIELD,
  nudgeInflyExemptionApplies,
  scanActiveMailSuppressions,
} from "./mailSuppression";
import { serverOwnedMailLaneProvenance } from "./mailOutboundLanes";
import { SCP_PORTAL_APPLY_LINK } from "./admin";

/** 이 모듈이 sendEmail 에 싣는 `source`. mailOutboundLanes.SERVER_OWNED_MAIL_LANE_SOURCES 에 등재돼 있어야 한다. */
const SCP_RESULT_MAIL_LANE_SOURCE = "scp_result_mail";

export {
  isStrictScpProviderConfirmed,
  SCP_RESULT_PROVIDER_VERIFIED_MIGRATION_MARKER,
} from "./scpResultMailDelivery";

export type ScpMailTemplateKind =
  | "qualification_pass"
  | "qualification_fail"
  | "re_guide"
  | "encouragement"
  | "gem_paid_submission_request"
  | "video_submission_reminder"
  // W7-3b: HTML+텍스트 편집 대상(영수증 2종 + 오버라이드 2종). 오버라이드 2종은 문서가 없으면
  // 각 워커의 코드 렌더러가 fallback 이라 발송 동작이 오늘과 같다.
  | ScpEditableMailTemplateKind;
type ScpMailTemplateStatus = "active" | "archived";
type ScpResultMailMode = "draft_only" | "send_approved";
type QualificationRejectionNotificationStatus =
  "dry_run" | "sent" | "mock" | "blocked" | "skipped";

// R7: publish format for the editable receipt-mail kinds. Stored explicitly so "html is empty"
// never has to double as the format signal (see normalizeReceiptTemplate).
/**
 * W72-HOTFIX: `markdown` 추가.
 *
 * 63차에서 18종 시퀀스를 `bodyFormat:"markdown"` 으로 발행했는데(마크다운이라야 라벨이
 * 앵커로 렌더된다) 이 타입과 정규화기는 html|text 만 알고 있었다. 그래서 첫 실발송에서
 * 스윕이 전량 `bodyFormat must be "html" or "text"` 로 죽었다(01:39Z ~50건, fail-closed).
 * 컴파일러는 처음부터 markdown|text|html 을 지원한다(mailCompiler.ts) — 낡은 쪽은 이 계약이다.
 */
type TemplateBodyFormat = "html" | "text" | "markdown";

type ScpMailTemplate = {
  id: ScpMailTemplateKind;
  kind: ScpMailTemplateKind;
  title: string;
  subject: string;
  body: string;
  html?: string;
  /**
   * R7: the operator's authored HTML, preserved verbatim regardless of bodyFormat so a text-only
   * publish never destroys it (normalizeReceiptTemplate). Only the editable receipt-mail kinds
   * ever set this; `html` stays the send representation the unmodified render/resolve path
   * (scpReceiptMailTemplates.ts) already keys off of — empty exactly when bodyFormat is "text".
   */
  htmlDraft?: string;
  text?: string;
  /** R7: explicit publish format for the editable receipt-mail kinds — never derived from html
   * emptiness. Only set for editable kinds; other kinds never carry HTML at all. */
  bodyFormat?: TemplateBodyFormat;
  vars: string[];
  status: ScpMailTemplateStatus;
  draftOnlyDefault: true;
  updatedAtIso: string;
  updatedBy: string;
  createdAtIso?: string;
  createdBy?: string;
};

type RenderedScpMail = {
  subject: string;
  body: string;
  preview: string;
  missingPlaceholders: string[];
  values: Record<string, string>;
};

// Cold-outreach reply context (case B/D). A creator replied to a cold email but has NOT yet
// submitted the application form, so there is no OneLink to share yet — only the form link.
// The re_guide template is otherwise a post-qualification next-step resend that DOES carry a
// OneLink. This context is additive: it leaves the re_guide kind, its template CRUD, and every
// gate/suppression path unchanged, and only (a) swaps the rendered body to a form-only variant
// and (b) drops the OneLink custom-link requirement for this one context.
export type ScpResultMailContext = "default" | "cold_reply";
const COLD_REPLY_REGUIDE_BODY = [
  "Hi {{name}},",
  "",
  "Thanks for getting back to us about Super Creator Partners.",
  "To move forward, please complete the short application form below and we will take it from there.",
  "",
  "Application form: {{form_link}}",
  "",
  "If you already applied, please ignore this message.",
  "",
  "Best,",
  "Supercent Partnerships",
].join("\n");

const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;
const TEMPLATE_COLLECTION = "scp_mail_templates";
const TEMPLATE_AUDIT_COLLECTION = "scp_mail_template_audits";
const RESULTS_COLLECTION = "scp_mail_results";
const RESULT_MAIL_PREVIEW_CLAIMS_COLLECTION =
  "scp_result_mail_preview_claims";
const REJECTION_NOTIFICATION_AUDIT_COLLECTION =
  "scp_qualification_result_notification_audits";
const SUPPRESSIONS_COLLECTION = "mail_suppressions";
const DEFAULT_PROGRAM_ID = "scp";
const DEFAULT_FORM_LINK = "{{form_link}}";
const RESULT_MAIL_PREVIEW_TTL_MS = 15 * 60 * 1_000;
// This is only a transactional wrapper batch-safety ceiling. It is deliberately
// not the Program > Campaign coldmail daily cap (50), and must not be presented
// or enforced as a campaign send cap.
const QUALIFICATION_REJECTION_BATCH_LIMIT = 200;
// P0-6 / SEC-P0-009: the lead's internal decision-reason free-text fields must never reach an external
// recipient. Only a structured reasonCode is accepted and mapped to a customer-safe phrase here;
// anything unmapped falls back to the generic message.
const GENERIC_CUSTOMER_REASON = "campaign fit / eligibility criteria";
/** W72 합동리뷰 R3-1: 독려 문안의 `{{homepage_link}}` 정본. 템플릿에 URL 을 박지 않는다. */
const SCP_HOMEPAGE_LINK = "https://creator.supercent.io/?locale=en";
const TEMPLATE_PLACEHOLDER_RULES: Record<
  ScpMailTemplateKind,
  { allowed: readonly string[]; required: readonly string[] }
> = {
  // W62-2: 재촉(nudge). 링크는 제출 화면으로 가는 portal_link 하나뿐이다(W48 정적 링크 금지).
  application_video_reminder: {
    allowed: [
      "application_id",
      "program_name",
      "portal_link",
      "reference_code",
      "days_since_apply",
      "supercent_brand",
    ],
    required: ["portal_link", "supercent_brand"],
  },
  qualification_pass: {
    allowed: [
      "name",
      "email",
      "onelink",
      "adjust_link",
      "campaign",
      "form_link",
      "quick_start_guide_link",
      "guidebook_link",
      "user_id_guide_link",
    ],
    required: [
      "onelink",
      "form_link",
      "quick_start_guide_link",
      "guidebook_link",
      "user_id_guide_link",
    ],
  },
  qualification_fail: {
    allowed: ["name", "reason"],
    required: ["name", "reason"],
  },
  re_guide: {
    allowed: ["name", "email", "onelink", "adjust_link", "campaign", "form_link"],
    required: ["name", "onelink", "form_link"],
  },
  encouragement: {
    allowed: ["name", "email", "onelink", "adjust_link", "campaign", "form_link"],
    required: ["name", "onelink", "form_link"],
  },
  gem_paid_submission_request: {
    allowed: ["name", "email", "campaign", "form_link"],
    required: ["name", "form_link"],
  },
  video_submission_reminder: {
    allowed: ["name", "email", "campaign", "form_link", "days_since_request", "reminder_number"],
    required: ["name", "form_link", "days_since_request", "reminder_number"],
  },
  application_confirmed: RECEIPT_TEMPLATE_RULES.application_confirmed,
  content_submitted: RECEIPT_TEMPLATE_RULES.content_submitted,
  uid_guide: RECEIPT_TEMPLATE_RULES.uid_guide,
  video_result_mail: RECEIPT_TEMPLATE_RULES.video_result_mail,
  // W120: 승인 결과 메일 전용 문서. 반려 문안 override 가 승인 통지로 새지 않게 kind 를 가른다.
  video_result_mail_approved: RECEIPT_TEMPLATE_RULES.video_result_mail_approved,
  // W72 합동리뷰 R2-2: 코호트1·3 독려 문안도 같은 변수 규칙을 쓴다 —
  //   등록하지 않으면 normalizeKind 가 미지의 키를 qualification_pass 로 떨어뜨려
  //   **헤세가 설정한 문안 대신 엉뚱한 문안이 draft 로 생성된다.**
  scp_nudge_cohort1_read_no_reply_en: RECEIPT_TEMPLATE_RULES.scp_nudge_cohort1_read_no_reply_en,
  scp_nudge_cohort2_applied_no_video_en: RECEIPT_TEMPLATE_RULES.scp_nudge_cohort2_applied_no_video_en,
  scp_nudge_cohort3_unread_no_reply_en: RECEIPT_TEMPLATE_RULES.scp_nudge_cohort3_unread_no_reply_en,
  // W91 [헤세 · admin-bridge 승인 메일]: uid_guide/video_result_mail 과 같은 이유로 등록한다 —
  //   등록하지 않으면 normalizeKind 가 미지의 키를 qualification_pass 로 떨어뜨린다.
  login_approved: RECEIPT_TEMPLATE_RULES.login_approved,
  // 반려 안내 2종(26-08-27) — 같은 이유로 등록한다.
  login_rejected_subscriber_minimum: RECEIPT_TEMPLATE_RULES.login_rejected_subscriber_minimum,
  login_rejected_channel_not_found: RECEIPT_TEMPLATE_RULES.login_rejected_channel_not_found,
  login_rejected_public_reason: RECEIPT_TEMPLATE_RULES.login_rejected_public_reason,
  // Task-100 F-6 — 같은 이유로 등록한다(등록하지 않으면 normalizeKind 가 qualification_pass 로 떨어뜨린다).
  resubmission_nudge_en: RECEIPT_TEMPLATE_RULES.resubmission_nudge_en,
};
const TEMPLATE_PREVIEW_VALUES: Record<string, string> = {
  name: "Sample Creator",
  email: "creator@example.test",
  onelink: "https://example.test/store-link",
  adjust_link: "https://example.test/adjust-link",
  campaign: "sample-campaign",
  form_link: "https://example.test/submission-form",
  reason: GENERIC_CUSTOMER_REASON,
  days_since_request: "7",
  reminder_number: "2",
};
const CUSTOMER_REASON_MESSAGES: Record<string, string> = {
  campaign_fit: "This campaign was not the right fit at this time.",
  fit: "This campaign was not the right fit at this time.",
  eligibility: "The eligibility criteria for this campaign were not met.",
  eligibility_criteria:
    "The eligibility criteria for this campaign were not met.",
  capacity: "We have reached capacity for this campaign.",
  content_guidelines: "The application did not meet our content guidelines.",
  guidelines: "The application did not meet our content guidelines.",
  audience_mismatch: "The audience profile was not a match for this campaign.",
  low_activity:
    "Recent channel activity did not meet the campaign requirements.",
  inactive: "Recent channel activity did not meet the campaign requirements.",
};

function publicHash(value: unknown): string {
  const input = asString(value);
  return input
    ? createHash("sha256").update(input).digest("hex").slice(0, 16)
    : "";
}

function privateHash(value: unknown): string {
  return createHash("sha256").update(asString(value)).digest("hex");
}

function strictProviderMessageIdHash(value: unknown): string {
  const candidate = asString(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(candidate) ? candidate : "";
}

function opaqueScpMailTrackingId(value: unknown): string {
  return `scp-mail-${privateHash(value).slice(0, 40)}`;
}

function legacyRawScpResultFieldDeletes() {
  return {
    draftRef: FieldValue.delete(),
    approvalRef: FieldValue.delete(),
    trackingId: FieldValue.delete(),
    messageRef: FieldValue.delete(),
    providerMessageId: FieldValue.delete(),
  };
}

function legacyRawScpResultNestedFieldDeletes() {
  return {
    draftRef: FieldValue.delete(),
    approvalRef: FieldValue.delete(),
    trackingId: FieldValue.delete(),
    messageRef: FieldValue.delete(),
    providerMessageId: FieldValue.delete(),
  };
}

type ScpResultMailDeliveryStatus = "sent" | "mock" | "blocked" | "skipped";

/**
 * Result-mail ledgers may say `sent` only when the mail engine exposes provider-confirmed
 * SMTP evidence. `ok: true` is intentionally insufficient because dry-run/mock delivery also
 * returns ok from the shared engine. A duplicate is reconciled only from a canonical outbox row
 * whose own state is provider `sent`; a `mock_sent` outbox never closes the review queue.
 */
export function classifyScpResultMailDelivery(
  sendResultValue: unknown,
  canonicalOutboundValue: unknown = {},
): {
  status: ScpResultMailDeliveryStatus;
  reason: string;
  providerConfirmed: boolean;
} {
  const sendResult = asRecord(sendResultValue);
  const canonicalOutbound = asRecord(canonicalOutboundValue);
  const deliveryState = asString(sendResult.deliveryState);
  const source = asString(sendResult.source);
  const duplicate =
    sendResult.duplicate === true || deliveryState === "skipped_duplicate";
  const canonicalDeliveryState = asString(canonicalOutbound.deliveryState);

  if (duplicate) {
    if (
      isStrictScpProviderConfirmed(canonicalOutbound, "outbound")
    ) {
      return {
        status: "sent",
        reason: "provider_sent_reconciled",
        providerConfirmed: true,
      };
    }
    if (canonicalDeliveryState === "mock_sent") {
      return {
        status: "mock",
        reason: "mock_delivery_not_sent",
        providerConfirmed: false,
      };
    }
    return {
      status: "skipped",
      reason: "duplicate_reservation_unconfirmed",
      providerConfirmed: false,
    };
  }

  const acceptedCount = Number(sendResult.acceptedCount ?? 0);
  const providerConfirmed =
    deliveryState === "sent" &&
    source === "smtp-live-callable" &&
    sendResult.providerConfirmed === true &&
    strictProviderMessageIdHash(sendResult.providerMessageIdHash).length ===
      64 &&
    Number.isFinite(acceptedCount) &&
    acceptedCount > 0 &&
    sendResult.persisted === true;
  if (providerConfirmed) {
    return {
      status: "sent",
      reason: "provider_sent_confirmed",
      providerConfirmed: true,
    };
  }
  // W62-3(A2): 차단은 별도로 말한다. 종전에는 차단이 mock 으로 접혀 `mock_delivery_not_sent` 가 났고,
  //   그게 확인 메일 29건이 죽은 실제 원인이었다(사유가 틀리니 결정적 차단에 재시도를 태웠다).
  if (deliveryState === "blocked" || source === "email-blocked-callable") {
    // W62e-CRIT-A [Codex 델타]: **결정적 억제만** 종결이다. 일시 잠금(긴급 셧다운·아웃바운드 잠금·
    //   승인 미비·휴먼 게이트)은 풀리므로 재시도로 남겨야 한다 — 종전에는 그것까지 영구 종결시켜
    //   셧다운 한 번이 그 창의 메일을 전부 죽였다.
    if (!isDeterministicMailBlockRule(asString(sendResult.blockedRuleId))) {
      return {
        status: "skipped",
        reason: `mail_blocked_retryable:${asString(sendResult.blockedRuleId) || "unknown"}`,
        providerConfirmed: false,
      };
    }
    // W62c-C1 [두 리뷰 수렴]: 여기서 status 를 "mock" 으로 돌려주면 A2 라벨 수리가 **분류기에서
    //   다시 접힌다** — 사유만 바꾸고 상태를 그대로 두면 하류(드레인)는 종전과 똑같이 재시도한다.
    //   그리고 1차 테스트가 reason 만 단정해서 이 자기모순이 통과했다(status 단정을 추가했다).
    //   차단은 **결정적**이다: 같은 억제 목록에 같은 수신자면 다시 시도해도 결과가 같다.
    //   그래서 status 를 blocked 로 분리하고, 드레인이 이걸 **비소모 종결**로 처리한다.
    return {
      status: "blocked",
      reason: "suppressed_or_unapproved_not_sent",
      providerConfirmed: false,
    };
  }
  if (deliveryState === "mock_sent" || source === "email-mock-callable") {
    return {
      status: "mock",
      reason: "mock_delivery_not_sent",
      providerConfirmed: false,
    };
  }
  if (deliveryState === "blocked" || sendResult.ok !== true) {
    return {
      status: "blocked",
      reason: "mail_engine_blocked",
      providerConfirmed: false,
    };
  }
  return {
    status: "blocked",
    reason: "provider_delivery_unconfirmed",
    providerConfirmed: false,
  };
}

function maskedLeadId(value: string): string {
  const safePrefix =
    value
      .split("-")
      .find((part) => /^[A-Za-z][A-Za-z0-9_]{1,24}$/.test(part)) ??
    "lead";
  return `${safePrefix}-${publicHash(value)}`;
}

function publicNotificationRowBase(
  candidate: RejectionNotificationCandidate,
  idempotency: ReturnType<typeof rejectionNotificationIds>,
): Record<string, unknown> {
  return {
    leadIdMasked: maskedLeadId(candidate.leadId),
    emailMasked: maskEmail(candidate.email),
    trackingIdHash: publicHash(idempotency.trackingId),
  };
}
const DEFAULT_TEMPLATES: Record<
  Exclude<ScpMailTemplateKind, ScpEditableMailTemplateKind>,
  Omit<ScpMailTemplate, "updatedAtIso" | "updatedBy">
> = {
  qualification_pass: {
    id: "qualification_pass",
    kind: "qualification_pass",
    title: "SCP 합격 안내",
    subject: "[Supercent] Super Creator Partners 합격 및 다음 단계 안내",
    body: `Hi there!😊



We have great news to share!

we are pleased to inform you that you have been selected as a participant in the Super Creator Partners🎉

We look forward to creating fun content together!



Here are key details regarding your upcoming activities.



[Activity Overview]

🎬 Activity Details: Upload content at least once a week after playing the game

🎮 Game Title: XP Hero

🔗 Store Custom Link: {{onelink}}   (This link varies by creator; please use the one shared with you)

🔄 Upload Process: Upload content → Submit your video({{form_link}}) → Receive reply after administrator approval



[Guide]

⚡ Quick Start Guide: {{quick_start_guide_link}} — 5 minutes is all you need. Check the guide and get started right away!

📘 Guidebook: {{guidebook_link}} — Want to dive deeper into the full process, content tips, and XP Hero contents strategies? This guidebook has everything you need!

🎁 In-Game Benefits: To receive in-game benefits, please let us know your User ID. (How to find User ID: {{user_id_guide_link}})



Please be sure to review the Quick Start Guide and reply to this email with your User ID!

We look forward to creating great results together:-)





Best Regards,

Supercent`,
    vars: [
      "onelink",
      "form_link",
      "quick_start_guide_link",
      "guidebook_link",
      "user_id_guide_link",
    ],
    status: "active",
    draftOnlyDefault: true,
  },
  qualification_fail: {
    id: "qualification_fail",
    kind: "qualification_fail",
    title: "SCP 불합격 안내",
    subject: "[Supercent] Super Creator Partners 지원 결과 안내",
    body: [
      "Hi {{name}},",
      "",
      "Thank you for applying to Super Creator Partners. After review, we are unable to move forward this time.",
      "Reason: {{reason}}",
      "",
      "We appreciate your interest and hope to reconnect on a better-fit campaign.",
      "",
      "Best,",
      "Supercent Partnerships",
    ].join("\n"),
    vars: ["name", "reason"],
    status: "active",
    draftOnlyDefault: true,
  },
  re_guide: {
    id: "re_guide",
    kind: "re_guide",
    title: "SCP 재안내",
    subject: "[Supercent] Super Creator Partners 제출 안내 재전송",
    body: [
      "Hi {{name}},",
      "",
      "Sharing the Super Creator Partners next-step links again for your convenience.",
      "",
      "OneLink: {{onelink}}",
      "Submission form: {{form_link}}",
      "",
      "If you already submitted, please ignore this message.",
      "",
      "Best,",
      "Supercent Partnerships",
    ].join("\n"),
    vars: ["name", "onelink", "form_link"],
    status: "active",
    draftOnlyDefault: true,
  },
  encouragement: {
    id: "encouragement",
    kind: "encouragement",
    title: "SCP 독려 안내",
    subject: "[Supercent] Super Creator Partners 제출 안내",
    body: [
      "Hi {{name}},",
      "",
      "Just checking in on your Super Creator Partners next steps.",
      "",
      "OneLink: {{onelink}}",
      "Submission form: {{form_link}}",
      "",
      "If you already submitted, please ignore this message.",
      "",
      "Best,",
      "Supercent Partnerships",
    ].join("\n"),
    vars: ["name", "onelink", "form_link"],
    status: "active",
    draftOnlyDefault: true,
  },
  gem_paid_submission_request: {
    id: "gem_paid_submission_request",
    kind: "gem_paid_submission_request",
    title: "SCP 젬 지급 후 영상 제출 요청",
    subject: "[Supercent] Your SCP gems are ready — submit your video",
    body: [
      "Hi {{name}},",
      "",
      "Your in-game gems have been granted.",
      "Please submit your SCP video through the same form shared in the qualification email:",
      "{{form_link}}",
      "",
      "If you already submitted, please ignore this message.",
      "",
      "Best,",
      "Supercent Partnerships",
    ].join("\n"),
    vars: ["name", "form_link"],
    status: "active",
    draftOnlyDefault: true,
  },
  video_submission_reminder: {
    id: "video_submission_reminder",
    kind: "video_submission_reminder",
    title: "SCP 영상 제출 독려",
    subject: "[Supercent] SCP video submission reminder",
    body: [
      "Hi {{name}},",
      "",
      "This is reminder {{reminder_number}}. It has been {{days_since_request}} days since the video submission request was sent.",
      "Please submit your video here:",
      "{{form_link}}",
      "",
      "If you already submitted, please ignore this message.",
      "",
      "Best,",
      "Supercent Partnerships",
    ].join("\n"),
    vars: ["name", "form_link", "days_since_request", "reminder_number"],
    status: "active",
    draftOnlyDefault: true,
  },
};

export async function upsertScpMailTemplate(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(
    request,
    "scp_mail_templates.upsert",
    WRITE_ROLES,
  );
  await assertScpEntitled(auth, request, "scp_mail_templates.upsert");
  const data = asRecord(request.data);
  const nowIso = new Date().toISOString();
  const template = normalizeTemplate(data, auth.userId, nowIso);
  const ref = adminDb.collection(TEMPLATE_COLLECTION).doc(template.id);
  const configuredGuideLinks = template.kind === "qualification_pass"
    ? await resolveScpGuideLinks(data, {})
    : null;
  const previewValues = {
    ...TEMPLATE_PREVIEW_VALUES,
    ...RECEIPT_TEMPLATE_PREVIEW_VALUES,
    ...(configuredGuideLinks
      ? {
          quick_start_guide_link: configuredGuideLinks.quickStartGuideLink,
          guidebook_link: configuredGuideLinks.guidebookLink,
          user_id_guide_link: configuredGuideLinks.userIdGuideLink,
        }
      : {}),
    ...stringRecord(data.previewValues ?? data.values),
  };
  const receiptPreview = isScpEditableMailTemplateKind(template.kind)
    ? renderScpReceiptMailTemplate({
        kind: template.kind,
        subject: template.subject,
        html: template.html ?? "",
        text: template.text ?? template.body,
        // W72-HOTFIX: preview 도 발송과 **같은 형식 판정**을 써야 한다. 안 그러면 화면에서는
        //   평문으로 보이고 실제로는 HTML 이 나가는(또는 그 반대) 괴리가 생긴다.
        bodyFormat: template.bodyFormat,
        values: previewValues,
      })
    : null;
  const preview = receiptPreview
    ? {
        subject: receiptPreview.subject,
        body: receiptPreview.text,
        preview: receiptPreview.html,
        missingPlaceholders: [],
        values: previewValues,
      }
    : renderScpMail(template, previewValues);
  const contentHash = scpTemplateContentHash(template);
  const existing = await ref.get();
  const currentTemplate = existing.exists
    ? normalizeStoredTemplate(template.kind, existing.data() ?? {})
    : null;
  const currentVersion = storedVersion(existing.data()?.version);
  const currentHash = currentTemplate ? scpTemplateContentHash(currentTemplate) : "";
  const currentTemplateValidation = currentTemplate
    ? isScpEditableMailTemplateKind(currentTemplate.kind)
      ? validateScpReceiptMailTemplate({
          kind: currentTemplate.kind,
          subject: currentTemplate.subject,
          html: currentTemplate.html ?? "",
          text: currentTemplate.text ?? currentTemplate.body,
        })
      : templatePlaceholderDiagnostics(
          currentTemplate.kind,
          currentTemplate.vars,
          `${currentTemplate.subject}\n${currentTemplate.body}`,
        )
    : null;
  const validation = isScpEditableMailTemplateKind(template.kind)
    ? {
        ...validateScpReceiptMailTemplate({
          kind: template.kind,
          subject: template.subject,
          html: template.html ?? "",
          text: template.text ?? template.body,
        }),
        renderable: true,
        missingPreviewValues: [],
      }
    : {
        ...templateValidation(
          template.kind,
          template.vars,
          `${template.subject}\n${template.body}`,
        ),
        renderable: preview.missingPlaceholders.length === 0,
        missingPreviewValues: preview.missingPlaceholders,
      };

  // W7-3f: 저장 전 경고 2종. 판정을 막지 않고(운영자가 의도한 문안일 수 있다) 사실만 돌려준다:
  //  ① 발송 게이트와 같은 매처로 mailSafety 위험 문구 매치 — 매치되면 실제 발송이 전면 차단된다.
  //  ② 호출부가 주입하지 않는 변수 사용 — 지금은 빈 문자열로 조용히 발송된다.
  const lints = isScpEditableMailTemplateKind(template.kind)
    ? evaluateScpMailTemplateLints({
        kind: template.kind,
        subject: template.subject,
        html: template.html ?? "",
        text: template.text ?? template.body,
        emergencyKeywords: (await readSettings()).mailSafety.emergencyKeywords,
      })
    : null;

  if (data.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      sideEffects: "none" as const,
      template,
      preview,
      contentHash,
      currentHash,
      currentVersion,
      currentTemplateValidation,
      validation,
      lints,
      cache: makeCache(`scp_mail_templates:${template.id}:preview`, false),
      costLog: makeCostLog("scp_mail_templates.preview", "mock-admin", false, 0),
    };
  }

  if (!validation.renderable && currentHash !== contentHash) {
    throw templateCallableError(
      "failed-precondition",
      `required preview values missing: ${preview.missingPlaceholders.join(", ")}`,
      auth,
    );
  }

  const expectation = templateCasExpectation(data);
  const auditRef = adminDb.collection(TEMPLATE_AUDIT_COLLECTION).doc();
  const applied = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const stored = snapshot.data() ?? {};
    const beforeVersion = storedVersion(stored.version);
    const beforeTemplate = snapshot.exists
      ? normalizeStoredTemplate(template.kind, stored)
      : null;
    const beforeHash = beforeTemplate ? scpTemplateContentHash(beforeTemplate) : "";
    if (snapshot.exists && beforeHash === contentHash) {
      return {
        beforeHash,
        beforeVersion,
        nextVersion: beforeVersion,
        noop: true as const,
      };
    }
    assertTemplateCas(expectation, beforeVersion, beforeHash, auth);
    const nextVersion = beforeVersion + 1;
    transaction.set(
      ref,
      {
        ...template,
        version: nextVersion,
        contentHash,
        createdAtIso: asString(stored.createdAtIso, nowIso),
        createdBy: asString(stored.createdBy, auth.userId),
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: snapshot.exists
          ? (stored.createdAt ?? FieldValue.serverTimestamp())
          : FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.create(auditRef, {
      action: snapshot.exists ? "update" : "create",
      templateKind: template.kind,
      templateRef: ref.path,
      beforeVersion,
      afterVersion: nextVersion,
      beforeHash,
      afterHash: contentHash,
      changedFields: changedTemplateFields(beforeTemplate, template),
      actorUserIdHash: publicHash(auth.userId),
      actorRole: auth.role,
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { beforeHash, beforeVersion, nextVersion, noop: false as const };
  });

  return {
    ok: true,
    dryRun: false,
    applied: !applied.noop,
    noop: applied.noop,
    noopReason: applied.noop ? "identical_content" : undefined,
    template: { ...template, version: applied.nextVersion, contentHash },
    preview,
    contentHash,
    previousHash: applied.beforeHash,
    previousVersion: applied.beforeVersion,
    version: applied.nextVersion,
    currentTemplateValidation,
    auditRef: applied.noop ? null : auditRef.path,
    validation,
    lints,
    cache: makeCache(`scp_mail_templates:${template.id}`, false),
    costLog: makeCostLog("scp_mail_templates.upsert", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(
      auth,
      applied.noop
        ? `scp_mail_templates.noop(${template.id})`
        : `scp_mail_templates.upsert(${template.id})`,
      "success",
      "scp-automation",
    ),
  };
}

export async function deleteScpMailTemplate(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(
    request,
    "scp_mail_templates.delete",
    WRITE_ROLES,
  );
  await assertScpEntitled(auth, request, "scp_mail_templates.delete");
  const data = asRecord(request.data);
  // W72F-R2 P0: **파괴적 경로는 permissive 폴백을 쓰지 않는다.**
  //   normalizeKind 는 미지원 kind 를 qualification_pass 로 떨어뜨린다(발송 경로의 관용).
  //   그 폴백을 archive 에 쓰면 `_wX`·bogus kind archive 요청이
  //   **엉뚱하게 qualification_pass 를 archive** 하고 원 문안은 active 로 남는다.
  //   삭제는 되돌리기 어려우므로 **아는 kind 만** 받고 나머지는 거절한다.
  const kind = strictTemplateKindOrThrow(data.kind ?? data.id);
  const ref = adminDb.collection(TEMPLATE_COLLECTION).doc(kind);
  const nowIso = new Date().toISOString();
  await ref.set(
    {
      id: kind,
      kind,
      status: "archived",
      archivedAtIso: nowIso,
      archivedBy: auth.userId,
      updatedAtIso: nowIso,
      updatedBy: auth.userId,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return {
    ok: true,
    templateRef: ref.path,
    status: "archived" as const,
    cache: makeCache(`scp_mail_templates:${kind}`, false),
    costLog: makeCostLog("scp_mail_templates.delete", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(
      auth,
      `scp_mail_templates.delete(${kind})`,
      "success",
      "scp-automation",
    ),
  };
}

export async function sendPendingQualificationRejectionNotifications(
  request: CallableRequestShape,
) {
  const auth = assertNonGuestAuth(
    request,
    "scp_qualification_rejection_notifications.send",
    WRITE_ROLES,
  );
  // 2026-09-27 codex adversarial review round 2 sweep: sends scp qualification rejection mail —
  // no general-purpose UI reaches it.
  await assertScpEntitled(auth, request, "scp_qualification_rejection_notifications.send");
  const data = asRecord(request.data);
  const dryRun = data.dryRun !== false;
  const liveSend = data.liveSend === true;
  const allowAiRecommendation = data.allowAiRecommendation === true;
  const limit = Math.max(1, Math.min(Number(data.limit) || 20, QUALIFICATION_REJECTION_BATCH_LIMIT));
  const requestedLeadIds = stringList(data.leadIds, QUALIFICATION_REJECTION_BATCH_LIMIT);
  const nowIso = new Date().toISOString();
  const candidates = await rejectionNotificationCandidates({
    limit,
    leadIds: requestedLeadIds,
    allowAiRecommendation,
  });
  const rows: Array<Record<string, unknown> & { status: QualificationRejectionNotificationStatus }> = [];

  for (const candidate of candidates) {
    const idempotency = rejectionNotificationIds(candidate.leadId);
    const publicRowBase = publicNotificationRowBase(candidate, idempotency);
    if (candidate.blockedReason) {
      rows.push({
        ...publicRowBase,
        status: "blocked" as QualificationRejectionNotificationStatus,
        reason: candidate.blockedReason,
        reasonCode: candidate.reasonCode,
        customerFacingReason: customerFacingReason(candidate.reasonCode),
        source: candidate.source,
        templateKind: "qualification_fail",
      });
      continue;
    }
    const previous = await existingRejectionNotificationSend(
      candidate.leadId,
      idempotency.trackingId,
    );
    if (previous.sent || previous.skipped) {
      rows.push({
        ...publicRowBase,
        status: "skipped" as QualificationRejectionNotificationStatus,
        reason: previous.sent
          ? "already_sent"
          : previous.reason || "already_skipped",
        existingResultRefHash: publicHash(previous.resultRef),
        existingOutboundLogRefHash: publicHash(previous.outboundLogRef),
        suppressionRefHash: publicHash(previous.suppressionRef),
      });
      continue;
    }

    if (dryRun) {
      rows.push({
        ...publicRowBase,
        status: "dry_run" as QualificationRejectionNotificationStatus,
        reasonCode: candidate.reasonCode,
        customerFacingReason: customerFacingReason(candidate.reasonCode),
        source: candidate.source,
        templateKind: "qualification_fail",
      });
      continue;
    }

    const resultMailData = {
      leadId: candidate.leadId,
      email: candidate.email,
      name: candidate.name,
      kind: "qualification_fail",
      mode: "send_approved",
      approval: "approved",
      reasonCode: candidate.reasonCode,
      draftRef: idempotency.draftRef,
      approvalRef: idempotency.approvalRef,
      trackingId: idempotency.trackingId,
    };
    const previewResult = asRecord(
      await prepareScpResultMail({
        auth: request.auth,
        rawRequest: request.rawRequest,
        data: {
          ...resultMailData,
          dryRun: true,
          liveSend: false,
        },
      }),
    );
    const result =
      liveSend && asString(previewResult.status) === "preview"
        ? asRecord(
            await prepareScpResultMail({
              auth: request.auth,
              rawRequest: request.rawRequest,
              data: {
                ...resultMailData,
                previewToken: previewResult.previewToken,
                previewHash: previewResult.previewHash,
                dryRun: false,
                liveSend: true,
              },
            }),
          )
        : previewResult;
    const mailSafety = asRecord(result.mailSafety);
    const sendResultRecord = asRecord(result.sendResult);
    const alreadySent =
      result.alreadySent === true ||
      asString(result.skippedReason) === "already_sent";
    const safetySuppressed =
      !alreadySent &&
      mailSafety.allowed === false &&
      asString(mailSafety.suppressionRef).startsWith(
        `${SUPPRESSIONS_COLLECTION}/`,
      );
    const duplicateSuppressed =
      !alreadySent &&
      ((result.status === "skipped" &&
        asString(result.skippedReason) === "duplicate_reservation") ||
        asString(sendResultRecord.deliveryState) === "skipped_duplicate" ||
        sendResultRecord.duplicate === true);
    const previewOnly = asString(result.status) === "preview";
    const status: QualificationRejectionNotificationStatus =
      alreadySent || duplicateSuppressed || safetySuppressed
        ? "skipped"
        : asString(result.status) === "sent"
          ? "sent"
          : previewOnly || asString(result.status) === "mock"
            ? "mock"
            : "blocked";
    const resultRefPath = asString(result.resultRef);
    if (liveSend && safetySuppressed && resultRefPath) {
      const resultDocRef = adminDb.doc(resultRefPath);
      await adminDb.runTransaction(async (transaction) => {
        const existing = await transaction.get(resultDocRef);
        if (asString(existing.data()?.status) === "sent") return;
        transaction.set(
          resultDocRef,
          {
            status: "skipped",
            skippedReason: "mail_suppression",
            skippedAtIso: nowIso,
            updatedAtIso: nowIso,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      });
    }
    const auditRef = adminDb
      .collection(REJECTION_NOTIFICATION_AUDIT_COLLECTION)
      .doc(idempotency.auditId);
    if (!previewOnly) {
      await auditRef.set(
        {
          id: auditRef.id,
          leadId: candidate.leadId,
          emailMasked: maskEmail(candidate.email),
          source: candidate.source,
          sourceDecisionRef: candidate.sourceDecisionRef,
          reasonCode: candidate.reasonCode,
          customerFacingReason: customerFacingReason(candidate.reasonCode),
          templateKind: "qualification_fail",
          trackingIdHash: privateHash(idempotency.trackingId),
          resultRefHash: resultRefPath ? privateHash(resultRefPath) : "",
          status,
          skippedReason: duplicateSuppressed
            ? "duplicate_reservation"
            : safetySuppressed
              ? "mail_suppression"
              : alreadySent
                ? "already_sent"
                : asString(result.mockReason),
          suppressionRef: safetySuppressed
            ? asString(mailSafety.suppressionRef)
            : "",
          liveSend,
          actor: {
            uid: auth.userId,
            role: auth.role,
            team: auth.team,
            email: auth.email ?? null,
          },
          createdAtIso: nowIso,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
    rows.push({
      ...publicRowBase,
      status,
      reasonCode: candidate.reasonCode,
      customerFacingReason: customerFacingReason(candidate.reasonCode),
      source: candidate.source,
      resultRefHash: publicHash(resultRefPath),
      auditRefHash: previewOnly ? "" : publicHash(auditRef.path),
      deliveryState: asString(sendResultRecord.deliveryState),
      reason: alreadySent
        ? "already_sent"
        : duplicateSuppressed
        ? "duplicate_reservation"
        : safetySuppressed
          ? "mail_suppression"
          : previewOnly
            ? "live_send_disabled_preview_only"
            : status === "mock"
              ? "mock_delivery_not_sent"
              : "",
      suppressionRefHash: safetySuppressed
        ? publicHash(mailSafety.suppressionRef)
        : "",
    });
  }

  return {
    ok: rows.every(
      (row) =>
        row.status === "dry_run" ||
        row.status === "sent" ||
        (row.status === "mock" && !liveSend) ||
        row.status === "skipped",
    ),
    dryRun,
    liveSend,
    allowAiRecommendation,
    candidateCount: candidates.length,
    sentCount: rows.filter((row) => row.status === "sent").length,
    mockCount: rows.filter((row) => row.status === "mock").length,
    skippedCount: rows.filter((row) => row.status === "skipped").length,
    blockedCount: rows.filter((row) => row.status === "blocked").length,
    rows,
    capScope:
      "qualification result mail uses prepareScpResultMail/sendEmail and is not a Program Campaign coldmail cap path",
    batchLimit: QUALIFICATION_REJECTION_BATCH_LIMIT,
    batchLimitScope:
      "qualification_result_notification_batch_safety_not_campaign_coldmail_cap",
    campaignColdmailCapApplied: false,
    cache: makeCache("scp_qualification_rejection_notifications", false),
    costLog: makeCostLog(
      "scp_qualification_rejection_notifications.send",
      liveSend ? "smtp" : "mock-email",
      false,
      0,
    ),
    behaviorLog: makeBehaviorLog(
      auth,
      "scp_qualification_rejection_notifications.send",
      rows.some((row) => row.status === "blocked") ? "blocked" : "success",
      "scp-automation",
    ),
  };
}

export const sendPendingQualificationRejectionNotificationsCallable =
  sendPendingQualificationRejectionNotifications;

type RejectionNotificationCandidate = {
  leadId: string;
  email: string;
  name: string;
  source: "final_verdict" | "ai_recommendation";
  sourceDecisionRef: string;
  reasonCode: string;
  blockedReason?: string;
};

function verdictIsFail(value: unknown): boolean {
  const textValue = asString(value).trim().toLowerCase();
  return (
    textValue === "fail" ||
    textValue === "rejected" ||
    /불합격|탈락|반려|거절/.test(textValue)
  );
}

function leadLatestRecommendation(
  lead: Record<string, unknown>,
): Record<string, unknown> {
  return asRecord(lead.latestAiRecommendation);
}

function leadIsFinalFail(lead: Record<string, unknown>): boolean {
  return [
    lead.qualificationStatus,
    lead.finalVerdict,
    lead.qualificationResult,
    lead.result,
    lead.decision,
    lead.status,
    lead.reviewStatus,
  ].some(verdictIsFail);
}

function leadIsAiFail(lead: Record<string, unknown>): boolean {
  return asString(leadLatestRecommendation(lead).verdict) === "fail";
}

function rejectionReasonCode(lead: Record<string, unknown>): string {
  const recommendation = leadLatestRecommendation(lead);
  const reasons = Array.isArray(recommendation.reasons)
    ? recommendation.reasons
    : [];
  const firstReason = reasons.find(
    (item) => typeof item === "string" && item.trim(),
  ) as string | undefined;
  const raw =
    asString(lead.qualificationReasonCode) ||
    asString(lead.rejectionReasonCode) ||
    asString(firstReason) ||
    asString(lead.qualificationFinalReason) ||
    asString(lead.reason);
  const normalized = raw.toLowerCase();
  if (/저티어|country|audience/.test(normalized)) return "audience_mismatch";
  if (/업로드|activity|inactive/.test(normalized)) return "low_activity";
  if (/장르|guideline|content/.test(normalized)) return "content_guidelines";
  if (/구독자|eligibility|인게이지먼트|중복|유튜브|언어/.test(normalized))
    return "eligibility";
  return "fit";
}

async function rejectionNotificationCandidates(input: {
  limit: number;
  leadIds: string[];
  allowAiRecommendation: boolean;
}): Promise<RejectionNotificationCandidate[]> {
  let rows: Record<string, unknown>[] = [];
  if (input.leadIds.length > 0) {
    const snapshots = await Promise.all(
      input.leadIds.map((leadId) =>
        adminDb.collection("program_sheet_leads").doc(leadId).get(),
      ),
    );
    rows = snapshots
      .filter((snap) => snap.exists)
      .map((snap) => ({ id: snap.id, ...snap.data() }));
  } else {
    // Live qualification-result mail must never continue from an unordered broad fallback.
    // If the ordered/indexed candidate query fails, preserve the failure evidence and block the
    // run instead of silently changing the recipient set.
    try {
      const snapshot = await adminDb
        .collection("program_sheet_leads")
        .orderBy("updatedAtIso", "desc")
        .limit(Math.max(input.limit * 3, input.limit))
        .get();
      rows = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    } catch {
      throw new Error(
        "qualification_rejection_candidate_query_failed: ordered updatedAtIso query is required before sending",
      );
    }
  }

  const candidates: RejectionNotificationCandidate[] = [];
  for (const lead of rows) {
    const leadId = safeId(lead.id);
    const email = leadEmail(lead);
    if (!leadId || !email) continue;
    const finalFail = leadIsFinalFail(lead);
    const aiFail = input.allowAiRecommendation && leadIsAiFail(lead);
    if (!finalFail && !aiFail) continue;
    const recommendation = leadLatestRecommendation(lead);
    const reasonCode = rejectionReasonCode(lead);
    const blockedReason = await rejectionSourceConsistencyIssue(lead);
    candidates.push({
      leadId,
      email,
      name: leadName(lead) || email,
      source: finalFail ? "final_verdict" : "ai_recommendation",
      sourceDecisionRef:
        asString(lead.latestDecisionRef) ||
        asString(recommendation.decisionRef),
      reasonCode,
      ...(blockedReason ? { blockedReason } : {}),
    });
    if (candidates.length >= input.limit) break;
  }
  return candidates;
}

async function rejectionSourceConsistencyIssue(
  lead: Record<string, unknown>,
): Promise<string> {
  if (!hasYoutubelessRejectionReason(lead)) return "";
  if (looksLikeYoutubeUrl(leadYoutubeUrl(lead))) {
    return "source_inconsistent_youtube_present_for_youtubeless_rejection";
  }
  if (looksLikeYoutubeUrl(await leadSourceRawYoutubeUrl(lead))) {
    return "source_inconsistent_sheet_raw_youtube_present_for_youtubeless_rejection";
  }
  return "";
}

function hasYoutubelessRejectionReason(lead: Record<string, unknown>): boolean {
  const recommendation = leadLatestRecommendation(lead);
  const reasons = Array.isArray(recommendation.reasons)
    ? recommendation.reasons
    : [];
  const values = [
    lead.qualificationReasonCode,
    lead.rejectionReasonCode,
    lead.qualificationFinalReason,
    lead.finalReason,
    lead.reason,
    recommendation.reason,
    recommendation.reasonCode,
    ...reasons,
  ];
  return values.some((value) =>
    /유튜브없음|youtube_missing|no_youtube|missing_youtube/i.test(
      asString(value),
    ),
  );
}

function leadYoutubeUrl(lead: Record<string, unknown>): string {
  const applicant = asRecord(lead.applicant);
  return (
    asString(lead.youtubeUrl) ||
    asString(applicant.youtubeUrl) ||
    asString(lead.channelUrl) ||
    asString(applicant.channelUrl)
  );
}

async function leadSourceRawYoutubeUrl(
  lead: Record<string, unknown>,
): Promise<string> {
  const inlineRaw = firstYoutubeLikeCell(asRecord(lead.rawCells));
  if (inlineRaw) return inlineRaw;
  const sourceRef = asString(lead.sourceRef);
  if (!/^sheet_raw_rows\/[a-zA-Z0-9_:-]{1,240}$/.test(sourceRef)) return "";
  const snapshot = await adminDb.doc(sourceRef).get();
  if (!snapshot.exists) return "";
  return firstYoutubeLikeCell(asRecord(snapshot.data()?.rawCells));
}

function firstYoutubeLikeCell(cells: Record<string, unknown>): string {
  for (const value of Object.values(cells)) {
    if (looksLikeYoutubeUrl(value)) return asString(value);
  }
  return "";
}

function looksLikeYoutubeUrl(value: unknown): boolean {
  return /(?:youtube\.com|youtu\.be)\//i.test(asString(value));
}

function rejectionNotificationIds(leadId: string) {
  const safeLeadId = safeDocId(leadId);
  const trackingId = `scp-qualification-fail-${safeLeadId}`;
  return {
    draftRef: trackingId,
    approvalRef: `${trackingId}-approval`,
    trackingId,
    auditId: privateHash(`scp-qualification-fail-audit:${trackingId}`),
  };
}

async function existingRejectionNotificationSend(
  leadId: string,
  trackingId: string,
): Promise<{
  sent: boolean;
  skipped?: boolean;
  reason?: string;
  resultRef?: string;
  outboundLogRef?: string;
  suppressionRef?: string;
}> {
  const outboundTrackingId = opaqueScpMailTrackingId(trackingId);
  const resultSnapshot = await adminDb
    .collection(RESULTS_COLLECTION)
    .where("leadId", "==", leadId)
    .where("templateKind", "==", "qualification_fail")
    .where("status", "==", "sent")
    .limit(1)
    .get();
  if (!resultSnapshot.empty) {
    const resultDoc = resultSnapshot.docs[0];
    const resultData = resultDoc.data();
    const outboundEvidence = await adminDb
      .collection("mail_outbound_log")
      .doc(outboundTrackingId)
      .get();
    const resultProviderConfirmed =
      isStrictScpProviderConfirmed(resultData);
    const outboundProviderConfirmed =
      outboundEvidence.exists &&
      isStrictScpProviderConfirmed(outboundEvidence.data(), "outbound");
    if (resultProviderConfirmed || outboundProviderConfirmed) {
      let outboundLogRef: string | undefined;
      try {
        outboundLogRef = await repairRejectionOutboundConversationLink(
          resultData,
          outboundTrackingId,
        );
      } catch (error) {
        await recordRejectionConversationRepairFailure({
          leadId,
          trackingId: outboundTrackingId,
          resultRef: resultDoc.ref.path,
          error,
        });
      }
      return {
        sent: true,
        resultRef: resultDoc.ref.path,
        outboundLogRef,
      };
    }
  }
  const skippedSnapshot = await adminDb
    .collection(RESULTS_COLLECTION)
    .where("leadId", "==", leadId)
    .where("templateKind", "==", "qualification_fail")
    .where("status", "==", "skipped")
    .limit(1)
    .get();
  if (!skippedSnapshot.empty) {
    const data = skippedSnapshot.docs[0].data();
    return {
      sent: false,
      skipped: true,
      reason: asString(data.skippedReason, "already_skipped"),
      resultRef: skippedSnapshot.docs[0].ref.path,
      suppressionRef: asString(asRecord(data.mailSafety).suppressionRef),
    };
  }
  // Backward-compatible terminal skip for rows produced before this wrapper learned to convert
  // mail_suppressions blocks into a skipped state. These are intentional no-send safety outcomes,
  // not transient quota failures, and should not be retried forever.
  const blockedSnapshot = await adminDb
    .collection(RESULTS_COLLECTION)
    .where("leadId", "==", leadId)
    .where("templateKind", "==", "qualification_fail")
    .where("status", "==", "blocked")
    .limit(1)
    .get();
  if (!blockedSnapshot.empty) {
    const data = blockedSnapshot.docs[0].data();
    const mailSafety = asRecord(data.mailSafety);
    const suppressionRef = asString(mailSafety.suppressionRef);
    if (
      mailSafety.allowed === false &&
      suppressionRef.startsWith(`${SUPPRESSIONS_COLLECTION}/`)
    ) {
      return {
        sent: false,
        skipped: true,
        reason: "mail_suppression",
        resultRef: blockedSnapshot.docs[0].ref.path,
        suppressionRef,
      };
    }
  }
  const outbound = await adminDb
    .collection("mail_outbound_log")
    .doc(outboundTrackingId)
    .get();
  if (
    outbound.exists &&
    isStrictScpProviderConfirmed(outbound.data(), "outbound")
  )
    return { sent: true, outboundLogRef: outbound.ref.path };
  return { sent: false };
}

async function recordRejectionConversationRepairFailure(input: {
  leadId: string;
  trackingId: string;
  resultRef: string;
  error: unknown;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  const rawCode = asString(
    (input.error as { code?: unknown } | null)?.code,
  ).toLowerCase();
  const errorCode = [
    "failed-precondition",
    "permission-denied",
    "resource-exhausted",
    "unavailable",
    "deadline-exceeded",
    "internal",
  ].includes(rawCode)
    ? rawCode
    : "conversation_link_repair_failed";
  const auditId = privateHash(
    `rejection-conversation-repair:${input.trackingId}`,
  );
  await adminDb
    .collection(REJECTION_NOTIFICATION_AUDIT_COLLECTION)
    .doc(auditId)
    .set(
      {
        id: auditId,
        leadId: input.leadId,
        trackingIdHash: privateHash(input.trackingId),
        resultRefHash: privateHash(input.resultRef),
        status: "repair_failed",
        repairTarget: "mail_outbound_log.conversationRef",
        errorCode,
        createdAtIso: nowIso,
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

async function repairRejectionOutboundConversationLink(
  result: Record<string, unknown>,
  trackingId: string,
): Promise<string | undefined> {
  if (!trackingId) return undefined;
  const outboundSnapshot = await adminDb
    .collection("mail_outbound_log")
    .doc(trackingId)
    .get();
  if (!outboundSnapshot.exists) return undefined;
  const messageRef = [
    asString(asRecord(result.sendResult).messageRef, ""),
    asString(result.messageRef, ""),
    asString(outboundSnapshot.data()?.messageRef, ""),
  ].find((ref) => ref.startsWith("message_sources/"));
  let sourceSnapshot = messageRef ? await adminDb.doc(messageRef).get() : null;
  if (!sourceSnapshot?.exists) {
    const sourceByTracking = await adminDb
      .collection("message_sources")
      .where("trackingId", "==", trackingId)
      .limit(1)
      .get();
    sourceSnapshot = sourceByTracking.docs[0] ?? null;
  }
  const conversationId = asString(sourceSnapshot?.data()?.conversationId, "");
  if (!conversationId) return outboundSnapshot.ref.path;
  const currentConversationId = asString(
    outboundSnapshot.data()?.conversationId,
    "",
  );
  const conversationRef = `conversations/${conversationId}`;
  if (
    currentConversationId !== conversationId ||
    asString(outboundSnapshot.data()?.conversationRef, "") !== conversationRef
  ) {
    await outboundSnapshot.ref.set(
      {
        conversationId,
        conversationRef,
        conversationLinkRepairedAtIso: new Date().toISOString(),
        conversationLinkRepairedBy:
          "sendPendingQualificationRejectionNotifications",
      },
      { merge: true },
    );
  }
  return outboundSnapshot.ref.path;
}

export async function prepareScpResultMail(request: CallableRequestShape) {
  // W72-C R2 HIGH-2: 이 콜러블은 **공개 입구**다(index.ts). 요청 본문의 provenance 를 그대로 두면
  //   인증된 manager 가 그 필드를 넣어 내부 sendEmail 을 internalTrustedInvocation:true 로
  //   승격시키고 infly 예외를 연다 — sendEmail 에 한 것과 같은 처방을 여기에도 건다.
  //   내부 직호출(스윕·재촉 등)은 서버가 request 를 만들며 플래그를 명시하므로 보존된다.
  if (request.internalTrustedInvocation !== true) {
    const externalData = request.data;
    if (externalData && typeof externalData === "object" && !Array.isArray(externalData)) {
      delete (externalData as Record<string, unknown>)[NUDGE_INTERNAL_PROVENANCE_FIELD];
    }
  }
  const auth = assertNonGuestAuth(
    request,
    "scp_result_mail.prepare",
    WRITE_ROLES,
  );
  // 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate, codex adversarial review
  // fix): this callable is also invoked directly (in-process, not through the client) by several
  // SYSTEM_ACTOR/systemRequest/mailRequestFor-built background flows (functions/scpOutreach.ts,
  // functions/scpVideoSubmissionReminder.ts, functions/scpOutboxMailWorkers.ts) whose synthetic
  // identity has no real org membership to resolve — those calls are already marked
  // internalTrustedInvocation:true (the same server-made-the-request marker the provenance-strip
  // check right above this uses) and skip the gate so the automated pipeline keeps flowing. A
  // real external (client) caller is never allowed to set that flag (see the comment above), so
  // this still fail-closes the public entry point WRITE_ROLES alone left open.
  if (request.internalTrustedInvocation !== true) {
    await assertScpEntitled(auth, request, "scp_result_mail.prepare");
  }
  const data = asRecord(request.data);
  const nowIso = new Date().toISOString();
  const leadId = safeId(data.leadId);
  const kind = normalizeKind(data.kind ?? data.templateKind);
  const mode: ScpResultMailMode =
    data.mode === "send_approved" ? "send_approved" : "draft_only";
  const context: ScpResultMailContext =
    data.context === "cold_reply" ? "cold_reply" : "default";
  // cold_reply only alters the re_guide kind (see COLD_REPLY_REGUIDE_BODY). Every other kind and
  // the default context are untouched.
  const coldReply = context === "cold_reply" && kind === "re_guide";
  const approval = asString(data.approval, "pending");
  const leadSnapshot = await readLeadSnapshot(leadId);
  const lead = leadSnapshot?.data ?? {};
  const programId = asString(
    data.programId,
    asString(lead.canonicalProgramId, asString(lead.programId, DEFAULT_PROGRAM_ID)),
  );
  const reminderSettingsSnapshot = await adminDb
    .collection("scp_video_submission_reminder_settings")
    .doc(safeDocId(programId || DEFAULT_PROGRAM_ID))
    .get();
  const configuredSubmissionFormUrl = asString(
    reminderSettingsSnapshot.data()?.submissionFormUrl,
    "",
  );
  const email = cleanEmail(data.email) || leadEmail(lead);
  const creatorId =
    safeId(data.creatorId) ||
    asString(lead.creatorId, "") ||
    `CR_${safeDocId(email || leadId || "scp")}`;
  const creatorName =
    text(data.name ?? data.creatorName) || leadName(lead) || email || "creator";
  // Only a structured reasonCode is honored; free-text reasons and internal lead fields are ignored so
  // no internal decision text can leak to the recipient (P0-6 / SEC-P0-009).
  const customerReason = customerFacingReason(
    data.reasonCode ?? lead.qualificationReasonCode ?? lead.rejectionReasonCode,
  );
  const creatorLink = await resolveCreatorLink(leadId, email, lead);
  const guideLinks = await resolveScpGuideLinks(data, lead);
  const baseTemplate = await readTemplate(kind);
  const template: ScpMailTemplate = coldReply
    ? {
        ...baseTemplate,
        body: COLD_REPLY_REGUIDE_BODY,
        vars: ["name", "form_link"],
      }
    : baseTemplate;
  const effectiveRequiredPlaceholders = templateRequiredPlaceholders(
    template.kind,
    coldReply,
  );
  const templateSchema = templatePlaceholderDiagnostics(
    template.kind,
    template.vars,
    `${template.subject}\n${template.body}`,
    effectiveRequiredPlaceholders,
  );
  const schemaMissingPlaceholders = kind === "qualification_pass"
    ? templateSchema.missingRequiredPlaceholders
    : [];
  const renderedTemplate = renderScpMail(template, {
    name: creatorName,
    email,
    onelink: asString(
      data.onelink,
      asString(creatorLink?.appsflyerOneLink, ""),
    ),
    adjust_link: asString(
      data.adjustLink,
      asString(creatorLink?.adjustLink, ""),
    ),
    campaign: asString(creatorLink?.campaign, ""),
    form_link: asString(
      data.formLink,
      configuredSubmissionFormUrl || asString(lead.formLink, DEFAULT_FORM_LINK),
    ),
    quick_start_guide_link: guideLinks.quickStartGuideLink,
    // P0-7: pass mail guide links are required campaign/program configuration. If the configured guide
    // values disappear, keep the placeholders unresolved so the send path holds before provider contact.
    guidebook_link: guideLinks.guidebookLink,
    user_id_guide_link: guideLinks.userIdGuideLink,
    reason: customerReason,
    days_since_request: asString(data.daysSinceRequest, asString(data.offsetDays, "")),
    reminder_number: asString(data.reminderNumber, ""),
    // W72 합동리뷰 R3-1: 독려 문안 계약 변수. 호출부가 formLink 만 넘기면 apply_link·homepage_link 가
    //   빈 칸이 되어 "거부는 안 나는데 링크가 없는 메일"이 만들어진다.
    // W72 합동리뷰 R3-1: DEFAULT_FORM_LINK 는 값이 아니라 `{{form_link}}` **플레이스홀더**다.
    //   그걸 폴백으로 쓰면 apply_link 가 미치환으로 남아 수신자가 리터럴 토큰을 본다(값 테스트가 잡았다).
    //   호출부가 명시 값을 넘기고, 없으면 설정/리드 값만 쓴다.
    // W72 교정 [헤세 지적 2026-08-13]: 지원 CTA 정본은 `/apply?locale=en` 이다(실측: h1 "Consent").
    //   설정/리드 값이 없을 때 빈 문자열로 두면 미치환으로 남아 draft 자체가 거부된다 —
    //   독려 레인이 통째로 0건이 되므로 정본으로 닫는다. `?locale=en&view=apply` 는 no-op 이라 안 쓴다.
    apply_link: asString(
      data.applyLink,
      configuredSubmissionFormUrl || asString(lead.formLink, "") || SCP_PORTAL_APPLY_LINK,
    ),
    homepage_link: asString(data.homepageLink, SCP_HOMEPAGE_LINK),
    portal_link: asString(
      data.portalLink,
      configuredSubmissionFormUrl || asString(lead.formLink, "") || SCP_PORTAL_APPLY_LINK,
    ),
    // W72 교정 [헤세 지적 2026-08-13]: 코호트2 CTA 는 **제출 폼**에 도달해야 한다.
    //   `portal_link`(포털 홈)를 쓰면 "How to submit" 을 눌러도 폼이 아니라 홈으로 간다(실측).
    //   회신 레인이 이미 쓰는 정본(`REPLY_LINK_SUBMIT` = /submit-content)을 그대로 재사용한다.
    submit_link: asString(data.submitLink, REPLY_LINK_SUBMIT),
    program_name: asString(data.programTitle, "Super Creator Partners"),
    supercent_brand: "Supercent",
  });
  // W72 합동리뷰 R4-2: **렌더 결과에 `{{...}}` 가 남아 있으면 무조건 실패**로 센다.
  //   변수표에 없거나 문법이 어긋난 토큰은 missingPlaceholders 에도 안 잡히는데,
  //   수신자에게는 그대로 보인다. 모양을 따지지 않고 잔존 자체를 사고로 취급한다.
  const residualPlaceholders = [...new Set(
    [...`${renderedTemplate.subject}\n${renderedTemplate.body}`
      .matchAll(new RegExp(SCP_MAIL_RESIDUAL_PLACEHOLDER_PATTERN.source, "g"))]
      .map((match) => normalizedResidualPlaceholder(match[0])),
  )];
  const rendered = {
    ...renderedTemplate,
    residualPlaceholders,
    missingPlaceholders: [...new Set([
      ...renderedTemplate.missingPlaceholders,
      ...schemaMissingPlaceholders,
      ...residualPlaceholders,
    ])],
    templateValidation: {
      ...templateSchema,
      enforcedAtSend: kind === "qualification_pass",
    },
  };
  // W72 합동리뷰 R5-1: **렌더 직후·영속 전에** 거부한다.
  //   R4-2 수리는 검사값을 `draft.missingPlaceholders` 에 담았는데 호출부는 최상위를 봐서 항상
  //   빈값이었고, 게다가 그 검사보다 **먼저** draft_only 가 원장에 영속됐다 —
  //   `{{ rogue-token }}` 이 accepted·drafted 로 통과했다(리뷰어 재현).
  //   여기서 던지면 결과 원장도 큐도 만들어지지 않는다: 미치환 토큰은 어떤 흔적도 남기지 않는다.
  //   독려 레인에만 건다 — 기존 레인은 미치환을 경고로 다루는 종전 계약을 그대로 유지한다.
  if (isNudgeDraftMailTemplateKind(kind) && rendered.missingPlaceholders.length > 0) {
    throw invalidTemplateArgument(
      `nudge draft has unreplaced placeholders: ${rendered.missingPlaceholders.join(", ")}`,
    );
  }
  const scpGate = isHumanGateRequiredFromSettings(
    kind === "gem_paid_submission_request" || kind === "video_submission_reminder"
      ? "encouragement"
      : "qualification",
    "mail_send",
    await readScpAutomationSettings(),
  );
  const suppression = await findMailSuppression(
    email,
    asString(data.creatorHandle, asString(lead.handle, "")),
    {
      mailPurpose: asString(data.mailPurpose, kind),
      templateKind: kind,
      // 서버 소유 표식은 **호출자가 넣은 값을 그대로** 넘긴다. 공용 콜러블은 입구에서 strip 하므로
      //   외부 요청으로는 채울 수 없다(위조 차단은 strip 지점이 담당한다).
      [NUDGE_INTERNAL_PROVENANCE_FIELD]: data[NUDGE_INTERNAL_PROVENANCE_FIELD],
    },
  );
  // Bouncer 검증(작업1). mail_suppressions 는 읽지도 쓰지도 않는다 — 완전히 별개 판정.
  const deliverability = await resolveMailDeliverability(email);
  if (deliverability.failOpen) console.warn("[scp-mail] mail_deliverability_fail_open", { status: deliverability.status });
  const resultIdentityHash = privateHash(
    JSON.stringify({
      leadIdHash: privateHash(leadId),
      creatorIdHash: privateHash(creatorId),
      emailHash: privateHash(email),
      kind,
      context,
      programId,
      gemGrantRef: asString(data.gemGrantRef),
      secondMailVersion: Number(data.secondMailVersion ?? 0),
      occurrenceRef: asString(data.occurrenceRef),
    }),
  );
  const draftRefSeed = asString(
    data.draftRef,
    `scp-draft-${resultIdentityHash.slice(0, 32)}`,
  );
  const draftRef = `scp-draft-${privateHash(draftRefSeed).slice(0, 40)}`;
  const approvalRefSeed = asString(
    data.approvalRef,
    `scp-approval-${privateHash(`${resultIdentityHash}:approval`).slice(0, 32)}`,
  );
  const approvalRef = `scp-approval-${privateHash(approvalRefSeed).slice(0, 40)}`;
  const trackingIdSeed = asString(
    data.trackingId,
    `scp-mail-${privateHash(`${draftRef}:${approvalRef}`).slice(0, 40)}`,
  );
  // Never propagate caller-supplied correlation identifiers into Firestore or
  // provider-facing mail surfaces. The opaque deterministic ID preserves
  // idempotency while raw tracking sentinels stay outside persistence/logging.
  const trackingId = opaqueScpMailTrackingId(trackingIdSeed);
  const resultRef = adminDb
    .collection(RESULTS_COLLECTION)
    .doc(privateHash(`${draftRef}:${approvalRef}`));
  const baseResult = {
    id: resultRef.id,
    leadId: leadId || null,
    creatorId,
    emailMasked: maskEmail(email),
    programId,
    canonicalProgramId: programId,
    campaignId: asString(data.campaignId) || null,
    templateKind: kind,
    mailPurpose: asString(data.mailPurpose, kind),
    gemGrantRef: asString(data.gemGrantRef) || null,
    occurrenceRef: asString(data.occurrenceRef) || null,
    targetRef: asString(data.targetRef) || null,
    secondMailVersion: Number(data.secondMailVersion ?? 0),
    offsetDays: Number(data.offsetDays ?? 0),
    reminderNumber: Number(data.reminderNumber ?? 0),
    templateRef: `${TEMPLATE_COLLECTION}/${kind}`,
    mode,
    context,
    draftRefHash: privateHash(draftRef),
    approvalRefHash: privateHash(approvalRef),
    trackingIdHash: privateHash(trackingId),
    subject: rendered.subject,
    bodyPreview: rendered.preview,
    missingPlaceholders: rendered.missingPlaceholders,
    templateValidation: rendered.templateValidation,
    scpGate,
    mailSafety: suppression,
    mailDeliverability: deliverability,
    source: "scp_result_mail",
    updatedAtIso: nowIso,
    updatedBy: auth.userId,
  };

  if (!email) {
    throw withCallableError(
      "invalid-argument",
      "recipient email is required for SCP result mail",
      auth,
    );
  }

  const dryRun = data.dryRun !== false;
  const liveSend = data.liveSend === true;
  if (dryRun && liveSend) {
    throw withCallableError(
      "invalid-argument",
      "result_mail_preview_flags_invalid: preview requires dryRun=true and liveSend=false",
      auth,
    );
  }
  const missingRequiredPlaceholders = rendered.missingPlaceholders.filter(
    (placeholder) =>
      templateRequiredPlaceholders(template.kind, coldReply).includes(
        placeholder,
      ),
  );
  const previewContentHash = privateHash(
    JSON.stringify({
      resultRefHash: privateHash(resultRef.path),
      actorUserIdHash: privateHash(auth.userId),
      leadIdHash: privateHash(leadId),
      creatorIdHash: privateHash(creatorId),
      recipientHash: privateHash(email),
      kind,
      context,
      draftRefHash: privateHash(draftRef),
      approvalRefHash: privateHash(approvalRef),
      trackingIdHash: privateHash(trackingId),
      subjectHash: privateHash(rendered.subject),
      bodyHash: privateHash(rendered.body),
      suppressionAllowed: suppression.allowed,
      suppressionReason: suppression.reason,
      missingRequiredPlaceholders,
    }),
  );

  const enqueueMailResultRefresh = async (status: string) =>
    enqueueScpLifecycleRefreshEvent({
      source: "scp_mail_results",
      sourceRef: resultRef.path,
      reason: `scp_mail_result_${status}`,
      aliases: [{ leadId, creatorId, email }],
      sourceUpdatedAtIso: nowIso,
    });

  if (!suppression.allowed && dryRun && mode === "draft_only") {
    return {
      ok: false,
      blocked: true,
      dryRun: true,
      sideEffects: "none" as const,
      status: "blocked" as const,
      draft: rendered,
      resultRef: resultRef.path,
      mailSafety: suppression,
      scpGate,
      cache: makeCache(`scp_result_mail:${publicHash(draftRef)}`, false),
      costLog: makeCostLog("scp_result_mail.preview", "mock-email", false, 0),
    };
  }

  if (!suppression.allowed && mode === "draft_only") {
    let alreadySent = false;
    await adminDb.runTransaction(async (transaction) => {
      const existing = await transaction.get(resultRef);
      if (isStrictScpProviderConfirmed(existing.data())) {
        alreadySent = true;
        return;
      }
      transaction.set(
        resultRef,
        {
          ...baseResult,
          ...legacyRawScpResultFieldDeletes(),
          status: "blocked",
          blockedReason: suppression.reason,
          heldReason: FieldValue.delete(),
          mockReason: FieldValue.delete(),
          skippedReason: FieldValue.delete(),
          operatorAlert: FieldValue.delete(),
          sendError: FieldValue.delete(),
          sendResult: FieldValue.delete(),
          sentAtIso: FieldValue.delete(),
          deliveryTruth: {
            providerConfirmed: false,
            state: "blocked",
            reason: suppression.reason,
          },
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
    if (alreadySent) {
      await enqueueMailResultRefresh("already_sent");
      return {
        ok: true,
        alreadySent: true,
        skipped: true,
        skippedReason: "already_sent",
        status: "skipped" as const,
        draft: rendered,
        resultRef: resultRef.path,
        mailSafety: suppression,
        scpGate,
        cache: makeCache(`scp_result_mail:${publicHash(draftRef)}`, false),
        costLog: makeCostLog(
          "scp_result_mail.prepare",
          "mock-email",
          false,
          0,
        ),
        behaviorLog: makeBehaviorLog(
          auth,
          "scp_result_mail.prepare",
          "success",
          "scp-automation",
        ),
      };
    }
    await enqueueMailResultRefresh("blocked");
    return {
      ok: false,
      blocked: true,
      status: "blocked" as const,
      draft: rendered,
      resultRef: resultRef.path,
      mailSafety: suppression,
      scpGate,
      cache: makeCache(`scp_result_mail:${publicHash(draftRef)}`, false),
      costLog: makeCostLog("scp_result_mail.prepare", "mock-email", false, 0),
      behaviorLog: makeBehaviorLog(
        auth,
        "scp_result_mail.prepare",
        "blocked",
        "scp-automation",
      ),
    };
  }

  if (mode === "draft_only") {
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        sideEffects: "none" as const,
        status: "draft_only" as const,
        draft: rendered,
        resultRef: resultRef.path,
        mailSafety: suppression,
        scpGate,
        cache: makeCache(`scp_result_mail:${publicHash(draftRef)}`, false),
        costLog: makeCostLog(
          "scp_result_mail.preview",
          "mock-email",
          false,
          0,
        ),
      };
    }
    // W72 합동리뷰 R3-2 / R4-1: 검수·발송이 전진한 result 를 재실행이 draft_only 로 강등하고
    //   sendResult·sentAtIso 를 지우는 축을 막는다.
    //   R4-1: 종전 수리는 read → **비트랜잭션** set 이라 TOCTOU 였다 —
    //   (재시도가 draft_only 를 읽음) → (동시 발송이 sent+providerConfirmed 기록) →
    //   (오래된 set 이 sent 를 draft_only 로 되돌림). 읽기·판정·쓰기를 **한 트랜잭션**으로 묶는다.
    const TERMINAL_RESULT_STATUSES = ["sent", "delivered", "sending", "approved", "queued_for_send"];
    const preservedStatus = await adminDb.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(resultRef);
      const existing = snapshot.data() ?? {};
      const existingStatus = asString(existing.status);
      const providerConfirmed = asRecord(existing.sendResult).providerConfirmed === true
        || asRecord(existing.deliveryTruth).providerConfirmed === true;
      if (providerConfirmed || TERMINAL_RESULT_STATUSES.includes(existingStatus)) {
        // 아무것도 쓰지 않는다. 같은 트랜잭션에서 읽고 판정했으므로 이 사이에 상태가 바뀔 수 없다.
        return existingStatus || "sent";
      }
      transaction.set(
        resultRef,
        {
          ...baseResult,
          ...legacyRawScpResultFieldDeletes(),
          status: "draft_only",
          blockedReason: FieldValue.delete(),
          heldReason: FieldValue.delete(),
          mockReason: FieldValue.delete(),
          skippedReason: FieldValue.delete(),
          operatorAlert: FieldValue.delete(),
          sendError: FieldValue.delete(),
          sendResult: FieldValue.delete(),
          sentAtIso: FieldValue.delete(),
          deliveryTruth: {
            providerConfirmed: false,
            state: "draft_only",
            reason: "draft_persisted_without_send",
          },
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return "";
    });
    if (preservedStatus) {
      return {
        ok: true,
        preserved: true as const,
        status: preservedStatus,
        draft: rendered,
        resultRef: resultRef.path,
        scpGate,
        cache: makeCache(`scp_result_mail:${publicHash(draftRef)}`, false),
        costLog: makeCostLog("scp_result_mail.prepare", "mock-email", false, 0),
      };
    }
    await enqueueMailResultRefresh("draft_only");
    return {
      ok: true,
      status: "draft_only" as const,
      draft: rendered,
      resultRef: resultRef.path,
      mailSafety: suppression,
      scpGate,
      cache: makeCache(`scp_result_mail:${publicHash(draftRef)}`, false),
      costLog: makeCostLog("scp_result_mail.prepare", "mock-email", false, 0),
      behaviorLog: makeBehaviorLog(
        auth,
        "scp_result_mail.prepare",
        "success",
        "scp-automation",
      ),
    };
  }

  // P1-8: bind the mail_send gate into the send branch instead of only computing it. Automatic send is
  // allowed only when the server-computed gate is off (auto_ai + backtest passed). Otherwise a real human
  // approval is mandatory; without either, the request cannot progress past a draft.
  const humanApproved = approval === "approved";
  // W72-B2 [헤세 결정 2026-08-13 "코호트 1 3 도 게이트 필요없어 바로 보내면 좋겠다"]:
  //   독려 코호트1·3 은 **시스템 승인 정책**으로 나간다. 사람 승인 대신 정책 승인을 인정하되,
  //   ① 독려 문안 kind 이고 ② 승인 근거가 이 정책일 때로 **범위를 좁힌다** —
  //   다른 레인(자격 결과·재안내 등)의 human gate 는 그대로다.
  //   suppression·레인캡·전역캡·미치환 거부·2단계 preview→apply 는 전부 그대로 통과한다.
  const systemApproved = approval === "system_approved"
    && asString(data.approvalPolicy) === "w72_nudge_cohort_live"
    && isNudgeDraftMailTemplateKind(kind);
  if (scpGate.required && !humanApproved && !systemApproved) {
    throw withCallableError(
      "failed-precondition",
      "human approval is required before SCP result mail send",
      auth,
    );
  }

  // Never send while a required template value is unresolved. Preview is
  // side-effect free; an actual apply records the terminal hold only after the
  // one-time preview claim has been atomically claimed below.
  const customLinkMissing =
    requiresCustomLink(kind, coldReply) &&
    missingRequiredPlaceholders.includes("onelink");
  const missingPlaceholderAlertType = customLinkMissing
    ? "onelink_missing"
    : "required_placeholders_missing";
  if (dryRun) {
    const previewToken = randomUUID();
    const previewTokenHash = privateHash(previewToken);
    const previewExpiresAtIso = new Date(
      Date.now() + RESULT_MAIL_PREVIEW_TTL_MS,
    ).toISOString();
    const existing = await resultRef.get();
    if (isStrictScpProviderConfirmed(existing.data())) {
      return {
        ok: true,
        alreadySent: true,
        skipped: true,
        skippedReason: "already_sent",
        status: "sent" as const,
        draft: rendered,
        resultRef: resultRef.path,
        mailSafety: suppression,
        scpGate,
        cache: makeCache(`scp_result_mail:${publicHash(draftRef)}`, false),
        costLog: makeCostLog("scp_result_mail.preview", "mock-email", false, 0),
      };
    }
    const previewClaimRef = adminDb
      .collection(RESULT_MAIL_PREVIEW_CLAIMS_COLLECTION)
      .doc(previewTokenHash);
    await previewClaimRef.create({
      id: previewClaimRef.id,
      claimState: "current",
      previewContentHash,
      resultRefHash: privateHash(resultRef.path),
      draftRefHash: privateHash(draftRef),
      approvalRefHash: privateHash(approvalRef),
      trackingIdHash: privateHash(trackingId),
      actorUserIdHash: privateHash(auth.userId),
      previewOutcome: !suppression.allowed
        ? "blocked"
        : missingRequiredPlaceholders.length > 0
          ? "held"
          : "eligible",
      expiresAtIso: previewExpiresAtIso,
      expiresAt: new Date(previewExpiresAtIso),
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    return {
      ok: true,
      dryRun: true,
      liveSend: false,
      status: "preview" as const,
      draft: rendered,
      resultRef: resultRef.path,
      previewToken,
      previewHash: previewContentHash,
      previewExpiresAtIso,
      mailSafety: suppression,
      scpGate,
      operatorAlert:
        missingRequiredPlaceholders.length > 0
          ? {
              type: missingPlaceholderAlertType,
              needsOperator: true,
              missingPlaceholders: missingRequiredPlaceholders,
            }
          : undefined,
      cache: makeCache(
        `scp_result_mail:${publicHash(draftRef)}:preview`,
        false,
      ),
      costLog: makeCostLog("scp_result_mail.preview", "mock-email", false, 0),
    };
  }

  // Flu conversation org-filter round 3 (codex adversarial review round 3, finding #2): everything
  // above this point (template rendering, draft/preview responses) is side-effect free and reached
  // by many existing internal batch callables/tests with an inherited or synthetic non-scp-entitled
  // auth — unaffected by design. Once dryRun is false, this request is genuinely trying to reach
  // the trusted-worker send hand-off below, which deliberately skips the public sender's
  // conversation preflight (functions/chat-ai.ts assertEndUserMailConversationAccess) for
  // legitimate scheduled sends (SYSTEM_ACTOR calls set internalTrustedInvocation:true). Without a
  // gate here, a manager with no scp grant (or granted to a different org) could still reach a real
  // scp mail send once every other approval/safety condition passed.
  const targetConversationId = asString(
    data.conversationId,
    `scp-${safeDocId(leadId || email || creatorId)}`,
  );
  // Flu conversation org-filter round 4 (codex adversarial review round 4, finding #1): the row
  // check below must authorize the same document persistSentEmail (functions/chat-ai.ts, the real
  // writer inside sendEmailFromTrustedWorker) will actually write to — persistSentEmail
  // canonicalizes the raw id first (canonicalConversationIdForData, functions/conversationScope.ts,
  // the SAME canonicalizer chat-ai.ts's own send preflight/persistence paths use), so a caller-
  // supplied or derived id that does not exist as its own doc (e.g. "scp-foreign-lead") can still
  // canonicalize to an EXISTING conversation (e.g. "program-scp-default-cr_foreign") that a
  // different org owns. Canonicalize with the identical identity fields (creatorId/creatorName/
  // programId/to) the data object below carries into that same writer, rather than re-deriving the
  // decision from a different shape.
  const canonicalTargetConversationId = canonicalConversationIdForData(
    { conversationId: targetConversationId, creatorId, creatorName, programId, to: email },
    targetConversationId,
  );
  // Flu conversation org-filter round 5 (codex adversarial review round 5, finding #1): when the
  // canonical destination does not exist yet, an scp-entitled caller could previously send to a
  // brand-new conversation with NO org check at all — the trusted-worker path (persistSentEmail,
  // functions/chat-ai.ts) creates that new conversation without any org or mailAccountId stamp, so
  // it would also read as an ungated legacy row for every future caller. Set once so both the
  // authorization check below and the stamp passed to sendEmailFromTrustedWorker agree.
  let scpSendOrgId = "";
  if (request.internalTrustedInvocation !== true) {
    const resultMailAccessScope = await resolveConversationMailAccessScope(auth);
    if (!resultMailAccessScope.isSuperAdmin && !resultMailAccessScope.hasScpEntitlement) {
      throw Object.assign(new Error("permission-denied: caller does not hold the scp mailbox grant"), {
        code: "permission-denied",
        errorCode: "prepare_scp_result_mail_scp_grant_required",
      });
    }
    const targetSnapshot = await adminDb.collection("conversations").doc(canonicalTargetConversationId).get();
    // Flu conversation org-filter round 16 (codex adversarial review round 16, finding #1): the
    // hand-off below (sendEmailFromTrustedWorker → sendEmailInternal, internalMailAccountPin left
    // unset) independently resolves the actual sending account via selectOutboundMailAccountForData
    // — for an EXISTING conversation that itself carries a PERSONAL account stamp (e.g. a human
    // operator's own manual takeover), that resolution can "pin" to that personal account
    // (selectOutboundMailAccount's conversation_pinned source) instead of the canonical scp mailbox
    // this whole result-mail pipeline is designed to send from. Predict the SAME resolution the
    // trusted hand-off will make (identical inputs: same conversationId, no live caller — matching
    // sendEmailInternal's own `callerCtx: null` for a trusted invocation) before ever authorizing
    // this request as an scp send, so the checks below are for the account that will ACTUALLY be
    // used — never let a caller authorized on scp entitlement silently launder into an unaudited
    // personal-mailbox send, or vice versa.
    const predictedOutboundAccount = await selectOutboundMailAccountForData(
      { conversationId: canonicalTargetConversationId },
      null,
    );
    if (predictedOutboundAccount.accountId !== CANONICAL_SCP_MAIL_ACCOUNT_ID) {
      if (!resultMailAccessScope.isSuperAdmin) {
        throw Object.assign(new Error("permission-denied: this conversation would send through a non-canonical mailbox — send manually instead"), {
          code: "permission-denied",
          errorCode: "prepare_scp_result_mail_non_canonical_sender",
        });
      }
    } else if (targetSnapshot.exists) {
      // Flu conversation org-filter round 19 (codex adversarial review round 19, scope decision
      // after round 18): mixing mailboxes in one thread is not a supported flow for a genuine
      // external, non-super_admin caller — deny outright regardless of org match; a blank/legacy
      // stamp is not "a different explicit account" and is unaffected. Round 18 briefly denied
      // this unconditionally (super_admin and internal/scheduled workers, i.e. this callable's own
      // internalTrustedInvocation:true trusted-worker hand-off from scpOutreach.ts's SYSTEM_ACTOR
      // sends and scpVideoSubmissionReminder.ts's scheduled sends, included) — but program
      // conversation ids do not encode which mailbox created them, so a scheduler's legitimate
      // result-mail/reminder/nudge to a creator whose canonical conversation happens to already be
      // stamped from a personal-mailbox send would be silently and permanently denied, eventually
      // marking real jobs failed. Mixed-mailbox threads are a known pre-existing limitation
      // (canonical ids lack mailbox); tracked separately for a real fix (mailbox-aware canonical
      // ids). Narrowed back to the same non-super_admin, non-internal scope round 17 originally
      // shipped — this whole `internalTrustedInvocation !== true` block already only runs for a
      // genuine external caller.
      const existingStampedAccountId = asString((targetSnapshot.data() ?? {}).mailAccountId, "");
      if (!resultMailAccessScope.isSuperAdmin && existingStampedAccountId && existingStampedAccountId !== CANONICAL_SCP_MAIL_ACCOUNT_ID) {
        console.warn("[scp-mail] mixed_mailbox_thread_denied", {
          conversationId: canonicalTargetConversationId,
          existingStampedAccountId,
        });
        throw Object.assign(new Error("permission-denied: conversation belongs to a different mailbox"), {
          code: "permission-denied",
          errorCode: "prepare_scp_result_mail_mixed_mailbox_thread",
        });
      }
      // The destination's OWN historical stamp is not the source of truth here — the resolved
      // sender (confirmed scp above) is. Force the row to read as explicitly scp for the org check
      // regardless of how it happens to be stamped (blank/legacy or, in principle, mismatched),
      // matching persistSentEmail's own authorizeCanonicalScpSendDestination fix.
      if (!canReadScpConversationRowForOrg(
        { id: canonicalTargetConversationId, ...(targetSnapshot.data() ?? {}), mailAccountId: CANONICAL_SCP_MAIL_ACCOUNT_ID },
        {
          viewerOrgId: resultMailAccessScope.viewerOrgId,
          isSuperAdmin: resultMailAccessScope.isSuperAdmin,
          hasScpEntitlement: resultMailAccessScope.hasScpEntitlement,
        },
      )) {
        throw Object.assign(new Error("permission-denied: conversation is not accessible to this mail caller"), {
          code: "permission-denied",
          errorCode: "prepare_scp_result_mail_conversation_not_accessible",
        });
      }
    } else if (!resultMailAccessScope.isSuperAdmin) {
      // A brand-new destination has no existing stamp to check against — the caller's own
      // confidently-resolved org becomes the new conversation's org (they are the one bringing it
      // into existence). A caller with the scp grant but no provable own org cannot be authorized
      // to create scp mail history under an org no one can verify.
      if (!resultMailAccessScope.viewerOrgId) {
        throw Object.assign(new Error("permission-denied: caller's org could not be determined for a new scp conversation"), {
          code: "permission-denied",
          errorCode: "prepare_scp_result_mail_new_conversation_org_required",
        });
      }
      scpSendOrgId = resultMailAccessScope.viewerOrgId;
    }
  }

  if (!liveSend) {
    throw withCallableError(
      "invalid-argument",
      "result_mail_live_apply_flags_required: actual apply requires dryRun=false and liveSend=true",
      auth,
    );
  }

  const previewToken = asString(data.previewToken);
  const expectedPreviewHash = asString(data.previewHash);
  if (!previewToken || !expectedPreviewHash) {
    throw withCallableError(
      "failed-precondition",
      "result_mail_preview_required: create a current send preview before actual apply",
      auth,
    );
  }
  const previewTokenHash = privateHash(previewToken);
  const previewClaimRef = adminDb
    .collection(RESULT_MAIL_PREVIEW_CLAIMS_COLLECTION)
    .doc(previewTokenHash);
  await adminDb.runTransaction(async (transaction) => {
    const previewClaim = await transaction.get(previewClaimRef);
    const existing = await transaction.get(resultRef);
    const claimData = previewClaim.data() ?? {};
    const stored = existing.data() ?? {};
    const previewExpiresAtMs = Date.parse(asString(claimData.expiresAtIso));
    const previewMatches =
      previewClaim.exists &&
      asString(claimData.claimState) === "current" &&
      asString(claimData.previewContentHash) === expectedPreviewHash &&
      expectedPreviewHash === previewContentHash &&
      asString(claimData.actorUserIdHash) === privateHash(auth.userId) &&
      asString(claimData.resultRefHash) === privateHash(resultRef.path) &&
      asString(claimData.draftRefHash) === privateHash(draftRef) &&
      asString(claimData.approvalRefHash) === privateHash(approvalRef) &&
      asString(claimData.trackingIdHash) === privateHash(trackingId) &&
      Number.isFinite(previewExpiresAtMs) &&
      previewExpiresAtMs > Date.now();
    if (!previewMatches) {
      throw withCallableError(
        "failed-precondition",
        "result_mail_preview_conflict: preview is missing, stale, expired, changed, or already claimed",
        auth,
      );
    }
    if (isStrictScpProviderConfirmed(stored)) {
      throw withCallableError(
        "failed-precondition",
        "result_mail_already_sent: provider-confirmed delivery already exists",
        auth,
      );
    }
    transaction.set(
      previewClaimRef,
      {
        claimState: "claimed",
        claimedAtIso: nowIso,
        claimedByUserIdHash: privateHash(auth.userId),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.set(
      resultRef,
      {
        ...baseResult,
        ...legacyRawScpResultFieldDeletes(),
        status: "sending",
        blockedReason: FieldValue.delete(),
        heldReason: FieldValue.delete(),
        mockReason: FieldValue.delete(),
        skippedReason: FieldValue.delete(),
        operatorAlert: FieldValue.delete(),
        sendError: FieldValue.delete(),
        sendResult: FieldValue.delete(),
        sentAtIso: FieldValue.delete(),
        deliveryTruth: {
          providerConfirmed: false,
          state: "sending",
          reason: "actual_apply_claimed",
        },
        actualApplyClaim: {
          state: "claimed",
          previewTokenHash,
          previewContentHash,
          claimedAtIso: nowIso,
          claimedByUserIdHash: publicHash(auth.userId),
          dryRun: false,
          liveSend: true,
        },
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  // Only the actual-apply branch may alter the result ledger. If a safety
  // condition somehow survives claim validation (for example, a future claim
  // format no longer binds that field), consume the one-time claim and record
  // the truthful no-send outcome without invoking the provider.
  if (
    !suppression.allowed ||
    missingRequiredPlaceholders.length > 0 ||
    deliverability.status === "undeliverable"
  ) {
    const noSendStatus = !suppression.allowed
      ? "blocked"
      : deliverability.status === "undeliverable"
        ? "skipped"
        : "held";
    const noSendReason = !suppression.allowed
      ? "mail_suppression"
      : deliverability.status === "undeliverable"
        ? "mail_deliverability_undeliverable"
        : customLinkMissing
          ? "custom_link_missing"
          : "required_placeholders_missing";
    if (noSendStatus === "skipped") console.warn("[scp-mail] mail_deliverability_skip", { reason: noSendReason });
    const noSendAtIso = new Date().toISOString();
    const noSendBatch = adminDb.batch();
    noSendBatch.set(
      resultRef,
      {
        ...baseResult,
        ...legacyRawScpResultFieldDeletes(),
        status: noSendStatus,
        blockedReason:
          noSendStatus === "blocked" ? noSendReason : FieldValue.delete(),
        heldReason:
          noSendStatus === "held" ? noSendReason : FieldValue.delete(),
        mockReason: FieldValue.delete(),
        skippedReason:
          noSendStatus === "skipped" ? noSendReason : FieldValue.delete(),
        operatorAlert:
          noSendStatus === "held"
            ? {
                type: missingPlaceholderAlertType,
                needsOperator: true,
                missingPlaceholders: missingRequiredPlaceholders,
              }
            : FieldValue.delete(),
        sendError: FieldValue.delete(),
        sendResult: FieldValue.delete(),
        sentAtIso: FieldValue.delete(),
        deliveryTruth: {
          providerConfirmed: false,
          state: noSendStatus,
          reason: noSendReason,
        },
        actualApplyClaim: {
          state: "completed",
          previewTokenHash,
          previewContentHash,
          claimedAtIso: nowIso,
          completedAtIso: noSendAtIso,
          dryRun: false,
          liveSend: true,
        },
        updatedAtIso: noSendAtIso,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    noSendBatch.set(
      previewClaimRef,
      {
        claimState: "consumed",
        deliveryStatus: noSendStatus,
        providerConfirmed: false,
        completedAtIso: noSendAtIso,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    await noSendBatch.commit();
    await enqueueMailResultRefresh(noSendStatus);
    return {
      ok: false,
      blocked: noSendStatus === "blocked",
      held: noSendStatus === "held",
      skipped: noSendStatus === "skipped",
      status: noSendStatus,
      draft: rendered,
      resultRef: resultRef.path,
      mailSafety: suppression,
      scpGate,
      operatorAlert:
        noSendStatus === "held"
          ? {
              type: missingPlaceholderAlertType,
              needsOperator: true,
              missingPlaceholders: missingRequiredPlaceholders,
            }
          : undefined,
      cache: makeCache(`scp_result_mail:${publicHash(draftRef)}`, false),
      costLog: makeCostLog("scp_result_mail.apply", "mock-email", false, 0),
      behaviorLog: makeBehaviorLog(
        auth,
        "scp_result_mail.apply",
        "blocked",
        "scp-automation",
      ),
    };
  }

  let sendResult: unknown;
  try {
    sendResult = await sendEmailFromTrustedWorker({
      ...request,
      // W72-C R1 HIGH-3: 이건 **내부 호출**이다. 공용 콜러블 입구의 표식 strip 대상이 아니다
      //   (외부 요청은 이 플래그를 못 넣는다 — request 객체를 서버가 만든다).
      internalTrustedInvocation: true,
      data: {
        conversationId: targetConversationId,
        creatorId,
        creatorName,
        programId,
        programTitle: asString(data.programTitle, "Super Creator Partners"),
        to: email,
        subject: rendered.subject,
        text: rendered.body,
        draftRef,
        trackingId,
        approvalRef,
        approval: "approved",
        gameId: "scp-automation",
        author: auth.userId,
        // W72 마감리뷰 R2 P0-B: 자동 독려는 **사람이 보낸 것이 아니다.**
        //   chat-ai 는 fromRole!=="ai" 를 `manual_send` 로 분류하고,
        //   mailOutboundSafety 는 manual_send 를 **outreachSendingEnabled 킬스위치 검사 앞에서**
        //   무조건 허용한다 — 글로벌 발송 중지를 걸어도 예약 독려가 그대로 나가는 구조였다.
        //   시스템 승인 발송은 `ai` 로 표기해 auto_send 안전 경로(킬스위치·전역 캡)를 지난다.
        //   사람이 승인한 발송은 종전대로 human 이다(그쪽 계약은 건드리지 않는다).
        fromRole: systemApproved ? "ai" : "human",
        // 2026-09-05 적대 리뷰 P0-b: 이 경로가 실어 보내는 purpose 에는 **거래성**(지원확인·UID 안내·
        //   로그인 승인/반려·콘텐츠 접수·영상 결과·온보딩)과 **독려 코호트①③** 이 섞여 있다.
        //   서버 소유 표식이 없으면 셋 다 outreach 로 분류돼 아웃리치 수동 정지 하나에 함께 죽었다.
        //   표식은 외부 콜러블 입구가 지우므로 위조 경로로는 못 들어온다(mailOutboundLanes 위협 모델).
        ...serverOwnedMailLaneProvenance(SCP_RESULT_MAIL_LANE_SOURCE),
        sourceRef: resultRef.path,
        mailPurpose: asString(data.mailPurpose, kind),
        templateKind: kind,
        // W72-C R1 HIGH-1: 실발송은 chat-ai sendEmail → evaluateMailSafety 를 한 번 더 지난다.
        //   여기서 서버 소유 표식을 안 실으면 그 층에서 다시 infly 로 막혀 예외가 반쪽이 된다
        //   (scpMail 자체 조회만 통과하고 발송은 여전히 0건 — 값 테스트가 그 상태를 잡았다).
        [NUDGE_INTERNAL_PROVENANCE_FIELD]: data[NUDGE_INTERNAL_PROVENANCE_FIELD],
        gemGrantRef: asString(data.gemGrantRef),
        targetRef: asString(data.targetRef),
        occurrenceRef: asString(data.occurrenceRef),
        secondMailVersion: Number(data.secondMailVersion ?? 0),
        mailType:
          kind === "qualification_fail"
            ? "qualification_result_fail"
            : `scp_result_${kind}`,
        dryRun: false,
        liveSend: true,
      },
    },
    // Flu conversation org-filter round 6 (codex adversarial review round 6, finding #2/#3):
    // passed as a trusted FUNCTION ARGUMENT (never through `data`, which persistSentEmail no
    // longer trusts for this) — only set for an authorized, non-super_admin caller creating a
    // brand-new scp conversation (see the authorization block above). Empty/undefined for every
    // other case (existing conversation, super_admin, internal scheduled sends); persistSentEmail
    // itself stamps mailAccountId:"scp" regardless and leaves orgId empty when this is absent.
    scpSendOrgId || undefined);
  } catch (error) {
    const failedAtIso = new Date().toISOString();
    const rawErrorCode = asString(
      (error as { code?: unknown } | null)?.code,
    ).toLowerCase();
    const providerErrorCode = [
      "failed-precondition",
      "permission-denied",
      "resource-exhausted",
      "unavailable",
      "deadline-exceeded",
      "internal",
    ].includes(rawErrorCode)
      ? rawErrorCode
      : "provider_send_failed";
    const failureBatch = adminDb.batch();
    failureBatch.set(
      resultRef,
      {
        ...baseResult,
        ...legacyRawScpResultFieldDeletes(),
        status: "blocked",
        blockedReason: "provider_send_failed",
        heldReason: FieldValue.delete(),
        mockReason: FieldValue.delete(),
        skippedReason: FieldValue.delete(),
        operatorAlert: FieldValue.delete(),
        sendResult: FieldValue.delete(),
        sentAtIso: FieldValue.delete(),
        deliveryTruth: {
          providerConfirmed: false,
          state: "blocked",
          reason: "provider_send_failed",
        },
        sendError: {
          ...legacyRawScpResultNestedFieldDeletes(),
          message: FieldValue.delete(),
          stack: FieldValue.delete(),
          details: FieldValue.delete(),
          code: providerErrorCode,
          failedAtIso,
        },
        actualApplyClaim: {
          state: "failed",
          previewTokenHash,
          previewContentHash,
          claimedAtIso: nowIso,
          failedAtIso,
          dryRun: false,
          liveSend: true,
        },
        updatedAtIso: failedAtIso,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    failureBatch.set(
      previewClaimRef,
      {
        claimState: "failed",
        providerErrorCode,
        failedAtIso,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    await failureBatch.commit();
    await enqueueMailResultRefresh("blocked");
    throw withCallableError(
      "failed-precondition",
      `result_mail_provider_send_failed: ${providerErrorCode}`,
      auth,
    );
  }

  const sendRecord = asRecord(sendResult);
  const duplicateSend =
    sendRecord.duplicate === true ||
    asString(sendRecord.deliveryState) === "skipped_duplicate";
  const canonicalOutbound = duplicateSend
    ? (
        await adminDb.collection("mail_outbound_log").doc(trackingId).get()
      ).data() ?? {}
    : {};
  const canonicalOutboundRecord = asRecord(canonicalOutbound);
  const delivery = classifyScpResultMailDelivery(
    sendRecord,
    canonicalOutboundRecord,
  );
  const completedAtIso = new Date().toISOString();
  const skippedReason = duplicateSend
    ? "duplicate_reservation"
    : delivery.status === "skipped"
      ? delivery.reason
      : "";
  const reconciledProviderSend =
    duplicateSend && delivery.providerConfirmed;
  const providerMessageIdHash = reconciledProviderSend
    ? strictProviderMessageIdHash(
        canonicalOutboundRecord.providerMessageIdHash,
      )
    : strictProviderMessageIdHash(sendRecord.providerMessageIdHash);
  const messageRef = asString(
    reconciledProviderSend
      ? canonicalOutboundRecord.messageRef
      : sendRecord.messageRef,
  );
  const verifiedMigrationMarker =
    reconciledProviderSend &&
    asString(canonicalOutboundRecord.verificationMarker) ===
      SCP_RESULT_PROVIDER_VERIFIED_MIGRATION_MARKER
      ? SCP_RESULT_PROVIDER_VERIFIED_MIGRATION_MARKER
      : "";
  const sanitizedSendResult = {
    ok: sendRecord.ok === true,
    duplicate: duplicateSend,
    source: reconciledProviderSend
      ? asString(
          canonicalOutboundRecord.deliverySource,
          asString(canonicalOutboundRecord.source),
        )
      : asString(sendRecord.source, "unknown"),
    deliveryState: reconciledProviderSend
      ? "sent"
      : asString(sendRecord.deliveryState, "unknown"),
    messageRefHash: messageRef ? privateHash(messageRef) : "",
    providerMessageIdHash,
    acceptedCount: Number(
      reconciledProviderSend
        ? canonicalOutboundRecord.acceptedCount ?? 0
        : sendRecord.acceptedCount ?? 0,
    ),
    rejectedCount: Number(
      reconciledProviderSend
        ? canonicalOutboundRecord.rejectedCount ?? 0
        : sendRecord.rejectedCount ?? 0,
    ),
    persisted:
      reconciledProviderSend
        ? canonicalOutboundRecord.persisted === true
        : sendRecord.persisted === true,
  };
  const persistedSendResult = {
    ...legacyRawScpResultNestedFieldDeletes(),
    ...sanitizedSendResult,
  };
  const completionBatch = adminDb.batch();
  completionBatch.set(
    resultRef,
    {
      ...baseResult,
      ...legacyRawScpResultFieldDeletes(),
      status: delivery.status,
      blockedReason:
        delivery.status === "blocked" ? delivery.reason : FieldValue.delete(),
      mockReason:
        delivery.status === "mock" ? delivery.reason : FieldValue.delete(),
      skippedReason:
        delivery.status === "skipped" ? skippedReason : FieldValue.delete(),
      heldReason: FieldValue.delete(),
      operatorAlert: FieldValue.delete(),
      sendError: FieldValue.delete(),
      sendResult: persistedSendResult,
      deliveryTruth: {
        providerConfirmed: delivery.providerConfirmed,
        state: delivery.status,
        reason: delivery.reason,
        verificationMarker:
          verifiedMigrationMarker || FieldValue.delete(),
        canonicalOutboundDeliveryState: asString(
          canonicalOutboundRecord.deliveryState,
        ),
      },
      sentAtIso: delivery.providerConfirmed
        ? completedAtIso
        : FieldValue.delete(),
      actualApplyClaim: {
        state: "completed",
        previewTokenHash,
        previewContentHash,
        claimedAtIso: nowIso,
        completedAtIso,
        dryRun: false,
        liveSend: true,
      },
      updatedAtIso: completedAtIso,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  completionBatch.set(
    previewClaimRef,
    {
      claimState: "consumed",
      deliveryStatus: delivery.status,
      providerConfirmed: delivery.providerConfirmed,
      completedAtIso,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  if (delivery.providerConfirmed && kind === "gem_paid_submission_request") {
    enqueueProviderConfirmedReminderTriggerInBatch(completionBatch, {
      resultRef: resultRef.path,
      programId,
      leadId,
      creatorId,
      email,
      uid: asString(data.uid),
      token: asString(data.token),
      creatorName: asString(data.name, asString(data.creatorName)),
      campaignId: asString(data.campaignId),
      formLink: asString(rendered.values.form_link),
      gemGrantRef: asString(data.gemGrantRef),
      sentAtIso: completedAtIso,
      secondMailVersion: Math.max(1, Number(data.secondMailVersion ?? 1)),
    });
  }
  await completionBatch.commit();
  await enqueueMailResultRefresh(delivery.status);

  const engineMailSafety = asRecord(sendRecord.mailSafety);
  return {
    ok: delivery.status === "sent",
    blocked: delivery.status === "blocked",
    mock: delivery.status === "mock",
    skipped: delivery.status === "skipped",
    status: delivery.status,
    skippedReason,
    deliveryTruth: {
      ...delivery,
      ...(verifiedMigrationMarker
        ? { verificationMarker: verifiedMigrationMarker }
        : {}),
    },
    draft: rendered,
    resultRef: resultRef.path,
    mailSafety:
      Object.keys(engineMailSafety).length > 0 ? engineMailSafety : suppression,
    scpGate,
    sendResult: sanitizedSendResult,
    cache: makeCache(`scp_result_mail:${publicHash(draftRef)}`, false),
    costLog: makeCostLog("scp_result_mail.prepare", "smtp", false, 0),
    behaviorLog: makeBehaviorLog(
      auth,
      "scp_result_mail.prepare",
      delivery.status === "sent" ? "success" : "blocked",
      "scp-automation",
    ),
  };
}

function normalizeTemplate(
  value: Record<string, unknown>,
  userId: string,
  nowIso: string,
): ScpMailTemplate {
  const kind = normalizeTemplateKindForWrite(value.kind ?? value.id);
  if (isScpEditableMailTemplateKind(kind)) {
    return normalizeReceiptTemplate(value, kind, userId, nowIso);
  }
  const template = normalizeTemplateForKind(kind, value, userId, nowIso);
  templateValidation(kind, template.vars, `${template.subject}\n${template.body}`);
  return template;
}

/**
 * R7: validates the explicit bodyFormat field. Absent/empty falls back to the caller-supplied
 * default (used both for fresh saves without the field and for reconstructing legacy stored docs
 * that predate this migration — same inference the old client used: html present => "html").
 */
function normalizeTemplateBodyFormat(
  value: unknown,
  fallback: TemplateBodyFormat,
): TemplateBodyFormat {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "html" || value === "text" || value === "markdown") return value;
  throw invalidTemplateArgument('bodyFormat must be "html", "text", or "markdown"');
}

function normalizeReceiptTemplate(
  value: Record<string, unknown>,
  kind: ScpEditableMailTemplateKind,
  userId: string,
  nowIso: string,
): ScpMailTemplate {
  const subject = text(value.subject, 400);
  // R7a: htmlDraft is the operator's authored HTML, preserved verbatim no matter what bodyFormat
  // is published as. `html` stays the send representation: empty when bodyFormat is "text", which
  // is exactly the "html absent => text-only send" mechanism the (unmodified) resolve/render path
  // already implements — so text-only sends keep behaving exactly as before.
  const htmlDraft = asString(value.htmlDraft ?? value.html ?? value.bodyHtml ?? value.body);
  const bodyFormat = normalizeTemplateBodyFormat(value.bodyFormat, htmlDraft ? "html" : "text");
  // W72-HOTFIX: markdown 은 authored HTML 을 갖지 않는다(본문이 곧 마크다운이다).
  //   text 와 같이 send 표현의 html 을 비워 두고, 실제 HTML 은 렌더 시점에
  //   컴파일러가 본문에서 만든다(scpReceiptMailTemplates.renderScpReceiptMailTemplate).
  const html = bodyFormat === "text" || bodyFormat === "markdown" ? "" : htmlDraft;
  const plainText = asString(value.text ?? value.plainText);
  const validation = validateScpReceiptMailTemplate({
    kind,
    subject,
    html,
    text: plainText,
  });
  if (!validation.valid) {
    throw invalidTemplateArgument(
      `receipt mail template variables invalid: ${[
        ...validation.unknownVariables.map((name) => `unknown:${name}`),
        ...validation.missingRequiredVariables.map((name) => `missing:${name}`),
        ...validation.malformedVariables.map((name) => `malformed:${name}`),
      ].join(", ")}`,
    );
  }
  renderScpReceiptMailTemplate({
    kind,
    subject,
    html,
    text: plainText,
    // R1-P1-1: **저장 검증도 발송과 같은 경로를 타야 한다.**
    //   bodyFormat 을 안 넘기면 검증은 text 경로로 통과하는데 발송은 markdown 경로로 가서,
    //   "저장은 됐는데 발송에서 갈리는" 이번 사고 모양이 그대로 남는다. 같은 입력을 주면
    //   컴파일러 단계까지 동일해져 markdown 산출물이 발송 전에 검증된다.
    bodyFormat,
    values: RECEIPT_TEMPLATE_PREVIEW_VALUES,
  });
  return {
    id: kind,
    kind,
    title: text(value.title, 120) || defaultReceiptTemplateTitle(kind),
    subject,
    body: plainText,
    html,
    htmlDraft,
    text: plainText,
    bodyFormat,
    vars: [...RECEIPT_TEMPLATE_RULES[nudgeDraftMailTemplateBaseKind(kind) || kind].allowed],
    status: value.status === "archived" ? "archived" : "active",
    draftOnlyDefault: true,
    updatedAtIso: nowIso,
    updatedBy: userId,
  };
}

function defaultReceiptTemplateTitle(
  kind: ScpEditableMailTemplateKind,
): string {
  if (kind === "application_confirmed") {
    return "신청 확인 메일";
  }
  if (kind === "uid_guide") {
    return "UID 등록 안내 메일";
  }
  if (kind === "video_result_mail") {
    return "영상 검수 결과 메일";
  }
  if (kind === "video_result_mail_approved") {
    return "영상 승인 결과 메일";
  }
  return "콘텐츠 제출 확인 메일";
}

function normalizeStoredTemplate(
  kind: ScpMailTemplateKind,
  value: Record<string, unknown>,
): ScpMailTemplate {
  return normalizeTemplateForKind(
    kind,
    { ...value, kind },
    asString(value.updatedBy, "system"),
    asString(value.updatedAtIso, "1970-01-01T00:00:00.000Z"),
    false,
  );
}

function normalizeTemplateForKind(
  kind: ScpMailTemplateKind,
  value: Record<string, unknown>,
  userId: string,
  nowIso: string,
  strictSubject = true,
): ScpMailTemplate {
  if (isScpEditableMailTemplateKind(kind)) {
    return normalizeReceiptTemplate(value, kind, userId, nowIso);
  }
  const defaults = DEFAULT_TEMPLATES[kind];
  const subject = normalizeSingleLine(
    value.subject,
    defaults.subject,
    220,
    "subject",
    strictSubject,
  );
  const body = normalizeMultiline(value.body, defaults.body, 5000);
  const vars = extractVars(`${subject}\n${body}`);
  return {
    id: kind,
    kind,
    title: text(value.title, 120) || defaults.title,
    subject,
    body,
    vars,
    status: value.status === "archived" ? "archived" : "active",
    draftOnlyDefault: true,
    updatedAtIso: nowIso,
    updatedBy: userId,
  };
}

async function readTemplate(
  kind: ScpMailTemplateKind,
): Promise<ScpMailTemplate> {
  // W72 합동리뷰 R3-1: 독려 문안 2종은 editable 이면서 **result-mail 렌더러를 타야 한다**
  //   (코호트1·3 draft 경로). editable 전체를 막으면 draft 가 0건이 된다.
  //   영수증 4종은 종전대로 거부한다 — 그쪽은 발송 워커가 자기 렌더러로 처리한다.
  if (isScpEditableMailTemplateKind(kind) && !isNudgeDraftMailTemplateKind(kind)) {
    throw invalidTemplateArgument("receipt templates are not result mail templates");
  }
  const snapshot = await adminDb
    .collection(TEMPLATE_COLLECTION)
    .doc(kind)
    .get();
  // W72 합동리뷰 R3-1: 독려 문안에는 코드 기본값이 없다. **활성 발행 문서만** 쓴다 —
  //   없거나 archived 면 거절한다(엉뚱한 기본 문안으로 draft 를 만들지 않는다).
  if (isNudgeDraftMailTemplateKind(kind)) {
    const nudgeData = snapshot.data() ?? {};
    // W72 합동리뷰 R4-P2: `status` 부재를 active 로 보면 **fail-open** 이다(발행 안 한 문서가 나간다).
    //   정확 일치만 허용한다.
    if (!snapshot.exists || asString(nudgeData.status) !== "active") {
      throw invalidTemplateArgument(`nudge template ${kind} is not published`);
    }
    return normalizeTemplateForKind(kind, nudgeData, "system", new Date().toISOString());
  }
  const defaults = DEFAULT_TEMPLATES[kind as keyof typeof DEFAULT_TEMPLATES];
  if (!snapshot.exists)
    return {
      ...defaults,
      updatedAtIso: "1970-01-01T00:00:00.000Z",
      updatedBy: "system",
    };
  const data = snapshot.data() ?? {};
  if (data.status === "archived")
    return {
      ...defaults,
      updatedAtIso: asString(data.updatedAtIso, "1970-01-01T00:00:00.000Z"),
      updatedBy: asString(data.updatedBy, "system"),
    };
  return normalizeStoredTemplate(kind, data);
}

function renderScpMail(
  template: ScpMailTemplate,
  values: Record<string, string>,
): RenderedScpMail {
  // W72 합동리뷰 R3-1: 독려 문안 2종은 result-mail 렌더러를 탄다(readTemplate 과 같은 예외).
  //   여기까지 막혀 있어서 거부 지점이 **두 곳**이었다 — 하나만 열면 draft 는 여전히 0건이다.
  if (isScpEditableMailTemplateKind(template.kind) && !isNudgeDraftMailTemplateKind(template.kind)) {
    throw invalidTemplateArgument("receipt templates use receipt renderer");
  }
  const missing = new Set<string>();
  // W72 합동리뷰 R4-2: 검증기와 **같은 정본 패턴**을 쓴다. 종전에는 렌더러만 `\w+` 라
  //   `{{ apply_link }}`(내부 공백)가 검증을 통과하고도 치환되지 않았다.
  const replace = (input: string) =>
    input.replace(new RegExp(SCP_MAIL_PLACEHOLDER_PATTERN.source, "g"), (match, rawKey: string) => {
      const key = rawKey.trim();
      const value = values[key] ?? "";
      if (!value || value === DEFAULT_FORM_LINK) {
        missing.add(key);
        return match;
      }
      return value;
    });
  const subject = replace(template.subject);
  const body = replace(template.body);
  return {
    subject,
    body,
    preview: compactPreview(body),
    missingPlaceholders: Array.from(missing),
    values: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        key === "email" ? (maskEmail(value) ?? "") : value,
      ]),
    ),
  };
}

function normalizedResidualPlaceholder(value: string): string {
  const match = new RegExp(`^${SCP_MAIL_PLACEHOLDER_PATTERN.source}$`).exec(value);
  return match?.[1]?.trim() || value;
}

async function readLeadSnapshot(
  leadId: string,
): Promise<{ id: string; data: Record<string, unknown> } | null> {
  if (!leadId) return null;
  const snapshot = await adminDb
    .collection("program_sheet_leads")
    .doc(leadId)
    .get();
  return snapshot.exists
    ? { id: snapshot.id, data: snapshot.data() ?? {} }
    : null;
}

type ScpGuideLinks = {
  quickStartGuideLink: string;
  guidebookLink: string;
  userIdGuideLink: string;
};

async function resolveScpGuideLinks(
  requestData: Record<string, unknown>,
  lead: Record<string, unknown>,
): Promise<ScpGuideLinks> {
  const configuredProgramId =
    asString(requestData.programId, "").trim()
    || asString(lead.programId, "").trim()
    || DEFAULT_PROGRAM_ID;
  const programId = safeDocId(configuredProgramId);
  const programSnapshot = await adminDb.collection("programs").doc(programId).get();
  const program = programSnapshot.exists ? (programSnapshot.data() ?? {}) : {};
  const sources = [
    requestData,
    asRecord(requestData.guideLinks),
    lead,
    asRecord(lead.guideLinks),
    asRecord(lead.scpGuideLinks),
    program,
    asRecord(program.guideLinks),
    asRecord(program.scpGuideLinks),
    asRecord(program.templateValues),
    asRecord(program.mailTemplateValues),
  ];
  return {
    quickStartGuideLink: firstConfiguredHttpsUrl(sources, [
      "quickStartGuideLink",
      "quick_start_guide_link",
      "quickStart",
    ]),
    guidebookLink: firstConfiguredHttpsUrl(sources, [
      "guidebookLink",
      "guidebook_link",
      "guidebook",
    ]),
    userIdGuideLink: firstConfiguredHttpsUrl(sources, [
      "userIdGuideLink",
      "user_id_guide_link",
      "userIdGuide",
    ]),
  };
}

function firstConfiguredHttpsUrl(
  sources: Record<string, unknown>[],
  keys: string[],
): string {
  for (const source of sources) {
    for (const key of keys) {
      const candidate = asString(source[key], "").trim();
      if (!candidate) continue;
      try {
        const parsed = new URL(candidate);
        if (parsed.protocol === "https:" && !parsed.username && !parsed.password) {
          return parsed.toString();
        }
      } catch {
        // Invalid configured values remain unresolved and are reported as missing.
      }
    }
  }
  return "";
}

async function resolveCreatorLink(
  leadId: string,
  email: string,
  lead: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const explicitRef = asString(lead.creatorLinkRef, "");
  if (explicitRef.startsWith("creator_links/")) {
    const explicit = await adminDb.doc(explicitRef).get();
    if (explicit.exists) return explicit.data() ?? null;
  }
  if (leadId) {
    const byLead = await adminDb
      .collection("creator_links")
      .where("leadId", "==", leadId)
      .limit(1)
      .get();
    if (!byLead.empty) return byLead.docs[0].data() ?? null;
  }
  if (email) {
    const byEmail = await adminDb
      .collection("creator_links")
      .where("email", "==", email)
      .limit(1)
      .get();
    if (!byEmail.empty) return byEmail.docs[0].data() ?? null;
  }
  return null;
}

async function findMailSuppression(
  email: string,
  handle: string,
  /** W72-C R1: 예외 판정에 쓰는 발송 맥락(purpose·templateKind·서버 소유 표식). */
  exemptionData: Record<string, unknown> = {},
): Promise<{
  allowed: boolean;
  reason: string;
  suppressionRef?: string;
  matchedField?: string;
}> {
  if (!email && !handle)
    return { allowed: true, reason: "no recipient suppression match" };
  const normalizedEmail = cleanEmail(email);
  const domain = emailDomain(normalizedEmail);
  const normalizedHandle = handle.trim().toLowerCase();
  const checks = [
    ["email", normalizedEmail],
    ["domain", domain],
    ["handle", normalizedHandle],
  ].filter((entry): entry is [string, string] => entry[1].length > 0);

  // W72-C R2 HIGH-1: 조회를 **정본 하나**(scanActiveMailSuppressions)로 합쳤다.
  //   갈라진 구현이 이번 라운드 내내 결함의 온상이었다 — limit(1)·limit(10) fail-open,
  //   예외 미배선이 전부 "여기 따로 있는 구현" 때문이었다.
  //   정본은 임의 상한 없이 active 전량을 커서로 훑고, 예외 불가 규칙을 만나면 즉시 단락한다.
  const scan = await scanActiveMailSuppressions(checks as ReadonlyArray<readonly ["email" | "handle" | "domain", string]>);
  if (scan.hits.length === 0) return { allowed: true, reason: "mail_suppressions checked" };

  const representative = scan.nonExemptible ?? scan.hits[0];
  const exempt = nudgeInflyExemptionApplies({
    ruleId: representative.ruleId ?? "",
    hasNonExemptibleRule: Boolean(scan.nonExemptible),
    data: exemptionData,
  });
  if (exempt) {
    return { allowed: true, reason: "mail_suppressions checked (nudge infly exemption)" };
  }
  return {
    allowed: false,
    reason: representative.reason ?? "mail_suppressions match",
    suppressionRef: representative.ref,
    matchedField: representative.matchedField,
  };
}

function requiresCustomLink(
  kind: ScpMailTemplateKind,
  coldReply = false,
): boolean {
  // A cold-outreach reply resend (case B/D) drives to the application form only and carries no
  // OneLink yet, so it must not be held for a missing OneLink. All other paths are unchanged.
  if (coldReply) return false;
  return kind === "qualification_pass" || kind === "re_guide";
}

function templateRequiredPlaceholders(
  kind: ScpMailTemplateKind,
  coldReply = false,
): readonly string[] {
  if (coldReply) return ["name", "form_link"];
  return TEMPLATE_PLACEHOLDER_RULES[nudgeDraftMailTemplateBaseKind(kind) || kind].required;
}

function customerFacingReason(value: unknown): string {
  const code = asString(value, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  if (!code) return GENERIC_CUSTOMER_REASON;
  return CUSTOMER_REASON_MESSAGES[code] ?? GENERIC_CUSTOMER_REASON;
}

/**
 * W72F-R2 P0 — **파괴적 경로 전용 strict normalizer.**
 *
 * `normalizeKind` 는 미지원 값을 `qualification_pass` 로 떨어뜨린다. 발송 경로에서는
 * 그 관용이 편의였지만, archive/delete 에서는 **엉뚱한 문안을 지우는 우회**가 된다
 * (`_wX`·bogus kind 요청이 qualification_pass 를 archive 하고 원 문안은 살아남는다).
 * 그래서 여기서는 폴백 없이, 아는 kind 가 아니면 거절한다.
 */
function strictTemplateKindOrThrow(value: unknown): ScpMailTemplateKind {
  const raw = asString(value).trim();
  if (!raw) throw invalidTemplateArgument("template kind is required");
  const known: readonly string[] = [
    "qualification_pass", "qualification_fail", "re_guide", "encouragement",
    "gem_paid_submission_request", "video_submission_reminder",
  ];
  // 별칭은 발송 경로와 동일하게 인정한다.
  const alias: Record<string, string> = {
    fail: "qualification_fail", reguide: "re_guide", reminder: "re_guide",
  };
  const resolved = alias[raw] ?? raw;
  if (known.includes(resolved) || isScpEditableMailTemplateKind(resolved)) {
    return resolved as ScpMailTemplateKind;
  }
  throw invalidTemplateArgument(`unknown template kind: ${raw}`);
}

function normalizeKind(value: unknown): ScpMailTemplateKind {
  if (value === "qualification_fail" || value === "fail")
    return "qualification_fail";
  if (value === "re_guide" || value === "reguide" || value === "reminder")
    return "re_guide";
  if (value === "encouragement") return "encouragement";
  if (value === "gem_paid_submission_request") return "gem_paid_submission_request";
  if (value === "video_submission_reminder") return "video_submission_reminder";
  if (isScpEditableMailTemplateKind(value)) return value;
  return "qualification_pass";
}

function normalizeTemplateKindForWrite(value: unknown): ScpMailTemplateKind {
  if (value === "qualification_pass" || value === "pass")
    return "qualification_pass";
  if (value === "qualification_fail" || value === "fail")
    return "qualification_fail";
  if (value === "re_guide" || value === "reguide" || value === "reminder")
    return "re_guide";
  if (value === "encouragement") return "encouragement";
  if (value === "gem_paid_submission_request") return "gem_paid_submission_request";
  if (value === "video_submission_reminder") return "video_submission_reminder";
  if (isScpEditableMailTemplateKind(value)) return value;
  throw invalidTemplateArgument("unsupported SCP mail template kind");
}

function normalizeSingleLine(
  value: unknown,
  fallback: string,
  maxLength: number,
  field: string,
  strict = true,
): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return fallback;
  if (normalized.includes("\n")) {
    if (strict) throw invalidTemplateArgument(`${field} must be a single line`);
    return normalized.replace(/\n+/g, " ").trim().slice(0, maxLength);
  }
  return normalized.trim().slice(0, maxLength);
}

function normalizeMultiline(
  value: unknown,
  fallback: string,
  maxLength: number,
): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/\r\n?/g, "\n");
  return normalized.trim().length > 0 ? normalized.slice(0, maxLength) : fallback;
}

function templateValidation(
  kind: ScpMailTemplateKind,
  vars: readonly string[],
  source = "",
) {
  const diagnostics = templatePlaceholderDiagnostics(kind, vars, source);
  if (diagnostics.malformedPlaceholders.length > 0) {
    throw invalidTemplateArgument(
      `malformed placeholders for ${kind}: ${diagnostics.malformedPlaceholders.join(", ")}`,
    );
  }
  if (diagnostics.unsupportedPlaceholders.length > 0) {
    throw invalidTemplateArgument(
      `unsupported placeholders for ${kind}: ${diagnostics.unsupportedPlaceholders.join(", ")}`,
    );
  }
  if (diagnostics.missingRequiredPlaceholders.length > 0) {
    throw invalidTemplateArgument(
      `required placeholders missing for ${kind}: ${diagnostics.missingRequiredPlaceholders.join(", ")}`,
    );
  }
  return diagnostics;
}

function templatePlaceholderDiagnostics(
  kind: ScpMailTemplateKind,
  vars: readonly string[],
  source = "",
  requiredPlaceholders: readonly string[] = TEMPLATE_PLACEHOLDER_RULES[nudgeDraftMailTemplateBaseKind(kind) || kind].required,
) {
  const rules = TEMPLATE_PLACEHOLDER_RULES[nudgeDraftMailTemplateBaseKind(kind) || kind];
  const malformedPlaceholders = [...new Set(
    Array.from(source.matchAll(/\{\{([^{}]+)\}\}/g))
      .map((match) => match[1].trim())
      .filter((variable) => !/^\w+$/.test(variable)),
  )];
  const unsupportedPlaceholders = vars.filter(
    (variable) => !rules.allowed.includes(variable),
  );
  const missingRequiredPlaceholders = requiredPlaceholders.filter(
    (variable) => !vars.includes(variable),
  );
  return {
    valid:
      malformedPlaceholders.length === 0
      && unsupportedPlaceholders.length === 0
      && missingRequiredPlaceholders.length === 0,
    allowedPlaceholders: [...rules.allowed],
    requiredPlaceholders: [...requiredPlaceholders],
    placeholders: [...vars],
    malformedPlaceholders,
    unsupportedPlaceholders,
    missingRequiredPlaceholders,
  };
}

function scpTemplateContentHash(template: ScpMailTemplate): string {
  const canonical = JSON.stringify({
    kind: template.kind,
    title: template.title,
    subject: template.subject,
    body: template.body,
    html: template.html ?? "",
    // R7: bodyFormat/htmlDraft must be in the hash — otherwise a format-only toggle (html stays ""
    // on both sides of a text<->text no-op, or unchanged while re-editing the dormant draft) would
    // hash-collide with the prior save and get silently swallowed as a no-op ("saved" but nothing
    // actually changed).
    htmlDraft: template.htmlDraft ?? "",
    bodyFormat: template.bodyFormat ?? "",
    text: template.text ?? "",
    vars: template.vars,
    status: template.status,
    draftOnlyDefault: template.draftOnlyDefault,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function changedTemplateFields(
  before: ScpMailTemplate | null,
  after: ScpMailTemplate,
): string[] {
  if (!before)
    return ["title", "subject", "body", "html", "htmlDraft", "bodyFormat", "text", "vars", "status", "draftOnlyDefault"];
  const fields = [
    "title",
    "subject",
    "body",
    "html",
    "htmlDraft",
    "bodyFormat",
    "text",
    "vars",
    "status",
    "draftOnlyDefault",
  ] as const;
  return fields.filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
}

function storedVersion(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

type TemplateCasExpectation = {
  expectedVersion?: number;
  expectedHash?: string;
};

function templateCasExpectation(
  data: Record<string, unknown>,
): TemplateCasExpectation {
  const expectation: TemplateCasExpectation = {};
  if (Object.prototype.hasOwnProperty.call(data, "expectedVersion")) {
    if (
      typeof data.expectedVersion !== "number"
      || !Number.isSafeInteger(data.expectedVersion)
      || data.expectedVersion < 0
    ) {
      throw invalidTemplateArgument("expectedVersion must be a non-negative integer");
    }
    expectation.expectedVersion = data.expectedVersion;
  }
  if (Object.prototype.hasOwnProperty.call(data, "expectedHash")) {
    if (
      typeof data.expectedHash !== "string"
      || (data.expectedHash !== "" && !/^[a-f0-9]{64}$/i.test(data.expectedHash))
    ) {
      throw invalidTemplateArgument("expectedHash must be empty or a SHA-256 hash");
    }
    expectation.expectedHash = data.expectedHash.toLowerCase();
  }
  return expectation;
}

function assertTemplateCas(
  expectation: TemplateCasExpectation,
  currentVersion: number,
  currentHash: string,
  auth: ReturnType<typeof assertNonGuestAuth>,
): void {
  if (
    expectation.expectedVersion === undefined
    && expectation.expectedHash === undefined
  ) {
    throw invalidTemplateArgument("expectedVersion or expectedHash is required");
  }
  if (
    expectation.expectedVersion !== undefined
    && expectation.expectedVersion !== currentVersion
  ) {
    throw templateCallableError(
      "failed-precondition",
      `template version conflict: expected ${expectation.expectedVersion}, current ${currentVersion}`,
      auth,
    );
  }
  if (
    expectation.expectedHash !== undefined
    && expectation.expectedHash !== currentHash
  ) {
    throw templateCallableError(
      "failed-precondition",
      `template hash conflict: expected ${expectation.expectedHash || "<empty>"}, current ${currentHash || "<empty>"}`,
      auth,
    );
  }
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(asRecord(value))
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, entry]) => [key, entry.slice(0, 8000)]),
  );
}

function invalidTemplateArgument(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid-argument", errorCode: "invalid_template_argument_unauthorized" });
}

function templateCallableError(
  code: string,
  message: string,
  auth: ReturnType<typeof assertNonGuestAuth>,
) {
  return Object.assign(new Error(message), {
    code,
    behaviorLog: makeBehaviorLog(
      auth,
      "scp_mail_templates.upsert",
      "blocked",
      "scp-automation",
    ),
  });
}

function leadApplicant(lead: Record<string, unknown>): Record<string, unknown> {
  return asRecord(lead.applicant);
}

function leadEmail(lead: Record<string, unknown>): string {
  return cleanEmail(leadApplicant(lead).email) || cleanEmail(lead.email);
}

function leadName(lead: Record<string, unknown>): string {
  return (
    text(leadApplicant(lead).name) || text(lead.name) || text(lead.channelTitle)
  );
}

function cleanEmail(value: unknown): string {
  const raw = asString(value, "").trim().toLowerCase().slice(0, 240);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw) ? raw : "";
}

function emailDomain(value: string): string {
  const at = value.lastIndexOf("@");
  return at >= 0 ? value.slice(at + 1) : "";
}

function safeId(value: unknown): string {
  return safeDocId(asString(value, ""));
}

function text(value: unknown, maxLength = 180): string {
  return asString(value, "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function stringList(value: unknown, maxItems = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    )
    .map((item) => safeDocId(item).slice(0, 60))
    .filter(Boolean)
    .slice(0, maxItems);
}

function extractVars(value: string): string[] {
  return Array.from(
    new Set(
      // R4-2: 변수 추출도 정본 패턴을 공유한다(세 곳이 갈리면 같은 사고가 재발한다).
      Array.from(value.matchAll(new RegExp(SCP_MAIL_PLACEHOLDER_PATTERN.source, "g")))
        .map((match) => match[1]),
    ),
  ).slice(0, 20);
}

function compactPreview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 280 ? `${compact.slice(0, 277)}...` : compact;
}

function withCallableError(
  code: string,
  message: string,
  auth: ReturnType<typeof assertNonGuestAuth>,
) {
  return Object.assign(new Error(message), {
    code,
    behaviorLog: makeBehaviorLog(
      auth,
      "scp_result_mail.prepare",
      "blocked",
      "scp-automation",
    ),
  });
}
