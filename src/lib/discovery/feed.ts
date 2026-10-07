import { CONTENT_TAG, SETTINGS, type ContentTag } from "@/lib/data";
import { isOwnedOfficialIdentity } from "@/lib/creator-identity";
import { recencyDominantOrder } from "./feed-order";

export type FeedSettings = typeof SETTINGS.feed;
export type VideoSourceBucket = "owned_game_ugc" | "similar_game" | "paid";

const BLOCKED_LANDING_HOSTS = ["facebook.com", "m.facebook.com", "fb.com"];
const CANONICAL_GAME_SOURCE_LANDINGS: Record<string, Partial<Record<"reddit" | "x" | "discord" | "web", string>>> = {
  xphero: {
    reddit: "https://www.reddit.com/r/XPHero/",
    x: "https://x.com/search?q=XPHERO%20Supercent&f=live",
    discord: "https://discord.gg/supercent-creators",
    web: "https://www.supercent.io/",
  },
};

export function sourceKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "web";
}

export function publishedSortValue(value: string): number {
  const normalized = /^\d{2}-\d{2}$/.test(value) ? `2026-${value}` : value;
  const parsed = Date.parse(normalized);
  if (Number.isFinite(parsed)) return parsed;
  const hoursAgo = value.match(/^(\d+)\s*시간 전$/);
  if (hoursAgo) return Date.now() - Number(hoursAgo[1]) * 3_600_000;
  const daysAgo = value.match(/^(\d+)\s*일 전$/);
  if (daysAgo) return Date.now() - Number(daysAgo[1]) * 86_400_000;
  if (value === "어제") return Date.now() - 86_400_000;
  if (value === "오늘") return Date.now();
  return 0;
}

export function matchTag(text: string, tags: readonly string[]): string | null {
  const lower = text.toLowerCase();
  return tags.find((tag) => tag.trim() && lower.includes(tag.trim().toLowerCase())) ?? null;
}

function canonicalGameKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function safeHttpUrl(value: unknown): URL | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function hostMatches(host: string, blockedHost: string): boolean {
  return host === blockedHost || host.endsWith(`.${blockedHost}`);
}

function isBlockedLandingHost(url: URL): boolean {
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  return BLOCKED_LANDING_HOSTS.some((blockedHost) => hostMatches(host, blockedHost));
}

function redditSubredditFromLabel(value: string | undefined): string | null {
  const match = value?.match(/\br\/([a-z0-9_]+)/i);
  return match?.[1] ?? null;
}

function xHandleFromLabel(value: string | undefined): string | null {
  const match = value?.trim().match(/^@([A-Za-z0-9_]{1,15})$/);
  return match?.[1] ?? null;
}

function isRedditLanding(url: URL): boolean {
  if (url.hostname.endsWith("redd.it")) return url.pathname !== "/";
  if (!url.hostname.endsWith("reddit.com")) return false;
  if (url.pathname.includes("/comments/")) return true;
  return url.pathname.includes("/search") && Boolean(url.searchParams.get("q"));
}

function isRedditPostLanding(url: URL): boolean {
  if (url.hostname.endsWith("redd.it")) return url.pathname !== "/";
  return url.hostname.endsWith("reddit.com") && url.pathname.includes("/comments/");
}

function isXLanding(url: URL): boolean {
  if (!(url.hostname.endsWith("x.com") || url.hostname.endsWith("twitter.com"))) return false;
  if (url.pathname.startsWith("/search")) return Boolean(url.searchParams.get("q"));
  return url.pathname.includes("/status/");
}

function isDiscordLanding(url: URL): boolean {
  if (url.hostname.endsWith("discord.gg")) return url.pathname !== "/";
  if (!url.hostname.endsWith("discord.com")) return false;
  if (url.pathname.startsWith("/channels/@me")) return false;
  return url.pathname.startsWith("/channels/") || url.pathname.startsWith("/invite/");
}

function searchUrl(base: string, query: string): string {
  const url = new URL(base);
  url.searchParams.set("q", query);
  if (url.hostname.endsWith("x.com")) url.searchParams.set("f", "live");
  if (url.hostname.endsWith("reddit.com") && url.pathname.includes("/search")) {
    url.searchParams.set("sort", "new");
    if (url.pathname.includes("/r/")) url.searchParams.set("restrict_sr", "1");
  }
  return url.toString();
}

export function resolveCommunitySourceUrl(input: {
  source: string;
  by?: string;
  title?: string;
  sourceUrl?: string;
  game?: string;
  matchedGame?: string;
}): string | undefined {
  const key = sourceKey(input.source);
  const rawUrl = safeHttpUrl(input.sourceUrl);
  const inferredGame = input.matchedGame ?? input.game ?? matchTag(`${input.title ?? ""} ${input.by ?? ""}`, SETTINGS.feed.ownedGameTags) ?? "";
  const gameKey = canonicalGameKey(inferredGame);
  const canonical = CANONICAL_GAME_SOURCE_LANDINGS[gameKey]?.[key as "reddit" | "x" | "discord" | "web"];

  if (key === "reddit") {
    const subreddit = redditSubredditFromLabel(input.by);
    if (rawUrl && isRedditPostLanding(rawUrl)) return rawUrl.toString();
    if (canonical) return canonical;
    if (rawUrl && isRedditLanding(rawUrl)) return rawUrl.toString();
    if (subreddit && input.title) return searchUrl(`https://www.reddit.com/r/${subreddit}/search/`, input.title);
    if (subreddit) return `https://www.reddit.com/r/${subreddit}/`;
    return searchUrl("https://www.reddit.com/search/", [inferredGame, input.title].filter(Boolean).join(" "));
  }

  if (key === "x") {
    const handle = xHandleFromLabel(input.by);
    if (rawUrl && isXLanding(rawUrl)) return rawUrl.toString();
    if (canonical) return input.title ? searchUrl("https://x.com/search", [inferredGame, input.title].filter(Boolean).join(" ")) : canonical;
    if (handle) return `https://x.com/${handle}`;
    return searchUrl("https://x.com/search", [inferredGame, "Supercent"].filter(Boolean).join(" "));
  }

  if (key === "discord") {
    if (rawUrl && isDiscordLanding(rawUrl)) return rawUrl.toString();
    if (input.by?.startsWith("discord.gg/")) return `https://${input.by}`;
    return canonical;
  }

  if (rawUrl && !isBlockedLandingHost(rawUrl)) return rawUrl.toString();
  if (rawUrl && isBlockedLandingHost(rawUrl)) return searchUrl("https://www.google.com/search", [input.title, inferredGame].filter(Boolean).join(" "));
  if (canonical) return canonical;
  return searchUrl("https://www.google.com/search", [input.title, inferredGame].filter(Boolean).join(" "));
}

// P8 N/10 "오늘 생성" 배지(A10): feed-date.ts(path-alias 없는 순수 모듈, 행위 테스트 가능)에서
// 재노출 — activityRefresh/scpApprovedFeed의 createdAt-1회-스탬프 계약에 의존한 신규 판정.
export { countNewFeedItems, isFeedItemNewOnDate, seoulDateKey } from "./feed-date";

export function isFreshPublished(value: string, freshnessDays: number): boolean {
  const published = publishedSortValue(value);
  if (!published) return false;
  const ageDays = (Date.now() - published) / 86_400_000;
  return ageDays >= 0 && ageDays <= freshnessDays;
}

export function contentTag(value: unknown, fallback: ContentTag = "UGC"): ContentTag {
  return typeof value === "string" && value in CONTENT_TAG ? value as ContentTag : fallback;
}

const COMMUNITY_UGC_REVIEW_TERMS = [
  "review",
  "reviews",
  "rating",
  "ratings",
  "gameplay",
  "walkthrough",
  "tips",
  "clip",
  "clips",
  "shorts",
  "creator",
  "creators",
  "challenge",
  "thread",
  "discussion",
  "players",
  "comments",
  "reaction",
  "reactions",
  "sponsorship",
  "brief",
  "briefs",
];

const COMMUNITY_DIRECTORY_PATTERNS = [
  /\bapp store\b/i,
  /\bapps on google play\b/i,
  /\bgoogle play\b/i,
  /\bapk\b/i,
  /\bdownload\b/i,
  /\btopgames\b/i,
  /\bappgamer\b/i,
  /\bgame solver\b/i,
  /\bchaptercheats\b/i,
  /\bcloudphoneapp\b/i,
  /\bworldsapps\b/i,
];

export function hasCommunityUgcSignal(text: string, settings: FeedSettings): boolean {
  return Boolean(matchTag(text, [...settings.ugcKeywords, ...COMMUNITY_UGC_REVIEW_TERMS]));
}

export function isCommunityDirectoryPage(text: string): boolean {
  return COMMUNITY_DIRECTORY_PATTERNS.some((pattern) => pattern.test(text));
}

export function classifyVideoFeedItem(
  input: {
    title: string;
    by: string;
    tag: ContentTag;
    published: string;
  },
  settings: FeedSettings,
): {
  tag: ContentTag;
  matchedGame?: string;
  fresh: boolean;
  sourceBucket?: VideoSourceBucket;
} {
  const haystack = `${input.title} ${input.by} ${input.tag}`;
  const ownedGame = matchTag(haystack, settings.ownedGameTags);
  const similarGame = matchTag(haystack, settings.similarGameTags);
  const fresh = isFreshPublished(input.published, settings.freshnessDays);
  const tag = input.tag === "유료"
    ? input.tag
    : ownedGame
      ? (input.tag === "자사" ? "자사" : "UGC")
      : similarGame
        ? "UGC"
        : input.tag;
  const sourceBucket: VideoSourceBucket | undefined = input.tag === "유료"
    ? "paid"
    : ownedGame
      ? "owned_game_ugc"
      : similarGame || fresh
        ? "similar_game"
        : undefined;

  return {
    tag,
    matchedGame: ownedGame ?? similarGame ?? undefined,
    fresh,
    sourceBucket,
  };
}

export function classifyCommunityFeedItem(
  input: {
    title: string;
    by: string;
    game?: string;
    published: string;
    sourceUrl?: string;
    subreddit?: string;
  },
  settings: FeedSettings,
): {
  tag: ContentTag;
  matchedGame?: string;
  fresh: boolean;
  sourceBucket?: VideoSourceBucket;
  excludedOwnedOfficial: boolean;
} {
  const haystack = `${input.title} ${input.by} ${input.game ?? ""}`;
  const excludedOwnedOfficial = isOwnedOfficialIdentity([
    input.by,
    input.title,
    input.sourceUrl ?? "",
    input.subreddit ?? "",
  ], settings.officialChannels);
  const ownedGame = matchTag(haystack, settings.ownedGameTags);
  const similarGame = matchTag(haystack, settings.similarGameTags);
  const ugcSignal = hasCommunityUgcSignal(haystack, settings);
  const directoryPage = isCommunityDirectoryPage(haystack);
  const fresh = isFreshPublished(input.published, settings.freshnessDays);
  const relevantGameReview = Boolean((ownedGame || similarGame) && ugcSignal && !directoryPage && !excludedOwnedOfficial);
  const tag: ContentTag = relevantGameReview ? "UGC" : "커뮤니티";
  const sourceBucket: VideoSourceBucket | undefined = relevantGameReview
    ? ownedGame
      ? "owned_game_ugc"
      : "similar_game"
    : undefined;

  return {
    tag,
    matchedGame: ownedGame ?? similarGame ?? input.game,
    fresh,
    sourceBucket,
    excludedOwnedOfficial,
  };
}

function roundRobinBuckets<T>(buckets: Map<string, T[]>): T[] {
  const keys = [...buckets.keys()].sort();
  const merged: T[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const key of keys) {
      const next = buckets.get(key)?.shift();
      if (!next) continue;
      merged.push(next);
      added = true;
    }
  }
  return merged;
}

function sourceDiversityKey(value: string | undefined): string {
  return value?.trim().toLowerCase() || "unknown-source";
}

function creatorDiversityKey(value: string | undefined): string {
  return value?.trim().toLowerCase() || "unknown-creator";
}

export function diversifyFeedItems<T extends { published: string }>(
  items: readonly T[],
  options: {
    maxPerSource: number;
    maxPerCreator: number;
    sourceKey: (item: T) => string | undefined;
    creatorKey: (item: T) => string | undefined;
    interleaveSources?: boolean;
  },
): T[] {
  const interleaveSources = options.interleaveSources ?? true;

  if (!interleaveSources) {
    // Skip source round-robin entirely — only cap per-creator repeats while
    // preserving the incoming (published-desc) order.
    const creatorCounts = new Map<string, number>();
    const selected: T[] = [];
    for (const item of items) {
      const creator = creatorDiversityKey(options.creatorKey(item));
      const creatorCount = creatorCounts.get(creator) ?? 0;
      if (creatorCount >= options.maxPerCreator) continue;
      selected.push(item);
      creatorCounts.set(creator, creatorCount + 1);
    }
    return selected;
  }

  const sourceCounts = new Map<string, number>();
  const creatorCounts = new Map<string, number>();
  const selected: T[] = [];
  const overflow: T[] = [];

  for (const item of items) {
    const source = sourceDiversityKey(options.sourceKey(item));
    const creator = creatorDiversityKey(options.creatorKey(item));
    const sourceCount = sourceCounts.get(source) ?? 0;
    const creatorCount = creatorCounts.get(creator) ?? 0;
    if (sourceCount >= options.maxPerSource || creatorCount >= options.maxPerCreator) {
      overflow.push(item);
      continue;
    }
    selected.push(item);
    sourceCounts.set(source, sourceCount + 1);
    creatorCounts.set(creator, creatorCount + 1);
  }

  // Reorder selected items so recency dominates while preventing long
  // consecutive runs from a single source.  roundRobinBuckets is retained
  // above for reference but is no longer used here — it sorted sources
  // alphabetically and destroyed the newest-first ordering.
  const ordered = recencyDominantOrder(selected, {
    maxPerSource: options.maxPerSource,
    sourceKey: (item) => sourceDiversityKey(options.sourceKey(item)),
    dateMs: (item) => publishedSortValue(item.published),
  });

  return [...ordered, ...overflow];
}
