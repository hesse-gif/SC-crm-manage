"use client";

// C4 유튜브 링크 일일 모니터링 패널 — 제출물 YouTube 링크의 조회수 시계열(총조회·일일증분·성장률) + 댓글 감성.
//   데이터는 getVideoViewSeries 콜러블(video_view_series)에서 로드. 스냅샷은 스케줄러(매일 05:40 KST)가 적재.
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { getVideoViewSeries, runVideoViewSnapshots, type VideoViewSeriesEnvelope } from "@/lib/data";
import { publicCallableErrorMessage } from "@/lib/live";
import { normalizeVideoId } from "@/lib/scp-alias-id";

type Series = NonNullable<VideoViewSeriesEnvelope["series"]>;
type Monitor = NonNullable<VideoViewSeriesEnvelope["monitor"]>;

function kstDate(nowMs: number): string {
  return new Date(nowMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 수집 신선도: 오늘(KST) 수집이면 최신, 그 외 데이터 보유 시 오래됨.
function freshness(series: Series | null, monitor: Monitor | null): "fresh" | "stale" | "none" {
  const lastDate = monitor?.lastSnapshotDate || series?.updatedAtIso?.slice(0, 10) || "";
  if (!lastDate) return "none";
  return lastDate === kstDate(Date.now()) ? "fresh" : "stale";
}

export function VideoViewSeriesPanel({ youtubeUrl, submissionId }: { youtubeUrl?: string; submissionId?: string }) {
  const videoId = normalizeVideoId(youtubeUrl);
  const [series, setSeries] = useState<Series | null>(null);
  const [monitor, setMonitor] = useState<Monitor | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifecycleSequenceRef = useRef(0);
  const loadSequenceRef = useRef(0);
  const snapshotSequenceRef = useRef(0);

  const load = useCallback(async (lifecycleSequence: number) => {
    if (!videoId) return;
    const loadSequence = ++loadSequenceRef.current;
    const isCurrent = () => lifecycleSequenceRef.current === lifecycleSequence
      && loadSequenceRef.current === loadSequence;
    setLoading(true);
    setError(null);
    try {
      const res = await getVideoViewSeries({ videoId });
      if (isCurrent()) {
        setSeries((res as VideoViewSeriesEnvelope).series ?? null);
        setMonitor((res as VideoViewSeriesEnvelope).monitor ?? null);
      }
    } catch (e) {
      if (isCurrent()) setError(publicCallableErrorMessage(e, "시계열을 불러오지 못했습니다."));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [videoId]);

  useEffect(() => {
    const lifecycleSequence = ++lifecycleSequenceRef.current;
    if (!videoId) {
      loadSequenceRef.current += 1;
      snapshotSequenceRef.current += 1;
      setSeries(null);
      setLoading(false);
      setBusy(false);
      setError(null);
      return;
    }
    setBusy(false);
    void load(lifecycleSequence);
    return () => {
      if (lifecycleSequenceRef.current === lifecycleSequence) lifecycleSequenceRef.current += 1;
      loadSequenceRef.current += 1;
      snapshotSequenceRef.current += 1;
    };
  }, [load, videoId]);

  const snapshotNow = async () => {
    if (!videoId || busy) return;
    const lifecycleSequence = lifecycleSequenceRef.current;
    const snapshotSequence = ++snapshotSequenceRef.current;
    const isCurrent = () => lifecycleSequenceRef.current === lifecycleSequence
      && snapshotSequenceRef.current === snapshotSequence;
    setBusy(true);
    setError(null);
    try {
      await runVideoViewSnapshots({ videoId, submissionId });
      if (isCurrent()) await load(lifecycleSequence);
    } catch (e) {
      if (isCurrent()) setError(publicCallableErrorMessage(e, "스냅샷 수집에 실패했습니다."));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  if (!videoId) {
    // URL이 있는데 정규화가 불가능하면 숨기지 말고 URL 오류를 표시한다.
    if (typeof youtubeUrl === "string" && youtubeUrl.trim()) {
      return (
        <div data-testid="video-view-series" className="rounded-md border border-line">
          <div className="border-b border-line bg-fill px-3 py-2 text-[11px] font-semibold text-ink-2">📈 유튜브 조회수 시계열 · 일일 모니터링</div>
          <div className="px-3 py-2.5 text-[11px] text-danger" data-testid="series-url-error">
            제출 링크가 YouTube 주소로 인식되지 않습니다 — youtube.com/youtu.be 링크인지 확인해 주세요.
          </div>
        </div>
      );
    }
    return null;
  }

  const freshState = freshness(series, monitor);
  const monitorUnavailable = monitor?.status === "unavailable" || monitor?.status === "retired_unavailable";

  const points = series?.points ?? [];
  const maxViews = points.reduce((m, p) => Math.max(m, p.views), 0) || 1;
  const sentiment = series?.commentInsights?.sentimentPct ?? null;

  return (
    <div data-testid="video-view-series" className="rounded-md border border-line">
      <div className="flex items-center justify-between border-b border-line bg-fill px-3 py-2 text-[11px] font-semibold text-ink-2">
        <span>📈 유튜브 조회수 시계열 · 일일 모니터링</span>
        <Button size="sm" variant="ghost" className="h-7" disabled={busy || loading} onClick={snapshotNow}>{busy ? "수집 중…" : "지금 스냅샷"}</Button>
      </div>
      <div className="space-y-2.5 px-3 py-2.5">
        {loading ? (
          <div className="text-[11px] text-ink-4">불러오는 중…</div>
        ) : series && points.length > 0 ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded bg-fill px-2.5 py-2"><div className="text-[10px] text-ink-3">총 조회수</div><div data-testid="series-total-views" className="mt-0.5 text-sm font-bold text-ink tabular-nums">{series.totalViews.toLocaleString()}</div></div>
              <div className="rounded bg-fill px-2.5 py-2"><div className="text-[10px] text-ink-3">일일 증분</div><div className="mt-0.5 text-sm font-bold text-ink tabular-nums">+{series.latestDailyDeltaViews.toLocaleString()}</div></div>
              <div className="rounded bg-fill px-2.5 py-2"><div className="text-[10px] text-ink-3">성장률</div><div className="mt-0.5 text-sm font-bold text-ink tabular-nums">{series.latestGrowthRatePct}%</div></div>
            </div>
            <div data-testid="series-sparkline" className="flex items-end gap-0.5 h-12">
              {points.slice(-30).map((p, i) => (
                <span key={i} title={`${p.date}: ${p.views.toLocaleString()}회 (+${p.dailyDeltaViews.toLocaleString()}, ${p.growthRatePct}%)`}
                  className="flex-1 rounded-t bg-accent/70" style={{ height: `${Math.max(6, Math.round((p.views / maxViews) * 100))}%` }} />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-4">
              <span>{series.dayCount}일치 스냅샷 · 마지막 수집 {series.updatedAtIso.slice(0, 10)}</span>
              {freshState === "fresh" ? <Badge tone="ok">최신</Badge> : <Badge tone="warn">오래됨</Badge>}
              <span>다음 자동 수집 매일 05:40 KST</span>
            </div>
            {monitorUnavailable ? (
              <div className="text-[11px] text-danger" data-testid="series-unavailable">
                YouTube에서 영상 통계를 찾을 수 없습니다(비공개/삭제 추정) · 마지막 시도 {monitor?.lastErrorAtIso?.slice(0, 10) ?? "-"} · "지금 스냅샷"으로 재시도할 수 있습니다.
              </div>
            ) : monitor?.lastError ? (
              <div className="text-[11px] text-warn" data-testid="series-last-error">
                최근 수집 실패({monitor.retryCount ?? 0}회): {monitor.lastError} · 다음 로테이션에서 자동 재시도됩니다.
              </div>
            ) : null}
            {sentiment ? (
              <div className="border-t border-line pt-2">
                <div className="mb-1 text-[11px] font-semibold text-ink-2">댓글 감성 <span className="font-normal text-ink-4">(video-comment-insights 재사용)</span></div>
                <div className="flex h-2 overflow-hidden rounded-full bg-fill">
                  <span className="block h-full bg-ok" style={{ width: `${sentiment.positive}%` }} />
                  <span className="block h-full bg-ink-4/40" style={{ width: `${sentiment.neutral}%` }} />
                  <span className="block h-full bg-danger" style={{ width: `${sentiment.negative}%` }} />
                </div>
                <div className="mt-1 flex gap-3 text-[11px] text-ink-3"><span>긍정 {sentiment.positive}%</span><span>중립 {sentiment.neutral}%</span><span>부정 {sentiment.negative}%</span></div>
              </div>
            ) : series?.commentInsights?.summary ? (
              <div className="border-t border-line pt-2 text-[11px] text-ink-3">💬 {series.commentInsights.summary}</div>
            ) : null}
          </>
        ) : (
          <div className="flex items-center justify-between gap-2 text-[11px] text-ink-4">
            {monitorUnavailable ? (
              <>
                <span data-testid="series-unavailable">YouTube에서 영상 통계를 찾을 수 없습니다(비공개/삭제 추정) · "지금 스냅샷"으로 재시도할 수 있습니다.</span>
                <Badge tone="danger">수집 불가</Badge>
              </>
            ) : (
              <>
                <span>아직 수집 전입니다 (다음 자동 수집 매일 05:40 KST). "지금 스냅샷"으로 즉시 1일치를 수집할 수 있습니다.</span>
                <Badge tone="neutral">수집 전</Badge>
              </>
            )}
          </div>
        )}
        {error ? <div className="text-[11px] text-danger" data-testid="series-error">{error}</div> : null}
      </div>
    </div>
  );
}
