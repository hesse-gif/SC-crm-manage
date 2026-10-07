import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { expireAt180DaysFromIso } from "./firestoreTtl";
import { canonicalCreatorId } from "./creatorIdentity";
import { parseYouTubeDurationSeconds } from "./youtubeEnrichmentMetrics";
import { isCommentInsightsEnabled, analyzeVideoCommentInsights, markCommentInsightsPending, COMMENT_INLINE_VIDEO_CAP } from "./videoCommentAnalysisInline";
import { computeViewVelocity } from "./creatorPromotion";
import { recordYoutubeApiAttempt, recordYoutubeApiUnits, youtubeOperationFromUrl, YOUTUBE_GROWTH_POOL_ID } from "./apiQuota";

type CreatorDoc = {
  id: string;
  name?: string;
  handle?: string;
  email?: string;
  avatar?: string;
  type?: string;
  youtubeUrl?: string;
  channelId?: string;
  deletedAt?: string;
  archivedAt?: string;
};

type RefreshCounters = {
  creatorsScanned: number;
  creatorsUpdated: number;
  creatorsSkipped: number;
  videosUpdated: number;
  commentsUpdated: number;
  channelStatsUpdated: number;
  errors: number;
};

type RefreshOptions = {
  limit?: number;
  recentVideosPerCreator?: number;
  commentsPerVideo?: number;
  // 테스트 전용 시드: 프로덕션 onSchedule 호출부(index.ts)는 절대 넘기지 않는다(기본값
  // FUNCTION_TIME_BUDGET_MS 유지). 실제 540s를 기다리지 않고도 chunking/이월 경로를
  // 결정적으로 재현하기 위한 시드.
  timeBudgetMs?: number;
};

const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const DEFAULT_CREATOR_LIMIT = 10_000;
const DEFAULT_RECENT_VIDEOS = 5;
const DEFAULT_COMMENTS_PER_VIDEO = 5;
// RT-10 실측(07-05/07-06): 매일 첫 시도 DEADLINE_EXCEEDED(540s 하드 리밋) → 재시도에서만
// partial-time-budget 성공. 원인: 이전 500s 소프트 예산은 "크리에이터 단위"로만 체크돼
// video-comment-analysis LLM 재시도가 크리에이터 1건 처리 도중 남은 예산을 통째로
// 넘겨버릴 수 있었음(중간 체크 없음). 450s로 낮추고(90s 버퍼) + 영상 단위 체크(아래
// commentsPerVideo 분기)를 추가해 초과 폭을 크리에이터당→영상당으로 좁힌다.
const FUNCTION_TIME_BUDGET_MS = 450_000;
const NON_ACTIONABLE_COMMENT_REASONS = new Set(["commentsDisabled"]);
// 크리에이터 스캔 순서(document id asc)의 이어달리기 커서. 하루 1회 cron이 예산 내에
// 전체를 못 돌아도, 다음 실행이 멈춘 지점부터 재개해 뒤쪽 creator가 영구 미스캔되는
// 것을 막는다(이월/idempotent — 이미 처리된 creator를 다시 "신규"로 잘못 잡지 않음).
const ACTIVITY_REFRESH_CURSOR_REF = adminDb.collection("activity_refresh_state").doc("cursor");

class YouTubeApiError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(path: string, status: number, reason: string) {
    super(`youtube-${path}-failed-${status}${reason ? `-${reason}` : ""}`);
    this.name = "YouTubeApiError";
    this.status = status;
    this.reason = reason;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  const source = typeof value === "string" ? Number(value) : value;
  return typeof source === "number" && Number.isFinite(source) ? source : fallback;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

function youtubeErrorReason(payload: Record<string, unknown>): string {
  const error = asRecord(payload.error);
  const errors = Array.isArray(error.errors) ? error.errors.map(asRecord) : [];
  return asString(errors[0]?.reason) || asString(error.reason) || asString(error.status);
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

function youtubeHandle(value: string): string {
  const trimmed = value.trim();
  const handle = trimmed.match(/youtube\.com\/@([^/?#]+)/i)?.[1] ?? trimmed.match(/^@([^/?#]+)/)?.[1];
  return handle ? `@${handle}` : "";
}

function normalizeYouTubeChannelId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const fromUrl = trimmed.match(/youtube\.com\/channel\/([^/?#]+)/i)?.[1];
  const candidate = fromUrl ?? trimmed.replace(/^yt_channel_/i, "");
  return /^UC[a-zA-Z0-9_-]{20,}$/.test(candidate) ? candidate : "";
}

function videoUrl(videoId: string, commentId?: string): string {
  const url = new URL(`https://www.youtube.com/watch?v=${videoId}`);
  if (commentId) url.searchParams.set("lc", commentId);
  return url.toString();
}

function sentimentLabel(text: string): "positive" | "neutral" | "negative" {
  const normalized = text.toLowerCase();
  if (/(love|best|good|great|nice|awesome|fun|cool|❤|❤️|😂|👍)/i.test(normalized)) return "positive";
  if (/(bad|hate|boring|bug|crash|worst|scam|trash)/i.test(normalized)) return "negative";
  return "neutral";
}

// Flu/Task-49: optional pool/slot context for the ledger writes below. Every existing caller in
// this codebase omits it, so `slotIndex` stays 0 and `poolId` stays growth — byte-identical to
// this module's pre-Task-49 behavior. A future caller that resolved a non-growth pool (e.g. via
// functions/youtubeQuotaPools.ts's selectYoutubeApiKey) can pass its {slotIndex, poolId} through
// fetchChannel/fetchRecentVideos so that pool's own ledger accrues the usage instead of growth's.
export type YoutubeGetQuotaContext = { readonly slotIndex?: number; readonly poolId?: string };

async function youtubeGet(
  path: string,
  params: Record<string, string>,
  apiKey: string,
  quotaContext: YoutubeGetQuotaContext = {},
  // Flu/0673 핫픽스 보강: 기본 12s는 그대로 유지한다(스케줄 경로 회귀 0) — candidateTable.ts의
  // enrichCandidateMeta만 더 짧은 값을 넘겨 후보 탭 응답을 빠르게 실패시킨다.
  timeoutMs = 12_000,
): Promise<Record<string, unknown>> {
  const url = new URL(`${YOUTUBE_API}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  url.searchParams.set("key", apiKey);
  const operation = youtubeOperationFromUrl(path);
  const slotIndex = quotaContext.slotIndex ?? 0;
  const poolId = quotaContext.poolId ?? YOUTUBE_GROWTH_POOL_ID;
  // W59c-C1 [Codex 적대 리뷰]: 이 모듈은 legacy 유닛 원장(bySlot.0)만 쓰고 **v2 원장에는 한 건도
  // 남기지 않았다**. 그래서 v2 로 본 슬롯 0 은 실제보다 한가해 보였다 — R28-3 이 두 모델을 병행
  // 기록해 대조하려던 목적이 주 키에서만 깨져 있었고, v2 를 근거로 쓰는 판정이 생기면 조회수 추적
  // 소모가 통째로 보이지 않는다. fetchYouTubeRecord(발굴)와 동일하게 시도/성공/실패를 완결 기록한다.
  void recordYoutubeApiAttempt({ operation, slotIndex, poolId, outcome: "attempted" });
  const response = await fetch(url, { signal: timeoutSignal(timeoutMs) });
  const json = await responseJson(response);
  if (!response.ok) {
    const errorReason = youtubeErrorReason(json);
    void recordYoutubeApiAttempt({
      operation,
      slotIndex,
      poolId,
      outcome: "failure",
      httpStatus: response.status,
      ...(errorReason ? { errorReason } : {}),
    });
    throw new YouTubeApiError(path, response.status, errorReason);
  }
  // R22-2: 이 모듈은 주 키(process.env.YOUTUBE_API_KEY = 슬롯 0)만 쓴다. 슬롯을 명시하지 않으면
  // bySlot.0 에 잡히지 않아 R21-2 예약분 가드가 주 키 잔여를 **과대평가**한다
  // (youtubeEnrichmentService 가 같은 이유로 이미 슬롯 0 을 명시한다).
  void recordYoutubeApiUnits(operation, 1, slotIndex, poolId);
  // W59d-F6: search 성공의 v2 계상은 **await** 한다 — 이 값이 슬롯 회전 원장의 정본이고(W59c-C4),
  // 인스턴스가 쓰기 도달 전에 종결되면 그 콜이 durable 원장에서 사라져 다음 인스턴스가 이미 마른
  // 프로젝트를 다시 고른다. 그 외 연산은 종전대로 fire-and-forget(호출 경로를 느리게 만들지 않는다).
  if (operation === "search") {
    try {
      await recordYoutubeApiAttempt({ operation, slotIndex, poolId, outcome: "success" });
    } catch {
      // 계측 실패가 조회수 추적을 깨뜨리면 안 된다 — 삼키되 위 units 기록은 이미 나갔다.
    }
  } else {
    void recordYoutubeApiAttempt({ operation, slotIndex, poolId, outcome: "success" });
  }
  return json;
}

async function resolveChannelId(creator: CreatorDoc, apiKey: string): Promise<string> {
  const explicitChannelId = normalizeYouTubeChannelId(creator.channelId ?? "");
  if (explicitChannelId) return explicitChannelId;
  const urlChannelId = normalizeYouTubeChannelId(creator.youtubeUrl ?? "");
  if (urlChannelId) return urlChannelId;
  const handle = youtubeHandle(creator.youtubeUrl ?? creator.handle ?? "");
  if (!handle) return "";
  const json = await youtubeGet("channels", {
    part: "id",
    forHandle: handle,
    maxResults: "1",
  }, apiKey);
  const items = Array.isArray(json.items) ? json.items.map(asRecord) : [];
  return asString(items[0]?.id);
}

// Flu/Task-43: exported so functions/candidateTable.ts can reuse the exact same channel/recent-
// video fetch (incl. youtubeGet's built-in COST-P0-006 quota accounting) instead of duplicating
// it. Behavior is unchanged — this only widens visibility.
// Flu/Task-49: `quotaContext` is a new trailing optional param (default {} => slot 0/growth, the
// exact prior behavior). candidateTable.ts calls this with 2 args and is intentionally left
// untouched by this ticket, so it keeps riding growth; a future orgId-aware caller can pass
// {slotIndex, poolId} (e.g. from functions/youtubeQuotaPools.ts's selectYoutubeApiKey) without
// this function's signature changing again.
// Flu/0673 핫픽스 보강: `timeoutMs` is a further trailing optional param — omitted (undefined) it
// falls through to youtubeGet's own 12s default, byte-identical to pre-hotfix behavior for every
// existing caller. Only candidateTable.ts's enrichCandidateMeta passes a shorter value.
export async function fetchChannel(
  channelId: string,
  apiKey: string,
  quotaContext: YoutubeGetQuotaContext = {},
  timeoutMs?: number,
): Promise<Record<string, unknown> | null> {
  const json = await youtubeGet("channels", {
    part: "snippet,statistics",
    id: channelId,
    maxResults: "1",
  }, apiKey, quotaContext, timeoutMs);
  const items = Array.isArray(json.items) ? json.items.map(asRecord) : [];
  return items[0] ?? null;
}

// Flu/Task-43: exported — see fetchChannel comment above. Flu/Task-49: same `quotaContext` param.
// Flu/0673 핫픽스 보강: same `timeoutMs` param as fetchChannel above.
export async function fetchRecentVideos(
  channelId: string,
  apiKey: string,
  maxResults: number,
  quotaContext: YoutubeGetQuotaContext = {},
  timeoutMs?: number,
): Promise<Record<string, unknown>[]> {
  const search = await youtubeGet("search", {
    part: "snippet",
    channelId,
    type: "video",
    order: "date",
    maxResults: String(maxResults),
  }, apiKey, quotaContext, timeoutMs);
  const videoIds = (Array.isArray(search.items) ? search.items.map(asRecord) : [])
    .map((item) => asString(asRecord(item.id).videoId))
    .filter(Boolean);
  if (videoIds.length === 0) return [];
  const videos = await youtubeGet("videos", {
    part: "snippet,contentDetails,statistics",
    id: videoIds.join(","),
    maxResults: String(videoIds.length),
  }, apiKey, quotaContext, timeoutMs);
  return Array.isArray(videos.items) ? videos.items.map(asRecord) : [];
}

// 분석용 fetch cap(top100, order relevance) vs creator_comments 저장 cap(top20). env override 가능.
// commentThreads.list = 1 unit/page(최대 100/page) → 전체 영상×1~2p도 일일 quota 10,000 대비 무시 가능.
const COMMENT_FETCH_CAP = Number.parseInt(process.env.SCP_COMMENT_FETCH_CAP ?? "", 10) || 100;
export const COMMENT_STORE_CAP = Number.parseInt(process.env.SCP_COMMENT_STORE_CAP ?? "", 10) || 20;
const COMMENT_FETCH_MAX_PAGES = 5;

// 영상당 top(fetchCap) 댓글을 relevance 순으로 페이지네이션 수집해 in-memory 반환(W2 분석 입력).
// AI-DRAMA-DISCOVERY-METAPROMPT W5: quotaContext 는 fetchRecentVideos 와 같은 선택적 5번째 인자다 —
// 안 넘기면(기존 모든 호출부) growth 슬롯 0 그대로(회귀 0). T049 댓글 수집 스윕만 selectYoutubeApiKey
// 로 해석한 {slotIndex, poolId} 를 넘겨 drama_1 원장에 기록되게 한다.
export async function fetchTopComments(
  videoId: string,
  apiKey: string,
  fetchCap = COMMENT_FETCH_CAP,
  quotaContext: YoutubeGetQuotaContext = {},
): Promise<Record<string, unknown>[]> { const cap = Math.max(1, Math.min(COMMENT_FETCH_CAP, fetchCap || COMMENT_FETCH_CAP));
const items: Record<string, unknown>[] = [];
let pageToken: string | undefined;
try {
  for (let page = 0; page < COMMENT_FETCH_MAX_PAGES && items.length < cap; page += 1) {
    const json = await youtubeGet("commentThreads", {
      part: "snippet",
      videoId,
      order: "relevance",
      textFormat: "plainText",
      maxResults: String(Math.min(100, cap - items.length)),
      ...(pageToken ? { pageToken } : {}),
    }, apiKey, quotaContext) as Record<string, unknown>;
    const pageItems = Array.isArray(json.items) ? json.items.map(asRecord) : [];
    items.push(...pageItems);
    pageToken = typeof json.nextPageToken === "string" ? json.nextPageToken : undefined;
    if (!pageToken || pageItems.length === 0) break;
  }
  return items.slice(0, cap);
} catch (error) {
  if (error instanceof YouTubeApiError && NON_ACTIONABLE_COMMENT_REASONS.has(error.reason)) return [];
  throw error;
} }

function creatorFromDoc(id: string, data: Record<string, unknown>): CreatorDoc {
  return {
    id,
    name: asString(data.name),
    handle: asString(data.handle),
    email: asString(data.email),
    avatar: asString(data.avatar),
    type: asString(data.type),
    youtubeUrl: asString(data.youtubeUrl),
    channelId: asString(data.channelId),
    deletedAt: asString(data.deletedAt),
    archivedAt: asString(data.archivedAt),
  };
}

function creatorActivityId(creator: CreatorDoc, channelId: string): string {
  return canonicalCreatorId({
    creatorId: creator.id,
    email: creator.email,
    handle: creator.handle,
    name: creator.name,
    youtubeUrl: creator.youtubeUrl,
    channelId,
  }) || creator.id;
}

// creator-evidence-metrics fix (2026-09): channel_stats.recentViews/engagement used to be
// hardcoded 0 here — functions/mailHumanGate.ts's scoreHumanReviewEvidence weights them 45/20
// (vs 35 for followers), so every creator scored at most 35/80 no matter how active they were,
// which starved auto-reply evidence and misrouted real conversations to needs_review. Both
// values are derived from `videos` (already fetched via fetchRecentVideos below — no extra
// YouTube API call/quota, see COST-P0-006/COST-P0-011).

// Average (not summed) view count across the creator's recent uploads — mirrors the
// channel_stats.recentViews semantics used elsewhere (crm.ts sanitizeMetrics, seedData.ts
// SEED_CHANNEL_STATS), which stays comparable to the per-video CPM pricing bands in
// mailHumanGate.ts's pricingBandForContext/priceNegotiationFromContext.
export function averageRecentViews(videos: readonly Record<string, unknown>[]): number {
  const viewCounts = videos
    .map((video) => asNumber(asRecord(video.statistics).viewCount))
    .filter((views) => Number.isFinite(views) && views >= 0);
  if (viewCounts.length === 0) return 0;
  const total = viewCounts.reduce((sum, views) => sum + views, 0);
  return Math.round(total / viewCounts.length);
}

// Average per-video engagement rate as a percentage (mirrors channel_stats.engagement, e.g.
// 6.2 = 6.2% — see seedData.ts SEED_CHANNEL_STATS), averaged across videos rather than
// aggregated so one outlier view count doesn't dominate the score. Videos with 0 views
// (not yet counted by YouTube) are excluded rather than treated as 0% engagement.
export function averageEngagementPct(videos: readonly Record<string, unknown>[]): number {
  const ratios: number[] = [];
  for (const video of videos) {
    const stats = asRecord(video.statistics);
    const views = asNumber(stats.viewCount);
    if (!(views > 0)) continue;
    const likes = asNumber(stats.likeCount);
    const comments = asNumber(stats.commentCount);
    ratios.push(((likes + comments) / views) * 100);
  }
  if (ratios.length === 0) return 0;
  const avg = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
  return Math.round(avg * 100) / 100;
}

export async function refreshCreatorActivityFeed(options: RefreshOptions = {}) {
  const apiKey = process.env.YOUTUBE_API_KEY?.trim() ?? "";
  const startedAtIso = new Date().toISOString();
  const deadlineMs = Date.now() + (options.timeBudgetMs ?? FUNCTION_TIME_BUDGET_MS);
  const runId = `activity_${startedAtIso.slice(0, 10)}`;
  const counters: RefreshCounters = {
    creatorsScanned: 0,
    creatorsUpdated: 0,
    creatorsSkipped: 0,
    videosUpdated: 0,
    commentsUpdated: 0,
    channelStatsUpdated: 0,
    errors: 0,
  };
  let stoppedForTimeBudget = false;
  let commentInsightsAnalyzed = 0; // W2 인라인 댓글 인사이트 실행당 영상 상한 카운터
  const runRef = adminDb.collection("activity_refresh_runs").doc(runId);

  if (!apiKey) {
    await runRef.set({
      id: runId,
      status: "skipped",
      reason: "missing-youtube-api-key",
      counters,
      startedAtIso,
      finishedAtIso: new Date().toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
      expireAt: expireAt180DaysFromIso(startedAtIso),
    }, { merge: true });
    return { ok: false, skipped: true, counters };
  }

  await runRef.set({
    id: runId,
    status: "running",
    startedAtIso,
    updatedAt: FieldValue.serverTimestamp(),
    expireAt: expireAt180DaysFromIso(startedAtIso),
  }, { merge: true });

  const creatorLimit = Math.max(1, Math.min(options.limit ?? DEFAULT_CREATOR_LIMIT, 10_000));
  const recentVideosPerCreator = Math.max(1, Math.min(options.recentVideosPerCreator ?? DEFAULT_RECENT_VIDEOS, 10));
  const commentsPerVideo = Math.max(0, Math.min(options.commentsPerVideo ?? DEFAULT_COMMENTS_PER_VIDEO, 20));

  const cursorSnap = await ACTIVITY_REFRESH_CURSOR_REF.get();
  const resumeAfterCreatorId = asString(cursorSnap.data()?.resumeAfterCreatorId);
  const creatorsQuery = () => adminDb.collection("creators").where("type", "==", "influencer").orderBy(FieldPath.documentId()).limit(creatorLimit);
  let snapshot = resumeAfterCreatorId
    ? await creatorsQuery().startAfter(resumeAfterCreatorId).get()
    : await creatorsQuery().get();
  let wrappedToStart = false;
  if (snapshot.empty && resumeAfterCreatorId) {
    // Previous run's cursor reached the end of the collection — wrap around so
    // this run still makes progress instead of doing nothing.
    snapshot = await creatorsQuery().get();
    wrappedToStart = true;
  }

  let lastHandledCreatorId: string | null = wrappedToStart ? null : resumeAfterCreatorId || null;

  for (const doc of snapshot.docs) {
    if (Date.now() > deadlineMs) {
      stoppedForTimeBudget = true;
      await Promise.all([
        runRef.set({
          status: "partial-time-budget",
          counters,
          stoppedAtCreatorId: doc.id,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }),
        ACTIVITY_REFRESH_CURSOR_REF.set({
          resumeAfterCreatorId: lastHandledCreatorId,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtIso: new Date().toISOString(),
        }, { merge: true }),
      ]);
      break;
    }
    counters.creatorsScanned += 1;
    // Mark handled the moment we pick this creator up (success, skip, or
    // error all count) so a mid-run timeout resumes after it, not before it.
    lastHandledCreatorId = doc.id;
    const creator = creatorFromDoc(doc.id, doc.data());
    if (creator.deletedAt || creator.archivedAt) {
      counters.creatorsSkipped += 1;
      continue;
    }

    try {
      const channelId = await resolveChannelId(creator, apiKey);
      if (!channelId) {
        counters.creatorsSkipped += 1;
        continue;
      }

      const activityCreatorId = creatorActivityId(creator, channelId);
      const channel = await fetchChannel(channelId, apiKey);
      const channelSnippet = asRecord(channel?.snippet);
      const channelStats = asRecord(channel?.statistics);
      const videos = await fetchRecentVideos(channelId, apiKey, recentVideosPerCreator);
      const batch = adminDb.batch();
      const refreshedAtIso = new Date().toISOString();

      if (channel) {
        const followers = asNumber(channelStats.subscriberCount);
        const views = asNumber(channelStats.viewCount);
        const videoCount = asNumber(channelStats.videoCount);
        batch.set(adminDb.collection("channel_stats").doc(activityCreatorId), {
          id: activityCreatorId,
          channelId,
          creatorRef: `creators/${doc.id}`,
          channelRef: `youtube/${channelId}`,
          followers,
          viewCount: views,
          videoCount,
          avgViews: videoCount > 0 ? Math.round(views / videoCount) : 0,
          recentViews: averageRecentViews(videos),
          engagement: averageEngagementPct(videos),
          metricSource: "youtube.data-api",
          refreshedAtIso,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtIso: refreshedAtIso,
        }, { merge: true });
        // C2 급상승 신호: 최근 수집 영상 조회수/경과일 → creators.viewVelocity(트렌딩 랭킹·피드 정렬 근거).
        const viewVelocity = computeViewVelocity(videos.map((v) => ({ views: asNumber(asRecord(v.statistics).viewCount), publishedAtIso: asString(asRecord(v.snippet).publishedAt) })));
        batch.set(doc.ref, {
          channelId,
          followers,
          viewVelocity,
          youtubeUrl: creator.youtubeUrl || (creator.handle ? `https://www.youtube.com/${creator.handle}` : `https://www.youtube.com/channel/${channelId}`),
          avatar: creator.avatar || asString(asRecord(asRecord(channelSnippet.thumbnails).high).url, creator.avatar ?? ""),
          activityFreshness: {
            status: "fresh",
            source: "youtube.data-api",
            refreshedAtIso,
            nextRefreshPolicy: "daily-0520-asia-seoul",
          },
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtIso: refreshedAtIso,
        }, { merge: true });
        counters.channelStatsUpdated += 1;
      }

      for (const video of videos) {
        const videoId = asString(video.id);
        if (!videoId) continue;
        const snippet = asRecord(video.snippet);
        const statistics = asRecord(video.statistics);
        const contentDetails = asRecord(video.contentDetails);
        const duration = asString(contentDetails.duration);
        const durationSeconds = parseYouTubeDurationSeconds(duration);
        const thumbnails = asRecord(snippet.thumbnails);
        const thumb = asString(asRecord(thumbnails.high).url)
          || asString(asRecord(thumbnails.medium).url)
          || asString(asRecord(thumbnails.default).url);
        const publishedAt = asString(snippet.publishedAt);
        const videoRef = adminDb.collection("videos").doc(videoId);
        // N/10 신규 관측(P8, A10): merge 재기록은 createdAt/createdAtIso를 절대 다시
        // 쓰지 않는다 — 최초 생성 시 1회만 스탬프해서, 기존 영상의 일일 갱신을
        // "신규 노출"로 오집계하지 않게 한다. (read-before-write, idempotent)
        const existingVideoSnap = await videoRef.get();
        const isNewVideo = !existingVideoSnap.exists || !existingVideoSnap.get("createdAtIso");
        batch.set(videoRef, {
          videoId,
          creatorId: activityCreatorId,
          channelId,
          channel: asString(snippet.channelTitle, creator.name ?? "YouTube"),
          title: asString(snippet.title, "Untitled video"),
          description: asString(snippet.description, "").slice(0, 2000),
          views: asNumber(statistics.viewCount),
          likes: asNumber(statistics.likeCount),
          comments: asNumber(statistics.commentCount),
          duration,
          durationSeconds,
          published: publishedAt.slice(0, 10),
          publishedAtIso: publishedAt,
          thumb,
          thumbnailUrl: thumb,
          tag: "자사",
          source: "youtube.data-api",
          url: videoUrl(videoId),
          adClassificationPending: true,
          refreshedAtIso,
          ...(isNewVideo ? { createdAt: FieldValue.serverTimestamp(), createdAtIso: refreshedAtIso } : {}),
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtIso: refreshedAtIso,
        }, { merge: true });
        counters.videosUpdated += 1;

        if (commentsPerVideo > 0 && Date.now() < deadlineMs) {
          // top100(relevance) in-memory 수집(W2 인라인 분석 입력) + creator_comments엔 표시용 top20만 저장.
          const comments = await fetchTopComments(videoId, apiKey, COMMENT_FETCH_CAP);
          for (const item of comments.slice(0, COMMENT_STORE_CAP)) {
            const commentId = asString(item.id);
            const top = asRecord(asRecord(asRecord(item.snippet).topLevelComment).snippet);
            if (!commentId || !asString(top.textDisplay)) continue;
            batch.set(adminDb.collection("creator_comments").doc(commentId), {
              id: commentId,
              creatorId: activityCreatorId,
              channelId,
              videoId,
              author: asString(top.authorDisplayName, "YouTube viewer"),
              authorChannelId: asString(asRecord(top.authorChannelId).value),
              text: asString(top.textDisplay),
              time: asString(top.publishedAt),
              updatedAtIso: asString(top.updatedAt),
              sentiment: sentimentLabel(asString(top.textDisplay)),
              likeCount: asNumber(top.likeCount),
              source: "youtube.data-api",
              url: videoUrl(videoId, commentId),
              refreshedAtIso,
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
            counters.commentsUpdated += 1;
          }
          // W2 인라인 댓글 인사이트: 플래그 on + 실행당 상한/데드라인 내에서만. 초과분/실패는 이월(스윕이 소진). try/catch 격리로 수집 무회귀.
          if (isCommentInsightsEnabled()) {
            const commentInputs = comments
              .map((item) => {
                const top = asRecord(asRecord(asRecord(item.snippet).topLevelComment).snippet);
                return { text: asString(top.textDisplay), author: asString(top.authorDisplayName), likeCount: asNumber(top.likeCount), time: asString(top.publishedAt) };
              })
              .filter((c) => c.text);
            const latestCommentTimeIso = commentInputs.reduce((m, c) => (c.time && c.time > m ? c.time : m), "");
            const totalCommentCount = asNumber(statistics.commentCount) || commentInputs.length;
            try {
              if (commentInputs.length > 0 && commentInsightsAnalyzed < COMMENT_INLINE_VIDEO_CAP && Date.now() < deadlineMs) {
                const r = await analyzeVideoCommentInsights(
                  { videoId, creatorId: activityCreatorId, comments: commentInputs, commentCount: totalCommentCount, latestCommentTimeIso: latestCommentTimeIso || undefined },
                  { analyzeOptions: { useLlm: process.env.FUNCTIONS_EMULATOR !== "true" } },
                );
                if (r.analyzed) commentInsightsAnalyzed += 1;
              } else if (commentInputs.length > 0) {
                await markCommentInsightsPending(videoId);
              }
            } catch (err) {
              console.warn("[comment-insights-inline] failed; carry over", { videoId, error: err instanceof Error ? err.message : String(err) });
              await markCommentInsightsPending(videoId).catch(() => undefined);
            }
          }
        } else if (commentsPerVideo > 0) {
          // RT-10 chunking: 시간 예산을 이미 넘겼으면 이 영상부터는 댓글 수집(네트워크)·
          // LLM 인사이트를 아예 시작하지 않는다 — 이전에는 크리에이터 단위로만 체크해
          // 진행 중인 영상의 댓글 수집/분석이 예산을 그대로 넘겨버렸다. pending 마킹만
          // 하고 다음 스윕(별도 워커)이 이어받는다.
          await markCommentInsightsPending(videoId).catch(() => undefined);
        }
      }

      batch.set(runRef, {
        counters,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      await batch.commit();
      counters.creatorsUpdated += 1;
    } catch (error) {
      counters.errors += 1;
      await adminDb.collection("activity_refresh_errors").doc(`${runId}_${doc.id}`).set({
        runId,
        creatorId: doc.id,
        message: error instanceof Error ? error.message : "unknown-refresh-error",
        createdAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }

  if (!stoppedForTimeBudget) {
    // Finished this run's whole snapshot within budget — clear the resume
    // cursor so the next run starts a fresh pass from the top instead of
    // sitting at the tail forever.
    await ACTIVITY_REFRESH_CURSOR_REF.set({
      resumeAfterCreatorId: null,
      updatedAt: FieldValue.serverTimestamp(),
      updatedAtIso: new Date().toISOString(),
    }, { merge: true });
  }

  const ok = counters.errors === 0;
  await runRef.set({
    id: runId,
    status: stoppedForTimeBudget ? "partial-time-budget" : ok ? "success" : "partial",
    counters,
    finishedAtIso: new Date().toISOString(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { ok, counters };
}
