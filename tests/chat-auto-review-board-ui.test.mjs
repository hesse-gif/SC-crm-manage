// /chat/auto 검토 보드 (2026-10-05) — client-side unit tests: draft lint, template library, cross-page
// merge + live counts, URL state, composer prefill (consume once) and link shape; plus static checks
// that the board UI exposes no send/save path and the /chat fixes are wired. Synthetic data only.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import {
  SCP_LINT_PASS_COPY,
  buildReviewBoardSearch,
  chatConversationHref,
  lintPassed,
  lintScpReplyDraft,
  mergeReviewBoardRows,
  parseReviewBoardUrlState,
  resolveTemplateChoice,
  reviewBoardCounts,
} from "../src/lib/scpReplyReview.ts";
import { SCP_REPLY_TEMPLATES, scpReplyTemplate } from "../src/lib/scpReplyTemplates.ts";
import { COMPOSER_PREFILL_TTL_MS, consumeComposerPrefill, stageComposerPrefill } from "../src/lib/chatComposerPrefill.ts";
import { messageOtherConversationTail, normalizeMessage } from "../src/lib/chat-normalization.ts";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const failedIds = (checks) => checks.filter((check) => !check.ok).map((check) => check.id);

// ── templates + lint ─────────────────────────────────────────────────────────────────────────────

test("every library template (A–G, greeting A, rate policy) passes the draft lint", () => {
  assert.deepEqual(SCP_REPLY_TEMPLATES.map((template) => template.id), ["A", "B", "C", "D", "E", "F", "G", "greeting_a", "rate_policy"]);
  for (const template of SCP_REPLY_TEMPLATES) {
    assert.deepEqual(failedIds(lintScpReplyDraft(template.text, 1)), [], template.id);
    assert.ok(template.text.trim().endsWith("Super Creator Partners Team"), template.id);
    assert.ok(template.provenance.length > 0, template.id);
  }
  assert.equal(scpReplyTemplate("D").recommendable, false, "D is reference-only under the current policy");
  assert.match(scpReplyTemplate("D").usage, /이전 기준 참고\(2026-10-05 이전\)/);
  assert.equal(scpReplyTemplate("G").condition, "실제 계정 확인이 진행 중일 때만 사용");
  assert.match(scpReplyTemplate("rate_policy").provenance, /caa40c.*6194a6/);
  assert.match(scpReplyTemplate("greeting_a").provenance, /YyQs6g/);
});

test("templates are verbatim copies of the operator sources (checked when the sources are present locally)", () => {
  const metaprompt = "/Users/supercent/Dev/flu/casebook-inbox-2026-10-01/gpt-dot-reply-metaprompt.md";
  if (existsSync(metaprompt)) {
    const source = readFileSync(metaprompt, "utf8");
    for (const id of ["A", "B", "C", "D", "E", "F", "G"]) assert.ok(source.includes(scpReplyTemplate(id).text), id);
  }
  const reviewDir = "/Users/supercent/Documents/Codex/2026-10-05/task/scp-review";
  for (const [file, id] of [["draft-greeting-A-review-only.md", "greeting_a"], ["draft-custom-rate-policy-review-only.md", "rate_policy"]]) {
    if (existsSync(`${reviewDir}/${file}`)) assert.ok(readFileSync(`${reviewDir}/${file}`, "utf8").includes(scpReplyTemplate(id).text), id);
  }
});

test("lint flags the known conflicts and the reviewer regressions", () => {
  const supercentSigned = "Hi:)\n\nThanks for reaching out.\n\nBest regards,\nSupercent";
  assert.ok(failedIds(lintScpReplyDraft(supercentSigned, 1)).includes("signature"));
  assert.ok(failedIds(lintScpReplyDraft("Hi, sorry for the delay. Your rate is 2 per view.\nSuper Creator Partners Team", 1)).includes("no_amounts"));
  assert.ok(failedIds(lintScpReplyDraft("Hi, sorry for the delay. We can make an exception.\nSuper Creator Partners Team", 1)).includes("no_promises"));
  assert.ok(failedIds(lintScpReplyDraft("Hi. {{GUIDELINE_AMOUNT}} per video.\nSuper Creator Partners Team", 1)).includes("no_amounts"));
  assert.ok(failedIds(lintScpReplyDraft("There is no separate approval step.\nSuper Creator Partners Team", 1)).includes("no_approval_claim"));
  assert.ok(failedIds(lintScpReplyDraft("We fixed the bug.\nSuper Creator Partners Team", 1)).includes("no_forbidden_words"));
  assert.ok(failedIds(lintScpReplyDraft(scpReplyTemplate("A").text, 3)).includes("single_question_inbound"));
  assert.ok(failedIds(lintScpReplyDraft(scpReplyTemplate("A").text, null)).includes("single_question_inbound"));
  assert.equal(lintPassed(lintScpReplyDraft(scpReplyTemplate("A").text, 1)), true);
  assert.equal(SCP_LINT_PASS_COPY, "기계 검사에서 해당 표현 미검출");
});

// ── merge + counts ───────────────────────────────────────────────────────────────────────────────

function row(overrides = {}) {
  const conversationId = overrides.conversationId ?? "conv-ui-000001";
  return {
    rowKey: overrides.rowKey ?? `c:${conversationId}`,
    conversationId,
    conversationTail: conversationId.slice(-6),
    primaryCaseId: "submission_support",
    primaryCaseLabel: "Submission support",
    evidenceCaseIds: [],
    protected: false,
    protectedReasons: [],
    sendBatch: { bucket: "final_safety_wait", reason: null, reasonLabel: null, allReasons: [] },
    nextAction: "final_safety_check",
    nextActionLabel: "마지막 안전 확인",
    classification: { kind: "auto", label: "자동 추천(원문 규칙)" },
    claims: [],
    newInboundSinceJudgment: false,
    question: { status: "unresolved", label: "미해결 질문", questionCount: 1, recommendedHandling: "" },
    draft: { status: "system_default", draftAllowed: true, reason: null, caseId: "submission_support", label: "현재 시스템 기본 답신 (운영자 승인 문구와 다름)", sourceLabel: "Flu 케이스북 정본", basisLabel: null, text: "Hi", suggestedTemplateId: "B", sendable: false, sendableLabel: "전송 불가(검토 전용)" },
    summary: { status: "confirmed", value: "요약", reason: null, source: "body", sourceLabel: "AI 요약" },
    realReplies: { status: "confirmed", value: 0, reason: null, latestAtIso: null, latestAfterInbound: false, possibleCount: 0, evidence: [] },
    queued: { status: "confirmed", value: false, reason: null },
    suppressed: { status: "confirmed", value: false, reason: null },
    aiActive: { status: "confirmed", value: true, reason: null },
    orgAutomationOff: false,
    identity: { status: "confirmed", value: "verified", reason: null, fromMatches: true },
    registration: { status: "confirmed", value: "not_applicable", reason: null },
    latestInboundAtIso: "2026-10-04T00:00:00.000Z",
    lastMessageSide: "creator",
    creatorName: "Synthetic",
    creatorHandle: null,
    creatorEmailMasked: "s***@example.test",
    programLabel: null,
    unknowns: [],
    grouping: { kind: "single_conversation", label: "대화 1개" },
    conversations: [{ conversationId, conversationTail: conversationId.slice(-6), primaryCaseId: "submission_support", primaryCaseLabel: "Submission support", latestInboundAtIso: overrides.latestInboundAtIso ?? "2026-10-04T00:00:00.000Z", protected: Boolean(overrides.protected) }],
    ...overrides,
  };
}

test("cross-page merge: one person row per verified key, protection is group-level, counts keep units apart", () => {
  const page1 = [
    row({ rowKey: "p:abc", conversationId: "conv-ui-new001", latestInboundAtIso: "2026-10-05T00:00:00.000Z", grouping: { kind: "verified_sender", label: "확인된 발신자" } }),
    row({ conversationId: "conv-ui-single" }),
  ];
  const page2 = [row({ rowKey: "p:abc", conversationId: "conv-ui-old002", latestInboundAtIso: "2026-10-01T00:00:00.000Z", protected: true, protectedReasons: ["운영자 담당 (AI off)"], grouping: { kind: "verified_sender", label: "확인된 발신자" } })];
  const merged = mergeReviewBoardRows(mergeReviewBoardRows([], page1), page2);
  assert.equal(merged.length, 2);
  const person = merged.find((item) => item.rowKey === "p:abc");
  assert.deepEqual(person.conversations.map((item) => item.conversationId), ["conv-ui-new001", "conv-ui-old002"]);
  assert.equal(person.conversationId, "conv-ui-new001");
  assert.equal(person.protected, true);
  assert.equal(person.draft.draftAllowed, false);
  assert.equal(person.draft.suggestedTemplateId, null);
  assert.equal(person.summary.value, null);
  assert.equal(person.sendBatch.bucket, "operator_judgment");
  assert.equal(person.newInboundSinceJudgment, true);
  const counts = reviewBoardCounts(merged);
  assert.equal(counts.verifiedGroups.all, 1);
  assert.equal(counts.unverifiedConversations.all, 1);
  assert.equal(counts.conversations, 3);
  assert.equal(counts.protectedConversations, 2, "a protected group counts all its conversations as protected items");
  assert.equal(counts.rows.final_safety_wait, 1);
});

// ── URL state + links ────────────────────────────────────────────────────────────────────────────

test("URL state round-trips tab/open/template/scroll/pages and keeps unrelated params; 'none' differs from unset", () => {
  const search = buildReviewBoardSearch("?other=1", { tab: "excluded", open: "p:abc", template: "none", scrollY: 812, pages: 2 });
  const state = parseReviewBoardUrlState(new URLSearchParams(search));
  assert.deepEqual(state, { tab: "excluded", open: "p:abc", template: "none", scrollY: 812, pages: 2 });
  assert.match(search, /other=1/);
  assert.equal(parseReviewBoardUrlState(new URLSearchParams("?rb=bogus&rbPages=99")).tab, "all");
  assert.equal(parseReviewBoardUrlState(new URLSearchParams("?rbPages=99")).pages, 8, "restore is bounded");
  const recommended = scpReplyTemplate("B");
  assert.equal(resolveTemplateChoice(null, recommended, scpReplyTemplate).id, "B", "unset → recommendation");
  assert.equal(resolveTemplateChoice("none", recommended, scpReplyTemplate), null, "none → nothing");
  assert.equal(resolveTemplateChoice("E", recommended, scpReplyTemplate).id, "E");
  assert.equal(buildReviewBoardSearch("?rb=excluded&rbOpen=x", { tab: "all", open: null }), "");
  assert.equal(parseReviewBoardUrlState(new URLSearchParams(buildReviewBoardSearch("", { scrollY: 0 }))).scrollY, 0, "top (0) round-trips");
  assert.equal(parseReviewBoardUrlState(new URLSearchParams("")).scrollY, null);
});

test("'대화 열기' links are always /chat?conversationId=<encoded id>, never bare /chat", () => {
  assert.equal(chatConversationHref("conv a/b"), "/chat?conversationId=conv%20a%2Fb");
  assert.equal(chatConversationHref(""), null);
  assert.equal(chatConversationHref(null), null);
  const dir = new URL("../src/app/(app)/chat/auto/", import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".tsx"))) {
    const source = readFileSync(new URL(file, dir), "utf8");
    assert.doesNotMatch(source, /href=["'{`]+\/chat["'`]/, `${file} must not link to a bare /chat`);
    for (const match of source.matchAll(/\/chat\?conversationId=\$\{([^}]+)\}/g)) {
      assert.match(match[1], /^encodeURIComponent\(/, `${file}: conversation id must be encoded`);
    }
  }
});

// ── composer prefill ─────────────────────────────────────────────────────────────────────────────

function memoryStore() {
  const map = new Map();
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key), map };
}

test("composer prefill: text never in the URL, consumed exactly once, bound to conversation + nonce, TTL-bounded", () => {
  const store = memoryStore();
  const href = stageComposerPrefill({ conversationId: "conv-ui-000001", templateId: "A", text: "Hi :) body" }, { store, nowMs: 1000, nonce: "n1" });
  assert.equal(href, "/chat?conversationId=conv-ui-000001&prefill=n1");
  assert.doesNotMatch(href, /Hi|body/);
  assert.equal(consumeComposerPrefill("conv-other", "n1", { store, nowMs: 2000 }), null, "other conversation never gets it");
  assert.equal(consumeComposerPrefill("conv-ui-000001", "wrong", { store, nowMs: 2000 }), null);
  const entry = consumeComposerPrefill("conv-ui-000001", "n1", { store, nowMs: 2000 });
  assert.equal(entry.text, "Hi :) body");
  assert.equal(consumeComposerPrefill("conv-ui-000001", "n1", { store, nowMs: 2000 }), null, "second consume is a no-op");
  stageComposerPrefill({ conversationId: "conv-ui-000001", templateId: "A", text: "x" }, { store, nowMs: 0, nonce: "n2" });
  assert.equal(consumeComposerPrefill("conv-ui-000001", "n2", { store, nowMs: COMPOSER_PREFILL_TTL_MS + 1 }), null, "stale entry is dropped");
  assert.equal(stageComposerPrefill({ conversationId: "conv", templateId: "A", text: "x" }, { store: null }), null);
});

test("/chat consumes the prefill once into the existing composer, asks before replacing unsaved text, and makes no callable for it", () => {
  const chat = read("src/app/(app)/chat/page.tsx");
  const start = chat.indexOf("const boardPrefillNonce");
  const block = chat.slice(start, chat.indexOf("}, [boardPrefillNonce", start));
  assert.ok(start > 0);
  assert.match(block, /consumeComposerPrefill\(requestedConversationId, boardPrefillNonce\)/);
  assert.ok(block.indexOf("succeededMessageKeys.has(selectedConversationKey)") > 0 && block.indexOf("succeededMessageKeys.has(selectedConversationKey)") < block.indexOf("consumeComposerPrefill("), "consumed only after the messages loaded SUCCESSFULLY (reply-source scope settled)");
  assert.match(block, /window\.confirm\(/);
  assert.match(block, /setDraftBody\(entry\.text\)/);
  assert.doesNotMatch(block, /sendEmail|gatewayProxy|saveChatAutoCaseReply|setConversationAutoReply|markConversationRead|updateWorkflowItemState|await /);
  assert.match(chat, /if \(boardPrefillNonce \|\| boardPrefillAppliedScopeRef\.current === composeScopeKey\) return;/, "a pending or applied board hand-off suppresses the automatic AI draft");
  assert.equal((chat.match(/if \(boardHandoffTargetRef\.current && \(selectedConversationId === boardHandoffTargetRef\.current \|\| chatConversationMatchesSelection\(conv, boardHandoffTargetRef\.current\)\)\) return;/g) ?? []).length, 2, "hand-off guards (auto-draft + mark-read) are scoped to the selected conversation");
  assert.match(chat, /next\.delete\(selectedConversationKey\)/, "a failed message load clears the success mark");
});

// ── board UI static guarantees ───────────────────────────────────────────────────────────────────

test("review board UI: read-only (no send/save/schedule callables), protected rows have no template/composer button, ≥12px text", () => {
  const panel = read("src/app/(app)/chat/auto/ReviewBoardPanel.tsx");
  assert.doesNotMatch(panel, /sendEmail|sendChatAutoCaseHeldBacklogNow|saveChatAutoCaseReply|setChatAutoCasePermitArming|updateAutoReply|setConversationAutoReply|gatewayProxy|suggestChatAutoCaseReply/);
  assert.match(panel, /listChatAutoReviewBoard/);
  const draft = panel.slice(panel.indexOf("function DraftReview"));
  const lockedReturn = draft.indexOf("if (!row.draft.draftAllowed)");
  assert.ok(lockedReturn > 0 && lockedReturn < draft.indexOf("template-to-composer"), "the locked branch returns before any template/composer UI");
  assert.doesNotMatch(panel, /text-\[1[01]px\]|text-\[9px\]/);
  assert.doesNotMatch(panel, /발송 가능(?! 아님)/);
  assert.match(panel, /전송 불가\(검토 전용\)/);
  const page = read("src/app/(app)/chat/auto/page.tsx");
  assert.ok(page.indexOf("<ReviewBoardPanel") > 0 && page.indexOf("<ReviewBoardPanel") < page.indexOf("<PermitCasePanel"), "board sits above the existing case cards");
});

// ── /chat fixes ──────────────────────────────────────────────────────────────────────────────────

test("/chat: other-conversation tag, 요약본 source, loading states and list-scope wording", () => {
  assert.equal(messageOtherConversationTail({ conversationId: "conv-other-abcdef" }, "conv-shown-000001"), "abcdef");
  assert.equal(messageOtherConversationTail({ conversationId: "conv-shown-000001" }, "conv-shown-000001"), null);
  assert.equal(messageOtherConversationTail({}, "conv-shown-000001"), null);
  assert.equal(normalizeMessage({ id: "m1", from: "creator", summaryKr: "요약" }, "f").textSource, "summary");
  assert.equal(normalizeMessage({ id: "m2", from: "creator", text: "요약", summaryKr: "요약" }, "f").textSource, "summary");
  assert.equal(normalizeMessage({ id: "m3", from: "creator", text: "Real body", summaryKr: "요약" }, "f").textSource, undefined);
  const chat = read("src/app/(app)/chat/page.tsx");
  assert.match(chat, /data-testid="message-other-conversation"/);
  assert.match(chat, /data-testid="message-summary-badge"/);
  assert.match(chat, /!autoReplySettingsLoaded\s*\?\s*"확인 중"/);
  assert.match(chat, /data-testid="chat-messages-loading"/);
  assert.match(chat, /목록 범위: 미등록 대화 포함/);
  assert.match(chat, /대화별 차단 표시는 아니에요/);
  assert.doesNotMatch(chat, /counterpartyRegistered\s*(===|!==)\s*(false|undefined)[^\n]*미등록/, "never renders 미등록 per conversation from the stamp");
  assert.match(chat, /personRooms\.find\(requestedRoomMatches\)/, "deep link falls back to unfiltered rooms");
  assert.match(chat, /const personTargetStrandKey = requestedStrandKey\s*\|\|/, "a deep link selects the requested (possibly non-default) strand");
  assert.match(chat, /&& !replyTargetStrand && deepLinkStrandActive/, "the deep-link strand preference is one-time");
  assert.match(chat, /function selectStrandFilter\(strandKeyArg: string\) \{[\s\S]{0,200}endDeepLinkStrandPreference\(\);/, "explicit strand navigation ends it");
  assert.equal((chat.match(/setDeepLinkStrandActive\(/g) ?? []).length, 3, "only the single user-intent path and the new-deep-link arm touch the preference");
  assert.match(chat, /onReplyToStrand=\{m\.from === "creator" \? \(\) => selectReplyTargetByUser\(m\.sourceUiThreadKey\)/, "bubble reply goes through the single user path");
  assert.match(chat, /onChange=\{\(key\) => \{ endDeepLinkStrandPreference\(\); setTab\(key\); \}\}/, "list tab changes end the preference");
  assert.match(chat, /setLastFlatClick\(null\);\s*\n\s*\/\/[^\n]*\n\s*setStrandFilter\("all"\);\s*\n\s*setReplyTargetStrand\(""\);\s*\n\s*\}, \[requestedConversationId\]\);/, "a new deep link (same person too) drops the previous strand override");
});
