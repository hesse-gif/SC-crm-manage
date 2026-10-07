// 피드 영상 댓글 3축 분석(감성·의도7·브랜드세이프티) — videoClassifier.ts + communitySearch.enrichRedditComments
//   규범 답습: 캐시 선행(video_comment_analysis_cache, COST-P0-011) → callModel chokepoint(SEC-P0-005)
//   → usage 로그(aiHubReport.reportLlmUsage, COST-P0-006·007). 프롬프트 원문은 usage 로그·캐시 메타에 비노출(SEC-P0-009).
//   집계(aggregateCommentInsights)는 네트워크/Firestore 무의존 순수 함수(테스트 가능한 leaf).
import { createHash } from "node:crypto";
import { commentCategoryV1 } from "./taxonomy/comment-category.v1";

export const COMMENT_ANALYSIS_PROMPT_VERSION = 2; // v2: summary/themes 한국어 강제(sampleQuotes verbatim). 캐시키 포함 → 기존 영어 분석 자연 무효화(idempotent 백필).
export const COMMENT_ANALYSIS_TAXONOMY_VERSION = commentCategoryV1.version;
const COMMENT_ANALYSIS_MODEL_FALLBACK = "gemini-2.5-flash-lite";
const COMMENT_ANALYSIS_CACHE_COLLECTION = "video_comment_analysis_cache";
const COMMENT_ANALYSIS_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
// 배치당 분석 댓글 수. flash-lite가 대배치(>~60)에서 구조화 JSON을 간헐적으로 깨뜨림(결정적 truncation) →
//   기본 50(top-relevance)으로 신뢰성 확보. 집계 통계는 표본 50으로도 견고(표본하한 10). env로 튜닝 가능.
const MAX_ANALYZED_COMMENTS = Number.parseInt(process.env.SCP_COMMENT_MAX_ANALYZED ?? "", 10) || 50;
const DEFAULT_BRAND_SAFETY_FLAG_RATIO = 0.1;
const SAMPLE_QUOTE_MAX = 3;
const THEME_MAX = 6;

export const COMMENT_CATEGORY_IDS = commentCategoryV1.categories.map((c) => c.id) as readonly string[];
const COMMENT_CATEGORY_SET = new Set(COMMENT_CATEGORY_IDS);
export const COMMENT_SEVERITY_LEVELS = ["none", "low", "medium", "high"] as const;

export type CommentSentiment = "positive" | "neutral" | "negative";
export type CommentSeverity = (typeof COMMENT_SEVERITY_LEVELS)[number];

export type CommentBrandSafety = {
  toxic: boolean;
  abusive: boolean;
  controversial: boolean;
  severity: CommentSeverity;
};

export type CommentLabel = {
  sentiment: CommentSentiment;
  category: string;
  brandSafety: CommentBrandSafety;
};

export type CommentInput = {
  readonly text: string;
  readonly author?: string;
  readonly likeCount?: number;
};

export type CommentInsight = {
  sentimentCounts: { positive: number; neutral: number; negative: number };
  sentimentPct: { positive: number; neutral: number; negative: number };
  categories: Array<{ id: string; count: number }>;
  brandSafety: { flaggedCount: number; severeCount: number; flagRatio: number; flagged: boolean };
  themes: string[];
  summary: string;
  sampleQuotes: string[];
  analyzedCount: number;
};

export type CommentInsightMeta = {
  themes?: unknown;
  summary?: unknown;
  sampleQuotes?: unknown;
};

// ── 순수 집계 ─────────────────────────────────────────────────────────────────
function severityRank(s: CommentSeverity): number {
  return COMMENT_SEVERITY_LEVELS.indexOf(s);
}

// 최대 잔여법(largest-remainder)으로 % 합이 정확히 100이 되게 반올림.
function roundedPercents(counts: { positive: number; neutral: number; negative: number }): { positive: number; neutral: number; negative: number } {
  const total = counts.positive + counts.neutral + counts.negative;
  if (total <= 0) return { positive: 0, neutral: 0, negative: 0 };
  const raw = [
    { k: "positive" as const, v: (counts.positive / total) * 100 },
    { k: "neutral" as const, v: (counts.neutral / total) * 100 },
    { k: "negative" as const, v: (counts.negative / total) * 100 },
  ];
  const floors = raw.map((r) => ({ k: r.k, floor: Math.floor(r.v), rem: r.v - Math.floor(r.v) }));
  let used = floors.reduce((s, f) => s + f.floor, 0);
  const out: Record<string, number> = { positive: 0, neutral: 0, negative: 0 };
  for (const f of floors) out[f.k] = f.floor;
  const order = [...floors].sort((a, b) => b.rem - a.rem);
  let i = 0;
  while (used < 100 && order.length > 0) {
    out[order[i % order.length].k] += 1;
    used += 1;
    i += 1;
  }
  return { positive: out.positive, neutral: out.neutral, negative: out.negative };
}

export function normalizeSentiment(value: unknown): CommentSentiment {
  return value === "positive" || value === "negative" ? value : "neutral";
}

export function normalizeCategory(value: unknown): string {
  return typeof value === "string" && COMMENT_CATEGORY_SET.has(value) ? value : "other";
}

export function normalizeBrandSafety(value: unknown): CommentBrandSafety {
  const r = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const severity = COMMENT_SEVERITY_LEVELS.includes(r.severity as CommentSeverity) ? r.severity as CommentSeverity : "none";
  return {
    toxic: r.toxic === true,
    abusive: r.abusive === true,
    controversial: r.controversial === true,
    severity,
  };
}

function isFlagged(bs: CommentBrandSafety): boolean {
  return bs.toxic || bs.abusive || bs.controversial || severityRank(bs.severity) >= severityRank("medium");
}

// perComment 라벨 + LLM 메타(테마/요약/대표인용)로 영상 단위 인사이트 집계. 순수·결정적.
export function aggregateCommentInsights(
  perComment: readonly CommentLabel[],
  meta: CommentInsightMeta = {},
  options: { brandSafetyFlagRatio?: number } = {},
): CommentInsight {
  const flagRatioThreshold = options.brandSafetyFlagRatio ?? DEFAULT_BRAND_SAFETY_FLAG_RATIO;
  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  const categoryCounts = new Map<string, number>();
  let flaggedCount = 0;
  let severeCount = 0;

  for (const label of perComment) {
    sentimentCounts[label.sentiment] += 1;
    categoryCounts.set(label.category, (categoryCounts.get(label.category) ?? 0) + 1);
    if (isFlagged(label.brandSafety)) flaggedCount += 1;
    if (severityRank(label.brandSafety.severity) >= severityRank("high")) severeCount += 1;
  }

  const analyzedCount = perComment.length;
  const flagRatio = analyzedCount > 0 ? Number((flaggedCount / analyzedCount).toFixed(4)) : 0;
  // enum 순서 유지 + count desc 정렬(동률은 enum 정의 순).
  const categories = COMMENT_CATEGORY_IDS
    .map((id) => ({ id, count: categoryCounts.get(id) ?? 0 }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || COMMENT_CATEGORY_IDS.indexOf(a.id) - COMMENT_CATEGORY_IDS.indexOf(b.id));

  return {
    sentimentCounts,
    sentimentPct: roundedPercents(sentimentCounts),
    categories,
    brandSafety: {
      flaggedCount,
      severeCount,
      flagRatio,
      flagged: flagRatio >= flagRatioThreshold || severeCount >= 1,
    },
    themes: normalizeStringArray(meta.themes, THEME_MAX),
    summary: typeof meta.summary === "string" ? meta.summary.slice(0, 600) : "",
    sampleQuotes: normalizeStringArray(meta.sampleQuotes, SAMPLE_QUOTE_MAX),
    analyzedCount,
  };
}

function normalizeStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim().slice(0, 200)).slice(0, max);
}

// ── 정규식 폴백(LLM 미가동/에뮬레이터) ───────────────────────────────────────
// activityRefresh.sentimentLabel과 동일 규범(다국어 미대응). LLM 경로가 정본, 이건 안전망.
export function regexSentiment(text: string): CommentSentiment {
  const t = text.toLowerCase();
  if (/(love|best|good|great|nice|awesome|fun|cool|❤|❤️|😂|👍)/i.test(t)) return "positive";
  if (/(bad|hate|boring|bug|crash|worst|scam|trash)/i.test(t)) return "negative";
  return "neutral";
}

export function regexFallbackLabels(comments: readonly CommentInput[]): CommentLabel[] {
  return comments.map((c) => ({
    sentiment: regexSentiment(c.text),
    category: "other",
    brandSafety: { toxic: false, abusive: false, controversial: false, severity: "none" as CommentSeverity },
  }));
}

// ── LLM 배치 분석(캐시 선행 → callModel → usage 로그) ─────────────────────────
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

type CommentAnalysisResponse = {
  comments?: unknown;
  themes?: unknown;
  summary?: unknown;
  sampleQuotes?: unknown;
};

export type CommentAnalysisCallModel = <T = unknown>(
  modelId: string,
  responseSchema: unknown,
  promptText: string,
) => Promise<VertexResult<T>>;

type CacheMetadata = { modelId: string; provider: string; runId: string };
export type CommentAnalysisCache = {
  get(key: string): Promise<CommentInsight | null>;
  set(key: string, value: CommentInsight, metadata: CacheMetadata): Promise<void>;
};

export type AnalyzeVideoCommentsOptions = {
  cache?: CommentAnalysisCache;
  callModelFn?: CommentAnalysisCallModel;
  modelId?: string;
  runId?: string;
  brandSafetyFlagRatio?: number;
  useLlm?: boolean;
  // LLM 호출 시도 횟수(기본 2). flash-lite 대배치에서 간헐적 JSON 불완전 → 재시도로 폴백률 감소.
  maxAttempts?: number;
};

export type AnalyzeVideoCommentsResult = CommentInsight & {
  modelId: string;
  cacheHit: boolean;
  // true면 LLM(재시도 포함) 실패로 정규식 폴백 사용 — 캐시 미저장·다음 사이클 재분석 대상.
  usedFallback: boolean;
};

type VertexModule = {
  callModel: CommentAnalysisCallModel;
  selectVertexModelForTask: (task: "comment_summary") => string;
};
type AiHubReportModule = {
  reportLlmUsage: (payload: Record<string, unknown>) => void;
  newSessionId: () => string;
};
type FirestoreDocRef = {
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(value: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
};
type FirestoreDb = { collection(name: string): { doc(id: string): FirestoreDocRef } };

declare const require: ((id: string) => unknown) | undefined;
function asRequireModule<T>(moduleName: string): T | null {
  if (typeof require !== "function") return null;
  try {
    return require(moduleName) as T;
  } catch {
    return null;
  }
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

function commentModelId(): string {
  return vertexModule()?.selectVertexModelForTask("comment_summary") ?? COMMENT_ANALYSIS_MODEL_FALLBACK;
}

async function defaultCallModel<T = unknown>(modelId: string, responseSchema: unknown, promptText: string): Promise<VertexResult<T>> {
  const vertex = vertexModule();
  if (!vertex) throw new Error("vertex callModel module is unavailable");
  return vertex.callModel<T>(modelId, responseSchema, promptText);
}

export function commentAnalysisCacheKey(videoId: string, comments: readonly CommentInput[]): string {
  const digest = createHash("sha256")
    .update(comments.map((c) => c.text).join("\u0000"))
    .digest("hex")
    .slice(0, 24);
  return `cca_${createHash("sha256").update(`${videoId}:${COMMENT_ANALYSIS_TAXONOMY_VERSION}:${COMMENT_ANALYSIS_PROMPT_VERSION}:${digest}`).digest("hex").slice(0, 40)}`;
}

function firestoreCache(): CommentAnalysisCache {
  return {
    async get(key) {
      const admin = adminDbModule();
      if (!admin) return null;
      try {
        const snap = await admin.adminDb.collection(COMMENT_ANALYSIS_CACHE_COLLECTION).doc(key).get();
        if (!snap.exists) return null;
        const data = snap.data() ?? {};
        return data.insight && typeof data.insight === "object" ? data.insight as CommentInsight : null;
      } catch {
        return null;
      }
    },
    async set(key, value, metadata) {
      const admin = adminDbModule();
      if (!admin) return;
      try {
        await admin.adminDb.collection(COMMENT_ANALYSIS_CACHE_COLLECTION).doc(key).set({
          insight: value,
          modelId: metadata.modelId,
          provider: metadata.provider,
          runId: metadata.runId,
          promptVersion: COMMENT_ANALYSIS_PROMPT_VERSION,
          taxonomyVersion: COMMENT_ANALYSIS_TAXONOMY_VERSION,
          updatedAtIso: new Date().toISOString(),
          expiresAt: new Date(Date.now() + COMMENT_ANALYSIS_CACHE_TTL_SECONDS * 1000),
        }, { merge: true });
      } catch {
        /* 캐시 저장 실패 비치명적 */
      }
    },
  };
}

function responseSchema() {
  return {
    type: "OBJECT",
    properties: {
      comments: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            sentiment: { type: "STRING", enum: ["positive", "neutral", "negative"] },
            category: { type: "STRING", enum: [...COMMENT_CATEGORY_IDS] },
            toxic: { type: "BOOLEAN" },
            abusive: { type: "BOOLEAN" },
            controversial: { type: "BOOLEAN" },
            severity: { type: "STRING", enum: [...COMMENT_SEVERITY_LEVELS] },
          },
          required: ["sentiment", "category", "toxic", "abusive", "controversial", "severity"],
        },
      },
      themes: { type: "ARRAY", items: { type: "STRING" } },
      summary: { type: "STRING" },
      sampleQuotes: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["comments", "themes", "summary", "sampleQuotes"],
  } as const;
}

export function analysisPrompt(comments: readonly CommentInput[]): string {
  const payload = comments.map((c, i) => ({ i, text: c.text.slice(0, 400) }));
  return [
    "Classify each mobile-game YouTube comment on 3 axes and summarize the batch. Multilingual input (English/Korean/Japanese/Bengali/Hindi/Portuguese/etc.) — judge by meaning, not just keywords.",
    "For EACH comment return: sentiment(positive|neutral|negative), category(one of the provided ids), and brand-safety flags toxic/abusive/controversial(boolean) + severity(none|low|medium|high).",
    `category ids: ${COMMENT_CATEGORY_IDS.join("|")}.`,
    "Also return: themes (up to 6 short recurring topics) and summary (<=600 chars neutral overview) — write BOTH in Korean (한국어) regardless of the comments' languages. sampleQuotes (up to 3 representative comments) MUST stay verbatim in their ORIGINAL language (do NOT translate).",
    "Return JSON only. The comments array MUST be in the same order and length as the input.",
    JSON.stringify(payload),
  ].join("\n");
}

function perCommentFromResponse(json: CommentAnalysisResponse, count: number): CommentLabel[] {
  const arr = Array.isArray(json.comments) ? json.comments : [];
  const out: CommentLabel[] = [];
  for (let i = 0; i < count; i += 1) {
    const r = arr[i] && typeof arr[i] === "object" ? arr[i] as Record<string, unknown> : {};
    out.push({
      sentiment: normalizeSentiment(r.sentiment),
      category: normalizeCategory(r.category),
      brandSafety: normalizeBrandSafety(r),
    });
  }
  return out;
}

async function logUsage(runId: string, videoId: string, result: VertexResult<CommentAnalysisResponse>, itemCount: number, latencyMs: number): Promise<void> {
  const usage = {
    event: "video_comment_analysis_llm_usage",
    runId,
    videoId,
    modelId: result.modelId,
    provider: result.provider,
    transport: result.transport ?? "unverified",
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    itemCount,
    latencyMs,
  };
  console.info("[video-comment-analysis]", usage);
  const aiHub = aiHubReportModule();
  if (!aiHub) return;
  await aiHub.reportLlmUsage({
    sessionId: aiHub.newSessionId(),
    toolId: "video.comment_analysis",
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

// 영상 1건 댓글 배치 분석. 캐시 선행 → callModel chokepoint → 집계 → 캐시 저장 + usage 로그.
export async function analyzeVideoComments(
  videoId: string,
  comments: readonly CommentInput[],
  options: AnalyzeVideoCommentsOptions = {},
): Promise<AnalyzeVideoCommentsResult> {
  const slice = comments.slice(0, MAX_ANALYZED_COMMENTS);
  const modelId = options.modelId ?? commentModelId();
  const runId = options.runId ?? "video-comment-analysis";

  if (slice.length === 0) {
    const empty = aggregateCommentInsights([], {}, { brandSafetyFlagRatio: options.brandSafetyFlagRatio });
    return { ...empty, modelId, cacheHit: false, usedFallback: false };
  }

  const cache = options.cache ?? firestoreCache();
  const key = commentAnalysisCacheKey(videoId, slice);
  const cached = await cache.get(key);
  if (cached) return { ...cached, modelId, cacheHit: true, usedFallback: false };

  // LLM 미사용(에뮬레이터/플래그 off) → 정규식 폴백 집계.
  if (options.useLlm === false) {
    const insight = aggregateCommentInsights(regexFallbackLabels(slice), {}, { brandSafetyFlagRatio: options.brandSafetyFlagRatio });
    return { ...insight, modelId, cacheHit: false, usedFallback: true };
  }

  const callModelFn = options.callModelFn ?? defaultCallModel;
  const startedAt = Date.now();
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  let result: VertexResult<CommentAnalysisResponse> | null = null;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      result = await callModelFn<CommentAnalysisResponse>(modelId, responseSchema(), analysisPrompt(slice));
      break;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        console.warn("[video-comment-analysis] LLM attempt failed; retrying", { runId, videoId, attempt, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  if (!result) {
    // LLM 실패(재시도 소진) 시 정규식 폴백(수집·저장은 계속). 캐시엔 저장하지 않음(다음 사이클 재시도).
    console.warn("[video-comment-analysis] LLM failed; regex fallback", { runId, videoId, error: lastError instanceof Error ? lastError.message : String(lastError) });
    const insight = aggregateCommentInsights(regexFallbackLabels(slice), {}, { brandSafetyFlagRatio: options.brandSafetyFlagRatio });
    return { ...insight, modelId, cacheHit: false, usedFallback: true };
  }

  const perComment = perCommentFromResponse(result.json, slice.length);
  const insight = aggregateCommentInsights(perComment, {
    themes: result.json.themes,
    summary: result.json.summary,
    sampleQuotes: result.json.sampleQuotes,
  }, { brandSafetyFlagRatio: options.brandSafetyFlagRatio });

  await cache.set(key, insight, { modelId: result.modelId, provider: result.provider, runId });
  await logUsage(runId, videoId, result, slice.length, Date.now() - startedAt);
  return { ...insight, modelId: result.modelId, cacheHit: false, usedFallback: false };
}
