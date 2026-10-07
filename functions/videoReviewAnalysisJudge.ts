// §5 analysis-evidence + Judge auto-decision worker (handoff §5 → feeds the canonical §4
// review transition). For each §4-canonical review-state doc still awaiting analysis, this
// worker (1) runs an injectable analyzer to produce versioned analysis evidence
// (voice_authenticity_risk.v1 + language_accent.v1), (2) persists that evidence onto the
// review-state doc + an append-only audit collection (hash/opaque only — no raw PII), and
// (3) derives evidenceRisk from the voice-risk band and runs a DORMANT-BY-DEFAULT AI Judge
// through the SINGLE canonical transitionVideoReviewDecision (videoReviewTransitionStore).
//
// Hard invariants (composed, not reimplemented):
// - voiceAuthenticityRiskCore.assessVoiceAuthenticityRisk / voiceRiskToEvidenceRisk are the
//   ONLY calibration logic for voice risk; this file never re-derives a band itself.
// - videoReviewTransitionStore.transitionVideoReviewDecision is the ONLY write path for
//   review-state transitions; this worker never flips `state` directly.
// - The Judge always proposes targetStatus "approved" — it NEVER proposes "rejected" or
//   "changes_requested". planVideoReviewTransition's actor gate (videoReviewTransitionCore)
//   downgrades that proposal to "human_review_required" whenever aiAutoPilotEnabled is false
//   OR evidenceRisk isn't "low" — so a synthetic-sounding voice alone can never auto-reject,
//   and with the default autoPilot=false this Judge is dormant (always routes to human review)
//   until autopilot is explicitly enabled (see resolveAutoPilotEnabled below).
// - The default production analyzer is Vertex/AI-Hub-gated and fails closed (returns null,
//   never fabricates) — see defaultVideoReviewAnalyzer for why it is a no-op today.

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";
import {
  isHumanGateRequiredFromSettings,
  readScpAutomationSettings,
} from "./scpAutomationSettings";
import {
  assessVoiceAuthenticityRisk,
  voiceRiskToEvidenceRisk,
  VOICE_AUTHENTICITY_RISK_VERSION,
  type VoiceAuthenticityDecision,
  type VoiceRiskBand,
} from "./voiceAuthenticityRiskCore";
import {
  SCP_VIDEO_REVIEW_STATE_COLLECTION,
  transitionVideoReviewDecision,
} from "./videoReviewTransitionStore";
import type { EvidenceRisk, VideoReviewState } from "./videoReviewTransitionCore";
import {
  aiHubGatewayUrl,
  callVideoModel,
  selectVertexModelForTask,
  type VertexContentPart,
  type VertexVideoResult,
} from "./vertex";
import { VIDEO_REVIEW_MIME_TYPE } from "./videoReviewMedia";
import { resolveProgramTitlesOrDefault } from "./programTitles";
import {
  resolveVideoReviewGameFilterIdentity,
  type VideoReviewGameFilterIdentity,
} from "./videoReviewGameFilter";
import {
  resolveVideoReviewMedia,
  videoReviewMediaCandidate,
  videoReviewMediaGenerationDrifted,
  type VideoReviewMediaDescriptor,
  type VideoReviewMediaMetadataReader,
} from "./videoReviewMultimodal";
import {
  mergeVideoReviewRuleEvidenceLedger,
} from "./videoReviewRuleEvidenceLedger";

// Evidence schema version — persisted as analysisEvidence.schema and compared by
// alreadyAnalyzed. v2 = the v2-game-context prompt revision: evidence gained the strict
// row game identity (game/gameKey), so pre-v2 evidence is a different shape and must
// re-analyze instead of being trusted (the gameKey check already self-heals older docs).
export const VIDEO_REVIEW_ANALYSIS_JUDGE_VERSION = "video_review_analysis_judge_v2" as const;
export const LANGUAGE_ACCENT_ANALYSIS_VERSION = "language_accent.v1" as const;
export const SCP_VIDEO_REVIEW_ANALYSIS_EVIDENCE_AUDIT_COLLECTION = "scp_video_review_analysis_evidence_audit";

const ANALYSIS_JUDGE_ACTOR_ID = "video-review-analysis-judge-ai";
const DEFAULT_BATCH_LIMIT = 10;
const MAX_BATCH_LIMIT = 25;
// Over-fetch the state-filtered scan so already-evidenced docs (which must be skipped, not
// counted against the caller's batchLimit) don't starve a drain call down to zero progress.
const SCAN_MULTIPLIER = 4;

// Media-gate failure reasons that are terminal for the doc's CURRENT media identity — the
// row's own fields make them permanent (a superseding revision writes a fresh head, which
// also deletes analysisSkip). The two remaining reasons stay retryable on purpose:
// gcs_media_unavailable (the object can land after the state doc) and
// video_media_metadata_lookup_failed (a transient Storage error) — retrying those is how a
// late-arriving upload ever gets analyzed. They are NOT retried unconditionally forever
// though (see RETRYABLE_MEDIA_GATE_REASONS below): bounded exponential backoff + an attempt
// cap stop a permanently-missing object from paying a Storage getMetadata + merge-write on
// every single 1-minute schedule tick.
const TERMINAL_MEDIA_GATE_REASONS: ReadonlySet<string> = new Set([
  "no_video_media",
  "invalid_uploaded_media",
  "gcs_bucket_not_allowed",
  "unsupported_media_mime",
  "uploaded_media_size_invalid",
  "uploaded_media_generation_invalid",
  "uploaded_media_generation_mismatch",
]);

// The two media-gate reasons that stay retryable (see comment above). Mirrors the
// attempts/exponential-backoff convention already used for durable retry state elsewhere
// (e.g. youtubeOAuthLifecycle.ts's retryDelayMs: 1m doubling, capped) rather than inventing
// a new shape: 1m -> 2m -> 4m -> ... capped at 1h between attempts, terminal after
// MEDIA_RETRY_MAX_ATTEMPTS. Once exhausted the doc gets the SAME durable `analysisSkip`
// terminal marker as TERMINAL_MEDIA_GATE_REASONS (reason suffixed `_exhausted`), so it is
// picked up by the existing terminal-skip fast path and surfaces to human review the same
// way any other unanalyzable row does.
const RETRYABLE_MEDIA_GATE_REASONS: ReadonlySet<string> = new Set([
  "gcs_media_unavailable",
  "video_media_metadata_lookup_failed",
]);
const MEDIA_RETRY_BACKOFF_BASE_MS = 60_000; // 1 minute
const MEDIA_RETRY_BACKOFF_CAP_MS = 60 * 60_000; // 1 hour
const MEDIA_RETRY_MAX_ATTEMPTS = 24;

function mediaRetryBackoffMs(attempts: number): number {
  return Math.min(
    MEDIA_RETRY_BACKOFF_CAP_MS,
    MEDIA_RETRY_BACKOFF_BASE_MS * (2 ** Math.min(Math.max(attempts - 1, 0), 8)),
  );
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function humanConfirmationSatisfied(value: unknown): boolean {
  if (value === true) return true;
  const confirmation = asRecord(value);
  return confirmation.confirmed === true && asString(confirmation.verdict) === "pass";
}

function hasPendingHumanRuleConfirmation(ledger: readonly unknown[]): boolean {
  return ledger.some((entry) => {
    const row = asRecord(entry);
    return row.requiresHumanConfirmation === true
      && !humanConfirmationSatisfied(row.humanConfirmation);
  });
}

export type AnalysisEvidenceTransport = "vertex_direct" | "ai_hub_gateway" | "unconfigured";

export type LanguageAccentEvidence = {
  version: typeof LANGUAGE_ACCENT_ANALYSIS_VERSION;
  model: string;
  modelVersion: string;
  detectedLocale: string;
  confidence: number;
  reasons: string[];
};

// The persisted-evidence shape. voiceAuthenticityRisk is exactly the output of
// assessVoiceAuthenticityRisk (already versioned/opaque: model/version/confidence/reasons +
// derived band, no raw audio/transcript). No field here ever carries raw PII.
export type AnalysisEvidence = {
  schema: typeof VIDEO_REVIEW_ANALYSIS_JUDGE_VERSION;
  transport: AnalysisEvidenceTransport;
  producedAtIso: string;
  voiceAuthenticityRisk: VoiceAuthenticityDecision;
  languageAccent: LanguageAccentEvidence;
  // Strict row game identity this evidence was produced under + its provenance key segment.
  // Persisted/audit copies are stamped by the drain so injected analyzers cannot mislabel.
  game: AnalysisGameIdentity;
  gameKey: string;
};

// Strict row-level game identity (A1 contract, videoReviewGameFilter). Nested
// `subject.gameId` is explicit evidence — the subject bag and the top-level row are
// resolved SEPARATELY and then converged, so a subject-vs-top-level disagreement surfaces
// as conflict => unknown (human fallback), never a silent precedence. The programId only
// selects the title registry (same single SCP fallback the review surface uses); row
// evidence must still name the game — there is NO default-title landing, so an
// unevidenced/conflicting row can never be silently labeled XP or Snake.
export type AnalysisGameIdentity = Pick<
  VideoReviewGameFilterIdentity,
  "gameId" | "status" | "reason"
>;

export function resolveAnalysisGameIdentity(
  data: Record<string, unknown>,
): AnalysisGameIdentity {
  const programId =
    asString(data.canonicalProgramId) || asString(asRecord(data.subject).programId);
  const registry = resolveProgramTitlesOrDefault(programId);
  const top = resolveVideoReviewGameFilterIdentity(data, registry.programId, registry);
  const subject = asRecord(data.subject);
  if (Object.keys(subject).length === 0) {
    return { gameId: top.gameId, status: top.status, reason: top.reason };
  }
  const nested = resolveVideoReviewGameFilterIdentity(subject, registry.programId, registry);
  const resolvedIds = new Set(
    [nested, top]
      .filter((identity) => identity.status === "resolved")
      .map((identity) => identity.gameId),
  );
  const anyConflict = nested.reason === "conflict" || top.reason === "conflict";
  const anyUnresolved =
    nested.reason === "unresolved-evidence" || top.reason === "unresolved-evidence";
  if (resolvedIds.size === 1 && !anyConflict && !anyUnresolved) {
    return { gameId: [...resolvedIds][0], status: "resolved", reason: "resolved" };
  }
  if (resolvedIds.size > 1 || anyConflict || (resolvedIds.size === 1 && anyUnresolved)) {
    return { gameId: "", status: "unknown", reason: "conflict" };
  }
  return {
    gameId: "",
    status: "unknown",
    reason: anyUnresolved ? "unresolved-evidence" : "no-evidence",
  };
}

// Provenance/cache key segment for every persisted/derived key in this lane: the explicit
// game the row resolved to, or "unknown" for every unresolved/conflict shape. Same media
// under a different explicit game produces a different key, so stale-context evidence can
// never be reused.
export function videoReviewAnalysisGameKey(
  identity: Pick<VideoReviewGameFilterIdentity, "status" | "gameId">,
): string {
  return identity.status === "resolved" && identity.gameId
    ? `g:${identity.gameId}`
    : "g:unknown";
}

// Defensive normalize for analyzer ctx — a caller-provided game can only ever be honored
// when it is a fully resolved registry id; anything else degrades to unknown/no-evidence.
function analysisGameIdentityOf(value: unknown): AnalysisGameIdentity {
  const record = asRecord(value);
  const gameId = asString(record.gameId);
  if (record.status === "resolved" && gameId) {
    return { gameId, status: "resolved", reason: "resolved" };
  }
  const reason = asString(record.reason);
  return {
    gameId: "",
    status: "unknown",
    reason:
      reason === "conflict" || reason === "unresolved-evidence" ? reason : "no-evidence",
  };
}

export type VideoAnalyzerContext = {
  videoSubmissionId: string;
  youtubeUrl: string;
  contentFingerprint: string;
  // Drain-resolved strict row game identity (resolveAnalysisGameIdentity). Downstream only
  // ever sees a registry-resolved title id or "unknown" — never a program/default title.
  game?: AnalysisGameIdentity;
  // Drain-resolved via the SAME canonical resolveVideoReviewMedia validator the multimodal
  // lane owns: present only when a supported media source validated — a YouTube candidate
  // or allowlisted-bucket uploaded GCS media (mime/size/generation fenced). Absent for
  // legacy/direct callers that only carry a bare youtubeUrl.
  media?: VideoReviewMediaDescriptor;
};

// Returns null when the submission is not (yet) analyzable — fail-closed, never fabricated.
export type VideoAnalyzer = (ctx: VideoAnalyzerContext) => Promise<AnalysisEvidence | null>;

// Forward-compatible lane gate mirroring the VERTEX_VIDEO_LANE_APPROVED pattern used by
// videoReviewMultimodal's SEC-P0-005 B2 exception: a human-approved env switch that must be
// explicitly turned on before ANY live model call is attempted for this analysis lane.
export const VIDEO_ANALYSIS_JUDGE_LANE_ENV = "VIDEO_ANALYSIS_JUDGE_LANE_APPROVED";

function analysisJudgeLaneApproved(): boolean {
  return process.env[VIDEO_ANALYSIS_JUDGE_LANE_ENV] === "true";
}

export function videoReviewAnalysisGateReason(): string | null {
  if (!analysisJudgeLaneApproved()) {
    return "VIDEO_ANALYSIS_JUDGE_LANE_APPROVED_not_true";
  }
  if (!aiHubGatewayUrl()) return "AI_HUB_GATEWAY_URL_missing";
  return null;
}

// DEFAULT production analyzer. Gated by VIDEO_ANALYSIS_JUDGE_LANE_ENV (a human-approved
// lane switch, mirroring VERTEX_VIDEO_LANE_APPROVED for videoReviewMultimodal's SEC-P0-005
// B2 exception) AND a configured transport (aiHubGatewayUrl()). Only when BOTH gates are
// open does this attempt a REAL model call via the SAME chokepoint the multimodal review
// engine already uses (vertex.callVideoModel — SEC-P0-005 B2 exception: gateway-bypassed,
// Vertex(ADC) direct, human-approved via VERTEX_VIDEO_LANE_APPROVED). It never invents a
// second model path. Any missing config/credential/media input, or any model error, is a
// fail-closed null — never a fabricated evidence result, never a mislabeled transport.
export type VideoReviewAnalysisModelCaller = (
  modelId: string,
  responseSchema: unknown,
  parts: VertexContentPart[],
) => Promise<VertexVideoResult<unknown>>;

const VIDEO_REVIEW_ANALYSIS_PROMPT_VERSION = "video-review-analysis-judge/v2-game-context";

// Gemini structured-output schema (same OBJECT/STRING/NUMBER/ARRAY convention as
// videoReviewJudgeService.VIDEO_REVIEW_RESPONSE_SCHEMA) for the two raw signals this lane
// needs: a voice-authenticity estimate (fed through assessVoiceAuthenticityRisk — this file
// never recalibrates a band itself) and a language/accent estimate.
const VIDEO_REVIEW_ANALYSIS_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    voice: {
      type: "OBJECT",
      properties: {
        syntheticProbability: { type: "NUMBER" },
        confidence: { type: "NUMBER" },
        reasons: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["syntheticProbability", "confidence", "reasons"],
    },
    language: {
      type: "OBJECT",
      properties: {
        detectedLocale: { type: "STRING" },
        confidence: { type: "NUMBER" },
        reasons: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["detectedLocale", "confidence", "reasons"],
    },
  },
  required: ["voice", "language"],
} as const;

// Bounded, instruction-only prompt — never carries raw transcript/audio (SEC-P0-009 discipline
// already used by videoReviewMultimodal's multimodalReviewPrompt).
function videoReviewAnalysisJudgePrompt(ctx: VideoAnalyzerContext): string {
  const declaredGame = analysisGameIdentityOf(ctx.game);
  return [
    `[${VIDEO_REVIEW_ANALYSIS_PROMPT_VERSION}]`,
    "You are assisting a creator-program video review pipeline.",
    "Observe the provided video and return ONLY the two structured signals defined by the response schema:",
    "1) voice: syntheticProbability (0..1, your best estimate the narration/voice-over is synthetically generated), confidence (0..1), and up to 5 short bounded reasons — never quote transcript text verbatim.",
    "2) language: detectedLocale (BCP-47 style, e.g. 'en-US'), confidence (0..1), and up to 5 short bounded reasons.",
    `Declared game for this row: "${declaredGame.status === "resolved" ? declaredGame.gameId : "unknown"}". When "unknown", the row carried no trustworthy explicit game evidence — never assume a title from program or defaults.`,
    "Never include verbatim transcript text, raw audio content, or personal data in reasons — summarize only.",
    `Reference fingerprint: ${ctx.contentFingerprint || "unknown"}.`,
  ].join(" ");
}

function clamp01(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function boundedReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .slice(0, 5)
    .map((v) => v.trim().slice(0, 200));
}

// Internal gated analysis path. ctx.media is the drain-resolved, validator-fenced media
// descriptor (canonical resolveVideoReviewMedia — the same one videoReviewMultimodal.ts
// owns), so uploaded GCS media is analyzable whenever the review-state contract already
// carries it (bucket allowlist + mime + size + generation fences), not only YouTube links.
// ctx.youtubeUrl remains a legacy direct fallback for callers that resolved a YouTube
// target upstream. Missing/unsupported/unverified media fails closed — never a fabricated
// media reference.
export async function runGatedVideoReviewAnalysis(
  ctx: VideoAnalyzerContext,
  modelCaller: VideoReviewAnalysisModelCaller = callVideoModel,
): Promise<AnalysisEvidence | null> {
  if (videoReviewAnalysisGateReason()) return null;

  const media = ctx.media?.verified ? ctx.media : null;
  const fileUri = media?.fileUri?.trim() || ctx.youtubeUrl?.trim();
  if (!fileUri) {
    console.warn(
      "[video-review-analysis-judge] gated analysis skipped: no supported media available for",
      ctx.videoSubmissionId,
    );
    return null;
  }

  const modelId = selectVertexModelForTask("video_analysis");
  const parts: VertexContentPart[] = [
    { text: videoReviewAnalysisJudgePrompt(ctx) },
    { fileData: { fileUri, mimeType: media?.mimeType ?? VIDEO_REVIEW_MIME_TYPE } },
  ];

  let result: VertexVideoResult<unknown>;
  try {
    result = await modelCaller(modelId, VIDEO_REVIEW_ANALYSIS_RESPONSE_SCHEMA, parts);
  } catch (error) {
    console.warn(
      "[video-review-analysis-judge] gated model call failed (fail-closed, no fabricated evidence):",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }

  const json = asRecord(result.json);
  const voice = asRecord(json.voice);
  const language = asRecord(json.language);

  const voiceAuthenticityRisk = assessVoiceAuthenticityRisk({
    model: result.modelId,
    modelVersion: result.modelId,
    syntheticProbability: clamp01(voice.syntheticProbability),
    confidence: clamp01(voice.confidence),
    reasons: boundedReasons(voice.reasons),
  });

  const languageAccent: LanguageAccentEvidence = {
    version: LANGUAGE_ACCENT_ANALYSIS_VERSION,
    model: result.modelId,
    modelVersion: result.modelId,
    detectedLocale: asString(language.detectedLocale, "unknown"),
    confidence: clamp01(language.confidence),
    reasons: boundedReasons(language.reasons),
  };

  // Truthful transport: callVideoModel's SEC-P0-005 B2 exception always bypasses the
  // gateway and calls Vertex direct (result.transport reflects what generateJsonFromParts
  // actually set) — never relabel a direct Vertex call as ai_hub_gateway.
  const transport: AnalysisEvidenceTransport = result.transport === "ai_hub_gateway" ? "ai_hub_gateway" : "vertex_direct";

  const game = analysisGameIdentityOf(ctx.game);
  return {
    schema: VIDEO_REVIEW_ANALYSIS_JUDGE_VERSION,
    transport,
    producedAtIso: new Date().toISOString(),
    voiceAuthenticityRisk,
    languageAccent,
    game,
    gameKey: videoReviewAnalysisGameKey(game),
  };
}

// DEFAULT production analyzer. Delegates to runGatedVideoReviewAnalysis (gated real model
// call) — never a hardcoded no-op. Callers that need a different/injected decision (tests,
// or a future real integration override) pass their own `analyzer`.
export const defaultVideoReviewAnalyzer: VideoAnalyzer = (ctx) => runGatedVideoReviewAnalysis(ctx);

export type DrainVideoReviewAnalysisJudgeOptions = {
  batchLimit?: number;
  now?: Date;
  analyzer?: VideoAnalyzer;
  // Injectable GCS metadata reader for resolveVideoReviewMedia (same seam as
  // JudgeVideoReviewMultimodalOptions.mediaMetadataReader) — tests/emulator inject a fake;
  // production uses the default Storage metadata reader.
  mediaMetadataReader?: VideoReviewMediaMetadataReader;
  // Explicit override wins. Omitted => read the existing SCP automation policy gate
  // (videoReview stage, final_decision action) via scpAutomationSettings — which itself
  // defaults autoPilotEnabled:false / stage mode:"human_assist" / gate:"required", so the
  // Judge is dormant (routes to human_review_required) unless an operator has explicitly
  // flipped that stage to auto_ai + gate:off AND passed its backtest.
  autoPilotEnabled?: boolean;
};

export type DrainVideoReviewAnalysisJudgeOutcome = "skipped_not_analyzable" | "judged" | "evidence_persisted_transition_failed";

export type DrainVideoReviewAnalysisJudgeResultRow = {
  submissionId: string;
  revision: number;
  outcome: DrainVideoReviewAnalysisJudgeOutcome;
  band?: VoiceRiskBand;
  evidenceRisk?: EvidenceRisk;
  nextState?: VideoReviewState;
  requiresHumanReview?: boolean;
  error?: string;
};

export type DrainVideoReviewAnalysisJudgeResult = {
  scanned: number;
  judged: number;
  skipped: number;
  results: DrainVideoReviewAnalysisJudgeResultRow[];
};

export function videoReviewAnalysisJudgeScheduleLogSummary(result: DrainVideoReviewAnalysisJudgeResult) {
  return { scanned: result.scanned, judged: result.judged, skipped: result.skipped };
}

function boundedBatchLimit(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.trunc(parsed), MAX_BATCH_LIMIT) : DEFAULT_BATCH_LIMIT;
}

async function resolveAutoPilotEnabled(explicit: boolean | undefined): Promise<boolean> {
  if (typeof explicit === "boolean") return explicit;
  try {
    const settings = await readScpAutomationSettings();
    // Reuses the existing SCP automation gate (mode:auto_ai + gate:off + backtest passed) for
    // the videoReview stage's final_decision action — the same policy surface every other SCP
    // automation stage already exposes to operators. Fail-safe: any read error => dormant.
    return !isHumanGateRequiredFromSettings("videoReview", "final_decision", settings).required;
  } catch {
    return false;
  }
}

function alreadyAnalyzed(data: Record<string, unknown>, gameKey: string): boolean {
  const evidence = asRecord(data.analysisEvidence);
  // Same schema version AND same resolved game context. A row re-labeled under a different
  // explicit game re-analyzes instead of reusing stale-context evidence; evidence without
  // a gameKey (pre-B2 writes) mismatches and self-heals on the next drain.
  return (
    evidence.schema === VIDEO_REVIEW_ANALYSIS_JUDGE_VERSION &&
    asString(evidence.gameKey) === gameKey
  );
}

export async function drainVideoReviewAnalysisJudge(
  options: DrainVideoReviewAnalysisJudgeOptions = {},
): Promise<DrainVideoReviewAnalysisJudgeResult> {
  const batchLimit = boundedBatchLimit(options.batchLimit);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const analyzer = options.analyzer ?? defaultVideoReviewAnalyzer;
  // Lane gate BEFORE the scan: with the default analyzer and the lane/transport gate
  // closed, every scanned doc can only fail closed — yet the drain still paid a media
  // resolution (Storage getMetadata for GCS candidates) plus a ledger merge-write per doc
  // on every 1-minute schedule tick, and the batch cap let those dead docs starve
  // everything queued behind them. An injected analyzer is an explicit caller override
  // (same seam as autoPilotEnabled) — the gate guards the live model path, not the seam.
  if (analyzer === defaultVideoReviewAnalyzer && videoReviewAnalysisGateReason()) {
    return { scanned: 0, judged: 0, skipped: 0, results: [] };
  }
  const autoPilotEnabled = await resolveAutoPilotEnabled(options.autoPilotEnabled);

  // Single-field `state in [...]` + limit needs no composite index (Firestore auto-indexes
  // single fields; firestore.indexes.json carries no fieldOverrides exemption for "state").
  const snapshot = await adminDb
    .collection(SCP_VIDEO_REVIEW_STATE_COLLECTION)
    .where("state", "in", ["queued", "in_review"])
    .limit(batchLimit * SCAN_MULTIPLIER)
    .get();

  const results: DrainVideoReviewAnalysisJudgeResultRow[] = [];
  let judged = 0;
  let skipped = 0;
  let scanned = 0;

  for (const doc of snapshot.docs) {
    if (judged + skipped >= batchLimit) break;
    const data = doc.data() ?? {};
    const gameIdentity = resolveAnalysisGameIdentity(data);
    const gameKey = videoReviewAnalysisGameKey(gameIdentity);
    // Already analyzed for THIS schema version + game context => idempotent skip. Combined
    // with the state filter above (approved/human_review_required/etc. fall out of the
    // query entirely), this makes a repeated drain call a no-op for anything already
    // judged under the same game.
    if (alreadyAnalyzed(data, gameKey)) continue;

    const submissionId = doc.id;
    const revision = Number(data.revision ?? 0);
    // Durable terminal skip: a previous drain already proved THIS media identity
    // unanalyzable and stamped `analysisSkip`. mediaKey comes from the pure candidate
    // extractor (no I/O), so a new upload/new media field lands on a different key and
    // re-evaluates. The key is path-only for GCS though (`gcs:bucket:objectPath`) and a
    // Sheet3 re-upload overwrites in place without bumping revision — so the marker
    // additionally records the live object generation seen at mark time, and this skip
    // pays ONE bounded generation probe (GCS candidates only; YouTube stays I/O-free)
    // to catch in-place replacement. A drifted/absent baseline falls through to a full
    // re-evaluation which re-marks with the current generation.
    const mediaCandidate = videoReviewMediaCandidate(data);
    const mediaKey = mediaCandidate?.candidateFingerprint ?? "";
    const priorSkip = asRecord(data.analysisSkip);
    if (
      priorSkip.status === "unanalyzable"
      && Number(priorSkip.revision) === revision
      && asString(priorSkip.mediaKey) === mediaKey
    ) {
      const mediaMoved = mediaCandidate
        ? await videoReviewMediaGenerationDrifted(
            mediaCandidate,
            asString(priorSkip.mediaGeneration),
            options.mediaMetadataReader,
          )
        : false;
      // No drift => still the same unanalyzable object: idempotent skip that must not
      // consume the batch cap or re-pay a Storage getMetadata + merge-write.
      if (!mediaMoved) continue;
    }
    // Bounded retry backoff: a previous drain already saw a RETRYABLE media-gate reason
    // (gcs_media_unavailable / video_media_metadata_lookup_failed) for THIS exact media
    // identity. Skip cheaply — no Storage getMetadata, no merge-write, no batch-cap
    // consumption — until nextRetryAtIso elapses, instead of re-probing GCS on every
    // 1-minute tick while a late-arriving upload is still landing.
    const priorMediaRetry = asRecord(data.analysisMediaRetry);
    if (
      Number(priorMediaRetry.revision) === revision
      && asString(priorMediaRetry.mediaKey) === mediaKey
      && asString(priorMediaRetry.nextRetryAtIso) > nowIso
    ) {
      continue;
    }
    scanned += 1;

    const contentFingerprint = asString(data.contentFingerprint);
    const canonicalProgramId = asString(data.canonicalProgramId);
    const policyConfigHash = asString(data.policyConfigHash);
    const youtubeUrl = asString(data.youtubeUrl);

    // Supported-media eligibility is owned by the SAME canonical resolver the multimodal
    // lane uses (resolveVideoReviewMedia): YouTube links AND uploaded GCS media both
    // qualify once validated (bucket allowlist, mime, size, generation fences). When no
    // supported/validated media exists the analyzer is never invoked — fail closed.
    let media: VideoReviewMediaDescriptor | null = null;
    let mediaGateReason: string | null = null;
    // Live object generation observed during a failed GCS validation — stamped onto a
    // terminal `analysisSkip` so a later same-path overwrite is detectable by the cheap
    // generation probe instead of staying skipped forever.
    let mediaObservedGeneration = "";
    try {
      const resolution = await resolveVideoReviewMedia(data, options.mediaMetadataReader);
      if (resolution.ok) media = resolution.media;
      else {
        mediaGateReason = resolution.reason;
        mediaObservedGeneration = resolution.observedGeneration ?? "";
      }
    } catch {
      // resolveVideoReviewMedia throws only a fixed-string error (no object paths/URLs) for
      // non-403/404 metadata failures — record the stable reason, never the raw error.
      mediaGateReason = "video_media_metadata_lookup_failed";
    }

    const evidence = media
      ? await analyzer({ videoSubmissionId: submissionId, youtubeUrl, contentFingerprint, media, game: gameIdentity })
      : null;
    if (!evidence) {
      const gateReason =
        videoReviewAnalysisGateReason() ||
        mediaGateReason ||
        "analyzer_unavailable";
      // Permanent media-gate failures stamp a durable `analysisSkip` marker keyed to this
      // media identity, so the next drain skips the doc before paying another Storage
      // getMetadata + merge-write (this schedule runs every minute — the marker is what
      // stops a dead doc from rewriting updatedAtIso forever). Transient failures get no
      // marker: they must be re-checked on the next tick.
      const terminalSkip =
        mediaGateReason !== null && TERMINAL_MEDIA_GATE_REASONS.has(mediaGateReason);
      // Retryable failures (gcs_media_unavailable / video_media_metadata_lookup_failed):
      // bump the attempt count carried on THIS exact media identity (reset to 1 whenever
      // the prior retry marker's revision/mediaKey no longer matches, same convergence rule
      // the terminal marker uses) and schedule the next attempt with exponential backoff.
      // Once the cap is reached the doc gets the SAME durable terminal `analysisSkip`
      // marker as a permanent media-gate failure, just with an `_exhausted`-suffixed
      // reason, so it stops being rescanned and surfaces to human review like any other
      // unanalyzable row.
      const retryable =
        mediaGateReason !== null && RETRYABLE_MEDIA_GATE_REASONS.has(mediaGateReason);
      const priorRetryAttempts =
        retryable
        && Number(priorMediaRetry.revision) === revision
        && asString(priorMediaRetry.mediaKey) === mediaKey
          ? nonNegativeInteger(priorMediaRetry.attempts)
          : 0;
      const retryAttempts = priorRetryAttempts + 1;
      const retryExhausted = retryable && retryAttempts >= MEDIA_RETRY_MAX_ATTEMPTS;
      await doc.ref.set(
        {
          ruleEvidenceLedger: mergeVideoReviewRuleEvidenceLedger(
            data.ruleEvidenceLedger,
            [{
              ruleId: "R7",
              verdict: "unknown",
              confidence: 0,
              provider: "voice_language_analysis",
              version:
                `${VOICE_AUTHENTICITY_RISK_VERSION}+${LANGUAGE_ACCENT_ANALYSIS_VERSION}`,
              gateReason,
            }],
            nowIso,
          ),
          ...(terminalSkip || retryExhausted
            ? {
                analysisSkip: {
                  status: "unanalyzable",
                  reason: retryExhausted ? `${mediaGateReason}_exhausted` : mediaGateReason,
                  revision,
                  mediaKey,
                  // mediaKey is path-only — record WHICH object generation proved
                  // unanalyzable so a same-path overwrite (new generation) re-evaluates.
                  ...(mediaObservedGeneration
                    ? { mediaGeneration: mediaObservedGeneration }
                    : {}),
                  markedAtIso: nowIso,
                },
                analysisMediaRetry: FieldValue.delete(),
              }
            : {}),
          ...(retryable && !retryExhausted
            ? {
                analysisMediaRetry: {
                  reason: mediaGateReason,
                  revision,
                  mediaKey,
                  attempts: retryAttempts,
                  nextRetryAtIso: new Date(now.getTime() + mediaRetryBackoffMs(retryAttempts)).toISOString(),
                },
                // A stale terminal `analysisSkip` (e.g. left by an earlier generation-mismatch
                // verdict on this same revision/mediaKey) must not survive alongside a fresh
                // retry marker — the invariant is that the two never coexist (see the success
                // and terminal branches, which already clear/stamp exclusively). Leaving a
                // stale marker here would make the priorSkip drift-probe above run a Storage
                // read every tick, defeating this branch's own not-due short-circuit.
                analysisSkip: FieldValue.delete(),
              }
            : {}),
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      skipped += 1;
      results.push({ submissionId, revision, outcome: "skipped_not_analyzable" });
      continue;
    }

    const band = evidence.voiceAuthenticityRisk.band;
    const evidenceRisk = voiceRiskToEvidenceRisk(band);
    const decisionRef = `ai_judge_${submissionId}_r${revision}_${gameKey}`;

    // Persist the versioned analysis evidence (additive field, hash/opaque only) BEFORE
    // attempting the transition — evidence production is independent of whether the Judge's
    // proposed transition is currently reachable (e.g. a concurrent CAS drift), and the
    // append-only audit trail must record what was analyzed regardless.
    const mergedRuleEvidenceLedger = mergeVideoReviewRuleEvidenceLedger(
      data.ruleEvidenceLedger,
      [{
        ruleId: "R7",
        verdict: "unknown",
        confidence: Math.max(
          evidence.voiceAuthenticityRisk.confidence,
          evidence.languageAccent.confidence,
        ),
        provider: evidence.transport,
        version:
          `${VOICE_AUTHENTICITY_RISK_VERSION}+${LANGUAGE_ACCENT_ANALYSIS_VERSION}`,
        modelId: evidence.languageAccent.model,
        gateReason:
          gameIdentity.status === "resolved"
            ? "human_confirmation_required"
            : "game_identity_unresolved",
        evidenceRef: decisionRef,
      }],
      nowIso,
    );
    const humanRuleConfirmationPending =
      hasPendingHumanRuleConfirmation(mergedRuleEvidenceLedger);

    await doc.ref.set(
      {
        analysisEvidence: {
          ...evidence,
          // Drain-stamped provenance: the resolved row identity wins over anything an
          // injected analyzer claims, so persisted evidence can never be mislabeled.
          game: gameIdentity,
          gameKey,
          judgeDecisionRef: decisionRef,
          judgeAtIso: nowIso,
        },
        ruleEvidenceLedger: mergedRuleEvidenceLedger,
        // Media proved analyzable — drop any stale terminal-skip marker left by an earlier
        // drain so the doc does not carry a contradiction next to fresh evidence, and reset
        // the retry-attempt count (a later media-gate failure on a fresh revision/media
        // identity starts its own backoff from attempt 1).
        analysisSkip: FieldValue.delete(),
        analysisMediaRetry: FieldValue.delete(),
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    await adminDb
      .collection(SCP_VIDEO_REVIEW_ANALYSIS_EVIDENCE_AUDIT_COLLECTION)
      .doc(`${submissionId}__r${revision}__${gameKey}`)
      .set({
        submissionId,
        revision,
        decisionRef,
        evidence: { ...evidence, game: gameIdentity, gameKey },
        createdAtIso: nowIso,
        createdAt: FieldValue.serverTimestamp(),
      });

    try {
      // The Judge always proposes "approved" — planVideoReviewTransition's actor gate
      // downgrades this to human_review_required whenever autoPilot is off or risk isn't
      // low. It NEVER proposes "rejected"/"changes_requested" (never-auto-reject invariant).
      const transition = await transitionVideoReviewDecision(
        {
          submissionId,
          targetStatus: "approved",
          expectedRevision: revision,
          expectedContentFingerprint: contentFingerprint,
          expectedCanonicalProgramId: canonicalProgramId,
          expectedPolicyConfigHash: policyConfigHash,
          decisionRef,
          actorType: "ai",
          actorId: ANALYSIS_JUDGE_ACTOR_ID,
          notifyCreator: true,
          aiAutoPilotEnabled:
            autoPilotEnabled && !humanRuleConfirmationPending,
          evidenceRisk,
        },
        now,
      );
      judged += 1;
      results.push({
        submissionId,
        revision,
        outcome: "judged",
        band,
        evidenceRisk,
        nextState: transition.nextState,
        requiresHumanReview: transition.requiresHumanReview,
      });
    } catch (err) {
      // CAS drift / invalid transition after evidence was already (correctly) persisted.
      // No state change happens; the audit trail still reflects the analysis that ran.
      judged += 1;
      results.push({
        submissionId,
        revision,
        outcome: "evidence_persisted_transition_failed",
        band,
        evidenceRisk,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { scanned, judged, skipped, results };
}
