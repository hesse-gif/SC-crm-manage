import { SETTINGS, type QueueCommunityDiscoveryPayload, type QueueYtDlpDiscoveryPayload } from "@/lib/data";

type CandidateCriteria = typeof SETTINGS.candidateCriteria;

export type DiscoveryCountryTargeting = {
  countryScope: "inherit" | "all" | "include";
  includedCountries: string[];
  excludedCountries: string[];
};

type DiscoveryCriteria = {
  keywords: string[];
  countryTargeting: DiscoveryCountryTargeting;
  filters: {
    regions: string[];
    categories: string[];
    minFollowers: number;
    maxFollowers: number;
    recentActivityDays: number;
    platforms: string[];
  };
  communitySources: Array<"reddit" | "discord" | "x" | "web">;
};

const DEFAULT_KEYWORDS = ["casual game", "mobile game", "hyper casual"];
export const DEFAULT_DISCOVERY_RESULT_LIMIT = 200;
const COMMUNITY_SOURCE_BY_PLATFORM: Record<string, "reddit" | "discord" | "x" | "web" | undefined> = {
  reddit: "reddit",
  discord: "discord",
  x: "x",
  twitter: "x",
  web: "web",
};

function uniqueNonEmpty(values: readonly string[], limit: number): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = value.trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    if (out.some((existing) => existing.toLowerCase() === lower)) continue;
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function numberOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeCountryCodes(values: readonly string[] | undefined): string[] {
  return Array.from(new Set((values ?? [])
    .map((value) => value.trim().toUpperCase())
    .map((value) => value === "UK" ? "GB" : value)
    .filter((value) => /^[A-Z]{2}$/.test(value))));
}

function normalizeCountryTargeting(
  countryTargeting: Partial<DiscoveryCountryTargeting> | undefined,
): DiscoveryCountryTargeting {
  const includedCountries = normalizeCountryCodes(countryTargeting?.includedCountries);
  const countryScope = countryTargeting?.countryScope === "include"
    || countryTargeting?.countryScope === "inherit"
    || countryTargeting?.countryScope === "all"
    ? countryTargeting.countryScope
    : includedCountries.length > 0
      ? "include"
      : "all";
  return {
    countryScope,
    includedCountries: countryScope === "include" ? includedCountries : [],
    excludedCountries: normalizeCountryCodes(countryTargeting?.excludedCountries),
  };
}

export function tokenizeDiscoveryBrief(text: string, fallback: readonly string[] = DEFAULT_KEYWORDS): string[] {
  const tokens = text
    .replace(/[·,/|]+/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
  return uniqueNonEmpty(tokens.length > 0 ? tokens : fallback, 12);
}

export function communitySourcesFromPlatforms(platforms: readonly string[]): Array<"reddit" | "discord" | "x" | "web"> {
  const sources = platforms
    .map((platform) => COMMUNITY_SOURCE_BY_PLATFORM[platform.trim().toLowerCase()])
    .filter((source): source is "reddit" | "discord" | "x" | "web" => Boolean(source));
  return sources.length > 0 ? Array.from(new Set(sources)) : ["reddit", "discord", "x", "web"];
}

export function buildDiscoveryCriteriaFromBrief(
  brief: string,
  base: CandidateCriteria = SETTINGS.candidateCriteria,
  countryTargeting?: Partial<DiscoveryCountryTargeting>,
): DiscoveryCriteria {
  const baseKeywords = Array.isArray(base.keywords) ? base.keywords : DEFAULT_KEYWORDS;
  const keywords = tokenizeDiscoveryBrief(brief, baseKeywords);
  const platforms = uniqueNonEmpty(Array.isArray(base.platforms) ? base.platforms : ["YouTube"], 8);
  const categories = uniqueNonEmpty([...keywords, ...baseKeywords, ...SETTINGS.feed.ownedGameTags], 24);

  const resolvedCountryTargeting = normalizeCountryTargeting(countryTargeting);
  return {
    keywords,
    countryTargeting: resolvedCountryTargeting,
    filters: {
      regions: resolvedCountryTargeting.countryScope === "include"
        ? resolvedCountryTargeting.includedCountries
        : [],
      categories,
      minFollowers: numberOrFallback(base.minFollowers, 30_000),
      maxFollowers: numberOrFallback(base.maxFollowers, 2_000_000),
      recentActivityDays: numberOrFallback(base.recentActivityDays, 30),
      platforms,
    },
    communitySources: communitySourcesFromPlatforms([...platforms, "Reddit", "Discord", "X", "Web"]),
  };
}

export function discoveryCriteriaToYoutubePayload(
  criteria: DiscoveryCriteria,
  options: {
    programId?: string;
    campaignId?: string;
    campaignRef: string;
    gameId: string;
    resultLimit?: number;
    commentLimit?: number;
  },
): QueueYtDlpDiscoveryPayload & { countryTargeting: DiscoveryCountryTargeting } {
  return {
    ...(options.programId ? { programId: options.programId } : {}),
    ...(options.campaignId ? { campaignId: options.campaignId } : {}),
    campaignRef: options.campaignRef,
    gameId: options.gameId,
    countryTargeting: criteria.countryTargeting,
    keywords: criteria.keywords,
    filters: {
      regions: criteria.filters.regions,
      categories: criteria.filters.categories,
      minFollowers: criteria.filters.minFollowers,
      maxFollowers: criteria.filters.maxFollowers,
      recentActivityDays: criteria.filters.recentActivityDays,
    },
    resultLimit: options.resultLimit ?? DEFAULT_DISCOVERY_RESULT_LIMIT,
    commentLimit: options.commentLimit ?? 5,
    includeComments: true,
  };
}

export function discoveryCriteriaToCommunityPayload(
  criteria: DiscoveryCriteria,
  brief: string,
  options: {
    programId?: string;
    campaignId?: string;
    campaignRef: string;
    gameId: string;
    resultLimit?: number;
    actionId?: string;
  },
): QueueCommunityDiscoveryPayload {
  return {
    actionId: options.actionId ?? globalThis.crypto.randomUUID(),
    ...(options.programId ? { programId: options.programId } : {}),
    ...(options.campaignId ? { campaignId: options.campaignId } : {}),
    campaignRef: options.campaignRef,
    gameId: options.gameId,
    brief,
    keywords: criteria.keywords,
    ownedGameTags: SETTINGS.feed.ownedGameTags,
    ugcKeywords: SETTINGS.feed.ugcKeywords,
    communitySubreddits: SETTINGS.feed.communitySubreddits,
    communityRefreshHours: SETTINGS.feed.communityRefreshHours,
    sources: criteria.communitySources,
    filters: {
      regions: criteria.filters.regions,
      categories: criteria.filters.categories,
      recentActivityDays: criteria.filters.recentActivityDays,
      platforms: [...criteria.filters.platforms, "Reddit", "Discord", "X", "Web"],
    },
    resultLimit: options.resultLimit ?? DEFAULT_DISCOVERY_RESULT_LIMIT,
    includeComments: true,
  };
}
