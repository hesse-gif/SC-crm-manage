"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { listChatAutoCasebookCaseItems, type ChatAutoCasebookCaseItemRow } from "@/lib/data";
import {
  CASEBOOK_ITEMS_NO_REPLY_NEEDED,
  CASEBOOK_ITEMS_PAGE_SIZE,
  CASEBOOK_ITEMS_UNCLASSIFIED,
  CASEBOOK_UNCLASSIFIED_REASON_LABELS,
  caseItemTimeLabel,
  caseItemsGroupSummary,
  noReplyCaseLabel,
  type PendingDisplayKind,
} from "@/lib/casebookInbox";

// "실제 건 보기" (2026-10-03): which actual conversations sit behind a casebook card's 대기 중 N건, so
// the operator can judge whether the classification is right. The list is fetched through the
// listChatAutoCasebookCaseItems callable only when expanded (never on mount), newest first, 25 per
// page with a cursor. Like the unclassified list it only mounts inside the casebook section, which
// the page swaps for the view-as blocked panel during viewAs — the callable also rejects viewAs.
export function CaseItemsPanel({
  caseId,
  count,
  kind,
  testId,
}: {
  /** A casebook case id, or "unclassified" / "no_reply_needed". */
  caseId: string;
  /** The card's own 대기 중 count — only used for the button label. */
  count: number;
  kind: PendingDisplayKind;
  testId: string;
}) {
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<ChatAutoCasebookCaseItemRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = (cursor: string | null) => {
    requestRef.current += 1;
    const requestId = requestRef.current;
    setError("");
    if (cursor) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setLoadingMore(false);
      setLoaded(false);
      setRows([]);
      setNextCursor(null);
    }
    void listChatAutoCasebookCaseItems({
      caseId,
      limit: CASEBOOK_ITEMS_PAGE_SIZE,
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
        setNowMs(Date.now());
        setLoaded(true);
      })
      .catch(() => {
        if (requestId !== requestRef.current || !mountedRef.current) return;
        setError("실제 건 목록을 불러오지 못했습니다.");
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
    load(null);
  };

  const countText = kind === "exact" ? ` (${count})` : "";

  return (
    <div className="mt-3" data-testid={testId}>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={toggle}
        aria-expanded={expanded}
        data-testid={`${testId}-toggle`}
      >
        {expanded ? "실제 건 닫기" : `실제 건 보기${countText}`}
      </Button>

      {expanded ? (
        <div className="mt-2 space-y-2" data-testid={`${testId}-body`}>
          {loading ? (
            <div role="status" aria-label="실제 건을 불러오는 중" className="space-y-2" data-testid={`${testId}-loading`}>
              {[0, 1, 2].map((index) => (
                <div key={index} className="animate-pulse rounded-md border border-line px-3 py-2.5">
                  <div className="h-3 w-2/5 rounded bg-fill" />
                  <div className="mt-2 h-3 w-4/5 rounded bg-fill" />
                </div>
              ))}
              <div className="text-[11px] text-ink-3">대기 대화를 최신순으로 훑고 있어 몇 초 걸릴 수 있습니다.</div>
            </div>
          ) : null}
          {error ? (
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-danger" role="alert" data-testid={`${testId}-error`}>
              <span>{error}</span>
              <Button type="button" size="sm" variant="secondary" onClick={() => load(rows.length > 0 ? nextCursor : null)}>
                다시 시도
              </Button>
            </div>
          ) : null}
          {loaded && !loading && !error && rows.length === 0 && nextCursor === null ? (
            <div className="rounded-md border border-line bg-fill px-3 py-3 text-xs text-ink-3" data-testid={`${testId}-empty`}>
              지금 기준으로 이 묶음에 해당하는 대기 대화가 없습니다. 집계 이후 답장되었거나 다른 묶음으로 옮겨졌을 수 있습니다.
            </div>
          ) : null}
          {/* A bounded scan can end without a match while older conversations are still unscanned — that is not "none". */}
          {loaded && !loading && !error && rows.length === 0 && nextCursor !== null ? (
            <div className="rounded-md border border-line bg-fill px-3 py-3 text-xs text-ink-3" data-testid={`${testId}-partial`}>
              대기 대화를 아직 다 훑지 못했습니다. 지금까지는 이 묶음에 해당하는 건이 없었습니다.
            </div>
          ) : null}

          {rows.length > 0 ? (
            <>
              <p className="text-[11px] font-semibold text-ink-2" data-testid={`${testId}-summary`}>
                {caseItemsGroupSummary(rows, nextCursor !== null)}
              </p>
              <ul className="divide-y divide-line rounded-md border border-line" data-testid={`${testId}-list`}>
                {rows.map((row) => (
                  <CaseItemRow key={row.conversationId} row={row} caseId={caseId} nowMs={nowMs} testId={testId} />
                ))}
              </ul>
              <p className="text-[11px] text-ink-3">
                지금 다시 조회한 현재 기준이라 위 집계 건수와 몇 건 다를 수 있습니다.
              </p>
            </>
          ) : null}

          {nextCursor && !loading ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={loadingMore}
              onClick={() => load(nextCursor)}
              data-testid={`${testId}-more`}
            >
              {loadingMore ? "불러오는 중" : rows.length === 0 ? "계속 찾기" : "더 보기"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CaseItemRow({
  row,
  caseId,
  nowMs,
  testId,
}: {
  row: ChatAutoCasebookCaseItemRow;
  caseId: string;
  nowMs: number;
  testId: string;
}) {
  const held = row.replyState === "held";
  const bucketTag = caseId === CASEBOOK_ITEMS_UNCLASSIFIED
    ? (row.unclassifiedReason ? CASEBOOK_UNCLASSIFIED_REASON_LABELS[row.unclassifiedReason] ?? row.unclassifiedReason : "")
    : caseId === CASEBOOK_ITEMS_NO_REPLY_NEEDED
      ? noReplyCaseLabel(row.caseId)
      : "";
  return (
    <li className="px-3 py-2.5" data-testid={`${testId}-row-${row.conversationId}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[11px] tabular-nums text-ink-3">{caseItemTimeLabel(row.lastInboundAtIso, nowMs)}</span>
            <span className="truncate text-sm font-semibold text-ink">{row.creatorName ?? "이름 없음"}</span>
            {row.creatorHandle ? <span className="text-xs text-ink-3">{row.creatorHandle.startsWith("@") ? row.creatorHandle : `@${row.creatorHandle}`}</span> : null}
            {row.creatorEmailMasked ? <span className="text-[11px] text-ink-4">{row.creatorEmailMasked}</span> : null}
            {row.programLabel ? <span className="text-[11px] text-ink-3">{row.programLabel}</span> : null}
            {bucketTag ? <Badge tone="neutral">{bucketTag}</Badge> : null}
            {row.inboundIntentLabel ? <Badge tone="info">{row.inboundIntentLabel}</Badge> : null}
          </div>
          <p
            className="mt-1 text-xs text-ink-2 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden"
            title={row.summaryKr ?? undefined}
            data-testid={`${testId}-summary-${row.conversationId}`}
          >
            {row.summaryKr ?? "AI 요지 없음"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={held ? "warn" : "ai"}>{held ? "보류" : "자동답장 대기"}</Badge>
          {row.holdReasonLabel ? <span className="text-[11px] font-semibold text-ink-2">{row.holdReasonLabel}</span> : null}
          <a
            href={`/chat?conversationId=${encodeURIComponent(row.conversationId)}`}
            data-testid={`${testId}-link-${row.conversationId}`}
            className="rounded-md border border-line bg-paper px-2.5 py-1 text-xs font-semibold text-ink-2 hover:bg-fill"
          >
            대화 열기
          </a>
        </div>
      </div>
    </li>
  );
}
