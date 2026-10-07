import { createHash } from "node:crypto";
import type {
  FirestoreDb,
  FirestoreWriteFence,
  ParsedYtDlpVideo,
  YtDlpIngestCounters,
} from "./feedWorkerTypes";
import { numberField, stringField } from "./ytdlpRecordParser";

export function initialCounters(recordsReceived: number): YtDlpIngestCounters {
  return {
    recordsReceived,
    videosWritten: 0,
    commentsWritten: 0,
    fingerprintsCreated: 0,
    skippedByDedupe: 0,
    knownChannels: 0,
    excludedByCountry: 0,
    excludedOfficial: 0,
    malformedRecords: 0,
    malformedComments: 0,
  };
}

export function increment(counters: YtDlpIngestCounters, key: keyof YtDlpIngestCounters): YtDlpIngestCounters {
  return { ...counters, [key]: counters[key] + 1 };
}

function fingerprintId(type: "channel" | "video" | "comment", key: string): string {
  return `${type}:${key.replace(/\//g, "_")}`;
}

function alreadyExists(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const coded = error as Error & { readonly code?: unknown };
  return coded.code === 6 || coded.code === "already-exists" || coded.code === "ALREADY_EXISTS";
}

export async function createFingerprint(
  db: FirestoreDb,
  type: "channel" | "video" | "comment",
  key: string,
  runId: string,
  nowIso: string,
  assertWriteAllowed: FirestoreWriteFence,
): Promise<boolean> {
  try {
    await assertWriteAllowed();
    await db.collection("source_fingerprints").doc(fingerprintId(type, key)).create({
      type,
      key,
      ownerRunId: runId,
      status: "active",
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
    });
    return true;
  } catch (error) {
    if (alreadyExists(error)) {
      await assertWriteAllowed();
      await db.collection("source_fingerprints").doc(fingerprintId(type, key)).set({ lastSeenAt: nowIso }, { merge: true });
      return false;
    }
    throw error;
  }
}

export function commentDocId(videoId: string, commentId: string): string {
  return `${videoId}_${commentId}`.replace(/\//g, "_");
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function excerpt(text: string): string {
  return text.length <= 240 ? text : `${text.slice(0, 237)}...`;
}

function commentPublishedAt(record: Record<string, unknown>): string | null {
  const timestamp = numberField(record, ["timestamp", "time"]);
  return timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null;
}

export async function writeCreatorComment(
  db: FirestoreDb,
  video: ParsedYtDlpVideo,
  comment: Record<string, unknown>,
  commentId: string,
  text: string,
  runId: string,
  nowIso: string,
  assertWriteAllowed: FirestoreWriteFence,
): Promise<void> {
  await assertWriteAllowed();
  await db.collection("creator_comments").doc(commentDocId(video.videoId, commentId)).set({
    commentId,
    videoId: video.videoId,
    channelId: video.channelId,
    authorChannelId: stringField(comment, ["author_channel_id", "authorChannelId"]),
    authorHandle: stringField(comment, ["author", "author_id", "authorHandle"]),
    textHash: textHash(text),
    excerpt: excerpt(text),
    publishedAt: commentPublishedAt(comment),
    fetchedAt: nowIso,
    likeCount: numberField(comment, ["like_count", "likeCount"]),
    url: `${video.sourceUrl}&lc=${encodeURIComponent(commentId)}`,
    isSelfComment: stringField(comment, ["author_channel_id", "authorChannelId"]) === video.channelId,
    discoveryRunId: runId,
  }, { merge: true });
}
