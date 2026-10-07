"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/Tabs";
import { CaseItemsPanel } from "./CaseItemsPanel";
import {
  listChatAutoCasebookUnclassified,
  type ChatAutoCasebookUnclassifiedReason,
  type ChatAutoCasebookUnclassifiedRow,
} from "@/lib/data";
import {
  CASEBOOK_ITEMS_UNCLASSIFIED,
  CASEBOOK_STAMP_LAUNCH_LABEL,
  CASEBOOK_UNCLASSIFIED_REASONS,
  CASEBOOK_UNCLASSIFIED_REASON_LABELS,
  pendingCountLabel,
  unclassifiedReasonSummary,
  type PendingDisplayKind,
} from "@/lib/casebookInbox";

const PAGE_SIZE = 25;

type ReasonFilter = ChatAutoCasebookUnclassifiedReason | "all";

// Casebook inbox (2026-10-01): "미분류" as a first-class entry of the casebook list. The count and
// the reason breakdown come from the cached snapshot (props); the expandable list below is a LIVE
// paged scan (listChatAutoCasebookUnclassified) and is fetched only when the operator expands it —
// never on mount, so the console's initial load cost does not change. This component only mounts
// inside CasebookSection, which the page replaces with the view-as blocked panel during viewAs, so
// the callable can never run for a previewed identity.
export function UnclassifiedPanel({
  count,
  kind,
  byReason,
  legacyCount,
  asOfLabel,
}: {
  count: number;
  kind: PendingDisplayKind;
  /** Cached per-reason counts; null when the snapshot carries no breakdown. */
  byReason: Record<ChatAutoCasebookUnclassifiedReason, number> | null;
  /** Of byReason.never_classified, how many arrived before case stamping launched; null = unknown. */
  legacyCount: number | null;
  /** Human wording for the snapshot's as-of time, e.g. "3분 전 기준 (09:01:02)". */
  asOfLabel: string;
}) {
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const [expanded, setExpanded] = useState(false);
  const [reason, setReason] = useState<ReasonFilter>("all");
  const [rows, setRows] = useState<ChatAutoCasebookUnclassifiedRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [scannedAtIso, setScannedAtIso] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A monotonic request id (bumped synchronously) discards a superseded page: switching the reason
  // chip while "더 보기" is in flight must never append the old reason's rows to the new list.
  const load = (nextReason: ReasonFilter, cursor: string | null) => {
    requestRef.current += 1;
    const requestId = requestRef.current;
    setError("");
    if (cursor) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setLoadingMore(false);
      setRows([]);
      setNextCursor(null);
    }
    void listChatAutoCasebookUnclassified({
      reason: nextReason,
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    })
      .then((result) => {
        if (requestId !== requestRef.current || !mountedRef.current) return;
        const incoming = Array.isArray(result.rows) ? result.rows : [];
        setRows((current) => {
          if (!cursor) return incoming;
          const seen = new Set(current.map((row) => row.conversationId));
          return [...current, ...incoming.filter((row) => !seen.has(row.conversationId))];
        });
        setNextCursor(result.exhausted ? null : (result.nextCursor ?? null));
        setScannedAtIso(typeof result.scannedAtIso === "string" ? result.scannedAtIso : null);
      })
      .catch(() => {
        if (requestId !== requestRef.current || !mountedRef.current) return;
        setError("미분류 목록을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (requestId !== requestRef.current || !mountedRef.current) return;
        setLoading(false);
        setLoadingMore(false);
      });
  };

  const toggle = () => {
    if (expanded) {
      requestRef.current += 1;
      setExpanded(false);
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    setExpanded(true);
    load(reason, null);
  };

  const selectReason = (next: ReasonFilter) => {
    if (next === reason) return;
    setReason(next);
    load(next, null);
  };

  const reasonSummary = byReason && kind === "exact" ? unclassifiedReasonSummary(byReason, legacyCount) : "";

  const reasonTabs = [
    { key: "all", label: "전체", count: byReason && kind === "exact" ? count : undefined },
    ...CASEBOOK_UNCLASSIFIED_REASONS.map((item) => ({
      key: item,
      label: CASEBOOK_UNCLASSIFIED_REASON_LABELS[item],
      count: byReason && kind === "exact" ? byReason[item] : undefined,
    })),
  ];

  return (
    <div className="px-5 py-4" data-testid="casebook-unclassified">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-ink">미분류 문의</h3>
            <Badge tone="neutral">자동답장 대상 아님</Badge>
            <span className="text-sm font-bold text-ink" data-testid="casebook-unclassified-count">
              {/* A lower bound of 0 proves nothing ("0건 이상") — same as a case row, show it as still counting. */}
              {pendingCountLabel(kind === "lower_bound" && count === 0 ? "computing" : kind, count)}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-3">
            케이스가 정해지지 않았거나, 최신 메일이 아직 분류되기 전인 대기 대화입니다. 사람이 열어서 확인합니다.
          </p>
          {reasonSummary ? (
            <p className="mt-1 text-[11px] text-ink-3" data-testid="casebook-unclassified-reasons">
              {reasonSummary}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={toggle}
          aria-expanded={expanded}
          data-testid="casebook-unclassified-toggle"
        >
          {expanded ? "목록 닫기" : "목록 보기"}
        </Button>
      </div>

      <CaseItemsPanel caseId={CASEBOOK_ITEMS_UNCLASSIFIED} count={count} kind={kind} testId="case-items-unclassified" />

      {expanded ? (
        <div className="mt-3 space-y-3" data-testid="casebook-unclassified-body">
          <div role="tablist" aria-label="미분류 사유" data-testid="casebook-unclassified-reason-tabs" className="overflow-x-auto">
            <Tabs tabs={reasonTabs} value={reason} onChange={(key) => selectReason(key as ReasonFilter)} />
          </div>
          <p className="text-[11px] text-ink-3" data-testid="casebook-unclassified-basis">
            목록은 지금 다시 조회한 현재 기준{scannedAtIso ? ` (${formatTime(scannedAtIso)} 조회)` : ""}이고,
            위의 건수는 {asOfLabel} 집계라 서로 다를 수 있습니다.
          </p>

          {loading ? (
            <div className="text-xs text-ink-3" role="status" data-testid="casebook-unclassified-loading">
              {/* A cursor-less load (first open or a reason switch) is a live scan from the oldest waiting
                  conversation — 30-40s in production — so say so instead of a generic spinner text. */}
              대기 대화를 처음부터 훑고 있어 최대 1분 걸릴 수 있습니다.
            </div>
          ) : null}
          {error ? (
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-danger" role="alert" data-testid="casebook-unclassified-error">
              <span>{error}</span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => load(reason, rows.length > 0 ? nextCursor : null)}
              >
                다시 시도
              </Button>
            </div>
          ) : null}
          {!loading && !error && rows.length === 0 ? (
            <div className="rounded-md border border-line bg-fill px-3 py-3 text-xs text-ink-3" data-testid="casebook-unclassified-empty">
              현재 기준으로 이 사유에 해당하는 미분류 대화가 없습니다.
            </div>
          ) : null}

          {rows.length > 0 ? (
            <ul className="divide-y divide-line rounded-md border border-line" data-testid="casebook-unclassified-list">
              {rows.map((row) => (
                <li
                  key={row.conversationId}
                  className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5"
                  data-testid={`casebook-unclassified-row-${row.conversationId}`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold text-ink">{row.creatorName ?? "이름 없음"}</span>
                      <Badge tone="warn">{CASEBOOK_UNCLASSIFIED_REASON_LABELS[row.reason] ?? row.reason}</Badge>
                      {row.legacy === true ? (
                        <Badge tone="neutral" title={`케이스 분류 도입(${CASEBOOK_STAMP_LAUNCH_LABEL}) 전에 받은 메일`}>도입 전</Badge>
                      ) : null}
                    </div>
                    {row.subject ? <div className="mt-0.5 truncate text-xs text-ink-2">{row.subject}</div> : null}
                    <div className="mt-0.5 text-[11px] text-ink-3">
                      {[row.creatorEmailMasked, row.mailAccountLabel, formatTime(row.lastInboundAtIso)]
                        .filter((part): part is string => Boolean(part))
                        .join(" · ")}
                    </div>
                  </div>
                  <a
                    href={`/chat?conversationId=${encodeURIComponent(row.conversationId)}`}
                    data-testid={`casebook-unclassified-link-${row.conversationId}`}
                    className="rounded-md border border-line bg-paper px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-fill"
                  >
                    채팅에서 열기
                  </a>
                </li>
              ))}
            </ul>
          ) : null}

          {nextCursor && !loading ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={loadingMore}
              onClick={() => load(reason, nextCursor)}
              data-testid="casebook-unclassified-more"
            >
              {loadingMore ? "불러오는 중" : "더 보기"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("ko-KR");
}
