"use client";

// 영상 성과 요약 밴드 — 시각 정본 10번(하나의 얇은 통합 밴드, 큰 카드 4개로 분리하지 않음)을 따른다.
// (.specs/spec_video_performance_settlement_report/spec.md §4.3)
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import type { VideoPerformanceSummary } from "@/lib/videoPerformanceData";
import { formatUsdMinor, formatViews } from "./formatters";

export function VideoPerformanceSummaryBand({
  summary,
  updatedAtLabel,
}: {
  summary: VideoPerformanceSummary;
  updatedAtLabel?: string;
}) {
  const metrics = [
    { label: "총 조회수", value: formatViews(summary.totalViews) },
    { label: "인정 조회수", value: formatViews(summary.eligibleViews) },
    { label: "마감 예정", value: `${summary.cutoffPendingCount.toLocaleString("ko-KR")}편` },
    { label: "정산 확정", value: formatUsdMinor(summary.settlementConfirmedAmountMinor) },
  ];
  return (
    <Card className="p-0 overflow-hidden">
      <div className="grid grid-cols-2 divide-y divide-line sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        {metrics.map((metric) => (
          <div key={metric.label} className="px-5 py-4">
            <div className="text-xs font-medium text-ink-3">{metric.label}</div>
            <div className="mt-1 text-xl font-bold text-ink-1">{metric.value}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-line px-5 py-2 text-xs text-ink-3">
        <span>{updatedAtLabel ? `${updatedAtLabel} 업데이트` : "업데이트 시각 확인 중"}</span>
        {!summary.coverage.complete && (
          <Badge tone="warn">
            일부 영상 제외됨 ({summary.coverage.excludedRowCount}건 · {summary.coverage.excludedReasons.join(", ")})
          </Badge>
        )}
      </div>
    </Card>
  );
}
