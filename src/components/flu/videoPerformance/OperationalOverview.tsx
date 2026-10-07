"use client";

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { B2DailySeriesPoint, VideoPerformanceReportRow } from "@/lib/videoPerformanceData";
import type {
  SettlementPipelineStage,
  VideoPerformanceReconciliationSummary,
  VideoPerformanceUniverseSummary,
} from "@/lib/videoPerformanceOperationalSemantics";
import type { VideoPerformanceTrendCoverage, VideoPerformanceTrendPoint } from "@/lib/videoPerformanceData";
import { formatKstDateTime, formatSignedDelta, formatShortDate, formatUsdMinor, formatViews } from "./formatters";

export function OperationalUniverseCards({ universes, reconciliation, settlementConfirmedAmountMinor = "0" }: {
  universes: VideoPerformanceUniverseSummary[];
  reconciliation: VideoPerformanceReconciliationSummary;
  settlementConfirmedAmountMinor?: string;
}) {
  const kpis = [
    { label: "총 조회수", value: formatViews(universes[1]?.totalViews ?? universes[0]?.totalViews), delta: formatSignedDelta(universes[1]?.dailyDeltaViews ?? "0"), note: "조회 추적 전체 참고 지표" },
    { label: "인정 조회수", value: formatViews(universes[0]?.recognizedViews), delta: formatSignedDelta(universes[0]?.dailyDeltaViews ?? "0"), note: "최신 승인본 정산 대상만" },
    { label: "마감 예정", value: `${reconciliation.settlementEligibleRows.toLocaleString("ko-KR")}편`, delta: `+${reconciliation.approvedEvidenceInDescriptiveRows.toLocaleString("ko-KR")}`, note: "승인 근거도 참고 지표와 분리" },
    { label: "정산 확정", value: formatUsdMinor(settlementConfirmedAmountMinor), delta: "운영 증명 미확인", note: "정확 168시간 운영 증명 없음" },
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-4" data-testid="video-performance-universe-cards">
      {kpis.map((metric) => (
        <Card key={metric.label} className="px-4 py-3">
          <div className="text-xs font-medium text-ink-3">{metric.label} ⓘ</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-black tracking-tight text-ink-1">{metric.value}</span>
            <span className="text-xs font-bold text-accent">{metric.delta}</span>
          </div>
          <p className="mt-2 text-[11px] text-ink-3">{metric.note}</p>
        </Card>
      ))}
    </div>
  );
}

export function UniverseReconciliationStrip({ universes, reconciliation }: {
  universes: VideoPerformanceUniverseSummary[];
  reconciliation: VideoPerformanceReconciliationSummary;
}) {
  return (
    <Card className="px-4 py-3" data-testid="video-performance-reconciliation-strip">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap gap-2">
          {universes.map((u) => (
            <Badge key={u.universe} tone={u.universe === "settlementEligible" ? "accent" : "info"}>
              {u.label}: {u.rowCount.toLocaleString("ko-KR")}건 · 총 {formatViews(u.totalViews)} · 인정 {formatViews(u.recognizedViews)}
            </Badge>
          ))}
          <Badge tone="warn">168시간 측정 마감 확인 대기</Badge>
          {(reconciliation.globalFetchTruncated || reconciliation.pageTruncated) && <Badge tone="warn">페이지/원천 조회 일부 절단됨</Badge>}
        </div>
        <div className="text-ink-3">
          대조 {formatKstDateTime(reconciliation.reconciledAtIso)} · 참고 지표 귀속 {reconciliation.descriptiveAttributedRows}/{reconciliation.descriptiveRows}
        </div>
      </div>
    </Card>
  );
}

export function TrendAndPipelinePanel({ trend, trendCoverage, pipeline, trackedState, trackedErrorMessage }: {
  trend: VideoPerformanceTrendPoint[];
  trendCoverage?: VideoPerformanceTrendCoverage;
  pipeline: SettlementPipelineStage[];
  trackedState?: "idle" | "loading" | "ready" | "empty" | "error";
  trackedErrorMessage?: string;
}) {
  const cumulativeMax = Math.max(1, ...trend.flatMap((point) => [Number(point.totalViews) || 0, Number(point.recognizedViews) || 0]));
  const dailyMax = Math.max(1, ...trend.flatMap((point) => [Number(point.dailyDeltaViews) || 0, Number(point.recognizedDailyDeltaViews) || 0]));
  const width = 620;
  const height = 118;
  const step = trend.length > 1 ? width / (trend.length - 1) : width;
  const totalPoints = trend.map((point, index) => `${index * step},${height - ((Number(point.totalViews) || 0) / cumulativeMax) * height}`).join(" ");
  const recognizedPoints = trend.map((point, index) => `${index * step},${height - ((Number(point.recognizedViews) || 0) / cumulativeMax) * height}`).join(" ");
  const last = trend.at(-1);
  const baseline = trendCoverage?.periodStartTotalViews ?? "0";
  const recognizedBaseline = trendCoverage?.periodStartRecognizedViews ?? "0";
  const endTotal = trendCoverage?.periodEndTotalViews ?? last?.totalViews ?? "0";
  const endRecognized = trendCoverage?.periodEndRecognizedViews ?? last?.recognizedViews ?? "0";
  const totalNetIncrease = trendCoverage?.periodNetIncreaseViews ?? "0";
  const recognizedNetIncrease = trendCoverage?.periodRecognizedNetIncreaseViews ?? "0";
  return (
    <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
      <Card className="p-4" data-testid="video-performance-trend-panel">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-bold text-ink-1">조회수 추이</h3>
          <div className="flex gap-3 text-[11px] text-ink-3"><span>누적 총조회</span><span>정산 인정 누적</span><span>일일 증가(별도 축)</span></div>
        </div>
        {trackedState === "loading" ? (
          <div className="mt-3 grid h-[126px] place-items-center rounded border border-line bg-fill/40 px-4 text-center text-xs font-medium text-ink-3">
            조회 추적 시계열을 불러오는 중입니다
          </div>
        ) : trackedState === "error" ? (
          <div className="mt-3 grid h-[126px] place-items-center rounded border border-dashed border-danger/40 bg-danger/5 px-4 text-center text-xs font-medium text-danger">
            {trackedErrorMessage || "조회 추적 참고 지표를 불러오지 못했습니다."}
          </div>
        ) : trend.length === 0 ? (
          <div className="mt-3 grid h-[126px] place-items-center rounded border border-dashed border-line bg-fill/40 px-4 text-center text-xs font-medium text-ink-3" aria-label="조회수 추이 원자료 없음">
            날짜별 실측 원자료가 아직 연결되지 않았습니다 · 현재 스냅샷을 추이로 표시하지 않습니다
          </div>
        ) : (
          <>
            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-4" data-testid="video-performance-period-semantics">
              <div><span className="text-ink-3">선택 기간</span><br /><b className="text-ink-1">{trendCoverage?.periodFrom ?? last?.label} → {trendCoverage?.periodTo ?? last?.label}</b></div>
              <div><span className="text-ink-3">시작 누적 기준</span><br /><b className="text-ink-1">{formatViews(baseline)}</b><span className="ml-1 text-ink-3">/ 인정 {formatViews(recognizedBaseline)}</span></div>
              <div><span className="text-ink-3">종료 누적</span><br /><b className="text-ink-1">{formatViews(endTotal)}</b><span className="ml-1 text-ink-3">/ 인정 {formatViews(endRecognized)}</span></div>
              <div><span className="text-ink-3">기간 순증</span><br /><b className="text-accent">{formatSignedDelta(totalNetIncrease)}</b><span className="ml-1 text-ink-3">/ 인정 {formatSignedDelta(recognizedNetIncrease)}</span></div>
            </div>
            <div className="mt-3 flex gap-2">
              <svg viewBox={`0 0 ${width} ${height}`} className="h-[126px] w-full overflow-visible" aria-label="총 조회수와 인정 조회수 추이">
                {trend.map((point, index) => {
                  const daily = Number(point.dailyDeltaViews) || 0;
                  const barHeight = dailyMax > 0 ? Math.min(height * 0.58, (daily / dailyMax) * height * 0.58) : 0;
                  return <rect key={point.label} x={index * step - 9} y={height - barHeight} width="18" height={barHeight} rx="3" fill="#c9d6ff" />;
                })}
                {trend.map((point, index) => {
                  const daily = Number(point.recognizedDailyDeltaViews) || 0;
                  const barHeight = dailyMax > 0 ? Math.min(height * 0.42, (daily / dailyMax) * height * 0.42) : 0;
                  return <rect key={`${point.label}-recognized`} x={index * step + 1} y={height - barHeight} width="8" height={barHeight} rx="2" fill="#7aa2ff" />;
                })}
                <polyline points={recognizedPoints} fill="none" stroke="#9db4ff" strokeWidth="2" strokeDasharray="5 4" />
                <polyline points={totalPoints} fill="none" stroke="#315af4" strokeWidth="2.5" />
              </svg>
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-ink-3">
              {trend.map((point) => <span key={point.label}>{formatShortDate(point.label)}</span>)}
            </div>
          </>
        )}
        {trendCoverage ? (
          <p className="mt-2 text-[11px] text-ink-3">
            원천 일별 조회수 시계열 · 날짜별 실측점 기반 · 이전 실측 누적 조회수 이월 적용 ·
            조회 추적 {trendCoverage.totalSeriesVideoCount}/{trendCoverage.selectedTotalVideoCount} ·
            인정 {trendCoverage.recognizedSeriesVideoCount}/{trendCoverage.selectedRecognizedVideoCount}
            {trendCoverage.partial ? " · 일부 원자료 누락" : ""}
            {trendCoverage.freshnessWatermarkIso ? ` · 최신 ${formatKstDateTime(trendCoverage.freshnessWatermarkIso)}` : ""}
          </p>
        ) : null}
      </Card>
      <Card className="p-4" data-testid="video-performance-settlement-pipeline">
        <h3 className="text-sm font-bold text-ink-1">정산 진행 현황</h3>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          {pipeline.map((stage, index) => (
            <div key={stage.key} className="flex items-center gap-2">
              <div className="text-center">
                <div className="grid h-12 w-12 place-items-center rounded-full border-2 border-accent text-base font-black text-accent">{stage.count}</div>
                <div className="mt-2 text-[11px] text-ink-2">{stage.label}</div>
              </div>
              {index < pipeline.length - 1 ? <span className="text-ink-4">→</span> : null}
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-ink-3">마감 대기: 168시간 도달 후에도 공식 운영 증명이 없으면 자동 확정하지 않습니다.</p>
      </Card>
    </div>
  );
}

// W6-4: 행 단위 실측 추이. 원자료는 `listTrackedVideoObservations` 응답에 이미 실려 오는
// `operations.rows[].metrics.dailySeries`(실측 video_view_series.points[])뿐이다 — 추가 서버 호출도,
// 새 차트 라이브러리도 쓰지 않는다. 점이 없으면 합성하지 않고 "시계열 수집 전"으로 남긴다.
export function RowMiniSparkline({
  row: _row,
  points = [],
}: {
  row: VideoPerformanceReportRow;
  points?: readonly B2DailySeriesPoint[];
}) {
  void _row;
  if (points.length === 0) {
    return (
      <div
        data-testid="video-performance-row-series-empty"
        className="grid h-16 place-items-center rounded border border-dashed border-line bg-fill/40 px-3 text-center text-[11px] font-medium text-ink-3"
      >
        시계열 수집 전 · 합성 추이는 표시하지 않음
      </div>
    );
  }
  const maxTotal = points.reduce((max, point) => {
    const value = BigInt(point.totalViews);
    return value > max ? value : max;
  }, 1n);
  return (
    <div data-testid="video-performance-row-series" className="rounded border border-line bg-paper p-2">
      <div className="flex h-16 items-end gap-1">
        {points.map((point) => {
          const height = Number((BigInt(point.totalViews) * 100n) / maxTotal);
          return (
            <div
              key={point.date}
              title={`${point.date} · 누적 ${point.totalViews} · 일일 증가 ${point.dailyDeltaViews}`}
              className="min-w-0 flex-1 rounded-t bg-accent/70"
              style={{ height: `${Math.max(4, height)}%` }}
            />
          );
        })}
      </div>
      <table className="mt-2 w-full text-[10px] text-ink-2">
        <thead className="text-ink-4">
          <tr>
            <th className="text-left font-semibold">날짜</th>
            <th className="text-right font-semibold">일일 증가</th>
            <th className="text-right font-semibold">누적</th>
          </tr>
        </thead>
        <tbody>
          {points.slice(-7).map((point) => (
            <tr key={`row-${point.date}`}>
              <td className="text-left">{point.date.slice(5)}</td>
              <td className="text-right tabular-nums">{formatViews(point.dailyDeltaViews)}</td>
              <td className="text-right tabular-nums">{formatViews(point.totalViews)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
