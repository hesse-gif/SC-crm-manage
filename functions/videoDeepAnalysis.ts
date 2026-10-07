// P5 영상 2차 멀티모달(Gemini) 분석 — 선별(selectForWeek)·분석(analyzeVideo)·병합(buildVideoAnalysisMerge)·
//   감사 샘플링(sampleTierOneRejects/buildAuditSample)·예산 역산(buildBudgetReport)의 순수/DI 로직.
//   Firestore I/O는 runWeeklyDeepAnalysisBatch(오케스트레이션)에만 있고, 나머지는 테스트 가능한 leaf다.
// SEC-P0-005 B2 예외: 멀티모달 전송은 videoLlm.runVideoLlm(callFn 기본값 vertex.callVideoModel) 경유.
// 프롬프트 원문은 usage 로그/캐시 메타데이터에 싣지 않는다(SEC-P0-009).

import { createHash } from "node:crypto";
import { runVideoLlm, type VideoLlmCache, type VideoLlmCallFn } from "./videoLlm";
import type { TierTwoEligibility } from "./videoTranscript";

export const DEFAULT_PER_GAME_SELECTION = 20;
export const DEFAULT_PROMOTED_RESERVE = 4;
export const VIDEO_DEEP_ANALYSIS_PROMPT_VERSION = 1;
export const VIDEO_DEEP_ANALYSIS_TAXONOMY_VERSION = 1;
export const VIDEO_ANALYSIS_CLASSIFICATION_SOURCE = "video_v2" as const;
export const VIDEO_ANALYSIS_RUNS_TTL_SECONDS = 180 * 24 * 60 * 60; // 6개월
export const AUDIT_MISS_RATE_WARNING_THRESHOLD_PCT = 10;
const DEEP_ANALYSIS_MODEL_FALLBACK = "gemini-2.5-flash";
const DEEP_ANALYSIS_LOW_COST_MODEL_FALLBACK = "gemini-2.5-flash-lite";

// ── 1) 선별(selectForWeek) ──────────────────────────────────────────────────────────
export type VideoAvailability = "public" | "unlisted" | "private";

export type SelectionCandidate = {
  readonly videoId: string;
  readonly gameId: string;
  readonly confidence: number;
  readonly tierTwoEligibility: TierTwoEligibility;
  readonly availability?: VideoAvailability;
};

export type TierOneReject = {
  readonly videoId: string;
  readonly gameId: string;
  readonly reason: "below_top_n" | "promoted_reserve_overflow" | "excluded_availability";
};

export type SelectForWeekOptions = {
  readonly perGame?: number;
  readonly promotedReserve?: number;
};

export type SelectForWeekResult = {
  readonly selected: readonly SelectionCandidate[];
  readonly carriedOver: readonly SelectionCandidate[];
  readonly excludedPrivate: readonly SelectionCandidate[];
  readonly rejects: readonly TierOneReject[];
};

const PRIVATE_AVAILABILITY = new Set<VideoAvailability>(["private", "unlisted"]);

function byConfidenceDesc(a: SelectionCandidate, b: SelectionCandidate): number {
  return b.confidence - a.confidence || a.videoId.localeCompare(b.videoId);
}

function groupByGame(candidates: readonly SelectionCandidate[]): Map<string, SelectionCandidate[]> {
  const groups = new Map<string, SelectionCandidate[]>();
  for (const candidate of candidates) {
    const bucket = groups.get(candidate.gameId);
    if (bucket) bucket.push(candidate);
    else groups.set(candidate.gameId, [candidate]);
  }
  return groups;
}

// 게임별: confidence 상위 (perGame - promotedReserve, 기본 16) + tierTwoEligibility==='promoted_no_transcript'
// 예약 promotedReserve(기본 4, 상위16에 이미 포함된 promoted는 예약분에서 제외 — 중복 차감 방지).
// 예약 슬롯을 초과하는 promoted 후보는 confidence 순으로 이월(carriedOver)한다. availability가
// 'private'|'unlisted'인 후보는 선별 대상에서 완전히 제외한다(ADC 서비스 계정은 비공개/한정공개 접근 불가).
// 처리는 직렬(1건=1요청) — 이 함수는 순서만 정하고, 실제 호출은 runWeeklyDeepAnalysisBatch가 순차 수행한다.
export function selectForWeek(
  candidates: readonly SelectionCandidate[],
  options: SelectForWeekOptions = {},
): SelectForWeekResult {
  const perGame = options.perGame ?? DEFAULT_PER_GAME_SELECTION;
  const promotedReserve = options.promotedReserve ?? DEFAULT_PROMOTED_RESERVE;
  const generalSlots = Math.max(0, perGame - promotedReserve);

  const excludedPrivate: SelectionCandidate[] = [];
  const rejects: TierOneReject[] = [];
  const eligible: SelectionCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.availability && PRIVATE_AVAILABILITY.has(candidate.availability)) {
      excludedPrivate.push(candidate);
      rejects.push({ videoId: candidate.videoId, gameId: candidate.gameId, reason: "excluded_availability" });
      continue;
    }
    eligible.push(candidate);
  }

  const selected: SelectionCandidate[] = [];
  const carriedOver: SelectionCandidate[] = [];

  for (const [, gameCandidates] of groupByGame(eligible)) {
    const ranked = [...gameCandidates].sort(byConfidenceDesc);
    const topPool = ranked.slice(0, generalSlots);
    const topIds = new Set(topPool.map((v) => v.videoId));

    const promotedRemaining = ranked.filter((v) => v.tierTwoEligibility === "promoted_no_transcript" && !topIds.has(v.videoId));
    const reserved = promotedRemaining.slice(0, promotedReserve);
    const reservedIds = new Set(reserved.map((v) => v.videoId));
    const overflowPromoted = promotedRemaining.slice(promotedReserve);

    selected.push(...topPool, ...reserved);
    carriedOver.push(...overflowPromoted);
    for (const v of overflowPromoted) {
      rejects.push({ videoId: v.videoId, gameId: v.gameId, reason: "promoted_reserve_overflow" });
    }

    for (const v of ranked) {
      if (topIds.has(v.videoId) || reservedIds.has(v.videoId)) continue;
      if (v.tierTwoEligibility === "promoted_no_transcript") continue; // already counted as overflow above
      rejects.push({ videoId: v.videoId, gameId: v.gameId, reason: "below_top_n" });
      carriedOver.push(v);
    }
  }

  return { selected, carriedOver, excludedPrivate, rejects };
}

// ── 2) 분석(analyzeVideo) — YouTube fileUri 멀티모달 호출 ───────────────────────────
export type DeepAnalysisVideoInput = {
  readonly videoId: string;
  readonly youtubeUrl: string; // 공개 YouTube watch URL 1개 — SEC-P0-005 B2 예외 전제
  readonly title: string;
};

export type DeepAnalysisResult = {
  readonly stageTransitions: readonly string[];
  readonly sessionComposition: Readonly<Record<string, number>>;
  readonly editDensity: number;
  readonly coreLoopObservations: readonly string[];
  readonly estimatedSessionMinutes: number;
  readonly sessionConfidence: number;
};

type VertexModule = {
  selectVertexModelForTask: (task: string) => string;
  DEFAULT_VERTEX_LOW_COST_MODEL: string;
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

function deepAnalysisModelId(lowCost: boolean): string {
  const vertex = vertexModule();
  if (lowCost) return vertex?.DEFAULT_VERTEX_LOW_COST_MODEL ?? DEEP_ANALYSIS_LOW_COST_MODEL_FALLBACK;
  return vertex?.selectVertexModelForTask("video_analysis") ?? DEEP_ANALYSIS_MODEL_FALLBACK;
}

function deepAnalysisResponseSchema() {
  return {
    type: "object",
    properties: {
      stageTransitions: { type: "array", items: { type: "string" } },
      sessionComposition: { type: "object" },
      editDensity: { type: "number" },
      coreLoopObservations: { type: "array", items: { type: "string" } },
      estimatedSessionMinutes: { type: "number" },
      sessionConfidence: { type: "number" },
    },
    required: ["stageTransitions", "sessionComposition", "editDensity", "coreLoopObservations", "estimatedSessionMinutes", "sessionConfidence"],
  } as const;
}

function deepAnalysisParts(video: DeepAnalysisVideoInput): Array<{ text: string } | { fileData: { fileUri: string; mimeType: string } }> {
  const instructions = [
    "Analyze this mobile game YouTube gameplay video for session structure and editing pace.",
    "Return JSON only with: stageTransitions (ordered list of observed gameplay stage/phase labels), sessionComposition",
    "(object mapping activity-type labels to a percentage of the video, values should sum to roughly 100), editDensity",
    "(average cuts per minute), coreLoopObservations (short factual observations about the core gameplay loop),",
    "estimatedSessionMinutes (estimated real played session length in minutes), sessionConfidence (0 to 1).",
    `Video title: ${video.title.slice(0, 280)}`,
  ].join(" ");
  return [
    { text: instructions },
    { fileData: { fileUri: video.youtubeUrl, mimeType: "video/mp4" } },
  ];
}

function normalizeStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, max);
}

function normalizeComposition(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const num = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    out[key] = Math.max(0, Math.min(100, Number(num.toFixed(1))));
  }
  return out;
}

function normalizeUnitInterval(value: unknown): number {
  const num = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, Number(num.toFixed(3))));
}

function normalizeNonNegativeNumber(value: unknown): number {
  const num = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Number(num.toFixed(2)));
}

export function normalizeDeepAnalysisResponse(json: unknown): DeepAnalysisResult {
  const record = json && typeof json === "object" ? json as Record<string, unknown> : {};
  return {
    stageTransitions: normalizeStringArray(record.stageTransitions, 40),
    sessionComposition: normalizeComposition(record.sessionComposition),
    editDensity: normalizeNonNegativeNumber(record.editDensity),
    coreLoopObservations: normalizeStringArray(record.coreLoopObservations, 20),
    estimatedSessionMinutes: normalizeNonNegativeNumber(record.estimatedSessionMinutes),
    sessionConfidence: normalizeUnitInterval(record.sessionConfidence),
  };
}

export function deepAnalysisCacheKey(videoId: string): string {
  return `${videoId}:${VIDEO_DEEP_ANALYSIS_TAXONOMY_VERSION}:${VIDEO_DEEP_ANALYSIS_PROMPT_VERSION}`;
}

export type AnalyzeVideoOptions = {
  readonly cache?: VideoLlmCache<DeepAnalysisResult>;
  readonly callFn?: VideoLlmCallFn;
  readonly runId?: string;
  readonly modelId?: string;
  readonly lowCost?: boolean;
};

export type AnalyzeVideoResult = DeepAnalysisResult & {
  readonly modelId: string;
  readonly cacheHit: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
};

// 캐시 선행 + callFn(기본 vertex.callVideoModel) 경유 + usage 로그는 videoLlm.runVideoLlm이 담당(COST-P0).
// 1건=1요청(직렬) — 배치 소비는 runWeeklyDeepAnalysisBatch가 for-of로 순차 호출한다.
export async function analyzeVideo(video: DeepAnalysisVideoInput, options: AnalyzeVideoOptions = {}): Promise<AnalyzeVideoResult> {
  const modelId = options.modelId ?? deepAnalysisModelId(options.lowCost === true);
  const result = await runVideoLlm<DeepAnalysisResult>("video_deep_analysis", {
    cacheKey: deepAnalysisCacheKey(video.videoId),
    cache: options.cache,
    modelId,
    responseSchema: deepAnalysisResponseSchema(),
    parts: deepAnalysisParts(video),
    callFn: options.callFn,
    runId: options.runId,
    actionId: video.videoId,
    normalize: normalizeDeepAnalysisResponse,
  });
  return {
    ...result.value,
    modelId: result.modelId,
    cacheHit: result.cacheHit,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd: result.estimatedCostUsd,
  };
}

// ── 3) 병합(buildVideoAnalysisMerge) — youtube_videos.analysis + 3축 재분류 ─────────
export type ReclassificationAxes = {
  readonly format: string;
  readonly genreStyle: string;
  readonly contentNature: string;
};

export type VideoAnalysisMergeInput = {
  readonly videoId: string;
  readonly runId: string;
  readonly model: string;
  readonly analysis: DeepAnalysisResult;
  readonly nowIso: string;
  readonly promptVersion?: number;
  readonly taxonomyVersion?: number;
  readonly reclassification?: ReclassificationAxes | null;
  readonly tierOneClassification?: Record<string, unknown> | null;
};

export type VideoAnalysisMergeResult = {
  readonly videoDocPatch: Record<string, unknown>;
  readonly runDoc: Record<string, unknown>;
  readonly runDocId: string;
};

// youtube_videos.analysis는 최신 1건(latest-wins, append 아님)만 보관 — 이력은 video_analysis_runs(append-only)가
// 담당한다. reclassification이 주어지면(3축 재분류) classificationSource:'video_v2'로 덮어쓰되
// tierOneClassification 원값을 보존한다(감사 추적용, governance).
export function buildVideoAnalysisMerge(input: VideoAnalysisMergeInput): VideoAnalysisMergeResult {
  const promptVersion = input.promptVersion ?? VIDEO_DEEP_ANALYSIS_PROMPT_VERSION;
  const taxonomyVersion = input.taxonomyVersion ?? VIDEO_DEEP_ANALYSIS_TAXONOMY_VERSION;
  const analysisRecord = {
    ...input.analysis,
    runId: input.runId,
    model: input.model,
    promptVersion,
    taxonomyVersion,
    analyzedAtIso: input.nowIso,
  };

  const videoDocPatch: Record<string, unknown> = {
    analysis: analysisRecord,
    updatedAtIso: input.nowIso,
  };

  if (input.reclassification) {
    videoDocPatch.classification = {
      format: input.reclassification.format,
      genreStyle: input.reclassification.genreStyle,
      contentNature: input.reclassification.contentNature,
      confidence: input.analysis.sessionConfidence,
      classificationSource: VIDEO_ANALYSIS_CLASSIFICATION_SOURCE,
      model: input.model,
      promptVersion,
      taxonomyVersion,
      runId: input.runId,
      classifiedAtIso: input.nowIso,
      ...(input.tierOneClassification ? { tierOneClassification: input.tierOneClassification } : {}),
    };
  }

  const runDocId = `${input.runId}__${input.videoId}`;
  const outputSha = createHash("sha256").update(JSON.stringify(analysisRecord)).digest("hex");
  const runDoc = {
    runId: input.runId,
    videoId: input.videoId,
    model: input.model,
    promptVersion,
    taxonomyVersion,
    outputSha,
    createdAtIso: input.nowIso,
    ttlSeconds: VIDEO_ANALYSIS_RUNS_TTL_SECONDS,
    expiresAtIso: new Date(Date.parse(input.nowIso) + VIDEO_ANALYSIS_RUNS_TTL_SECONDS * 1000).toISOString(),
  };

  return { videoDocPatch, runDoc, runDocId };
}

// ── 4) 감사 샘플링(sampleTierOneRejects/buildAuditSample) ───────────────────────────
// 결정적 체계적 표집(systematic sampling) — videoId 정렬 후 균등 간격으로 rate(기본 5%) 비율만큼 뽑는다.
// 무작위 시드에 의존하지 않아 동일 입력에 대해 항상 같은 표본을 반환한다(테스트 가능성/재현성).
export function sampleTierOneRejects(rejects: readonly TierOneReject[], rate = 0.05): TierOneReject[] {
  if (rejects.length === 0) return [];
  const sorted = [...rejects].sort((a, b) => a.videoId.localeCompare(b.videoId));
  const sampleSize = Math.max(1, Math.round(sorted.length * rate));
  const cappedSize = Math.min(sampleSize, sorted.length);
  const step = sorted.length / cappedSize;
  const seen = new Set<number>();
  const out: TierOneReject[] = [];
  for (let i = 0; i < cappedSize; i += 1) {
    const idx = Math.min(sorted.length - 1, Math.floor(i * step));
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(sorted[idx]);
  }
  return out;
}

export type AuditReviewLabel = {
  readonly videoId: string;
  readonly missed: boolean; // true = 리뷰어가 "잘못 제외됐다(누락)"고 판정
};

export type AuditSampleResult = {
  readonly weekKey: string;
  readonly totalRejects: number;
  readonly sampleSize: number;
  readonly missedCount: number;
  readonly missRatePct: number;
  readonly qualityWarning: boolean;
};

// 감사 샘플 + 라벨(리뷰어 판정)을 합쳐 누락률(%)을 계산한다. >10%면 qualityWarning=true —
// index.ts/trend_reports 훅이 이 플래그를 trend_reports/{weekKey}.qualityWarning에 반영하고
// PROMPT-REVISION-BACKLOG 항목을 남긴다.
export function buildAuditSample(
  weekKey: string,
  rejects: readonly TierOneReject[],
  labels: readonly AuditReviewLabel[],
  rate = 0.05,
): AuditSampleResult & { readonly sample: readonly TierOneReject[] } {
  const sample = sampleTierOneRejects(rejects, rate);
  const labelMap = new Map(labels.map((label) => [label.videoId, label.missed]));
  const missedCount = sample.filter((reject) => labelMap.get(reject.videoId) === true).length;
  const missRatePct = sample.length > 0 ? Number(((missedCount / sample.length) * 100).toFixed(1)) : 0;
  return {
    weekKey,
    totalRejects: rejects.length,
    sampleSize: sample.length,
    missedCount,
    missRatePct,
    qualityWarning: missRatePct > AUDIT_MISS_RATE_WARNING_THRESHOLD_PCT,
    sample,
  };
}

export type PromptRevisionBacklogEntry = {
  readonly weekKey: string;
  readonly missRatePct: number;
  readonly sampleSize: number;
  readonly missedCount: number;
  readonly createdAtIso: string;
  readonly note: string;
};

// 감사 누락률이 임계치를 넘긴 주에 대해 PROMPT-REVISION-BACKLOG.md에 실릴 항목(순수 데이터)을 만든다.
// 실제 마크다운 파일 갱신은 사람 프로세스(문서 리뷰)가 담당 — 함수는 prompt_revision_backlog Firestore
// 컬렉션에 이 값을 기록해 문서 갱신 근거를 남긴다(runWeeklyDeepAnalysisBatch에서 사용).
export function buildPromptRevisionBacklogEntry(audit: AuditSampleResult, nowIso: string): PromptRevisionBacklogEntry {
  return {
    weekKey: audit.weekKey,
    missRatePct: audit.missRatePct,
    sampleSize: audit.sampleSize,
    missedCount: audit.missedCount,
    createdAtIso: nowIso,
    note: `1차 분류 감사 표본 누락률 ${audit.missRatePct}%가 임계치(${AUDIT_MISS_RATE_WARNING_THRESHOLD_PCT}%)를 초과 — 1차 분류 프롬프트 재검토 필요.`,
  };
}

// ── 5) 예산 역산(buildBudgetReport) ─────────────────────────────────────────────────
export type VideoLlmUsageRow = {
  readonly videoId: string;
  readonly sessionMinutes: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
};

export type BudgetReport = {
  readonly weekKey: string;
  readonly totalVideoMinutes: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly tokensPerMinute: number;
  readonly costPerMinuteUsd: number;
  readonly projectedMinutesForBudgetUsd: Readonly<Record<string, number>>;
};

export type BuildBudgetReportOptions = {
  readonly budgetCapsUsd?: Readonly<Record<string, number>>;
};

// 순수 산식: 주간 총 영상 분수(Σ sessionMinutes) 대비 토큰/분(tokensPerMinute = ΣtokenSum / Σminutes)을
// 구하고, 이를 역산해(예산 역산) 임의의 예산 한도(budgetCapsUsd)로 분석 가능한 영상 분수를 추정한다.
// 분모가 0이면(이번 주 분석 실적 없음) 0으로 안전 처리한다.
export function buildBudgetReport(usageRows: readonly VideoLlmUsageRow[], weekKey: string, options: BuildBudgetReportOptions = {}): BudgetReport {
  const totalVideoMinutes = usageRows.reduce((sum, row) => sum + Math.max(0, row.sessionMinutes), 0);
  const totalInputTokens = usageRows.reduce((sum, row) => sum + Math.max(0, row.inputTokens), 0);
  const totalOutputTokens = usageRows.reduce((sum, row) => sum + Math.max(0, row.outputTokens), 0);
  const totalCostUsd = usageRows.reduce((sum, row) => sum + Math.max(0, row.estimatedCostUsd), 0);
  const totalTokens = totalInputTokens + totalOutputTokens;
  const tokensPerMinute = totalVideoMinutes > 0 ? Number((totalTokens / totalVideoMinutes).toFixed(2)) : 0;
  const costPerMinuteUsd = totalVideoMinutes > 0 ? Number((totalCostUsd / totalVideoMinutes).toFixed(6)) : 0;

  const projectedMinutesForBudgetUsd: Record<string, number> = {};
  for (const [label, capUsd] of Object.entries(options.budgetCapsUsd ?? {})) {
    projectedMinutesForBudgetUsd[label] = costPerMinuteUsd > 0 ? Number((capUsd / costPerMinuteUsd).toFixed(1)) : 0;
  }

  return {
    weekKey,
    totalVideoMinutes: Number(totalVideoMinutes.toFixed(2)),
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    tokensPerMinute,
    costPerMinuteUsd,
    projectedMinutesForBudgetUsd,
  };
}

// ── 6) 배치 오케스트레이션(Firestore I/O) ───────────────────────────────────────────
export type FirestoreSnapshot = {
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
};

export type FirestoreDocRef = {
  get(): Promise<FirestoreSnapshot>;
  set(data: Record<string, unknown>, options: { merge: boolean }): Promise<unknown>;
};

export type FirestoreQuerySnapshotDoc = {
  readonly id: string;
  readonly ref: FirestoreDocRef;
  data(): Record<string, unknown> | undefined;
};

export type FirestoreQuery = {
  where(field: string, op: string, value: unknown): FirestoreQuery;
  limit(count: number): FirestoreQuery;
  get(): Promise<{ docs: FirestoreQuerySnapshotDoc[] }>;
};

export type FirestoreDb = {
  collection(name: string): FirestoreQuery & { doc(id: string): FirestoreDocRef };
};

function adminDbModule(): { adminDb: FirestoreDb } | null {
  return asRequireModule<{ adminDb: FirestoreDb }>("./firebaseAdmin");
}

function firestoreDb(options: { db?: FirestoreDb }): FirestoreDb {
  if (options.db) return options.db;
  const module = adminDbModule();
  if (!module) throw new Error("Firestore is unavailable for video deep-analysis batch processing");
  return module.adminDb;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function candidateFromVideoDoc(id: string, data: Record<string, unknown>): SelectionCandidate | null {
  const classification = data.classification && typeof data.classification === "object" ? data.classification as Record<string, unknown> : null;
  const gameId = stringField(data.gameId) || stringField(data.matchedGame);
  if (!classification || !gameId) return null;
  const confidence = typeof classification.confidence === "number" ? classification.confidence : 0;
  const tierTwoEligibility = (data.tierTwoEligibility === "promoted_no_transcript" || data.tierTwoEligibility === "demoted")
    ? data.tierTwoEligibility as TierTwoEligibility
    : "normal";
  const availability = data.availability === "private" || data.availability === "unlisted" || data.availability === "public"
    ? data.availability as VideoAvailability
    : undefined;
  return { videoId: id, gameId, confidence, tierTwoEligibility, ...(availability ? { availability } : {}) };
}

export type RunWeeklyDeepAnalysisBatchOptions = {
  readonly weekKey: string;
  readonly db?: FirestoreDb;
  readonly nowIso?: string;
  readonly runId?: string;
  readonly limit?: number;
  readonly perGame?: number;
  readonly promotedReserve?: number;
  readonly sampleRate?: number;
  readonly auditLabels?: readonly AuditReviewLabel[];
  readonly budgetCapsUsd?: Readonly<Record<string, number>>;
  readonly cache?: VideoLlmCache<DeepAnalysisResult>;
  readonly callFn?: VideoLlmCallFn;
  readonly lowCost?: boolean;
};

export type RunWeeklyDeepAnalysisBatchResult = {
  readonly ok: true;
  readonly weekKey: string;
  readonly scanned: number;
  readonly analyzed: number;
  readonly failed: number;
  readonly carriedOver: number;
  readonly excludedPrivate: number;
  readonly audit: AuditSampleResult;
  readonly budget: BudgetReport;
};

// 주간 2차 배치: deepAnalysisPending===true(1차 분류 완료, 승격 후보) 스캔 → selectForWeek 선별 →
// 직렬(1건=1요청) analyzeVideo → youtube_videos.analysis merge + video_analysis_runs(append-only) →
// sampleTierOneRejects(5%) 감사 → 누락률>10%면 trend_reports/{weekKey}.qualityWarning=true +
// prompt_revision_backlog 기록 → buildBudgetReport(예산 역산) → budget_reports/{weekKey}.
// index.ts의 onSchedule('30 0 * * 1', Asia/Seoul)이 스냅샷 직후·발행 전에 이 함수를 호출한다.
// 미완료(carriedOver) 항목은 deepAnalysisPending을 true로 유지해 다음 주로 이월된다(부분 완료분 이월).
export async function runWeeklyDeepAnalysisBatch(options: RunWeeklyDeepAnalysisBatchOptions): Promise<RunWeeklyDeepAnalysisBatchResult> {
  const db = firestoreDb(options);
  const nowIso = options.nowIso ?? new Date().toISOString();
  const runId = options.runId ?? `video-deep-analysis-${options.weekKey}`;
  const limit = options.limit ?? 500;

  const snapshot = await db.collection("youtube_videos")
    .where("deepAnalysisPending", "==", true)
    .limit(limit)
    .get();
  const docs = snapshot.docs ?? [];

  const candidates: SelectionCandidate[] = [];
  const docById = new Map<string, FirestoreQuerySnapshotDoc>();
  for (const doc of docs) {
    const data = doc.data() ?? {};
    const candidate = candidateFromVideoDoc(doc.id, data);
    if (candidate) {
      candidates.push(candidate);
      docById.set(doc.id, doc);
    }
  }

  const { selected, carriedOver, excludedPrivate, rejects } = selectForWeek(candidates, {
    perGame: options.perGame,
    promotedReserve: options.promotedReserve,
  });

  const usageRows: VideoLlmUsageRow[] = [];
  let analyzed = 0;
  let failed = 0;

  // 직렬(1건=1요청) — 병렬 팬아웃 금지(비용/쿼터 통제, B2 예외 범위 최소화).
  for (const candidate of selected) {
    const doc = docById.get(candidate.videoId);
    if (!doc) continue;
    const data = doc.data() ?? {};
    const youtubeUrl = stringField(data.videoUrl) || (data.videoId ? `https://www.youtube.com/watch?v=${stringField(data.videoId) || candidate.videoId}` : "");
    const title = stringField(data.title) || "Untitled YouTube video";
    try {
      const result = await analyzeVideo({ videoId: candidate.videoId, youtubeUrl, title }, {
        cache: options.cache,
        callFn: options.callFn,
        runId,
        lowCost: options.lowCost,
      });
      const tierOneClassification = data.classification && typeof data.classification === "object" ? data.classification as Record<string, unknown> : null;
      const analysisOnly: DeepAnalysisResult = {
        stageTransitions: result.stageTransitions,
        sessionComposition: result.sessionComposition,
        editDensity: result.editDensity,
        coreLoopObservations: result.coreLoopObservations,
        estimatedSessionMinutes: result.estimatedSessionMinutes,
        sessionConfidence: result.sessionConfidence,
      };
      const merge = buildVideoAnalysisMerge({
        videoId: candidate.videoId,
        runId,
        model: result.modelId,
        analysis: analysisOnly,
        nowIso,
        tierOneClassification,
      });
      await doc.ref.set({ ...merge.videoDocPatch, deepAnalysisPending: false }, { merge: true });
      await db.collection("video_analysis_runs").doc(merge.runDocId).set(merge.runDoc, { merge: false });
      usageRows.push({
        videoId: candidate.videoId,
        sessionMinutes: result.estimatedSessionMinutes,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedCostUsd: result.estimatedCostUsd,
      });
      analyzed += 1;
    } catch (error) {
      failed += 1;
      console.warn("[video-deep-analysis] analysis failed", {
        runId,
        videoId: candidate.videoId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const audit = buildAuditSample(options.weekKey, rejects, options.auditLabels ?? [], options.sampleRate);
  await db.collection("audit_samples").doc(options.weekKey).set({ ...audit, createdAtIso: nowIso }, { merge: true });
  if (audit.qualityWarning) {
    await db.collection("trend_reports").doc(options.weekKey).set({ qualityWarning: true }, { merge: true });
    const backlogEntry = buildPromptRevisionBacklogEntry(audit, nowIso);
    await db.collection("prompt_revision_backlog").doc(options.weekKey).set(backlogEntry, { merge: true });
  }

  const budget = buildBudgetReport(usageRows, options.weekKey, { budgetCapsUsd: options.budgetCapsUsd });
  await db.collection("budget_reports").doc(options.weekKey).set({ ...budget, createdAtIso: nowIso }, { merge: true });

  return {
    ok: true,
    weekKey: options.weekKey,
    scanned: docs.length,
    analyzed,
    failed,
    carriedOver: carriedOver.length,
    excludedPrivate: excludedPrivate.length,
    audit,
    budget,
  };
}
