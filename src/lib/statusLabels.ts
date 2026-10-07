// 운영자 화면에 노출되는 영문 enum → 한글 라벨 사전.
//
// 데이터가 아니라 순수 표시 매핑이다. 화면마다 즉석 삼항으로 번역하면 같은 값이 화면마다 다르게
// (혹은 영문 그대로) 보이므로, 표시 문구는 여기 한 곳에서만 정한다.
//
// ⚠️ 사전에 없는 값은 raw 를 그대로 흘리지 않고 `확인 필요(<raw>)` 로 감싼다. 새 enum 이 조용히
// 화면으로 새는 걸 막고, 운영자가 "모르는 값이 왔다"는 사실 자체를 보게 하기 위한 규칙이다.

export const UNKNOWN_STATUS_PREFIX = "확인 필요";

export function unknownStatusLabel(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  return text ? `${UNKNOWN_STATUS_PREFIX}(${text})` : UNKNOWN_STATUS_PREFIX;
}

function lookup(dictionary: Readonly<Record<string, string>>, raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return UNKNOWN_STATUS_PREFIX;
  return dictionary[text] ?? unknownStatusLabel(text);
}

/** 메일 발송/수신 상태 (mail_outbox.deliveryState, conversations.lastDeliveryState). */
export const DELIVERY_STATE_LABELS: Readonly<Record<string, string>> = {
  queued: "대기열",
  queued_for_review: "검토 대기",
  queued_for_send: "발송 대기",
  leased: "처리 중",
  processing: "처리 중",
  sending: "발송 중",
  scheduled: "예약됨",
  sent: "발송됨",
  mock_sent: "모의 발송",
  delivered: "도착 확인",
  received: "수신됨",
  bounced: "반송됨",
  deferred: "지연됨",
  dead_letter: "발송 포기",
  failed: "발송 실패",
  retryable_failed: "재시도 대기",
  blocked: "차단됨",
  cancelled: "취소됨",
  suppressed_duplicate: "중복 억제",
  recipient_pending: "수신자 확인 대기",
  sent_evidence_pending: "발송 근거 확인 대기",
  // W61-A3: 회수기가 증거 부족으로 잡고 있던 행을 **미발송으로 종결**한 상태. 발송 실패(failed)가
  // 아니다 — 실패는 "보냈는데 안 됐다"이고 이건 "보낸 적이 없다"다. 라벨을 빌려 쓰면 사유가 틀린다.
  settled_unsent: "미발송 종결",
  delivery_unknown: "도착 미확인",
};

export function deliveryStateLabel(raw: unknown): string {
  return lookup(DELIVERY_STATE_LABELS, raw);
}

/** 지원 관리 귀속 분류 (scp_application_management.classification). */
export const ATTRIBUTION_CLASSIFICATION_LABELS: Readonly<Record<string, string>> = {
  managed: "배정 완료",
  unclassified: "미분류",
  ambiguous: "후보 다수",
  conflict: "근거 충돌",
};

export function attributionClassificationLabel(raw: unknown): string {
  return lookup(ATTRIBUTION_CLASSIFICATION_LABELS, raw);
}

/** 지원 관리 분류 사유 (scp_application_management.reasonCode). */
export const ATTRIBUTION_REASON_LABELS: Readonly<Record<string, string>> = {
  exact_signed_match: "서명 토큰 일치",
  token_absent: "토큰 없음",
  signature_unverified: "서명 미검증",
  token_expired: "토큰 만료",
  token_revoked: "토큰 폐기",
  no_candidate: "후보 없음",
  multiple_candidates: "후보 다수",
  signed_evidence_conflict: "서명 근거 충돌",
  operator_assigned: "운영자 배정",
  // W99: 메일 발송 레인이 서명 귀속을 해석해 승격한 케이스 (아웃박스 역전파)
  outbox_resolved: "메일 발송 근거",
};

export function attributionReasonLabel(raw: unknown): string {
  return lookup(ATTRIBUTION_REASON_LABELS, raw);
}
export type ApplicationAttributionDisplay = {
  kind: "mail_match" | "managed_unlinked" | "operator_assigned" | "unclassified";
  campaignLabel: string;
  badgeLabel: string;
  tone: "ok" | "warn" | "neutral";
};

export function applicationAttributionDisplay(input: {
  classification: unknown;
  reasonCode: unknown;
  campaignId: unknown;
  outreachId: unknown;
  campaignName: unknown;
  hasOutreachDisplay: boolean;
  /** W104: 지원서 자가신고 신원(포털 answers)이 있는 행 — "신원 미확인" 문구가 거짓이 된다. */
  hasDeclaredIdentity?: boolean;
}): ApplicationAttributionDisplay {
  const classification = typeof input.classification === "string" ? input.classification.trim() : "";
  const reasonCode = typeof input.reasonCode === "string" ? input.reasonCode.trim() : "";
  const campaignId = typeof input.campaignId === "string" ? input.campaignId.trim() : "";
  const outreachId = typeof input.outreachId === "string" ? input.outreachId.trim() : "";
  const joinedCampaignName = typeof input.campaignName === "string" ? input.campaignName.trim() : "";
  const campaignLabel = joinedCampaignName || "캠페인명 미연결";
  const signedManaged = classification === "managed" && Boolean(campaignId) && Boolean(outreachId);

  if (signedManaged && joinedCampaignName && input.hasOutreachDisplay) {
    return { kind: "mail_match", campaignLabel, badgeLabel: `메일 매칭 · ${campaignLabel}`, tone: "ok" };
  }
  if (signedManaged) {
    return {
      kind: "managed_unlinked",
      campaignLabel,
      badgeLabel: "귀속 확인 · 발송 기록 미연결",
      tone: "warn",
    };
  }
  if (
    classification === "managed"
    && reasonCode === "operator_assigned"
    && Boolean(campaignId)
    && !outreachId
  ) {
    return {
      kind: "operator_assigned",
      campaignLabel,
      badgeLabel: `운영자 배정 · ${campaignLabel}`,
      tone: "warn",
    };
  }
  return {
    kind: "unclassified",
    campaignLabel: "미확인",
    // W26-F2: "포털 백필 대기"는 "대기 중이라 아직 관리가 아니다"라는 틀린 인상을 준다 — apply가
    // 들어오면 이미 관리 대상이다. 신원을 모른다는 사실은 숨기지 않되, 대기 프레이밍만 제거한다.
    // W104(헤세): 신원과 발송 귀속은 다른 축이다 — 지원서 자가신고 신원이 있으면 "신원 미확인"이
    // 거짓이 된다. 귀속 미확인 사실은 그대로 말하고, 신원 출처(자가 신고)를 정확히 라벨링한다.
    // 헤세(0907): 목록 15/18행에서 반복되는 배지라 12자 이내로 압축 — 자세한 사유는 상세에서 본다.
    badgeLabel: input.hasDeclaredIdentity ? "자가 신고 신원" : "추적 없는 유입",
    tone: "neutral",
  };
}

/** 자격 검증 결과 (program_applications.qualificationStatus). */
export const QUALIFICATION_STATUS_LABELS: Readonly<Record<string, string>> = {
  pass: "통과",
  approved: "승인",
  human_gate: "사람 확인 필요",
  fail: "미통과",
  rejected: "반려",
  pending: "판정 대기",
};

export function qualificationStatusLabel(raw: unknown): string {
  return lookup(QUALIFICATION_STATUS_LABELS, raw);
}

/** 피드백 fine-tune 반출 상태 (feedback.fineTuneStatus). */
export const FINE_TUNE_STATUS_LABELS: Readonly<Record<string, string>> = {
  queued: "반출 대기",
  sent_to_aihub: "AI Hub 반출 완료",
  compensation_required: "보정 필요",
  compensated: "보정 완료",
  skipped: "반출 제외",
};

export function fineTuneStatusLabel(raw: unknown): string {
  return lookup(FINE_TUNE_STATUS_LABELS, raw);
}

/** LLM 사용 기록의 공급자/전송 경로 (llm_usage.provider / transport). */
export const LLM_PROVENANCE_LABELS: Readonly<Record<string, string>> = {
  unverified: "출처 미검증",
  vertex: "Vertex",
  gateway: "AI Hub 게이트웨이",
  aihub: "AI Hub",
  mock: "모의 호출",
  direct: "직접 호출",
  proxy: "프록시 경유",
};

export function llmProvenanceLabel(raw: unknown): string {
  return lookup(LLM_PROVENANCE_LABELS, raw);
}

/** 메일 안전/신원 상태 (mail safety status, mail identity code). */
export const MAIL_SAFETY_STATUS_LABELS: Readonly<Record<string, string>> = {
  identity_ok: "신원 확인",
  identity_ok_unverified_subject: "신원 확인 · 발신 주체 미검증",
  identity_missing: "신원 미설정",
  blocked: "차단됨",
  available: "사용 가능",
  configured: "설정됨",
  not_configured: "미설정",
  verified: "검증됨",
  unverified: "미검증",
  active: "작동 중",
  off: "꺼짐",
  required: "필요",
  no_sync_yet: "동기화 이력 없음",
  ok: "정상",
};

export function mailSafetyStatusLabel(raw: unknown): string {
  return lookup(MAIL_SAFETY_STATUS_LABELS, raw);
}

/** 프로그램 신청/파일럿 승격 상태 (program_applications.status). */
export const PROGRAM_APPLICATION_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: "대기",
  approved: "승인",
  hold: "보류",
  rejected: "반려",
  // 운영 데이터에는 타입에 없는 값이 실제로 들어 있다(2026-07-27 실측: operator_reviewed_pilot).
  operator_reviewed_pilot: "운영자 검토 파일럿",
  ambiguous_candidate_review: "후보 모호 · 확인 필요",
  fuzzy_candidate_review: "후보 유사 일치 · 확인 필요",
  cancelled_preapproval_failed: "사전승인 실패로 취소",
  cancelled: "취소됨",
  withdrawn: "철회됨",
};

export function programApplicationStatusLabel(raw: unknown): string {
  return lookup(PROGRAM_APPLICATION_STATUS_LABELS, raw);
}

/** 캠페인 귀속 스코프 표기. `unclassified` 는 "분류 안 된 상태"이지 캠페인 이름이 아니다. */
export const CAMPAIGN_SCOPE_LABELS: Readonly<Record<string, string>> = {
  unclassified: "캠페인 미분류",
  "view-cpm": "조회수 CPM",
};

export function campaignScopeLabel(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return "캠페인 미지정";
  // 실제 캠페인 id 는 사전에 없으므로 그대로 둔다 — 여기서는 상태 토큰만 번역한다.
  return CAMPAIGN_SCOPE_LABELS[text] ?? text;
}

/** 메일 플로우 템플릿 종류 (scp_mail_templates.kind). */
export const MAIL_TEMPLATE_KIND_LABELS: Readonly<Record<string, string>> = {
  scp_coldmail_initial: "콜드메일 1차",
  scp_coldmail_followup: "콜드메일 팔로업",
  re_guide: "회신 재안내",
  qualification_pass: "자격 합격",
  qualification_fail: "자격 불합격",
  gem_paid_submission_request: "젬 지급 후 영상 제출 요청",
  video_submission_reminder: "영상 제출 독려",
  scp_uid_request: "UID 요청",
  chat_general_reply: "일반 답장",
  scp_receipt_auto: "자동 영수증",
  // W7-3: 편집 대상이 된 자동 발송 레인 kind(scp_mail_templates 문서 id 와 같은 값).
  application_confirmed: "신청 확인",
  content_submitted: "콘텐츠 제출 확인",
  uid_guide: "UID 등록 안내",
  video_result_mail: "영상 검수 결과",
  video_result_mail_approved: "영상 승인 결과",
  scp_management_ack: "배정 확인 안내",
  scp_result_pass: "검수 합격 안내",
  scp_result_revise: "검수 보완 요청",
  scp_result_reject: "검수 반려 안내",
};

export function mailTemplateKindLabel(raw: unknown): string {
  return lookup(MAIL_TEMPLATE_KIND_LABELS, raw);
}

/**
 * 검수 판정 사유 코드 / 고객 안내 코드.
 * ⚠️ value 는 Portal 계약이라 그대로 보낸다 — 여기서는 화면 label 만 한글로 바꾼다.
 */
export const REVIEW_REASON_CODE_LABELS: Readonly<Record<string, string>> = {
  policy_gate_failed: "정책 기준 미충족",
  content_quality: "콘텐츠 품질 미달",
  wrong_video: "다른 영상 제출",
  duplicate_content: "중복 콘텐츠",
  // W120: 실데이터 반려 1위 유형(링크 접근 불가 5/14)인데 enum 에 없어서 운영자가
  // `other_documented` + 자유 타이핑으로 처리하고 있었다 — 집계도 프리셋도 안 붙는다.
  video_unavailable: "영상 확인 불가",
  metadata_mismatch: "메타데이터 불일치",
  other_documented: "기타(사유 기재)",
};

/**
 * 검수 사유 코드의 정본 순서(선택 목록). 값은 Portal 계약(publicReasonCode)이라 그대로 보낸다.
 * 화면과 프리셋이 각자 목록을 들면 갈리므로 여기 하나만 둔다.
 */
export const REVIEW_REASON_CODES: readonly string[] = [
  "policy_gate_failed",
  "content_quality",
  "wrong_video",
  "duplicate_content",
  "video_unavailable",
  "metadata_mismatch",
  "other_documented",
];

export function reviewReasonCodeLabel(raw: unknown): string {
  return lookup(REVIEW_REASON_CODE_LABELS, raw);
}

/**
 * W120: 사유 코드별 **영문 기본 안내문 프리셋**(크리에이터 발송 문안 초안).
 *
 * 종전에는 운영자가 매번 자유 타이핑했다 — 실운영 반려 문안에서 오타("he audio")가 그대로
 * 크리에이터에게 나갔다. 사유 코드를 고르면 이 문안이 편집창에 채워지고, 운영자는 그대로 보내거나
 * 고쳐 쓴다(편집 권한은 그대로).
 *
 * ⚠️ 서버 검증(parseVideoReviewOperatorMessage)을 통과해야 하므로 **URL·도메인형 토큰·`{{ }}` 금지**.
 * 포털 링크는 발송 시 재제출 CTA 로 자동 붙는다 — 문안에 주소를 적지 않는다.
 * `other_documented` 는 의도적으로 비운다(자유 기재 코드).
 */
export const REVIEW_REASON_CODE_MAIL_PRESETS: Readonly<Record<string, string>> = {
  policy_gate_failed:
    "Your submission did not meet the campaign content policy. Please review the campaign guidelines and submit a corrected video.",
  content_quality:
    "Plain gameplay walkthroughs are not eligible. Approved videos add your own hook, commentary or reaction, or edited highlights. Please review the guide and submit a new video.",
  wrong_video:
    "The link points to a different video than the one registered for this campaign. Please check your submission and resubmit the correct watch link.",
  duplicate_content:
    "This video was already submitted. Each video can be submitted once - please submit a new, different video.",
  video_unavailable:
    "The video at your link could not be viewed - it may be private, deleted, or mistyped. Set it to Public and resubmit the exact watch link.",
  // W120 [적대 리뷰 M8]: 서버 코드 지도(scpOutboxMailWorkers VIDEO_RESULT_MAIL_CUSTOMER_MESSAGES)의
  //   같은 코드 문구로 문장을 연다 — 운영자가 프리셋을 비우면 그 조각이 대신 나가므로, 두 문안이
  //   서로 다른 사실을 말하면 같은 사유가 메일마다 달라 보인다.
  metadata_mismatch:
    "The submitted video did not match the required campaign details - the audio and the visuals do not match, so the purpose of the content is unclear. Please resubmit with audio that matches what is on screen.",
  other_documented: "",
};

/** 프리셋이 없는(또는 자유 기재) 코드면 빈 문자열 — 호출부가 편집창을 비운다. */
export function reviewReasonCodeMailPreset(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return "";
  return REVIEW_REASON_CODE_MAIL_PRESETS[text] ?? "";
}

/**
 * W121: **룰 키 → 크리에이터 안전 영문 문구** 사전(사유 태그 칩의 문안 소스).
 *
 * 위 `REVIEW_REASON_CODE_MAIL_PRESETS` 와 같은 계층·같은 규율이다: 화면은 룰명과 confidence
 * 퍼센트를 보지만 **메일에는 이 문장만** 나간다 — 룰 ID·룰명·퍼센트·AI/모델 언급은 크리에이터
 * 메일에 한 글자도 들어가지 않는다(SEC-P0-009). 사전에 없는 룰 키는 태그 후보에서 제외된다.
 *
 * ⚠️ 정본은 서버의 `functions/videoReviewCriteria.ts VIDEO_REVIEW_RULE_TAG_MAIL_PHRASES` 다
 *   (발송 렌더는 서버가 한다). 배포 경계상 import 할 수 없어 사본을 두고, 두 사본이 어긋나면
 *   테스트가 red 다 — 어긋나면 칩에 보인 문장과 실제 발송본이 갈린다.
 * ⚠️ 비대칭 주의: 서버 사본은 `Record<VideoReviewRuleKey, string>` 이라 **룰이 늘면 컴파일이
 *   깨져** 문구 누락을 즉시 잡는다. 이 사본은 룰 키 타입이 없어(서버 전용 모듈) 그 강제를
 *   잃는다 — 여기서 누락은 컴파일이 아니라 위 정합 테스트에서만 red 가 된다.
 */
export const VIDEO_REVIEW_RULE_TAG_MAIL_PHRASES: Readonly<Record<string, string>> = {
  xp_hero_gameplay_relevance:
    "XP Hero gameplay is not the main subject of this video. Please make XP Hero gameplay the focus and submit a new video.",
  xp_hero_store_link:
    "The description is missing the XP Hero store link assigned to you, or it points somewhere else. Please add the assigned link and resubmit.",
  public_visibility:
    "The video could not be viewed at the link you submitted - it may be private, deleted, or mistyped. Set it to Public and resubmit the exact watch link.",
  edited_secondary_creation:
    "Plain gameplay recordings, reposts, and cut-only reuploads are not eligible. Add your own hook, commentary or reaction, or edited highlights.",
  duration_min_20s:
    "The video is shorter than the 20-second minimum, or it is a live-stream recording. Please submit a video of at least 20 seconds.",
  xp_hero_exact_name:
    "The game name is not written exactly as XP Hero in the video or the description. Please correct it and resubmit.",
  allowed_content_language:
    "The spoken or written language of this video is not one of the languages this campaign accepts.",
  required_hashtags:
    "The description is missing the required hashtags: #SuperCreatorPartners, #Supercent, and #XPHero.",
  sponsorship_disclosure:
    "The video and the description do not clearly disclose that this content is part of a paid partnership program.",
  face_ratio_25pct:
    "Your own face is not on screen for the share of the video this campaign requires. Please film with your face visible and resubmit.",
  provided_sample_derivative:
    "The approved sample footage is not used as part of an edited work. Please build your video around the provided sample and resubmit.",
  captions_required:
    "Captions are missing, or they do not match the language spoken in the video. Please add matching captions and resubmit.",
  clear_synced_av:
    "The audio and the visuals do not match, so the purpose of the content is unclear. Please resubmit with audio that matches what is on screen.",
  no_metric_manipulation:
    "The engagement on this video could not be accepted under the campaign rules. Views, likes, comments, and followers must come from genuine activity.",
  no_repeat_upload:
    "This video, or a nearly identical one, has already been submitted. Each video can be submitted once - please submit a new, different video.",
  no_copyright_infringement:
    "The video uses third-party material that is not cleared for this campaign. Please remove it and resubmit.",
  no_portrait_privacy_infringement:
    "The video uses other people's faces, voices, or personal information without their consent. Please remove it and resubmit.",
  no_hate_discrimination:
    "The video contains hateful or discriminatory content, which this campaign does not allow.",
  no_misinformation:
    "The video contains inaccurate or exaggerated claims about the game. Please correct them and resubmit.",
  no_disclosure_omission:
    "The video leaves out the program participation and reward information that has to be disclosed.",
  no_brand_harm:
    "The way the game is presented in this video is not something this campaign can publish.",
  platform_policy_compliance:
    "The video does not comply with YouTube's operating, advertising, or community policies.",
  no_sexual_content:
    "The video contains sexual or otherwise inappropriate content, which this campaign does not allow.",
  no_violent_content:
    "The video contains violent or otherwise inappropriate content, which this campaign does not allow.",
};

/** 한 통의 메일이 실을 수 있는 사유 태그 상한(서버 VIDEO_REVIEW_REASON_TAG_MAX 미러). */
export const VIDEO_REVIEW_REASON_TAG_MAX = 5;

/**
 * 사전 미등록 룰 키는 빈 문자열 — 호출부가 그 후보를 칩에서 뺀다.
 * 서버(`isVideoReviewRuleTagKey`)와 같이 `hasOwnProperty` 로 본다 — 인덱스 접근만 쓰면
 * `"constructor"`·`"__proto__"` 같은 프로토타입 키가 truthy 로 통과한다.
 */
export function videoReviewRuleTagMailPhrase(raw: unknown): string {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return "";
  return Object.prototype.hasOwnProperty.call(VIDEO_REVIEW_RULE_TAG_MAIL_PHRASES, key)
    ? VIDEO_REVIEW_RULE_TAG_MAIL_PHRASES[key]
    : "";
}

export const CUSTOMER_MESSAGE_CODE_LABELS: Readonly<Record<string, string>> = {
  cm_fix_and_resubmit: "수정 후 재제출 안내",
  cm_replace_video: "영상 교체 안내",
  cm_policy_guidance: "정책 안내",
  cm_final_rejection: "현재 리비전 반려·재제출 안내",
};

export function customerMessageCodeLabel(raw: unknown): string {
  return lookup(CUSTOMER_MESSAGE_CODE_LABELS, raw);
}

/**
 * 캐노니컬 영상 검수 상태(`scp_video_review_state.state`, functions/videoReviewTransitionCore
 * VIDEO_REVIEW_STATES 6종 + 레거시 호환값 2종).
 * ⚠️ value 는 Portal 계약이라 그대로 두고 화면 라벨만 한글로 바꾼다. 미등록은 `확인 필요(raw)`.
 */
export const VIDEO_REVIEW_STATE_LABELS: Readonly<Record<string, string>> = {
  queued: "검수 대기",
  in_review: "검수 중",
  changes_requested: "변경 요청",
  human_review_required: "사람 확인 필요",
  rejected: "반려",
  approved: "승인 완료",
  pending: "검수 대기",
  needs_review: "사람 확인 필요",
};

export function videoReviewStateLabel(raw: unknown): string {
  return lookup(VIDEO_REVIEW_STATE_LABELS, raw);
}
