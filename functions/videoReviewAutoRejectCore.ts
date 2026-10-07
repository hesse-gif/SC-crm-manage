// Task-94: 제출 콘텐츠 자동 검수와 자동 반려 — deterministic 코어.
//
// 다툼 없는 2개 위반만 확정 반려로 판정한다: r5_duration_below_min(20초 미만) ·
// r3_video_unavailable(영상 확인 불가). r8_required_hashtags_absent(필수 해시태그 누락)는
// 사람 검수 근거로만 남기고 자동 반려로 승격하지 않는다. LLM 미사용, I/O 없음 — 호출부가
// 이미 만들어 둔 facts(evidence envelope + youtubeMetadata + settings)만 받는다.
//
// 판정 불가(unknown) 사실은 절대 반려로 승격하지 않는다(fail-closed) — 한 룰이 unknown 이어도
// 다른 룰이 확정 위반이면 전체는 auto_reject 다(그 위반은 여전히 확정 사실이므로).
//
// r8(필수 해시태그)은 W107 규율을 그대로 물려받는다: "텍스트 부재 ≠ hard fail" — 이 코어에서는
// "설명 텍스트 자체를 못 읽었다"(r8_youtube_metadata_unavailable)와 "텍스트는 읽었는데 해시태그가
// 없다"(r8_required_hashtags_not_in_text)를 구분하되, 둘 다 auto_reject 후보가 아니다. 이 구분은
// videoReviewEvidence.ts 의 R8 트러스트 facts 를 그대로 재사용한다 — 텍스트를 다시 파싱하지 않는다
// (SEC-P0-009 경계 재사용, 로직 이중화 방지).
import type { VideoReviewRuleKey } from "./videoReviewCriteria";

export type VideoReviewAutoRejectVerdict = "auto_reject" | "pass" | "unknown";

export type VideoReviewAutoRejectRuleKey =
  | "r5_duration_below_min"
  | "r3_video_unavailable"
  | "r8_required_hashtags_absent";

export const VIDEO_REVIEW_AUTO_REJECT_RULE_KEYS: readonly VideoReviewAutoRejectRuleKey[] = [
  "r5_duration_below_min",
  "r3_video_unavailable",
  "r8_required_hashtags_absent",
];

/** videoReviewEvidence.ts 의 R8 트러스트 fact 코드 — 재사용(재파싱 금지). */
export type VideoReviewAutoRejectHashtagsEvidenceCode =
  | "r8_required_hashtags_present"
  | "r8_required_hashtags_not_in_text"
  | "r8_youtube_metadata_unavailable";

export interface VideoReviewAutoRejectFacts {
  /** YouTube contentDetails.duration 에서 파싱된 초. 모르면 null. */
  durationSeconds: number | null;
  /** settings.automation.videoReview.minDurationSeconds (기본 20). */
  minDurationSeconds: number;
  /** YouTube status.privacyStatus 원문(소문자). 모르면 null. */
  privacyStatus: string | null;
  /** videosList 응답에 영상 자체가 없었다(삭제/오타 등, producerFailures 의 youtube_video_not_found). */
  videoNotFound: boolean;
  /** produceVideoReviewEvidence 가 만든 R8 트러스트 fact 의 code. 그 fact 자체가 없으면 null. */
  hashtagsEvidenceCode: VideoReviewAutoRejectHashtagsEvidenceCode | null;
}

export interface VideoReviewAutoRejectRuleResult {
  ruleKey: VideoReviewAutoRejectRuleKey;
  verdict: VideoReviewAutoRejectVerdict;
}

export interface VideoReviewAutoRejectDecision {
  verdict: VideoReviewAutoRejectVerdict;
  /** auto_reject 일 때 실제로 위반한 룰 전부(우선순위: duration → visibility → hashtags). */
  ruleKeys: VideoReviewAutoRejectRuleKey[];
  /** REVIEW_REASON_CODES(src/lib/statusLabels.ts) 카탈로그의 값 — auto_reject 가 아니면 null. */
  reasonCode: string | null;
  /** 위반한 룰의 정본 룰 ID(R3/R5/R8) — 근거 추적용. */
  evidenceRefs: string[];
  rules: VideoReviewAutoRejectRuleResult[];
}

/** ruleKey → 정본 룰 ID(videoReviewCriteria.ts 의 R3/R5/R8). */
const RULE_EVIDENCE_REF: Record<VideoReviewAutoRejectRuleKey, string> = {
  r5_duration_below_min: "R5",
  r3_video_unavailable: "R3",
  r8_required_hashtags_absent: "R8",
};

/**
 * ruleKey → REVIEW_REASON_CODES(src/lib/statusLabels.ts) 비즈니스 사유 코드. `video_unavailable`
 * 은 그 카탈로그에 이미 있는 1:1 대응(W120 실데이터 반려 1위 유형)이라 그대로 쓴다. duration/
 * hashtag 는 전용 코드가 카탈로그에 없어 "정책 기준 미충족"으로 묶는다 — 세부 사유는
 * reasonTagKeys(아래 매핑)로 크리에이터 메일 문구에 남는다.
 */
const RULE_REASON_CODE: Record<VideoReviewAutoRejectRuleKey, string> = {
  r5_duration_below_min: "policy_gate_failed",
  r3_video_unavailable: "video_unavailable",
  r8_required_hashtags_absent: "policy_gate_failed",
};

/** ruleKey → videoReviewCriteria.ts 의 기존 룰 태그 키(R3/R5/R8 과 1:1) — 반려 메일 사유 불릿용. */
export const AUTO_REJECT_RULE_TAG_KEYS: Record<VideoReviewAutoRejectRuleKey, VideoReviewRuleKey> = {
  r5_duration_below_min: "duration_min_20s",
  r3_video_unavailable: "public_visibility",
  r8_required_hashtags_absent: "required_hashtags",
};

function evaluateDurationRule(facts: VideoReviewAutoRejectFacts): VideoReviewAutoRejectRuleResult {
  const ruleKey: VideoReviewAutoRejectRuleKey = "r5_duration_below_min";
  if (facts.durationSeconds === null || !Number.isFinite(facts.durationSeconds)) {
    return { ruleKey, verdict: "unknown" };
  }
  return { ruleKey, verdict: facts.durationSeconds < facts.minDurationSeconds ? "auto_reject" : "pass" };
}

function evaluateVisibilityRule(facts: VideoReviewAutoRejectFacts): VideoReviewAutoRejectRuleResult {
  const ruleKey: VideoReviewAutoRejectRuleKey = "r3_video_unavailable";
  if (facts.videoNotFound) return { ruleKey, verdict: "auto_reject" };
  const status = (facts.privacyStatus ?? "").trim().toLowerCase();
  if (!status) return { ruleKey, verdict: "unknown" };
  // R3 statement: "must resolve to the intended video and be publicly viewable" — private and
  // unlisted are both not publicly viewable (existing videoReviewJudgeService.ts R3 logic agrees).
  if (status === "private" || status === "unlisted") return { ruleKey, verdict: "auto_reject" };
  if (status === "public") return { ruleKey, verdict: "pass" };
  return { ruleKey, verdict: "unknown" };
}

function evaluateHashtagsRule(facts: VideoReviewAutoRejectFacts): VideoReviewAutoRejectRuleResult {
  const ruleKey: VideoReviewAutoRejectRuleKey = "r8_required_hashtags_absent";
  switch (facts.hashtagsEvidenceCode) {
    case "r8_required_hashtags_present":
      return { ruleKey, verdict: "pass" };
    case "r8_required_hashtags_not_in_text":
      // Task-94 2026-09-17 policy: description text absence of hashtags cannot rule out
      // on-screen placement, so R8 remains human-gated even when the text was readable.
      return { ruleKey, verdict: "unknown" };
    // Text itself unavailable (fetch failed / no YouTube candidate at all) or no fact produced yet
    // — text absent ≠ hard fail, stays unknown pending human review.
    case "r8_youtube_metadata_unavailable":
    default:
      return { ruleKey, verdict: "unknown" };
  }
}

export function evaluateVideoReviewAutoReject(
  facts: VideoReviewAutoRejectFacts,
): VideoReviewAutoRejectDecision {
  const rules = [evaluateDurationRule(facts), evaluateVisibilityRule(facts), evaluateHashtagsRule(facts)];
  const violated = rules.filter((rule) => rule.verdict === "auto_reject");
  if (violated.length > 0) {
    return {
      verdict: "auto_reject",
      ruleKeys: violated.map((rule) => rule.ruleKey),
      reasonCode: RULE_REASON_CODE[violated[0].ruleKey],
      evidenceRefs: violated.map((rule) => RULE_EVIDENCE_REF[rule.ruleKey]),
      rules,
    };
  }
  const hasUnknown = rules.some((rule) => rule.verdict === "unknown");
  return {
    verdict: hasUnknown ? "unknown" : "pass",
    ruleKeys: [],
    reasonCode: null,
    evidenceRefs: [],
    rules,
  };
}
