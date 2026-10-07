// 1차 텍스트 기반 영상 분류(LLM) — main/functions/communitySearch.ts LLM 호출 규범 그대로 답습.
//   캐시 선행(video_classification_cache, COST-P0-011) → callModel chokepoint 경유(SEC-P0-005)
//   → usage 로그(video_classification_llm_usage → aiHubReport.reportLlmUsage, COST-P0-006·007).
// 프롬프트에는 activeEnumIds()로 노출된(골든셋 확보) enum 후보만 실어 신규 enum 오염을 막는다(governance).
// 프롬프트 원문은 usage 로그에 싣지 않는다(SEC-P0-009).

import { activeEnumIds, isValidEnumId, taxonomyVersion } from "./videoTaxonomy";
import { computeTierTwoEligibility, type TierTwoEligibility, type TranscriptStatus } from "./videoTranscript";

export const TIER_ONE_PROMPT_VERSION = 1;
export const TIER_ONE_CLASSIFICATION_SOURCE = "text_v1" as const;
const TIER_ONE_MODEL_FALLBACK = "gemini-2.5-flash-lite";
const CLASSIFICATION_CACHE_COLLECTION = "video_classification_cache";
const CLASSIFICATION_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_CLASSIFICATION_QUEUE_LIMIT = 25;
const MAX_TIER_ONE_ATTEMPTS = 2;
const INVALID_ENUM_CONFIDENCE_PENALTY = 0.4;

export type TierOneClassification = {
  readonly format: string;
  readonly genreStyle: string;
  readonly contentNature: string;
  readonly confidence: number;
};

export type TierOneInput = {
  readonly videoId: string;
  readonly title: string;
  readonly description?: string;
  readonly channelTitle?: string;
  readonly hashtags?: readonly string[];
  readonly transcriptExcerpt?: string;
  readonly transcriptState?: TranscriptStatus;
};

type VertexResult<T = unknown> = {
  json: T;
  text: string;
  modelId: string;
  provider: string;
  transport?: "ai_hub_gateway" | "vertex_direct" | "cache" | "unverified";
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

type TierOneCallModel = <T = unknown>(
  modelId: string,
  responseSchema: unknown,
  promptText: string,
) => Promise<VertexResult<T>>;

type TierOneCacheMetadata = { modelId: string; provider: string; runId: string };

type TierOneCache = {
  get(key: string): Promise<TierOneClassification | null>;
  set(key: string, value: TierOneClassification, metadata: TierOneCacheMetadata): Promise<void>;
};

export type ClassifyVideoTierOneOptions = {
  cache?: TierOneCache;
  callModelFn?: TierOneCallModel;
  modelId?: string;
  runId?: string;
};

export type TierOneClassificationResult = TierOneClassification & {
  readonly modelId: string;
  readonly cacheHit: boolean;
};

type TierOneResponse = {
  format?: unknown;
  genreStyle?: unknown;
  contentNature?: unknown;
  confidence?: unknown;
};

type VertexModule = {
  callModel: TierOneCallModel;
  selectVertexModelForTask: (task: "tagging") => string;
};

type AiHubReportModule = {
  newSessionId: () => string;
  reportLlmUsage: (opts?: Record<string, unknown>) => Promise<void>;
};

type FirestoreSnapshot = {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
};

type FirestoreDocRef = {
  get(): Promise<FirestoreSnapshot>;
  set(data: Record<string, unknown>, options: { merge: boolean }): Promise<unknown>;
};

type FirestoreQuerySnapshotDoc = {
  id: string;
  ref: FirestoreDocRef;
  data(): Record<string, unknown> | undefined;
};

type FirestoreQuery = {
  where(field: string, op: string, value: unknown): FirestoreQuery;
  limit(count: number): FirestoreQuery;
  get(): Promise<{ docs: FirestoreQuerySnapshotDoc[] }>;
};

type FirestoreDb = {
  collection(name: string): FirestoreQuery & { doc(id: string): FirestoreDocRef };
};

declare const require: ((id: string) => unknown) | undefined;

function asRequireModule<T>(moduleName: string): T | null {
  if (typeof require !== "function") return null;
  return require(moduleName) as T;
}

function vertexModule(): VertexModule | null {
  return asRequireModule<VertexModule>("./vertex");
}

function aiHubReportModule(): AiHubReportModule | null {
  return asRequireModule<AiHubReportModule>("./aiHubReport");
}

function adminDbModule(): { adminDb: FirestoreDb } | null {
  return asRequireModule<{ adminDb: FirestoreDb }>("./firebaseAdmin");
}

function tierOneModelId(): string {
  return vertexModule()?.selectVertexModelForTask("tagging") ?? TIER_ONE_MODEL_FALLBACK;
}

async function defaultTierOneCallModel<T = unknown>(
  modelId: string,
  responseSchema: unknown,
  promptText: string,
): Promise<VertexResult<T>> {
  const vertex = vertexModule();
  if (!vertex) throw new Error("vertex callModel module is unavailable");
  return vertex.callModel<T>(modelId, responseSchema, promptText);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function classificationCacheDoc(key: string): FirestoreDocRef {
  const module = adminDbModule();
  if (!module) throw new Error("Firestore video classification cache is unavailable");
  return module.adminDb.collection(CLASSIFICATION_CACHE_COLLECTION).doc(key);
}

function normalizeConfidence(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : 0.5;
  return Math.max(0, Math.min(1, Number(numeric.toFixed(3))));
}

function normalizeCachedClassification(value: unknown): TierOneClassification | null {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const format = stringField(record.format);
  const genreStyle = stringField(record.genreStyle);
  const contentNature = stringField(record.contentNature);
  if (!format || !genreStyle || !contentNature) return null;
  return { format, genreStyle, contentNature, confidence: normalizeConfidence(record.confidence) };
}

function firestoreClassificationCache(): TierOneCache {
  return {
    async get(key) {
      const snapshot = await classificationCacheDoc(key).get();
      if (!snapshot.exists) return null;
      const record = snapshot.data() ?? {};
      const expiresAtIso = stringField(record.expiresAtIso);
      if (expiresAtIso && Date.now() > Date.parse(expiresAtIso)) return null;
      return normalizeCachedClassification(record.classification);
    },
    async set(key, value, metadata) {
      await classificationCacheDoc(key).set({
        key,
        classification: value,
        modelId: metadata.modelId,
        provider: metadata.provider,
        runId: metadata.runId,
        ttlSeconds: CLASSIFICATION_CACHE_TTL_SECONDS,
        expiresAtIso: new Date(Date.now() + CLASSIFICATION_CACHE_TTL_SECONDS * 1000).toISOString(),
        updatedAtIso: new Date().toISOString(),
      }, { merge: true });
    },
  };
}

// 캐시 키: videoId + taxonomyVersion + promptVersion + transcriptState — taxonomy/prompt 개정이나
// 자막 상태 변경(none→available) 시 자동 무효화되어 재분류를 유도한다(COST-P0-011).
export function tierOneCacheKey(input: Pick<TierOneInput, "videoId" | "transcriptState">): string {
  const transcriptState = input.transcriptState ?? "none";
  return `${input.videoId}:${taxonomyVersion()}:${TIER_ONE_PROMPT_VERSION}:${transcriptState}`;
}

function tierOneResponseSchema() {
  return {
    type: "object",
    properties: {
      format: { type: "string", enum: activeEnumIds("format") },
      genreStyle: { type: "string", enum: activeEnumIds("genreStyle") },
      contentNature: { type: "string", enum: activeEnumIds("contentNature") },
      confidence: { type: "number" },
    },
    required: ["format", "genreStyle", "contentNature", "confidence"],
  } as const;
}

function tierOnePrompt(input: TierOneInput): string {
  const payload = {
    video: {
      title: input.title.slice(0, 280),
      description: (input.description ?? "").slice(0, 1600),
      channelTitle: input.channelTitle ?? "",
      hashtags: (input.hashtags ?? []).slice(0, 12),
      transcriptExcerpt: (input.transcriptExcerpt ?? "").slice(0, 1200),
    },
    candidates: {
      format: activeEnumIds("format"),
      genreStyle: activeEnumIds("genreStyle"),
      contentNature: activeEnumIds("contentNature"),
    },
  };
  return [
    "Classify one mobile-game related YouTube video into exactly one id per axis, chosen only from the provided candidate id lists.",
    "Return JSON only with format, genreStyle, contentNature (each must be one of that axis's candidate ids) and confidence from 0 to 1.",
    "Use title, description, channelTitle, hashtags, and transcriptExcerpt (if present) as evidence. Never invent ids outside the candidate lists.",
    JSON.stringify(payload),
  ].join("\n");
}

function isValidTierOneResponse(json: TierOneResponse): boolean {
  return typeof json.format === "string" && isValidEnumId("format", json.format)
    && typeof json.genreStyle === "string" && isValidEnumId("genreStyle", json.genreStyle)
    && typeof json.contentNature === "string" && isValidEnumId("contentNature", json.contentNature);
}

// enum 검증 실패 시 confidence를 강등(× INVALID_ENUM_CONFIDENCE_PENALTY)하고, 유효하지 않은 축은
// 첫 번째 활성 enum으로 대체한다(스키마가 enum을 강제하므로 실제로는 모델이 스키마를 어겼을 때 대비하는 방어선).
function classificationFromResponse(json: TierOneResponse): TierOneClassification {
  const format = typeof json.format === "string" && isValidEnumId("format", json.format) ? json.format : undefined;
  const genreStyle = typeof json.genreStyle === "string" && isValidEnumId("genreStyle", json.genreStyle) ? json.genreStyle : undefined;
  const contentNature = typeof json.contentNature === "string" && isValidEnumId("contentNature", json.contentNature) ? json.contentNature : undefined;
  const confidence = normalizeConfidence(json.confidence);
  const allValid = format !== undefined && genreStyle !== undefined && contentNature !== undefined;
  return {
    format: format ?? activeEnumIds("format")[0] ?? "unknown",
    genreStyle: genreStyle ?? activeEnumIds("genreStyle")[0] ?? "unknown",
    contentNature: contentNature ?? activeEnumIds("contentNature")[0] ?? "unknown",
    confidence: allValid ? confidence : Number((confidence * INVALID_ENUM_CONFIDENCE_PENALTY).toFixed(3)),
  };
}

async function logTierOneUsage(
  runId: string,
  videoId: string,
  result: VertexResult<TierOneResponse>,
  cacheHits: number,
  latencyMs: number,
): Promise<void> {
  const usage = {
    event: "video_classification_llm_usage",
    runId,
    videoId,
    modelId: result.modelId,
    provider: result.provider,
    transport: result.transport ?? "unverified",
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    itemCount: 1,
    cacheHits,
    cacheMisses: 1,
    latencyMs,
  };
  console.info("[video-classification]", usage);
  const aiHub = aiHubReportModule();
  if (!aiHub) return;
  await aiHub.reportLlmUsage({
    sessionId: aiHub.newSessionId(),
    toolId: "video.classification.tier_one",
    modelId: result.modelId,
    provider: result.provider,
    transport: result.transport ?? "unverified",
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    totalCostUsd: result.estimatedCostUsd,
    latencyMs,
    actionId: runId,
  });
}

// 1차 텍스트 영상 분류. communitySearch.enrichCommunityPostSentiments와 동일한 캐시선행→callModel
// chokepoint→usage로그 구조를 단일 항목에 적용한 버전(배치는 processVideoClassificationQueue가 담당).
export async function classifyVideoTierOne(
  input: TierOneInput,
  options: ClassifyVideoTierOneOptions = {},
): Promise<TierOneClassificationResult> {
  const cache = options.cache ?? firestoreClassificationCache();
  const key = tierOneCacheKey(input);
  const modelId = options.modelId ?? tierOneModelId();
  const runId = options.runId ?? "video-classification";

  const cached = await cache.get(key);
  if (cached) return { ...cached, modelId, cacheHit: true };

  const callModelFn = options.callModelFn ?? defaultTierOneCallModel;
  const schema = tierOneResponseSchema();
  const prompt = tierOnePrompt(input);
  const startedAt = Date.now();

  let result = await callModelFn<TierOneResponse>(modelId, schema, prompt);
  let attempts = 1;
  while (!isValidTierOneResponse(result.json) && attempts < MAX_TIER_ONE_ATTEMPTS) {
    attempts += 1;
    result = await callModelFn<TierOneResponse>(modelId, schema, prompt);
  }

  const classification = classificationFromResponse(result.json);
  await cache.set(key, classification, { modelId: result.modelId, provider: result.provider, runId });
  await logTierOneUsage(runId, input.videoId, result, 0, Date.now() - startedAt);
  return { ...classification, modelId: result.modelId, cacheHit: false };
}

export type VideoClassificationRecord = {
  readonly format: string;
  readonly genreStyle: string;
  readonly contentNature: string;
  readonly confidence: number;
  readonly classificationSource: typeof TIER_ONE_CLASSIFICATION_SOURCE;
  readonly model: string;
  readonly promptVersion: number;
  readonly taxonomyVersion: number;
  readonly runId: string;
  readonly classifiedAtIso: string;
};

export type ProcessVideoClassificationQueueOptions = {
  db?: FirestoreDb;
  limit?: number;
  runId?: string;
  nowIso?: string;
  cache?: TierOneCache;
  callModelFn?: TierOneCallModel;
  modelId?: string;
};

export type ProcessVideoClassificationQueueResult = {
  readonly ok: true;
  readonly scanned: number;
  readonly classified: number;
  readonly failed: number;
};

function firestoreDb(options: ProcessVideoClassificationQueueOptions): FirestoreDb {
  if (options.db) return options.db;
  const module = adminDbModule();
  if (!module) throw new Error("Firestore is unavailable for video classification queue processing");
  return module.adminDb;
}

function tierOneInputFromVideoDoc(id: string, data: Record<string, unknown>): TierOneInput {
  const transcript = data.transcript && typeof data.transcript === "object" ? data.transcript as Record<string, unknown> : {};
  const transcriptState: TranscriptStatus = transcript.status === "available" || transcript.status === "fetch_failed" ? transcript.status : "none";
  return {
    videoId: id,
    title: stringField(data.title) || "Untitled YouTube video",
    description: stringField(data.description),
    channelTitle: stringField(data.creatorName) || stringField(data.channelTitle),
    hashtags: Array.isArray(data.hashtags) ? data.hashtags.filter((item): item is string => typeof item === "string") : [],
    transcriptExcerpt: stringField(transcript.text),
    transcriptState,
  };
}

function tierTwoEligibilityInputFromVideoDoc(data: Record<string, unknown>, transcriptStatus: TranscriptStatus) {
  return {
    transcript: { status: transcriptStatus },
    matchedGame: typeof data.matchedGame === "string" ? data.matchedGame : undefined,
    ownedGameMatch: data.ownedGameMatch === true,
    similarGameMatch: data.similarGameMatch === true,
  };
}

// 분류 대기열 배치 소비 — classificationPending===true(신규 영상 또는 자막 상태 변경분)를 스캔해
// tier-one 분류 후 youtube_videos에 3축+confidence+classificationSource를 기록한다.
// index.ts의 processVideoClassificationQueue onSchedule(every 10 minutes)이 이 함수를 호출한다.
export async function processVideoClassificationQueue(
  options: ProcessVideoClassificationQueueOptions = {},
): Promise<ProcessVideoClassificationQueueResult> {
  const db = firestoreDb(options);
  const limit = options.limit ?? DEFAULT_CLASSIFICATION_QUEUE_LIMIT;
  const runId = options.runId ?? `video-classification-${Date.now()}`;
  const nowIso = options.nowIso ?? new Date().toISOString();

  const snapshot = await db.collection("youtube_videos")
    .where("classificationPending", "==", true)
    .limit(limit)
    .get();
  const docs = snapshot.docs ?? [];

  let classified = 0;
  let failed = 0;
  for (const doc of docs) {
    const data = doc.data() ?? {};
    const input = tierOneInputFromVideoDoc(doc.id, data);
    try {
      const result = await classifyVideoTierOne(input, {
        cache: options.cache,
        callModelFn: options.callModelFn,
        modelId: options.modelId,
        runId,
      });
      const classification: VideoClassificationRecord = {
        format: result.format,
        genreStyle: result.genreStyle,
        contentNature: result.contentNature,
        confidence: result.confidence,
        classificationSource: TIER_ONE_CLASSIFICATION_SOURCE,
        model: result.modelId,
        promptVersion: TIER_ONE_PROMPT_VERSION,
        taxonomyVersion: taxonomyVersion(),
        runId,
        classifiedAtIso: nowIso,
      };
      const tierTwoEligibility: TierTwoEligibility = computeTierTwoEligibility(
        tierTwoEligibilityInputFromVideoDoc(data, input.transcriptState ?? "none"),
      );
      await doc.ref.set({
        classification,
        classificationPending: false,
        tierTwoEligibility,
        updatedAtIso: nowIso,
      }, { merge: true });
      classified += 1;
    } catch (error) {
      failed += 1;
      console.warn("[video-classification] tier-one classification failed", {
        runId,
        videoId: doc.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { ok: true, scanned: docs.length, classified, failed };
}
