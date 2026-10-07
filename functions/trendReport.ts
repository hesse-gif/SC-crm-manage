// 주간 트렌드 리포트 v1 — main/functions/videoClassifier.ts/communitySearch.ts LLM 호출 규범 그대로 답습.
//   순수 집계(buildWeeklyTrendSnapshot) → 헤드라인 callModel chokepoint(SEC-P0-005) → usage 로그(COST-P0-006·007)
//   → 골든셋 정성 일치율 게이트(≥85%면 published, 미만이면 gate_blocked) → trend_reports/{weekKey} merge(멱등).
// 활성 enum만 집계에 포함한다(videoTaxonomy.activeEnumIds — governance: docs/VIDEO-TAXONOMY.md).
// 헤드라인 프롬프트 원문은 usage 로그에 싣지 않는다(SEC-P0-009).

import { activeEnumIds, type TaxonomyAxis } from "./videoTaxonomy";

export const TREND_SAMPLE_SCOPE = "자사 15 + 유사 8 키워드 생태계 한정";
export const GOLDEN_SET_AGREEMENT_PUBLISH_THRESHOLD = 0.85;
const TREND_HEADLINE_MODEL_FALLBACK = "gemini-2.5-flash";
const AXES: readonly TaxonomyAxis[] = ["format", "genreStyle", "contentNature"];
const TOP_N = 10;
const LOW_COVERAGE_QUALITY_WARNING_PCT = 50;
const WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// P5 추가: 관찰 프록시(editDensity/estimatedSessionMinutes) 실값 전환 게이트 — 프록시 골든셋 정성
// 일치율이 이 임계치(%) 이상을 통과하기 전까지는 observedProxyMetrics를 만들지 않고 '수집 중' 상태
// (undefined)를 유지한다. proxyFieldsPending:true 자체는 기존 계약대로 항상 유지(무수정).
export const PROXY_GOLDEN_SET_PASS_RATE_GATE_PCT = 70;

export type WeeklyVideoClassification = {
  readonly format: string;
  readonly genreStyle: string;
  readonly contentNature: string;
};

// timestampIso: 영상이 주간 버킷에 편입되는 기준 시각(수집/게시 시각 등, 호출자가 결정) — 컷오프는
// weekKey가 나타내는 KST 자정(해당 요일 00:00 KST) 직전 7일 창([cutoff-7d, cutoff)).
export type WeeklyVideoRecord = {
  readonly id: string;
  readonly timestampIso: string;
  readonly classification?: WeeklyVideoClassification;
  readonly classificationPending?: boolean;
  readonly classificationSource?: string; // P5 추가: 'video_v2'면 2차(멀티모달) 재분류
  readonly analysis?: { readonly editDensity: number; readonly estimatedSessionMinutes: number }; // P5 추가: 관찰 프록시 실값 원천
};

export type AxisDeltaEntry = {
  readonly id: string;
  readonly count: number;
  readonly prevCount: number;
  readonly delta: number;
};

export type CrossCellMover = {
  readonly format: string;
  readonly genreStyle: string;
  readonly contentNature: string;
  readonly count: number;
  readonly delta: number;
};

export type WeeklyTrendSnapshot = {
  readonly weekKey: string;
  readonly axisTopDeltas: Record<TaxonomyAxis, AxisDeltaEntry[]>;
  readonly crossCellMovers: CrossCellMover[];
  readonly sampleScope: string;
  readonly analysisCoveragePct: number;
  readonly carriedOver: string[];
  readonly proxyFieldsPending: true;
  readonly tierTwoReclassificationRatePct: number;
  readonly observedProxyMetrics?: ObservedProxyMetrics;
  readonly qualityWarning?: boolean;
};

export type ObservedProxyMetrics = {
  readonly avgEditDensity: number;
  readonly avgEstimatedSessionMinutes: number;
  readonly sampleSize: number;
};

export type BuildWeeklyTrendSnapshotOptions = {
  readonly videos: readonly WeeklyVideoRecord[];
  readonly prevSnapshot?: WeeklyTrendSnapshot | null;
  readonly proxyGoldenSetPassRatePct?: number;
};

// weekKey(예: "2026-06-29")는 컷오프 시각(해당 날짜 00:00 KST, 배타적 상한)을 나타낸다.
// 실제 집계 창은 [컷오프-7일, 컷오프) — onSchedule('0 0 * * 1', Asia/Seoul)이 매주 월요일 00:00 KST에
// 그 주(직전 일요일 24:00 KST까지)를 컷오프로 스냅샷을 만든다.
export function weekWindowForKey(weekKey: string): { startIso: string; endIsoExclusive: string } {
  const cutoffMs = Date.parse(`${weekKey}T00:00:00+09:00`);
  if (!Number.isFinite(cutoffMs)) {
    throw new Error(`invalid weekKey (expected YYYY-MM-DD KST cutoff date): ${weekKey}`);
  }
  return {
    startIso: new Date(cutoffMs - WEEK_WINDOW_MS).toISOString(),
    endIsoExclusive: new Date(cutoffMs).toISOString(),
  };
}

function selectWeekVideos(weekKey: string, videos: readonly WeeklyVideoRecord[]): WeeklyVideoRecord[] {
  const { startIso, endIsoExclusive } = weekWindowForKey(weekKey);
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIsoExclusive);
  return videos.filter((video) => {
    const ts = Date.parse(video.timestampIso);
    return Number.isFinite(ts) && ts >= startMs && ts < endMs;
  });
}

function isAnalyzed(video: WeeklyVideoRecord): video is WeeklyVideoRecord & { classification: WeeklyVideoClassification } {
  return !!video.classification && video.classificationPending !== true;
}

function sortDeltaEntries<T extends { count: number; delta: number }>(entries: T[], keyOf: (entry: T) => string): T[] {
  return entries
    .slice()
    .sort((a, b) => b.count - a.count || b.delta - a.delta || keyOf(a).localeCompare(keyOf(b)))
    .slice(0, TOP_N);
}

function buildAxisTopDeltas(
  analyzed: readonly (WeeklyVideoRecord & { classification: WeeklyVideoClassification })[],
  prevSnapshot: WeeklyTrendSnapshot | null | undefined,
): Record<TaxonomyAxis, AxisDeltaEntry[]> {
  const result = {} as Record<TaxonomyAxis, AxisDeltaEntry[]>;
  for (const axis of AXES) {
    const active = new Set(activeEnumIds(axis));
    const counts = new Map<string, number>();
    for (const id of active) counts.set(id, 0);
    for (const video of analyzed) {
      const id = video.classification[axis];
      if (!active.has(id)) continue; // 비활성 enum 제외(governance)
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const prevCounts = new Map((prevSnapshot?.axisTopDeltas?.[axis] ?? []).map((entry) => [entry.id, entry.count]));
    const entries: AxisDeltaEntry[] = [...counts.entries()].map(([id, count]) => {
      const prevCount = prevCounts.get(id) ?? 0;
      return { id, count, prevCount, delta: count - prevCount };
    });
    result[axis] = sortDeltaEntries(entries, (entry) => entry.id);
  }
  return result;
}

function crossCellKey(format: string, genreStyle: string, contentNature: string): string {
  return `${format}|${genreStyle}|${contentNature}`;
}

function buildCrossCellMovers(
  analyzed: readonly (WeeklyVideoRecord & { classification: WeeklyVideoClassification })[],
  prevSnapshot: WeeklyTrendSnapshot | null | undefined,
): CrossCellMover[] {
  const activeByAxis = new Map(AXES.map((axis) => [axis, new Set(activeEnumIds(axis))]));
  const counts = new Map<string, { format: string; genreStyle: string; contentNature: string; count: number }>();
  for (const video of analyzed) {
    const { format, genreStyle, contentNature } = video.classification;
    if (
      !activeByAxis.get("format")!.has(format)
      || !activeByAxis.get("genreStyle")!.has(genreStyle)
      || !activeByAxis.get("contentNature")!.has(contentNature)
    ) continue; // 비활성 enum 제외
    const key = crossCellKey(format, genreStyle, contentNature);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { format, genreStyle, contentNature, count: 1 });
  }
  const prevCounts = new Map(
    (prevSnapshot?.crossCellMovers ?? []).map((mover) => [crossCellKey(mover.format, mover.genreStyle, mover.contentNature), mover.count]),
  );
  const entries: CrossCellMover[] = [...counts.entries()].map(([key, value]) => {
    const prevCount = prevCounts.get(key) ?? 0;
    return { ...value, delta: value.count - prevCount };
  });
  return sortDeltaEntries(entries, (entry) => crossCellKey(entry.format, entry.genreStyle, entry.contentNature));
}

// 순수 집계 — Firestore/네트워크 의존 없음(테스트 가능한 leaf). 골든셋 게이트/헤드라인은 publishWeeklyTrendReport가 담당.
export function buildWeeklyTrendSnapshot(weekKey: string, options: BuildWeeklyTrendSnapshotOptions): WeeklyTrendSnapshot {
  const selected = selectWeekVideos(weekKey, options.videos);
  const analyzed = selected.filter(isAnalyzed);
  const carriedOver = selected.filter((video) => !isAnalyzed(video)).map((video) => video.id);
  const analysisCoveragePct = selected.length > 0 ? Number(((analyzed.length / selected.length) * 100).toFixed(1)) : 0;
  const qualityWarning = selected.length > 0 && analysisCoveragePct < LOW_COVERAGE_QUALITY_WARNING_PCT ? true : undefined;

  // 2차 재분류율 각주: analyzed 중 classificationSource==='video_v2'(P5 멀티모달 재분류) 비율.
  const reclassifiedCount = analyzed.filter((video) => video.classificationSource === "video_v2").length;
  const tierTwoReclassificationRatePct = analyzed.length > 0 ? Number(((reclassifiedCount / analyzed.length) * 100).toFixed(1)) : 0;

  // 관찰 프록시 실값 전환 훅: analysis 데이터가 있는 영상만 집계하고, 프록시 골든셋 통과율이
  // PROXY_GOLDEN_SET_PASS_RATE_GATE_PCT(70%) 이상일 때만 실값을 채운다. 미만이면 undefined('수집 중').
  const goldenSetGatePassed = (options.proxyGoldenSetPassRatePct ?? 0) >= PROXY_GOLDEN_SET_PASS_RATE_GATE_PCT;
  const withAnalysis = analyzed.filter((video) => video.analysis);
  const observedProxyMetrics: ObservedProxyMetrics | undefined = goldenSetGatePassed && withAnalysis.length > 0
    ? {
      avgEditDensity: Number((withAnalysis.reduce((sum, video) => sum + (video.analysis?.editDensity ?? 0), 0) / withAnalysis.length).toFixed(2)),
      avgEstimatedSessionMinutes: Number((withAnalysis.reduce((sum, video) => sum + (video.analysis?.estimatedSessionMinutes ?? 0), 0) / withAnalysis.length).toFixed(2)),
      sampleSize: withAnalysis.length,
    }
    : undefined;

  const snapshot: WeeklyTrendSnapshot = {
    weekKey,
    axisTopDeltas: buildAxisTopDeltas(analyzed, options.prevSnapshot),
    crossCellMovers: buildCrossCellMovers(analyzed, options.prevSnapshot),
    sampleScope: TREND_SAMPLE_SCOPE,
    analysisCoveragePct,
    carriedOver,
    proxyFieldsPending: true,
    tierTwoReclassificationRatePct,
    ...(observedProxyMetrics ? { observedProxyMetrics } : {}),
    ...(qualityWarning ? { qualityWarning } : {}),
  };
  return snapshot;
}

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

type TrendHeadlineCallModel = <T = unknown>(
  modelId: string,
  responseSchema: unknown,
  promptText: string,
) => Promise<VertexResult<T>>;

type TrendHeadlineCacheMetadata = { modelId: string; provider: string; runId: string };

type TrendHeadlineCache = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, metadata: TrendHeadlineCacheMetadata): Promise<void>;
};

type VertexModule = {
  callModel: TrendHeadlineCallModel;
  selectVertexModelForTask: (task: string) => string;
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

type FirestoreDb = {
  collection(name: string): { doc(id: string): FirestoreDocRef };
};

export type PublishWeeklyTrendReportOptions = {
  readonly snapshot: WeeklyTrendSnapshot;
  readonly goldenSetAgreement: number; // 0..1 — computeGoldenSetAgreement() 결과
  readonly db?: FirestoreDb;
  readonly cache?: TrendHeadlineCache;
  readonly callModelFn?: TrendHeadlineCallModel;
  readonly modelId?: string;
  readonly runId?: string;
  readonly nowIso?: string;
};

export type TrendReportDoc = {
  readonly weekKey: string;
  readonly generatedAtIso: string;
  readonly visibility: "published" | "gate_blocked";
  readonly axisTopDeltas: Record<TaxonomyAxis, AxisDeltaEntry[]>;
  readonly crossCellMovers: CrossCellMover[];
  readonly headline300: string;
  readonly sampleScope: string;
  readonly analysisCoveragePct: number;
  readonly carriedOver: string[];
  readonly qualityWarning?: boolean;
  readonly proxyFieldsPending: true;
  readonly tierTwoReclassificationRatePct: number;
  readonly observedProxyMetrics?: ObservedProxyMetrics;
};

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

function trendHeadlineModelId(): string {
  return vertexModule()?.selectVertexModelForTask("trend_report_headline") ?? TREND_HEADLINE_MODEL_FALLBACK;
}

async function defaultTrendHeadlineCallModel<T = unknown>(
  modelId: string,
  responseSchema: unknown,
  promptText: string,
): Promise<VertexResult<T>> {
  const vertex = vertexModule();
  if (!vertex) throw new Error("vertex callModel module is unavailable");
  return vertex.callModel<T>(modelId, responseSchema, promptText);
}

function firestoreDb(options: { db?: FirestoreDb }): FirestoreDb {
  if (options.db) return options.db;
  const module = adminDbModule();
  if (!module) throw new Error("Firestore is unavailable for trend report publishing");
  return module.adminDb;
}

function headlineResponseSchema() {
  return {
    type: "object",
    properties: { headline: { type: "string" } },
    required: ["headline"],
  } as const;
}

function headlinePrompt(snapshot: WeeklyTrendSnapshot): string {
  const payload = {
    weekKey: snapshot.weekKey,
    topFormat: snapshot.axisTopDeltas.format.slice(0, 3),
    topGenreStyle: snapshot.axisTopDeltas.genreStyle.slice(0, 3),
    topContentNature: snapshot.axisTopDeltas.contentNature.slice(0, 3),
    crossCellMovers: snapshot.crossCellMovers.slice(0, 3),
    analysisCoveragePct: snapshot.analysisCoveragePct,
  };
  return [
    "Write one Korean headline (max 300 characters) summarizing this week's mobile-game YouTube content trend movements.",
    "Base it only on the provided top axis deltas and cross-cell movers. Return JSON only with a single field: headline.",
    JSON.stringify(payload),
  ].join("\n");
}

type HeadlineResponse = { headline?: unknown };

function normalizeHeadline(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.slice(0, 300);
}

function headlineCacheKey(weekKey: string): string {
  return `trend-headline:${weekKey}`;
}

async function logTrendHeadlineUsage(
  runId: string,
  weekKey: string,
  result: VertexResult<HeadlineResponse>,
  cacheHit: boolean,
  latencyMs: number,
): Promise<void> {
  const usage = {
    event: "trend_report_headline_llm_usage",
    runId,
    weekKey,
    modelId: result.modelId,
    provider: result.provider,
    transport: cacheHit ? "cache" : result.transport ?? "unverified",
    inputTokens: cacheHit ? 0 : result.inputTokens,
    outputTokens: cacheHit ? 0 : result.outputTokens,
    estimatedCostUsd: cacheHit ? 0 : result.estimatedCostUsd,
    cacheHit,
    latencyMs,
  };
  console.info("[trend-report]", usage);
  const aiHub = aiHubReportModule();
  if (!aiHub) return;
  await aiHub.reportLlmUsage({
    sessionId: aiHub.newSessionId(),
    toolId: "trend_report.headline",
    modelId: result.modelId,
    provider: result.provider,
    transport: cacheHit ? "cache" : result.transport ?? "unverified",
    inputTokens: cacheHit ? 0 : result.inputTokens,
    outputTokens: cacheHit ? 0 : result.outputTokens,
    totalCostUsd: cacheHit ? 0 : result.estimatedCostUsd,
    latencyMs,
    actionId: runId,
  });
}

async function resolveHeadline(options: PublishWeeklyTrendReportOptions, runId: string): Promise<string> {
  const key = headlineCacheKey(options.snapshot.weekKey);
  const startedAt = Date.now();
  if (options.cache) {
    const cached = await options.cache.get(key);
    if (cached) {
      await logTrendHeadlineUsage(
        runId,
        options.snapshot.weekKey,
        { json: { headline: cached }, text: cached, modelId: options.modelId ?? trendHeadlineModelId(), provider: "unverified", transport: "cache", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        true,
        Date.now() - startedAt,
      );
      return cached;
    }
  }

  const modelId = options.modelId ?? trendHeadlineModelId();
  const callModelFn = options.callModelFn ?? defaultTrendHeadlineCallModel;
  const result = await callModelFn<HeadlineResponse>(modelId, headlineResponseSchema(), headlinePrompt(options.snapshot));
  const headline = normalizeHeadline(result.json.headline) || "이번 주 트렌드 요약을 생성하지 못했습니다.";
  if (options.cache) {
    await options.cache.set(key, headline, { modelId: result.modelId, provider: result.provider, runId });
  }
  await logTrendHeadlineUsage(runId, options.snapshot.weekKey, result, false, Date.now() - startedAt);
  return headline;
}

// 헤드라인(callModel chokepoint, 캐시+usage 로그) 생성 후 골든셋 정성 일치율 게이트를 적용해
// trend_reports/{weekKey}에 merge(멱등) 기록한다. index.ts의 두 번째 onSchedule('0 9 * * 1', Asia/Seoul)이 호출.
export async function publishWeeklyTrendReport(weekKey: string, options: PublishWeeklyTrendReportOptions): Promise<TrendReportDoc> {
  if (weekKey !== options.snapshot.weekKey) {
    throw new Error(`weekKey mismatch: publish(${weekKey}) vs snapshot(${options.snapshot.weekKey})`);
  }
  const runId = options.runId ?? `trend-report-${weekKey}`;
  const nowIso = options.nowIso ?? new Date().toISOString();
  const visibility: TrendReportDoc["visibility"] = options.goldenSetAgreement >= GOLDEN_SET_AGREEMENT_PUBLISH_THRESHOLD
    ? "published"
    : "gate_blocked";
  const headline300 = await resolveHeadline(options, runId);

  const doc: TrendReportDoc = {
    weekKey,
    generatedAtIso: nowIso,
    visibility,
    axisTopDeltas: options.snapshot.axisTopDeltas,
    crossCellMovers: options.snapshot.crossCellMovers,
    headline300,
    sampleScope: options.snapshot.sampleScope,
    analysisCoveragePct: options.snapshot.analysisCoveragePct,
    carriedOver: options.snapshot.carriedOver,
    proxyFieldsPending: true,
    tierTwoReclassificationRatePct: options.snapshot.tierTwoReclassificationRatePct,
    ...(options.snapshot.observedProxyMetrics ? { observedProxyMetrics: options.snapshot.observedProxyMetrics } : {}),
    ...(options.snapshot.qualityWarning ? { qualityWarning: true as const } : {}),
  };

  const db = firestoreDb(options);
  await db.collection("trend_reports").doc(weekKey).set(doc, { merge: true });
  return doc;
}
