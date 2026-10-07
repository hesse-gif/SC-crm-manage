// 자격심사 언어/억양 게이트 — 지원자 유튜브 채널에서 최근 업로드 3~6개를 샘플링해 멀티모달(Vertex
//   callVideoModel)로 실제 오디오를 듣고 발화 언어 + 영어 억양을 분류한다. 원시 분류 캐시는 프로그램과
//   무관하게 재사용하되, 허용/비허용 판정은 매 실행마다 정확한 프로그램 정책으로 다시 계산한다.
//   음성 없음·music/song-only·저신뢰·억양 불확실·상충 증거는 탈락이 아니라 사람 검토다.
//
// 컴플라이언스: 외부 AI는 vertex.callVideoModel(SEC-P0-005 B2 예외, VERTEX_VIDEO_LANE_APPROVED 게이트) 경유,
//   캐시 선행(creator_accent_cache, COST-P0-011) + usage 로그(aiHubReport.reportLlmUsage, COST-P0), 프롬프트
//   원문 미로깅(SEC-P0-009). YouTube 목록은 Functions 서버측 YouTube Data API 프록시(NET-P0-012).
//
// 샘플링: 최근 업로드에서 후보를 받아 1건씩 억양 분석. 3건 이상 분석 + 결론이 나면 중단, 애매하면(동률/음성
//   없음/오류) 최대 6건까지 확대(요구사항: 3개 → 애매하면 5개 → 많으면 6개).

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { callVideoModel, selectVertexModelForTask, type VertexContentPart, type VertexVideoResult } from "./vertex";
import { newSessionId, reportLlmUsage } from "./aiHubReport";
import { resolveYouTubeChannel, makeYouTubeDataApiClient, type YouTubeApiClient } from "./youtubeEnrichmentService";
import {
  normalizeQualificationLanguageCode,
  XP_HERO_ALLOWED_LANGUAGE_CODES,
  type QualificationLanguageCode,
} from "./qualificationLanguagePolicy";

export type SpokenLanguage = QualificationLanguageCode | "other" | "none";
export type EnglishAccent =
  | "american" | "british" | "australian" | "canadian"
  | "indian" | "south_asian" | "other_non_native" | "unclear" | "na";
export type LanguageGateVerdict = "pass" | "fail" | "hold";

const SPOKEN_LANGUAGES: readonly SpokenLanguage[] = [
  "en", "ko", "de", "ja", "zh", "fr", "it", "no", "da", "is", "nl", "sv",
  "ru", "he", "es", "fi", "pt", "th", "tr", "tl", "vi", "id", "hi", "ar",
  "bn", "ur", "ta", "te", "other", "none",
];
const ENGLISH_ACCENTS: readonly EnglishAccent[] = ["american", "british", "australian", "canadian", "indian", "south_asian", "other_non_native", "unclear", "na"];

// v2 removes the old fixed native-English/Korean/Japanese eligibility instruction.
// Cached values are raw audio classifications and are re-categorized per program policy.
export const ACCENT_PROMPT_VERSION = 2;
export const ACCENT_MODEL_TASK = "scp_creator_accent_gate";
export const ACCENT_CACHE_COLLECTION = "creator_accent_cache";
const ACCENT_CACHE_TTL_SECONDS = 90 * 24 * 60 * 60;
export const LANGUAGE_GATE_MIN_SAMPLE = 3;
export const LANGUAGE_GATE_MAX_SAMPLE = 6;
// 인터뷰 #3 확정 기본값. scpAutomationSettings.countryConfidenceThreshold로 외부화되어
// 즉시 롤백(threshold 완화) 가능 — 이 상수는 설정 미로딩 시 fail-safe 기본값으로만 쓰인다.
export const DEFAULT_COUNTRY_CONFIDENCE_THRESHOLD = 0.8;
const CANDIDATE_FETCH_LIMIT = 12;
const ACCENT_MODEL_FALLBACK = "gemini-2.5-flash";
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export interface AccentAnalysis {
  spokenLanguage: SpokenLanguage;
  englishAccent: EnglishAccent;
  targetMarketFit: boolean;
  confidence: number;
  evidence: string;
}

export interface PerVideoAccent extends AccentAnalysis {
  videoId: string;
  ok: boolean;
  cacheHit: boolean;
  category: "target" | "nonTarget" | "unclear" | "nospeech";
  estimatedCostUsd?: number;
  error?: string;
}

// "hold" = no reliable measured evidence yet: lookup/provider error, no speech,
// music-only/UNKNOWN, low confidence, or target-vs-nontarget ambiguity. It is not
// a rejection and must remain human-gated downstream.
export type CountryGateVerdict = "pass" | "fail" | "hold";

export interface AccentEvidenceSummary {
  videoId: string;
  category: PerVideoAccent["category"];
  spokenLanguage: SpokenLanguage;
  englishAccent: EnglishAccent;
  confidence: number;
  evidence: string;
}

export interface CreatorLanguageGateResult {
  gate: LanguageGateVerdict;
  reason: string;
  channelId: string | null;
  sampledVideoCount: number;
  analyzedSpeechCount: number;
  targetCount: number;
  nonTargetCount: number;
  dominantLanguage: SpokenLanguage | null;
  dominantAccent: EnglishAccent | null;
  perVideo: PerVideoAccent[];
  estimatedCostUsd: number;
  // countryConfidence is the weighted target share. evidenceConfidence is the
  // average confidence of directional evidence used to decide pass/fail/hold.
  // Only confident target evidence passes, only confident non-target evidence fails.
  countryConfidence: number;
  evidenceConfidence?: number;
  countryGate: CountryGateVerdict;
  countryGateReason: string;
  accentEvidence: AccentEvidenceSummary[];
}

export type AccentCallFn = (
  modelId: string,
  responseSchema: unknown,
  parts: VertexContentPart[],
  opts?: { mediaResolution?: string },
) => Promise<VertexVideoResult<AccentAnalysis>>;

export interface RunCreatorLanguageGateOptions {
  readonly youtubeUrl: string;
  readonly now?: Date;
  readonly youtubeApi?: YouTubeApiClient;
  readonly callVideoFn?: AccentCallFn;
  readonly maxSample?: number;
  readonly runId?: string;
  readonly candidateVideoIds?: readonly string[]; // 채널 조회 우회(테스트/직접 지정)
  readonly countryConfidenceThreshold?: number; // scpAutomationSettings 외부화값 주입
  // undefined preserves the exact legacy SCP allow-list; null means this program has
  // no valid language policy and therefore every language decision must be held.
  readonly allowedLanguages?: readonly QualificationLanguageCode[] | null;
}

const ACCENT_SCHEMA = {
  type: "OBJECT",
  properties: {
    spokenLanguage: { type: "STRING", enum: SPOKEN_LANGUAGES as unknown as string[] },
    englishAccent: { type: "STRING", enum: ENGLISH_ACCENTS as unknown as string[] },
    targetMarketFit: { type: "BOOLEAN" },
    confidence: { type: "NUMBER" },
    evidence: { type: "STRING" },
  },
  required: ["spokenLanguage", "englishAccent", "targetMarketFit", "confidence", "evidence"],
} as const;

function accentPrompt(title: string): string {
  return [
    "You are an audio language and accent classifier. LISTEN to the speech in this YouTube video and classify the PRIMARY speaker (ignore background music). Do not decide program eligibility.",
    "Return JSON only:",
    `- spokenLanguage: primary spoken language code (${SPOKEN_LANGUAGES.join(", ")}). Use 'none' for music/song-only audio with no analyzable speech and 'other' only when no listed language can be identified.`,
    "- englishAccent: if spokenLanguage is 'en', classify accent as one of 'american','british','australian','canadian','indian','south_asian','other_non_native','unclear'; otherwise 'na'.",
    "- targetMarketFit: legacy compatibility field. TRUE only when the raw language/accent classification is reliable; FALSE for no speech or unresolved/conflicting audio. Never use it to decide which program accepts a language.",
    "- confidence: 0..1.",
    "- evidence: <=120 chars naming the concrete audio cues (language/accent markers, or 'music only / no speech').",
    `Video title (context only, judge by AUDIO): ${String(title || "").slice(0, 200)}`,
  ].join("\n");
}

function normalizeAccentAnalysis(json: unknown): AccentAnalysis {
  const r = json && typeof json === "object" ? json as Record<string, unknown> : {};
  const spokenLanguage = SPOKEN_LANGUAGES.includes(r.spokenLanguage as SpokenLanguage) ? r.spokenLanguage as SpokenLanguage : "other";
  const englishAccent = ENGLISH_ACCENTS.includes(r.englishAccent as EnglishAccent) ? r.englishAccent as EnglishAccent : (spokenLanguage === "en" ? "unclear" : "na");
  const confidenceRaw = typeof r.confidence === "number" && Number.isFinite(r.confidence) ? r.confidence : 0;
  return {
    spokenLanguage,
    englishAccent,
    targetMarketFit: r.targetMarketFit === true,
    confidence: Math.max(0, Math.min(1, Number(confidenceRaw.toFixed(3)))),
    evidence: typeof r.evidence === "string" ? r.evidence.slice(0, 200) : "",
  };
}

export function accentCategory(
  a: Pick<AccentAnalysis, "spokenLanguage" | "englishAccent">,
  options: { allowedLanguages?: readonly QualificationLanguageCode[] | null } = {},
): PerVideoAccent["category"] {
  if (a.spokenLanguage === "none") return "nospeech";
  if (a.spokenLanguage === "other") return "unclear";
  // Accent uncertainty is never evidence for auto-rejection, even when English itself
  // is disallowed by the program. It always enters the human gate.
  if (a.spokenLanguage === "en" && (a.englishAccent === "unclear" || a.englishAccent === "na")) return "unclear";
  const allowed = allowedLanguageSet(options);
  if (!allowed) return "unclear";
  return allowed.has(a.spokenLanguage) ? "target" : "nonTarget";
}

function mode<T>(values: T[]): T | null {
  if (values.length === 0) return null;
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let bestCount = -1;
  for (const [v, c] of counts) if (c > bestCount) { best = v; bestCount = c; }
  return best;
}

// 순수 집계 — 분석 결과로부터 게이트 판정. (Firestore/네트워크 무의존, 테스트 가능한 leaf)
// `threshold`는 scpAutomationSettings.countryConfidenceThreshold(기본 0.8) 외부화값을 호출부가
// 주입한다 — 여기서는 순수 계산만 하고 설정 조회는 하지 않는다(leaf 함수 유지).
export function evaluateAccentResults(
  perVideo: PerVideoAccent[],
  options: { threshold?: number; allowedLanguages?: readonly QualificationLanguageCode[] | null } = {},
): Omit<CreatorLanguageGateResult, "channelId" | "sampledVideoCount" | "perVideo" | "estimatedCostUsd"> {
  const threshold = clamp01(options.threshold ?? DEFAULT_COUNTRY_CONFIDENCE_THRESHOLD);
  // Categories are always recomputed from raw cached classifications and the exact
  // current program policy. A category cached/evaluated for program A cannot bleed into B.
  const categorized = perVideo.map((video) => ({
    ...video,
    category: accentCategory(video, { allowedLanguages: explicitAllowedLanguages(options) }),
  }));
  const speech = categorized.filter((v) => v.ok && v.spokenLanguage !== "none");
  const target = speech.filter((v) => v.category === "target");
  const nonTarget = speech.filter((v) => v.category === "nonTarget");
  const dominantLanguage = mode(speech.map((v) => v.spokenLanguage));
  const enAccents = speech.filter((v) => v.spokenLanguage === "en").map((v) => v.englishAccent);
  const dominantAccent = enAccents.length > 0 ? mode(enAccents) : null;

  // 다수결 판정(`gate`/`reason`) — 하위호환 유지, 기존 소비자/테스트는 그대로 통과한다.
  let gate: LanguageGateVerdict;
  let reason: string;
  if (speech.length === 0) {
    gate = "hold";
    reason = "분석 가능한 음성이 있는 영상을 확보하지 못함";
  } else if (nonTarget.length > target.length) {
    gate = "fail";
    reason = `프로그램 비허용 언어 우세 (${dominantLanguage ?? "?"}${dominantAccent && dominantAccent !== "na" ? `/${dominantAccent}` : ""}, 비허용 ${nonTarget.length} vs 허용 ${target.length})`;
  } else if (target.length > nonTarget.length) {
    gate = "pass";
    reason = `프로그램 허용 언어 (${dominantLanguage ?? "?"}${dominantAccent && dominantAccent !== "na" ? `/${dominantAccent}` : ""}, 허용 ${target.length} vs 비허용 ${nonTarget.length})`;
  } else {
    gate = "hold";
    reason = `언어/억양 판정 동률 (대상 ${target.length} vs 비대상 ${nonTarget.length}) — 사람 검토 필요`;
  }

  // Confidence-weighted directional evidence. countryConfidence remains the
  // weighted target share for backward-compatible audit displays; evidenceConfidence
  // prevents low-confidence target hints from silently becoming pass.
  const weightedTarget = target.reduce((sum, v) => sum + clamp01(v.confidence), 0);
  const weightedNonTarget = nonTarget.reduce((sum, v) => sum + clamp01(v.confidence), 0);
  const weightedTotal = weightedTarget + weightedNonTarget;
  const countryConfidence = weightedTotal > 0 ? Number((weightedTarget / weightedTotal).toFixed(4)) : 0;
  const targetEvidenceConfidence = target.length > 0 ? Number((weightedTarget / target.length).toFixed(4)) : 0;
  const nonTargetEvidenceConfidence = nonTarget.length > 0 ? Number((weightedNonTarget / nonTarget.length).toFixed(4)) : 0;
  const strongestEvidenceConfidence = Math.max(targetEvidenceConfidence, nonTargetEvidenceConfidence);
  const directionalEvidence = [...target, ...nonTarget];
  const evidenceConfidence = strongestEvidenceConfidence;
  const nonTargetConfidence = weightedTotal > 0 ? Number((weightedNonTarget / weightedTotal).toFixed(4)) : 0;

  const accentEvidence: AccentEvidenceSummary[] = categorized.map((v) => ({
    videoId: v.videoId,
    category: v.category,
    spokenLanguage: v.spokenLanguage,
    englishAccent: v.englishAccent,
    confidence: v.confidence,
    evidence: v.evidence,
  }));

  const evidenceSummary = summarizeAccentEvidence(accentEvidence);
  let countryGate: CountryGateVerdict;
  let countryGateReason: string;
  if (speech.length === 0 || directionalEvidence.length === 0) {
    countryGate = "hold";
    countryGateReason = `canonical_hold:분석가능한음성없음 — 발화 없음/UNKNOWN/music-only evidence; human gate required. evidence: ${evidenceSummary}`;
  } else if (target.length === nonTarget.length || (countryConfidence < threshold && nonTargetConfidence < threshold && weightedTarget >= weightedNonTarget)) {
    countryGate = "hold";
    countryGateReason = `canonical_hold:대상_비대상_증거_모호 — target ${Math.round(countryConfidence * 100)}%, non-target ${Math.round(nonTargetConfidence * 100)}%, threshold ${Math.round(threshold * 100)}%; human gate required. evidence: ${evidenceSummary}`;
  } else if ((weightedTarget > weightedNonTarget && targetEvidenceConfidence < threshold) || (weightedNonTarget > weightedTarget && nonTargetEvidenceConfidence < threshold)) {
    countryGate = "hold";
    countryGateReason = `canonical_hold:증거_신뢰도_부족 — evidenceConfidence ${Math.round(evidenceConfidence * 100)}% < threshold ${Math.round(threshold * 100)}%; human gate required. evidence: ${evidenceSummary}`;
  } else if (countryConfidence >= threshold && targetEvidenceConfidence >= threshold) {
    countryGate = "pass";
    countryGateReason = `canonical_pass:대상_증거_충분 — countryConfidence ${Math.round(countryConfidence * 100)}% ≥ threshold ${Math.round(threshold * 100)}%, evidenceConfidence ${Math.round(evidenceConfidence * 100)}%. evidence: ${evidenceSummary}`;
  } else if (weightedNonTarget > weightedTarget && nonTargetEvidenceConfidence >= threshold) {
    countryGate = "fail";
    countryGateReason = `canonical_fail:비대상_증거_충분 — nonTargetConfidence ${Math.round(nonTargetConfidence * 100)}% ≥ threshold ${Math.round(threshold * 100)}%, evidenceConfidence ${Math.round(evidenceConfidence * 100)}%. evidence: ${evidenceSummary}`;
  } else {
    countryGate = "hold";
    countryGateReason = `canonical_hold:대상_비대상_증거_모호 — target ${Math.round(countryConfidence * 100)}%, non-target ${Math.round(nonTargetConfidence * 100)}%, threshold ${Math.round(threshold * 100)}%; human gate required. evidence: ${evidenceSummary}`;
  }

  return {
    gate,
    reason,
    analyzedSpeechCount: speech.length,
    targetCount: target.length,
    nonTargetCount: nonTarget.length,
    dominantLanguage,
    dominantAccent,
    countryConfidence,
    evidenceConfidence,
    countryGate,
    countryGateReason,
    accentEvidence,
  };
}

// Re-apply the current program policy at the service boundary. The Vertex/cache lane
// owns raw audio classification only; callers must not trust a previously attached
// category/countryGate that may have been produced under another program's policy.
export function enforceCreatorLanguageGatePolicy(
  result: CreatorLanguageGateResult,
  options: { threshold?: number; allowedLanguages?: readonly QualificationLanguageCode[] | null } = {},
): CreatorLanguageGateResult {
  const perVideo = result.perVideo.map((video) => ({
    ...video,
    category: accentCategory(video, { allowedLanguages: explicitAllowedLanguages(options) }),
  }));
  const evaluation = evaluateAccentResults(perVideo, options);
  const preserveProviderHoldReason = perVideo.length === 0 && result.countryGate === "hold";
  return {
    ...result,
    ...evaluation,
    reason: preserveProviderHoldReason ? result.reason : evaluation.reason,
    countryGateReason: preserveProviderHoldReason ? result.countryGateReason : evaluation.countryGateReason,
    sampledVideoCount: perVideo.length,
    perVideo,
  };
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function explicitAllowedLanguages(
  options: { allowedLanguages?: readonly QualificationLanguageCode[] | null },
): readonly QualificationLanguageCode[] | null | undefined {
  return Object.prototype.hasOwnProperty.call(options, "allowedLanguages") ? options.allowedLanguages : undefined;
}

function allowedLanguageSet(
  options: { allowedLanguages?: readonly QualificationLanguageCode[] | null },
): Set<QualificationLanguageCode> | null {
  const configured = explicitAllowedLanguages(options);
  const source = configured === undefined ? XP_HERO_ALLOWED_LANGUAGE_CODES : configured;
  if (!source || source.length === 0) return null;
  const normalized = source.map(normalizeQualificationLanguageCode);
  if (normalized.some((language) => language === null)) return null;
  return new Set(normalized as QualificationLanguageCode[]);
}

// 탈락 사유에 노출할 per-video accent evidence 요약(acceptance (c) — 운영자 오탈락 판별용).
function summarizeAccentEvidence(entries: AccentEvidenceSummary[]): string {
  if (entries.length === 0) return "no videos analyzed";
  return entries
    .slice(0, LANGUAGE_GATE_MAX_SAMPLE)
    .map((e) => `${e.videoId}:${e.category}/${e.spokenLanguage}${e.englishAccent !== "na" ? `-${e.englishAccent}` : ""}@${Math.round(e.confidence * 100)}%${e.evidence ? ` (${e.evidence.slice(0, 60)})` : ""}`)
    .join("; ");
}

// 3건 이상 분석했고 명확한 다수(대상≠비대상)면 결론. 아니면 확대(최대 6).
function isConclusiveSample(perVideo: PerVideoAccent[]): boolean {
  const speech = perVideo.filter((v) => v.ok && v.spokenLanguage !== "none");
  if (speech.length < 2) return false;
  const target = speech.filter((v) => v.category === "target").length;
  const nonTarget = speech.filter((v) => v.category === "nonTarget").length;
  return target !== nonTarget;
}

function accentCacheDocId(videoId: string): string {
  return createHash("sha256").update(`${videoId}:${ACCENT_PROMPT_VERSION}`).digest("hex").slice(0, 40);
}

async function accentCacheGet(videoId: string): Promise<AccentAnalysis | null> {
  try {
    const snap = await adminDb.collection(ACCENT_CACHE_COLLECTION).doc(accentCacheDocId(videoId)).get();
    if (!snap.exists) return null;
    const data = snap.data() ?? {};
    if (!data.analysis) return null;
    return normalizeAccentAnalysis(data.analysis);
  } catch {
    return null;
  }
}

async function accentCacheSet(videoId: string, analysis: AccentAnalysis, modelId: string): Promise<void> {
  try {
    await adminDb.collection(ACCENT_CACHE_COLLECTION).doc(accentCacheDocId(videoId)).set({
      videoId,
      promptVersion: ACCENT_PROMPT_VERSION,
      analysis,
      modelId,
      updatedAt: FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + ACCENT_CACHE_TTL_SECONDS * 1000),
    }, { merge: true });
  } catch {
    /* 캐시 저장 실패는 비치명적 */
  }
}

function accentModelId(): string {
  try {
    return selectVertexModelForTask("video_analysis") || ACCENT_MODEL_FALLBACK;
  } catch {
    return ACCENT_MODEL_FALLBACK;
  }
}

// 단일 영상 억양 분석 — 캐시 선행 → callVideoModel(chokepoint) → usage 로그.
export async function classifyCreatorVideoAccent(
  videoId: string,
  youtubeUrl: string,
  title: string,
  options: { callVideoFn?: AccentCallFn; runId?: string } = {},
): Promise<PerVideoAccent> {
  const cached = await accentCacheGet(videoId);
  if (cached) {
    return { ...cached, videoId, ok: true, cacheHit: true, category: accentCategory(cached) };
  }
  const modelId = accentModelId();
  const callFn = options.callVideoFn ?? (callVideoModel as AccentCallFn);
  const parts: VertexContentPart[] = [
    { text: accentPrompt(title) },
    { fileData: { fileUri: youtubeUrl, mimeType: "video/mp4" } },
  ];
  const startedAt = Date.now();
  try {
    const result = await callFn(modelId, ACCENT_SCHEMA, parts, { mediaResolution: "MEDIA_RESOLUTION_LOW" });
    const analysis = normalizeAccentAnalysis(result.json);
    await accentCacheSet(videoId, analysis, result.modelId);
    await reportLlmUsage({
      sessionId: newSessionId(),
      toolId: ACCENT_MODEL_TASK,
      modelId: result.modelId,
      provider: result.provider,
      transport: result.transport ?? "unverified",
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalCostUsd: result.estimatedCostUsd,
      latencyMs: Date.now() - startedAt,
      actionId: videoId,
    });
    return {
      ...analysis,
      videoId,
      ok: true,
      cacheHit: false,
      category: accentCategory(analysis),
      estimatedCostUsd: Number(result.estimatedCostUsd) || 0,
    };
  } catch (err) {
    return {
      videoId,
      ok: false,
      cacheHit: false,
      spokenLanguage: "none",
      englishAccent: "na",
      targetMarketFit: false,
      confidence: 0,
      evidence: "",
      category: "nospeech",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 채널 URL → 최근 업로드 영상 ID (신규순). Functions 서버측 YouTube Data API 프록시.
export async function recentUploadVideoIds(api: YouTubeApiClient, youtubeUrl: string, limit = CANDIDATE_FETCH_LIMIT): Promise<{ channelId: string | null; videoIds: string[] }> {
  const { channel } = await resolveYouTubeChannel(api, youtubeUrl);
  const channelId = channel.id ?? null;
  const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return { channelId, videoIds: [] };
  const response = await api.playlistItemsList({ part: "snippet", playlistId: uploads, maxResults: Math.min(50, Math.max(limit, LANGUAGE_GATE_MAX_SAMPLE)) });
  const ids: string[] = [];
  for (const item of response.items ?? []) {
    const id = item.snippet?.resourceId?.videoId;
    if (id && YT_ID_RE.test(id)) ids.push(id);
    if (ids.length >= limit) break;
  }
  return { channelId, videoIds: ids };
}

// 지원자별 게이트 오케스트레이션: 후보 확보 → 1건씩 억양 분석 → 3건+결론이면 중단, 애매하면 최대 6건.
export async function runCreatorLanguageGate(options: RunCreatorLanguageGateOptions): Promise<CreatorLanguageGateResult> {
  const maxSample = Math.max(LANGUAGE_GATE_MIN_SAMPLE, Math.min(LANGUAGE_GATE_MAX_SAMPLE, options.maxSample ?? LANGUAGE_GATE_MAX_SAMPLE));
  const api = options.youtubeApi ?? makeYouTubeDataApiClient();

  let channelId: string | null = null;
  let candidates: string[] = [...(options.candidateVideoIds ?? [])];
  if (candidates.length === 0) {
    try {
      const resolved = await recentUploadVideoIds(api, options.youtubeUrl);
      channelId = resolved.channelId;
      candidates = resolved.videoIds;
    } catch {
      return {
        gate: "hold",
        reason: "canonical_hold:provider_or_lookup_unavailable",
        channelId: null,
        sampledVideoCount: 0,
        analyzedSpeechCount: 0,
        targetCount: 0,
        nonTargetCount: 0,
        dominantLanguage: null,
        dominantAccent: null,
        perVideo: [],
        estimatedCostUsd: 0,
        // Provider/lookup failures mean "no reliable evidence", not rejection.
        // Do not expose raw provider errors in persisted audit fields.
        countryConfidence: 0,
        evidenceConfidence: 0,
        countryGate: "hold",
        countryGateReason: "canonical_hold:provider_or_lookup_unavailable — 보류(사람 검토 필요; 재시도 가능, 자동 탈락 아님). raw provider error는 감사 필드에 기록하지 않는다.",
        accentEvidence: [],
      };
    }
  }

  const perVideo: PerVideoAccent[] = [];
  let estimatedCostUsd = 0;
  for (const videoId of candidates) {
    if (perVideo.length >= maxSample) break;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const raw = await classifyCreatorVideoAccent(videoId, url, "", { callVideoFn: options.callVideoFn, runId: options.runId });
    const r = {
      ...raw,
      category: accentCategory(raw, { allowedLanguages: explicitAllowedLanguages(options) }),
    };
    estimatedCostUsd += r.estimatedCostUsd ?? 0;
    perVideo.push(r);
    if (perVideo.length >= LANGUAGE_GATE_MIN_SAMPLE && isConclusiveSample(perVideo)) break;
  }

  const evaluation = evaluateAccentResults(perVideo, {
    threshold: options.countryConfidenceThreshold,
    allowedLanguages: explicitAllowedLanguages(options),
  });
  return {
    ...evaluation,
    channelId,
    sampledVideoCount: perVideo.length,
    perVideo,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
  };
}
