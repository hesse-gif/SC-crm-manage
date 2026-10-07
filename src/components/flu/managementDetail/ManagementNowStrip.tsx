"use client";

// "Now" strip + enrollment/program scope selector (spec §3.3, §4.1 routing rule: "2개 이상이면 마지막
// 사용자 선택을 우선하되, 선택 전에는 program-scoped 액션을 비활성화하고 `프로그램을 선택하세요`를
// 표시"). Renders one line: state / selected program / selected campaign / next action / blocker.
// Slow sources show "불러오는 중" instead of a blank value (spec §3.3) — callers pass `loading` per field.
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import Link from "next/link";

export interface ManagementEnrollmentOption {
  // React/query-param selection key — stable per program+campaign scope, but NOT necessarily a real
  // Portal v3 `enrollmentId`. Callers without a verified v3 enrollment identity for this scope yet
  // (e.g. a legacy program-application-derived scope) should leave `queryEnrollmentId` unset so the
  // scoped-tab query narrows to program(+campaign) only, never guessing at an enrollmentId that would
  // silently zero out real records.
  enrollmentId: string;
  programId: string;
  programLabel?: string;
  campaignId?: string;
  campaignLabel?: string;
  queryEnrollmentId?: string;
}

export function ManagementNowStrip({
  stateLabel,
  stateLoading,
  actionLabel,
  actionHref,
  actionEta,
  blockerLabel,
  freshnessLabel,
  conflict = false,
  enrollments,
  selectedEnrollmentId,
  onSelectEnrollment,
}: {
  stateLabel: string;
  stateLoading?: boolean;
  actionLabel: string;
  actionHref?: string;
  actionEta?: string;
  blockerLabel?: string;
  freshnessLabel?: string;
  conflict?: boolean;
  enrollments: ManagementEnrollmentOption[];
  selectedEnrollmentId: string | null;
  onSelectEnrollment: (enrollmentId: string) => void;
}) {
  const selected = enrollments.find((e) => e.enrollmentId === selectedEnrollmentId) ?? null;

  return (
    <Card className="mt-3 px-5 py-4">
      {enrollments.length > 1 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-line pb-3 text-xs">
          <span className="font-semibold text-ink-3">프로그램</span>
          <select
            aria-label="프로그램 선택"
            className="rounded-md border border-line bg-paper px-2 py-1 text-xs font-medium text-ink"
            value={selectedEnrollmentId ?? ""}
            onChange={(event) => onSelectEnrollment(event.target.value)}
          >
            {!selectedEnrollmentId ? <option value="">프로그램을 선택하세요</option> : null}
            {enrollments.map((option) => (
              <option key={option.enrollmentId} value={option.enrollmentId}>
                {option.programLabel ?? "프로그램 이름 미연결"}
                {option.campaignLabel ? ` / ${option.campaignLabel}` : ""}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-4">현재 상태</p>
          <p className="mt-1 text-sm font-bold text-ink">{stateLoading ? "불러오는 중" : stateLabel}</p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-4">선택된 프로그램</p>
          <p className="mt-1 text-sm font-medium text-ink">{selected?.programLabel ?? "프로그램 이름 미연결"}</p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-4">선택된 캠페인</p>
          <p className="mt-1 text-sm font-medium text-ink">{selected?.campaignLabel ?? "캠페인 이름 미연결"}</p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-4">다음 액션</p>
          {conflict ? (
            <Badge tone="danger">충돌 해결</Badge>
          ) : actionHref ? (
            <Link href={actionHref} className="mt-1 inline-block text-sm font-semibold text-accent hover:underline">
              {actionLabel}
            </Link>
          ) : (
            <p className="mt-1 text-sm font-medium text-ink">{actionLabel}</p>
          )}
          {actionEta ? <p className="mt-0.5 text-[11px] text-ink-4">예상 소요 시간 {actionEta}</p> : null}
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-4">블로커</p>
          <p className="mt-1 text-sm font-medium text-ink">
            {blockerLabel ?? "없음"}
            {freshnessLabel ? <span className="ml-1 text-xs text-ink-4">· {freshnessLabel}</span> : null}
          </p>
        </div>
      </div>
    </Card>
  );
}
