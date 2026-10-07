import { canonicalCreatorId, canonicalThreadId, conversationThreadCandidates } from "./creator-identity.ts";
import { isScpProgramId } from "./scp-program-alias.ts";
import { workflowContextKey, workflowConversationKey } from "./workflow-context.ts";

const PARTICIPATION_STAGES = new Set(["contact", "negotiation", "contract", "review", "live"] as const);
export type ConversationParticipationStage = "contact" | "negotiation" | "contract" | "review" | "live";

export type ChatMessage = {
  id: string;
  from: "ai" | "human" | "creator";
  author: string;
  text: string;
  time: string;
  createdAtIso?: string;
  sentAtIso?: string;
  receivedAtIso?: string;
  mailEventAtIso?: string;
  messageRef?: string;
  // 이 메시지를 소유한 실제 conversations 문서 id(병합 스레드에서 reply source 바인딩용).
  conversationId?: string;
  trackingId?: string;
  deliveryState?: "queued_for_review" | "queued_for_send" | "sent" | "mock_sent" | "received" | "blocked";
  humanGate?: "auto_reply" | "needs_review" | "blocked" | "auto_close";
  campaignId?: string;
  programId?: string;
  /** Which stored field the shown text came from — "summary" means the original body is not shown. */
  textSource?: "text" | "summary" | "preview" | "body";
};

export type ChatConversationAttributionSnapshot = {
  primaryBucket: "program" | "direct";
  programId?: string;
  campaignId?: string;
  confidence: number;
  source: "automatic" | "manual" | "revert";
  reasonId: string;
  decidedAtIso?: string;
};

export type ChatConversationAttributionStatus = "legacy/unrecorded" | "automatic" | "manual_confirmed";

function recordedAttributionStatus(value: unknown): Exclude<ChatConversationAttributionStatus, "legacy/unrecorded"> | undefined {
  return value === "automatic" || value === "manual_confirmed" ? value : undefined;
}

export type ChatConversationAttribution = {
  policyVersion?: string;
  attributionStatus?: Exclude<ChatConversationAttributionStatus, "legacy/unrecorded">;
  version: number;
  reviewRequired: boolean;
  original?: ChatConversationAttributionSnapshot;
  suggested?: ChatConversationAttributionSnapshot;
  final?: ChatConversationAttributionSnapshot;
  updatedAtIso?: string;
};

export type ChatConversation = {
  id: string;
  threadId?: string;
  threadConversationIds?: string[];
  uiThreadKey?: string;
  contextKey?: string;
  type?: string;
  originalCreatorId?: string;
  candidateId?: string;
  creatorId: string;
  creatorName?: string;
  creatorAvatar?: string;
  creatorEmail?: string;
  creatorHandle?: string;
  creatorPlatform?: string;
  creatorFollowers?: number;
  channelId?: string;
  youtubeUrl?: string;
  profileMatchedEmail?: string;
  profileSourceRef?: string;
  profileSnapshotUpdatedAtIso?: string;
  programId?: string;
  canonicalProgramId?: string;
  programTitle?: string;
  campaignId?: string;
  campaignTitle?: string;
  applicationId?: string;
  applicationRef?: string;
  participationActive?: boolean;
  participationStatus?: "pending" | "hold" | "active" | "retracted";
  participationStage?: ConversationParticipationStage;
  participationUpdatedAtIso?: string;
  source?: string;
  protected?: boolean;
  hasCreatorReply?: boolean;
  hiddenFromDefaultChat?: boolean;
  lastInboundAtIso?: string;
  visibility?: string;
  routeReason?: string;
  attribution?: ChatConversationAttribution;
  attributionStatus: ChatConversationAttributionStatus;
  /** Derived client-side owner document for the merged thread attribution state. */
  attributionOwnerConversationId?: string;
  attributionReviewRequired?: boolean;
  lastAttributionAuditRef?: string;
  archivedAt?: string;
  deletedAt?: string;
  deliveryState?: string;
  lastDeliveryState?: string;
  outreachStatus?: string;
  status?: string;
  humanGate?: "auto_reply" | "needs_review" | "blocked" | "auto_close";
  manualIntervention?: {
    status: "open" | "resolved";
    reason?: string;
    requestedAt?: string;
    requestedBy?: string;
  };
  unread: number;
  aiActive: boolean;
  alert?: string;
  nextAutoReplyAtIso?: string;
  autoReplyDraftText?: string;
  autoReplyQueueRef?: string;
  // "closed" (auto-close 정책 B): 순수 종결 인사로 서버가 스레드를 닫은 상태 — 발송·검수·
  //   재큐 대상이 아닌 종결 표식이다.
  autoReplyStatus?: "scheduled" | "sent" | "waiting_for_human" | "blocked" | "failed" | "draft_only" | "expired_stale" | "closed";
  autoReplyBlockedReason?: string;
  // auto-close 정책(B): autoReplyStatus="closed" 일 때 서버가 남기는 종결 사유·시각.
  autoReplyClosedReason?: string;
  autoReplyClosedAtIso?: string;
  // S4/P4 (Q3/A11): needs_review 참고용 초안 — humanDraftSuggestion. autoReplyDraftText와
  // 완전히 별도 필드이며 어떤 발송 경로도 이 필드를 읽지 않는다(발송 자격 승격 금지).
  humanDraftSuggestion?: string;
  // W98: 초안 한국어 요지 (운영자 안내용)
  humanDraftSuggestionKr?: string;
  messages: ChatMessage[];
  lastMessage?: string;
  lastMessageAtIso?: string;
  lastMessageFrom?: ChatMessage["from"];
  lastMessageRef?: string;
  // lastMessageRef 를 가진(가장 최근) 실제 대화 id — 병합 그룹에서도 base(최신 멤버)의 값이 유지된다.
  lastMessageConversationId?: string;
  updatedAtIso?: string;
};

type MinimalCreator = {
  id: string;
  name: string;
  handle?: string;
  creatorId?: string;
  candidateId?: string;
  channelId?: string;
  email?: string;
  profileMatchedEmail?: string;
  youtubeUrl?: string;
  platform?: string;
  followers?: number;
  avatar?: string;
};

const MVP_CONVERSATION_ID = "v-hesse";
const LEGACY_DEMO_CONVERSATION_IDS = new Set(["v1", "v2", "v3", "v4"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) || isRecord(value)) return "";
  if (value == null) return "";
  return String(value);
}

function optionalString(value: unknown): string | undefined {
  return stringValue(value) || undefined;
}

function isProfileImageUrl(value?: string): boolean {
  return typeof value === "string" && /^(https?:\/\/|\/)/.test(value.trim());
}

function numberValue(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function participationStage(value: unknown): ConversationParticipationStage | undefined {
  return typeof value === "string" && PARTICIPATION_STAGES.has(value as ConversationParticipationStage)
    ? value as ConversationParticipationStage
    : undefined;
}

export function conversationParticipationStage(
  conversation: Pick<ChatConversation, "programId" | "participationActive" | "participationStatus" | "participationStage">,
  creator?: { stage?: string },
): ConversationParticipationStage | undefined {
  if (conversation.participationStatus === "retracted" || conversation.participationActive === false) return undefined;
  const scopedStage = participationStage(conversation.participationStage);
  if (conversation.participationActive === true) return scopedStage;
  if (isScpProgramId(conversation.programId)) return participationStage(creator?.stage);
  if (!conversation.programId) return participationStage(creator?.stage);
  return undefined;
}

export function messageFrom(value: unknown): ChatMessage["from"] {
  if (value === "ai" || value === "human" || value === "creator") return value;
  return "ai";
}

function deliveryState(value: unknown): ChatMessage["deliveryState"] {
  if (
    value === "queued_for_review" ||
    value === "queued_for_send" ||
    value === "sent" ||
    value === "mock_sent" ||
    value === "received" ||
    value === "blocked"
  ) {
    return value;
  }
  return undefined;
}

function humanGate(value: unknown): ChatMessage["humanGate"] {
  if (value === "auto_reply" || value === "needs_review" || value === "blocked" || value === "auto_close") return value;
  return undefined;
}

function manualIntervention(value: unknown): ChatConversation["manualIntervention"] {
  if (!isRecord(value) || (value.status !== "open" && value.status !== "resolved")) return undefined;
  return {
    status: value.status,
    reason: optionalString(value.reason),
    requestedAt: optionalString(value.requestedAt),
    requestedBy: optionalString(value.requestedBy),
  };
}

function attributionSnapshot(value: unknown): ChatConversationAttributionSnapshot | undefined {
  if (!isRecord(value) || (value.primaryBucket !== "program" && value.primaryBucket !== "direct")) return undefined;
  const programId = value.primaryBucket === "program" ? optionalString(value.programId) : undefined;
  if (value.primaryBucket === "program" && !programId) return undefined;
  const source = value.source === "manual" || value.source === "revert" ? value.source : "automatic";
  return {
    primaryBucket: value.primaryBucket,
    ...(programId ? { programId } : {}),
    ...(programId && optionalString(value.campaignId) ? { campaignId: optionalString(value.campaignId) } : {}),
    confidence: Math.min(1, Math.max(0, numberValue(value.confidence))),
    source,
    reasonId: optionalString(value.reasonId) ?? "attribution_unspecified",
    decidedAtIso: optionalString(value.decidedAtIso),
  };
}

function conversationAttribution(value: unknown): ChatConversationAttribution | undefined {
  if (!isRecord(value)) return undefined;
  const original = attributionSnapshot(value.original);
  const suggested = attributionSnapshot(value.suggested);
  const final = attributionSnapshot(value.final);
  if (!original && !suggested && !final) return undefined;
  const derivedStatus = final
    ? final.source === "manual" || final.source === "revert"
      ? "manual_confirmed"
      : "automatic"
    : undefined;
  const declaredStatus = recordedAttributionStatus(value.attributionStatus);
  const attributionStatus = declaredStatus === derivedStatus ? declaredStatus : derivedStatus;
  return {
    policyVersion: optionalString(value.policyVersion),
    attributionStatus,
    version: Math.max(0, Math.trunc(numberValue(value.version))),
    reviewRequired: booleanValue(value.reviewRequired),
    original,
    suggested,
    final,
    updatedAtIso: optionalString(value.updatedAtIso),
  };
}

export function normalizeMessage(value: unknown, fallbackId: string): ChatMessage | null {
  if (!isRecord(value)) return null;
  // W116: 툴 발송과 중복으로 확인된 보낸편지함 편입 메시지는 화면에서 뺀다. 서버는 원장에서
  // 지우는 대신 `hiddenReason` 만 단다(삭제는 파괴적이고 되돌릴 수 없다) — 숨김은 여기서 한다.
  // **등가 비교**다: truthy 검사로 두면 원장에 들어온 임의의 문자열이 대화를 조용히 지운다.
  // 서버도 같은 값만 투영한다(functions/read.ts PUBLIC_CONVERSATION_MESSAGE_HIDDEN_REASONS).
  if (optionalString(value.hiddenReason) === "tool_duplicate") return null;
  const text = stringValue(value.text ?? value.summaryKr ?? value.bodyPreview ?? value.body);
  const summaryKr = optionalString(value.summaryKr);
  const textSource: ChatMessage["textSource"] = value.textSource === "summary"
    ? "summary"
    : value.text !== undefined && value.text !== null
    ? (summaryKr && stringValue(value.text).trim() === summaryKr.trim() ? "summary" : "text")
    : summaryKr !== undefined ? "summary" : value.bodyPreview !== undefined && value.bodyPreview !== null ? "preview" : "body";
  const from = messageFrom(value.from);
  const author = optionalString(value.author) ?? (from === "creator" ? "Creator" : from === "human" ? "헤세" : "Flu AI");
  const programId = optionalString(value.programId);
  const createdAtIso = optionalString(value.createdAtIso);
  const sentAtIso = optionalString(value.sentAtIso);
  const receivedAtIso = optionalString(value.receivedAtIso);
  const mailEventAtIso = optionalString(value.mailEventAtIso) ?? sentAtIso ?? receivedAtIso ?? createdAtIso;
  return {
    id: optionalString(value.id) ?? fallbackId,
    from,
    author,
    text,
    time: stringValue(value.time),
    createdAtIso: mailEventAtIso,
    sentAtIso,
    receivedAtIso,
    mailEventAtIso,
    messageRef: optionalString(value.messageRef),
    ...(optionalString(value.conversationId) ? { conversationId: optionalString(value.conversationId) } : {}),
    trackingId: optionalString(value.trackingId),
    deliveryState: deliveryState(value.deliveryState),
    humanGate: humanGate(value.humanGate),
    campaignId: optionalString(value.campaignId),
    ...(programId ? { programId } : {}),
    // Only stamped when the shown text is the stored summary (keeps the existing message shape otherwise).
    ...(textSource === "summary" ? { textSource } : {}),
  };
}

/**
 * When a thread view merges messages from several conversation docs of the same person
 * (threadConversationIds), returns the last 6 characters of the OTHER conversation a message came
 * from, so the bubble can say "다른 대화"; null when it belongs to the shown conversation or is unknown.
 */
export function messageOtherConversationTail(message: Pick<ChatMessage, "conversationId">, shownConversationId: string | null | undefined): string | null {
  const own = typeof message.conversationId === "string" ? message.conversationId.trim() : "";
  const shown = typeof shownConversationId === "string" ? shownConversationId.trim() : "";
  if (!own || !shown || own === shown) return null;
  return own.slice(-6);
}

export function normalizeMessages(messages: unknown, seed: string): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message, index) => normalizeMessage(message, `${seed}-message-${index}`))
    .filter((message): message is ChatMessage => Boolean(message));
}

export function normalizeConversation(value: unknown, fallbackId: string): ChatConversation | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value.id) ?? fallbackId;
  const creatorIdentity = {
    id,
    conversationId: id,
    threadId: optionalString(value.threadId),
    creatorId: optionalString(value.creatorId) ?? id,
    email: optionalString(value.email),
    creatorEmail: optionalString(value.creatorEmail),
    handle: optionalString(value.handle),
    creatorHandle: optionalString(value.creatorHandle),
    name: optionalString(value.name),
    creatorName: optionalString(value.creatorName),
    channelId: optionalString(value.channelId),
    youtubeUrl: optionalString(value.youtubeUrl),
    programId: optionalString(value.canonicalProgramId) ?? optionalString(value.programId),
    campaignId: optionalString(value.campaignId),
    type: optionalString(value.type),
    source: optionalString(value.source),
  };
  const threadId = canonicalThreadId(creatorIdentity);
  const contextKey = workflowContextKey({
    id,
    threadId: threadId || undefined,
    contextKey: optionalString(value.contextKey),
    type: optionalString(value.type),
    source: optionalString(value.source),
    creatorId: optionalString(value.creatorId) ?? id,
    creatorEmail: optionalString(value.creatorEmail),
    creatorHandle: optionalString(value.creatorHandle),
    creatorName: optionalString(value.creatorName),
    programId: optionalString(value.canonicalProgramId) ?? optionalString(value.programId),
    campaignId: optionalString(value.campaignId),
  });
  const attribution = conversationAttribution(value.attribution);
  const declaredAttributionStatus = recordedAttributionStatus(value.attributionStatus);
  const attributionStatus: ChatConversationAttributionStatus = attribution?.final && attribution.attributionStatus
    ? declaredAttributionStatus === attribution.attributionStatus
      ? declaredAttributionStatus
      : attribution.attributionStatus
    : "legacy/unrecorded";
  if (attribution && attributionStatus !== "legacy/unrecorded") {
    attribution.attributionStatus = attributionStatus;
  }
  return {
    id,
    threadId: threadId || undefined,
    threadConversationIds: conversationThreadCandidates(creatorIdentity),
    uiThreadKey: workflowConversationKey({ id, threadId: threadId || undefined, contextKey }),
    contextKey,
    type: optionalString(value.type),
    originalCreatorId: optionalString(value.creatorId) ?? id,
    candidateId: optionalString(value.candidateId),
    creatorId: canonicalCreatorId(creatorIdentity) || optionalString(value.creatorId) || id,
    creatorName: optionalString(value.creatorName),
    creatorAvatar: optionalString(value.creatorAvatar),
    creatorEmail: optionalString(value.creatorEmail),
    creatorHandle: optionalString(value.creatorHandle),
    creatorPlatform: optionalString(value.creatorPlatform),
    creatorFollowers: value.creatorFollowers == null ? undefined : numberValue(value.creatorFollowers),
    channelId: optionalString(value.channelId),
    youtubeUrl: optionalString(value.youtubeUrl),
    profileMatchedEmail: optionalString(value.profileMatchedEmail),
    profileSourceRef: optionalString(value.profileSourceRef),
    profileSnapshotUpdatedAtIso: optionalString(value.profileSnapshotUpdatedAtIso),
    programId: optionalString(value.programId),
    canonicalProgramId: optionalString(value.canonicalProgramId),
    programTitle: optionalString(value.programTitle),
    campaignId: optionalString(value.campaignId),
    campaignTitle: optionalString(value.campaignTitle),
    applicationId: optionalString(value.applicationId),
    applicationRef: optionalString(value.applicationRef),
    participationActive: value.participationActive == null ? undefined : booleanValue(value.participationActive),
    participationStatus: optionalString(value.participationStatus) as ChatConversation["participationStatus"],
    participationStage: participationStage(value.participationStage),
    participationUpdatedAtIso: optionalString(value.participationUpdatedAtIso),
    source: optionalString(value.source),
    protected: booleanValue(value.protected),
    hasCreatorReply: booleanValue(value.hasCreatorReply),
    hiddenFromDefaultChat: booleanValue(value.hiddenFromDefaultChat),
    lastInboundAtIso: optionalString(value.lastInboundAtIso),
    visibility: optionalString(value.visibility),
    routeReason: optionalString(value.routeReason),
    attribution,
    attributionStatus,
    attributionReviewRequired: booleanValue(value.attributionReviewRequired),
    lastAttributionAuditRef: optionalString(value.lastAttributionAuditRef),
    archivedAt: optionalString(value.archivedAt),
    deletedAt: optionalString(value.deletedAt),
    deliveryState: optionalString(value.deliveryState),
    lastDeliveryState: optionalString(value.lastDeliveryState),
    outreachStatus: optionalString(value.outreachStatus),
    status: optionalString(value.status),
    humanGate: humanGate(value.humanGate),
    manualIntervention: manualIntervention(value.manualIntervention),
    unread: numberValue(value.unread),
    aiActive: booleanValue(value.aiActive),
    alert: optionalString(value.alert),
    nextAutoReplyAtIso: optionalString(value.nextAutoReplyAtIso),
    autoReplyDraftText: optionalString(value.autoReplyDraftText),
    autoReplyQueueRef: optionalString(value.autoReplyQueueRef),
    autoReplyStatus: optionalString(value.autoReplyStatus) as ChatConversation["autoReplyStatus"],
    autoReplyBlockedReason: optionalString(value.autoReplyBlockedReason),
    autoReplyClosedReason: optionalString(value.autoReplyClosedReason),
    autoReplyClosedAtIso: optionalString(value.autoReplyClosedAtIso),
    humanDraftSuggestion: optionalString(value.humanDraftSuggestion),
    humanDraftSuggestionKr: optionalString(value.humanDraftSuggestionKr),
    messages: normalizeMessages(value.messages, id).map((message) => (message.conversationId ? message : { ...message, conversationId: id })),
    lastMessageConversationId: id,
    lastMessage: optionalString(value.lastMessage),
    lastMessageAtIso: optionalString(value.lastMessageAtIso),
    lastMessageFrom: value.lastMessageFrom == null ? undefined : messageFrom(value.lastMessageFrom),
    lastMessageRef: optionalString(value.lastMessageRef),
    updatedAtIso: optionalString(value.updatedAtIso),
  };
}

export function normalizeConversations(values: readonly unknown[]): ChatConversation[] {
  return values
    .map((conversation, index) => normalizeConversation(conversation, `conversation-${index}`))
    .filter((conversation): conversation is ChatConversation => Boolean(conversation));
}

export function conversationMessages(conversation?: Partial<ChatConversation> | null): ChatMessage[] {
  if (!isRecord(conversation)) return [];
  return normalizeMessages(conversation.messages, optionalString(conversation.id) ?? "conversation");
}

export function previewMessage(conversation: ChatConversation): ChatMessage | undefined {
  const lastEmbedded = latestMessage(conversationMessages(conversation));
  const lastSnapshot = conversation.lastMessage ? {
    id: `${conversation.id}-preview`,
    from: conversation.lastMessageFrom ?? "ai",
    author: conversation.lastMessageFrom === "creator"
      ? conversation.creatorName ?? "Creator"
      : conversation.lastMessageFrom === "human"
        ? "헤세"
        : "Flu AI",
    time: "",
    text: stringValue(conversation.lastMessage),
    createdAtIso: conversation.lastMessageAtIso,
    mailEventAtIso: conversation.lastMessageAtIso,
    messageRef: conversation.lastMessageRef,
  } : undefined;
  if (!lastEmbedded) return lastSnapshot;
  if (!lastSnapshot) return lastEmbedded;
  return messageMillis(lastSnapshot) >= messageMillis(lastEmbedded) ? lastSnapshot : lastEmbedded;
}

export function compactConversationSignal(conversation: ChatConversation, messages?: ChatMessage[]): string {
  return normalizeMessages(messages ?? conversation.messages, conversation.id)
    .slice(-8)
    .map((message) => `${message.from}/${message.author}: ${stringValue(message.text)}`)
    .join(" | ")
    .slice(0, 1200);
}

const PERSON_SIGNAL_MESSAGE_BOUND = 30;

/**
 * P-2 사람 스코프 초안 신호 (plans/flu-chat-person-rooms-metaprompt.md §3 P-2, §4 L4).
 * compactConversationSignal 과 같은 압축 관례(from/author: text 포맷, 1200자 상한 — SEC 규율,
 * 원문 과다 노출 금지)를 그대로 따르되 입력이 다르다: 단일 갈래가 아니라 사람 전체 병합
 * 타임라인이다. 갈래를 넘나든 messageRef dedupe는 chat-people.ts 의
 * mergeMessagesAcrossStrands()(PersonRoom.mergedMessages)가 이미 끝낸 것을 그대로 받는다 — 여기서
 * 다시 구현하지 않는다(재사용 가능한 부분은 재사용, 중복 구현 금지). 그 압축 타임라인을 최근 30개로
 * bound 하고, 타깃 갈래 라벨과 reply-target 앵커를 덧붙인다.
 */
export function compactPersonSignal(
  mergedMessages: readonly ChatMessage[],
  targetStrand: ChatConversation,
  anchorMessage?: ChatMessage,
): string {
  const timeline = mergedMessages
    .slice(-PERSON_SIGNAL_MESSAGE_BOUND)
    .map((message) => `${message.from}/${message.author}: ${stringValue(message.text)}`)
    .join(" | ")
    .slice(0, 1200);
  const targetLabel = targetStrand.campaignTitle || targetStrand.programTitle || targetStrand.contextKey || targetStrand.uiThreadKey || targetStrand.id;
  const strandSignal = targetLabel ? `target-strand/${targetLabel}` : "";
  // 리뷰 NOTE 봉합(W106 P3+4): 앵커 텍스트는 타임라인 캡 밖이라 장문 메일을 앵커로 지정하면
  // gatewayProxy payload 가 무제한으로 커졌다(실행 재현 50만자). 타임라인과 같은 규율로 캡.
  const anchorSignal = anchorMessage
    ? `reply-target/${anchorMessage.from}/${anchorMessage.author}: ${stringValue(anchorMessage.text)}`.slice(0, 600)
    : "";
  return [timeline, strandSignal, anchorSignal].filter(Boolean).join(" || ");
}

export function isLegacyDemoConversation(conversation: ChatConversation): boolean {
  return LEGACY_DEMO_CONVERSATION_IDS.has(conversation.id) && conversation.id !== MVP_CONVERSATION_ID && !conversation.campaignId && !conversation.programId;
}

export function isVisibleConversation(conversation: ChatConversation): boolean {
  return !conversation.deletedAt && !conversation.archivedAt && !isLegacyDemoConversation(conversation);
}

export function hasCreatorReplySignal(conversation: ChatConversation): boolean {
  if (conversation.hasCreatorReply) return true;
  if (
    conversation.lastMessageFrom === "creator" &&
    Boolean(conversation.lastInboundAtIso || conversation.lastMessageAtIso || conversation.lastMessageRef)
  ) {
    return true;
  }
  return conversationMessages(conversation).some((message) =>
    message.from === "creator" && Boolean(message.mailEventAtIso || message.receivedAtIso || message.messageRef),
  );
}

/**
 * W111-B: 포털에서 **크리에이터가 직접 한 행동**으로 생긴 대화인가.
 *
 * 이메일 회신이 없어도 지원하거나 콘텐츠를 낸 사람은 응대 대상이다 — 오히려 가장 중요한 쪽이다.
 * 그런데 참여 여부를 담는 구조화 필드(`participationStatus`/`participationStage`/`applicationId`)는
 * 프로드 원장에서 **전부 비어 있고**(7,658건 전수 0), 종류는 대화 ID 에만 인코딩돼 있다.
 * 그래서 ID 로 판정한다. 실측한 종류(원장 전수 7,658건 기준, program-* 와 campaign-* 두 네임스페이스
 * 모두에서 나온다): application-confirmed 119 · content-submitted 43 · application-video-reminder 73.
 * 이 중 `application-video-reminder` 는 **우리가 보낸 독촉**(applicationVideoPending 의 쿨다운 타이머
 * 트리거)이라 참여가 아니다 — 포함하면 답장도 반응도 없는 사람이 "반응함"으로 올라온다.
 * 나머지 둘은 포털이 보내는 크리에이터 액션 이벤트(application.submitted / video.submitted)에만
 * 물려 생성된다(functions/scpFluApplicationCommand.ts, scpIntegrationEventV2.ts).
 *
 * ⚠️ 스코프 한계(리뷰 지적, MEDIUM): 이 이벤트 어휘는 현재 `view-cpm` 계열 프로그램에서만 쓰인다.
 * 다른 프로그램이 다른 ID 규칙으로 참여 대화를 만들면 여기서 안 잡힌다(실측 1명: fuwaseal@gmail.com).
 * 토글을 끄면 여전히 보이므로 락아웃은 아니지만, 정공법은 포털이 구조화 필드를 채우는 것이다.
 */
const PORTAL_ENGAGEMENT_EVENT = /(application-confirmed|content-submitted)/i;

export function hasPortalEngagementSignal(conversation: ChatConversation): boolean {
  return PORTAL_ENGAGEMENT_EVENT.test(conversation.id)
    || PORTAL_ENGAGEMENT_EVENT.test(conversation.originalCreatorId ?? "")
    || PORTAL_ENGAGEMENT_EVENT.test(conversation.creatorId ?? "");
}

export function isDefaultChatConversation(conversation: ChatConversation): boolean {
  return isVisibleConversation(conversation) && conversation.hiddenFromDefaultChat !== true && hasCreatorReplySignal(conversation);
}

/**
 * W109: `hiddenFromDefaultChat` 는 성격이 다른 두 가지를 한 플래그로 덮고 있다 —
 * (a) 진짜 노이즈(반송·차단 발신자·옵트아웃/법무·자동응답·내부 픽스처)와
 * (b) `outbound-only-or-no-creator-reply`, 즉 "아직 답장이 없다"는 사실을 표식으로 굳힌 것.
 * (b)는 scripts/chat-hygiene-rules.mjs 의 `reasonForHide` 에서 **다른 노이즈 사유를 모두
 * 통과한 뒤 마지막에** 붙는 사유라, 내용이 더러워서가 아니라 답장이 없어서 숨은 것이다.
 * 프로드 실측(2026-08-19): hidden 1,443건 중 1,432건이 (b).
 */
const REPLY_PROXY_HIDE_REASON = "outbound-only-or-no-creator-reply";

export function isContentNoiseHidden(conversation: ChatConversation): boolean {
  if (conversation.hiddenFromDefaultChat !== true) return false;
  return conversation.routeReason !== REPLY_PROXY_HIDE_REASON;
}

/**
 * "사람" 탭 스코프(W109, 헤세 승인): 기본 탭과 달리 답장 신호(hasCreatorReplySignal)를
 * 요구하지 않는다 — 콜드·프로그램 메일까지 사람 단위로 전부 커버해야 하기 때문이다.
 * 삭제·보관·레거시 데모와 **실제 노이즈만** 배제하고, 답장 없음을 이유로 숨겨진 대화는
 * 다시 포함한다(그러지 않으면 같은 필터를 이름만 바꿔 두 번 거는 셈이 된다).
 * 기본 탭 동작(isDefaultChatConversation)은 건드리지 않는다.
 */
export function isPersonScopeConversation(conversation: ChatConversation): boolean {
  return isVisibleConversation(conversation) && !isContentNoiseHidden(conversation);
}

function isoMillis(value?: string): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function messageMillis(message?: ChatMessage): number {
  if (!message) return 0;
  return isoMillis(message.mailEventAtIso) ||
    isoMillis(message.sentAtIso) ||
    isoMillis(message.receivedAtIso) ||
    isoMillis(message.createdAtIso);
}

function latestMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.reduce<ChatMessage | undefined>((latest, message) => {
    if (!latest) return message;
    return messageMillis(message) >= messageMillis(latest) ? message : latest;
  }, undefined);
}

export function conversationMillis(conversation: ChatConversation): number {
  const messages = conversationMessages(conversation);
  const preview = previewMessage(conversation);
  const messageLatest = Math.max(
    0,
    isoMillis(conversation.lastMessageAtIso),
    ...messages.map(messageMillis),
    messageMillis(preview),
  );
  return messageLatest || isoMillis(conversation.updatedAtIso);
}

export function messageKey(message: ChatMessage): string {
  return message.messageRef || `${message.id}:${message.createdAtIso ?? ""}:${message.from}:${message.text}`;
}

function mergeMessages(messages: ChatMessage[]): ChatMessage[] {
  const byKey = new Map<string, ChatMessage>();
  for (const message of messages) {
    const key = messageKey(message);
    if (!byKey.has(key)) byKey.set(key, message);
  }
  return Array.from(byKey.values()).sort((left, right) => {
    const leftMillis = messageMillis(left);
    const rightMillis = messageMillis(right);
    if (leftMillis !== rightMillis) return leftMillis - rightMillis;
    return left.id.localeCompare(right.id);
  });
}

function latestConversation(left: ChatConversation, right: ChatConversation): ChatConversation {
  if (conversationMillis(right) > conversationMillis(left)) return right;
  return left;
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (value && !result.includes(value)) result.push(value);
  }
  return result;
}

export function dedupeConversationsByThread(conversations: readonly ChatConversation[]): ChatConversation[] {
  const groups = new Map<string, ChatConversation[]>();
  for (const conversation of conversations) {
    const threadId = conversation.threadId || canonicalThreadId({
      conversationId: conversation.id,
      creatorId: conversation.creatorId,
      creatorEmail: conversation.creatorEmail,
      creatorHandle: conversation.creatorHandle,
      creatorName: conversation.creatorName,
    }) || conversation.id;
    const contextKey = workflowContextKey({ ...conversation, threadId });
    const groupKey = `${threadId}::${contextKey}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), { ...conversation, threadId, contextKey, uiThreadKey: groupKey }]);
  }

  return Array.from(groups.entries()).map(([groupKey, group]) => {
    const base = group.reduce(latestConversation);
    const profileCarrier = group.find((conversation) => isProfileImageUrl(conversation.creatorAvatar)) ??
      group.find((conversation) => conversation.creatorAvatar || conversation.creatorHandle || conversation.creatorEmail || conversation.youtubeUrl) ??
      base;
    const threadId = base.threadId || groupKey.split("::", 1)[0] || base.id;
    const contextKey = base.contextKey || workflowContextKey({ ...base, threadId });
    const primary = group.find((conversation) => conversation.id === threadId) ?? base;
    const attributionCarrier = group.reduce((best, candidate) => {
      const bestManual = best.attribution?.final?.source === "manual" || best.attribution?.final?.source === "revert" ? 1 : 0;
      const candidateManual = candidate.attribution?.final?.source === "manual" || candidate.attribution?.final?.source === "revert" ? 1 : 0;
      if (candidateManual !== bestManual) return candidateManual > bestManual ? candidate : best;
      const bestVersion = best.attribution?.version ?? -1;
      const candidateVersion = candidate.attribution?.version ?? -1;
      if (candidateVersion !== bestVersion) return candidateVersion > bestVersion ? candidate : best;
      const bestUpdated = isoMillis(best.attribution?.updatedAtIso);
      const candidateUpdated = isoMillis(candidate.attribution?.updatedAtIso);
      if (candidateUpdated !== bestUpdated) return candidateUpdated > bestUpdated ? candidate : best;
      return conversationMillis(candidate) > conversationMillis(best) ? candidate : best;
    }, primary);
    const threadConversationIds = uniqueStrings(group.flatMap((conversation) => [
      conversation.id,
      ...(conversation.threadConversationIds ?? []),
    ])).filter((id) => id !== threadId || contextKey.startsWith("mail:"));
    const messages = mergeMessages(group.flatMap((conversation) => conversation.messages));
    const unread = group.reduce((sum, conversation) => sum + Math.max(0, conversation.unread), 0);
    return {
      ...base,
      id: primary.id,
      threadId,
      contextKey,
      uiThreadKey: groupKey,
      threadConversationIds,
      attribution: attributionCarrier.attribution,
      attributionStatus: attributionCarrier.attributionStatus,
      attributionOwnerConversationId: attributionCarrier.id,
      attributionReviewRequired: attributionCarrier.attributionReviewRequired,
      lastAttributionAuditRef: attributionCarrier.lastAttributionAuditRef,
      creatorId: canonicalCreatorId({
        conversationId: threadId,
        creatorId: base.creatorId,
        creatorEmail: base.creatorEmail,
        creatorHandle: base.creatorHandle,
        creatorName: base.creatorName,
      }) || base.creatorId,
      candidateId: base.candidateId ?? profileCarrier.candidateId,
      creatorName: base.creatorName ?? profileCarrier.creatorName,
      creatorAvatar: isProfileImageUrl(base.creatorAvatar) ? base.creatorAvatar : profileCarrier.creatorAvatar ?? base.creatorAvatar,
      creatorEmail: base.creatorEmail ?? profileCarrier.creatorEmail,
      creatorHandle: base.creatorHandle ?? profileCarrier.creatorHandle,
      creatorPlatform: base.creatorPlatform ?? profileCarrier.creatorPlatform,
      creatorFollowers: base.creatorFollowers ?? profileCarrier.creatorFollowers,
      channelId: base.channelId ?? profileCarrier.channelId,
      youtubeUrl: base.youtubeUrl ?? profileCarrier.youtubeUrl,
      profileMatchedEmail: base.profileMatchedEmail ?? profileCarrier.profileMatchedEmail,
      profileSourceRef: base.profileSourceRef ?? profileCarrier.profileSourceRef,
      profileSnapshotUpdatedAtIso: base.profileSnapshotUpdatedAtIso ?? profileCarrier.profileSnapshotUpdatedAtIso,
      unread,
      messages,
    };
  });
}

function nameFromCampaignSummary(text?: string): string {
  if (!text) return "";
  const parts = text.split("—");
  return (parts.length > 1 ? parts[parts.length - 1] ?? "" : "").trim();
}

function fallbackHandle(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? `@${slug}` : "";
}

function formatFollowers(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(count % 10000 === 0 ? 0 : 1)}만`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}천`;
  return `${count}`;
}

function profileString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function profileNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function normalizeProfileToken(value: unknown): string {
  const text = profileString(value);
  if (!text) return "";
  return text.trim().toLowerCase()
    .replace(/^candidate:/, "")
    .replace(/^@/, "")
    .replace(/^https?:\/\/(www\.)?youtube\.com\/@/, "")
    .replace(/^https?:\/\/(www\.)?youtube\.com\/channel\//, "")
    .replace(/[/?#].*$/, "");
}

function addProfileToken(tokens: Set<string>, value: unknown) {
  const normalized = normalizeProfileToken(value);
  if (!normalized) return;
  tokens.add(normalized);
  const slug = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug && slug !== normalized) tokens.add(slug);
}

function conversationProfileTokens(conversation: ChatConversation): Set<string> {
  const tokens = new Set<string>();
  for (const value of [
    conversation.id,
    conversation.creatorId,
    conversation.originalCreatorId,
    conversation.candidateId,
    conversation.channelId,
    conversation.creatorEmail,
    conversation.profileMatchedEmail,
    conversation.creatorHandle,
    conversation.youtubeUrl,
    ...(conversation.threadConversationIds ?? []),
  ]) addProfileToken(tokens, value);
  return tokens;
}

function creatorProfileTokens(creator: MinimalCreator): Set<string> {
  const tokens = new Set<string>();
  for (const value of [
    creator.id,
    creator.creatorId,
    creator.candidateId,
    creator.channelId,
    creator.email,
    creator.profileMatchedEmail,
    creator.handle,
    creator.youtubeUrl,
  ]) addProfileToken(tokens, value);
  return tokens;
}

function profileTokenSetsIntersect(left: Set<string>, right: Set<string>): boolean {
  for (const token of left) {
    if (right.has(token)) return true;
  }
  return false;
}

/**
 * D (헤세 감사): 예전엔 이 자리에 `platform && followers ? "메인" : undefined` 가 끼어 있었다 —
 * 채널이 "메인"인지 "서브"인지를 나타내는 실제 필드는 리포·데이터 어디에도 없는데, platform과
 * followers가 둘 다 있다는 이유만으로 "메인 채널"이라고 단정하던 근거 없는 장식이었다. 제거하고
 * platform·followers만 조합한다. C: page.tsx의 사람 단위 union(목록 행·헤더)도 이 조합 규칙을
 * 그대로 재사용해 두 곳에서 같은 문자열 포맷이 따로 굳지 않게 한다.
 */
export function formatProfileMeta(platform?: string, followers?: number): string {
  return [
    platform,
    followers ? `${formatFollowers(followers)} 팔로워` : undefined,
  ].filter(Boolean).join(" · ");
}

export function conversationProfile<TCreator extends MinimalCreator>(
  conversation: ChatConversation,
  creators: readonly TCreator[],
) {
  const conversationCreatorId = canonicalCreatorId({
    conversationId: conversation.id,
    creatorId: conversation.originalCreatorId ?? conversation.creatorId,
    creatorEmail: conversation.creatorEmail,
    creatorHandle: conversation.creatorHandle,
    creatorName: conversation.creatorName,
  });
  const conversationTokens = conversationProfileTokens(conversation);
  const creator = creators.find((item) =>
    canonicalCreatorId({
      creatorId: item.id,
      email: item.email,
      handle: item.handle,
      name: item.name,
    }) === conversationCreatorId ||
    profileTokenSetsIntersect(conversationTokens, creatorProfileTokens(item)),
  );
  const last = previewMessage(conversation);
  // P7(A12/context §3): 캠페인 요약 텍스트("프로그램명 — 메시지")의 "—" 뒤쪽을 이름으로 추정하던
  // inferredName은 실제로는 프로그램명이 새어드는 경로였다 — 진짜 이름/이메일이 전무할 때의 최후
  // 수단으로만 강등한다(완전 제거하면 그 자리가 아예 비므로 최후순위 유지를 선택).
  const inferredName = nameFromCampaignSummary(last?.text);
  const creatorName = profileString(creator?.name);
  const name = creatorName || conversation.creatorName || conversation.creatorEmail || inferredName || "알 수 없는 채널";
  const handle = profileString(creator?.handle) || conversation.creatorHandle || fallbackHandle(name);
  const email = conversation.creatorEmail ?? profileString(creator?.email);
  const platform = profileString(creator?.platform) ?? conversation.creatorPlatform ?? (conversation.campaignId ? "YouTube" : undefined);
  const followers = profileNumber(creator?.followers) ?? conversation.creatorFollowers;
  const creatorAvatar = profileString(creator?.avatar);
  const conversationAvatar = profileString(conversation.creatorAvatar);
  const avatar = isProfileImageUrl(conversationAvatar)
    ? conversationAvatar
    : creatorAvatar ?? conversationAvatar ?? name;
  const meta = formatProfileMeta(platform, followers);

  return { creator, name, handle, email, platform, followers, avatar, meta };
}

// 0.6.107 E: reply source(messageRef)와 그 메시지를 소유한 실제 conversationId 를 함께 돌려준다 —
//   병합 스레드(부모 conv + 최신 수신을 가진 자식 conv)에서 서버는 replyToMessageRef 가 속한 대화로 정확히 바인딩한다.
export function latestCreatorMessageSource(
  messages: readonly ChatMessage[],
  conversation: ChatConversation | undefined,
): { ref: string; conversationId: string } {
  const latestCreator = [...messages].reverse().find((message) => message.from === "creator" && message.messageRef);
  if (latestCreator?.messageRef) return { ref: latestCreator.messageRef, conversationId: latestCreator.conversationId ?? "" };
  return conversation?.lastMessageFrom === "creator" && conversation.lastMessageRef
    ? { ref: conversation.lastMessageRef, conversationId: conversation.lastMessageConversationId ?? "" }
    : { ref: "", conversationId: "" };
}
