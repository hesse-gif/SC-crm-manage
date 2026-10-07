// C5 영상검수 멀티모달 판정 엔진 — YouTube와 서버 검증된 업로드 MP4를 실제로
// "보고/듣고"(callVideoModel) 판정한다.
//   텍스트 Judge B(videoReviewJudgeService)와 동일한 verdict 스키마 + 과거 검수 few-shot(RAG)을 재사용하되,
//   영상 픽셀/오디오를 직접 관찰(멀티모달)한다. 캐시선행 → callVideoModel(chokepoint, videoLlm.runVideoLlm)
//   → usage 로그(video_review_judge). SEC-P0-005 B2 예외(VERTEX_VIDEO_LANE_APPROVED 게이트). 프롬프트 원문 비로깅(SEC-P0-009).
//   클라 직접쓰기 금지(SEC-P0-004) → 콜러블 경유. 발송/자동확정 없음 — content 기반 추천만 갱신하고 사람 검수 게이트 유지.
import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb, adminStorage } from "./firebaseAdmin";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { assertScpEntitled } from "./mailAccounts";
import { isVertexModelId, selectVertexModelForTask, type VertexContentPart } from "./vertex";
import { runVideoLlm, type RunVideoLlmResult, type VideoLlmCache, type VideoLlmCallFn } from "./videoLlm";
import {
  VIDEO_REVIEW_MIME_TYPE,
  uploadedFileValue,
  videoReviewMediaCandidate,
  videoReviewMediaGenerationHint,
  videoReviewSourceFingerprint,
  type VideoReviewMediaCandidate,
  type VideoReviewMediaSource,
} from "./videoReviewMedia";
import {
  selectRecentVideoReviewFewShotCases,
  pickProgramScopedVideoReviewFewShotCases,
  videoReviewFeaturesFromSubmission,
  hashVideoReviewFewShotCases,
  normalizeVideoReviewVerdict,
  promptSafeVideoReviewFewShotReason,
  videoReviewPromptFeatures,
  VIDEO_REVIEW_RESPONSE_SCHEMA,
  VIDEO_REVIEW_REASONS,
  type VideoReviewVerdict,
  type VideoReviewFewShotCase,
} from "./videoReviewJudgeService";
import { VIDEO_REVIEW_POLICY_VERSION, videoReviewCriteriaMetadata, videoReviewCriteriaPromptBlock, videoReviewRubricTitleFromFeatures } from "./videoReviewCriteria";
import { SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";
import {
  programScopeError,
  resolveAuthoritativeVideoReviewProgramScope,
  sameVideoReviewProgramScope,
  videoReviewEffectiveProgramPolicy,
  videoReviewProgramScopeKey,
  videoReviewProgramScopeFromTrustedRecords,
  videoReviewScopePreservingSubmissionUpdate,
  videoReviewScopedFingerprint,
  type VideoReviewProgramScope,
} from "./videoReviewProgramScope";

const ROLES = ["super_admin", "admin", "manager"] as const;
const CACHE_COLLECTION = "video_review_multimodal_cache";
const DECISIONS_COLLECTION = "video_review_multimodal_decisions";
const CACHE_TTL_SECONDS = 60 * 60;
const MODEL_FALLBACK = "gemini-2.5-flash";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const CACHE_RESERVATION_LEASE_MS = 4 * 60 * 1000;
const CACHE_RESERVATION_POLL_MS = 100;
const MULTIMODAL_PROMPT_VERSION = "video-review-multimodal/v2-uploaded-media";
const VIDEO_MIME_TYPE = VIDEO_REVIEW_MIME_TYPE;
const MULTIMODAL_CACHE_TRANSPORT_FIELDS = new Set([
  "capabilities",
  "capability",
  "gatewaybypassed",
  "provider",
  "providerid",
  "providermetadata",
  "providerrunid",
  "runid",
  "transport",
  "transportmetadata",
]);
const MULTIMODAL_CACHE_TOP_LEVEL_FIELDS = new Set([
  "canonicalProgramId",
  "expiresAtIso",
  "key",
  "modelId",
  "policyConfigHash",
  "policyVersion",
  "programScopeVersion",
  "updatedAtIso",
  "verdict",
]);
const MULTIMODAL_CACHE_VERDICT_FIELDS = new Set([
  "checks",
  "disapprovalProbability",
  "evidence",
  "humanGate",
  "missingFields",
  "policyFlags",
  "policyVersion",
  "reasons",
  "verdict",
]);
const MULTIMODAL_CACHE_CHECK_FIELDS = new Set([
  "contentRelevance",
  "customLinkUsed",
  "duplicationOrOriginality",
  "gameplayDepth",
  "linkValidity",
  "publicAccess",
]);
const MULTIMODAL_CACHE_HUMAN_GATE_FIELDS = new Set(["reasons", "required", "ruleIds"]);
const MULTIMODAL_CACHE_EVIDENCE_FIELDS = new Set([
  "applicability",
  "assessment",
  "confidence",
  "frameRef",
  "mediaFingerprint",
  "modelId",
  "observedAtIso",
  "policyVersion",
  "provider",
  "ruleId",
  "ruleKey",
  "ruleName",
  "status",
  "summary",
  "timestampMs",
  "transcriptRef",
]);
const MULTIMODAL_CACHE_EVIDENCE_PROVIDERS = new Set(["server", "vertex", "human", "unknown"]);

export {
  hasVideoReviewMediaCandidate,
  nonFileYouTubeTarget,
  uploadedFileValue,
  videoReviewMediaCandidate,
  videoReviewMediaGenerationHint,
} from "./videoReviewMedia";
export type { VideoReviewMediaCandidate, VideoReviewMediaSource } from "./videoReviewMedia";

function sha256(v: string): string { return createHash("sha256").update(v).digest("hex"); }
function youtubeThumb(videoId: string): string { return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`; }

// Model identity is intentionally exposed for the authorized review UX and cost audit, but
// only from the repository-owned Vertex allowlist. Provider-returned transport metadata is not
// authoritative and must never choose a durable/client-visible model identifier.
export function videoReviewAllowlistedModelId(value: unknown): string {
  return isVertexModelId(value) ? value : MODEL_FALLBACK;
}

export function videoReviewMultimodalCacheEntryIsPublicSafe(
  value: unknown,
  expectedModelId: string,
): boolean {
  const record = asRecord(value);
  if (Object.keys(record).some((field) => !MULTIMODAL_CACHE_TOP_LEVEL_FIELDS.has(field))) return false;
  if (Object.keys(record).some((field) => MULTIMODAL_CACHE_TRANSPORT_FIELDS.has(field.toLowerCase().replace(/[_-]/g, "")))) {
    return false;
  }
  if (asString(record.modelId) !== videoReviewAllowlistedModelId(expectedModelId)) return false;
  const verdict = asRecord(record.verdict);
  if (Object.keys(verdict).some((field) => !MULTIMODAL_CACHE_VERDICT_FIELDS.has(field))) return false;
  const checks = asRecord(verdict.checks);
  if (Object.keys(checks).some((field) => !MULTIMODAL_CACHE_CHECK_FIELDS.has(field))) return false;
  const humanGate = asRecord(verdict.humanGate);
  if (Object.keys(humanGate).some((field) => !MULTIMODAL_CACHE_HUMAN_GATE_FIELDS.has(field))) return false;
  if (!Array.isArray(verdict.evidence)) return false;
  return verdict.evidence.every((item) => {
    const evidence = asRecord(item);
    if (Object.keys(evidence).some((field) => !MULTIMODAL_CACHE_EVIDENCE_FIELDS.has(field))) return false;
    if (!MULTIMODAL_CACHE_EVIDENCE_PROVIDERS.has(asString(evidence.provider))) return false;
    const evidenceModelId = evidence.modelId;
    return evidenceModelId === null
      || evidenceModelId === undefined
      || asString(evidenceModelId) === videoReviewAllowlistedModelId(expectedModelId);
  });
}

export function videoReviewMultimodalDecisionId(
  submissionId: string,
  mediaFingerprint: string,
  modelId: string,
  programScope: Pick<VideoReviewProgramScope, "canonicalProgramId" | "policyConfigHash"> = videoReviewProgramScopeFromTrustedRecords({ submission: {} }),
): string {
  return `decision:${videoReviewScopedFingerprint(
    "multimodal-decision",
    programScope,
    VIDEO_REVIEW_POLICY_VERSION,
    MULTIMODAL_PROMPT_VERSION,
    submissionId,
    mediaFingerprint,
    modelId,
  ).slice(0, 48)}`;
}

export type VideoReviewMediaDescriptor = VideoReviewMediaCandidate & {
  fingerprint: string;
  verified: boolean;
  generation?: string;
};

export type VideoReviewMediaMetadata = {
  contentType?: string | null;
  size?: string | number | null;
  generation?: string | number | null;
  md5Hash?: string | null;
  crc32c?: string | null;
  updated?: string | null;
};

export type VideoReviewMediaMetadataReader = (
  bucket: string,
  objectPath: string,
  expectedGeneration?: string,
) => Promise<VideoReviewMediaMetadata>;

export type VideoReviewMediaResolution =
  | { ok: true; media: VideoReviewMediaDescriptor }
  | {
      ok: false;
      reason: "no_video_media" | "invalid_uploaded_media" | "gcs_media_unavailable" | "gcs_bucket_not_allowed" | "unsupported_media_mime" | "uploaded_media_size_invalid" | "uploaded_media_generation_invalid" | "uploaded_media_generation_mismatch";
      /**
       * Live GCS object generation observed during this failed validation — present only
       * when the metadata read itself succeeded. Callers that persist a terminal marker
       * stamp it so a later same-path overwrite (new generation, same mediaKey) is
       * detectable without re-reading Storage on every pass.
       */
      observedGeneration?: string;
    };

export function multimodalReviewPrompt(features: Record<string, unknown>, fewShotCases: VideoReviewFewShotCase[]): string {
  const rubricTitle = videoReviewRubricTitleFromFeatures(features);
  const fewShotBlock = fewShotCases.length ? JSON.stringify({
    caseSetHash: hashVideoReviewFewShotCases(fewShotCases),
    instructions: "Recent human-finalized examples for calibration. Outcome labels and label counts are intentionally excluded from prompt context.",
    cases: fewShotCases.map((c) => ({
      caseRef: hashVideoReviewFewShotCases([c]).slice(0, 12),
      reasonCode: promptSafeVideoReviewFewShotReason(c.reason, c.label),
      programMatch: c.programMatch,
      features: c.features,
    })),
  }) : "[]";
  return [
    "You are Judge B (multimodal) for Super Creator Partners video review.",
    "You CAN watch and hear the attached video — inspect the actual gameplay footage, on-screen content, editing, spoken commentary, music/sound, and other audible evidence directly.",
    `The complete versioned ${rubricTitle.name} policy ${VIDEO_REVIEW_POLICY_VERSION} (R1-R24) is authoritative; apply only rule-safe evidence and do not import case-level examples.`,
    `Criteria/rulecheck metadata: ${videoReviewCriteriaPromptBlock(rubricTitle)}`,
    "Track behavior: uploaded_file means direct uploaded video; youtube_link means already-posted YouTube content. R2 custom-link and R3 link-validity are metadata/rulecheck boundaries: do NOT judge them from pixels/audio. checks.customLinkUsed MUST copy deterministicChecks.customLinkUsed exactly; null means unknown and MUST NOT cause disapproval or the reason 커스텀링크 미사용.",
    `For R1, use video observation to decide whether ${rubricTitle.name} is the main theme. For R4, use checks.duplicationOrOriginality: observe simple raw gameplay/reupload signals when visible, but true duplicate detection requires relational hash/embedding metadata.`,
    "Return evidence items only for multimodal rules where the attached media provides a real observation. Use status observed/unknown/failed, confidence 0..1, and nullable timestampMs/frameRef/transcriptRef. The server completes the final R1-R24 ledger, so do not echo deterministic, metadata, not-applicable, or human-only rows.",
    "R1 is review-only when failed because the source guidance conflicts. R10 face ownership/sampling and R11 approved-sample identity/derivative context always require human confirmation even when the model observes likely compliance. R14 and R16-R24 are human-only and must remain unknown for the model.",
    "Return strict JSON matching the schema. verdict: approval=likely acceptable, disapproval=likely reject, needs_review=human should inspect. Set disapprovalProbability 0..100.",
    `Preferred reason vocabulary: ${VIDEO_REVIEW_REASONS.join(", ")}.`,
    "Calibrate with the recent human-confirmed cases below (PII-masked, no human outcome labels/counts).",
    `Recent confirmed cases: ${fewShotBlock}`,
    "Never include email, submit tokens, prior review status, payment state, review notes, or raw prompt text in the answer.",
    JSON.stringify(videoReviewPromptFeatures(features)),
  ].join("\n");
}

export async function resolveVideoReviewMedia(
  submission: Record<string, unknown>,
  metadataReader: VideoReviewMediaMetadataReader = readGcsMetadata,
): Promise<VideoReviewMediaResolution> {
  const candidate = videoReviewMediaCandidate(submission);
  if (!candidate) {
    const uploaded = uploadedFileValue(submission);
    return { ok: false, reason: uploaded ? "invalid_uploaded_media" : "no_video_media" };
  }
  if (candidate.source !== "gcs") {
    return { ok: true, media: { ...candidate, fingerprint: candidate.candidateFingerprint, verified: true } };
  }
  const bucket = candidate.bucket ?? "";
  const objectPath = candidate.objectPath ?? "";
  if (!allowedStorageBuckets().has(bucket)) return { ok: false, reason: "gcs_bucket_not_allowed" };
  const expectedGeneration = videoReviewMediaGenerationHint(submission, candidate);
  let metadata: VideoReviewMediaMetadata;
  try {
    metadata = await metadataReader(bucket, objectPath, expectedGeneration || undefined);
  } catch (error) {
    const code = storageErrorCode(error);
    if (code === 403 || code === 404) return { ok: false, reason: "gcs_media_unavailable" };
    // 원본 오류에는 signed URL/object path가 섞일 수 있으므로 outbox에 남는 오류는 고정 문자열만 사용한다.
    throw Object.assign(new Error("video_media_metadata_lookup_failed"), { code: "unavailable", errorCode: "resolve_video_review_media_video_media_metadata_lookup" });
  }
  const contentType = asString(metadata.contentType).toLowerCase();
  const observedGeneration = metadataString(metadata.generation);
  const observed = observedGeneration ? { observedGeneration } : {};
  if (contentType !== VIDEO_MIME_TYPE) return { ok: false, reason: "unsupported_media_mime", ...observed };
  const size = Number(metadata.size);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_BYTES) return { ok: false, reason: "uploaded_media_size_invalid", ...observed };
  const generation = observedGeneration;
  if (!/^\d+$/.test(generation)) return { ok: false, reason: "uploaded_media_generation_invalid", ...observed };
  if (expectedGeneration && expectedGeneration !== generation) return { ok: false, reason: "uploaded_media_generation_mismatch", ...observed };
  const fingerprint = sha256(JSON.stringify({
    source: "gcs",
    bucket,
    objectPath,
    generation,
    md5Hash: metadataString(metadata.md5Hash),
    crc32c: metadataString(metadata.crc32c),
    size,
    updated: metadataString(metadata.updated),
  }));
  return {
    ok: true,
    media: { ...candidate, fingerprint, verified: true, ...(generation ? { generation } : {}) },
  };
}

/**
 * Drift probe for the analysis drain's durable terminal-skip marker. The marker's
 * `mediaKey` is the pure candidate fingerprint — for GCS that is path-only
 * (`gcs:bucket:objectPath`), so a same-path overwrite (Sheet3 re-uploads never bump the
 * revision either) keeps the same key and would stay skipped forever. The marker
 * therefore also stamps the live object generation observed at mark time
 * (`analysisSkip.mediaGeneration`), and this probe answers "is the object behind this
 * candidate still the generation the marker was written for" with ONE metadata read.
 *
 * Semantics:
 * - Non-GCS candidates (YouTube) and malformed candidates: false — no probe needed, the
 *   path/key already is the whole identity.
 * - Reader/Storage failure: false — keep the cheap skip; the full resolution this skip
 *   is avoiding would fail the same way and only burn another merge-write.
 * - Missing baseline (marker predates mediaGeneration) or unreadable live generation:
 *   true — a marker that cannot prove it still describes the live object must not keep
 *   a possibly-replaced upload terminally skipped; the re-evaluation re-marks with a
 *   concrete baseline and self-heals on the same pass.
 */
export async function videoReviewMediaGenerationDrifted(
  candidate: VideoReviewMediaCandidate,
  baselineGeneration: string,
  metadataReader: VideoReviewMediaMetadataReader = readGcsMetadata,
): Promise<boolean> {
  if (candidate.source !== "gcs" || !candidate.bucket || !candidate.objectPath) return false;
  let liveGeneration = "";
  try {
    const metadata = await metadataReader(candidate.bucket, candidate.objectPath);
    liveGeneration = metadataString(metadata.generation);
  } catch {
    return false;
  }
  if (!baselineGeneration || !liveGeneration) return true;
  return liveGeneration !== baselineGeneration;
}

function allowedStorageBuckets(): Set<string> {
  const buckets = new Set<string>();
  const projectId = asString(process.env.GCLOUD_PROJECT) || asString(process.env.GOOGLE_CLOUD_PROJECT);
  if (projectId) {
    buckets.add(`${projectId}.appspot.com`);
    buckets.add(`${projectId}.firebasestorage.app`);
  }
  try {
    const config = JSON.parse(asString(process.env.FIREBASE_CONFIG, "{}")) as { storageBucket?: unknown };
    const configured = asString(config.storageBucket).toLowerCase();
    if (configured) buckets.add(configured);
  } catch {
    // Invalid runtime config is handled by the normal Storage initialization path.
  }
  try {
    const defaultBucket = asString(adminStorage.bucket().name).toLowerCase();
    if (defaultBucket) buckets.add(defaultBucket);
  } catch {
    // Unit tests and projects without a configured default bucket rely on explicit project config.
  }
  return buckets;
}

async function readGcsMetadata(bucket: string, objectPath: string, expectedGeneration?: string): Promise<VideoReviewMediaMetadata> {
  const storageBucket = adminStorage.bucket(bucket);
  if (!expectedGeneration) {
    const [metadata] = await storageBucket.file(objectPath).getMetadata();
    return metadata;
  }
  // First fence against a privileged out-of-band replacement of the live object. Then read
  // the exact immutable generation through the client-library generation selector. Vertex's
  // fileData URI supports canonical gs:// identity but no documented generation parameter,
  // so this is the closest supported server-side read fence before model invocation.
  const [liveMetadata] = await storageBucket.file(objectPath).getMetadata();
  if (metadataString(liveMetadata.generation) !== expectedGeneration) return liveMetadata;
  const [metadata] = await storageBucket.file(objectPath, { generation: expectedGeneration }).getMetadata();
  return metadata;
}

function storageErrorCode(error: unknown): number {
  const record = asRecord(error);
  const numeric = Number(record.code ?? asRecord(record.response).statusCode);
  if (Number.isFinite(numeric)) return numeric;
  const text = asString(record.code).toLowerCase();
  if (text.includes("not-found")) return 404;
  if (text.includes("permission") || text.includes("forbidden")) return 403;
  return 0;
}

function metadataString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

type VideoReviewProgramScopeIdentity = Pick<VideoReviewProgramScope, "canonicalProgramId" | "policyConfigHash">;

function programScopeForSubmission(
  submission: Record<string, unknown>,
  expectedScope?: VideoReviewProgramScopeIdentity,
): VideoReviewProgramScope {
  // A full scope is produced only by the server-side authoritative resolver. Its policy hash
  // can include task/lead/application snapshots that are intentionally absent from the
  // submission document, so re-deriving from the submission alone would reject a valid linked
  // policy. Still validate any program identity carried by the submission before trusting it.
  if (expectedScope && isResolvedVideoReviewProgramScope(expectedScope)) {
    const explicitProgram = asString(submission.canonicalProgramId) || asString(submission.programId);
    if (explicitProgram) {
      const submissionIdentity = videoReviewProgramScopeFromTrustedRecords({
        submission: {
          canonicalProgramId: submission.canonicalProgramId,
          programId: submission.programId,
        },
      });
      if (submissionIdentity.canonicalProgramId !== expectedScope.canonicalProgramId) {
        throw programScopeError("video_review_program_scope_changed");
      }
    }
    return expectedScope;
  }
  const hasProgramIdentity = Boolean(asString(submission.canonicalProgramId) || asString(submission.programId));
  const derived = videoReviewProgramScopeFromTrustedRecords({
    submission: hasProgramIdentity || !expectedScope
      ? submission
      : { ...submission, canonicalProgramId: expectedScope.canonicalProgramId },
  });
  if (expectedScope && !sameVideoReviewProgramScope(derived, expectedScope)) {
    throw programScopeError("video_review_program_scope_changed");
  }
  return derived;
}

function isResolvedVideoReviewProgramScope(
  value: VideoReviewProgramScopeIdentity,
): value is VideoReviewProgramScope {
  const candidate = value as Partial<VideoReviewProgramScope>;
  return typeof candidate.scopeVersion === "string"
    && typeof candidate.policyVersion === "string"
    && Boolean(candidate.policySnapshot)
    && typeof candidate.policySnapshot === "object"
    && !Array.isArray(candidate.policySnapshot)
    && Array.isArray(candidate.sourceProgramIds)
    && Array.isArray(candidate.sourceRefs)
    && typeof candidate.legacyScpFallback === "boolean";
}

function programScopeIdentityFromResult(result: MultimodalJudgeResult): VideoReviewProgramScopeIdentity | null {
  const canonicalProgramId = asString(result.canonicalProgramId);
  const policyConfigHash = asString(result.policyConfigHash);
  if (!canonicalProgramId && !policyConfigHash) return null;
  if (!canonicalProgramId || !/^[a-f0-9]{64}$/.test(policyConfigHash)) {
    throw programScopeError("video_review_program_scope_unresolved");
  }
  return { canonicalProgramId, policyConfigHash };
}

function programScopeFailureReason(error: unknown): string {
  const code = asString(asRecord(error).code);
  if ([
    "video_review_program_scope_unresolved",
    "video_review_program_scope_ambiguous",
    "video_review_program_scope_changed",
  ].includes(code)) return code;
  throw error;
}

export function videoReviewMultimodalSourceFingerprint(
  submission: Record<string, unknown>,
  programScope: VideoReviewProgramScopeIdentity = videoReviewProgramScopeFromTrustedRecords({ submission }),
): string {
  return videoReviewScopedFingerprint(
    "multimodal-source",
    programScope,
    videoReviewSourceFingerprint(submission),
  );
}

function firestoreCache(
  modelId: string,
  programScope: VideoReviewProgramScope,
  normalizeCachedVerdict: (value: unknown) => VideoReviewVerdict,
  reservationToken = "",
): VideoLlmCache<VideoReviewVerdict> {
  return {
    async get(key) {
      const snap = await adminDb.collection(CACHE_COLLECTION).doc(key).get();
      if (!snap.exists) return null;
      const d = snap.data() ?? {};
      if (!videoReviewMultimodalCacheEntryIsPublicSafe(d, modelId)) return null;
      if (asString(d.policyVersion) !== VIDEO_REVIEW_POLICY_VERSION) return null;
      if (asString(d.canonicalProgramId) !== programScope.canonicalProgramId) return null;
      if (asString(d.policyConfigHash) !== programScope.policyConfigHash) return null;
      if (asString(d.programScopeVersion) !== programScope.scopeVersion) return null;
      const expiresAtMs = Date.parse(asString(d.expiresAtIso));
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
      return normalizeCachedVerdict(d.verdict);
    },
    async set(key, value, _meta) {
      const ref = adminDb.collection(CACHE_COLLECTION).doc(key);
      const patch = {
        key,
        verdict: value,
        modelId: videoReviewAllowlistedModelId(modelId),
        policyVersion: VIDEO_REVIEW_POLICY_VERSION,
        canonicalProgramId: programScope.canonicalProgramId,
        policyConfigHash: programScope.policyConfigHash,
        programScopeVersion: programScope.scopeVersion,
        expiresAtIso: new Date(Date.now() + CACHE_TTL_SECONDS * 1000).toISOString(),
        updatedAtIso: new Date().toISOString(),
      };
      if (!reservationToken) {
        // Cache documents are wholly owned by this module. Replacing the reservation document
        // also scrubs any legacy transport/capability fields from an older cache schema.
        await ref.set(patch);
        return;
      }
      await adminDb.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists || asString(snapshot.get("reservationToken")) !== reservationToken) return;
        if (asString(snapshot.get("canonicalProgramId")) !== programScope.canonicalProgramId) return;
        if (asString(snapshot.get("policyConfigHash")) !== programScope.policyConfigHash) return;
        transaction.set(ref, patch);
      });
    },
  };
}

type CacheReservation = { state: "ready" } | { state: "wait" } | { state: "owner"; token: string };
const localMultimodalRuns = new Map<string, Promise<RunVideoLlmResult<VideoReviewVerdict>>>();

async function reserveMultimodalCache(
  cacheKey: string,
  programScope: VideoReviewProgramScope,
): Promise<CacheReservation> {
  const ref = adminDb.collection(CACHE_COLLECTION).doc(cacheKey);
  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data() ?? {};
    const nowMs = Date.now();
    const expiresAtMs = Date.parse(asString(data.expiresAtIso));
    const currentScope = asString(data.policyVersion) === VIDEO_REVIEW_POLICY_VERSION
      && asString(data.canonicalProgramId) === programScope.canonicalProgramId
      && asString(data.policyConfigHash) === programScope.policyConfigHash
      && asString(data.programScopeVersion) === programScope.scopeVersion;
    if (snapshot.exists && currentScope && data.verdict && Number.isFinite(expiresAtMs) && expiresAtMs > nowMs) return { state: "ready" as const };
    const reservationExpiresAtMs = Number(data.reservationExpiresAtMs);
    if (currentScope && asString(data.reservationToken) && Number.isFinite(reservationExpiresAtMs) && reservationExpiresAtMs > nowMs) {
      return { state: "wait" as const };
    }
    const token = randomUUID();
    transaction.set(ref, {
      key: cacheKey,
      reservationToken: token,
      policyVersion: VIDEO_REVIEW_POLICY_VERSION,
      canonicalProgramId: programScope.canonicalProgramId,
      policyConfigHash: programScope.policyConfigHash,
      programScopeVersion: programScope.scopeVersion,
      ...(!currentScope ? {
        verdict: FieldValue.delete(),
        expiresAtIso: FieldValue.delete(),
        modelId: FieldValue.delete(),
      } : {}),
      reservationVersion: Number.isFinite(Number(data.reservationVersion)) ? Number(data.reservationVersion) + 1 : 1,
      reservationStartedAtIso: new Date(nowMs).toISOString(),
      reservationExpiresAtMs: nowMs + CACHE_RESERVATION_LEASE_MS,
      updatedAtIso: new Date(nowMs).toISOString(),
    }, { merge: true });
    return { state: "owner" as const, token };
  });
}

async function releaseMultimodalReservation(cacheKey: string, token: string): Promise<void> {
  const ref = adminDb.collection(CACHE_COLLECTION).doc(cacheKey);
  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || asString(snapshot.get("reservationToken")) !== token) return;
    transaction.set(ref, {
      reservationToken: FieldValue.delete(),
      reservationExpiresAtMs: FieldValue.delete(),
      reservationStartedAtIso: FieldValue.delete(),
      updatedAtIso: new Date().toISOString(),
    }, { merge: true });
  });
}

async function withMultimodalSingleFlight(
  cacheKey: string,
  execute: () => Promise<RunVideoLlmResult<VideoReviewVerdict>>,
): Promise<RunVideoLlmResult<VideoReviewVerdict>> {
  const existing = localMultimodalRuns.get(cacheKey);
  if (existing) {
    const winner = await existing;
    return { ...winner, cacheHit: true, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  }
  const pending = execute();
  localMultimodalRuns.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    if (localMultimodalRuns.get(cacheKey) === pending) localMultimodalRuns.delete(cacheKey);
  }
}

async function waitForMultimodalReservation(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, CACHE_RESERVATION_POLL_MS));
}

export type MultimodalJudgeResult = {
  ok: boolean; submissionId: string; reason?: string;
  persisted?: boolean; stale?: boolean;
  verdict?: VideoReviewVerdict; modelId?: string; cacheHit?: boolean; source?: string; thumbnailUrl?: string;
  canonicalProgramId?: string; policyConfigHash?: string; programScopeVersion?: string;
  mediaSource?: VideoReviewMediaSource; mediaFingerprint?: string;
  mediaDescriptor?: VideoReviewMediaDescriptor;
  reviewCriteria?: ReturnType<typeof videoReviewCriteriaMetadata>;
  usage?: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
};

export type VideoReviewMultimodalPersistencePlan = {
  decisionRef: FirebaseFirestore.DocumentReference;
  decisionData: Record<string, unknown>;
  submissionPatch: Record<string, unknown>;
};

export type VideoReviewMultimodalPersistenceResult = {
  persisted: boolean;
  stale: boolean;
  reason?: "submission_not_found" | "submission_source_changed" | "program_scope_changed" | "persistence_plan_unavailable";
};

export function videoReviewMultimodalPersistencePlan(
  submission: Record<string, unknown> & { id?: string },
  result: MultimodalJudgeResult,
  nowIso: string,
  expectedProgramScope?: VideoReviewProgramScopeIdentity,
): VideoReviewMultimodalPersistencePlan | null {
  const submissionId = asString(submission.id) || result.submissionId;
  const media = result.mediaDescriptor;
  if (!result.ok || !submissionId || !result.verdict || !result.modelId || !media) return null;
  const resultScope = expectedProgramScope ?? programScopeIdentityFromResult(result) ?? undefined;
  const programScope = programScopeForSubmission(submission, resultScope);
  const modelId = videoReviewAllowlistedModelId(result.modelId);
  const decisionId = videoReviewMultimodalDecisionId(submissionId, media.fingerprint, modelId, programScope);
  const decisionRef = adminDb.collection(DECISIONS_COLLECTION).doc(decisionId);
  const criteriaMetadata = result.reviewCriteria ?? videoReviewCriteriaMetadata();
  const usage = result.usage ?? { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  const existingUploadedMedia = asRecord(submission.uploadedMedia);
  const authoritativeRecommendation = {
    ...result.verdict,
    modelId,
    source: "multimodal_callVideoModel",
    decisionRef: decisionRef.path,
    generatedAtIso: nowIso,
    reviewCriteria: criteriaMetadata,
    mediaSource: media.source,
    mediaFingerprint: media.fingerprint,
    canonicalProgramId: programScope.canonicalProgramId,
    policyConfigHash: programScope.policyConfigHash,
    programScopeVersion: programScope.scopeVersion,
    effectiveVideoReviewPolicy: videoReviewEffectiveProgramPolicy(programScope),
  };
  const scopeKey = videoReviewProgramScopeKey(programScope);
  const existingScopeProjection = asRecord(asRecord(submission.videoReviewByScope)[scopeKey]);
  return {
    decisionRef,
    decisionData: {
      id: decisionId,
      submissionId,
      canonicalProgramId: programScope.canonicalProgramId,
      policyConfigHash: programScope.policyConfigHash,
      programScopeVersion: programScope.scopeVersion,
      effectiveVideoReviewPolicy: videoReviewEffectiveProgramPolicy(programScope),
      ...(media.videoId ? { videoId: media.videoId } : {}),
      mediaSource: media.source,
      mediaFingerprint: media.fingerprint,
      ...(media.generation ? { mediaGeneration: media.generation } : {}),
      verdict: result.verdict,
      modelId,
      source: "multimodal_callVideoModel",
      policyVersion: VIDEO_REVIEW_POLICY_VERSION,
      reviewCriteria: criteriaMetadata,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostUsd: usage.estimatedCostUsd,
      cacheHit: result.cacheHit ?? false,
      createdAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    },
    submissionPatch: {
      videoReviewByScope: {
        [scopeKey]: {
          ...existingScopeProjection,
          canonicalProgramId: programScope.canonicalProgramId,
          policyConfigHash: programScope.policyConfigHash,
          programScopeVersion: programScope.scopeVersion,
          multimodal: {
            aiRecommendation: authoritativeRecommendation,
            latestVideoReviewDecisionRef: decisionRef.path,
            updatedAtIso: nowIso,
          },
        },
      },
      ...(programScope.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID ? {
        aiRecommendation: authoritativeRecommendation,
        aiRecommendationMultimodal: authoritativeRecommendation,
      } : {}),
      ...(media.source === "gcs" && media.bucket && media.objectPath ? {
        uploadedMedia: {
          // Keep immutable upload-verification and analysis fields (size, hashes, duration,
          // dedup evidence, original verifiedAtIso). Replacing this map erased those producers,
          // while rewriting verifiedAtIso on every judge run changed an otherwise stable cache
          // fingerprint. The decision ledger already records this inference's timestamp.
          ...existingUploadedMedia,
          source: "gcs",
          bucket: media.bucket,
          objectPath: media.objectPath,
          gcsUri: media.fileUri,
          mimeType: media.mimeType,
          generation: media.generation ?? null,
          fingerprint: media.fingerprint,
        },
      } : {}),
      ...(!asString(submission.thumbnailUrl) && result.thumbnailUrl ? { thumbnailUrl: result.thumbnailUrl } : {}),
    },
  };
}

export async function persistVideoReviewMultimodalResult(
  submissionId: string,
  expectedSourceFingerprint: string,
  result: MultimodalJudgeResult,
  nowIso: string,
  expectedProgramScope?: VideoReviewProgramScopeIdentity,
): Promise<VideoReviewMultimodalPersistenceResult> {
  let resultScope: VideoReviewProgramScopeIdentity | undefined;
  try {
    resultScope = expectedProgramScope ?? programScopeIdentityFromResult(result) ?? undefined;
  } catch {
    return { persisted: false, stale: true, reason: "program_scope_changed" };
  }
  if (!resultScope) return { persisted: false, stale: true, reason: "program_scope_changed" };
  const submissionRef = adminDb.collection("submissions").doc(submissionId);
  return adminDb.runTransaction(async (transaction) => {
    // The model runs outside this transaction. Re-read the authoritative submission before
    // either write, then commit the decision and recommendation atomically only if the exact
    // source generation that was judged is still live.
    const snapshot = await transaction.get(submissionRef);
    if (!snapshot.exists) return { persisted: false, stale: true, reason: "submission_not_found" };
    const currentSubmission = { id: snapshot.id, ...(snapshot.data() ?? {}) };
    let currentProgramScope: VideoReviewProgramScope;
    try {
      currentProgramScope = await resolveAuthoritativeVideoReviewProgramScope(currentSubmission, {
        recordReader: async (collection, documentId) => {
          const related = await transaction.get(adminDb.collection(collection).doc(documentId));
          return related.exists ? { id: related.id, ...(related.data() ?? {}) } : null;
        },
      });
      if (resultScope && !sameVideoReviewProgramScope(currentProgramScope, resultScope)) {
        throw programScopeError("video_review_program_scope_changed");
      }
    } catch {
      return { persisted: false, stale: true, reason: "program_scope_changed" };
    }
    const currentSourceFingerprint = videoReviewMultimodalSourceFingerprint(currentSubmission, currentProgramScope);
    if (currentSourceFingerprint !== expectedSourceFingerprint) {
      return { persisted: false, stale: true, reason: "submission_source_changed" };
    }
    const plan = videoReviewMultimodalPersistencePlan(currentSubmission, result, nowIso, currentProgramScope);
    if (!plan) return { persisted: false, stale: false, reason: "persistence_plan_unavailable" };
    // Both records are module-owned projections. Full decision replacement and top-level map
    // replacement remove any legacy transport/capability fields omitted by the safe schema.
    transaction.set(plan.decisionRef, plan.decisionData);
    transaction.update(submissionRef, videoReviewScopePreservingSubmissionUpdate(plan.submissionPatch));
    return { persisted: true, stale: false };
  });
}

export type JudgeVideoReviewMultimodalOptions = {
  cache?: VideoLlmCache<VideoReviewVerdict>;
  callFn?: VideoLlmCallFn;
  write?: boolean;
  mediaMetadataReader?: VideoReviewMediaMetadataReader;
  fewShotCases?: VideoReviewFewShotCase[];
  /** Server-resolved scope. Public callers must never populate this from request data. */
  programScope?: VideoReviewProgramScope;
  /**
   * Gemini video-understanding frame-sampling resolution override (e.g. "MEDIA_RESOLUTION_LOW").
   * Only the admin-only comparison harness (previewVideoReviewMediaResolution) sets this —
   * production automation callers never pass it, so they fall back to
   * configuredVideoReviewMediaResolution() (VIDEO_REVIEW_MEDIA_RESOLUTION env, unset by default).
   */
  mediaResolution?: string;
};

// W89 레버 3: 배포 재빌드 없이 영상 멀티모달 판정의 Gemini 프레임 샘플링 해상도를 조정한다.
// 미설정이거나 허용값 밖이면 undefined를 반환 — runVideoLlm은 opts.mediaResolution이 undefined면
// Vertex 호출에 그 필드를 아예 싣지 않으므로(vertex.ts opts?.mediaResolution 삼항) 기본은
// 현행과 바이트 동일 동작을 유지한다(기본값 변경 금지). 값은 creatorLanguageGate.ts의
// "MEDIA_RESOLUTION_LOW" 리터럴과 동일한 Gemini 열거값만 허용한다.
export const VIDEO_REVIEW_MEDIA_RESOLUTIONS = new Set([
  "MEDIA_RESOLUTION_LOW",
  "MEDIA_RESOLUTION_MEDIUM",
  "MEDIA_RESOLUTION_HIGH",
]);

export function configuredVideoReviewMediaResolution(): string | undefined {
  const raw = asString(process.env.VIDEO_REVIEW_MEDIA_RESOLUTION).trim().toUpperCase();
  return VIDEO_REVIEW_MEDIA_RESOLUTIONS.has(raw) ? raw : undefined;
}

function programScopedMultimodalFewShotCases(
  cases: VideoReviewFewShotCase[],
  programScope: VideoReviewProgramScope,
): VideoReviewFewShotCase[] {
  return pickProgramScopedVideoReviewFewShotCases(cases, programScope, 5).filter((item) => {
    const caseScope = asRecord(asRecord(item.features).programScope);
    return asString(caseScope.canonicalProgramId) === programScope.canonicalProgramId
      && asString(caseScope.policyConfigHash) === programScope.policyConfigHash;
  });
}

export async function judgeVideoReviewMultimodal(
  submission: Record<string, unknown> & { id?: string },
  options: JudgeVideoReviewMultimodalOptions = {},
): Promise<MultimodalJudgeResult> {
  const submissionId = asString(submission.id) || asString((submission as Record<string, unknown>).submissionId);
  let programScope: VideoReviewProgramScope;
  try {
    programScope = programScopeForSubmission(submission, options.programScope);
  } catch (error) {
    return { ok: false, submissionId, reason: programScopeFailureReason(error) };
  }
  const candidate = videoReviewMediaCandidate(submission);
  if (!candidate) return { ok: false, submissionId, reason: uploadedFileValue(submission) ? "invalid_uploaded_media" : "no_video_media" };
  if (process.env.VERTEX_VIDEO_LANE_APPROVED !== "true") return { ok: false, submissionId, reason: "video_lane_not_approved" };
  const mediaLookup = await resolveVideoReviewMedia(submission, options.mediaMetadataReader);
  if (!mediaLookup.ok) return { ok: false, submissionId, reason: mediaLookup.reason };

  const media = mediaLookup.media;
  const geminiMediaResolution = options.mediaResolution ?? configuredVideoReviewMediaResolution();
  const features = videoReviewFeaturesFromSubmission(submission, programScope);
  const fewShotCandidates = options.fewShotCases
    ?? await selectRecentVideoReviewFewShotCases(submission, { scope: programScope });
  const fewShot = programScopedMultimodalFewShotCases(fewShotCandidates, programScope);
  const prompt = multimodalReviewPrompt(features, fewShot);
  const modelId = selectVertexModelForTask("video_analysis") || MODEL_FALLBACK;
  const parts: VertexContentPart[] = [{ text: prompt }, { fileData: { fileUri: media.fileUri, mimeType: media.mimeType } }];
  // W89 리뷰 처방: mediaResolution 은 판정 입력이므로 캐시 키에 포함해야 한다 — 빠지면 운영에서
  // env 레버를 돌린 뒤에도 이전 해상도의 verdict 가 TTL 동안 조용히 서빙된다. 미설정(현행 기본)일 때는
  // 세그먼트를 아예 더하지 않아 기존 키와 바이트 동일 = 배포 시 캐시 무효화 없음.
  const cacheKey = videoReviewScopedFingerprint(
    "multimodal-cache",
    programScope,
    VIDEO_REVIEW_POLICY_VERSION,
    MULTIMODAL_PROMPT_VERSION,
    modelId,
    features.submissionFingerprint,
    media.fingerprint,
    hashVideoReviewFewShotCases(fewShot),
    ...(geminiMediaResolution ? [`media-resolution:${geminiMediaResolution}`] : []),
  );
  const thumbnailUrl = media.videoId ? youtubeThumb(media.videoId) : undefined;
  const criteriaMetadata = videoReviewCriteriaMetadata();

  const normalizeModelVerdict = (json: unknown) => normalizeVideoReviewVerdict(json, features, {
    modality: "multimodal",
    provider: "vertex",
    modelId,
    observedAtIso: new Date().toISOString(),
    mediaFingerprint: media.fingerprint,
  });
  const runWithCache = (cache: VideoLlmCache<VideoReviewVerdict>) => runVideoLlm<VideoReviewVerdict>("video_review_judge", {
    cacheKey,
    cache,
    modelId,
    responseSchema: VIDEO_REVIEW_RESPONSE_SCHEMA,
    parts,
    mediaResolution: geminiMediaResolution,
    callFn: options.callFn,
    actionId: submissionId || media.fingerprint.slice(0, 16),
    normalize: normalizeModelVerdict,
  });
  const run = await withMultimodalSingleFlight(cacheKey, async () => {
    if (options.cache) return runWithCache(options.cache);
    while (true) {
      const reservation = await reserveMultimodalCache(cacheKey, programScope);
      if (reservation.state === "ready") return runWithCache(firestoreCache(modelId, programScope, normalizeModelVerdict));
      if (reservation.state === "wait") {
        await waitForMultimodalReservation();
        continue;
      }
      try {
        return await runWithCache(firestoreCache(modelId, programScope, normalizeModelVerdict, reservation.token));
      } catch (error) {
        await releaseMultimodalReservation(cacheKey, reservation.token).catch(() => undefined);
        throw error;
      }
    }
  });

  // Vertex consumes the canonical live gs:// URI (its supported fileData format has no
  // generation selector). Re-read the source after the call/cache wait and reject the result
  // unless the same immutable generation/fingerprint is still live. This closes the practical
  // replace-during-analysis window before any decision can be persisted.
  if (media.source === "gcs") {
    const postRunResolution = await resolveVideoReviewMedia(submission, options.mediaMetadataReader);
    if (!postRunResolution.ok) return { ok: false, submissionId, reason: postRunResolution.reason };
    if (postRunResolution.media.fingerprint !== media.fingerprint) {
      return { ok: false, submissionId, reason: "uploaded_media_generation_mismatch" };
    }
  }

  const result: MultimodalJudgeResult = {
    ok: true,
    submissionId,
    verdict: run.value,
    modelId: videoReviewAllowlistedModelId(modelId),
    canonicalProgramId: programScope.canonicalProgramId,
    policyConfigHash: programScope.policyConfigHash,
    programScopeVersion: programScope.scopeVersion,
    cacheHit: run.cacheHit,
    source: "multimodal_callVideoModel",
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    mediaSource: media.source,
    mediaFingerprint: media.fingerprint,
    mediaDescriptor: media,
    reviewCriteria: criteriaMetadata,
    usage: { inputTokens: run.inputTokens, outputTokens: run.outputTokens, estimatedCostUsd: run.estimatedCostUsd },
  };
  if (options.write !== false && submissionId) {
    const persistence = await persistVideoReviewMultimodalResult(
      submissionId,
      videoReviewMultimodalSourceFingerprint(submission, programScope),
      result,
      new Date().toISOString(),
      programScope,
    );
    if (!persistence.persisted) {
      return { ...result, ok: false, persisted: false, stale: persistence.stale, reason: persistence.reason };
    }
    return { ...result, persisted: true, stale: false };
  }
  return result;
}

// 콜러블(수동/admin verify): 저장된 submissionId로만 멀티모달 판정한다. 프로그램
// 스코프를 클라이언트 URL/필드에서 선택하게 두면 다른 프로그램의 cache/few-shot을
// 빌릴 수 있으므로, 서버가 submission/task/application 체인에서 확정한 scope만 사용한다.
export async function judgeVideoReviewMultimodalCallable(
  request: CallableRequestShape,
  options: Omit<JudgeVideoReviewMultimodalOptions, "write" | "programScope"> = {},
) {
  const auth = assertNonGuestAuth(request, "video_review.judge_multimodal", ROLES);
  // 2026-09-27 codex adversarial review round 4 FAIL-2: scp-only review AI judgment tool (manual/
  // admin-verify trigger) — role alone let a non-entitled manager/admin invoke it directly.
  await assertScpEntitled(auth, request, "video_review.judge_multimodal");
  const data = asRecord(request.data);
  const submissionId = asString(data.submissionId);
  if (!submissionId) {
    throw Object.assign(new Error("stored submissionId required"), { code: "failed-precondition", errorCode: "judge_video_review_multimodal_callable_stored_submission_id_required" });
  }
  const snap = await adminDb.collection("submissions").doc(submissionId).get();
  if (!snap.exists) throw Object.assign(new Error("submission not found"), { code: "not-found", errorCode: "judge_video_review_multimodal_callable_submission_found" });
  const submission = { id: snap.id, ...(snap.data() ?? {}) };
  let programScope: VideoReviewProgramScope;
  try {
    programScope = await resolveAuthoritativeVideoReviewProgramScope(submission);
  } catch (error) {
    const reason = programScopeFailureReason(error);
    throw Object.assign(new Error(reason), { code: "failed-precondition", errorCode: "judge_video_review_multimodal_callable_unauthorized", details: { reason } });
  }
  const expectedSourceFingerprint = videoReviewMultimodalSourceFingerprint(submission, programScope);
  const computed = await judgeVideoReviewMultimodal(submission, { ...options, write: false, programScope });
  let result = computed;
  if (computed.ok) {
    const persistence = await persistVideoReviewMultimodalResult(
      submissionId,
      expectedSourceFingerprint,
      computed,
      new Date().toISOString(),
      programScope,
    );
    result = persistence.persisted
      ? { ...computed, persisted: true, stale: false }
      : { ...computed, ok: false, persisted: false, stale: persistence.stale, reason: persistence.reason };
  }
  return result;
}

const MEDIA_RESOLUTION_PREVIEW_ROLES = ["super_admin", "admin"] as const;

function noopVideoLlmCache<T>(): VideoLlmCache<T> {
  // W89 레버 3 하네스 전용: 운영 video_review_multimodal_cache(Firestore)는 mediaResolution을
  // 지문에 포함하지 않는다 — 비교 실행이 그 캐시를 타면 해상도가 다른 결과가 서로 오염될 수
  // 있다(캐시 오염 금지). get은 항상 miss, set은 아무것도 저장하지 않는 in-memory 우회로
  // 매 비교 호출을 항상 새로 판정하고 운영 캐시엔 절대 쓰지 않는다.
  return { async get() { return null; }, async set() { /* intentionally no-op */ } };
}

// W89 레버 3 품질 비교 하네스: 같은 제출물 1건을 지정 mediaResolution으로 재판정해 (판정 결과 +
// usage 토큰)만 반환한다. 스테이징에서 default vs MEDIA_RESOLUTION_LOW 등 샘플 비교용
// (기본 판정 파이프라인/게이트는 그대로 — configuredVideoReviewMediaResolution() 기본 레버는 건드리지 않는다).
// RBAC super_admin/admin, write:false(운영 데이터 쓰기 없음), 캐시 우회(noopVideoLlmCache).
// SEC-P0-009: 반환값은 구조화된 verdict/usage 수치뿐 — 프롬프트/모델 원문 응답은 담지 않는다.
export async function previewVideoReviewMediaResolution(
  request: CallableRequestShape,
  options: { callFn?: VideoLlmCallFn } = {},
) {
  const auth = assertNonGuestAuth(request, "video_review.preview_media_resolution", MEDIA_RESOLUTION_PREVIEW_ROLES);
  // 2026-09-27 codex adversarial review round 4 sweep: scp review-quality comparison harness
  // (staging-only tool, no general-purpose UI) — role alone let a non-entitled admin invoke it.
  await assertScpEntitled(auth, request, "video_review.preview_media_resolution");
  const data = asRecord(request.data);
  const submissionId = asString(data.submissionId);
  if (!submissionId) {
    throw Object.assign(new Error("submissionId required"), { code: "invalid-argument", errorCode: "preview_video_review_media_resolution_submission_id_required" });
  }
  const requestedResolution = asString(data.mediaResolution).trim().toUpperCase();
  if (!VIDEO_REVIEW_MEDIA_RESOLUTIONS.has(requestedResolution)) {
    throw Object.assign(new Error("mediaResolution must be one of MEDIA_RESOLUTION_LOW, MEDIA_RESOLUTION_MEDIUM, MEDIA_RESOLUTION_HIGH"), { code: "invalid-argument", errorCode: "preview_video_review_media_resolution_invalid_resolution" });
  }
  const snap = await adminDb.collection("submissions").doc(submissionId).get();
  if (!snap.exists) throw Object.assign(new Error("submission not found"), { code: "not-found", errorCode: "preview_video_review_media_resolution_submission_not_found" });
  const submission = { id: snap.id, ...(snap.data() ?? {}) };
  let programScope: VideoReviewProgramScope;
  try {
    programScope = await resolveAuthoritativeVideoReviewProgramScope(submission);
  } catch (error) {
    const reason = programScopeFailureReason(error);
    throw Object.assign(new Error(reason), { code: "failed-precondition", errorCode: "preview_video_review_media_resolution_unauthorized", details: { reason } });
  }
  const computed = await judgeVideoReviewMultimodal(submission, {
    write: false,
    programScope,
    mediaResolution: requestedResolution,
    cache: noopVideoLlmCache<VideoReviewVerdict>(),
    callFn: options.callFn,
  });
  const behaviorLog = makeBehaviorLog(auth, "video_review.preview_media_resolution", computed.ok ? "success" : "denied");
  if (!computed.ok) {
    return { ok: false as const, submissionId, mediaResolution: requestedResolution, reason: computed.reason, behaviorLog };
  }
  return {
    ok: true as const,
    submissionId,
    mediaResolution: requestedResolution,
    modelId: computed.modelId,
    cacheHit: false as const,
    verdict: computed.verdict,
    usage: computed.usage,
    behaviorLog,
  };
}
