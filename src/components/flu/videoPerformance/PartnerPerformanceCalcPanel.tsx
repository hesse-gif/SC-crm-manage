"use client";

// 파트너 상세 "성과·정산" 탭 전용 차트 + 계산 근거 카드 (mockup 07 우측 2칸 레이아웃).
// 목업은 "최근 7일 · 1시간마다 Portal 동기화" 일별 시계열을 보여주지만, videoPerformanceData read
// callable은 일별 granularity를 노출하지 않는다(functions 변경은 이번 wave 비목표 — Owned 범위가
// src/components/flu/** 로 한정됨). 없는 데이터를 지어내는 대신, 이미 로드된 영상별 인정 조회수를
// 막대로 보여주고 라벨로 이 사실을 명시한다 — artifacts/l6-20260720/visual/report.json에도 별도
// 기록한다.
import { Card } from "@/components/ui/Card";
import type { VideoPerformanceReportRow } from "@/lib/videoPerformanceData";
import { formatUsdMinor, formatViews } from "./formatters";

export function PartnerPerformanceCalcPanel({ rows }: { rows: VideoPerformanceReportRow[] }) {
  const representativeRow = rows[0];
  const maxEligible = rows.reduce((max, row) => {
    const value = row.metrics.eligibleViews ? Number(row.metrics.eligibleViews) : 0;
    return Number.isFinite(value) && value > max ? value : max;
  }, 0);

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[2fr_1fr]">
      <Card className="p-4">
        <div className="text-sm font-semibold text-ink-1">영상별 인정 조회수</div>
        <div className="text-xs text-ink-3">현재 페이지 · 승인된 현재 revision 기준 (일별 시계열 데이터 없음 — [확인 필요])</div>
        <div className="mt-4 flex h-40 items-end gap-2">
          {rows.length === 0 ? (
            <div className="w-full text-center text-xs text-ink-3">표시할 영상이 없습니다</div>
          ) : (
            rows.slice(0, 7).map((row) => {
              const value = row.metrics.eligibleViews ? Number(row.metrics.eligibleViews) : 0;
              const heightPct = maxEligible > 0 ? Math.max(4, Math.round((value / maxEligible) * 100)) : 4;
              return (
                <div key={row.rowId} className="flex flex-1 flex-col items-center gap-1">
                  <div
                    className="w-full max-w-10 rounded-t bg-accent"
                    style={{ height: `${heightPct}%` }}
                    title={`${row.video.title}: ${formatViews(row.metrics.eligibleViews)}`}
                  />
                  <div className="w-full truncate text-center text-[10px] text-ink-4">{row.video.title}</div>
                </div>
              );
            })
          )}
        </div>
      </Card>
      <Card className="p-4">
        <div className="text-sm font-semibold text-ink-1">정산 계산 근거</div>
        {representativeRow ? (
          <div className="mt-3 space-y-1 text-sm text-ink-2">
            <div>{formatViews(representativeRow.metrics.eligibleViews)} 인정 조회수</div>
            <div>
              × {representativeRow.rate ? `$${(Number(representativeRow.rate.cpmMicrosPerThousand) / 1_000_000).toFixed(2)}` : "—"} CPM
            </div>
            <div className="border-t border-line pt-1 text-lg font-bold text-ok">
              = {formatUsdMinor(representativeRow.settlement.estimatedAmountMinor ?? representativeRow.settlement.fluCalculatedAmountMinor)}
            </div>
            <div className="pt-1 text-xs text-ink-3">
              신고: {representativeRow.country.declared ?? "—"}
              <br />
              검증: {representativeRow.country.verified ?? "미확인"} · {representativeRow.country.effective ? "effective" : "declared 기준"}
            </div>
          </div>
        ) : (
          <div className="mt-3 text-xs text-ink-3">표시할 영상이 없습니다</div>
        )}
      </Card>
    </div>
  );
}
