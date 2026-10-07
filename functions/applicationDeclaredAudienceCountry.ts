// Flu — Apply 신고 오디언스 국가 추출(순수, B2-7).
//
// 계약(B2-AUDIENCE-INGRESS-DATA-CONTRACT §2.1): 보호 자료(protected application material)에서
// **allowlist 필드만** 읽어 normalized ISO alpha-2 로 만든다. raw 지원서 answers 전체를 복사하지
// 않고, 없으면 null(추측 금지). `ZZ`(미상)·비 ISO 값은 국가로 승격하지 않는다.
//
// 런타임 import 없음 — 노드 테스트 레인이 이 판정을 그대로 행위 테스트할 수 있어야 한다.

/** 보호 자료에서 읽어도 되는 필드 이름 화이트리스트(스칼라 값). 이 밖의 키는 쳐다보지 않는다. */
export const DECLARED_AUDIENCE_COUNTRY_ALLOWLIST = [
  "declaredPrimaryAudienceCountry",
  "primaryAudienceCountry",
] as const;

// R25-A [운영 실측: scp_application_management 전수 17건 중 declaredPrimaryAudienceCountry 보유
// 0건]. 위 2필드는 존재만 하고 실제로 채워진 적이 없었다 — 포털 실물 apply 폼(scp-creator-portal
// src/features/creator-apply/model.ts:97,222)은 이 스칼라 필드가 아니라
// `audienceMajorityCountries: readonly string[]`(1~5개, COUNTRY_OPTIONS=ISO alpha-2 코드 자체에서
// 선택 — 라벨이 아니다)로 신고받는다. 위 2필드가 쓰이는 곳은 OAuth/geo 리포트 경로다(apply 폼과
// 무관). 이 배열도 whitelist 에 넣는다 — 다만 값이 배열이라 스칼라 필드와 다른 핸들링이 필요하다
// (아래 declaredAudienceCountryFromMaterial 참고).
export const DECLARED_AUDIENCE_COUNTRY_ARRAY_ALLOWLIST = [
  "audienceMajorityCountries",
] as const;

export function normalizedIsoAlpha2(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) && upper !== "ZZ" ? upper : null;
}

/** 허용된 필드에서만 신고 국가를 뽑는다. 없으면 null. */
export function declaredAudienceCountryFromMaterial(material: unknown): string | null {
  if (!material || typeof material !== "object" || Array.isArray(material)) return null;
  const record = material as Record<string, unknown>;
  for (const field of DECLARED_AUDIENCE_COUNTRY_ALLOWLIST) {
    const code = normalizedIsoAlpha2(record[field]);
    if (code) return code;
  }
  // R25-A: 배열 whitelist — 사용자가 고른 순서의 **첫 항목만** primary 로 정규화한다. 라벨/비ISO/
  // ZZ 는 normalizedIsoAlpha2 가 그대로 걸러낸다(승격 금지 불변 유지). 빈 배열이면 아래로 떨어져
  // null(추측 금지).
  for (const field of DECLARED_AUDIENCE_COUNTRY_ARRAY_ALLOWLIST) {
    const value = record[field];
    if (Array.isArray(value) && value.length > 0) {
      const code = normalizedIsoAlpha2(value[0]);
      if (code) return code;
    }
  }
  return null;
}
