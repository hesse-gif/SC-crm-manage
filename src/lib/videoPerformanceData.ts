// ── 영상 성과·정산 원장 클라이언트 페처 (Wave-2 UI lane) ───────────────────────────
// .specs/spec_video_performance_settlement_report/spec.md §7/§8 read callables의 typed client 계약.
// src/lib/data.ts의 callFluCallable 패턴(§8 규칙: 클라 Firestore 직접 read 금지, Functions callable 경유)을
// 그대로 재사용하되 data.ts 자체는 수정하지 않는다 — 여기서 호출하는 callable들은 아직 functions/index.ts에
// 등록(wiring)되지 않았으므로(이번 wave 비목표) src/lib/data.ts의 고정 FLU_CALLABLES 유니온에는 넣지 않는다.
//
// UI는 이 모듈만 import한다. functions/videoPerformanceReportProjection.ts의 순수 타입과 어긋나지 않도록
// row/summary/detail shape을 그대로 미러링한다.

export type UIntString = string;
export type MoneyMinorString = string;
export type IsoInstant = string;
export type IsoCountryCode = string;

export type TrackingState =
  | "not_eligible"
  | "registration_pending"
  | "active"
  | "stale"
  | "source_diverged"
  | "temporarily_failed"
  | "unavailable"
  | "cutoff_reached"
  | "retired_superseded"
  | "retired_withdrawn";

export type MeasurementState =
  | "not_started"
  | "collecting"
  | "cutoff_waiting_source"
  | "verification_pending"
  | "finalized"
  | "conflict"
  | "invalidated";

export type CountryEvidenceState =
  | "declared_only"
  | "oauth_pending"
  | "collecting"
  | "verified"
  | "ambiguous_tie"
  | "stale"
  | "failed";

export type SettlementDisplayState =
  | "not_eligible"
  | "estimated"
  | "measurement_pending"
  | "country_verification_pending"
  | "calculation_ready"
  | "delivery_pending"
  | "portal_review"
  | "portal_confirmed"
  | "payable"
  | "paid"
  | "disputed"
  | "adjustment_required"
  | "void";

export interface VideoPerformanceReportRow {
  rowId: string;
  isCurrentRevision: boolean;
  isApproved: boolean;
  creator: { fluCreatorId: string; displayName: string; handle: string; profileImageUrl?: string };
  scope: { enrollmentId: string; programId: string; programName: string; campaignId?: string; campaignName?: string };
  video: {
    videoSubmissionId: string;
    youtubeVideoId: string;
    canonicalUrl: string;
    title: string;
    thumbnailUrl?: string;
    channelTitle?: string;
    publishedAt: IsoInstant;
    revision: string;
  };
  // creatorRegion 은 정산 근거가 아니라 참고 표시다(출처 필드와 함께만 노출). 정산 국가는
  // declared/verified/effective 뿐이며 필터의 countryBasis 도 그 셋만 읽는다.
  country: {
    declared?: IsoCountryCode;
    verified?: IsoCountryCode;
    effective?: IsoCountryCode;
    state: CountryEvidenceState;
    creatorRegion?: IsoCountryCode;
    creatorRegionSource?: "countryCode" | "country" | "region";
  };
  metrics: {
    totalViews: UIntString;
    periodDeltaViews: UIntString;
    eligibleViews?: UIntString;
    excludedViews?: UIntString;
    measurementEndExclusive: IsoInstant;
    finalizedAt?: IsoInstant;
    lastObservedAt?: IsoInstant;
  };
  rate?: { tier: string; cpmMicrosPerThousand: UIntString; currency: "USD" };
  settlement: {
    state: SettlementDisplayState;
    estimatedAmountMinor?: MoneyMinorString;
    fluCalculatedAmountMinor?: MoneyMinorString;
    portalFinalAmountMinor?: MoneyMinorString;
    hasPortalReceipt: boolean;
  };
  trackingState: TrackingState;
  measurementState: MeasurementState;
  attentionCodes: string[];
  attentionRank: number;
  lastSyncedAt: IsoInstant;
}

export interface VideoPerformanceSummary {
  totalViews: string;
  periodDeltaViews: string;
  eligibleViews: string;
  cutoffPendingCount: number;
  settlementConfirmedAmountMinor: string;
  coverage: { complete: boolean; excludedRowCount: number; excludedReasons: string[] };
}

export interface VideoPerformanceGroupSubtotal {
  programId: string;
  campaignId?: string;
  rowCount: number;
  totalViews: string;
  eligibleViews: string;
}

export interface VideoPerformanceLedgerPage {
  rows: VideoPerformanceReportRow[];
  pageInfo: { nextCursor: string | null; truncated: boolean };
  groupSubtotals: VideoPerformanceGroupSubtotal[];
}

export interface VideoPerformanceLedgerFilter {
  enrollmentId?: string;
  programId?: string;
  campaignId?: string;
  countryBasis?: "declared" | "verified" | "effective";
  countryCode?: IsoCountryCode;
  trackingStates?: TrackingState[];
  settlementStates?: SettlementDisplayState[];
  includeExcludedRevisions?: boolean;
}

export interface VideoPerformanceRowDetail {
  row: VideoPerformanceReportRow;
  measurementWindow: {
    publishedAt: IsoInstant;
    measurementStartAt: IsoInstant;
    measurementEndExclusive: IsoInstant;
    finalizedAt?: IsoInstant;
    cutoffReached: boolean;
  };
  countryEvidence: {
    declared?: IsoCountryCode;
    verified?: IsoCountryCode;
    effective?: IsoCountryCode;
    state: CountryEvidenceState;
    creatorRegion?: IsoCountryCode;
    creatorRegionSource?: "countryCode" | "country" | "region";
  };
  displayAmounts: { estimatedAmountMinor?: MoneyMinorString; fluCalculatedAmountMinor?: MoneyMinorString; portalFinalAmountMinor?: MoneyMinorString };
  diagnosticOnlyCounts: { kind: "submitted" | "manual"; views: UIntString; note?: string }[];
  auditTimeline: { at: IsoInstant; code: string; detail?: string }[];
}

// Logical callable names this lane's server factories expose (functions/videoPerformanceReportProjection.ts
// §7 read callables). NOT yet present in src/lib/data.ts's FLU_CALLABLES/index.ts wiring — the integration
// leader registers these next wave. Calling them before that wiring lands yields a stable
// `functions/not-found` error, which the UI's error state below already renders explicitly.
type VideoPerformanceCallableName =
  | "getVideoPerformanceSummary"
  | "listVideoPerformanceLedger"
  | "getVideoPerformanceDetail"
  | "listTrackedVideoObservations";

async function callVideoPerformanceCallable<TResponse, TPayload extends object = Record<string, unknown>>(
  name: VideoPerformanceCallableName,
  payload: TPayload,
): Promise<TResponse> {
  const [{ httpsCallable }, { functions, getFluCallableName }] = await Promise.all([
    import("firebase/functions"),
    import("./firebase"),
  ]);
  const callable = httpsCallable<TPayload, TResponse>(functions, getFluCallableName(name));
  const result = await callable(payload);
  return result.data;
}

export interface VideoPerformancePeriodInput {
  mode: "week" | "month" | "range";
  from: string;
  to: string;
}

export interface GetVideoPerformanceSummaryPayload {
  period: VideoPerformancePeriodInput;
  filter?: VideoPerformanceLedgerFilter;
}

export interface GetVideoPerformanceSummaryEnvelope {
  ok: boolean;
  summary: VideoPerformanceSummary;
  periodClamped: boolean;
  globalFetchTruncated?: boolean;
}

export const getVideoPerformanceSummary = (payload: GetVideoPerformanceSummaryPayload) =>
  callVideoPerformanceCallable<GetVideoPerformanceSummaryEnvelope, GetVideoPerformanceSummaryPayload>("getVideoPerformanceSummary", payload);

export interface ListVideoPerformanceLedgerPayload {
  period: VideoPerformancePeriodInput;
  filter?: VideoPerformanceLedgerFilter;
  cursor?: string | null;
  pageSize?: number;
  sort?: string[];
}

export interface ListVideoPerformanceLedgerEnvelope extends VideoPerformanceLedgerPage {
  ok: boolean;
  globalFetchTruncated?: boolean;
}

export const listVideoPerformanceLedger = (payload: ListVideoPerformanceLedgerPayload) =>
  callVideoPerformanceCallable<ListVideoPerformanceLedgerEnvelope, ListVideoPerformanceLedgerPayload>("listVideoPerformanceLedger", payload);

export interface GetVideoPerformanceDetailPayload {
  rowId: string;
}

export interface GetVideoPerformanceDetailEnvelope {
  ok: boolean;
  detail: VideoPerformanceRowDetail;
}

export const getVideoPerformanceDetail = (payload: GetVideoPerformanceDetailPayload) =>
  callVideoPerformanceCallable<GetVideoPerformanceDetailEnvelope, GetVideoPerformanceDetailPayload>("getVideoPerformanceDetail", payload);

// GAP-B (FLU-0538 completion): descriptive tracked-video read surface. Shows the real
// video_view_series/video_view_snapshots tracked videos as report-only rows (always reportEligible=false —
// never settlement-eligible). Unattributed rows are honest "미귀속" markers, never a fabricated identity.
export interface DescriptiveTrackingSummary {
  trackedVideoCount: number;
  attributedCount: number;
  unattributedCount: number;
  approvedEvidenceCount: number;
  totalViews: string;
}

export interface VideoPerformanceTrendPoint {
  label: string;
  totalViews: string;
  recognizedViews: string;
  dailyDeltaViews: string;
  recognizedDailyDeltaViews: string;
}

export interface VideoPerformanceTrendCoverage {
  sourceCollection: "video_view_series";
  periodFrom: string;
  periodTo: string;
  periodStartTotalViews: string;
  periodStartRecognizedViews: string;
  periodEndTotalViews: string;
  periodEndRecognizedViews: string;
  periodNetIncreaseViews: string;
  periodRecognizedNetIncreaseViews: string;
  selectedTotalVideoCount: number;
  selectedRecognizedVideoCount: number;
  totalSeriesVideoCount: number;
  recognizedSeriesVideoCount: number;
  totalPointCount: number;
  recognizedPointCount: number;
  carryForwardCumulativeViews: true;
  partial: boolean;
  unavailableReason?: "no_selected_videos" | "no_series_points_in_period";
  freshnessWatermarkIso: string | null;
}

export interface VideoPerformanceTrendEnvelope {
  points: VideoPerformanceTrendPoint[];
  coverage: VideoPerformanceTrendCoverage;
}

// ── B2 운영 모니터링 (B2-3) ─────────────────────────────────────────────────────────
// 같은 callable 응답의 additive `operations` 만 읽는다. CPM 숫자·예상/계산 금액은 서버 투영에서
// 이미 빠져 있고(P2), 이 래퍼가 `rows`/`trend`(리포트용, 금액 포함)를 **버리고** operations 만
// 돌려주므로 B2 화면 코드에는 금액이 도달할 경로 자체가 없다.

export type B2AudienceAuthority = "declared" | "youtube_verified";

export type B2AudienceState =
  | "declared_only"
  | "collecting"
  | "verified"
  | "stale"
  | "reauth_required"
  | "failed"
  /** W63: 신고값 대신 **발굴 시점 관측값**을 보여 주는 상태(출처 라벨 필수). */
  | "initial_observed"
  /** W63: 신고값이 영원히 오지 않고 관측 원천도 없다 — "대기"가 아니라 미확인이다. */
  | "unresolved_no_source"
  | "unavailable";

export type B2OperationsBucket = "active" | "settled" | "unclassified";

export interface B2AudienceCountryShare {
  countryCode: string;
  views: UIntString;
  shareBps: UIntString;
}

export interface B2AudienceProjection {
  authority: B2AudienceAuthority;
  declaredCountryCode: string | null;
  /** W62-6: 신고 국가 투영 시도 횟수. 0 = 아직 시도 전 / 1 이상 = 시도했고 실패했다. */
  declaredCountryAttempts?: number;
  /**
   * W63: **관측** 초기 국가와 그 출처. 신고값이 아니다 —
   * 화면은 반드시 출처를 함께 표기하고, 발송 국가 하드 게이트에는 쓰지 않는다.
   */
  initialCountryCode?: string | null;
  initialCountrySource?: string | null;
  verifiedObservationRef: string | null;
  verifiedPrimaryCountryCode: string | null;
  countries: B2AudienceCountryShare[];
  window: { startDate: string; endDate: string } | null;
  collectedAtIso: string | null;
  status: B2AudienceState;
}

export interface B2DailySeriesPoint {
  date: string;
  totalViews: UIntString;
  dailyDeltaViews: UIntString;
}

export interface B2OperationalRow {
  rowId: string;
  reviewStage: string | null;
  trackingStage: string;
  program: { id: string; name: string };
  campaign: { id: string | null; name: string | null };
  creator: { id: string; displayName: string; handle: string; profileImageUrl: string | null };
  video: {
    submissionId: string;
    youtubeVideoId: string;
    title: string;
    url: string;
    thumbnailUrl: string | null;
  };
  submittedAtIso: string | null;
  cutoffAtIso: string | null;
  settledFromIso: string | null;
  remainingMs: number | null;
  listBucket: B2OperationsBucket;
  metrics: {
    totalViews: UIntString | null;
    eligibleViews: UIntString | null;
    latestDailyDeltaViews: UIntString | null;
    sevenDayDeltaViews: UIntString | null;
    dailySeries: B2DailySeriesPoint[];
    freshnessWatermarkIso: string | null;
  };
  collectionState: "not_started" | "healthy" | "missing_today" | "stalled_48h";
  audience: B2AudienceProjection;
  cpmPolicyApplied: boolean;
  cpmDisplay: "CPM 비공개";
}

export interface B2OperationalRowsEnvelope {
  generatedAtIso: string;
  rows: B2OperationalRow[];
  nextCursor: string | null;
  globalFetchTruncated: boolean;
  /** R3③: 검수 head universe 가 상한에서 잘렸는지. 화면은 이 사실을 숨기지 않는다. */
  universeTruncated: boolean;
}

export interface ListTrackedVideoObservationsPayload {
  enrollmentId?: string;
  period?: VideoPerformancePeriodInput;
  filter?: VideoPerformanceLedgerFilter;
  cursor?: string | null;
  pageSize?: number;
}

export interface ListTrackedVideoObservationsEnvelope extends VideoPerformanceLedgerPage {
  ok: boolean;
  summary: DescriptiveTrackingSummary;
  globalFetchTruncated: boolean;
  trend: VideoPerformanceTrendEnvelope;
  /**
   * B2-3 에서 같은 응답에 additive 로 실린 운영 투영. W6-4 의 리포트 행 인라인 확장은 **추가 서버
   * 호출 없이** 여기 실린 행별 `metrics.dailySeries`(실측 video_view_series.points[])를 재사용한다.
   */
  operations?: {
    generatedAtIso: string;
    rows: B2OperationalRow[];
    /** R3③: universe 상한 절단 — UI 가 "전체"인 척하지 않도록 그대로 노출한다. */
    universeTruncated?: boolean;
    limits?: { universe: number; universeScanned: number; performancePage: number };
  };
}

export const listTrackedVideoObservations = (payload: ListTrackedVideoObservationsPayload) =>
  callVideoPerformanceCallable<ListTrackedVideoObservationsEnvelope, ListTrackedVideoObservationsPayload>(
    "listTrackedVideoObservations",
    payload,
  );

export const listB2OperationalRows = async (
  payload: ListTrackedVideoObservationsPayload = {},
): Promise<B2OperationalRowsEnvelope> => {
  const envelope = await callVideoPerformanceCallable<
    ListTrackedVideoObservationsEnvelope,
    ListTrackedVideoObservationsPayload
  >("listTrackedVideoObservations", payload);
  return {
    generatedAtIso: envelope.operations?.generatedAtIso ?? "",
    rows: envelope.operations?.rows ?? [],
    nextCursor: envelope.pageInfo?.nextCursor ?? null,
    globalFetchTruncated: Boolean(envelope.globalFetchTruncated),
    universeTruncated: envelope.operations?.universeTruncated === true,
  };
};

/**
 * E7 (2026-09-05 Aside 실측): `/flu/scp?tab=ops` 가 "측정 운영 중 0" · "정산 완료 0" 을
 * "요청을 처리하지 못했습니다" 와 동시에 보여줬다 — 실패와 무데이터를 구분할 수 없었다.
 * B2OperationalMonitor 가 로딩/실패/성공 세 화면 결정을 각자 인라인 불리언으로 흩어 계산하던
 * 것을 여기 순수 함수 하나로 뽑는다 — 상태별 렌더 규칙을 값으로 확인할 수 있어야 한다.
 *
 *   · countsKnown  — 배지 숫자(측정 운영 중/정산 완료)를 실제 값으로 보여줘도 되는가.
 *                    아직 확정되지 않은 0(첫 로딩 중이거나 실패한 직후)은 절대 숫자로 보여주지
 *                    않는다 — 이전에 성공한 데이터가 있으면(hasRows) 새로고침 중에도 그 값을
 *                    계속 보여준다(깜빡이며 0으로 떨어지지 않게).
 *   · showEmptyState — "운영 중인 영상이 없습니다" 같은 무데이터 문구. 실패 중에는 절대
 *                    보여주지 않는다(무데이터처럼 보이면 운영자가 재시도 대신 방치한다).
 *   · showSkeleton  — 첫 로딩(아직 아무 데이터도 없음)에서만 전체 스켈레톤을 보여준다.
 */
export interface B2OperationalMonitorDisplayState {
  readonly countsKnown: boolean;
  readonly showEmptyState: boolean;
  readonly showSkeleton: boolean;
}

export function b2OperationalMonitorDisplayState(input: {
  readonly loading: boolean;
  readonly hasError: boolean;
  readonly hasRows: boolean;
}): B2OperationalMonitorDisplayState {
  return {
    countsKnown: input.hasRows || (!input.loading && !input.hasError),
    showEmptyState: !input.loading && !input.hasError,
    showSkeleton: input.loading && !input.hasRows,
  };
}
