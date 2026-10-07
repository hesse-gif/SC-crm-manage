// 크리에이터 국가 표시의 정본 해석기.
//
// creators 문서는 국가를 세 곳에 담는다: `countryCode` · `country` · `region`(운영 373/434건이 region).
// 표면마다 이 질문에 따로 답하면 값이 갈리므로(핸드오프 원칙 2) 해석은 여기 한 곳에만 둔다.
//
// ⚠️ 절단 금지: 이전 검수 큐 구현은 `value.trim().slice(0, 2).toUpperCase()` 로 잘라서
// "United Kingdom" → "UN", "GLOBAL" → "GL"(그린란드), "unknown" → "UN" 처럼 **없는 국가를 만들어냈다**
// (2026-07-25 운영 실측 4건). 2자 코드가 아니면 통과시키지 않고 미확인으로 남긴다 — 붙지 않는 값은
// 날조하지 않는다.
//
// 반환값에 출처 필드를 함께 담는다. 정산 국가(country.verified/effective)와 구분해 "출처=creators.region"
// 처럼 라벨을 달아 노출해야 하기 때문이다(핸드오프 원칙 3: 파생은 출처를 표시한다).

export const CREATOR_COUNTRY_SOURCE_FIELDS = ["countryCode", "country", "region"] as const;

export type CreatorCountrySourceField = (typeof CREATOR_COUNTRY_SOURCE_FIELDS)[number];

export interface CreatorCountryProjection {
  /** 정확히 두 자리 ASCII 알파벳일 때만 대문자 코드, 아니면 null. */
  readonly code: string | null;
  /** 값을 읽어온 필드 — 화면 출처 라벨용. code 가 null 이면 null. */
  readonly sourceField: CreatorCountrySourceField | null;
}

const ISO_ALPHA2 = /^[A-Za-z]{2}$/;

const UNRESOLVED: CreatorCountryProjection = { code: null, sourceField: null };

export function resolveCreatorCountryProjection(
  data: Record<string, unknown> | null | undefined,
): CreatorCountryProjection {
  if (!data) return UNRESOLVED;
  for (const field of CREATOR_COUNTRY_SOURCE_FIELDS) {
    const raw = data[field];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!ISO_ALPHA2.test(trimmed)) continue;
    return { code: trimmed.toUpperCase(), sourceField: field };
  }
  return UNRESOLVED;
}
