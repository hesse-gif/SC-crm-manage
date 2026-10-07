"use client";

// 파트너 상세 "성과·정산" 탭 전용 4-카드 요약 (mockup 07,
// docs/product/flu-view-cpm-settlement-scp-review-design-spec-20260719.md §5 "상단 KPI" 표).
// 전역 리포트 페이지가 쓰는 `VideoPerformanceSummaryBand`(시각 정본 10, 얇은 통합 밴드)와는 다른 레이아웃 —
// enrollment 단일 스코프에서는 정산 예상/인정 조회수/적용 CPM/다음 지급을 각각 카드로 분리해 보여준다.
// 계산 코어는 동일하게 `videoPerformanceData`가 반환한 값만 표시한다 — 여기서 새 금액을 계산하지 않는다.
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import type { VideoPerformanceReportRow, VideoPerformanceSummary } from "@/lib/videoPerformanceData";
import { formatUsdMinor, formatViews, subtractViews, sumMoneyMinor } from "./formatters";

function formatCpm(row: VideoPerformanceReportRow | undefined): string {
  if (!row?.rate) return "—";
  const dollarsPerThousand = Number(row.rate.cpmMicrosPerThousand) / 1_000_000;
  if (!Number.isFinite(dollarsPerThousand)) return "—";
  return `$${dollarsPerThousand.toFixed(dollarsPerThousand % 1 === 0 ? 0 : 2)} / 1K`;
}

export function PartnerPerformanceSummaryCards({
  summary,
  rows,
}: {
  summary: VideoPerformanceSummary;
  // 대표 행(CPM/국가 카드용) — 현재 페이지 정렬 순서상 첫 행을 사용한다. 여러 CPM이 섞여 있을 수 있어
  // 대표값임을 라벨/뱃지로 명시한다.
  rows: VideoPerformanceReportRow[];
}) {
  const representativeRow = rows[0];
  const carryForwardEstimate = sumMoneyMinor(
    rows.filter((row) => !row.settlement.hasPortalReceipt).map((row) => row.settlement.estimatedAmountMinor),
  );
  const totalEstimate = sumMoneyMinor([summary.settlementConfirmedAmountMinor, carryForwardEstimate]);
  const excludedViews = subtractViews(summary.totalViews, summary.eligibleViews);
  const effectiveCountry = representativeRow?.country.effective ?? representativeRow?.country.declared;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card className="p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-ink-3">
          이번 정산 예상
          <Badge tone="warn">추정</Badge>
        </div>
        <div className="mt-2 text-2xl font-bold text-ink-1">{totalEstimate ? formatUsdMinor(totalEstimate) : "—"}</div>
        <div className="mt-1 text-xs text-ink-3">
          확정 {formatUsdMinor(summary.settlementConfirmedAmountMinor)} · 이월 {carryForwardEstimate ? formatUsdMinor(carryForwardEstimate) : "—"}
        </div>
      </Card>
      <Card className="p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-ink-3">
          인정 조회수
          <Badge tone="info">168h</Badge>
        </div>
        <div className="mt-2 text-2xl font-bold text-ink-1">{formatViews(summary.eligibleViews)}</div>
        <div className="mt-1 text-xs text-ink-3">
          전체 {formatViews(summary.totalViews)} · 제외 {excludedViews ? formatViews(excludedViews) : "—"}
        </div>
      </Card>
      <Card className="p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-ink-3">
          적용 CPM
          {effectiveCountry && <Badge tone="neutral">{effectiveCountry}</Badge>}
        </div>
        <div className="mt-2 text-2xl font-bold text-ink-1">{formatCpm(representativeRow)}</div>
        <div className="mt-1 text-xs text-ink-3">
          {representativeRow ? `${representativeRow.country.verified ? "YouTube 확인" : "신고"} 국가 기준` : "표시할 영상 없음"}
        </div>
      </Card>
      <Card className="p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-ink-3">
          다음 지급
          <Badge tone="neutral">확인 필요</Badge>
        </div>
        <div className="mt-2 text-2xl font-bold text-ink-1">—</div>
        <div className="mt-1 text-xs text-ink-3">
          Portal 지급 일정/최소 지급액 연동 전 (docs/product/flu-view-cpm-settlement-scp-review-design-spec-20260719.md §4 미구현 항목 6)
        </div>
      </Card>
    </div>
  );
}
