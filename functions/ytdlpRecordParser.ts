import type { ParsedYtDlpVideo } from "./feedWorkerTypes";
import { youtubeCreatorCountryDecision } from "./youtubeCreatorCountries";
import { normalizeTranscript } from "./videoTranscript";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function stringField(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function numberField(record: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed));
    }
  }
  return 0;
}

function uploadDateIso(record: Record<string, unknown>): string | null {
  const uploadDate = stringField(record, ["upload_date", "uploadDate"]);
  if (/^\d{8}$/.test(uploadDate)) {
    return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T00:00:00.000Z`;
  }
  const timestamp = numberField(record, ["timestamp", "release_timestamp", "modified_timestamp"]);
  if (timestamp > 0) return new Date(timestamp * 1000).toISOString();
  return null;
}

function recordComments(record: Record<string, unknown>): readonly Record<string, unknown>[] {
  const comments = record.comments;
  if (!Array.isArray(comments)) return [];
  return comments.map(asRecord).filter((comment): comment is Record<string, unknown> => comment !== null);
}

function stringArrayField(record: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  }
  return [];
}

export function parseYtDlpVideo(
  record: Record<string, unknown>,
  allowlist: readonly string[],
): ParsedYtDlpVideo | { readonly excluded: "country" } | null {
  const videoId = stringField(record, ["id", "video_id", "videoId"]);
  const channelId = stringField(record, ["channel_id", "channelId"]);
  if (!videoId || !channelId) return null;

  const country = stringField(record, ["channel_country", "channelCountry", "creatorCountry", "country"]);
  const countryDecision = youtubeCreatorCountryDecision(country, allowlist);
  if (!countryDecision.allowed) return { excluded: "country" };

  const sourceUrl = stringField(record, ["webpage_url", "webpageUrl", "url"]) || `https://www.youtube.com/watch?v=${videoId}`;
  const channelUrl = stringField(record, ["channel_url", "channelUrl"]) || `https://www.youtube.com/channel/${channelId}`;
  return {
    videoId,
    channelId,
    channelTitle: stringField(record, ["channel", "uploader", "creatorName"]) || "Unknown channel",
    handle: stringField(record, ["uploader_id", "uploader", "handle", "channel"]),
    channelUrl,
    sourceUrl,
    title: stringField(record, ["title", "fulltitle"]) || "Untitled YouTube video",
    description: stringField(record, ["description", "full_description", "webpage_description"]),
    hashtags: stringArrayField(record, ["hashtags", "tags"]),
    creatorCountry: countryDecision.country,
    viewCount: numberField(record, ["view_count", "viewCount"]),
    likeCount: numberField(record, ["like_count", "likeCount"]),
    commentCount: numberField(record, ["comment_count", "commentCount"]),
    durationSeconds: numberField(record, ["duration", "duration_seconds", "durationSeconds"]) || null,
    publishedAt: uploadDateIso(record),
    comments: recordComments(record),
    transcript: normalizeTranscript(record.transcript),
  };
}
