"use client";

// 파트너 상세 "성과·정산" 탭 — enrollment-scoped 영상 성과 원장 (mockup 07,
// .specs/spec_video_performance_settlement_report/spec.md §1.2 라우팅: "`/flu/partners/{enrollmentId}?tab=
// performance`는 동일 계산 코어의 enrollment-scoped projection을 읽습니다").
//
// Wave-2 cross-lane contract (frozen this wave): L2 imports exactly this component with exactly this
// props shape. Do not widen/rename without IRC coordination (ids: 0-I1-ReviewActivationWiring,
// 1-L2-PartnerUI, 2-L5-PerformanceUI).
import { useMemo } from "react";
import type { VideoPerformanceLedgerFilter } from "@/lib/videoPerformanceData";
import { VideoPerformanceReportView } from "./VideoPerformanceReportView";

export interface PartnerPerformancePanelProps {
  enrollmentId: string;
  programId: string;
  campaignId?: string;
}

export function PartnerPerformancePanel({ enrollmentId, programId, campaignId }: PartnerPerformancePanelProps) {
  const scopeFilter = useMemo<VideoPerformanceLedgerFilter>(
    () => ({ enrollmentId, programId, campaignId }),
    [enrollmentId, programId, campaignId],
  );
  return (
    <VideoPerformanceReportView
      scopeFilter={scopeFilter}
      title="성과 · 정산"
      description="승인된 현재 revision 영상만 표시 — 예상 금액과 Portal 확정 금액을 분리해 보여줍니다."
      layout="cards"
    />
  );
}
