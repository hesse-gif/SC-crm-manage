import { createHash } from "node:crypto";
import { asRecord, asString } from "./shared";
import { extractYouTubeVideoId } from "./videoViewSnapshots";
import { isImageSubmission } from "./videoReviewImageFallback";

export const VIDEO_REVIEW_MIME_TYPE = "video/mp4" as const;

export type VideoReviewMediaSource = "youtube" | "gcs";

export type VideoReviewMediaCandidate = {
  source: VideoReviewMediaSource;
  fileUri: string;
  mimeType: typeof VIDEO_REVIEW_MIME_TYPE;
  candidateFingerprint: string;
  generation?: string;
  videoId?: string;
  bucket?: string;
  objectPath?: string;
};

// Every lane uses this one canonical resolver so aliases cannot diverge between
// multimodal eligibility, source fingerprints, and the human-review gate.
export function videoReviewMediaCandidate(submission: Record<string, unknown>): VideoReviewMediaCandidate | null {
  const uploaded = uploadedFileValue(submission);
  const uploadedIsImage = uploaded
    ? isImageSubmission({ uploadedFileUrl: uploaded, contentType: uploadedMimeHint(submission) || asString(submission.contentType) })
    : false;
  if (uploaded && !uploadedIsImage) {
    const uploadedCandidate = uploadedVideoCandidate(uploaded, submission);
    if (uploadedCandidate) return uploadedCandidate;
  }

  const videoId = safeYouTubeVideoId(submission.youtubeUrl)
    ?? safeYouTubeVideoId(submission.videoUrl)
    ?? safeYouTubeVideoId(submission.reviewUrl);
  if (videoId) return youtubeCandidate(videoId);
  const fallback = asRecord(submission.imageFallbackTarget);
  const fallbackVideoId = safeYouTubeVideoId(fallback.youtubeUrl);
  return fallbackVideoId ? youtubeCandidate(fallbackVideoId) : null;
}

// Existing import contract: this returns only a YouTube candidate after upload precedence.
export function nonFileYouTubeTarget(submission: Record<string, unknown>): { videoId: string; youtubeUrl: string } | null {
  const candidate = videoReviewMediaCandidate(submission);
  return candidate?.source === "youtube" && candidate.videoId
    ? { videoId: candidate.videoId, youtubeUrl: candidate.fileUri }
    : null;
}

export function hasVideoReviewMediaCandidate(submission: Record<string, unknown>): boolean {
  if (videoReviewMediaCandidate(submission)) return true;
  const uploaded = uploadedFileValue(submission);
  return Boolean(uploaded && !isImageSubmission({
    uploadedFileUrl: uploaded,
    contentType: uploadedMimeHint(submission) || asString(submission.contentType),
  }));
}

export function uploadedFileValue(submission: Record<string, unknown>): string {
  const direct = directUploadedFileValue(submission);
  if (direct) return direct;
  const media = asRecord(submission.uploadedMedia);
  return asString(submission.uploadedFileGcsUri)
    || asString(media.gcsUri)
    || (asString(media.bucket) && asString(media.objectPath)
      ? canonicalGcsUri(asString(media.bucket), asString(media.objectPath))
      : "");
}

export function videoReviewMediaGenerationHint(
  submission: Record<string, unknown>,
  candidate: VideoReviewMediaCandidate | null = videoReviewMediaCandidate(submission),
): string {
  const explicit = metadataString(submission.uploadedFileGeneration);
  if (explicit) return explicit;
  const media = asRecord(submission.uploadedMedia);
  const persistedGeneration = metadataString(media.generation);
  if (!persistedGeneration || candidate?.source !== "gcs") return "";
  const direct = directUploadedFileValue(submission);
  if (!direct) return persistedGeneration;
  const directGcs = parseGcsReference(direct);
  const persistedGcs = parseGcsReference(asString(media.gcsUri))
    ?? validGcsParts(asString(media.bucket), asString(media.objectPath));
  return directGcs && persistedGcs
    && directGcs.bucket === persistedGcs.bucket
    && directGcs.objectPath === persistedGcs.objectPath
    ? persistedGeneration
    : "";
}

// Canonical submission-source fence shared by the outbox and manual multimodal lane.
// Raw media identities stay one-way hashed; authoritative media/timestamp/resubmission
// changes invalidate in-flight work without persisting signed download credentials.
export function videoReviewSourceFingerprint(source: Record<string, unknown>): string {
  const contentUrls = Array.isArray(source.contentUrls)
    ? source.contentUrls.map((value) => asString(value).trim()).filter(Boolean).sort()
    : [];
  const mediaCandidate = videoReviewMediaCandidate(source);
  const rawUploaded = asString(source.uploadedFileUrl).trim();
  const videoMediaFingerprints = mediaCandidate?.source === "youtube"
    ? [mediaCandidate.candidateFingerprint]
    : [...new Set([
      opaqueMediaIdentityHash(asString(source.youtubeUrl)),
      opaqueMediaIdentityHash(asString(source.videoUrl)),
      opaqueMediaIdentityHash(asString(source.reviewUrl)),
    ].filter(Boolean))].sort();
  const payload = {
    videoMediaFingerprints,
    uploadedMediaFingerprint: mediaCandidate && mediaCandidate.source !== "youtube"
      ? mediaCandidate.candidateFingerprint
      : rawUploaded
        ? sha256(`uploaded:${rawUploaded}`)
        : "",
    uploadedMediaGeneration: videoReviewMediaGenerationHint(source, mediaCandidate),
    tiktokMediaFingerprint: opaqueMediaIdentityHash(asString(source.tiktokUrl)),
    instagramMediaFingerprint: opaqueMediaIdentityHash(asString(source.instagramUrl ?? source.instaUrl)),
    contentUrlFingerprints: contentUrls.map(opaqueMediaIdentityHash),
    submittedAtIso: canonicalIso(source.submittedAtIso) || asString(source.submittedAtIso).trim(),
    updatedAtIso: canonicalIso(source.updatedAtIso) || asString(source.updatedAtIso).trim(),
    resubmissionCount: nonNegativeInteger(source.resubmissionCount),
  };
  return sha256(JSON.stringify(payload)).slice(0, 32);
}

function youtubeCandidate(videoId: string): VideoReviewMediaCandidate {
  return {
    source: "youtube",
    fileUri: `https://www.youtube.com/watch?v=${videoId}`,
    mimeType: VIDEO_REVIEW_MIME_TYPE,
    candidateFingerprint: sha256(`youtube:${videoId}`),
    videoId,
  };
}

function uploadedVideoCandidate(uploaded: string, submission: Record<string, unknown>): VideoReviewMediaCandidate | null {
  const mimeHint = uploadedMimeHint(submission);
  if (mimeHint && mimeHint !== VIDEO_REVIEW_MIME_TYPE) return null;
  const uploadedYoutubeId = safeYouTubeVideoId(uploaded);
  if (uploadedYoutubeId) return youtubeCandidate(uploadedYoutubeId);
  const gcs = parseGcsReference(uploaded);
  if (!gcs) return null;
  const candidate: VideoReviewMediaCandidate = {
    source: "gcs",
    fileUri: canonicalGcsUri(gcs.bucket, gcs.objectPath),
    mimeType: VIDEO_REVIEW_MIME_TYPE,
    bucket: gcs.bucket,
    objectPath: gcs.objectPath,
    candidateFingerprint: sha256(`gcs:${gcs.bucket}:${gcs.objectPath}`),
  };
  const generation = videoReviewMediaGenerationHint(submission, candidate);
  return { ...candidate, ...(generation ? { generation } : {}) };
}

function directUploadedFileValue(submission: Record<string, unknown>): string {
  return asString(submission.uploadedFileUrl)
    || asString(submission.uploaded_file_url)
    || asString(submission.uploaded_file)
    || asString(submission.uploadedFile);
}

function uploadedMimeHint(submission: Record<string, unknown>): string {
  const media = asRecord(submission.uploadedMedia);
  return (asString(submission.uploadedFileContentType)
    || asString(submission.uploadContentType)
    || asString(media.mimeType)).toLowerCase();
}

function parseGcsReference(value: string): { bucket: string; objectPath: string } | null {
  try {
    if (value.startsWith("gs://")) {
      const parsed = new URL(value);
      if (parsed.protocol !== "gs:" || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null;
      return validGcsParts(parsed.hostname, safeDecode(parsed.pathname.replace(/^\/+/, "")));
    }
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443") || parsed.hash) return null;
    const host = parsed.hostname.toLowerCase();
    if (host === "firebasestorage.googleapis.com") {
      const match = parsed.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
      return match ? validGcsParts(safeDecode(match[1]), safeDecode(match[2])) : null;
    }
    if (host === "storage.googleapis.com") {
      const [, bucket = "", ...objectSegments] = parsed.pathname.split("/");
      return validGcsParts(safeDecode(bucket), safeDecode(objectSegments.join("/")));
    }
    if (host.endsWith(".storage.googleapis.com")) {
      return validGcsParts(host.slice(0, -".storage.googleapis.com".length), safeDecode(parsed.pathname.replace(/^\/+/, "")));
    }
  } catch {
    return null;
  }
  return null;
}

function safeYouTubeVideoId(value: unknown): string | null {
  const raw = asString(value).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) return null;
    const host = parsed.hostname.toLowerCase();
    if (host !== "youtu.be" && host !== "youtube.com" && !host.endsWith(".youtube.com")) return null;
    return extractYouTubeVideoId(raw);
  } catch {
    return null;
  }
}

function validGcsParts(bucket: string, objectPath: string): { bucket: string; objectPath: string } | null {
  const cleanBucket = bucket.trim().toLowerCase();
  const cleanPath = objectPath.trim().replace(/^\/+/, "");
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(cleanBucket)) return null;
  if (!cleanPath.startsWith("scp-submissions/") || !/\.mp4$/i.test(cleanPath)) return null;
  if (Buffer.byteLength(cleanPath, "utf8") > 1024 || /[\u0000-\u001f\u007f]/.test(cleanPath)) return null;
  if (cleanPath.split("/").some((segment) => !segment || segment === "." || segment === "..")) return null;
  return { bucket: cleanBucket, objectPath: cleanPath };
}

function canonicalGcsUri(bucket: string, objectPath: string): string {
  return `gs://${bucket.toLowerCase()}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return ""; }
}

function metadataString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function opaqueMediaIdentityHash(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.searchParams.sort();
    return sha256(parsed.href);
  } catch {
    return sha256(normalized);
  }
}

function canonicalIso(value: unknown): string {
  const text = asString(value);
  return Number.isFinite(Date.parse(text)) ? new Date(Date.parse(text)).toISOString() : "";
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
