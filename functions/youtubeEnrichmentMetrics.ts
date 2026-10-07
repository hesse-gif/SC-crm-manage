export type VideoDurationKind = "long" | "short" | "unknown";

export type CountTriplet = {
  long: number;
  short: number;
  total: number;
};

export type EngagementTriplet = CountTriplet;

export type YouTubeMetricVideo = {
  duration?: unknown;
  durationSeconds?: unknown;
  statistics?: unknown;
  views?: unknown;
  viewCount?: unknown;
  likes?: unknown;
  likeCount?: unknown;
  comments?: unknown;
  commentCount?: unknown;
};

export type YouTubeVideoMetricSummary = {
  videoCount: CountTriplet;
  engagement: EngagementTriplet;
};

export const YOUTUBE_SHORT_MAX_SECONDS = 180;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asFiniteNumber(value: unknown): number | null {
  const source = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof source === "number" && Number.isFinite(source) ? source : null;
}

export function parseYouTubeDurationSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const duration = value.trim();
  if (!duration) return null;
  const match = duration.match(/^P(?:(\d+(?:[.,]\d+)?)D)?(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?$/i);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  const total = [
    [days, 86_400],
    [hours, 3_600],
    [minutes, 60],
    [seconds, 1],
  ].reduce((sum, [part, multiplier]) => {
    if (typeof part !== "string" || !part) return sum;
    return sum + Number(part.replace(",", ".")) * Number(multiplier);
  }, 0);
  return Number.isFinite(total) ? Math.round(total) : null;
}

export function classifyYouTubeDuration(value: unknown): VideoDurationKind {
  const seconds = typeof value === "number" ? asFiniteNumber(value) : parseYouTubeDurationSeconds(value);
  if (seconds === null || seconds < 0) return "unknown";
  return seconds <= YOUTUBE_SHORT_MAX_SECONDS ? "short" : "long";
}

type EngagementSums = {
  likes: number;
  comments: number;
  views: number;
};

function emptyEngagementSums(): EngagementSums {
  return { likes: 0, comments: 0, views: 0 };
}

function addVideoEngagement(target: EngagementSums, video: YouTubeMetricVideo): void {
  target.likes += metricNumber(video, "likes", "likeCount");
  target.comments += metricNumber(video, "comments", "commentCount");
  target.views += metricNumber(video, "views", "viewCount");
}

export function summarizeYouTubeVideoCounts(videos: readonly YouTubeMetricVideo[]): YouTubeVideoMetricSummary {
  const videoCount: CountTriplet = { long: 0, short: 0, total: 0 };
  const engagementSums = {
    long: emptyEngagementSums(),
    short: emptyEngagementSums(),
    total: emptyEngagementSums(),
  };
  for (const video of videos) {
    videoCount.total += 1;
    addVideoEngagement(engagementSums.total, video);
    const kind = classifyYouTubeDuration(video.durationSeconds ?? video.duration);
    if (kind === "long") {
      videoCount.long += 1;
      addVideoEngagement(engagementSums.long, video);
    }
    if (kind === "short") {
      videoCount.short += 1;
      addVideoEngagement(engagementSums.short, video);
    }
  }
  return {
    videoCount,
    engagement: {
      long: engagementPercent(engagementSums.long.likes, engagementSums.long.comments, engagementSums.long.views),
      short: engagementPercent(engagementSums.short.likes, engagementSums.short.comments, engagementSums.short.views),
      total: engagementPercent(engagementSums.total.likes, engagementSums.total.comments, engagementSums.total.views),
    },
  };
}

function metricNumber(video: YouTubeMetricVideo, objectKey: keyof YouTubeMetricVideo, statisticsKey: string): number {
  const direct = asFiniteNumber(video[objectKey]);
  if (direct !== null) return Math.max(0, direct);
  const stats = asRecord(video.statistics);
  return Math.max(0, asFiniteNumber(stats[statisticsKey]) ?? 0);
}

export function engagementPercent(likes: number, comments: number, views: number): number {
  if (!Number.isFinite(views) || views <= 0) return 0;
  const value = ((Math.max(0, likes) + Math.max(0, comments)) / views) * 100;
  return Math.round(value * 100) / 100;
}
