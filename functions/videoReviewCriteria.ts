import {
  defaultProgramTitle,
  joinProgramTitleNames,
  otherProgramTitles,
  requiredHashtagsForTitle,
  resolveProgramTitle,
  resolveProgramTitles,
  resolveProgramTitlesOrDefault,
} from "./programTitles";
import { canonicalScpProgramId } from "./scpProgramAlias";

export type VideoReviewTrack = "uploaded_file" | "youtube_link";
export type VideoReviewAssessment = "deterministic" | "metadata" | "multimodal" | "human_only";
export type VideoReviewRuleStatus = "applicable" | "not_applicable" | "unknown";
export type VideoReviewRuleEvidenceStatus = "observed" | "unknown" | "failed";

// W107: judgment semantics changed (human-gate trigger scope, probability clamp, R2/R8 evidence
// codes) without changing the rubric text itself, so the policy version is bumped to invalidate
// judge/evidence caches keyed on it (videoReviewCacheKey, VIDEO_REVIEW_EVIDENCE_POLICY_VERSION,
// the multimodal cache in videoReviewMultimodal.ts) and to flag pre-bump decisions as a prior
// revision in the review UI (CURRENT_VIDEO_REVIEW_POLICY_VERSION in ReviewWorkspace.tsx, kept in
// sync manually since it cannot import this server-only module).
export const VIDEO_REVIEW_POLICY_VERSION = "xp-hero-content-policy/v2.1.0" as const;

export const XP_HERO_ALLOWED_CONTENT_LANGUAGE_CODES = [
  "en", "ko", "de", "ja", "zh", "fr", "it", "no", "da", "is", "nl", "sv",
  "ru", "he", "es", "fi", "pt", "th", "tr", "fil", "vi", "id", "hi", "ar",
] as const;

export type VideoReviewRuleId = `R${number}`;
export type VideoReviewRuleKey =
  | "xp_hero_gameplay_relevance"
  | "xp_hero_store_link"
  | "public_visibility"
  | "edited_secondary_creation"
  | "duration_min_20s"
  | "xp_hero_exact_name"
  | "allowed_content_language"
  | "required_hashtags"
  | "sponsorship_disclosure"
  | "face_ratio_25pct"
  | "provided_sample_derivative"
  | "captions_required"
  | "clear_synced_av"
  | "no_metric_manipulation"
  | "no_repeat_upload"
  | "no_copyright_infringement"
  | "no_portrait_privacy_infringement"
  | "no_hate_discrimination"
  | "no_misinformation"
  | "no_disclosure_omission"
  | "no_brand_harm"
  | "platform_policy_compliance"
  | "no_sexual_content"
  | "no_violent_content";

export type VideoReviewRuleDescriptor = {
  id: VideoReviewRuleId;
  key: VideoReviewRuleKey;
  name: string;
  statement: string;
  notes: string;
  assessment: VideoReviewAssessment;
  judgeFrom: string;
  appliesToTracks: VideoReviewTrack[];
  aiJudgeable: "yes" | "no" | "partial";
  verdictIfViolated: "reject" | "human_review";
  checkKey: string;
  reason: string;
  missingEvidence: "human_gate";
  canAutoReject: boolean;
  requiresHumanConfirmation: boolean;
};

/**
 * 정책 출처의 **불변 이력 기록**(v2 시점의 원문 제공자). `game` 은 그 시점의 유일한 타이틀이라
 * 여기 남아 있을 뿐, 판정에 쓰이는 값이 아니다 — 제출별 게임명은 반드시
 * `videoReviewCriteriaSourceFor(title).game` 으로 읽는다(다타이틀, 2026-09-05).
 */
export const VIDEO_REVIEW_CRITERIA_SOURCE = {
  schema: "flu-video-review-policy/v2",
  criteriaSchema: "xp-hero-content-policy/v2",
  rulecheckSchema: "infly-review-training-rulecheck/v1",
  source: "Flu canonical XP Hero participant rubric plus the non-PII Infly R1-R4 compatibility port",
  game: "XP Hero",
  version: VIDEO_REVIEW_POLICY_VERSION,
  effectiveAt: "2026-07-11T00:00:00.000Z",
} as const;

// Historical training aggregates are retained only as provenance for the original four
// Infly-compatible rules. They are not evidence that the twenty new policy rules were trained.
export const VIDEO_REVIEW_RULECHECK_SUMMARY = {
  schema: VIDEO_REVIEW_CRITERIA_SOURCE.rulecheckSchema,
  generatedAt: "2026-06-18T07:23:56.268Z",
  counts: {
    totalRecords: 67,
    trainReady: 66,
    byLabel: { rejected: 9, approved: 57 },
    byRule: { R1: 2, R2: 3, R3: 2, R4: 2 },
  },
  dedupGroups: [{ group: "dup01", memberCount: 2 }],
  scope: "legacy_r1_r4_only",
} as const;

/**
 * 검수 루브릭이 필요로 하는 **타이틀 사실**(프로그램 타이틀 레지스트리에서만 온다).
 *
 * 2026-09-05 헤세 결정으로 SCP 는 다타이틀 프로그램이 됐다. R1/R2/R6/R8 과 반려 문구는 더 이상
 * XP Hero 를 상수로 갖지 않고 이 컨텍스트로 조립된다. **타이틀별 분기는 어디에도 없다** —
 * 타이틀을 추가하려면 `functions/programTitles.seed.json` 에 항목 1개를 넣으면 된다.
 *
 * 룰 id/key/checkKey/reason 은 정본 계약이라 타이틀과 무관하게 고정이다(원장·캐시·클라 사본이
 * 이 값들로 맞물려 있다). 바뀌는 것은 사람이 읽는 name/statement/notes 와 메일 문구뿐이다.
 */
export type VideoReviewRubricTitle = {
  id: string;
  name: string;
  storeUrl: string;
  /** 프로그램 공통 해시태그 + 타이틀 해시태그(R8). */
  requiredHashtags: readonly string[];
  /** 같은 프로그램의 다른 타이틀 이름 — R2 의 "이 프로그램 밖 타이틀 링크 금지" 대상. */
  otherTitleNames: readonly string[];
};

/** 옥스퍼드 콤마 나열("A, B, and C") — 룰 문구/메일 문구가 공유한다. */
function joinWithAnd(values: readonly string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

/**
 * programId + 제출의 gameId 로 루브릭 타이틀을 해석한다. 미등록/누락 gameId 는 프로그램 기본
 * 타이틀로 착지한다(기존 행의 오늘 동작 보존). `registryOverride` 는 운영 오버라이드 문서다.
 */
export function videoReviewRubricTitle(
  programId: unknown = canonicalScpProgramId,
  gameId?: unknown,
  registryOverride?: unknown,
): VideoReviewRubricTitle {
  const registry = resolveProgramTitlesOrDefault(programId, registryOverride);
  const title = resolveProgramTitle(registry, gameId) ?? defaultProgramTitle(registry);
  if (!title) {
    return { id: "", name: "the program game", storeUrl: "", requiredHashtags: [], otherTitleNames: [] };
  }
  return {
    id: title.id,
    name: title.name,
    storeUrl: title.storeUrl,
    requiredHashtags: requiredHashtagsForTitle(registry, title),
    otherTitleNames: otherProgramTitles(registry, title.id).map((entry) => entry.name),
  };
}

/** gameId 가 없는 모든 레거시 호출부가 보는 값 — SCP 프로그램의 기본 타이틀. */
export const DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE: VideoReviewRubricTitle = videoReviewRubricTitle();

/**
 * features 봉투(`reviewCriteria.title`)에 실린 루브릭 타이틀을 되읽는다. 프롬프트·판정 정규화가
 * 제출과 같은 타이틀을 보게 하는 유일한 경로다. 값이 없으면 기본 타이틀.
 */
export function videoReviewRubricTitleFromFeatures(features: unknown): VideoReviewRubricTitle {
  const record = features && typeof features === "object" ? features as Record<string, unknown> : {};
  const criteria = record.reviewCriteria && typeof record.reviewCriteria === "object"
    ? record.reviewCriteria as Record<string, unknown>
    : {};
  const title = criteria.title && typeof criteria.title === "object"
    ? criteria.title as Record<string, unknown>
    : {};
  const name = typeof title.name === "string" ? title.name.trim() : "";
  if (!name) return DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE;
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  return {
    id: typeof title.id === "string" ? title.id : "",
    name,
    storeUrl: typeof title.storeUrl === "string" ? title.storeUrl : "",
    requiredHashtags: strings(title.requiredHashtags),
    otherTitleNames: strings(title.otherTitleNames),
  };
}

/** 프로그램의 전체 타이틀 이름 나열(카피 생성 전용, 리터럴 열거 금지). */
export function videoReviewProgramTitleNames(programId: unknown = canonicalScpProgramId, registryOverride?: unknown): string {
  return joinProgramTitleNames(resolveProgramTitles(programId, registryOverride).titles);
}

const BOTH_TRACKS: VideoReviewTrack[] = ["uploaded_file", "youtube_link"];
const DEFAULT_MISSING_EVIDENCE_NOTE = "Unavailable, ambiguous, or low-confidence evidence must remain unknown and enter the human review gate.";

function rule(
  id: VideoReviewRuleId,
  key: VideoReviewRuleKey,
  name: string,
  statement: string,
  assessment: VideoReviewAssessment,
  judgeFrom: string,
  checkKey: string,
  reason: string,
  options: Partial<Pick<VideoReviewRuleDescriptor, "notes" | "appliesToTracks" | "aiJudgeable" | "verdictIfViolated" | "canAutoReject" | "requiresHumanConfirmation">> = {},
): VideoReviewRuleDescriptor {
  const humanOnly = assessment === "human_only";
  return {
    id,
    key,
    name,
    statement,
    notes: options.notes ?? DEFAULT_MISSING_EVIDENCE_NOTE,
    assessment,
    judgeFrom,
    appliesToTracks: options.appliesToTracks ?? BOTH_TRACKS,
    aiJudgeable: options.aiJudgeable ?? (humanOnly ? "no" : assessment === "multimodal" ? "yes" : "partial"),
    verdictIfViolated: options.verdictIfViolated ?? (humanOnly ? "human_review" : "reject"),
    checkKey,
    reason,
    missingEvidence: "human_gate",
    canAutoReject: options.canAutoReject ?? !humanOnly,
    requiresHumanConfirmation: options.requiresHumanConfirmation ?? humanOnly,
  };
}

export function videoReviewRulesFor(
  title: VideoReviewRubricTitle = DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE,
): readonly VideoReviewRuleDescriptor[] {
  const otherTitles = title.otherTitleNames.length ? ` (${joinWithAnd(title.otherTitleNames)})` : "";
  return [
  rule("R1", "xp_hero_gameplay_relevance", `${title.name} gameplay relevance`, `${title.name} gameplay must be shown and ${title.name} must remain the primary subject.`, "multimodal", "sampled_video_frames + transcript", "contentRelevance", "게임 관련성 확인 필요", {
    notes: `The source guide conflicts on whether any other game is allowed. Seeing another game is never an automatic hard fail; record evidence and require a human decision on whether ${title.name} remains primary.`,
    verdictIfViolated: "human_review",
    canAutoReject: false,
  }),
  rule("R2", "xp_hero_store_link", `${title.name} store destination`, `The description must include the assigned canonical ${title.name} store/tracking destination and must not include a store destination for any other title in this program${otherTitles} or for a game outside it.`, "metadata", "youtube_description + canonical_redirect_chain + creator_assignment", "customLinkUsed", "게임 스토어 링크 확인 필요", { appliesToTracks: ["youtube_link"] }),
  rule("R3", "public_visibility", "Public YouTube target", "The submitted YouTube target must resolve to the intended video and be publicly viewable.", "metadata", "youtube_video_metadata", "linkValidity", "공개 상태 또는 제출 링크 확인 필요", { appliesToTracks: ["youtube_link"] }),
  rule("R4", "edited_secondary_creation", "Edited secondary creation", "Raw unedited gameplay, simple reposts, and cut-only reuploads are not eligible; creator-added storytelling, reaction, commentary, or editing is required.", "multimodal", "sampled_video_frames + audio + relational_dedup", "duplicationOrOriginality", "편집·2차 창작 확인 필요"),
  rule("R5", "duration_min_20s", "Minimum duration", "Eligible Shorts or long-form content must be at least 20 seconds; live-stream VOD is not eligible.", "deterministic", "youtube_or_media_duration + broadcast_metadata", "durationSeconds", "20초 미만 또는 Live VOD"),
  rule("R6", "xp_hero_exact_name", `Exact ${title.name} name`, `The game name must be written exactly as ${title.name} in the video or description.`, "multimodal", "title + description + transcript + on_screen_text", "gameNameExact", "게임명 표기 확인 필요", { notes: "An authoritative title/description match can satisfy the rule. Otherwise use transcript/OCR evidence; incomplete scans remain unknown and enter the human gate." }),
  rule("R7", "allowed_content_language", "Allowed content language", "Spoken and written content must use an approved content language.", "multimodal", "youtube_language + transcript_language", "contentLanguage", "허용 언어 확인 필요", { notes: "Authoritative YouTube language metadata or a transcript-language observation may satisfy the rule. Conflicting or incomplete language evidence remains unknown." }),
  rule("R8", "required_hashtags", "Required hashtags", `The description must contain ${joinWithAnd(title.requiredHashtags)}.`, "deterministic", "youtube_description", "requiredHashtags", "필수 해시태그 누락", { appliesToTracks: ["youtube_link"], notes: "This is a posting-stage description check. It is not applicable to a pre-post uploaded-file review and must run once a YouTube description exists." }),
  rule("R9", "sponsorship_disclosure", "Program and sponsorship disclosure", "Program participation and advertising or sponsorship status must be clearly disclosed in the video or description.", "multimodal", "youtube_description + transcript + on_screen_text", "sponsorshipDisclosure", "광고·협찬 고지 확인 필요", { notes: "A description disclosure can satisfy the rule. Otherwise transcript/on-screen evidence may satisfy it; absence requires a completed scan and incomplete evidence remains unknown." }),
  rule("R10", "face_ratio_25pct", "Creator face ratio", "The creator's own face must occupy at least 25% of the frame when evaluated under the approved sampling protocol.", "multimodal", "documented_frame_sampling + face_ownership + visible_area_aggregation", "faceRatio", "얼굴 노출 25% 확인 필요", { verdictIfViolated: "human_review", canAutoReject: false, requiresHumanConfirmation: true, notes: "Automated evidence must state frame sampling, face ownership, visible-area calculation, and aggregation. Without all four, the result remains a human-review signal." }),
  rule("R11", "provided_sample_derivative", "Provided sample footage derivative", "Approved sample footage must be included as part of an edited derivative work; filename or similarity guess alone is insufficient.", "multimodal", "approved_sample_fingerprints + sampled_video_frames", "sampleFootage", "샘플 영상 사용 확인 필요", { verdictIfViolated: "human_review", canAutoReject: false, requiresHumanConfirmation: true, notes: "AI similarity is assistive only until the approved sample fingerprint/reference and derivative-use context are confirmed by a person." }),
  rule("R12", "captions_required", "Captions", "Captions are required and must match the language used in the video.", "multimodal", "caption_track + burned_in_text + transcript_language", "captions", "자막 확인 필요"),
  rule("R13", "clear_synced_av", "Clear and synchronized AV", "Video and audio must be clear, and non-background audio should match the visual effects.", "multimodal", "sampled_video_frames + audio_quality + av_sync", "audioVisualQuality", "화질·오디오 품질 확인 필요"),
  rule("R14", "no_metric_manipulation", "No metric manipulation", "Views, likes, comments, or followers must not be inflated with bots, paid traffic, or other artificial activity.", "human_only", "youtube_analytics_traffic_source + anomaly_summary", "metricManipulation", "조작 의심 사람 검토", { appliesToTracks: ["youtube_link"], notes: "Without current traffic-source evidence, manipulation must stay unknown. Never infer manipulation from public counters alone. A pre-post uploaded file has no traffic metrics, so this check runs after publication." }),
  rule("R15", "no_repeat_upload", "No repeated upload", "The same or materially identical video must not be submitted repeatedly.", "metadata", "cross_submission_media_fingerprint + perceptual_similarity", "repeatUpload", "반복 업로드 확인 필요", { verdictIfViolated: "human_review", canAutoReject: false }),
  rule("R16", "no_copyright_infringement", "No copyright infringement", "Unapproved movie, TV, celebrity, or other third-party copyrighted material is prohibited.", "human_only", "rights_manifest + content_match + human_context", "copyright", "저작권 사람 검토"),
  rule("R17", "no_portrait_privacy_infringement", "No portrait or privacy infringement", "Third-party faces, voices, or personal information may not be used without consent.", "human_only", "consent_manifest + sampled_media + human_context", "portraitPrivacy", "초상권·개인정보 사람 검토"),
  rule("R18", "no_hate_discrimination", "No hate or discrimination", "Hateful or discriminatory content based on race, gender, religion, nationality, or similar traits is prohibited.", "human_only", "transcript + on_screen_text + human_context", "hateDiscrimination", "혐오·차별 사람 검토"),
  rule("R19", "no_misinformation", "No misinformation or misleading claims", "Inaccurate information, exaggerated performance claims, and misleading statements are prohibited.", "human_only", "fact_check + transcript + on_screen_text + human_context", "misinformation", "허위·과장 주장 사람 검토"),
  rule("R20", "no_disclosure_omission", "No intentional disclosure omission", "Program participation or reward structure must not be intentionally concealed.", "human_only", "disclosure_evidence + human_intent_review", "disclosureOmission", "고지 누락 사람 검토"),
  rule("R21", "no_brand_harm", "No brand harm", "Potentially damaging negative portrayal of the game requires policy-owner review.", "human_only", "transcript + visual_context + policy_owner_review", "brandHarm", "브랜드 이미지 사람 검토", { notes: "The source wording is aspirational, not an approved automatic rejection rule. Treat it as a warning and human review only." }),
  rule("R22", "platform_policy_compliance", "Platform policy compliance", "The content must comply with YouTube operating, advertising, and community policies.", "human_only", "platform_policy_evidence + human_context", "platformPolicy", "플랫폼 정책 사람 검토"),
  rule("R23", "no_sexual_content", "No inappropriate sexual content", "Sexual or otherwise inappropriate content prohibited by platform policy is not eligible.", "human_only", "sampled_media + human_context", "sexualContent", "성적 콘텐츠 사람 검토"),
  rule("R24", "no_violent_content", "No inappropriate violent content", "Violent or otherwise inappropriate content prohibited by platform policy is not eligible.", "human_only", "sampled_media + human_context", "violentContent", "폭력적 콘텐츠 사람 검토"),
  ];
}

/** gameId 를 모르는 레거시 호출부의 기본 룰셋(= 프로그램 기본 타이틀). */
export const VIDEO_REVIEW_RULES: readonly VideoReviewRuleDescriptor[] = videoReviewRulesFor();

/** 이 타이틀에 맞춘 criteria source(게임명만 타이틀에서 온다). */
export function videoReviewCriteriaSourceFor(title: VideoReviewRubricTitle = DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE) {
  return { ...VIDEO_REVIEW_CRITERIA_SOURCE, game: title.name };
}

export function videoReviewCriteriaPromptMetadata(title: VideoReviewRubricTitle = DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE) {
  return {
    source: videoReviewCriteriaSourceFor(title),
    title: { ...title },
    policyVersion: VIDEO_REVIEW_POLICY_VERSION,
    allowedContentLanguageCodes: XP_HERO_ALLOWED_CONTENT_LANGUAGE_CODES,
    rulecheckSummary: {
      schema: VIDEO_REVIEW_RULECHECK_SUMMARY.schema,
      generatedAt: VIDEO_REVIEW_RULECHECK_SUMMARY.generatedAt,
      counts: {
        totalRecords: VIDEO_REVIEW_RULECHECK_SUMMARY.counts.totalRecords,
        trainReady: VIDEO_REVIEW_RULECHECK_SUMMARY.counts.trainReady,
        byRule: VIDEO_REVIEW_RULECHECK_SUMMARY.counts.byRule,
      },
      dedupGroups: VIDEO_REVIEW_RULECHECK_SUMMARY.dedupGroups,
      scope: VIDEO_REVIEW_RULECHECK_SUMMARY.scope,
    },
    // Prompt metadata is intentionally compact: the persisted criteria metadata below retains
    // every display/audit field, while the model receives each policy statement and only the
    // fields needed to classify evidence. This avoids repeating generic prose 24 times per call.
    rules: videoReviewRulesFor(title).map((item) => ({
      id: item.id,
      key: item.key,
      statement: item.statement,
      assessment: item.assessment,
      judgeFrom: item.judgeFrom,
      appliesToTracks: item.appliesToTracks,
      checkKey: item.checkKey,
      verdictIfViolated: item.verdictIfViolated,
      canAutoReject: item.canAutoReject,
      requiresHumanConfirmation: item.requiresHumanConfirmation,
      ...(item.notes !== DEFAULT_MISSING_EVIDENCE_NOTE ? { notes: item.notes } : {}),
    })),
    boundaries: {
      pii: "Do not include identity, emails, tokens, raw URLs, local file names, comments, operator rejection-reason text, dataset rows, prompt text, human case labels, or label outcome counts.",
      evidence: "Return one evidence item per rule. Missing, unavailable, ambiguous, or low-confidence evidence is unknown and requires human review; it is never a model-invented failure.",
      textOnly: "Text-only Judge B may only use server-derived deterministic/metadata evidence. Multimodal and human-only rules remain unknown.",
      multimodal: "Multimodal Judge B may report sampled-media evidence for multimodal rules. Deterministic/metadata evidence remains server-authoritative. R10 and R11 observations are assistive and always require human confirmation; human-only rules remain unknown until a person or approved rights/analytics workflow resolves them.",
    },
  };
}

export function videoReviewCriteriaPromptBlock(title: VideoReviewRubricTitle = DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE): string {
  return JSON.stringify(videoReviewCriteriaPromptMetadata(title));
}

export function videoReviewCriteriaMetadata(title: VideoReviewRubricTitle = DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE) {
  return {
    source: videoReviewCriteriaSourceFor(title),
    title: { ...title },
    policyVersion: VIDEO_REVIEW_POLICY_VERSION,
    allowedContentLanguageCodes: XP_HERO_ALLOWED_CONTENT_LANGUAGE_CODES,
    rulecheckSummary: VIDEO_REVIEW_RULECHECK_SUMMARY,
    rules: videoReviewRulesFor(title).map((item) => ({ ...item })),
  };
}

export function ruleApplicabilityForTracks(
  tracks: readonly VideoReviewTrack[],
  title: VideoReviewRubricTitle = DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE,
) {
  return Object.fromEntries(videoReviewRulesFor(title).map((item) => {
    const applies = tracks.some((track) => item.appliesToTracks.includes(track));
    const status: VideoReviewRuleStatus = tracks.length ? (applies ? "applicable" : "not_applicable") : "unknown";
    return [item.id, {
      status,
      key: item.key,
      checkKey: item.checkKey,
      reason: item.reason,
      assessment: item.assessment,
      judgeFrom: item.judgeFrom,
      aiJudgeable: item.aiJudgeable,
      missingEvidence: item.missingEvidence,
      canAutoReject: item.canAutoReject,
      requiresHumanConfirmation: item.requiresHumanConfirmation,
      appliesToTracks: item.appliesToTracks,
    }];
  }));
}

export function videoReviewRuleById(
  ruleId: unknown,
  title: VideoReviewRubricTitle = DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE,
): VideoReviewRuleDescriptor | null {
  return typeof ruleId === "string" ? videoReviewRulesFor(title).find((item) => item.id === ruleId) ?? null : null;
}

/**
 * W121: 룰 키 → **크리에이터 안전 영문 문구** 사전(반려/변경요청 메일의 사유 불릿 원천).
 *
 * 이 사전이 사유 태그 경로의 SEC-P0-009 경계 그 자체다. 검수 화면은 룰명·confidence 퍼센트를
 * 보지만 **메일에는 이 문장만** 나간다 — 룰 ID(R6)·룰명·퍼센트·AI/모델 언급은 한 글자도 넣지
 * 않는다. 태그는 이 사전의 키만 통과하므로(closed 카탈로그), 모델이 만든 자유 텍스트가 태그
 * 경로로 크리에이터에게 닿을 구조적 경로가 없다.
 *
 * ⚠️ 프런트 사본은 `src/lib/statusLabels.ts` 의 동명 상수다(배포 경계상 import 불가).
 *   W120 의 `REVIEW_REASON_CODE_MAIL_PRESETS` ↔ `VIDEO_RESULT_MAIL_CUSTOMER_MESSAGES` 쌍과
 *   같은 규율이고, 두 사본의 정합은 테스트가 못 박는다.
 * ⚠️ URL 을 넣지 않는다 — 포털 링크는 발송 시 재제출 CTA 로 자동 붙는다.
 */
export function videoReviewRuleTagMailPhrasesFor(
  title: VideoReviewRubricTitle = DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE,
): Readonly<Record<VideoReviewRuleKey, string>> {
  return {
  xp_hero_gameplay_relevance:
    `${title.name} gameplay is not the main subject of this video. Please make ${title.name} gameplay the focus and submit a new video.`,
  xp_hero_store_link:
    `The description is missing the ${title.name} store link assigned to you, or it points somewhere else. Please add the assigned link and resubmit.`,
  public_visibility:
    "The video could not be viewed at the link you submitted - it may be private, deleted, or mistyped. Set it to Public and resubmit the exact watch link.",
  edited_secondary_creation:
    "Plain gameplay recordings, reposts, and cut-only reuploads are not eligible. Add your own hook, commentary or reaction, or edited highlights.",
  duration_min_20s:
    "The video is shorter than the 20-second minimum, or it is a live-stream recording. Please submit a video of at least 20 seconds.",
  xp_hero_exact_name:
    `The game name is not written exactly as ${title.name} in the video or the description. Please correct it and resubmit.`,
  allowed_content_language:
    "The spoken or written language of this video is not one of the languages this campaign accepts.",
  required_hashtags:
    `The description is missing the required hashtags: ${joinWithAnd(title.requiredHashtags)}.`,
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
}

/** gameId 를 모르는 레거시 호출부의 기본 문구집(= 프로그램 기본 타이틀). */
export const VIDEO_REVIEW_RULE_TAG_MAIL_PHRASES: Readonly<Record<VideoReviewRuleKey, string>> =
  videoReviewRuleTagMailPhrasesFor();

/** 한 통의 메일이 실을 수 있는 사유 태그 상한. 그 이상은 읽히지 않고 사유가 흐려진다. */
export const VIDEO_REVIEW_REASON_TAG_MAX = 5;

/** closed 카탈로그 검증 — 사전에 없는 키는 태그가 될 수 없다(콜러블·렌더러 공용). */
export function isVideoReviewRuleTagKey(value: unknown): value is VideoReviewRuleKey {
  return typeof value === "string"
    && Object.prototype.hasOwnProperty.call(VIDEO_REVIEW_RULE_TAG_MAIL_PHRASES, value);
}

/** 미등록 키는 빈 문자열 — 호출부가 그 태그를 메일에서 통째로 뺀다. */
export function videoReviewRuleTagPhrase(
  ruleKey: unknown,
  title: VideoReviewRubricTitle = DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE,
): string {
  return isVideoReviewRuleTagKey(ruleKey) ? videoReviewRuleTagMailPhrasesFor(title)[ruleKey] : "";
}
