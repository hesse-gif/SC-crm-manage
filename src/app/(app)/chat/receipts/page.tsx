"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { Refresh } from "@/components/icons";
import { cn } from "@/lib/cn";
import {
  listMailOutbox,
  reconcileMailOutboxReplies,
  type MailOutboxPageCursor,
  type MailOutboxRow,
} from "@/lib/data";
import { deliveryStateLabel } from "@/lib/statusLabels";
import { useRole } from "@/lib/role";
import { useViewAs } from "@/lib/viewAs";

// 수신확인 — 발송한 메일의 도착·픽셀 감지 현황 전용 페이지 (네이버 메일 수신확인 참고).
// 데이터는 listMailOutbox 콜러블(manager+) 경유 — 클라 Firestore 직접 접근 없음.
// 픽셀 신호는 mailOpenPixel 이벤트 기반: Gmail/메일 클라이언트 프리페치일 수 있어 캡션으로 고지.

// 색만 여기서 정하고, 문구는 정본 사전(@/lib/statusLabels)이 정한다. 예전에는 3종만 번역돼서
// bounced/deferred/dead_letter/delivered 같은 값이 영문 그대로 배지에 떴다.
const STATE_TONE: Record<string, string> = {
  sent: "bg-ok-soft text-ok",
  delivered: "bg-ok-soft text-ok",
  received: "bg-ok-soft text-ok",
  mock_sent: "bg-fill text-ink-3",
  queued: "bg-fill text-ink-3",
  queued_for_review: "bg-fill text-ink-3",
  queued_for_send: "bg-fill text-ink-3",
  scheduled: "bg-fill text-ink-3",
  deferred: "bg-warn-soft text-warn",
  retryable_failed: "bg-warn-soft text-warn",
  recipient_pending: "bg-warn-soft text-warn",
  sent_evidence_pending: "bg-warn-soft text-warn",
  delivery_unknown: "bg-warn-soft text-warn",
  bounced: "bg-danger-soft text-danger",
  dead_letter: "bg-danger-soft text-danger",
  failed: "bg-danger-soft text-danger",
  blocked: "bg-danger-soft text-danger",
  cancelled: "bg-fill text-ink-3",
  suppressed_duplicate: "bg-fill text-ink-3",
};

function formatReceiptTime(iso: string): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "";
  const date = new Date(parsed);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    ...(sameYear ? {} : { year: "2-digit" }),
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function MailReceiptsPage() {
  // Flu conversation org-filter round 6 (codex adversarial review round 6, finding #4): without
  // this, a super_admin previewing a restricted member (viewAs) saw the super_admin's OWN
  // unrestricted scp outbox — this page never forwarded the target identity, so
  // functions/mailSignature.ts listMailOutbox fell back to the real caller's own bypass scope.
  // reconcileMailOutboxReplies intentionally never receives this — it mutates, and viewAs stays
  // read-only preview everywhere else in this app.
  const { role } = useRole();
  const { target: viewAsTarget, isViewingAs: viewAsFlagActive } = useViewAs();
  const isViewingAs = role === "super_admin" && viewAsFlagActive;
  const viewAsParams = isViewingAs && viewAsTarget
    ? { viewAsUserId: viewAsTarget.userId, viewAsEmail: viewAsTarget.email }
    : {};

  // Flu conversation org-filter round 8 (codex adversarial review round 8, finding #1): round 7's
  // fix cleared `rows` from an EFFECT, which only runs AFTER the first render under the new scope
  // — the previous scope's rows (possibly unrestricted) still painted for that one frame. Keying
  // the whole scoped section by the viewAs identity makes React unmount the OLD instance (and its
  // state) and mount a genuinely fresh one — rows start at [] synchronously, before anything
  // renders under the new scope. The request-generation guard inside the section stays as
  // defense-in-depth against an ordinary (non-scope-change) stale response race.
  const scopeKey = isViewingAs && viewAsTarget ? `${viewAsTarget.userId}:${viewAsTarget.email}` : "self";

  return (
    <ReceiptsSection
      key={scopeKey}
      isViewingAs={isViewingAs}
      viewAsParams={viewAsParams}
    />
  );
}

function ReceiptsSection({
  isViewingAs,
  viewAsParams,
}: {
  isViewingAs: boolean;
  viewAsParams: Record<string, unknown>;
}) {
  const [rows, setRows] = useState<MailOutboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [nextCursor, setNextCursor] = useState<MailOutboxPageCursor | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileNotice, setReconcileNotice] = useState("");
  const [reconcileError, setReconcileError] = useState("");
  // Flu conversation org-filter round 9 (codex adversarial review round 9, finding #3): set
  // whenever a bounded reconcile walk (see reconcileReplies) still has more of the backlog left
  // to scan after MAX_RECONCILE_PAGES_PER_CLICK pages — "계속" resumes the SAME walk from here,
  // rather than the click silently looking "done" with an unbounded backlog still unreconciled.
  const [reconcileContinueCursor, setReconcileContinueCursor] = useState<MailOutboxPageCursor | null>(null);

  // Flu conversation org-filter round 7 (codex adversarial review round 7, finding #3): a request
  // generation counter — bumped on every load() call. A response only gets applied if the
  // generation it was fired under is still the current one; an older in-flight request that
  // resolves after a newer one is silently discarded instead of repopulating the table. The
  // component-key remount above (round 8) handles the SCOPE-change case; this remains defense-in-
  // depth for an ordinary manual-refresh race within one mounted scope.
  const requestGenerationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    setError("");
    try {
      const envelope = await listMailOutbox({ limit: 100, ...viewAsParams });
      if (requestGenerationRef.current !== generation) return;
      setRows(envelope.rows ?? []);
      setNextCursor(envelope.nextCursor ?? null);
    } catch (caught) {
      if (requestGenerationRef.current !== generation) return;
      setError(caught instanceof Error ? caught.message : "수신확인 목록을 불러오지 못했습니다.");
    } finally {
      if (requestGenerationRef.current === generation) setLoading(false);
    }
  }, [viewAsParams]);

  useEffect(() => {
    void load();
  }, [load]);

  // Flu conversation org-filter round 8 (codex adversarial review round 8, finding #2): the server
  // now pages through the outbox authorizing WHILE it scans, instead of narrowing to a fixed
  // newest-N window before authorization (which could make a non-super-admin's own rows
  // permanently unreachable behind enough newer foreign-org rows). It bounds each call's scan and
  // returns a cursor when more of the backlog may still hold authorized rows — "더 보기" continues
  // that same scan and appends, rather than the page silently looking "done" too early.
  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const generation = ++requestGenerationRef.current;
    setLoadingMore(true);
    setError("");
    try {
      const envelope = await listMailOutbox({
        limit: 100,
        ...viewAsParams,
        cursorSentAtIso: nextCursor.sentAtIso,
        cursorTrackingId: nextCursor.trackingId,
      });
      if (requestGenerationRef.current !== generation) return;
      setRows((previous) => [...previous, ...(envelope.rows ?? [])]);
      setNextCursor(envelope.nextCursor ?? null);
    } catch (caught) {
      if (requestGenerationRef.current !== generation) return;
      setError(caught instanceof Error ? caught.message : "추가 수신확인 목록을 불러오지 못했습니다.");
    } finally {
      if (requestGenerationRef.current === generation) setLoadingMore(false);
    }
  }

  // Flu conversation org-filter round 9 (codex adversarial review round 9, finding #3): a single
  // reconcileMailOutboxReplies call only ever scans one bounded page (round 8's 300-row-per-call
  // budget) — treating a page's own pendingWriteCount:0 as "nothing to reconcile" ignores that
  // nextCursor may still point at an unscanned backlog holding real pending replies. This walks
  // pages via nextCursor (bounded per click so one click can never run unboundedly long), and — the
  // part round 8 got wrong — the actual:true apply pass REPLAYS the exact same cursor sequence the
  // dry-run walk used, instead of ever starting over from the head (which would only ever reconcile
  // page 1 again, leaving every later page's real pending replies unreconciled).
  const MAX_RECONCILE_PAGES_PER_CLICK = 5;

  async function reconcileReplies(continueFromCursor: MailOutboxPageCursor | null = null) {
    // Defense-in-depth alongside hiding the button below (round 7 finding #2) — the server
    // rejection (functions/mailSignature.ts reconcileMailOutboxReplies) remains the real gate.
    if (isViewingAs) return;
    if (reconciling) return;
    setReconciling(true);
    setReconcileNotice("");
    setReconcileError("");
    setReconcileContinueCursor(null);
    try {
      let cursor = continueFromCursor;
      let totalScanned = 0;
      let totalPending = 0;
      let walkExhausted = false;
      const cursorSequence: (MailOutboxPageCursor | null)[] = [];
      for (let page = 0; page < MAX_RECONCILE_PAGES_PER_CLICK; page += 1) {
        cursorSequence.push(cursor);
        const preview = await reconcileMailOutboxReplies({
          dryRun: true,
          limit: 100,
          ...(cursor ? { cursorSentAtIso: cursor.sentAtIso, cursorTrackingId: cursor.trackingId } : {}),
        });
        totalScanned += preview.scannedCount;
        totalPending += preview.pendingWriteCount;
        if (!preview.nextCursor) {
          walkExhausted = true;
          break;
        }
        cursor = preview.nextCursor;
      }
      const remainingCursor = walkExhausted ? null : cursor;

      if (totalPending === 0) {
        setReconcileNotice(
          remainingCursor
            ? `최근 ${totalScanned}건을 확인했습니다. 새로 반영할 회신은 없었지만, 아직 확인하지 않은 발송 내역이 남아 있습니다.`
            : `최근 ${totalScanned}건을 확인했습니다. 새로 반영할 회신이 없습니다.`,
        );
        setReconcileContinueCursor(remainingCursor);
        return;
      }
      const confirmed = window.confirm(
        `최근 발송 ${totalScanned}건 중 ${totalPending}건의 회신 상태를 원장에 반영하고 파이프라인을 갱신합니다. 계속할까요?`,
      );
      if (!confirmed) {
        setReconcileNotice("미리보기만 확인했으며 데이터는 변경하지 않았습니다.");
        setReconcileContinueCursor(remainingCursor);
        return;
      }
      let updatedTotal = 0;
      let lifecycleFailedTotal = 0;
      for (const pageCursor of cursorSequence) {
        const result = await reconcileMailOutboxReplies({
          dryRun: false,
          actual: true,
          limit: 100,
          ...(pageCursor ? { cursorSentAtIso: pageCursor.sentAtIso, cursorTrackingId: pageCursor.trackingId } : {}),
        });
        updatedTotal += result.updatedCount;
        lifecycleFailedTotal += result.lifecycleFailedCount;
      }
      const lifecycleWarning = lifecycleFailedTotal > 0
        ? ` · 파이프라인 갱신 ${lifecycleFailedTotal}건은 재시도가 필요합니다.`
        : "";
      const continuationNotice = remainingCursor
        ? ` 아직 확인하지 않은 발송 내역이 남아 있습니다 — "계속"을 눌러 이어서 반영하세요.`
        : "";
      setReconcileNotice(`회신 상태 ${updatedTotal}건을 반영했습니다.${lifecycleWarning}${continuationNotice}`);
      setReconcileContinueCursor(remainingCursor);
      await load();
    } catch (caught) {
      setReconcileError(caught instanceof Error ? caught.message : "회신 상태를 재조정하지 못했습니다.");
    } finally {
      setReconciling(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      <PageHeader
        title={`수신확인${loading ? "" : ` ${rows.length}`}`}
        desc="발송한 메일의 도착·픽셀 감지 현황입니다 · 프리페치/운영자 확인도 포함될 수 있어요"
        action={(
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Flu conversation org-filter round 7 (codex adversarial review round 7, finding #2):
                reconcileMailOutboxReplies mutates and never accepts a viewAs identity (it stays
                read-only preview everywhere else) — the server already rejects it, but a
                super_admin previewing a restricted target's read-only view should never even see
                a control that can reconcile the GLOBAL outbox from that preview. Hidden, not just
                disabled, so it reads as genuinely unavailable rather than a broken button. */}
            {isViewingAs ? null : (
              <button
                type="button"
                onClick={() => void reconcileReplies()}
                disabled={reconciling || loading}
                className="min-h-10 rounded-md border border-line bg-paper px-3 py-2 text-xs font-semibold text-ink-2 transition-[background-color,scale] hover:bg-fill active:scale-[0.96] disabled:cursor-wait disabled:opacity-50"
              >
                {reconciling ? "회신 상태 확인 중…" : "회신 상태 재조정"}
              </button>
            )}
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              aria-label="수신확인 새로고침"
              className="grid h-10 w-10 place-items-center rounded-md text-ink-3 transition-[background-color,scale] hover:bg-fill active:scale-[0.96] disabled:opacity-50"
            >
              <Refresh className={cn("h-4 w-4", loading && "animate-spin")} />
            </button>
          </div>
        )}
      />

      {reconcileNotice ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-ok/25 bg-ok-soft px-4 py-3 text-sm text-ok" role="status">
          <span>{reconcileNotice}</span>
          {/* Flu conversation org-filter round 9 (codex adversarial review round 9, finding #3):
              only shown when the bounded walk above still has more backlog left (nextCursor) —
              resumes the SAME walk from there instead of restarting from the head. */}
          {reconcileContinueCursor && !isViewingAs ? (
            <button
              type="button"
              onClick={() => void reconcileReplies(reconcileContinueCursor)}
              disabled={reconciling}
              className="min-h-8 rounded-md border border-ok/40 bg-paper px-3 py-1.5 text-xs font-semibold text-ok transition-[background-color,scale] hover:bg-ok-soft active:scale-[0.96] disabled:cursor-wait disabled:opacity-50"
            >
              계속
            </button>
          ) : null}
        </div>
      ) : null}

      {reconcileError ? (
        <div className="mt-4 rounded-lg border border-danger/25 bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">
          회신 상태 재조정 실패: {reconcileError}
        </div>
      ) : null}

      <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-paper">
        {/* 컬럼 헤더 — Naver 수신확인처럼 훑어읽는 테이블 감성, 톤은 quiet */}
        <div className="hidden gap-3 border-b border-line px-5 py-2.5 text-[11px] font-semibold text-ink-4 md:grid md:grid-cols-[minmax(0,1.05fr)_minmax(0,1.45fr)_76px_116px_128px_132px]">
          <span>받는 사람</span>
          <span>제목</span>
          <span>상태</span>
          <span className="text-right">발송</span>
          <span className="text-right">열람 신호</span>
          <span className="text-right">대화</span>
        </div>

        {loading && rows.length === 0 ? (
          <div className="space-y-0" aria-label="수신확인 로딩 중">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="border-b border-line px-5 py-4 last:border-0">
                <div className="h-4 w-1/3 rounded bg-ink/10" />
                <div className="mt-2 h-3 w-2/3 rounded bg-ink/5" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="px-5 py-14 text-center text-sm text-danger">{error}</div>
        ) : rows.length === 0 && nextCursor ? (
          // Flu conversation org-filter round 9 (codex adversarial review round 9, finding #2): a
          // page can legitimately return zero rows while still holding a nextCursor — e.g. the
          // scan budget was entirely consumed by newer foreign-org rows before reaching any of the
          // caller's own. Saying "발송된 메일이 없습니다" here would be simply false (mail exists,
          // just further back) and gives no way to reach it.
          <div className="flex flex-col items-center gap-3 px-5 py-14 text-center text-sm text-ink-4">
            <p>이 범위에서는 아직 확인된 메일이 없습니다. 더 이전 발송 내역을 계속 찾아볼까요?</p>
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="min-h-10 rounded-md border border-line bg-paper px-4 py-2 text-xs font-semibold text-ink-2 transition-[background-color,scale] hover:bg-fill active:scale-[0.96] disabled:cursor-wait disabled:opacity-50"
            >
              {loadingMore ? "불러오는 중…" : "계속 찾기"}
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="px-5 py-14 text-center text-sm text-ink-4">발송된 메일이 없습니다.</div>
        ) : (
          rows.map((row) => {
            const stateMeta = {
              label: deliveryStateLabel(row.deliveryState),
              className: STATE_TONE[row.deliveryState] ?? "bg-fill text-ink-3",
            };
            const opened = row.deliveryState === "sent" && row.openCount > 0;
            return (
              <div
                key={row.trackingId}
                className="grid gap-x-3 gap-y-1 border-b border-line px-5 py-3.5 transition-colors last:border-0 hover:bg-fill/60 md:grid-cols-[minmax(0,1.05fr)_minmax(0,1.45fr)_76px_116px_128px_132px] md:items-center"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink">{row.to || "수신자 없음"}</span>
                  {/* 개인 계정 Sent 편입분은 어느 계정에서 보냈는지가 답이다 — canonical(scp)은 생략해 잡음을 줄인다. */}
                  {row.mailAccountId && row.mailAccountId !== "scp" ? (
                    <span className="mt-0.5 block truncate text-[10px] font-medium text-ink-4">
                      {row.mailAccountId} 계정 발신
                    </span>
                  ) : null}
                </span>
                <span className="truncate text-sm text-ink-2">{row.subject || "(제목 없음)"}</span>
                <span>
                  <span className={cn("inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold", stateMeta.className)}>
                    {stateMeta.label}
                  </span>
                </span>
                <span className="text-xs tabular-nums text-ink-3 md:text-right">{formatReceiptTime(row.sentAtIso)}</span>
                <span className="text-xs md:text-right">
                  {row.deliveryState !== "sent" ? (
                    <span className="text-ink-4">—</span>
                  ) : opened ? (
                    <span className="font-semibold text-accent">
                      픽셀 감지 <span className="tabular-nums">{row.openCount}</span>회
                      <span className="font-medium text-ink-4"> · {formatReceiptTime(row.lastOpenedAtIso)}</span>
                    </span>
                  ) : (
                    <span className="font-medium text-ink-4">신호 없음</span>
                  )}
                </span>
                <span className="flex flex-col items-start gap-1 text-xs md:items-end">
                  {row.hasReply && row.conversationId ? (
                    <Link
                      href={`/chat?conversationId=${encodeURIComponent(row.conversationId)}`}
                      data-testid={`mail-receipt-open-conversation-${row.trackingId}`}
                      className="inline-flex rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-semibold text-white transition-[background-color,scale] hover:bg-accent-strong active:scale-[0.96]"
                    >
                      대화 열기
                    </Link>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled
                        data-testid={`mail-receipt-open-conversation-${row.trackingId}`}
                        className="inline-flex cursor-not-allowed rounded-md bg-fill px-2.5 py-1.5 text-[11px] font-semibold text-ink-4"
                      >
                        대화 열기
                      </button>
                      <span className="text-[10px] font-medium text-ink-4">회신이 오면 대화가 열립니다</span>
                    </>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>

      {nextCursor && !loading && rows.length > 0 ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="min-h-10 rounded-md border border-line bg-paper px-4 py-2 text-xs font-semibold text-ink-2 transition-[background-color,scale] hover:bg-fill active:scale-[0.96] disabled:cursor-wait disabled:opacity-50"
          >
            {loadingMore ? "불러오는 중…" : "더 보기"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
