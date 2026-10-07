"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { chatReadGenerationKey, shouldArmChatRead } from "@/lib/chat-read-arming";
import { tokenizeMailText } from "@/lib/mailTextRender";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Tabs } from "@/components/ui/Tabs";
import { Avatar } from "@/components/ui/Avatar";
import { StageBadge } from "@/components/ui/StageBadge";
import { WorkflowActionMenu } from "@/components/ui/WorkflowActionMenu";
import { UnrepliedInboxPanel, useUnrepliedInboxCount } from "@/components/flu/chat/UnrepliedInboxPanel";
import Link from "next/link";
import { Sparkles, Send, Alert, Search, Refresh, ChevronLeft, ChevronRight } from "@/components/icons";
import { CREATORS, gatewayProxy, getMailSafetyStatus, getMessageSource, listMailAccounts, searchPeoplyDirectory, listConversationMessages, listConversations, markConversationRead, receiveEmail, reclassifyConversationAttribution, revertConversationAttribution, sendEmail, setConversationAutoReply, setUserPreference, updateWorkflowItemState, type Campaign, type Msg, type Conversation, type Creator, type MailSafetyStatusEnvelope, type MessageSourceEnvelope, type PeoplyOrganization, type Program, type WorkflowAction, type WorkflowItemStateEnvelope, type SendEmailPayload } from "@/lib/data";
import { previewEmailDraft, type MailAccountPublic, type MyOrgContextEnvelope, type PreviewEmailDraftEnvelope } from "@/lib/data";
import { requestDataRefresh, useLive, useLiveCampaigns, useLiveCreators, useLivePrograms } from "@/lib/live";
import { useInvalidateOrgContext, useOrgContext } from "@/lib/useNavPreset";
import { subscribeOrgContextInvalidation } from "@/lib/org-context-cache";
import {
  conversationListCacheKey,
  invalidateConversationListCache,
  peekConversationListCache,
  reconcileRevalidatedConversations,
  revalidateConversationListCache,
  shouldSkipConversationListRead,
} from "@/lib/conversation-list-cache";
import { callableDedupeKey, dedupeCallable, type CallableAuthScope } from "@/lib/callable-dedupe";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import { CreatorHover } from "@/components/ui/CreatorHover";
import { FeedbackControl } from "@/components/ui/FeedbackControl";
import { VirtualList } from "@/components/ui/VirtualList";
import { cn } from "@/lib/cn";
import { buildReviewHref } from "@/lib/review-route";
import {
  compactConversationSignal,
  compactPersonSignal,
  conversationParticipationStage,
  conversationMillis,
  conversationProfile,
  dedupeConversationsByThread,
  formatProfileMeta,
  isDefaultChatConversation,
  isPersonScopeConversation,
  latestCreatorMessageSource,
  messageOtherConversationTail,
  normalizeConversations,
  normalizeMessages,
  stringValue,
  type ChatConversation,
} from "@/lib/chat-normalization";
import {
  primaryConversationId,
  workflowContextTagsForConversation,
  workflowConversationKey,
  type WorkflowContextTag,
} from "@/lib/workflow-context";
import { buildChatProgramGroups, chatConversationMatchesSelection, classifyChatPrimaryRoute, selectChatConversationForView, type ChatPrimaryRoute } from "@/lib/chat-programs";
import { resolveCanonicalProgramId } from "@/lib/program-canonical";
import { messageIndexForRoute, parseChatRouteState } from "@/lib/chat-route";
import { groupConversationsByPerson, resolvePersonReplyTarget, type PersonRoom } from "@/lib/chat-people";
import { consumeComposerPrefill } from "@/lib/chatComposerPrefill";
import { acquireBodyScrollLock } from "@/lib/bodyScrollLock";
import { WorkspaceGroupRecipientPicker } from "@/components/chat/WorkspaceGroupRecipientPicker";
// W114-C: 별도 import 문 — 위 줄은 tests/w106-person-tab.test.mjs가 정확한 문자열로 고정해 뒀다.
import { personIdentityKey } from "@/lib/chat-people";
import { canonicalThreadId } from "@/lib/creator-identity";
import { useAuthUser, useRole } from "@/lib/role";
import { useViewAs } from "@/lib/viewAs";
import { isComposerSenderViewMismatched } from "@/lib/chat-composer-sender";
import { chatComposeEffectivePolicyKey, chatComposeScopeKey, chatComposeSenderSelection, isCurrentChatComposeAiDraftRequest, isCurrentChatComposeAsyncRequest, type ChatComposeAiDraftRequest, type ChatComposeAsyncRequest } from "@/lib/chat-compose-scope";
import { defaultMailSender, mailSenderDisplayName, mailSenderPolicyMessage, usableMailSenders } from "@/lib/mail-sender-policy";
import { externalFluHref } from "@/lib/flu-external-link";

function messageEventIso(message?: Pick<Msg, "createdAtIso" | "sentAtIso" | "receivedAtIso" | "mailEventAtIso">): string {
  return message?.mailEventAtIso || message?.sentAtIso || message?.receivedAtIso || message?.createdAtIso || "";
}

function messageEventMillis(message?: Pick<Msg, "createdAtIso" | "sentAtIso" | "receivedAtIso" | "mailEventAtIso">): number {
  const iso = messageEventIso(message);
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatMessageTime(message?: Pick<Msg, "time" | "createdAtIso" | "sentAtIso" | "receivedAtIso" | "mailEventAtIso">): string {
  if (!message) return "";
  const iso = messageEventIso(message);
  if (!iso) return message.time;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return message.time;
  const clock = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const sameDateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  if (sameDateFormatter.format(date) === sameDateFormatter.format(new Date())) return clock;
  const parts = sameDateFormatter.formatToParts(date);
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${month}.${day} ${clock}`;
}

function formatChatSyncTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function recordBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

type MailAccountViewMode = "personal" | "org";

const SUPER_ADMIN_MAILBOX_SELECTION_STORAGE_PREFIX = "flu:chat-super-admin-mailbox:v1:";
const SUPER_ADMIN_ALL_MAILBOXES_SELECTION = "__all_authorized_mailboxes__";
const SUPER_ADMIN_POLICY_MAILBOX_SELECTION = "__policy_mailbox__";

function superAdminMailboxSelectionStorageKey(identityKey: string): string {
  return `${SUPER_ADMIN_MAILBOX_SELECTION_STORAGE_PREFIX}${identityKey}`;
}

function readSuperAdminMailboxSelection(identityKey: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(superAdminMailboxSelectionStorageKey(identityKey))?.trim() ?? "";
  } catch {
    return "";
  }
}

function persistSuperAdminMailboxSelection(identityKey: string, accountId: string): void {
  if (typeof window === "undefined") return;
  try {
    const key = superAdminMailboxSelectionStorageKey(identityKey);
    if (accountId) window.localStorage.setItem(key, accountId);
    else window.localStorage.removeItem(key);
  } catch {
    // Private browsing/quota failures retain the safe in-memory selection for this page only.
  }
}

type AccountScopedConversationState = {
  accountId: string;
  scopeKey: string;
  rows: Conversation[];
  nextCursor: string | null;
  // 리뷰 수리(9de0a32f 후속, conversation-list-cache.ts 의 reconcileRevalidatedConversations 참고):
  //   "이전 대화 더 보기"로 꼬리가 이어붙었는지(extendedByLoadMore)와 첫 페이지 구성 시점의
  //   머리 길이(headLength) — 배경 재검증이 꼬리를 지울지 말지를 상수(100) 대신 이 두 값으로
  //   판정·슬라이스한다.
  extendedByLoadMore: boolean;
  headLength: number;
};

// 계정 보기 목록 응답(rows + 첫 페이지 커서)을 상태 형태로 정규화한다 — 기본 보기와 미등록 포함
//   보기 두 effect, 그리고 conversation-list-cache 에 쓰는 값이 전부 이 형태다. 매번 새로 받은
//   첫 페이지이므로 extendedByLoadMore=false, headLength=이 페이지의 행 수로 시작한다.
function toAccountScopedConversationState(
  result: unknown,
  accountId: string,
  scopeKey: string,
): AccountScopedConversationState {
  const rows = Array.isArray((result as { rows?: unknown }).rows) ? (result as { rows: unknown[] }).rows : [];
  const pageInfo = (result as { pageInfo?: { nextCursor?: unknown } }).pageInfo;
  return {
    accountId,
    scopeKey,
    rows: rows as unknown as Conversation[],
    nextCursor: typeof pageInfo?.nextCursor === "string" ? pageInfo.nextCursor : null,
    extendedByLoadMore: false,
    headLength: rows.length,
  };
}

function emailFromText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.match(EMAIL_PATTERN)?.[0]?.toLowerCase() ?? "";
}

// Flu conversation org-filter round 2 (codex adversarial review): mirrors
// functions/mailConversationAuthorization.ts canonicalScpOrgId — G005 is a legacy scp orgId label
// for T056 (헤세 confirmed 2026-09-27, no data restamp). This client-side org dropdown filter is
// presentational only (the server already scopes rows before they reach the client), but without
// this alias an admin filtering by "T056" would silently drop conversations stamped "G005" and
// vice versa. Keep in lockstep with the server constant if another legacy label ever surfaces.
function canonicalScpOrgId(orgId: string): string {
  const trimmed = orgId.trim();
  return trimmed === "G005" ? "T056" : trimmed;
}

function replyRecipientFor(
  conversation: ChatConversation | undefined,
  creator: Creator | undefined,
  profile: ReturnType<typeof conversationProfile> | undefined,
  messages: readonly Msg[],
): string {
  const latestCreator = [...messages].reverse().find((message) => message.from === "creator");
  const candidates = [
    conversation?.creatorEmail,
    creator?.email,
    conversation?.profileMatchedEmail,
    profile?.email,
    conversation?.creatorName,
    conversation?.creatorHandle,
    profile?.handle,
    latestCreator?.author,
  ];
  for (const candidate of candidates) {
    const direct = typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
    if (direct.includes("@") && EMAIL_PATTERN.test(direct)) return direct.match(EMAIL_PATTERN)?.[0]?.toLowerCase() ?? direct;
    const embedded = emailFromText(candidate);
    if (embedded) return embedded;
  }
  return "";
}

function latestCreatorMessageRef(messages: readonly Msg[], conversation: ChatConversation | undefined): string {
  return latestCreatorMessageSource(messages, conversation).ref;
}

function freshComposeReference(prefix: string): string {
  const entropy = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${entropy}`;
}

// W96: 메일 본문의 마크다운 앵커·raw URL(outreach 토큰 포함 수백 자)을 "라벨 + 클릭 링크"로
//   표시한다. innerHTML 없이 React 노드로만 조립 — 표시 계층 전용, 저장 데이터 불변.
function MailText({ text }: { text: string }) {
  const segments = useMemo(() => tokenizeMailText(text), [text]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "link" ? (
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noreferrer noopener"
            className="break-words font-medium underline decoration-current/40 underline-offset-2 hover:decoration-current"
          >
            {segment.label}
          </a>
        ) : (
          <span key={index}>{segment.value}</span>
        ),
      )}
    </>
  );
}

type ChatComposerFieldsProps = {
  composeKey: string;
  composeRecipient: string;
  onRecipientChange: (value: string) => void;
  composeSubject?: string;
  onSubjectChange?: (value: string) => void;
  showSubject?: boolean;
  selectedSenderId: string;
  onSenderChange: (value: string) => void;
  selectedSender: MailAccountPublic | null;
  usableSenderAccounts: readonly MailAccountPublic[];
  orgContext: MyOrgContextEnvelope | null;
  draft: string;
  onDraftChange: (value: string) => void;
  setDraftBody: (value: string) => void;
  drafting: boolean;
  sending: boolean;
  previewLoading: boolean;
  canComposeSend: boolean;
  composeSendBlockedMessage: string;
  composerSenderMismatched: boolean;
  isViewingAs: boolean;
  allowAiDraft?: boolean;
  onOpenAiDraft: () => void;
  onPreview: () => void;
  onSend: () => void;
};

/**
 * Shared recipient/sender/body controls for an existing reply and a no-thread new-mail draft.
 * The no-thread variant deliberately keeps conversation/source values out of this UI; it only
 * collects a recipient, an authorized sender, a subject, and a body for preview/send actions.
 */
function ChatComposerFields({
  composeKey,
  composeRecipient,
  onRecipientChange,
  composeSubject = "",
  onSubjectChange,
  showSubject = false,
  selectedSenderId,
  onSenderChange,
  selectedSender,
  usableSenderAccounts,
  orgContext,
  draft,
  onDraftChange,
  setDraftBody,
  drafting,
  sending,
  previewLoading,
  canComposeSend,
  composeSendBlockedMessage,
  composerSenderMismatched,
  isViewingAs,
  allowAiDraft = true,
  onOpenAiDraft,
  onPreview,
  onSend,
}: ChatComposerFieldsProps) {
  return (
    <>
      <div className="space-y-2 px-3 pt-2">
        <WorkspaceGroupRecipientPicker
          key={composeKey || "empty-conversation"}
          value={composeRecipient}
          onChange={onRecipientChange}
          disabled={isViewingAs}
        />
        {showSubject && onSubjectChange ? (
          <div className="space-y-1">
            <label className="block text-[11px] font-semibold text-ink-3" htmlFor="chat-mail-subject">제목</label>
            <input
              id="chat-mail-subject"
              type="text"
              value={composeSubject}
              disabled={isViewingAs}
              onChange={(event) => onSubjectChange(event.target.value)}
              placeholder="메일 제목"
              className="h-9 w-full rounded-md border border-line bg-paper px-3 text-xs text-ink outline-none placeholder:text-ink-4 focus:border-ink-4 disabled:cursor-not-allowed disabled:bg-fill"
            />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
          <label className="shrink-0 font-semibold" htmlFor="chat-mail-sender">발신 계정</label>
          <select
            id="chat-mail-sender"
            value={selectedSenderId}
            onChange={(event) => onSenderChange(event.target.value)}
            disabled={!orgContext || Boolean(orgContext.senderBlockedReason) || usableSenderAccounts.length === 0}
            className="h-8 min-w-[190px] max-w-full rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none focus:border-ink-4 disabled:cursor-not-allowed disabled:bg-fill"
            aria-describedby="chat-mail-sender-help"
          >
            <option value="">
              {!orgContext ? "팀 발신 정책 확인 중" : usableSenderAccounts.length === 0 ? "사용 가능한 발신 계정 없음" : "발신 계정 선택"}
            </option>
            {usableSenderAccounts.map((account) => (
              <option key={account.accountId} value={account.accountId}>
                {mailSenderDisplayName(account)} · {account.kind === "workspace_oauth" ? "개인" : "팀 공유"}
              </option>
            ))}
          </select>
          {selectedSender && (
            <span id="chat-mail-sender-help" className="text-ink-4">
              {selectedSender.mailbox} · 서버 허용 발신
            </span>
          )}
          {!selectedSender && orgContext && usableSenderAccounts.length > 0 && !orgContext.senderBlockedReason && (
            <span id="chat-mail-sender-help" className="text-warn">발송 전에 허용된 계정을 선택하세요.</span>
          )}
          {composerSenderMismatched && (
            <span className="font-semibold text-warn">⚠ 현재 메일함 보기와 발신 계정이 다릅니다 — 확인 후 발송하세요</span>
          )}
        </div>
      </div>

      {/* Below md the textarea takes its own full-width row and the controls wrap beneath it. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line p-3 md:flex-nowrap">
        <textarea
          value={draft}
          onChange={(event) => {
            onDraftChange(event.target.value);
            setDraftBody(event.target.value);
          }}
          onKeyDown={(event) => {
            // 멀티라인 편집 우선: Enter=줄바꿈, ⌘/Ctrl+Enter=발송.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void onSend();
            }
          }}
          rows={2}
          placeholder="메시지 입력… (Enter 줄바꿈, ⌘/Ctrl+Enter 발송)"
          className="min-h-9 max-h-40 min-w-0 basis-full resize-y rounded-md border border-line bg-paper px-3 py-2 text-sm leading-relaxed text-ink placeholder:text-ink-3 focus:border-ink-4 focus:outline-none md:basis-auto md:flex-1"
        />
        <Button
          variant="ghost"
          size="md"
          className="shrink-0"
          disabled={drafting || sending || !allowAiDraft}
          onClick={onOpenAiDraft}
          title={allowAiDraft ? "AI 초안 재생성 팝업 열기" : "새 메일에는 답장 초안을 만들 수 없습니다"}
        >
          <Sparkles className="h-[18px] w-[18px] text-ai" />
          초안 재생성
        </Button>
        <Button
          variant="ghost"
          size="md"
          className="shrink-0"
          disabled={!draft.trim() || previewLoading || !canComposeSend || (showSubject && !composeSubject.trim())}
          onClick={onPreview}
          title={canComposeSend ? "메일 미리보기 (발송 전 렌더 확인)" : composeSendBlockedMessage}
        >
          {previewLoading ? "미리보기…" : "메일 미리보기"}
        </Button>
        <Button
          size="md"
          className="shrink-0"
          disabled={!draft.trim() || sending || !canComposeSend || isViewingAs || (showSubject && !composeSubject.trim())}
          onClick={onSend}
          title={
            isViewingAs
              ? "대신 보기 중에는 비활성"
              : !canComposeSend
                ? composeSendBlockedMessage
                : sending
                  ? "메일 발송 중"
                  : "메일 발송"
          }
        >
          <Send className="h-[18px] w-[18px]" />
        </Button>
      </div>
    </>
  );
}

function MailPreviewDialog({
  open,
  data,
  onClose,
}: {
  open: boolean;
  data: PreviewEmailDraftEnvelope | null;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button aria-label="닫기" onClick={onClose} className="absolute inset-0 bg-ink/40 backdrop-blur-[1px]" />
      <div className="relative flex max-h-[85vh] w-full max-w-[560px] flex-col overflow-y-auto rounded-xl bg-paper shadow-pop">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="text-sm font-semibold text-ink">메일 미리보기</span>
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-md text-ink-3 hover:bg-fill hover:text-ink" aria-label="닫기">✕</button>
        </div>
        <div className="space-y-3 px-4 py-3 text-sm">
          {data?.warnings && data.warnings.length > 0 ? (
            <div className="space-y-0.5 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-[12px] text-warn">
              {data.warnings.map((warning, index) => <div key={index}>⚠ {warning}</div>)}
            </div>
          ) : null}
          <div className="text-[11px] text-ink-3">받는사람 {data?.recipientLabel} · 제목 {data?.resolvedSubject || "(제목 없음)"}</div>
          <div className="rounded-md border border-line p-3">
            <div className="mb-1 text-[11px] font-semibold text-ink-2">HTML 렌더</div>
            <div className="text-ink [&_a]:text-accent [&_a]:underline" dangerouslySetInnerHTML={{ __html: data?.html ?? "" }} />
          </div>
          <div className="rounded-md border border-line p-3">
            <div className="mb-1 text-[11px] font-semibold text-ink-2">텍스트</div>
            <pre className="whitespace-pre-wrap break-words text-[12px] text-ink-2">{data?.text ?? ""}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({
  msg,
  mailAccountId,
  targeted = false,
  feedbackScope,
  strandLabel,
  strandSpan,
  onReplyToStrand,
  otherConversationTail,
}: {
  msg: Msg;
  mailAccountId?: string;
  targeted?: boolean;
  feedbackScope: { programId: string; campaignId: string; locale: string } | { globalScope: "global"; locale: string } | null;
  // W106 person-room 통합 타임라인(전체 뷰) 전용 — 갈래 출처 칩(P-1). 단일 갈래 화면에서는
  // 전달되지 않는다(기존 ChatBubble 호출부는 그대로).
  strandLabel?: string;
  strandSpan?: number;
  onReplyToStrand?: () => void;
  /** 2026-10-05: set when this message came from ANOTHER conversation of the same person (threadConversationIds). */
  otherConversationTail?: string | null;
}) {
  // Flu/Task-50 적대 리뷰 P0-2 — 이 컴포넌트는 InboxPage와 별도라 viewAsParams를 prop으로
  // 물려받지 않는다; ViewAsProvider(src/app/layout.tsx)가 앱 전체를 감싸므로 컨텍스트로 직접
  // 읽는다. useNavPreset.ts와 동일하게 role 재검증(super_admin 아니면 무시)은 여기서도 한다.
  const { role: bubbleRole } = useRole();
  const { target: bubbleViewAsTarget, isViewingAs: bubbleViewAsFlagActive } = useViewAs();
  const bubbleIsViewingAs = bubbleRole === "super_admin" && bubbleViewAsFlagActive;
  const bubbleViewAsParams = bubbleIsViewingAs && bubbleViewAsTarget
    ? { viewAsUserId: bubbleViewAsTarget.userId, viewAsEmail: bubbleViewAsTarget.email }
    : {};
  const isCreator = msg.from === "creator";
  const isAi = msg.from === "ai";
  const isHuman = msg.from === "human";
  const hasMessageRef = Boolean(msg.messageRef);
  const isAiSummary = isCreator && hasMessageRef;
  const displayText = stringValue(msg.text).replace(/^(Gemini|AI)\s*요약:\s*/i, "");
  const aiLabel = aiMessageLabel(msg);
  const feedbackTarget = isAiSummary || msg.deliveryState ? "email" : "chat";
  const feedbackArtifactRef = msg.messageRef ?? `conversations/messages/${msg.id}`;
  const [source, setSource] = useState<MessageSourceEnvelope | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const sourceDirectionLabel = source?.direction === "inbound"
    ? "수신"
    : source?.direction === "outbound"
      ? "발신"
      : "";
  const sourceTimeLabel = source?.found
    ? formatMessageTime({
      time: "",
      createdAtIso: source.createdAtIso,
      sentAtIso: source.sentAtIso,
      receivedAtIso: source.receivedAtIso,
      mailEventAtIso: source.mailEventAtIso,
    })
    : "";

  async function loadMessageSource() {
    if (!msg.messageRef || source || sourceLoading || sourceError) return;
    setSourceLoading(true);
    try {
      const result = await getMessageSource({
        messageRef: msg.messageRef,
        ...(mailAccountId ? { mailAccountId } : {}),
        ...bubbleViewAsParams,
      });
      setSource(result);
    } catch (error) {
      setSourceError(mailPermissionErrorText(error));
    } finally {
      setSourceLoading(false);
    }
  }

  return (
    <div
      aria-current={targeted ? "true" : undefined}
      data-target-message={targeted ? "true" : undefined}
      className={cn(
        "group flex flex-col rounded-lg transition-[background-color,box-shadow]",
        isCreator ? "items-start" : "items-end",
        targeted && "bg-accent-soft/60 p-2 ring-2 ring-accent/35",
      )}
    >
      {aiLabel && (
        <span className="mb-1 inline-flex items-center gap-1 px-1 text-[11px] font-bold text-ai">
          <Sparkles className="h-3 w-3" />
          {aiLabel} · {msg.author}
          {strandLabel && <span className="font-medium text-ink-4">· {strandLabel}</span>}
          {strandSpan && strandSpan > 1 ? (
            <span className="inline-flex items-center rounded-full bg-warn-soft px-1.5 py-0.5 text-[10px] font-bold text-warn">
              +{strandSpan - 1} 갈래
            </span>
          ) : null}
        </span>
      )}
      {isCreator && !isAiSummary && (
        <span className="mb-1 inline-flex items-center gap-1 px-1 text-[11px] font-medium text-ink-3">
          {msg.author}
          {strandLabel && <span className="text-ink-4">· {strandLabel}</span>}
          {strandSpan && strandSpan > 1 ? (
            <span className="inline-flex items-center rounded-full bg-warn-soft px-1.5 py-0.5 text-[10px] font-bold text-warn">
              +{strandSpan - 1} 갈래
            </span>
          ) : null}
        </span>
      )}
      {/* W106: ai/creator 메타 라인이 없는(human) 버블도 병합 뷰에서는 출처를 밝혀야 한다. */}
      {!aiLabel && !(isCreator && !isAiSummary) && strandLabel && (
        <span className="mb-1 inline-flex items-center gap-1 px-1 text-[11px] font-medium text-ink-4">
          {strandLabel}
          {strandSpan && strandSpan > 1 ? (
            <span className="inline-flex items-center rounded-full bg-warn-soft px-1.5 py-0.5 text-[10px] font-bold text-warn">
              +{strandSpan - 1} 갈래
            </span>
          ) : null}
        </span>
      )}
      {otherConversationTail || (isCreator && msg.textSource === "summary") ? (
        <span className="mb-1 inline-flex flex-wrap items-center gap-1 px-1">
          {otherConversationTail ? (
            <span
              data-testid="message-other-conversation"
              title={`같은 사람의 다른 대화(…${otherConversationTail})에서 합쳐 보여주는 메시지예요.`}
              className="inline-flex items-center rounded-full bg-fill px-1.5 py-0.5 text-[10px] font-semibold text-ink-3"
            >
              다른 대화 …{otherConversationTail}
            </span>
          ) : null}
          {isCreator && msg.textSource === "summary" ? (
            <span
              data-testid="message-summary-badge"
              title="원문이 아니라 저장된 요약을 보여주고 있어요. 원문은 원문 보기에서 확인하세요."
              className="inline-flex items-center rounded-full bg-warn-soft px-1.5 py-0.5 text-[10px] font-semibold text-warn"
            >
              요약본
            </span>
          ) : null}
        </span>
      ) : null}
      <div className="group/email relative max-w-[68%]" onMouseEnter={loadMessageSource}>
        <div
          className={cn(
            "rounded-[16px] px-4 py-2.5 text-sm leading-relaxed",
            isCreator && "bg-fill text-ink",
            isHuman && "bg-accent text-white",
            isAi && "bg-ai-soft text-ink ring-1 ring-ai/15",
          )}
        >
          <MailText text={displayText} />
        </div>
        {hasMessageRef && (
          <div
            className={cn(
              "pointer-events-none absolute top-full z-30 mt-2 w-[28rem] max-w-[82vw] rounded-lg border border-line bg-paper p-3 opacity-0 shadow-pop transition-opacity duration-150 group-hover/email:pointer-events-auto group-hover/email:opacity-100",
              isCreator ? "left-0" : "right-0",
            )}
          >
            <div className="flex items-center gap-2 text-[11px] font-semibold text-ink-3">
              <span>메일 원문</span>
              {sourceDirectionLabel && (
                <span className="rounded-full bg-fill px-1.5 py-0.5 text-[10px] font-medium text-ink-3">
                  {sourceDirectionLabel}
                </span>
              )}
            </div>
            {sourceLoading && (
              <div className="mt-2 text-[12px] leading-relaxed text-ink-3">전문을 불러오는 중입니다.</div>
            )}
            {!sourceLoading && sourceError && (
              <div className="mt-2 rounded-md border border-danger/30 bg-danger-soft px-2.5 py-2 text-[12px] leading-relaxed text-danger">
                {sourceError}
              </div>
            )}
            {!sourceLoading && source && !source.found && (
              <div className="mt-2 text-[12px] leading-relaxed text-ink-3">보관된 전문을 찾지 못했습니다.</div>
            )}
            {!sourceLoading && source?.found && source.reason === "scope" && (
              <div className="mt-2 rounded-md border border-warn/30 bg-warn-soft px-2.5 py-2 text-[12px] leading-relaxed text-warn">
                이 원문을 볼 권한이 없습니다.
              </div>
            )}
            {!sourceLoading && source?.found && source.reason !== "scope" && (
              <>
                <div className="mt-2 space-y-1 text-[12px] leading-relaxed text-ink-2">
                  {source.subject && <div className="font-semibold text-ink">{source.subject}</div>}
                  <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                    {source.from && <span>From {source.from}</span>}
                    {source.to && <span>To {source.to}</span>}
                    {sourceTimeLabel && <span>{sourceDirectionLabel || "메일"} {sourceTimeLabel}</span>}
                  </div>
                </div>
                <pre className="scroll-quiet mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-fill px-2.5 py-2 text-[12px] leading-relaxed text-ink [&_a]:text-accent">
                  {source.body
                    ? <MailText text={source.body} />
                    : source.bodyPreview
                      ? <MailText text={source.bodyPreview} />
                      : "본문 원문이 서버에 보존되지 않았습니다 — 제목과 발신 시각만 편입됩니다."}
                </pre>
                {/* W116: 보낸편지함 편입 원장은 전문을 담지 않는다. 빈 상자로 침묵하지 말고 무엇이
                    보존됐는지 밝힌다 — 화면이 "불러오기 실패"로 오독되지 않아야 한다. */}
                {!source.body && source.bodyPreview && (
                  <div className="mt-1 text-[11px] leading-relaxed text-ink-4">
                    프리뷰만 보존됨(240자) · 전문은 서버 원장에 없습니다
                  </div>
                )}
              </>
            )}
            <div className="mt-2 text-[10px] leading-relaxed text-ink-4">
              {source?.found && !source.body ? "서버 보관 원장" : "서버 보관 원문"}
            </div>
          </div>
        )}
      </div>
      <span
        className={cn(
          "mt-1 px-1 text-[11px] text-ink-3",
          isCreator ? "text-left" : "text-right",
        )}
      >
        {hasMessageRef && <span className="mr-1.5 text-[10px] text-ink-4">메일 원문</span>}
        {formatMessageTime(msg)}
        {isCreator && onReplyToStrand && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onReplyToStrand();
            }}
            className="ml-1.5 inline-flex items-center rounded-full border border-accent/30 bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent opacity-0 transition-opacity group-hover:opacity-100"
          >
            이 갈래로 답장
          </button>
        )}
      </span>
      {(isAi || isAiSummary) && feedbackScope && (
        <FeedbackControl
          target={feedbackTarget}
          pipelineDomain={feedbackTarget === "email" ? "mail" : "chat"}
          artifactRef={feedbackArtifactRef}
          excerpt={displayText}
          {...feedbackScope}
        />
      )}
    </div>
  );
}

function WorkflowContextTags({ tags, compact = false }: { tags: readonly WorkflowContextTag[]; compact?: boolean }) {
  if (tags.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {tags.slice(0, compact ? 2 : 4).map((tag) => (
        <span
          key={tag.key}
          className={cn(
            "inline-flex max-w-full items-center truncate rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none",
            tag.kind === "program" && "border-ai/20 bg-ai-soft text-ai",
            tag.kind === "campaign" && "border-accent/20 bg-accent-soft text-accent",
            tag.kind === "mail" && "border-warn/20 bg-warn-soft text-warn",
            tag.kind === "direct" && "border-line bg-fill text-ink-3",
          )}
          title={tag.label}
        >
          {tag.label}
        </span>
      ))}
    </span>
  );
}

function aiMessageLabel(msg: Msg): string {
  if (msg.from === "creator" && msg.messageRef) return "실제 수신 · AI 요약";
  if (msg.from !== "ai") return "";
  if (msg.deliveryState === "sent") return "발송 완료";
  if (msg.deliveryState === "mock_sent") return "Dry run";
  return "AI 초안";
}

function formatCountdown(targetIso?: string, nowMs = Date.now()): string {
  if (!targetIso) return "예약 없음";
  const targetMs = Date.parse(targetIso);
  if (!Number.isFinite(targetMs)) return "시간 확인 필요";
  const remaining = Math.max(0, targetMs - nowMs);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  const hours = Math.floor(minutes / 60);
  const minutePart = minutes % 60;
  if (hours > 0) return `${hours}시간 ${minutePart}분 ${seconds}초`;
  return `${minutePart}분 ${seconds}초`;
}

function ScheduledAutoReplyPanel({
  conversation,
  onRequestHuman,
  loading,
  isViewingAs,
}: {
  conversation: ChatConversation;
  onRequestHuman: () => void;
  loading: boolean;
  isViewingAs: boolean;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const sendAt = stringValue(conversation.nextAutoReplyAtIso);
  const draftText = stringValue(conversation.autoReplyDraftText);
  const isDraftOnly = conversation.autoReplyStatus === "draft_only";
  const hasScheduledDraft = conversation.autoReplyStatus === "scheduled" && Boolean(sendAt || draftText);
  // F-2(b) 적대 리뷰 MED-3: 72h 만료로 종결된 예약을 채팅 화면에서도 보여준다 — 안 그러면
  // 관리자는 여전히 "scheduled" 라벨을 기대하고 회신이 나가길 기다리게 된다.
  const isExpiredStale = conversation.autoReplyStatus === "expired_stale";
  const shouldShow = hasScheduledDraft || (isDraftOnly && Boolean(draftText)) || isExpiredStale;

  useEffect(() => {
    if (!hasScheduledDraft) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasScheduledDraft]);

  if (!shouldShow) return null;

  if (isDraftOnly) {
    return (
      <div className="border-b border-line bg-paper px-6 py-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1 rounded-md border border-warn/20 bg-warn-soft px-3 py-2">
            <div className="mb-1 inline-flex items-center gap-1.5">
              <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-bold text-warn">초안(미발송)</span>
            </div>
            <pre className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-ink [&_a]:text-accent">
              {draftText ? <MailText text={draftText} /> : "초안 전문을 불러오지 못했습니다."}
            </pre>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={onRequestHuman}
            disabled={loading || isViewingAs}
            title={isViewingAs ? "대신 보기 중에는 비활성" : undefined}
          >
            {loading ? "전환 중" : "사람이 회신"}
          </Button>
        </div>
      </div>
    );
  }

  if (isExpiredStale) {
    return (
      <div className="border-b border-line bg-paper px-6 py-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1 rounded-md border border-warn/20 bg-warn-soft px-3 py-2">
            <p className="text-xs leading-relaxed text-ink">
              자동응답 예약이 72시간을 넘겨 만료됐습니다 — 수동 답장이 필요합니다.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-line bg-paper px-6 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[180px] shrink-0 rounded-md border border-ai/20 bg-ai-soft px-3 py-2">
          <div className="text-[11px] font-bold text-ai">예약된 AI 회신</div>
          <div className="mt-1 text-lg font-black leading-none text-ink">{formatCountdown(sendAt, nowMs)}</div>
          <div className="mt-1 text-[11px] font-medium text-ink-3">{formatMessageTime({ time: "", createdAtIso: sendAt })} 발송 예정</div>
        </div>
        <div className="min-w-0 flex-1 rounded-md border border-line bg-fill px-3 py-2">
          <div className="text-[11px] font-bold text-ink-3">실제 발송 예정 초안</div>
          <pre className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-ink [&_a]:text-accent">
            {draftText ? <MailText text={draftText} /> : "초안 전문을 불러오지 못했습니다."}
          </pre>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={onRequestHuman}
          disabled={loading || isViewingAs}
          title={isViewingAs ? "대신 보기 중에는 비활성" : undefined}
        >
          {loading ? "전환 중" : "사람이 회신"}
        </Button>
      </div>
    </div>
  );
}

// W111 (헤세): "전체" 탭의 내용을 사람 뷰로 갈아끼운다 — 워딩은 "전체"로 유지한다.
//   종전의 평면 대화 목록(key "all")은 사람 단위 방과 같은 것을 두 번 보여주는 셈이었고,
//   헤세 지시는 "전체를 대신해서 사람 탭 내용으로, 워딩은 전체 유지"다. 그래서 탭 하나로 합친다.
//   내부 키는 "person" 그대로 둔다 — 사람 방 배선 17곳이 이 키로 갈라지므로 키를 바꾸면 파급만 커진다.
//   평면 목록이 필요한 축(프로그램·Direct·안읽음)은 그대로 남아 있다.
const LIST_TABS = [
  { key: "person", label: "전체" },
  { key: "campaign", label: "프로그램" },
  { key: "direct", label: "Direct" },
  { key: "unread", label: "안읽음" },
];

// W106 Phase 2 (plans/flu-chat-person-rooms-metaprompt.md §4 L1/L2): "사람" 탭 전용.
// 안정적인 빈 배열 참조 — tab !== "person" 렌더마다 새 배열을 만들지 않는다.
const EMPTY_PERSON_ROOMS: readonly PersonRoom[] = [];

// W109: "사람" 탭 전용 대화 스코프의 안정적인 빈 배열 참조(tab !== "person" 일 때).
const EMPTY_CONVERSATIONS: readonly ChatConversation[] = [];

// W111 은 반응 온 사람 전원의 갈래 메시지를 배경 프리로드했다(PERSON_PREFETCH_CONCURRENCY=4).
// 그 판단의 전제는 "260명 / 갈래 559개"였는데, 프로드 실측(2026-08-22)에서는 /chat 1회 로드가
// listConversationMessages **82회** / 페이지 전체 ~98콜러블 · 20.7MB 로 커졌다 — 프리로드 범위가
// 목록에 보이는 방 전체라 사람 수가 늘수록 그대로 비례한다. COST-P0-006/011 대응으로 프리로드를
// 걷어내고 **열린 방만** 로드한다(아래 두 effect). 캐시(threadMessagesById/loadedMessageKeys)는
// 그대로라 한 번 연 방은 다시 열어도 네트워크를 타지 않는다. 대가는 사람을 처음 누를 때의 왕복
// 1회이고, 그 대신 열지도 않은 방 수십 개의 메시지를 매 로드마다 당기지 않는다.

// COST-P0-006 대응: "열린 대화" effect 와 "열린 사람 방" effect 는 선택된 갈래에 대해 같은
// 페이로드로 동시에 요청할 수 있다(전자에는 중복 가드가 없다). 진행 중인 동일 호출은 한 번으로
// 합친다 — 완료된 응답은 캐싱하지 않으므로 신선도 계약은 그대로다(src/lib/callable-dedupe.ts).
// `scope` 필수: 콜러블 페이로드에는 사용자 신원이 없으므로, 인증 스코프가 키에 없으면 계정 전환
// 직후 이전 사용자의 진행 중 응답에 합류할 수 있다(H3 — 구조적으로 불가능하게 만든다).
function loadConversationMessagesDeduped(
  payload: Parameters<typeof listConversationMessages>[0],
  scope: CallableAuthScope,
) {
  return dedupeCallable(
    callableDedupeKey("listConversationMessages", payload, scope),
    () => listConversationMessages(payload),
  );
}

// 갈래(strand)에 이미 지연 로딩된 전체 메시지(threadMessagesById)가 있으면 그걸로 교체한다.
// conv.messages 는 목록 투영용 미리보기라 병합 타임라인엔 부족하다(§2-D). 신규 쿼리는 없다 —
// 이미 채워진 로컬 state 를 읽기만 한다.
function withLoadedMessages(conversation: ChatConversation, loaded: Record<string, Msg[]>): ChatConversation {
  const key = conversation.uiThreadKey ?? workflowConversationKey(conversation);
  const messages = loaded[key];
  return messages && messages.length > 0 ? { ...conversation, messages: normalizeMessages(messages, key) } : conversation;
}

type ReceiveEmailResult = {
  ok?: boolean;
  source?: string;
  queueState?: string;
  trackingId?: string;
  messageRef?: string;
  conversationRef?: string;
  persisted?: boolean;
  fromMasked?: string;
  subject?: string;
  summaryKr?: string;
};

type SendEmailResult = {
  ok?: boolean;
  source?: string;
  trackingId?: string;
  messageRef?: string;
  conversationId?: string;
  conversationRef?: string;
  deliveryState?: string;
  providerMessageIdHash?: string;
  providerConfirmed?: boolean;
  persisted?: boolean;
  mailSafety?: {
    reason?: string;
    ruleId?: string;
    suppressionWarning?: { ruleId?: string; reason?: string; suppressionRef?: string };
  };
};

type GatewayDraftResult = {
  ok?: boolean;
  summaryKr?: string;
  draftKr?: string;
  draftText?: string | null;
  draftPreview?: string | null;
  draftRef?: string;
  trackingId?: string;
  humanGate?: { decision?: string; reason?: string; ruleIds?: string[] };
  resolvedFromCache?: boolean;
};

type DraftActionState = {
  key: string;
  status: "idle" | "loading" | "done" | "error";
  outcome?: "preview_ready" | "composer_ready" | "human_review" | "blocked";
  draftText?: string;
  humanDraftSuggestion?: string;
  humanDraftSuggestionKr?: string;
  blockedReason?: string;
  error?: string;
};

type ReadActionState = {
  key: string;
  status: "idle" | "loading" | "done" | "error";
  message?: string;
};

const IDLE_DRAFT_ACTION: DraftActionState = { key: "", status: "idle" };
const IDLE_READ_ACTION: ReadActionState = { key: "", status: "idle" };

const MVP_CONVERSATION_ID = "v-hesse";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const RECEIVE_IMAP_CONFIGURATION_ERROR_MESSAGE =
  "수신함 연동 설정이 아직 완료되지 않았습니다. 관리자 설정에서 수신함 연동 상태를 확인하세요.";

const RECEIVE_IMAP_CONFIGURATION_ERROR_PATTERNS = [
  /IMAP host is not configured/i,
  /IMAP username is not configured/i,
  /IMAP secret is not configured/i,
  /Functions environment\/Secret Manager/i,
  /receiveEmail live IMAP unavailable/i,
];

function chatReceiveErrorText(error: unknown): string {
  const text = errorText(error);
  return RECEIVE_IMAP_CONFIGURATION_ERROR_PATTERNS.some((pattern) => pattern.test(text))
    ? RECEIVE_IMAP_CONFIGURATION_ERROR_MESSAGE
    : text;
}

function mailPermissionErrorText(error: unknown): string {
  const text = errorText(error);
  // sendEmail 사전 접근 검사 거부는 서버가 안정 errorCode 만 details 로 내려준다(민감 정보 없음) — 일반 "Manager 이상" 대신 정확한 안내.
  const detailCode = (error as { details?: { errorCode?: unknown } } | null)?.details?.errorCode;
  if (detailCode === "send_email_conversation_not_accessible") {
    return "이 대화에 접근할 수 없어 발송할 수 없습니다. 담당 메일 계정의 대화인지 확인한 뒤 새로고침해 다시 시도하세요.";
  }
  if (detailCode === "send_email_reply_source_not_accessible") {
    return "답장 대상 메일을 찾을 수 없거나 접근할 수 없어 발송할 수 없습니다. 대화를 새로고침한 뒤 다시 시도하세요.";
  }
  if (/permission-denied|You do not have permission|requires manager\/admin approval role|role blocked/i.test(text)) {
    // W139: 원문 조회 권한은 더 이상 담당 계정·프로그램 범위로 좁혀지지 않는다 — 대화 목록과
    // 같은 조건(Viewer 이상 role + 대화 존재)이면 org-wide 로 열람 가능하다(functions/read.ts
    // getMessageSource).
    return "메일 권한이 없습니다. 발송은 Manager 이상, 원문 조회는 Viewer 이상 역할에서 가능합니다.";
  }
  return text;
}

// R5-E: autoReplyBlockedReason은 mail-safety.infly-overlap suppression 사유("already exists in
// Infly DB; skip cold outreach", import-infly-suppressions.mjs)일 때도 다른 게이트 차단 사유와
// 동일한 "AI 자동 초안 미생성" 배너로 뭉뚱그려져, 운영자가 "콜드는 원래 억제되는 정상 상태"인지
// "버그로 초안이 안 생겼는지" 구분할 수 없었다. 정책(suppression 로직)은 그대로 두고, 이미 서버가
// 내려주는 사유 텍스트만으로 클라에서 표시를 구분한다(ruleId는 conv 문서에 별도 저장되지 않음).
function isInflyOverlapBlockedReason(reason: string | undefined): boolean {
  return /infly/i.test(reason ?? "");
}

// W32-B: 임계값(mailHumanGate.ts:317)은 그대로 두고 표시 문구만 사람이 읽게 바꾼다.
function isLowEvidenceBlockedReason(reason: string | undefined): boolean {
  return /admin review threshold/i.test(reason ?? "");
}

function chatPrimaryRouteReviewLabel(route: ChatPrimaryRoute): string {
  if (route.reasonId === "campaign_unresolved") return "캠페인 프로그램을 확인해야 합니다.";
  if (route.reasonId === "unassigned_ai_active") return "AI 활성 대화지만 프로그램 귀속이 없습니다.";
  if (route.reasonId === "routing_status_ambiguous") return "귀속 상태가 불명확합니다.";
  return "프로그램 귀속을 확인해야 합니다.";
}

/**
 * 대화 목록 검색 술어 — `visible`(갈래 단위 필터)과 `flatPersonRows`(사람 단위 필터)가
 * **같은 필드 목록**으로 매치를 판정하게 하나로 뺐다. 두 곳이 각자 필드 목록을 들고 있으면
 * 한쪽만 고쳐졌을 때 "검색 결과 갈래 수"와 "검색 결과 사람 수"가 갈린다(W114-E 근인과 같은
 * 종류의 사고).
 */
function conversationMatchesListQuery(
  conversation: ChatConversation,
  creators: readonly Creator[],
  query: string,
): boolean {
  const profile = conversationProfile(conversation, creators);
  return [
    profile.name,
    profile.handle,
    profile.email,
    profile.meta,
    conversation.lastMessage,
    conversation.programTitle,
    conversation.campaignTitle,
  ].some((field) => typeof field === "string" && field.toLowerCase().includes(query));
}

/**
 * [리뷰어 A HIGH (c), 구조적 마감] flat 탭(사람 탭 아님) conv 해소 결과에 **왼쪽 목록 멤버십
 * 게이트**를 건다 — flatPersonRows(왼쪽 목록이 실제로 그리는, 탭+검색 다 반영된 방 목록)에
 * 없는 대화는 오른쪽 패널에도 안 그린다.
 *
 * 왜 필요한가: selectChatConversationForView 의 폴백(후보 풀에서 못 찾으면 풀[0], 풀도 비면
 * 전체 conversations 에서 재탐색)은 상황에 따라 **왼쪽에 안 보이는 대화**를 돌려줄 수 있다
 * (검색 활성 중 탭 전환으로 다른 탭의 selectedId 가 새 탭 스코프에 남는 경우가 실제로 재현된
 * 사례다). 후보 풀을 아무리 정교하게 골라도 "다음 폴백 경로"가 또 문을 열 수 있으므로,
 * 해소 로직이 아니라 **렌더 직전**에 왼쪽 목록과 같은 기준으로 한 번 더 걸러 이 결함 계열
 * 전체(클릭이든 탭 전환이든, 지금 안 것이든 앞으로 생길 것이든)를 구조적으로 닫는다.
 *
 * 사람 탭은 이 게이트가 필요 없다 — 그 분기는 이미 requireExactSelection:true 로 호출돼
 * personRoomStrands 밖으로 못 새는 계약이 있다(위 conv 정의 옆 주석 참고).
 */
function gateFlatTabConversation(
  resolved: ChatConversation | undefined,
  flatPersonRows: readonly PersonRoom[],
  flatListAbsent: boolean,
): ChatConversation | undefined {
  if (!resolved) return undefined;
  // flatPersonRows 가 빈 배열인 이유는 둘이다. (1) 프로그램 탭을 드릴다운하지 않은 상태처럼
  // 애초에 평평한 목록 자체가 없는 하위 상태(flatListAbsent: 검색 전 방 목록도 0건) — 이때 게이트가
  // 항상 거부하면 conv 가 undefined 로 무너져 아래 `if (!conv)` 조기 return 이 좌측 aside 전체를
  // 플레이스홀더로 갈아치운다(대화가 0건이 아닌데 화면이 사라짐). 검증할 대상이 없으니 통과시킨다.
  // (2) 목록은 있는데 검색어가 전부 걸러낸 경우 — 이때는 통과시키면 안 된다. 3단 폴백이 전체
  // conversations 에서 stale selectedId 를 찾아 돌려주면 바로 이 게이트가 막으려던 "왼쪽에 없는
  // 대화가 오른쪽에 뜨는" 누출이 재현된다(적대 리뷰 HIGH). 검색 0건은 fail-closed 로 둔다.
  if (flatPersonRows.length === 0) return flatListAbsent ? resolved : undefined;
  const resolvedKey = resolved.uiThreadKey ?? workflowConversationKey(resolved);
  const inVisibleList = flatPersonRows.some((room) =>
    room.strands.some((strand) => (strand.uiThreadKey ?? workflowConversationKey(strand)) === resolvedKey));
  return inVisibleList ? resolved : undefined;
}

export default function InboxPage() {
  const { role: currentRole } = useRole();
  const authUser = useAuthUser();
  const searchParams = useSearchParams();
  const chatRouteState = parseChatRouteState(searchParams);
  // Sidebar's "새 메시지" action explicitly enters a no-thread compose. Keep this mode
  // independent from conversation selection so a stale selectedId can never open another thread.
  const isNewCompose = searchParams.get("compose") === "new";
  const requestedConversationId = chatRouteState.conversationId;
  const requestedMessageRef = chatRouteState.messageRef;
  // Conversation rows are loaded through the explicit mailbox scope below. The legacy bulk
  // conversations feed is intentionally not used here because it can include another account's
  // rows while the mailbox context is pending or unavailable.
  // PLAN-ORG-MAIL-IDENTITY Slice 5 — org chip + admin-only org filter. Server-side scoping
  // (functions/read.ts resolveConversationOrgScope) already restricts what manager/viewer ever
  // receive here; this is a client-side filter over the already-loaded page for admin's
  // convenience (same 2000-row page bound either way — see functions/read.ts comment).
  const isAdminRole = currentRole === "super_admin" || currentRole === "admin";
  // Flu/Task-50: shared/memoized (src/lib/useNavPreset.ts) instead of a local one-off fetch —
  // transparently reflects an active super_admin "대신 보기" target, same as Sidebar/FluTabGate.
  const orgContext = useOrgContext();
  const invalidateOrgContext = useInvalidateOrgContext();
  // Flu/Task-50 적대 리뷰 P0-2/P1 — role 재검증은 src/lib/useNavPreset.ts와 동일 패턴(role이
  // super_admin이 아니면 대상이 있어도 무시). viewAsParams는 그 검증된 쌍만 listConversations류
  // 호출에 얹는다 — 서버(functions/read.ts effectiveConversationAuth)가 다시 검증한다.
  const { target: viewAsTarget, isViewingAs: viewAsFlagActive } = useViewAs();
  const isViewingAs = currentRole === "super_admin" && viewAsFlagActive;
  // An actual super_admin may inspect any server-returned active mailbox. This is deliberately
  // a read-scope selector only: ViewAs keeps the subject's ordinary policy projection and never
  // receives the operator inventory.
  const canSelectSuperAdminMailbox = currentRole === "super_admin" && !isViewingAs;
  const superAdminMailboxSelectionIdentityKey = [
    authUser?.tenantId ?? "",
    authUser?.uid ?? "anonymous",
  ].join("|");
  const [superAdminMailboxAccounts, setSuperAdminMailboxAccounts] = useState<MailAccountPublic[]>([]);
  const [selectedSuperAdminMailboxId, setSelectedSuperAdminMailboxId] = useState("");
  const [superAdminMailboxProjectionOwnerKey, setSuperAdminMailboxProjectionOwnerKey] = useState("");
  // useEffect 의존 배열에 안전하게 넣을 수 있도록(참조가 아니라 값으로 비교되게) userId/email
  // 원시값에만 의존해 메모한다 — 매 렌더 새 객체 리터럴이면 아래 effect들이 매번 재실행된다.
  const viewAsUserIdForScope = isViewingAs ? viewAsTarget?.userId ?? "" : "";
  const viewAsEmailForScope = isViewingAs ? viewAsTarget?.email ?? "" : "";
  const viewAsParams = useMemo(
    () => (viewAsUserIdForScope && viewAsEmailForScope
      ? { viewAsUserId: viewAsUserIdForScope, viewAsEmail: viewAsEmailForScope }
      : {}),
    [viewAsUserIdForScope, viewAsEmailForScope],
  );
  useEffect(() => {
    let cancelled = false;
    if (!canSelectSuperAdminMailbox) {
      setSuperAdminMailboxAccounts([]);
      setSelectedSuperAdminMailboxId("");
      setSuperAdminMailboxProjectionOwnerKey("");
      return () => { cancelled = true; };
    }
    // A prior identity's inventory must not survive while this identity's read is pending.
    // The owner key also guards the render before this effect commits its clearing updates.
    setSuperAdminMailboxAccounts([]);
    setSelectedSuperAdminMailboxId(SUPER_ADMIN_ALL_MAILBOXES_SELECTION);
    setSuperAdminMailboxProjectionOwnerKey(superAdminMailboxSelectionIdentityKey);
    void listMailAccounts({})
      .then((result) => {
        if (cancelled) return;
        const activeAccounts = Array.isArray(result.accounts)
          ? result.accounts.filter((account) => account.status === "active")
          : [];
        setSuperAdminMailboxAccounts(activeAccounts);
        const persisted = readSuperAdminMailboxSelection(superAdminMailboxSelectionIdentityKey);
        const next = persisted === SUPER_ADMIN_POLICY_MAILBOX_SELECTION
          || activeAccounts.some((account) => account.accountId === persisted)
          ? persisted
          : SUPER_ADMIN_ALL_MAILBOXES_SELECTION;
        if (next !== persisted) persistSuperAdminMailboxSelection(superAdminMailboxSelectionIdentityKey, next);
        setSelectedSuperAdminMailboxId(next);
      })
      .catch(() => {
        if (!cancelled) {
          setSuperAdminMailboxAccounts([]);
          setSelectedSuperAdminMailboxId(SUPER_ADMIN_ALL_MAILBOXES_SELECTION);
          setSuperAdminMailboxProjectionOwnerKey(superAdminMailboxSelectionIdentityKey);
        }
      });
    return () => { cancelled = true; };
  }, [canSelectSuperAdminMailbox, superAdminMailboxSelectionIdentityKey]);
  const [chatOrgFilter, setChatOrgFilter] = useState("");
  const [orgFilterOptions, setOrgFilterOptions] = useState<{ orgId: string; name: string }[]>([]);
  useEffect(() => {
    if (!isAdminRole) return;
    let cancelled = false;
    void (async () => {
      try {
        const [accountsResponse, orgsResponse] = await Promise.all([
          listMailAccounts({}),
          searchPeoplyDirectory({ kind: "orgs", q: "" }),
        ]);
        if (cancelled) return;
        const nameById = new Map<string, string>();
        if (orgsResponse.ok && orgsResponse.snapshot) {
          for (const item of orgsResponse.snapshot.items as PeoplyOrganization[]) nameById.set(item.id, item.name);
        }
        const orgIds = Object.keys(accountsResponse.routing.byOrgId);
        setOrgFilterOptions(orgIds.map((orgId) => ({ orgId, name: nameById.get(orgId) ?? orgId })));
      } catch {
        if (!cancelled) setOrgFilterOptions([]);
      }
    })();
    return () => { cancelled = true; };
  }, [isAdminRole]);
  // Flu/Task-47 — admin-only "미등록 보기" toggle. Default OFF for account views: the server hides
  // personal-account conversations whose counterpartyRegistered stamp is false (functions/
  // read.ts resolveConversationOrgScope). The explicit actual-super_admin all-mailbox view always
  // includes those rows and legacy rows under the same server-side role gate. Flipping this ON
  // re-fetches with includeUnregistered —
  // a separate one-off call (like listMailAccounts/searchPeoplyDirectory above), not routed
  // through the shared bulk loader, so it doesn't need a cache-key change there for one rarely
  // used admin toggle. First page only (DEFAULT_PAGE_SIZE, no cursor loop) — acceptable for an
  // opt-in moderation view over what is normally a small unregistered backlog.
  const [showUnregisteredConversations, setShowUnregisteredConversations] = useState(false);
  const [unregisteredInclusiveConversations, setUnregisteredInclusiveConversations] = useState<AccountScopedConversationState | null>(null);
  const [unregisteredInclusiveError, setUnregisteredInclusiveError] = useState<{ scopeKey: string; message: string } | null>(null);

  // Flu/Task-48 — [Chat 계정 보기] 토글: '내 메일함(연결 주소)' / '조직 계정(라벨)'. The
  // context now returns these as explicit policy projections. `accessibleAccounts` remains an
  // inventory/read scope and must never decide which account can send as the caller.
  const personalMailAccount = useMemo(() => orgContext?.personalAccount ?? null, [orgContext]);
  const orgMailAccount = useMemo(() => orgContext?.orgAccount ?? null, [orgContext]);
  const usableSenderAccounts = useMemo(() => usableMailSenders(orgContext), [orgContext]);
  const defaultSender = useMemo(
    () => defaultMailSender(orgContext, usableSenderAccounts),
    [orgContext, usableSenderAccounts],
  );
  const [selectedSenderId, setSelectedSenderId] = useState("");
  const appliedSenderViewKeyRef = useRef<string | null>(null);
  // True while the empty picker is a deliberate result of a view change (viewed account not a
  // usable sender); the default-sender fill must not silently re-select on a later refetch.
  const senderViewClearedRef = useRef(false);
  const handleSenderChange = useCallback((value: string) => {
    senderViewClearedRef.current = false;
    setSelectedSenderId(value);
  }, []);
  const senderSelectionIdentityKey = JSON.stringify([
    currentRole ?? "",
    authUser?.tenantId ?? "",
    authUser?.uid ?? "anonymous",
    viewAsUserIdForScope || "self",
    viewAsEmailForScope || "",
  ]);
  const senderSelectionIdentityRef = useRef(senderSelectionIdentityKey);
  // codex final-gate round 12 (MEDIUM) — senderSelectionResetPending used to be a plain ref
  // (`senderSelectionPendingResetRef`) compared against senderSelectionIdentityKey each render.
  // Clearing that ref alone never forces React to re-render, so the handoff to the effect below
  // relied on setSelectedSenderId's OWN state change to happen to trigger the next render — if
  // selectedSenderId was already "" at that moment (a real, reachable case: a same-uid role
  // change, or the previous identity also had no sender selected), React's setState bailout (no
  // change, no re-render) could leave senderSelectionResetPending computing as still-true on the
  // COMMITTED render, keeping senderBlocked true until something unrelated happened to re-render.
  // Real useState guarantees a re-render on true -> false (booleans are never `Object.is`-equal
  // across that transition), so it cannot suffer the same propagation gap.
  const [senderSelectionResetPending, setSenderSelectionResetPending] = useState(false);
  if (senderSelectionIdentityRef.current !== senderSelectionIdentityKey) {
    senderSelectionIdentityRef.current = senderSelectionIdentityKey;
    appliedSenderViewKeyRef.current = null;
    senderViewClearedRef.current = false;
    // Render-phase "adjust state during rendering" (same pattern as src/lib/useNavPreset.ts's own
    // fix earlier in this PR) — must block send on THIS SAME render, not wait for an effect.
    setSenderSelectionResetPending(true);
  }
  // codex final-gate round 11 (MEDIUM) — this effect used to bail out (`|| orgContext`) whenever
  // orgContext was already truthy, on the assumption an identity change always leaves orgContext
  // transiently null until a fresh fetch resolves. That assumption no longer holds now that
  // useOrgContext's own render-phase fix (src/lib/useNavPreset.ts) can hand back an
  // ALREADY-RESOLVED value for the new scope on the very same render the identity changes (e.g. a
  // warm same-uid role change, or returning from a "대신 보기" session to an already-cached self
  // scope) — orgContext could then never become null, this effect would never run its body,
  // senderSelectionResetPending would never clear, and senderBlocked (which is
  // senderSelectionResetPending || ...) would stay true until the component remounted, disabling
  // send indefinitely even though there was no wrong-identity risk. Clearing the pending marker
  // (and handing off to the effect below, which recomputes the real selection once
  // senderSelectionResetPending is false) must happen regardless of whether orgContext already has
  // data — the identity-changed reset below is a safe, momentary "" that the next effect
  // immediately replaces with the correct default/current sender for the live orgContext.
  useEffect(() => {
    if (!senderSelectionResetPending) return;
    setSenderSelectionResetPending(false);
    setSelectedSenderId((current) => chatComposeSenderSelection({
      currentSenderId: current,
      policyPending: false,
      usableSenderIds: [],
      identityChanged: true,
    }));
  }, [orgContext, senderSelectionIdentityKey, senderSelectionResetPending]);
  useEffect(() => {
    if (senderSelectionResetPending) return;
    setSelectedSenderId((current) => {
      return chatComposeSenderSelection({
        currentSenderId: current,
        policyPending: !orgContext,
        usableSenderIds: usableSenderAccounts.map((account) => account.accountId),
        defaultSenderId: senderViewClearedRef.current ? undefined : defaultSender?.accountId,
      });
    });
  }, [defaultSender, orgContext, senderSelectionResetPending, usableSenderAccounts]);
  const selectedSender = useMemo(
    () => usableSenderAccounts.find((account) => account.accountId === selectedSenderId) ?? null,
    [selectedSenderId, usableSenderAccounts],
  );
  const selectedSenderIdRef = useRef(selectedSenderId);
  selectedSenderIdRef.current = orgContext && !senderSelectionResetPending ? selectedSenderId : "";
  const senderBlocked = senderSelectionResetPending || Boolean(orgContext?.senderBlockedReason) || !selectedSender;
  const senderBlockedMessage = mailSenderPolicyMessage(
    orgContext,
    !senderSelectionResetPending && !selectedSender,
  );
  // An explicit team mailbox is enough to expose the account switch. If personal OAuth is not
  // linked yet, Personal remains a deliberate empty/connect-required view so the user can switch
  // back to the mapped team's existing history without inventing a personal account id.
  const canToggleMailAccountView = Boolean(orgMailAccount);
  const [chatMailAccountView, setChatMailAccountView] = useState<MailAccountViewMode>("org");
  const serverViewMailAccountId = orgContext?.viewMailAccountId?.trim() ?? "";
  const serverMailAccountView: MailAccountViewMode | null = serverViewMailAccountId
    && personalMailAccount?.accountId === serverViewMailAccountId
    ? "personal"
    : serverViewMailAccountId
      && orgMailAccount?.accountId === serverViewMailAccountId
      ? "org"
      : orgContext?.chatMailAccountView === "personal" && personalMailAccount
        ? "personal"
        : orgContext?.chatMailAccountView === "org" && orgMailAccount
          ? "org"
          : personalMailAccount
            ? "personal"
            : orgMailAccount
              ? "org"
              : null;
  const mailAccountViewContextScopeKey = [
    authUser?.tenantId ?? "",
    authUser?.uid ?? "anonymous",
    viewAsUserIdForScope || "self",
    viewAsEmailForScope || "",
    orgContext?.orgId ?? "unresolved-org",
    orgContext?.orgResolutionStatus ?? "unknown",
    personalMailAccount?.accountId ?? "no-personal-account",
    personalMailAccount?.status ?? "",
    orgMailAccount?.accountId ?? "no-org-account",
    orgMailAccount?.status ?? "",
    serverViewMailAccountId || "no-server-view",
  ].join("|");
  const [chatMailAccountViewScopeKey, setChatMailAccountViewScopeKey] = useState<string | null>(null);
  useEffect(() => {
    const previousScopeKey = chatMailAccountViewScopeKey;
    const currentModeStillAuthorized = Boolean(orgMailAccount);
    setChatMailAccountView((current) => (
      previousScopeKey === mailAccountViewContextScopeKey && currentModeStillAuthorized
        ? current
        : serverMailAccountView ?? "org"
    ));
    setChatMailAccountViewScopeKey(mailAccountViewContextScopeKey);
  }, [
    chatMailAccountView,
    chatMailAccountViewScopeKey,
    mailAccountViewContextScopeKey,
    orgMailAccount,
    personalMailAccount,
    serverMailAccountView,
  ]);
  // A single eligible account is still an explicit account view. Only the two-account case gets
  // a toggle; falling back to the live bulk list here would expose another mailbox (including
  // legacy SCP rows) when a personal-only or unmapped team has no org account.
  const effectiveMailAccountView = chatMailAccountViewScopeKey === mailAccountViewContextScopeKey
    ? chatMailAccountView
    : serverMailAccountView;
  const selectedMailAccountView: MailAccountViewMode | null = !orgContext
    ? null
    : effectiveMailAccountView === "personal" && (personalMailAccount || orgMailAccount)
      ? "personal"
      : effectiveMailAccountView === "org" && orgMailAccount
        ? "org"
        : personalMailAccount
          ? "personal"
            : orgMailAccount
              ? "org"
              : null;
  const hasCurrentSuperAdminMailboxProjection = canSelectSuperAdminMailbox
    && superAdminMailboxProjectionOwnerKey === superAdminMailboxSelectionIdentityKey;
  const selectedSuperAdminMailbox = hasCurrentSuperAdminMailboxProjection
    ? superAdminMailboxAccounts.find((account) => account.accountId === selectedSuperAdminMailboxId) ?? null
    : null;
  const isSuperAdminAllMailboxView = hasCurrentSuperAdminMailboxProjection
    && selectedSuperAdminMailboxId === SUPER_ADMIN_ALL_MAILBOXES_SELECTION;
  const hasSuperAdminMailboxOverride = hasCurrentSuperAdminMailboxProjection
    && (isSuperAdminAllMailboxView || Boolean(selectedSuperAdminMailbox));
  const mailAccountPolicyPending = chatMailAccountViewScopeKey !== mailAccountViewContextScopeKey
    || (canSelectSuperAdminMailbox && !hasCurrentSuperAdminMailboxProjection);
  const personalMailAccountViewPressed = !mailAccountPolicyPending && !hasSuperAdminMailboxOverride
    && selectedMailAccountView === "personal";
  const orgMailAccountViewPressed = !mailAccountPolicyPending && !hasSuperAdminMailboxOverride
    && selectedMailAccountView === "org";
  const policySelectedViewMailAccountId = selectedMailAccountView === "personal"
    ? personalMailAccount?.accountId ?? ""
    : selectedMailAccountView === "org"
      ? orgMailAccount?.accountId ?? ""
      : "";
  // The operator selection is accepted only after a fresh credential-free server projection
  // confirms that its account remains active. It scopes reads; it never becomes a send-as grant.
  const selectedViewMailAccountId = isSuperAdminAllMailboxView
    ? ""
    : selectedSuperAdminMailbox?.accountId ?? policySelectedViewMailAccountId;
  // Empty account id means an explicit all-account read selected by the actual super_admin
  // outside ViewAs. The callable still derives the authorized account set from server auth;
  // ordinary policy views with no account stay fail-closed.
  const hasMailboxConversationReadScope = Boolean(selectedViewMailAccountId) || isSuperAdminAllMailboxView;
  // Changing the mailbox view must never silently retain the previous account as the sender. A
  // usable viewed account is selected for convenience; an unavailable/unconnected view clears
  // the sender so a user must make an explicit authorized alternative choice in the picker.
  // The viewed account only drives the selection when the VIEW itself changed. A policy refetch
  // (new orgContext / usableSenderAccounts identity, same view) must keep the operator's explicit
  // pick while it stays allowed — re-applying the viewed sender there reset the picker to
  // "발신 계정 선택" whenever the view had no usable sender of its own (conv_1hxd8to, 2026-10-02).
  useEffect(() => {
    if (senderSelectionResetPending || !orgContext) return;
    const viewKey = JSON.stringify([selectedMailAccountView ?? "", selectedViewMailAccountId]);
    const viewChanged = appliedSenderViewKeyRef.current !== viewKey;
    appliedSenderViewKeyRef.current = viewKey;
    const usableSenderIds = usableSenderAccounts.map((account) => account.accountId);
    const viewedSenderId = selectedMailAccountView ? selectedViewMailAccountId : "";
    if (viewChanged) senderViewClearedRef.current = !(viewedSenderId && usableSenderIds.includes(viewedSenderId));
    setSelectedSenderId((current) => chatComposeSenderSelection({
      currentSenderId: current,
      policyPending: false,
      usableSenderIds,
      defaultSenderId: senderViewClearedRef.current ? undefined : defaultSender?.accountId,
      ...(viewChanged ? { viewedSenderId } : {}),
    }));
  }, [defaultSender, orgContext, selectedMailAccountView, selectedViewMailAccountId, senderSelectionResetPending, usableSenderAccounts]);
  const mailAccountViewScopeKey = [
    mailAccountViewContextScopeKey,
    isSuperAdminAllMailboxView ? "all-authorized-mailboxes" : selectedViewMailAccountId || "no-mail-account",
  ].join("|");
  // Flu/Task-48 적대 리뷰 P1-5 — 계정 배지: row.mailAccountId 는 공개 투영에 없으므로 실제 행
  // 값이 아니라 "지금 이 목록이 어느 계정 보기로 스코프됐는지"(viewMailAccountId 기준)만 보여준다.
  // 개인 계정이면 label/mailbox, 조직 계정이면 매핑된 팀 이름을 우선한다.
  const viewingMailAccount = useMemo(
    () => selectedSuperAdminMailbox
      ?? [personalMailAccount, orgMailAccount].find((account) => account?.accountId === selectedViewMailAccountId)
      ?? null,
    [orgMailAccount, personalMailAccount, selectedSuperAdminMailbox, selectedViewMailAccountId],
  );
  const viewingMailAccountLabel = viewingMailAccount
    ? (selectedSuperAdminMailbox
        ? (viewingMailAccount.label || viewingMailAccount.mailbox)
        : selectedMailAccountView === "personal"
        ? (viewingMailAccount.label || viewingMailAccount.mailbox)
        : (orgContext?.orgName || viewingMailAccount.label || viewingMailAccount.mailbox))
    : isSuperAdminAllMailboxView
      ? "전체 메일함"
      : selectedMailAccountView === "personal"
      ? "개인 메일함 연결 필요"
      : null;
  // Flu/Task-56 — "보기 · " 접두: 이 대화가 실제로 속한 계정이 아니라 지금 이 목록/헤더가 어느
  // 계정 보기로 스코프됐는지라는 것을 문구로 구분한다(위 Task-48 P1-5 주석 그대로, 실제 귀속 표시는
  // 별도 설계 확인이 필요해 이번 스코프에서는 라벨만 명확히 한다).
  const viewingAccountBadge = viewingMailAccountLabel ? (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold text-accent"
      title={`현재 보기 계정 — 이 대화의 실제 소속 계정과 다를 수 있습니다${viewingMailAccount?.mailbox ? ` (${viewingMailAccount.mailbox})` : ""}`}
    >
      보기 · {viewingMailAccountLabel}
    </span>
  ) : null;
  const [mailAccountViewConversations, setMailAccountViewConversations] = useState<AccountScopedConversationState | null>(null);
  const [targetedMailboxConversations, setTargetedMailboxConversations] = useState<{ scopeKey: string; rows: Conversation[] } | null>(null);
  const [mailAccountViewError, setMailAccountViewError] = useState<{ scopeKey: string; message: string } | null>(null);
  const mailAccountViewRequestGenerationRef = useRef(0);
  // 명시적 데이터 갱신(requestDataRefresh → "flu:data-refresh" — 읽음 처리·발송·받은편지함
  //   새로고침 등 이 화면의 뮤테이션이 쏘는 신호)에는 마운트된 목록도 다시 읽는다. 캐시 만료는
  //   conversation-list-cache 모듈이 같은 이벤트에 먼저 반응하므로(모듈 등록이 페이지 마운트보다
  //   먼저 일어난다) 이 재실행은 항상 새 읽기로 이어진다 — 신선 캐시에 막혀 뮤테이션 이전 행을
  //   계속 보여주지 않는다.
  const [accountViewRefreshTick, setAccountViewRefreshTick] = useState(0);
  useEffect(() => {
    const onDataRefresh = () => setAccountViewRefreshTick((tick) => tick + 1);
    const onForegroundSync = (event: Event) => {
      const detail = (event as CustomEvent<{ status?: string }>).detail;
      if (detail?.status !== "success") return;
      invalidateConversationListCache();
      setAccountViewRefreshTick((tick) => tick + 1);
    };
    window.addEventListener("flu:data-refresh", onDataRefresh);
    window.addEventListener("chat:foreground-sync", onForegroundSync);
    return () => {
      window.removeEventListener("flu:data-refresh", onDataRefresh);
      window.removeEventListener("chat:foreground-sync", onForegroundSync);
    };
  }, []);
  // orgContext 무효화(메일 계정 정책·라우팅 변경, TTL 재검증 진입)는 이 목록의 스코프 근거를
  //   흔든다 — 같은 신호에 목록 캐시도 만료시켜 둔다. 스코프 키에 들어가지 않는 org 정책 변화가
  //   목록 내용을 바꾸는 경우(계정 재라우팅 등)에도 신선 캐시가 그 이후 재실행을 가로막지 않게.
  //   값은 지워지지 않고 만료될 뿐이라 표시 중인 행은 그대로 두고 배경에서만 다시 읽는다.
  useEffect(
    () => subscribeOrgContextInvalidation(() => invalidateConversationListCache()),
    [],
  );
  useEffect(() => {
    const requestGeneration = mailAccountViewRequestGenerationRef.current + 1;
    mailAccountViewRequestGenerationRef.current = requestGeneration;
    if (!hasMailboxConversationReadScope || !orgContext) {
      setMailAccountViewConversations(null);
      setMailAccountViewError(null);
      return;
    }
    const includeUnregistered = isSuperAdminAllMailboxView || showUnregisteredConversations;
    const cacheKey = conversationListCacheKey(mailAccountViewScopeKey, includeUnregistered);
    const cached = peekConversationListCache<AccountScopedConversationState>(cacheKey);
    // SWR — 캐시에 값이 있으면(만료됐어도) 먼저 그린다: 재마운트·orgContext 재검증으로 이 effect 가
    //   다시 돌 때 목록이 비었다 차오르는 플래시를 없앤다. 이미 이 스코프의 행을 들고 있으면 그쪽이
    //   더 최신이므로 건드리지 않는다.
    setMailAccountViewConversations((current) => (
      current?.scopeKey === mailAccountViewScopeKey ? current : cached?.value ?? null
    ));
    setMailAccountViewError((current) => current?.scopeKey === mailAccountViewScopeKey ? current : null);
    if (shouldSkipConversationListRead(cached)) return;
    let cancelled = false;
    void revalidateConversationListCache(cacheKey, () =>
      listConversations({
        mailAccountId: selectedViewMailAccountId,
        ...(includeUnregistered ? { includeUnregistered: true } : {}),
        ...viewAsParams,
      })
        .then((result) => toAccountScopedConversationState(result, selectedViewMailAccountId, mailAccountViewScopeKey)),
    )
      .then((next) => {
        if (cancelled || requestGeneration !== mailAccountViewRequestGenerationRef.current) return;
        // 재검증 응답은 항상 1페이지뿐이다 — "이전 대화 더 보기"로 이어붙인 꼬리가 있으면
        //   (reconcileRevalidatedConversations) 머리만 새로 그리고 꼬리·깊은 커서는 그대로
        //   지킨다. 아직 1페이지뿐이면(또는 스코프가 바뀌었으면) next 그대로 교체된다.
        setMailAccountViewConversations((current) =>
          reconcileRevalidatedConversations(current, next));
      })
      .catch((error) => {
        if (cancelled || requestGeneration !== mailAccountViewRequestGenerationRef.current) return;
        setMailAccountViewConversations(null);
        setMailAccountViewError({ scopeKey: mailAccountViewScopeKey, message: errorText(error) });
      });
    return () => { cancelled = true; };
  }, [accountViewRefreshTick, hasMailboxConversationReadScope, isSuperAdminAllMailboxView, mailAccountViewScopeKey, orgContext, selectedViewMailAccountId, showUnregisteredConversations, viewAsParams]);

  useEffect(() => {
    if (!isAdminRole || (!showUnregisteredConversations && !isSuperAdminAllMailboxView) || !hasMailboxConversationReadScope || !orgContext) {
      setUnregisteredInclusiveConversations(null);
      setUnregisteredInclusiveError(null);
      return;
    }
    // 위 기본 보기와 같은 SWR 캐시를 includeUnregistered 구분 키로 나눠 쓴다 — 토글을 껐다 켜거나
    //   스코프 재실행이 있을 때 이 목록도 비었다 차오르지 않는다.
    const cacheKey = conversationListCacheKey(mailAccountViewScopeKey, true);
    const cached = peekConversationListCache<AccountScopedConversationState>(cacheKey);
    setUnregisteredInclusiveConversations((current) => (
      current?.scopeKey === mailAccountViewScopeKey ? current : cached?.value ?? null
    ));
    setUnregisteredInclusiveError((current) => current?.scopeKey === mailAccountViewScopeKey ? current : null);
    if (shouldSkipConversationListRead(cached)) return;
    let cancelled = false;
    void revalidateConversationListCache(cacheKey, () =>
      listConversations({
        includeUnregistered: true,
        mailAccountId: selectedViewMailAccountId,
        ...viewAsParams,
      }).then((result) => toAccountScopedConversationState(result, selectedViewMailAccountId, mailAccountViewScopeKey)),
    )
      .then((next) => {
        // 위 기본 보기 effect와 같은 이유로 reconcileRevalidatedConversations 를 거친다 —
        //   "이전 대화 더 보기"로 이어붙인 꼬리가 있으면 머리만 새로 그리고 지킨다.
        if (!cancelled) {
          setUnregisteredInclusiveConversations((current) =>
            reconcileRevalidatedConversations(current, next));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setUnregisteredInclusiveConversations(null);
          setUnregisteredInclusiveError({ scopeKey: mailAccountViewScopeKey, message: errorText(error) });
        }
      });
    return () => { cancelled = true; };
  }, [accountViewRefreshTick, hasMailboxConversationReadScope, isAdminRole, isSuperAdminAllMailboxView, mailAccountViewScopeKey, orgContext, selectedViewMailAccountId, showUnregisteredConversations, viewAsParams]);
  const handleSuperAdminMailboxChange = useCallback((accountId: string) => {
    if (!hasCurrentSuperAdminMailboxProjection) return;
    const nextAccountId = accountId.trim();
    if (nextAccountId !== SUPER_ADMIN_ALL_MAILBOXES_SELECTION
      && nextAccountId !== SUPER_ADMIN_POLICY_MAILBOX_SELECTION
      && nextAccountId
      && !superAdminMailboxAccounts.some((account) => account.accountId === nextAccountId)) return;
    setSelectedSuperAdminMailboxId(nextAccountId);
    persistSuperAdminMailboxSelection(superAdminMailboxSelectionIdentityKey, nextAccountId);
  }, [hasCurrentSuperAdminMailboxProjection, superAdminMailboxAccounts, superAdminMailboxSelectionIdentityKey]);

  const handleMailAccountViewChange = useCallback((next: MailAccountViewMode) => {
    if (!orgMailAccount || mailAccountPolicyPending) return;
    // Policy controls must leave an operator-only all/concrete mailbox override before applying
    // the policy account mode; otherwise their pressed state can disagree with the actual read.
    const shouldReturnToPolicyMailbox = hasCurrentSuperAdminMailboxProjection
      && selectedSuperAdminMailboxId !== SUPER_ADMIN_POLICY_MAILBOX_SELECTION;
    if (shouldReturnToPolicyMailbox) {
      handleSuperAdminMailboxChange(SUPER_ADMIN_POLICY_MAILBOX_SELECTION);
    }
    if (next === selectedMailAccountView) return;
    setChatMailAccountView(next);
    // ViewAs may switch the subject's mailbox locally, but must never persist that choice as the
    // operator's own preference. Keep the raw flag in this guard as well as the role-validated
    // state so claim hydration cannot briefly turn a preview into a write.
    if (viewAsFlagActive || isViewingAs || chatMailAccountViewScopeKey !== mailAccountViewContextScopeKey) return;
    // Capture this render's scoped invalidator. If ViewAs changes before the write settles, this
    // still invalidates only the original operator scope and cannot evict the new target cache.
    void setUserPreference({ key: "chatMailAccountView", value: next })
      .then(() => invalidateOrgContext())
      .catch(() => undefined);
  }, [
    chatMailAccountViewScopeKey,
    handleSuperAdminMailboxChange,
    hasCurrentSuperAdminMailboxProjection,
    invalidateOrgContext,
    isViewingAs,
    mailAccountViewContextScopeKey,
    mailAccountPolicyPending,
    orgMailAccount,
    selectedSuperAdminMailboxId,
    selectedMailAccountView,
    viewAsFlagActive,
  ]);

  const mailAccountViewToggle = (
    <>
      {canToggleMailAccountView && orgMailAccount ? (
        <div
          role="group"
          aria-label="계정 보기"
          className="flex items-center overflow-hidden rounded-md border border-line text-[11px] font-medium"
        >
          <button
            type="button"
            onClick={() => handleMailAccountViewChange("personal")}
            disabled={mailAccountPolicyPending}
            aria-pressed={personalMailAccountViewPressed}
            className={cn(
              "px-2 py-1 transition-colors",
              personalMailAccountViewPressed ? "bg-accent text-white" : "bg-paper text-ink-3 hover:bg-fill",
            )}
            title={personalMailAccount?.mailbox ?? "개인 메일 연결 필요"}
          >
            내 메일함
          </button>
          <button
            type="button"
            onClick={() => handleMailAccountViewChange("org")}
            disabled={mailAccountPolicyPending}
            aria-pressed={orgMailAccountViewPressed}
            className={cn(
              "px-2 py-1 transition-colors",
              orgMailAccountViewPressed ? "bg-accent text-white" : "bg-paper text-ink-3 hover:bg-fill",
            )}
            title={orgMailAccount.mailbox}
          >
            {orgMailAccount.label || "조직 계정"}
          </button>
        </div>
      ) : null}
      {hasCurrentSuperAdminMailboxProjection ? (
        <label className="flex items-center gap-1 text-[11px] font-medium text-ink-3">
          운영자 메일함
          <select
            aria-label="운영자 메일함 보기"
            value={selectedSuperAdminMailboxId}
            onChange={(event) => handleSuperAdminMailboxChange(event.target.value)}
            className="h-7 max-w-[190px] rounded-md border border-line bg-paper px-1.5 text-[11px] text-ink outline-none focus:border-ink-4"
          >
            <option value={SUPER_ADMIN_ALL_MAILBOXES_SELECTION}>전체 메일함</option>
            <option value={SUPER_ADMIN_POLICY_MAILBOX_SELECTION}>정책 기본 보기</option>
            {superAdminMailboxAccounts.map((account) => (
              <option key={account.accountId} value={account.accountId}>
                {account.label || account.mailbox}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </>
  );

  // Keep the explicit sender and mailbox view identities separate, while warning when the user is
  // composing from a different account than the mailbox whose history is on screen.
  const composerSenderMismatched = isComposerSenderViewMismatched({
    selectedViewMailAccountId,
    selectedSenderAccountId: selectedSender?.accountId ?? null,
  });

  const rawConversations = useMemo(() => {
    const accountScopedConversations = mailAccountViewConversations?.scopeKey === mailAccountViewScopeKey
      ? mailAccountViewConversations.rows
      : [];
    const unregisteredScopedConversations = unregisteredInclusiveConversations?.scopeKey === mailAccountViewScopeKey
      ? unregisteredInclusiveConversations.rows
      : [];
    const base = isAdminRole && (showUnregisteredConversations || isSuperAdminAllMailboxView)
        ? unregisteredScopedConversations
        : orgContext
          ? accountScopedConversations
          : [];
    const targetedRows = targetedMailboxConversations?.scopeKey === mailAccountViewScopeKey
      ? targetedMailboxConversations.rows : [];
    const targetedIds = new Set(targetedRows.map((row) => String(row.id)));
    const scopedRows = [...base.filter((row) => !targetedIds.has(String(row.id))), ...targetedRows];
    if (!isAdminRole || !chatOrgFilter) return scopedRows;
    const canonicalFilter = canonicalScpOrgId(chatOrgFilter);
    return scopedRows.filter((conversation) => canonicalScpOrgId(conversation.orgId ?? "") === canonicalFilter);
  }, [chatOrgFilter, isAdminRole, isSuperAdminAllMailboxView, mailAccountViewConversations, mailAccountViewScopeKey, orgContext, showUnregisteredConversations, targetedMailboxConversations, unregisteredInclusiveConversations]);
  const conversations = useMemo(() => dedupeConversationsByThread(
    normalizeConversations(rawConversations).filter(isDefaultChatConversation),
  ).sort((a, b) => conversationMillis(b) - conversationMillis(a)), [rawConversations]);
  // W114-C (헤세: "다른 탭에서도 사람 탭처럼 다 해야 한다"): 사람 탭만 buildPersonProfile 의
  // 갈래-간 union 을 받는다 — 다른 탭(전체/안읽음/Direct/프로그램) 목록 행·헤더는 그 갈래
  // 하나만 보고 그려서, 포털 갈래(이름 자리에 이메일, 팔로워 0)가 선택되면 캠페인 갈래에 있는
  // 진짜 이름·플랫폼·팔로워가 있어도 못 본다(실측: 이메일-이름 412건 중 200건, followers 0
  // 443건 중 161건, platform 공백 417건 중 201건이 다른 갈래로 해결 가능). 사람 탭이 쓰는
  // groupConversationsByPerson 을 여기서도 재사용해, 이미 로드된 기본 스코프(conversations,
  // 신규 Firestore 읽기 없음)만 다시 묶는다 — personScopeConversations(콜드 포함 7천대) 는
  // person 탭에서만 계산하는 기존 비용 정책을 그대로 둔다.
  const conversationPersonProfileByKey = useMemo(() => {
    const map = new Map<string, PersonRoom["profile"]>();
    for (const room of groupConversationsByPerson(conversations)) map.set(room.personKey, room.profile);
    return map;
  }, [conversations]);
  const creators = useLiveCreators<Creator>(CREATORS);
  const programs = useLivePrograms<Program>([]);
  const campaigns = useLiveCampaigns<Campaign>([]);
  const { data, loading, authReady, canRead, authScopeKey, authScopeGeneration, mutate, chatForegroundSync } = useLive();
  const autoReplySettings = data?.autoReply?.[0] as { enabled?: unknown } | undefined;
  const globalAutoReplyEnabled = recordBoolean(autoReplySettings?.enabled);
  // 2026-10-05: until the autoReply dataset has loaded, "off" is not a fact — show 확인 중 instead.
  const autoReplySettingsLoaded = Boolean(data) && (!data?.loadedKeys || data.loadedKeys.includes("autoReply"));
  const conversationsLoaded = Boolean(
    orgContext
    && hasMailboxConversationReadScope
    && mailAccountViewConversations?.scopeKey === mailAccountViewScopeKey,
  );
  // `data?.loadedKeys?.includes("conversations")` may still be populated by the shared live
  // provider for notification consumers, but it is never a readiness signal for this mailbox.
  const [tab, setTab] = useState("person");
  // "미답장 인박스" (2026-09-26): 탭 배지 건수는 패널 자신의 fetch/캐시를 재사용한다(새 구독
  // 없음) — LIST_TABS는 모듈 상수라 여기서 건수를 얹은 사본을 만든다.
  // Flu conversation org-filter round 3 (coordinator gap-close): the bounded scan behind this
  // count can be partial (a sparse org's rows buried past the auto-continuation bound) — isPartial
  // labels that honestly ("37+") instead of presenting a lower bound as an exact count.
  const { count: unrepliedInboxCount, isPartial: unrepliedInboxCountPartial } = useUnrepliedInboxCount();
  // 2026-09-27 security fix (codex round1 finding #5): "미답장" 탭은 scp 전용 큐다 — 서버가
  // 빈 결과로 낮춰줘도(getMyOrgContext.scpAccessGranted 가 false) 탭 자체는 계속 보였다. 명시적
  // scp 배정이 없는 호출자에게는 scp 관련 토글/탭이 아예 노출되면 안 된다는 정책이라, 탭 존재
  // 자체를 서버 판정 플래그로 가린다(role/orgId로 다시 판정하지 않는다 — SEC-P0-009 doctrine).
  const listTabs = useMemo(
    () => (
      orgContext?.scpAccessGranted
        ? [...LIST_TABS, {
            key: "unreplied",
            label: "미답장",
            count: unrepliedInboxCount ? (unrepliedInboxCountPartial ? `${unrepliedInboxCount}+` : unrepliedInboxCount) : undefined,
          }]
        : LIST_TABS
    ),
    [orgContext?.scpAccessGranted, unrepliedInboxCount, unrepliedInboxCountPartial],
  );
  const [selectedId, setSelectedId] = useState(requestedConversationId);
  // [리뷰어 A HIGH 수리 (a)]: flat 탭에서 "방금 이 탭에서 명시적으로 클릭했다"는 사실을
  // selectedId 와 별도로 기록한다 — selectConversation(행 클릭·프로그램 드릴다운 진입, 아래)이
  // 찍는다. conv 해소는 이 값이 **지금 탭·지금 selectedId 와 정확히 일치할 때만** 넓은 풀
  // (tabScoped)을 쓰고, 그 밖(다른 탭에서 넘어온 stale selectedId 등 수동/passive 해소)에는
  // 옛 좁은 풀(visible)로 되돌린다 — 탭을 바꿨을 때 이전 탭의 selectedId 가 새 탭의 tabScoped[0]
  // (검색·클릭과 무관한 그 탭의 최신 대화)로 조용히 새는 걸 막는다(리뷰어 A 재검증 HIGH, 재현됨).
  const [lastFlatClick, setLastFlatClick] = useState<{ tab: string; key: string } | null>(null);
  const [programDrilldownId, setProgramDrilldownId] = useState<string | null>(null);
  const [attributionEditorOpen, setAttributionEditorOpen] = useState(false);
  const [attributionProgramId, setAttributionProgramId] = useState("");
  const [attributionCampaignId, setAttributionCampaignId] = useState("");
  const [attributionReason, setAttributionReason] = useState("");
  const [attributionSaving, setAttributionSaving] = useState(false);
  const [lastAttributionChange, setLastAttributionChange] = useState<{ conversationId: string; auditRef: string; version: number } | null>(null);
  const [attributionNotice, setAttributionNotice] = useState("");
  const [threadMessagesById, setThreadMessagesById] = useState<Record<string, Msg[]>>({});
  const [loadedMessageKeys, setLoadedMessageKeys] = useState<ReadonlySet<string>>(() => new Set());
  // 2026-10-05: keys whose LATEST message request succeeded (a failure removes the key again) — the
  // board prefill hand-off waits for this, never for a failed load.
  const [succeededMessageKeys, setSucceededMessageKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [targetedConversationStatus, setTargetedConversationStatus] = useState<{ id: string; scopeKey: string; state: "idle" | "loading" | "done" | "missing" }>({ id: "", scopeKey: "", state: "idle" });
  const [draftActionByKey, setDraftActionByKey] = useState<Record<string, DraftActionState>>({});
  const [readActionByKey, setReadActionByKey] = useState<Record<string, ReadActionState>>({});
  const [pendingHumanDraftUse, setPendingHumanDraftUse] = useState(false);
  const campaignsById = useMemo(() => new Map(campaigns.map((campaign) => [campaign.id, campaign])), [campaigns]);

  const programGroups = useMemo(
    () => buildChatProgramGroups(programs, campaigns, conversations),
    [programs, campaigns, conversations],
  );
  const selectedProgramGroup = programGroups.find((group) => group.programId === programDrilldownId) ?? null;

  const [listSearch, setListSearch] = useState("");

  // W106 Phase 2 (§4 L2): 사람 방 상태 3개 — personKey/strandFilter/replyTargetStrand.
  // strandFilter: "all" | uiThreadKey. replyTargetStrand: "" (기본값) | uiThreadKey | "__new__".
  const [personKey, setPersonKey] = useState("");
  // 2026-10-05: below md the inbox is single-pane — the list, or the selected conversation full width.
  // A deep link (?conversationId=, incl. a review-board hand-off) opens the conversation pane.
  const [mobilePane, setMobilePane] = useState<"list" | "conversation">(requestedConversationId ? "conversation" : "list");
  // The deep-linked strand is a ONE-TIME preference: any explicit strand navigation ends it.
  const [deepLinkStrandActive, setDeepLinkStrandActive] = useState(Boolean(requestedConversationId));
  // Every explicit user navigation that touches the reply target ends the one-time deep-link
  // preference; only a NEW requestedConversationId (new deep link) arms it again.
  const endDeepLinkStrandPreference = useCallback(() => setDeepLinkStrandActive(false), []);
  const selectReplyTargetByUser = useCallback((strandKey: string) => {
    setDeepLinkStrandActive(false);
    setReplyTargetStrand(strandKey);
  }, []);
  // 2026-10-05: a NEW deep link (?conversationId= changes via back/forward or a link) wins over an
  // earlier explicit click, so the requested conversation opens instead of the previously clicked one.
  useEffect(() => {
    if (!requestedConversationId) return;
    setMobilePane("conversation");
    setDeepLinkStrandActive(true);
    setPersonKey("");
    setLastFlatClick(null);
    // A new deep link also drops the previous strand filter / reply-target override (same person too).
    setStrandFilter("all");
    setReplyTargetStrand("");
  }, [requestedConversationId]);
  const [strandFilter, setStrandFilter] = useState("all");
  const [replyTargetStrand, setReplyTargetStrand] = useState("");
  const [replyTargetMenuOpen, setReplyTargetMenuOpen] = useState(false);
  // W111-B (헤세): Gmail 모델. 지메일은 보낸 메일을 전체메일에 싣지 않고, 전체메일엔 받은 메일과
  // 답장이 온 스레드만 뜬다. 사람 탭도 같은 모델로 **인바운드가 온 사람만** 기본 노출한다
  // (프로드 실측 7,094명 → 163명). 답장 없는 콜드 발송은 목록을 덮을 뿐 응대할 게 없고,
  // 그쪽은 이미 /flu/review 의 콜드메일 히스토리에 자리가 있다.
  //   W109 의 신원·스코프는 그대로 살아 있다 — 이메일 우선 키가 없으면 인바운드 온 사람도
  //   갈래 수만큼 쪼개지고(tokymongrey 13갈래), 스코프 수정이 없으면 "답장 없음"으로 숨겨져
  //   있던 실제 인바운드 대화 23건을 여전히 못 본다. 이번 변경은 **기본 노출 범위만** 바꾼다.
  // 기본 정렬은 groupConversationsByPerson 이 이미 최근 활동순(latestMillis desc)이다.
  const [personRepliedOnly, setPersonRepliedOnly] = useState(true);
  // 이미 요청을 쏜 갈래 키(중복 fetch 방지) — loadedMessageKeys(state)에 의존하면 같은 프레임에
  // 아직 응답이 안 온 두 갈래가 서로를 중복 재요청할 수 있다(autoPrefillKeysRef 와 같은 이유).
  const personRoomLoadRequestedRef = useRef<Set<string>>(new Set());
  const previousMailAccountViewScopeRef = useRef<string | null>(null);
  useEffect(() => {
    const previousScope = previousMailAccountViewScopeRef.current;
    previousMailAccountViewScopeRef.current = mailAccountViewScopeKey;
    // Keep an incoming deep link while the policy context resolves for the first time. Every
    // later account/identity change invalidates the selected conversation and message cache so a
    // personal view can never briefly render a previously selected shared mailbox thread.
    if (
      previousScope === null
      || previousScope === mailAccountViewScopeKey
      || previousScope.startsWith("no-mail-account|")
    ) return;
    setSelectedId("");
    setThreadMessagesById({});
    setLoadedMessageKeys(new Set());
    setSucceededMessageKeys(new Set());
    personRoomLoadRequestedRef.current.clear();
    setStrandFilter("all");
    setReplyTargetStrand("");
    setReplyTargetMenuOpen(false);
    setTargetedConversationStatus({ id: "", scopeKey: "", state: "idle" });
    setTargetedMailboxConversations(null);
  }, [mailAccountViewScopeKey]);

  // W114-E [헤세 재신고 — 스크린샷]: 아래 flatPersonRows 가 이 배열(탭 스코프만, **검색 전**)을
  //   그룹의 원본으로 쓴다 — 이유는 flatPersonRows 정의 옆 주석 참고.
  const tabScoped = useMemo(() => (
    // "미답장" 탭은 이 배열이 구동하는 기존 flat-list/그룹핑 렌더 경로를 전혀 쓰지 않는다 —
    // UnrepliedInboxPanel 이 자기 데이터(listUnrepliedInbox)를 따로 갖는 자기완결 패널이라,
    // 여기서는 안정적인 빈 참조만 돌려줘 아래 flatPersonRows 류가 옛 탭의 목록을 이어서
    // 보여주지 않게 한다.
    tab === "unreplied"
      ? EMPTY_CONVERSATIONS
      : tab === "unread"
        ? conversations.filter((c) => c.unread > 0)
        : tab === "campaign"
          ? (selectedProgramGroup ? [...selectedProgramGroup.conversations] : [])
          : tab === "direct"
            ? conversations.filter((c) => classifyChatPrimaryRoute(c, campaignsById).primaryBucket === "direct")
            : conversations
  ), [tab, conversations, selectedProgramGroup, campaignsById]);

  const visible = useMemo(() => {
    const query = listSearch.trim().toLowerCase();
    if (!query) return tabScoped;
    // 이미 로드된 목록에 대한 클라이언트 필터다 — 새 서버 조회를 만들지 않는다.
    return tabScoped.filter((conversation) => conversationMatchesListQuery(conversation, creators, query));
  }, [tabScoped, listSearch, creators]);

  // W114-D (헤세 실측: jonnyboesee@gmail.com 이 목록에 7줄로 갈라져 뜨는 결함 — 스크린샷 신고).
  // 근인 확정(스크립트 실행 검증): personIdentityKey/groupConversationsByPerson 자체는 같은
  // creatorEmail 을 가진 10건을 정확히 갈래10짜리 방 하나로 합친다 — 키 산출은 정상이다.
  // 실제 결함은 렌더 경로에 있었다: 사람 탭이 아닌 다른 탭(전체/안읽음/Direct/캠페인 드릴다운)의
  // 목록 행은 `visible`(원문 conversations 배열)을 **그룹 없이 1문서=1행**으로 그렸다 — W114-C가
  // 붙인 conversationPersonProfileByKey union 은 행의 이름·아바타만 덮어썼을 뿐, 같은 사람의
  // 서로 다른 대화 문서(예: 캠페인 갈래 + conv_* 갈래들)를 한 행으로 접지는 않았다. 그래서 답장
  // 신호가 있는 갈래가 2개 이상이면 그 탭에서 같은 사람이 여전히 여러 줄로 쪼개져 보인다.
  //
  // W114-E [헤세 재신고 — 스크린샷, jonnyboesee 검색]: 위 수리(D)는 **무검색 상태**만 고쳤다.
  //   `flatPersonRows = groupConversationsByPerson(visible)` 로 짜면, 검색어가 있을 때 `visible`
  //   이 이미 **갈래(대화) 단위**로 걸러진 뒤라 같은 사람의 갈래 중 일부만 검색 필드에 매치되면
  //   (예: 캠페인 갈래는 handle 이 매치, 포털 conv_* 갈래는 매치 필드가 없음) 그 부분집합만 묶여
  //   사람이 다시 여러 줄로 쪼개진다(실측: jonnyboesee 검색 시 "갈래 8" 한 줄 + "갈래 1" 여섯 줄 —
  //   Firestore 실제 10건과도, 화면 헤더/검색 카운트와도 셋 다 어긋났다). 순서를 뒤집는다:
  //   **tabScoped(검색 전, 탭 스코프만)를 먼저 사람 단위로 묶고**, 그 방의 갈래 중 어느 하나라도
  //   검색어에 매치되면 방 전체(=전체 갈래 수 배지)를 남긴다 — 사람 탭의 personRoomsVisible 이
  //   이미 쓰던 것과 같은 "그룹 먼저, 사람 단위 술어" 순서다. 탭 필터(unread/direct/campaign)는
  //   그대로 tabScoped 에서 먼저 적용되므로 탭의 의미(예: unread 탭은 안 읽은 갈래만)는 안 바뀐다
  //   — 다만 그 스코프 안에서 같은 사람의 갈래는 항상 한 행으로 묶인다.
  // [리뷰어 A LOW]: 그룹핑(groupConversationsByPerson)과 검색 필터를 별도 memo 로 나눈다 — 하나로
  //   합쳐 두면 검색창에 키를 칠 때마다(listSearch 변화) tabScoped 전체를 다시 묶는다. 필터만
  //   listSearch 에 의존하게 하면 타이핑 중에는 이미 묶인 rooms 를 그대로 재사용한다.
  const flatPersonRoomsAll = useMemo(
    () => (tab === "person" ? EMPTY_PERSON_ROOMS : groupConversationsByPerson(tabScoped)),
    [tab, tabScoped],
  );
  const flatPersonRows = useMemo(() => {
    const query = listSearch.trim().toLowerCase();
    if (!query) return flatPersonRoomsAll;
    return flatPersonRoomsAll.filter((room) => room.strands.some((strand) => conversationMatchesListQuery(strand, creators, query)));
  }, [flatPersonRoomsAll, listSearch, creators]);

  // W106 Phase 2 (§4 L1/L2, §5-3): 이미 로드된 conversations 의 클라이언트 재조립뿐 — 신규
  // Firestore 읽기 없음. tab !== "person" 이면 계산을 건너뛴다(EMPTY_PERSON_ROOMS, 안정 참조).
  // W109 (헤세): "사람" 탭은 기본 탭과 **다른 스코프**를 본다. 기본 탭의 isDefaultChatConversation
  // 은 답장 신호를 요구해서 콜드·프로그램 메일을 전부 걷어내는데(프로드 실측 7,622건 중 237건만
  // 통과), 사람 탭은 "우리가 접촉한 사람 전체"를 커버해야 한다. 그래서 여기서만 원장 스코프
  // (isPersonScopeConversation)로 다시 파생한다 — 기존 탭들이 쓰는 `conversations` 는 불변.
  // tab !== "person" 이면 계산을 건너뛴다(30배 큰 모집단을 평소에 만들지 않는다).
  const personScopeConversations = useMemo(
    () => (tab === "person"
      ? dedupeConversationsByThread(normalizeConversations(rawConversations).filter(isPersonScopeConversation))
        .sort((a, b) => conversationMillis(b) - conversationMillis(a))
      : EMPTY_CONVERSATIONS),
    [tab, rawConversations],
  );

  // W106 Phase 2 (plan §4 L1/L2, §5-3): 이미 로드된 대화의 클라이언트 재조립뿐 — 신규 Firestore
  // 읽기 없음. 묶음 키는 personIdentityKey(이메일 우선, chat-people.ts)다.
  // W111 (헤세, 캐싱): 방 **목록**은 하이드레이션 없이 한 번만 묶는다.
  //   종전엔 목록 자체를 threadMessagesById 로 하이드레이션해서 만들었는데, 그러면 갈래 메시지가
  //   하나 로드될 때마다 원장 전체(스코프 7,641건)를 다시 묶었다 — 실측 35ms/회, 17갈래짜리 사람을
  //   열면 600ms 가 그냥 재계산에 갈린다. 목록에 필요한 값(이름·아바타·갈래 수·안읽음·최근시각)은
  //   대화 문서 필드에서 나오지 그 안의 메시지에서 나오지 않으므로 하이드레이션이 필요 없다.
  const personRooms = useMemo(
    () => (tab === "person" ? groupConversationsByPerson(personScopeConversations) : EMPTY_PERSON_ROOMS),
    [tab, personScopeConversations],
  );
  // W111-B (헤세): 노출 기준은 "이메일 회신" 단독이 아니라 **회신 OR 포털 참여**다.
  // 회신만으로 거르면 지원 확정·콘텐츠 제출한 96명(프로드 실측)이 통째로 사라지는데,
  // 그 사람들이야말로 응대 대상이다(예: MineLite — 회신 0건이지만 지원 확정 + 콘텐츠 2회 제출).
  const personRoomsResponded = useMemo(
    () => personRooms.filter((room) => room.hasReplySignal || room.hasEngagementSignal),
    [personRooms],
  );
  const personRoomsVisible = useMemo(() => {
    const scoped = personRepliedOnly ? personRoomsResponded : personRooms;
    const query = listSearch.trim().toLowerCase();
    if (!query) return scoped;
    // 이미 로드된 사람 방에 대한 클라이언트 필터 — 새 서버 조회를 만들지 않는다(§5-3).
    return scoped.filter((room) =>
      [room.profile.name, room.profile.handle, room.profile.email].some(
        (field) => typeof field === "string" && field.toLowerCase().includes(query),
      ));
  }, [personRooms, personRoomsResponded, personRepliedOnly, listSearch]);

  // The explicit mailbox view loads one bounded page first. Older person history is now a
  // deliberate user action: draining every cursor on first visit made large mailboxes keep issuing
  // 2,000-row calls while regrouping the person list after each page.
  const accountViewPageIsUnregistered = isAdminRole && (showUnregisteredConversations || isSuperAdminAllMailboxView);
  const accountViewPageSource = accountViewPageIsUnregistered
    ? unregisteredInclusiveConversations
    : mailAccountViewConversations;
  const accountViewPageLoaded = accountViewPageSource?.scopeKey === mailAccountViewScopeKey;
  const accountViewNextCursor = accountViewPageLoaded ? accountViewPageSource?.nextCursor ?? null : null;
  const [accountViewLoadingMore, setAccountViewLoadingMore] = useState(false);
  const [accountViewLoadMoreError, setAccountViewLoadMoreError] = useState<{ scopeKey: string; message: string } | null>(null);
  useEffect(() => {
    setAccountViewLoadMoreError((current) => current?.scopeKey === mailAccountViewScopeKey ? current : null);
    if (!accountViewNextCursor) setAccountViewLoadingMore(false);
  }, [accountViewNextCursor, mailAccountViewScopeKey]);
  const handleLoadOlderAccountViewConversations = useCallback(async () => {
    if (!authReady || !canRead || !orgContext || !hasMailboxConversationReadScope || !accountViewNextCursor || accountViewLoadingMore) return;
    const requestScopeKey = mailAccountViewScopeKey;
    setAccountViewLoadingMore(true);
    setAccountViewLoadMoreError(null);
    try {
      const result = await listConversations({
        cursor: accountViewNextCursor,
        mailAccountId: selectedViewMailAccountId,
        ...(accountViewPageIsUnregistered ? { includeUnregistered: true } : {}),
        ...viewAsParams,
      });
      const rows = Array.isArray((result as { rows?: unknown }).rows)
        ? (result as { rows: unknown[] }).rows as Conversation[]
        : [];
      const pageInfo = (result as { pageInfo?: { nextCursor?: unknown } }).pageInfo;
      const nextCursor = typeof pageInfo?.nextCursor === "string" ? pageInfo.nextCursor : null;
      const updateRows = (current: AccountScopedConversationState | null) => {
        if (!current || current.scopeKey !== requestScopeKey) return current;
        const knownIds = new Set(current.rows.map((row) => String(row.id)));
        const additions = rows.filter((row) => {
          const id = String(row.id);
          if (!id || knownIds.has(id)) return false;
          knownIds.add(id);
          return true;
        });
        // 이 시점부터 "이전 대화 더 보기"로 꼬리가 이어붙은 상태다 — headLength(최초 첫 페이지
        //   길이)는 그대로 두고 extendedByLoadMore 만 세운다. reconcileRevalidatedConversations
        //   가 배경 재검증에서 이 두 값으로 꼬리를 지키는 근거가 된다.
        return { ...current, rows: [...current.rows, ...additions], nextCursor, extendedByLoadMore: true };
      };
      if (accountViewPageIsUnregistered) setUnregisteredInclusiveConversations(updateRows);
      else setMailAccountViewConversations(updateRows);
    } catch (error) {
      setAccountViewLoadMoreError({ scopeKey: requestScopeKey, message: errorText(error) });
    } finally {
      setAccountViewLoadingMore(false);
    }
  }, [
    accountViewLoadingMore,
    accountViewNextCursor,
    accountViewPageIsUnregistered,
    authReady,
    canRead,
    hasMailboxConversationReadScope,
    mailAccountViewScopeKey,
    orgContext,
    selectedViewMailAccountId,
    viewAsParams,
  ]);

  // 명시적 클릭(personKey) 이 없고 딥링크(?conversationId=)가 이 방의 갈래를 가리키면 그 사람
  // 방을 연다 — 그렇지 않으면 목록 맨 위 사람으로 조용히 대체돼(옛 기본값) 딥링크가 가리킨
  // 대화 대신 아무 관련 없는 사람이 열린다("silent fallback", chat-draft-prefill.spec.ts S1(d)
  // 가 막으려는 바로 그 결함 클래스).
  // 2026-10-05: a deep-linked conversation that a list filter/search (or a later page) hides from
  // personRoomsVisible is still looked up in the unfiltered rooms, so the selection survives paging
  // and late loads instead of hanging on "불러오는 중".
  const requestedRoomMatches = (room: PersonRoom) => room.strands.some((strand) =>
    chatConversationMatchesSelection(strand, requestedConversationId) || primaryConversationId(strand) === requestedConversationId,
  );
  const requestedPersonKey = requestedConversationId
    ? personRoomsVisible.find(requestedRoomMatches)?.personKey ?? personRooms.find(requestedRoomMatches)?.personKey ?? ""
    : "";
  const effectivePersonKey = tab === "person"
    ? (personKey && personRoomsVisible.some((room) => room.personKey === personKey)
      ? personKey
      // 딥링크가 있는데 어떤 사람 방에도 없으면(오타·삭제된 대화) 목록 맨 위로 조용히 대체하지
      // 않는다 — 대신 비워 둬 아래 targetedMissing 배너가 뜨게 한다(S1(d)).
      : requestedConversationId
        ? requestedPersonKey
        : (personRoomsVisible[0]?.personKey ?? ""))
    : "";
  // 하이드레이션은 **열린 방 하나에만** 건다. 병합 타임라인(mergedMessages)은 이 방에서만 쓰이므로,
  // 여기서 그 방의 갈래(최대 17건)만 다시 묶으면 된다 — 목록 전체 재그룹핑(7,641건)이 사라진다.
  const selectedPersonRoom = useMemo(() => {
    if (!effectivePersonKey) return null;
    const base = personRooms.find((room) => room.personKey === effectivePersonKey);
    if (!base) return null;
    const hydrated = base.strands.map((strand) => withLoadedMessages(strand, threadMessagesById));
    // 같은 사람의 갈래만 넘기므로 방은 하나로 나온다. 혹시 갈리면 키가 일치하는 쪽을 쓴다.
    const rebuilt = groupConversationsByPerson(hydrated);
    return rebuilt.find((room) => room.personKey === base.personKey) ?? rebuilt[0] ?? base;
  }, [effectivePersonKey, personRooms, threadMessagesById]);

  // 방이 "바뀌었는지"를 객체 동일성이 아니라 **갈래 구성**으로 판정한다 — 메시지가 도착해도
  // 이 서명은 안 바뀌므로, 메시지 로딩 effect 가 자기 요청을 스스로 취소하지 않는다.
  const personRoomStrandSignature = useMemo(
    () => (selectedPersonRoom?.strands ?? [])
      .map((strand) => strand.uiThreadKey ?? workflowConversationKey(strand))
      .join("|"),
    [selectedPersonRoom],
  );

  // 방어 리셋(리뷰 처방, W106 REQUEST CHANGES HIGH): selectPersonRoom/selectStrandFilter 같은
  // 명시적 클릭 경로 밖에서 effectivePersonKey 가 바뀌는 경우(검색 필터·실시간 갱신으로 현재
  // 사람이 목록에서 자동으로 빠지는 폴백)도 갈래 상태를 리셋한다. resolvePersonReplyTarget 의
  // 소속 검증이 발송/읽음 오발을 이미 막지만, 이 effect 없이는 화면(칩 바·드롭업)이 여전히
  // 존재하지 않는 갈래를 가리킨 채로 남는다.
  useEffect(() => {
    setStrandFilter("all");
    setReplyTargetStrand("");
    setReplyTargetMenuOpen(false);
  }, [effectivePersonKey]);

  // P-2 답장 대상 결정(부록 규칙 2) — 순수 함수(chat-people.ts)에 위임한다. 갈래 필터/override
  // 둘 다 "이 방 소속 갈래인지" 검증을 거친다(리뷰 처방, W106 REQUEST CHANGES HIGH): 사람이 명시적
  // 클릭 없이 자동 전환돼도(검색 필터·실시간 갱신으로 현재 사람이 목록에서 빠짐) strandFilter/
  // replyTargetStrand 가 이전 사람의 갈래 키를 물고 있을 수 있고, 그 키를 검증 없이 신뢰하면
  // 화면은 새 방인데 발송/읽음/초안이 이전 대화로 새는 사고가 난다.
  const personReplyTarget = selectedPersonRoom
    ? resolvePersonReplyTarget(selectedPersonRoom, strandFilter, replyTargetStrand)
    : null;
  // "새 메일" 선택 중에도 conv 는 항상 실재하는 갈래를 가리켜야 한다(창작자 정보/수신자 템플릿용) —
  // handleDraftSend 가 새 conversationId/threadId 를 별도로 발급한다(§4 L3).
  // 2026-10-05: a deep link (?conversationId=) to a NON-default strand of the room selects that strand
  // until the user picks a strand/filter themselves (otherwise the room default would be selected).
  const requestedStrandKey = requestedConversationId && selectedPersonRoom && strandFilter === "all" && !replyTargetStrand && deepLinkStrandActive
    ? (() => {
        const strand = selectedPersonRoom.strands.find((item) =>
          chatConversationMatchesSelection(item, requestedConversationId) || primaryConversationId(item) === requestedConversationId);
        return strand ? strand.uiThreadKey ?? workflowConversationKey(strand) : "";
      })()
    : "";
  const personTargetStrandKey = requestedStrandKey
    || (personReplyTarget?.kind === "strand" ? personReplyTarget.strandKey : (selectedPersonRoom?.defaultReplyStrand ?? ""));
  // Make the visible reply-target chip/menu follow the deep-linked strand (the user can still change it).
  useEffect(() => {
    if (requestedStrandKey && requestedStrandKey !== selectedPersonRoom?.defaultReplyStrand) setReplyTargetStrand(requestedStrandKey);
  }, [requestedStrandKey, selectedPersonRoom?.defaultReplyStrand]);
  const personStrandTagByKey = useMemo(() => {
    const map = new Map<string, { label: string; kind: WorkflowContextTag["kind"] }>();
    if (!selectedPersonRoom) return map;
    for (const strand of selectedPersonRoom.strands) {
      const key = strand.uiThreadKey ?? workflowConversationKey(strand);
      const tag = workflowContextTagsForConversation(strand, { programs, campaigns })[0];
      if (tag) map.set(key, { label: tag.label, kind: tag.kind });
    }
    return map;
  }, [selectedPersonRoom, programs, campaigns]);

  // W106: 사람 탭에서는 목록 선택이 아니라 답장 대상 갈래가 conv 를 고른다 — 발송/초안/읽음의
  // 기존 conv 기반 배선을 손대지 않고 그대로 태우기 위한 결정이다(§4 L3 최소, 재설계 없음).
  //
  // W109 (리뷰에서 재현된 CRITICAL): 이 조회 대상이 `conversations`/`visible`(기본 탭 스코프,
  // 답장 신호 필수)이면 **콜드 갈래는 애초에 그 목록에 없어서** conv 가 영영 undefined 가 된다.
  // 그러면 아래 `if (!conv)` 조기 return 이 사람 카드 목록(aside)까지 통째로 플레이스홀더로
  // 갈아치워, W109 가 열려는 사람(프로드 7,089명 중 답장 없는 6,926명)이 전부 빈 화면이 된다.
  // 갈래는 이 방 자신의 strands(=personScopeConversations 기반, withLoadedMessages 로 이미
  // 하이드레이트됨)에서 고른다. 다른 사람의 대화로 폴백하지 않는다 — 폴백하면 발송/읽음 배선이
  // 엉뚱한 사람에게 향하므로, 못 찾으면 fail-closed 로 undefined 를 유지한다.
  const personRoomStrands = selectedPersonRoom?.strands ?? EMPTY_CONVERSATIONS;
  const conv = isNewCompose
    ? undefined
    : tab === "person"
    // 사람 탭은 **이 방의 갈래에서만** 고른다. 못 찾으면 fail-closed 로 undefined 를 유지한다.
    // 다른 사람의 대화로 폴백하면 발송·읽음이 화면에 없는 사람에게 향한다 — 실제로 한 번
    // 폴백을 넣었다가 적대 리뷰에서 발송 오발 경로가 재현됐다: composer/handleDraftSend 는
    // `conv` 하나에만 물려 있고 사람 탭 전용 가드가 없어서, 좌측이 "사람이 없습니다"인 상태로
    // 우측 입력창이 검색과 무관한 임의 대화에 살아 있었다. 방이 0개일 때의 탈출구는
    // conv 폴백이 아니라 아래 플레이스홀더 안의 "검색어 지우기" 버튼으로 푼다.
    ? selectChatConversationForView(personRoomStrands, personRoomStrands, personTargetStrandKey, { requireExactSelection: true })
    // W114-E 후속 [리뷰어 A BLOCKER, 수리] → [리뷰어 A 재검증 HIGH, 재현됨 → 재수리]:
    //   flatPersonRows 는 tabScoped(검색 전)에서 묶이므로 room.defaultReplyStrand 가 검색어에
    //   매치되지 않는 갈래일 수 있다(그게 W114-E 수리의 의도다 — 방의 갈래 중 하나만 매치돼도
    //   방 전체를 남긴다). 행 클릭은 URL 을 안 바꿔 requestedConversationId 가 항상 falsy 라
    //   requireExactSelection:false 로 떨어지므로, 후보 풀이 `visible`(검색 후) 그대로면
    //   defaultReplyStrand 가 거기 없어 클릭한 대화가 안 열렸다(BLOCKER) — 그래서 처음엔 후보
    //   풀 전체를 tabScoped(검색 전)로 넓혔다.
    //
    //   그런데 그 확대가 **모든 호출**(클릭이든 아니든)에 적용돼 새 HIGH 를 열었다: 사람 탭에서
    //   자동 선택된 selectedId 를 들고 검색 유지한 채 flat 탭으로 전환하면, 그 stale selectedId
    //   가 새 탭의 tabScoped 에는 없지만(다른 스코프 출신이니 당연하다) tabScoped 자체는 탭
    //   필터만 걸려 거의 항상 비지 않는다 — 그래서 옛 안전판(풀이 비면 전체 conversations 에서
    //   정확히 일치하는 것만 재탐색하는 3단 폴백)이 아니라 "풀이 비지 않으면 그냥 풀[0] 반환"하는
    //   얕은 폴백이 발동해, 검색·클릭 어느 것과도 무관한 그 탭의 최신 대화(타인)가 열렸다.
    //
    //   수리(리뷰어 A 지시, (a)+(c) 둘 다):
    //   (a) 넓은 풀(tabScoped)은 **"지금 이 탭에서 방금 명시적으로 클릭한 키"일 때만** 쓴다
    //       (lastFlatClick, selectConversation 이 찍는다·아래). 그 밖의 해소(탭 전환으로 넘어온
    //       stale selectedId 등)는 옛 좁은 풀(visible)로 돌아간다 — 그러면 위 문단의 안전한
    //       3단 폴백을 다시 타 타인으로 새지 않는다.
    //   (c) 그 결과를 flatPersonRows(왼쪽 목록이 실제로 그리는 것과 같은 스코프)에 대한 멤버십
    //       게이트(gateFlatTabConversation, 위)로 한 번 더 거른다 — (a)로도 못 막는 **다음
    //       폴백 경로**가 또 열리더라도, 왼쪽 목록에 없는 대화는 오른쪽에 절대 안 뜨게 하는
    //       구조적 마감이다.
    : gateFlatTabConversation(
        selectChatConversationForView(
          conversations,
          !requestedConversationId && lastFlatClick?.tab === tab && lastFlatClick?.key === selectedId
            ? tabScoped
            : visible,
          requestedConversationId || selectedId,
          { requireExactSelection: Boolean(requestedConversationId) },
        ),
        flatPersonRows,
        flatPersonRoomsAll.length === 0,
      );
  useEffect(() => {
    if (!conv || visible.length === 0) return;
    const nextSelectedId = conv.uiThreadKey ?? workflowConversationKey(conv);
    if (nextSelectedId !== selectedId) setSelectedId(nextSelectedId);
  }, [conv, selectedId, visible]);
  // S1(d)/P1: a targeted-load (e.g. coldmail history "열기" landing) that resolved to
  // "missing" must not be allowed to silently sit on whatever `conv` fell back to —
  // this drives an explicit banner instead of the previous no-op.
  const targetedMissing = Boolean(requestedConversationId)
    && targetedConversationStatus.id === requestedConversationId
    && targetedConversationStatus.scopeKey === mailAccountViewScopeKey
    && targetedConversationStatus.state === "missing"
    && !conv;
  const selectedConversationKey = conv ? conv.uiThreadKey ?? workflowConversationKey(conv) : "";
  const selectedConversationId = conv ? primaryConversationId(conv) : "";
  const selectedAttributionConversationId = conv?.attributionOwnerConversationId || selectedConversationId || conv?.id || "";
  const selectedThreadId = conv?.threadId ?? conv?.id ?? "";
  const selectedMessages = conv
    ? normalizeMessages(threadMessagesById[selectedConversationKey] ?? conv.messages, selectedConversationKey)
      .sort((left, right) => messageEventMillis(left) - messageEventMillis(right) || left.id.localeCompare(right.id))
    : [];
  const composeReplySourceKey = conv ? latestCreatorMessageRef(selectedMessages, conv) : "";
  // 2026-10-05: an empty list before the messages arrive is "불러오는 중", not "0 messages".
  const selectedMessagesLoading = Boolean(conv) && selectedMessages.length === 0 && !loadedMessageKeys.has(selectedConversationKey);
  // The selected conversation key alone is not an identity boundary: no-thread compose always has
  // an empty key, and the same thread key can be visible after an account or ViewAs switch. Keep
  // the mailbox/auth/mode/source dimensions in one scope so draft and async-result state cannot
  // cross those transitions. The account-view envelope itself is deliberately not used as the
  // composer boundary: policy polling temporarily clears it and its Peoply/status metadata can
  // change while the effective view and selected sender grant remain unchanged.
  const composePolicyIdentityKey = JSON.stringify([
    authScopeKey ?? "",
    authScopeGeneration,
    authUser?.tenantId ?? "",
    authUser?.uid ?? "anonymous",
    viewAsUserIdForScope || "self",
    viewAsEmailForScope || "",
  ]);
  const composePolicyIdentityRef = useRef(composePolicyIdentityKey);
  const composeViewIdentityRef = useRef<{ viewMode: string; viewMailAccountId: string } | null>(null);
  const composeLastKnownSenderIdRef = useRef<string | null>(null);
  if (composePolicyIdentityRef.current !== composePolicyIdentityKey) {
    composePolicyIdentityRef.current = composePolicyIdentityKey;
    composeViewIdentityRef.current = null;
    composeLastKnownSenderIdRef.current = null;
  }
  const currentComposeViewIdentity = {
    viewMode: selectedSuperAdminMailbox || isSuperAdminAllMailboxView ? "super_admin" : selectedMailAccountView ?? "",
    viewMailAccountId: selectedViewMailAccountId || "",
  };
  if (orgContext) composeViewIdentityRef.current = currentComposeViewIdentity;
  const composeViewIdentity = composeViewIdentityRef.current ?? currentComposeViewIdentity;
  if (orgContext && selectedSenderId && selectedSender) {
    // Preserve the last concrete selection while org policy is unresolved. A later policy
    // response can then distinguish a real lost sender grant from a transient null context.
    composeLastKnownSenderIdRef.current = selectedSenderId;
  }
  const selectedSenderPermission = composeLastKnownSenderIdRef.current
    && orgContext
    && !usableSenderAccounts.some((account) => account.accountId === composeLastKnownSenderIdRef.current)
    ? "revoked"
    : "authorized";
  const composePolicyScopeKey = chatComposeEffectivePolicyKey({
    identityScopeKey: composePolicyIdentityKey,
    viewMode: composeViewIdentity.viewMode,
    viewMailAccountId: composeViewIdentity.viewMailAccountId,
    selectedSenderPermission,
  });
  const composeScopeKey = chatComposeScopeKey({
    authScopeKey,
    authScopeGeneration,
    mailAccountViewScopeKey: composePolicyScopeKey,
    isNewCompose,
    conversationKey: selectedConversationKey,
    replySourceKey: composeReplySourceKey,
    requestedMessageRef,
  });
  const replyTargetResetBoundaryKey = JSON.stringify([
    "person-reply-target-boundary-v1",
    composePolicyScopeKey,
    isNewCompose ? "new" : "reply",
    tab === "person" ? effectivePersonKey : "",
    tab === "person" ? personRoomStrandSignature : "",
  ]);
  const composeScopeKeyRef = useRef(composeScopeKey);
  composeScopeKeyRef.current = composeScopeKey;
  const previousComposeScopeKeyRef = useRef<string | null>(null);
  const previousReplyTargetResetBoundaryKeyRef = useRef<string | null>(null);
  const composeScopeGenerationRef = useRef(0);
  const composePreviewRequestGenerationRef = useRef(0);
  const composeSendRequestGenerationRef = useRef(0);
  const composeReceiveRequestGenerationRef = useRef(0);
  const composeAiDraftRequestGenerationRef = useRef(0);
  const composePolicyPendingRef = useRef(!orgContext);
  const composeScopeResetKeyRef = useRef<string | null>(null);
  const preserveStandaloneSendStatusForInputResetRef = useRef(false);
  const requestedMessageIndex = messageIndexForRoute(selectedMessages, requestedMessageRef);
  const requestedMessageMissing = Boolean(
    requestedMessageRef && selectedConversationKey && loadedMessageKeys.has(selectedConversationKey) && requestedMessageIndex < 0,
  );
  const selectedProfile = conv ? conversationProfile(conv, creators) : undefined;
  const selectedContextTags = conv ? workflowContextTagsForConversation(conv, { programs, campaigns }) : [];
  const selectedPrimaryRoute = conv ? classifyChatPrimaryRoute(conv, campaignsById) : null;
  const selectedFeedbackScope = selectedPrimaryRoute?.primaryBucket === "program"
    && selectedPrimaryRoute.programId
    && selectedPrimaryRoute.campaignId
    ? {
        programId: resolveCanonicalProgramId(selectedPrimaryRoute.programId),
        campaignId: selectedPrimaryRoute.campaignId,
        locale: "und",
      }
    : selectedPrimaryRoute?.primaryBucket === "direct"
      ? { globalScope: "global" as const, locale: "und" }
      : null;
  const attributionProgramOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const program of programs) {
      const id = resolveCanonicalProgramId(program.id);
      if (id) options.set(id, program.title || id);
    }
    for (const group of programGroups) {
      const id = resolveCanonicalProgramId(group.programId);
      if (id && !options.has(id)) options.set(id, group.title || id);
    }
    return [...options.entries()].map(([id, title]) => ({ id, title }));
  }, [programGroups, programs]);
  const attributionCampaignOptions = campaigns.filter(
    (campaign) => resolveCanonicalProgramId(campaign.programId) === attributionProgramId,
  );
  const currentAttributionLabel = selectedPrimaryRoute?.primaryBucket === "program"
    ? [
        attributionProgramOptions.find((program) => program.id === resolveCanonicalProgramId(selectedPrimaryRoute.programId))?.title
          || selectedPrimaryRoute.programId
          || "프로그램",
        campaignsById.get(selectedPrimaryRoute.campaignId || "")?.name || selectedPrimaryRoute.campaignId,
      ].filter(Boolean).join(" / ")
    : "Direct";
  const canRevertAttribution = Boolean(
    conv && (
      (lastAttributionChange?.conversationId === selectedAttributionConversationId && lastAttributionChange.auditRef)
      || conv.lastAttributionAuditRef
    ),
  );
  // 에스컬레이션 배너의 "검수 열기" 목적지. 메일 검수 큐를 이 대화의 귀속으로 좁혀서 연다.
  // 프로그램/신청 근거가 하나도 없으면 링크를 만들지 않는다(아무 데나 보내지 않는다).
  const reviewQueueProgramId = resolveCanonicalProgramId(conv?.canonicalProgramId || conv?.programId || "");
  const reviewQueueHref = conv && (reviewQueueProgramId || conv.applicationId)
    ? externalFluHref(buildReviewHref({
        kind: "mail",
        applicationId: conv.applicationId || undefined,
        programId: reviewQueueProgramId || undefined,
        campaignId: conv.campaignId || undefined,
      }))
    : "";
  const creator = selectedProfile?.creator;
  const selectedParticipationStage = conv ? conversationParticipationStage(conv, creator) : undefined;
  // W111 (헤세): 사람 탭에서는 **갈래가 아니라 사람** 기준으로 표시한다. 갈래마다 프로필 충실도가
  //   달라서(포털 갈래는 아바타가 없고 이름 자리에 이메일이 들어 있다) 갈래를 바꿀 때마다 같은
  //   사람의 얼굴·이름이 바뀌어 보였다. 방 프로필은 갈래들을 훑어 있는 값을 모아두므로 그걸 덮어쓴다.
  //   ⚠️ selectedProfile 자체는 건드리지 않는다 — replyRecipientFor 가 그걸로 **수신자**를 해석하므로
  //   표시 통일이 발송 대상을 바꾸면 안 된다. 여기서 바꾸는 건 표시용 파생값뿐이다.
  //   (displayName 은 메일 제목·creatorName 에도 쓰인다: 종전엔 제목에 이메일 주소가 그대로 박혔고
  //    이제 실제 이름이 들어간다 — 같은 사람이고 더 정확한 표기다.)
  // W114-C: person 탭은 콜드 포함 전체 스코프 방 프로필(selectedPersonRoom, 기존과 동일)을 쓰고,
  // 나머지 탭은 위에서 만든 가벼운 conversationPersonProfileByKey 로 같은 union 을 받는다 —
  // "다른 탭에서도 사람 탭처럼 다 해야 한다"(헤세). replyRecipientFor 등 수신자 해석은 여전히
  // selectedProfile(갈래 기준)만 본다 — 이 값은 표시 전용이라 발송 대상엔 영향 없다.
  const personProfile = tab === "person"
    ? selectedPersonRoom?.profile
    : (conv ? conversationPersonProfileByKey.get(personIdentityKey(conv)) : undefined);
  const displayName = personProfile?.name ?? selectedProfile?.name ?? "알 수 없는 채널";
  const displayAvatar = personProfile?.avatar ?? selectedProfile?.avatar ?? displayName;
  const displayHandle = personProfile?.handle ?? selectedProfile?.handle ?? personProfile?.email ?? selectedProfile?.email;
  const displayEmail = personProfile?.email ?? selectedProfile?.email;
  // C: platform/followers 는 지금까지 어느 렌더 경로에서도 personProfile 쪽을 읽지 않아 union 이
  // 전혀 반영되지 않았다(단일 갈래 selectedProfile.meta만 쓰였다) — 헤더 meta 줄에 union 결과를
  // 연결한다. "데이터가 있으면 더 보여주고 없으면 덜 보여준다": 값이 둘 다 없으면 formatProfileMeta
  // 가 빈 문자열을 내고, 아래 렌더 쪽의 기존 `{... && (...)}` 가드가 그 줄 자체를 그리지 않는다.
  const displayPlatform = personProfile?.platform ?? selectedProfile?.platform;
  const displayFollowers = personProfile?.followers ?? selectedProfile?.followers;
  const displayMeta = formatProfileMeta(displayPlatform, displayFollowers);
  const [aiOn, setAiOn] = useState(conv?.aiActive ?? false);
  // 사람 개입(manualIntervention.status="open")이 열려 있으면 서버 자동회신 게이트가
  // aiActive 와 무관하게 막는다(chat-ai.conversationTakenOverByHuman). 그 상태에서 토글을
  // 켜 두면 화면이 거짓말을 하므로 토글 자체를 잠근다.
  const humanTakeoverOpen = conv?.manualIntervention?.status === "open";
  const effectiveAiOn = globalAutoReplyEnabled && aiOn && !humanTakeoverOpen;
  // 서버 ingest 결과와 명시적 운영자 액션 결과는 대화별 슬롯으로 격리한다. 대화를 여는 것만으로
  // LLM을 호출하지 않으며, 다른 대화에서 늦게 끝난 결과도 현재 화면으로 새지 않는다.
  const draftActionForConv = draftActionByKey[selectedConversationKey] ?? IDLE_DRAFT_ACTION;
  const readActionForConv = readActionByKey[selectedConversationKey] ?? IDLE_READ_ACTION;
  const effectiveBlockedReason = conv?.autoReplyBlockedReason || draftActionForConv.blockedReason;
  const effectiveHumanDraftSuggestion = conv?.humanDraftSuggestion || draftActionForConv.humanDraftSuggestion;
  // W98: 초안 한국어 요지 — 저장 필드 우선, 재생성 직후엔 액션 결과 사용.
  const effectiveHumanDraftSuggestionKr = conv?.humanDraftSuggestionKr || draftActionForConv.humanDraftSuggestionKr;
  // R5-E: Infly DB 기존 연락처(콜드아웃리치 억제, mail-safety.infly-overlap)와 다른 초안 미생성
  // 사유를 배너에서 구분 표시하기 위한 판별값. 정책·억제 로직은 그대로이며 표시만 갈린다.
  const effectiveBlockedReasonIsInflyOverlap = isInflyOverlapBlockedReason(effectiveBlockedReason);
  // W32-B: 초안 존재(humanDraftSuggestion)와 자동 발송 가능 여부는 별개다 — 배너 제목을 분리한다.
  const hasDraftAlongsideBlockedReason = Boolean(effectiveHumanDraftSuggestion);
  const effectiveBlockedReasonIsLowEvidence = isLowEvidenceBlockedReason(effectiveBlockedReason);

  useEffect(() => {
    if (!conv) return;
    const suggestedProgramId = resolveCanonicalProgramId(conv.attribution?.suggested?.programId);
    const currentProgramId = selectedPrimaryRoute?.primaryBucket === "program"
      ? resolveCanonicalProgramId(selectedPrimaryRoute.programId)
      : "";
    const nextProgramId = suggestedProgramId || currentProgramId || resolveCanonicalProgramId(programs[0]?.id);
    setAttributionProgramId(nextProgramId);
    setAttributionCampaignId(
      conv.attribution?.suggested?.campaignId || selectedPrimaryRoute?.campaignId || "",
    );
    setAttributionReason("");
    // W99(헤세): 리뷰 필요 시 자동으로 열리던 귀속 편집기도 Chat 에서는 닫아둔다 — 관리 일원화.
    setAttributionEditorOpen(false);
    setAttributionNotice("");
    setLastAttributionChange(
      conv.lastAttributionAuditRef
        ? {
            conversationId: selectedAttributionConversationId,
            auditRef: conv.lastAttributionAuditRef,
            version: conv.attribution?.version ?? 0,
          }
        : null,
    );
  }, [selectedAttributionConversationId, selectedConversationKey, conv?.attribution?.version, conv?.lastAttributionAuditRef]);

  useEffect(() => {
    if (isNewCompose || !requestedConversationId || conversations.length === 0) return;
    const requested = conversations.find((conversation) =>
      chatConversationMatchesSelection(conversation, requestedConversationId) ||
      primaryConversationId(conversation) === requestedConversationId,
    );
    if (!requested) return;
    const nextSelectedId = requested.uiThreadKey ?? workflowConversationKey(requested);
    if (nextSelectedId && selectedId !== nextSelectedId) setSelectedId(nextSelectedId);
  }, [conversations, isNewCompose, requestedConversationId, selectedId]);

  useEffect(() => {
    if (isNewCompose || !requestedConversationId || !authReady || !canRead || !conversationsLoaded) return;
    const alreadyLoaded = conversations.some((conversation) =>
      chatConversationMatchesSelection(conversation, requestedConversationId) ||
      primaryConversationId(conversation) === requestedConversationId,
    );
    if (alreadyLoaded) return;
    // A dependency change cancels the previous invocation. Its loading status must not
    // suppress a replacement read when this same mailbox becomes ready again.
    if (targetedConversationStatus.id === requestedConversationId && targetedConversationStatus.scopeKey === mailAccountViewScopeKey && ["done", "missing"].includes(targetedConversationStatus.state)) return;
    if (!hasMailboxConversationReadScope) {
      setTargetedConversationStatus({ id: requestedConversationId, scopeKey: mailAccountViewScopeKey, state: "missing" });
      return;
    }
    let cancelled = false;
    setTargetedConversationStatus({ id: requestedConversationId, scopeKey: mailAccountViewScopeKey, state: "loading" });
    void listConversations({
      ids: [requestedConversationId],
      limit: 1,
      mailAccountId: selectedViewMailAccountId,
      ...(isAdminRole && (isSuperAdminAllMailboxView || showUnregisteredConversations) ? { includeUnregistered: true } : {}),
      ...viewAsParams,
    })
      .then((result) => {
        if (cancelled) return;
        const rows = Array.isArray((result as { rows?: unknown }).rows) ? (result as { rows: unknown[] }).rows : [];
        if (rows.length === 0) {
          setTargetedConversationStatus({ id: requestedConversationId, scopeKey: mailAccountViewScopeKey, state: "missing" });
          return;
        }
        const next = normalizeConversations(rows).filter(isDefaultChatConversation);
        if (next.length === 0) {
          setTargetedConversationStatus({ id: requestedConversationId, scopeKey: mailAccountViewScopeKey, state: "missing" });
          return;
        }
        // A separately scoped target survives first-page revalidation and either list's
        // initialization order without changing pagination boundaries.
        setTargetedMailboxConversations({ scopeKey: mailAccountViewScopeKey, rows: next });
        mutate((prev) => ({
          ...prev,
          conversations: [
            ...next,
            ...prev.conversations.filter((conversation) => !next.some((item) => item.id === String(conversation.id))),
          ],
        }));
        setTargetedConversationStatus({ id: requestedConversationId, scopeKey: mailAccountViewScopeKey, state: "done" });
      })
      .catch(() => {
        if (!cancelled) setTargetedConversationStatus({ id: requestedConversationId, scopeKey: mailAccountViewScopeKey, state: "missing" });
      });
    return () => {
      cancelled = true;
    };
  // targetedConversationStatus and conversations are intentionally excluded from this
  // effect's deps (verified via runtime instrumentation, not just review):
  // - targetedConversationStatus: this effect is its sole writer (setTargetedConversationStatus
  //   above). Including it makes the "idle"→"loading" update re-run the effect immediately.
  // - conversations: the array reference returned by useLiveConversations/useMemo above churns
  //   on unrelated re-renders in production builds (confirmed empirically — the built server
  //   reproduces this, dev mode's timing happened to mask it), so keeping it as a dep re-runs
  //   the effect on renders that carry no new conversation data too.
  // Either dependency re-running this effect fires React's automatic cleanup for the PREVIOUS
  // invocation (React always cleans up before re-running an effect, even if the new invocation
  // then no-ops), which flips `cancelled` to true on the in-flight fetch's closure — so the
  // resolved "missing"/"done" result is silently discarded and the UI is stuck on the default
  // conversation with no banner (S1(d) missing-banner regression). The effect still reads the
  // latest `conversations`/`targetedConversationStatus` via closure on every render it's
  // actually allowed to re-run for (requestedConversationId/authReady/canRead/conversationsLoaded
  // changes), so the guards above stay correct without needing either as a re-run trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, canRead, conversationsLoaded, hasMailboxConversationReadScope, isAdminRole, isNewCompose, isSuperAdminAllMailboxView, mailAccountViewScopeKey, mutate, requestedConversationId, selectedViewMailAccountId, showUnregisteredConversations]);

  useEffect(() => {
    if (tab !== "campaign") setProgramDrilldownId(null);
  }, [tab]);

  useEffect(() => {
    if (programDrilldownId && !selectedProgramGroup) setProgramDrilldownId(null);
  }, [programDrilldownId, selectedProgramGroup]);

  // 선택 대화가 바뀌면 토글을 해당 대화의 기본값으로 동기화.
  // 렌더 중 setState는 선택 직후 한 프레임을 버리게 만들어 chat 상세 영역 깜빡임을 유발한다.
  useEffect(() => {
    if (!conv) return;
    setAiOn(conv.aiActive);
  }, [conv?.aiActive, selectedConversationKey]);

  const defaultRecipient = conv
    ? replyRecipientFor(conv, creator, selectedProfile, selectedMessages)
    : "";
  const [composeRecipient, setComposeRecipient] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const composeRecipientScopeKeyRef = useRef<string | null>(null);
  const [composeScopeResetVersion, setComposeScopeResetVersion] = useState(0);

  const [draft, setDraft] = useState("");
  const [aiDraftModalOpen, setAiDraftModalOpen] = useState(false);
  const [aiDraftInstruction, setAiDraftInstruction] = useState("");
  const [aiDraftPreview, setAiDraftPreview] = useState<{
    text: string;
    summaryKr?: string;
    decision?: string;
    blockedReason?: string;
  } | null>(null);
  const [overwrittenDraftBackup, setOverwrittenDraftBackup] = useState("");
  const aiDraftModalPanelRef = useRef<HTMLDivElement>(null);
  const aiDraftInstructionRef = useRef<HTMLTextAreaElement>(null);
  const selectedConversationKeyRef = useRef(selectedConversationKey);
  selectedConversationKeyRef.current = selectedConversationKey;
  const draftLatestRef = useRef("");
  const draftComposerStateRef = useRef({ conversationKey: "", dirty: false, appliedSavedDraft: "" });
  const autoPrefillKeysRef = useRef(new Set<string>());
  const drafting = draftActionForConv.status === "loading";

  const setDraftBody = useCallback((nextDraft: string) => {
    draftLatestRef.current = nextDraft;
    setDraft(nextDraft);
  }, []);

  const clearStaleDraftAction = useCallback((requestKey: string) => {
    setDraftActionByKey((prev) => {
      if (prev[requestKey]?.status !== "loading") return prev;
      const next = { ...prev };
      delete next[requestKey];
      return next;
    });
  }, []);

  const invalidateAiDraftRequest = useCallback(() => {
    composeAiDraftRequestGenerationRef.current += 1;
    clearStaleDraftAction(selectedConversationKeyRef.current);
  }, [clearStaleDraftAction]);

  // 대화 전환 시 이전 대화의 "참고용 초안 사용" 확인 UI가 새 대화로 새지 않게 리셋.
  useEffect(() => {
    setPendingHumanDraftUse(false);
    setAiDraftModalOpen(false);
    setAiDraftInstruction("");
    setAiDraftPreview(null);
    setOverwrittenDraftBackup("");
  }, [selectedConversationKey]);

  useEffect(() => {
    if (!aiDraftModalOpen) return undefined;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const releaseScrollLock = acquireBodyScrollLock();
    window.requestAnimationFrame(() => aiDraftInstructionRef.current?.focus());

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setAiDraftModalOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(aiDraftModalPanelRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])",
      ) ?? []);
      if (focusable.length === 0) {
        event.preventDefault();
        aiDraftModalPanelRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      releaseScrollLock();
      previouslyFocused?.focus?.();
    };
  }, [aiDraftModalOpen]);

  function useHumanDraftSuggestion(text: string) {
    if (!text) return;
    draftComposerStateRef.current.dirty = true;
    setDraftBody(text);
    setPendingHumanDraftUse(false);
  }

  const [sending, setSending] = useState(false);
  const canSendMail = currentRole === "super_admin" || currentRole === "admin" || currentRole === "manager";
  const canComposeSend = canSendMail && !senderBlocked;
  const composeSendBlockedMessage = !canSendMail
    ? "현재 역할은 메일 발송 권한이 없습니다. Manager 이상 계정에서 발송하세요."
    : senderBlockedMessage;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewEmailDraftEnvelope | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [humanRequesting, setHumanRequesting] = useState(false);
  const [aiToggleSaving, setAiToggleSaving] = useState(false);
  const [receiveResult, setReceiveResult] = useState<ReceiveEmailResult | null>(null);
  const [actionError, setActionError] = useState("");
  const [standaloneSendResult, setStandaloneSendResult] = useState<{ conversationId: string } | null>(null);
  // W117: 발송은 됐지만 억제 예외(예: infly-overlap 수동 답장)가 적용됐을 때 보여주는 경고 배지.
  const [sendSuppressionWarning, setSendSuppressionWarning] = useState("");
  const [messageLoadError, setMessageLoadError] = useState("");
  const [mailSafetyStatus, setMailSafetyStatus] = useState<MailSafetyStatusEnvelope | null>(null);

  // A policy refresh invalidates in-flight work, but it does not create a new composer scope.
  // Keep the draft/preview/result visible while the server revalidates the same identity; stop
  // only the transient request indicators so a late response cannot write into a pending policy.
  useEffect(() => {
    const policyPending = !orgContext;
    const wasPolicyPending = composePolicyPendingRef.current;
    composePolicyPendingRef.current = policyPending;
    if (!policyPending || wasPolicyPending) return;

    composePreviewRequestGenerationRef.current += 1;
    composeSendRequestGenerationRef.current += 1;
    composeReceiveRequestGenerationRef.current += 1;
    invalidateAiDraftRequest();
    setPreviewLoading(false);
    setSending(false);
    setReceiving(false);
  }, [invalidateAiDraftRequest, orgContext]);

  // Account/identity/ViewAs/mailbox or new/reply/source changes start a new composer instance.
  // Reset it before any default-recipient/saved-draft effect can repopulate values from the old
  // render. The reset version lets those effects run once more after the boundary is committed,
  // so a newly loaded conversation may contribute only its own current saved draft.
  useEffect(() => {
    const previousScopeKey = previousComposeScopeKeyRef.current;
    const previousReplyTargetBoundaryKey = previousReplyTargetResetBoundaryKeyRef.current;
    previousComposeScopeKeyRef.current = composeScopeKey;
    previousReplyTargetResetBoundaryKeyRef.current = replyTargetResetBoundaryKey;
    if (previousScopeKey === null || previousScopeKey === composeScopeKey) return;
    const shouldResetReplyTarget = previousReplyTargetBoundaryKey !== replyTargetResetBoundaryKey;

    composeScopeGenerationRef.current += 1;
    composePreviewRequestGenerationRef.current += 1;
    composeSendRequestGenerationRef.current += 1;
    composeReceiveRequestGenerationRef.current += 1;
    composeAiDraftRequestGenerationRef.current += 1;
    composeScopeResetKeyRef.current = composeScopeKey;
    preserveStandaloneSendStatusForInputResetRef.current = false;
    composeRecipientScopeKeyRef.current = null;
    draftLatestRef.current = "";
    draftComposerStateRef.current = { conversationKey: "", dirty: false, appliedSavedDraft: "" };
    autoPrefillKeysRef.current.clear();
    setComposeScopeResetVersion((version) => version + 1);
    setComposeRecipient("");
    setComposeSubject("");
    setDraftBody("");
    setPendingHumanDraftUse(false);
    setAiDraftModalOpen(false);
    setAiDraftInstruction("");
    setAiDraftPreview(null);
    setOverwrittenDraftBackup("");
    setDraftActionByKey({});
    setReadActionByKey({});
    setPreviewOpen(false);
    setPreviewLoading(false);
    setPreviewData(null);
    setStandaloneSendResult(null);
    setSending(false);
    setActionError("");
    setSendSuppressionWarning("");
    setMessageLoadError("");
    setReceiveResult(null);
    if (shouldResetReplyTarget) {
      setReplyTargetStrand("");
      setReplyTargetMenuOpen(false);
    }
    setTargetedConversationStatus({ id: "", scopeKey: "", state: "idle" });
  }, [composeScopeKey, replyTargetResetBoundaryKey, setDraftBody]);

  useEffect(() => {
    if (composeScopeResetKeyRef.current === composeScopeKey) return;
    if (composeRecipientScopeKeyRef.current === composeScopeKey) return;
    composeRecipientScopeKeyRef.current = composeScopeKey;
    setComposeRecipient(defaultRecipient);
  }, [composeScopeResetVersion, composeScopeKey, defaultRecipient]);

  // 대화가 바뀌면 이전 작성 내용을 먼저 격리하고, 서버 자동 초안이 늦게 도착해도
  // 사용자가 아직 편집하지 않은 작성창에만 채운다.
  useEffect(() => {
    const savedDraft = conv?.autoReplyStatus === "draft_only"
      ? stringValue(conv.autoReplyDraftText)
      : "";
    const composerState = draftComposerStateRef.current;
    if (composerState.conversationKey !== composeScopeKey) {
      draftComposerStateRef.current = {
        conversationKey: composeScopeKey,
        dirty: false,
        appliedSavedDraft: savedDraft,
      };
      setDraftBody(savedDraft);
      return;
    }
    if (!composerState.dirty && savedDraft && savedDraft !== composerState.appliedSavedDraft) {
      composerState.appliedSavedDraft = savedDraft;
      setDraftBody(savedDraft);
    }
  }, [composeScopeResetVersion, composeScopeKey, conv?.autoReplyDraftText, conv?.autoReplyStatus, setDraftBody]);

  // 2026-10-05 "작성창으로 가져오기" (/chat/auto 검토 보드): a template staged in sessionStorage for
  // exactly this conversation + one-time nonce (?prefill=) is put into the composer ONCE. Nothing is
  // saved or sent — the human edits and sends with the existing permissions and gates. Unsaved text
  // is never silently replaced. The board prefill also suppresses this scope's automatic AI draft.
  const boardPrefillNonce = searchParams.get("prefill") ?? "";
  const boardPrefillAppliedScopeRef = useRef<string | null>(null);
  // A review-board hand-off is review-only: the deep-link auto mark-read below is skipped for it
  // (ordinary deep links keep marking read as before).
  const boardHandoffTargetRef = useRef(boardPrefillNonce ? requestedConversationId : "");
  useEffect(() => {
    if (!boardPrefillNonce || !conv || !requestedConversationId) return;
    // The staged id may be a non-representative member of a merged thread.
    if (selectedConversationId !== requestedConversationId && !chatConversationMatchesSelection(conv, requestedConversationId)) return;
    // Consume only once this conversation's messages loaded SUCCESSFULLY: the reply-source part of the
    // compose scope (composeReplySourceKey) settles then, so the scope reset can no longer clear it.
    if (!succeededMessageKeys.has(selectedConversationKey) || messageLoadError) return;
    const entry = consumeComposerPrefill(requestedConversationId, boardPrefillNonce);
    const params = new URLSearchParams(window.location.search);
    params.delete("prefill");
    const search = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`);
    if (!entry) return;
    const current = draftLatestRef.current.trim();
    if (current && current !== entry.text.trim() && !window.confirm("작성 중인 내용을 선택한 템플릿으로 바꿀까요?")) return;
    boardPrefillAppliedScopeRef.current = composeScopeKey;
    draftComposerStateRef.current.dirty = true;
    setDraftBody(entry.text);
  }, [boardPrefillNonce, composeScopeKey, conv, messageLoadError, requestedConversationId, selectedConversationId, selectedConversationKey, setDraftBody, succeededMessageKeys]);

  // Consume the one render in which the scope reset suppresses default values. This is deliberately
  // after the recipient/draft effects so the reset cannot be overwritten by their old closure.
  useEffect(() => {
    if (composeScopeResetKeyRef.current === composeScopeKey) {
      composeScopeResetKeyRef.current = null;
    }
  }, [composeScopeKey, composeScopeResetVersion]);

  // A preview is an approval aid for the exact current inputs. Sender, recipient, subject, or
  // body edits invalidate it while preserving the draft itself, so a late response cannot look
  // like it belongs to a different authorized sender.
  const composePreviewInputKey = JSON.stringify([
    composeScopeKey,
    selectedSenderId,
    composeRecipient.trim(),
    composeSubject.trim(),
    draft.trim(),
  ]);
  const previousComposePreviewInputKeyRef = useRef(composePreviewInputKey);
  const composePreviewInputKeyRef = useRef(composePreviewInputKey);
  composePreviewInputKeyRef.current = composePreviewInputKey;
  const composeAiDraftInputKey = JSON.stringify([
    composePreviewInputKey,
    aiDraftInstruction.trim().slice(0, 500),
  ]);
  const previousComposeAiDraftInputKeyRef = useRef(composeAiDraftInputKey);
  const composeAiDraftInputKeyRef = useRef(composeAiDraftInputKey);
  composeAiDraftInputKeyRef.current = composeAiDraftInputKey;
  useEffect(() => {
    const previousInputKey = previousComposeAiDraftInputKeyRef.current;
    previousComposeAiDraftInputKeyRef.current = composeAiDraftInputKey;
    if (previousInputKey === composeAiDraftInputKey) return;
    invalidateAiDraftRequest();
  }, [composeAiDraftInputKey, invalidateAiDraftRequest]);
  useEffect(() => {
    const previousInputKey = previousComposePreviewInputKeyRef.current;
    previousComposePreviewInputKeyRef.current = composePreviewInputKey;
    if (previousInputKey === composePreviewInputKey) return;
    composePreviewRequestGenerationRef.current += 1;
    setPreviewOpen(false);
    setPreviewLoading(false);
    setPreviewData(null);
    setActionError("");
    if (preserveStandaloneSendStatusForInputResetRef.current) {
      // The standalone success handler clears the old inputs to open a fresh draft. Preserve its
      // returned conversation link and warning for that programmatic reset only.
      preserveStandaloneSendStatusForInputResetRef.current = false;
    } else {
      setStandaloneSendResult(null);
      setSendSuppressionWarning("");
    }
  }, [composePreviewInputKey]);

  const receiveLabel = receiving
    ? "받은편지함 확인 중"
    : receiveResult?.queueState === "no_new_mail"
      ? "새 메일 없음"
      : "받은편지함 새로고침";
  const mailAccountViewLoaded = Boolean(
    mailAccountViewConversations?.scopeKey === mailAccountViewScopeKey,
  );
  const mailAccountViewFailed = mailAccountViewError?.scopeKey === mailAccountViewScopeKey;
  const unregisteredViewLoaded = Boolean(
    unregisteredInclusiveConversations?.scopeKey === mailAccountViewScopeKey,
  );
  const unregisteredViewFailed = unregisteredInclusiveError?.scopeKey === mailAccountViewScopeKey;
  // Mailbox-scoped rows are fail-closed while the policy context or the selected account query
  // is pending. A failed/empty personal view must remain an explicit empty state so the user can
  // switch back to an authorized shared mailbox and see its existing history.
  const accountViewLoadPending = !orgContext
    || (isAdminRole && (showUnregisteredConversations || isSuperAdminAllMailboxView)
      ? hasMailboxConversationReadScope && !unregisteredViewLoaded && !unregisteredViewFailed
      : hasMailboxConversationReadScope && !mailAccountViewLoaded && !mailAccountViewFailed);
  const conversationLoadPending = !authReady || accountViewLoadPending || (!orgContext && loading);
  const requestedConversationPending = Boolean(requestedConversationId) && !targetedMissing && !conv;
  const unresolvedInboundErrors = mailSafetyStatus?.status?.ingestUnresolvedErrors ?? 0;

  function openAiDraftModal() {
    setAiDraftInstruction("");
    setAiDraftPreview(null);
    setActionError("");
    setAiDraftModalOpen(true);
  }

  function applyAiDraftPreview() {
    const nextDraft = aiDraftPreview?.text.trim() ?? "";
    if (!nextDraft) return;
    const latestDraft = draftLatestRef.current;
    const currentDraft = latestDraft.trim();
    if (currentDraft && currentDraft !== nextDraft) {
      setOverwrittenDraftBackup(latestDraft);
    } else {
      setOverwrittenDraftBackup("");
    }
    draftComposerStateRef.current.dirty = true;
    setDraftBody(nextDraft);
    setDraftActionByKey((prev) => ({
      ...prev,
      [selectedConversationKey]: {
        key: selectedConversationKey,
        status: "done",
        outcome: "composer_ready",
        draftText: nextDraft,
      },
    }));
    setAiDraftModalOpen(false);
    setAiDraftPreview(null);
  }

  useEffect(() => {
    if (!authReady || !canRead) return;
    let cancelled = false;
    void getMailSafetyStatus()
      .then((result) => {
        if (!cancelled) setMailSafetyStatus(result);
      })
      .catch(() => {
        if (!cancelled) setMailSafetyStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [authReady, canRead]);

  // 수신 직후 서버가 생성한 초안은 별도 클릭 없이 열린 대화에 도착해야 한다.
  // 완료/억제 상태가 확인되면 폴링을 멈추고, 대화 전체를 비우지 않은 채 현재 행만 병합한다.
  useEffect(() => {
    if (!authReady || !canRead || !selectedConversationId) return;
    if (["draft_only", "scheduled"].includes(conv?.autoReplyStatus ?? "") || conv?.autoReplyBlockedReason) return;
    let cancelled = false;
    let timer = 0;
    let attempts = 0;
    let inFlight = false;
    const schedulePoll = (delayMs: number) => {
      window.clearTimeout(timer);
      if (cancelled || attempts >= 12 || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => void poll(), delayMs);
    };
    const poll = async () => {
      if (cancelled || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      attempts += 1;
      try {
        const result = await listConversations({
          ids: [selectedConversationId],
          limit: 1,
          mailAccountId: selectedViewMailAccountId,
          ...(isAdminRole && (isSuperAdminAllMailboxView || showUnregisteredConversations) ? { includeUnregistered: true } : {}),
          ...viewAsParams,
        });
        if (cancelled) return;
        const rawRows = Array.isArray((result as { rows?: unknown }).rows)
          ? (result as { rows: unknown[] }).rows
          : [];
        const next = normalizeConversations(rawRows).filter(isDefaultChatConversation);
        if (next.length > 0) {
          const refreshSelected = (current: AccountScopedConversationState | null) => {
            if (!current || current.scopeKey !== mailAccountViewScopeKey) return current;
            return {
              ...current,
              rows: current.rows.map((row) => next.find((item) => String(item.id) === String(row.id)) ?? row),
            };
          };
          setMailAccountViewConversations(refreshSelected);
          setUnregisteredInclusiveConversations(refreshSelected);
          setTargetedMailboxConversations((current) => current?.scopeKey === mailAccountViewScopeKey
            ? { ...current, rows: current.rows.map((row) => next.find((item) => String(item.id) === String(row.id)) ?? row) }
            : current);
          mutate((prev) => ({
            ...prev,
            conversations: [
              ...next,
              ...prev.conversations.filter((conversation) => !next.some((item) => item.id === String(conversation.id))),
            ],
          }));
          const refreshed = next[0];
          if (["draft_only", "scheduled"].includes(refreshed.autoReplyStatus ?? "") || refreshed.autoReplyBlockedReason) return;
        }
      } catch {
        // The next bounded poll is allowed to recover a transient callable error.
      } finally {
        inFlight = false;
      }
      schedulePoll(5_000);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") schedulePoll(0);
    };
    document.addEventListener("visibilitychange", onVisible);
    schedulePoll(2_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authReady, canRead, conv?.autoReplyBlockedReason, conv?.autoReplyStatus, isAdminRole, isSuperAdminAllMailboxView, mailAccountViewScopeKey, mutate, selectedConversationId, selectedViewMailAccountId, showUnregisteredConversations]);

  // W62-4 [헤세 · Chat 읽음 표시 버그]
  //
  // 실측으로 끊긴 지점을 특정했다(tests/w62-chat-mark-read.test.mjs):
  //   콜러블 → Firestore 필드 → 목록 콜러블 왕복은 **전부 정상**이다(unread 0 으로 내려온다).
  //   끊긴 곳은 클라 구간이었다 — 대화를 열어도 markConversationRead 를 부르는 곳이 없고
  //   수동 "읽음 처리" 버튼만 있었다. 사용자는 읽었는데 시스템은 모른다.
  //
  // ⚠️ 처음엔 useEffect 로 붙였다가 되돌렸다. 기존 계약
  //   (tests/chat-explicit-side-effect-boundary.test.mjs — "chat mount never mutates read state")이
  //   **마운트 효과가 서버 상태를 바꾸는 것**을 금지한다. 그 원칙이 옳다: 페이지가 뜨기만 해도
  //   서버 상태가 바뀌면, 목록을 스쳐 본 것과 실제로 읽은 것을 구분할 수 없게 된다.
  //   그래서 **대화를 클릭하는 명시적 조작**에 건다 — 계약도 지키고 증상도 사라진다.
  // W62c-M1: **영구 Set 이 아니라 세대(generation) 맵**이다.
  //   영구 Set 이면 한 번 읽음 처리한 대화에 **새 메시지가 와도 다시 안 찍는다** — 안읽음이 다시
  //   쌓였는데 화면만 조용해진다. 세대 키(안읽음 수 + 마지막 읽음 시각)가 바뀌면 다시 무장한다.
  const markedReadGenerationRef = useRef<Map<string, string>>(new Map());
  function selectConversation(conversationKey: string) {
    endDeepLinkStrandPreference();
    setSelectedId(conversationKey);
    setMobilePane("conversation");
    // [리뷰어 A HIGH 수리 (a)] 이 클릭이 "지금 탭에서 명시적으로 고른 키"라는 사실을 남긴다 —
    //   conv 해소가 이 값과 (tab, selectedId) 가 정확히 일치할 때만 넓은 후보 풀을 쓴다(위).
    //   flat 행 클릭(:2370 근방)과 프로그램 드릴다운 진입(:2280 근방) 둘 다 이 함수를 거친다.
    setLastFlatClick({ tab, key: conversationKey });
    const target = conversations.find(
      (conversation) => (conversation.uiThreadKey ?? workflowConversationKey(conversation)) === conversationKey,
    );
    // W62e [구조 권고]: 무장 판정은 src/lib/chat-read-arming 의 순수 함수가 정본이다.
    //   테스트가 판정을 **복제**하면 갈릴 수 있고, 갈리는 순간 테스트는 green 인데 화면은 틀린다 —
    //   이 라운드가 고친 결함과 같은 형상이다. 같은 함수를 import 해서 그 갭을 없앤다.
    if (!shouldArmChatRead(target, markedReadGenerationRef.current.get(conversationKey))) return;
    markedReadGenerationRef.current.set(conversationKey, chatReadGenerationKey(target!));
    // setTimeout 을 쓰지 않는다 — 클릭 시점의 key 를 인자로 넘기므로 다음 틱을 기다릴 이유가 없고,
    //   기다리면 그 사이 도착한 메시지가 낙관적 갱신에 덮인다.
    // 실패해도 화면을 깨뜨리지 않는다 — 수동 버튼이 남아 있어 사람이 다시 시도할 수 있다.
    void handleMarkSelectedConversationRead(conversationKey, true);
  }

  // W106 Phase 3 (§3 P-3): 사람 방/갈래 진입 읽음 처리. 신규 API 없음 — 기존
  // markConversationRead 콜러블(handleMarkSelectedConversationRead)과 selectConversation 이 쓰는
  // 것과 같은 무장 가드(shouldArmChatRead/markedReadGenerationRef)를 재사용한다. 이미 읽음
  // 처리된(안읽음 0 이거나 같은 세대) 갈래는 애초에 무장되지 않아 중복 호출이 폭주하지 않는다.
  function markPersonStrandsRead(strandsToMark: readonly ChatConversation[]) {
    for (const strand of strandsToMark) {
      const strandKeyValue = strand.uiThreadKey ?? workflowConversationKey(strand);
      if (!shouldArmChatRead(strand, markedReadGenerationRef.current.get(strandKeyValue))) continue;
      markedReadGenerationRef.current.set(strandKeyValue, chatReadGenerationKey(strand));
      void handleMarkSelectedConversationRead(strandKeyValue, true);
    }
  }

  // W106: 사람 카드 클릭 — 방 상태 3개를 이 사람의 기본값으로 리셋한다(부록 규칙 2 기본값).
  // 전체 뷰 진입이므로 이 방의 모든 갈래를 읽음 처리한다(§3 P-3).
  function selectPersonRoom(personKeyArg: string) {
    setPersonKey(personKeyArg);
    endDeepLinkStrandPreference();
    setMobilePane("conversation");
    setStrandFilter("all");
    setReplyTargetStrand("");
    setReplyTargetMenuOpen(false);
    const room = personRooms.find((candidate) => candidate.personKey === personKeyArg);
    if (room) markPersonStrandsRead(room.strands);
  }

  // W106: 갈래 칩 클릭 — "전체"로 돌아가도 override 는 리셋한다(부록 규칙 2, 시안 selectStrand 그대로).
  // 읽음 처리(§3 P-3): "전체" 칩은 방의 모든 갈래, 특정 갈래 칩은 그 갈래만.
  function selectStrandFilter(strandKeyArg: string) {
    setStrandFilter(strandKeyArg);
    setReplyTargetStrand("");
    setReplyTargetMenuOpen(false);
    endDeepLinkStrandPreference();
    if (!selectedPersonRoom) return;
    const strandsToMark = strandKeyArg === "all"
      ? selectedPersonRoom.strands
      : selectedPersonRoom.strands.filter((strand) => (strand.uiThreadKey ?? workflowConversationKey(strand)) === strandKeyArg);
    markPersonStrandsRead(strandsToMark);
  }

  function openAttributionEditor() {
    if (!conv) return;
    const suggested = conv.attribution?.suggested;
    const nextProgramId = resolveCanonicalProgramId(
      selectedPrimaryRoute?.programId || suggested?.programId || "",
    );
    setAttributionProgramId(nextProgramId);
    setAttributionCampaignId(selectedPrimaryRoute?.campaignId || suggested?.campaignId || "");
    setAttributionReason("");
    setAttributionNotice("");
    setAttributionEditorOpen(true);
  }

  // silent 는 **자동 경로 전용**이다(대화 클릭으로 따라오는 읽음 처리). 명시적 버튼은 기본값으로 부른다.
  // 파라미터를 객체가 아닌 단순 불리언으로 둔다 — 계약 테스트가 시그니처의 `{` 를 함수 본문으로
  // 오인하지 않게 하려는 실용적 이유도 있다(tests/chat-explicit-side-effect-boundary).
  async function handleMarkSelectedConversationRead(conversationKeyArg?: string, silent = false) {
    // Flu/Task-50 적대 리뷰 P1 — "대신 보기"는 읽기 전용 프리뷰다: 대상자 시점으로 보는 화면을
    // 열었다고 그 사람의 안읽음 상태가 실제로 바뀌면 안 된다. 자동 경로(대화 클릭 시 silent 호출)
    // 든 명시적 버튼이든 구분 없이 호출 자체를 건너뛴다.
    if (isViewingAs) return;
    // W62c-M1 [두 리뷰 수렴 · stale closure]: 종전에는 이 함수가 렌더 시점의 `conv` 를 클로저로
    //   잡았다. B 를 클릭하면 setSelectedId 는 예약만 되고 이 함수는 **이전 렌더의 conv(=A)** 를
    //   본다 — A 를 읽음 처리하거나(오발), 선택이 없던 첫 클릭에서는 conv 가 undefined 라 그냥
    //   이탈했다. 그런데 이탈해도 Set 에는 이미 등록돼서 **지금 보고 있는 대화가 영영 안 찍혔다.**
    //   → 클릭 시점의 key 를 **인자로** 받고, 대화는 그 key 로 목록에서 직접 찾는다.
    const key = conversationKeyArg ?? selectedConversationKey;
    const target = conversations.find(
      (conversation) => (conversation.uiThreadKey ?? workflowConversationKey(conversation)) === key,
    );
    const action = readActionByKey[key] ?? { key, status: "idle" as const, message: "" };
    if (!target || target.unread <= 0 || action.status === "loading") return;
    const conversationId = String(target.id);
    const threadConversationIds = target.threadConversationIds ?? [conversationId];
    const readAtIso = new Date().toISOString();
    setActionError("");
    // 명시적 조작은 정직한 상태(loading/done/error)를 그대로 보여준다 —
    // 자동 경로만 조용하다(사용자가 누른 것은 "대화 열기"지 "읽음 처리"가 아니다).
    if (silent) {
      setReadActionByKey((prev) => ({ ...prev, [key]: { key, status: "idle", message: "" } }));
    } else {
      setReadActionByKey((prev) => ({
        ...prev,
        [key]: { key, status: "loading", message: "읽음 처리 중…" },
      }));
    }
    try {
      const result = await markConversationRead({
        conversationId,
        // W62e-MAJ-E: **본 시점**을 실어 보낸다. 서버는 이보다 새 메시지가 있으면 안읽음을 내리지
        //   않는다 — 클릭과 쓰기 사이에 도착한 메일이 읽음으로 지워지는 유실을 막는다.
        lastSeenMessageAtIso: String(target.updatedAtIso ?? ""),
        threadId: target.threadId ?? selectedThreadId,
        contextKey: target.contextKey,
        programId: target.programId,
        campaignId: target.campaignId,
        conversationIds: threadConversationIds,
        readAtIso,
        gameId: "flu-chat",
      });
      // 서버가 **안 내린** 대화는 화면에서도 내리지 않는다 — 내리면 같은 유실이 화면에서 재현된다.
      const skipped = new Set(
        Array.isArray((result as { skippedNewerConversationIds?: unknown }).skippedNewerConversationIds)
          ? ((result as { skippedNewerConversationIds: unknown[] }).skippedNewerConversationIds).map(String)
          : [],
      );
      mutate((prev) => ({
        ...prev,
        conversations: prev.conversations.map((conversation) =>
          threadConversationIds.includes(String(conversation.id)) && !skipped.has(String(conversation.id))
            ? { ...conversation, unread: 0, lastReadAtIso: readAtIso }
            : conversation,
        ),
      }));
      // 자동 처리는 완료 토스트를 남기지 않는다 — 열 때마다 뜨면 소음이 되고,
      // 사용자가 한 행동이 아니라 시스템이 따라온 것이라 알릴 내용도 아니다.
      if (silent) {
        setReadActionByKey((prev) => ({ ...prev, [key]: { key, status: "idle", message: "" } }));
      } else {
        setReadActionByKey((prev) => ({
          ...prev,
          [key]: { key, status: "done", message: "읽음 처리가 완료되었습니다." },
        }));
      }
      requestDataRefresh();
    } catch (err) {
      // W62e [Codex 델타]: 실패했으면 **무장을 푼다.** 안 풀면 그 세대에서는 다시 시도하지 않아
      //   한 번의 네트워크 오류가 그 대화를 영구히 안읽음으로 남긴다.
      markedReadGenerationRef.current.delete(key);
      const message = errorText(err);
      setReadActionByKey((prev) => ({
        ...prev,
        [key]: { key, status: "error", message: `읽음 처리 실패: ${message}` },
      }));
      setActionError(`읽음 처리 실패: ${message}`);
    }
  }

  // 헤세 [Chat 딥링크 열람 레드닷 잔류]
  //
  // SCP 문의 퍼널·후보자 테이블·콜드메일 히스토리·인플루언서 상세 등 다른 화면의
  // "대화 열기"/"열기" 링크는 목록 행 클릭(selectConversation)을 거치지 않고
  // /chat?conversationId=... 로 직행한다(requestedConversationId, 위 targeted-load effect
  // 참고). 이 경로는 지금까지 읽음 처리 배선이 전혀 없었다 — 아래 메시지 로드 effect 는 정상
  // 동작해 사용자는 메시지를 실제로 보는데, unread 는 그대로 남아 레드닷이 안 지워졌다.
  //
  // W62-4 가 "마운트 효과는 서버 상태를 바꾸지 않는다"는 원칙으로 useEffect 배선을 한 번
  // 되돌린 것과 배치되지 않는다: 그 원칙은 requestedConversationId 가 없는 일반 마운트(기본/
  // 폴백 선택)에 대한 것이다 — "페이지가 뜨기만 해서" 어떤 대화가 화면에 걸리는 경우와, 다른
  // 화면의 클릭이 "이 대화를 열어라"라고 **명시적으로 지정한 결과**로 뜨는 경우는 다르다.
  // 후자는 목록 클릭과 같은 명시적 조작이므로 같은 무장 가드(shouldArmChatRead/
  // markedReadGenerationRef)를 그대로 재사용한다 — 중복 호출·이미 읽은 대화 재호출을 막는다.
  useEffect(() => {
    if (!requestedConversationId || !conv) return;
    if (boardHandoffTargetRef.current && (selectedConversationId === boardHandoffTargetRef.current || chatConversationMatchesSelection(conv, boardHandoffTargetRef.current))) return;
    if (!shouldArmChatRead(conv, markedReadGenerationRef.current.get(selectedConversationKey))) return;
    markedReadGenerationRef.current.set(selectedConversationKey, chatReadGenerationKey(conv));
    void handleMarkSelectedConversationRead(selectedConversationKey, true);
  }, [conv, requestedConversationId, selectedConversationKey]);

  useEffect(() => {
    if (!conv) return undefined;
    let cancelled = false;
    setMessageLoadError("");
    void loadConversationMessagesDeduped({
      conversationId: selectedConversationId || conv.id,
      threadId: selectedThreadId,
      contextKey: conv.contextKey,
      programId: conv.programId,
      campaignId: conv.campaignId,
      conversationIds: conv.threadConversationIds ?? [conv.id],
      limit: 500,
      mailAccountId: selectedViewMailAccountId,
      ...viewAsParams,
    }, { authScopeKey, generation: authScopeGeneration })
      .then((result) => {
        const nextMessages = normalizeMessages((result as Record<string, unknown>).messages, selectedConversationKey);
        if (!cancelled) {
          setMessageLoadError("");
          setLoadedMessageKeys((current) => new Set(current).add(selectedConversationKey));
          setSucceededMessageKeys((current) => new Set(current).add(selectedConversationKey));
        }
        if (!cancelled && nextMessages.length > 0) {
          setThreadMessagesById((prev) => ({ ...prev, [selectedConversationKey]: nextMessages }));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setMessageLoadError(errorText(error));
          setLoadedMessageKeys((current) => new Set(current).add(selectedConversationKey));
          setSucceededMessageKeys((current) => {
            const next = new Set(current);
            next.delete(selectedConversationKey);
            return next;
          });
        }
      });
    return () => {
      cancelled = true;
    };
  // Flu/Task-50 재리뷰: viewAsUserIdForScope/viewAsEmailForScope는 원시 문자열이라(객체 참조가
  // 아니다) viewAsParams 자체를 넣는 것과 달리 매 렌더 재실행을 유발하지 않는다 — 대신 보기
  // 대상이 실제로 바뀔 때만(로그인 사용자 전환·시작/종료) 이 effect가 새 스코프로 재요청한다.
  }, [authScopeGeneration, authScopeKey, conv?.id, conv?.threadConversationIds, conv?.contextKey, conv?.programId, conv?.campaignId, selectedConversationId, selectedConversationKey, selectedThreadId, selectedViewMailAccountId, viewAsUserIdForScope, viewAsEmailForScope]);

  // W106 (§2-D, §5-3): PersonRoom 진입 시 그 사람의 모든 갈래를 기존 listConversationMessages
  // 경로로 채운다 — 신규 쿼리 유형 없음, 위 효과와 같은 콜러블을 갈래마다 한 번씩만 부른다.
  // 병합 타임라인이 갈래별 미리보기가 아니라 전체 이력을 보여주려면 필요하다.
  useEffect(() => {
    if (tab !== "person" || !selectedPersonRoom) return undefined;
    let cancelled = false;
    for (const strand of selectedPersonRoom.strands) {
      const key = strand.uiThreadKey ?? workflowConversationKey(strand);
      if (loadedMessageKeys.has(key) || personRoomLoadRequestedRef.current.has(key)) continue;
      personRoomLoadRequestedRef.current.add(key);
      void loadConversationMessagesDeduped({
        conversationId: primaryConversationId(strand) || strand.id,
        threadId: strand.threadId ?? strand.id,
        contextKey: strand.contextKey,
        programId: strand.programId,
        campaignId: strand.campaignId,
        conversationIds: strand.threadConversationIds ?? [strand.id],
        limit: 500,
        mailAccountId: selectedViewMailAccountId,
        ...viewAsParams,
      }, { authScopeKey, generation: authScopeGeneration })
        .then((result) => {
          if (cancelled) return;
          const nextMessages = normalizeMessages((result as Record<string, unknown>).messages, key);
          setLoadedMessageKeys((current) => new Set(current).add(key));
          if (nextMessages.length > 0) {
            setThreadMessagesById((prev) => ({ ...prev, [key]: nextMessages }));
          }
        })
        .catch(() => {
          if (!cancelled) setLoadedMessageKeys((current) => new Set(current).add(key));
        });
    }
    return () => {
      cancelled = true;
    };
  // loadedMessageKeys is deliberately omitted — personRoomLoadRequestedRef already gates
  // duplicate in-flight requests, and depending on the state here would refire this loop on
  // every single strand's resolution mid-batch (same class of issue as autoPrefillKeysRef above).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // W111 (헤세: "갈래를 하나씩 눌러야 대화가 생긴다"): 의존성이 selectedPersonRoom **객체**면
  //   메시지가 하나 도착할 때마다 threadMessagesById 가 바뀌어 방 객체가 새로 만들어지고,
  //   effect 가 재실행되며 cleanup 이 `cancelled = true` 로 **아직 응답 안 온 나머지 갈래 요청을
  //   전부 버린다**. 그런데 personRoomLoadRequestedRef 에는 이미 "요청함"이 찍혀 있어 재요청도
  //   안 한다 — 결과적으로 방을 열면 갈래 하나만 채워지고 나머지는 직접 눌러야 생겼다.
  //   방이 실제로 바뀔 때만 취소하도록, 객체 대신 **갈래 구성의 안정적인 서명**에 의존한다.
  // Flu/Task-50 재리뷰: viewAsUserIdForScope/viewAsEmailForScope 원시 문자열도 같은 이유로
  // 넣는다 — viewAsParams(객체)를 넣으면 위 W111 문제와 같은 클래스의 재실행 폭주가 재현된다.
  }, [tab, effectivePersonKey, personRoomStrandSignature, selectedViewMailAccountId, viewAsUserIdForScope, viewAsEmailForScope]);

  // (여기 있던 W111 배경 프리로드는 제거됐다 — 파일 상단 EMPTY_CONVERSATIONS 아래 주석의
  //  실측·근거 참조. 메시지는 위 두 effect, 즉 **열린 대화 / 열린 사람 방**에서만 로드한다.)

  function handleConversationWorkflowAction(result: WorkflowItemStateEnvelope, action: WorkflowAction) {
    if (!conv) return;
    if (result.blocked) {
      setActionError(result.message ?? "보호된 대화는 보관/삭제할 수 없습니다.");
      return;
    }
    const conversationId = selectedConversationId || conv.id;
    if (action === "archive" || action === "delete") {
      const nextConversation = conversations.find((conversation) => (conversation.uiThreadKey ?? workflowConversationKey(conversation)) !== selectedConversationKey);
      const affectedIds = new Set(conv.threadConversationIds ?? [conversationId]);
      mutate((prev) => ({
        ...prev,
        conversations: prev.conversations.filter((conversation) => !affectedIds.has(String(conversation.id))),
      }));
      setSelectedId(nextConversation ? nextConversation.uiThreadKey ?? workflowConversationKey(nextConversation) : "");
      return;
    }
    if (action === "request_human") {
      const requestedAt = new Date().toISOString();
      const affectedIds = new Set(conv.threadConversationIds ?? [conversationId]);
      setAiOn(false);
      mutate((prev) => ({
        ...prev,
        conversations: prev.conversations.map((conversation) =>
          affectedIds.has(String(conversation.id))
            ? {
                ...conversation,
                aiActive: false,
                humanGate: "needs_review",
                alert: conversation.alert ?? "사람 개입 요청됨 — 자동 처리를 중단하고 담당자 검토가 필요합니다.",
                manualIntervention: {
                  status: "open",
                  reason: "manual_request_human",
                  requestedAt,
                },
              }
            : conversation,
        ),
      }));
    }
  }

  async function requestHumanIntervention() {
    if (!conv || humanRequesting) return;
    // 0.6.73 Aside 핫픽스 — 다른 쓰기 핸들러(handleDraftSend/handleAiDraft/
    // handleMarkSelectedConversationRead)와 같은 가드가 이 함수엔 없었다: "대신 보기" 중에도
    // 실제로 updateWorkflowItemState를 호출해 대화 상태를 바꿀 수 있었다(읽기 전용 프리뷰 계약 위반).
    if (isViewingAs) return;
    setActionError("");
    setHumanRequesting(true);
    try {
      const result = await updateWorkflowItemState({
        entity: "conversation",
        id: selectedConversationId || conv.id,
        action: "request_human",
        reason: "manual_request_human",
        conversationIds: conv.threadConversationIds ?? [selectedConversationId || conv.id],
        threadId: selectedThreadId,
        contextKey: conv.contextKey,
        gameId: "flu-chat",
      });
      handleConversationWorkflowAction(result, "request_human");
      requestDataRefresh();
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setHumanRequesting(false);
    }
  }

  // 대화 단위 AI 자동응답 토글 — 서버(conversations.aiActive) 저장 성공 후에만 화면을 바꾼다.
  // 낙관적 업데이트 금지: 저장 실패 시 이전 값으로 되돌리고 사유를 노출한다.
  async function toggleConversationAutoReply() {
    if (!conv || aiToggleSaving || !globalAutoReplyEnabled) return;
    if (humanTakeoverOpen) return;
    // 0.6.73 Aside 핫픽스 — 같은 이유로 누락돼 있었다(위 requestHumanIntervention 주석 참조):
    // "대신 보기" 중 이 토글을 누르면 실제로 setConversationAutoReply가 나가 대화의 AI 자동응답
    // 설정이 바뀌었다.
    if (isViewingAs) return;
    const previous = aiOn;
    const next = !previous;
    setActionError("");
    setAiToggleSaving(true);
    try {
      const conversationId = selectedConversationId || conv.id;
      const result = await setConversationAutoReply({
        conversationId,
        enabled: next,
        conversationIds: conv.threadConversationIds ?? [conversationId],
        threadId: selectedThreadId,
        contextKey: conv.contextKey,
        gameId: "flu-chat",
      });
      const affectedIds = new Set(conv.threadConversationIds ?? [conversationId]);
      setAiOn(result.enabled);
      mutate((prev) => ({
        ...prev,
        conversations: prev.conversations.map((conversation) =>
          affectedIds.has(String(conversation.id))
            ? { ...conversation, aiActive: result.enabled }
            : conversation,
        ),
      }));
      requestDataRefresh();
    } catch (err) {
      setAiOn(previous);
      setActionError(`AI 자동응답 ${next ? "켜기" : "끄기"} 실패: ${errorText(err)}`);
    } finally {
      setAiToggleSaving(false);
    }
  }

  async function saveConversationAttribution(primaryBucket: "program" | "direct") {
    if (!conv || attributionSaving) return;
    // 0.6.73 Aside 핫픽스 — 다른 쓰기 핸들러와 같은 이유로 누락돼 있었다(위
    // requestHumanIntervention/toggleConversationAutoReply 주석 참조).
    if (isViewingAs) return;
    const reason = attributionReason.replace(/\s+/g, " ").trim();
    if (reason.length < 5) {
      setActionError("귀속 변경 이유를 5자 이상 입력해주세요.");
      return;
    }
    if (primaryBucket === "program" && !attributionProgramId) {
      setActionError("귀속할 프로그램을 선택해주세요.");
      return;
    }

    setActionError("");
    setAttributionNotice("");
    setAttributionSaving(true);
    try {
      const conversationId = selectedAttributionConversationId;
      const actionId = crypto.randomUUID();
      const basePayload = {
        conversationId,
        actionId,
        expectedVersion: lastAttributionChange?.conversationId === conversationId
          ? lastAttributionChange.version
          : conv.attribution?.version ?? 0,
        reason,
        primaryBucket,
        ...(primaryBucket === "program" ? {
          programId: attributionProgramId,
          ...(attributionCampaignId ? { campaignId: attributionCampaignId } : {}),
        } : {}),
      } as const;
      const preview = await reclassifyConversationAttribution({
        ...basePayload,
        dryRun: true,
      });
      if (!preview.previewToken || !preview.previewHash) {
        throw new Error("귀속 변경 미리보기 검증 토큰을 받지 못했습니다.");
      }
      const targetLabel = primaryBucket === "program"
        ? `프로그램 ${attributionProgramId}${attributionCampaignId ? ` / 캠페인 ${attributionCampaignId}` : ""}`
        : "Direct";
      const ambiguityWarning = preview.ambiguityDetected
        ? `\n⚠ 서로 다른 귀속 후보 ${preview.ambiguityTargetKeys.length}개가 감지되었습니다. 증거를 확인한 운영자 판단으로만 확정됩니다.`
        : "";
      const confirmed = window.confirm([
        `${targetLabel}(으)로 귀속을 확정할까요?`,
        `대화 메시지 증거 ${preview.projectedMessageSourceCount}건과 연결된 발송 원장 ${preview.projectedOutboundLedgerCount}건이 같은 트랜잭션에서 갱신됩니다.`,
        "이 작업은 메일을 보내지 않습니다.",
        ambiguityWarning,
      ].filter(Boolean).join("\n\n"));
      if (!confirmed) {
        setAttributionNotice("귀속 변경을 취소했습니다.");
        return;
      }
      const response = await reclassifyConversationAttribution({
        ...basePayload,
        dryRun: false,
        actual: true,
        confirm: true,
        previewToken: preview.previewToken,
        previewHash: preview.previewHash,
      });
      if (!response.auditRef || !response.readbackVerified || response.mailSent !== false) {
        throw new Error("귀속 변경 후 원장 읽기 검증이 완료되지 않았습니다.");
      }
      setLastAttributionChange({
        conversationId,
        auditRef: response.auditRef,
        version: response.version,
      });
      setAttributionReason("");
      setAttributionEditorOpen(false);
      setAttributionNotice(primaryBucket === "program" ? "프로그램 귀속을 저장했습니다." : "Direct 귀속을 저장했습니다.");
      requestDataRefresh();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setAttributionSaving(false);
    }
  }

  async function revertLastConversationAttribution() {
    if (!conv || attributionSaving) return;
    if (isViewingAs) return;
    const conversationId = selectedAttributionConversationId;
    const auditRef = lastAttributionChange?.conversationId === conversationId
      ? lastAttributionChange.auditRef
      : conv.lastAttributionAuditRef || "";
    if (!auditRef) {
      setActionError("되돌릴 귀속 감사 기록이 없습니다.");
      return;
    }
    const reason = attributionReason.replace(/\s+/g, " ").trim();
    if (reason.length < 5) {
      setActionError("되돌리기 이유를 5자 이상 입력해주세요.");
      setAttributionEditorOpen(true);
      return;
    }

    setActionError("");
    setAttributionNotice("");
    setAttributionSaving(true);
    try {
      const response = await revertConversationAttribution({
        conversationId,
        auditRef,
        expectedVersion: lastAttributionChange?.conversationId === conversationId
          ? lastAttributionChange.version
          : conv.attribution?.version ?? 0,
        reason,
      });
      setLastAttributionChange({
        conversationId,
        auditRef: response.auditRef,
        version: response.version,
      });
      setAttributionReason("");
      setAttributionEditorOpen(false);
      setAttributionNotice("마지막 귀속 변경을 되돌렸습니다.");
      requestDataRefresh();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setAttributionSaving(false);
    }
  }

  async function handlePreview() {
    const body = draft.trim();
    if (!body) return;
    if (!canComposeSend || !selectedSender) {
      setActionError(composeSendBlockedMessage);
      return;
    }
    const to = composeRecipient.trim();
    if (!to) {
      setActionError("받는 사람 이메일을 입력하거나 Workspace 그룹을 검색해 선택하세요.");
      return;
    }
    const subject = conv ? `Re: Supercent Flu collaboration - ${displayName}` : composeSubject.trim();
    if (!subject) {
      setActionError("메일 제목을 입력하세요.");
      return;
    }
    const previewRequest: ChatComposeAsyncRequest = {
      scopeKey: composeScopeKey,
      scopeGeneration: composeScopeGenerationRef.current,
      requestGeneration: composePreviewRequestGenerationRef.current + 1,
      senderAccountId: selectedSender.accountId,
    };
    const previewInputKey = composePreviewInputKey;
    const isCurrentPreviewRequest = () => composePreviewInputKeyRef.current === previewInputKey
      && isCurrentChatComposeAsyncRequest(previewRequest, {
        scopeKey: composeScopeKeyRef.current,
        scopeGeneration: composeScopeGenerationRef.current,
        requestGeneration: composePreviewRequestGenerationRef.current,
        senderAccountId: selectedSenderIdRef.current,
      });
    composePreviewRequestGenerationRef.current = previewRequest.requestGeneration;
    setPreviewLoading(true);
    setPreviewOpen(false);
    setPreviewData(null);
    setActionError("");
    try {
      const res = await previewEmailDraft({
        conversationId: conv ? (selectedConversationId || conv.id) : "",
        subject,
        body,
        recipient: to,
        sender: selectedSender.mailbox,
      });
      if (!isCurrentPreviewRequest()) return;
      setPreviewData(res);
      setPreviewOpen(true);
    } catch (err) {
      if (!isCurrentPreviewRequest()) return;
      setActionError(mailPermissionErrorText(err));
    } finally {
      if (isCurrentPreviewRequest()) {
        setPreviewLoading(false);
      }
    }
  }

  async function handleDraftSend() {
    if (sending) return;
    if (!isNewCompose && !conv) return;
    // Flu/Task-50 적대 리뷰 P1 — "대신 보기" 중에는 발송도 막는다: 실제로는 슈퍼어드민 자신의
    // 계정으로 나가는데 화면은 대상자 시점을 보여주고 있어, 발송을 허용하면 "미리보기가 실제로
    // 일어날 일과 다르다"는 거짓 프리뷰가 된다.
    if (isViewingAs) {
      setActionError("대신 보기 중에는 발송할 수 없습니다. 종료 후 다시 시도하세요.");
      return;
    }
    const text = draft.trim();
    if (!text) return;
    if (!canComposeSend || !selectedSender) {
      setActionError(composeSendBlockedMessage);
      return;
    }

    const to = composeRecipient.trim();
    if (!to) {
      setActionError("받는 사람 이메일을 입력하거나 Workspace 그룹을 검색해 선택하세요.");
      return;
    }
    const subject = isNewCompose ? composeSubject.trim() : `Re: Supercent Flu collaboration - ${displayName}`;
    if (!subject) {
      setActionError("메일 제목을 입력하세요.");
      return;
    }
    const currentConversation = conv;
    if (!isNewCompose && !currentConversation) return;

    // The mailbox history view and the explicit sender picker are independent. Ask for a final
    // review when they differ, so the user sees which account will actually send the message.
    if (!isNewCompose && composerSenderMismatched) {
      const confirmed = window.confirm([
        `현재 보고 있는 메일함(${viewingMailAccountLabel || selectedViewMailAccountId})과 발신 계정(${selectedSender.mailbox})이 다릅니다.`,
        "선택한 발신 계정으로 계속할까요?",
      ].join("\n\n"));
      if (!confirmed) return;
    }

    invalidateAiDraftRequest();
    setAiDraftModalOpen(false);
    setAiDraftInstruction("");
    setAiDraftPreview(null);
    setOverwrittenDraftBackup("");
    setActionError("");
    setSendSuppressionWarning("");
    setStandaloneSendResult(null);
    // A send supersedes any preview still resolving. Its finally block is also guarded below, so
    // an old preview cannot reopen the dialog or clear this send's loading state.
    composePreviewRequestGenerationRef.current += 1;
    setPreviewLoading(false);
    setPreviewOpen(false);
    setPreviewData(null);
    const sendRequest: ChatComposeAsyncRequest = {
      scopeKey: composeScopeKey,
      scopeGeneration: composeScopeGenerationRef.current,
      requestGeneration: composeSendRequestGenerationRef.current + 1,
      senderAccountId: selectedSender.accountId,
    };
    const sendInputKey = composePreviewInputKey;
    composeSendRequestGenerationRef.current = sendRequest.requestGeneration;
    setSending(true);
    try {
      let payload: SendEmailPayload;
      if (isNewCompose) {
        payload = {
          intent: "standalone_new_mail",
          draftRef: freshComposeReference("chat-standalone-draft"),
          trackingId: freshComposeReference("chat-standalone-tracking"),
          approvalRef: freshComposeReference("chat-standalone-approval"),
          approval: "approved",
          senderAccountId: selectedSender.accountId,
          to,
          subject,
          text,
          fromRole: "human",
          dryRun: false,
          liveSend: true,
        };
      } else {
        // The preflight above makes this impossible during one synchronous event, but keep the
        // guard before any network result can leave the send spinner stuck if state is refactored.
        if (!currentConversation) {
          setSending(false);
          return;
        }
        const replySource = latestCreatorMessageSource(selectedMessages, currentConversation);
        const replyToMessageRef = replySource.ref;

        // W106 (§3 P-2, §4 L3 최소): 사람 방에서 "새 메일(새 갈래)"을 고르면 기존 갈래의
        // conversationId/threadId 대신 새로 발급한다 — sendEmail 계약 자체는 불변(§6), 팬아웃은
        // 서버가 그대로 처리한다. 그 외 필드는 아래 기존 페이로드 그대로(발송 타깃 =
        // replyTargetStrand 갈래) — isNewStrand 일 때만 스프레드로 마지막에 덮어쓴다.
        const isNewStrand = tab === "person" && personReplyTarget?.kind === "new";
        const stamp = Date.now().toString(36);
        const newStrandId = isNewStrand
          ? canonicalThreadId({ conversationId: `mail-${currentConversation.creatorId}-${stamp}`, creatorId: currentConversation.creatorId })
          : "";
        payload = {
          conversationId: (replyToMessageRef && replySource.conversationId) || selectedConversationId || currentConversation.id,
          threadId: selectedThreadId,
          contextKey: currentConversation.contextKey,
          creatorId: currentConversation.creatorId,
          creatorName: displayName,
          programId: currentConversation.programId,
          programTitle: currentConversation.programTitle,
          campaignId: currentConversation.campaignId,
          campaignTitle: currentConversation.campaignTitle,
          to,
          subject,
          text,
          intent: "chat_manual_reply",
          replyToMessageRef,
          draftRef: `chat-draft-${currentConversation.id}-${stamp}`,
          trackingId: `chat-${currentConversation.id}-${stamp}`,
          approvalRef: `chat-approval-${currentConversation.id}-${stamp}`,
          approval: "approved",
          gameId: "flu-chat",
          author: "헤세",
          fromRole: "human",
          dryRun: false,
          liveSend: true,
          // Sender selection is limited to the server-authorized usableSenders projection. The
          // callable revalidates this id against the current team policy before sending. This is
          // intentionally separate from viewAccountId, which legacy callers use for sender
          // selection while Chat uses mailAccountId for mailbox history.
          senderAccountId: selectedSender.accountId,
          ...(isNewStrand
            ? {
                conversationId: newStrandId,
                threadId: newStrandId,
                contextKey: `mail:${newStrandId}`,
                programId: undefined,
                programTitle: undefined,
                campaignId: undefined,
                campaignTitle: undefined,
                subject: `Supercent Flu collaboration - ${displayName}`,
                replyToMessageRef: undefined,
                draftRef: `chat-draft-${newStrandId}-${stamp}`,
                trackingId: `chat-${newStrandId}-${stamp}`,
                approvalRef: `chat-approval-${newStrandId}-${stamp}`,
              }
            : {}),
        };
      }
      const result = await sendEmail(payload) as SendEmailResult;
      if (composePreviewInputKeyRef.current !== sendInputKey || !isCurrentChatComposeAsyncRequest(sendRequest, {
        scopeKey: composeScopeKeyRef.current,
        scopeGeneration: composeScopeGenerationRef.current,
        requestGeneration: composeSendRequestGenerationRef.current,
        senderAccountId: selectedSenderIdRef.current,
      })) return;

      if (result.ok !== true) {
        const reason = result.mailSafety?.reason || result.mailSafety?.ruleId || result.deliveryState;
        throw new Error(`메일 발송 실패${reason ? ` (${reason})` : ""}`);
      }

      // W117: infly-overlap 예외로 통과된 발송은 성공이지만, 이 수신자가 Infly 중복(콜드메일
      // 방지) 대상이었다는 사실을 운영자에게 남긴다.
      const suppressionWarning = result.mailSafety?.suppressionWarning;
      setSendSuppressionWarning(
        suppressionWarning
          ? isNewCompose
            ? `이 수신자는 억제 목록 예외로 발송이 허용되었습니다. (${suppressionWarning.reason ?? suppressionWarning.ruleId ?? "infly-overlap"})`
            : `이 수신자는 억제 목록(Infly 중복)에 있었지만 기존 회신에 대한 수동 답장이라 발송을 허용했습니다. (${suppressionWarning.reason ?? suppressionWarning.ruleId ?? "infly-overlap"})`
          : "",
      );

      if (isNewCompose) {
        draftComposerStateRef.current = { conversationKey: composeScopeKey, dirty: false, appliedSavedDraft: "" };
        preserveStandaloneSendStatusForInputResetRef.current = true;
        setComposeRecipient("");
        setComposeSubject("");
        setDraftBody("");
        setStandaloneSendResult({ conversationId: result.conversationId?.trim() ?? "" });
      } else {
        draftComposerStateRef.current.dirty = false;
        draftComposerStateRef.current.appliedSavedDraft = "";
        setDraftBody("");
        if (tab === "person" && personReplyTarget?.kind === "new") setReplyTargetStrand("");
      }
      requestDataRefresh();
    } catch (err) {
      if (composePreviewInputKeyRef.current !== sendInputKey || !isCurrentChatComposeAsyncRequest(sendRequest, {
        scopeKey: composeScopeKeyRef.current,
        scopeGeneration: composeScopeGenerationRef.current,
        requestGeneration: composeSendRequestGenerationRef.current,
        senderAccountId: selectedSenderIdRef.current,
      })) return;
      setActionError(mailPermissionErrorText(err));
    } finally {
      // Sender/input changes invalidate the result, but the in-flight request still owns the
      // spinner until it settles. Scope or a newer send owns the spinner after that boundary.
      if (composeScopeKeyRef.current === sendRequest.scopeKey
        && composeScopeGenerationRef.current === sendRequest.scopeGeneration
        && composeSendRequestGenerationRef.current === sendRequest.requestGeneration) {
        setSending(false);
      }
    }
  }

  async function handleAiDraft(anchorMessage?: Msg, autoPrefill = false) {
    if (!conv || drafting) return;
    // Flu/Task-50 적대 리뷰 P1 — "대신 보기" 중에는 초안 생성(자동/수동 모두)도 막는다: 실제 LLM
    // 호출·비용(COST-P0-006/011)이 발생하고 그 결과가 대화에 남는 쓰기다 — 읽기 전용 프리뷰
    // 계약을 벗어난다.
    if (isViewingAs) return;
    const key = selectedConversationKey;
    const requestScopeKey = composeScopeKey;
    // W111 리뷰(MEDIUM): 수동 경로도 같은 원칙을 따른다 — **크리에이터가 말한 게 있어야** 답장 초안이
    //   성립한다. 종전엔 앵커가 없으면 마지막 메시지(대개 우리 아웃바운드)를 그대로 썼고, 그러면
    //   게이트웨이가 failed-precondition 을 내서 버튼을 누를 때마다 같은 실패 배너만 떴다.
    //   자동 경로만 막고 수동을 열어두면 그건 자유가 아니라 함정이라는 리뷰 지적을 받아들였다.
    const anchor = anchorMessage ?? [...selectedMessages].reverse().find((message) => message.from === "creator");
    if (!anchor) {
      setActionError("크리에이터 회신이 없어 답장 초안을 만들 수 없습니다.");
      return;
    }
    const replyTargetSignal = anchor
      ? `reply-target/${anchor.from}/${anchor.author}: ${stringValue(anchor.text)}`
      : "";
    // W106 Phase 3 (§3 P-2): 사람 방일 때만 신호를 person-scope 통합 타임라인으로 바꾼다 —
    // conversationId/threadId/contextKey/programId/campaignId 는 그대로 conv(=타깃 갈래, Phase 2가
    // 이미 personTargetStrandKey 로 해석) 값을 쓴다. 서버 게이트·캐시 seed 가 갈래 단위라 서버
    // 변경이 없다(§4 L5). 기존 탭(사람 아님)은 compactConversationSignal 을 그대로 유지한다.
    const signal = tab === "person" && selectedPersonRoom
      ? compactPersonSignal(selectedPersonRoom.mergedMessages, conv, anchor)
      : [compactConversationSignal(conv, selectedMessages), replyTargetSignal].filter(Boolean).join(" || ");
    const operatorInstruction = !autoPrefill ? aiDraftInstruction.trim().slice(0, 500) : "";
    const aiDraftRequest: ChatComposeAiDraftRequest = {
      scopeKey: requestScopeKey,
      scopeGeneration: composeScopeGenerationRef.current,
      requestGeneration: composeAiDraftRequestGenerationRef.current + 1,
      conversationKey: key,
      inputKey: composeAiDraftInputKey,
    };
    composeAiDraftRequestGenerationRef.current = aiDraftRequest.requestGeneration;
    clearStaleDraftAction(key);
    const isCurrentAiDraftRequest = () => isCurrentChatComposeAiDraftRequest(aiDraftRequest, {
      scopeKey: composeScopeKeyRef.current,
      scopeGeneration: composeScopeGenerationRef.current,
      requestGeneration: composeAiDraftRequestGenerationRef.current,
      conversationKey: selectedConversationKeyRef.current,
      inputKey: composeAiDraftInputKeyRef.current,
    });
    setActionError("");
    if (!autoPrefill) setAiDraftPreview(null);
    setDraftActionByKey((prev) => ({
      ...prev,
      [key]: { key, status: "loading" },
    }));
    try {
      const result = await gatewayProxy({
        conversationId: selectedConversationId || conv.id,
        threadId: selectedThreadId,
        contextKey: conv.contextKey,
        programId: conv.programId,
        programTitle: conv.programTitle,
        campaignId: conv.campaignId,
        campaignTitle: conv.campaignTitle,
        messageRef: anchor?.messageRef,
        trackingId: anchor?.trackingId,
        intent: autoPrefill ? "chat-open-auto-prefill" : "draft-next-email-reply",
        operatorInstruction: operatorInstruction || undefined,
        signal,
        gameId: "flu-chat",
        dryRun: true,
        autoPrefill: autoPrefill || undefined,
      }) as GatewayDraftResult;
      if (composeScopeKeyRef.current !== requestScopeKey) return;
      if (selectedConversationKeyRef.current !== key) {
        clearStaleDraftAction(key);
        return;
      }
      const nextDraft = (result.draftText ?? result.draftPreview ?? "").trim();
      if (!isCurrentAiDraftRequest()) return;
      const decision = result.humanGate?.decision;
      if (decision === "needs_review" && nextDraft) {
        if (!autoPrefill) {
          setAiDraftPreview({
            text: nextDraft,
            summaryKr: typeof result.draftKr === "string" ? result.draftKr : undefined,
            decision,
            blockedReason: result.humanGate?.reason,
          });
        }
        setDraftActionByKey((prev) => ({
          ...prev,
          [key]: {
            key,
            status: "done",
            outcome: "human_review",
            humanDraftSuggestion: nextDraft,
            humanDraftSuggestionKr: typeof result.draftKr === "string" ? result.draftKr : undefined,
            blockedReason: result.humanGate?.reason,
          },
        }));
        return;
      }
      if (!nextDraft || (decision && decision !== "auto_reply" && decision !== "draft_only")) {
        setDraftActionByKey((prev) => ({
          ...prev,
          [key]: {
            key,
            status: "done",
            outcome: "blocked",
            blockedReason: result.humanGate?.reason ?? "AI 초안을 생성하지 못했습니다.",
          },
        }));
        return;
      }
      if (!autoPrefill) {
        setAiDraftPreview({
          text: nextDraft,
          summaryKr: typeof result.draftKr === "string" ? result.draftKr : undefined,
          decision,
        });
        setDraftActionByKey((prev) => ({
          ...prev,
          [key]: {
            key,
            status: "done",
            outcome: "preview_ready",
            draftText: nextDraft,
          },
        }));
        return;
      }
      draftComposerStateRef.current.dirty = true;
      setDraftBody(nextDraft);
      setDraftActionByKey((prev) => ({
        ...prev,
        [key]: {
          key,
          status: "done",
          outcome: "composer_ready",
          draftText: nextDraft,
        },
      }));
    } catch (err) {
      const message = errorText(err);
      if (composeScopeKeyRef.current !== requestScopeKey) return;
      if (selectedConversationKeyRef.current !== key) {
        clearStaleDraftAction(key);
        return;
      }
      if (!isCurrentAiDraftRequest()) return;
      setDraftActionByKey((prev) => ({
        ...prev,
        [key]: { key, status: "error", error: message },
      }));
      setActionError(`AI 초안 생성 실패: ${message}`);
    } finally {
      if (!isCurrentAiDraftRequest()) return;
      setDraftActionByKey((prev) => {
        if (prev[key]?.status !== "loading") return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }

  // 수신 시점 자동 초안이 아직 저장되지 않은 오래된/복구 대화도 열자마자 한 번만
  // 자동 보완한다. 서버 캐시는 messageRef 기준이라 새로고침해도 AI를 중복 호출하지 않는다.
  useEffect(() => {
    if (!conv || !selectedConversationKey || selectedMessages.length === 0) return;
    // A review-board hand-off (pending, applied, or this visit's hand-off target) never auto-drafts.
    if (boardPrefillNonce || boardPrefillAppliedScopeRef.current === composeScopeKey) return;
    if (boardHandoffTargetRef.current && (selectedConversationId === boardHandoffTargetRef.current || chatConversationMatchesSelection(conv, boardHandoffTargetRef.current))) return;
    if (draftActionForConv.status !== "idle" || effectiveHumanDraftSuggestion || effectiveBlockedReason) return;
    if (["draft_only", "scheduled"].includes(conv.autoReplyStatus ?? "") || stringValue(conv.autoReplyDraftText)) return;
    // W111-B (헤세): **크리에이터가 말한 게 있을 때만** 자동 초안을 건다.
    //   종전엔 인바운드가 없으면 마지막 아웃바운드를 앵커로 삼아 그대로 발사했는데, 답장할
    //   원문이 없으니 게이트웨이가 failed-precondition 을 내고 화면엔 빨간 "AI 초안 생성 실패:
    //   The request cannot be completed in its current state." 만 남았다(사유는 콜러블 에러
    //   경계에서 일반화돼 가려진다). 노출 기준이 회신 OR 참여로 넓어지면서 회신 원문이 없는
    //   사람(지원·제출만 한 96명)이 목록에 들어오므로, 안 걸러내면 그 전부가 에러를 띄운다.
    //   수동 초안 버튼은 그대로 둔다 — 사람이 명시적으로 요청하는 건 막지 않는다.
    const anchor = [...selectedMessages].reverse().find((message) => message.from === "creator");
    if (!anchor?.messageRef) return;
    const key = `${composeScopeKey}:${selectedConversationKey}:${anchor.messageRef}`;
    const scheduleGeneration = composeAiDraftRequestGenerationRef.current;
    const timer = window.setTimeout(() => {
      if (composeAiDraftRequestGenerationRef.current !== scheduleGeneration) return;
      if (autoPrefillKeysRef.current.has(key)) return;
      autoPrefillKeysRef.current.add(key);
      void handleAiDraft(anchor, true);
    }, 1_500);
    return () => window.clearTimeout(timer);
  // handleAiDraft is intentionally omitted: the effect is keyed by stable conversation/message
  // identity and the server cache owns cross-render/cross-reload deduplication.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    conv?.autoReplyDraftText,
    conv?.autoReplyStatus,
    draftActionForConv.status,
    effectiveBlockedReason,
    effectiveHumanDraftSuggestion,
    boardPrefillNonce,
    composeScopeKey,
    selectedConversationKey,
    selectedMessages,
  ]);


  async function handleReceive() {
    const receiveRequestScopeKey = composeScopeKey;
    const receiveRequestGeneration = composeReceiveRequestGenerationRef.current + 1;
    composeReceiveRequestGenerationRef.current = receiveRequestGeneration;
    setActionError("");
    setReceiveResult(null);
    setReceiving(true);
    try {
      // IMAP 수신은 "메일함의 다음 메일"을 읽는 작업이다. 현재 클릭된 대화 id를 같이 넘기면
      // reply-header로 다른 아웃바운드에 매칭된 메일도 선택 대화에 붙는 오연결이 생긴다.
      const result = await receiveEmail({
        dryRun: true,
        draftOnly: true,
      });
      if (composeScopeKeyRef.current !== receiveRequestScopeKey
        || composeReceiveRequestGenerationRef.current !== receiveRequestGeneration) return;
      setReceiveResult(result as ReceiveEmailResult);
      void getMailSafetyStatus().then(setMailSafetyStatus).catch(() => {});
      requestDataRefresh();
    } catch (err) {
      if (composeScopeKeyRef.current !== receiveRequestScopeKey
        || composeReceiveRequestGenerationRef.current !== receiveRequestGeneration) return;
      setActionError(chatReceiveErrorText(err));
    } finally {
      if (composeScopeKeyRef.current === receiveRequestScopeKey
        && composeReceiveRequestGenerationRef.current === receiveRequestGeneration) {
        setReceiving(false);
      }
    }
  }

  if (!conv) {
    if (isNewCompose) {
      return (
        <div data-testid="new-mail-compose" className="flex h-full min-h-0 flex-col bg-canvas">
          <header className="flex items-start justify-between gap-4 border-b border-line bg-paper px-6 py-5">
            <div className="min-w-0">
              <span className="inline-flex items-center rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-bold text-accent">
                새 메일
              </span>
              <h1 className="mt-1 text-lg font-bold text-ink">새 메시지 작성</h1>
              <p className="mt-1 text-xs leading-relaxed text-ink-3">
                기존 대화와 연결하지 않고 받는 사람·제목·본문을 작성한 뒤 미리보고 발송할 수 있습니다.
              </p>
            </div>
            <Link
              href="/chat"
              className="shrink-0 rounded-md border border-line bg-paper px-3 py-2 text-xs font-semibold text-ink-2 hover:bg-fill"
            >
              받은편지함
            </Link>
          </header>

          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-paper px-6 py-3">
            {mailAccountViewToggle}
            {viewingAccountBadge}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {!canSendMail && (
              <div className="mb-2 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs leading-relaxed text-warn" role="note">
                현재 역할은 메일 발송 권한이 없습니다. Manager 이상 계정에서 미리보기와 발송을 진행하세요.
              </div>
            )}
            {canSendMail && !orgContext && (
              <div className="mb-2 rounded-md border border-line bg-fill px-3 py-2 text-xs leading-relaxed text-ink-3" role="status">
                현재 팀의 발신 정책을 확인하는 중입니다. 확인이 끝날 때까지 메일 발송이 비활성화됩니다.
              </div>
            )}
            {canSendMail && orgContext && senderBlocked && (
              <div className="mb-2 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs leading-relaxed text-warn" role="status">
                {composeSendBlockedMessage}
                {orgContext.senderBlockedReason === "personal_connection_required" && (
                  <Link href="/admin/integrations" className="ml-1 font-semibold underline underline-offset-2">
                    내 메일함 연결
                  </Link>
                )}
              </div>
            )}
            <div className="rounded-lg border border-line bg-paper">
              <div className="border-b border-line px-4 py-3 text-xs text-ink-3">
                메일 미리보기는 서버에 저장하지 않습니다. 발송은 선택한 허용 계정과 현재 작성 내용을 사용합니다.
              </div>
              <ChatComposerFields
                composeKey={composeScopeKey}
                composeRecipient={composeRecipient}
                onRecipientChange={setComposeRecipient}
                composeSubject={composeSubject}
                onSubjectChange={setComposeSubject}
                showSubject
                selectedSenderId={selectedSenderId}
                onSenderChange={handleSenderChange}
                selectedSender={selectedSender}
                usableSenderAccounts={usableSenderAccounts}
                orgContext={orgContext}
                draft={draft}
                onDraftChange={() => {
                  draftComposerStateRef.current = {
                    ...draftComposerStateRef.current,
                    conversationKey: composeScopeKey,
                    dirty: true,
                  };
                }}
                setDraftBody={setDraftBody}
                drafting={false}
                sending={sending}
                previewLoading={previewLoading}
                canComposeSend={canComposeSend}
                composeSendBlockedMessage={composeSendBlockedMessage}
                composerSenderMismatched={composerSenderMismatched}
                isViewingAs={isViewingAs}
                allowAiDraft={false}
                onOpenAiDraft={() => undefined}
                onPreview={() => void handlePreview()}
                onSend={() => void handleDraftSend()}
              />
            </div>
            {standaloneSendResult ? (
              <p className="mt-2 rounded-md border border-ok/30 bg-ok-soft px-3 py-2 text-xs text-ok" role="status">
                새 메일을 발송했습니다.
                {standaloneSendResult.conversationId ? (
                  <Link
                    className="ml-1 font-semibold underline underline-offset-2"
                    href={`/chat?conversationId=${encodeURIComponent(standaloneSendResult.conversationId)}`}
                  >
                    보낸 대화 열기
                  </Link>
                ) : null}
              </p>
            ) : null}
            {sendSuppressionWarning ? (
              <p className="mt-2 flex items-start gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn" role="status">
                <Badge tone="warn">억제 목록 예외</Badge>
                <span className="min-w-0 flex-1">{sendSuppressionWarning}</span>
              </p>
            ) : null}
            {actionError ? <p className="mt-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger" role="alert">{actionError}</p> : null}
          </div>
          <MailPreviewDialog open={previewOpen} data={previewData} onClose={() => setPreviewOpen(false)} />
        </div>
      );
    }
    // S1(d)/P1: targeted-load(콜드메일 히스토리 "열기" 등)가 명시적으로 실패한 경우, 일반
    // "대화가 없습니다"로 뭉개지 않고 복구 문구를 보여준다.
    const emptyText = targetedMissing
      ? "요청한 대화를 찾을 수 없습니다. 삭제되었거나 접근 권한이 없을 수 있습니다."
      : mailAccountViewFailed || unregisteredViewFailed
        ? "선택한 메일함의 대화를 불러오지 못했습니다. 잠시 후 다시 시도하세요."
        : requestedConversationPending
          ? "요청한 대화를 불러오는 중입니다"
          : conversationLoadPending
            ? "대화를 불러오는 중입니다"
            : !canRead
              ? "대화 읽기 권한이 없습니다"
              : !orgContext
                ? "메일함 보기 정책을 확인하는 중입니다"
                : !hasMailboxConversationReadScope
                  ? selectedMailAccountView === "personal"
                    ? "개인 메일함이 연결되지 않았습니다. 연결하면 내 메일 기록을 확인할 수 있습니다. 팀 공유 메일함의 기존 기록은 계정 보기에서 확인하세요."
                    : "현재 계정에서 볼 수 있는 연결된 메일함이 없습니다. 개인 메일을 연결하거나 팀 매핑을 확인하세요."
                  : viewingMailAccountLabel
                    ? isSuperAdminAllMailboxView
                      ? "전체 메일함에 표시할 대화가 없습니다."
                      : `${viewingMailAccountLabel} 메일함에 표시할 대화가 없습니다. 다른 메일함의 기존 기록은 계정 보기에서 확인할 수 있습니다.`
                    : "대화가 없습니다";
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-ink-4" role="status">
        <div className="flex flex-wrap items-center justify-center gap-2">
          {mailAccountViewToggle}
          {viewingAccountBadge}
        </div>
        <span>{emptyText}</span>
        {accountViewLoadMoreError?.scopeKey === mailAccountViewScopeKey && (
          <span className="rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn" role="status">
            이전 대화 불러오기 실패 — 다시 시도해 주세요.
          </span>
        )}
        {accountViewNextCursor && (
          <button
            type="button"
            data-testid="chat-load-older-conversations-empty"
            onClick={() => void handleLoadOlderAccountViewConversations()}
            disabled={accountViewLoadingMore}
            className="rounded-md border border-line bg-paper px-3 py-2 text-xs font-semibold text-ink transition-colors hover:bg-fill disabled:cursor-wait disabled:opacity-60"
          >
            {accountViewLoadingMore ? "불러오는 중" : "이전 대화 더 보기"}
          </button>
        )}
        {orgContext && !hasMailboxConversationReadScope && (
          selectedMailAccountView === "personal"
          || orgContext.senderBlockedReason === "personal_connection_required"
        ) ? (
          <Link href="/admin/integrations" className="font-semibold text-accent underline underline-offset-2">
            내 메일함 연결
          </Link>
        ) : null}
        {/* W109: 사람 탭에서 필터가 사람을 전부 걸러내면 conv 가 없어 이 화면으로 떨어지는데,
            그러면 좌측의 검색창과 "답장 있는 사람만" 토글까지 같이 사라져 **필터를 되돌릴 UI 가
            페이지 안에 하나도 남지 않는다**(리뷰에서 재현된 하드 락아웃).
            conv 를 임의 대화로 폴백시키면 발송 오발 경로가 열리므로, 탈출구만 여기 둔다.
            검색어·토글 둘 중 무엇이 원인이든(또는 둘 다든) 한 번에 복구되도록 둘 다 리셋한다 —
            토글은 setPersonRepliedOnly 호출부가 그 버튼 하나뿐이라, 안 끄면 복구 경로가 없다. */}
        {/* 필터가 **실제 원인일 때만** 보여준다: 방이 있는데 필터가 다 걸러낸 경우.
            종전엔 기본값이 true 라 조건이 항상 참이어서, 새로고침 직후 로딩 중에도 이 버튼이 떠
            "필터 때문에 비었다"고 오해하게 만들었다(헤세 보고). 로딩·권한·빈 계정은 원인이 다르다. */}
        {tab === "person" && !conversationLoadPending && personRooms.length > 0
          && personRoomsVisible.length === 0 && (listSearch || personRepliedOnly) ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setListSearch("");
              setPersonRepliedOnly(false);
            }}
          >
            필터 초기화
          </Button>
        ) : null}
        {canRead && !conversationLoadPending ? (
          <Button size="sm" variant="secondary" onClick={handleReceive} disabled={receiving}>
            <Refresh className={cn("h-4 w-4", receiving && "animate-spin")} />
            {receiveLabel}
          </Button>
        ) : null}
        {actionError ? <span className="text-xs text-danger">{actionError}</span> : null}
        {unresolvedInboundErrors > 0 ? (
          <span className="max-w-md rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
            받은 메일 {unresolvedInboundErrors}건이 처리 실패 상태입니다. 새 메일 없음으로 판단하지 말고 운영 복구가 필요합니다.
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* LEFT — 대화 목록 (below md: full width, hidden while a conversation is open) */}
      <aside
        data-testid="chat-list-pane"
        className={cn(
          "w-full shrink-0 flex-col border-r border-line bg-paper md:flex md:w-[340px]",
          mobilePane === "conversation" ? "hidden" : "flex",
        )}
      >
        <div className="flex items-center justify-between px-5 pb-3 pt-5">
          <h1 className="text-lg font-bold text-ink">메시지</h1>
          <button
            type="button"
            onClick={handleReceive}
            disabled={receiving}
            className="grid h-8 w-8 place-items-center rounded-md text-ink-2 transition-colors hover:bg-fill disabled:opacity-50"
            aria-label={receiveLabel}
            title={receiveLabel}
          >
            <Refresh className={cn("h-[17px] w-[17px]", receiving && "animate-spin")} />
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 px-5 pb-2 text-[11px] text-ink-4">
          <span
            data-testid="chat-foreground-sync-status"
            className={cn("min-w-0 truncate", chatForegroundSync.error ? "text-danger" : chatForegroundSync.inFlight ? "text-accent" : "text-ink-4")}
            title={chatForegroundSync.error ?? "앱을 열어 둔 동안 30초마다 새 대화를 확인합니다."}
          >
            {chatForegroundSync.inFlight
              ? "동기화 중"
              : chatForegroundSync.error
                ? `동기화 실패 · ${chatForegroundSync.error}`
                : chatForegroundSync.lastFinishedAtIso
                  ? `최근 동기화 ${formatChatSyncTime(chatForegroundSync.lastFinishedAtIso)}`
                  : "자동 동기화 대기"}
          </span>
          <span className="shrink-0" title="30초마다 새 대화를 확인합니다. Flu의 메일 수신 시점에 따라 반영 시간이 달라질 수 있습니다.">
            30초 갱신
          </span>
        </div>

        {(orgContext || isAdminRole) && (
          <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
            {orgContext && (
              <Badge tone="accent">
                {orgContext.orgName || (orgContext.orgId ? `팀 ${orgContext.orgId}` : "미배정 팀")}
              </Badge>
            )}
            {orgContext && !orgContext.orgAccount && (
              <p className="w-full text-[11px] text-ink-3">
                {orgContext.senderBlockedReason === "personal_connection_required"
                  ? senderBlockedMessage
                  : "현재 팀에 명시적으로 설정된 공유 계정이 없습니다. 연결된 개인 메일 또는 팀 매핑을 확인하세요."}
              </p>
            )}
            {mailAccountViewToggle}
            {viewingAccountBadge}
            {isAdminRole && orgFilterOptions.length > 0 && (
              <select
                value={chatOrgFilter}
                onChange={(event) => setChatOrgFilter(event.target.value)}
                aria-label="조직 필터"
                className="h-7 rounded-md border border-line bg-paper px-2 text-[11px] text-ink outline-none"
              >
                <option value="">전체 조직</option>
                {orgFilterOptions.map((option) => (
                  <option key={option.orgId} value={option.orgId}>{option.name}</option>
                ))}
              </select>
            )}
            {isAdminRole && isSuperAdminAllMailboxView ? (
              <span
                className="text-xs font-medium text-ink-4"
                role="status"
                title="이 목록에 미등록 대화도 함께 보여준다는 뜻이에요. 대화별 차단 표시는 아니에요."
                data-testid="chat-list-scope-unregistered"
              >
                목록 범위: 미등록 대화 포함
              </span>
            ) : isAdminRole ? (
              <label
                className="flex items-center gap-1.5 text-[11px] font-medium text-ink-3"
                title="목록 범위 설정이에요. 켜면 미등록 대화도 목록에 함께 보여요. 대화별 차단 표시는 아니에요."
              >
                <input
                  type="checkbox"
                  checked={showUnregisteredConversations}
                  onChange={(event) => setShowUnregisteredConversations(event.target.checked)}
                  className="h-3.5 w-3.5"
                />
                미등록 보기
              </label>
            ) : null}
          </div>
        )}

        {tab !== "unreplied" && (
          <div className="px-4 pb-3">
            {unresolvedInboundErrors > 0 ? (
              <div role="alert" className="mb-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-semibold text-danger">
                수신 처리 실패 {unresolvedInboundErrors}건 · 빈 성공 실행으로 정상 처리하지 않음
              </div>
            ) : null}
            <div className="flex items-center gap-2 rounded-md bg-fill px-3 py-2 text-ink-3">
              <Search className="h-4 w-4" />
              <input
                type="text"
                value={listSearch}
                onChange={(event) => setListSearch(event.target.value)}
                placeholder="대화 검색 (이름·핸들·이메일·최근 메시지)"
                aria-label="대화 검색"
                className="w-full bg-transparent text-sm text-ink placeholder:text-ink-3 focus:outline-none"
              />
              {listSearch ? (
                <button
                  type="button"
                  onClick={() => setListSearch("")}
                  className="shrink-0 text-[11px] font-semibold text-ink-3 hover:text-ink-2"
                >
                  지우기
                </button>
              ) : null}
            </div>
            {listSearch.trim() ? (
              <p className="mt-1.5 text-[11px] text-ink-4">불러온 대화 중 {visible.length}건 일치</p>
            ) : null}
          </div>
        )}

        <div className="px-4 pb-2">
          <Tabs tabs={listTabs} value={tab} onChange={(key) => { endDeepLinkStrandPreference(); setTab(key); }} />
        </div>

        {/* "미답장 인박스" (2026-09-26, 헤세 요청) — scp 사서함 대화 중 사람 답장이 필요한 것만
            서버가 걸러 내려주는 자기완결 패널. 위 검색바/기존 목록(tabScoped 기반)과는 별개
            데이터 소스라 이 탭에서는 그 목록들을 전부 빈 상태로 둔다(tabScoped 정의 참조).
            2026-09-27 security fix: listTabs와 별개로 tab 상태만으로 렌더 여부를 정하므로,
            scpAccessGranted도 여기서 다시 확인한다(탭 버튼이 안 보여도 남아 있던 tab 상태로
            패널이 새는 것을 막는 방어선 — listTabs 게이트와 동일 플래그). */}
        {tab === "unreplied" && orgContext?.scpAccessGranted && <UnrepliedInboxPanel />}

        {/* W111-B (헤세): 기본은 인바운드가 온 사람만(Gmail 전체메일 모델). 콜드까지 보려면
            토글을 끈다 — 원장 전체 커버 자체는 W109 로 살아 있고, 여기선 기본 노출만 좁힌다. */}
        {tab === "person" && (
          <>
            <div className="flex items-center gap-2 px-4 pb-2">
              {/* W111 (헤세): 종전엔 칩 하나 + 옆에 회색 안내문이라, 안내문의 숫자(콜드 포함 인원)가
                  눌리는 줄 알고 클릭하게 됐다. 두 선택지를 **둘 다 눌리는 세그먼트**로 만든다 —
                  지금 무엇을 보고 있고 무엇으로 바꿀 수 있는지가 한눈에 보인다. */}
              <div role="group" aria-label="사람 목록 범위" className="inline-flex rounded-full border border-line bg-fill p-0.5">
                {([
                  { on: true, label: "반응 온 사람", count: personRoomsResponded.length },
                  { on: false, label: "콜드 포함", count: personRooms.length },
                ] as const).map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={personRepliedOnly === option.on}
                    onClick={() => { endDeepLinkStrandPreference(); setPersonRepliedOnly(option.on); }}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors",
                      personRepliedOnly === option.on
                        ? "bg-accent text-white"
                        : "text-ink-3 hover:text-ink-2",
                    )}
                  >
                    {option.label}
                    <span className="tabular-nums opacity-80">{option.count.toLocaleString("ko-KR")}</span>
                  </button>
                ))}
              </div>
              <span className="text-[11px] text-ink-4">최근 활동순</span>
            </div>
            {/* 현재 숫자는 불러온 범위 기준이다. 서버가 nextCursor 를 주면 사용자가 필요할 때
                같은 계정 스코프의 다음 페이지만 붙인다. */}
            {(accountViewNextCursor || accountViewLoadMoreError?.scopeKey === mailAccountViewScopeKey) && (
              <div className="space-y-2 px-4 pb-2">
                {accountViewLoadMoreError?.scopeKey === mailAccountViewScopeKey && (
                  <div
                    role="status"
                    className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn"
                  >
                    <Alert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    이전 대화 불러오기 실패 — 다시 시도해 주세요.
                  </div>
                )}
                {accountViewNextCursor && (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-line bg-fill px-3 py-2 text-xs text-ink-3">
                    <span>현재 숫자는 불러온 대화 기준입니다.</span>
                    <button
                      type="button"
                      data-testid="chat-load-older-conversations"
                      onClick={() => void handleLoadOlderAccountViewConversations()}
                      disabled={accountViewLoadingMore}
                      className="shrink-0 rounded-md border border-line bg-paper px-2 py-1 font-semibold text-ink transition-colors hover:bg-fill-2 disabled:cursor-wait disabled:opacity-60"
                    >
                      {accountViewLoadingMore ? "불러오는 중" : "이전 대화 더 보기"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        <div className="min-h-0 flex-1 px-2 pb-3">
          {tab === "campaign" && !programDrilldownId && programGroups.length > 0 && (
            <VirtualList
              items={programGroups}
              estimateSize={86}
              getKey={(group) => group.programId}
              className="h-full"
              renderItem={(group) => (
                <button
                  type="button"
                  onClick={() => {
                    setProgramDrilldownId(group.programId);
                    const first = group.conversations[0];
                    // W62c-M1: 이것도 **명시적 클릭**이다 — 목록 클릭과 같은 배선을 쓴다.
                    if (first) selectConversation(first.uiThreadKey ?? workflowConversationKey(first));
                  }}
                  className="flex w-full items-start gap-3 rounded-md px-3 py-3 text-left transition-colors hover:bg-fill"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-ai-soft text-sm font-black text-ai">
                    {group.title.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-ink">{group.title}</span>
                      <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-ink-4" />
                    </span>
                    <span className="mt-1 block truncate text-[11px] font-medium text-ink-3">
                      캠페인 {group.campaignCount.toLocaleString("ko-KR")}개 · 참여 {group.participantCount.toLocaleString("ko-KR")}명
                    </span>
                    <span className="mt-1 flex items-center gap-2 text-xs text-ink-2">
                      대화 {group.conversations.length.toLocaleString("ko-KR")}개
                      {group.unread > 0 && (
                        <span className="ml-auto grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[11px] font-bold text-white">
                          {group.unread}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              )}
            />
          )}
          {tab === "campaign" && !programDrilldownId && programGroups.length === 0 && (
            <div className="px-3 py-10 text-center text-xs text-ink-4">연결된 프로그램이 없습니다</div>
          )}
          {tab === "campaign" && programDrilldownId && (
            <button
              type="button"
              onClick={() => setProgramDrilldownId(null)}
              className="mb-2 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-semibold text-ink-3 hover:bg-fill"
            >
              <ChevronLeft className="h-4 w-4" />
              프로그램 목록
              {selectedProgramGroup ? <span className="ml-auto truncate text-ink-4">{selectedProgramGroup.title}</span> : null}
            </button>
          )}
          {tab !== "person" && tab !== "unreplied" && (tab !== "campaign" || programDrilldownId) && flatPersonRows.length > 0 && (
            <VirtualList
              items={flatPersonRows}
              estimateSize={108}
              getKey={(room) => room.personKey}
              className="h-full"
              onEndReached={() => undefined}
              renderItem={(room) => {
                // W114-D: 이 탭 스코프(visible) 안에서 같은 사람의 갈래를 한 행으로 묶었다 — 대표
                // 갈래는 person 탭과 같은 규칙(최근 활동순, chat-people.ts compareStrandRecency)의
                // room.strands[0]. 답장 대상은 반드시 room.defaultReplyStrand(=pickDefaultReplyStrand,
                // "최근 인바운드 우선" 규칙)로 고른다 — 하드 제약: 행을 합쳐도 답장이 나가는 갈래는
                // 기존 규칙 그대로여야 한다.
                const representative = room.strands[0];
                const last = room.preview;
                const conversationKey = room.defaultReplyStrand;
                const active = conversationKey === selectedConversationKey;
                const profile = conversationProfile(representative, creators);
                // C: 이 갈래 하나만 보고 그리면 포털 갈래(이름 자리에 이메일, 팔로워 0)가 선택돼도
                // 같은 사람의 캠페인 갈래에 있는 진짜 이름·플랫폼·팔로워를 못 본다 — person 탭과
                // 같은 union(conversationPersonProfileByKey, buildPersonProfile 재사용)을 덮는다.
                // 이 union 은 이 탭의 좁은 스코프가 아니라 conversations(narrow scope) 전체에서
                // 만들어지므로, 같은 사람의 다른 갈래가 이 탭 밖에 있어도 이름·아바타는 더 채워진다.
                const rowPersonProfile = conversationPersonProfileByKey.get(room.personKey);
                const listName = (rowPersonProfile?.handle ?? profile.handle) || (rowPersonProfile?.name ?? profile.name);
                const listAvatar = rowPersonProfile?.avatar ?? profile.avatar;
                const listEmail = rowPersonProfile?.email ?? profile.email;
                const listMeta = formatProfileMeta(
                  rowPersonProfile?.platform ?? profile.platform,
                  rowPersonProfile?.followers ?? profile.followers,
                );
                const contextTags = workflowContextTagsForConversation(representative, { programs, campaigns });
                // 귀속 검토 배지는 대표 갈래 하나로 좁히지 않는다 — 캠페인/프로그램 고유 필드는
                // 갈래마다 다를 수 있고(뭉개면 안 됨), 검토가 필요한 갈래가 대표가 아닌 다른 갈래에
                // 있어도 숨기지 않아야 "데이터가 있으면 더 보여준다" 원칙에 맞는다.
                const showRoutingReview = room.strands.some((strand) => {
                  const route = classifyChatPrimaryRoute(strand, campaignsById);
                  return route.primaryBucket === "direct" && route.reviewRequired;
                });
                const routingReviewLabel = showRoutingReview
                  ? chatPrimaryRouteReviewLabel(classifyChatPrimaryRoute(representative, campaignsById))
                  : "";
                const hasAlert = room.strands.some((strand) => strand.alert);
                return (
                  <button
                    type="button"
                    onClick={() => selectConversation(conversationKey)}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-md px-3 py-3 text-left transition-colors",
                      active ? "bg-accent-soft" : "hover:bg-fill",
                    )}
                  >
                    <Avatar label={listAvatar} size={40} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-ink">{listName}</span>
                        <span className="ml-auto shrink-0 text-[11px] text-ink-3">{formatMessageTime(last)}</span>
                      </div>
                      {listMeta && (
                        <p className="mt-0.5 truncate text-[11px] font-medium text-ink-3">{listMeta}</p>
                      )}
                      {listEmail && (
                        <p className="mt-0.5 break-all text-[11px] font-medium leading-snug text-ink-3" title={listEmail}>
                          {listEmail}
                        </p>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <WorkflowContextTags tags={contextTags} compact />
                        {room.strands.length > 1 && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-line bg-fill px-1.5 py-0.5 text-[10px] font-bold text-ink-3">
                            갈래 {room.strands.length}
                          </span>
                        )}
                        {viewingAccountBadge}
                      </div>
                      {showRoutingReview && (
                        <div className="mt-1">
                          <span
                            className="inline-flex max-w-full items-center rounded-full border border-danger/25 bg-danger-soft px-1.5 py-0.5 text-[10px] font-semibold leading-none text-danger"
                            aria-label={`귀속 검토 필요: ${routingReviewLabel}`}
                            title={routingReviewLabel}
                          >
                            귀속 검토
                          </span>
                        </div>
                      )}
                      <div className="mt-0.5 flex items-center gap-2">
                        <p className="truncate text-xs text-ink-2">{last?.text}</p>
                        <span className="ml-auto flex shrink-0 items-center gap-1.5">
                          {hasAlert && (
                            <span className="h-2 w-2 rounded-full bg-danger" aria-label="검수 필요" />
                          )}
                          {room.unreadTotal > 0 && (
                            <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[11px] font-bold text-white">
                              {room.unreadTotal}
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              }}
            />
          )}
          {tab !== "person" && tab !== "unreplied" && (tab !== "campaign" || programDrilldownId) && flatPersonRows.length === 0 && (
            <div className="px-3 py-10 text-center text-xs text-ink-4">
              {conversationLoadPending ? "대화를 불러오는 중입니다" : "대화가 없습니다"}
            </div>
          )}
          {tab === "person" && accountViewLoadingMore && (
            <LoadingStatus compact className="px-3 py-2">
              이전 대화를 불러오는 중 — 불러온 범위 안에서 사람·갈래 수를 갱신합니다
            </LoadingStatus>
          )}
          {/* W106 Phase 2 — 뎁스 0: 사람 카드 목록. 시안 v2 .person-row 이식. */}
          {tab === "person" && personRoomsVisible.length > 0 && (
            <VirtualList
              items={personRoomsVisible}
              estimateSize={112}
              getKey={(room) => room.personKey}
              className="h-full"
              renderItem={(room) => {
                const active = room.personKey === effectivePersonKey;
                // W111 리뷰(HIGH): mergedMessages 는 목록에서 항상 비어 있다(본문이 서브컬렉션이라
                //   열린 방에서만 로드된다). room.preview 가 스냅샷 필드로 폴백해준다.
                const last = room.preview;
                const listName = room.profile.handle || room.profile.name;
                // C: room.profile 은 buildPersonProfile 의 union 결과라 platform/followers 를 이미
                // 갖고 있는데, 지금까지 이 카드도 어느 화면도 그걸 읽지 않았다(전체 0건) — 여기서
                // 처음 연결한다.
                const listMeta = formatProfileMeta(room.profile.platform, room.profile.followers);
                return (
                  <button
                    type="button"
                    onClick={() => selectPersonRoom(room.personKey)}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-md px-3 py-3 text-left transition-colors",
                      active ? "bg-accent-soft" : "hover:bg-fill",
                    )}
                  >
                    <Avatar label={room.profile.avatar} size={40} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-ink">{listName}</span>
                        <span className="ml-auto shrink-0 text-[11px] text-ink-3">{formatMessageTime(last)}</span>
                      </div>
                      {listMeta && (
                        <p className="mt-0.5 truncate text-[11px] font-medium text-ink-3">{listMeta}</p>
                      )}
                      {room.profile.email && (
                        <p className="mt-0.5 break-all text-[11px] font-medium leading-snug text-ink-3" title={room.profile.email}>
                          {room.profile.email}
                        </p>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <span className="inline-flex items-center gap-1 rounded-full border border-line bg-fill px-1.5 py-0.5 text-[10px] font-bold text-ink-3">
                          갈래 {room.strands.length}
                        </span>
                        {viewingAccountBadge}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <p className="truncate text-xs text-ink-2">{last?.text}</p>
                        <span className="ml-auto flex shrink-0 items-center gap-1.5">
                          {room.unreadTotal > 0 && (
                            <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[11px] font-bold text-white">
                              {room.unreadTotal}
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              }}
            />
          )}
          {tab === "person" && personRoomsVisible.length === 0 && (
            <div className="px-3 py-10 text-center text-xs text-ink-4">
              {conversationLoadPending ? "대화를 불러오는 중입니다" : "사람이 없습니다"}
            </div>
          )}
        </div>
      </aside>

      {/* RIGHT — 대화 상세 (below md: full width only while a conversation is open) */}
      <section
        data-testid="chat-conversation-pane"
        className={cn("min-w-0 flex-1 flex-col bg-canvas md:flex", mobilePane === "conversation" ? "flex" : "hidden")}
      >
        <div className="flex items-center border-b border-line bg-paper px-3 py-2 md:hidden">
          <button
            type="button"
            data-testid="chat-mobile-back"
            onClick={() => setMobilePane("list")}
            className="inline-flex min-h-10 items-center gap-1 rounded-md px-2 text-sm font-semibold text-ink-2 hover:bg-fill"
          >
            ← 목록
          </button>
        </div>
        {/* 헤더 */}
        <header className="flex items-center gap-3 border-b border-line px-6 py-3.5">
          {creator ? (
            <CreatorHover creator={creator}>
              <span className="flex items-center gap-3">
                <Avatar label={displayAvatar} size={36} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-bold text-ink">{displayName}</span>
                  <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
                    {selectedParticipationStage ? <StageBadge stage={selectedParticipationStage} /> : null}
                    {displayEmail && (
                      <span className="break-all text-[11px] font-medium text-ink-3" title={displayEmail}>
                        {displayEmail}
                      </span>
                    )}
                    <WorkflowContextTags tags={selectedContextTags} />
                    {tab === "person" && selectedPersonRoom && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-line bg-fill px-1.5 py-0.5 text-[10px] font-bold text-ink-3">
                        갈래 {selectedPersonRoom.strands.length} · 안읽음 {selectedPersonRoom.unreadTotal}
                      </span>
                    )}
                    {viewingAccountBadge}
                  </span>
                </span>
              </span>
            </CreatorHover>
          ) : (
            <>
              <Avatar label={displayAvatar} size={36} />
              <div className="min-w-0">
                <div className="truncate text-sm font-bold text-ink">{displayName}</div>
                <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
                  {displayHandle && <span className="truncate text-[11px] text-ink-3">{displayHandle}{displayMeta ? ` · ${displayMeta}` : ""}</span>}
                  {displayEmail && displayEmail !== displayHandle && (
                    <span className="break-all text-[11px] font-medium text-ink-3" title={displayEmail}>
                      {displayEmail}
                    </span>
                  )}
                  <WorkflowContextTags tags={selectedContextTags} />
                  {tab === "person" && selectedPersonRoom && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-line bg-fill px-1.5 py-0.5 text-[10px] font-bold text-ink-3">
                      갈래 {selectedPersonRoom.strands.length} · 안읽음 {selectedPersonRoom.unreadTotal}
                    </span>
                  )}
                  {viewingAccountBadge}
                </div>
              </div>
            </>
          )}

          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {selectedPrimaryRoute?.reviewRequired ? <Badge tone="warn">귀속 검토</Badge> : null}
            {conv.unread > 0 ? (
              <button
                type="button"
                onClick={() => void handleMarkSelectedConversationRead()}
                disabled={readActionForConv.status === "loading" || isViewingAs}
                title={isViewingAs ? "대신 보기 중에는 비활성" : undefined}
                className="min-h-10 rounded-md border border-line bg-paper px-3 py-2 text-xs font-semibold text-ink-2 transition-[background-color,scale] hover:bg-fill active:scale-[0.96] disabled:cursor-wait disabled:opacity-60"
              >
                {readActionForConv.status === "loading" ? "읽음 처리 중…" : `읽음 처리 · ${conv.unread}`}
              </button>
            ) : null}
            {/* W99(헤세): 귀속 변경 UI 는 Chat 에서 제거 — 귀속 관리는 관리(/flu/manage) 일원화.
                편집기 코드·콜러블은 유지(향후 관리 이관 v2), 진입점만 닫는다. */}
            <button
              type="button"
              role="switch"
              aria-checked={effectiveAiOn}
              disabled={!globalAutoReplyEnabled || humanTakeoverOpen || aiToggleSaving || isViewingAs}
              title={
                isViewingAs
                  ? "대신 보기 중에는 비활성"
                  : !globalAutoReplyEnabled
                    ? "전역 자동응답이 꺼져 있습니다 (AI 자동응답 설정)"
                    : humanTakeoverOpen
                      ? "사람 개입이 열려 있어 자동응답이 잠겨 있습니다"
                      : "이 대화의 AI 자동응답을 켜고 끕니다"
              }
              onClick={() => void toggleConversationAutoReply()}
              className={cn(
                "inline-flex items-center gap-2 rounded-full py-1 pl-2.5 pr-1 text-[13px] font-semibold transition-colors",
                effectiveAiOn ? "bg-accent-soft text-accent" : "bg-fill text-ink-3",
                (!globalAutoReplyEnabled || humanTakeoverOpen || isViewingAs) && "cursor-not-allowed opacity-70",
                aiToggleSaving && "cursor-wait opacity-70",
              )}
            >
              {aiToggleSaving
                ? "저장 중…"
                : !autoReplySettingsLoaded
                  ? "확인 중"
                  : !globalAutoReplyEnabled
                  ? "자동응답 꺼짐"
                  : humanTakeoverOpen
                    ? "사람 개입 중"
                    : "AI 자동응답"}
              <span
                className={cn(
                  "relative h-5 w-9 rounded-full transition-colors",
                  effectiveAiOn ? "bg-accent" : "bg-ink-4",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all",
                    effectiveAiOn ? "left-[18px]" : "left-0.5",
                  )}
                />
              </span>
            </button>
            <WorkflowActionMenu
              entity="conversation"
              id={selectedConversationId || conv.id}
              label={displayName}
              protectedItem={conv.protected || selectedThreadId === MVP_CONVERSATION_ID}
              onCompleted={handleConversationWorkflowAction}
              disabled={isViewingAs}
            />
          </div>
        </header>

        {readActionForConv.status === "done" ? (
          <div className="border-b border-line bg-ok-soft px-6 py-2 text-xs font-semibold text-ok" role="status">
            {readActionForConv.message || "읽음 처리가 완료되었습니다."}
          </div>
        ) : null}

        {readActionForConv.status === "error" ? (
          <div className="border-b border-line bg-danger-soft px-6 py-2 text-xs font-semibold text-danger" role="alert">
            {readActionForConv.message || "읽음 처리에 실패했습니다."}
          </div>
        ) : null}

        {attributionNotice ? (
          <div className="border-b border-line bg-ok-soft px-6 py-2 text-xs font-semibold text-ok" role="status">
            {attributionNotice}
          </div>
        ) : null}

        {attributionEditorOpen && (
          <div className="border-b border-line bg-paper px-4 py-4 sm:px-6" role="group" aria-label="대화 귀속 변경">
            <div className="mb-3 grid gap-2 rounded-lg border border-line bg-canvas p-3 text-xs text-ink-3 sm:grid-cols-4">
              <p><span className="font-semibold text-ink-2">현재 귀속</span><br />{currentAttributionLabel}</p>
              <p><span className="font-semibold text-ink-2">정책 버전</span><br />{conv.attribution?.policyVersion ?? "기록 없음"}</p>
              <p><span className="font-semibold text-ink-2">기록 상태</span><br />{
                conv.attributionStatus === "manual_confirmed"
                  ? "수동 확정"
                  : conv.attributionStatus === "automatic"
                    ? "자동 분류"
                    : conv.attributionStatus === "legacy/unrecorded"
                      ? "레거시 · 미기록"
                      : "레거시 · 미기록"
              }</p>
              <p><span className="font-semibold text-ink-2">검토 상태</span><br />{conv.attribution?.reviewRequired || conv.attributionReviewRequired ? "사람 확인 필요" : "검토 요청 없음"}</p>
            </div>
            <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_minmax(220px,1fr)_minmax(280px,2fr)_auto] xl:items-end">
              <label className="min-w-0 text-[11px] font-semibold text-ink-3">
                최종 귀속
                <select
                  value={attributionProgramId}
                  onChange={(event) => {
                    setAttributionProgramId(event.target.value);
                    setAttributionCampaignId("");
                  }}
                  className="mt-1 min-h-10 w-full rounded-md border border-line bg-canvas px-3 text-sm text-ink"
                >
                  <option value="">Direct</option>
                  {attributionProgramOptions.map((program) => (
                    <option key={program.id} value={program.id}>{program.title}</option>
                  ))}
                </select>
              </label>
              <label className="min-w-0 text-[11px] font-semibold text-ink-3">
                캠페인
                <select
                  value={attributionCampaignId}
                  onChange={(event) => setAttributionCampaignId(event.target.value)}
                  disabled={!attributionProgramId}
                  className="mt-1 min-h-10 w-full rounded-md border border-line bg-canvas px-3 text-sm text-ink disabled:opacity-50"
                >
                  <option value="">캠페인 미지정</option>
                  {attributionCampaignOptions.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>{campaign.name || campaign.id}</option>
                  ))}
                </select>
              </label>
              <label className="min-w-0 text-[11px] font-semibold text-ink-3">
                변경 사유
                <input
                  value={attributionReason}
                  onChange={(event) => setAttributionReason(event.target.value)}
                  placeholder="확인 근거를 5자 이상 입력"
                  className="mt-1 min-h-10 w-full rounded-md border border-line bg-canvas px-3 text-sm text-ink placeholder:text-ink-4"
                />
              </label>
              <div className="flex flex-wrap gap-2 xl:justify-end">
                <Button
                  size="sm"
                  onClick={() => void saveConversationAttribution(attributionProgramId ? "program" : "direct")}
                  disabled={attributionSaving || isViewingAs}
                  title={isViewingAs ? "대신 보기 중에는 비활성" : undefined}
                >
                  {attributionSaving ? "저장 중…" : "귀속 저장"}
                </Button>
                {canRevertAttribution ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void revertLastConversationAttribution()}
                    disabled={attributionSaving || isViewingAs}
                    title={isViewingAs ? "대신 보기 중에는 비활성" : undefined}
                  >
                    마지막 변경 되돌리기
                  </Button>
                ) : null}
                <Button size="sm" variant="secondary" onClick={() => setAttributionEditorOpen(false)} disabled={attributionSaving}>
                  닫기
                </Button>
              </div>
            </div>
            {conv.attribution?.suggested?.primaryBucket === "program" ? (
              <p className="mt-2 text-[11px] text-ink-4">
                엔진 제안: {conv.attribution.suggested.programId}
                {conv.attribution.suggested.campaignId ? ` / ${conv.attribution.suggested.campaignId}` : ""}
                {` · 신뢰도 ${Math.round(conv.attribution.suggested.confidence * 100)}%`}
              </p>
            ) : null}
          </div>
        )}

        {effectiveAiOn && (
          <div className="flex items-center gap-1.5 border-b border-line bg-ai-soft/40 px-6 py-2 text-xs text-ai">
            <Sparkles className="h-3.5 w-3.5" />
            AI가 가이드 범위 내 회신을 자동 처리 중
          </div>
        )}

        <ScheduledAutoReplyPanel
          conversation={conv}
          onRequestHuman={requestHumanIntervention}
          loading={humanRequesting}
          isViewingAs={isViewingAs}
        />

        {/* W106 Phase 2 — 갈래 칩 바(시안 v2 .strand-bar-wrap 이식). 전체 ↔ 단일 갈래 드릴다운. */}
        {tab === "person" && selectedPersonRoom && (
          <div data-testid="person-strand-bar" className="flex flex-wrap items-center gap-2 border-b border-line bg-paper px-6 py-2.5">
            <span className="shrink-0 text-[10.5px] font-bold uppercase tracking-wide text-ink-4">갈래</span>
            <button
              type="button"
              onClick={() => selectStrandFilter("all")}
              className={cn(
                "inline-flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold transition-colors",
                strandFilter === "all" ? "border-ink bg-ink text-white" : "border-line bg-paper text-ink-2 hover:bg-fill",
              )}
            >
              전체 <span className="text-ink-4">{selectedPersonRoom.strands.some((strand) => !loadedMessageKeys.has(strand.uiThreadKey ?? workflowConversationKey(strand))) && selectedPersonRoom.mergedMessages.length === 0 ? "불러오는 중" : selectedPersonRoom.mergedMessages.length}</span>
            </button>
            {selectedPersonRoom.strands.map((strand) => {
              const strandKeyValue = strand.uiThreadKey ?? workflowConversationKey(strand);
              const active = strandFilter === strandKeyValue;
              const tag = personStrandTagByKey.get(strandKeyValue);
              return (
                <button
                  key={strandKeyValue}
                  type="button"
                  data-strand-key={strandKeyValue}
                  onClick={() => selectStrandFilter(strandKeyValue)}
                  title={tag?.label}
                  className={cn(
                    "inline-flex h-[30px] max-w-[220px] items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold transition-colors",
                    active
                      ? tag?.kind === "program"
                        ? "border-ai/40 bg-ai-soft text-ai"
                        : tag?.kind === "campaign"
                          ? "border-accent/40 bg-accent-soft text-accent"
                          : "border-warn/40 bg-warn-soft text-warn"
                      : "border-line bg-paper text-ink-2 hover:bg-fill",
                  )}
                >
                  <span
                    className={cn(
                      "h-[7px] w-[7px] shrink-0 rounded-full",
                      tag?.kind === "program" ? "bg-ai" : tag?.kind === "campaign" ? "bg-accent" : tag?.kind === "mail" ? "bg-warn" : "bg-ink-4",
                    )}
                  />
                  <span className="truncate">{tag?.label}</span>
                  <span className="text-ink-4">{strand.messages.length}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* 대화 열기는 읽기 전용이다. AI 호출은 아래 명시적 초안 버튼을 누른 뒤에만 실행한다. */}
        {drafting && (
          <div className="flex items-center gap-1.5 border-b border-line bg-fill/60 px-6 py-2 text-xs text-ink-3" role="status">
            <Sparkles className="h-3.5 w-3.5 animate-pulse" />
            AI 초안 준비 중…
          </div>
        )}

        {/* S4/P4 (Q3): AI 자동 초안 미생성 사유 배너 + 재시도 — autoReplyBlockedReason은
            기존에도 저장됐지만 렌더하는 UI가 전무했다.
            R5-E: Infly DB 기존 연락처(콜드아웃리치 억제, mail-safety.infly-overlap)는 버그가 아니라
            정상 억제 사유이므로, 다른 차단 사유와 같은 "미생성" 톤 대신 구분되는 라벨/톤으로 보여준다. */}
        {/* W98(헤세): 참고용 초안이 이미 있으면 "AI 초안 있음 · 자동 발송 보류/증거 부족" 배너는
            중복 정보라 숨긴다 — 재생성 버튼은 아래 초안 박스로 이동. 초안이 없거나(미생성 사유
            안내가 필요) Infly 특수 안내인 경우에만 배너 유지. */}
        {!drafting && effectiveBlockedReason && (!effectiveHumanDraftSuggestion || effectiveBlockedReasonIsInflyOverlap) && (
          <div
            className={`mx-3 mt-2 flex items-start gap-2.5 rounded-md border p-3 ${
              effectiveBlockedReasonIsInflyOverlap ? "border-info/30 bg-info-soft" : "border-line bg-fill"
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className={`mb-1 text-[11px] font-bold ${effectiveBlockedReasonIsInflyOverlap ? "text-info" : "text-ink-2"}`}>
                {effectiveBlockedReasonIsInflyOverlap
                  ? "Infly DB 기존 연락처 — 콜드아웃리치 억제됨"
                  : hasDraftAlongsideBlockedReason
                    ? "AI 초안 있음 · 자동 발송 보류"
                    : "AI 자동 초안 미생성"}
              </div>
              <p className="text-[13px] leading-relaxed text-ink-2">
                {effectiveBlockedReasonIsLowEvidence ? "증거 부족(팔로워·최근 조회수·참여율 데이터 미충족) — 사람 검수 필요" : effectiveBlockedReason}
              </p>
              {effectiveBlockedReasonIsInflyOverlap ? (
                <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
                  이 크리에이터는 Infly에 이미 등록되어 있어 신규 콜드 발송이 차단된 정상 상태입니다. 이미 열린 대화의 회신 초안은
                  아래 참고용 초안(있는 경우)에서 확인하세요.
                </p>
              ) : null}
            </div>
            <Button size="sm" variant="secondary" onClick={openAiDraftModal}>
              AI 초안 다시 생성
            </Button>
          </div>
        )}

        {/* S4/P4 (Q3/A11): needs_review 참고용 초안 — humanDraftSuggestion. 발송 자격은
            없으며(어떤 발송 경로도 이 필드를 읽지 않음), 검토 후 "사용" 확정 시에만 작성창에
            채워진다(발송 전 confirmation).
            R5-E: Infly 억제로 콜드가 막힌 경우에도 이미 열린 대화의 회신 참고초안은 이 블록이 그대로
            노출한다(별도 게이트 없음) — human gate/draft_only 완화 없이 노출만 강화. */}
        {effectiveHumanDraftSuggestion && (
          <div className="mx-3 mt-2 rounded-md border border-ai/20 bg-ai-soft/40 p-3">
            <div className="mb-1 inline-flex items-center gap-1.5">
              <span className="rounded-full bg-ai/15 px-2 py-0.5 text-[11px] font-bold text-ai">AI 참고용 — 발송 전 검토 필수</span>
              {effectiveBlockedReasonIsInflyOverlap ? (
                <span className="rounded-full bg-info/15 px-2 py-0.5 text-[11px] font-bold text-info">콜드 아님 · 회신 초안</span>
              ) : null}
            </div>
            <pre className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-ink [&_a]:text-accent">
              <MailText text={effectiveHumanDraftSuggestion} />
            </pre>
            {effectiveHumanDraftSuggestionKr && (
              <p className="mt-1.5 rounded bg-fill px-2 py-1 text-[12px] leading-relaxed text-ink-2">
                <span className="mr-1 font-semibold text-ink-3">요지</span>
                {effectiveHumanDraftSuggestionKr}
              </p>
            )}
            {pendingHumanDraftUse ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-ink-2">검토를 마쳤고 이 참고용 초안을 작성창에 채워 넣으시겠습니까?</span>
                <Button size="sm" onClick={() => useHumanDraftSuggestion(effectiveHumanDraftSuggestion!)}>
                  사용 확정
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setPendingHumanDraftUse(false)}>
                  취소
                </Button>
                <Button size="sm" variant="secondary" onClick={openAiDraftModal}>
                  AI 초안 다시 생성
                </Button>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => setPendingHumanDraftUse(true)}>
                  이 초안 사용
                </Button>
                <Button size="sm" variant="secondary" onClick={openAiDraftModal}>
                  AI 초안 다시 생성
                </Button>
              </div>
            )}
          </div>
        )}

        {requestedMessageMissing && (
          <div className="mx-3 mt-2 flex items-start gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn" role="status">
            <Alert className="mt-0.5 h-4 w-4 shrink-0" />
            요청한 원문 메시지를 이 대화에서 찾지 못했습니다. 최신 전체 대화를 표시합니다.
          </div>
        )}

        {selectedMessagesLoading && !(tab === "person" && selectedPersonRoom && strandFilter === "all") ? (
          <p className="px-6 pt-4 text-xs text-ink-3" role="status" data-testid="chat-messages-loading">메시지 불러오는 중</p>
        ) : null}
        {/* 메시지 — W106: 사람 방 전체 뷰(strandFilter==="all")만 병합 타임라인으로 갈아탄다.
            갈래 필터 중엔 conv 가 이미 그 갈래이므로(§4 L3) 기존 selectedMessages 경로 그대로. */}
        {tab === "person" && selectedPersonRoom && strandFilter === "all" ? (
          <VirtualList
            items={selectedPersonRoom.mergedMessages}
            estimateSize={82}
            getKey={(message) => `${selectedViewMailAccountId}:${message.id}`}
            gap={12}
            initialScroll="end"
            className="flex-1 p-6"
            renderItem={(m) => (
              <ChatBubble
                msg={m}
                mailAccountId={selectedViewMailAccountId || undefined}
                feedbackScope={selectedFeedbackScope}
                strandLabel={personStrandTagByKey.get(m.sourceUiThreadKey)?.label}
                strandSpan={m.strandSpan}
                otherConversationTail={messageOtherConversationTail(m, selectedConversationId)}
                onReplyToStrand={m.from === "creator" ? () => selectReplyTargetByUser(m.sourceUiThreadKey) : undefined}
              />
            )}
          />
        ) : (
          <VirtualList
            items={selectedMessages}
            estimateSize={78}
            getKey={(message) => `${selectedViewMailAccountId}:${message.id}`}
            gap={12}
            initialScroll={requestedMessageIndex >= 0 ? "start" : "end"}
            initialIndex={requestedMessageIndex >= 0 ? requestedMessageIndex : undefined}
            className="flex-1 p-6"
            renderItem={(m) => (
              <ChatBubble
                msg={m}
                mailAccountId={selectedViewMailAccountId || undefined}
                targeted={m.messageRef === requestedMessageRef}
                feedbackScope={selectedFeedbackScope}
                otherConversationTail={messageOtherConversationTail(m, selectedConversationId)}
              />
            )}
          />
        )}

        {/* 에스컬레이션 배너 */}
        {conv.alert && (
          <div className="mx-3 mb-2 flex items-start gap-2.5 rounded-md border border-danger/30 bg-danger-soft p-3">
            <Alert className="mt-0.5 h-[18px] w-[18px] shrink-0 text-danger" />
            <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-danger">{conv.alert}</p>
            <div className="flex shrink-0 items-center gap-2">
              {/* 검수 큐로 실제 이동시킨다. 목적지를 만들 수 있는 귀속 근거가 없으면 버튼을 걸지 않는다. */}
              {reviewQueueHref ? (
                <Link
                  href={reviewQueueHref}
                  className="inline-flex min-h-8 items-center rounded-md border border-line bg-paper px-3 text-xs font-semibold text-ink-2 hover:bg-fill"
                >
                  검수 열기
                </Link>
              ) : null}
              <Button
                size="sm"
                onClick={requestHumanIntervention}
                disabled={humanRequesting || isViewingAs}
                title={isViewingAs ? "대신 보기 중에는 비활성" : undefined}
              >
                {humanRequesting ? "전환 중" : "사람이 회신"}
              </Button>
            </div>
          </div>
        )}

        {actionError && (
          <div className="mx-3 mb-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
            {actionError}
          </div>
        )}

        {sendSuppressionWarning && (
          <div
            className="mx-3 mb-2 flex items-start gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn"
            role="status"
          >
            <Badge tone="warn">억제 목록 예외</Badge>
            <span className="min-w-0 flex-1">{sendSuppressionWarning}</span>
          </div>
        )}

        {messageLoadError && (
          <div className="mx-3 mb-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs leading-relaxed text-danger">
            전체 대화 스레드를 불러오지 못했습니다. 일부 메시지만 표시될 수 있습니다. {messageLoadError}
          </div>
        )}

        {draftActionForConv.status === "done" && draftActionForConv.outcome === "composer_ready" ? (
          <div className="mx-3 mb-2 rounded-md border border-ok/25 bg-ok-soft px-3 py-2 text-xs font-semibold text-ok" role="status">
            AI 초안을 작성창에 준비했습니다. 검토 후 발송하세요.
          </div>
        ) : null}

        {draftActionForConv.status === "error" ? (
          <div className="mx-3 mb-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger" role="alert">
            AI 초안 생성 실패: {draftActionForConv.error || "다시 시도해주세요."}
          </div>
        ) : null}

        {overwrittenDraftBackup ? (
          <div className="mx-3 mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warn/25 bg-warn-soft px-3 py-2 text-xs text-warn" role="status">
            <span>AI 초안으로 작성창을 교체했습니다. 이전 작성본은 이 대화 안에서 복구할 수 있습니다.</span>
            <button
              type="button"
              className="rounded-md border border-warn/30 bg-paper px-2 py-1 font-semibold text-warn hover:bg-fill"
              onClick={() => {
                setDraftBody(overwrittenDraftBackup);
                setOverwrittenDraftBackup("");
                draftComposerStateRef.current.dirty = true;
              }}
            >
              이전 작성본 복구
            </button>
          </div>
        ) : null}

        {!canSendMail && (
          <div className="mx-3 mb-2 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs leading-relaxed text-warn" role="note">
            현재 역할은 메일 발송 권한이 없습니다. Manager 이상 계정에서 미리보기와 발송을 진행하세요.
          </div>
        )}
        {canSendMail && !orgContext && (
          <div className="mx-3 mb-2 rounded-md border border-line bg-fill px-3 py-2 text-xs leading-relaxed text-ink-3" role="status">
            현재 팀의 발신 정책을 확인하는 중입니다. 확인이 끝날 때까지 메일 발송이 비활성화됩니다.
          </div>
        )}
        {canSendMail && orgContext && senderBlocked && (
          <div className="mx-3 mb-2 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs leading-relaxed text-warn" role="status">
            {composeSendBlockedMessage}
            {orgContext.senderBlockedReason === "personal_connection_required" && (
              <Link href="/admin/integrations" className="ml-1 font-semibold underline underline-offset-2">
                내 메일함 연결
              </Link>
            )}
          </div>
        )}

        {/* W106 Phase 2 — 답장 대상 칩(부록 규칙 1-3, 시안 v2 .reply-target-bar 이식).
            composer 위 상시 노출. 기본값=defaultReplyStrand, 갈래 필터 중엔 잠금. */}
        {tab === "person" && selectedPersonRoom && personReplyTarget && (
          <div className="flex items-center gap-2 px-3 pt-2">
            <span className="shrink-0 text-[10.5px] font-bold uppercase tracking-wide text-ink-4">답장 대상</span>
            <div className="relative">
              <button
                type="button"
                data-testid="person-reply-target-chip"
                data-target-strand={personReplyTarget.kind === "strand" ? personTargetStrandKey : "__new__"}
                onClick={() => {
                  if (!personReplyTarget.locked) setReplyTargetMenuOpen((open) => !open);
                }}
                title={personReplyTarget.locked ? "갈래 보기 중에는 답장 대상이 고정됩니다" : "클릭해서 답장 대상 갈래 변경"}
                className={cn(
                  "inline-flex h-7 max-w-[320px] items-center gap-1.5 rounded-full border border-line bg-fill px-2.5 text-xs font-semibold text-ink transition-colors",
                  personReplyTarget.locked ? "cursor-default" : "hover:bg-fill-2",
                )}
              >
                {personReplyTarget.kind === "new" ? (
                  <>
                    <span className="font-black text-accent">+</span>
                    <span className="truncate">새 메일 (새 갈래)</span>
                  </>
                ) : (
                  <>
                    <span
                      className={cn(
                        "h-[7px] w-[7px] shrink-0 rounded-full",
                        personStrandTagByKey.get(personTargetStrandKey)?.kind === "program"
                          ? "bg-ai"
                          : personStrandTagByKey.get(personTargetStrandKey)?.kind === "campaign"
                            ? "bg-accent"
                            : personStrandTagByKey.get(personTargetStrandKey)?.kind === "mail"
                              ? "bg-warn"
                              : "bg-ink-4",
                      )}
                    />
                    <span className="truncate">{personStrandTagByKey.get(personTargetStrandKey)?.label ?? "갈래"}</span>
                  </>
                )}
                {personReplyTarget.locked ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className="h-3.5 w-3.5 shrink-0 text-ink-3">
                    <rect x="5" y="11" width="14" height="9" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className="h-3.5 w-3.5 shrink-0 text-ink-3">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                )}
              </button>
              {!personReplyTarget.locked && replyTargetMenuOpen && (
                <div data-testid="person-reply-target-menu" className="absolute bottom-full left-0 z-40 mb-2 min-w-[240px] rounded-lg border border-line bg-paper p-1.5 shadow-pop">
                  {selectedPersonRoom.strands.map((strand) => {
                    const strandKeyValue = strand.uiThreadKey ?? workflowConversationKey(strand);
                    const tag = personStrandTagByKey.get(strandKeyValue);
                    const current = personReplyTarget.kind === "strand" && personTargetStrandKey === strandKeyValue;
                    return (
                      <button
                        key={strandKeyValue}
                        type="button"
                        data-strand-key={strandKeyValue}
                        onClick={() => {
                          selectReplyTargetByUser(strandKeyValue);
                          setReplyTargetMenuOpen(false);
                        }}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] font-semibold",
                          current ? "bg-accent-soft text-accent" : "text-ink hover:bg-fill",
                        )}
                      >
                        <span
                          className={cn(
                            "h-[7px] w-[7px] shrink-0 rounded-full",
                            tag?.kind === "program" ? "bg-ai" : tag?.kind === "campaign" ? "bg-accent" : tag?.kind === "mail" ? "bg-warn" : "bg-ink-4",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">{tag?.label}</span>
                        <span className="shrink-0 text-ink-4">{strand.messages.length}개</span>
                      </button>
                    );
                  })}
                  <div className="my-1 h-px bg-line" />
                  <button
                    type="button"
                    onClick={() => {
                      selectReplyTargetByUser("__new__");
                      setReplyTargetMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] font-semibold text-accent hover:bg-fill"
                  >
                    <span className="font-black">+</span> 새 메일 (새 갈래 시작)
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        <div data-testid="chat-composer-context" data-compose-conversation={selectedConversationId} className="contents" />
        <ChatComposerFields
          composeKey={composeScopeKey}
          composeRecipient={composeRecipient}
          onRecipientChange={setComposeRecipient}
          selectedSenderId={selectedSenderId}
          onSenderChange={handleSenderChange}
          selectedSender={selectedSender}
          usableSenderAccounts={usableSenderAccounts}
          orgContext={orgContext}
          draft={draft}
          onDraftChange={() => {
            draftComposerStateRef.current = {
              ...draftComposerStateRef.current,
              conversationKey: composeScopeKey,
              dirty: true,
            };
          }}
          setDraftBody={setDraftBody}
          drafting={drafting}
          sending={sending}
          previewLoading={previewLoading}
          canComposeSend={canComposeSend}
          composeSendBlockedMessage={composeSendBlockedMessage}
          composerSenderMismatched={composerSenderMismatched}
          isViewingAs={isViewingAs}
          onOpenAiDraft={openAiDraftModal}
          onPreview={() => void handlePreview()}
          onSend={() => void handleDraftSend()}
        />
      </section>
        {aiDraftModalOpen ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-4 backdrop-blur-[1px]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-draft-modal-title"
            onClick={() => setAiDraftModalOpen(false)}
          >
            <div
              ref={aiDraftModalPanelRef}
              tabIndex={-1}
              onClick={(event) => event.stopPropagation()}
              className="flex max-h-[88vh] w-full max-w-[620px] flex-col overflow-hidden rounded-xl border border-line bg-paper shadow-pop outline-none"
            >
              <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
                <div>
                  <div className="mb-1 inline-flex items-center gap-1.5 rounded-full bg-ai-soft px-2 py-0.5 text-[11px] font-bold text-ai">
                    <Sparkles className="h-3 w-3" /> AI 답장 도우미
                  </div>
                  <h2 id="ai-draft-modal-title" className="text-base font-bold text-ink">AI 초안 다시 생성</h2>
                  <p className="mt-1 text-xs leading-relaxed text-ink-3">이번 답장에서 전달할 내용을 적고, 생성 결과를 확인한 뒤 작성창에 적용하세요.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setAiDraftModalOpen(false)}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-fill hover:text-ink"
                  aria-label="AI 초안 팝업 닫기"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-4 overflow-y-auto px-5 py-4">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-bold text-ink-2">이번 답장에 반영할 내용</span>
                  <textarea
                    ref={aiDraftInstructionRef}
                    value={aiDraftInstruction}
                    onChange={(event) => setAiDraftInstruction(event.target.value)}
                    maxLength={500}
                    rows={4}
                    placeholder="예: 지원서 검토 결과 통과되었음을 알리고, 대시보드 로그인 후 다음 단계를 확인하도록 안내해 주세요."
                    className="w-full resize-y rounded-lg border border-line bg-paper px-3 py-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-3 focus:border-ai focus:outline-none focus:ring-2 focus:ring-ai/15"
                  />
                  <span className="mt-1 block text-right text-[11px] text-ink-4">{aiDraftInstruction.length}/500</span>
                </label>

                {drafting ? (
                  <div className="flex min-h-40 flex-col items-center justify-center rounded-lg border border-ai/20 bg-ai-soft/35 px-4 py-8 text-center" role="status" aria-live="polite">
                    <Sparkles className="h-7 w-7 animate-spin text-ai" />
                    <p className="mt-3 text-sm font-bold text-ink">AI가 답장 초안을 만들고 있습니다</p>
                    <p className="mt-1 text-xs text-ink-3">대화·프로그램·캠페인 맥락과 입력한 지시를 함께 확인합니다.</p>
                  </div>
                ) : aiDraftPreview ? (
                  <section className="rounded-lg border border-ai/20 bg-ai-soft/25 p-4" aria-label="AI 초안 미리보기">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-xs font-bold text-ai">생성 결과 미리보기</span>
                      {aiDraftPreview.decision === "needs_review" ? <Badge tone="warn">사람 검토 필수</Badge> : <Badge tone="ai">발송 전 검토</Badge>}
                    </div>
                    {aiDraftPreview.blockedReason ? <p className="mb-2 text-xs text-warn">{aiDraftPreview.blockedReason}</p> : null}
                    <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-line bg-paper p-3 text-sm leading-relaxed text-ink">
                      <MailText text={aiDraftPreview.text} />
                    </pre>
                    {aiDraftPreview.summaryKr ? (
                      <p className="mt-2 rounded-md bg-fill px-3 py-2 text-xs leading-relaxed text-ink-2"><span className="mr-1 font-bold text-ink-3">요지</span>{aiDraftPreview.summaryKr}</p>
                    ) : null}
                  </section>
                ) : draftActionForConv.status === "error" ? (
                  <div className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">
                    AI 초안 생성 실패: {draftActionForConv.error || "다시 시도해주세요."}
                  </div>
                ) : draftActionForConv.outcome === "blocked" ? (
                  <div className="rounded-lg border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
                    {draftActionForConv.blockedReason || "현재 맥락에서는 AI 초안을 만들 수 없습니다."}
                  </div>
                ) : (
                  <div className="rounded-lg border border-line bg-fill px-4 py-3 text-xs leading-relaxed text-ink-3">
                    작성창의 기존 내용은 이 팝업에서 초안을 생성하는 동안 변경되지 않습니다.
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-fill/50 px-5 py-3">
                <Button variant="secondary" onClick={() => setAiDraftModalOpen(false)}>취소</Button>
                <Button
                  variant="secondary"
                  disabled={drafting || isViewingAs}
                  onClick={() => void handleAiDraft()}
                  title={isViewingAs ? "대신 보기 중에는 비활성" : undefined}
                >
                  <Sparkles className={cn("h-4 w-4 text-ai", drafting && "animate-spin")} />
                  {aiDraftPreview ? "다시 생성" : "AI 초안 생성"}
                </Button>
                <Button disabled={!aiDraftPreview || drafting} onClick={applyAiDraftPreview}>초안 적용하기</Button>
              </div>
            </div>
          </div>
        ) : null}
        <MailPreviewDialog open={previewOpen} data={previewData} onClose={() => setPreviewOpen(false)} />
    </div>
  );
}
