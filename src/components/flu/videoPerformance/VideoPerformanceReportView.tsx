"use client";

// 영상 성과 화면의 공용 조립체 — 전역 리포트 페이지(`/flu/report/video-performance`)와
// 파트너 상세 성과 탭(`PartnerPerformancePanel`)이 같은 계산 코어를 공유하도록 한다.
// Report layout now follows frozen mockup 10 density while preserving the hard semantic split:
// 조회 추적 참고 지표와 최신 승인본 정산 대상을 분리하고, 정확 168시간 운영 증명은 계속 fail-closed로 둔다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import {
  getVideoPerformanceDetail,
  getVideoPerformanceSummary,
  listTrackedVideoObservations,
  listVideoPerformanceLedger,
  type DescriptiveTrackingSummary,
  type SettlementDisplayState,
  type B2DailySeriesPoint,
  type VideoPerformanceLedgerFilter,
  type VideoPerformanceLedgerPage,
  type VideoPerformancePeriodInput,
  type VideoPerformanceReportRow,
  type VideoPerformanceRowDetail,
  type VideoPerformanceSummary,
  type VideoPerformanceTrendEnvelope,
} from "@/lib/videoPerformanceData";
import { publicCallableErrorMessage } from "@/lib/live";
import {
  buildSettlementPipeline,
  reconcileVideoPerformanceUniverses,
  summarizeDescriptiveUniverse,
  summarizeSettlementUniverse,
} from "@/lib/videoPerformanceOperationalSemantics";
import { VideoPerformanceLedger } from "./VideoPerformanceLedger";
import { TrackedVideoObservations } from "./TrackedVideoObservations";
import { PartnerPerformanceSummaryCards } from "./PartnerPerformanceSummaryCards";
import { PartnerPerformanceCalcPanel } from "./PartnerPerformanceCalcPanel";
import { OperationalUniverseCards, TrendAndPipelinePanel, UniverseReconciliationStrip } from "./OperationalOverview";
import { formatKstDateTime } from "./formatters";

export type VideoPerformanceViewState = "loading" | "ready" | "empty" | "stale" | "error" | "permission-denied";

const EMPTY_LEDGER_PAGE: VideoPerformanceLedgerPage = { rows: [], pageInfo: { nextCursor: null, truncated: false }, groupSubtotals: [] };
const EMPTY_TRACKED_PAGE: VideoPerformanceLedgerPage = { rows: [], pageInfo: { nextCursor: null, truncated: false }, groupSubtotals: [] };
const EMPTY_TREND: VideoPerformanceTrendEnvelope = {
  points: [],
  coverage: {
    sourceCollection: "video_view_series",
    periodFrom: "",
    periodTo: "",
    periodStartTotalViews: "0",
    periodStartRecognizedViews: "0",
    periodEndTotalViews: "0",
    periodEndRecognizedViews: "0",
    periodNetIncreaseViews: "0",
    periodRecognizedNetIncreaseViews: "0",
    selectedTotalVideoCount: 0,
    selectedRecognizedVideoCount: 0,
    totalSeriesVideoCount: 0,
    recognizedSeriesVideoCount: 0,
    totalPointCount: 0,
    recognizedPointCount: 0,
    carryForwardCumulativeViews: true,
    partial: true,
    unavailableReason: "no_selected_videos",
    freshnessWatermarkIso: null,
  },
};

function defaultWeekPeriod(): VideoPerformancePeriodInput {
  const to = new Date();
  const from = new Date(to.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { mode: "week", from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function periodForMode(mode: VideoPerformancePeriodInput["mode"]): VideoPerformancePeriodInput {
  const to = new Date();
  let days = 6;
  if (mode === "month") {
    days = 29;
  }
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { mode, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function isPermissionDeniedError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "permission-denied" || code === "functions/permission-denied";
}

function compact(value: string): string | undefined {
  const next = value.trim();
  return next ? next : undefined;
}

function selectClass() {
  return "h-9 rounded-lg border border-line bg-paper px-3 text-xs font-medium text-ink-2 outline-none focus:border-accent";
}

export function VideoPerformanceReportView({
  scopeFilter,
  title,
  description,
  layout = "band",
}: {
  scopeFilter: VideoPerformanceLedgerFilter;
  title: string;
  description: string;
  layout?: "band" | "cards";
}) {
  const [period, setPeriod] = useState<VideoPerformancePeriodInput>(defaultWeekPeriod);
  const [programId, setProgramId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [settlementState, setSettlementState] = useState<SettlementDisplayState | "">("");
  const [summary, setSummary] = useState<VideoPerformanceSummary | null>(null);
  const [summaryUpdatedAt, setSummaryUpdatedAt] = useState<string | null>(null);
  const [ledgerPage, setLedgerPage] = useState<VideoPerformanceLedgerPage>(EMPTY_LEDGER_PAGE);
  const [trackedPage, setTrackedPage] = useState<VideoPerformanceLedgerPage>(EMPTY_TRACKED_PAGE);
  // W6-4: 행 인라인 확장의 일자별 실측 시계열. `listTrackedVideoObservations` 응답의 additive
  // `operations` 에 이미 실려 오므로 **추가 서버 호출을 만들지 않는다**(ba5c2d7 배치 조회 재사용).
  const [dailySeriesByVideoId, setDailySeriesByVideoId] = useState<ReadonlyMap<string, readonly B2DailySeriesPoint[]>>(new Map());
  const [trackedSummary, setTrackedSummary] = useState<DescriptiveTrackingSummary | null>(null);
  const [trend, setTrend] = useState<VideoPerformanceTrendEnvelope>(EMPTY_TREND);
  const [trackedEnvelopeState, setTrackedEnvelopeState] = useState<"idle" | "loading" | "ready" | "empty" | "error">("idle");
  const [trackedEnvelopeError, setTrackedEnvelopeError] = useState("");
  const [globalFetchTruncated, setGlobalFetchTruncated] = useState(false);
  const [viewState, setViewState] = useState<VideoPerformanceViewState>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [rowDetail, setRowDetail] = useState<VideoPerformanceRowDetail | null>(null);
  const [rowDetailState, setRowDetailState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const loadGenerationRef = useRef(0);

  const combinedFilter = useMemo<VideoPerformanceLedgerFilter>(() => ({
    ...scopeFilter,
    ...(compact(programId) ? { programId: compact(programId) } : {}),
    ...(compact(campaignId) ? { campaignId: compact(campaignId) } : {}),
    ...(compact(countryCode) ? { countryCode: compact(countryCode)?.toUpperCase(), countryBasis: "effective" as const } : {}),
    ...(settlementState ? { settlementStates: [settlementState] } : {}),
  }), [scopeFilter, programId, campaignId, countryCode, settlementState]);

  const loadPage = useCallback(
    async (cursor: string | null) => {
      const generation = loadGenerationRef.current + 1;
      loadGenerationRef.current = generation;
      const isCurrentGeneration = () => loadGenerationRef.current === generation;
      setViewState((prev) => (prev === "ready" || prev === "stale" ? "stale" : "loading"));
      setErrorMessage("");
      setTrackedEnvelopeError("");
      setTrackedEnvelopeState(layout === "band" ? "loading" : "idle");
      if (layout === "band") {
        setTrackedPage(EMPTY_TRACKED_PAGE);
        setTrackedSummary(null);
        setTrend(EMPTY_TREND);
      }
      try {
        const [summaryRes, ledgerRes] = await Promise.all([
          getVideoPerformanceSummary({ period, filter: combinedFilter }),
          listVideoPerformanceLedger({ period, filter: combinedFilter, cursor, pageSize: 40 }),
        ]);
        if (!isCurrentGeneration()) return;
        setSummary(summaryRes.summary);
        setSummaryUpdatedAt(new Date().toISOString());
        setLedgerPage(ledgerRes);
        setGlobalFetchTruncated(summaryRes.globalFetchTruncated === true || ledgerRes.globalFetchTruncated === true);
        setViewState(ledgerRes.rows.length > 0 ? "ready" : "empty");
      } catch (error) {
        if (!isCurrentGeneration()) return;
        if (isPermissionDeniedError(error)) {
          setViewState("permission-denied");
          return;
        }
        setErrorMessage(publicCallableErrorMessage(error, "영상 성과 데이터를 불러오지 못했습니다."));
        setViewState("error");
      }
      if (layout !== "band") return;
      try {
        const trackedRes = await listTrackedVideoObservations({ enrollmentId: combinedFilter.enrollmentId, period, filter: combinedFilter, pageSize: 40 });
        if (!isCurrentGeneration()) return;
        setTrackedPage(trackedRes);
        setTrackedSummary(trackedRes.summary);
        setTrend(trackedRes.trend);
        setDailySeriesByVideoId(new Map(
          (trackedRes.operations?.rows ?? [])
            .filter((row) => row.video.youtubeVideoId && row.metrics.dailySeries.length > 0)
            .map((row) => [row.video.youtubeVideoId, row.metrics.dailySeries] as const),
        ));
        setTrackedEnvelopeState(trackedRes.rows.length > 0 ? "ready" : "empty");
      } catch (error) {
        if (!isCurrentGeneration()) return;
        setTrackedPage(EMPTY_TRACKED_PAGE);
        setTrackedSummary(null);
        setTrend(EMPTY_TREND);
        setDailySeriesByVideoId(new Map());
        setTrackedEnvelopeError(publicCallableErrorMessage(error, "조회 추적 참고 지표를 불러오지 못했습니다."));
        setTrackedEnvelopeState("error");
      }
    },
    [period, combinedFilter, layout],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!alive) return;
      await loadPage(null);
    })();
    return () => {
      alive = false;
    };
  }, [loadPage]);

  useEffect(() => {
    if (!selectedRowId) {
      setRowDetail(null);
      setRowDetailState("idle");
      return;
    }
    let alive = true;
    const selectedDescriptive = trackedPage.rows.find((row) => row.rowId === selectedRowId) ?? null;
    if (selectedDescriptive) {
      setRowDetail({
        row: selectedDescriptive,
        measurementWindow: {
          publishedAt: selectedDescriptive.video.publishedAt,
          measurementStartAt: selectedDescriptive.video.publishedAt,
          measurementEndExclusive: selectedDescriptive.metrics.measurementEndExclusive,
          finalizedAt: selectedDescriptive.metrics.finalizedAt,
          cutoffReached: Date.parse(new Date().toISOString()) >= Date.parse(selectedDescriptive.metrics.measurementEndExclusive),
        },
        countryEvidence: selectedDescriptive.country,
        displayAmounts: selectedDescriptive.settlement,
        diagnosticOnlyCounts: [{ kind: "manual", views: selectedDescriptive.metrics.totalViews, note: "조회 추적 참고 지표 — 정산 대상 아님" }],
        auditTimeline: [{ at: selectedDescriptive.lastSyncedAt, code: "tracking_observation_reference", detail: "조회 추적 참고 지표" }],
      });
      setRowDetailState("ready");
      return;
    }
    setRowDetailState("loading");
    getVideoPerformanceDetail({ rowId: selectedRowId })
      .then((res) => {
        if (!alive) return;
        setRowDetail(res.detail);
        setRowDetailState("ready");
      })
      .catch(() => {
        if (!alive) return;
        setRowDetailState("error");
      });
    return () => {
      alive = false;
    };
  }, [selectedRowId, trackedPage.rows]);

  const updatedAtLabel = useMemo(() => (summaryUpdatedAt ? formatKstDateTime(summaryUpdatedAt) : undefined), [summaryUpdatedAt]);
  const settlementUniverse = useMemo(() => summarizeSettlementUniverse(summary, ledgerPage.rows), [summary, ledgerPage.rows]);
  const descriptiveUniverse = useMemo(() => summarizeDescriptiveUniverse(trackedSummary, trackedPage.rows), [trackedSummary, trackedPage.rows]);
  const reconciliation = useMemo(() => reconcileVideoPerformanceUniverses({
    settlementRows: ledgerPage.rows,
    descriptiveRows: trackedPage.rows,
    descriptiveSummary: trackedSummary,
    globalFetchTruncated,
    pageTruncated: ledgerPage.pageInfo.truncated || trackedPage.pageInfo.truncated,
    reconciledAtIso: summaryUpdatedAt ?? new Date().toISOString(),
  }), [ledgerPage, trackedPage, trackedSummary, globalFetchTruncated, summaryUpdatedAt]);
  const pipeline = useMemo(() => buildSettlementPipeline(ledgerPage.rows), [ledgerPage.rows]);

  if (viewState === "permission-denied") {
    return <Card className="border-y border-line py-12 text-center text-sm font-medium text-ink-3">영상 성과 열람 권한이 없습니다 (manager 이상)</Card>;
  }

  return (
    <div className="space-y-4" data-testid="video-performance-operational-view">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-ink-1">{title}</h2>
          <p className="text-sm text-ink-3">{description}</p>
        </div>
        {layout === "band" && (
          <div className="flex flex-wrap justify-end gap-2" data-testid="video-performance-filter-bar">
            {(["week", "month", "range"] as const).map((mode) => (
              <Button key={mode} size="sm" variant={period.mode === mode ? "primary" : "secondary"} onClick={() => setPeriod(periodForMode(mode))}>
                {mode === "week" ? "주간" : mode === "month" ? "월간" : "구간"}
              </Button>
            ))}
            <input className={selectClass()} aria-label="기간 시작" type="date" value={period.from} onChange={(e) => setPeriod((prev) => ({ ...prev, mode: "range", from: e.target.value }))} />
            <input className={selectClass()} aria-label="기간 종료" type="date" value={period.to} onChange={(e) => setPeriod((prev) => ({ ...prev, mode: "range", to: e.target.value }))} />
            <input className={selectClass()} aria-label="프로그램 필터" placeholder="프로그램 전체" value={programId} onChange={(e) => setProgramId(e.target.value)} />
            <input className={selectClass()} aria-label="캠페인 필터" placeholder="캠페인 전체" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} />
            <input className={`${selectClass()} w-24`} aria-label="국가 필터" placeholder="국가 전체" value={countryCode} onChange={(e) => setCountryCode(e.target.value.slice(0, 2).toUpperCase())} />
            <select className={selectClass()} aria-label="정산 상태 필터" value={settlementState} onChange={(e) => setSettlementState(e.target.value as SettlementDisplayState | "")}>
              <option value="">정산 상태 전체</option>
              <option value="measurement_pending">마감 대기</option>
              <option value="calculation_ready">계산 완료</option>
              <option value="portal_confirmed">정산 확정</option>
              <option value="payable">지급 가능</option>
              <option value="disputed">예외/분쟁</option>
            </select>
          </div>
        )}
      </div>

      {viewState === "loading" && !summary ? (
        <LoadingStatus className="justify-center border-y border-line py-12">데이터를 불러오는 중입니다</LoadingStatus>
      ) : viewState === "error" ? (
        <Card className="py-8 text-center text-sm text-danger">{errorMessage || "요청을 처리하지 못했습니다."}</Card>
      ) : (
        <>
          {summary && layout === "cards" && <PartnerPerformanceSummaryCards summary={summary} rows={ledgerPage.rows} />}
          {summary && layout === "cards" && <PartnerPerformanceCalcPanel rows={ledgerPage.rows} />}
          {layout === "band" && (
            <>
              <OperationalUniverseCards universes={[settlementUniverse, descriptiveUniverse]} reconciliation={reconciliation} settlementConfirmedAmountMinor={summary?.settlementConfirmedAmountMinor} />
              <UniverseReconciliationStrip universes={[settlementUniverse, descriptiveUniverse]} reconciliation={reconciliation} />
              <TrendAndPipelinePanel trend={trend.points} trendCoverage={trend.coverage} pipeline={pipeline} trackedState={trackedEnvelopeState} trackedErrorMessage={trackedEnvelopeError} />
            </>
          )}
          {viewState === "stale" && <div className="text-xs text-warn">최신 데이터를 불러오는 중입니다 — 이전 값을 표시하고 있습니다.</div>}
          {layout === "band" && <div className="text-xs text-ink-3">마지막 동기화: {updatedAtLabel ?? "확인 중"} · 정산 168시간 정확 측정은 운영 증명 전까지 미확인으로 표시됩니다.</div>}
          <VideoPerformanceLedger
            page={ledgerPage}
            nowIso={new Date().toISOString()}
            onRequestPage={(cursor) => loadPage(cursor)}
            onSelectRow={setSelectedRowId}
            selectedRowId={selectedRowId}
            rowDetail={rowDetail}
            rowDetailState={rowDetailState}
            dailySeriesByVideoId={dailySeriesByVideoId}
            expandedProgramId={combinedFilter.programId}
          />
          {layout === "band" && (
            <TrackedVideoObservations
              enrollmentId={combinedFilter.enrollmentId}
              period={period}
              filter={combinedFilter}
              selectedRowId={selectedRowId}
              onSelectRow={setSelectedRowId}
            />
          )}
        </>
      )}
    </div>
  );
}
