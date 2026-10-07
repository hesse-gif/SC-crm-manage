import type { ReactNode } from "react";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Tabs } from "@/components/ui/Tabs";
import {
  type ChatAutoCaseCommittedSendRow,
  type ChatAutoCaseHeldBacklogSkipped,
  type ChatAutoCasebookReplyLink,
  type ChatAutoCasebookSnapshotEnvelope,
  type ChatAutoCasebookSnapshotRow,
  type ChatAutoCasebookReplyText,
  type ChatAutoCasebookUnclassifiedReason,
  type ChatAutoCasePermitEvalStatus,
  type ChatAutoNeedsReviewCandidate,
  type SendChatAutoCaseHeldBacklogNowEnvelope,
} from "@/lib/data";
import {
  CASEBOOK_FILTER_LABELS,
  attentionBadges,
  buildInboxEntries,
  casebookLinkChoices,
  filterInboxEntries,
  inboxFilterCounts,
  pendingCountLabel,
  visiblePendingTotal,
  unclassifiedNeedsHuman,
  type CasebookInboxFilter,
  type PendingDisplayKind,
} from "@/lib/casebookInbox";
import { CaseReplyEditor } from "./CaseReplyEditor";
import { CaseItemsPanel } from "./CaseItemsPanel";
import { UnclassifiedPanel } from "./UnclassifiedPanel";

type PermitAction = "arm" | "disarm" | "eval";

// F1 (2026-09-05 Aside 실측): arm/eval/disarm 은 전부 manager 이상만 쓸 수 있다
// (functions/chatAutoCasePermitCallables.ts MUTATION_ROLES 와 같은 하한선 —
// src/lib/permitRoleGate.ts 의 permitManageRoleGate 가 그 판정을 낸다). 이 화면은 그 경계를 보이지 않는
// disabled 버튼으로만 표현해 왔다 — 왜 눌리지 않는지 문구가 없었다. 서버가 최종 권한이다;
// 이 라벨은 그 사실을 미리 알리는 안내일 뿐이다.
export const PERMIT_MANAGE_BOUNDARY_LABEL = "manager 이상 전용 · 서버가 최종 검증합니다";

type CandidateConversation = {
  conversationId: string;
  title: string;
  candidates: ChatAutoNeedsReviewCandidate[];
  permitDenyReasons: string[];
  clampReasonIds: string[];
  autoRepliedCaseIds: string[];
};

// Casebook snapshot (2026-09-28, "simplify in place" direction): a case's "최근 발송" is now a
// single selection the parent (CasebookSection, page.tsx) drives via one more
// getChatAutoCasebookSnapshot({selectedCaseId}) call — no client-side pagination, cursors, or
// viewAs plumbing. Selecting a case never re-runs the pending scan — that scan doesn't even run on
// this callable's request path anymore (2026-09-29 hotfix): pending counts are a scheduled
// precompute the callable only ever reads.
type SelectedSends = { caseId: string; sends: ChatAutoCaseCommittedSendRow[] | null; loading: boolean; error: string };

// "보류 N건 지금 보내기" (case-backlog-send, 2026-09-28): the parent (CasebookSection, page.tsx) owns
// all state/network calls, matching the SelectedSends pattern above — this is non-null only for the
// ONE currently-expanded row (getChatAutoCaseHeldBacklogCount is lazy, on expand, never fetched for
// every armed row at once).
type CaseBacklogSendState = {
  caseId: string;
  heldCount: number | null; // null while the count has never resolved yet (first load in flight)
  scanCap: number;
  scannedCapped: boolean;
  countLoading: boolean;
  countError: string;
  confirming: boolean;
  sendBusy: boolean;
  sendError: string;
  result: SendChatAutoCaseHeldBacklogNowEnvelope | null;
};

const CASE_BACKLOG_SKIPPED_LABELS: Record<keyof ChatAutoCaseHeldBacklogSkipped, string> = {
  takenOver: "사람이 개입",
  alreadyReplied: "이미 발송됨",
  laneLocked: "처리 중",
  aiInactive: "자동응답 꺼짐",
  denied: "조건 미충족",
  stale: "이후 변경됨",
  recentlyDenied: "최근 거부됨",
  orgExcluded: "조직 제외",
  manualReplyDetected: "사람 답장 감지",
  caseMismatch: "다른 케이스로 분류",
  humanReviewHeld: "사람 검토 대기",
};

function caseBacklogTotalSkipped(skipped: ChatAutoCaseHeldBacklogSkipped): number {
  return Object.values(skipped).reduce((sum, value) => sum + value, 0);
}

function caseBacklogSkippedBreakdownLabel(skipped: ChatAutoCaseHeldBacklogSkipped): string {
  const entries = (Object.keys(CASE_BACKLOG_SKIPPED_LABELS) as Array<keyof ChatAutoCaseHeldBacklogSkipped>)
    .map((key) => ({ label: CASE_BACKLOG_SKIPPED_LABELS[key], count: skipped[key] }))
    .filter((entry) => entry.count > 0);
  if (entries.length === 0) return "없음";
  return entries.map((entry) => `${entry.label} ${entry.count}건`).join(", ");
}

export function PermitCasePanel({
  rows,
  loading,
  error,
  canManage,
  canEditReplies,
  canSuggestReplies,
  actionBusyKey,
  actionError,
  candidateError,
  candidateConversations,
  onAction,
  selected,
  onSelectCase,
  onReloadReply,
  onSavedReply,
  pendingKind,
  pendingStatus,
  pendingTotalCount,
  filter,
  onFilterChange,
  unclassified,
  pinnedKeys,
  onEditorEngagedChange,
  replyLinkCatalog,
  backlogSend,
  onToggleBacklogSend,
  onRequestBacklogSend,
  onCancelBacklogSend,
  onConfirmBacklogSend,
  onContinueBacklogSend,
}: {
  rows: ChatAutoCasebookSnapshotRow[];
  loading: boolean;
  error: string;
  candidateError: string;
  canManage: boolean;
  canEditReplies: boolean;
  canSuggestReplies: boolean;
  actionBusyKey: string;
  actionError: string;
  candidateConversations: CandidateConversation[];
  onAction: (row: ChatAutoCasebookSnapshotRow, action: PermitAction) => void;
  selected: SelectedSends | null;
  onSelectCase: (caseId: string) => void;
  onReloadReply: (caseId: string) => Promise<ChatAutoCasebookReplyText | null>;
  onSavedReply: () => Promise<void>;
  /** How far the cached counts can be trusted — only "exact" may render a bare integer. */
  pendingKind: PendingDisplayKind;
  /** pendingTotal.status — only a "fresh" exact 0 may hide an entry (a stale 0 is displayed, never hidden). */
  pendingStatus: ChatAutoCasebookSnapshotEnvelope["pendingTotal"]["status"];
  /** pendingTotal.count — the program-wide headline, never replaced by a filtered sum. */
  pendingTotalCount: number;
  /** View-only filter (no server mutation). */
  filter: CasebookInboxFilter;
  onFilterChange: (filter: CasebookInboxFilter) => void;
  /** The "미분류" bucket as a first-class entry; null hides it (older server, nothing to show). */
  unclassified: {
    count: number;
    byReason: Record<ChatAutoCasebookUnclassifiedReason, number> | null;
    /** Of byReason.never_classified, how many predate case stamping (null/absent = unknown). */
    legacyCount?: number | null;
    asOfLabel: string;
  } | null;
  /** Row keys that must stay visible whatever the filter says (an open/unsaved editor). */
  pinnedKeys: ReadonlySet<string>;
  onEditorEngagedChange: (caseId: string, engaged: boolean) => void;
  replyLinkCatalog: ChatAutoCasebookReplyLink[] | undefined;
  /** "보류 N건 지금 보내기" — non-null only for the ONE currently-expanded armed case row. */
  backlogSend: CaseBacklogSendState | null;
  onToggleBacklogSend: (caseId: string) => void;
  onRequestBacklogSend: (caseId: string) => void;
  onCancelBacklogSend: (caseId: string) => void;
  onConfirmBacklogSend: (caseId: string) => void;
  onContinueBacklogSend: (caseId: string) => void;
}) {
  // One list: case rows + the 미분류 bucket, sorted by pending count (ties = server order), then the
  // view filter. Pure projection — nothing here is written back to the server.
  const entries = buildInboxEntries(
    rows,
    // 미분류 needs a human when conversations are waiting OR its count is unknown (never hide an
    // unknown backlog); only a known 0 leaves it under 전체.
    unclassified ? { pendingCount: unclassified.count, needsHuman: unclassifiedNeedsHuman(unclassified.count, pendingKind, pendingStatus) } : null,
  );
  const visibleEntries = filterInboxEntries(entries, filter, pinnedKeys);
  const filterCounts = inboxFilterCounts(entries);
  const hiddenCount = entries.length - visibleEntries.length;
  // 답장 불필요 tab only when the server marks such rows (an older server never does → tabs unchanged).
  const filterKeys = (Object.keys(CASEBOOK_FILTER_LABELS) as CasebookInboxFilter[])
    .filter((key) => key !== "no_reply_needed" || filterCounts.no_reply_needed > 0 || filter === "no_reply_needed");
  return (
    <div className="mt-6 space-y-4" data-testid="permit-chat-auto-ui">
      <Card>
        <CardHeader
          title="케이스별 자동발송"
          desc="새 케이스는 기본으로 꺼져 있습니다. 승인 발송 수, 설정 일치 여부, 최신 검증이 모두 맞을 때만 켤 수 있습니다."
          action={<Badge tone={canManage ? "ai" : "neutral"}>{canManage ? "관리 권한" : `조회 전용 · ${PERMIT_MANAGE_BOUNDARY_LABEL}`}</Badge>}
        />
        {loading ? (
          <div className="px-5 py-8 text-sm text-ink-3" role="status">
            케이스별 자동발송 상태를 불러오는 중입니다.
          </div>
        ) : null}
        {error ? (
          <div data-testid="permit-status-error" className="border-b border-danger/20 bg-danger-soft px-5 py-3 text-sm font-semibold text-danger" role="alert">
            {error}
          </div>
        ) : null}
        {!loading && rows.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3" data-testid="casebook-inbox-filter">
            <div role="tablist" aria-label="케이스 보기 필터" className="max-w-full overflow-x-auto">
              <Tabs
                tabs={filterKeys.map((key) => ({
                  key,
                  label: CASEBOOK_FILTER_LABELS[key],
                  count: filterCounts[key],
                }))}
                value={filter}
                onChange={(key) => onFilterChange(key as CasebookInboxFilter)}
              />
            </div>
            {hiddenCount > 0 ? (
              <p className="text-xs text-ink-3" data-testid="casebook-filter-summary">
                필터로 {hiddenCount}개를 숨겼습니다 ·{" "}
                <span data-testid="casebook-filter-total">전체 대기 {pendingCountLabel(pendingKind, pendingTotalCount)}</span>
                {" · "}
                <span data-testid="casebook-filter-visible-sum">현재 보이는 합계 {pendingCountLabel(pendingKind, visiblePendingTotal(visibleEntries))}</span>
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="divide-y divide-line">
          {visibleEntries.map((entry) => {
            if (entry.kind === "unclassified") {
              return unclassified ? (
                <UnclassifiedPanel
                  key={entry.key}
                  count={unclassified.count}
                  kind={pendingKind}
                  byReason={unclassified.byReason}
                  legacyCount={unclassified.legacyCount ?? null}
                  asOfLabel={unclassified.asOfLabel}
                />
              ) : null;
            }
            const row = entry.row;
            // key={caseId}: an open editor's text / CAS base / suggestion state belongs to its case, so
            // re-sorting or filtering can move the row but never hand that state to another case.
            return (
              <PermitCaseRow
                key={entry.key}
                row={row}
                canManage={canManage}
                canEditReplies={canEditReplies}
                canSuggestReplies={canSuggestReplies}
                busyKey={actionBusyKey}
                onAction={onAction}
                selected={selected}
                onSelectCase={onSelectCase}
                onReloadReply={onReloadReply}
                onSavedReply={onSavedReply}
                pendingKind={pendingKind}
                replyLinkCatalog={replyLinkCatalog}
                onEditorEngagedChange={onEditorEngagedChange}
                backlogSend={backlogSend?.caseId === row.caseId ? backlogSend : null}
                onToggleBacklogSend={onToggleBacklogSend}
                onRequestBacklogSend={onRequestBacklogSend}
                onCancelBacklogSend={onCancelBacklogSend}
                onConfirmBacklogSend={onConfirmBacklogSend}
                onContinueBacklogSend={onContinueBacklogSend}
              />
            );
          })}
          {!loading && rows.length === 0 ? (
            <div className="px-5 py-8 text-sm text-ink-3">
              서버가 아직 자동발송 케이스를 내려주지 않았습니다. 케이스별 자동발송은 기본 꺼짐으로 유지됩니다.
            </div>
          ) : null}
          {!loading && rows.length > 0 && visibleEntries.length === 0 ? (
            <div className="px-5 py-8 text-sm text-ink-3" data-testid="casebook-filter-empty">
              {filter === "auto_healthy"
                ? "자동답장이 설정된 케이스가 없습니다."
                : filter === "no_reply_needed"
                  ? "답장이 필요 없는 대기 케이스가 없습니다."
                  : "지금 사람이 처리할 케이스가 없습니다."}
              <button
                type="button"
                onClick={() => onFilterChange("all")}
                className="ml-2 font-semibold text-accent underline underline-offset-2"
                data-testid="casebook-filter-show-all"
              >
                전체 보기
              </button>
            </div>
          ) : null}
        </div>
        {actionError ? (
          <div className="border-t border-danger/20 bg-danger-soft px-5 py-3 text-sm font-semibold text-danger" role="alert">
            {actionError}
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="검토 후보"
          desc="서버가 사람 검토로 넘긴 후보만 표시합니다. 후보는 대화와 메시지마다 최대 4개이며, 실제 발송 기록은 채팅 작성창에서 사람이 검토한 뒤 누적됩니다."
        />
        {candidateError ? (
          <div className="border-b border-warn/20 bg-warn-soft px-5 py-3 text-sm font-semibold text-warn" role="status">
            {candidateError}
          </div>
        ) : null}
        <div className="divide-y divide-line">
          {candidateConversations.map((conversation) => (
            <div key={conversation.conversationId} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-ink">{conversation.title}</div>
                  <div className="mt-1 text-xs text-ink-3">
                    실제 발송된 케이스 {conversation.autoRepliedCaseIds.length}건
                  </div>
                </div>
                <a
                  href={`/chat?conversationId=${encodeURIComponent(conversation.conversationId)}`}
                  className="rounded-md border border-line bg-paper px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-fill"
                >
                  채팅에서 검토
                </a>
              </div>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {conversation.candidates.map((candidate) => (
                  <div key={`${conversation.conversationId}:${candidate.caseId}`} className="rounded-md border border-line bg-fill px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-semibold text-ink">{candidate.title}</span>
                      <Badge tone="warn">{reasonLabel(candidate.reasonCode)}</Badge>
                    </div>
                    <div className="mt-1 text-[11px] text-ink-3">
                      검토 사유: {reasonListLabel(candidate.clampReasonIds)}
                    </div>
                  </div>
                ))}
              </div>
              {conversation.clampReasonIds.length > 0 ? (
                <div className="mt-2 text-[11px] text-ink-3">
                  대화 검토 사유: {reasonListLabel(conversation.clampReasonIds)}
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-ink-3">
                <span>중단 사유 {reasonListLabel(conversation.permitDenyReasons)}</span>
              </div>
            </div>
          ))}
          {candidateConversations.length === 0 ? (
            <div className="px-5 py-8 text-sm text-ink-3">
              검토 후보가 없습니다.
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function PermitCaseRow({
  row,
  canManage,
  canEditReplies,
  canSuggestReplies,
  busyKey,
  onAction,
  selected,
  onSelectCase,
  onReloadReply,
  onSavedReply,
  pendingKind,
  replyLinkCatalog,
  onEditorEngagedChange,
  backlogSend,
  onToggleBacklogSend,
  onRequestBacklogSend,
  onCancelBacklogSend,
  onConfirmBacklogSend,
  onContinueBacklogSend,
}: {
  row: ChatAutoCasebookSnapshotRow;
  canManage: boolean;
  canEditReplies: boolean;
  canSuggestReplies: boolean;
  busyKey: string;
  onAction: (row: ChatAutoCasebookSnapshotRow, action: PermitAction) => void;
  selected: SelectedSends | null;
  onSelectCase: (caseId: string) => void;
  onReloadReply: (caseId: string) => Promise<ChatAutoCasebookReplyText | null>;
  onSavedReply: () => Promise<void>;
  pendingKind: PendingDisplayKind;
  replyLinkCatalog: ChatAutoCasebookReplyLink[] | undefined;
  onEditorEngagedChange: (caseId: string, engaged: boolean) => void;
  backlogSend: CaseBacklogSendState | null;
  onToggleBacklogSend: (caseId: string) => void;
  onRequestBacklogSend: (caseId: string) => void;
  onCancelBacklogSend: (caseId: string) => void;
  onConfirmBacklogSend: (caseId: string) => void;
  onContinueBacklogSend: (caseId: string) => void;
}) {
  const counter = row.counters.consecutiveHumanUneditedApprovedSent;
  const floor = row.counterFloor;
  const evalFresh = row.eval.status === "passed" && Boolean(row.eval.expiresAtIso);
  // 운영자 저장 답신도 auto_ok 케이스면 정적 답신과 같은 조건으로 검증/자동발송 대상이다. 단 저장 답신의 arm 은
  // 새 revision 이 승인 발송 수(핀 단위)를 채울 수 없으므로 아래 "운영자 예외 승인"(super_admin + 사유)로만 한다.
  const savedReplyArmsViaOverride = row.replyText.source === "operator_override";
  const supportsAutomaticReply = row.replyText.state === "auto_ok";
  const canRequestArm = canManage && supportsAutomaticReply && !savedReplyArmsViaOverride && row.eval.status === "passed" && row.pins.casebookMatchesCurrent && row.pins.modelMatchesCurrent && counter >= floor;
  const permitActionBusy = busyKey.length > 0;
  const isSelected = selected?.caseId === row.caseId;
  const isBacklogExpanded = backlogSend?.caseId === row.caseId;
  return (
    <div className="px-5 py-4" data-testid={`permit-case-${row.caseId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-ink">{row.caseTitle || row.caseId}</h3>
            <Badge tone={stateTone(row)}>{stateLabel(row)}</Badge>
            {attentionBadges(row, pendingKind).map((badge) => (
              <Badge key={badge.label} tone={badge.tone}>{badge.label}</Badge>
            ))}
          </div>
          <p className="mt-1 text-xs text-ink-3">{row.caseDescription}</p>
          <details className="mt-1 text-xs text-ink-3">
            <summary className="cursor-pointer select-none">상세 식별자</summary>
            <code className="mt-1 block break-all">{row.caseId}</code>
          </details>
          <details className="mt-1 text-xs text-ink-3" data-testid={`permit-reply-text-${row.caseId}`}>
            <summary className="cursor-pointer select-none">답신 문구 — {row.replyText.label ?? "답신 상태"}</summary>
            <p className="mt-1 whitespace-pre-line rounded-md border border-line bg-fill px-3 py-2 text-ink-2">
              {row.replyText.text
                ?? (row.replyText.editable || row.replyText.suggestionAllowed
                  ? "아직 저장된 답신이 없습니다. 답신을 작성하거나 AI 제안을 받아보세요."
                  : row.replyText.unavailableReason ?? "이 케이스는 답신을 작성할 수 없습니다.")}
            </p>
          </details>
          <CaseReplyEditor
            caseId={row.caseId}
            replyText={row.replyText}
            canEdit={canEditReplies}
            canSuggest={canSuggestReplies}
            defaultSuggestion={row.defaultSuggestion}
            linkChoices={casebookLinkChoices(row, replyLinkCatalog)}
            onEngagedChange={(engaged) => onEditorEngagedChange(row.caseId, engaged)}
            onReload={onReloadReply}
            onSaved={onSavedReply}
          />
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!canManage || !supportsAutomaticReply || permitActionBusy}
              title={!canManage ? PERMIT_MANAGE_BOUNDARY_LABEL : !supportsAutomaticReply ? "사람 검토용 답신은 자동발송 검증 대상이 아닙니다." : undefined}
              onClick={() => onAction(row, "eval")}
            >
              최신 검증 실행
            </Button>
            {row.armed ? (
              <Button
                type="button"
                size="sm"
                variant="danger"
                disabled={!canManage || permitActionBusy}
                title={canManage ? undefined : PERMIT_MANAGE_BOUNDARY_LABEL}
                onClick={() => onAction(row, "disarm")}
              >
                자동발송 끄기
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={!canRequestArm || permitActionBusy}
                title={!canManage
                  ? PERMIT_MANAGE_BOUNDARY_LABEL
                  : savedReplyArmsViaOverride
                    ? "저장한 답신은 최신 검증 통과 후 아래 '운영자 예외 승인'에서 super_admin이 사유를 남기고 켭니다. 저장한 문구가 그대로 자동발송됩니다."
                    : undefined}
                onClick={() => onAction(row, "arm")}
              >
                자동발송 켜기
              </Button>
            )}
          </div>
          {!canManage ? (
            <span data-testid="permit-role-boundary" className="text-[11px] font-semibold text-ink-3">
              {PERMIT_MANAGE_BOUNDARY_LABEL}
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <Metric
          testId={`case-pending-metric-${row.caseId}`}
          label="대기 중"
          value={rowPendingValue(pendingKind, row.pendingCount)}
          detail={pendingKind === "exact"
            ? "마지막 전체 집계 기준의 미답장"
            : pendingKind === "lower_bound" && row.pendingCount > 0
              ? "집계가 일부만 끝나 실제 건수는 더 많을 수 있습니다"
              : pendingKind === "missing"
                ? "첫 집계가 저장되면 건수를 표시합니다"
                : "전체 집계가 완료되면 건수를 표시합니다"}
          // Only a completed full scan can prove a zero; missing / in-progress / partial counts never
          // look like one (no reassuring green, no "없음").
          tone={pendingKind === "exact" && row.pendingCount === 0 ? "ok" : "warn"}
          badgeLabel={pendingKind === "exact"
            ? row.pendingCount > 0 ? "확인 필요" : "없음"
            : pendingKind === "lower_bound" && row.pendingCount > 0 ? "일부 집계" : pendingKind === "missing" ? "집계 전" : "집계 중"}
        />
        <Metric
          label="승인 발송"
          value={`${counter}/${floor}`}
          detail={`전체 ${row.counters.totalHumanUneditedApprovedSent}건`}
          tone={counter >= floor ? "ok" : "warn"}
          badgeLabel={counter >= floor ? "충족" : "부족"}
        />
        <Metric
          label="기록 상태"
          value={row.counters.unavailableEvidenceCount > 0 ? "확인 필요" : "확인됨"}
          detail={`확인 불가 ${row.counters.unavailableEvidenceCount}건`}
          tone={row.counters.unavailableEvidenceCount > 0 ? "warn" : "ok"}
          badgeLabel={row.counters.unavailableEvidenceCount > 0 ? "확인필요" : "정상"}
        />
        <Metric
          label="최신 검증"
          value={evalLabel(row.eval.status)}
          detail={`${row.eval.estimatedCostUsd.toFixed(4)} USD · ${evalFresh ? `${dateLabel(row.eval.expiresAtIso)}까지` : "새 검증 필요"}`}
          tone={evalTone(row.eval.status)}
          badgeLabel={row.eval.status === "passed" ? "통과" : "확인필요"}
        />
      </div>

      <CaseItemsPanel caseId={row.caseId} count={row.pendingCount} kind={pendingKind} testId={`case-items-${row.caseId}`} />

      <details className="mt-3 text-[11px] text-ink-3">
        <summary className="cursor-pointer select-none font-semibold">평가 상세</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <span>보류 검증 {row.eval.heldoutPassed}/{row.eval.heldoutTotal}</span>
          <span>반복 검증 {row.eval.rerollStable}/{row.eval.rerollTotal}</span>
          <span>검증 경로 {verificationPathLabel(row.eval.transports)}</span>
          <span>마지막 꺼짐 사유 {row.lastDisarmReason ?? "없음"}</span>
          <span>마지막 검증 {dateLabel(row.eval.evaluatedAtIso)}</span>
        </div>
      </details>

      <div className="mt-3" data-testid={`permit-send-history-${row.caseId}`}>
        <button
          type="button"
          onClick={() => onSelectCase(row.caseId)}
          className="text-[11px] font-semibold text-accent underline underline-offset-2"
        >
          {isSelected ? "최근 발송 숨기기" : "최근 발송 보기"}
        </button>
        {isSelected ? (
          <div className="mt-2 space-y-2">
            {selected?.loading ? <div className="text-[11px] text-ink-3">최근 발송 내역을 불러오는 중입니다.</div> : null}
            {selected?.error ? <div className="text-[11px] font-semibold text-danger">{selected.error}</div> : null}
            {!selected?.loading && !selected?.error ? (
              <SendHistoryTable
                title="확정 발송 (최근 20건 · sender=ai · 발송됨 · provider 확인됨만)"
                emptyLabel="확정 발송 기록이 없습니다."
                rows={selected?.sends ?? []}
                columns={["시각", "배달 이상", "대화"]}
                renderRow={(sent) => (
                  <tr key={sent.id} className="border-t border-line">
                    <td className="px-2 py-1.5 text-ink-3">{dateLabel(sent.atIso)}</td>
                    <td className="px-2 py-1.5 text-ink-3">{deliverabilityFlagsLabel(sent)}</td>
                    <td className="px-2 py-1.5">
                      <ConversationLink conversationId={sent.conversationId} />
                    </td>
                  </tr>
                )}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {row.armed ? (
        <div className="mt-3" data-testid={`permit-case-backlog-send-${row.caseId}`}>
          <button
            type="button"
            onClick={() => onToggleBacklogSend(row.caseId)}
            className="text-[11px] font-semibold text-accent underline underline-offset-2"
          >
            {isBacklogExpanded ? "보류 확인 숨기기" : "보류 확인"}
          </button>
          {isBacklogExpanded ? (
            <div className="mt-2 space-y-2">
              {backlogSend?.countLoading ? (
                <div className="text-[11px] text-ink-3">보류 건수를 확인하는 중입니다.</div>
              ) : null}
              {backlogSend?.countError ? (
                <div className="text-[11px] font-semibold text-danger">{backlogSend.countError}</div>
              ) : null}
              {backlogSend && !backlogSend.countLoading && !backlogSend.countError && backlogSend.heldCount !== null ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-fill px-3 py-2">
                  <span className="text-sm font-bold text-ink" data-testid={`case-backlog-held-count-${row.caseId}`}>
                    {/* [codex review round 2 followup, 2026-09-28] "추정" (estimate) — this is a
                       cheap, bounded, receive-time-classification-based count, never authoritative.
                       A 0 does not mean nothing is truly held (see the button's own doc comment
                       below), so the copy says so explicitly instead of implying certainty. */}
                    {backlogSend.heldCount > 0
                      ? `확인된 보류 ${backlogSend.heldCount}건`
                      : "추정 0건 — 보내기를 누르면 다시 확인합니다"}
                  </span>
                  {backlogSend.scannedCapped ? (
                    <span className="text-[11px] text-ink-3">최근 {backlogSend.scanCap}건만 검사했습니다. 전체 건수는 위의 캐시 집계를 확인하세요.</span>
                  ) : null}
                  {canManage ? (
                    <Button
                      type="button"
                      size="sm"
                      // [codex review round 2 followup, 2026-09-28] heldCount is ALWAYS just an
                      // estimate — never authoritative for either "there is nothing to send" or
                      // "there is something to send". sendChatAutoCaseHeldBacklogNow always runs its
                      // own fresh, live scan + JEV judgment regardless of what this label says, so the
                      // button stays enabled for ANY armed case; sendBusy (double-click safety) is the
                      // only real guard.
                      disabled={backlogSend.sendBusy}
                      onClick={() => onRequestBacklogSend(row.caseId)}
                      data-testid={`case-backlog-send-button-${row.caseId}`}
                    >
                      지금 보내기
                    </Button>
                  ) : (
                    <span className="text-[11px] font-semibold text-ink-3">{PERMIT_MANAGE_BOUNDARY_LABEL}</span>
                  )}
                </div>
              ) : null}

              {backlogSend?.confirming ? (
                <div
                  className="rounded-md border border-warn/30 bg-warn-soft p-3 text-sm text-ink-2"
                  data-testid={`case-backlog-send-confirm-${row.caseId}`}
                >
                  <div className="font-semibold text-warn">
                    보류 메일을 다시 판정하고, 발송 조건을 통과한 메일만 보냅니다.
                  </div>
                  <div className="mt-1 text-xs text-ink-3">
                    한 번에 최대 200건을 검사하고, 조건을 통과한 메일만 발송 대기열에 등록합니다. 확인된 보류 건수와 실제 발송 건수는 다를 수 있습니다. 계속할까요?
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => onConfirmBacklogSend(row.caseId)}
                      disabled={backlogSend.sendBusy}
                      data-testid={`case-backlog-send-confirm-button-${row.caseId}`}
                      className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {backlogSend.sendBusy ? "보내는 중" : "확인하고 보내기"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onCancelBacklogSend(row.caseId)}
                      disabled={backlogSend.sendBusy}
                      className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink-2 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      취소
                    </button>
                  </div>
                </div>
              ) : null}

              {backlogSend?.sendError ? (
                <div className="text-[11px] font-semibold text-danger">{backlogSend.sendError}</div>
              ) : null}

              {backlogSend?.result ? (
                <div
                  className="rounded-md border border-line bg-fill px-3 py-2 text-[11px] text-ink-2"
                  data-testid={`case-backlog-send-result-${row.caseId}`}
                >
                  <div>
                    대기열 등록 {backlogSend.result.queued}건 / 건너뜀 {caseBacklogTotalSkipped(backlogSend.result.skipped)}건
                    ({caseBacklogSkippedBreakdownLabel(backlogSend.result.skipped)})
                  </div>
                  <div className="mt-1 text-ink-3">확인한 대화 {backlogSend.result.scanned}건</div>
                  {backlogSend.result.stoppedReason === "deadline" ? (
                    <div className="mt-1 font-semibold text-warn">처리 시간 제한에 도달해 이번 요청에서는 일부만 처리했습니다.</div>
                  ) : null}
                  {backlogSend.result.nextCursor ? (
                    <button
                      type="button"
                      onClick={() => onContinueBacklogSend(row.caseId)}
                      disabled={backlogSend.sendBusy}
                      data-testid={`case-backlog-send-continue-${row.caseId}`}
                      className="mt-2 rounded-md border border-line bg-paper px-3 py-1.5 text-xs font-semibold text-ink-2 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {backlogSend.sendBusy ? "보내는 중" : "계속 보내기"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SendHistoryTable<T extends { id: string }>({
  title,
  emptyLabel,
  rows,
  columns,
  renderRow,
}: {
  title: string;
  emptyLabel: string;
  rows: T[];
  columns: string[];
  renderRow: (row: T) => ReactNode;
}) {
  return (
    <div className="rounded-md border border-line">
      <div className="border-b border-line bg-fill px-2 py-1.5 text-[11px] font-semibold text-ink-2">{title}</div>
      {rows.length === 0 ? (
        <div className="px-2 py-2 text-[11px] text-ink-3">{emptyLabel}</div>
      ) : (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-ink-3">
              {columns.map((column) => (
                <th key={column} className="px-2 py-1.5 font-medium">{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>{rows.map(renderRow)}</tbody>
        </table>
      )}
    </div>
  );
}

function ConversationLink({ conversationId }: { conversationId: string | null }) {
  if (!conversationId) return <span className="text-ink-3">없음</span>;
  return (
    <a
      href={`/chat?conversationId=${encodeURIComponent(conversationId)}`}
      className="font-medium text-accent underline underline-offset-2 hover:opacity-80"
    >
      채팅에서 검토
    </a>
  );
}

function deliverabilityFlagsLabel(row: ChatAutoCaseCommittedSendRow) {
  const flags = [
    row.bounced ? "반송" : null,
    row.complained ? "신고" : null,
    row.optedOut ? "수신거부" : null,
    row.suppressed ? "억제됨" : null,
  ].filter((flag): flag is string => Boolean(flag));
  return flags.length === 0 ? "없음" : flags.join(", ");
}

function Metric({
  testId,
  label,
  value,
  detail,
  tone,
  badgeLabel,
}: {
  testId?: string;
  label: string;
  value: string;
  detail: string;
  tone: Tone;
  badgeLabel: string;
}) {
  return (
    <div className="rounded-md border border-line bg-fill px-3 py-2" data-testid={testId}>
      <div className="text-[11px] font-semibold text-ink-3">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-sm font-bold text-ink">{value}</span>
        <Badge tone={tone}>{badgeLabel}</Badge>
      </div>
      <div className="mt-1 truncate text-[11px] text-ink-3">{detail}</div>
    </div>
  );
}

function rowPendingValue(kind: PendingDisplayKind, count: number): string {
  // A lower bound of 0 says nothing ("0건 이상") — show it as still being counted.
  if (kind === "lower_bound" && count === 0) return pendingCountLabel("computing", count);
  return pendingCountLabel(kind, count);
}

function stateLabel(row: ChatAutoCasebookSnapshotRow) {
  if (row.state === "default_off") return "기본 꺼짐";
  if (row.state === "candidate") return "켜기 가능성 있음";
  if (row.state === "armed") return "켜짐";
  if (row.state === "disarmed") return "꺼짐";
  if (row.state === "stale_pin") return "설정 변경됨";
  if (row.state === "eval_failed") return "검증 필요";
  return row.state;
}

function stateTone(row: ChatAutoCasebookSnapshotRow): Tone {
  if (row.state === "stale_pin" || row.state === "eval_failed") return "danger";
  if (row.armed) return "ok";
  if (row.state === "default_off" || row.state === "candidate") return "neutral";
  return "warn";
}

function evalLabel(status: ChatAutoCasePermitEvalStatus) {
  if (status === "passed") return "통과";
  if (status === "missing") return "없음";
  if (status === "failed") return "실패";
  if (status === "unavailable") return "확인 불가";
  if (status === "expired") return "만료";
  return status;
}

function evalTone(status: ChatAutoCasePermitEvalStatus): Tone {
  if (status === "passed") return "ok";
  if (status === "missing" || status === "unavailable") return "warn";
  return "danger";
}

function reasonListLabel(values: string[]) {
  if (values.length === 0) return "없음";
  return Array.from(new Set(values.map(reasonLabel))).join(", ");
}

function reasonLabel(value: string) {
  if (value === "untrusted_sender") return "처음 보는 발신자";
  if (value === "sender_not_creator") return "크리에이터로 확인되지 않은 발신자";
  if (value === "pin_mismatch") return "설정 변경 확인 필요";
  if (value === "eval_not_passed") return "검증 필요";
  if (value === "mail_safety_blocked") return "메일 안전 확인 필요";
  if (value === "permit_missing") return "자동발송 승인 없음";
  if (value === "permit_case_mismatch") return "케이스 확인 필요";
  if (value === "case_unclassified") return "케이스 분류 필요";
  if (value === "server_render_unavailable") return "서버 작성문 없음";
  if (value === "needs_review") return "사람 검토 필요";
  return value.replaceAll("_", " ");
}

function verificationPathLabel(values: string[]) {
  if (values.length === 0) return "없음";
  const labels = Array.from(new Set(values.map((value) => {
    if (value === "ai_hub_gateway") return "기본 경로";
    if (value === "vertex_direct") return "보조 경로";
    return "확인 경로";
  })));
  return labels.join(", ");
}

function dateLabel(value: string | null | undefined) {
  if (!value) return "없음";
  return value.slice(0, 10);
}
