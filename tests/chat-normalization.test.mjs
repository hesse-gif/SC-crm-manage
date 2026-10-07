import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compactConversationSignal,
  conversationMillis,
  conversationProfile,
  dedupeConversationsByThread,
  formatProfileMeta,
  hasCreatorReplySignal,
  isDefaultChatConversation,
  normalizeConversations,
  normalizeMessages,
  previewMessage,
} from "../src/lib/chat-normalization.ts";

test("normalizeMessages drops malformed entries and coerces text-like payloads", () => {
  assert.deepEqual(normalizeMessages("not-an-array", "thread"), []);

  const messages = normalizeMessages([
    null,
    "raw",
    { id: 123, from: "creator", author: 42, text: { nested: true }, createdAtIso: "2026-06-23T04:16:00.000Z" },
    { summaryKr: "요약 본문", from: "nobody", deliveryState: "bogus", humanGate: "needs_review" },
  ], "thread");

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], {
    id: "123",
    from: "creator",
    author: "42",
    text: "",
    time: "",
    createdAtIso: "2026-06-23T04:16:00.000Z",
    sentAtIso: undefined,
    receivedAtIso: undefined,
    mailEventAtIso: "2026-06-23T04:16:00.000Z",
    messageRef: undefined,
    trackingId: undefined,
    deliveryState: undefined,
    humanGate: undefined,
    campaignId: undefined,
  });
  assert.equal(messages[1].id, "thread-message-3");
  assert.equal(messages[1].from, "ai");
  assert.equal(messages[1].text, "요약 본문");
  assert.equal(messages[1].humanGate, "needs_review");
});

test("normalizeMessages uses actual mail event timestamps before queued creation time", () => {
  const messages = normalizeMessages([
    {
      id: "queued-outbound",
      from: "ai",
      text: "queued first",
      createdAtIso: "2026-06-29T15:28:58.609Z",
      sentAtIso: "2026-06-29T16:12:28.144Z",
      time: "00:28",
    },
    {
      id: "inbound-reply",
      from: "creator",
      text: "reply",
      createdAtIso: "2026-06-29T15:40:00.000Z",
      receivedAtIso: "2026-06-29T16:20:00.000Z",
    },
  ], "mail-thread");

  assert.equal(messages[0].createdAtIso, "2026-06-29T16:12:28.144Z");
  assert.equal(messages[0].mailEventAtIso, "2026-06-29T16:12:28.144Z");
  assert.equal(messages[1].createdAtIso, "2026-06-29T16:20:00.000Z");
  assert.equal(messages[1].mailEventAtIso, "2026-06-29T16:20:00.000Z");
});

test("normalizeConversations keeps /chat safe with missing fields and malformed embedded messages", () => {
  const conversations = normalizeConversations([
    null,
    "raw",
    {
      id: "broken-a",
      creatorName: 777,
      creatorEmail: null,
      creatorFollowers: "2800000",
      unread: "3",
      aiActive: "true",
      messages: "not-an-array",
      lastMessage: { nested: true },
      lastMessageFrom: "creator",
      lastMessageAtIso: "2026-06-24T01:00:00.000Z",
      updatedAtIso: "2026-06-24T02:00:00.000Z",
    },
    {
      creatorId: "creator-b",
      campaignId: "camp-b",
      messages: [{ bodyPreview: "캠페인 회신 - Supercent" }],
    },
  ]);

  assert.equal(conversations.length, 2);
  assert.equal(conversations[0].id, "broken-a");
  assert.equal(conversations[0].creatorId, "broken-a");
  assert.equal(conversations[0].creatorName, "777");
  assert.equal(conversations[0].creatorFollowers, 2800000);
  assert.equal(conversations[0].unread, 3);
  assert.equal(conversations[0].aiActive, true);
  assert.equal(previewMessage(conversations[0]), undefined);
  assert.equal(conversationMillis(conversations[0]), Date.parse("2026-06-24T01:00:00.000Z"));

  assert.equal(conversations[1].id, "conversation-3");
  assert.equal(conversations[1].creatorId, "creator-b");
  assert.equal(previewMessage(conversations[1])?.text, "캠페인 회신 - Supercent");
});

test("conversation ordering follows the newest mail/message timestamp", () => {
  const conversations = normalizeConversations([
    {
      id: "doc-touched-later",
      creatorId: "creator-a",
      updatedAtIso: "2026-06-26T00:00:00.000Z",
      lastMessageAtIso: "2026-06-24T06:57:00.000Z",
      messages: [
        { id: "older-mail", text: "이전 메일", createdAtIso: "2026-06-24T06:57:00.000Z" },
      ],
    },
    {
      id: "latest-mail",
      creatorId: "creator-a",
      updatedAtIso: "2026-06-24T00:00:00.000Z",
      lastMessageAtIso: "2026-06-25T01:48:00.000Z",
      messages: [
        { id: "seed-order-last", text: "이전 초안", createdAtIso: "2026-06-23T07:19:00.000Z" },
        { id: "newest-mail", text: "승인 회신", createdAtIso: "2026-06-25T01:48:00.000Z" },
      ],
    },
  ]);

  const ordered = [...conversations].sort((left, right) => conversationMillis(right) - conversationMillis(left));

  assert.equal(ordered[0].id, "latest-mail");
  assert.equal(previewMessage(ordered[0])?.text, "승인 회신");
});

test("conversation preview uses lastMessage when it is newer than embedded stale messages", () => {
  const [conversation] = normalizeConversations([{
    id: "last-message-newer",
    creatorId: "creator-newer",
    lastMessage: "방금 들어온 IMAP 회신",
    lastMessageFrom: "creator",
    lastMessageAtIso: "2026-06-29T16:20:00.000Z",
    messages: [
      { id: "embedded-old", text: "예전 임베디드 메시지", createdAtIso: "2026-06-29T12:00:00.000Z" },
    ],
  }]);

  const preview = previewMessage(conversation);

  assert.equal(preview?.text, "방금 들어온 IMAP 회신");
  assert.equal(preview?.createdAtIso, "2026-06-29T16:20:00.000Z");
  assert.equal(conversationMillis(conversation), Date.parse("2026-06-29T16:20:00.000Z"));
});

test("default Chat accepts production snapshot rows with creator reply signals", () => {
  const [replySnapshot, hiddenReplySnapshot, outboundSnapshot] = normalizeConversations([
    {
      id: "reply-snapshot",
      creatorId: "creator-reply",
      lastMessage: "크리에이터가 파트너십 프로그램에 관심을 보입니다.",
      lastMessageFrom: "creator",
      lastMessageAtIso: "2026-06-30T03:44:29.000Z",
      messages: [],
    },
    {
      id: "hidden-reply-snapshot",
      creatorId: "creator-hidden",
      lastMessage: "내부 테스트 회신",
      lastMessageFrom: "creator",
      lastMessageAtIso: "2026-06-30T03:44:29.000Z",
      hiddenFromDefaultChat: true,
      messages: [],
    },
    {
      id: "outbound-snapshot",
      creatorId: "creator-outbound",
      lastMessage: "초기 아웃리치",
      lastMessageFrom: "ai",
      lastMessageAtIso: "2026-06-30T03:44:29.000Z",
      messages: [],
    },
  ]);

  assert.equal(hasCreatorReplySignal(replySnapshot), true);
  assert.equal(isDefaultChatConversation(replySnapshot), true);
  assert.equal(isDefaultChatConversation(hiddenReplySnapshot), false);
  assert.equal(isDefaultChatConversation(outboundSnapshot), false);
});

test("conversationProfile falls back without a creator row and preserves creator detail when present", () => {
  const [conversation] = normalizeConversations([{
    id: "profile-a",
    creatorId: "missing",
    campaignId: "camp-a",
    messages: [{ text: "신규 캠페인 — Supercent Official" }],
  }]);

  const fallback = conversationProfile(conversation, []);
  assert.equal(fallback.name, "Supercent Official");
  assert.equal(fallback.handle, "@supercent-official");
  assert.match(fallback.meta, /YouTube/);
  assert.doesNotMatch(fallback.meta, /@/);

  const withCreator = conversationProfile(conversation, [{
    id: "missing",
    name: "Supercent",
    handle: "@supercent",
    platform: "YouTube",
    followers: 2800000,
    avatar: "avatar",
  }]);
  assert.equal(withCreator.creator?.name, "Supercent");
  assert.equal(withCreator.avatar, "avatar");
  assert.equal(withCreator.email, undefined);
  assert.match(withCreator.meta, /280만 팔로워/);
  assert.match(compactConversationSignal(conversation), /신규 캠페인/);
});

test("conversationProfile matches loaded creators by profile identity fields beyond creator id", () => {
  const [conversation] = normalizeConversations([{
    id: "campaign-cp-1-infly_global_UC123456789",
    creatorId: "infly_global_UC123456789",
    creatorEmail: "brand@example.com",
    channelId: "UC123456789",
    creatorName: "Fallback Name",
    lastMessageFrom: "creator",
    lastMessageAtIso: "2026-06-30T03:44:29.000Z",
  }]);

  const profile = conversationProfile(conversation, [{
    id: "creator-doc-not-equal",
    channelId: "UC123456789",
    name: "Resolved Channel",
    handle: "@resolved",
    profileMatchedEmail: "brand@example.com",
    avatar: "https://example.com/resolved.jpg",
  }]);

  assert.equal(profile.creator?.name, "Resolved Channel");
  assert.equal(profile.avatar, "https://example.com/resolved.jpg");
  assert.equal(profile.handle, "@resolved");
});

test("dedupeConversationsByThread preserves a profile image from an older row in the same thread", () => {
  const conversations = normalizeConversations([
    {
      id: "thread-profile",
      threadId: "thread-profile",
      creatorId: "creator-profile",
      creatorName: "Profile Carrier",
      creatorAvatar: "https://example.com/profile.jpg",
      lastMessageFrom: "ai",
      lastMessageAtIso: "2026-06-29T01:00:00.000Z",
    },
    {
      id: "thread-profile-latest",
      threadId: "thread-profile",
      creatorId: "creator-profile",
      creatorName: "Latest Row",
      lastMessageFrom: "creator",
      lastMessageAtIso: "2026-06-30T01:00:00.000Z",
    },
  ]);

  const [deduped] = dedupeConversationsByThread(conversations);

  assert.equal(deduped.creatorName, "Latest Row");
  assert.equal(deduped.creatorAvatar, "https://example.com/profile.jpg");
});

test("normalizeConversations preserves outreach state and prefers conversation avatar URLs", () => {
  const [conversation] = normalizeConversations([{
    id: "campaign-row",
    creatorId: "candidate:abc",
    creatorName: "Avatar Creator",
    creatorAvatar: "https://example.com/avatar.jpg",
    campaignId: "campaign-a",
    deliveryState: "sent",
    lastDeliveryState: "failed",
    outreachStatus: "failed",
    status: "failed",
  }]);

  assert.equal(conversation.deliveryState, "sent");
  assert.equal(conversation.lastDeliveryState, "failed");
  assert.equal(conversation.outreachStatus, "failed");
  assert.equal(conversation.status, "failed");

  const profile = conversationProfile(conversation, [{
    id: "candidate:abc",
    name: "Creator Row",
    handle: "@creator",
    avatar: "CR",
  }]);
  assert.equal(profile.avatar, "https://example.com/avatar.jpg");
});

test("conversationProfile exposes email separately from compact meta", () => {
  const [conversation] = normalizeConversations([{
    id: "profile-email",
    creatorId: "creator-email",
    creatorEmail: "biz@example.com",
    creatorPlatform: "YouTube",
    creatorFollowers: 123000,
  }]);

  const profile = conversationProfile(conversation, []);

  assert.equal(profile.email, "biz@example.com");
  assert.match(profile.meta, /YouTube/);
  assert.match(profile.meta, /12\.3만 팔로워/);
  assert.doesNotMatch(profile.meta, /biz@example\.com/);
});

test("conversationProfile ignores malformed creator fields before rendering /chat", () => {
  const [conversation] = normalizeConversations([{
    id: "profile-malformed",
    creatorId: "broken-creator",
    campaignId: "camp-malformed",
    messages: [{ text: "신규 캠페인 — Supercent Official" }],
  }]);

  const profile = conversationProfile(conversation, [{
    id: "broken-creator",
    name: { nested: true },
    handle: { nested: true },
    email: { nested: true },
    platform: { nested: true },
    followers: "many",
    avatar: { nested: true },
  }]);

  assert.equal(profile.name, "Supercent Official");
  assert.equal(profile.handle, "@supercent-official");
  assert.equal(profile.followers, undefined);
  assert.equal(profile.avatar, "Supercent Official");
  assert.match(profile.meta, /YouTube/);
});

test("campaign stress personas with the Hesse mailbox do not merge into the protected Hesse thread", () => {
  const conversations = dedupeConversationsByThread(normalizeConversations([
    {
      id: "v-hesse",
      creatorId: "rc-hesse",
      creatorName: "Supercent Official",
      creatorEmail: "hesse@supercent.io",
      threadId: "v-hesse",
      campaignId: "cp-live-hesse-stress",
      lastMessage: "공식 계정 대화",
      lastMessageAtIso: "2026-06-27T15:00:00.000Z",
    },
    {
      id: "campaign-cp-live-hesse-stress-stress-hesse-run-persona-003-budget",
      creatorId: "stress-hesse-run-persona-003-budget",
      creatorName: "Jamie Chen",
      creatorEmail: "hesse@supercent.io",
      threadId: "v-hesse",
      campaignId: "cp-live-hesse-stress",
      lastMessage: "관심 있음 — 예산/단가 범위 문의",
      lastMessageAtIso: "2026-06-27T15:31:45.000Z",
    },
  ]));

  assert.equal(conversations.length, 2);
  const stress = conversations.find((conversation) => conversation.creatorName === "Jamie Chen");
  assert.ok(stress);
  assert.equal(stress.threadId, "thread-stress-hesse-run-persona-003-budget");
  assert.equal(conversationProfile(stress, []).name, "Jamie Chen");
});

test("D: formatProfileMeta는 근거 없는 '메인' 라벨을 붙이지 않는다 (channel-kind 필드가 리포에 없음, 감사 확정)", () => {
  // 예전엔 platform && followers ? "메인" : undefined 가 끼어 있었다 — 실제 채널 종류(메인/서브)를
  // 나타내는 필드는 리포·데이터 어디에도 없는데, platform과 followers가 둘 다 있다는 이유만으로
  // "메인 채널"이라고 단정하던 장식이었다. platform·followers만 조합해야 한다.
  assert.equal(formatProfileMeta("YouTube", 2800000), "YouTube · 280만 팔로워");
  assert.doesNotMatch(formatProfileMeta("YouTube", 2800000), /메인/);
  assert.equal(formatProfileMeta("YouTube", undefined), "YouTube");
  assert.equal(formatProfileMeta(undefined, 12300), "1.2만 팔로워");
  assert.equal(formatProfileMeta(undefined, undefined), "");

  // conversationProfile()도 같은 조합 규칙을 재사용한다 — 공식이 두 곳에서 따로 굳지 않는다.
  const [conversation] = normalizeConversations([{
    id: "profile-meta-d",
    creatorId: "creator-meta-d",
    creatorPlatform: "YouTube",
    creatorFollowers: 2800000,
  }]);
  assert.equal(conversationProfile(conversation, []).meta, formatProfileMeta("YouTube", 2800000));
  assert.doesNotMatch(conversationProfile(conversation, []).meta, /메인/);
});

test("W116: 툴 발송과 중복으로 마킹된 편입 메시지는 렌더 목록에서 빠진다", () => {
  const messages = normalizeMessages([
    { id: "m1", from: "human", text: "정상 발신", createdAtIso: "2026-08-10T00:00:00.000Z" },
    {
      id: "msg-external-sent-dup",
      from: "human",
      text: "Collab follow-up · 보낸편지함 가져옴",
      createdAtIso: "2026-08-10T00:01:00.000Z",
      hiddenReason: "tool_duplicate",
    },
  ], "thread");
  assert.deepEqual(messages.map((message) => message.id), ["m1"]);
});

test("W116-H1: 허용값이 아닌 hiddenReason 은 메시지를 지우지 못한다", () => {
  // 서버 투영은 화이트리스트를 거치지만, 클라가 truthy 검사면 다른 경로(임베드 프리뷰·목 데이터)로
  // 들어온 임의 문자열이 대화를 조용히 지운다. 등가 비교여야 한다.
  const messages = normalizeMessages([
    { id: "m1", from: "human", text: "정상", createdAtIso: "2026-08-10T00:00:00.000Z" },
    { id: "m2", from: "human", text: "임의값", createdAtIso: "2026-08-10T00:01:00.000Z", hiddenReason: "spam" },
    { id: "m3", from: "human", text: "빈문자", createdAtIso: "2026-08-10T00:02:00.000Z", hiddenReason: "" },
    { id: "m4", from: "human", text: "참", createdAtIso: "2026-08-10T00:03:00.000Z", hiddenReason: true },
    { id: "m5", from: "human", text: "대소문자", createdAtIso: "2026-08-10T00:04:00.000Z", hiddenReason: "TOOL_DUPLICATE" },
  ], "thread");
  assert.deepEqual(messages.map((message) => message.id), ["m1", "m2", "m3", "m4", "m5"]);
});

test("W116: hiddenReason 이 없으면 편입 메시지는 그대로 보인다(과잉 숨김 금지)", () => {
  const messages = normalizeMessages([
    {
      id: "msg-external-sent-keep",
      from: "human",
      text: "Collab follow-up · 보낸편지함 가져옴",
      createdAtIso: "2026-08-10T00:01:00.000Z",
    },
  ], "thread");
  assert.deepEqual(messages.map((message) => message.id), ["msg-external-sent-keep"]);
});
