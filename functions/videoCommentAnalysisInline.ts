// 댓글 인사이트 인라인 오케스트레이션 — activityRefresh 수집 직후(및 백로그 스윕)에서 호출.
//   캐시 선행(videoCommentAnalysis) → videos.commentInsights merge → creator_comments per-comment 라벨 →
//   creator_comment_insights 롤업. 증분(순서독립)·실행당 상한·deadline 이월(commentInsightsPending)·
//   try/catch 격리·ENABLE_COMMENT_INSIGHTS 플래그. 순수 산식(computeCreatorRollup/shouldReanalyze)은 DI/테스트 가능.
import {
  analyzeVideoComments,
  type CommentInput,
  type CommentInsight,
  type AnalyzeVideoCommentsOptions,
} from "./videoCommentAnalysis";

export const COMMENT_REANALYZE_DELTA = Number.parseInt(process.env.SCP_COMMENT_REANALYZE_DELTA ?? "", 10) || 20;
export const COMMENT_INLINE_VIDEO_CAP = Number.parseInt(process.env.SCP_COMMENT_INLINE_VIDEO_CAP ?? "", 10) || 12;
export const CREATOR_ROLLUP_RECENT_VIDEOS = 10;
export const CREATOR_ROLLUP_MIN_VALID = 3;
export const COMMENT_SAMPLE_FLOOR = 10;

export function isCommentInsightsEnabled(): boolean {
  return process.env.ENABLE_COMMENT_INSIGHTS === "true";
}

// ── 순수: 재분석 판정(순서독립 증분) ─────────────────────────────────────────
export type ReanalyzeState = {
  hasInsight: boolean;
  analyzedCommentCount?: number; // 마지막 분석 시점 commentCount
  analyzedAtIso?: string;
};

export function shouldReanalyze(
  state: ReanalyzeState,
  currentCommentCount: number,
  latestCommentTimeIso: string | undefined,
  deltaThreshold = COMMENT_REANALYZE_DELTA,
): boolean {
  if (!state.hasInsight) return true; // 최초
  const prevCount = typeof state.analyzedCommentCount === "number" ? state.analyzedCommentCount : 0;
  if (currentCommentCount - prevCount >= deltaThreshold) return true; // 신규 댓글 델타
  if (latestCommentTimeIso && state.analyzedAtIso && Date.parse(latestCommentTimeIso) > Date.parse(state.analyzedAtIso)) return true; // 최신 댓글이 분석 이후
  return false;
}

// ── 순수: 크리에이터 롤업(최근10·댓글가중감성·플래그영상비율, 유효≥3 else N/A) ──
export type VideoInsightRow = {
  videoId: string;
  publishedAtIso?: string;
  analyzedAtIso?: string;
  commentInsights?: CommentInsight & { commentCountAtAnalysis?: number };
};

export type CreatorRollup = {
  status: "ok" | "insufficient";
  validVideoCount: number;
  weightedSentiment: { positive: number; neutral: number; negative: number };
  flagRatio: number;
  flaggedVideoCount: number;
  recentVideoCount: number;
};

function sortByRecency(rows: VideoInsightRow[]): VideoInsightRow[] {
  return [...rows].sort((a, b) => {
    const at = Date.parse(a.publishedAtIso ?? a.analyzedAtIso ?? "") || 0;
    const bt = Date.parse(b.publishedAtIso ?? b.analyzedAtIso ?? "") || 0;
    return bt - at;
  });
}

export function computeCreatorRollup(rows: readonly VideoInsightRow[], minValid = CREATOR_ROLLUP_MIN_VALID): CreatorRollup {
  // 유효 = commentInsights 존재 + 표본충분(analyzedCount>=FLOOR). 최근 10영상만.
  const recent = sortByRecency(rows as VideoInsightRow[]).slice(0, CREATOR_ROLLUP_RECENT_VIDEOS);
  const valid = recent.filter((r) => r.commentInsights && r.commentInsights.analyzedCount >= COMMENT_SAMPLE_FLOOR);
  if (valid.length < minValid) {
    return { status: "insufficient", validVideoCount: valid.length, weightedSentiment: { positive: 0, neutral: 0, negative: 0 }, flagRatio: 0, flaggedVideoCount: 0, recentVideoCount: recent.length };
  }
  let wPos = 0;
  let wNeu = 0;
  let wNeg = 0;
  let totalWeight = 0;
  let flaggedVideoCount = 0;
  for (const r of valid) {
    const ci = r.commentInsights!;
    const weight = ci.analyzedCount; // 댓글수 가중
    wPos += ci.sentimentCounts.positive;
    wNeu += ci.sentimentCounts.neutral;
    wNeg += ci.sentimentCounts.negative;
    totalWeight += weight;
    if (ci.brandSafety.flagged) flaggedVideoCount += 1;
  }
  const denom = wPos + wNeu + wNeg;
  const pct = (n: number) => (denom > 0 ? Math.round((n / denom) * 100) : 0);
  // 정수 합 100 보정(최대 항목에 잔여 배분)
  const rawPos = pct(wPos);
  const rawNeu = pct(wNeu);
  const rawNeg = pct(wNeg);
  const drift = 100 - (rawPos + rawNeu + rawNeg);
  const buckets = [
    { k: "positive" as const, v: rawPos, raw: wPos },
    { k: "neutral" as const, v: rawNeu, raw: wNeu },
    { k: "negative" as const, v: rawNeg, raw: wNeg },
  ].sort((a, b) => b.raw - a.raw);
  if (buckets.length > 0 && denom > 0) buckets[0].v += drift;
  const weightedSentiment = {
    positive: buckets.find((b) => b.k === "positive")!.v,
    neutral: buckets.find((b) => b.k === "neutral")!.v,
    negative: buckets.find((b) => b.k === "negative")!.v,
  };
  return {
    status: "ok",
    validVideoCount: valid.length,
    weightedSentiment,
    flagRatio: Number((flaggedVideoCount / valid.length).toFixed(4)),
    flaggedVideoCount,
    recentVideoCount: recent.length,
    // totalWeight는 향후 확장 여지(현재 미노출)
  } as CreatorRollup;
}

// ── I/O 오케스트레이션 (DI: db·analyze·nowIso) ───────────────────────────────
type FirestoreDocRef = {
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(value: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
  ref?: unknown;
};
type FirestoreQuerySnapshotDoc = { id: string; data(): Record<string, unknown> | undefined; ref: FirestoreDocRef };
type FirestoreQuery = {
  where(field: string, op: string, value: unknown): FirestoreQuery;
  limit(n: number): FirestoreQuery;
  get(): Promise<{ docs: FirestoreQuerySnapshotDoc[] }>;
};
type FirestoreDb = { collection(name: string): FirestoreQuery & { doc(id: string): FirestoreDocRef } };

declare const require: ((id: string) => unknown) | undefined;
function adminDbFromRequire(): FirestoreDb | null {
  if (typeof require !== "function") return null;
  try {
    return (require("./firebaseAdmin") as { adminDb: FirestoreDb }).adminDb;
  } catch {
    return null;
  }
}

export type AnalyzeInlineFn = (
  videoId: string,
  comments: readonly CommentInput[],
  options?: AnalyzeVideoCommentsOptions,
) => Promise<CommentInsight & { modelId: string; cacheHit: boolean }>;

export type InlineOptions = {
  db?: FirestoreDb;
  analyze?: AnalyzeInlineFn;
  nowIso?: string;
  analyzeOptions?: AnalyzeVideoCommentsOptions;
  // shouldReanalyze 우회(백필/강제 재분석). analyzeVideoComments 캐시 선행은 유지 → 성공분은 재호출 없음.
  force?: boolean;
};

function db(options: InlineOptions): FirestoreDb {
  const d = options.db ?? adminDbFromRequire();
  if (!d) throw new Error("firebaseAdmin adminDb unavailable");
  return d;
}

// 단일 영상 인라인 분석 → videos.commentInsights merge + 크리에이터 롤업 갱신. 증분 스킵 반영.
export async function analyzeVideoCommentInsights(
  input: { videoId: string; creatorId: string; comments: readonly CommentInput[]; commentCount: number; latestCommentTimeIso?: string },
  options: InlineOptions = {},
): Promise<{ analyzed: boolean; reason?: string; insight?: CommentInsight }> {
  const d = db(options);
  const nowIso = options.nowIso ?? new Date().toISOString();
  const analyze = options.analyze ?? (analyzeVideoComments as AnalyzeInlineFn);

  const videoRef = d.collection("videos").doc(input.videoId);
  const snap = await videoRef.get();
  const data = snap.exists ? snap.data() ?? {} : {};
  const existing = data.commentInsights && typeof data.commentInsights === "object" ? data.commentInsights as Record<string, unknown> : null;
  const state: ReanalyzeState = {
    hasInsight: !!existing,
    analyzedCommentCount: typeof existing?.commentCountAtAnalysis === "number" ? existing.commentCountAtAnalysis as number : undefined,
    analyzedAtIso: typeof data.commentInsightsAnalyzedAtIso === "string" ? data.commentInsightsAnalyzedAtIso : undefined,
  };

  if (!options.force && !shouldReanalyze(state, input.commentCount, input.latestCommentTimeIso)) {
    if (data.commentInsightsPending === true) await videoRef.set({ commentInsightsPending: false }, { merge: true });
    return { analyzed: false, reason: "no_reanalyze_needed" };
  }

  const insight = await analyze(input.videoId, input.comments, options.analyzeOptions);
  await videoRef.set({
    commentInsights: { ...insight, commentCountAtAnalysis: input.commentCount },
    commentInsightsAnalyzedAtIso: nowIso,
    commentInsightsPending: false,
  }, { merge: true });

  if (input.creatorId) await updateCreatorRollup(input.creatorId, options);
  return { analyzed: true, insight };
}

// deadline/cap 초과 시 이월 표시.
export async function markCommentInsightsPending(videoId: string, options: InlineOptions = {}): Promise<void> {
  await db(options).collection("videos").doc(videoId).set({ commentInsightsPending: true }, { merge: true });
}

// 크리에이터 롤업 재계산 → creator_comment_insights/{creatorId}.
export async function updateCreatorRollup(creatorId: string, options: InlineOptions = {}): Promise<CreatorRollup> {
  const d = db(options);
  const nowIso = options.nowIso ?? new Date().toISOString();
  const snap = await d.collection("videos").where("creatorId", "==", creatorId).limit(200).get();
  const rows: VideoInsightRow[] = (snap.docs ?? []).map((doc) => {
    const data = doc.data() ?? {};
    return {
      videoId: doc.id,
      publishedAtIso: typeof data.publishedAtIso === "string" ? data.publishedAtIso : undefined,
      analyzedAtIso: typeof data.commentInsightsAnalyzedAtIso === "string" ? data.commentInsightsAnalyzedAtIso : undefined,
      commentInsights: data.commentInsights && typeof data.commentInsights === "object" ? data.commentInsights as VideoInsightRow["commentInsights"] : undefined,
    };
  });
  const rollup = computeCreatorRollup(rows);
  await d.collection("creator_comment_insights").doc(creatorId).set({
    creatorId,
    ...rollup,
    updatedAtIso: nowIso,
  }, { merge: true });
  return rollup;
}

// 백로그 스윕: commentInsightsPending===true 영상을 상한만큼 소진. run-feed-video-analysis 4번째 패스가 호출.
export async function sweepPendingCommentInsights(
  loadComments: (videoId: string) => Promise<{ comments: CommentInput[]; commentCount: number; creatorId: string; latestCommentTimeIso?: string }>,
  options: InlineOptions & { limit?: number } = {},
): Promise<{ scanned: number; analyzed: number; errors: number }> {
  const d = db(options);
  const limit = Math.max(1, options.limit ?? COMMENT_INLINE_VIDEO_CAP);
  const snap = await d.collection("videos").where("commentInsightsPending", "==", true).limit(limit).get();
  const docs = snap.docs ?? [];
  let analyzed = 0;
  let errors = 0;
  for (const doc of docs) {
    try {
      const loaded = await loadComments(doc.id);
      const result = await analyzeVideoCommentInsights(
        { videoId: doc.id, creatorId: loaded.creatorId, comments: loaded.comments, commentCount: loaded.commentCount, latestCommentTimeIso: loaded.latestCommentTimeIso },
        options,
      );
      if (result.analyzed) analyzed += 1;
      else await doc.ref.set({ commentInsightsPending: false }, { merge: true }); // 재분석 불필요 → pending 해제(수렴)
    } catch (err) {
      errors += 1;
      console.warn("[comment-insights-sweep] failed", { videoId: doc.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { scanned: docs.length, analyzed, errors };
}
