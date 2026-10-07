import type { ChannelStat, Creator, RecCandidate } from "../data.ts";
import { diversifySimilarResults } from "./similar-diversity.ts";
import type { SimilarCreatorResult } from "./similar-types.ts";

export type { SimilarCreatorResult } from "./similar-types.ts";

type VisibleRecord = {
  archivedAt?: string;
  deletedAt?: string;
};

export type SearchableCreator = Creator & VisibleRecord;
export type SearchableRecCandidate = RecCandidate & VisibleRecord;

export interface CreatorSearchMatch<T extends SearchableCreator = SearchableCreator> {
  creator: T;
  score: number;
  matchedFields: string[];
}

const FIELD_WEIGHTS = {
  name: 36,
  handle: 34,
  email: 30,
  channel: 30,
  category: 20,
  platform: 12,
  region: 10,
  owner: 8,
} as const;

const CATEGORY_SPLIT = /[\/,\s·|_-]+/;
const SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "channel",
  "creator",
  "creators",
  "influencer",
  "influencers",
  "no",
  "of",
  "official",
  "such",
  "the",
  "to",
]);

export function isVisibleSearchRecord(record: VisibleRecord): boolean {
  return !record.deletedAt && !record.archivedAt;
}

export function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/^@/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

export function tokenizeSearchQuery(query: string): string[] {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];
  const rawTokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const searchableTokens = rawTokens.filter((token) => token.length >= 2 && !SEARCH_STOPWORDS.has(token));
  const phrase = rawTokens.some((token) => SEARCH_STOPWORDS.has(token)) ? searchableTokens.join(" ") : normalized;
  return Array.from(new Set([phrase, ...searchableTokens].filter(Boolean)));
}

function categoryTokens(value: unknown): string[] {
  return normalizeSearchText(value)
    .split(CATEGORY_SPLIT)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function fieldMatchScore(fieldValue: unknown, tokens: readonly string[], weight: number): number {
  const text = normalizeSearchText(fieldValue);
  if (!text) return 0;
  return tokens.reduce((score, token) => {
    if (!token) return score;
    if (text === token) return Math.max(score, weight);
    if (text.startsWith(token)) return Math.max(score, Math.round(weight * 0.86));
    if (token.length >= 3 && text.length >= 3 && (text.includes(token) || token.includes(text))) {
      return Math.max(score, Math.round(weight * 0.65));
    }
    return score;
  }, 0);
}

function creatorFieldScores(creator: SearchableCreator, tokens: readonly string[]): Record<keyof typeof FIELD_WEIGHTS, number> {
  return {
    name: fieldMatchScore(creator.name, tokens, FIELD_WEIGHTS.name),
    handle: fieldMatchScore(creator.handle, tokens, FIELD_WEIGHTS.handle),
    email: fieldMatchScore(creator.email ?? creator.profileMatchedEmail, tokens, FIELD_WEIGHTS.email),
    channel: fieldMatchScore(creator.channelId ?? creator.youtubeUrl, tokens, FIELD_WEIGHTS.channel),
    category: fieldMatchScore(creator.category, tokens, FIELD_WEIGHTS.category),
    platform: fieldMatchScore(creator.platform ?? creator.primaryPlatform, tokens, FIELD_WEIGHTS.platform),
    region: fieldMatchScore(creator.region, tokens, FIELD_WEIGHTS.region),
    owner: fieldMatchScore(creator.owner, tokens, FIELD_WEIGHTS.owner),
  };
}

function metricBoost(creator: SearchableCreator, channelStats: Record<string, ChannelStat>): number {
  const stat = channelStats[creator.id];
  const recentViews = stat?.recentViews ?? 0;
  const engagement = stat?.engagement ?? 0;
  const recentBoost = recentViews > 0 ? Math.min(12, Math.log10(recentViews + 1) * 2) : 0;
  const followerBoost = creator.followers > 0 ? Math.min(10, Math.log10(creator.followers + 1) * 1.4) : 0;
  return Math.round(recentBoost + followerBoost + Math.min(6, engagement));
}

export function rankCreatorSearchResults<T extends SearchableCreator>(
  creators: readonly T[],
  query: string,
  channelStats: Record<string, ChannelStat> = {},
): CreatorSearchMatch<T>[] {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) return [];

  return creators
    .filter(isVisibleSearchRecord)
    .map((creator) => {
      const fieldScores = creatorFieldScores(creator, tokens);
      const matchedFields = Object.entries(fieldScores)
        .filter(([, score]) => score > 0)
        .map(([field]) => field);
      const score = Object.values(fieldScores).reduce((sum, value) => sum + value, 0) + (matchedFields.length > 0 ? metricBoost(creator, channelStats) : 0);
      return { creator, score, matchedFields };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || (right.creator.followers ?? 0) - (left.creator.followers ?? 0) || left.creator.name.localeCompare(right.creator.name));
}

function categoryOverlapScore(left: unknown, right: unknown): number {
  const leftTokens = new Set(categoryTokens(left));
  const rightTokens = categoryTokens(right);
  if (leftTokens.size === 0 || rightTokens.length === 0) return 0;
  return rightTokens.reduce((score, token) => score + (leftTokens.has(token) ? 1 : 0), 0);
}

function candidateSimilarityScore(
  target: SearchableCreator,
  candidate: SearchableCreator | SearchableRecCandidate,
  channelStats: Record<string, ChannelStat>,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  const categoryScore = categoryOverlapScore(target.category, candidate.category);
  if (categoryScore > 0) {
    score += 42 + Math.min(12, categoryScore * 6);
    reasons.push("같은 카테고리");
  }

  if (normalizeSearchText(target.platform) === normalizeSearchText(candidate.platform)) {
    score += 16;
    reasons.push("같은 플랫폼");
  }

  if (normalizeSearchText(target.region) === normalizeSearchText(candidate.region)) {
    score += 14;
    reasons.push("같은 지역");
  }

  if ("matchScore" in candidate && typeof candidate.matchScore === "number") {
    score += Math.round(candidate.matchScore * 0.34);
    if (candidate.matchScore >= 80) reasons.push("유사 시청자층");
  }

  const targetViews = channelStats[target.id]?.recentViews ?? 0;
  const candidateViews = channelStats[candidate.id]?.recentViews ?? 0;
  if (targetViews > 0 && candidateViews > 0) {
    const ratio = Math.min(targetViews, candidateViews) / Math.max(targetViews, candidateViews);
    if (ratio >= 0.3) {
      score += Math.round(ratio * 16);
      reasons.push("최근 조회수 규모 유사");
    }
  }

  return { score, reasons: Array.from(new Set(reasons)) };
}

function toSimilarResult(
  candidate: SearchableCreator | SearchableRecCandidate,
  score: number,
  reasons: readonly string[],
): SimilarCreatorResult {
  return {
    id: candidate.id,
    name: candidate.name,
    handle: candidate.handle,
    avatar: candidate.avatar,
    platform: candidate.platform,
    category: candidate.category,
    region: candidate.region,
    score,
    matchReason: reasons[0] ?? "유사 신호",
  };
}

export function buildSimilarCreatorResults({
  target,
  creators,
  recCandidates,
  channelStats = {},
  excludeIds = new Set<string>(),
  limit = 6,
}: {
  target: SearchableCreator;
  creators: readonly SearchableCreator[];
  recCandidates: readonly SearchableRecCandidate[];
  channelStats?: Record<string, ChannelStat>;
  excludeIds?: Set<string>;
  limit?: number;
}): SimilarCreatorResult[] {
  const seen = new Set<string>([target.id, ...excludeIds]);
  const candidates: SimilarCreatorResult[] = [];

  for (const candidate of [...creators, ...recCandidates]) {
    if (!isVisibleSearchRecord(candidate) || seen.has(candidate.id)) continue;
    const { score, reasons } = candidateSimilarityScore(target, candidate, channelStats);
    if (score <= 0) continue;
    seen.add(candidate.id);
    candidates.push(toSimilarResult(candidate, score, reasons));
  }

  return diversifySimilarResults(
    candidates.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name)),
    limit,
  );
}
