import type { ChannelStat, CreatorComment, RecCandidate, VideoItem } from "../data.ts";

export type CandidateHoverVideo = {
  readonly title: string;
  readonly views: number;
  readonly likes: number;
  readonly comments: number;
  readonly published: string;
};

export type CandidateHoverComment = {
  readonly author: string;
  readonly text: string;
  readonly time: string;
};

export type CandidateHoverIntelligence = {
  readonly recentVideos: readonly CandidateHoverVideo[];
  readonly recentComments: readonly CandidateHoverComment[];
  readonly avgViews: number;
  readonly recentViews: number;
  readonly commentCount: number;
  readonly engagement: number | null;
  readonly freshness: number | null;
  readonly metricSource: string;
  readonly isEstimated: boolean;
  readonly emptyReason: "none" | "no-recent-activity";
};

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function findChannelStat(candidate: RecCandidate, channelStats: Record<string, ChannelStat>): ChannelStat | undefined {
  const direct = channelStats[candidate.id];
  if (direct) return direct;
  if (!candidate.channelId) return undefined;
  return Object.values(channelStats).find((stat) => stat.channelId === candidate.channelId || stat.channelRef === candidate.channelId);
}

function candidateIdentityValues(candidate: RecCandidate): Set<string> {
  return new Set([candidate.id, candidate.channelId, candidate.handle, candidate.youtubeUrl, candidate.name]
    .map((value) => safeText(value).toLowerCase().replace(/^@/, ""))
    .filter(Boolean));
}

function matchesCandidateVideo(candidate: RecCandidate, video: VideoItem): boolean {
  const keys = candidateIdentityValues(candidate);
  return [
    video.creatorId,
    video.channelId,
    video.youtubeUrl,
    video.channel,
  ].some((value) => keys.has(safeText(value).toLowerCase().replace(/^@/, "")));
}

function matchesCandidateComment(candidate: RecCandidate, comment: CreatorComment, videoIds: ReadonlySet<string>): boolean {
  const keys = candidateIdentityValues(candidate);
  const creatorId = safeText(comment.creatorId).toLowerCase().replace(/^@/, "");
  const videoId = safeText(comment.videoId);
  return keys.has(creatorId) || (videoId.length > 0 && videoIds.has(videoId));
}

function dateSortValue(value: unknown): number {
  const text = safeText(value);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toHoverVideo(video: VideoItem): CandidateHoverVideo | null {
  const title = safeText(video.title);
  if (!title) return null;
  const published = safeText(video.publishedAtIso) || safeText(video.publishedIso) || safeText(video.published) || "일자 미상";
  return {
    title,
    views: safeNumber(video.views),
    likes: safeNumber(video.likes),
    comments: safeNumber(video.comments),
    published,
  };
}

function engagementFromVideos(videos: readonly CandidateHoverVideo[]): number | null {
  const rows = videos.filter((video) => video.views > 0);
  if (rows.length === 0) return null;
  const totals = rows.reduce(
    (sum, video) => ({
      views: sum.views + video.views,
      reactions: sum.reactions + video.likes + video.comments,
    }),
    { views: 0, reactions: 0 },
  );
  return Math.round((totals.reactions / totals.views) * 10_000) / 100;
}

function freshnessFromVideos(videos: readonly CandidateHoverVideo[]): number | null {
  const latest = Math.max(...videos.map((video) => dateSortValue(video.published)));
  if (!Number.isFinite(latest) || latest <= 0) return null;
  const ageDays = Math.max(0, (Date.now() - latest) / 86_400_000);
  return Math.max(0, Math.min(100, Math.round(100 - ageDays * 4)));
}

export function buildCandidateHoverIntelligence(
  candidate: RecCandidate,
  {
    channelStats,
    videos,
    creatorComments,
  }: {
    channelStats: Record<string, ChannelStat>;
    videos: readonly VideoItem[];
    creatorComments: readonly CreatorComment[];
  },
): CandidateHoverIntelligence {
  const stat = findChannelStat(candidate, channelStats);
  const matchedVideos = videos
    .filter((video) => matchesCandidateVideo(candidate, video))
    .sort((left, right) => dateSortValue(right.publishedAtIso ?? right.publishedIso ?? right.published) - dateSortValue(left.publishedAtIso ?? left.publishedIso ?? left.published));
  const recentVideos = matchedVideos
    .map(toHoverVideo)
    .filter((video): video is CandidateHoverVideo => video !== null)
    .slice(0, 3);
  const videoIds = new Set(matchedVideos.map((video) => video.videoId).filter(Boolean));
  const matchedComments = creatorComments
    .filter((comment) => matchesCandidateComment(candidate, comment, videoIds))
    .sort((left, right) => dateSortValue(right.time) - dateSortValue(left.time));
  const recentComments = matchedComments
    .map((comment) => ({
      author: safeText(comment.author) || "익명",
      text: safeText(comment.text),
      time: safeText(comment.time) || "시간 미상",
    }))
    .filter((comment) => comment.text.length > 0)
    .slice(0, 2);

  const avgViewsFromVideos = recentVideos.length > 0
    ? Math.round(recentVideos.reduce((sum, video) => sum + video.views, 0) / recentVideos.length)
    : 0;
  const recentViewsFromVideos = recentVideos[0]?.views ?? 0;
  const hasVideoMetrics = recentVideos.length > 0;
  const hasStatMetrics = !hasVideoMetrics && Boolean(stat);
  const avgViews = hasVideoMetrics ? avgViewsFromVideos : Math.round(safeNumber(stat?.avgViews));
  const recentViews = hasVideoMetrics ? recentViewsFromVideos : Math.round(safeNumber(stat?.recentViews, safeNumber(stat?.avgViews)));
  const engagement = hasVideoMetrics ? engagementFromVideos(recentVideos) : stat ? Math.round(safeNumber(stat.engagement) * 10) / 10 : null;
  const freshness = freshnessFromVideos(recentVideos);
  const commentCount = recentVideos.reduce((sum, video) => sum + video.comments, 0) || matchedComments.length;
  const metricSource = hasVideoMetrics
    ? "videos.creator_activity"
    : hasStatMetrics
      ? stat?.metricSource ?? "channel_stats"
      : matchedComments.length > 0
        ? "creator_comments"
        : "no-recent-activity";
  const emptyReason = recentVideos.length === 0 && !stat && matchedComments.length === 0 ? "no-recent-activity" : "none";
  return { recentVideos, recentComments, avgViews, recentViews, commentCount, engagement, freshness, metricSource, isEstimated: false, emptyReason };
}
