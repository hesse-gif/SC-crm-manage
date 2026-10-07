// 광고 분류 + 게임적합도 엔진(C1) — videoClassifier.ts(1차 텍스트 분류) 규범을 그대로 답습한다.
//   캐시 선행(video_ad_classification_cache, COST-P0-011) → callModel chokepoint 경유(SEC-P0-005)
//   → usage 로그(video_ad_classification_llm_usage → aiHubReport.reportLlmUsage, COST-P0-006·007).
// 프롬프트 원문은 usage 로그에 싣지 않는다(SEC-P0-009). 외부 AI는 오직 callModel 단일 초크포인트 경유.
//
// ⚠️ YouTube API 현실: 제3자 영상의 유료광고(paidProductPlacement) 플래그는 Data API v3로 노출되지
//   않는다(소유자 OAuth 전용). 따라서 광고 탐지는 title/description/captions의 협찬 시그널
//   (#광고/#sponsored/유료광고/브랜드/PPL 등)에 대한 LLM 판정을 1차로 삼고, 수집 파이프라인이 우연히
//   확보한 paidPromotion 플래그가 있으면 보너스 신호로만 합산한다(있으면 isAd 강제 true).
//
// verdict는 모델이 아니라 (isAd, gameFit) 조합으로 결정론적으로 계산한다 — 감사·재현 가능(스키마 오염 방지).

export const AD_CLASSIFICATION_PROMPT_VERSION = 1;
export const AD_CLASSIFICATION_SOURCE = "text_v1" as const;
const AD_MODEL_FALLBACK = "gemini-2.5-flash-lite";
const AD_CACHE_COLLECTION = "video_ad_classification_cache";
const AD_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_AD_ATTEMPTS = 2;
// 게임적합도 임계치: 이 이상이면 캐주얼게임 적합으로 본다(운영 조정 여지 — 상수 단일 지점).
export const AD_GAME_FIT_THRESHOLD = 0.6;

export type AdVerdict =
  | "good_ad_candidate" // 광고(브랜드딜 이력) + 게임 적합 → 아웃리치 타깃
  | "brand_deal_low_fit" // 광고 이력은 있으나 게임 적합도 낮음
  | "organic_good_fit" // 광고 이력 미검출이나 게임 적합(잠재 후보)
  | "not_relevant"; // 광고 아님 + 게임 부적합

export type AdClassification = {
  readonly isAd: boolean;
  readonly adConfidence: number;
  readonly adSignals: readonly string[];
  readonly gameFit: number;
  readonly fitReasons: readonly string[];
  readonly verdict: AdVerdict;
};

export type AdClassifyInput = {
  readonly videoId: string;
  readonly title: string;
  readonly description?: string;
  readonly channelTitle?: string;
  readonly hashtags?: readonly string[];
  readonly transcriptExcerpt?: string;
  // 수집 파이프라인이 확보한 경우에만 전달되는 유료광고 플래그(보너스 신호). 기본 미확보(undefined).
  readonly paidPromotion?: boolean;
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

type AdCallModel = <T = unknown>(
  modelId: string,
  responseSchema: unknown,
  promptText: string,
) => Promise<VertexResult<T>>;

type AdCacheMetadata = { modelId: string; provider: string; runId: string };

type AdCache = {
  get(key: string): Promise<AdClassification | null>;
  set(key: string, value: AdClassification, metadata: AdCacheMetadata): Promise<void>;
};

export type ClassifyVideoAdOptions = {
  cache?: AdCache;
  callModelFn?: AdCallModel;
  modelId?: string;
  runId?: string;
};

export type AdClassificationResult = AdClassification & {
  readonly modelId: string;
  readonly cacheHit: boolean;
};

type AdResponse = {
  isAd?: unknown;
  adConfidence?: unknown;
  adSignals?: unknown;
  gameFit?: unknown;
  fitReasons?: unknown;
};

type VertexModule = {
  callModel: AdCallModel;
  selectVertexModelForTask: (task: "tagging") => string;
};

type AiHubReportModule = {
  newSessionId: () => string;
  reportLlmUsage: (opts?: Record<string, unknown>) => Promise<void>;
};

type FirestoreSnapshot = { exists: boolean; data(): Record<string, unknown> | undefined };
type FirestoreDocRef = {
  get(): Promise<FirestoreSnapshot>;
  set(data: Record<string, unknown>, options: { merge: boolean }): Promise<unknown>;
};
type FirestoreQuerySnapshotDoc = { id: string; ref: FirestoreDocRef; data(): Record<string, unknown> | undefined };
type FirestoreQuery = {
  where(field: string, op: string, value: unknown): FirestoreQuery;
  limit(count: number): FirestoreQuery;
  get(): Promise<{ docs: FirestoreQuerySnapshotDoc[] }>;
};
type FirestoreDb = { collection(name: string): FirestoreQuery & { doc(id: string): FirestoreDocRef } };

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

function adModelId(): string {
  return vertexModule()?.selectVertexModelForTask("tagging") ?? AD_MODEL_FALLBACK;
}

async function defaultAdCallModel<T = unknown>(
  modelId: string,
  responseSchema: unknown,
  promptText: string,
): Promise<VertexResult<T>> {
  const vertex = vertexModule();
  if (!vertex) throw new Error("vertex callModel module is unavailable");
  return vertex.callModel<T>(modelId, responseSchema, promptText);
}

function adCacheDoc(key: string): FirestoreDocRef {
  const module = adminDbModule();
  if (!module) throw new Error("Firestore ad classification cache is unavailable");
  return module.adminDb.collection(AD_CACHE_COLLECTION).doc(key);
}

function clamp01(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : 0.5;
  return Math.max(0, Math.min(1, Number(numeric.toFixed(3))));
}

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, max);
}

// verdict는 (isAd, gameFit)로 결정론적으로 계산 — 모델 출력에 verdict를 맡기지 않는다(감사·재현성).
export function computeAdVerdict(isAd: boolean, gameFit: number, threshold = AD_GAME_FIT_THRESHOLD): AdVerdict {
  const fit = gameFit >= threshold;
  if (isAd && fit) return "good_ad_candidate";
  if (isAd && !fit) return "brand_deal_low_fit";
  if (!isAd && fit) return "organic_good_fit";
  return "not_relevant";
}

function normalizeCachedClassification(value: unknown): AdClassification | null {
  const r = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!r) return null;
  if (typeof r.verdict !== "string") return null;
  const isAd = r.isAd === true;
  const gameFit = clamp01(r.gameFit);
  return {
    isAd,
    adConfidence: clamp01(r.adConfidence),
    adSignals: stringList(r.adSignals, 6),
    gameFit,
    fitReasons: stringList(r.fitReasons, 4),
    verdict: computeAdVerdict(isAd, gameFit),
  };
}

function firestoreAdCache(): AdCache {
  return {
    async get(key) {
      const snapshot = await adCacheDoc(key).get();
      if (!snapshot.exists) return null;
      const record = snapshot.data() ?? {};
      const expiresAtIso = typeof record.expiresAtIso === "string" ? record.expiresAtIso : "";
      if (expiresAtIso && Date.now() > Date.parse(expiresAtIso)) return null;
      return normalizeCachedClassification(record.classification);
    },
    async set(key, value, metadata) {
      await adCacheDoc(key).set({
        key,
        classification: value,
        modelId: metadata.modelId,
        provider: metadata.provider,
        runId: metadata.runId,
        ttlSeconds: AD_CACHE_TTL_SECONDS,
        expiresAtIso: new Date(Date.now() + AD_CACHE_TTL_SECONDS * 1000).toISOString(),
        updatedAtIso: new Date().toISOString(),
      }, { merge: true });
    },
  };
}

// 캐시 키: videoId + promptVersion — 프롬프트 개정 시 자동 무효화되어 재분류를 유도한다(COST-P0-011).
export function adCacheKey(input: Pick<AdClassifyInput, "videoId">): string {
  return `${input.videoId}:${AD_CLASSIFICATION_PROMPT_VERSION}`;
}

export function adResponseSchema() {
  return {
    type: "object",
    properties: {
      isAd: { type: "boolean" },
      adConfidence: { type: "number" },
      adSignals: { type: "array", items: { type: "string" } },
      gameFit: { type: "number" },
      fitReasons: { type: "array", items: { type: "string" } },
    },
    required: ["isAd", "adConfidence", "adSignals", "gameFit", "fitReasons"],
  } as const;
}

export function adPrompt(input: AdClassifyInput): string {
  const payload = {
    video: {
      title: input.title.slice(0, 280),
      description: (input.description ?? "").slice(0, 1600),
      channelTitle: input.channelTitle ?? "",
      hashtags: (input.hashtags ?? []).slice(0, 12),
      transcriptExcerpt: (input.transcriptExcerpt ?? "").slice(0, 1200),
    },
  };
  return [
    "Analyze one YouTube video on two axes for a casual mobile-game brand-deal pipeline. Return JSON only.",
    "AXIS 1 ad-detection: does this video contain a paid promotion / brand sponsorship / product placement?",
    "  Judge by sponsorship signals in title/description/hashtags/transcript across languages: e.g. '#광고', '#sponsored', '#ad', '유료광고', '유료 광고 포함', 'PPL', '브랜드', 'sponsored by', 'paid partnership', promo/discount codes, affiliate links, 'this video is sponsored'.",
    "  Return isAd(boolean), adConfidence(0..1), adSignals(up to 6 short phrases quoting the actual evidence found; empty if none).",
    "AXIS 2 game-fit: how well does the creator/content fit CASUAL mobile-game advertising (genre/style/audience)? Casual/hyper-casual/puzzle/idle mobile gameplay, family-friendly, broad audience => high; unrelated tech/vlog/news/finance => low.",
    "  Return gameFit(0..1) and fitReasons(up to 4 short phrases).",
    "Do NOT translate quoted signals; keep them verbatim in their original language.",
    JSON.stringify(payload),
  ].join("\n");
}

function isValidAdResponse(json: AdResponse): boolean {
  return typeof json.isAd === "boolean" && typeof json.gameFit === "number" && typeof json.adConfidence === "number";
}

function classificationFromResponse(json: AdResponse, paidPromotion?: boolean): AdClassification {
  // 수집이 확보한 유료광고 플래그가 true면 광고로 강제(보너스 신호가 LLM 미검출을 보정).
  const isAd = json.isAd === true || paidPromotion === true;
  const gameFit = clamp01(json.gameFit);
  const adSignals = stringList(json.adSignals, 6);
  return {
    isAd,
    adConfidence: paidPromotion === true ? Math.max(clamp01(json.adConfidence), 0.9) : clamp01(json.adConfidence),
    adSignals: paidPromotion === true && !adSignals.includes("youtube:paidPromotion") ? [...adSignals, "youtube:paidPromotion"].slice(0, 6) : adSignals,
    gameFit,
    fitReasons: stringList(json.fitReasons, 4),
    verdict: computeAdVerdict(isAd, gameFit),
  };
}

async function logAdUsage(
  runId: string,
  videoId: string,
  result: VertexResult<AdResponse>,
  latencyMs: number,
): Promise<void> {
  const usage = {
    event: "video_ad_classification_llm_usage",
    runId,
    videoId,
    modelId: result.modelId,
    provider: result.provider,
    transport: result.transport ?? "unverified",
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    itemCount: 1,
    cacheHits: 0,
    cacheMisses: 1,
    latencyMs,
  };
  console.info("[video-ad-classification]", usage);
  const aiHub = aiHubReportModule();
  if (!aiHub) return;
  await aiHub.reportLlmUsage({
    sessionId: aiHub.newSessionId(),
    toolId: "video.ad_classification",
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

// 단일 영상 광고+적합도 분류. classifyVideoTierOne과 동일한 캐시선행→callModel chokepoint→usage로그 구조.
export async function classifyVideoAd(
  input: AdClassifyInput,
  options: ClassifyVideoAdOptions = {},
): Promise<AdClassificationResult> {
  const cache = options.cache ?? firestoreAdCache();
  const key = adCacheKey(input);
  const modelId = options.modelId ?? adModelId();
  const runId = options.runId ?? "video-ad-classification";

  const cached = await cache.get(key);
  if (cached) {
    // 캐시된 LLM 판정 위에 현재 paidPromotion 플래그를 재적용(플래그는 캐시 무효화 없이 갱신될 수 있음).
    const merged = input.paidPromotion === true && !cached.isAd
      ? { ...cached, isAd: true, verdict: computeAdVerdict(true, cached.gameFit) }
      : cached;
    return { ...merged, modelId, cacheHit: true };
  }

  const callModelFn = options.callModelFn ?? defaultAdCallModel;
  const schema = adResponseSchema();
  const prompt = adPrompt(input);
  const startedAt = Date.now();

  let result = await callModelFn<AdResponse>(modelId, schema, prompt);
  let attempts = 1;
  while (!isValidAdResponse(result.json) && attempts < MAX_AD_ATTEMPTS) {
    attempts += 1;
    result = await callModelFn<AdResponse>(modelId, schema, prompt);
  }

  const classification = classificationFromResponse(result.json, input.paidPromotion);
  await cache.set(key, classification, { modelId: result.modelId, provider: result.provider, runId });
  await logAdUsage(runId, input.videoId, result, Date.now() - startedAt);
  return { ...classification, modelId: result.modelId, cacheHit: false };
}

export type AdClassificationRecord = AdClassification & {
  readonly classificationSource: typeof AD_CLASSIFICATION_SOURCE;
  readonly model: string;
  readonly promptVersion: number;
  readonly runId: string;
  readonly classifiedAtIso: string;
};

// videos.adClassification에 기록할 레코드 형태로 변환(활성 스키마 필드 고정).
export function toAdClassificationRecord(result: AdClassificationResult, runId: string, nowIso: string): AdClassificationRecord {
  return {
    isAd: result.isAd,
    adConfidence: result.adConfidence,
    adSignals: result.adSignals,
    gameFit: result.gameFit,
    fitReasons: result.fitReasons,
    verdict: result.verdict,
    classificationSource: AD_CLASSIFICATION_SOURCE,
    model: result.modelId,
    promptVersion: AD_CLASSIFICATION_PROMPT_VERSION,
    runId,
    classifiedAtIso: nowIso,
  };
}

// ── 배치 큐 + 비-LLM 휴리스틱(에뮬레이터 e2e 격리용) ──────────────────────────────
// 에뮬레이터/오프라인 경로: 실 LLM 없이 키워드 규칙으로 광고+적합도를 근사한다(commentInsightsAdmin 규범 —
//   emulator는 규칙 폴백, prod는 실 LLM). "실엔진 증명"은 prod 라이브 콜러블(llm_usage)로 별도 수행한다.
const AD_SIGNAL_PATTERNS: readonly RegExp[] = [
  /#\s*광고/i, /유료\s*광고/i, /광고\s*포함/i, /협찬/i, /브랜드\s*딜/i, /제휴/i,
  /#\s*(ad|sponsored|paidpromotion|paidpartnership)\b/i, /\bsponsored\b/i, /\bpaid\s+(promotion|partnership)\b/i,
  /\bpromo\s*code\b/i, /\baffiliate\b/i, /\bppl\b/i,
];
const GAME_FIT_PATTERNS: readonly RegExp[] = [
  /casual/i, /puzzle/i, /hyper[-\s]?casual/i, /idle/i, /방치형/i, /퍼즐/i, /캐주얼/i,
  /mobile\s*game/i, /모바일\s*게임/i, /gameplay/i, /게임/i, /\bgame\b/i,
];

export function heuristicAdClassify(input: AdClassifyInput): AdClassification {
  const haystack = [input.title, input.description ?? "", (input.hashtags ?? []).join(" "), input.transcriptExcerpt ?? ""].join(" \n ");
  const adSignals = AD_SIGNAL_PATTERNS.map((re) => re.exec(haystack)?.[0]?.trim()).filter((v): v is string => Boolean(v)).slice(0, 6);
  const isAd = input.paidPromotion === true || adSignals.length > 0;
  const fitHits = GAME_FIT_PATTERNS.filter((re) => re.test(haystack)).length;
  const gameFit = clamp01(Math.min(1, fitHits / 3));
  const fitReasons = fitHits > 0 ? [`keyword game-fit hits: ${fitHits}`] : [];
  const signals = input.paidPromotion === true && !adSignals.includes("youtube:paidPromotion")
    ? [...adSignals, "youtube:paidPromotion"].slice(0, 6)
    : adSignals;
  return {
    isAd,
    adConfidence: isAd ? (input.paidPromotion === true ? 0.9 : 0.6) : 0.1,
    adSignals: signals,
    gameFit,
    fitReasons,
    verdict: computeAdVerdict(isAd, gameFit),
  };
}

// videos 문서 → AdClassifyInput. 해시태그는 title/description에서 추출.
export function adInputFromVideoDoc(id: string, data: Record<string, unknown>): AdClassifyInput {
  const title = typeof data.title === "string" ? data.title : "";
  const description = typeof data.description === "string" ? data.description : "";
  const hashtags = Array.from(new Set(`${title}\n${description}`.match(/#[\p{L}\p{N}_]+/gu) ?? [])).slice(0, 12);
  return {
    videoId: id,
    title,
    description,
    channelTitle: typeof data.channel === "string" ? data.channel : undefined,
    hashtags,
    paidPromotion: data.paidPromotion === true ? true : undefined,
  };
}

export type ProcessVideoAdClassificationQueueOptions = {
  db?: FirestoreDb;
  cache?: AdCache;
  callModelFn?: AdCallModel;
  modelId?: string;
  runId?: string;
  nowIso?: string;
  limit?: number;
  useLlm?: boolean; // false면 heuristicAdClassify(에뮬레이터). 기본: 실 LLM.
};

export type ProcessVideoAdClassificationQueueResult = { ok: true; scanned: number; classified: number; failed: number };

const DEFAULT_AD_QUEUE_LIMIT = 25;

function adFirestoreDb(options: { db?: FirestoreDb }): FirestoreDb {
  if (options.db) return options.db;
  const module = adminDbModule();
  if (!module) throw new Error("Firestore is unavailable for ad classification queue");
  return module.adminDb;
}

async function classifyOne(input: AdClassifyInput, useLlm: boolean, options: ProcessVideoAdClassificationQueueOptions, runId: string): Promise<AdClassificationResult> {
  if (useLlm) return classifyVideoAd(input, { cache: options.cache, callModelFn: options.callModelFn, modelId: options.modelId, runId });
  return { ...heuristicAdClassify(input), modelId: "heuristic", cacheHit: false };
}

// videos.adClassificationPending===true 를 스캔해 광고+적합도 분류 후 videos.adClassification 병합.
export async function processVideoAdClassificationQueue(
  options: ProcessVideoAdClassificationQueueOptions = {},
): Promise<ProcessVideoAdClassificationQueueResult> {
  const db = adFirestoreDb(options);
  const limit = options.limit ?? DEFAULT_AD_QUEUE_LIMIT;
  const runId = options.runId ?? `video-ad-classification-${Date.now()}`;
  const nowIso = options.nowIso ?? new Date().toISOString();
  const useLlm = options.useLlm !== false;

  const snapshot = await db.collection("videos").where("adClassificationPending", "==", true).limit(limit).get();
  const docs = snapshot.docs ?? [];

  let classified = 0;
  let failed = 0;
  for (const doc of docs) {
    const data = doc.data() ?? {};
    const input = adInputFromVideoDoc(doc.id, data);
    if (!input.title) {
      await doc.ref.set({ adClassificationPending: false, updatedAtIso: nowIso }, { merge: true });
      continue;
    }
    try {
      const result = await classifyOne(input, useLlm, options, runId);
      await doc.ref.set({ adClassification: toAdClassificationRecord(result, runId, nowIso), adClassificationPending: false, updatedAtIso: nowIso }, { merge: true });
      classified += 1;
    } catch (error) {
      failed += 1;
      console.warn("[video-ad-classification] classification failed", { runId, videoId: doc.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: true, scanned: docs.length, classified, failed };
}

// 단일 영상 광고 분류 → videos.adClassification 병합(콜러블/온디맨드).
export async function runAdClassificationForVideo(
  videoId: string,
  options: ProcessVideoAdClassificationQueueOptions = {},
): Promise<{ ok: boolean; videoId: string; classification: AdClassificationRecord | null; reason?: string }> {
  const db = adFirestoreDb(options);
  const runId = options.runId ?? `video-ad-classification-${Date.now()}`;
  const nowIso = options.nowIso ?? new Date().toISOString();
  const useLlm = options.useLlm !== false;
  const ref = db.collection("videos").doc(videoId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, videoId, classification: null, reason: "not_found" };
  const input = adInputFromVideoDoc(videoId, snap.data() ?? {});
  if (!input.title) return { ok: false, videoId, classification: null, reason: "no_title" };
  const result = await classifyOne(input, useLlm, options, runId);
  const record = toAdClassificationRecord(result, runId, nowIso);
  await ref.set({ adClassification: record, adClassificationPending: false, updatedAtIso: nowIso }, { merge: true });
  return { ok: true, videoId, classification: record };
}
