// getReportDashboard — impure half (Firestore reads + role/behaviorLog/cache) for the /flu/report
// rebuild (SCP Creator Portal admin dashboard clone). All aggregation logic lives in the pure
// ./reportDashboardCore — this file only fetches bounded row sets and hands them over.
//
// Reads are bounded by construction:
//   - cold emails / replies: Firestore count() aggregation over scp_coldmail_history (no document
//     reads). coldEmails = count(sentAtIso range) − count(same range ∧ programId=="scp-canary")
//     (canary self-sends never count as outreach); replies = count(range ∧ hasReply==true). The
//     prior outbound-log / conversation-thread sources are retired here — the former mixed in
//     nudge and result mail (wrong KPI scope), the latter counted every inbound thread including
//     reminders (2026-09-07 prod probe: portal cold emails 7,202 vs the old source's 16,259;
//     portal replies 71 vs the old source's 273).
//   - applications: unchanged, count() over scp_application_management.submittedAtIso.
//   - content submissions: scp_video_review_state period-scoped (submittedAtIso range query),
//     capped at REVIEW_STATE_ROW_LIMIT, limit+1 truncation flag, fixture + withdrawn/superseded
//     filtered in-memory. Replaces the legacy `submissions` collection (sheet3-era, dead since
//     2026-07-20 — every portal submission since then lands in scp_video_review_state instead, so
//     the old source silently returned 0 rows for any recent period). All-time submission counts
//     (for submittedVideos.allTimeSubmissions) come from two separate count() aggregations instead
//     — count() cannot apply the in-memory fixture predicate, a known/accepted trade for a cheap
//     all-time number instead of an unbounded scan.
//   - video performance rows: the same bounded port the video-performance page uses
//     (createFirestoreVideoPerformanceReportPort), already fixture-filtered + reportEligible-only.
//   - portal bridge directory: paginated up to BRIDGE_MAX_PAGES, fail-closed to `configured:false`
//     on any bridge error (never throws — matches listScpPortalCreatorsHandler's contract).
//
// 2026-09-07 라운드 3: 승인→트래킹 프로젝션(video_performance_report_rows)이 멎어 있다(별도
// 트레이서 레인이 조사 중 — 이 파일 책임 아님). 포털의 "조회수"는 제출일 기준 공개 YouTube
// 조회수라, videoViews/topVideos/pulse/submittedVideos.rows 는 그 프로젝션 하나에만 기대지
// 않고 3단 사다리로 기간 내·반려 제외 영상마다 조회수를 하나씩 해석한다(resolveVideoViews):
//   1단(tracked) — video_performance_report_rows 조인(기존 로직, 측정 확정).
//   2단(rollup)  — video_view_rollups(매시 크론 캐시), getVideoViewRollups 와 같은 유계 읽기
//                  (updatedAtIso desc, ≤100 문서).
//   3단(live)    — YouTube Data API videos.list(fetchVideoStatsBatch, 50개씩 배치), 호출당
//                  최대 LIVE_VIEW_FETCH_CAP 개. processVideoViewSnapshotQueueSchedule 과 같은
//                  api 클라이언트 구성(makeYouTubeDataApiClient)을 그대로 쓴다. 결과는 응답
//                  캐시와 같은 10분 TTL(LIVE_VIEW_CACHE_TTL_MS=CACHE_TTL_MS)로 videoId 별
//                  캐시해 프리셋 반복 클릭이 YouTube 를 다시 때리지 않게 한다.
// 세 단 모두 실패하면 그 영상은 조회수 0("unavailable")로 남는다 — 지어내지 않는다.
// viewReward(리워드 산식)는 이 사다리를 타지 않는다 — 1단(reportRows)만 본다(공개 조회수를
// CPM 정산 근거에 섞지 않는다).
//
// 2026-09-07 리뷰 후속(MEDIUM/LOW): (1) 같은 (from,to) 요청이 동시에 여러 건 들어오면 하나의
// 실행만 돌고 나머지는 그 결과를 공유한다(pendingResponses). (2) 3단(라이브 YouTube) 은 네트워크
// 호출 직전 apiQuota.ts 의 추적 예약분 가드를 통과해야 한다 — discovery.ts 가 발굴 레인에 거는
// 것과 같은 가드(주 키 잔여가 2,000유닛 예약분에 닿으면 건너뜀). (3) liveViewCache 는 조회 시점에
// 만료 항목을 지우고 5,000건 상한에서 가장 오래된 항목부터 버려 무한정 자라지 않는다.
import { adminDb } from "./firebaseAdmin";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  makeBehaviorLog,
  type CallableRequestShape,
  type Role,
} from "./shared";
import { isOperationalFixtureRecord } from "./operationalFixtureProvenance";
import { fetchScpAdminBridgeCreatorsDirectory } from "./scpAdminBridgeClient";
import { createFirestoreVideoPerformanceReportPort } from "./videoPerformanceReportPorts";
import { fetchVideoStatsBatch, VIDEO_VIEW_ROLLUPS_COLLECTION, type YouTubeVideoStat } from "./videoViewSnapshots";
import { makeYouTubeDataApiClient } from "./youtubeEnrichmentService";
import { YOUTUBE_TRACKING_RESERVED_UNITS, youtubePerKeyDailyCap, youtubeSlotUnitsUsed } from "./apiQuota";
import {
  buildKstPeriod,
  buildReportDashboardCore,
  reportRowViews,
  uniqueNonRejectedVideoIds,
  type BridgeRowLike,
  type ReportDashboardResponse,
  type ReportRowLike,
  type SubmissionRowLike,
  type VideoViewResolutionRow,
  type VideoViewsSourceSummary,
} from "./reportDashboardCore";

// 응답은 집계 숫자뿐(PII 없음) — 예전 aggregateReport 와 같은 접근 범위로 viewer 도 허용한다.
// guest/미인증만 막는다.
const REPORT_DASHBOARD_ROLES: readonly Exclude<Role, "guest">[] = ["super_admin", "admin", "manager", "viewer"];

const SCP_COLDMAIL_HISTORY_COLLECTION = "scp_coldmail_history";
const SCP_APPLICATION_MANAGEMENT_COLLECTION = "scp_application_management";
const SCP_VIDEO_REVIEW_STATE_COLLECTION = "scp_video_review_state";
// 콜드메일 원장에 매일 자가 발송되는 카나리(운영 헬스체크) — 실제 아웃리치가 아니다.
const COLDMAIL_CANARY_PROGRAM_ID = "scp-canary";

const APPLICATION_DAY_ROW_LIMIT = 2000;
const REVIEW_STATE_ROW_LIMIT = 2000;
const BRIDGE_PAGE_LIMIT = 100;
const BRIDGE_MAX_PAGES = 10;
// video_view_rollups 유계 읽기 상한 — getVideoViewRollups(videoViewSnapshotsAdmin.ts)와 동일.
const ROLLUP_DOC_LIMIT = 100;
// 라이브 YouTube API 폴백은 호출당 이 개수까지만(쿼터 보호). 넘는 만큼은 이번 응답에서
// "unavailable" 로 남고, 다음 호출(다른 캐시 상태)에서 다시 시도된다.
const LIVE_VIEW_FETCH_CAP = 200;

const CACHE_TTL_MS = 10 * 60 * 1000;
// 인스턴스별 메모리 캐시(콜드스타트마다 초기화) — (from,to) 페어당 10분.
const dashboardCache = new Map<string, { expiresAt: number; response: ReportDashboardResponse }>();
// 동일 (from,to) 요청이 동시에 여러 건 들어와도 Firestore+YouTube 실행은 한 번만 돈다 — N개
// 동시 요청이 각자 fetchVideoStatsBatch 를 때리는 걸 막는다. finally 에서 반드시 지운다(성공·
// 실패 어느 쪽이든 다음 요청은 새로 계산한다).
const pendingResponses = new Map<string, Promise<ReportDashboardResponse>>();
// videoId 별 라이브 조회수 캐시 — 같은 10분 TTL. 프리셋(7일/30일/…)을 반복 클릭해도 겹치는
// 영상은 YouTube 를 다시 때리지 않는다(응답 캐시와 키 공간만 다르다: 여기는 videoId, 저기는
// from,to 페어). 상한을 두고(LIVE_VIEW_CACHE_MAX_ENTRIES) 조회 시점에 만료 항목을 지워
// 무한정 자라지 않게 한다.
const liveViewCache = new Map<string, { expiresAt: number; views: number; title: string; publishedAt: string }>();
const LIVE_VIEW_CACHE_MAX_ENTRIES = 5000;

/** 조회 시점 opportunistic 만료 정리 — 만료된 항목이면 지우고 undefined 를 반환한다. */
function liveViewCacheGet(videoId: string, nowMs: number) {
  const cached = liveViewCache.get(videoId);
  if (!cached) return undefined;
  if (cached.expiresAt <= nowMs) {
    liveViewCache.delete(videoId);
    return undefined;
  }
  return cached;
}

/** 상한(LIVE_VIEW_CACHE_MAX_ENTRIES) 도달 시 가장 오래된 항목(Map 삽입 순서 최선두)부터 지운다 —
 * 무한 성장 방지. 정확한 LRU 는 아니지만 opportunistic 만료 정리와 합쳐 실사용 상한을 지킨다. */
function liveViewCacheSet(videoId: string, entry: { expiresAt: number; views: number; title: string; publishedAt: string }) {
  if (liveViewCache.size >= LIVE_VIEW_CACHE_MAX_ENTRIES && !liveViewCache.has(videoId)) {
    const oldestKey = liveViewCache.keys().next().value;
    if (oldestKey !== undefined) liveViewCache.delete(oldestKey);
  }
  liveViewCache.set(videoId, entry);
}

/**
 * R21-2 예약분 재사용(functions/apiQuota.ts) — 리포트 대시보드의 3단(라이브 조회) 폴백은 추적
 * 크론과 달리 "예약분과 무관하게 계속 쓸 수 있는" 특권이 없다. discovery.ts 가 발굴 레인에 거는
 * 것과 같은 가드를 여기도 건다: 주 키(슬롯 0) 잔여가 추적 예약분(YOUTUBE_TRACKING_RESERVED_UNITS
 * =2,000)에 닿아 있으면 이번 라이브 폴백은 건너뛴다(fail-closed, throw 하지 않음) — 정산 측정
 * (videoViewSnapshots 크론)이 언제나 우선한다.
 */
async function liveViewFetchBudgetAvailable(now = new Date()): Promise<boolean> {
  try {
    const cap = youtubePerKeyDailyCap();
    const used = await youtubeSlotUnitsUsed(0, now);
    return cap - used > YOUTUBE_TRACKING_RESERVED_UNITS;
  } catch {
    // 계측을 못 읽으면 모르는 채로 쓰지 않는다 — discoveryMayUsePrimaryYoutubeKey 와 같은 fail-closed.
    return false;
  }
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument",
    errorCode: "get_report_dashboard_invalid_argument",
  });
}

async function countInRange(collection: string, field: string, fromIso: string, toIsoExclusive: string): Promise<number> {
  const snapshot = await adminDb
    .collection(collection)
    .where(field, ">=", fromIso)
    .where(field, "<", toIsoExclusive)
    .count()
    .get();
  return snapshot.data().count ?? 0;
}

async function countAll(collection: string): Promise<number> {
  const snapshot = await adminDb.collection(collection).count().get();
  return snapshot.data().count ?? 0;
}

async function countWhereEqual(collection: string, field: string, value: string): Promise<number> {
  const snapshot = await adminDb.collection(collection).where(field, "==", value).count().get();
  return snapshot.data().count ?? 0;
}

// 같은 range 위에 하나의 equality 를 더 건다(카나리 제외, hasReply==true) — 복합 색인 필요
// (firestore.indexes.json 의 scp_coldmail_history: programId+sentAtIso, hasReply+sentAtIso).
async function countInRangeWhereEqual(
  collection: string,
  rangeField: string,
  fromIso: string,
  toIsoExclusive: string,
  eqField: string,
  eqValue: string | boolean,
): Promise<number> {
  const snapshot = await adminDb
    .collection(collection)
    .where(eqField, "==", eqValue)
    .where(rangeField, ">=", fromIso)
    .where(rangeField, "<", toIsoExclusive)
    .count()
    .get();
  return snapshot.data().count ?? 0;
}

async function fetchApplicationDayIsos(fromIso: string, toIsoExclusive: string): Promise<{ isos: string[]; truncated: boolean }> {
  const snapshot = await adminDb
    .collection(SCP_APPLICATION_MANAGEMENT_COLLECTION)
    .where("submittedAtIso", ">=", fromIso)
    .where("submittedAtIso", "<", toIsoExclusive)
    .select("submittedAtIso")
    .limit(APPLICATION_DAY_ROW_LIMIT + 1)
    .get();
  const docs = snapshot.docs.slice(0, APPLICATION_DAY_ROW_LIMIT);
  return {
    isos: docs.map((doc) => asString((doc.data() as Record<string, unknown>).submittedAtIso)),
    truncated: snapshot.docs.length > APPLICATION_DAY_ROW_LIMIT,
  };
}

async function fetchReviewStates(fromIso: string, toIsoExclusive: string): Promise<{ rows: SubmissionRowLike[]; truncated: boolean }> {
  // 기간으로 걸러서 읽는다 — submittedAtIso 위의 단일 필드 range + 같은 필드 orderBy 라 복합
  // 색인이 필요 없다. 예전 `submissions` 컬렉션 읽기와 같은 원칙: 전체 최신 N건을 읽고 기간을
  // 메모리에서 거르면, 전체 건수가 상한을 넘는 순간 과거 구간이 조용히 0건으로 보인다.
  const snapshot = await adminDb
    .collection(SCP_VIDEO_REVIEW_STATE_COLLECTION)
    .where("submittedAtIso", ">=", fromIso)
    .where("submittedAtIso", "<", toIsoExclusive)
    .orderBy("submittedAtIso", "desc")
    .select("submittedAtIso", "state", "youtubeVideoId", "title", "applicationId", "withdrawn", "superseded", "mock", "seedTag", "seedId", "source")
    .limit(REVIEW_STATE_ROW_LIMIT + 1)
    .get();
  const docs = snapshot.docs.slice(0, REVIEW_STATE_ROW_LIMIT);
  const rows = docs
    .map((doc) => ({ id: doc.id, ...(doc.data() ?? {}) }) as Record<string, unknown>)
    .filter((row) => !isOperationalFixtureRecord(row, SCP_VIDEO_REVIEW_STATE_COLLECTION))
    // withdrawn(크리에이터 철회)·superseded(재제출로 무효화된 이전 리비전)는 "지금 유효한 제출"이
    // 아니다 — 오늘 프로드 실측(2026-09-07)에는 0건이지만 스키마상 있을 수 있어 방어적으로 뺀다.
    .filter((row) => row.withdrawn !== true && row.superseded !== true)
    .map((row): SubmissionRowLike => ({
      id: asString(row.id),
      submittedAtIso: asString(row.submittedAtIso),
      reviewStatus: asString(row.state) || "queued",
      youtubeVideoId: typeof row.youtubeVideoId === "string" ? row.youtubeVideoId : undefined,
      title: typeof row.title === "string" ? row.title : undefined,
      applicationId: typeof row.applicationId === "string" ? row.applicationId : undefined,
    }))
    .filter((row) => row.submittedAtIso);
  return { rows, truncated: snapshot.docs.length > REVIEW_STATE_ROW_LIMIT };
}

async function fetchReportRows(): Promise<{ rows: ReportRowLike[]; truncated: boolean }> {
  const port = createFirestoreVideoPerformanceReportPort();
  const { rows, truncated } = await port.fetchRows({});
  return {
    rows: rows.map((row): ReportRowLike => ({
      video: { youtubeVideoId: row.video.youtubeVideoId, title: row.video.title, publishedAt: row.video.publishedAt },
      metrics: { totalViews: row.metrics.totalViews, eligibleViews: row.metrics.eligibleViews },
      country: { declared: row.country.declared, verified: row.country.verified, effective: row.country.effective },
    })),
    truncated,
  };
}

// video_view_rollups(매시 크론이 채우는 캐시) → videoId 별 조회수+게시일. getVideoViewRollups
// (videoViewSnapshotsAdmin.ts:90-121)와 같은 유계 읽기(updatedAtIso desc, ≤100 문서) — 그 콜러블은
// programId 필터를 지원하지만 여기서는 필요 없어 무필터 버전만 둔다.
async function fetchRollupViews(): Promise<Map<string, { views: number; publishedAt: string }>> {
  const snapshot = await adminDb
    .collection(VIDEO_VIEW_ROLLUPS_COLLECTION)
    .orderBy("updatedAtIso", "desc")
    .limit(ROLLUP_DOC_LIMIT)
    .get();
  const map = new Map<string, { views: number; publishedAt: string }>();
  for (const doc of snapshot.docs) {
    const data = (doc.data() ?? {}) as Record<string, unknown>;
    const videos = data.videos && typeof data.videos === "object" && !Array.isArray(data.videos)
      ? data.videos as Record<string, Record<string, unknown>>
      : {};
    for (const entry of Object.values(videos)) {
      const videoId = asString(entry.videoId);
      // 최신순으로 도는 문서라 먼저 만난 값이 더 최신이다 — 뒤에 오는 오래된 문서로 덮지 않는다.
      if (!videoId || map.has(videoId)) continue;
      const totalViews = typeof entry.totalViews === "number" ? entry.totalViews : 0;
      map.set(videoId, { views: Math.max(0, totalViews), publishedAt: asString(entry.publishedAtIso) });
    }
  }
  return map;
}

/**
 * 3단 사다리 — 기간 내·반려 제외 영상마다 공개 조회수를 하나만 정한다.
 *   1단(tracked) reportRowsByVideoId(video_performance_report_rows, 이미 유계 페치됨)
 *   2단(rollup)  video_view_rollups(매시 캐시, 유계 읽기 — 남은 영상이 있을 때만 조회)
 *   3단(live)    YouTube Data API videos.list — videoId 캐시 우선, 남은 만큼만
 *                LIVE_VIEW_FETCH_CAP 상한으로 fetchVideoStatsBatch(50개씩 배치) 호출.
 * 키/API 미설정·쿼터 소진 등 어떤 이유로든 실패하면 그 영상은 조회수 0("unavailable")로
 * 남는다(throw 하지 않음 — 화면이 정직하게 "미조회"를 보여줄 수 있어야 한다).
 */
async function resolveVideoViews(
  videoIds: readonly string[],
  reportRowsByVideoId: ReadonlyMap<string, ReportRowLike>,
  titleFallbackByVideoId: ReadonlyMap<string, string>,
): Promise<{ resolutions: VideoViewResolutionRow[]; source: VideoViewsSourceSummary }> {
  const resolutions: VideoViewResolutionRow[] = [];
  const source: VideoViewsSourceSummary = { tracked: 0, rollup: 0, live: 0, unavailable: 0 };
  let remaining: string[] = [];

  for (const videoId of videoIds) {
    const row = reportRowsByVideoId.get(videoId);
    if (row) {
      resolutions.push({
        youtubeVideoId: videoId,
        views: reportRowViews(row),
        title: row.video.title || titleFallbackByVideoId.get(videoId) || videoId,
        publishedAt: row.video.publishedAt,
        source: "tracked",
      });
      source.tracked += 1;
    } else {
      remaining.push(videoId);
    }
  }

  if (remaining.length > 0) {
    const rollups = await fetchRollupViews();
    const stillRemaining: string[] = [];
    for (const videoId of remaining) {
      const entry = rollups.get(videoId);
      if (entry) {
        resolutions.push({
          youtubeVideoId: videoId,
          views: entry.views,
          title: titleFallbackByVideoId.get(videoId) || videoId,
          publishedAt: entry.publishedAt,
          source: "rollup",
        });
        source.rollup += 1;
      } else {
        stillRemaining.push(videoId);
      }
    }
    remaining = stillRemaining;
  }

  if (remaining.length > 0) {
    const nowMs = Date.now();
    const toFetch: string[] = [];
    for (const videoId of remaining) {
      const cached = liveViewCacheGet(videoId, nowMs);
      if (cached) {
        resolutions.push({
          youtubeVideoId: videoId,
          views: cached.views,
          title: cached.title || titleFallbackByVideoId.get(videoId) || videoId,
          publishedAt: cached.publishedAt,
          source: "live",
        });
        source.live += 1;
      } else {
        toFetch.push(videoId);
      }
    }
    const capped = toFetch.slice(0, LIVE_VIEW_FETCH_CAP);
    if (capped.length > 0) {
      // 추적 예약분 가드 — 캐시 조회 이후, 실제 네트워크 호출 직전에만 건다(캐시 히트는 쿼터를
      // 안 쓰니 가드 대상이 아니다).
      const budgetAvailable = await liveViewFetchBudgetAvailable();
      if (!budgetAvailable) {
        source.unavailable += capped.length;
      } else {
        let stats: Map<string, YouTubeVideoStat> = new Map();
        try {
          const api = makeYouTubeDataApiClient();
          const batch = await fetchVideoStatsBatch(api, capped);
          stats = batch.stats;
        } catch {
          // YOUTUBE_API_KEY 미설정(비-에뮬레이터)/쿼터 소진 등 — 이번 응답은 fail-closed 로
          // "unavailable" 취급한다(throw 로 전체 대시보드를 죽이지 않는다).
        }
        for (const videoId of capped) {
          const stat = stats.get(videoId);
          if (stat) {
            const title = stat.title || titleFallbackByVideoId.get(videoId) || videoId;
            const publishedAt = stat.publishedAtIso || "";
            liveViewCacheSet(videoId, { expiresAt: nowMs + CACHE_TTL_MS, views: stat.views, title, publishedAt });
            resolutions.push({ youtubeVideoId: videoId, views: stat.views, title, publishedAt, source: "live" });
            source.live += 1;
          } else {
            source.unavailable += 1;
          }
        }
      }
    }
    // 이번 호출의 200건 상한을 넘긴 나머지는 이번 응답에서 시도조차 못 했다 — 여전히 unavailable.
    source.unavailable += Math.max(0, toFetch.length - capped.length);
  }

  return { resolutions, source };
}

async function fetchBridgeRows(): Promise<{ configured: boolean; rows: BridgeRowLike[]; truncated: boolean }> {
  let cursor: string | undefined;
  const rows: BridgeRowLike[] = [];
  let configured = false;
  for (let page = 0; page < BRIDGE_MAX_PAGES; page += 1) {
    const result = await fetchScpAdminBridgeCreatorsDirectory({ cursor, limit: BRIDGE_PAGE_LIMIT });
    if (!result) {
      // 미설정/전송 실패/드리프트 — fail-closed. listScpPortalCreatorsHandler 와 같은 계약.
      return { configured: false, rows: [], truncated: false };
    }
    configured = true;
    for (const row of result.rows) {
      rows.push({
        status: row.status,
        loginRequestedAt: row.loginRequestedAt,
        approvalApplication: row.approvalApplication ? { loginRequested: row.approvalApplication.loginRequested } : undefined,
        profile: { country: row.profile.country },
      });
    }
    if (!result.nextCursor) return { configured, rows, truncated: false };
    cursor = result.nextCursor;
  }
  return { configured, rows, truncated: true };
}

async function computeReportDashboardResponse(
  period: ReturnType<typeof buildKstPeriod>,
): Promise<ReportDashboardResponse> {
  const [
    coldEmailsTotalInRange,
    coldEmailsCanaryInRange,
    repliesCount,
    applicationsCount,
    applicationDays,
    reviewStates,
    reportRows,
    bridge,
    allTimeSubmissionsTotalCount,
    allTimeSubmissionsRejectedCount,
  ] = await Promise.all([
    countInRange(SCP_COLDMAIL_HISTORY_COLLECTION, "sentAtIso", period.fromIso, period.toIsoExclusive),
    countInRangeWhereEqual(
      SCP_COLDMAIL_HISTORY_COLLECTION, "sentAtIso", period.fromIso, period.toIsoExclusive,
      "programId", COLDMAIL_CANARY_PROGRAM_ID,
    ),
    countInRangeWhereEqual(
      SCP_COLDMAIL_HISTORY_COLLECTION, "sentAtIso", period.fromIso, period.toIsoExclusive,
      "hasReply", true,
    ),
    countInRange(SCP_APPLICATION_MANAGEMENT_COLLECTION, "submittedAtIso", period.fromIso, period.toIsoExclusive),
    fetchApplicationDayIsos(period.fromIso, period.toIsoExclusive),
    fetchReviewStates(period.fromIso, period.toIsoExclusive),
    fetchReportRows(),
    fetchBridgeRows(),
    countAll(SCP_VIDEO_REVIEW_STATE_COLLECTION),
    countWhereEqual(SCP_VIDEO_REVIEW_STATE_COLLECTION, "state", "rejected"),
  ]);
  // 카나리(scp-canary, 운영 헬스체크 자가발송)는 실제 아웃리치가 아니다 — 범위 내 전체에서 뺀다.
  const coldEmailsCount = Math.max(0, coldEmailsTotalInRange - coldEmailsCanaryInRange);

  // 3단 사다리(1단: video_performance_report_rows·2단: video_view_rollups·3단: 라이브 YouTube
  // API)로 기간 내·반려 제외 영상마다 공개 조회수를 해석한다 — 파일 상단 설명 참조.
  const targetVideoIds = [...uniqueNonRejectedVideoIds(reviewStates.rows)];
  const reportRowsByVideoId = new Map<string, ReportRowLike>();
  for (const row of reportRows.rows) reportRowsByVideoId.set(row.video.youtubeVideoId, row);
  const titleFallbackByVideoId = new Map<string, string>();
  for (const row of reviewStates.rows) {
    if (row.youtubeVideoId && row.title) titleFallbackByVideoId.set(row.youtubeVideoId, row.title);
  }
  const { resolutions: videoViewResolutions, source: videoViewsSource } = await resolveVideoViews(
    targetVideoIds, reportRowsByVideoId, titleFallbackByVideoId,
  );

  return buildReportDashboardCore({
    period,
    coldEmailsCount,
    repliesCount,
    applicationsCount,
    applicationDayIsos: applicationDays.isos,
    applicationDaysTruncated: applicationDays.truncated,
    bridgeConfigured: bridge.configured,
    bridgeRows: bridge.rows,
    bridgeTruncated: bridge.truncated,
    submissionRows: reviewStates.rows,
    submissionsTruncated: reviewStates.truncated,
    allTimeSubmissionsTotalCount,
    allTimeSubmissionsRejectedCount,
    reportRows: reportRows.rows,
    reportRowsTruncated: reportRows.truncated,
    videoViewResolutions,
    videoViewsSource,
    nowIso: new Date().toISOString(),
  });
}

/**
 * 캐시 미스일 때만 호출된다. 같은 cacheKey 로 동시에 여러 요청이 들어오면(예: 대시보드 첫 진입
 * 시 프리셋 자동 재조회, 또는 여러 탭) pendingResponses 에 있는 진행 중 Promise 를 그대로
 * 돌려줘 Firestore+YouTube 실행이 요청 수만큼 배로 늘지 않게 한다. 성공·실패 어느 쪽이든
 * finally 에서 지운다 — 다음 요청은 항상 새로 계산(또는 이미 채워진 dashboardCache 히트)한다.
 */
function getOrComputeResponse(cacheKey: string, period: ReturnType<typeof buildKstPeriod>): Promise<ReportDashboardResponse> {
  const pending = pendingResponses.get(cacheKey);
  if (pending) return pending;
  const promise = computeReportDashboardResponse(period)
    .then((response) => {
      dashboardCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, response });
      return response;
    })
    .finally(() => {
      pendingResponses.delete(cacheKey);
    });
  pendingResponses.set(cacheKey, promise);
  return promise;
}

export async function getReportDashboard(
  request: CallableRequestShape,
): Promise<ReportDashboardResponse & { behaviorLog: unknown; cache: { hit: boolean; ageSeconds: number } }> {
  const action = "getReportDashboard";
  const auth = assertNonGuestAuth(request, action, REPORT_DASHBOARD_ROLES);
  const data = asRecord(request.data);

  let period;
  try {
    period = buildKstPeriod(data.fromDate, data.toDate);
  } catch (caught) {
    throw invalidArgument(caught instanceof Error ? caught.message : "invalid date range");
  }

  const cacheKey = `${period.fromDate}:${period.toDate}`;
  const nowMs = Date.now();
  const cached = dashboardCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) {
    return {
      ...cached.response,
      behaviorLog: makeBehaviorLog(auth, action, "cache_hit"),
      cache: { hit: true, ageSeconds: Math.max(0, Math.round((CACHE_TTL_MS - (cached.expiresAt - nowMs)) / 1000)) },
    };
  }

  const response = await getOrComputeResponse(cacheKey, period);

  return {
    ...response,
    behaviorLog: makeBehaviorLog(auth, action, "success"),
    cache: { hit: false, ageSeconds: 0 },
  };
}
