// C4 일일 스냅샷 수동 트리거 + 시계열 조회 콜러블. RBAC manager+ 서버검증. SEC-P0-004: 클라 직접쓰기/read 금지 → 콜러블 경유.
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";
import {
  extractYouTubeVideoId,
  markMonitorAttempt,
  processVideoViewSnapshotQueue,
  recordVideoViewSnapshot,
  VIDEO_VIEW_MONITORS_COLLECTION,
  VIDEO_VIEW_ROLLUPS_COLLECTION,
} from "./videoViewSnapshots";
import { extractYouTubeVideoIdFromSubmissionUrl } from "./scpApprovedFeed";
import { adminDb } from "./firebaseAdmin";

const ROLES = ["super_admin", "admin", "manager"] as const;

// URL 입력은 정식 host 검증 파서(approved-feed 재사용)로만 받는다 — lookalike host 차단.
// videoId 입력은 순수 11자 토큰만 허용.
function requestedVideoId(data: Record<string, unknown>): string | null {
  return extractYouTubeVideoIdFromSubmissionUrl(data.youtubeUrl)
    ?? (typeof data.videoId === "string" && /^[A-Za-z0-9_-]{11}$/.test(data.videoId.trim()) ? data.videoId.trim() : null)
    ?? extractYouTubeVideoIdFromSubmissionUrl(data.videoId);
}

export async function runVideoViewSnapshots(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "video_view_snapshots.run", ROLES);
  const data = asRecord(request.data);
  const explicit = requestedVideoId(data);
  if (explicit) {
    const nowIso = new Date().toISOString();
    const r = await recordVideoViewSnapshot(explicit, { submissionId: asString(data.submissionId) || undefined });
    // 수동 재시도는 멱등이며 모니터 상태를 함께 갱신한다 — 성공은 retired 상태도
    // 즉시 되살리고(status active), 실패는 unavailable 사유를 기록한다.
    await markMonitorAttempt(adminDb, explicit, nowIso, r.ok ? { kind: "success", date: r.date } : { kind: "unavailable" });
    return { ok: r.ok, mode: "single" as const, videoId: explicit, date: r.date, point: r.point ?? null, reason: r.reason ?? null, behaviorLog: makeBehaviorLog(auth, "video_view_snapshots.run.single", r.ok ? "success" : "mock") };
  }
  if (typeof data.youtubeUrl === "string" && data.youtubeUrl.trim()) {
    throw Object.assign(new Error("유효한 YouTube 링크가 아닙니다 — youtube.com/youtu.be 주소인지 확인해 주세요."), { code: "invalid-argument", errorCode: "run_video_view_snapshots_you_tube_youtube_com_youtu" });
  }
  const limit = typeof data.limit === "number" ? Math.max(1, Math.min(50, data.limit)) : undefined;
  const res = await processVideoViewSnapshotQueue({ limit });
  if (!res.ok) {
    throw Object.assign(new Error("스냅샷 런타임 구성(YOUTUBE_API_KEY/Firestore)을 확인할 수 없습니다."), { code: "failed-precondition", errorCode: "run_video_view_snapshots_youtube_api_key_firestore" });
  }
  return { ...res, mode: "queue" as const, behaviorLog: makeBehaviorLog(auth, "video_view_snapshots.run.queue", "success") };
}

export async function getVideoViewSeries(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "video_view_snapshots.get", ROLES);
  const data = asRecord(request.data);
  const videoId = requestedVideoId(data);
  if (!videoId) throw Object.assign(new Error("videoId or youtubeUrl required"), { code: "invalid-argument", errorCode: "get_video_view_series_video_id_youtube_url_required" });
  const [snap, monitorSnap] = await Promise.all([
    adminDb.collection("video_view_series").doc(videoId).get(),
    adminDb.collection(VIDEO_VIEW_MONITORS_COLLECTION).doc(videoId).get(),
  ]);
  const series = snap.exists ? (snap.data() ?? {}) : null;
  const monitorData = monitorSnap.exists ? (monitorSnap.data() ?? {}) : null;
  return {
    ok: true as const,
    videoId,
    series: series ? {
      videoId,
      points: Array.isArray(series.points) ? series.points : [],
      totalViews: typeof series.totalViews === "number" ? series.totalViews : 0,
      latestDailyDeltaViews: typeof series.latestDailyDeltaViews === "number" ? series.latestDailyDeltaViews : 0,
      latestGrowthRatePct: typeof series.latestGrowthRatePct === "number" ? series.latestGrowthRatePct : 0,
      dayCount: typeof series.dayCount === "number" ? series.dayCount : 0,
      commentInsights: series.commentInsights ?? null,
      publishedAtIso: asString(series.publishedAtIso) || null,
      lastHour: asString(series.lastHour) || null,
      source: asString(series.source) || null,
      sourceDivergencePct: typeof series.sourceDivergencePct === "number" ? series.sourceDivergencePct : null,
      updatedAtIso: asString(series.updatedAtIso),
    } : null,
    // 수집 상태(신선도/실패/비공개)를 UI가 정직하게 표시할 수 있도록 모니터를 함께 반환.
    monitor: monitorData ? {
      status: asString(monitorData.status) || "active",
      lastAttemptAtIso: asString(monitorData.lastAttemptAtIso),
      lastSuccessAtIso: asString(monitorData.lastSuccessAtIso),
      lastSnapshotDate: asString(monitorData.lastSnapshotDate),
      lastError: asString(monitorData.lastError) || null,
      lastErrorAtIso: asString(monitorData.lastErrorAtIso) || null,
      retryCount: typeof monitorData.retryCount === "number" ? monitorData.retryCount : 0,
    } : null,
    behaviorLog: makeBehaviorLog(auth, "video_view_snapshots.get", "success"),
  };
}

// 프로그램 > 캠페인 조회수 롤업 — 피드·리포트가 동일 집계를 읽는다(CPM 정산 근거).
export async function getVideoViewRollups(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "video_view_snapshots.rollups", ROLES);
  const data = asRecord(request.data);
  const programId = typeof data.programId === "string" ? data.programId.trim().slice(0, 180) : "";
  let query = adminDb.collection(VIDEO_VIEW_ROLLUPS_COLLECTION).orderBy("updatedAtIso", "desc").limit(100);
  if (programId) query = adminDb.collection(VIDEO_VIEW_ROLLUPS_COLLECTION).where("programId", "==", programId).limit(100);
  const snap = await query.get();
  const rollups = snap.docs.map((doc) => {
    const d = doc.data() ?? {};
    const videosMap = d.videos && typeof d.videos === "object" && !Array.isArray(d.videos)
      ? d.videos as Record<string, Record<string, unknown>>
      : {};
    return {
      id: doc.id,
      programId: asString(d.programId) || "unassigned",
      campaignId: asString(d.campaignId) || "unassigned",
      totalViews: typeof d.totalViews === "number" ? d.totalViews : 0,
      videoCount: typeof d.videoCount === "number" ? d.videoCount : 0,
      updatedAtIso: asString(d.updatedAtIso),
      videos: Object.values(videosMap).map((v) => ({
        videoId: asString(v.videoId),
        submissionId: asString(v.submissionId),
        creator: asString(v.creator),
        totalViews: typeof v.totalViews === "number" ? v.totalViews : 0,
        latestDailyDeltaViews: typeof v.latestDailyDeltaViews === "number" ? v.latestDailyDeltaViews : 0,
        publishedAtIso: asString(v.publishedAtIso) || null,
        submittedAtIso: asString(v.submittedAtIso) || null,
      })).sort((a, b) => b.totalViews - a.totalViews),
    };
  });
  return { ok: true as const, rollups, behaviorLog: makeBehaviorLog(auth, "video_view_snapshots.rollups", "success") };
}
