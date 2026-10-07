import { createHash } from "node:crypto";
import { compileMailArtifact, resolveMailSubject } from "./mailCompiler";
import { extractInlineImageAssets } from "./mailAssets";
import {
  CONTENT_SUBMITTED_EMAIL_EN_HTML,
  SCP_APPLICATION_CONFIRMED_EMAIL_EN_HTML,
  SCP_APPLICATION_VIDEO_REMINDER_EN_HTML,
} from "./mailTemplatesGenerated";
import {
  SCP_APPLICATION_CONFIRMED_SUBJECT,
  SCP_CONTENT_SUBMITTED_RECEIPT_SUBJECT,
  SCP_CONTENT_SUBMITTED_RECEIPT_TEXT,
} from "./scpReceiptMailContracts";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";
// W7-3f: 위험 문구 매치는 발송 게이트(mailSafetyPolicy)가 쓰는 그 매처를 그대로 재사용한다.
import { firstKeywordMatch } from "./mailSafetyShared";
// 2026-09-05 다타이틀: 미리보기 기본값의 게임 관련 값은 레지스트리에서만 온다(리터럴 금지).
import {
  defaultProgramTitle,
  requiredHashtagsForTitle,
  resolveProgramTitles,
} from "./programTitles";
import { canonicalScpProgramId } from "./scpProgramAlias";

export type ScpReceiptMailTemplateKind =
  | "application_confirmed"
  | "content_submitted"
  // W62-2 [헤세 · 지원 관리 탭]: apply 는 했는데 영상을 아직 안 올린 크리에이터에게 보내는 재촉.
  //   **재촉의 정본 모수는 확인 메일이 실제로 전달된 사람뿐이다**(실측 26명) — 확인 메일이
  //   dead_letter 로 죽은 28명은 처음 안내를 받은 적이 없으므로 재촉이 아니라 최초 안내가 맞다
  //   (리더 판정 L2026-0810-04 (2), 모수 분리). 그 분리는 발송 콜러블이 강제한다.
  | "application_video_reminder";

/**
 * W7-3b: 편집기(`scp_mail_templates/{kind}`)로 운영자가 덮어쓸 수 있지만 **정본 fallback 이 코드
 * 렌더러**인 레인. 문서가 없거나 archived 면 각 워커의 기존 하드코딩 렌더가 그대로 쓰인다
 * (fail-closed: 동작이 오늘과 같다). 그래서 아래 FALLBACKS 표에는 넣지 않는다.
 */
export type ScpMailTemplateOverrideKind =
  | "uid_guide"
  // ── 영상 검수 판정 메일이 실제로 쓰는 kind (2026-09-05 경로 확인) ──────────────────
  // `VideoReviewMailKind` 3종이 여기 **2종**으로 접힌다
  // (scpOutboxMailWorkers.renderVideoResultMailForDelivery):
  //   content_approved                        → `video_result_mail_approved`
  //   content_changes_requested / content_rejected → `video_result_mail`
  // 본문 정본은 `scp_mail_templates/{kind}`(status:"active") 이고, 없으면 코드 폴백
  // `renderVideoResultMailFallback` 이다. 미리보기(검수 탭 dry-run)와 드레인(실발송)은 **같은**
  // 렌더러·같은 변수 집합을 탄다 — 한쪽에만 값을 넣으면 그 자리에서 WYSIWYG 이 깨진다.
  // 사유 문구(videoReviewCriteria 의 rule-tag 문구집)는 **크리에이터에게 실제로 나가는 값**이다
  // (감사 §d 3b 의 미해결 질문에 대한 답: 운영자 UI 전용이 아니다).
  | "video_result_mail"
  // W120 [적대 리뷰 H3]: 승인 메일이 반려용 override 문서를 타면, 운영자가 반려 문안으로 발행한
  //   `scp_mail_templates/video_result_mail` 이 **승인 통지에 그대로 나간다**. 판정별로 문서를
  //   가른다 — 반려·변경요청은 기존 키를 그대로 써서 이미 발행된 문서가 계속 이긴다(하위호환).
  | "video_result_mail_approved"
  // W72 합동리뷰 R2-2: 코호트1·3 독려 문안. 오버라이드 kind 로 등록해야
  //   `prepareScpResultMail` 이 `scp_mail_templates/{kind}` 에서 **헤세가 설정한 문안**을 읽는다.
  //   등록 전에는 normalizeKind 가 미지의 키를 조용히 `qualification_pass` 로 떨어뜨렸다.
  | "scp_nudge_cohort1_read_no_reply_en"
  | "scp_nudge_cohort2_applied_no_video_en"
  | "scp_nudge_cohort3_unread_no_reply_en"
  // W91 [헤세 · admin-bridge 승인 메일]: 포털 로그인 승인 커맨드 성공 시 보내는 안내. `loginUrl` 은
  //   uid_guide 의 `uid_guide_link` 와 같은 이유로 오버라이드 kind 다 — 수신자별 값(포털 material
  //   회수 결과)이 **발송 시점에만** 정해져서 enqueue 시점에 스냅샷을 구울 수 없다.
  | "login_approved"
  // 반려 안내 2종(헤세 확정 카피, 26-08-27). 사유(reasonCode)별로 문안이 완전히 달라서 kind 를
  // 가른다 — video_result 의 승인/반려 분리(W120 H3)와 같은 이유다: 한 키를 공유하면 운영자가
  // 한쪽 사유로 발행한 문서가 다른 사유 반려에도 그대로 나간다.
  | "login_rejected_subscriber_minimum"
  | "login_rejected_channel_not_found"
  | "login_rejected_public_reason"
  // Task-100 F-6: 반려 후 재제출 독려 draft(EN). {{reason_message}}/{{deadline}}/{{portal_link}}
  // 만 허용 — 링크는 전부 변수로만 참조한다(다른 override kind 와 같은 규칙).
  | "resubmission_nudge_en";

/** 편집기가 다루는 HTML+텍스트 템플릿 kind 전체. */
export type ScpEditableMailTemplateKind =
  | ScpReceiptMailTemplateKind
  | ScpMailTemplateOverrideKind;

export type RenderedScpReceiptMailTemplate = Readonly<{
  kind: ScpEditableMailTemplateKind;
  source: "published" | "fallback";
  revision: number;
  hash: string;
  subject: string;
  text: string;
  /**
   * W8-3: 이 발행본의 본문 형식. `"text"` 면 HTML 파트 없이 텍스트만 발송한다
   * (어댑터 계약 "Absent => plain-text send"). 발송 레인이 "빈 html"과 "스냅샷 없음"을 구분해야
   * 하므로 파생이 아니라 **명시 필드**로 싣는다 — 빈 문자열만 보고 판단하면 드레인의 fallback 이
   * 정본 마스터 HTML 을 되살려 운영자가 고른 형식을 무시한다.
   */
  bodyFormat: "html" | "text";
  /** 컴파일 산출물(자산화·정화 완료) — 미리보기·해시·감사 스냅샷용. 텍스트 전용이면 빈 문자열. */
  html: string;
  /**
   * W8-1a: **발송 레인이 실어야 하는 컴파일 입력**(치환 완료, 자산화·정화 이전).
   *
   * 발송은 sendEmail 이 유일한 컴파일러다(chat-ai.ts 가 넘겨받은 body 를 다시 compileMailArtifact
   * 한다). 이미 자산화된 html(`src="cid:flu-asset-…"`)을 실어 보내면 그 재컴파일이 cid 를 다시
   * 추출할 수 없어 매니페스트가 비고, mailAssetParityValid 가 fail-closed 로 발송을 막는다.
   * 그래서 와이어에는 data: 원본을 그대로 넘기고 자산화·레지스트리 등록·인라인 첨부는 기존
   * sendEmail 경로가 수행한다(콜드메일 레인의 compilerInputBody 와 같은 규칙).
   * 이미지가 없는 템플릿은 compileMailArtifact 가 멱등이므로 최종 발송본이 동일하다.
   */
  htmlSource: string;
}>;

const TEMPLATE_COLLECTION = "scp_mail_templates";
const MAX_SUBJECT_BYTES = 400;

export const RECEIPT_TEMPLATE_RULES: Record<
  ScpEditableMailTemplateKind,
  { allowed: readonly string[]; required: readonly string[] }
> = {
  application_confirmed: {
    allowed: [
      "application_id",
      "program_name",
      "portal_link",
      "apply_link",
      "reference_code",
      "supercent_brand",
    ],
    required: ["supercent_brand"],
  },
  application_video_reminder: {
    allowed: [
      "application_id",
      "program_name",
      "portal_link",
      // W72 [리더 확정 URL]: 가이드북 CTA. 리터럴 `[Guidebook Link]` 금지 — 변수로만 참조한다.
      "guidebook_link",
      "reference_code",
      "days_since_apply",
      "supercent_brand",
    ],
    // portal_link 는 **정적 링크 금지**(W48) 때문에 필수다 — 제출 화면으로 보내는 CTA 가 이 자리다.
    required: ["portal_link", "supercent_brand"],
  },
  content_submitted: {
    allowed: [
      "application_id",
      "video_submission_id",
      "video_revision",
      "program_name",
      "portal_link",
      "guide_link",
      "supercent_brand",
    ],
    required: ["portal_link", "guide_link", "supercent_brand"],
  },
  // W7-3b: 허용 변수는 **실제 호출부가 넘기는 값만** 등록한다(코드에서 확인).
  //  uid_guide  — scpUidGuideMailWorker: Portal MATERIAL 의 uidGuideUrl 하나뿐.
  //  video_result_mail — scpOutboxMailWorkers: mailKind(승인/변경요청/반려) 라벨,
  //                      customerMessageCode → 고정 문구 지도 결과, 재제출 링크.
  // 없는 변수를 허용 목록에 올리면 편집기에서 저장은 되지만 발송 때 빈 문자열이 된다.
  uid_guide: {
    allowed: ["uid_guide_link", "program_name", "portal_link", "supercent_brand"],
    required: ["uid_guide_link"],
  },
  video_result_mail: {
    allowed: [
      "video_result_state",
      "video_result_message",
      "correction_link",
      // W120: 제출 참조 블록. 결과만 오는 메일은 크리에이터가 "어느 제출 얘기냐"를 못 맞춘다
      //   (실데이터: 같은 사람이 며칠 새 여러 건 제출). 드레인이 원장에서 읽어 주입한다.
      "video_title",
      "youtube_url",
      "submission_ref",
      "decided_date",
      "prior_rejection_count",
      // W121: 사유 태그 불릿 블록. 발행 템플릿이 사유를 **결과 문구와 다른 자리**에 놓고 싶을 때
      //   쓰는 변수다(코드 마스터는 {{video_result_message}} 하나로 같은 문장을 싣는다).
      //   값은 서버 사전이 만든 문구뿐 — 룰 ID·룰명·퍼센트·모델 원문은 들어가지 않는다.
      "reason_tag_block",
      // W126: 반복 반려 에스컬레이션 한 문장. 값은 서버가 만든 완성 문장이고 변수는 서버가 센
      //   정수 하나뿐이다 — 사유 코드별 반려 횟수가 임계 미만이면 애초에 주입되지 않는다.
      "escalation_notice",
      // 2026-09-05 다타이틀: 이 제출이 어느 게임 타이틀인지. 값은 **프로그램 타이틀 레지스트리**
      //   (functions/programTitles.seed.json → videoReviewRubricTitle)에서만 오고, 드레인·미리보기가
      //   같은 값을 주입한다. 발행 템플릿이 게임명·스토어 링크·해시태그를 직접 쓰고 싶을 때 쓴다 —
      //   본문에 게임명을 리터럴로 적으면 두 번째 타이틀이 붙는 순간 잘못된 게임 메일이 된다.
      "game_title",
      "game_store_link",
      "game_hashtags",
      "program_name",
      "portal_link",
      "supercent_brand",
    ],
    // 승인 문안에는 안내 문구가 없다 — 필수 변수를 두면 승인 fallback 이 렌더에서 죽는다.
    required: [],
  },
  // W120: 승인 전용 override. 승인 문안에는 재제출 링크가 없다 — 허용 목록에서도 뺀다.
  video_result_mail_approved: {
    allowed: [
      "video_result_state",
      "video_result_message",
      "video_title",
      "youtube_url",
      "submission_ref",
      "decided_date",
      "prior_rejection_count",
      // 2026-09-05 다타이틀: 이 제출이 어느 게임 타이틀인지. 값은 **프로그램 타이틀 레지스트리**
      //   (functions/programTitles.seed.json → videoReviewRubricTitle)에서만 오고, 드레인·미리보기가
      //   같은 값을 주입한다. 발행 템플릿이 게임명·스토어 링크·해시태그를 직접 쓰고 싶을 때 쓴다 —
      //   본문에 게임명을 리터럴로 적으면 두 번째 타이틀이 붙는 순간 잘못된 게임 메일이 된다.
      "game_title",
      "game_store_link",
      "game_hashtags",
      "program_name",
      "portal_link",
      "supercent_brand",
    ],
    required: [],
  },
  // W72 합동리뷰 R2-2: 코호트1·3 독려 문안. 링크는 전부 변수다(리터럴 금지).
  scp_nudge_cohort1_read_no_reply_en: {
    allowed: ["apply_link", "homepage_link", "program_name", "supercent_brand"],
    required: ["apply_link"],
  },
  // W72 교정 [헤세 지적 2026-08-13]: 코호트2 문안은 **제출 폼**으로 보내야 한다.
  //   종전에는 `portal_link`(포털 홈)를 CTA 로 썼는데 실측 결과 그 URL 에는 폼이 없다
  //   (input[type=file] 0 · form 0). 원문서는 "How to submit: [Content Submission Form Link]" 다.
  //   그래서 제출 전용 변수를 신설한다 — `portal_link` 는 홈 링크로 남는다(의미가 다르다).
  scp_nudge_cohort2_applied_no_video_en: {
    allowed: ["submit_link", "guidebook_link", "application_id", "program_name", "supercent_brand"],
    required: ["submit_link"],
  },
  scp_nudge_cohort3_unread_no_reply_en: {
    allowed: ["apply_link", "program_name", "supercent_brand"],
    required: ["apply_link"],
  },
  // W91: 링크는 값으로만 들어간다 — 템플릿 본문에 URL 을 적어 넣을 수 없다(uid_guide 와 같은 규칙).
  login_approved: {
    allowed: ["loginUrl", "supercent_brand"],
    required: ["loginUrl"],
  },
  // 반려 안내 2종 — 카피에 수신자별 값이 없다(링크·이름 없음). 운영 기본값 두 개만 허용하고
  // 필수 변수는 두지 않는다(필수를 두면 변수 없는 확정 카피의 fallback 렌더가 죽는다 —
  // video_result_mail 의 required:[] 와 같은 이유).
  login_rejected_subscriber_minimum: {
    allowed: ["program_name", "supercent_brand"],
    required: [],
  },
  login_rejected_channel_not_found: {
    allowed: ["program_name", "supercent_brand"],
    required: [],
  },
  login_rejected_public_reason: {
    allowed: ["program_name", "supercent_brand", "public_reason_text"],
    required: ["public_reason_text"],
  },
  // Task-100 F-6.
  resubmission_nudge_en: {
    allowed: ["reason_message", "deadline", "portal_link", "program_name", "supercent_brand"],
    required: ["reason_message", "deadline", "portal_link"],
  },
};

const SCP_CREATOR_PORTAL_LINK = "https://creator.supercent.io";
const SCP_CREATOR_APPLY_LINK = `${SCP_CREATOR_PORTAL_LINK}/?locale=en`;

export const RECEIPT_TEMPLATE_PRODUCTION_DEFAULT_VALUES: Record<string, string> = {
  program_name: "Super Creator Partners",
  portal_link: SCP_CREATOR_PORTAL_LINK,
  apply_link: SCP_CREATOR_APPLY_LINK,
  guide_link:
    "https://creator.supercent.io/?locale=en&view=guide&track=fixed-cpm#guide-overview",
  supercent_brand: "Super Creator Partners",
};

/**
 * 결과 메일의 게임 타이틀 변수 3종. 드레인·미리보기가 **같은 함수로** 만들어 넣어야
 * WYSIWYG 이 성립한다(W120/W121 규율 그대로). 입력은 검수 루브릭이 해석한 타이틀이고,
 * 값이 없으면 빈 문자열이라 렌더러가 조용히 지운다 — 잘못된 게임명을 넣는 것보다 낫다.
 */
export function videoResultMailTitleValues(title: {
  readonly name?: string;
  readonly storeUrl?: string;
  readonly requiredHashtags?: readonly string[];
} | null | undefined): Record<string, string> {
  return {
    game_title: asString(title?.name).trim(),
    game_store_link: asString(title?.storeUrl).trim(),
    game_hashtags: (title?.requiredHashtags ?? [])
      .map((tag) => asString(tag).trim())
      .filter(Boolean)
      .join(" "),
  };
}

/** 편집기 미리보기의 게임 값 — 프로그램 기본 타이틀(레지스트리 시드). */
function previewProgramTitleValues(): Record<string, string> {
  const registry = resolveProgramTitles(canonicalScpProgramId);
  const title = defaultProgramTitle(registry);
  return videoResultMailTitleValues(title
    ? { name: title.name, storeUrl: title.storeUrl, requiredHashtags: requiredHashtagsForTitle(registry, title) }
    : null);
}

export const RECEIPT_TEMPLATE_PREVIEW_VALUES: Record<string, string> = {
  ...RECEIPT_TEMPLATE_PRODUCTION_DEFAULT_VALUES,
  ...previewProgramTitleValues(),
  application_id: "app_sample_001",
  video_submission_id: "vsub_sample_001",
  video_revision: "1",
  reference_code: "SCP-2026-0001",
  uid_guide_link: "https://portal.example.test/uid-guide/sample",
  video_result_state: "Changes requested",
  video_result_message: "campaign content guidelines",
  correction_link: "https://portal.example.test/resubmit/sample",
  video_title: "My casual puzzle gameplay highlight",
  youtube_url: "https://www.youtube.com/watch?v=sample00001",
  submission_ref: "vsub_sample_001 - rev 2",
  decided_date: "2026-08-24",
  prior_rejection_count: "1",
  loginUrl: "https://portal.example.test/login/sample",
  public_reason_text: "After reviewing your application, we are unable to approve your login request at this time.",
};

/** W62-2: 재촉 제목. 훅 한 줄 — 열지 않아도 무슨 말인지 알게 한다. */
/**
 * W62c-C2: 재촉 텍스트 파트. 드레인이 렌더 스냅샷 없이도 같은 문안을 쓰도록 **상수로 승격**한다 —
 * 드레인에 문안을 다시 적으면 템플릿과 갈리고, 그때 텍스트 클라이언트만 옛 문안을 받는다.
 */
export const SCP_APPLICATION_VIDEO_REMINDER_FALLBACK_TEXT = [
  "Your spot is still open.",
  "",
  "You applied to Super Creator Partners, but we have not received your video yet.",
  "One upload is all that stands between you and your first payout.",
  "",
  "- Paid per view - earnings scale with how your video performs.",
  "- Your content, your style - no scripts, no approval queue before you post.",
  "- Takes minutes - submit the link to a video you already made.",
  "",
  "Submit your video: {{portal_link}}",
  "",
  "Application {{application_id}}. Questions? Contact scp@supercent.io",
].join("\n");

export const SCP_APPLICATION_VIDEO_REMINDER_SUBJECT =
  "[SCP] Your spot is still open — submit your video";

const FALLBACKS: Record<ScpReceiptMailTemplateKind, RenderedScpReceiptMailTemplate> = {
  application_confirmed: {
    kind: "application_confirmed",
    source: "fallback",
    revision: 0,
    hash: sha256(
      `${SCP_APPLICATION_CONFIRMED_SUBJECT}\n${SCP_APPLICATION_CONFIRMED_EMAIL_EN_HTML}`,
    ),
    bodyFormat: "html",
    subject: SCP_APPLICATION_CONFIRMED_SUBJECT,
    text: [
      "Hello from Super Creator Partners,",
      "",
      "Your application is confirmed. You can start creating and submit your content through the SCP Creator Portal.",
      "",
      "We're excited to create with you.",
    ].join("\n"),
    html: SCP_APPLICATION_CONFIRMED_EMAIL_EN_HTML,
    htmlSource: SCP_APPLICATION_CONFIRMED_EMAIL_EN_HTML,
  },
  application_video_reminder: {
    kind: "application_video_reminder",
    source: "fallback",
    revision: 0,
    hash: sha256(
      `${SCP_APPLICATION_VIDEO_REMINDER_SUBJECT}\n${SCP_APPLICATION_VIDEO_REMINDER_EN_HTML}`,
    ),
    bodyFormat: "html",
    subject: SCP_APPLICATION_VIDEO_REMINDER_SUBJECT,
    // 텍스트 파트도 **같은 구조**로 둔다(훅 → 불릿 → CTA). HTML 만 구조화하고 텍스트를 산문으로
    // 남기면 텍스트 전용 클라이언트에서 종전 문제가 그대로 재현된다.
    text: SCP_APPLICATION_VIDEO_REMINDER_FALLBACK_TEXT,
    html: SCP_APPLICATION_VIDEO_REMINDER_EN_HTML,
    htmlSource: SCP_APPLICATION_VIDEO_REMINDER_EN_HTML,
  },
  content_submitted: {
    kind: "content_submitted",
    source: "fallback",
    revision: 0,
    hash: sha256(
      `${SCP_CONTENT_SUBMITTED_RECEIPT_SUBJECT}\n${SCP_CONTENT_SUBMITTED_RECEIPT_TEXT}\n${CONTENT_SUBMITTED_EMAIL_EN_HTML}`,
    ),
    bodyFormat: "html",
    subject: SCP_CONTENT_SUBMITTED_RECEIPT_SUBJECT,
    text: SCP_CONTENT_SUBMITTED_RECEIPT_TEXT,
    html: CONTENT_SUBMITTED_EMAIL_EN_HTML,
    htmlSource: CONTENT_SUBMITTED_EMAIL_EN_HTML,
  },
};

function staticHrefValues(source: string): string[] {
  return [...source.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => (match[1] ?? "").replace(/&amp;/g, "&").trim())
    .filter(Boolean);
}

function hasCanonicalApplicationConfirmedStaticCta(source: string): boolean {
  return staticHrefValues(source).some((href) => {
    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      return false;
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "creator.supercent.io") return false;
    if (parsed.username || parsed.password || parsed.port) return false;
    return parsed.pathname === "/submit-content" || parsed.pathname === "/apply" || parsed.pathname === "/";
  });
}

function normalizedTemplateString(value: string): string {
  return value.trim();
}

function isExactApplicationConfirmedCodeFallback(input: {
  kind: ScpEditableMailTemplateKind;
  subject: string;
  html: string;
  text: string;
}): boolean {
  return input.kind === "application_confirmed" &&
    normalizedTemplateString(input.subject) === normalizedTemplateString(FALLBACKS.application_confirmed.subject) &&
    normalizedTemplateString(input.html) === normalizedTemplateString(FALLBACKS.application_confirmed.html) &&
    normalizedTemplateString(input.text) === normalizedTemplateString(FALLBACKS.application_confirmed.text);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPE[character] ?? character);
}

function templateBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function isScpReceiptMailTemplateKind(
  value: unknown,
): value is ScpReceiptMailTemplateKind {
  return value === "application_confirmed"
    || value === "content_submitted"
    || value === "application_video_reminder";
}

/** 발송 경로가 오버라이드만 읽는 kind(문서 없으면 코드 렌더러 fallback). */
export function isScpMailTemplateOverrideKind(
  value: unknown,
): value is ScpMailTemplateOverrideKind {
  return value === "uid_guide"
    || value === "video_result_mail"
    || value === "video_result_mail_approved"
    || value === "scp_nudge_cohort1_read_no_reply_en"
    || value === "scp_nudge_cohort2_applied_no_video_en"
    || value === "scp_nudge_cohort3_unread_no_reply_en"
    || value === "login_approved"
    || value === "login_rejected_subscriber_minimum"
    || value === "login_rejected_channel_not_found"
    || value === "login_rejected_public_reason"
    || value === "resubmission_nudge_en";
}

/**
 * W72 합동리뷰 R3-1: **독려 draft 로도 쓰이는 kind.**
 *
 * 이 두 kind 는 편집기(검수 > 메일 템플릿)가 다루는 editable kind 이면서, 동시에
 * `prepareScpResultMail` 의 result-mail 렌더러를 타야 한다(코호트1·3 draft 경로).
 * `readTemplate` 이 editable 전체를 막고 있어서 R2-2 수리가 "오문안"을 **draft 0건**으로 바꿨다 —
 * 그 예외 지점을 이름으로 못 박는다. 기존 영수증 4종은 그대로 거부된다.
 *
 * W72F-R1 P0 — **회차 파생 kind 를 정식 인정한다.**
 *   18종 발행기는 2회차부터 `<base>_w2` … `_w10` suffix 키를 만든다. 그런데 레지스트리가
 *   base 3키만 알아서 후속 회차가 normalizeKind 에서 **qualification_pass 로 오해**돼
 *   엉뚱한 문안이 나가고, archive 요청도 qualification_pass 를 archive 하는 우회가 됐다
 *   (원 문안은 active 로 남는다). R3-1 의 "등록 안 된 키" 계열 재발이다.
 *   회차 파생을 **접두 규칙으로 정본화**해 활성화 검사·렌더·archive 세 소비자가
 *   이 함수 하나를 쓰게 한다.
 */
const NUDGE_DRAFT_BASE_KINDS = [
  "scp_nudge_cohort1_read_no_reply_en",
  "scp_nudge_cohort2_applied_no_video_en",
  "scp_nudge_cohort3_unread_no_reply_en",
] as const;

/**
 * 0.6.110: 프로그램 전용 문안 키 — `scp_nudge_<slug>_cohortN_..._en[_wN]`. `<slug>` 는 프로그램 구분자
 * (예: `snake`)이고, 코호트 꼬리(`cohortN_..._en`)가 base kind(변수 계약)를 결정한다.
 * 슬러그 문자는 소문자·숫자뿐이다(`_` 를 못 넣게 해 `cohort` 꼬리와의 경계가 모호해지지 않게 한다).
 */
const NUDGE_PROGRAM_KEY_PATTERN = /^scp_nudge_([a-z0-9]{2,24})_(cohort[123]_[a-z_]+_en)(?:_w([0-9]+))?$/;

function nudgeProgramKeyParts(value: string): { base: (typeof NUDGE_DRAFT_BASE_KINDS)[number]; wave: number } | null {
  const match = NUDGE_PROGRAM_KEY_PATTERN.exec(value);
  if (!match) return null;
  const base = NUDGE_DRAFT_BASE_KINDS.find((candidate) => candidate === `scp_nudge_${match[2]}`);
  if (!base) return null;
  const wave = match[3] === undefined ? 1 : Number(match[3]);
  // 1회차는 접미사 없는 키다(`_w1` 은 만들지 않는다) — 기존 키와 같은 규칙.
  if (match[3] !== undefined && wave < 2) return null;
  return { base, wave };
}

/** 프로그램 전용 문안 키(`scp_nudge_<slug>_cohortN_..._en[_wN]`)의 base kind. 아니면 빈 문자열. */
export function nudgeProgramMailTemplateBaseKind(value: unknown): ScpMailTemplateOverrideKind | "" {
  if (typeof value !== "string") return "";
  const program = nudgeProgramKeyParts(value);
  return program ? (program.base as ScpMailTemplateOverrideKind) : "";
}

/** `<base>` 또는 `<base>_w<2..N>`, 또는 프로그램 전용 `scp_nudge_<slug>_cohortN_..._en[_wN]`. */
export function isNudgeDraftMailTemplateKind(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  for (const base of NUDGE_DRAFT_BASE_KINDS) {
    if (value === base) return true;
    const suffix = value.startsWith(`${base}_w`) ? value.slice(base.length + 2) : "";
    if (suffix && /^[0-9]+$/.test(suffix) && Number(suffix) >= 2) return true;
  }
  return nudgeProgramKeyParts(value) !== null;
}

/** 회차 파생 kind 의 base 를 돌려준다(변수 계약 조회가 base 기준이라 필요하다). */
export function nudgeDraftMailTemplateBaseKind(value: unknown): ScpMailTemplateOverrideKind | "" {
  if (typeof value !== "string") return "";
  for (const base of NUDGE_DRAFT_BASE_KINDS) {
    if (value === base || value.startsWith(`${base}_w`)) return base as ScpMailTemplateOverrideKind;
  }
  const program = nudgeProgramKeyParts(value);
  return program ? (program.base as ScpMailTemplateOverrideKind) : "";
}

/** 편집기가 HTML+텍스트로 다루는 kind 전체(영수증 2종 + 오버라이드 2종 + 독려 문안 2종). */
export function isScpEditableMailTemplateKind(
  value: unknown,
): value is ScpEditableMailTemplateKind {
  // W72F-R1 P0: 회차 파생 kind(`_w2`..)도 editable 로 인정한다.
  //   이 함수가 normalizeKind·렌더·archive 세 소비자의 공통 관문이라,
  //   여기서 인정해야 후속 회차가 qualification_pass 로 오해되지 않는다.
  return isScpReceiptMailTemplateKind(value)
    || isScpMailTemplateOverrideKind(value)
    || isNudgeDraftMailTemplateKind(value);
}

/**
 * W72 합동리뷰 R4-2: **플레이스홀더 문법의 정본.**
 *
 * 검증기는 `{{ apply_link }}`(내부 공백)를 정상 변수로 인정했는데 렌더러는 `\{\{(\w+)\}\}` 만
 * 치환해서, 그 토큰이 **검증 통과 + 미치환**으로 draft 까지 갔다(fail-closed 파괴).
 * 과거 리터럴 발송 사고(f5f3e7a 계열)와 같은 계열이다.
 * 두 곳이 같은 정규식을 쓰도록 여기 하나로 모은다 — 복사하면 또 갈린다.
 */
export const SCP_MAIL_PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** 렌더 후에도 남은 `{{...}}` 는 **무조건** 실패다(모양이 무엇이든 수신자에게 보인다). */
export const SCP_MAIL_RESIDUAL_PLACEHOLDER_PATTERN = /\{\{[^{}]*\}\}/g;

function placeholders(source: string): string[] {
  return [...new Set(
    [...source.matchAll(new RegExp(SCP_MAIL_PLACEHOLDER_PATTERN.source, "g"))]
      .map((match) => match[1] ?? "")
      .filter(Boolean),
  )].sort();
}

function malformedPlaceholders(source: string): string[] {
  return [...source.matchAll(/\{\{([^{}]*)\}\}/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((name) => !/^[a-zA-Z0-9_]+$/.test(name));
}

/**
 * W72 [R1 P1-6]: **리터럴 링크 플레이스홀더** 검출.
 *
 * 검증기가 `{{...}}` 만 봐서, 원문 MD 의 `[Apply Link]` 같은 대괄호 토큰이 그대로 든 템플릿이
 * "유효"로 저장되고 발송까지 나갔다(f5f3e7a 계열 전례와 같은 사고다). 신규 소스 3종은 깨끗하지만
 * **운영자가 패널에서 작성하는 회차 템플릿 경로가 열려 있었다.**
 *
 * ⚠️ 오탐이 치명적이다. 이 판정이 참이면 저장 검증이 실패하고, 발송 경로는 렌더 실패 시
 * **미치환 폴백 표**를 그대로 내보낸다 — 오탐 하나가 `{{portal_link}}` 리터럴 발송을 만든다.
 * 실제로 라이브 제목 `[SCP] Your spot is still open…` 의 `[SCP]` 를 넓은 규칙이 잡아 그 사고를
 * 재현했다(에뮬레이터 행위 테스트가 검출). 그래서 **링크 자리표시자 형태만** 좁게 잡는다:
 *   · 마지막 낱말이 `Link`/`URL`  (`[Apply Link]` · `[Content Submission Form Link]` · `[Guidebook Link]`)
 *   · 또는 내용이 `homepage`      (`[homepage]`)
 * 브랜드 태그(`[SCP]` · `[Super Creator Partners]`)와 마크다운 링크·각주는 잡지 않는다.
 */
export function literalPlaceholderTokens(source: string): string[] {
  return [...new Set(
    [...source.matchAll(/\[([^\][\n]{2,60})\]/g)]
      .filter((match) => {
        const after = source.slice((match.index ?? 0) + match[0].length);
        if (after.startsWith("(")) return false; // 마크다운 링크
        const inner = (match[1] ?? "").trim();
        if (!inner || /^\d+$/.test(inner)) return false; // 각주
        return /(^|\s)(link|url)$/i.test(inner) || /^homepage$/i.test(inner);
      })
      .map((match) => `[${(match[1] ?? "").trim()}]`),
  )].sort();
}

export function validateScpReceiptMailTemplate(input: {
  kind: ScpEditableMailTemplateKind;
  subject: string;
  html: string;
  text: string;
}): {
  valid: boolean;
  variables: string[];
  unknownVariables: string[];
  missingRequiredVariables: string[];
  malformedVariables: string[];
  /** W72 [R1 P1-6]: `[Apply Link]` 류 리터럴 자리표시자. 있으면 유효하지 않다. */
  literalPlaceholders: string[];
} {
  const source = `${input.subject}\n${input.html}\n${input.text}`;
  const variables = placeholders(source);
  // W72F-R1 P0: 회차 파생 kind 는 base 의 변수 계약을 그대로 쓴다.
  const baseKind = nudgeDraftMailTemplateBaseKind(input.kind) || input.kind;
  const rules = RECEIPT_TEMPLATE_RULES[baseKind];
  const malformedVariables = malformedPlaceholders(source);
  const unknownVariables = variables.filter(
    (name) => !rules.allowed.includes(name),
  );
  const isApplicationConfirmedCodeFallback = isExactApplicationConfirmedCodeFallback({
    kind: baseKind,
    subject: input.subject,
    html: input.html,
    text: input.text,
  });
  const missingRequiredVariables = isApplicationConfirmedCodeFallback
    ? []
    : rules.required.filter((name) => !variables.includes(name));
  const hasApplicationConfirmedCta = variables.includes("portal_link") ||
    variables.includes("apply_link") ||
    hasCanonicalApplicationConfirmedStaticCta(`${input.html}
${input.text}`);
  if (baseKind === "application_confirmed" &&
    !isApplicationConfirmedCodeFallback &&
    !hasApplicationConfirmedCta) {
    missingRequiredVariables.push("portal_link_or_apply_link");
  }
  const literals = literalPlaceholderTokens(source);
  return {
    valid:
      unknownVariables.length === 0 &&
      missingRequiredVariables.length === 0 &&
      malformedVariables.length === 0 &&
      literals.length === 0,
    variables,
    unknownVariables,
    missingRequiredVariables,
    malformedVariables,
    literalPlaceholders: literals,
  };
}

/**
 * W8-1a: 사용자가 브랜디드 마스터 HTML(base64 로고 포함)을 붙여넣으면 여기서 `data:` 무조건
 * 거부에 걸려 dryRun·저장이 전부 400 이었다(운영 Cloud Run 실측). 콜드메일 레인은 같은 본문을
 * 이미 공식 자산화(extractInlineImageAssets → `cid:flu-asset-<sha256>`)로 통과시키므로, 판정을
 * 새로 만들지 않고 **같은 추출기의 잔여 HTML** 을 검사한다.
 *
 * 즉 `<img src="data:image/png;base64,…">` 는 자산화가 흡수하고, 그 밖의 data:(href·비이미지·
 * 허용 밖 MIME·깨진 base64)는 추출기가 던지거나 아래 규칙에 그대로 걸린다. javascript:·vbscript:·
 * protocol-relative(`//`)·이벤트 핸들러·금지 요소 판정은 하나도 완화하지 않았다.
 */
function rejectUnsafeHtml(source: string): void {
  let residual: string;
  try {
    residual = extractInlineImageAssets(source).html;
  } catch (error) {
    throw invalid(
      asString(asRecord(error).message) || "receipt mail template contains an unsupported inline image",
      "mail_template_image_rejected",
    );
  }
  if (/<(?:script|form|iframe|object|embed|template|math)\b/i.test(residual)) {
    throw invalid("receipt mail template contains a forbidden HTML element", "mail_template_unsafe_html");
  }
  if (/\son[a-z]+\s*=/i.test(residual)) {
    throw invalid("receipt mail template contains an event handler", "mail_template_unsafe_html");
  }
  if (/\b(?:href|src)\s*=\s*["']?\s*(?:javascript:|data:|vbscript:|\/\/)/i.test(residual)) {
    throw invalid("receipt mail template contains an unsafe URL", "mail_template_unsafe_html");
  }
}

/**
 * W8-1b: 콜러블 경계(callableErrorBoundary.toHttpsError)는 메시지를 일반 문구로 바꾸고
 * `details.errorCode` 만 통과시킨다 — 사유를 화면에 보여주려면 **구조화 코드**가 필요하다.
 * 코드는 CALLABLE_DETAIL_ERROR_CODES 에 등록되고 사용자 문구는
 * src/lib/live.tsx PUBLIC_BUSINESS_ERROR_MESSAGES 가 갖는다(3자 정합을 테스트로 고정).
 */
function invalid(message: string, errorCode?: string): Error {
  return Object.assign(new Error(message), {
    code: "invalid-argument", errorCode: "invalid_unauthorized",
    ...(errorCode ? { errorCode } : {}),
  });
}

function replaceReceiptHtmlPlaceholders(
  source: string,
  values: Record<string, string>,
): string {
  return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) =>
    escapeHtml(values[key] ?? ""),
  );
}

function receiptRenderValues(
  values: Record<string, unknown> = {},
): Record<string, string> {
  return {
    ...RECEIPT_TEMPLATE_PRODUCTION_DEFAULT_VALUES,
    ...Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        asString(value),
      ]),
    ),
  };
}

export function renderScpReceiptMailTemplate(input: {
  kind: ScpEditableMailTemplateKind;
  subject: string;
  html: string;
  text: string;
  /**
   * W72-HOTFIX: 저장된 본문 형식. 종전에는 이 값을 **읽지 않고** `html` 유무로만 판정해서,
   *   마크다운으로 발행한 문안(html 없음)이 평문으로 나갔다 — 수신자에게 `[Apply now](url)` 가
   *   리터럴로 보인다. 마크다운이면 컴파일러로 HTML 을 만들어 앵커를 살린다.
   *   생략하면 종전 판정(html 유무)을 그대로 쓴다 — 기존 호출부 동작 불변.
   */
  bodyFormat?: string;
  values?: Record<string, unknown>;
  revision?: number;
  hash?: string;
  source?: "published" | "fallback";
}): RenderedScpReceiptMailTemplate {
  const subject = asString(input.subject).trim();
  const html = asString(input.html);
  const text = asString(input.text);
  if (!subject) throw invalid("receipt mail subject is required", "mail_template_field_required");
  // W8-3: HTML 은 **선택**이다. 어댑터는 html 부재 시 텍스트 전용 발송을 이미 지원하는데
  // (OutboundMailMessage.html optional · "Absent => plain-text send") 저장 검증만 이 자리에서 막고
  // 있었다. 완화는 이 한 방향뿐 — 텍스트 본문은 계속 필수다(빈 메일 발송 금지).
  if (!text) throw invalid("receipt mail plain text is required", "mail_template_field_required");
  if (templateBytes(subject) > MAX_SUBJECT_BYTES) {
    throw invalid("receipt mail subject is too large", "mail_template_subject_too_large");
  }
  const validation = validateScpReceiptMailTemplate({
    kind: input.kind,
    subject,
    html,
    text,
  });
  if (!validation.valid) {
    throw invalid(
      `receipt mail template variables invalid: ${[
        ...validation.unknownVariables.map((name) => `unknown:${name}`),
        ...validation.missingRequiredVariables.map((name) => `missing:${name}`),
        ...validation.malformedVariables.map((name) => `malformed:${name}`),
        // W72 [R1 P1-6]: 리터럴 자리표시자는 "치환되지 않은 링크"라 수신자에게 그대로 보인다.
        ...validation.literalPlaceholders.map((token) => `literal:${token}`),
      ].join(", ")}`,
      "mail_template_variables_invalid",
    );
  }
  const values = receiptRenderValues(input.values);
  // W72-HOTFIX: 마크다운 문안은 authored HTML 이 없다. 종전 판정(`html ? "html" : "text"`)은
  //   그걸 평문으로 떨어뜨려 `[Apply now](url)` 가 리터럴로 나갔다.
  //   컴파일러는 이미 markdown 을 1급으로 지원하므로(mailCompiler: markdown|text|html),
  //   여기서 본문을 HTML 로 컴파일해 앵커를 살린다. 텍스트 표현은 종전대로 함께 만든다
  //   (수신 클라이언트가 평문을 고르면 그쪽이 쓰인다).
  const storedBodyFormat = asString(input.bodyFormat).trim().toLowerCase();
  const markdownBody = !html && storedBodyFormat === "markdown";
  const bodyFormat: "html" | "text" = html || markdownBody ? "html" : "text";
  const renderedSubject = resolveMailSubject(subject, values);
  // W120 [적대 리뷰 H1]: 위험 마크업 판정은 **작성된 템플릿 원본**에만 적용한다.
  //   주입값은 replaceReceiptHtmlPlaceholders 가 escapeHtml 로 태그가 될 수 없게 만드는데,
  //   치환 **후** 문자열을 검사하면 평범한 운영자 문장이 규칙에 걸린다 — 실증:
  //   "Level 5 only = impossible" 의 ` only =` 가 이벤트 핸들러 패턴(`\son[a-z]+\s*=`)에 매치돼
  //   render 가 throw → resolveScpMailTemplateOverride 의 텍스트 전용 폴백으로 떨어지면서
  //   **HTML 파트가 통째로 버려졌다**(발송은 되지만 브랜디드 본문이 사라진다).
  //   URL 값(correction_link 등)의 스킴 방어는 그대로다: 값은 escapeHtml 로 속성 밖으로 못 나가고,
  //   compileMailArtifact 의 sanitizeUrlAttributes 가 javascript:/data: href 를 계속 떨어뜨린다.
  if (html) rejectUnsafeHtml(html);
  const renderedHtmlSource = html ? replaceReceiptHtmlPlaceholders(html, values) : "";
  const htmlArtifact = renderedHtmlSource
    ? compileMailArtifact({
      body: renderedHtmlSource,
      bodyFormat: "html",
      values: {},
      templateRevision: String(input.revision ?? 0),
    })
    : markdownBody
      ? compileMailArtifact({
        // 마크다운 원문에 자리표시자가 그대로 있다 — 컴파일러가 values 로 치환한다
        //   (텍스트 아티팩트와 **같은 입력·같은 치환**이라 두 표현이 갈리지 않는다).
        body: text,
        bodyFormat: "markdown",
        values,
        templateRevision: String(input.revision ?? 0),
      })
      : null;
  const textArtifact = compileMailArtifact({
    body: text,
    bodyFormat: "text",
    values,
    templateRevision: String(input.revision ?? 0),
  });
  const renderedText = textArtifact.text;
  if (!renderedSubject || !renderedText || (bodyFormat === "html" && !htmlArtifact?.compiledHtml)) {
    throw invalid("receipt mail rendered output is empty", "mail_template_field_required");
  }
  return {
    kind: input.kind,
    source: input.source ?? "published",
    revision: Math.max(0, Math.trunc(Number(input.revision ?? 0))),
    // W72-HOTFIX: 저장 형식을 해시에 넣는다 — markdown↔text 전환은 authored 필드가 하나도
    //   안 바뀌어도 **실제 산출물이 달라지는** 변경이라, 빠뜨리면 캐시가 옛 표현을 계속 낸다.
    hash:
      input.hash ||
      sha256(`${subject}\n${html}\n${text}\n${storedBodyFormat}\n${htmlArtifact?.compiledHash ?? "text-only"}\n${textArtifact.textHash}`),
    bodyFormat,
    subject: renderedSubject,
    text: renderedText,
    html: htmlArtifact?.compiledHtml ?? "",
    htmlSource: renderedHtmlSource,
  };
}

/**
 * W72 [R2-1]: **코드 폴백만** 렌더한다(Firestore 문서를 읽지 않는다).
 *
 * 기본 1회차 키(`application_video_reminder`)는 종전에 legacy resolver 를 탔고, 그 경로는
 * `archived` 만 거부해서 `draft`·빈 status 문서의 **본문이 그대로 발송**될 수 있었다
 * (P1-5③ 수리가 사용자 정의 키에만 적용된 상태였다).
 *
 * 이제 기본 키도 active-only resolver 를 먼저 태우고, 쓸 수 있는 active 문서가 없을 때만
 * 이 함수로 내려온다. 즉 **비활성 문서의 본문은 어떤 경로로도 발송되지 않는다.**
 * 폴백 본문은 생성물에서 온 검수된 정본이고(리터럴·변수 테스트로 고정) 라이브 레인을 살려 둔다.
 */
export function renderScpReceiptMailFallbackTemplate(
  kind: ScpReceiptMailTemplateKind,
  values: Record<string, unknown> = {},
): RenderedScpReceiptMailTemplate {
  const fallback = FALLBACKS[kind];
  try {
    return renderScpReceiptMailTemplate({
      kind,
      subject: fallback.subject,
      html: fallback.html,
      text: fallback.text,
      values,
      revision: 0,
      source: "fallback",
    });
  } catch {
    return fallback;
  }
}

/**
 * W72 [리더 승인 · 회차별 문안]: 매핑된 템플릿 키로 발행 문서를 읽는다.
 *
 * `resolveScpReceiptMailTemplate` 과 결정적으로 다른 점은 **폴백이 없다는 것**이다.
 * 문서가 없거나 archived 면 `null` 을 돌려주고 호출부는 **보내지 않는다**.
 * 회차별 문안에서 폴백은 "3회차인데 1회차 문안이 나가는" 조용한 오발송이 되므로 금지다
 * (리더 확정: 미설정 회차는 임의 폴백 발송 금지).
 *
 * 변수 규칙(`RECEIPT_TEMPLATE_RULES`)과 렌더러는 기존 레인과 **정확히 같은 것**을 쓴다 —
 * 그래서 플레이스홀더 미치환·미허용 변수는 여기서도 똑같이 걸린다.
 */
export async function resolveNudgeSequenceTemplateByKey(
  templateKey: string,
  // 2026-08-29: `ScpReceiptMailTemplateKind`(영수증 3종) 로 좁혀져 있었는데, 이 함수의 유일한
  //   용도인 **독려 회차 문안**의 base kind 는 그 유니온에 없다. 그래서 호출부가 어쩔 수 없이
  //   `"application_video_reminder"` 를 하드코딩했고, 변수 계약이 엉뚱한 kind 로 검증돼 렌더가
  //   전량 던졌다. 아래 renderScpReceiptMailTemplate 는 이미 넓은 타입을 받고
  //   RECEIPT_TEMPLATE_RULES 도 그 타입으로 키잉돼 있다 — 타입만 실제 계약에 맞춘다.
  kind: ScpEditableMailTemplateKind,
  values: Record<string, unknown> = {},
): Promise<RenderedScpReceiptMailTemplate | null> {
  const key = templateKey.trim();
  // W72 [R1 P1-5①]: 키에 `/` 가 있으면 `doc("foo/bar")` 가 예외를 던지고, 그 예외가 try 밖이라
  //   **워커 루프 전체가 죽는다**(클레임한 행이 sending 으로 잠긴 채 반복된다). 문서 ID 문자셋을 강제한다.
  if (!/^[A-Za-z0-9_.:@-]{1,200}$/.test(key) || key === "." || key === "..") return null;
  const snapshot = await adminDb.collection(TEMPLATE_COLLECTION).doc(key).get();
  const data = asRecord(snapshot.data());
  // W72 [R1 P1-5③]: **`active` 명시 검사.** 종전에는 `archived` 만 배제해서 `status:"draft"`·빈 status·
  //   오타 status 가 전부 발행 취급됐다 — 코호트2 는 라이브 레인이라 그대로 실발송된다.
  //   프로드 `scp_mail_templates` 4건이 전부 `status:"active"` 임을 실측하고 좁혔다.
  //   ⚠️ 이 함수는 **W72 회차 매핑 전용**이다. 기존 레인의 `resolveScpReceiptMailTemplate` 은
  //      건드리지 않았다(기존 동작 불변).
  if (!snapshot.exists || asString(data.status) !== "active") return null;
  try {
    return renderScpReceiptMailTemplate({
      kind,
      subject: asString(data.subject),
      html: asString(data.html),
      text: asString(data.text || data.plainText || data.body),
      // W72-HOTFIX: 저장된 형식을 렌더러에 넘긴다. 안 넘기면 markdown 문안이 평문으로 나가
      //   수신자에게 `[Apply now](url)` 가 리터럴로 보인다.
      bodyFormat: asString(data.bodyFormat),
      values,
      revision: Math.max(1, Math.trunc(Number(data.version ?? 1))),
      hash: asString(data.contentHash),
      source: "published",
    });
  } catch {
    // 발행 문서가 렌더에 실패하면(변수 규칙 위반 등) **보내지 않는다**. 폴백으로 내려가면
    // 편집기 실수가 잘못된 회차 문안 발송이 된다.
    return null;
  }
}

export async function resolveScpReceiptMailTemplate(
  kind: ScpReceiptMailTemplateKind,
  values: Record<string, unknown> = {},
): Promise<RenderedScpReceiptMailTemplate> {
  const snapshot = await adminDb.collection(TEMPLATE_COLLECTION).doc(kind).get();
  const data = asRecord(snapshot.data());
  if (!snapshot.exists || asString(data.status) === "archived") {
    // W62d-minor [변수표 정합]: fallback 도 **같은 렌더러로** 통과시킨다.
    //   종전에는 표를 그대로 돌려줘서 fallback 본문의 `{{...}}` 가 치환되지 않았다.
    //   기존 두 kind 의 fallback 에는 변수가 없어서 드러나지 않았을 뿐이고, 재촉(W62-2)은
    //   `{{portal_link}}`·`{{application_id}}` 를 쓴다 — 발행 문서가 없는 상태(새 kind 의 기본값)에서
    //   그대로 두면 **수신자가 리터럴 `{{portal_link}}` 를 받는다.**
    //   아래 오버라이드 레인(resolveScpMailTemplateOverride)은 이미 fallback 을 렌더러로 통과시킨다 —
    //   두 레인의 형상을 맞추는 것이기도 하다.
    //   렌더가 실패하면(변수 규칙 위반 등) 표 원본으로 떨어진다 — 발송 자체를 막지는 않는다.
    const fallback = FALLBACKS[kind];
    try {
      return renderScpReceiptMailTemplate({
        kind,
        subject: fallback.subject,
        html: fallback.html,
        text: fallback.text,
        values,
        revision: 0,
        source: "fallback",
      });
    } catch {
      return fallback;
    }
  }
  const revision = Math.max(1, Math.trunc(Number(data.version ?? 1)));
  const hash = asString(data.contentHash);
  return renderScpReceiptMailTemplate({
    kind,
    subject: asString(data.subject),
    html: asString(data.html),
    text: asString(data.text || data.plainText || data.body),
    // W72-HOTFIX: 이 경로도 저장 형식을 넘긴다 — 세 렌더 호출부의 판정이 갈리면
    //   같은 문안이 레인마다 다른 표현으로 나간다.
    bodyFormat: asString(data.bodyFormat),
    values,
    revision,
    hash,
    source: "published",
  });
}

/**
 * W7-3c: 오버라이드 레인(uid_guide · video_result_mail)의 정본 해석기.
 *
 * 확인 메일 레인(resolveScpReceiptMailTemplate)과 **같은 패턴**이지만 fallback 표가 없다:
 * 문서가 없거나 archived 면 호출부가 넘긴 `fallback`(각 워커의 기존 하드코딩 렌더)을 같은
 * 렌더러로 통과시킨다. 그래서 문서를 지우면 동작이 오늘과 정확히 같아진다(fail-closed).
 *
 * 발행된 문서가 렌더에 실패하면(변수 규칙 위반·빈 본문 등) 던지지 않고 fallback 으로 내려간다 —
 * 편집기 실수가 실사용자 메일 발송을 막지 않게 한다. 게이트(펜스/GA/분류기)는 이 경로를
 * 거치지 않으므로 템플릿 변경이 게이트 판정을 바꾸지 않는다.
 */
export async function resolveScpMailTemplateOverride(
  kind: ScpMailTemplateOverrideKind,
  fallback: { subject: string; text: string; html: string },
  values: Record<string, unknown> = {},
): Promise<RenderedScpReceiptMailTemplate> {
  // F4: fallback 렌더도 던질 수 있다(값이 비어 필수 변수 검증 실패, 오염된 URL 로 rejectUnsafeHtml
  // 위반 등). 예전에는 catch 밖이라 그 예외가 워커 루프까지 올라가 드레인 전체를 멈추고 클레임한
  // 행을 `sending` 으로 잠갔다. 최후 수단은 **비컴파일 원문 텍스트 전용**이다: 남은 `{{...}}` 토큰은
  // 지우고 html 은 비워(텍스트 파트만) 보낸다 — 수신자에게 토큰이 노출되지 않는다.
  const rawFallback = (): RenderedScpReceiptMailTemplate => {
    const stripTokens = (value: string) => value.replace(/\{\{\s*[a-zA-Z0-9_]*\s*\}\}/g, "").replace(/[ \t]{2,}/g, " ").trim();
    const subject = stripTokens(fallback.subject);
    const text = stripTokens(fallback.text);
    return {
      kind,
      source: "fallback",
      revision: 0,
      hash: sha256(`raw:${subject}\n${text}`),
      bodyFormat: "text",
      subject,
      text,
      html: "",
      htmlSource: "",
    };
  };
  const renderFallback = (): RenderedScpReceiptMailTemplate => {
    try {
      return renderScpReceiptMailTemplate({
        kind,
        subject: fallback.subject,
        html: fallback.html,
        text: fallback.text,
        values,
        revision: 0,
        source: "fallback",
      });
    } catch {
      return rawFallback();
    }
  };
  const snapshot = await adminDb
    .collection(TEMPLATE_COLLECTION)
    .doc(kind)
    .get()
    .catch(() => null);
  const data = asRecord(snapshot?.data());
  // F7h: "archived 가 아니면 발행"이 아니라 **명시적 발행 상태일 때만** 오버라이드가 이긴다.
  // draft·오타·빈 status 는 fallback 으로 내려간다(fail-closed 방향 정합).
  // 발행 상태 어휘는 writer 계약을 따른다: scpMail.normalizeTemplate 은 "active" | "archived" 만 쓴다.
  if (!snapshot?.exists || asString(data.status) !== "active") {
    return renderFallback();
  }
  try {
    return renderScpReceiptMailTemplate({
      kind,
      subject: asString(data.subject),
      html: asString(data.html),
      text: asString(data.text || data.plainText || data.body),
      // W72-HOTFIX: 저장된 형식을 렌더러에 넘긴다. 안 넘기면 markdown 문안이 평문으로 나가
      //   수신자에게 `[Apply now](url)` 가 리터럴로 보인다.
      bodyFormat: asString(data.bodyFormat),
      values,
      revision: Math.max(1, Math.trunc(Number(data.version ?? 1))),
      hash: asString(data.contentHash),
      source: "published",
    });
  } catch {
    return renderFallback();
  }
}

/**
 * W7-3f: 편집기 lint ② 의 근거 — **각 발송 호출부가 실제로 주입하는 변수 집합**.
 *
 * 허용 목록(RECEIPT_TEMPLATE_RULES.allowed)은 "저장 가능한 변수"이고, 이 표는 "발송 시 값이 오는
 * 변수"다. 둘의 차이가 위험이다: 허용되지만 주입되지 않는 변수를 템플릿에 쓰면 렌더러가 빈 문자열로
 * 치환해 **조용히 발송**된다(수신자는 빈 칸을 본다).
 *
 * always      = 그 kind 의 모든 발송 경로가 넘긴다.
 * conditional = 일부 경로/조건에서만 넘긴다(경고는 하되 오류로 취급하지 않는다).
 * 운영 기본값(program_name·portal_link·guide_link·supercent_brand)은 receiptRenderValues 가 항상
 * 병합하므로 always 에 포함하되, **그 kind 의 허용 목록에 있는 것만** 넣는다(허용되지 않은 변수는
 * 애초에 저장이 막히므로 주입 여부를 말할 자리가 없다).
 */
export const RECEIPT_TEMPLATE_INJECTED_VARIABLES: Record<
  ScpEditableMailTemplateKind,
  { readonly always: readonly string[]; readonly conditional: readonly string[] }
> = {
  // applicationManagementStore.ts:117 / scpFluApplicationCommand.ts:221
  application_confirmed: {
    always: ["application_id", "program_name", "portal_link", "apply_link", "supercent_brand"],
    conditional: ["reference_code"],
  },
  // W62-2: applicationVideoReminder 발송 콜러블이 주입한다.
  application_video_reminder: {
    always: ["application_id", "program_name", "portal_link", "guidebook_link", "supercent_brand"],
    conditional: ["reference_code", "days_since_apply"],
  },
  // scpIntegrationEventV2.ts:577 / scpVideoRevisionIngress.ts:879
  content_submitted: {
    always: [
      "application_id",
      "program_name",
      "video_submission_id",
      "video_revision",
      "portal_link",
      "guide_link",
      "supercent_brand",
    ],
    conditional: [],
  },
  // scpUidGuideMailWorker.ts (drainUidGuideOutbox)
  uid_guide: {
    always: ["uid_guide_link", "program_name", "portal_link", "supercent_brand"],
    conditional: [],
  },
  // scpOutboxMailWorkers.ts (drainVideoResultMailOutbox) — correction_link 는 재제출 링크가 있을 때만.
  // W120: 제출 참조 5종은 원장에서 항상 만들어 넘긴다(값이 비면 안전한 대체값으로 채운다).
  video_result_mail: {
    always: [
      "video_result_state",
      "video_result_message",
      "video_title",
      "youtube_url",
      "submission_ref",
      "decided_date",
      "prior_rejection_count",
      // 2026-09-05 다타이틀: 레지스트리 해석은 항상 성공한다(미등록 gameId → 기본 타이틀).
      "game_title",
      "game_store_link",
      "game_hashtags",
      "program_name",
      "portal_link",
      "supercent_brand",
    ],
    // W121: 사유 태그는 운영자가 고를 때만 주입된다(고르지 않으면 종전 코드 지도 문구 경로).
    // W126: 에스컬레이션은 같은 사유 반려가 임계(2회) 이상일 때만 주입된다.
    conditional: ["correction_link", "reason_tag_block", "escalation_notice"],
  },
  // W120: 승인 전용 override — 재제출 링크는 주입되지 않는다.
  video_result_mail_approved: {
    always: [
      "video_result_state",
      "video_result_message",
      "video_title",
      "youtube_url",
      "submission_ref",
      "decided_date",
      "prior_rejection_count",
      "game_title",
      "game_store_link",
      "game_hashtags",
      "program_name",
      "portal_link",
      "supercent_brand",
    ],
    conditional: [],
  },
  // W72 합동리뷰 R2-2: 스윕이 draft 를 만들 때 주입하는 값 집합(허용 목록과 정확히 같아야 한다).
  scp_nudge_cohort1_read_no_reply_en: {
    always: ["apply_link", "homepage_link", "program_name", "supercent_brand"],
    conditional: [],
  },
  scp_nudge_cohort2_applied_no_video_en: {
    always: ["submit_link", "guidebook_link", "application_id", "program_name", "supercent_brand"],
    conditional: [],
  },
  scp_nudge_cohort3_unread_no_reply_en: {
    always: ["apply_link", "program_name", "supercent_brand"],
    conditional: [],
  },
  // W91: scpOutboxMailWorkers.ts drainLoginApprovedMailOutbox 가 발송 시점에 주입한다.
  login_approved: {
    always: ["loginUrl", "supercent_brand"],
    conditional: [],
  },
  // 반려 드레인은 값을 넘기지 않는다 — 운영 기본값(program_name·supercent_brand)만
  // receiptRenderValues 가 항상 병합한다.
  login_rejected_subscriber_minimum: {
    always: ["program_name", "supercent_brand"],
    conditional: [],
  },
  login_rejected_channel_not_found: {
    always: ["program_name", "supercent_brand"],
    conditional: [],
  },
  login_rejected_public_reason: {
    always: ["program_name", "supercent_brand", "public_reason_text"],
    conditional: [],
  },
  // Task-100 F-6: resubmissionNudgeMail.ts 드레인이 발송 시점에 세 값 모두 주입한다.
  resubmission_nudge_en: {
    always: ["reason_message", "deadline", "portal_link", "program_name", "supercent_brand"],
    conditional: [],
  },
};

export type ScpMailTemplateLints = {
  /**
   * F7g: 예전에는 "허용되지만 주입되지 않는 변수"도 함께 경고했지만, 저장 시 검증
   * (validateScpReceiptMailTemplate)이 허용 목록 밖 변수를 이미 거부하고 허용 목록 == 주입 목록이라
   * **구조적으로 발화할 수 없는 경고**였다(죽은 주장). 아래 두 경고만 실제로 발화한다.
   * 허용 == 주입 불변식은 tests/scp-mail-template-lints.test.mjs 가 강제한다.
   */
  /** 일부 경로에서만 주입되는 변수 — 값이 없는 판정에서는 빈 칸·죽은 링크가 된다. */
  readonly conditionallyInjectedVariables: string[];
  /** 본문/제목이 mailSafety.emergencyKeywords 와 매치 — 매치되면 발송이 **전면 차단**된다. */
  readonly safetyKeywordMatches: string[];
};

/**
 * 저장 전 경고 2종. 판정을 새로 만들지 않는다:
 *   ① 변수 대조는 RECEIPT_TEMPLATE_RULES/INJECTED 표만 본다.
 *   ② 위험 문구 매치는 발송 게이트와 **같은 매처**(mailSafetyShared.firstKeywordMatch)를 재사용한다
 *      — 여기서 자체 정규화를 만들면 게이트와 판정이 갈린다.
 */
export function evaluateScpMailTemplateLints(input: {
  kind: ScpEditableMailTemplateKind;
  subject: string;
  html: string;
  text: string;
  emergencyKeywords: readonly string[];
}): ScpMailTemplateLints {
  const source = `${input.subject}\n${input.html}\n${input.text}`;
  const used = placeholders(source);
  const injected = RECEIPT_TEMPLATE_INJECTED_VARIABLES[input.kind];
  const conditional = new Set(injected.conditional);
  return {
    conditionallyInjectedVariables: used.filter((name) => conditional.has(name)),
    safetyKeywordMatches: input.emergencyKeywords.filter(
      (keyword) => typeof keyword === "string" && keyword.trim().length > 0 && Boolean(firstKeywordMatch(source, [keyword])),
    ),
  };
}
