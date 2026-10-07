import { DocumentReference, FieldValue, Transaction } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";

export type ScpApprovedFeedProjectionResult = {
  promoted: boolean;
  archived: boolean;
  ignored: boolean;
  videoId: string | null;
  videoRef: string | null;
  reason: string;
};

type ProjectionOptions = {
  transaction: Transaction;
  submissionId: string;
  submissionRef: DocumentReference;
  submission: Record<string, unknown>;
  reviewStatus: string;
  previousReviewStatus?: string;
  verdict?: unknown;
  reasons?: unknown;
  reasonText?: unknown;
  feedbackText?: unknown;
  approver?: unknown;
  approvedAtIso?: unknown;
  payableStatus?: unknown;
  latestVideoReviewDecisionRef?: unknown;
  backfillRunId?: unknown;
  archivedAtIso?: string;
};

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function asString(value: unknown, max = 2000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") return asString(value, 500) ? [asString(value, 500)] : [];
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item, 500)).filter(Boolean).slice(0, 20);
}

function asOptionalString(value: unknown, max = 2000): string | null {
  const normalized = asString(value, max);
  return normalized || null;
}
function firstOptionalString(values: unknown[], max = 2000): string | null {
  for (const value of values) {
    const normalized = asString(value, max);
    if (normalized) return normalized;
  }
  return null;
}

function firstStringArray(values: unknown[]): string[] {
  for (const value of values) {
    const normalized = asStringArray(value);
    if (normalized.length) return normalized;
  }
  return [];
}

function canonicalReviewStatusForFeed(value: unknown): string {
  const module = require("./review-pay") as { canonicalReviewStatus(value: unknown): unknown };
  const canonical = module.canonicalReviewStatus(value);
  return typeof canonical === "string" ? canonical : "";
}

export function extractYouTubeVideoIdFromSubmissionUrl(value: unknown): string | null {
  const input = asString(value, 1000);
  if (!input) return null;
  if (YOUTUBE_ID_RE.test(input)) return input;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] ?? "";
    return YOUTUBE_ID_RE.test(id) ? id : null;
  }
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;

  const watchId = url.searchParams.get("v") ?? "";
  if (YOUTUBE_ID_RE.test(watchId)) return watchId;

  const parts = url.pathname.split("/").filter(Boolean);
  if (["shorts", "embed", "live"].includes(parts[0] ?? "")) {
    return YOUTUBE_ID_RE.test(parts[1] ?? "") ? parts[1] : null;
  }
  return null;
}

function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function youtubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function firstExistingString(existing: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = asString(existing[key], 2000);
    if (value) return value;
  }
  return fallback;
}

function firstSubmissionString(submission: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = asString(submission[key], 2000);
    if (value) return value;
  }
  return fallback;
}

function firstExistingFiniteNumber(existing: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = existing[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return fallback;
}

function softHiddenAt(submission: Record<string, unknown>, fallbackIso: string): string | null {
  return asOptionalString(submission.archivedAtIso, 120)
    ?? asOptionalString(submission.archivedAt, 120)
    ?? asOptionalString(submission.deletedAtIso, 120)
    ?? asOptionalString(submission.deletedAt, 120)
    ?? (submission.softHidden === true || submission.hidden === true ? fallbackIso : null);
}

function hasExistingScpApprovedProjection(existing: Record<string, unknown>, existingMeta: Record<string, unknown>): boolean {
  return existing.source === "scpReviewPass"
    || existing.scpReviewPass === true
    || existingMeta.source === "scpReviewPass";
}

export async function projectScpApprovedFeed(options: ProjectionOptions): Promise<ScpApprovedFeedProjectionResult> {
  const videoId = extractYouTubeVideoIdFromSubmissionUrl(options.submission.youtubeUrl);
  if (!videoId) {
    return {
      promoted: false,
      archived: false,
      ignored: true,
      videoId: null,
      videoRef: null,
      reason: "no_youtube_submission_url",
    };
  }

  const videoRef = adminDb.collection("videos").doc(videoId);
  const videoSnapshot = await options.transaction.get(videoRef);
  const existing: Record<string, unknown> = videoSnapshot.exists ? (videoSnapshot.data() ?? {}) : {};
  const existingMeta: Record<string, unknown> = existing.scpReviewMeta && typeof existing.scpReviewMeta === "object"
    ? existing.scpReviewMeta as Record<string, unknown>
    : {};
  const hasScpProjection = hasExistingScpApprovedProjection(existing, existingMeta);
  const reviewStatus = canonicalReviewStatusForFeed(options.reviewStatus);
  const previousReviewStatus = canonicalReviewStatusForFeed(options.previousReviewStatus);
  const submittedYoutubeUrl = asString(options.submission.youtubeUrl, 1000) || youtubeWatchUrl(videoId);
  const hiddenAt = softHiddenAt(options.submission, options.archivedAtIso ?? new Date().toISOString());
  const shouldPromote = reviewStatus === "approved" && !hiddenAt;
  const shouldArchive = (Boolean(hiddenAt) && (reviewStatus === "approved" || hasScpProjection))
    || (previousReviewStatus === "approved" && reviewStatus !== "approved");
  if (!shouldPromote && !shouldArchive) {
    return {
      promoted: false,
      archived: false,
      ignored: true,
      videoId,
      videoRef: videoRef.path,
      reason: "not_approved_or_leaving_approved",
    };
  }
  const archiveIso = hiddenAt ?? options.archivedAtIso ?? new Date().toISOString();

  const meta = {
    source: "scpReviewPass",
    submissionId: options.submissionId,
    submissionRef: options.submissionRef.path,
    reviewStatus,
    verdict: firstOptionalString([options.verdict, options.submission.verdict, existingMeta.verdict], 500),
    reasons: firstStringArray([options.reasons, options.submission.reasons, existingMeta.reasons]),
    reasonText: firstOptionalString([
      options.reasonText,
      options.submission.reasonText,
      options.submission.rejectedReason,
      existingMeta.reasonText,
    ], 4000),
    feedbackText: firstOptionalString([options.feedbackText, options.submission.feedbackText, existingMeta.feedbackText], 4000),
    approver: firstOptionalString([options.approver, existingMeta.approver], 240),
    approvedAtIso: firstOptionalString([options.approvedAtIso, options.submission.approvedAtIso, existingMeta.approvedAtIso], 120),
    payableStatus: firstOptionalString([options.payableStatus, options.submission.payableStatus, existingMeta.payableStatus], 80),
    programId: firstOptionalString([options.submission.programId, existingMeta.programId], 180),
    leadId: firstOptionalString([options.submission.leadId, existingMeta.leadId], 180),
    creatorLinkRef: firstOptionalString([options.submission.creatorLinkRef, existingMeta.creatorLinkRef], 240),
    campaign: firstOptionalString([options.submission.campaign, existingMeta.campaign], 240),
    latestVideoReviewDecisionRef: firstOptionalString([options.latestVideoReviewDecisionRef, options.submission.latestVideoReviewDecisionRef, existingMeta.latestVideoReviewDecisionRef], 500),
    backfillRunId: firstOptionalString([options.backfillRunId, options.submission.backfillRunId, existingMeta.backfillRunId], 180),
  };
  const fallbackPublishedIso = firstSubmissionString(
    options.submission,
    ["publishedAtIso", "publishedIso", "submittedAtIso"],
    asString(options.approvedAtIso, 120) || archiveIso,
  );
  const existingPublishedIso = firstExistingString(existing, ["publishedAtIso", "publishedIso"], fallbackPublishedIso);
  const publishedAtIso = firstExistingString(existing, ["publishedAtIso"], existingPublishedIso);
  const publishedIso = firstExistingString(existing, ["publishedIso"], existingPublishedIso);
  const published = firstExistingString(existing, ["published"], existingPublishedIso.slice(0, 10));
  const creatorId = firstExistingString(existing, ["creatorId"], asString(options.submission.creatorId, 2000));
  // N/10 신규 관측(P8, A10): activityRefresh와 동일 규약 — createdAt/createdAtIso는
  // 이 videos 문서의 최초 생성 시 1회만 스탬프한다. 이미 존재하는 영상(자사 활동
  // 갱신으로 먼저 생겼거나 재승인 재기록)을 SCP 합격 프로젝션이 "신규"로 재잡지 않게.
  const isNewVideoDoc = !videoSnapshot.exists || !asString(existing.createdAtIso);
  const nowIso = new Date().toISOString();

  const patch: Record<string, unknown> = {
    videoId,
    source: "scpReviewPass",
    scpReviewPass: true,
    youtubeUrl: firstExistingString(existing, ["youtubeUrl"], submittedYoutubeUrl),
    url: firstExistingString(existing, ["url", "sourceUrl"], youtubeWatchUrl(videoId)),
    sourceUrl: firstExistingString(existing, ["sourceUrl", "url"], youtubeWatchUrl(videoId)),
    thumb: firstExistingString(existing, ["thumb", "thumbnailUrl"], youtubeThumbnailUrl(videoId)),
    thumbnailUrl: firstExistingString(existing, ["thumbnailUrl", "thumb"], youtubeThumbnailUrl(videoId)),
    title: firstExistingString(
      existing,
      ["title"],
      firstSubmissionString(options.submission, ["title", "videoTitle", "app"], "SCP 합격 영상"),
    ),
    channel: firstExistingString(
      existing,
      ["channel"],
      firstSubmissionString(
        options.submission,
        ["channel", "channelName", "creatorName", "email", "creatorId"],
        "SCP creator",
      ),
    ),
    published,
    publishedAtIso,
    publishedIso,
    views: firstExistingFiniteNumber(existing, ["views"], 0),
    likes: firstExistingFiniteNumber(existing, ["likes"], 0),
    comments: firstExistingFiniteNumber(existing, ["comments"], 0),
    tag: "SCP 합격",
    scpReviewMeta: meta,
    ...(isNewVideoDoc ? { createdAt: FieldValue.serverTimestamp(), createdAtIso: nowIso } : {}),
    updatedAtIso: options.archivedAtIso ?? new Date().toISOString(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (creatorId) {
    patch.creatorId = creatorId;
  }

  if (shouldPromote) {
    patch.archivedAt = FieldValue.delete();
    patch.archiveReason = FieldValue.delete();
  } else if (shouldArchive) {
    patch.archivedAt = archiveIso;
    patch.archiveReason = hiddenAt ? "scp_submission_soft_hidden" : "scp_review_left_approved";
  }

  options.transaction.set(videoRef, patch, { merge: true });

  return {
    promoted: shouldPromote,
    archived: shouldArchive,
    ignored: false,
    videoId,
    videoRef: videoRef.path,
    reason: shouldPromote ? "approved_youtube_submission" : patch.archiveReason as string,
  };
}
