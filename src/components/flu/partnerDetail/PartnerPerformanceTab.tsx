"use client";

// Performance & Settlement tab (성과·정산) — spec_partner_profile_tabs/spec.md §4.4, mockup
// 07-partner-performance-settlement-final.png.
//
// Cross-lane frozen contract (this wave): the KPI cards / views-over-time chart / settlement-basis /
// per-video settlement table are owned by L5 and rendered via
// `src/components/flu/videoPerformance/PartnerPerformancePanel.tsx`, exported with EXACTLY
// `{ enrollmentId: string; programId: string; campaignId?: string }`. This tab is only the thin
// composition point inside the Partner detail 5-tab shell — it must not re-implement L5's KPI/chart
// logic.
import { PartnerPerformancePanel } from "@/components/flu/videoPerformance/PartnerPerformancePanel";

export function PartnerPerformanceTab({
  enrollmentId,
  programId,
  campaignId,
}: {
  enrollmentId: string;
  programId: string;
  campaignId?: string;
}) {
  return <PartnerPerformancePanel enrollmentId={enrollmentId} programId={programId} campaignId={campaignId} />;
}
