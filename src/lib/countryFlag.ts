// Flu — ISO alpha-2 → regional-indicator 국기 변환 공용 유틸.
//
// ReviewWorkspace.tsx 에 있던 변환을 B2 운영 모니터링과 공유하려고 추출했다(계약: CMUX-HANDOFF §6
// "국기는 ReviewWorkspace 의 ISO alpha-2 → regional-indicator 변환을 공용 유틸로 추출해 재사용").
// 판정 규칙은 그대로다: **검증된 2자 ISO 코드만** 국기로 바꾸고, invalid/unknown 은 국기를 만들지
// 않는다(중립 아이콘 + "확인 대기"는 호출자가 표시한다).

export const REGIONAL_INDICATOR_FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;

const REGIONAL_INDICATOR_BASE = 127397;

/** ISO alpha-2 가 아니면 빈 문자열. `ZZ`(미상)는 국가로 승격하지 않는다. */
export function flagEmojiFromIsoCode(code: unknown): string {
  const normalized = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(normalized) || normalized === "ZZ") return "";
  return Array.from(normalized)
    .map((char) => String.fromCodePoint(REGIONAL_INDICATOR_BASE + char.charCodeAt(0)))
    .join("");
}

/** 국기로 바꿀 수 있는 코드인지. 화면에서 "확인 대기" 로 떨어뜨릴지 판단할 때 쓴다. */
export function isDisplayableIsoCountryCode(code: unknown): boolean {
  return flagEmojiFromIsoCode(code).length > 0;
}
