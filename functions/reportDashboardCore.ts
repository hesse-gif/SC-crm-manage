// getReportDashboard — pure aggregation core (/flu/report rebuild, SCP Creator Portal admin
// dashboard clone). No Firestore/network access: every input here is an already-fetched,
// already-bounded row set. functions/reportDashboard.ts is the only impure half (Firestore
// reads + role/behaviorLog/cache) and composes this module.
//
// Hard rule from the product owner (2026-09-07): rejected submissions are EXCLUDED from view
// totals and "unique videos" counts, but STILL shown as counts ("제출 N건 · 반려 N건").
//
// 2026-09-07 소스 수리: `submissionRows` 는 이제 legacy `submissions` 컬렉션이 아니라
// `scp_video_review_state` 원장에서 온다(reportDashboard.ts 쪽 fetchReviewStates). 그 원장의
// `state` 값("queued"/"approved"/"rejected"/...)을 그대로 이 모듈의 `reviewStatus` 필드에
// 싣는다 — isApprovedReviewStatus/isRejectedReviewStatus 술어가 그대로 맞는다.
//
// 2026-09-07 라운드 3: 승인→트래킹 프로젝션(video_performance_report_rows)이 멎어 있다(별도
// 트레이서 레인이 원인 조사 중 — 이 모듈 책임 아님). 포털의 "조회수"는 공개 YouTube 조회수를
// 제출일 기준으로 세므로, 리포트는 그 프로젝션에만 의존하면 안 된다. `videoViewResolutions`
// 는 reportDashboard.ts 가 이미 3단 사다리(리포트 행 → video_view_rollups → 라이브 YouTube API)
// 로 해석해 넘기는 기간 내·반려 제외 영상 목록이다 — 이 모듈은 그 사다리를 모른다(순수 유지),
// 그저 받은 값을 랭킹·합산할 뿐이다. `viewReward`(리워드 산식)는 여전히 `reportRows`(1단, 측정
// 확정 조회수)만 본다 — 공개 조회수를 리워드 산식에 섞지 않는다.

import { calculateViewCpmRewardMinor, getViewCpmPolicyForCountry } from "./scpDashboardSnapshotContract";

export const REPORT_DASHBOARD_MAX_RANGE_DAYS = 366;
const KST_OFFSET_HOURS = 9;
const ISO2_RE = /^[A-Z]{2}$/;

export interface ReportDashboardPeriod {
  fromDate: string;
  toDate: string;
  fromIso: string;
  toIsoExclusive: string;
  dayCount: number;
}

function isValidDateStr(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

/** KST(UTC+9) 자정 → UTC ISO 인스턴트. DST 없음(고정 오프셋). */
export function kstMidnightUtcIso(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, -KST_OFFSET_HOURS, 0, 0, 0)).toISOString();
}

export function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 0, 0, 0)).toISOString().slice(0, 10);
}

/** fromDate/toDate(YYYY-MM-DD, KST 기준 달력일) → KST 하루 경계로 정규화된 반개구간. */
export function buildKstPeriod(fromDateRaw: unknown, toDateRaw: unknown): ReportDashboardPeriod {
  if (!isValidDateStr(fromDateRaw) || !isValidDateStr(toDateRaw)) {
    throw new Error("invalid_date_range");
  }
  const fromIso = kstMidnightUtcIso(fromDateRaw);
  const toIsoExclusive = kstMidnightUtcIso(addDaysToDateStr(toDateRaw, 1));
  if (Date.parse(toIsoExclusive) <= Date.parse(fromIso)) {
    throw new Error("invalid_date_range");
  }
  const dayCount = Math.round((Date.parse(toIsoExclusive) - Date.parse(fromIso)) / 86_400_000);
  if (dayCount > REPORT_DASHBOARD_MAX_RANGE_DAYS) {
    throw new Error("date_range_too_large");
  }
  return { fromDate: fromDateRaw, toDate: toDateRaw, fromIso, toIsoExclusive, dayCount };
}

export function isIsoInRange(iso: unknown, fromIso: string, toIsoExclusive: string): boolean {
  if (typeof iso !== "string") return false;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return false;
  return ms >= Date.parse(fromIso) && ms < Date.parse(toIsoExclusive);
}

/** KST 날짜 버킷 키(YYYY-MM-DD) — 펄스 차트·제출 테이블의 "일자" 축. */
export function kstDateKey(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + KST_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 10);
}

export function isRejectedReviewStatus(status: unknown): boolean {
  return status === "rejected";
}

/** 정본 승인 상태 — 레거시 `pass`/`passed` 도 승인으로 본다. review-pay.ts canonicalReviewStatus 와 같은
 *  3값 집합을 그대로 둔다(그 모듈은 firebase-admin 을 끌어와 순수 코어에서 import 하지 않는다). */
export function isApprovedReviewStatus(status: unknown): boolean {
  return status === "pass" || status === "passed" || status === "approved";
}

export function parseViewCount(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

let regionNamesKo: Intl.DisplayNames | null = null;
function regionNameFormatter(): Intl.DisplayNames {
  if (!regionNamesKo) regionNamesKo = new Intl.DisplayNames(["ko"], { type: "region" });
  return regionNamesKo;
}

/** ISO2 → 한국어 국가명. 미상 버킷("XX")은 국가명을 짓지 않는다. */
export function countryNameKo(code: string): string {
  if (code === "XX") return "미상";
  try {
    return regionNameFormatter().of(code) ?? code;
  } catch {
    return code;
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ---- 영상 성과 행(video_performance_report_rows 서브셋) ---------------------------------------

export interface ReportRowLike {
  video: { youtubeVideoId: string; title: string; publishedAt: string };
  metrics: { totalViews: unknown; eligibleViews?: unknown };
  country: { declared?: string; verified?: string; effective?: string };
}

/** 정산 인정 조회수 우선, 없으면 총조회수 — 리워드/뷰 카운트 어디서나 이 우선순위를 쓴다. */
export function reportRowViews(row: ReportRowLike): number {
  return parseViewCount(row.metrics.eligibleViews ?? row.metrics.totalViews);
}

function reportRowCountryCode(row: ReportRowLike): string | null {
  const code = row.country.effective ?? row.country.verified ?? row.country.declared;
  return typeof code === "string" && ISO2_RE.test(code.toUpperCase()) ? code.toUpperCase() : null;
}

// ---- 콘텐츠 제출(scp_video_review_state) -------------------------------------------------------

export interface SubmissionRowLike {
  id: string;
  submittedAtIso: string;
  reviewStatus: string;
  youtubeVideoId?: string;
  title?: string;
  /** 검수 원장의 `applicationId` — 사람 식별자로 신뢰 가능한 유일한 필드(fluCreatorId 등은
   * `unclassified:*` 플레이스홀더가 잦아 참여 크리에이터 집계에 못 쓴다). */
  applicationId?: string;
}

export function splitSubmissionsByReviewStatus(rows: readonly SubmissionRowLike[]) {
  let pending = 0;
  let approved = 0;
  let rejected = 0;
  for (const row of rows) {
    if (isApprovedReviewStatus(row.reviewStatus)) approved += 1;
    else if (isRejectedReviewStatus(row.reviewStatus)) rejected += 1;
    else pending += 1;
  }
  return { total: rows.length, pending, approved, rejected };
}

export function filterRowsInPeriod<T extends { submittedAtIso: string }>(
  rows: readonly T[],
  period: Pick<ReportDashboardPeriod, "fromIso" | "toIsoExclusive">,
): T[] {
  return rows.filter((row) => isIsoInRange(row.submittedAtIso, period.fromIso, period.toIsoExclusive));
}

/** 소유자 규칙: 반려는 조회수·유니크 영상 집계에서 제외하되, 건수로는 계속 보인다. */
export function uniqueNonRejectedVideoIds(rows: readonly SubmissionRowLike[]): Set<string> {
  const set = new Set<string>();
  for (const row of rows) {
    if (isRejectedReviewStatus(row.reviewStatus)) continue;
    if (row.youtubeVideoId) set.add(row.youtubeVideoId);
  }
  return set;
}

export function countRejected(rows: readonly SubmissionRowLike[]): number {
  return rows.filter((row) => isRejectedReviewStatus(row.reviewStatus)).length;
}

export interface SubmittedVideoRow {
  date: string;
  youtubeVideoId: string;
  title: string;
  views: number | null;
  reviewStatus: string;
  tracked: boolean;
}

/** 영상당 최신 제출 1건 — 반려 제외 — 제출일 내림차순으로 최대 limit건. */
export function buildSubmittedVideoRows(
  rows: readonly SubmissionRowLike[],
  viewsByVideoId: ReadonlyMap<string, number>,
  limit = 100,
): SubmittedVideoRow[] {
  const latestByVideo = new Map<string, SubmissionRowLike>();
  for (const row of rows) {
    if (isRejectedReviewStatus(row.reviewStatus) || !row.youtubeVideoId) continue;
    const existing = latestByVideo.get(row.youtubeVideoId);
    if (!existing || Date.parse(row.submittedAtIso) > Date.parse(existing.submittedAtIso)) {
      latestByVideo.set(row.youtubeVideoId, row);
    }
  }
  return [...latestByVideo.values()]
    .sort((a, b) => Date.parse(b.submittedAtIso) - Date.parse(a.submittedAtIso))
    .slice(0, limit)
    .map((row) => {
      const videoId = row.youtubeVideoId as string;
      const tracked = viewsByVideoId.has(videoId);
      return {
        date: row.submittedAtIso,
        youtubeVideoId: videoId,
        title: row.title || videoId,
        views: tracked ? (viewsByVideoId.get(videoId) as number) : null,
        reviewStatus: row.reviewStatus,
        tracked,
      };
    });
}

// ---- 조회수 사다리(리포트 행 → video_view_rollups → 라이브 YouTube API) ----------------------
//
// 세 단(source)을 이 순서로 시도해 기간 내·반려 제외 영상 각각의 공개 조회수를 하나만 정한다.
// 어느 단도 못 찾으면 그 영상은 이 배열에서 아예 빠진다("unavailable" — 사다리 결과가 아니라
// viewsSource 카운트로만 남는다).
export type VideoViewSourceTier = "tracked" | "rollup" | "live";

export interface VideoViewResolutionRow {
  youtubeVideoId: string;
  views: number;
  title: string;
  publishedAt: string;
  source: VideoViewSourceTier;
}

export interface VideoViewsSourceSummary {
  /** 1단: video_performance_report_rows 조인(측정 확정 조회수). */
  tracked: number;
  /** 2단: video_view_rollups 캐시 조회수. */
  rollup: number;
  /** 3단: 라이브 YouTube Data API videos.list. */
  live: number;
  /** 세 단 모두 실패(영상 비공개/삭제, API 키 미설정, 쿼터 소진 등) — 조회수 0 취급. */
  unavailable: number;
}

// ---- 상위 영상 / 리워드 -------------------------------------------------------------------------

export interface TopVideoRow {
  rank: number;
  youtubeVideoId: string;
  title: string;
  views: number;
  publishedAt: string;
}

/** rows 는 이미 기간 내·반려 제외 영상으로 스코프돼서 온다(videoViewResolutions) — 여기서는
 * 랭킹·상한만 적용한다. */
export function topVideosInRange(
  rows: readonly VideoViewResolutionRow[],
  limit = 6,
): TopVideoRow[] {
  return [...rows]
    .sort((a, b) => b.views - a.views)
    .slice(0, limit)
    .map((row, index) => ({
      rank: index + 1,
      youtubeVideoId: row.youtubeVideoId,
      title: row.title,
      views: row.views,
      publishedAt: row.publishedAt,
    }));
}

/** "Views in 7-day measurement" — 각 영상 고유의 168h CPM 창 안에서 확정된 조회수 합(포털과 동일
 * 개념). 선택 기간과 무관한 스냅샷이라 period 필터를 받지 않는다. */
export function sumEligibleViews(rows: readonly ReportRowLike[]): number {
  return rows.reduce((sum, row) => sum + reportRowViews(row), 0);
}

export interface RewardByCountryRow {
  code: string;
  tierCode: string;
  cpmMicrosPerThousand: string;
  videos: number;
  views: number;
  estimatedRewardUsd: number;
}

export interface RewardSummary {
  estimatedRewardUsd: number;
  byCountry: RewardByCountryRow[];
}

/** minor(=USD센트, calculateViewCpmRewardMinor 계약) → USD. */
export function minorToUsd(minor: string): number {
  const n = Number(minor);
  return Number.isFinite(n) ? n / 100 : 0;
}

/** CPM 수학은 scpDashboardSnapshotContract 의 정본 함수만 쓴다 — 재구현 금지. */
export function estimateRewards(rows: readonly ReportRowLike[]): RewardSummary {
  const byCountry = new Map<string, { tierCode: string; cpmMicrosPerThousand: string; videos: number; views: number; minor: bigint }>();
  let totalMinor = 0n;
  for (const row of rows) {
    const code = reportRowCountryCode(row);
    if (!code) continue;
    const views = reportRowViews(row);
    if (views <= 0) continue;
    const policy = getViewCpmPolicyForCountry(code);
    const rewardMinor = BigInt(calculateViewCpmRewardMinor(String(views), policy.cpmMicrosPerThousand));
    totalMinor += rewardMinor;
    const existing = byCountry.get(code) ?? {
      tierCode: policy.tierCode,
      cpmMicrosPerThousand: policy.cpmMicrosPerThousand,
      videos: 0,
      views: 0,
      minor: 0n,
    };
    existing.videos += 1;
    existing.views += views;
    existing.minor += rewardMinor;
    byCountry.set(code, existing);
  }
  return {
    estimatedRewardUsd: minorToUsd(totalMinor.toString()),
    byCountry: [...byCountry.entries()]
      .map(([code, v]) => ({
        code,
        tierCode: v.tierCode,
        cpmMicrosPerThousand: v.cpmMicrosPerThousand,
        videos: v.videos,
        views: v.views,
        estimatedRewardUsd: minorToUsd(v.minor.toString()),
      }))
      .sort((a, b) => b.estimatedRewardUsd - a.estimatedRewardUsd),
  };
}

// ---- 운영 펄스(일자별) --------------------------------------------------------------------------

export interface PulseDay {
  date: string;
  applications: number;
  submissions: number;
  views: number;
}

export function countByKstDay(isoDates: readonly (string | null | undefined)[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const iso of isoDates) {
    const key = kstDateKey(iso);
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

export function sumByKstDay(entries: readonly { iso: string | null | undefined; value: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of entries) {
    const key = kstDateKey(entry.iso);
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + entry.value);
  }
  return map;
}

export function buildPulseDays(
  period: Pick<ReportDashboardPeriod, "fromDate" | "dayCount">,
  applicationDays: ReadonlyMap<string, number>,
  submissionDays: ReadonlyMap<string, number>,
  viewDays: ReadonlyMap<string, number>,
): PulseDay[] {
  const days: PulseDay[] = [];
  for (let i = 0; i < period.dayCount; i += 1) {
    const date = addDaysToDateStr(period.fromDate, i);
    days.push({
      date,
      applications: applicationDays.get(date) ?? 0,
      submissions: submissionDays.get(date) ?? 0,
      views: viewDays.get(date) ?? 0,
    });
  }
  return days;
}

// ---- 포털 브리지(계정 / 로그인 요청 / 국가 분포) -----------------------------------------------

export interface BridgeRowLike {
  status: string;
  loginRequestedAt?: string;
  approvalApplication?: { loginRequested?: boolean };
  profile: { country?: string };
}

export function summarizeBridgeAccounts(rows: readonly BridgeRowLike[]) {
  let approved = 0;
  let pending = 0;
  let rejected = 0;
  for (const row of rows) {
    if (row.status === "approved") approved += 1;
    else if (row.status === "rejected") rejected += 1;
    else pending += 1;
  }
  return { total: rows.length, approved, pending, rejected };
}

export function summarizeBridgeLoginRequests(rows: readonly BridgeRowLike[]) {
  const applications = rows.filter((row) => Boolean(row.approvalApplication)).length;
  const loginRequests = rows.filter(
    (row) => Boolean(row.loginRequestedAt) || row.approvalApplication?.loginRequested === true,
  ).length;
  const ratePct = applications > 0 ? round1((loginRequests / applications) * 100) : 0;
  return { applications, loginRequests, ratePct };
}

export interface CountryCount {
  code: string;
  count: number;
}

export function countryDistribution(countries: readonly (string | undefined)[]): CountryCount[] {
  const map = new Map<string, number>();
  for (const raw of countries) {
    const code = typeof raw === "string" && ISO2_RE.test(raw.toUpperCase()) ? raw.toUpperCase() : "XX";
    map.set(code, (map.get(code) ?? 0) + 1);
  }
  return [...map.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
}

// ---- 응답 조립 -----------------------------------------------------------------------------------

export interface ReportDashboardCoreInput {
  period: ReportDashboardPeriod;
  coldEmailsCount: number;
  repliesCount: number;
  applicationsCount: number;
  /** 펄스 차트 전용 — submittedAtIso 값만(프로젝션 조회), 상한·잘림 별도 표시. */
  applicationDayIsos: string[];
  applicationDaysTruncated: boolean;
  bridgeConfigured: boolean;
  bridgeRows: BridgeRowLike[];
  bridgeTruncated: boolean;
  /** 기간 내(period-scoped) 콘텐츠 제출 — scp_video_review_state 에서 이미 submittedAtIso 범위로
   * 걸러 넘어온다(상한 있음, 호출부가 픽스처·withdrawn·superseded 제외해서 넘긴다). all-time
   * 집계에는 쓰지 않는다 — 전체 건수가 상한을 넘으면 과거 구간이 조용히 0으로 보이는 사고를
   * 만들었던 자리다. */
  submissionRows: SubmissionRowLike[];
  submissionsTruncated: boolean;
  /** all-time 집계 전용 — count() 애그리게이션 2건(전체, state=="rejected")에서 온 정본 숫자.
   * 픽스처 제외는 적용되지 않는다(count() 는 문서를 읽지 않아 in-memory 필터를 못 태운다 —
   * 알려진 절충). */
  allTimeSubmissionsTotalCount: number;
  allTimeSubmissionsRejectedCount: number;
  /** viewReward 전용(1단만) — 측정 확정 조회수·CPM 리워드 산식의 유일한 입력. 공개 조회수
   * 사다리(videoViewResolutions)와 절대 섞지 않는다. */
  reportRows: ReportRowLike[];
  reportRowsTruncated: boolean;
  /** operations.videoViews/topVideos/pulse.days[*].views/submittedVideos 전용 — 기간 내·반려
   * 제외 영상마다 reportDashboard.ts 가 이미 3단 사다리로 해석해 넘긴 공개 조회수 1건씩. */
  videoViewResolutions: VideoViewResolutionRow[];
  videoViewsSource: VideoViewsSourceSummary;
  nowIso: string;
}

export interface ReportDashboardResponse {
  period: { fromDate: string; toDate: string };
  operations: {
    coldEmails: number;
    replies: number;
    replyRatePct: number;
    applications: number;
    loginRequests: number | null;
    loginRequestRatePct: number | null;
    contentSubmissions: { total: number; pending: number; approved: number; rejected: number };
    videoViews: number;
    viewsPerColdEmail: number;
  };
  topVideos: TopVideoRow[];
  viewReward: {
    participatingCreators: number;
    submittedContent: number;
    rejectedContent: number;
    viewsIn7dWindow: number;
    estimatedRewardUsd: number;
    byCountry: RewardByCountryRow[];
  };
  pulse: { days: PulseDay[] };
  submittedVideos: {
    uniqueInPeriod: number;
    rejectedInPeriod: number;
    /** 누적 제출 건수(반려 제외) — count() 애그리게이션 기준, "유니크 영상" 이 아니다. */
    allTimeSubmissions: number;
    withPublicViews: number;
    tracked: number;
    untracked: number;
    rows: SubmittedVideoRow[];
    /** 조회수 사다리 단(段)별 분포 — "실시간 조회 N편 · 미조회 N편" UI 문구의 근거. */
    viewsSource: VideoViewsSourceSummary;
  };
  creatorCountries: Array<{ code: string; name: string; count: number }>;
  portalAccounts: { total: number; approved: number; pending: number; rejected: number } | null;
  truncated: {
    applicationDays: boolean;
    bridge: boolean;
    submissions: boolean;
    reportRows: boolean;
  };
  generatedAtIso: string;
}

export function buildReportDashboardCore(input: ReportDashboardCoreInput): ReportDashboardResponse {
  const { period } = input;
  const submissionsInPeriod = filterRowsInPeriod(input.submissionRows, period);
  const contentSubmissions = splitSubmissionsByReviewStatus(submissionsInPeriod);

  // youtubeVideoId → 영상 성과 행(video_performance_report_rows, reportEligible 전용 유계 페치).
  // viewReward(리워드) 스코프 전용 — 조회수 사다리와 별개다(아래 참조).
  const reportRowsByVideoId = new Map<string, ReportRowLike>();
  for (const row of input.reportRows) reportRowsByVideoId.set(row.video.youtubeVideoId, row);

  // youtubeVideoId → 공개 조회수(3단 사다리 결과, reportDashboard.ts 가 이미 해석). 사다리 어느
  // 단도 못 찾은 영상은 이 맵에 없다 — untracked 로 센다(아래).
  const viewsByVideoId = new Map<string, number>();
  for (const row of input.videoViewResolutions) viewsByVideoId.set(row.youtubeVideoId, row.views);

  const uniqueInPeriodSet = uniqueNonRejectedVideoIds(submissionsInPeriod);
  const rejectedInPeriod = countRejected(submissionsInPeriod);
  const allTimeSubmissions = Math.max(0, input.allTimeSubmissionsTotalCount - input.allTimeSubmissionsRejectedCount);

  let tracked = 0;
  let withPublicViews = 0;
  for (const videoId of uniqueInPeriodSet) {
    if (viewsByVideoId.has(videoId)) {
      tracked += 1;
      if ((viewsByVideoId.get(videoId) ?? 0) > 0) withPublicViews += 1;
    }
  }
  const untracked = uniqueInPeriodSet.size - tracked;
  const videoViewsInPeriod = [...uniqueInPeriodSet].reduce((sum, id) => sum + (viewsByVideoId.get(id) ?? 0), 0);

  const submittedVideoRows = buildSubmittedVideoRows(submissionsInPeriod, viewsByVideoId, 100);
  const topVideos = topVideosInRange(input.videoViewResolutions, 6);
  // 뷰 리워드는 사다리(공개 조회수)가 아니라 1단(reportRows, 측정 확정 조회수)만 본다 —
  // estimateRewards 자체(CPM 계약)는 손대지 않는다.
  const rewardRows = [...uniqueInPeriodSet]
    .map((videoId) => reportRowsByVideoId.get(videoId))
    .filter((row): row is ReportRowLike => Boolean(row));
  const rewardSummary = estimateRewards(rewardRows);
  // viewsIn7dWindow 는 기간과 무관한 스냅샷(각 영상 고유 168h 측정창) — 전체 reportRows 그대로.
  const viewsIn7dWindow = sumEligibleViews(input.reportRows);
  // 참여 크리에이터 = 기간 내 제출(반려 포함 전체 상태)의 유니크 applicationId — 포털 실측과
  // 대조(2026-09-07): 반려 제외로 좁히면 33→19 로 포털(35)에서 더 멀어진다. "참여"는 반려 여부와
  // 무관하게 이 기간에 뭔가 제출한 크리에이터를 센다(제출/조회수 집계의 반려-제외 규칙과는 다른 축).
  const participatingCreators = new Set(
    submissionsInPeriod.map((row) => row.applicationId).filter((value): value is string => Boolean(value)),
  ).size;

  const applicationDays = countByKstDay(input.applicationDayIsos);
  const submissionDays = countByKstDay(submissionsInPeriod.map((row) => row.submittedAtIso));
  const viewDays = sumByKstDay(
    submissionsInPeriod
      .filter((row) => !isRejectedReviewStatus(row.reviewStatus) && row.youtubeVideoId)
      .map((row) => ({ iso: row.submittedAtIso, value: viewsByVideoId.get(row.youtubeVideoId as string) ?? 0 })),
  );
  const pulse = { days: buildPulseDays(period, applicationDays, submissionDays, viewDays) };

  const replyRatePct = input.coldEmailsCount > 0 ? round1((input.repliesCount / input.coldEmailsCount) * 100) : 0;
  const viewsPerColdEmail = input.coldEmailsCount > 0 ? round1(videoViewsInPeriod / input.coldEmailsCount) : 0;

  const bridgeAccounts = input.bridgeConfigured ? summarizeBridgeAccounts(input.bridgeRows) : null;
  const bridgeLogin = input.bridgeConfigured ? summarizeBridgeLoginRequests(input.bridgeRows) : null;
  const creatorCountries = input.bridgeConfigured
    ? countryDistribution(input.bridgeRows.map((row) => row.profile.country))
      .map((row) => ({ code: row.code, name: countryNameKo(row.code), count: row.count }))
    : [];

  return {
    period: { fromDate: period.fromDate, toDate: period.toDate },
    operations: {
      coldEmails: input.coldEmailsCount,
      replies: input.repliesCount,
      replyRatePct,
      applications: input.applicationsCount,
      loginRequests: bridgeLogin ? bridgeLogin.loginRequests : null,
      loginRequestRatePct: bridgeLogin ? bridgeLogin.ratePct : null,
      contentSubmissions,
      videoViews: videoViewsInPeriod,
      viewsPerColdEmail,
    },
    topVideos,
    viewReward: {
      participatingCreators,
      submittedContent: contentSubmissions.total,
      rejectedContent: contentSubmissions.rejected,
      viewsIn7dWindow,
      estimatedRewardUsd: rewardSummary.estimatedRewardUsd,
      byCountry: rewardSummary.byCountry,
    },
    pulse,
    submittedVideos: {
      uniqueInPeriod: uniqueInPeriodSet.size,
      rejectedInPeriod,
      allTimeSubmissions,
      withPublicViews,
      tracked,
      untracked,
      rows: submittedVideoRows,
      viewsSource: input.videoViewsSource,
    },
    creatorCountries,
    portalAccounts: bridgeAccounts,
    truncated: {
      applicationDays: input.applicationDaysTruncated,
      bridge: input.bridgeTruncated,
      submissions: input.submissionsTruncated,
      reportRows: input.reportRowsTruncated,
    },
    generatedAtIso: input.nowIso,
  };
}
