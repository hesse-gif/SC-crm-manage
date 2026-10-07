"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Tabs } from "@/components/ui/Tabs";
import { listChatAutoReviewBoard, type ChatAutoReviewBoardRow, type ChatAutoReviewFieldStatus } from "@/lib/data";
import { caseItemTimeLabel } from "@/lib/casebookInbox";
import {
  SCP_LINT_FAIL_COPY,
  SCP_LINT_LIMITS,
  SCP_LINT_PASS_COPY,
  buildReviewBoardSearch,
  chatConversationHref,
  lintPassed,
  lintScpReplyDraft,
  mergeReviewBoardRows,
  parseReviewBoardUrlState,
  resolveTemplateChoice,
  reviewBoardCounts,
  type ReviewBoardTab,
  type ReviewBoardUrlState,
  type ScpLintCheck,
} from "@/lib/scpReplyReview";
import { SCP_REPLY_TEMPLATES, scpReplyTemplate } from "@/lib/scpReplyTemplates";
import { stageComposerPrefill } from "@/lib/chatComposerPrefill";

// /chat/auto 검토 보드 (2026-10-05): the whole scp population the operator can already see, split by
// what THIS automated batch would do with it. Read-only — no send, schedule, save or setting change
// exists here; "작성창으로 가져오기" only hands a template to the existing human composer on /chat.
// Tab / open row / chosen template / scroll live in the URL (?rb, rbOpen, rbTpl, rbY) so back/forward
// and close/reopen restore the same view.
const PAGE_SIZE = 25;
const TEMPLATE_CHOICES_KEY = "flu.reviewBoard.templateChoices.v1";

function readTemplateChoices(): Record<string, string> {
  try {
    const raw = window.sessionStorage.getItem(TEMPLATE_CHOICES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveTemplateChoice(rowKey: string, templateId: string) {
  try {
    const next = { ...readTemplateChoices(), [rowKey]: templateId };
    window.sessionStorage.setItem(TEMPLATE_CHOICES_KEY, JSON.stringify(next));
  } catch {
    // per-viewer convenience only
  }
}

const TAB_LABELS: Record<ReviewBoardTab, string> = {
  all: "전체",
  excluded: "이번 발송 제외",
  operator_judgment: "운영자 판단",
  final_safety_wait: "마지막 안전 확인 대기",
};

const TAB_HELP: Record<ReviewBoardTab, string> = {
  all: "볼 수 있는 SCP 대화 중 받은 메일이 있는 전체입니다.",
  excluded: "이번 자동 발송에서만 빠집니다. 해결됐다는 뜻은 아닙니다. 사람 응대 경로는 그대로입니다.",
  operator_judgment: "운영자가 판단할 건입니다. 답장 대상이라는 뜻은 아닙니다.",
  final_safety_wait: "발송 가능 아님 · 최종 live 확인 필요",
};

const BUCKET_TONE: Record<ChatAutoReviewBoardRow["sendBatch"]["bucket"], Tone> = {
  excluded: "neutral",
  operator_judgment: "warn",
  final_safety_wait: "info",
};

const STATUS_LABEL: Record<ChatAutoReviewFieldStatus, string> = {
  confirmed: "확인됨",
  partial: "부분 확인",
  unknown: "미확인",
};

function statusText(status: ChatAutoReviewFieldStatus, reason: string | null): string {
  return reason && status !== "confirmed" ? `${STATUS_LABEL[status]} · ${reason}` : STATUS_LABEL[status];
}

/** The element that actually scrolls the board: the app shell's overflow container, else the window. */
function scrollHost(element: HTMLElement | null): HTMLElement | null {
  let node = element?.parentElement ?? null;
  while (node && node !== document.body) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

function writeUrl(next: Partial<ReviewBoardUrlState>, mode: "push" | "replace") {
  if (typeof window === "undefined") return;
  const search = buildReviewBoardSearch(window.location.search, next);
  const url = `${window.location.pathname}${search}${window.location.hash}`;
  if (url === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  // State must be null: Next.js only syncs useSearchParams for history entries it did not create
  // itself (an entry carrying its own __NA state is treated as an internal navigation).
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

export function ReviewBoardPanel({ pendingTotalLabel }: { pendingTotalLabel?: string | null }) {
  const searchParams = useSearchParams();
  const urlState = parseReviewBoardUrlState(searchParams);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const scrollRestoredRef = useRef(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<ChatAutoReviewBoardRow[]>([]);
  const [pages, setPages] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [verifiedAtIso, setVerifiedAtIso] = useState<string | null>(null);
  const [scope, setScope] = useState<{ orgLabel: string; period: string; population: string } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Loads `pageCount` pages sequentially from `startCursor` (null = from the top) and merges them.
  const load = useCallback((startCursor: string | null, pageCount = 1) => {
    requestRef.current += 1;
    const requestId = requestRef.current;
    setError("");
    if (startCursor) setLoadingMore(true);
    else setLoading(true);
    void (async () => {
      let cursor = startCursor;
      let merged: ChatAutoReviewBoardRow[] | null = null;
      let loadedPages = 0;
      let done = false;
      let verified: string | null = null;
      for (let index = 0; index < pageCount; index += 1) {
        const result = await listChatAutoReviewBoard({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
        if (requestId !== requestRef.current || !mountedRef.current) return;
        const incoming = Array.isArray(result.rows) ? result.rows : [];
        merged = mergeReviewBoardRows(merged ?? [], incoming);
        loadedPages += 1;
        verified = result.verifiedAtIso ?? verified;
        if (result.scope) setScope(result.scope);
        done = Boolean(result.exhausted);
        cursor = done ? null : result.nextCursor ?? null;
        if (!cursor) break;
      }
      const pageRows = merged ?? [];
      setRows((current) => (startCursor ? mergeReviewBoardRows(current, pageRows) : pageRows));
      setPages((current) => {
        const total = (startCursor ? current : 0) + loadedPages;
        writeUrl({ pages: total }, "replace");
        return total;
      });
      setNextCursor(cursor);
      setExhausted(done);
      setVerifiedAtIso(verified);
      setNowMs(Date.now());
    })()
      .catch(() => {
        if (requestId !== requestRef.current || !mountedRef.current) return;
        setError("검토 보드를 불러오지 못했어요. 다시 시도해 주세요.");
      })
      .finally(() => {
        if (requestId !== requestRef.current || !mountedRef.current) return;
        setLoading(false);
        setLoadingMore(false);
      });
  }, []);

  // First mount restores as many pages as the URL says were loaded (back/forward, close/reopen).
  const initialPagesRef = useRef(urlState.pages);
  useEffect(() => {
    load(null, initialPagesRef.current);
  }, [load]);

  // Restore the saved scroll position once, after the first rows render.
  useEffect(() => {
    if (scrollRestoredRef.current || loading || rows.length === 0) return;
    scrollRestoredRef.current = true;
    if (urlState.scrollY === null) return;
    const target = urlState.scrollY;
    window.requestAnimationFrame(() => {
      const host = scrollHost(boardRef.current);
      if (host) host.scrollTop = target;
      else window.scrollTo({ top: target });
    });
  }, [loading, rows.length, urlState.scrollY]);

  // Back/forward between board states restores that entry's scroll position too.
  useEffect(() => {
    const onPopState = () => {
      // An entry without a recorded position is the top of the board view.
      const target = parseReviewBoardUrlState(new URLSearchParams(window.location.search)).scrollY ?? 0;
      window.requestAnimationFrame(() => {
        const host = scrollHost(boardRef.current);
        if (host) host.scrollTop = target;
        else window.scrollTo({ top: target });
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Scroll position of whichever element scrolls the page (capture: inner containers don't bubble).
  useEffect(() => {
    let timer: number | undefined;
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const host = scrollHost(boardRef.current);
        writeUrl({ scrollY: Math.round(host ? host.scrollTop : window.scrollY) }, "replace");
      }, 400);
    };
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, []);

  const counts = useMemo(() => reviewBoardCounts(rows), [rows]);
  const visibleRows = urlState.tab === "all" ? rows : rows.filter((row) => row.sendBatch.bucket === urlState.tab);
  const partial = !exhausted;
  const countText = (value: number) => (partial ? `${value}+` : value);

  const setTab = (tab: string) => {
    if (tab === urlState.tab) return;
    writeUrl({ tab: tab as ReviewBoardTab }, "push");
  };
  // Collapsing/expanding keeps each row's own template choice (sessionStorage, per viewer).
  const toggleRow = (rowKey: string) => {
    const opening = urlState.open !== rowKey;
    writeUrl({ open: opening ? rowKey : null, template: opening ? readTemplateChoices()[rowKey] ?? null : null }, "push");
  };

  return (
    <div ref={boardRef}>
    <Card className="mt-6" data-testid="review-board">
      <CardHeader
        title="검토 보드"
        desc="이번 자동 발송에서 빠지는 건, 운영자가 판단할 건, 마지막 확인이 남은 건을 나눠 봅니다. 여기서는 보내거나 저장하지 않습니다."
        action={<Badge tone="neutral">검토 전용</Badge>}
      />
      <div className="space-y-3 px-5 py-4">
        <div className="max-w-full overflow-x-auto" role="tablist" aria-label="검토 보드 보기">
          <Tabs
            value={urlState.tab}
            onChange={setTab}
            tabs={(Object.keys(TAB_LABELS) as ReviewBoardTab[]).map((key) => ({
              key,
              label: TAB_LABELS[key],
              count: loading ? undefined : countText(counts.rows[key]),
            }))}
          />
        </div>
        <p className="text-xs text-ink-3" data-testid="review-board-tab-help">{TAB_HELP[urlState.tab]}</p>
        {scope ? (
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-3" data-testid="review-board-scope">
            <span>조회 범위: SCP 메일함 · {scope.orgLabel}</span>
            <span>기간: {scope.period}</span>
            <span>대상: {scope.population}</span>
          </p>
        ) : null}
        {!loading && !error ? (
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2" data-testid="review-board-units">
            <span>확인된 주소 묶음 <b className="tabular-nums">{countText(counts.verifiedGroups[urlState.tab])}</b></span>
            <span>미확인 대화 <b className="tabular-nums">{countText(counts.unverifiedConversations[urlState.tab])}</b></span>
            <span>보호 항목 <b className="tabular-nums">{countText(counts.protectedConversations)}</b></span>
            <span>불러온 대화 <b className="tabular-nums">{counts.conversations}</b></span>
            {pendingTotalLabel ? <span className="text-ink-3">케이스북 대기 {pendingTotalLabel} (자동답장 대기만 셈)</span> : null}
            {partial ? <span className="font-semibold text-warn" data-testid="review-board-partial">부분 조회 · {pages}페이지 · 더 있음</span> : <span className="text-ink-3">전체 조회 완료 · {pages}페이지</span>}
            {verifiedAtIso ? <span className="text-ink-4">{caseItemTimeLabel(verifiedAtIso, nowMs)} 기준</span> : null}
          </p>
        ) : null}

        {loading ? (
          <div role="status" aria-label="검토 보드를 불러오는 중" className="space-y-2" data-testid="review-board-loading">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="animate-pulse rounded-md border border-line px-3 py-3">
                <div className="h-3 w-1/3 rounded bg-fill" />
                <div className="mt-2 h-3 w-2/3 rounded bg-fill" />
              </div>
            ))}
            <p className="text-xs text-ink-3">불러오는 중 · 대화마다 회신·대기열·억제를 확인하고 있어요.</p>
          </div>
        ) : null}

        {error ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger" role="alert" data-testid="review-board-error">
            <span>{error}</span>
            <Button type="button" size="sm" variant="secondary" disabled={loading || loadingMore} onClick={() => load(rows.length > 0 ? nextCursor : null)}>
              다시 시도
            </Button>
          </div>
        ) : null}

        {!loading && !error && visibleRows.length === 0 ? (
          <div className="rounded-md border border-line bg-fill px-3 py-4 text-sm text-ink-3" data-testid="review-board-empty">
            {partial ? "지금까지 불러온 범위에는 이 보기에 해당하는 건이 없어요. 더 불러와 확인하세요." : "이 보기에 해당하는 건이 없어요."}
          </div>
        ) : null}

        {visibleRows.length > 0 ? (
          <ul className="divide-y divide-line rounded-md border border-line" data-testid="review-board-list">
            {visibleRows.map((row) => (
              <ReviewBoardRowItem
                key={row.rowKey}
                row={row}
                open={urlState.open === row.rowKey}
                templateParam={urlState.open === row.rowKey ? urlState.template : null}
                nowMs={nowMs}
                onToggle={() => toggleRow(row.rowKey)}
              />
            ))}
          </ul>
        ) : null}

        {nextCursor && !loading ? (
          <Button type="button" size="sm" variant="secondary" disabled={loadingMore} onClick={() => load(nextCursor)} data-testid="review-board-more">
            {loadingMore ? "불러오는 중" : "더 불러오기"}
          </Button>
        ) : null}
      </div>
    </Card>
    </div>
  );
}

function Chip({ tone = "neutral", children, testId, title }: { tone?: Tone; children: React.ReactNode; testId?: string; title?: string }) {
  return (
    <Badge tone={tone} className="font-medium" title={title}>
      <span data-testid={testId}>{children}</span>
    </Badge>
  );
}

function ReviewBoardRowItem({
  row,
  open,
  templateParam,
  nowMs,
  onToggle,
}: {
  row: ChatAutoReviewBoardRow;
  open: boolean;
  templateParam: string | null;
  nowMs: number;
  onToggle: () => void;
}) {
  const href = chatConversationHref(row.conversationId);
  const unknownCount = [row.realReplies, row.queued, row.suppressed, row.aiActive, row.identity].filter((field) => field.status !== "confirmed").length;
  const draftChip = row.draft.draftAllowed
    ? row.draft.status === "system_default" || row.draft.suggestedTemplateId ? "초안 검토 가능 · 전송 불가" : "초안 없음"
    : row.aiActive.value === false ? "운영자 담당 (AI off)" : row.protected ? "보호 · 초안 없음" : "답장 없음";
  return (
    <li data-testid={`review-row-${row.conversationTail}`} data-row-key={row.rowKey}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-3 py-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left"
          data-testid={`review-row-toggle-${row.conversationTail}`}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs tabular-nums text-ink-3">{caseItemTimeLabel(row.latestInboundAtIso, nowMs)}</span>
            <span className="truncate text-sm font-semibold text-ink">{row.creatorName ?? "이름 없음"}</span>
            {row.creatorEmailMasked ? <span className="text-xs text-ink-4">{row.creatorEmailMasked}</span> : null}
            <span className="text-xs text-ink-4">대화 …{row.conversationTail}</span>
            <span className="text-xs text-ink-3">{row.grouping.label}</span>
          </div>
          <p className="mt-1 truncate text-sm text-ink-2" data-testid="row-summary-line">
            {row.aiActive.value === false
              ? "운영자 담당(AI off) · 요약 비표시"
              : row.protected
                ? "보호 · 요약 비표시"
                : row.summary.value ?? "요약 없음"}
            {!row.protected && row.aiActive.value !== false && row.summary.source !== "body" ? (
              <span className="ml-1.5 text-xs font-semibold text-warn">[{row.summary.source === "unverified" ? "본문 출처 미확인" : row.summary.source === "summary_fallback" ? "요약본" : "요약 없음"}]</span>
            ) : null}
            {row.primaryCaseLabel ? <span className="ml-1.5 text-xs text-ink-3">· {row.primaryCaseLabel}</span> : <span className="ml-1.5 text-xs text-ink-3">· 분류 없음</span>}
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-3" data-testid="row-facts-line">
            <span>마지막 발신: {row.lastMessageSide === "creator" ? "크리에이터" : row.lastMessageSide === "operator" ? "우리" : "미확인"}</span>
            <span>
              최근 실제 회신:{" "}
              {row.realReplies.latestAtIso
                ? caseItemTimeLabel(row.realReplies.latestAtIso, nowMs)
                : row.realReplies.status === "confirmed" ? "없음" : row.realReplies.status === "partial" ? "미확인(부분)" : "미확인"}
            </span>
            <span>대기열: {row.queued.value ? "대기" : row.queued.status === "confirmed" ? "없음" : row.queued.status === "partial" ? "미확인(부분)" : "미확인"}</span>
            <span>AI: {row.aiActive.value === null ? "미확인" : row.aiActive.value ? "on" : "off"}</span>
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Chip tone={BUCKET_TONE[row.sendBatch.bucket]} testId="chip-batch">
              {TAB_LABELS[row.sendBatch.bucket]}{row.sendBatch.reasonLabel ? ` · ${row.sendBatch.reasonLabel}` : ""}
            </Chip>
            <Chip tone={row.question.status === "unresolved" ? "warn" : "neutral"} testId="chip-question">질문: {row.question.label}</Chip>
            <Chip tone={row.draft.draftAllowed ? "ai" : "neutral"} testId="chip-draft">{draftChip}</Chip>
            <Chip tone="accent" testId="chip-next">다음 행동: {row.nextActionLabel}</Chip>
            <Chip testId="chip-classification" title="이 보드의 분류는 사람이 검증한 결과가 아닙니다">{row.classification.label}</Chip>
            {row.protected ? <Chip tone="danger" testId="chip-protected">보호 · {row.protectedReasons.join("·")}</Chip> : null}
            {row.orgAutomationOff ? <Chip testId="chip-org-off">자동화 꺼짐(조직)</Chip> : null}
            {row.newInboundSinceJudgment ? <Chip tone="warn" testId="chip-new-inbound">새 문의 있음 · 이전 판정 재확인 필요</Chip> : null}
            {row.claims.map((claim) => <Chip key={claim} testId="chip-claim">{claim}</Chip>)}
            {unknownCount > 0 ? <Chip tone="warn" testId="chip-unknown">미확인 {unknownCount}</Chip> : null}
          </div>
        </button>
        {href ? (
          <a href={href} className="shrink-0 rounded-md border border-line bg-paper px-2.5 py-1 text-xs font-semibold text-ink-2 hover:bg-fill" data-testid={`review-row-link-${row.conversationTail}`}>
            대화 열기
          </a>
        ) : null}
      </div>
      {open ? <ReviewRowDetail row={row} templateParam={templateParam} nowMs={nowMs} /> : null}
    </li>
  );
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="space-y-1.5" data-testid={testId}>
      <h4 className="text-xs font-bold text-ink-2">{title}</h4>
      {children}
    </section>
  );
}

function ReviewRowDetail({ row, templateParam, nowMs }: { row: ChatAutoReviewBoardRow; templateParam: string | null; nowMs: number }) {
  const href = chatConversationHref(row.conversationId);
  return (
    <div className="space-y-4 border-t border-line bg-fill/40 px-3 py-4" data-testid={`review-detail-${row.conversationTail}`}>
      <div className="grid gap-4 md:grid-cols-2">
        <Section title="질문 상태" testId="detail-question">
          <p className="text-sm text-ink">{row.question.label}{row.question.questionCount !== null ? ` · 물음표 ${row.question.questionCount}개` : ""}</p>
          <p className="text-xs text-ink-2">권장 처리: {row.question.recommendedHandling}</p>
        </Section>
        <Section title="받은 메일 요약" testId="detail-summary">
          {row.summary.value ? <p className="text-sm text-ink-2">{row.summary.value}</p> : <p className="text-xs text-ink-3">표시할 요약이 없어요.</p>}
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tone={row.summary.source === "body" ? "neutral" : "warn"} testId="summary-source">{row.summary.sourceLabel}</Chip>
            {href && !row.protected ? <a href={href} className="text-xs font-semibold text-accent hover:underline">원문은 Chat 원문 보기에서</a> : null}
          </div>
        </Section>
      </div>

      <Section title="근거" testId="detail-evidence">
        <ul className="grid gap-x-4 gap-y-1 text-xs text-ink-2 md:grid-cols-2">
          <li>케이스: {row.primaryCaseLabel ?? "분류 없음"}{row.evidenceCaseIds.length ? ` · 참고 ${row.evidenceCaseIds.join(", ")}` : ""}</li>
          <li>분류 출처: {row.classification.label}</li>
          <li>발신자 확인: {row.identity.value === "verified" ? (row.identity.fromMatches ? "확인됨(실제 From 일치)" : "From 불일치") : row.identity.value === "review_required" ? "확인 필요" : statusText(row.identity.status, row.identity.reason)}</li>
          <li>등록 여부: {row.registration.value === "not_applicable" ? "해당 없음" : "판정 안 함"}</li>
          <li>AI 자동응답: {row.aiActive.value === null ? statusText(row.aiActive.status, row.aiActive.reason) : row.aiActive.value ? "켜짐" : "꺼짐 · 운영자 담당"}</li>
          <li>발송 대기열: {row.queued.value ? "있음" : "없음"} · {statusText(row.queued.status, row.queued.reason)}</li>
          <li>수신 억제: {row.suppressed.value ? "있음" : "없음"} · {statusText(row.suppressed.status, row.suppressed.reason)}</li>
          <li>마지막 메시지: {row.lastMessageSide === "creator" ? "크리에이터" : row.lastMessageSide === "operator" ? "우리 쪽" : "미확인"}</li>
        </ul>
        {row.conversations.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-1.5" data-testid="detail-conversations">
            {row.conversations.map((item, index) => {
              const itemHref = chatConversationHref(item.conversationId);
              const role = row.conversations.length > 1 ? (index === 0 ? "최신 · " : index === row.conversations.length - 1 ? "처음 · " : "") : "";
              return itemHref ? (
                <li key={item.conversationId}>
                  <a href={itemHref} className="rounded-md border border-line bg-paper px-2 py-0.5 text-xs text-ink-2 hover:bg-fill">
                    {role}대화 …{item.conversationTail}{item.primaryCaseLabel ? ` · ${item.primaryCaseLabel}` : ""}{item.protected ? " · 보호" : ""}
                  </a>
                </li>
              ) : null;
            })}
          </ul>
        ) : null}
      </Section>

      <Section title="최근 14일 우리 쪽 발송 (실제 회신 먼저)" testId="detail-replies">
        <p className="text-xs text-ink-2">
          실제 회신 {row.realReplies.value}건{row.realReplies.possibleCount ? ` · 회신 가능성(미확인) ${row.realReplies.possibleCount}건` : ""} · {statusText(row.realReplies.status, row.realReplies.reason)}
          {row.realReplies.latestAtIso ? ` · 최근 실제 회신 ${caseItemTimeLabel(row.realReplies.latestAtIso, nowMs)}${row.realReplies.latestAfterInbound ? " (받은 메일 이후)" : ""}` : ""}
        </p>
        {row.realReplies.evidence.length > 0 ? (
          <ul className="space-y-0.5 text-xs text-ink-2">
            {row.realReplies.evidence.map((item, index) => (
              <li key={`${item.sentAtIso}-${index}`} className="flex flex-wrap gap-x-2">
                <span className={item.kind === "real_reply" ? "font-semibold text-ink" : "text-ink-3"}>{item.kindLabel}</span>
                <span className="tabular-nums text-ink-3">{caseItemTimeLabel(item.sentAtIso, nowMs)}</span>
                <span className="text-ink-4">{item.sameConversation ? "이 대화" : item.conversationTail ? `다른 대화 …${item.conversationTail}` : "대화 연결 없음"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-3">찾은 발송이 없어요.</p>
        )}
      </Section>

      <DraftReview row={row} templateParam={templateParam} />

      <Section title="이 조회로 확인할 수 없는 것" testId="detail-unknowns">
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-ink-3">
          {row.unknowns.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </Section>
    </div>
  );
}

function LintList({ checks, testId }: { checks: ScpLintCheck[]; testId: string }) {
  const passed = lintPassed(checks);
  return (
    <div className="space-y-1" data-testid={testId}>
      <p className={passed ? "text-xs font-semibold text-ok" : "text-xs font-semibold text-warn"}>
        {passed ? SCP_LINT_PASS_COPY : SCP_LINT_FAIL_COPY}
        <span className="ml-1 font-normal text-ink-3">· 정책·사실·수신자·발송 승인이 아니에요</span>
      </p>
      <ul className="space-y-0.5 text-xs">
        {checks.map((check) => (
          <li key={check.id} className={check.ok ? "text-ink-3" : "font-semibold text-warn"} data-lint-id={check.id} data-lint-ok={check.ok ? "1" : "0"}>
            {check.ok ? "통과" : "경고"} · {check.label}{check.detail ? ` (${check.detail})` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DraftReview({ row, templateParam }: { row: ChatAutoReviewBoardRow; templateParam: string | null }) {
  const [copied, setCopied] = useState("");
  if (!row.draft.draftAllowed) {
    return (
      <Section title="초안 검토" testId="detail-draft-locked">
        <p className="rounded-md border border-line bg-paper px-3 py-2 text-xs text-ink-2">
          {row.draft.reason ?? "초안 없음"}. 이 보드에서는 초안·템플릿을 보여주지 않아요. 사람 응대는 대화 열기에서 기존대로 할 수 있어요.
        </p>
      </Section>
    );
  }
  const recommended = SCP_REPLY_TEMPLATES.find((template) => template.id === row.draft.suggestedTemplateId && template.recommendable) ?? null;
  const chosen = resolveTemplateChoice(templateParam, recommended, scpReplyTemplate);
  const templateLint = chosen ? lintScpReplyDraft(chosen.text, row.question.questionCount) : [];
  const systemLint = row.draft.text ? lintScpReplyDraft(row.draft.text, row.question.questionCount) : [];
  const chooseTemplate = (id: string) => {
    const value = id || "none";
    saveTemplateChoice(row.rowKey, value);
    writeUrl({ template: value }, "replace");
  };
  const copy = async () => {
    if (!chosen) return;
    try {
      await navigator.clipboard.writeText(chosen.text);
      setCopied(chosen.id);
    } catch {
      setCopied("");
    }
  };
  const loadIntoComposer = () => {
    if (!chosen) return;
    const target = stageComposerPrefill({ conversationId: row.conversationId, templateId: chosen.id, text: chosen.text });
    if (target) window.location.assign(target);
  };
  return (
    <Section title="초안 검토 · 전송 불가(검토 전용)" testId="detail-draft">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 max-w-full items-center gap-1.5 text-xs text-ink-2">
          템플릿
          <select
            value={chosen?.id ?? ""}
            onChange={(event) => chooseTemplate(event.target.value)}
            className="h-8 min-w-0 max-w-full rounded-md border border-line bg-paper px-2 text-xs text-ink"
            data-testid="template-select"
          >
            <option value="">선택 안 함</option>
            {SCP_REPLY_TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.badge} · {template.title}{template.recommendable ? "" : " (이전 기준 참고)"}
              </option>
            ))}
          </select>
        </label>
        {recommended ? <span className="text-xs text-ink-3">자동 추천: {recommended.badge} · 사람이 고릅니다</span> : <span className="text-xs text-ink-3">자동 추천 없음</span>}
      </div>
      {chosen ? (
        <div className="grid gap-3 md:grid-cols-2" data-testid="template-review">
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-semibold text-ink-3">받은 메일 요약 ({row.summary.sourceLabel})</p>
            <p className="rounded-md border border-line bg-paper px-3 py-2 text-xs text-ink-2">{row.summary.value ?? "요약 없음"}</p>
            <LintList checks={templateLint} testId="template-lint" />
            <p className="text-xs text-ink-4">{SCP_LINT_LIMITS}</p>
          </div>
          <div className="min-w-0 space-y-1.5">
            <p className="text-xs font-semibold text-ink-3">{chosen.badge} · {chosen.title}</p>
            <p className="text-xs text-ink-3">출처: {chosen.provenance}</p>
            <p className="text-xs text-ink-3">쓰임: {chosen.usage}</p>
            {chosen.condition ? <p className="text-xs font-semibold text-warn" data-testid="template-condition">{chosen.condition}</p> : null}
            {row.draft.basisLabel && chosen.id === "rate_policy" ? <p className="text-xs text-ink-3">{row.draft.basisLabel}</p> : null}
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md border border-line bg-paper px-3 py-2 font-sans text-xs leading-relaxed text-ink" data-testid="template-text">{chosen.text}</pre>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => void copy()} data-testid="template-copy">
                {copied === chosen.id ? "복사했어요" : "복사"}
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={loadIntoComposer} data-testid="template-to-composer">
                작성창으로 가져오기
              </Button>
              <span className="text-xs text-ink-3">작성창에서 사람이 고치고 보냅니다. 이 보드는 저장·발송하지 않아요.</span>
            </div>
          </div>
        </div>
      ) : null}
      {row.draft.text ? (
        <details className="rounded-md border border-line bg-paper px-3 py-2" data-testid="system-default-reply">
          <summary className="cursor-pointer text-xs font-semibold text-ink-2">
            {row.draft.label}{row.draft.sourceLabel ? ` · ${row.draft.sourceLabel}` : ""}
          </summary>
          <pre className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] font-sans text-xs leading-relaxed text-ink-2">{row.draft.text}</pre>
          <div className="mt-2"><LintList checks={systemLint} testId="system-default-lint" /></div>
        </details>
      ) : (
        <p className="text-xs text-ink-3">{row.draft.reason ?? "시스템 기본 답신 없음"}</p>
      )}
    </Section>
  );
}
