"use client";

// 조회 추적 참고 지표 영역. 정산 원장과 의도적으로 분리한다:
// 참고 지표 행은 운영 커버리지와 실제 조회수를 설명할 수 있지만 정산 대상으로
// 화면 표시만으로 승격되거나 정확 168시간 완료로 처리되지 않는다.
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import {
  listTrackedVideoObservations,
  type DescriptiveTrackingSummary,
  type VideoPerformanceLedgerFilter,
  type VideoPerformanceLedgerPage,
  type VideoPerformancePeriodInput,
  type VideoPerformanceReportRow,
} from "@/lib/videoPerformanceData";
import { publicCallableErrorMessage } from "@/lib/live";
import { excludedViewsForRow } from "@/lib/videoPerformanceOperationalSemantics";
import { COUNTRY_EVIDENCE_STATE_LABEL, formatKstDateTime, formatRemainingToCutoff, formatSignedDelta, formatViews, SETTLEMENT_STATE_LABEL, TRACKING_STATE_LABEL } from "./formatters";
import { RowMiniSparkline } from "./OperationalOverview";

type State = "loading" | "ready" | "empty" | "error" | "permission-denied";

const COLUMNS = ["영상", "총 조회수", "일일 증가", "게시일", "마감", "귀속", "상태"];

function isPermissionDenied(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "permission-denied" || code === "functions/permission-denied";
}

function publishedLabel(iso: string): string {
  if (!iso || iso.startsWith("1970-01-01")) return "—";
  return iso.slice(0, 10);
}

function thumbnailUrl(row: VideoPerformanceReportRow): string {
  if (row.video.thumbnailUrl) return row.video.thumbnailUrl;
  const id = row.video.youtubeVideoId;
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : "";
}

export function TrackedVideoObservations({
  enrollmentId,
  title = "추적 중 영상 · 정산 전 참고 지표",
  description = "기존 조회 추적 영상입니다. 최신 승인본 정산 원장과 분리되어 있으며, 실측 조회수만 표시하고 정산 대상이 아닙니다.",
  period,
  filter,
  selectedRowId,
  onSelectRow,
}: {
  enrollmentId?: string;
  period?: VideoPerformancePeriodInput;
  filter?: VideoPerformanceLedgerFilter;
  title?: string;
  description?: string;
  selectedRowId?: string | null;
  onSelectRow?: (rowId: string | null) => void;
}) {
  const [page, setPage] = useState<VideoPerformanceLedgerPage>({ rows: [], pageInfo: { nextCursor: null, truncated: false }, groupSubtotals: [] });
  const [summary, setSummary] = useState<DescriptiveTrackingSummary | null>(null);
  const [state, setState] = useState<State>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([null]);
  const [globalFetchTruncated, setGlobalFetchTruncated] = useState(false);

  const load = useCallback((cursor: string | null) => {
    setState("loading");
    listTrackedVideoObservations({ enrollmentId, period, filter, pageSize: 40, cursor })
      .then((res) => {
        setPage(res);
        setSummary(res.summary);
        setGlobalFetchTruncated(res.globalFetchTruncated === true);
        setState(res.rows.length === 0 ? "empty" : "ready");
      })
      .catch((error) => {
        if (isPermissionDenied(error)) {
          setState("permission-denied");
          return;
        }
        setErrorMessage(publicCallableErrorMessage(error, "추적 영상 데이터를 불러오지 못했습니다."));
        setState("error");
      });
  }, [enrollmentId, period, filter]);

  useEffect(() => {
    setCursorHistory([null]);
    load(null);
  }, [load]);

  if (state === "permission-denied") return null;
  const selected = page.rows.find((row) => row.rowId === selectedRowId) ?? null;

  return (
    <div className="space-y-2" data-testid="video-performance-descriptive-section" role="region" aria-label="조회 추적 참고 지표">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold text-ink-1">{title}</h3>
        {summary && (
          <p className="text-xs text-ink-3">
            총 {summary.trackedVideoCount.toLocaleString()}개 · 현재 페이지 {page.rows.length.toLocaleString()}개 · 귀속 {summary.attributedCount.toLocaleString()} / 미귀속 {summary.unattributedCount.toLocaleString()} · 누적 {formatViews(summary.totalViews)}
          </p>
        )}
      </div>
      <p className="text-xs text-ink-3">{description}</p>

      {state === "loading" && page.rows.length === 0 ? (
        <LoadingStatus className="justify-center border-y border-line py-10">추적 영상을 불러오는 중입니다</LoadingStatus>
      ) : state === "error" ? (
        <Card className="py-8 text-center text-sm text-danger">{errorMessage || "요청을 처리하지 못했습니다."}</Card>
      ) : state === "empty" ? (
        <Card className="grid place-items-center py-12 text-center text-sm text-ink-3">추적 중인 영상이 없습니다</Card>
      ) : (
        <Card className="p-0">
          <div className="overflow-x-auto" style={{ maxHeight: 540 }}>
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-paper">
                <tr>
                  {COLUMNS.map((col) => (
                    <th key={col} className="border-b border-line px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-ink-3">{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row) => {
                  const attributed = row.creator.fluCreatorId.length > 0;
                  const selected = selectedRowId === row.rowId;
                  return (
                    <tr key={row.rowId} role="button" tabIndex={0} aria-label={`${row.video.title || row.video.youtubeVideoId} 상세 열기`} onClick={() => onSelectRow?.(selected ? null : row.rowId)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectRow?.(selected ? null : row.rowId); } }} className={`cursor-pointer border-b border-line/60 last:border-b-0 hover:bg-fill/60 focus:outline-none focus:ring-2 focus:ring-accent ${selected ? "bg-accent-soft/40" : ""}`}>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-3">
                          <a href={row.video.canonicalUrl} target="_blank" rel="noreferrer" aria-label={`${row.video.title || row.video.youtubeVideoId} YouTube 썸네일 열기`} className="block shrink-0" onClick={(e) => e.stopPropagation()}>
                            {thumbnailUrl(row) ? <img src={thumbnailUrl(row)} alt={`${row.video.title || row.video.youtubeVideoId} 썸네일`} loading="lazy" referrerPolicy="no-referrer" className="h-11 w-20 rounded bg-fill object-cover" /> : <div aria-hidden="true" className="h-11 w-20 rounded bg-fill" />}
                          </a>
                          <div className="min-w-0">
                            <a href={row.video.canonicalUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="line-clamp-2 font-medium text-ink-1 hover:underline">{row.video.title || row.video.youtubeVideoId}</a>
                            {row.video.channelTitle ? <p className="truncate text-xs text-ink-3">{row.video.channelTitle}</p> : null}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 tabular-nums font-semibold text-ink-1">{formatViews(row.metrics.totalViews)}</td>
                      <td className="px-3 py-2 tabular-nums font-semibold text-accent">{formatSignedDelta(row.metrics.periodDeltaViews)}</td>
                      <td className="px-3 py-2 text-ink-3">{publishedLabel(row.video.publishedAt)}</td>
                      <td className="px-3 py-2 text-xs text-ink-2">{formatRemainingToCutoff(new Date().toISOString(), row.metrics.measurementEndExclusive)}</td>
                      <td className="px-3 py-2">{attributed ? <span className="text-ink-2">{row.creator.displayName}</span> : <span className="rounded bg-fill px-1.5 py-0.5 text-xs font-medium text-ink-3">미귀속</span>}</td>
                      <td className="px-3 py-2"><Badge tone="neutral">정산 제외</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-ink-3">
            <span>{globalFetchTruncated ? "원천 조회 상한 도달" : "원천 조회 정상"} · {page.pageInfo.truncated ? "다음 페이지 있음" : "현재 마지막 페이지"}</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={cursorHistory.length <= 1} onClick={() => { const next = cursorHistory.slice(0, -1); setCursorHistory(next); load(next[next.length - 1] ?? null); }}>이전</Button>
              <Button variant="secondary" size="sm" aria-label="조회 추적 참고 지표 다음 페이지" disabled={!page.pageInfo.nextCursor} onClick={() => { if (!page.pageInfo.nextCursor) return; setCursorHistory((prev) => [...prev, page.pageInfo.nextCursor]); load(page.pageInfo.nextCursor); }}>다음</Button>
            </div>
          </div>
        </Card>
      )}

      {selected && (
        <Card className="grid gap-4 p-4 lg:grid-cols-[300px_1fr]" data-testid="video-performance-expanded-row-panel">
          <div>
            <div className="text-[11px] font-black uppercase tracking-wide text-accent">확장 행 · 참고 지표</div>
            <h3 className="mt-1 text-base font-black text-ink-1">{selected.video.title || selected.video.youtubeVideoId}</h3>
            <p className="mt-1 text-xs text-ink-3">{selected.creator.displayName} · {selected.scope.programName}</p>
            <div className="mt-3 space-y-1 text-xs text-ink-2">
              <div>게시: {formatKstDateTime(selected.video.publishedAt)}</div>
              <div>영상 링크: <a href={selected.video.canonicalUrl} target="_blank" rel="noreferrer" className="text-accent underline">YouTube 열기 ↗</a></div>
              <div>정산 분류: 조회 추적 참고 지표(정산 대상 아님)</div>
              <div>정확 168시간 운영 증명: 미확인</div>
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-4">
            <div><div className="text-xs font-bold text-ink-3">성과 추이</div><RowMiniSparkline row={selected} /></div>
            <div className="space-y-1 text-xs text-ink-2"><div className="font-bold text-ink-3">진단</div><div>총 조회수 {formatViews(selected.metrics.totalViews)}</div><div>일일 증가 {formatSignedDelta(selected.metrics.periodDeltaViews)}</div><div>{TRACKING_STATE_LABEL[selected.trackingState]}</div></div>
            <div className="space-y-1 text-xs text-ink-2"><div className="font-bold text-ink-3">컷오프 / 제외</div><div>구간: {formatKstDateTime(selected.video.publishedAt)} → {formatKstDateTime(selected.metrics.measurementEndExclusive)}</div><div>제외 조회수 {formatViews(excludedViewsForRow(selected))}</div><div>사유: 조회 추적 참고 지표는 정산 제외</div></div>
            <div className="space-y-1 text-xs text-ink-2"><div className="font-bold text-ink-3">국가/정산 내역</div><div>{COUNTRY_EVIDENCE_STATE_LABEL[selected.country.state]}</div><div>{SETTLEMENT_STATE_LABEL[selected.settlement.state]}</div><div>포털 확정 영수증 없음</div></div>
          </div>
        </Card>
      )}
    </div>
  );
}
