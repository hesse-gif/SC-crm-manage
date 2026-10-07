import {
  conversationMillis,
  hasCreatorReplySignal,
  hasPortalEngagementSignal,
  previewMessage,
  messageKey,
  messageMillis,
  type ChatConversation,
  type ChatMessage,
} from "./chat-normalization.ts";
import { CANONICAL_HESSE_CREATOR_ID, isProtectedHesseIdentity } from "./creator-identity.ts";
import { normalizeEmail, normalizeHandle } from "./scp-alias-id.ts";

/**
 * A single row inside a PersonRoom's merged timeline.
 *
 * `sourceUiThreadKey` names the strand whose row was chosen as the
 * representative when the same physical mail (messageRef) fanned out into
 * more than one strand (see chat-people.ts merge rule below). `strandSpan`
 * is how many distinct strands carried a row for this message — UI uses it
 * for the "+1 갈래" chip (see plans/flu-chat-person-rooms-metaprompt.md P-1).
 */
export type PersonMergedMessage = ChatMessage & {
  readonly sourceUiThreadKey: string;
  readonly strandSpan: number;
};

export type PersonProfile = {
  readonly name: string;
  readonly handle?: string;
  readonly email?: string;
  readonly avatar?: string;
  readonly platform?: string;
  readonly followers?: number;
};

export type PersonRoom = {
  readonly personKey: string;
  readonly profile: PersonProfile;
  readonly strands: readonly ChatConversation[];
  readonly mergedMessages: readonly PersonMergedMessage[];
  readonly unreadTotal: number;
  readonly latestMillis: number;
  readonly defaultReplyStrand: string;
  /** 이 사람의 갈래 중 하나라도 크리에이터 답장 신호가 있는지 (W109). */
  readonly hasReplySignal: boolean;
  /**
   * W111-B: 이메일 회신은 없어도 **포털에서 직접 행동**(지원 확정·콘텐츠 제출)한 사람인지.
   * 프로드 실측 96명 — 회신만으로 거르면 지원·제출한 사람이 통째로 목록에서 사라진다.
   */
  readonly hasEngagementSignal: boolean;
  /**
   * W111 리뷰(HIGH): 목록 카드에 쓸 "마지막 메시지" 한 줄.
   *
   * `mergedMessages` 로 쓰면 안 된다 — 프로드 대화 문서에는 메시지가 임베드돼 있지 않고
   * (실측: 최근 15건 전부 `messages: []`) 본문은 서브컬렉션에 있어서 **열린 방에서만** 로드된다.
   * 그래서 목록에서는 병합 타임라인이 항상 비고, 카드가 본문·시각 없이 그려진다.
   * 평면 목록 탭이 쓰던 `previewMessage()` 는 스냅샷 필드(lastMessage/lastMessageAtIso)로
   * 폴백하므로 그걸 그대로 재사용한다 — 갈래는 최근순 정렬이라 첫 갈래가 그 사람의 최근 활동이다.
   */
  readonly preview?: ChatMessage;
};

/**
 * 대화마다 새로 만들어지는 합성 ID 접두 — 사람 키가 될 수 없다. 프로드 대화 다수가
 * `creatorId` 자리에 문서 ID(`conv_1fomb4n` 등)를 들고 있어서, 이걸 사람 키로 쓰면
 * **같은 사람이 대화 수만큼 쪼개진다**(W109 근인, 실측: tokymongrey@gmail.com 13갈래가
 * 13명으로 흩어짐).
 */
const SYNTHETIC_CREATOR_ID = /^(conv_|thread-|campaign-|program-|application-|mail-)/i;
const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/**
 * `creatorId` 계열 값 중 **실제 사람 식별자**만 골라낸다. 합성 접두를 달았거나 이 대화
 * 자신의 ID/스레드ID 와 같은 값은(=문서 ID 가 creatorId 자리에 흘러든 것) 버린다.
 *
 * 주의: `threadConversationIds` 로는 거를 수 없다 — conversationThreadCandidates 가
 * canonicalCreatorId 자체를 그 배열에 넣기 때문에, 그걸로 거르면 **진짜 creatorId 까지**
 * 전부 탈락한다(W109 리뷰에서 실제로 잡힌 결함).
 */
/**
 * 유튜브 채널ID 를 뽑는다. `channelId` 필드가 비어 있고 `youtubeUrl` 만 `/channel/UC.../` 형태로
 * 오는 대화가 프로드에 2,503건 있는데, 이걸 핸들로 재파싱하면 대소문자가 뭉개져 같은 채널이
 * `channel:UCB_...` 와 `handle:@ucb_...` 두 방으로 쪼개진다(리뷰에서 재현). 채널ID 는 대소문자를
 * 구분하므로 원문 그대로 돌려준다.
 */
function youtubeChannelId(value?: string): string {
  const text = (value ?? "").trim();
  if (YOUTUBE_CHANNEL_ID.test(text)) return text;
  return text.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/)?.[1] ?? "";
}

function stableCreatorId(conversation: ChatConversation): string {
  for (const raw of [conversation.originalCreatorId, conversation.creatorId, conversation.candidateId]) {
    const value = (raw ?? "").trim().replace(/^candidate:/, "");
    if (!value) continue;
    if (SYNTHETIC_CREATOR_ID.test(value)) continue;
    if (value === conversation.id || value === conversation.threadId) continue;
    return value;
  }
  return "";
}

/**
 * 사람 방 전용 신원 키(W109, 헤세 승인). **안정 신원 우선** 순서로 고른다:
 * 이메일 → 유튜브 채널ID → 핸들 → 진짜 creatorId → (최후) 대화ID.
 *
 * `chat-programs.ts` 의 `participantKey`(=`canonicalCreatorId`, creatorId 무조건 우선)를
 * 바꾸지 않고 여기 따로 두는 이유: `canonicalCreatorId` 는 귀속·중복판정·스레드 키까지
 * 물고 있어서 전역 파급이 크다. 사람 방의 묶음 규칙만 바꾸는 게 이번 변경의 범위다.
 *
 * `isProtectedHesseIdentity`(본인 계정 보호) 경로는 기존과 같은 canonical ID 로 유지한다 —
 * 이메일 우선 규칙이 본인 계정을 상대 사람과 섞지 않도록 **가장 먼저** 건다.
 */
const EMAIL_SHAPED_NAME_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** 이름 칸 값이 통짜 이메일일 때만 그 주소를 돌려준다(공백 포함 등 일반 이름은 null). */
function emailShapedName(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return EMAIL_SHAPED_NAME_RE.test(text) ? text : null;
}

export function personIdentityKey(conversation: ChatConversation): string {
  const creatorId = stableCreatorId(conversation);

  // W114-F (헤세 스크린샷 재신고): legacy 유입분(6/30~7/9, 61건)은 creatorEmail 이 빈 문자열이고
  // **이름 칸에만** 이메일이 있었다 — 이메일 키를 못 만들어 같은 사람이 문서마다 갈래1 방으로
  // 흩어졌다. 데이터는 백필로 고쳤고(scripts/backfill-empty-creator-email.cjs), 여기는 재발 방어:
  // 이름이 엄격한 이메일 형태일 때만 신원으로 승격한다. normalizeEmail 의 includes("@") 검사만
  // 재사용하면 "A @ B Studio" 같은 일반 이름이 이메일 신원으로 오인된다.
  const email = normalizeEmail(conversation.creatorEmail) ?? emailShapedName(conversation.creatorName);
  // 우리 자신의 주소가 creatorEmail 자리에 들어와 있으면, 그건 **상대를 특정하는 신원이 아니다**.
  const ownEmail = email ? isProtectedHesseIdentity({ creatorEmail: email }) : false;

  // 상대 이메일이 있으면 그게 곧 그 사람이다. 이름·핸들 같은 약한 신호가 실제 이메일을 덮지
  // 못하게 여기서 먼저 끊는다 — creatorName 이 우연히 본인 별칭 토큰("supercent official" 등)과
  // 겹치는 것만으로 자기 이메일을 가진 실제 크리에이터가 본인 방으로 흡수돼 사라지던 케이스가
  // 적대 리뷰에서 재현됐다.
  if (email && !ownEmail) return `email:${email}`;

  // 여기부터는 상대 이메일이 없는 경우다(우리 주소만 있었거나 아예 없거나).
  // 다른 신원이 하나라도 사람을 특정하면 본인 방으로 접지 않는다 — 재검 지적대로, 진짜
  // creatorId/candidateId 가 있는데 우리 주소가 섞였다는 이유로 흡수되면 실제 사람이 사라진다.
  // (우리 주소를 키로 쓰는 대신 **실제 신원으로 떨어뜨리는** 쪽을 택했다. 우리 주소로 키를 만들면
  //  서로 다른 크리에이터가 그 한 방에 도로 뭉친다.)
  // 보호 판정에 합성 ID 는 넘기지 않는다: isProtectedHesseIdentity 는 "본인 별칭이 아닌 명시적
  // 행위자가 있으면 보호를 끈다"는 규칙이라, 문서 ID 가 creatorId 자리에 흘러들면 본인 계정
  // 대화가 보호를 잃는다(라운드1 리뷰에서 잡힌 결함).
  const identity = {
    creatorId,
    creatorHandle: conversation.creatorHandle,
    creatorName: conversation.creatorName,
    channelId: conversation.channelId,
    youtubeUrl: conversation.youtubeUrl,
  };
  if (isProtectedHesseIdentity(identity)) return `creator:${CANONICAL_HESSE_CREATOR_ID}`;

  const channelId = youtubeChannelId(conversation.channelId) || youtubeChannelId(conversation.youtubeUrl);
  if (channelId) return `channel:${channelId}`;

  const handle = normalizeHandle(conversation.creatorHandle) ?? normalizeHandle(conversation.youtubeUrl);
  if (handle) return `handle:${handle}`;

  if (creatorId) return `creator:${creatorId}`;

  // 상대를 특정할 게 아무것도 남지 않았다: creatorEmail 이 우리 주소뿐이었다면 본인 방,
  // 아니면 대화 단위로 떨어뜨린다(합성 ID 를 사람으로 승격하지 않는다).
  return ownEmail ? `creator:${CANONICAL_HESSE_CREATOR_ID}` : `conv:${conversation.id}`;
}

function strandKey(strand: ChatConversation): string {
  return strand.uiThreadKey || strand.threadId || strand.id;
}

/** Defends against a malformed/legacy strand doc whose `messages` field isn't an array. */
function strandMessages(strand: ChatConversation): ChatMessage[] {
  return Array.isArray(strand.messages) ? strand.messages : [];
}

/**
 * Recency-first ordering shared by every "which strand wins" decision in
 * this module (strand list order, cross-strand message dedupe, and the
 * defaultReplyStrand fallback): most recently active strand first, ties
 * broken by uiThreadKey ascending ("사전순", plan §4 L1 / plan §7 fixture ③).
 */
function compareStrandRecency(left: ChatConversation, right: ChatConversation): number {
  const millisDelta = conversationMillis(right) - conversationMillis(left);
  if (millisDelta !== 0) return millisDelta;
  return strandKey(left).localeCompare(strandKey(right));
}

function firstDefined<T>(strands: readonly ChatConversation[], pick: (strand: ChatConversation) => T | undefined): T | undefined {
  for (const strand of strands) {
    const value = pick(strand);
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/**
 * W111 (헤세): 갈래마다 프로필 충실도가 다르다 — 포털이 만든 갈래(program-*)는 아바타가 없고
 * `creatorName` 자리에 **이메일 주소**가 들어 있다. 유튜브 프로필은 캠페인 갈래에만 붙는다.
 * 그래서 "첫 유효값"을 쓰면 이메일이 이름을 이긴다(프로드 실측: 195명이 이름 대신 이메일로 표시,
 * 그중 74명은 같은 방에 제대로 된 이름을 가진 갈래가 있었다).
 * 사람은 하나인데 갈래마다 다른 얼굴·이름이 뜰 이유가 없으므로 **정보가 있는 갈래 쪽으로 덮는다**.
 */
function realName(strand: ChatConversation): string | undefined {
  const name = strand.creatorName;
  if (!name) return undefined;
  // 이메일 주소를 이름으로 쓰는 갈래는 이름이 없는 것으로 친다(더 나은 후보가 있으면 그쪽을 쓴다).
  return name.includes("@") ? undefined : name;
}

function buildPersonProfile(personKey: string, strands: readonly ChatConversation[]): PersonProfile {
  const name = firstDefined(strands, realName) ??
    firstDefined(strands, (strand) => strand.creatorHandle) ??
    firstDefined(strands, (strand) => strand.creatorName) ??
    firstDefined(strands, (strand) => strand.creatorEmail) ??
    personKey;
  return {
    name,
    handle: firstDefined(strands, (strand) => strand.creatorHandle),
    email: firstDefined(strands, (strand) => strand.creatorEmail),
    avatar: firstDefined(strands, (strand) => strand.creatorAvatar),
    platform: firstDefined(strands, (strand) => strand.creatorPlatform),
    // 팔로워는 0 이 "없음"인지 "실제 0"인지 구분이 안 된다 — 포털 갈래가 전부 0 을 박아 넣으므로
    // 0 이 아닌 값이 있으면 그걸 쓴다(MineLite: 캠페인 갈래 68,600 / 포털 갈래 0).
    followers: firstDefined(strands, (strand) => (strand.creatorFollowers ? strand.creatorFollowers : undefined))
      ?? firstDefined(strands, (strand) => strand.creatorFollowers),
  };
}

type MessageCandidate = {
  readonly message: ChatMessage;
  readonly strand: ChatConversation;
};

/**
 * Cross-strand merge key. A physical mail fanned out into multiple strands
 * (plan §2-B) carries the same messageRef in every row, so keying on
 * messageRef first collapses those fanned-out rows into a single bubble
 * (P-1). Rows without a messageRef (manual/hand-typed chat) fall back to
 * the existing per-message identity rule from chat-normalization.ts's
 * messageKey() — unchanged on purpose, so two different strands never
 * merge just because their text happens to match (plan §7 fixture ④).
 */
function mergeCandidateKey(message: ChatMessage): string {
  return message.messageRef || messageKey(message);
}

function mergeMessagesAcrossStrands(strands: readonly ChatConversation[]): PersonMergedMessage[] {
  const groups = new Map<string, MessageCandidate[]>();
  for (const strand of strands) {
    for (const message of strandMessages(strand)) {
      const key = mergeCandidateKey(message);
      const bucket = groups.get(key);
      if (bucket) bucket.push({ message, strand });
      else groups.set(key, [{ message, strand }]);
    }
  }

  const merged: PersonMergedMessage[] = [];
  for (const candidates of groups.values()) {
    const representative = [...candidates].sort((left, right) => compareStrandRecency(left.strand, right.strand))[0];
    const strandSpan = new Set(candidates.map((candidate) => strandKey(candidate.strand))).size;
    merged.push({
      ...representative.message,
      sourceUiThreadKey: strandKey(representative.strand),
      strandSpan,
    });
  }

  return merged.sort((left, right) => {
    const millisDelta = messageMillis(left) - messageMillis(right);
    if (millisDelta !== 0) return millisDelta;
    return left.id.localeCompare(right.id);
  });
}

/**
 * Default target strand for a fresh reply (P-2 default): the strand
 * holding the most recent inbound (from === "creator") message. Falls back
 * to the most recently active strand when no strand has ever received an
 * inbound message.
 */
function pickDefaultReplyStrand(strands: readonly ChatConversation[]): string {
  let best: MessageCandidate | undefined;
  for (const strand of strands) {
    for (const message of strandMessages(strand)) {
      if (message.from !== "creator") continue;
      if (!best || messageMillis(message) > messageMillis(best.message) ||
        (messageMillis(message) === messageMillis(best.message) && strandKey(strand).localeCompare(strandKey(best.strand)) < 0)) {
        best = { message, strand };
      }
    }
  }
  if (best) return strandKey(best.strand);

  const fallback = [...strands].sort(compareStrandRecency)[0];
  return fallback ? strandKey(fallback) : "";
}

/**
 * Groups strands (the output of dedupeConversationsByThread()) into one
 * room per person, per plans/flu-chat-person-rooms-metaprompt.md §4.
 * Pure client-side reassembly of already-loaded data — issues no Firestore
 * reads and adds no queries (plan §5-3).
 */
export function groupConversationsByPerson(conversations: readonly ChatConversation[]): PersonRoom[] {
  const groups = new Map<string, ChatConversation[]>();
  for (const conversation of conversations) {
    const key = personIdentityKey(conversation);
    const bucket = groups.get(key);
    if (bucket) bucket.push(conversation);
    else groups.set(key, [conversation]);
  }

  const rooms: PersonRoom[] = [];
  for (const [personKey, rawStrands] of groups) {
    const strands = [...rawStrands].sort(compareStrandRecency);
    const mergedMessages = mergeMessagesAcrossStrands(strands);
    rooms.push({
      personKey,
      profile: buildPersonProfile(personKey, strands),
      strands,
      mergedMessages,
      unreadTotal: strands.reduce((sum, strand) => sum + Math.max(0, Number.isFinite(strand.unread) ? strand.unread : 0), 0),
      latestMillis: Math.max(0, ...strands.map(conversationMillis)),
      defaultReplyStrand: pickDefaultReplyStrand(strands),
      hasReplySignal: strands.some(hasCreatorReplySignal),
      hasEngagementSignal: strands.some(hasPortalEngagementSignal),
      preview: mergedMessages[mergedMessages.length - 1]
        ?? (strands[0] ? previewMessage(strands[0]) : undefined),
    });
  }

  return rooms.sort((left, right) => {
    const millisDelta = right.latestMillis - left.latestMillis;
    if (millisDelta !== 0) return millisDelta;
    return left.personKey.localeCompare(right.personKey);
  });
}

export type PersonReplyTarget =
  | { readonly kind: "strand"; readonly strandKey: string; readonly locked: boolean }
  | { readonly kind: "new"; readonly locked: false };

/**
 * P-2 답장 대상 해소 (plans/flu-chat-person-rooms-metaprompt.md §3, 부록 규칙 2) — pure
 * function so the UI layer (chat/page.tsx) can't drift from it.
 *
 * REVIEW FIX (W106 REQUEST CHANGES, HIGH): the strandFilter branch used to trust its input
 * unconditionally. If the open room switches without an explicit selectPersonRoom/
 * selectStrandFilter click (e.g. a search filter or live refresh drops the current person out
 * of the visible list and effectivePersonKey falls back to someone else), `strandFilter` can
 * still hold a strand key that belonged to the *previous* person. Locking onto that stale key
 * sends/reads/drafts against a conversation that isn't even shown on screen. Membership in
 * `room.strands` is now required before either strandFilter or replyTargetStrand can select a
 * strand — otherwise this falls through to the same "all" resolution as no override at all.
 */
export function resolvePersonReplyTarget(
  room: PersonRoom,
  strandFilter: string,
  replyTargetStrand: string,
): PersonReplyTarget {
  const strandFilterBelongsToRoom = strandFilter !== "all"
    && room.strands.some((strand) => strandKey(strand) === strandFilter);
  if (strandFilterBelongsToRoom) {
    return { kind: "strand", strandKey: strandFilter, locked: true };
  }
  if (replyTargetStrand === "__new__") {
    return { kind: "new", locked: false };
  }
  const overrideBelongsToRoom = Boolean(replyTargetStrand)
    && room.strands.some((strand) => strandKey(strand) === replyTargetStrand);
  if (overrideBelongsToRoom) {
    return { kind: "strand", strandKey: replyTargetStrand, locked: false };
  }
  return { kind: "strand", strandKey: room.defaultReplyStrand, locked: false };
}
