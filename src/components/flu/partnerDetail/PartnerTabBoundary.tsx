"use client";

// Per-tab independent loading/empty/stale/error envelope shell (spec_partner_profile_tabs/spec.md §3.2).
// A slow or failed tab NEVER blocks the profile header or any other tab — this component only ever
// renders the state of the single envelope it was handed.
import type { ReactNode } from "react";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import { Badge } from "@/components/ui/Badge";
import { Alert, Refresh } from "@/components/icons";
import { formatKst } from "@/lib/datetime";
import type { SourceReadEnvelope } from "@/lib/partnerData";

const LONG_LOADING_THRESHOLD_MS = 8_000;

export function PartnerTabBoundary<T>({
  envelope,
  onRetry,
  emptyLabel,
  emptyHref,
  emptyHrefLabel,
  criticalEmpty = false,
  children,
}: {
  envelope: SourceReadEnvelope<T> | undefined;
  onRetry?: () => void;
  emptyLabel: string;
  emptyHref?: string;
  emptyHrefLabel?: string;
  criticalEmpty?: boolean;
  children: (data: T) => ReactNode;
}) {
  const state = envelope?.state ?? "idle";

  if (state === "idle" || state === "loading") {
    const requestedAt = envelope?.requestedAt ? new Date(envelope.requestedAt).getTime() : null;
    const longLoading = requestedAt !== null && Date.now() - requestedAt >= LONG_LOADING_THRESHOLD_MS;
    // U6(a): 로딩 placeholder 가 실제 내용보다 훨씬 낮아서 탭을 바꿀 때 레이아웃이 튀었다.
    // 최소 높이를 주고 스켈레톤 줄을 함께 두면 같은 자리에서 내용이 채워진다(독립 로딩 계약은 불변).
    return (
      <div className="min-h-[360px] rounded-xl border border-line bg-paper px-5 py-8">
        <LoadingStatus>{longLoading ? "데이터를 불러오는 데 시간이 걸리고 있습니다" : "불러오는 중"}</LoadingStatus>
        <div aria-hidden="true" className="mt-4 space-y-2">
          {[0, 1, 2, 3, 4].map((line) => (
            <div key={line} className="h-4 animate-pulse rounded bg-fill" style={{ width: `${92 - line * 9}%` }} />
          ))}
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div role="alert" className="flex flex-col gap-2 rounded-xl border border-danger/30 bg-danger-soft px-5 py-5 text-sm text-danger">
        <div className="flex items-center gap-2 font-semibold">
          <Alert className="h-4 w-4" aria-hidden="true" />
          <span>원천 오류로 이 영역을 불러오지 못했습니다{envelope?.errorCode ? ` (${envelope.errorCode})` : ""}</span>
        </div>
        {envelope?.retryable && onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex w-fit items-center gap-1.5 rounded-full border border-danger/30 bg-paper px-3 py-1.5 text-xs font-semibold text-danger transition-colors hover:bg-danger-soft"
          >
            <Refresh className="h-3.5 w-3.5" aria-hidden="true" />
            재시도
          </button>
        ) : null}
      </div>
    );
  }

  if (state === "empty") {
    return (
      <div className={`rounded-xl border px-5 py-8 text-center text-sm ${criticalEmpty ? "border-danger/30 bg-danger-soft text-danger" : "border-line bg-paper text-ink-4"}`}>
        {criticalEmpty ? (
          <div className="mb-2 flex items-center justify-center gap-2 font-semibold">
            <Alert className="h-4 w-4" aria-hidden="true" />
            데이터 무결성 오류
          </div>
        ) : null}
        <p>{emptyLabel}</p>
        {emptyHref ? (
          <a href={emptyHref} className="mt-2 inline-block text-xs font-semibold text-accent hover:underline">
            {emptyHrefLabel ?? "이동"}
          </a>
        ) : null}
      </div>
    );
  }

  // ready or stale — render the data. `stale` additionally shows the last-sync badge + retry.
  return (
    <div className="flex flex-col gap-2">
      {state === "stale" ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">
          <span>마지막 동기화: {formatKst(envelope?.updatedAt, "—")}</span>
          {onRetry ? (
            <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 font-semibold hover:underline">
              <Refresh className="h-3.5 w-3.5" aria-hidden="true" />
              재시도
            </button>
          ) : null}
        </div>
      ) : null}
      {envelope?.data !== undefined ? children(envelope.data) : null}
    </div>
  );
}

export function TabBadgeDot({ label, tone }: { label: string; tone: "ok" | "warn" | "danger" | "neutral" }) {
  return <Badge tone={tone} dot>{label}</Badge>;
}
