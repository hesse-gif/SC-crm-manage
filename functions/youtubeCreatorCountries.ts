export const DEFAULT_YOUTUBE_CREATOR_COUNTRIES = ["US", "AU", "JP", "KR", "GB", "CA"] as const;

export type YoutubeCreatorCountry = typeof DEFAULT_YOUTUBE_CREATOR_COUNTRIES[number] | string;
export type CountryScope = "inherit" | "all" | "include";

export type CountryTargeting = {
  readonly countryScope: CountryScope;
  readonly includedCountries: string[];
  readonly excludedCountries: string[];
};

export type YoutubeCreatorCountryDecision =
  | { readonly allowed: true; readonly country: string; readonly reason: "country_allowed" }
  | { readonly allowed: false; readonly country: string; readonly reason: "country_not_allowed" }
  | { readonly allowed: false; readonly country: null; readonly reason: "country_unknown_excluded" };

export type YoutubeCreatorCountryPolicyDecision =
  | { readonly accepted: true; readonly country: string | null; readonly decision: "countryAllowed" }
  | { readonly accepted: false; readonly country: string; readonly decision: "excludedByIncludedCountries" }
  | { readonly accepted: false; readonly country: string; readonly decision: "excludedByExplicitCountry" }
  | { readonly accepted: false; readonly country: null; readonly decision: "unknownCountryHeld"; readonly heldForReview: true };

export type YoutubeCreatorCountryFilterResult<T extends Record<string, unknown>> = {
  readonly kept: Array<T & {
    readonly creatorCountry: string;
    readonly countryFilterReason: "country_allowed";
  }>;
  readonly excluded: Array<{
    readonly item: T;
    readonly country: string | null;
    readonly reason: Exclude<YoutubeCreatorCountryDecision["reason"], "country_allowed">;
  }>;
  readonly allowlist: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function owns(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function normalizeYoutubeCreatorCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return null;
  return normalized === "UK" ? "GB" : normalized;
}

/**
 * W127 — **ISO 3166-1 alpha-2 실배정 코드 전량**(2023년 CQ/Sark 추가 반영, 250개).
 *
 * `^[A-Z]{2}$` 만으로는 부족한 이유: 두 글자면 무엇이든 통과하므로 CSV 임포트 같은 자유입력 경로에서
 * `XX`·`AA`·대륙 약어(`NA` 는 나미비아이지만 `EU`·`SA` 는 대륙 의도로 들어온다) 같은 값이 그대로
 * 국가로 승격된다. 국가 사다리(applicationInitialAudienceCountry 의 `firstCountryField`)는 이 값을
 * **처음 맞은 하나**로 채택하고 멈추므로, 한 번 들어온 가짜 코드가 그 지원 건의 국가로 굳는다.
 *
 * 예외·유보 코드는 **일부러 뺐다**: 예외 유보(AC·CP·DG·EA·EU·EZ·FX·IC·SU·TA·UK·UN),
 * 과도기 유보(AN·BU·CS·NT·TP·YU·ZR), 폐지(DD·DY·HV·NH·RH·VD·YD), 사용자 지정(QO·XA·XB·XK·ZZ).
 * `UK` 는 여기 없지만 버려지지 않는다 — 아래 정규화가 `GB` 로 매핑한다(이 파일의 기존 규칙과 같다).
 */
export const ISO_3166_1_ALPHA_2_CODES: readonly string[] = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT",
  "AU", "AW", "AX", "AZ", "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI",
  "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY",
  "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN",
  "CO", "CQ", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK",
  "DM", "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ",
  "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI",
  "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK",
  "HM", "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ",
  "IR", "IS", "IT", "JE", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM",
  "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR",
  "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH",
  "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV",
  "MW", "MX", "MY", "MZ", "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO",
  "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL",
  "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU",
  "RW", "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL",
  "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ", "TC", "TD",
  "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV",
  "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG",
  "VI", "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
];

const ISO_3166_1_ALPHA_2_SET = new Set(ISO_3166_1_ALPHA_2_CODES);

/**
 * W127 — 자유입력 국가 코드를 **실배정 alpha-2 로만** 통과시킨다. 아니면 `null`(추측 금지).
 *
 * `normalizeYoutubeCreatorCountry` 와 같은 형태 규칙(trim·대문자·`UK`→`GB`)을 쓰되 화이트리스트를
 * 한 겹 더 건다. 그쪽은 YouTube API 가 주는 값(이미 ISO)을 다루는 경로라 형태 검사로 충분했지만,
 * 사람이 만든 CSV 는 그 전제가 성립하지 않는다.
 */
export function normalizeIsoAlpha2Country(value: unknown): string | null {
  const normalized = normalizeYoutubeCreatorCountry(value);
  return normalized && ISO_3166_1_ALPHA_2_SET.has(normalized) ? normalized : null;
}

export function normalizeYoutubeCreatorCountries(values: readonly unknown[] | undefined): string[] {
  const countries = (values ?? [])
    .map(normalizeYoutubeCreatorCountry)
    .filter((country): country is string => country !== null);
  return Array.from(new Set(countries));
}

/**
 * Legacy allowlist callers still receive the configured default when the field
 * is absent, but an own explicit [] remains [] and therefore means all known
 * countries. This presence distinction is the G003 compatibility boundary.
 */
export function normalizeYoutubeCreatorCountryAllowlist(values: readonly unknown[] | undefined): string[] {
  return values === undefined
    ? [...DEFAULT_YOUTUBE_CREATOR_COUNTRIES]
    : normalizeYoutubeCreatorCountries(values);
}

export function normalizeCountryTargeting(value: unknown): CountryTargeting {
  const record = asRecord(value);
  const rawScope = typeof record.countryScope === "string" ? record.countryScope.trim().toLowerCase() : "";
  const includedCountries = normalizeYoutubeCreatorCountries(
    Array.isArray(record.includedCountries) ? record.includedCountries : undefined,
  );
  const excludedCountries = normalizeYoutubeCreatorCountries(
    Array.isArray(record.excludedCountries) ? record.excludedCountries : undefined,
  );
  const countryScope: CountryScope = rawScope === "all" || rawScope === "include" || rawScope === "inherit"
    ? rawScope
    : includedCountries.length > 0
      ? "include"
      : "inherit";
  return {
    countryScope,
    includedCountries: countryScope === "include" ? includedCountries : [],
    excludedCountries,
  };
}

/**
 * Preserve legacy own-property semantics:
 * - absent targetCountries => inherit
 * - own targetCountries=[] => explicit all
 * - own non-empty targetCountries => include
 * Explicit exclusions are retained for every scope.
 */
export function countryTargetingFromLegacy(
  value: unknown,
  options: {
    readonly targetCountriesKey?: string;
    readonly countryTargetingKey?: string;
    readonly excludedCountriesKey?: string;
  } = {},
): CountryTargeting {
  const record = asRecord(value);
  const countryTargetingKey = options.countryTargetingKey ?? "countryTargeting";
  const targetCountriesKey = options.targetCountriesKey ?? "targetCountries";
  const excludedCountriesKey = options.excludedCountriesKey ?? "excludedCountries";
  const direct = owns(record, countryTargetingKey)
    ? normalizeCountryTargeting(record[countryTargetingKey])
    : null;
  const extraExclusions = normalizeYoutubeCreatorCountries(
    Array.isArray(record[excludedCountriesKey]) ? record[excludedCountriesKey] as unknown[] : undefined,
  );
  if (direct) {
    return {
      ...direct,
      excludedCountries: Array.from(new Set([...direct.excludedCountries, ...extraExclusions])),
    };
  }
  if (!owns(record, targetCountriesKey)) {
    return {
      countryScope: "inherit",
      includedCountries: [],
      excludedCountries: extraExclusions,
    };
  }
  const targetCountries = normalizeYoutubeCreatorCountries(
    Array.isArray(record[targetCountriesKey]) ? record[targetCountriesKey] as unknown[] : [],
  );
  return targetCountries.length === 0
    ? { countryScope: "all", includedCountries: [], excludedCountries: extraExclusions }
    : { countryScope: "include", includedCountries: targetCountries, excludedCountries: extraExclusions };
}

export function resolveCountryTargeting(
  child: CountryTargeting,
  parent?: CountryTargeting,
): CountryTargeting {
  const normalizedChild = normalizeCountryTargeting(child);
  const normalizedParent = parent ? normalizeCountryTargeting(parent) : {
    countryScope: "all" as const,
    includedCountries: [],
    excludedCountries: [],
  };
  const inherited = normalizedChild.countryScope === "inherit" ? normalizedParent : normalizedChild;
  return {
    countryScope: inherited.countryScope === "inherit" ? "all" : inherited.countryScope,
    includedCountries: inherited.countryScope === "include" ? inherited.includedCountries : [],
    excludedCountries: Array.from(new Set([
      ...normalizedParent.excludedCountries,
      ...normalizedChild.excludedCountries,
    ])),
  };
}

export function youtubeCreatorCountryPolicyDecision(
  value: unknown,
  policy: CountryTargeting,
): YoutubeCreatorCountryPolicyDecision {
  const normalizedPolicy = resolveCountryTargeting(normalizeCountryTargeting(policy));
  const country = normalizeYoutubeCreatorCountry(value);
  if (!country) {
    // W15 F-1b [사용자 확정 2026-08-03]: 국가불명 held 를 정책 scope 조건부로 만든다.
    // scope=all 은 전 세계가 대상이라 국가 데이터 없이도 판정이 완결된다 → accept.
    // scope=include 는 포함 여부를 검증할 수 없으므로 현행 held 유지 — 이 비대칭이 안전 경계다.
    if (normalizedPolicy.countryScope === "all") {
      return { accepted: true, country: null, decision: "countryAllowed" };
    }
    return {
      accepted: false,
      country: null,
      decision: "unknownCountryHeld",
      heldForReview: true,
    };
  }
  if (normalizedPolicy.excludedCountries.includes(country)) {
    return { accepted: false, country, decision: "excludedByExplicitCountry" };
  }
  if (
    normalizedPolicy.countryScope === "include"
    && !normalizedPolicy.includedCountries.includes(country)
  ) {
    return { accepted: false, country, decision: "excludedByIncludedCountries" };
  }
  return { accepted: true, country, decision: "countryAllowed" };
}

export function youtubeCreatorCountryDecision(
  value: unknown,
  allowlist: readonly string[] = DEFAULT_YOUTUBE_CREATOR_COUNTRIES,
): YoutubeCreatorCountryDecision {
  const country = normalizeYoutubeCreatorCountry(value);
  if (!country) return { allowed: false, country: null, reason: "country_unknown_excluded" };
  const normalizedAllowlist = normalizeYoutubeCreatorCountryAllowlist(allowlist);
  return normalizedAllowlist.length === 0 || normalizedAllowlist.includes(country)
    ? { allowed: true, country, reason: "country_allowed" }
    : { allowed: false, country, reason: "country_not_allowed" };
}

export function filterYoutubeCreatorsByCountry<T extends Record<string, unknown>>(
  items: readonly T[],
  options: {
    readonly allowlist?: readonly string[];
    readonly countryOf: (item: T) => unknown;
  },
): YoutubeCreatorCountryFilterResult<T> {
  const allowlist = normalizeYoutubeCreatorCountryAllowlist(options.allowlist);
  const kept: YoutubeCreatorCountryFilterResult<T>["kept"] = [];
  const excluded: YoutubeCreatorCountryFilterResult<T>["excluded"] = [];

  for (const item of items) {
    const decision = youtubeCreatorCountryDecision(options.countryOf(item), allowlist);
    if (decision.allowed) {
      kept.push({
        ...item,
        creatorCountry: decision.country,
        countryFilterReason: decision.reason,
      });
    } else {
      excluded.push({
        item,
        country: decision.country,
        reason: decision.reason,
      });
    }
  }

  return { kept, excluded, allowlist };
}
