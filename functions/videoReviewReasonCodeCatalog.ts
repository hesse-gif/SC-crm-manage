// Task-100 갭 ②: 검수 판정 reasonCode 표준화.
//
// 4개 생산 레인(CanonicalVideoReviewPanel · videoReviewAnalysisJudge · scpSheetReviewSync ·
// scpIntegrationEventV2)이 각자 other_documented/operator_*/시트매핑/추천토큰을 자유롭게 적어 왔다
// (transitionVideoReviewDecision 이 카탈로그 멤버십을 검증하지 않았다). 이 파일은 그 유일한 쓰기
// 경로(videoReviewTransitionStore.transitionVideoReviewDecision)에서 값을 **closed 카탈로그**로
// 정규화한다 — video_resubmission_cycles 원장의 reasonCode 축이 이 정규화 없이는 4가지 방언을
// 그대로 물려받아 사유별 집계(resubmissionCycleMetrics)가 흩어진다.
//
// ⚠️ 정규화는 **새 필드**(reasonCodeRaw/reasonCodeNormalized)로만 나타난다 — 기존
//   ledgerEntry.reasonCode/아웃박스 reasonCode(= input.reasonCode 그대로)는 메일 문구 지도
//   (scpOutboxMailWorkers.VIDEO_RESULT_MAIL_CUSTOMER_MESSAGES)가 그대로 읽으므로 **건드리지 않는다**
//   — 정규화가 "policy_violation" 같은 기존 값을 "other_documented" 로 덮으면 그 값에 매핑된
//   구체적 문구가 사라지고 크리에이터는 제네릭 문장만 받는다(기존 생산자가 깨지면 안 된다는
//   과제 지시와 정면 충돌). 값을 아는 소비자는 새 필드를, 기존 소비자는 옛 필드를 그대로 쓴다.
//
// 카탈로그 = REVIEW_REASON_CODES(운영 화면 사유 코드 7종) ∪ VideoReviewRuleKey(룰 태그 24종).
// 두 카탈로그 모두 배포 경계(functions/ ↔ src/) 때문에 프런트/서버가 각자 사본을 든다 — 이 파일은
// **서버 사본**이다. 프런트 정본은 src/lib/statusLabels.ts REVIEW_REASON_CODES 이고, 값이 갈리면
// tests/review-reason-code-normalize.test.mjs 의 상수 대조가 red 다(VIDEO_REVIEW_RULE_TAG_MAIL_PHRASES
// 가 이미 쓰는 것과 같은 규율 — videoReviewCriteria.ts:349-351 주석 참고).

import { isVideoReviewRuleTagKey } from "./videoReviewCriteria";

/**
 * 운영 화면 사유 코드 7종의 서버 사본. 정본은 `src/lib/statusLabels.ts` `REVIEW_REASON_CODES` —
 * 값을 바꾸면 **양쪽을 같은 커밋에서** 바꾼다.
 */
export const SERVER_VIDEO_REVIEW_REASON_CODES: readonly string[] = [
  "policy_gate_failed",
  "content_quality",
  "wrong_video",
  "duplicate_content",
  "video_unavailable",
  "metadata_mismatch",
  "other_documented",
];

/** 카탈로그 멤버십 = 사유 코드 7종 ∪ 룰 태그 24종. */
export function isKnownVideoReviewReasonCode(value: unknown): boolean {
  return typeof value === "string"
    && value.length > 0
    && (SERVER_VIDEO_REVIEW_REASON_CODES.includes(value) || isVideoReviewRuleTagKey(value));
}

/** other_documented 로 정규화될 때 원래 값을 담는 필드의 최대 길이 — 감사용, 자유 텍스트 상한. */
const REASON_CODE_RAW_MAX_LENGTH = 200;

export type NormalizedVideoReviewReasonCode = {
  /** 카탈로그 안이면 원값 그대로, 밖이면 "other_documented". 빈 입력은 빈 문자열(무판단). */
  reasonCode: string;
  /** 정규화가 값을 바꿨을 때만 원래 값(감사용). 그대로 통과했으면 null. */
  reasonCodeRaw: string | null;
  /** true = 카탈로그 안(또는 빈 입력). false = other_documented 로 강등됨. */
  reasonCodeNormalized: boolean;
};

/**
 * 쓰기 경로 전용 정규화. **던지지 않는다** — 카탈로그 밖 값도 other_documented 로 받아 적고
 * 원래 값은 reasonCodeRaw 에 보존한다(과제 지시: "기존 생산자가 깨지면 안 된다").
 */
/**
 * Task-100 F-6: 독려 메일의 {{reason_message}} 문구. `src/lib/statusLabels.ts`
 * `REVIEW_REASON_CODE_MAIL_PRESETS` 와 같은 문구를 쓴다(배포 경계상 사본 — 값이 갈리면
 * tests/review-reason-code-normalize.test.mjs 가 red). 미등록/other_documented 는 중립 문구.
 */
const REASON_CODE_NUDGE_PHRASES: Readonly<Record<string, string>> = {
  policy_gate_failed: "Your submission did not meet the campaign content policy.",
  content_quality: "Plain gameplay walkthroughs are not eligible - your video needs your own hook, commentary or reaction, or edited highlights.",
  wrong_video: "The link pointed to a different video than the one registered for this campaign.",
  duplicate_content: "This video was already submitted.",
  video_unavailable: "The video at your link could not be viewed - it may be private, deleted, or mistyped.",
  metadata_mismatch: "The submitted video did not match the required campaign details.",
};
const REASON_CODE_NUDGE_PHRASE_FALLBACK = "Your submission did not meet the campaign requirements.";

/** other_documented·미등록 코드는 중립 문구로 닫는다(자유 텍스트를 메일에 그대로 실지 않는다). */
export function videoReviewReasonCodeNudgePhrase(reasonCode: unknown): string {
  const key = typeof reasonCode === "string" ? reasonCode.trim() : "";
  return REASON_CODE_NUDGE_PHRASES[key] ?? REASON_CODE_NUDGE_PHRASE_FALLBACK;
}

export function normalizeVideoReviewReasonCode(raw: unknown): NormalizedVideoReviewReasonCode {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return { reasonCode: "", reasonCodeRaw: null, reasonCodeNormalized: true };
  }
  if (isKnownVideoReviewReasonCode(trimmed)) {
    return { reasonCode: trimmed, reasonCodeRaw: null, reasonCodeNormalized: true };
  }
  return {
    reasonCode: "other_documented",
    reasonCodeRaw: trimmed.slice(0, REASON_CODE_RAW_MAX_LENGTH),
    reasonCodeNormalized: false,
  };
}
