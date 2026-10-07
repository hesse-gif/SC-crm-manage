import { createHash } from "node:crypto";

export type CommunitySource = "reddit" | "discord" | "x" | "web" | "steam";

type SentimentLabel = "positive" | "neutral" | "negative";

type VertexResult<T = unknown> = {
  json: T;
  text: string;
  modelId: string;
  provider: string;
  transport?: "ai_hub_gateway" | "vertex_direct" | "cache" | "unverified";
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

type CommunitySentimentClassification = {
  label: SentimentLabel;
  confidence: number;
  themes: string[];
};

type CommentSentimentBreakdown = {
  positive: number;
  neutral: number;
  negative: number;
};

type RedditCommentAnalysis = {
  commentSummary: string;
  commentSentiment: CommentSentimentBreakdown;
  commentThemes: string[];
};

type CommunitySentimentCache = {
  get(key: string): Promise<CommunitySentimentClassification | null>;
  set(key: string, value: CommunitySentimentClassification, metadata: CommunitySentimentCacheMetadata): Promise<void>;
};

type RedditCommentAnalysisCache = {
  get(key: string): Promise<RedditCommentAnalysis | null>;
  set(key: string, value: RedditCommentAnalysis, metadata: CommunitySentimentCacheMetadata): Promise<void>;
};

type CommunitySentimentCacheMetadata = {
  modelId: string;
  provider: string;
  runId: string;
};

type CommunitySentimentCallModel = <T = unknown>(
  modelId: string,
  responseSchema: unknown,
  promptText: string,
) => Promise<VertexResult<T>>;

type CommunitySentimentOptions = {
  enableLlm: boolean;
  cache?: CommunitySentimentCache;
  callModelFn?: CommunitySentimentCallModel;
  modelId?: string;
  runId?: string;
};

type RedditCommentOptions = {
  enableComments: boolean;
  cache?: RedditCommentAnalysisCache;
  callModelFn?: CommunitySentimentCallModel;
  fetchTextFn?: (url: string) => Promise<{ status: number; text: string }>;
  modelId?: string;
  runId?: string;
  maxPosts?: number;
  commentLimit?: number;
};

type RedditCommentEnrichmentResult = {
  posts: CommunityPostArtifact[];
  externalRequests: number;
};

type SearchCommunitySourcesOptions = {
  enableLlmSentiment?: boolean;
  enableRedditComments?: boolean;
};

type CommunitySentimentResponse = {
  results?: unknown;
};

type RedditCommentAnalysisResponse = {
  commentSummary?: unknown;
  commentSentiment?: unknown;
  commentThemes?: unknown;
};

type VertexModule = {
  callModel: CommunitySentimentCallModel;
  selectVertexModelForTask: (task: "tagging" | "comment_summary") => string;
};

type AiHubReportModule = {
  newSessionId: () => string;
  reportLlmUsage: (opts?: Record<string, unknown>) => Promise<void>;
};

type CreatorIdentityModule = {
  isOwnedOfficialIdentity: (input: Record<string, unknown> | string[], officialChannels?: readonly string[]) => boolean;
};

type FirestoreSnapshot = {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
};

type FirestoreDocRef = {
  get(): Promise<FirestoreSnapshot>;
  set(data: Record<string, unknown>, options: { merge: boolean }): Promise<unknown>;
};

type FirestoreDb = {
  collection(name: string): {
    doc(id: string): FirestoreDocRef;
  };
};

declare const require: ((id: string) => unknown) | undefined;

export type ParsedCommunityDiscoveryData = {
  programId: string | undefined;
  campaignId: string | undefined;
  campaignRef: string;
  gameId: string;
  brief: string;
  keywords: string[];
  ownedGameTags: string[];
  similarGameTags: string[];
  ugcKeywords: string[];
  communitySubreddits: string[];
  officialChannels: string[];
  steamAppIds: string[];
  steamLanguage: string;
  communityRefreshHours: number;
  sources: CommunitySource[];
  filters: {
    regions: string[];
    categories: string[];
    recentActivityDays: number;
  };
  resultLimit: number;
  includeComments: boolean;
};

export type CommunityPostArtifact = Record<string, unknown> & {
  id: string;
  sourceIdentity: string;
  sourceRequestId: string;
  source: "Reddit" | "Discord" | "X" | "Web" | "Steam";
  sourceKey: CommunitySource;
  title: string;
  sourceUrl: string;
  author?: string;
  createdAtIso: string;
  excerpt?: string;
  sentiment?: SentimentLabel;
  sentimentConfidence?: number;
  sentimentThemes?: string[];
  paidStatus?: "organic" | "contacted" | "paid";
  paidStatusConfidence?: "exact" | "fuzzy_review";
  paidStatusReview?: boolean;
  paidStatusCandidateId?: string;
  comments?: number;
  score?: number;
  commentSummary?: string;
  commentSentiment?: CommentSentimentBreakdown;
  commentThemes?: string[];
};

export type CommunityCandidateArtifact = Record<string, unknown> & { id: string };

export type CommunitySourceReport = {
  source: "Reddit" | "Discord" | "X" | "Web" | "Steam";
  sourceKey: CommunitySource;
  query: string;
  status: "ok" | "blocked" | "auth_required" | "no_results" | "error";
  resultCount: number;
  reason?: string;
};

export type CommunitySearchArtifacts = {
  mode: "live-public-search" | "emulator-fallback";
  posts: CommunityPostArtifact[];
  candidates: CommunityCandidateArtifact[];
  reports: CommunitySourceReport[];
  externalRequests: number;
};

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  displayUrl: string;
  author?: string;
  publishedIso?: string;
  score?: number;
  comments?: number;
};

type SourceAdapterResult = {
  adapter: "reddit-rss" | "google-news-rss" | "steam-appreviews" | "public-search";
  results: SearchResult[];
  externalRequests: number;
  reason?: string;
  skipReader?: boolean;
};

type CommunitySearchQuery = {
  source: CommunitySource;
  keyword: string;
  query: string;
  gameTag?: string;
  tier?: "owned" | "similar";
  subreddit?: string;
  steamAppId?: string;
  steamLanguage?: string;
};

const USER_AGENT = "FluDiscoveryBot/1.0";
const MAX_QUERY_KEYWORDS = 4;
const MAX_OWNED_GAME_QUERY_TERMS = 12;
// Similar/competitor search expands external requests per source, so keep it small and high-signal.
const MAX_SIMILAR_GAME_QUERY_TERMS = 8;
const MAX_RELEVANT_GAME_QUERY_TERMS = MAX_OWNED_GAME_QUERY_TERMS + MAX_SIMILAR_GAME_QUERY_TERMS;
const MAX_UGC_QUERY_TERMS = 3;
const MAX_REDDIT_SUBREDDITS = 5;
const MAX_STEAM_APP_IDS = 12;
const DEFAULT_STEAM_LANGUAGE = "all";
const CANONICAL_GAME_SUBREDDITS: Record<string, string[]> = {
  xphero: ["XPHero"],
};
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_CANDIDATE_ARTIFACTS = 200;
const SENTIMENT_CACHE_COLLECTION = "sentiment_cache";
const SENTIMENT_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const COMMENT_ANALYSIS_CACHE_COLLECTION = "comment_analysis_cache";
const COMMENT_ANALYSIS_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_REDDIT_COMMENT_POSTS = 10;
const REDDIT_COMMENT_LIMIT = 20;
const COMMUNITY_SENTIMENT_MODEL_FALLBACK = "gemini-2.5-flash-lite";
const FRESHNESS_CONFIDENCE = {
  observed: "observed",
  unknown: "unknown_published_at",
} as const;
const OFFICIAL_API_REQUIRED_SOURCES = new Set<CommunitySource>(["x"]);
const BLOCKED_SOCIAL_HOSTS = new Set(["facebook.com", "m.facebook.com", "fb.com"]);
const COMMUNITY_REVIEW_CONTEXT_TERMS = [
  "review",
  "reviews",
  "gameplay",
  "walkthrough",
  "tips",
  "cheat",
  "cheats",
  "shorts",
  "clip",
  "clips",
  "creator",
  "creators",
  "challenge",
  "thread",
  "discussion",
  "players",
  "comments",
  "community",
  "rating",
  "ratings",
  "crash",
  "crashing",
  "bug",
  "notworking",
  "play",
  "playing",
  "プレー",
];

export function communitySourceLabel(source: CommunitySource): "Reddit" | "Discord" | "X" | "Web" | "Steam" {
  if (source === "reddit") return "Reddit";
  if (source === "discord") return "Discord";
  if (source === "x") return "X";
  if (source === "steam") return "Steam";
  return "Web";
}

function sourceSiteFilter(source: CommunitySource): string {
  if (source === "reddit") return "site:reddit.com";
  if (source === "discord") return "(site:discord.com OR site:discord.gg)";
  if (source === "x") return "site:x.com";
  if (source === "steam") return "(site:store.steampowered.com OR site:steamcommunity.com)";
  return "";
}

function uniqueText(values: readonly string[], limit: number): string[] {
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

function sanitizeSubreddit(value: string): string {
  return value.trim().replace(/^r\//i, "").replace(/[^a-z0-9_]/gi, "");
}

function sanitizeSteamAppId(value: string): string {
  return value.trim().replace(/[^0-9]/g, "");
}

function sanitizeSteamLanguage(value: string | undefined): string {
  const language = value?.trim() || DEFAULT_STEAM_LANGUAGE;
  return /^[a-z][a-z0-9_-]{0,31}$/i.test(language) ? language : DEFAULT_STEAM_LANGUAGE;
}

function canonicalGameKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function canonicalSubredditsForGameTerms(terms: readonly string[]): string[] {
  return uniqueText(terms.flatMap((term) => CANONICAL_GAME_SUBREDDITS[canonicalGameKey(term)] ?? []), MAX_REDDIT_SUBREDDITS);
}

function subredditForGameTerm(gameTag: string | undefined, subreddits: readonly string[], index: number): string | undefined {
  const canonical = gameTag ? canonicalSubredditsForGameTerms([gameTag]) : [];
  return canonical[0] ?? (subreddits.length > 0 ? subreddits[index % subreddits.length] : undefined);
}

export function buildCommunitySearchQueries(data: ParsedCommunityDiscoveryData): CommunitySearchQuery[] {
  const ownedTerms = ownedGameQueryTerms(data);
  const similarTerms = similarGameQueryTerms(data, ownedTerms);
  const fallbackTerms = uniqueText([
    ...data.keywords,
    ...data.filters.categories,
    "Supercent",
  ], MAX_QUERY_KEYWORDS);
  const queryTerms = [
    ...ownedTerms.map((gameTag) => ({ gameTag, tier: "owned" as const })),
    ...similarTerms.map((gameTag) => ({ gameTag, tier: "similar" as const })),
  ];
  const gameTerms = queryTerms.length > 0
    ? queryTerms
    : fallbackTerms.map((gameTag) => ({ gameTag, tier: "owned" as const }));
  const ugcTerms = uniqueText(data.ugcKeywords.length > 0 ? data.ugcKeywords : data.keywords, MAX_UGC_QUERY_TERMS);
  const subreddits = uniqueText([
    ...canonicalSubredditsForGameTerms(gameTerms.map((term) => term.gameTag)),
    ...data.communitySubreddits.map(sanitizeSubreddit).filter(Boolean),
  ], MAX_REDDIT_SUBREDDITS);

  return data.sources.flatMap((source): CommunitySearchQuery[] => {
    if (source === "steam") {
      const steamAppIds = uniqueText(data.steamAppIds.map(sanitizeSteamAppId).filter(Boolean), MAX_STEAM_APP_IDS);
      return steamAppIds.map((steamAppId, index) => {
        const gameTerm = gameTerms[index % Math.max(1, gameTerms.length)];
        const gameTag = gameTerm?.gameTag ?? data.gameId;
        const keyword = ugcTerms[index % Math.max(1, ugcTerms.length)] ?? "review";
        return {
          source,
          keyword,
          query: normalizeWhitespace(`Steam app ${steamAppId} ${gameTag} reviews`),
          gameTag,
          tier: gameTerm?.tier,
          steamAppId,
          steamLanguage: sanitizeSteamLanguage(data.steamLanguage),
        };
      });
    }

    return gameTerms.map(({ gameTag, tier }, index) => {
      const keyword = ugcTerms[index % Math.max(1, ugcTerms.length)] ?? "UGC";
      const query = [
        `"${gameTag}"`,
        tier === "owned" ? "Supercent" : "",
        ...ugcTerms,
        source === "web" ? "community" : "",
        sourceSiteFilter(source),
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        source,
        keyword,
        query,
        gameTag,
        tier,
        subreddit: source === "reddit" ? subredditForGameTerm(gameTag, subreddits, index) : undefined,
      };
    });
  });
}

export function unwrapDuckDuckGoUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.hostname.endsWith("duckduckgo.com") && url.pathname === "/l/") {
      return url.searchParams.get("uddg") ?? value;
    }
  } catch {
    return value;
  }
  return value;
}

function readerUrl(query: string): string {
  return `https://r.jina.ai/http://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
}

function redditRssUrl(query: string, subreddit?: string): string {
  const cleanSubreddit = subreddit ? sanitizeSubreddit(subreddit) : "";
  if (cleanSubreddit) {
    return `https://www.reddit.com/r/${cleanSubreddit}/search.rss?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new`;
  }
  return `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new`;
}

function googleNewsRssUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

function steamStorePageUrl(appId: string): string {
  return `https://store.steampowered.com/app/${encodeURIComponent(appId)}/`;
}

function steamStoreSearchUrl(query: string): string {
  return `https://store.steampowered.com/search/?term=${encodeURIComponent(query)}`;
}

function steamAppReviewsUrl(appId: string, language: string | undefined): string {
  const url = new URL(`https://store.steampowered.com/appreviews/${encodeURIComponent(appId)}`);
  url.searchParams.set("json", "1");
  url.searchParams.set("language", sanitizeSteamLanguage(language));
  return url.toString();
}

function steamReviewSourceUrl(appId: string, recommendationId: string, steamId: string | undefined): string {
  if (steamId) {
    const url = new URL(`https://steamcommunity.com/profiles/${encodeURIComponent(steamId)}/recommended/${encodeURIComponent(appId)}/`);
    if (recommendationId) url.hash = `review-${recommendationId}`;
    return url.toString();
  }
  const url = new URL(steamStorePageUrl(appId));
  if (recommendationId) url.hash = `review-${recommendationId}`;
  return url.toString();
}

function sourceSpecificQuery(source: CommunitySource, query: string): string {
  if (source === "reddit") {
    const withoutSite = normalizeWhitespace(query.replace(/\bsite:reddit\.com\b/gi, ""));
    const tokens = withoutSite.split(" ");
    const uniqueTokens = tokens.filter((token, index) => tokens.findIndex((candidate) => candidate.toLowerCase() === token.toLowerCase()) === index);
    return uniqueTokens.filter((token) => !/^creators?$/i.test(token)).slice(0, 5).join(" ");
  }
  if (source === "discord") return normalizeWhitespace(query.replace(/\(site:discord\.com OR site:discord\.gg\)/gi, ""));
  if (source === "x") return normalizeWhitespace(query.replace(/\bsite:x\.com\b/gi, ""));
  if (source === "steam") return normalizeWhitespace(query.replace(/\(site:store\.steampowered\.com OR site:steamcommunity\.com\)/gi, ""));
  return query;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  return value.replace(/&#(\d+);|&#x([0-9a-f]+);|&([a-z]+);/gi, (_match, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return named[String(name).toLowerCase()] ?? `&${name};`;
  });
}

function stripHtml(value: string): string {
  return normalizeWhitespace(decodeEntities(decodeEntities(value)).replace(/<[^>]+>/g, " "));
}

function stripMarkdown(value: string): string {
  return normalizeWhitespace(decodeEntities(value.replace(/\*\*/g, "")));
}

function safeHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function sourceMatches(source: CommunitySource, url: string): boolean {
  const host = safeHost(url);
  if (source === "reddit") return host.endsWith("reddit.com");
  if (source === "discord") return host.endsWith("discord.com") || host.endsWith("discord.gg");
  if (source === "x") return host.endsWith("x.com") || host.endsWith("twitter.com");
  if (source === "steam") return host.endsWith("steampowered.com") || host.endsWith("steamcommunity.com");
  return !isBlockedSocialHost(host);
}

function isBlockedSocialHost(host: string): boolean {
  return Array.from(BLOCKED_SOCIAL_HOSTS).some((blockedHost) => host === blockedHost || host.endsWith(`.${blockedHost}`));
}

function officialApiConfigured(source: CommunitySource): boolean {
  if (source === "x") return Boolean(process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN);
  return true;
}

export function parseDuckDuckGoMarkdown(markdown: string, source: CommunitySource): SearchResult[] {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const results: SearchResult[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\d+\.\[(.+?)\]\((https?:\/\/[^)]+)\)$/);
    if (!match) continue;
    const title = stripMarkdown(match[1]);
    const url = unwrapDuckDuckGoUrl(match[2]);
    const snippet = stripMarkdown(lines[index + 1] ?? "");
    const displayUrl = stripMarkdown(lines[index + 2] ?? safeHost(url));
    const dateMatch = `${snippet} ${displayUrl}`.match(/(20\d{2}-\d{2}-\d{2})/);
    const publishedIso = dateMatch ? new Date(`${dateMatch[1]}T00:00:00.000Z`).toISOString() : undefined;
    if (!sourceMatches(source, url)) continue;
    results.push({ title, url, snippet, displayUrl, publishedIso });
  }

  return results;
}

function feedBlocks(xml: string): string[] {
  const entryBlocks = Array.from(xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi), (match) => match[0]);
  if (entryBlocks.length > 0) return entryBlocks;
  return Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi), (match) => match[0]);
}

function readXmlTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripHtml(match[1]) : undefined;
}

function readXmlTagAttribute(block: string, tag: string, attr: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*\\s${attr}=["']([^"']+)["'][^>]*>`, "i"));
  return match ? stripHtml(match[1]) : undefined;
}

function readFeedLink(block: string): string | undefined {
  const href = readXmlTagAttribute(block, "link", "href");
  if (href) return href;
  return readXmlTag(block, "link");
}

function parseFeedDate(block: string): string | undefined {
  const value = readXmlTag(block, "published") ?? readXmlTag(block, "updated") ?? readXmlTag(block, "pubDate");
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function readFeedAuthor(block: string): string | undefined {
  const authorBlock = block.match(/<author\b[^>]*>([\s\S]*?)<\/author>/i)?.[1];
  if (authorBlock) {
    const atomName = readXmlTag(authorBlock, "name");
    if (atomName) return atomName;
    const atomAuthor = stripHtml(authorBlock);
    if (atomAuthor) return atomAuthor;
  }
  return readXmlTag(block, "dc:creator") ?? readXmlTag(block, "author");
}

function steamReviewTitle(body: string, votedUp: boolean): string {
  const text = normalizeWhitespace(body);
  if (text) return text.slice(0, 80);
  return votedUp ? "Recommended Steam review" : "Not recommended Steam review";
}

function steamReviewCreatedAtIso(review: Record<string, unknown>): string | undefined {
  const createdAtSeconds = readNumber(review, "timestamp_created");
  if (createdAtSeconds === undefined) return undefined;
  const createdAtMs = createdAtSeconds * 1000;
  return Number.isFinite(createdAtMs) ? new Date(createdAtMs).toISOString() : undefined;
}

function steamReviewScore(review: Record<string, unknown>, votedUp: boolean): number {
  const votes = Math.max(1, Math.trunc(readNumber(review, "votes_up") ?? 0));
  return votedUp ? votes : -votes;
}

function parseSteamReviewsFeed(text: string, item: CommunitySearchQuery): SearchResult[] {
  const appId = item.steamAppId;
  if (!appId) return [];
  const payload = asRecord(JSON.parse(text));
  const success = payload.success;
  if (success !== 1 && success !== true) return [];
  const reviews = Array.isArray(payload.reviews) ? payload.reviews.map(asRecord) : [];

  return reviews.flatMap((review) => {
    const body = stripHtml(readString(review, "review") ?? "");
    if (!body) return [];
    const recommendationId = readString(review, "recommendationid") ?? stableId("steam_review", `${appId}:${body}`);
    const author = asRecord(review.author);
    const steamId = readString(author, "steamid");
    const votedUp = readBoolean(review, "voted_up") ?? sentimentFromText(body) !== "negative";
    return [{
      title: steamReviewTitle(body, votedUp),
      url: steamReviewSourceUrl(appId, recommendationId, steamId),
      snippet: body,
      displayUrl: `Steam app ${appId}`,
      author: steamId,
      publishedIso: steamReviewCreatedAtIso(review),
      score: steamReviewScore(review, votedUp),
      comments: 0,
    }];
  });
}

export function parseXmlSearchFeed(xml: string, source: CommunitySource): SearchResult[] {
  return feedBlocks(xml)
    .map((block) => {
      const title = readXmlTag(block, "title") ?? "";
      const link = readFeedLink(block) ?? "";
      const sourceUrl = readXmlTagAttribute(block, "source", "url");
      const sourceLabel = readXmlTag(block, "source");
      const snippet = readXmlTag(block, "content") ?? readXmlTag(block, "description") ?? sourceLabel ?? "";
      const displayUrl = sourceUrl ?? sourceLabel ?? safeHost(link);
      return {
        title,
        url: link,
        snippet,
        displayUrl,
        author: readFeedAuthor(block),
        publishedIso: parseFeedDate(block),
      };
    })
    .filter((result) => result.title && result.url && sourceMatches(source, result.url));
}

function publishedFallback(index: number): string {
  return new Date(Date.now() - (index + 1) * 60 * 60 * 1000).toISOString();
}

const COMMUNITY_STABLE_ID_VERSION = "community-stable-id/v2";
export const COMMUNITY_SOURCE_IDENTITY_VERSION = "community-source-identity/v2" as const;

function stableId(prefix: string, seed: string): string {
  const digest = createHash("sha256")
    .update(`${COMMUNITY_STABLE_ID_VERSION}\0${prefix}\0${seed}`)
    .digest("hex");
  return `${prefix}_v2_${digest.slice(0, 40)}`;
}

function normalizedPlatformHost(source: CommunitySource, host: string): string {
  const lowered = host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (source === "reddit" && ["old.reddit.com", "new.reddit.com", "np.reddit.com"].includes(lowered)) return "reddit.com";
  if (source === "x" && ["twitter.com", "mobile.twitter.com"].includes(lowered)) return "x.com";
  if (source === "discord" && lowered === "discordapp.com") return "discord.com";
  return lowered;
}

const COMMUNITY_TRACKING_QUERY_KEYS = new Set([
  "context", "fbclid", "feature", "gclid", "igshid", "ref", "ref_source", "ref_src", "s", "share",
  "share_id", "si", "source", "src", "t", "twclid", "utm_campaign", "utm_content", "utm_medium",
  "utm_name", "utm_source", "utm_term",
]);

/**
 * Canonical public identity input. It deliberately removes transport-only URL
 * differences while retaining the platform object id that distinguishes posts.
 */
export function canonicalCommunitySourceUrl(source: CommunitySource, rawValue: string): string {
  const value = unwrapDuckDuckGoUrl(rawValue.trim());
  try {
    const url = new URL(value);
    const steamReviewHash = source === "steam" ? url.hash.match(/^#review-([A-Za-z0-9_-]+)$/i)?.[1] : undefined;
    url.protocol = "https:";
    url.username = "";
    url.password = "";
    url.hostname = normalizedPlatformHost(source, url.hostname);
    url.port = "";
    url.hash = "";

    const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (source === "reddit") {
      const commentIndex = segments.findIndex((segment) => segment.toLowerCase() === "comments");
      if (commentIndex >= 0 && segments[commentIndex + 1]) {
        url.pathname = `/comments/${segments[commentIndex + 1].toLowerCase()}`;
      }
    } else if (source === "x") {
      const statusIndex = segments.findIndex((segment) => segment.toLowerCase() === "status");
      if (statusIndex >= 0 && segments[statusIndex + 1]) {
        url.pathname = `/i/status/${segments[statusIndex + 1]}`;
      }
    } else if (source === "discord") {
      if (url.hostname === "discord.gg" && segments[0]) url.pathname = `/${segments[0]}`;
      else if (segments[0]?.toLowerCase() === "invite" && segments[1]) url.pathname = `/invite/${segments[1]}`;
      else if (segments[0]?.toLowerCase() === "channels") url.pathname = `/${segments.slice(0, 4).join("/")}`;
    } else if (source === "steam") {
      const lowerSegments = segments.map((segment) => segment.toLowerCase());
      const appIndex = lowerSegments.findIndex((segment) => segment === "app" || segment === "appreviews");
      const recommendationIndex = lowerSegments.findIndex((segment) => segment === "recommended");
      if (appIndex >= 0 && segments[appIndex + 1]) url.pathname = `/${lowerSegments[appIndex]}/${segments[appIndex + 1]}`;
      else if (recommendationIndex >= 0 && segments[recommendationIndex + 1]) {
        const profileIndex = lowerSegments.findIndex((segment) => segment === "profiles" || segment === "id");
        const profile = profileIndex >= 0 && segments[profileIndex + 1] ? `${lowerSegments[profileIndex]}/${segments[profileIndex + 1]}` : "anonymous";
        url.pathname = `/${profile}/recommended/${segments[recommendationIndex + 1]}`;
      }
    }

    const kept = Array.from(url.searchParams.entries())
      .filter(([key]) => !COMMUNITY_TRACKING_QUERY_KEYS.has(key.toLowerCase()))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    url.search = "";
    for (const [key, child] of kept) url.searchParams.append(key, child);
    url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    if (steamReviewHash) url.hash = `review-${steamReviewHash}`;
    return url.toString();
  } catch {
    const platformId = value.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9_.:-]/g, "");
    if (!platformId) throw new Error("invalid-argument: community source identity is empty");
    return `${source}:id:${platformId}`;
  }
}

export function communitySourceIdentity(source: CommunitySource, rawValue: string): string {
  const canonicalSource = canonicalCommunitySourceUrl(source, rawValue);
  const digest = createHash("sha256")
    .update(`${COMMUNITY_SOURCE_IDENTITY_VERSION}\0${source}\0${canonicalSource}`)
    .digest("hex");
  return `community_source_v2_${digest}`;
}

function sentimentFromText(text: string): SentimentLabel {
  const lower = text.toLowerCase();
  if (/(love|best|great|good|fun|awesome|positive|좋|재미|최고)/.test(lower)) return "positive";
  if (/(bad|bug|scam|hate|broken|negative|싫|버그|최악)/.test(lower)) return "negative";
  return "neutral";
}

function asRequireModule<T>(moduleName: string): T | null {
  if (typeof require !== "function") return null;
  return require(moduleName) as T;
}

function vertexModule(): VertexModule | null {
  return asRequireModule<VertexModule>("./vertex");
}

function aiHubReportModule(): AiHubReportModule | null {
  return asRequireModule<AiHubReportModule>("./aiHubReport");
}

function adminDbModule(): { adminDb: FirestoreDb } | null {
  return asRequireModule<{ adminDb: FirestoreDb }>("./firebaseAdmin");
}

async function creatorIdentityModule(): Promise<CreatorIdentityModule> {
  if (typeof require === "function") return require("./creatorIdentity") as CreatorIdentityModule;
  const tsExtension = ".ts";
  return import(`./creatorIdentity${tsExtension}`) as Promise<CreatorIdentityModule>;
}

function communitySentimentModelId(): string {
  return vertexModule()?.selectVertexModelForTask("tagging") ?? COMMUNITY_SENTIMENT_MODEL_FALLBACK;
}

function redditCommentModelId(): string {
  return vertexModule()?.selectVertexModelForTask("comment_summary") ?? COMMUNITY_SENTIMENT_MODEL_FALLBACK;
}

async function defaultCommunitySentimentCallModel<T = unknown>(
  modelId: string,
  responseSchema: unknown,
  promptText: string,
): Promise<VertexResult<T>> {
  const vertex = vertexModule();
  if (!vertex) throw new Error("vertex callModel module is unavailable");
  return vertex.callModel<T>(modelId, responseSchema, promptText);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function postSentimentText(post: CommunityPostArtifact): string {
  return normalizeWhitespace(`${post.title}\n${stringField(post.excerpt)}`);
}

export function communitySentimentCacheKey(post: Pick<CommunityPostArtifact, "title"> & Record<string, unknown>): string {
  const title = stringField(post.title);
  const excerpt = stringField(post.excerpt);
  const semantic = normalizeWhitespace(`${title}\n${excerpt}`).toLowerCase();
  return `cs_${createHash("sha256").update(semantic).digest("hex").slice(0, 40)}`;
}

export function redditCommentAnalysisCacheKey(postId: string, comments: readonly string[]): string {
  const fingerprint = comments.map((comment) => normalizeWhitespace(comment).toLowerCase()).join("\n---\n");
  return `rc_${createHash("sha256").update(`${postId}\n${fingerprint}`).digest("hex").slice(0, 40)}`;
}

function normalizeConfidence(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : 0.5;
  return Math.max(0, Math.min(1, Number(numeric.toFixed(3))));
}

function normalizeThemes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueText(
    value
      .map((item) => typeof item === "string" ? item.trim().slice(0, 40) : "")
      .filter(Boolean),
    5,
  );
}

function normalizeSentimentLabel(value: unknown, fallback: SentimentLabel): SentimentLabel {
  return value === "positive" || value === "neutral" || value === "negative" ? value : fallback;
}

function normalizeSentimentClassification(value: unknown, fallbackText: string): CommunitySentimentClassification {
  const record = asRecord(value);
  const fallback = sentimentFromText(fallbackText);
  return {
    label: normalizeSentimentLabel(record.label, fallback),
    confidence: normalizeConfidence(record.confidence),
    themes: normalizeThemes(record.themes),
  };
}

function applySentimentClassification(post: CommunityPostArtifact, classification: CommunitySentimentClassification): CommunityPostArtifact {
  return {
    ...post,
    sentiment: classification.label,
    sentimentConfidence: classification.confidence,
    sentimentThemes: classification.themes,
  };
}

function applyRegexSentiment(post: CommunityPostArtifact): CommunityPostArtifact {
  return {
    ...post,
    sentiment: sentimentFromText(postSentimentText(post)),
  };
}

function sentimentCacheDoc(key: string): FirestoreDocRef {
  const module = adminDbModule();
  if (!module) throw new Error("Firestore sentiment cache is unavailable");
  return module.adminDb.collection(SENTIMENT_CACHE_COLLECTION).doc(key);
}

function commentAnalysisCacheDoc(key: string): FirestoreDocRef {
  const module = adminDbModule();
  if (!module) throw new Error("Firestore comment analysis cache is unavailable");
  return module.adminDb.collection(COMMENT_ANALYSIS_CACHE_COLLECTION).doc(key);
}

function firestoreSentimentCache(): CommunitySentimentCache {
  return {
    async get(key) {
      const snapshot = await sentimentCacheDoc(key).get();
      if (!snapshot.exists) return null;
      const record = snapshot.data() ?? {};
      const expiresAtIso = readString(record, "expiresAtIso");
      if (expiresAtIso && Date.now() > Date.parse(expiresAtIso)) return null;
      const classification = asRecord(record.classification);
      if (!readString(classification, "label")) return null;
      return normalizeSentimentClassification(classification, "");
    },
    async set(key, value, metadata) {
      await sentimentCacheDoc(key).set({
        key,
        classification: value,
        modelId: metadata.modelId,
        provider: metadata.provider,
        runId: metadata.runId,
        ttlSeconds: SENTIMENT_CACHE_TTL_SECONDS,
        expiresAtIso: new Date(Date.now() + SENTIMENT_CACHE_TTL_SECONDS * 1000).toISOString(),
        updatedAtIso: new Date().toISOString(),
      }, { merge: true });
    },
  };
}

function normalizeCommentSentiment(value: unknown): CommentSentimentBreakdown {
  const record = asRecord(value);
  const count = (key: keyof CommentSentimentBreakdown): number => {
    const raw = record[key];
    return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
  };
  return {
    positive: count("positive"),
    neutral: count("neutral"),
    negative: count("negative"),
  };
}

function normalizeRedditCommentAnalysis(value: unknown): RedditCommentAnalysis {
  const record = asRecord(value);
  return {
    commentSummary: readString(record, "commentSummary") ?? "",
    commentSentiment: normalizeCommentSentiment(record.commentSentiment),
    commentThemes: normalizeThemes(record.commentThemes),
  };
}

function firestoreRedditCommentAnalysisCache(): RedditCommentAnalysisCache {
  return {
    async get(key) {
      const snapshot = await commentAnalysisCacheDoc(key).get();
      if (!snapshot.exists) return null;
      const record = snapshot.data() ?? {};
      const expiresAtIso = readString(record, "expiresAtIso");
      if (expiresAtIso && Date.now() > Date.parse(expiresAtIso)) return null;
      const analysis = asRecord(record.analysis);
      if (!readString(analysis, "commentSummary")) return null;
      return normalizeRedditCommentAnalysis(analysis);
    },
    async set(key, value, metadata) {
      await commentAnalysisCacheDoc(key).set({
        key,
        analysis: value,
        modelId: metadata.modelId,
        provider: metadata.provider,
        runId: metadata.runId,
        ttlSeconds: COMMENT_ANALYSIS_CACHE_TTL_SECONDS,
        expiresAtIso: new Date(Date.now() + COMMENT_ANALYSIS_CACHE_TTL_SECONDS * 1000).toISOString(),
        updatedAtIso: new Date().toISOString(),
      }, { merge: true });
    },
  };
}

const COMMUNITY_SENTIMENT_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          index: { type: "integer" },
          label: { type: "string", enum: ["positive", "neutral", "negative"] },
          confidence: { type: "number" },
          themes: { type: "array", items: { type: "string" } },
        },
        required: ["id", "index", "label", "confidence", "themes"],
      },
    },
  },
  required: ["results"],
} as const;

const REDDIT_COMMENT_ANALYSIS_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    commentSummary: { type: "string" },
    commentSentiment: {
      type: "object",
      properties: {
        positive: { type: "integer" },
        neutral: { type: "integer" },
        negative: { type: "integer" },
      },
      required: ["positive", "neutral", "negative"],
    },
    commentThemes: { type: "array", items: { type: "string" } },
  },
  required: ["commentSummary", "commentSentiment", "commentThemes"],
} as const;

function communitySentimentPrompt(items: Array<{ index: number; post: CommunityPostArtifact }>): string {
  const posts = items.map(({ index, post }) => ({
    id: post.id,
    index,
    title: post.title.slice(0, 280),
    excerpt: stringField(post.excerpt).slice(0, 1600),
  }));
  return [
    "Classify sentiment for community posts about mobile games and creator/community feedback.",
    "Return JSON only. For each post, use label positive, neutral, or negative; confidence from 0 to 1; themes as short topical tags.",
    "Keep the results array aligned by the provided id and index. Do not include the raw post text in themes.",
    JSON.stringify({ posts }),
  ].join("\n");
}

function redditCommentAnalysisPrompt(post: CommunityPostArtifact, comments: readonly string[]): string {
  const payload = {
    post: {
      id: post.id,
      title: post.title.slice(0, 280),
      sourceUrl: post.sourceUrl,
    },
    comments: comments.map((body, index) => ({ index, body: body.slice(0, 1000) })),
  };
  return [
    "Summarize top Reddit comments for one mobile-game community post.",
    "Return JSON only with commentSummary, commentSentiment counts, and short commentThemes.",
    "Do not include raw comment bodies in themes.",
    JSON.stringify(payload),
  ].join("\n");
}

function resultItemsFromSentimentResponse(json: CommunitySentimentResponse): Record<string, unknown>[] {
  return Array.isArray(json.results) ? json.results.map(asRecord) : [];
}

function classificationForPost(
  results: Record<string, unknown>[],
  post: CommunityPostArtifact,
  index: number,
): CommunitySentimentClassification {
  const byId = results.find((item) => readString(item, "id") === post.id);
  const byIndex = results.find((item) => readNumber(item, "index") === index);
  return normalizeSentimentClassification(byId ?? byIndex ?? {}, postSentimentText(post));
}

async function logCommunitySentimentUsage(
  runId: string,
  result: VertexResult<CommunitySentimentResponse>,
  itemCount: number,
  cacheHits: number,
  latencyMs: number,
): Promise<void> {
  const usage = {
    event: "community_sentiment_llm_usage",
    runId,
    modelId: result.modelId,
    provider: result.provider,
    transport: result.transport ?? "unverified",
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    itemCount,
    cacheHits,
    cacheMisses: itemCount,
    latencyMs,
  };
  console.info("[community-sentiment]", usage);
  const aiHub = aiHubReportModule();
  if (!aiHub) return;
  await aiHub.reportLlmUsage({
    sessionId: aiHub.newSessionId(),
    toolId: "community.sentiment",
    modelId: result.modelId,
    provider: result.provider,
    transport: result.transport ?? "unverified",
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    totalCostUsd: result.estimatedCostUsd,
    latencyMs,
    actionId: runId,
  });
}

async function logRedditCommentAnalysisUsage(
  runId: string,
  result: VertexResult<RedditCommentAnalysisResponse>,
  commentCount: number,
  cacheKey: string,
  latencyMs: number,
): Promise<void> {
  const usage = {
    event: "reddit_comment_analysis_llm_usage",
    runId,
    modelId: result.modelId,
    provider: result.provider,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    commentCount,
    cacheKey,
    latencyMs,
  };
  console.info("[reddit-comments]", usage);
  const aiHub = aiHubReportModule();
  if (!aiHub) return;
  await aiHub.reportLlmUsage({
    sessionId: aiHub.newSessionId(),
    toolId: "community.redditComments",
    modelId: result.modelId,
    provider: result.provider,
    transport: result.transport ?? "unverified",
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    totalCostUsd: result.estimatedCostUsd,
    latencyMs,
    actionId: runId,
  });
}

function isRedditCommentsPermalink(value: string): boolean {
  if (!isSpecificResultUrl("reddit", value)) return false;
  try {
    const url = new URL(value);
    return url.hostname.endsWith("reddit.com") && url.pathname.includes("/comments/");
  } catch {
    return false;
  }
}

function redditCommentsJsonUrl(value: string, limit: number): string | undefined {
  if (!isRedditCommentsPermalink(value)) return undefined;
  const url = new URL(value);
  const pathname = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = pathname.endsWith(".json") ? pathname : `${pathname}.json`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort", "top");
  return url.toString();
}

function listingChildren(value: unknown): Record<string, unknown>[] {
  const listing = asRecord(value);
  const data = asRecord(listing.data);
  const children = data.children;
  return Array.isArray(children) ? children.map(asRecord) : [];
}

function parseRedditCommentsJson(text: string, limit: number): { numComments?: number; comments: string[] } {
  const payload = JSON.parse(text) as unknown;
  if (!Array.isArray(payload)) return { comments: [] };
  const postChildren = listingChildren(payload[0]);
  const postData = asRecord(postChildren.length > 0 ? postChildren[0].data : {});
  const numComments = readNumber(postData, "num_comments");
  const commentChildren = listingChildren(payload[1]);
  const comments: string[] = [];
  for (const child of commentChildren) {
    if (readString(child, "kind") !== "t1") continue;
    const data = asRecord(child.data);
    const body = readString(data, "body");
    if (!body || body === "[deleted]" || body === "[removed]") continue;
    comments.push(body);
    if (comments.length >= limit) break;
  }
  return { numComments, comments };
}

function postScoreValue(post: CommunityPostArtifact): number {
  const score = post.score;
  return typeof score === "number" && Number.isFinite(score) ? score : 0;
}

function applyRedditCommentAnalysis(
  post: CommunityPostArtifact,
  commentsCount: number,
  analysis: RedditCommentAnalysis,
): CommunityPostArtifact {
  return {
    ...post,
    comments: commentsCount,
    commentSummary: analysis.commentSummary,
    commentSentiment: analysis.commentSentiment,
    commentThemes: analysis.commentThemes,
  };
}

export async function enrichRedditComments(
  posts: CommunityPostArtifact[],
  options: RedditCommentOptions,
): Promise<RedditCommentEnrichmentResult> {
  if (posts.length === 0 || !options.enableComments || process.env.FUNCTIONS_EMULATOR === "true") {
    return { posts, externalRequests: 0 };
  }

  const maxPosts = Math.max(0, Math.min(MAX_REDDIT_COMMENT_POSTS, Math.trunc(options.maxPosts ?? MAX_REDDIT_COMMENT_POSTS)));
  const commentLimit = Math.max(1, Math.min(REDDIT_COMMENT_LIMIT, Math.trunc(options.commentLimit ?? REDDIT_COMMENT_LIMIT)));
  const eligible = posts
    .map((post, index) => ({ post, index }))
    .filter(({ post }) => post.sourceKey === "reddit" && isRedditCommentsPermalink(post.sourceUrl))
    .sort((left, right) => postScoreValue(right.post) - postScoreValue(left.post))
    .slice(0, maxPosts);

  if (eligible.length === 0) return { posts, externalRequests: 0 };

  const cache = options.cache ?? firestoreRedditCommentAnalysisCache();
  const fetchTextFn = options.fetchTextFn ?? fetchText;
  const callModelFn = options.callModelFn ?? defaultCommunitySentimentCallModel;
  const modelId = options.modelId ?? redditCommentModelId();
  const runId = options.runId ?? "reddit-comments";
  const enriched = [...posts];
  let externalRequests = 0;

  for (const item of eligible) {
    const jsonUrl = redditCommentsJsonUrl(item.post.sourceUrl, commentLimit);
    if (!jsonUrl) continue;

    let parsed: { numComments?: number; comments: string[] };
    try {
      externalRequests += 1;
      const response = await fetchTextFn(jsonUrl);
      if (response.status >= 400) continue;
      parsed = parseRedditCommentsJson(response.text, commentLimit);
    } catch (error) {
      console.warn("[reddit-comments] fetch failed; leaving post unchanged", {
        runId,
        postId: item.post.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const commentsCount = parsed.numComments ?? item.post.comments ?? 0;
    if (parsed.comments.length === 0) {
      enriched[item.index] = { ...item.post, comments: commentsCount };
      continue;
    }

    const cacheKey = redditCommentAnalysisCacheKey(item.post.id, parsed.comments);
    const cached = await cache.get(cacheKey);
    if (cached) {
      enriched[item.index] = applyRedditCommentAnalysis(item.post, commentsCount, cached);
      continue;
    }

    const startedAt = Date.now();
    let result: VertexResult<RedditCommentAnalysisResponse>;
    try {
      result = await callModelFn<RedditCommentAnalysisResponse>(
        modelId,
        REDDIT_COMMENT_ANALYSIS_RESPONSE_SCHEMA,
        redditCommentAnalysisPrompt(item.post, parsed.comments),
      );
      const analysis = normalizeRedditCommentAnalysis(result.json);
      await cache.set(cacheKey, analysis, {
        modelId: result.modelId,
        provider: result.provider,
        runId,
      });
      enriched[item.index] = applyRedditCommentAnalysis(item.post, commentsCount, analysis);
      await logRedditCommentAnalysisUsage(runId, result, parsed.comments.length, cacheKey, Date.now() - startedAt);
    } catch (error) {
      console.warn("[reddit-comments] LLM analysis failed; leaving post unchanged", {
        runId,
        postId: item.post.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { posts: enriched, externalRequests };
}

export async function enrichCommunityPostSentiments(
  posts: CommunityPostArtifact[],
  options: CommunitySentimentOptions,
): Promise<CommunityPostArtifact[]> {
  if (posts.length === 0) return posts;
  if (!options.enableLlm || process.env.FUNCTIONS_EMULATOR === "true") return posts.map(applyRegexSentiment);

  const cache = options.cache ?? firestoreSentimentCache();
  const enriched = [...posts];
  const misses: Array<{ index: number; post: CommunityPostArtifact; key: string }> = [];
  let cacheHits = 0;

  for (let index = 0; index < enriched.length; index += 1) {
    const post = enriched[index];
    const key = communitySentimentCacheKey(post);
    const cached = await cache.get(key);
    if (cached) {
      cacheHits += 1;
      enriched[index] = applySentimentClassification(post, cached);
    } else {
      misses.push({ index, post, key });
    }
  }

  if (misses.length === 0) return enriched;

  const modelId = options.modelId ?? communitySentimentModelId();
  const callModelFn = options.callModelFn ?? defaultCommunitySentimentCallModel;
  const startedAt = Date.now();
  let result: VertexResult<CommunitySentimentResponse>;
  try {
    result = await callModelFn<CommunitySentimentResponse>(
      modelId,
      COMMUNITY_SENTIMENT_RESPONSE_SCHEMA,
      communitySentimentPrompt(misses),
    );
  } catch (error) {
    console.warn("[community-sentiment] LLM classification failed; using regex fallback", {
      runId: options.runId ?? "community-sentiment",
      error: error instanceof Error ? error.message : String(error),
      cacheHits,
      cacheMisses: misses.length,
    });
    for (const miss of misses) {
      enriched[miss.index] = applyRegexSentiment(miss.post);
    }
    return enriched;
  }

  const results = resultItemsFromSentimentResponse(result.json);
  await Promise.all(misses.map(async (miss) => {
    const classification = classificationForPost(results, miss.post, miss.index);
    enriched[miss.index] = applySentimentClassification(miss.post, classification);
    await cache.set(miss.key, classification, {
      modelId: result.modelId,
      provider: result.provider,
      runId: options.runId ?? "community-sentiment",
    });
  }));
  await logCommunitySentimentUsage(options.runId ?? "community-sentiment", result, misses.length, cacheHits, Date.now() - startedAt);
  return enriched;
}

function resultScore(result: SearchResult, index: number): number {
  const text = `${result.title} ${result.snippet}`.toLowerCase();
  const relevance = ["supercent", "xphero", "xp hero", "pizza ready", "burger please", "snake clash", "mobile game", "creator"].reduce((sum, token) => sum + (text.includes(token) ? 15 : 0), 30);
  return Math.max(1, Math.min(100, relevance - index * 4));
}

function compactText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "");
}

function candidateArtifactLimit(resultLimit: number): number {
  return Math.min(MAX_CANDIDATE_ARTIFACTS, Math.max(12, resultLimit));
}

function relevanceVariants(value: string): string[] {
  const compact = compactText(value);
  return compact.length >= 4 ? [compact] : [];
}

function hasReviewContext(result: SearchResult, data: ParsedCommunityDiscoveryData, item: CommunitySearchQuery): boolean {
  const compact = compactText(`${result.title} ${result.snippet} ${result.displayUrl} ${result.url}`);
  const signalTerms = [
    item.keyword,
    ...data.ugcKeywords,
    ...COMMUNITY_REVIEW_CONTEXT_TERMS,
  ]
    .filter(Boolean)
    .flatMap((term) => relevanceVariants(term));
  return signalTerms.some((term) => compact.includes(term));
}

function ownedGameQueryTerms(data: ParsedCommunityDiscoveryData): string[] {
  return uniqueText([
    ...data.ownedGameTags,
    data.gameId && data.gameId !== "flu-casual" ? data.gameId : "",
  ], MAX_OWNED_GAME_QUERY_TERMS);
}

function similarGameQueryTerms(data: ParsedCommunityDiscoveryData, ownedTerms = ownedGameQueryTerms(data)): string[] {
  const ownedKeys = new Set(ownedTerms.map(canonicalGameKey));
  return uniqueText(data.similarGameTags ?? [], MAX_SIMILAR_GAME_QUERY_TERMS)
    .filter((term) => !ownedKeys.has(canonicalGameKey(term)));
}

function relevantGameTerms(data: ParsedCommunityDiscoveryData): string[] {
  const ownedTerms = ownedGameQueryTerms(data);
  return uniqueText([
    ...ownedTerms,
    ...similarGameQueryTerms(data, ownedTerms),
  ], MAX_RELEVANT_GAME_QUERY_TERMS);
}

function matchedRelevantGame(result: SearchResult, data: ParsedCommunityDiscoveryData): string | undefined {
  const searchable = `${result.title} ${result.snippet} ${result.displayUrl} ${result.url}`;
  const compact = compactText(searchable);
  return relevantGameTerms(data).find((term) => relevanceVariants(term).some((variant) => compact.includes(variant)));
}

function resultIsRelevant(result: SearchResult, data: ParsedCommunityDiscoveryData, item: CommunitySearchQuery): boolean {
  const hasSignal = hasReviewContext(result, data, item);
  return Boolean(matchedRelevantGame(result, data) && hasSignal);
}

function ownedOfficialTokensForResult(result: SearchResult, item: CommunitySearchQuery): string[] {
  return [
    result.author ?? "",
    result.url,
    normalizedResultSourceUrl(result, item),
    result.title,
    result.displayUrl,
    item.subreddit ? `r/${item.subreddit}` : "",
    item.subreddit ?? "",
  ].filter(Boolean);
}

function sourceReportReason(adapter: SourceAdapterResult["adapter"], excludedOwnedOfficial: number): string | undefined {
  const reasons = [
    adapter !== "public-search" ? `adapter:${adapter}` : "",
    excludedOwnedOfficial > 0 ? `excluded_owned_official:${excludedOwnedOfficial}` : "",
  ].filter(Boolean);
  return reasons.length > 0 ? reasons.join("|") : undefined;
}

function candidateFromResult(result: SearchResult, item: CommunitySearchQuery, data: ParsedCommunityDiscoveryData, runId: string, index: number): CommunityCandidateArtifact {
  const host = safeHost(result.url);
  const source = item.source;
  const label = communitySourceLabel(source);
  const game = matchedRelevantGame(result, data) ?? item.gameTag ?? data.gameId;
  const sourceUrl = normalizedResultSourceUrl(result, item);
  const sourceIdentity = communitySourceIdentity(source, sourceUrl);
  const name = result.title.split(/[|—-]/)[0]?.trim().slice(0, 80) || `${communitySourceLabel(source)} signal`;
  return {
    id: stableId("community_candidate", `${sourceIdentity}:${game}:${item.keyword}`),
    name,
    handle: host ? `@${host.split(".")[0]}` : `@${source}_${index + 1}`,
    avatar: label.slice(0, 2).toUpperCase(),
    followers: null,
    region: "GLOBAL",
    category: game,
    matchedGame: game,
    matchScore: resultScore(result, index),
    email: null,
    emailStatus: "none",
    emailSource: null,
    confidence: 55,
    platform: label,
    channelRef: `community_signal_${sourceIdentity}`,
    queryRef: runId,
    recentActivity: result.snippet || `${label} 공개 검색 결과`,
    discoverySignals: ["community", source, "publicSearch", game, item.keyword],
    source: "public-community-search",
    sourceIdentity,
    sourceNote: `${label} public search signal`,
    sourcePlatform: label,
    sourceKey: source,
    discoverySource: "community-public-search",
    sourceUrl,
    externalProfileUrl: sourceUrl,
    sourceDisplayUrl: result.displayUrl,
    ...(result.author ? { author: result.author } : {}),
  };
}

function postFromResult(result: SearchResult, item: CommunitySearchQuery, data: ParsedCommunityDiscoveryData, runId: string, index: number): CommunityPostArtifact {
  const source = item.source;
  const label = communitySourceLabel(source);
  const createdAtIso = result.publishedIso ?? new Date().toISOString();
  const freshnessConfidence = result.publishedIso ? FRESHNESS_CONFIDENCE.observed : FRESHNESS_CONFIDENCE.unknown;
  const game = matchedRelevantGame(result, data) ?? item.gameTag ?? data.gameId;
  const sourceUrl = normalizedResultSourceUrl(result, item);
  const sourceIdentity = communitySourceIdentity(source, sourceUrl);
  return {
    id: stableId("community", `${runId}:${sourceIdentity}`),
    sourceIdentity,
    sourceRequestId: sourceIdentity,
    source: label,
    sourceKey: source,
    subreddit: item.subreddit ? `r/${item.subreddit}` : safeHost(result.url) || label,
    title: result.title,
    sentiment: sentimentFromText(`${result.title} ${result.snippet}`),
    score: result.score ?? resultScore(result, index),
    comments: result.comments ?? 0,
    time: result.publishedIso ?? "게시일 확인 필요",
    createdAtIso,
    publishedIso: result.publishedIso ?? null,
    collectedAtIso: createdAtIso,
    freshnessConfidence,
    game,
    matchedGame: game,
    keywords: [item.keyword, game],
    ugcMatched: true,
    discoveryRunId: runId,
    sourceUrl,
    excerpt: result.snippet,
    sourceDisplayUrl: result.displayUrl,
    ...(result.author ? { author: result.author } : {}),
  };
}

function sourceFeedUrl(source: CommunitySource, keyword: string, subreddit?: string): string {
  const query = encodeURIComponent(`${keyword} Supercent gameplay creator`);
  if (source === "reddit") {
    return subreddit
      ? `https://www.reddit.com/r/${subreddit}/search/?q=${query}&restrict_sr=1&sort=new`
      : `https://www.reddit.com/search/?q=${query}&sort=new`;
  }
  if (source === "x") return `https://x.com/search?q=${query}&f=live`;
  if (source === "discord") return "https://discord.gg/supercent-creators";
  if (source === "steam") return steamStoreSearchUrl(keyword);
  return `https://www.google.com/search?q=${query}`;
}

function sourceFeedUrlForItem(item: CommunitySearchQuery, keyword: string): string {
  if (item.source === "steam" && item.steamAppId) return steamStorePageUrl(item.steamAppId);
  return sourceFeedUrl(item.source, keyword, item.subreddit);
}

function isBlockedResultHost(url: URL): boolean {
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  return host === "facebook.com" || host === "m.facebook.com" || host === "fb.com" || host.endsWith(".facebook.com");
}

function isSpecificResultUrl(source: CommunitySource, value: string): boolean {
  try {
    const url = new URL(value);
    if (source === "reddit") {
      if (url.hostname.endsWith("redd.it")) return url.pathname !== "/";
      return url.hostname.endsWith("reddit.com") && (url.pathname.includes("/comments/") || (url.pathname.includes("/search") && Boolean(url.searchParams.get("q"))));
    }
    if (source === "x") return (url.hostname.endsWith("x.com") || url.hostname.endsWith("twitter.com")) && (url.pathname.includes("/status/") || (url.pathname.startsWith("/search") && Boolean(url.searchParams.get("q"))));
    if (source === "discord") {
      if (url.hostname.endsWith("discord.gg")) return url.pathname !== "/";
      if (!url.hostname.endsWith("discord.com") || url.pathname.startsWith("/channels/@me")) return false;
      return url.pathname.startsWith("/channels/") || url.pathname.startsWith("/invite/");
    }
    if (source === "steam") return sourceMatches(source, value) && url.pathname !== "/";
    return !isBlockedResultHost(url);
  } catch {
    return false;
  }
}

function normalizedResultSourceUrl(result: SearchResult, item: CommunitySearchQuery): string {
  const rawUrl = isSpecificResultUrl(item.source, result.url)
    ? result.url
    : sourceFeedUrlForItem(item, result.title || item.keyword);
  return canonicalCommunitySourceUrl(item.source, rawUrl);
}

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
  });
  return { status: response.status, text: await response.text() };
}

async function searchReader(query: string): Promise<{ status: number; text: string }> {
  return fetchText(readerUrl(query));
}

async function searchSourceSpecificPublicResults(item: CommunitySearchQuery): Promise<SourceAdapterResult> {
  const { source, query, subreddit } = item;
  if (OFFICIAL_API_REQUIRED_SOURCES.has(source) && !officialApiConfigured(source)) {
    return { adapter: "public-search", results: [], externalRequests: 0, reason: `${source}_official_api_required` };
  }
  const adapterQuery = sourceSpecificQuery(source, query);
  if (source === "steam") {
    if (!item.steamAppId) {
      return { adapter: "steam-appreviews", results: [], externalRequests: 0, reason: "steam_app_id_missing", skipReader: true };
    }
    const response = await fetchText(steamAppReviewsUrl(item.steamAppId, item.steamLanguage));
    if (response.status >= 400) {
      return { adapter: "steam-appreviews", results: [], externalRequests: 1, reason: `steam_appreviews_status_${response.status}`, skipReader: true };
    }
    return {
      adapter: "steam-appreviews",
      results: parseSteamReviewsFeed(response.text, item),
      externalRequests: 1,
      skipReader: true,
    };
  }
  if (source === "reddit") {
    const response = await fetchText(redditRssUrl(adapterQuery, subreddit));
    if (response.status >= 400) {
      return { adapter: "reddit-rss", results: [], externalRequests: 1, reason: `reddit_rss_status_${response.status}` };
    }
    return {
      adapter: "reddit-rss",
      results: parseXmlSearchFeed(response.text, source),
      externalRequests: 1,
    };
  }
  if (source === "web") {
    const response = await fetchText(googleNewsRssUrl(adapterQuery));
    if (response.status >= 400) {
      return { adapter: "google-news-rss", results: [], externalRequests: 1, reason: `google_news_rss_status_${response.status}` };
    }
    return {
      adapter: "google-news-rss",
      results: parseXmlSearchFeed(response.text, source),
      externalRequests: 1,
    };
  }
  return { adapter: "public-search", results: [], externalRequests: 0 };
}

function reportStatus(source: CommunitySource, query: string, status: CommunitySourceReport["status"], resultCount: number, reason?: string): CommunitySourceReport {
  return {
    source: communitySourceLabel(source),
    sourceKey: source,
    query,
    status,
    resultCount,
    ...(reason ? { reason } : {}),
  };
}

export async function searchCommunitySources(
  data: ParsedCommunityDiscoveryData,
  runId: string,
  options: SearchCommunitySourcesOptions = {},
): Promise<CommunitySearchArtifacts> {
  const posts: CommunityPostArtifact[] = [];
  const candidates = new Map<string, CommunityCandidateArtifact>();
  const seenSourceIdentities = new Set<string>();
  const reports: CommunitySourceReport[] = [];
  const queries = buildCommunitySearchQueries(data);
  const candidateLimit = candidateArtifactLimit(data.resultLimit);
  let externalRequests = 0;
  const plannedSources = new Set(queries.map((item) => item.source));
  const creatorIdentity = await creatorIdentityModule();

  for (const source of data.sources) {
    if (!plannedSources.has(source)) {
      reports.push(reportStatus(source, `${source}:unconfigured`, "no_results", 0, source === "steam" ? "steam_app_ids_unconfigured" : "no_queries"));
    }
  }

  for (const item of queries) {
    try {
      if (OFFICIAL_API_REQUIRED_SOURCES.has(item.source) && !officialApiConfigured(item.source)) {
        reports.push(reportStatus(item.source, item.query, "auth_required", 0, "x_official_api_required"));
        continue;
      }
      const sourceSpecific = await searchSourceSpecificPublicResults(item);
      externalRequests += sourceSpecific.externalRequests;
      const rawResults = [...sourceSpecific.results];

      if (!sourceSpecific.skipReader) {
        externalRequests += 1;
        const response = await searchReader(item.query);
        if (response.status >= 400) {
          if (rawResults.length === 0) {
            reports.push(reportStatus(item.source, item.query, "blocked", 0, sourceSpecific.reason ?? `reader_status_${response.status}`));
            continue;
          }
        } else {
          rawResults.push(...parseDuckDuckGoMarkdown(response.text, item.source));
        }
      }

      const results: SearchResult[] = [];
      let excludedOwnedOfficial = 0;
      for (const result of rawResults) {
        if (!resultIsRelevant(result, data, item)) continue;
        const sourceIdentity = communitySourceIdentity(item.source, normalizedResultSourceUrl(result, item));
        if (seenSourceIdentities.has(sourceIdentity)) continue;
        if (creatorIdentity.isOwnedOfficialIdentity(ownedOfficialTokensForResult(result, item), data.officialChannels)) {
          excludedOwnedOfficial += 1;
          continue;
        }
        // Reserve the canonical object identity at acceptance time. Deferring this
        // until after the loop lets RSS + reader aliases from the same query both
        // enter `results` and produce duplicate stable document ids.
        seenSourceIdentities.add(sourceIdentity);
        results.push(result);
        if (results.length >= Math.max(1, data.resultLimit - posts.length)) break;
      }
      if (results.length === 0) {
        const status = item.source === "discord" ? "auth_required" : "no_results";
        reports.push(reportStatus(
          item.source,
          item.query,
          status,
          0,
          status === "auth_required"
            ? "public_discord_messages_not_searchable_without_workspace_or_bot"
            : excludedOwnedOfficial > 0
              ? `excluded_owned_official:${excludedOwnedOfficial}`
              : sourceSpecific.reason,
        ));
        continue;
      }
      reports.push(reportStatus(item.source, item.query, "ok", results.length, sourceReportReason(sourceSpecific.adapter, excludedOwnedOfficial)));
      results.forEach((result, index) => {
        if (posts.length < data.resultLimit) posts.push(postFromResult(result, item, data, runId, posts.length));
        const candidate = candidateFromResult(result, item, data, runId, index);
        if (candidates.size < candidateLimit && !candidates.has(candidate.id)) candidates.set(candidate.id, candidate);
      });
    } catch (error) {
      reports.push(reportStatus(item.source, item.query, "error", 0, error instanceof Error ? error.message : "unknown_error"));
    }
  }

  const redditComments = await enrichRedditComments(posts, {
    enableComments: options.enableRedditComments === true,
    runId,
  });
  externalRequests += redditComments.externalRequests;

  const enrichedPosts = await enrichCommunityPostSentiments(redditComments.posts, {
    enableLlm: options.enableLlmSentiment === true,
    runId,
  });

  return {
    mode: "live-public-search",
    posts: sortCommunityPostsByFreshness(enrichedPosts),
    candidates: Array.from(candidates.values()).slice(0, candidateLimit),
    reports,
    externalRequests,
  };
}

// 반환 직전 최신순 정렬: 소스/쿼리 어댑터가 도착한 순서(웹 SEO vs 신선한 Reddit 등)가 아니라
// 실제 publishedIso 기준 desc로 재정렬하고, publishedIso를 모르는 게시물은 후순위로 보낸다.
// 소비처 확인: Firestore batch write는 id 기준(순서 무관), enrichRedditComments/enrichCommunityPostSentiments는
// 전달받은 배열 자체의 index로 자기참조하므로 이 정렬을 거친 뒤에도 안전하다.
export function sortCommunityPostsByFreshness(posts: CommunityPostArtifact[]): CommunityPostArtifact[] {
  return [...posts].sort((left, right) => {
    const leftMs = typeof left.publishedIso === "string" ? Date.parse(left.publishedIso) : NaN;
    const rightMs = typeof right.publishedIso === "string" ? Date.parse(right.publishedIso) : NaN;
    const leftKnown = Number.isFinite(leftMs);
    const rightKnown = Number.isFinite(rightMs);
    if (leftKnown && rightKnown) return rightMs - leftMs;
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    return 0;
  });
}

export function buildCommunityFallbackArtifacts(data: ParsedCommunityDiscoveryData, runId: string): CommunitySearchArtifacts {
  const posts: CommunityPostArtifact[] = [];
  const candidates: CommunityCandidateArtifact[] = [];
  const fallbackGameTerms = relevantGameTerms(data);
  const cappedKeywords = uniqueText(fallbackGameTerms.length > 0 ? fallbackGameTerms : data.keywords, Math.max(1, Math.min(6, data.resultLimit)));
  const ugcKeyword = data.ugcKeywords[0] ?? "gameplay";
  const candidateLimit = candidateArtifactLimit(data.resultLimit);
  const fallbackSubreddits = uniqueText([
    ...canonicalSubredditsForGameTerms(cappedKeywords),
    ...data.communitySubreddits.map(sanitizeSubreddit).filter(Boolean),
  ], MAX_REDDIT_SUBREDDITS);
  let artifactIndex = 0;

  for (const source of data.sources) {
    for (const keyword of cappedKeywords) {
      artifactIndex += 1;
      const label = communitySourceLabel(source);
      const createdAtIso = publishedFallback(artifactIndex);
      const redditSubreddit = source === "reddit" ? subredditForGameTerm(keyword, fallbackSubreddits, artifactIndex) : undefined;
      const steamAppId = source === "steam" ? data.steamAppIds[(artifactIndex - 1) % Math.max(1, data.steamAppIds.length)] : undefined;
      const sourceUrl = canonicalCommunitySourceUrl(
        source,
        source === "steam" && steamAppId ? steamStorePageUrl(steamAppId) : sourceFeedUrl(source, keyword, redditSubreddit ?? undefined),
      );
      const sourceIdentity = communitySourceIdentity(source, sourceUrl);
      posts.push({
        id: stableId("community", `${runId}:${sourceIdentity}`),
        sourceIdentity,
        sourceRequestId: sourceIdentity,
        source: label,
        sourceKey: source,
        subreddit: source === "reddit" ? `r/${redditSubreddit ?? "XPHero"}` : label,
        title: `${keyword} ${ugcKeyword} 공개 커뮤니티 검색 대기`,
        sentiment: "neutral",
        score: source === "steam" ? 1 : 40,
        comments: 0,
        time: createdAtIso,
        createdAtIso,
        game: keyword,
        matchedGame: keyword,
        keywords: [keyword, ugcKeyword],
        ugcMatched: true,
        discoveryRunId: runId,
        sourceUrl,
        excerpt: "에뮬레이터에서는 외부 검색을 호출하지 않고 동일한 저장 경로만 검증합니다.",
      });
      if (candidates.length < candidateLimit) {
        candidates.push({
          id: stableId("community_candidate", `${sourceIdentity}:${keyword}`),
          name: `${keyword} Community Signal`,
          handle: `@${keyword.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "creator"}_${source}`,
          avatar: label.slice(0, 2).toUpperCase(),
          followers: null,
          region: data.filters.regions[0] ?? "GLOBAL",
          category: keyword,
          matchedGame: keyword,
          matchScore: 55,
          email: null,
          emailStatus: "none",
          emailSource: null,
          confidence: 50,
          platform: label,
          channelRef: `community_signal_${source}_${artifactIndex}`,
          queryRef: runId,
          recentActivity: `${label} 공개 검색 대기`,
          discoverySignals: ["community", source, "emulatorFallback", keyword, ugcKeyword],
          source: "community-adapter-fallback",
          sourceIdentity,
          sourceNote: `${label} emulator public-search fallback`,
          sourcePlatform: label,
          sourceKey: source,
          discoverySource: "community-emulator-fallback",
          sourceUrl,
          externalProfileUrl: sourceUrl,
        });
      }
    }
  }

  return {
    mode: "emulator-fallback",
    posts: posts.slice(0, data.resultLimit),
    candidates,
    reports: data.sources.map((source) => reportStatus(source, `${source}:emulator`, "no_results", 0, "emulator_external_search_disabled")),
    externalRequests: 0,
  };
}
