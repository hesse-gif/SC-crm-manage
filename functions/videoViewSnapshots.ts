// C4 유튜브 링크 일일 스냅샷 모니터링 — 리포트/영상검수 제출물의 YouTube 링크에 대해 매일 조회수/좋아요/
//   댓글수 스냅샷을 적재해 총조회수·일일증분·성장률 시계열을 만든다. 댓글 감성은 기존 videos.commentInsights 재사용.
//   외부호출은 YouTube Data API 서버 프록시(NET-P0-012, makeYouTubeDataApiClient). YouTube API 쿼터 내 배치.
//   클라 직접쓰기 금지(SEC-P0-004) → 스케줄러/콜러블 경유. 순수 산식(computeGrowthSeries)은 DI/테스트 가능.

export type YouTubeVideoStat = { views: number; likes: number; comments: number; publishedAtIso?: string; title?: string; thumbnailUrl?: string; channelTitle?: string; channelId?: string };
type SnapshotPoint = { date: string; views: number; likes: number; comments: number };
export type SeriesPoint = SnapshotPoint & { dailyDeltaViews: number; growthRatePct: number };

// watch?v= / youtu.be/ / shorts / embed / 순수 11자 ID 에서 videoId 추출(순수).
export function extractYouTubeVideoId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/live\/([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

// 시계열: 날짜 오름차순 정렬 → 각 포인트에 전일 대비 일일증분·성장률(%) 부여(순수).
export function computeGrowthSeries(points: readonly SnapshotPoint[]): SeriesPoint[] {
  const sorted = [...points].filter((p) => p && typeof p.date === "string").sort((a, b) => a.date.localeCompare(b.date));
  const out: SeriesPoint[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const p = sorted[i];
    const prev = i > 0 ? sorted[i - 1] : null;
    const dailyDeltaViews = prev ? Math.max(0, (p.views ?? 0) - (prev.views ?? 0)) : 0;
    const growthRatePct = prev && prev.views > 0 ? Number(((dailyDeltaViews / prev.views) * 100).toFixed(2)) : 0;
    out.push({ date: p.date, views: p.views ?? 0, likes: p.likes ?? 0, comments: p.comments ?? 0, dailyDeltaViews, growthRatePct });
  }
  return out;
}

export function snapshotDate(nowIso: string): string {
  // KST 기준 날짜 버킷(피드/발송 시각 표기와 정합).
  return new Date(Date.parse(nowIso) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function snapshotHour(nowIso: string): string {
  // KST 기준 시간 버킷 "YYYY-MM-DDTHH" — CPM 정산용 시간별 트래킹의 키.
  return new Date(Date.parse(nowIso) + 9 * 60 * 60 * 1000).toISOString().slice(0, 13);
}

type FirestoreDocRef = {
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(data: Record<string, unknown>, options: { merge: boolean }): Promise<unknown>;
};
type FirestoreQuery = {
  where(field: string, op: string, value: unknown): FirestoreQuery;
  orderBy(field: string, direction?: "asc" | "desc"): FirestoreQuery;
  startAfter(cursor: unknown): FirestoreQuery;
  limit(count: number): FirestoreQuery;
  get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> | undefined }> }>;
};
type FirestoreDb = { collection(name: string): FirestoreQuery & { doc(id: string): FirestoreDocRef } };
type YouTubeApiLike = {
  videosList(
    params: Record<string, string | number | undefined>,
  ): Promise<{ items?: unknown[] }>;
};

declare const require: ((id: string) => unknown) | undefined;

function reqModule<T>(id: string): T | null {
  if (typeof require !== "function") return null;
  try { return require(id) as T; } catch { return null; }
}
function adminDbRuntime(): FirestoreDb | null {
  return reqModule<{ adminDb: FirestoreDb }>("./firebaseAdmin")?.adminDb ?? null;
}
function youtubeClientRuntime(): YouTubeApiLike | null {
  const mod = reqModule<{ makeYouTubeDataApiClient: () => YouTubeApiLike }>("./youtubeEnrichmentService");
  return mod ? mod.makeYouTubeDataApiClient() : null;
}

type LifecycleRefreshModule = {
  enqueueScpLifecycleRefreshEvent(input: {
    source: string;
    sourceRef: string;
    reason: string;
    aliases?: Array<Record<string, unknown>>;
    sourceUpdatedAtIso?: string;
  }): Promise<unknown>;
};

function lifecycleRefreshRuntime(): LifecycleRefreshModule | null {
  return reqModule<LifecycleRefreshModule>("./scpLifecycleProfiles");
}

async function enqueueVideoSnapshotLifecycleRefresh(input: { videoId: string; submissionId?: string; date: string }) {
  const lifecycle = lifecycleRefreshRuntime();
  if (!lifecycle) throw new Error("lifecycle_refresh_unavailable");
  const aliases = [{ videoId: input.videoId, submissionId: input.submissionId ?? "" }];
  // W46: eventId 는 [source, sourceRef, reason, sourceUpdatedAtIso, aliasIds] 해시이고 아웃박스
  // 쓰기는 merge 다. 여기서 nowIso 를 넘기면 스냅샷이 돌 때마다 새 문서가 쌓여 큐가 무한 누적된다
  // (프로드 적체의 91%가 이 두 source). 날짜 단위로 안정된 값을 넘겨 같은 (영상, 날짜)가 한 문서로
  // 합류하게 한다 — 워커는 큐가 비면 재구축을 건너뛰므로 하트비트는 살리고 누적만 없앤다.
  const sourceUpdatedAtIso = `${input.date}T00:00:00.000Z`;
  await lifecycle.enqueueScpLifecycleRefreshEvent({
    source: "video_view_snapshots",
    sourceRef: `video_view_snapshots/${input.videoId}:${input.date}`,
    reason: "video_view_snapshot_recorded",
    aliases,
    sourceUpdatedAtIso,
  });
  await lifecycle.enqueueScpLifecycleRefreshEvent({
    source: "video_view_series",
    sourceRef: `video_view_series/${input.videoId}`,
    reason: "video_view_series_updated",
    aliases,
    sourceUpdatedAtIso,
  });
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

function statFromVideoItem(item: Record<string, unknown> | undefined): YouTubeVideoStat | null {
  if (!item) return null;
  const s = (item.statistics && typeof item.statistics === "object" ? item.statistics : {}) as Record<string, unknown>;
  const snippet = (item.snippet && typeof item.snippet === "object" ? item.snippet : {}) as Record<string, unknown>;
  const publishedAtIso = typeof snippet.publishedAt === "string" && snippet.publishedAt ? snippet.publishedAt : undefined;
  // snippet 은 이미 받아오고 있었는데 publishedAt 만 쓰고 title/thumbnail 을 버렸다 — 그래서 운영
  // videos 문서 77건이 "XP Hero" 플레이스홀더 제목으로 남아 있었다. 같은 응답을 쓰므로 쿼터 추가 0.
  const thumbs = (snippet.thumbnails && typeof snippet.thumbnails === "object" ? snippet.thumbnails : {}) as Record<string, unknown>;
  const thumbUrl = (key: string): string => {
    const entry = (thumbs[key] && typeof thumbs[key] === "object" ? thumbs[key] : {}) as Record<string, unknown>;
    return typeof entry.url === "string" ? entry.url : "";
  };
  return {
    views: num(s.viewCount),
    likes: num(s.likeCount),
    comments: num(s.commentCount),
    publishedAtIso,
    title: typeof snippet.title === "string" ? snippet.title.trim() : undefined,
    thumbnailUrl: thumbUrl("high") || thumbUrl("medium") || thumbUrl("default") || undefined,
    // 같은 응답에 채널명·채널 id 도 들어 있는데 버리고 있었다. videos.channel 이 비어 있어서
    // 검수 목록이 "채널 미확인"을 띄우던 원인 중 하나 — 추가 API 콜/쿼터 0.
    channelTitle: typeof snippet.channelTitle === "string" ? snippet.channelTitle.trim() : undefined,
    channelId: typeof snippet.channelId === "string" ? snippet.channelId.trim() : undefined,
  };
}

export const VIDEO_STAT_BATCH_SIZE = 50;

/**
 * W8-5a: YouTube videos.list 는 `id` 에 **콤마로 최대 50개**를 넣어도 쿼터 1유닛이다. 예전에는
 * 모니터 1건당 1콜이었고(50 모니터 × 매시 24회 = 1,200유닛/일) 크론을 올릴 수도 없었다.
 * 배칭 패턴은 신설이 아니라 같은 코드베이스의 선례를 그대로 쓴다
 * (youtubeEnrichmentService: `chunks(videoIds, 50)` + `id: chunk.join(",")`).
 *
 * 반환: videoId → 통계. 응답에 없는 id(비공개·삭제)는 **키가 없다** — 호출부가 "영상 부재"와
 * "API 장애"를 계속 구분할 수 있어야 하므로 실패는 청크 단위로 구분해 넘긴다.
 *
 * R8①: 한 청크(최대 50개)가 throw 해도 **이미 성공한 다른 청크의 stats 는 지우지 않는다** —
 * 예전에는 어느 청크든 하나만 throw 하면 함수 전체가 throw 해서 호출부(catch)가 `stats`를
 * 빈 맵으로 되돌려 이미 받아온 결과까지 통째로 버렸다. 이제 실패한 청크만 `chunkFailures`에
 * 기록하고 다음 청크를 계속 처리한다(실패 videoId·사유는 호출부가 그대로 로깅/카운팅한다).
 */
export async function fetchVideoStatsBatch(
  api: YouTubeApiLike,
  videoIds: readonly string[],
): Promise<{
  stats: Map<string, YouTubeVideoStat>;
  apiCalls: number;
  chunkFailures: Array<{ videoIds: string[]; message: string }>;
}> {
  const unique = [...new Set(videoIds.filter((id) => typeof id === "string" && id.length > 0))];
  const stats = new Map<string, YouTubeVideoStat>();
  let apiCalls = 0;
  const chunkFailures: Array<{ videoIds: string[]; message: string }> = [];
  for (let index = 0; index < unique.length; index += VIDEO_STAT_BATCH_SIZE) {
    const chunk = unique.slice(index, index + VIDEO_STAT_BATCH_SIZE);
    apiCalls += 1;
    let res: { items?: unknown[] };
    try {
      res = await api.videosList({ part: "statistics,snippet", id: chunk.join(",") });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      chunkFailures.push({ videoIds: chunk, message });
      console.warn("[video-view-snapshot-batch] chunk failed; other chunks still processed", {
        chunkSize: chunk.length,
        message,
      });
      continue;
    }
    for (const item of res.items ?? []) {
      const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      const stat = statFromVideoItem(record);
      if (id && stat) stats.set(id, stat);
    }
  }
  return { stats, apiCalls, chunkFailures };
}

async function fetchVideoStat(api: YouTubeApiLike, videoId: string): Promise<YouTubeVideoStat | null> {
  const res = await api.videosList({ part: "statistics,snippet", id: videoId });
  return statFromVideoItem((res.items ?? [])[0] as Record<string, unknown> | undefined);
}

// yt-dlp 백업 소스 — Cloud Run 워커가 youtube_videos.viewCount(+viewCountUpdatedAtIso)를
// 갱신한다. YouTube API 실패(쿼터/일시 장애) 시 이 값으로 폴백해 트래킹 공백을 막는다.
async function fetchYtDlpBackupStat(db: FirestoreDb, videoId: string): Promise<{ views: number; updatedAtIso: string } | null> {
  const doc = await db.collection("youtube_videos").doc(videoId).get().catch(() => null);
  if (!doc?.exists) return null;
  const data = (doc.data() ?? {}) as Record<string, unknown>;
  const views = num(data.viewCount);
  const updatedAtIso = typeof data.viewCountUpdatedAtIso === "string" ? data.viewCountUpdatedAtIso : "";
  if (views <= 0) return null;
  return { views, updatedAtIso };
}

export type SnapshotOptions = {
  db?: FirestoreDb;
  api?: YouTubeApiLike;
  /**
   * W8-5a: 스윕이 배치로 미리 받아둔 통계. `stat === null` 은 "응답에 없음(영상 부재)"이고
   * `error` 가 있으면 "API 장애"다 — 단건 경로와 **같은 분기**를 유지하기 위해 둘을 구분해 넘긴다.
   * 이 값이 오면 이 함수는 YouTube API 를 호출하지 않는다(쿼터 0).
   */
  prefetched?: { stat: YouTubeVideoStat | null; error: string | null };
  nowIso?: string;
  limit?: number;
  lifecycleRefresh?: boolean;
  parser?: (value: unknown) => string | null;
};

// 단일 영상 스냅샷: YouTube API(1순위) → yt-dlp 백업(youtube_videos.viewCount, 2순위)으로
//   현재 통계를 얻어 일일 doc(video_view_snapshots/{id}:{date}) + 시간별 doc
//   (video_view_snapshots_hourly/{id}:{dateHour}) + 시계열 롤업(video_view_series/{id})을 갱신한다.
//   CPM 정산 근거: 시간별 버킷·영상 업로드 시각(publishedAtIso)·소스 라벨을 함께 적재하고,
//   두 소스가 동시에 존재하며 20% 이상 어긋나면 divergence 플래그를 남긴다(조회수 보호).
export async function recordVideoViewSnapshot(
  videoId: string,
  opts: SnapshotOptions & { submissionId?: string } = {},
): Promise<{ ok: boolean; videoId: string; date: string; hour?: string; reason?: string; point?: SeriesPoint; source?: string }> {
  const db = opts.db ?? adminDbRuntime();
  const api = opts.api ?? youtubeClientRuntime();
  if (!db || !api) return { ok: false, videoId, date: "", reason: "runtime_unavailable" };
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const date = snapshotDate(nowIso);
  const hour = snapshotHour(nowIso);

  let apiStat: YouTubeVideoStat | null = null;
  let apiError: string | null = null;
  if (opts.prefetched) {
    apiStat = opts.prefetched.stat;
    apiError = opts.prefetched.error;
  } else {
    try {
      apiStat = await fetchVideoStat(api, videoId);
    } catch (error) {
      // 쿼터 초과/일시 장애 — 영상 부재(null)와 구분해 백업 소스로 폴백한다.
      apiError = error instanceof Error ? error.message : String(error);
    }
  }
  const backup = await fetchYtDlpBackupStat(db, videoId);
  if (!apiStat && apiError === null) {
    // API가 정상 응답했지만 영상이 없음(비공개/삭제) — 백업 폴백 없이 정직하게 종료.
    return { ok: false, videoId, date, reason: "video_not_found" };
  }
  if (!apiStat && !backup) {
    return { ok: false, videoId, date, reason: `api_failed_no_backup:${(apiError ?? "").slice(0, 120)}` };
  }
  const source = apiStat ? "youtube_api" : "ytdlp_backup";
  const stat: YouTubeVideoStat = apiStat ?? { views: backup!.views, likes: 0, comments: 0 };
  // 이중 소스 상호검증 — 둘 다 있을 때 20% 초과 괴리는 플래그(운영이 원인 조사).
  const divergencePct = apiStat && backup && apiStat.views > 0
    ? Number(((Math.abs(apiStat.views - backup.views) / apiStat.views) * 100).toFixed(2))
    : null;
  const sourceDiverged = divergencePct !== null && divergencePct > 20;

  await db.collection("video_view_snapshots").doc(`${videoId}:${date}`).set(
    { videoId, date, views: stat.views, likes: stat.likes, comments: stat.comments, source, submissionId: opts.submissionId ?? null, updatedAtIso: nowIso },
    { merge: true },
  );
  // 시간별 버킷 — CPM 정산의 시간 단위 근거. 동일 시각 재실행은 멱등 merge.
  await db.collection("video_view_snapshots_hourly").doc(`${videoId}:${hour}`).set(
    { videoId, date, hour, views: stat.views, likes: stat.likes, comments: stat.comments, source, submissionId: opts.submissionId ?? null, updatedAtIso: nowIso },
    { merge: true },
  );

  const seriesRef = db.collection("video_view_series").doc(videoId);
  const existing = await seriesRef.get();
  const existingData = existing.exists ? existing.data() ?? {} : {};
  const prevPoints = Array.isArray(existingData.points) ? (existingData.points as SnapshotPoint[]) : [];
  const merged = new Map<string, SnapshotPoint>();
  for (const p of prevPoints) if (p && typeof p.date === "string") merged.set(p.date, p);
  merged.set(date, { date, views: stat.views, likes: stat.likes, comments: stat.comments });
  const series = computeGrowthSeries([...merged.values()]);
  const latest = series[series.length - 1];

  // 업로드 시각: API snippet이 1순위, 없으면 기존 값 유지(한 번 기록되면 불변에 가깝게).
  const publishedAtIso = stat.publishedAtIso
    ?? (typeof existingData.publishedAtIso === "string" ? existingData.publishedAtIso : null);

  // 댓글 감성 재사용: 해당 videoId가 피드 videos 문서면 commentInsights를 시계열에 함께 저장.
  let commentInsights: unknown = null;
  const videoDoc = await db.collection("videos").doc(videoId).get().catch(() => null);
  if (videoDoc?.exists) commentInsights = (videoDoc.data() ?? {}).commentInsights ?? null;

  // 같은 API 응답으로 videos 문서의 표시 메타를 정직하게 맞춘다(추가 호출·추가 쿼터 없음).
  // - 문서가 있을 때만 갱신한다: 스냅샷 워커가 피드 컬렉션에 새 문서를 만들지 않는다.
  // - yt-dlp 백업 경로(apiStat 없음)에서는 제목이 없으므로 건드리지 않는다.
  if (apiStat && videoDoc?.exists) {
    const existingVideo = (videoDoc.data() ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (apiStat.title && apiStat.title !== existingVideo.title) patch.title = apiStat.title;
    if (apiStat.thumbnailUrl && apiStat.thumbnailUrl !== existingVideo.thumbnailUrl) {
      patch.thumbnailUrl = apiStat.thumbnailUrl;
      patch.thumb = apiStat.thumbnailUrl;
    }
    if (apiStat.channelTitle && apiStat.channelTitle !== existingVideo.channel) patch.channel = apiStat.channelTitle;
    if (apiStat.channelId && apiStat.channelId !== existingVideo.channelId) patch.channelId = apiStat.channelId;
    if (apiStat.views !== existingVideo.views) patch.views = apiStat.views;
    if (apiStat.likes !== existingVideo.likes) patch.likes = apiStat.likes;
    if (apiStat.comments !== existingVideo.comments) patch.comments = apiStat.comments;
    if (Object.keys(patch).length > 0) {
      await db.collection("videos").doc(videoId).set(
        { ...patch, metricsSyncedAtIso: nowIso, updatedAtIso: nowIso },
        { merge: true },
      );
    }
  }

  await seriesRef.set({
    videoId,
    points: series,
    totalViews: latest?.views ?? 0,
    latestDailyDeltaViews: latest?.dailyDeltaViews ?? 0,
    latestGrowthRatePct: latest?.growthRatePct ?? 0,
    dayCount: series.length,
    lastHour: hour,
    source,
    ...(publishedAtIso ? { publishedAtIso } : {}),
    ...(divergencePct !== null ? { sourceDivergencePct: divergencePct, sourceDiverged } : {}),
    ...(opts.submissionId ? { submissionId: opts.submissionId } : {}),
    ...(commentInsights ? { commentInsights } : {}),
    updatedAtIso: nowIso,
  }, { merge: true });

  await updateViewRollup(db, {
    videoId,
    submissionId: opts.submissionId,
    totalViews: latest?.views ?? 0,
    latestDailyDeltaViews: latest?.dailyDeltaViews ?? 0,
    publishedAtIso,
    nowIso,
  });

  if (opts.lifecycleRefresh === true || (opts.lifecycleRefresh !== false && !opts.db)) {
    await enqueueVideoSnapshotLifecycleRefresh({ videoId, submissionId: opts.submissionId, date });
  }

  return { ok: true, videoId, date, hour, point: latest, source };
}

export const VIDEO_VIEW_ROLLUPS_COLLECTION = "video_view_rollups";

function rollupKey(programId: string, campaignId: string): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "unassigned";
  return `${clean(programId)}__${clean(campaignId)}`;
}

// 프로그램 > 캠페인 롤업 — 발송 구조 그대로 조회수 총합을 집계해 피드·리포트가
// 같은 문서를 읽는다(CPM 정산의 집계 근거). videos 맵은 캠페인 규모에 비례(상한 500).
export async function updateViewRollup(db: FirestoreDb, input: {
  videoId: string;
  submissionId?: string;
  totalViews: number;
  latestDailyDeltaViews: number;
  publishedAtIso: string | null;
  nowIso: string;
}): Promise<void> {
  if (!input.submissionId) return;
  const submissionDoc = await db.collection("submissions").doc(input.submissionId).get().catch(() => null);
  if (!submissionDoc?.exists) return;
  const submission = (submissionDoc.data() ?? {}) as Record<string, unknown>;
  const programId = typeof submission.programId === "string" && submission.programId ? submission.programId : "unassigned";
  const campaignId = typeof submission.campaign === "string" && submission.campaign
    ? submission.campaign
    : typeof submission.campaignId === "string" && submission.campaignId ? submission.campaignId : "unassigned";
  const creator = typeof submission.email === "string" ? submission.email : "";
  const submittedAtIso = typeof submission.submittedAtIso === "string"
    ? submission.submittedAtIso
    : typeof submission.createdAtIso === "string" ? submission.createdAtIso : "";

  const ref = db.collection(VIDEO_VIEW_ROLLUPS_COLLECTION).doc(rollupKey(programId, campaignId));
  const existing = await ref.get();
  const data = existing.exists ? existing.data() ?? {} : {};
  const videos = (data.videos && typeof data.videos === "object" && !Array.isArray(data.videos)
    ? { ...(data.videos as Record<string, unknown>) }
    : {}) as Record<string, Record<string, unknown>>;
  if (!videos[input.videoId] && Object.keys(videos).length >= 500) return;
  videos[input.videoId] = {
    videoId: input.videoId,
    submissionId: input.submissionId,
    creator,
    totalViews: input.totalViews,
    latestDailyDeltaViews: input.latestDailyDeltaViews,
    publishedAtIso: input.publishedAtIso ?? null,
    submittedAtIso,
    updatedAtIso: input.nowIso,
  };
  let totalViews = 0;
  for (const entry of Object.values(videos)) {
    const views = entry && typeof entry.totalViews === "number" ? entry.totalViews : 0;
    totalViews += Number.isFinite(views) ? views : 0;
  }
  await ref.set({
    programId,
    campaignId,
    videos,
    totalViews,
    videoCount: Object.keys(videos).length,
    updatedAtIso: input.nowIso,
  }, { merge: true });
}

export type SnapshotQueueResult = {
  ok: boolean;
  reason?: string;
  scanned: number;
  registered: number;
  linkedSubmissions: number;
  invalidUrls: number;
  cycleComplete: boolean;
  attempted: number;
  snapshotted: number;
  skippedFresh: number;
  failed: number;
  unavailable: number;
  /** W8-5a: 이번 실행이 쓴 YouTube videos.list 콜 수(= 쿼터 유닛). ⌈due/50⌉ 이어야 한다. */
  apiCalls: number;
  /** R4: 이번 실행이 reconcile 패스를 돌렸는지(5분마다가 아니라 1시간마다 돈다). */
  reconcileRan: boolean;
  /** R4: 이번 실행이 레거시(submissions) 등록 패스를 돌렸는지. canonical 등록은 매 실행 돈다. */
  legacyRegisterRan: boolean;
};

export const VIDEO_VIEW_MONITORS_COLLECTION = "video_view_monitors";
export const VIDEO_VIEW_MONITOR_STATE_DOC = "scan";
export const VIDEO_VIEW_MONITOR_STATE_COLLECTION = "video_view_monitor_state";
export const MONITOR_EPOCH_ATTEMPT_ISO = "1970-01-01T00:00:00.000Z";
// retired 모니터는 lastAttemptAtIso를 far-future로 밀어 공정 로테이션 정렬에서
// 자연히 맨 뒤로 보낸다(복합 인덱스 없이 상태 제외를 달성). 수동 재시도가 리셋한다.
export const MONITOR_RETIRED_ATTEMPT_ISO = "9999-12-31T00:00:00.000Z";
export const MONITOR_RETIRE_AFTER_FAILURES = 14;
/**
 * W8-FINAL R3: 은퇴 판정에는 **경과 시간 하한**도 함께 걸린다.
 *
 * 예전에는 실패 횟수(14회)만 봤다. 스냅샷 크론이 시간당일 때는 14회 = 840분이라 사실상 "반나절 넘게
 * 못 찍으면 은퇴"였는데, W8-5c 에서 크론을 5분으로 올리자 같은 14회가 **70~80분**이 됐다 —
 * 일시적 쿼터/네트워크 장애로도 CPM 정산 근거 모니터가 영구 은퇴하고, 복구는 영상별 수동뿐이었다.
 * 시간 하한을 두면 크론 주기를 어떻게 바꿔도 은퇴 시점이 흔들리지 않는다(횟수·시간 **둘 다** 충족).
 */
export const MONITOR_RETIRE_AFTER_MS = 14 * 60 * 60 * 1000;
/**
 * R4: reconcile 패스 최소 간격. 스냅샷 크론은 5분(승인→첫 수집 SLO)이지만 reconcile 은 모니터
 * 1건당 문서 get 을 하는 무거운 패스라 매 실행 돌릴 이유가 없다 — 은퇴/부활 판정은 시간 단위면 충분하다.
 */
export const MONITOR_RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
/**
 * R4: 레거시(submissions 시트 계열) 등록 패스 최소 간격. 새 승인은 canonical review-state 경로로
 * 들어오므로 이 백필 스캔은 5분마다 돌 필요가 없다(승인→첫 스냅샷 SLO 와 무관).
 */
export const MONITOR_LEGACY_REGISTER_INTERVAL_MS = 60 * 60 * 1000;
const VIDEO_PERFORMANCE_REPORT_ROWS_COLLECTION = "video_performance_report_rows";
const LEGACY_SHEET_SUBMISSION_PREFIX = "legacy_sheet_youtube_";
const LEGACY_SHEET_MANIFEST_PREFIX = "legacy_sheet_content_projection:";
/**
 * A-VV: canonical 모니터 등록의 조회·쓰기 병렬도. 이 패스는 5분 크론이 매 실행 돌리는
 * SLO 경로라(승인 → 첫 스냅샷 5분) 빈도를 못 줄인다 — 대신 직렬 왕복을 없앤다.
 * 8 은 같은 레포 `CAMPAIGN_EVIDENCE_QUERY_CONCURRENCY` 와 같은 값이다(검증된 상한).
 */
export const MONITOR_REGISTER_CONCURRENCY = 8;

/** 유계 병렬 map — 리필 마감과 결합된 admin.ts 헬퍼를 쓰지 않으려고 여기 둔다(의존 0). */
async function mapWithBoundedConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(items.length, Math.trunc(concurrency) || 1));
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => run()));
}

/**
 * A-VV 무변경 스킵 판정. `updatedAtIso` 는 매 pass 달라지므로 **비교에서 제외**한다 —
 * 포함하면 판정이 항상 "변경"이 되어 스킵이 무력해진다. 이 컬렉션에서 그 값을 정렬·필터에
 * 쓰는 소비처는 없다.
 */
function monitorPayloadDiffers(
  current: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(payload)) {
    if (key === "updatedAtIso") continue;
    const existing = current[key];
    if (Array.isArray(value) || Array.isArray(existing)) {
      if (JSON.stringify(existing ?? null) !== JSON.stringify(value ?? null)) return true;
      continue;
    }
    if ((existing ?? null) !== (value ?? null)) return true;
  }
  return false;
}

const DEFAULT_SCAN_LIMIT = 500;
const DEFAULT_SNAPSHOT_LIMIT = 50;

type SubmissionUrlParser = (value: unknown) => string | null;

// 정식 YouTube 제출 URL 정규화 재사용(approved-feed와 동일 파서 — host 검증 포함).
// 별도 파서를 두지 않는다: lookalike host는 여기서 걸러진다.
function submissionUrlParserRuntime(): SubmissionUrlParser | null {
  const mod = reqModule<{ extractYouTubeVideoIdFromSubmissionUrl: SubmissionUrlParser }>("./scpApprovedFeed");
  return mod ? mod.extractYouTubeVideoIdFromSubmissionUrl : null;
}

export function submissionYouTubeVideoId(
  submission: Record<string, unknown>,
  parser?: SubmissionUrlParser,
): { videoId: string | null; hadUrl: boolean } {
  const parse = parser ?? submissionUrlParserRuntime();
  if (!parse) throw new Error("submission_url_parser_unavailable");
  const candidates = [submission.youtubeUrl, submission.videoUrl, submission.reviewUrl];
  let hadUrl = false;
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      hadUrl = true;
      const videoId = parse(candidate);
      if (videoId) return { videoId, hadUrl };
    }
  }
  return { videoId: null, hadUrl };
}

function uniqueStrings(values: unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value === "string" && value && !out.includes(value)) out.push(value);
  }
  return out;
}

type ScanState = { cursorDocId: string };

async function readScanState(db: FirestoreDb): Promise<ScanState> {
  const doc = await db.collection(VIDEO_VIEW_MONITOR_STATE_COLLECTION).doc(VIDEO_VIEW_MONITOR_STATE_DOC).get();
  const data = doc.exists ? doc.data() ?? {} : {};
  return { cursorDocId: typeof data.cursorDocId === "string" ? data.cursorDocId : "" };
}

// 제출물 스캔 등록 패스 — 문서 ID 순 + 커서로 결정적 페이지네이션. 500개 상한이던
// 무순서 단발 스캔을 대체한다: 매 실행이 커서를 전진시키고 끝에 닿으면 커서를
// 리셋해 전체를 주기적으로 재순회하므로, 제출물 수와 무관하게 모든 제출물이
// 유한 시간 안에 모니터로 등록된다(영구 누락 불가).
export async function registerVideoViewMonitors(opts: {
  db: FirestoreDb;
  nowIso: string;
  scanLimit?: number;
  parser?: SubmissionUrlParser;
}): Promise<{ scanned: number; registered: number; linkedSubmissions: number; invalidUrls: number; skippedNotApproved: number; cycleComplete: boolean }> {
  const { db, nowIso } = opts;
  const scanLimit = opts.scanLimit ?? DEFAULT_SCAN_LIMIT;
  const state = await readScanState(db);

  let query = db.collection("submissions").orderBy("__name__", "asc");
  if (state.cursorDocId) query = query.startAfter(state.cursorDocId);
  const snap = await query.limit(scanLimit).get();
  const docs = snap.docs ?? [];

  let registered = 0;
  let linkedSubmissions = 0;
  let invalidUrls = 0;
  let skippedNotApproved = 0;
  for (const d of docs) {
    const data = d.data() ?? {};
    const { videoId, hadUrl } = submissionYouTubeVideoId(data, opts.parser);
    if (!videoId) {
      if (hadUrl) invalidUrls += 1;
      continue;
    }
    // Approved-only tracking invariant (TASK 6): only approved, non-revoked, non-deleted, non-private
    // submissions get a tracking target. Pending/rejected/human_required/failed/private/deleted/revoked
    // videos are never registered. Retirement of already-tracked non-approved videos is handled by
    // reconcileVideoViewMonitors.
    if (!isVideoViewTrackable(data)) {
      skippedNotApproved += 1;
      continue;
    }
    const monitorRef = db.collection(VIDEO_VIEW_MONITORS_COLLECTION).doc(videoId);
    const existing = await monitorRef.get();
    const current = existing.exists ? existing.data() ?? {} : {};
    const submissionIds = uniqueStrings([
      ...(Array.isArray(current.submissionIds) ? current.submissionIds : []),
      d.id,
    ]);
    if (!existing.exists) registered += 1;
    else if (submissionIds.length !== (Array.isArray(current.submissionIds) ? current.submissionIds.length : 0)) linkedSubmissions += 1;
    await monitorRef.set({
      videoId,
      submissionIds,
      primarySubmissionId: typeof current.primarySubmissionId === "string" && current.primarySubmissionId
        ? current.primarySubmissionId
        : d.id,
      status: typeof current.status === "string" && current.status ? current.status : "active",
      registeredAtIso: typeof current.registeredAtIso === "string" && current.registeredAtIso ? current.registeredAtIso : nowIso,
      // First-approval timestamp anchors the TASK 6 adaptive snapshot cadence, set ONLY for
      // review-approved submissions (non-review report/rollup videos keep the per-hour cadence).
      ...(data.reviewStatus === "approved"
        ? { approvedAtIso: typeof current.approvedAtIso === "string" && current.approvedAtIso ? current.approvedAtIso : nowIso }
        : {}),
      lastAttemptAtIso: typeof current.lastAttemptAtIso === "string" && current.lastAttemptAtIso
        ? current.lastAttemptAtIso
        : MONITOR_EPOCH_ATTEMPT_ISO,
      retryCount: typeof current.retryCount === "number" ? current.retryCount : 0,
      updatedAtIso: nowIso,
    }, { merge: true });
  }

  const cycleComplete = docs.length < scanLimit;
  await db.collection(VIDEO_VIEW_MONITOR_STATE_COLLECTION).doc(VIDEO_VIEW_MONITOR_STATE_DOC).set({
    cursorDocId: cycleComplete ? "" : docs[docs.length - 1]?.id ?? "",
    lastRunAtIso: nowIso,
    ...(cycleComplete ? { cycleCompletedAtIso: nowIso } : {}),
  }, { merge: true });

  return { scanned: docs.length, registered, linkedSubmissions, invalidUrls, skippedNotApproved, cycleComplete };
}

// Approved-only tracking invariant (TASK 6). Scoped to REVIEW-GATED submissions: a submission that
// carries a review lifecycle (non-empty reviewStatus) is trackable only when reviewStatus==approved.
// Explicit revoked/deleted/private always block. Submissions with no review lifecycle (e.g. report /
// campaign-rollup tracking) keep the deployed behavior and remain trackable, so this strengthening
// does not break non-review view tracking.
export function isVideoViewTrackable(submission: Record<string, unknown>): boolean {
  if (submission.revoked === true || submission.deleted === true || submission.private === true) return false;
  const reviewStatus = submission.reviewStatus;
  if (typeof reviewStatus === "string" && reviewStatus.trim() !== "") {
    return reviewStatus === "approved";
  }
  return true;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

// Legacy Sheet imports intentionally did not fabricate `submissions` documents. Their approval evidence
// instead lives in the exact approved-current report projection created from the historical human decision.
// This predicate accepts only that lineage and leaves `isVideoViewTrackable` unchanged.
export function isLegacySheetApprovedReportTrackingEvidence(
  report: Record<string, unknown>,
  videoId: string,
): boolean {
  const video = objectRecord(report.video);
  const historicalImport = objectRecord(report.historicalImport);
  return (
    extractYouTubeVideoId(videoId) === videoId &&
    report.reportEligible === true &&
    report.isCurrentRevision === true &&
    report.isApproved === true &&
    report.descriptive === false &&
    report.authoritativeProjection === "approved_current_v3" &&
    video.youtubeVideoId === videoId &&
    video.videoSubmissionId === `${LEGACY_SHEET_SUBMISSION_PREFIX}${videoId}` &&
    typeof historicalImport.sourceManifestId === "string" &&
    historicalImport.sourceManifestId.startsWith(LEGACY_SHEET_MANIFEST_PREFIX)
  );
}

async function hasLegacySheetApprovedReportTrackingEvidence(
  db: FirestoreDb,
  videoId: string,
): Promise<boolean> {
  if (extractYouTubeVideoId(videoId) !== videoId) return false;
  const legacySubmissionId = `${LEGACY_SHEET_SUBMISSION_PREFIX}${videoId}`;
  const snap = await db
    .collection(VIDEO_PERFORMANCE_REPORT_ROWS_COLLECTION)
    .where("video.videoSubmissionId", "==", legacySubmissionId)
    .limit(5)
    .get();
  return (snap.docs ?? []).some((doc) =>
    isLegacySheetApprovedReportTrackingEvidence(doc.data() ?? {}, videoId));
}

// ---- B2-8 브릿지: canonical current review head → view monitor 등록 ------------------------------
//
// canonical 검수 경로는 제출 즉시 `scp_video_review_state` current head 를 만들지만, 기존 등록기는
// `approved + downstream confirmed + trackingEligible` 이후만 모니터를 만들었다. 그래서 검수 대기
// 동안의 조회수는 영구적으로 복구할 수 없었다.
//
// 수집과 정산 자격을 분리한다:
//   - 조회수 수집: 유효한 current head 이면 판정 전/후 상태와 무관하게 시작한다.
//   - 정산/리포트: 기존 approved-current + downstream/reportEligible 게이트를 그대로 유지한다.
// legacy `submissions` 등록기의 approved-only 규칙도 그대로라, 이 변경이 과거 시트/롤업 경로의
// 정산 universe 를 넓히지 않는다.
const SCP_VIDEO_REVIEW_STATE_COLLECTION_NAME = "scp_video_review_state";
const COLLECTABLE_CANONICAL_REVIEW_STATES = new Set([
  "queued",
  "in_review",
  "changes_requested",
  "human_review_required",
  "rejected",
  "approved",
  // legacy-compatible current heads. Transition reads normalize these to the canonical values.
  "pending",
  "needs_review",
]);

export function isCanonicalReviewStateTrackingEvidence(
  head: Record<string, unknown>,
  videoId: string,
): boolean {
  const headVideoId = typeof head.youtubeVideoId === "string" ? head.youtubeVideoId : "";
  const state = typeof head.state === "string" ? head.state.trim() : "";
  return (
    extractYouTubeVideoId(videoId) === videoId &&
    COLLECTABLE_CANONICAL_REVIEW_STATES.has(state) &&
    head.withdrawn !== true &&
    head.superseded !== true &&
    extractYouTubeVideoId(headVideoId) === videoId
  );
}

async function hasCanonicalReviewStateTrackingEvidence(
  db: FirestoreDb,
  videoId: string,
): Promise<boolean> {
  if (extractYouTubeVideoId(videoId) !== videoId) return false;
  // 단일 필드 동등 조건만 쓴다(복합 인덱스 요구 금지) — 나머지는 메모리에서 판정한다.
  const snap = await db
    .collection(SCP_VIDEO_REVIEW_STATE_COLLECTION_NAME)
    .where("youtubeVideoId", "==", videoId)
    .limit(5)
    .get();
  return (snap.docs ?? []).some((doc) =>
    isCanonicalReviewStateTrackingEvidence(doc.data() ?? {}, videoId));
}

/**
 * canonical current head 를 제출 직후 모니터로 등록하는 패스. `submissions` 스캔과 독립 커서를
 * 쓰고, 모니터 문서 모양·id 규칙(doc id === videoId)은 완전히 동일하다.
 */
export async function registerCanonicalReviewStateMonitors(opts: {
  db: FirestoreDb;
  nowIso: string;
  scanLimit?: number;
  /**
   * 2026-09-27 비용 감사: 호출부(processVideoViewSnapshotQueue)가 같은 tick 안에서 이미 이
   * 상태 문서를 읽었으면 그 값을 넘겨 여기서 또 읽지 않는다(같은 문서를 한 invocation 에서 3번
   * 읽던 것 중 하나). 생략하면(단독 호출·테스트) 종전처럼 이 함수가 직접 읽는다 — 동작은
   * 그대로다.
   */
  precomputedCursorDocId?: string;
}): Promise<{ scanned: number; registered: number; linkedSubmissions: number; skippedNotEligible: number; cycleComplete: boolean }> {
  const { db, nowIso } = opts;
  const scanLimit = opts.scanLimit ?? DEFAULT_SCAN_LIMIT;
  let cursorDocId = opts.precomputedCursorDocId ?? "";
  if (opts.precomputedCursorDocId === undefined) {
    const stateDoc = await db
      .collection(VIDEO_VIEW_MONITOR_STATE_COLLECTION)
      .doc(VIDEO_VIEW_MONITOR_STATE_DOC)
      .get();
    const stateData = stateDoc.exists ? stateDoc.data() ?? {} : {};
    cursorDocId = typeof stateData.canonicalCursorDocId === "string" ? stateData.canonicalCursorDocId : "";
  }

  let query = db.collection(SCP_VIDEO_REVIEW_STATE_COLLECTION_NAME).orderBy("__name__", "asc");
  if (cursorDocId) query = query.startAfter(cursorDocId);
  const snap = await query.limit(scanLimit).get();
  const docs = snap.docs ?? [];

  let registered = 0;
  let linkedSubmissions = 0;
  let skippedNotEligible = 0;

  // A-VV [CPU 근인 · 2026-08-29]: 이 루프는 문서마다 `await get()` → `await set()` 을 **직렬로**
  // 돌았다. 프로드 실측: `scp_video_review_state` 201건이 `limit 500` 미만이라 매 pass 전량이
  // 대상이고, 왕복 약 400회가 통째로 벽시계에 실려 **호출당 134초**(38,318 vCPU-초/일 = 월 $28,
  // 전체 CPU 의 17%)가 됐다. YouTube API 대기가 아니라 Firestore 왕복이었다.
  //
  // ⚠️ **간격 게이트는 답이 아니다.** 같은 파일의 레거시 등록·reconcile 에는 게이트가 있지만 이
  //   경로에는 의도적으로 없다 — R4 주석대로 **새 승인이 들어오는 canonical 경로**라 "승인 → 첫
  //   스냅샷 5분 SLO" 를 이 패스가 담당한다. 게이트를 걸면 그 SLO 가 깨진다. 그래서 빈도는 그대로
  //   두고 **왕복만** 없앤다(성능 저하 0).
  //
  // 순서 의미 보존: 같은 videoId 를 가리키는 review-state 문서가 둘 이상이면 종전에는 뒤 문서가 앞
  // 문서의 쓰기를 읽었다. 아래는 조회를 배치로 당기되 판정은 **문서 순서대로** 돌면서 로컬 상태를
  // 갱신해 그 읽기-후-쓰기 의미를 그대로 재현한다.
  const eligible: { videoId: string; submissionId: string; head: Record<string, unknown> }[] = [];
  for (const doc of docs) {
    const head = doc.data() ?? {};
    const rawVideoId = typeof head.youtubeVideoId === "string" ? head.youtubeVideoId : "";
    const videoId = extractYouTubeVideoId(rawVideoId);
    if (!videoId || !isCanonicalReviewStateTrackingEvidence(head, videoId)) {
      skippedNotEligible += 1;
      continue;
    }
    eligible.push({
      videoId,
      submissionId: typeof head.videoSubmissionId === "string" && head.videoSubmissionId
        ? head.videoSubmissionId
        : doc.id,
      head,
    });
  }

  // 유니크 videoId 만 한 번씩, 유계 병렬로 조회한다(직렬 200회 → 라운드 몇 번).
  const uniqueVideoIds = [...new Set(eligible.map((item) => item.videoId))];
  const currentByVideoId = new Map<string, { exists: boolean; data: Record<string, unknown> }>();
  await mapWithBoundedConcurrency(uniqueVideoIds, MONITOR_REGISTER_CONCURRENCY, async (videoId) => {
    const snapshot = await db.collection(VIDEO_VIEW_MONITORS_COLLECTION).doc(videoId).get();
    currentByVideoId.set(videoId, {
      exists: Boolean(snapshot.exists),
      data: snapshot.exists ? snapshot.data() ?? {} : {},
    });
  });

  const writes: { videoId: string; payload: Record<string, unknown> }[] = [];
  for (const { videoId, submissionId, head } of eligible) {
    const snapshot = currentByVideoId.get(videoId) ?? { exists: false, data: {} };
    const existing = { exists: snapshot.exists };
    const current = snapshot.data;
    const restorePolicyRetired =
      current.status === "retired" &&
      current.retiredReason === "no_approved_submission";
    const submissionIds = uniqueStrings([
      ...(Array.isArray(current.submissionIds) ? current.submissionIds : []),
      submissionId,
    ]);
    if (!existing.exists) registered += 1;
    else if (submissionIds.length !== (Array.isArray(current.submissionIds) ? current.submissionIds.length : 0)) {
      linkedSubmissions += 1;
    }
    const payload: Record<string, unknown> = {
      videoId,
      submissionIds,
      primarySubmissionId: typeof current.primarySubmissionId === "string" && current.primarySubmissionId
        ? current.primarySubmissionId
        : submissionId,
      status: restorePolicyRetired
        ? "active"
        : typeof current.status === "string" && current.status ? current.status : "active",
      registeredAtIso: typeof current.registeredAtIso === "string" && current.registeredAtIso
        ? current.registeredAtIso
        : nowIso,
      // 승인 전에는 approvedAtIso 를 만들지 않는다. 승인된 뒤의 첫 패스에서만 세워 기존
      // 15분/1시간 adaptive cadence 와 "첫 승인 시각" 의미를 보존한다.
      ...(head.state === "approved"
        ? {
            approvedAtIso: typeof current.approvedAtIso === "string" && current.approvedAtIso
              ? current.approvedAtIso
              : nowIso,
          }
        : {}),
      registrationSource: typeof current.registrationSource === "string" && current.registrationSource
        ? current.registrationSource
        : "scp_video_review_state",
      lastAttemptAtIso: restorePolicyRetired
        ? MONITOR_EPOCH_ATTEMPT_ISO
        : typeof current.lastAttemptAtIso === "string" && current.lastAttemptAtIso
          ? current.lastAttemptAtIso
          : MONITOR_EPOCH_ATTEMPT_ISO,
      retryCount: typeof current.retryCount === "number" ? current.retryCount : 0,
      ...(restorePolicyRetired
        ? {
            retiredReason: null,
            staleWatermark: false,
            staleSinceIso: null,
          }
        : {}),
      updatedAtIso: nowIso,
    };
    // 무변경 스킵: `updatedAtIso` 를 뺀 나머지가 현재와 같으면 쓰지 않는다. 종전에는 값이 그대로여도
    // 매 pass 재기록해 쓰기 200건이 통째로 낭비였다. `updatedAtIso` 를 비교에서 빼는 이유는 그
    // 필드만 매번 달라져 비교가 항상 "변경"이 되기 때문이고, 이 컬렉션에서 그 값을 정렬·필터에 쓰는
    // 소비처는 없다(파일 전수 확인). pass 실행 기록은 아래 state 문서 canonicalLastRunAtIso 가 남긴다.
    if (monitorPayloadDiffers(current, payload)) {
      writes.push({ videoId, payload });
      // 같은 pass 에서 같은 videoId 가 또 나오면 이 결과를 읽어야 종전 직렬 의미와 같다.
      currentByVideoId.set(videoId, { exists: true, data: { ...current, ...payload } });
    }
  }

  await mapWithBoundedConcurrency(writes, MONITOR_REGISTER_CONCURRENCY, async ({ videoId, payload }) => {
    await db.collection(VIDEO_VIEW_MONITORS_COLLECTION).doc(videoId).set(payload, { merge: true });
  });

  const cycleComplete = docs.length < scanLimit;
  await db.collection(VIDEO_VIEW_MONITOR_STATE_COLLECTION).doc(VIDEO_VIEW_MONITOR_STATE_DOC).set({
    canonicalCursorDocId: cycleComplete ? "" : docs[docs.length - 1]?.id ?? "",
    canonicalLastRunAtIso: nowIso,
    ...(cycleComplete ? { canonicalCycleCompletedAtIso: nowIso } : {}),
  }, { merge: true });

  return { scanned: docs.length, registered, linkedSubmissions, skippedNotEligible, cycleComplete };
}

// TASK 6 adaptive cadence: within 24h of approval snapshot every 15 min; after 24h hourly. Deploy the
// snapshot schedule at <=5 min cadence so approval->first-snapshot latency meets the 5-minute SLO
// (the first snapshot, never attempted, is always due).
export function videoViewSnapshotAdaptiveIntervalMs(approvedAtIso: string, nowIso: string): number {
  const hoursSinceApproval = (Date.parse(nowIso) - Date.parse(approvedAtIso)) / 3_600_000;
  return Number.isFinite(hoursSinceApproval) && hoursSinceApproval < 24 ? 15 * 60_000 : 60 * 60_000;
}

// Whether an approved monitor is due for a snapshot under the adaptive cadence. Non-approved (report /
// rollup) monitors have no approvedAtIso and defer to the caller's default per-hour gate (returns true).
export function isVideoViewSnapshotDue(monitor: Record<string, unknown>, nowIso: string): boolean {
  const approvedAtIso = typeof monitor.approvedAtIso === "string" ? monitor.approvedAtIso : "";
  if (!approvedAtIso) return true;
  const attempt = typeof monitor.lastAttemptAtIso === "string" ? monitor.lastAttemptAtIso : MONITOR_EPOCH_ATTEMPT_ISO;
  if (attempt === MONITOR_RETIRED_ATTEMPT_ISO) return false;
  if (attempt === MONITOR_EPOCH_ATTEMPT_ISO) return true; // first snapshot is always due
  // W8-5b: 기준 시각은 **마지막 성공 수집**이다. 예전에는 lastAttemptAtIso 로 재는데 skip(fresh)도
  // 그 필드를 갱신해서, 크론 주기를 적응형 간격(15분)과 같거나 짧게 만들면 매 실행이 시계를 밀어
  // **영원히 due 가 되지 않는** 구조였다(시간당 크론에서는 60분 간격이라 드러나지 않았다).
  // 성공 시각이 없는 레거시 문서는 기존 동작(시도 시각)으로 폴백한다.
  const lastSuccess = typeof monitor.lastSuccessAtIso === "string" && monitor.lastSuccessAtIso
    ? monitor.lastSuccessAtIso
    : attempt;
  return Date.parse(nowIso) - Date.parse(lastSuccess) >= videoViewSnapshotAdaptiveIntervalMs(approvedAtIso, nowIso);
}

// Reconciliation pass: legacy `submissions` 는 approved-only 규칙을 유지하되, canonical current
// review head 가 있으면 판정 상태와 무관하게 수집 근거로 인정한다. Duplicate tracking targets are
// structurally impossible: a monitor doc id IS the videoId, so one video maps to exactly one monitor.
export async function reconcileVideoViewMonitors(opts: {
  db: FirestoreDb;
  nowIso: string;
  scanLimit?: number;
  staleAfterMs?: number;
}): Promise<{ scanned: number; retired: number; reactivated: number; stale: number; healthy: number }> {
  const { db, nowIso } = opts;
  const scanLimit = opts.scanLimit ?? DEFAULT_SCAN_LIMIT;
  // R3③: 크론이 5분(W8-5c)이고 적응형 간격은 승인 24h 내 15분 / 이후 1시간이다. 그래서 "1시간
  // 간격의 2배"였던 2h 하한을 유지한다 — 크론 주기가 아니라 **가장 느린 cadence(1시간)** 기준이라는
  // 뜻을 주석에 박아둔다(주기를 또 바꿀 때 이 값을 같이 보게 한다).
  const staleAfterMs = opts.staleAfterMs ?? 2 * 60 * 60 * 1000; // slowest cadence(1h) * 2
  const monitors = db.collection(VIDEO_VIEW_MONITORS_COLLECTION);
  const snap = await monitors.orderBy("__name__", "asc").limit(scanLimit).get();
  const docs = snap.docs ?? [];
  let retired = 0;
  let reactivated = 0;
  let stale = 0;
  let healthy = 0;
  for (const monitorDoc of docs) {
    const monitor = monitorDoc.data() ?? {};
    const submissionIds = Array.isArray(monitor.submissionIds) ? monitor.submissionIds : [];
    let anyTrackable = false;
    for (const submissionId of submissionIds) {
      const submissionSnap = await db.collection("submissions").doc(String(submissionId)).get();
      if (submissionSnap.exists && isVideoViewTrackable(submissionSnap.data() ?? {})) {
        anyTrackable = true;
        break;
      }
    }
    if (!anyTrackable) {
      anyTrackable = await hasLegacySheetApprovedReportTrackingEvidence(db, monitorDoc.id);
    }
    if (!anyTrackable) {
      // canonical current head 는 queued/rejected 포함 모든 판정 상태에서 수집을 유지한다.
      // withdrawn/superseded 만 근거에서 제외되어 이전 revision 영상은 정상 은퇴한다.
      anyTrackable = await hasCanonicalReviewStateTrackingEvidence(db, monitorDoc.id);
    }
    const ref = monitors.doc(monitorDoc.id);
    const status = typeof monitor.status === "string" ? monitor.status : "active";
    if (!anyTrackable && status !== "retired") {
      await ref.set({
        status: "retired",
        retiredReason: "no_approved_submission",
        lastAttemptAtIso: MONITOR_RETIRED_ATTEMPT_ISO,
        // R3②: 은퇴는 조용히 끝나면 안 된다 — 추적이 멈춘 사실을 워터마크로 남겨 운영이 본다
        // (예전에는 far-future 시계 때문에 stale 판정도 건너뛰어 무알람이었다).
        staleWatermark: true,
        staleSinceIso: nowIso,
        updatedAtIso: nowIso,
      }, { merge: true });
      retired += 1;
      continue;
    }
    // R3②: 예전에는 `status === "retired"`(승인 제출물 상실)만 되살렸다. 그래서 일시 장애로
    // `retired_unavailable` 이 된 모니터는 **자동 부활 경로가 없었고**(복구는 영상별 수동 클릭뿐),
    // lastAttemptAtIso 가 far-future 라 아래 stale 판정도 건너뛰어 healthy 로 오집계됐다.
    // 승인 근거가 살아 있으면 두 은퇴 상태 모두 되살린다(실패 시계도 초기화).
    if (anyTrackable && (status === "retired" || status === "retired_unavailable")) {
      await ref.set({
        status: "active",
        retiredReason: null,
        retryCount: 0,
        firstFailureAtIso: null,
        lastAttemptAtIso: MONITOR_EPOCH_ATTEMPT_ISO,
        updatedAtIso: nowIso,
      }, { merge: true });
      reactivated += 1;
      continue;
    }
    if (anyTrackable) {
      const last = typeof monitor.lastAttemptAtIso === "string" ? monitor.lastAttemptAtIso : MONITOR_EPOCH_ATTEMPT_ISO;
      // R3②: 은퇴 상태(far-future 시계)는 healthy 가 아니다. 위 재활성 분기가 승인 근거가 있는
      // 은퇴본을 이미 되살리므로, 여기 남는 은퇴본은 "승인 근거 없음"이 확정된 것이다 — stale 로 센다.
      const retiredWatermark = last === MONITOR_RETIRED_ATTEMPT_ISO
        || status === "retired"
        || status === "retired_unavailable";
      if (retiredWatermark) {
        if (monitor.staleWatermark !== true) {
          await ref.set({ staleWatermark: true, staleSinceIso: nowIso, updatedAtIso: nowIso }, { merge: true });
        }
        stale += 1;
        continue;
      }
      const overdue = last !== MONITOR_EPOCH_ATTEMPT_ISO && Date.parse(nowIso) - Date.parse(last) > staleAfterMs;
      if (overdue) {
        await ref.set({ staleWatermark: true, staleSinceIso: nowIso, updatedAtIso: nowIso }, { merge: true });
        stale += 1;
      } else {
        if (monitor.staleWatermark === true) await ref.set({ staleWatermark: false, updatedAtIso: nowIso }, { merge: true });
        healthy += 1;
      }
    }
  }
  return { scanned: docs.length, retired, reactivated, stale, healthy };
}

export async function markMonitorAttempt(
  db: FirestoreDb,
  videoId: string,
  nowIso: string,
  outcome:
    | { kind: "success"; date: string; hour?: string }
    | { kind: "unavailable" }
    | { kind: "error"; message: string }
    | { kind: "fresh" },
): Promise<void> {
  const ref = db.collection(VIDEO_VIEW_MONITORS_COLLECTION).doc(videoId);
  const existing = await ref.get();
  const current = existing.exists ? existing.data() ?? {} : {};
  const retryCount = typeof current.retryCount === "number" ? current.retryCount : 0;
  if (outcome.kind === "success") {
    await ref.set({
      videoId,
      lastAttemptAtIso: nowIso,
      lastSuccessAtIso: nowIso,
      lastSnapshotDate: outcome.date,
      ...(outcome.hour ? { lastSnapshotHour: outcome.hour } : {}),
      retryCount: 0,
      // R3①: 성공하면 실패 시계도 리셋한다(다음 장애는 처음부터 센다).
      firstFailureAtIso: null,
      status: "active",
      lastError: null,
      lastErrorAtIso: null,
      updatedAtIso: nowIso,
    }, { merge: true });
    return;
  }
  if (outcome.kind === "fresh") {
    await ref.set({ videoId, lastAttemptAtIso: nowIso, updatedAtIso: nowIso }, { merge: true });
    return;
  }
  const nextRetryCount = retryCount + 1;
  // R3①: 최초 실패 시각을 기록한다(없으면 지금). 은퇴는 횟수와 경과 시간을 **둘 다** 넘겨야 한다.
  const firstFailureAtIso = typeof current.firstFailureAtIso === "string" && current.firstFailureAtIso
    ? current.firstFailureAtIso
    : nowIso;
  const failureElapsedMs = Math.max(0, Date.parse(nowIso) - Date.parse(firstFailureAtIso));
  if (outcome.kind === "unavailable") {
    const retired = nextRetryCount >= MONITOR_RETIRE_AFTER_FAILURES
      && failureElapsedMs >= MONITOR_RETIRE_AFTER_MS;
    await ref.set({
      videoId,
      lastAttemptAtIso: retired ? MONITOR_RETIRED_ATTEMPT_ISO : nowIso,
      retryCount: nextRetryCount,
      firstFailureAtIso,
      status: retired ? "retired_unavailable" : "unavailable",
      lastError: "video_not_found_or_private",
      lastErrorAtIso: nowIso,
      updatedAtIso: nowIso,
    }, { merge: true });
    return;
  }
  await ref.set({
    videoId,
    lastAttemptAtIso: nowIso,
    retryCount: nextRetryCount,
    firstFailureAtIso,
    lastError: outcome.message.slice(0, 300),
    lastErrorAtIso: nowIso,
    updatedAtIso: nowIso,
  }, { merge: true });
}

// 스냅샷 패스 — lastAttemptAtIso 오름차순(가장 오래 기다린 모니터 먼저)으로
// 상한(limit)만큼 시도한다. 시도마다 lastAttemptAtIso가 갱신되므로 실행이
// 반복될수록 모든 모니터가 공정하게 순회된다(고정 상위 50 기아 불가).
export async function processVideoViewSnapshotQueue(
  opts: SnapshotOptions & { db?: FirestoreDb | null; api?: YouTubeApiLike | null } = {},
): Promise<SnapshotQueueResult> {
  // 명시적 null 주입(테스트)과 런타임 부재를 모두 "정직한 실패"로 처리한다.
  const db = "db" in opts ? opts.db : adminDbRuntime();
  const api = "api" in opts ? opts.api : youtubeClientRuntime();
  const empty = {
    scanned: 0, registered: 0, linkedSubmissions: 0, invalidUrls: 0, cycleComplete: false,
    attempted: 0, snapshotted: 0, skippedFresh: 0, failed: 0, unavailable: 0, apiCalls: 0,
    reconcileRan: false, legacyRegisterRan: false,
  };
  // 런타임 의존성 부재는 빈 성공이 아니라 명시적 실패다.
  if (!db || !api) return { ok: false, reason: "runtime_unavailable", ...empty };
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const limit = opts.limit ?? DEFAULT_SNAPSHOT_LIMIT;

  // 2026-09-27 비용 감사: 이 함수 안에서 VIDEO_VIEW_MONITOR_STATE_DOC(단일 "scan" 상태 문서)를
  // legacy-register 판정 · registerCanonicalReviewStateMonitors 내부 커서 조회 · reconcile 판정이
  // 각각 따로 읽어 같은 문서를 한 invocation 에 3번 읽고 있었다. 한 번만 읽고 아래 세 지점에
  // 전부 재사용한다 — 세 필드(lastLegacyRegisterAtIso·canonicalCursorDocId·lastReconcileAtIso)가
  // 모두 이 한 문서에 산다.
  const monitorStateRef = db.collection(VIDEO_VIEW_MONITOR_STATE_COLLECTION).doc(VIDEO_VIEW_MONITOR_STATE_DOC);
  const monitorStateSnap = await monitorStateRef.get();
  const monitorState = monitorStateSnap.data() ?? {};

  // R4: 두 등록 패스의 비용·긴급도가 다르다.
  //  · canonical(scp_video_review_state) current head 등록 = **제출→첫 스냅샷 5분 SLO 의 경로**라 매 실행 돈다.
  //  · legacy(submissions 시트 계열) 백필 등록 = 새 승인이 이 경로로 들어오지 않는다(백필/호환).
  //    5분마다 submissions 페이지를 다시 훑을 이유가 없어 reconcile 과 같은 1시간 주기로 내린다.
  const lastLegacyRegisterAtIso = typeof monitorState.lastLegacyRegisterAtIso === "string"
    ? monitorState.lastLegacyRegisterAtIso
    : "";
  const legacyRegisterDue = !lastLegacyRegisterAtIso
    || Date.parse(nowIso) - Date.parse(lastLegacyRegisterAtIso) >= MONITOR_LEGACY_REGISTER_INTERVAL_MS;
  const scan = legacyRegisterDue
    ? await registerVideoViewMonitors({ db, nowIso, parser: opts.parser })
    : { scanned: 0, registered: 0, linkedSubmissions: 0, invalidUrls: 0, cycleComplete: false };
  if (legacyRegisterDue) {
    await monitorStateRef.set(
      { lastLegacyRegisterAtIso: nowIso },
      { merge: true },
    );
  }
  const canonicalCursorDocId = typeof monitorState.canonicalCursorDocId === "string"
    ? monitorState.canonicalCursorDocId
    : "";
  await registerCanonicalReviewStateMonitors({ db, nowIso, precomputedCursorDocId: canonicalCursorDocId });
  // R4: reconcile(은퇴/부활/워터마크)은 **모니터 1건당 submissions 문서 get** 을 하는 무거운 패스다.
  // 5분 크론(W8-5c)에서 매 실행 돌리면 idle 읽기가 12배가 된다. 모니터 생성은 위 register 가 하고
  // reconcile 은 5분 SLO 에 필요하지 않으므로 1시간마다만 돌린다(기존 state 문서에 시각만 기록 —
  // 새 컬렉션 0). 시각이 없으면(최초/레거시) 이번 실행에서 한 번 돌려 기준점을 만든다.
  // (canonicalCursorDocId·lastLegacyRegisterAtIso 갱신과 무관한 필드라 위에서 한 번 읽은
  // monitorState 를 그대로 쓴다 — 재조회 없이도 최신값이다.)
  const lastReconcileAtIso = typeof monitorState.lastReconcileAtIso === "string"
    ? monitorState.lastReconcileAtIso
    : "";
  const reconcileDue = !lastReconcileAtIso
    || Date.parse(nowIso) - Date.parse(lastReconcileAtIso) >= MONITOR_RECONCILE_INTERVAL_MS;
  if (reconcileDue) {
    await reconcileVideoViewMonitors({ db, nowIso });
    await monitorStateRef.set(
      { lastReconcileAtIso: nowIso },
      { merge: true },
    );
  }

  const monitorsSnap = await db.collection(VIDEO_VIEW_MONITORS_COLLECTION)
    .orderBy("lastAttemptAtIso", "asc")
    .limit(limit)
    .get();

  let attempted = 0;
  let snapshotted = 0;
  let skippedFresh = 0;
  let failed = 0;
  let unavailable = 0;

  // W8-5a 1단계: cadence 게이트만 먼저 돌려 **이번에 실제로 찍을 대상**을 모은다. 예전에는 이
  // 루프 안에서 영상 1건당 videos.list 를 1콜 했다(50 모니터 × 매시 = 1,200유닛/일) — 그래서
  // 크론을 올릴 수 없었다.
  const due: Array<{ videoId: string; submissionId?: string }> = [];
  for (const doc of monitorsSnap.docs ?? []) {
    const monitor = doc.data() ?? {};
    const videoId = typeof monitor.videoId === "string" && monitor.videoId ? monitor.videoId : doc.id;
    if (monitor.status === "retired_unavailable") continue;
    // Cadence gate. Approved review videos (approvedAtIso set) use the TASK 6 adaptive cadence
    // (<=5min first, 15min for 24h, hourly after); report/rollup videos keep the per-KST-hour skip.
    if (typeof monitor.approvedAtIso === "string" && monitor.approvedAtIso) {
      if (!isVideoViewSnapshotDue(monitor, nowIso)) {
        skippedFresh += 1;
        await markMonitorAttempt(db, videoId, nowIso, { kind: "fresh" });
        continue;
      }
    } else if (monitor.lastSnapshotHour === snapshotHour(nowIso)) {
      skippedFresh += 1;
      await markMonitorAttempt(db, videoId, nowIso, { kind: "fresh" });
      continue;
    }
    const submissionId = typeof monitor.primarySubmissionId === "string" && monitor.primarySubmissionId
      ? monitor.primarySubmissionId
      : undefined;
    due.push({ videoId, ...(submissionId ? { submissionId } : {}) });
  }

  // 2단계: due 전체를 50개씩 콤마 조인해 **⌈due/50⌉ 콜**로 받는다(콜당 1유닛).
  // 배치 자체가 실패하면(쿼터/장애) 개별 영상마다 같은 오류를 넘겨 기존 백업 폴백 분기를 그대로 탄다.
  // R8①: fetchVideoStatsBatch 는 이제 청크 단위로 실패를 격리하므로 `stats` 에는 성공한 청크의
  // 결과가 그대로 담겨 있다 — batchError 는 실패한 청크에 속한 videoId 에만 실효 있다(성공한
  // videoId 는 아래 stats.get(videoId)가 값을 반환해 apiError 분기를 타지 않는다).
  let stats = new Map<string, YouTubeVideoStat>();
  let apiCalls = 0;
  let batchError: string | null = null;
  if (due.length > 0) {
    try {
      const batch = await fetchVideoStatsBatch(api, due.map((item) => item.videoId));
      stats = batch.stats;
      apiCalls = batch.apiCalls;
      if (batch.chunkFailures.length > 0) {
        batchError = batch.chunkFailures.map((f) => f.message).join("; ");
      }
    } catch (error) {
      batchError = error instanceof Error ? error.message : String(error);
      apiCalls = Math.ceil(due.length / VIDEO_STAT_BATCH_SIZE);
    }
  }

  // 3단계: 기록. 단건 스냅샷 함수의 판정·쓰기 경로는 그대로 쓰고 통계만 미리 넘긴다(결과 형태 무변).
  for (const { videoId, submissionId } of due) {
    attempted += 1;
    try {
      const r = await recordVideoViewSnapshot(videoId, {
        db, api, nowIso, submissionId,
        lifecycleRefresh: opts.lifecycleRefresh ?? opts.db === undefined,
        prefetched: { stat: stats.get(videoId) ?? null, error: batchError },
      });
      if (r.ok) {
        snapshotted += 1;
        await markMonitorAttempt(db, videoId, nowIso, { kind: "success", date: r.date, hour: r.hour });
      } else if (r.reason === "video_not_found") {
        unavailable += 1;
        await markMonitorAttempt(db, videoId, nowIso, { kind: "unavailable" });
      } else {
        // API 장애 + 백업 부재 = 일시 실패 — unavailable로 은퇴시키지 않고 재시도 로테이션 유지.
        failed += 1;
        await markMonitorAttempt(db, videoId, nowIso, { kind: "error", message: r.reason ?? "snapshot_failed" });
      }
    } catch (error) {
      failed += 1;
      await markMonitorAttempt(db, videoId, nowIso, {
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const result: SnapshotQueueResult = {
    ok: true,
    ...scan,
    attempted, snapshotted, skippedFresh, failed, unavailable, apiCalls,
    reconcileRan: reconcileDue,
    legacyRegisterRan: legacyRegisterDue,
  };
  await monitorStateRef.set({
    lastResult: { ...result, nowIso },
  }, { merge: true });
  return result;
}
