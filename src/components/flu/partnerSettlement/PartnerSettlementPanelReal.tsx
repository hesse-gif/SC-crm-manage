"use client";

// FLU-0540 gap-closure: promotes `PartnerSettlementView` (mockup 07 pixel-clone) to the DEFAULT
// performance-tab layout, fed by the real video-performance read-model instead of the demo singleton doc
// (`getPartnerSettlementSnapshot`). Fetches the same registered callables `PartnerPerformancePanel` uses
// (`getVideoPerformanceSummary` / `listVideoPerformanceLedger`, scoped to enrollmentId/programId/
// campaignId) and reshapes the result via `buildPartnerSettlementSnapshotFromReal` — no new calc logic, no
// second source of truth. No approved video yet → an honest present:true snapshot with an empty table
// (never a fallback to a different layout). Only a genuine fetch failure shows its own retryable error
// state, matching the clone-structure loading/empty/error contract this gap-closure requires.
import { useCallback, useEffect, useState } from "react";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import {
  getVideoPerformanceSummary,
  listVideoPerformanceLedger,
  type VideoPerformancePeriodInput,
  type VideoPerformanceReportRow,
  type VideoPerformanceSummary,
} from "@/lib/videoPerformanceData";
import { publicCallableErrorMessage } from "@/lib/live";
import type { PartnerVideo } from "@/lib/partnerData";
import { buildPartnerSettlementSnapshotFromReal } from "@/lib/partnerSettlementData";
import { PartnerSettlementView, type PartnerSurfaceTabLink } from "./PartnerSettlementView";

function defaultWeekPeriod(): VideoPerformancePeriodInput {
  const to = new Date();
  const from = new Date(to.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { mode: "week", from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function isPermissionDeniedError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "permission-denied" || code === "functions/permission-denied";
}

export interface PartnerSettlementPanelRealProps {
  enrollmentId: string;
  programId: string;
  campaignId?: string;
  programName: string;
  campaignName?: string | null;
  handle: string | null;
  displayName: string;
  profileImageUrl?: string | null;
  avatarInitial?: string;
  tabs?: PartnerSurfaceTabLink[];
  activeTabKey?: string;
  currentApprovedVideo: PartnerVideo | null;
}

export function PartnerSettlementPanelReal({
  enrollmentId,
  programId,
  campaignId,
  programName,
  campaignName,
  handle,
  displayName,
  profileImageUrl,
  avatarInitial,
  tabs,
  activeTabKey = "performance",
  currentApprovedVideo,
}: PartnerSettlementPanelRealProps) {
  const [state, setState] = useState<"loading" | "ready" | "error" | "permission-denied">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [summary, setSummary] = useState<VideoPerformanceSummary | null>(null);
  const [rows, setRows] = useState<VideoPerformanceReportRow[]>([]);

  const load = useCallback(() => {
    let cancelled = false;
    setState((prev) => (prev === "ready" ? prev : "loading"));
    const period = defaultWeekPeriod();
    const filter = { enrollmentId, programId, campaignId };
    Promise.all([
      getVideoPerformanceSummary({ period, filter }),
      listVideoPerformanceLedger({ period, filter, pageSize: 50 }),
    ])
      .then(([summaryRes, ledgerRes]) => {
        if (cancelled) return;
        setSummary(summaryRes.summary);
        setRows(ledgerRes.rows);
        setState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isPermissionDeniedError(error)) {
          setState("permission-denied");
          return;
        }
        setErrorMessage(publicCallableErrorMessage(error, "성과·정산 데이터를 불러오지 못했습니다."));
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [enrollmentId, programId, campaignId]);

  useEffect(() => load(), [load]);

  if (state === "loading") {
    return (
      <div data-testid="partner-settlement-view" className="flex justify-center py-16">
        <LoadingStatus>성과·정산 데이터를 불러오는 중</LoadingStatus>
      </div>
    );
  }

  if (state === "permission-denied") {
    return (
      <div data-testid="partner-settlement-view" className="rounded-md border border-line bg-paper px-4 py-8 text-center text-sm text-ink-3">
        성과·정산 열람 권한이 없습니다 (manager 이상)
      </div>
    );
  }

  if (state === "error") {
    return (
      <div data-testid="partner-settlement-view" role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-4 py-8 text-center text-sm text-danger">
        {errorMessage}
        <button type="button" onClick={load} className="ml-3 rounded-full border border-danger/30 bg-paper px-3 py-1.5 text-xs font-semibold text-danger hover:bg-danger-soft">
          재시도
        </button>
      </div>
    );
  }

  const snapshot = buildPartnerSettlementSnapshotFromReal(
    {
      enrollmentId,
      programName,
      campaignName,
      handle,
      displayName,
      profileImageUrl,
      avatarInitial,
      currentApprovedVideo,
    },
    summary as VideoPerformanceSummary,
    rows,
  );
  return <PartnerSettlementView snapshot={snapshot} tabs={tabs} activeTabKey={activeTabKey} />;
}
