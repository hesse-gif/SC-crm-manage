import type { Campaign, CampaignTargetMetric, CountryScope, CountryTargeting, Priority, UpdateCampaignControlPayload } from "./data";
import { isCancelledCampaignStatus } from "./campaign-status";
export {
  DEFAULT_CAMPAIGN_MAIL_BODY,
  DEFAULT_CAMPAIGN_MAIL_SUBJECT,
  extractMarkdownLinks,
  templateLinkCount,
  type MarkdownSegment,
} from "./campaignMailTemplate";

export const CAMPAIGN_COUNTRY_OPTIONS = [
  { code: "KR", label: "한국 (Korean)" },
  { code: "CN", label: "중국 (中文)" },
  { code: "US", label: "미국 (English)" },
  { code: "GB", label: "영국 (English)" },
  { code: "JP", label: "일본 (日本語)" },
  { code: "CA", label: "캐나다 (English)" },
  { code: "AU", label: "호주 (English)" },
  { code: "NZ", label: "뉴질랜드 (English)" },
  { code: "IE", label: "아일랜드 (English)" },
  { code: "BR", label: "브라질 (Português)" },
  { code: "ID", label: "인도네시아 (Indonesia)" },
  { code: "ES", label: "스페인 (Español)" },
  { code: "VN", label: "베트남 (Tiếng Việt)" },
  { code: "TH", label: "태국 (ไทย)" },
  { code: "DE", label: "독일 (Deutsch)" },
  { code: "FR", label: "프랑스 (Français)" },
] as const;

export const CAMPAIGN_COUNTRY_PRESETS = [
  { id: "kr-us-gb-jp", label: "한국 · 미국 · 영국 · 일본", codes: ["KR", "US", "GB", "JP"] },
  { id: "us-gb-ca-au", label: "미국 · 영국 · 캐나다 · 호주", codes: ["US", "GB", "CA", "AU"] },
  { id: "kr-jp-us", label: "한국 · 일본 · 미국", codes: ["KR", "JP", "US"] },
] as const;

export const CAMPAIGN_TEMPLATE_PLACEHOLDERS = [
  { key: "creatorName", label: "크리에이터명" },
  { key: "channelName", label: "채널명" },
  { key: "gameTitle", label: "게임명" },
  { key: "campaignName", label: "캠페인명" },
  { key: "country", label: "대상 국가" },
  { key: "senderName", label: "담당자" },
  { key: "name", label: "크리에이터명 (기존 템플릿 호환)" },
  { key: "creator", label: "크리에이터명 (기존 템플릿 호환)" },
  { key: "game", label: "게임명 (기존 템플릿 호환)" },
  { key: "campaign", label: "캠페인명 (기존 템플릿 호환)" },
  { key: "owner", label: "담당자명 (기존 템플릿 호환)" },
  // W48-1: 프로그램 콜드메일 쓰기 경로는 본문에 {{apply_link}}/{{form_link}} 가 없으면 저장을
  // 거부한다(functions/admin.ts PROGRAM_COLDMAIL_ALLOWED_PLACEHOLDERS 에도 이미 있다). 캠페인
  // 위저드는 그 원본을 그대로 상속하므로, 여기서 "지원하지 않는 변수"로 잘못 막으면 안 된다.
  { key: "apply_link", label: "지원 링크" },
  { key: "form_link", label: "지원 링크 (기존 템플릿 호환)" },
] as const;

const VALID_PRIORITIES: Priority[] = ["긴급", "높음", "보통"];
const VALID_SOURCES: Campaign["source"][] = ["CSV", "검색", "추천"];
const VALID_STATUSES: Campaign["status"][] = ["대기", "발송중", "완료", "예약"];
const VALID_TARGET_METRICS: CampaignTargetMetric[] = ["partners", "sent", "replied", "negotiating", "contracted", "live"];
const VALID_MAIL_BODY_FORMATS = new Set(["markdown", "text", "html"]);
export type CampaignCountryAllocation = { country: string; weight: number };

export type CampaignControlPayloadBaseline = {
  name: string;
  targetMetric: CampaignTargetMetric;
  targetValue: number;
  outreachQuota: number;
  priority: Priority;
  allowInflyOverlap: boolean;
};

export type CampaignControlPayloadDraft = CampaignControlPayloadBaseline & {
  countryTargeting: CountryTargeting;
  targetingCriteria: NonNullable<UpdateCampaignControlPayload["targetingCriteria"]>;
  liveSendCap?: number;
  liveSendCapReason?: string;
  dailyCap?: number;
};

export function buildCampaignControlUpdatePayload(input: {
  programId: string;
  campaignId: string;
  expectedVersion: number;
  baseline: CampaignControlPayloadBaseline;
  draft: CampaignControlPayloadDraft;
}): UpdateCampaignControlPayload {
  const baseline = input.baseline;
  const draft = input.draft;
  return {
    programId: input.programId,
    campaignId: input.campaignId,
    expectedVersion: input.expectedVersion,
    ...(draft.targetMetric !== baseline.targetMetric ? { targetMetric: draft.targetMetric } : {}),
    ...(Math.round(draft.targetValue) !== baseline.targetValue ? { targetValue: Math.round(draft.targetValue) } : {}),
    ...(Math.round(draft.outreachQuota) !== baseline.outreachQuota ? { outreachQuota: Math.round(draft.outreachQuota) } : {}),
    ...(draft.priority !== baseline.priority ? { priority: draft.priority } : {}),
    ...(draft.name !== baseline.name ? { name: draft.name } : {}),
    countryTargeting: draft.countryTargeting,
    targetingCriteria: draft.targetingCriteria,
    ...(draft.allowInflyOverlap !== baseline.allowInflyOverlap ? { allowInflyOverlap: draft.allowInflyOverlap } : {}),
    ...(typeof draft.liveSendCap === "number" && draft.liveSendCap > 0
      ? {
          liveSendCap: Math.round(draft.liveSendCap),
          liveSendCapReason: draft.liveSendCapReason ?? "",
        }
      : {}),
    ...(typeof draft.dailyCap === "number" ? { dailyCap: Math.round(draft.dailyCap) } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function owns(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function cleanString(value: unknown, fallback: string, maxLength = 200): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, maxLength) : fallback;
}

function cleanNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
}

function normalizeMailBodyFormat(value: unknown): "markdown" | "text" | "html" {
  return VALID_MAIL_BODY_FORMATS.has(value as string) ? value as "markdown" | "text" | "html" : "markdown";
}

/**
 * W7-2b: 본문 길이 상한은 **저장 경로와 같은 형식 분기**를 쓴다
 * (functions/admin.ts sanitizeCampaignColdMail: html = 256KB, 그 외 = 8000).
 * 예전 UI 정규화는 형식을 무시하고 항상 8000 자에서 잘라, 서버에 온전히 저장된 HTML 본문이
 * 화면에서만 절단됐다. 상한을 일괄 상향하지 않는다 — markdown 에 대형 문자열 상태를 만들지 않기 위해.
 */
const MAIL_BODY_MAX_CHARS: Readonly<Record<"markdown" | "text" | "html", number>> = {
  markdown: 8000,
  text: 8000,
  html: 256 * 1024,
};

function normalizeTemplateValues(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .slice(0, 50);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function normalizeStringList(value: unknown, maxItems = 24, maxLength = 80): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().slice(0, maxLength);
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function normalizeCountryCodes(value: unknown): string[] {
  const knownCodes = new Set<string>(CAMPAIGN_COUNTRY_OPTIONS.map((item) => item.code));
  return normalizeStringList(value, 30, 4)
    .map((item) => item.toUpperCase())
    .filter((code, index, list) => knownCodes.has(code) && list.indexOf(code) === index);
}

export function normalizeCountryTargeting(
  value: unknown,
  fallbackScope: CountryScope = "inherit",
): CountryTargeting {
  const record = isRecord(value) ? value : {};
  const includedCountries = normalizeCountryCodes(record.includedCountries);
  const excludedCountries = normalizeCountryCodes(record.excludedCountries);
  const rawScope = cleanString(record.countryScope, "", 12);
  const countryScope: CountryScope = rawScope === "inherit" || rawScope === "all" || rawScope === "include"
    ? rawScope
    : includedCountries.length > 0
      ? "include"
      : fallbackScope;
  return {
    countryScope,
    includedCountries: countryScope === "include" ? includedCountries : [],
    excludedCountries,
  };
}

export function countryTargetingFromRecord(value: unknown): CountryTargeting {
  const record = isRecord(value) ? value : {};
  if (owns(record, "countryTargeting")) {
    const direct = normalizeCountryTargeting(record.countryTargeting);
    return {
      ...direct,
      excludedCountries: Array.from(new Set([
        ...direct.excludedCountries,
        ...normalizeCountryCodes(record.excludedCountries),
      ])),
    };
  }
  if (owns(record, "targetCountries")) {
    const targetCountries = normalizeCountryCodes(record.targetCountries);
    return {
      countryScope: targetCountries.length === 0 ? "all" : "include",
      includedCountries: targetCountries,
      excludedCountries: normalizeCountryCodes(record.excludedCountries),
    };
  }
  return {
    countryScope: "inherit",
    includedCountries: [],
    excludedCountries: normalizeCountryCodes(record.excludedCountries),
  };
}

export function resolveCountryTargeting(
  child: CountryTargeting,
  parent: CountryTargeting = { countryScope: "all", includedCountries: [], excludedCountries: [] },
): CountryTargeting {
  const normalizedChild = normalizeCountryTargeting(child);
  const normalizedParent = normalizeCountryTargeting(parent, "all");
  const selected = normalizedChild.countryScope === "inherit" ? normalizedParent : normalizedChild;
  return {
    countryScope: selected.countryScope === "inherit" ? "all" : selected.countryScope,
    includedCountries: selected.countryScope === "include" ? selected.includedCountries : [],
    excludedCountries: Array.from(new Set([
      ...normalizedParent.excludedCountries,
      ...normalizedChild.excludedCountries,
    ])),
  };
}

export function countryTargetingLegacyCountries(policy: CountryTargeting): string[] | undefined {
  const normalized = normalizeCountryTargeting(policy);
  if (normalized.countryScope === "inherit") return undefined;
  return normalized.countryScope === "all" ? [] : normalized.includedCountries;
}

export function countryTargetingLabel(
  policy: CountryTargeting,
  inheritLabel = "프로그램 기준",
): string {
  const normalized = normalizeCountryTargeting(policy);
  if (normalized.countryScope === "inherit") return inheritLabel;
  if (normalized.countryScope === "all") return "전체 국가";
  return normalized.includedCountries.map(campaignCountryLabel).join(" · ") || "선택 국가 없음";
}

export function campaignCountryLabel(code: string): string {
  return CAMPAIGN_COUNTRY_OPTIONS.find((item) => item.code === code)?.label ?? code;
}

export function campaignCountriesLabel(codes: readonly string[] | undefined): string {
  if (!codes || codes.length === 0) return "전체 국가";
  return codes.map(campaignCountryLabel).join(" · ");
}

export function balancedCountryMix(codes: string[]): CampaignCountryAllocation[] {
  return normalizeCountryCodes(codes).map((country) => ({ country, weight: 1 }));
}

export function normalizeCountryMix(value: unknown, fallbackCountries: string[] = []): CampaignCountryAllocation[] {
  const knownCodes = new Set<string>(CAMPAIGN_COUNTRY_OPTIONS.map((item) => item.code));
  const fallback = balancedCountryMix(fallbackCountries);
  if (!Array.isArray(value)) return fallback;
  const out: CampaignCountryAllocation[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const country = cleanString(item.country, "", 4).toUpperCase();
    const weight = cleanNumber(item.weight, 0);
    if (knownCodes.has(country) && weight > 0 && !out.some((entry) => entry.country === country)) {
      out.push({ country, weight });
    }
  }
  return out.length > 0 ? out : fallback;
}

export function countryMixLabel(mix: CampaignCountryAllocation[]): string {
  if (mix.length === 0) return "전체 국가";
  return mix.map((entry) => `${campaignCountryLabel(entry.country)} ${entry.weight}`).join(" · ");
}

export function normalizeCampaignPriority(value: unknown): Priority {
  return VALID_PRIORITIES.includes(value as Priority) ? value as Priority : "보통";
}

export function normalizeCampaignTargetMetric(value: unknown): CampaignTargetMetric {
  return VALID_TARGET_METRICS.includes(value as CampaignTargetMetric) ? value as CampaignTargetMetric : "partners";
}

export function extractTemplatePlaceholders(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
      found.add(match[1]);
    }
  }
  return Array.from(found);
}

export function renderCampaignTemplatePreview(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => values[key] ?? `{{${key}}}`);
}

export function normalizeCampaignForUi(campaign: Campaign): Campaign {
  const record = campaign as unknown as Record<string, unknown>;
  const targeting = isRecord(record.targeting) ? record.targeting : {};
  const targetingCriteria = isRecord(record.targetingCriteria) ? record.targetingCriteria : {};
  const coldMailInput = isRecord(record.coldMail) ? record.coldMail : {};
  const subject = cleanString(coldMailInput.subject, "", 400);
  const bodyFormat = normalizeMailBodyFormat(coldMailInput.bodyFormat);
  const body = cleanString(coldMailInput.body, "", MAIL_BODY_MAX_CHARS[bodyFormat]);
  const coldMail = subject || body
    ? {
        subject,
        body,
        bodyFormat,
        placeholders: normalizeStringList(coldMailInput.placeholders, 50),
        preview: cleanString(coldMailInput.preview, "", 1000) || undefined,
        sourceCountry: cleanString(coldMailInput.sourceCountry, "KR", 4),
        templateValues: normalizeTemplateValues(coldMailInput.templateValues),
        templateRevision: cleanString(coldMailInput.templateRevision, "", 160) || undefined,
        trackingId: cleanString(coldMailInput.trackingId, "", 120) || undefined,
        draftRef: cleanString(coldMailInput.draftRef, "", 240) || undefined,
        updatedAtIso: cleanString(coldMailInput.updatedAtIso, "", 80) || undefined,
      }
    : undefined;
  const rootHasCountryPolicy = owns(record, "countryTargeting")
    || owns(record, "targetCountries")
    || owns(record, "excludedCountries");
  const criteriaHasCountryPolicy = owns(targetingCriteria, "countryTargeting")
    || owns(targetingCriteria, "targetCountries")
    || owns(targetingCriteria, "excludedCountries");
  const countryTargeting = rootHasCountryPolicy
    ? countryTargetingFromRecord(record)
    : criteriaHasCountryPolicy
      ? countryTargetingFromRecord(targetingCriteria)
      : countryTargetingFromRecord(targeting);
  const effectiveCountryTargeting = normalizeCountryTargeting(
    record.effectiveCountryTargeting
      ?? targetingCriteria.effectiveCountryTargeting
      ?? targeting.effectiveCountryTargeting
      ?? countryTargeting,
    countryTargeting.countryScope,
  );
  const targetCountries = countryTargetingLegacyCountries(countryTargeting);
  const includeKeywords = normalizeStringList(
    record.includeKeywords ?? targetingCriteria.includeKeywords ?? targeting.includeKeywords,
  );
  const excludeKeywords = normalizeStringList(
    record.excludeKeywords ?? targetingCriteria.excludeKeywords ?? targeting.excludeKeywords,
  );
  const targetCountryMix = normalizeCountryMix(
    record.targetCountryMix ?? targetingCriteria.targetCountryMix ?? targeting.targetCountryMix,
    targetCountries ?? [],
  );
  const total = cleanNumber(record.total, 0);
  const targetMetric = normalizeCampaignTargetMetric(record.targetMetric ?? targeting.targetMetric);
  const targetValue = cleanNumber(record.targetValue ?? targeting.targetValue, total);

  return {
    ...campaign,
    id: cleanString(record.id, campaign.id, 140),
    name: cleanString(record.name, "이름 없는 캠페인", 120),
    owner: cleanString(record.owner, "—", 80),
    source: VALID_SOURCES.includes(record.source as Campaign["source"]) ? record.source as Campaign["source"] : "검색",
    status: VALID_STATUSES.includes(record.status as Campaign["status"])
      ? record.status as Campaign["status"]
      : isCancelledCampaignStatus(record.status)
        ? record.status as Campaign["status"]
        : "대기",
    priority: normalizeCampaignPriority(record.priority),
    targetMetric,
    targetValue,
    total,
    queued: optionalNumber(record.queued),
    sent: cleanNumber(record.sent, 0),
    replied: cleanNumber(record.replied, 0),
    negotiating: cleanNumber(record.negotiating, 0),
    contracted: cleanNumber(record.contracted, 0),
    live: cleanNumber(record.live, 0),
    bounced: cleanNumber(record.bounced, 0),
    coldMail,
    countryTargeting,
    effectiveCountryTargeting,
    excludedCountries: countryTargeting.excludedCountries,
    ...(targetCountries === undefined ? {} : { targetCountries }),
    targetCountryMix,
    includeKeywords,
    excludeKeywords,
    allowInflyOverlap: record.allowInflyOverlap === true
      || targetingCriteria.allowInflyOverlap === true
      || (isRecord(record.mailProfile) && record.mailProfile.allowInflyOverlap === true),
    targetingCriteria: {
      countryTargeting,
      effectiveCountryTargeting,
      excludedCountries: countryTargeting.excludedCountries,
      ...(targetCountries === undefined ? {} : { targetCountries }),
      targetCountryMix,
      includeKeywords,
      excludeKeywords,
      discoveryVertical: cleanString(targetingCriteria.discoveryVertical, "", 32) || undefined,
      categories: normalizeStringList(targetingCriteria.categories),
      regions: normalizeStringList(targetingCriteria.regions),
      minFollowers: optionalNumber(targetingCriteria.minFollowers),
      maxFollowers: optionalNumber(targetingCriteria.maxFollowers),
      recentActivityDays: optionalNumber(targetingCriteria.recentActivityDays),
      minVideoViews: optionalNumber(targetingCriteria.minVideoViews),
      minVideoCount: optionalNumber(targetingCriteria.minVideoCount),
    },
    targeting: {
      ...targeting,
      countryTargeting,
      effectiveCountryTargeting,
      excludedCountries: countryTargeting.excludedCountries,
      targetMetric,
      targetValue,
      requested: optionalNumber(targeting.requested),
      queued: optionalNumber(targeting.queued),
      emailReady: optionalNumber(targeting.emailReady),
      emailRequiredSkipped: optionalNumber(targeting.emailRequiredSkipped),
      limit: optionalNumber(targeting.limit),
      truncated: targeting.truncated === true,
      ...(targetCountries === undefined ? {} : { targetCountries }),
      targetCountryMix,
      includeKeywords,
      excludeKeywords,
    },
  };
}
