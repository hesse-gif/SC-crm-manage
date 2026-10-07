// /chat/auto 검토 보드 (2026-10-05) — node-lane tests for functions/chatAutoReviewBoardModel.ts (pure
// verdicts: outbound classification, short-inbound rules, protection, bucketing, grouping) and
// functions/chatAutoReviewBoard.ts (listChatAutoReviewBoard: auth, read-only guarantee, metadata-first
// read order, payload). Every fixture is synthetic (example.test addresses, made-up ids). No
// Firestore, no Peoply, no network: the callable's readers are injected.
// Run: npm --prefix functions run build && node --test tests/chat-auto-review-board.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const model = await import(new URL("../functions/lib/chatAutoReviewBoardModel.js", import.meta.url));
const { CHAT_CASEBOOK } = await import(new URL("../functions/lib/chatCasebook.js", import.meta.url));
const {
  assessReviewProtection,
  classifyReviewOutbound,
  classifyShortInbound,
  countInboundQuestions,
  evaluateReviewConversation,
  groupReviewConversations,
  inboundSummarySource,
  isFixedFeeOfferOnly,
  REVIEW_NEXT_ACTION_LABELS,
} = model;

const TEMPLATES = new Map(CHAT_CASEBOOK.filter((item) => item.autoReplyTemplate?.template).map((item) => [item.id, item.autoReplyTemplate.template]));
const INBOUND_AT = "2026-10-04T00:00:00.000Z";

function facts(overrides = {}) {
  const { inbound, outbound, queue, suppression, ...rest } = overrides;
  return {
    conversationId: "conv-synthetic-000001",
    mailAccountId: "scp",
    aiActive: true,
    autoReplyStatus: "waiting_for_human",
    primaryCaseId: "submission_support",
    caseCandidateIds: [],
    actorType: "creator",
    intentLabels: ["submission_help"],
    gateReasonText: "",
    labelSource: "model",
    caseStampStale: false,
    orgAutomationOff: false,
    creatorName: "Synthetic Creator",
    creatorHandle: "@synthetic",
    creatorEmailMasked: "s***@example.test",
    programLabel: "Synthetic Program",
    latestInboundAtIso: INBOUND_AT,
    lastMessageFrom: "creator",
    summaryKr: "제출 방법 문의",
    addressProtectionReasons: [],
    inbound: {
      link: "confirmed",
      body: "Hello, how do I submit my video for the program?",
      bodyRead: true,
      summaryKr: "제출 방법 문의",
      binding: { status: "verified", bindingScope: "program", reasonCode: "verified", inboundSenderHash: "hash-a" },
      inboundSenderHash: "hash-a",
      ...inbound,
    },
    outbound: { status: "confirmed", reason: null, rows: [], ...outbound },
    queue: { status: "confirmed", liveCount: 0, reason: null, ...queue },
    suppression: { status: "confirmed", blocked: false, ...suppression },
    defaultReplyFor: (caseId) => (TEMPLATES.has(caseId) ? { text: TEMPLATES.get(caseId), sourceLabel: "Flu 케이스북 정본" } : null),
    ...rest,
  };
}
const body = (text, extra = {}) => ({ inbound: { body: text, ...extra } });

// ── outbound classification ─────────────────────────────────────────────────────────────────────

test("outbound: only a sendEmail reply on a creator thread is a confirmed real reply; Sent-import reply headers are only possible", () => {
  assert.equal(classifyReviewOutbound({ direction: "outbound", source: "sendEmail", deliveryState: "sent", replyToMessageRef: "message_sources/in-1", conversationId: "conv-x" }), "real_reply");
  assert.equal(classifyReviewOutbound({ direction: "outbound", source: "sendEmail", deliveryState: "sent", replyToMessageRef: "x" }), "unknown", "no conversation = not provably a creator thread");
  assert.equal(classifyReviewOutbound({ direction: "outbound", source: "sendEmail", deliveryState: "sent", subject: "Re: hi", conversationId: "conv-x" }), "unknown", "Re: alone is not proof");
  assert.equal(classifyReviewOutbound({ direction: "outbound", source: "external_sent_mail_import", deliveryState: "sent", kind: "manual_reply" }), "possible_reply");
  assert.equal(classifyReviewOutbound({ direction: "outbound", source: "external_sent_mail_import", deliveryState: "sent", subject: "Re: question" }), "possible_reply");
  assert.equal(classifyReviewOutbound({ direction: "outbound", source: "external_sent_mail_import", deliveryState: "sent", inReplyToHash: "abc" }), "possible_reply");
  assert.equal(classifyReviewOutbound({ direction: "outbound", campaignId: "cp-1", targetId: "t-1", conversationId: "campaign-cp-1-x", deliveryState: "sent" }), "outreach");
  assert.equal(classifyReviewOutbound({ direction: "outbound", source: "sendEmail", conversationId: "program-abc", replyToMessageRef: "x", deliveryState: "sent" }), "outreach", "outreach threads never count as replies");
  assert.equal(classifyReviewOutbound({ direction: "outbound", source: "scp_resubmission_nudge", deliveryState: "sent" }), "nudge");
  assert.equal(classifyReviewOutbound({ direction: "outbound", source: "external_sent_mail_import", mailType: "uid_guide", subject: "Re: Your UID guide", deliveryState: "sent" }), "system");
  assert.equal(classifyReviewOutbound({ direction: "outbound", source: "sendEmail", conversationId: "c", replyToMessageRef: "x", deliveryState: "mock_sent" }), "not_sent");
  assert.equal(classifyReviewOutbound({ direction: "outbound", source: "sendEmail", conversationId: "c", replyToMessageRef: "x", deliveryState: "queued_for_review" }), "not_sent");
});

// ── inbound text signals ────────────────────────────────────────────────────────────────────────

test("question counting ignores quoted history; summary source never upgrades a summary to an original", () => {
  assert.equal(countInboundQuestions("Is it open? And how much?\n\nOn Mon, someone wrote:\n> Are you there?"), 2);
  assert.equal(countInboundQuestions("> quoted?\nThanks"), 0);
  assert.equal(inboundSummarySource("Hello there, I want to join the program and share videos.", "참여 의사"), "body");
  assert.equal(inboundSummarySource("참여 의사", "참여 의사"), "summary_fallback");
  assert.equal(inboundSummarySource("안녕하세요 참여하고 싶어요", "참여 의사"), "unverified", "a Korean body may be a genuine inquiry");
  assert.equal(inboundSummarySource("", "요약"), "summary_fallback");
  assert.equal(inboundSummarySource(null, null), "none");
});

test("short-inbound shape is a FULL match on the real body", () => {
  assert.equal(classifyShortInbound("hello dear"), "greeting");
  assert.equal(classifyShortInbound("Hi John!"), "greeting");
  assert.equal(classifyShortInbound("I'm thinking about it"), "greeting");
  assert.equal(classifyShortInbound("Hello, please send a brief and confirm my bank"), "other");
  assert.equal(classifyShortInbound("Hello, I want to join. How?"), "other");
  assert.equal(classifyShortInbound("thanks!"), "closing");
  assert.equal(classifyShortInbound("ok"), "closing");
  assert.equal(classifyShortInbound("👍"), "closing");
  assert.equal(classifyShortInbound("Thanks 👍"), "closing");
  assert.equal(classifyShortInbound("Thank you so much!\n\nBest regards,"), "closing", "an explicit sign-off phrase line is ignored");
  assert.equal(classifyShortInbound("Thank you so much!\n\nBest regards,\nAlex"), "other", "an unproven trailing name line is kept → operator judgment (conservative)");
  assert.equal(classifyShortInbound("Thanks!\nRegards,\nDiscuss Terms"), "other");
  assert.equal(classifyShortInbound("Thank you! Can you tell me when payment arrives"), "other");
  assert.equal(classifyShortInbound("Thanks, please send the contract"), "other");
});

test("fixed-fee offer only = an offer and nothing else", () => {
  assert.equal(isFixedFeeOfferOnly("We offer a sponsored video at a flat fee of 300 USD per video."), true);
  assert.equal(isFixedFeeOfferOnly("Our fixed fee is 300 USD. Send me the brief and rights terms."), false);
  assert.equal(isFixedFeeOfferOnly("Our fixed fee is 300 USD. When is payment?"), false);
  assert.equal(isFixedFeeOfferOnly("Hello"), false);
});

// ── board-only operator rules ───────────────────────────────────────────────────────────────────

test("rule: fixed-fee sponsorship proposal only → 답장 없이 제외, question not needed, no draft, no template", () => {
  const row = evaluateReviewConversation(facts({ primaryCaseId: "fixed_terms_inquiry", intentLabels: ["custom_terms_proposal"], ...body("We offer a sponsored video at a flat fee of 300 USD per video.") }));
  assert.equal(row.sendBatch.reason, "fixed_fee_proposal_only");
  assert.equal(row.nextAction, "exclude_no_reply");
  assert.equal(row.nextActionLabel, "답장 없이 제외");
  assert.equal(row.question.status, "not_needed");
  assert.equal(row.draft.text, null);
  assert.equal(row.draft.suggestedTemplateId, null, "D is never preselected for fixed-fee-only");
});

test("rule: fixed fee + extra request (no '?') or + question → operator judgment, unresolved", () => {
  for (const text of ["Our fixed fee is 300 USD. Send me the brief and rights terms.", "Our fixed fee is 300 USD. When is the monthly settlement paid?"]) {
    const row = evaluateReviewConversation(facts({ primaryCaseId: "fixed_terms_inquiry", intentLabels: ["custom_terms_proposal"], ...body(text) }));
    assert.equal(row.sendBatch.bucket, "operator_judgment", text);
    assert.equal(row.nextAction, "operator_judgment", text);
    assert.equal(row.question.status, "unresolved", text);
  }
});

test("rule: fixed-fee label with only a summary fallback is never concluded → 원문 미확보 · 사람 판단", () => {
  const row = evaluateReviewConversation(facts({ primaryCaseId: "fixed_terms_inquiry", intentLabels: ["custom_terms_proposal"], ...body("고정 단가 제안", { summaryKr: "고정 단가 제안" }) }));
  assert.notEqual(row.sendBatch.reason, "fixed_fee_proposal_only");
  assert.equal(row.sendBatch.bucket, "operator_judgment");
  assert.equal(row.nextAction, "original_missing_judgment");
  assert.equal(row.question.status, "unknown");
});

test("rule: individual rate-change request → 정책 안내 초안 검토 with rate_policy preselected and the operator-decision basis", () => {
  const row = evaluateReviewConversation(facts({ primaryCaseId: "counter_offer_guideline_reply", intentLabels: ["custom_terms_proposal"], ...body("Could you raise my rate per video? I'd like a higher rate.") }));
  assert.equal(row.nextAction, "policy_guide_draft_review");
  assert.equal(row.nextActionLabel, "정책 안내 초안 검토");
  assert.match(row.question.recommendedHandling, /개별 조정 불가\(내부 정책\)/);
  assert.equal(row.draft.suggestedTemplateId, "rate_policy");
  assert.match(row.draft.basisLabel, /운영자 결정 \(2026-10-05\)/);
  assert.equal(row.draft.label, "현재 시스템 기본 답신 (운영자 승인 문구와 다름)");
});

test("rule: general reward-structure question → 보상 가이드 안내 초안 검토 (distinct from rate change), template C", () => {
  const row = evaluateReviewConversation(facts({ primaryCaseId: "reward_overview", intentLabels: ["reward_info_request"], ...body("How does the reward structure work?") }));
  assert.equal(row.nextAction, "reward_guide_draft_review");
  assert.notEqual(row.nextActionLabel, REVIEW_NEXT_ACTION_LABELS.policy_guide_draft_review);
  assert.equal(row.draft.suggestedTemplateId, "C");
  assert.equal(row.sendBatch.bucket, "final_safety_wait");
});

test("rule: settlement dispute → protected operator judgment, no draft, no summary, no template", () => {
  const row = evaluateReviewConversation(facts({ primaryCaseId: "settlement_dispute", intentLabels: ["settlement_question", "complaint"], inbound: { body: null, bodyRead: false } }));
  assert.equal(row.protected, true);
  assert.equal(row.sendBatch.bucket, "operator_judgment");
  assert.equal(row.draft.draftAllowed, false);
  assert.equal(row.draft.suggestedTemplateId, null);
  assert.equal(row.summary.value, null);
});

test("rule: 'hello dear' with no labels → 참여 안내 초안 검토 (greeting A preselected); with a summary-only body → unknown", () => {
  const row = evaluateReviewConversation(facts({ primaryCaseId: "confusion_or_short", intentLabels: [], ...body("hello dear") }));
  assert.equal(row.nextAction, "participation_guide_draft_review");
  assert.equal(row.nextActionLabel, "참여 안내 초안 검토");
  assert.equal(row.draft.suggestedTemplateId, "greeting_a");
  assert.equal(row.draft.caseId, "interest_next_steps");
  assert.equal(row.sendBatch.bucket, "operator_judgment", "confusion_or_short is a needs_review case — never final_safety_wait");
  const fallback = evaluateReviewConversation(facts({ primaryCaseId: "confusion_or_short", intentLabels: ["interest"], ...body("인사", { summaryKr: "인사" }) }));
  assert.equal(fallback.nextAction, "original_missing_judgment");
  assert.equal(fallback.question.status, "unknown");
  assert.equal(fallback.sendBatch.bucket, "operator_judgment");
});

test("rule: thanks / ok / emoji closings → excluded closing_or_no_question, no draft", () => {
  for (const text of ["Thank you!", "ok", "👍", "Thanks 👍"]) {
    const row = evaluateReviewConversation(facts({ primaryCaseId: "closing_acknowledgment", intentLabels: ["closing"], ...body(text) }));
    assert.equal(row.sendBatch.reason, "closing_or_no_question", text);
    assert.equal(row.nextAction, "closing_no_reply", text);
    assert.equal(row.draft.text, null, text);
    assert.equal(row.question.status, "not_needed", text);
  }
});

test("rule: a closing LABEL contradicted by the body stays open (operator judgment, unresolved)", () => {
  for (const text of ["Thank you! Can you tell me when payment arrives", "Thanks, please send the contract", "Hello, please send a brief and confirm my bank"]) {
    const row = evaluateReviewConversation(facts({ primaryCaseId: "closing_acknowledgment", intentLabels: ["closing"], ...body(text) }));
    assert.notEqual(row.sendBatch.reason, "closing_or_no_question", text);
    assert.equal(row.sendBatch.bucket, "operator_judgment", text);
    assert.equal(row.question.status, "unresolved", text);
  }
  const label = evaluateReviewConversation(facts({ primaryCaseId: "closing_acknowledgment", intentLabels: ["closing"], ...body("Thanks", { summaryKr: "Thanks" }) }));
  assert.equal(label.nextAction, "original_missing_judgment", "a label alone never closes a row");
});

// ── exclusions, protection, unknown-first ───────────────────────────────────────────────────────

test("AI off is operator-owned and a protection reason: excluded, no summary, no draft", () => {
  const row = evaluateReviewConversation(facts({ aiActive: false, inbound: { body: null, bodyRead: false } }));
  assert.equal(row.sendBatch.reason, "ai_off");
  assert.equal(row.nextAction, "operator_owned_ai_off");
  assert.ok(row.protectedReasons.includes("운영자 담당 (AI off)"));
  assert.equal(row.summary.value, null);
  assert.equal(row.draft.text, null);
});

test("protection covers suppression, legal, privacy, rejection appeal, account access, impersonation, settlement", () => {
  const base = { aiActive: true, primaryCaseId: null, intentLabels: [], gateReasonText: "", suppressionBlocked: false, binding: null, inboundSenderHash: null };
  assert.deepEqual(assessReviewProtection(base), []);
  assert.ok(assessReviewProtection({ ...base, suppressionBlocked: true }).includes("수신 억제"));
  assert.ok(assessReviewProtection({ ...base, primaryCaseId: "opt_out_or_legal" }).includes("수신거부·법적"));
  assert.ok(assessReviewProtection({ ...base, primaryCaseId: "access_concern" }).includes("계정 접근 문제"));
  assert.ok(assessReviewProtection({ ...base, gateReasonText: "privacy / GDPR request" }).includes("개인정보·삭제 요청"));
  assert.ok(assessReviewProtection({ ...base, gateReasonText: "rejection appeal" }).includes("반려 이의"));
  assert.ok(assessReviewProtection({ ...base, intentLabels: ["complaint"] }).includes("불만·이의 제기"));
  assert.ok(assessReviewProtection({ ...base, binding: { status: "review_required", inboundSenderHash: "h", reasonCode: "sender_not_creator" }, inboundSenderHash: "h" }).includes("발신자 불일치"));
  assert.ok(assessReviewProtection({ ...base, binding: { status: "verified", inboundSenderHash: "h1", reasonCode: null }, inboundSenderHash: "h2" }).includes("발신자 불일치"));
  assert.ok(assessReviewProtection({ ...base, primaryCaseId: "settlement_dispute" }).includes("정산 이의"));
});

test("a confirmed real reply excludes the row from this batch; the question stays unresolved and the draft stays reviewable", () => {
  const row = evaluateReviewConversation(facts({ outbound: { rows: [{ kind: "real_reply", sentAtIso: "2026-10-04T05:00:00.000Z", conversationId: "conv-other-123456" }, { kind: "outreach", sentAtIso: "2026-10-04T06:00:00.000Z", conversationId: "campaign-x" }] } }));
  assert.equal(row.sendBatch.reason, "recent_real_reply");
  assert.equal(row.question.status, "unresolved");
  assert.equal(row.realReplies.value, 1, "outreach is not counted as an answer");
  assert.equal(row.realReplies.evidence[0].kind, "real_reply", "real replies are listed first");
  assert.equal(row.realReplies.evidence[0].sameConversation, false);
  assert.equal(row.realReplies.evidence[0].conversationTail, "123456");
  assert.equal(row.draft.status, "system_default");
  assert.equal(row.draft.sendable, false);
});

test("possible or unknown-kind replies and capped lookups are never 'verified' → partial, operator judgment", () => {
  const possible = evaluateReviewConversation(facts({ outbound: { rows: [{ kind: "possible_reply", sentAtIso: "2026-10-04T05:00:00.000Z", conversationId: null }] } }));
  assert.equal(possible.realReplies.status, "partial");
  assert.equal(possible.realReplies.possibleCount, 1);
  assert.notEqual(possible.sendBatch.reason, "recent_real_reply");
  assert.equal(possible.sendBatch.bucket, "operator_judgment");
  const capped = evaluateReviewConversation(facts({ outbound: { status: "partial", reason: "미확인(부분 조회)" } }));
  assert.equal(capped.realReplies.reason, "미확인(부분 조회)");
  assert.equal(capped.sendBatch.bucket, "operator_judgment");
  const queuePartial = evaluateReviewConversation(facts({ queue: { status: "partial", reason: "미확인(부분 조회)" } }));
  assert.equal(queuePartial.sendBatch.bucket, "operator_judgment");
  assert.equal(queuePartial.queued.status, "partial");
});

test("a clean auto_ok case lands in final_safety_wait — still not sendable; classification is labelled automatic", () => {
  const row = evaluateReviewConversation(facts());
  assert.equal(row.sendBatch.bucket, "final_safety_wait");
  assert.equal(row.nextAction, "final_safety_check");
  assert.match(row.question.recommendedHandling, /발송 가능 아님 · 최종 live 확인 필요/);
  assert.equal(row.draft.sendableLabel, "전송 불가(검토 전용)");
  assert.equal(row.draft.suggestedTemplateId, "B");
  assert.equal(row.registration.value, "not_applicable", "scp rows are never shown as 미등록");
  assert.equal(row.classification.label, "자동 추천(원문 규칙)");
  assert.equal(evaluateReviewConversation(facts({ labelSource: "operator" })).classification.label, "운영자 라벨");
});

test("closed / we-replied-last / org-automation-off rows land in 제외 with their own reasons", () => {
  assert.equal(evaluateReviewConversation(facts({ lastMessageFrom: "human" })).sendBatch.reason, "we_replied_last");
  assert.equal(evaluateReviewConversation(facts({ autoReplyStatus: "closed" })).sendBatch.reason, "not_pending");
  const orgOff = evaluateReviewConversation(facts({ orgAutomationOff: true }));
  assert.equal(orgOff.sendBatch.reason, "org_automation_off");
  assert.equal(orgOff.orgAutomationOff, true);
  assert.equal(evaluateReviewConversation(facts({ queue: { liveCount: 1 } })).sendBatch.reason, "queued");
  assert.equal(evaluateReviewConversation(facts({ actorType: "agency_mcn" })).sendBatch.reason, "vendor_or_auto");
  const both = evaluateReviewConversation(facts({ queue: { liveCount: 1 }, suppression: { blocked: true } }));
  assert.deepEqual(both.sendBatch.allReasons, ["queued", "suppressed"]);
});

// ── grouping ────────────────────────────────────────────────────────────────────────────────────

test("grouping merges only verified senders with equal, non-empty From hashes; a protected/AI-off member protects the row", () => {
  const a = evaluateReviewConversation(facts({ conversationId: "conv-a-000001", latestInboundAtIso: "2026-10-04T01:00:00.000Z" }));
  const b = evaluateReviewConversation(facts({ conversationId: "conv-b-000002", latestInboundAtIso: "2026-10-03T01:00:00.000Z", aiActive: false, inbound: { body: null, bodyRead: false } }));
  const noBinding = evaluateReviewConversation(facts({ conversationId: "conv-c-000003", inbound: { binding: null } }));
  const mismatch = evaluateReviewConversation(facts({ conversationId: "conv-d-000004", inbound: { binding: { status: "verified", bindingScope: "program", reasonCode: "verified", inboundSenderHash: "hash-other" } } }));
  const emptyHash = evaluateReviewConversation(facts({ conversationId: "conv-e-000005", inbound: { binding: { status: "verified", bindingScope: "program", reasonCode: "verified", inboundSenderHash: null } } }));
  const rows = groupReviewConversations([a, b, noBinding, mismatch, emptyHash], (hash) => `k-${hash}`);
  assert.equal(rows.length, 4, "a+b merge; no-binding, From-mismatch and empty-hash rows stay single");
  const merged = rows.find((row) => row.conversations.length === 2);
  assert.equal(merged.conversationId, "conv-a-000001", "newest inbound is the representative");
  assert.equal(merged.protected, true);
  assert.ok(merged.protectedReasons.includes("운영자 담당 (AI off)"));
  assert.equal(merged.draft.draftAllowed, false);
  assert.equal(merged.draft.suggestedTemplateId, null);
  assert.equal(merged.summary.value, null);
  assert.notEqual(merged.sendBatch.bucket, "final_safety_wait");
  assert.equal(emptyHash.identity.groupSenderHash, null);
});

// ── callable ────────────────────────────────────────────────────────────────────────────────────

function runProbe(probeBody) {
  const source = `
    const fs = require("node:fs");
    const ts = require("typescript");
    require.extensions[".ts"] = (module, filename) => {
      const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
        fileName: filename,
      }).outputText;
      module._compile(compiled, filename);
    };
    ${probeBody}
  `;
  const result = spawnSync(process.execPath, ["--input-type=commonjs", "--eval", source], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      GCLOUD_PROJECT: "influchat-77db6",
      GOOGLE_CLOUD_PROJECT: "influchat-77db6",
      FIREBASE_CONFIG: JSON.stringify({ projectId: "influchat-77db6" }),
      FLU_RUNTIME_ENV: "production",
      FLU_FIRESTORE_DATABASE: "(default)",
      FLU_FUNCTIONS_CODEBASE: "default",
      FUNCTIONS_EMULATOR: "",
      FIRESTORE_EMULATOR_HOST: "",
      FIREBASE_AUTH_EMULATOR_HOST: "",
    },
  });
  assert.equal(result.status, 0, `probe failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

const PRELUDE = `
  const { listChatAutoReviewBoard, SOURCE_META_FIELDS, SIBLING_META_FIELDS, OUTBOUND_META_FIELDS } = require("./functions/chatAutoReviewBoard.ts");
  const superAdminAccess = { viewerOrgId: null, authorizedMailAccountIds: ["scp"], isSuperAdmin: true, hasScpEntitlement: true };
  const pad = (n) => String(n).padStart(6, "0");
  const mkRow = (n, extra = {}) => ({
    id: "conv-synth-" + pad(n),
    orgId: "T056",
    mailAccountId: "scp",
    autoReplyStatus: "waiting_for_human",
    aiActive: true,
    lastMessageFrom: "creator",
    lastMessageAtIso: "2026-10-04T00:" + String(59 - (n % 60)).padStart(2, "0") + ":00.000Z",
    lastInboundAtIso: "2026-10-04T00:" + String(59 - (n % 60)).padStart(2, "0") + ":00.000Z",
    creatorName: "Synthetic " + n,
    creatorEmail: "synthetic" + n + "@example.test",
    lastMessage: "요지 " + n,
    autoCaseId: "submission_support",
    autoCaseMessageRef: "message_sources/in-" + n,
    lastMessageRef: "message_sources/in-" + n,
    autoCaseIntentLabels: ["submission_help"],
    autoCaseActorType: "creator",
    ...extra,
  });
  const makeScanPage = (dataset, calls) => async ({ cursor, limit }) => {
    calls.push({ cursor, limit });
    const sorted = [...dataset].sort((a, b) => b.lastMessageAtIso.localeCompare(a.lastMessageAtIso) || a.id.localeCompare(b.id));
    const start = cursor ? sorted.findIndex((row) => row.id === cursor.docId) + 1 : 0;
    return sorted.slice(start, start + limit);
  };
  const readers = (log, dataset, overrides = {}) => ({
    readSourceMeta: async (id) => {
      log.push("meta:" + id);
      const n = Number(id.slice(3));
      const row = dataset.find((item) => item.id === "conv-synth-" + pad(n));
      return { conversationId: "conv-synth-" + pad(n), direction: "inbound", receivedAtIso: row ? row.lastInboundAtIso : "", inboundSenderHash: "h" + n, senderIdentityBinding: { status: "verified", inboundSenderHash: "h" + n } };
    },
    findInboundAt: async (conversationId) => { log.push("findInbound:" + conversationId); return []; },
    readSourceBody: async (id) => { log.push("body:" + id); return { body: "How do I submit? SECRET-BODY-MARKER", summaryKr: "제출 문의" }; },
    querySiblings: async (email) => { log.push("siblings"); return []; },
    querySenderConversations: async () => { log.push("sender"); return { rows: [], capped: false }; },
    queryOutbound: async () => { log.push("outbound"); return []; },
    queryQueue: async () => { log.push("queue"); return []; },
    findSuppression: async () => { log.push("suppression"); return { blocked: false }; },
    readReplyState: async () => ({ overrides: new Map(), revisions: new Map() }),
    readDisabledOrgIds: async () => [],
    ...overrides,
  });
  let tick = 0;
  const call = (data, deps = {}, role = "super_admin") => listChatAutoReviewBoard(
    { auth: { uid: "u1", token: { role, team: "platform", email: "operator@example.test" } }, rawRequest: { ip: "127.0.0.1" }, data },
    { now: () => new Date("2026-10-05T00:00:00.000Z"), nowMs: () => (tick += 1), isCallerScpEntitled: async () => true, resolveAccess: async () => ({ scopeKey: "super_admin", access: superAdminAccess }), ...deps },
  );
`;

test("callable wiring: literal isCallerScpEntitled gate, named export with PEOPLY_API_KEY, staging-listed, client wrapper without viewAs", () => {
  const callableSource = readFileSync(new URL("../functions/chatAutoReviewBoard.ts", import.meta.url), "utf8");
  const indexSource = readFileSync(new URL("../functions/index.ts", import.meta.url), "utf8");
  assert.match(callableSource, /: await isCallerScpEntitled\(auth\.email \?\? "", auth\.role === "super_admin", \{ userId: auth\.userId \}\)/);
  assert.match(callableSource, /canCallerReadScpRow\(row, access\)/);
  assert.match(indexSource, /export const listChatAutoReviewBoard = callable\(\s*function listChatAutoReviewBoard\(request\)\s*\{\s*return listChatAutoReviewBoardHandler\(request\);\s*\},\s*\["PEOPLY_API_KEY"\],\s*\{ persistOutcome: false \},\s*\);/);
  const stagingRuntime = readFileSync(new URL("../functions-staging/runtime/index.cjs", import.meta.url), "utf8");
  assert.equal((stagingRuntime.match(/"listChatAutoReviewBoard"/g) ?? []).length, 2);
  const dataSource = readFileSync(new URL("../src/lib/data.ts", import.meta.url), "utf8");
  assert.match(dataSource, /"listChatAutoReviewBoard",/);
  assert.doesNotMatch(dataSource, /listChatAutoReviewBoard[^;]*viewAs/);
});

test("callable sources import no write/send/model path", () => {
  for (const file of ["chatAutoReviewBoard.ts", "chatAutoReviewBoardModel.ts"]) {
    const source = readFileSync(new URL(`../functions/${file}`, import.meta.url), "utf8").replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(source, /\.batch\(\)|runTransaction|callModel|runGatewayLive|\bsendMail\(|sendEmail\(|FieldValue/, file);
  }
});

test("callable performs ZERO Firestore writes with its real default readers (write-spy fake adminDb)", () => {
  const result = runProbe(`
    const Module = require("node:module");
    const originalLoad = Module._load;
    const writes = [];
    const reads = [];
    const dataset = [
      { id: "conv-spy-000001", mailAccountId: "scp", orgId: "T056", aiActive: true, autoReplyStatus: "waiting_for_human", lastMessageFrom: "creator", lastMessageAtIso: "2026-10-04T00:10:00.000Z", lastInboundAtIso: "2026-10-04T00:10:00.000Z", creatorEmail: "spy1@example.test", lastMessageRef: "message_sources/in-1", autoCaseId: "submission_support", autoCaseMessageRef: "message_sources/in-1" },
      { id: "conv-spy-000002", mailAccountId: "scp", orgId: "T056", aiActive: false, autoReplyStatus: "waiting_for_human", lastMessageFrom: "creator", lastMessageAtIso: "2026-10-04T00:09:00.000Z", lastInboundAtIso: "2026-10-04T00:09:00.000Z", creatorEmail: "spy2@example.test", lastMessageRef: "message_sources/in-2" },
    ];
    const snap = (docs) => ({ docs: docs.map((d) => ({ id: d.id, ref: { path: "x/" + d.id }, exists: true, data: () => d, get: (k) => d[k] })), empty: docs.length === 0, size: docs.length, readTime: { seconds: 1, nanoseconds: 0 } });
    const WRITE = new Set(["set", "update", "delete", "create", "add", "commit", "batch", "runTransaction", "bulkWriter", "recursiveDelete"]);
    function query(name) {
      const q = {};
      const chain = new Proxy(q, {
        get(target, prop) {
          if (prop === "then") return undefined;
          if (prop === "get") return async () => { reads.push(name); return name === "conversations" && !q.where ? snap(dataset) : snap([]); };
          if (prop === "doc") return (id) => docRef(name + "/" + id);
          if (WRITE.has(prop)) return (...args) => { writes.push(name + "." + String(prop)); return chain; };
          return (...args) => { if (prop === "where") q.where = true; return chain; };
        },
      });
      return chain;
    }
    function docRef(path) {
      return new Proxy({}, {
        get(target, prop) {
          if (prop === "then") return undefined;
          if (prop === "get") return async () => { reads.push(path); return { exists: false, id: path.split("/").pop(), data: () => undefined, get: () => undefined }; };
          if (prop === "collection") return (name) => query(path + "/" + name);
          if (prop === "path") return path;
          if (WRITE.has(prop)) return (...args) => { writes.push(path + "." + String(prop)); return Promise.resolve(); };
          return () => undefined;
        },
      });
    }
    const fakeDb = new Proxy({}, {
      get(target, prop) {
        if (prop === "collection") return (name) => query(name);
        if (prop === "doc") return (path) => docRef(path);
        if (prop === "getAll") return async (...refs) => refs.map(() => ({ exists: false, data: () => undefined }));
        if (WRITE.has(prop)) return (...args) => { writes.push("db." + String(prop)); return { set() { writes.push("batch.set"); }, update() { writes.push("batch.update"); }, delete() { writes.push("batch.delete"); }, commit: async () => { writes.push("batch.commit"); } }; };
        return () => undefined;
      },
    });
    Module._load = function (request, parent, isMain) {
      const loaded = originalLoad.apply(this, arguments);
      if (request === "./firebaseAdmin") return { ...loaded, adminDb: fakeDb };
      return loaded;
    };
    const { listChatAutoReviewBoard } = require("./functions/chatAutoReviewBoard.ts");
    (async () => {
      const superAdminAccess = { viewerOrgId: null, authorizedMailAccountIds: ["scp"], isSuperAdmin: true, hasScpEntitlement: true };
      const envelope = await listChatAutoReviewBoard(
        { auth: { uid: "u1", token: { role: "super_admin", team: "platform", email: "operator@example.test" } }, rawRequest: { ip: "127.0.0.1" }, data: {} },
        { isCallerScpEntitled: async () => true, resolveAccess: async () => ({ scopeKey: "super_admin", access: superAdminAccess }) },
      );
      process.stdout.write(JSON.stringify({ writes, readCount: reads.length, rows: envelope.counts.conversations }));
    })().catch((error) => { process.stdout.write(JSON.stringify({ error: String(error && error.stack || error), writes })); });
  `);
  assert.equal(result.error, undefined, result.error);
  // No write of any kind with injected entitlement. (The real isCallerScpEntitled may refresh the
  // pre-existing Peoply directory cache — never ops data; asserted separately below.)
  assert.deepEqual(result.writes, []);
  const OPS = /^(conversations|message_sources|auto_reply_queue|chat_auto_case_replies|chat_auto_case_permits|settings|drafts|campaign_outreach|mail_suppressions)/;
  assert.deepEqual(result.writes.filter((entry) => OPS.test(entry)), []);
  assert.ok(result.readCount > 0);
  assert.equal(result.rows, 2);
});

test("metadata projections never include body/text/summary fields", () => {
  const result = runProbe(`${PRELUDE} process.stdout.write(JSON.stringify({ SOURCE_META_FIELDS, SIBLING_META_FIELDS, OUTBOUND_META_FIELDS }));`);
  for (const list of Object.values(result)) {
    for (const field of ["body", "text", "summaryKr", "bodyPreview", "lastMessage"]) assert.ok(!list.includes(field), field);
  }
  assert.ok(!result.SOURCE_META_FIELDS.includes("subject"));
});

test("callable blocks unauthenticated callers, guests, viewAs and non-scp-entitled callers before any read", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const log = [];
      const dataset = [mkRow(1)];
      const attempts = [];
      const deps = { scanPage: makeScanPage(dataset, calls), ...readers(log, dataset) };
      attempts.push(await listChatAutoReviewBoard({ rawRequest: { ip: "127.0.0.1" }, data: {} }, deps).then(() => ({ ok: true }), (e) => ({ code: e.code })));
      attempts.push(await call({}, deps, "guest").then(() => ({ ok: true }), (e) => ({ code: e.code })));
      attempts.push(await call({ viewAsUserId: "someone" }, deps, "super_admin").then(() => ({ ok: true }), (e) => ({ code: e.code, errorCode: e.errorCode })));
      let resolved = 0;
      attempts.push(await call({}, { ...deps, isCallerScpEntitled: async () => false, resolveAccess: async () => { resolved += 1; return { access: superAdminAccess }; } }, "manager").then(() => ({ ok: true }), (e) => ({ code: e.code, errorCode: e.errorCode })));
      process.stdout.write(JSON.stringify({ attempts, scans: calls.length, reads: log.length, resolved }));
    })();
  `);
  assert.equal(result.attempts[0].code, "unauthenticated");
  assert.equal(result.attempts[1].code, "permission-denied");
  assert.equal(result.attempts[2].errorCode, "chat_auto_review_board_view_as_unsupported");
  assert.equal(result.attempts[3].errorCode, "chat_auto_review_board_scp_entitlement_required");
  assert.equal(result.scans, 0);
  assert.equal(result.reads, 0);
  assert.equal(result.resolved, 0);
});

test("ZERO body reads for AI-off, every protected category, and any address with an AI-off/protected sibling", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const log = [];
      const dataset = [
        mkRow(1, { aiActive: false }),
        mkRow(2, { autoCaseId: "settlement_dispute", autoCaseMessageRef: "message_sources/in-2" }),
        mkRow(3, { autoCaseId: "opt_out_or_legal", autoCaseMessageRef: "message_sources/in-3" }),
        mkRow(4, { autoCaseId: "access_concern", autoCaseMessageRef: "message_sources/in-4" }),
        mkRow(5, { autoReplyBlockedReason: "privacy / GDPR deletion request" }),
        mkRow(6, { autoReplyBlockedReason: "rejection appeal" }),
        mkRow(7, { autoCaseIntentLabels: ["complaint"] }),
        mkRow(8),
        mkRow(9),
        mkRow(10),
      ];
      const deps = readers(log, dataset, {
        findSuppression: async ({ email }) => { log.push("suppression"); return { blocked: email === "synthetic8@example.test" }; },
        readSourceMeta: async (id) => {
          log.push("meta:" + id);
          const n = Number(id.slice(3));
          const row = dataset.find((item) => item.id === "conv-synth-" + pad(n));
          const binding = n === 9 ? { status: "review_required", reasonCode: "sender_not_creator", inboundSenderHash: "h9" } : { status: "verified", inboundSenderHash: "h" + n };
          return { conversationId: row.id, direction: "inbound", receivedAtIso: row.lastInboundAtIso, inboundSenderHash: "h" + n, senderIdentityBinding: binding };
        },
        querySiblings: async (email) => { log.push("siblings"); return email === "synthetic10@example.test" ? [{ id: "conv-sibling-aioff", aiActive: false }] : []; },
      });
      const envelope = await call({ limit: 50 }, { scanPage: makeScanPage(dataset, calls), ...deps });
      process.stdout.write(JSON.stringify({ bodyReads: log.filter((entry) => entry.startsWith("body:")), protectedCount: envelope.counts.protectedConversations, json: JSON.stringify(envelope) }));
    })();
  `);
  assert.deepEqual(result.bodyReads, []);
  assert.equal(result.protectedCount, 10);
  assert.doesNotMatch(result.json, /SECRET-BODY-MARKER/);
});

test("a lastMessageRef that points at OUR outbound is never read as the creator's question", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const log = [];
      const dataset = [mkRow(1, { lastMessageFrom: "human", lastMessageRef: "message_sources/out-1", lastMessageAtIso: "2026-10-04T02:00:00.000Z" })];
      const deps = readers(log, dataset, {
        readSourceMeta: async (id) => { log.push("meta:" + id); return { conversationId: "conv-synth-000001", direction: "outbound", receivedAtIso: "" }; },
      });
      const envelope = await call({}, { scanPage: makeScanPage(dataset, calls), ...deps });
      process.stdout.write(JSON.stringify({ log, row: envelope.rows[0] }));
    })();
  `);
  assert.ok(result.log.some((entry) => entry.startsWith("findInbound:")), "falls back to the metadata inbound lookup");
  assert.ok(!result.log.some((entry) => entry.startsWith("body:")), "no body read without a confirmed inbound");
  assert.equal(result.row.question.questionCount, null);
  assert.equal(result.row.sendBatch.reason, "we_replied_last");
  assert.equal(result.row.summary.value, null);
});

test("callable payload: no body, no full address, no address hash; out-of-scope org rows dropped; rows without inbound skipped", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const log = [];
      const orgAccess = { viewerOrgId: "T056", authorizedMailAccountIds: ["scp"], isSuperAdmin: false, hasScpEntitlement: true };
      const dataset = [mkRow(1), mkRow(2, { orgId: "T046" }), mkRow(3, { lastInboundAtIso: "" }), mkRow(4, { autoReplyStatus: "closed" })];
      const envelope = await call({}, { scanPage: makeScanPage(dataset, calls), ...readers(log, dataset), resolveAccess: async () => ({ scopeKey: "org:T056", access: orgAccess }) }, "manager");
      process.stdout.write(JSON.stringify({ envelope, json: JSON.stringify(envelope) }));
    })();
  `);
  const { envelope, json } = result;
  assert.doesNotMatch(json, /SECRET-BODY-MARKER/);
  assert.doesNotMatch(json, /synthetic\d+@example\.test/);
  assert.doesNotMatch(json, /"groupSenderHash":"h/);
  const ids = envelope.rows.flatMap((row) => row.conversations.map((item) => item.conversationId)).sort();
  assert.deepEqual(ids, ["conv-synth-000001", "conv-synth-000004"]);
  assert.equal(envelope.rows.find((row) => row.conversationId === "conv-synth-000004").sendBatch.reason, "not_pending");
  assert.equal(envelope.exhausted, true);
  for (const row of envelope.rows) assert.equal(row.draft.sendable, false);
});

test("callable is bounded: limit clamps to 50 and a cut-short call returns a resumable cursor", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const log = [];
      const dataset = Array.from({ length: 30 }, (_, i) => mkRow(i + 1));
      const deps = () => ({ scanPage: makeScanPage(dataset, calls), ...readers(log, dataset) });
      const first = await call({ limit: 10 }, deps());
      const second = await call({ limit: 10, cursor: first.nextCursor }, deps());
      const big = await call({ limit: 500 }, deps());
      const ids = (env) => env.rows.flatMap((row) => row.conversations.map((item) => item.conversationId));
      process.stdout.write(JSON.stringify({ first: first.counts.conversations, firstExhausted: first.exhausted, hasCursor: Boolean(first.nextCursor), overlap: ids(first).filter((id) => ids(second).includes(id)).length, second: second.counts.conversations, big: big.counts.conversations, bigExhausted: big.exhausted }));
    })();
  `);
  assert.equal(result.first, 10);
  assert.equal(result.firstExhausted, false);
  assert.equal(result.hasCursor, true);
  assert.equal(result.overlap, 0);
  assert.equal(result.second, 10);
  assert.equal(result.big, 30);
  assert.equal(result.bigExhausted, true);
});

test("scope: a same-address conversation in another org (AI off / queued / real reply) never affects the caller's row", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const log = [];
      const orgAccess = { viewerOrgId: "T056", authorizedMailAccountIds: ["scp"], isSuperAdmin: false, hasScpEntitlement: true };
      const dataset = [mkRow(1)];
      const deps = readers(log, dataset, {
        querySiblings: async () => [{ id: "conv-foreign-aaaaaa", aiActive: false, mailAccountId: "scp", orgId: "T046", autoCaseId: "settlement_dispute" }],
        queryQueue: async (ids) => { log.push("queue:" + ids.join(",")); return ids.includes("conv-foreign-aaaaaa") ? [{ status: "scheduled", conversationId: "conv-foreign-aaaaaa" }] : []; },
        queryOutbound: async () => [
          { direction: "outbound", source: "sendEmail", sendMailAccountId: "scp", deliveryState: "sent", replyToMessageRef: "message_sources/x", conversationId: "conv-foreign-aaaaaa", sentAtIso: "2026-10-04T03:00:00.000Z" },
          { direction: "outbound", source: "sendEmail", sendMailAccountId: "scp", deliveryState: "sent", replyToMessageRef: "message_sources/y", conversationId: "conv-other-account", sentAtIso: "2026-10-04T04:00:00.000Z" },
        ],
      });
      const envelope = await call({}, { scanPage: makeScanPage(dataset, calls), ...deps, resolveAccess: async () => ({ scopeKey: "org:T056", access: orgAccess }) }, "manager");
      process.stdout.write(JSON.stringify({ row: envelope.rows[0], counts: envelope.counts, log, json: JSON.stringify(envelope) }));
    })();
  `);
  const { row, counts, log, json } = result;
  assert.equal(row.protected, false, "a foreign sibling's AI off / settlement case is not used");
  assert.equal(row.realReplies.value, 0, "foreign and other-account outbound are not counted");
  assert.equal(row.realReplies.status, "partial");
  assert.equal(row.realReplies.reason, "권한 밖 데이터 존재 가능");
  assert.equal(row.queued.value, false);
  assert.equal(row.queued.status, "partial");
  assert.equal(row.queued.reason, "권한 밖 데이터 존재 가능");
  assert.ok(!log.some((entry) => entry.startsWith("queue:") && entry.includes("conv-foreign-aaaaaa")), "foreign conversation never queried");
  assert.equal(counts.protectedConversations, 0);
  assert.doesNotMatch(json, /aaaaaa|other-account/);
  assert.ok(log.some((entry) => entry.startsWith("body:")), "the caller's own unprotected row is still readable");
});

test("scenario: 'already applied' + review-status ask repeated on a new thread after a general outreach", () => {
  const verified = { binding: { status: "verified", bindingScope: "identity_only", reasonCode: "verified", inboundSenderHash: "hash-same" }, inboundSenderHash: "hash-same" };
  const outreachAfterFirst = { kind: "outreach", sentAtIso: "2026-10-02T00:00:00.000Z", conversationId: "campaign-general-1" };
  const first = evaluateReviewConversation(facts({
    conversationId: "conv-thread-old001",
    latestInboundAtIso: "2026-10-01T00:00:00.000Z",
    primaryCaseId: "approval_status_inquiry",
    intentLabels: ["approval_status"],
    inbound: { ...verified, body: "I already applied. Is my review complete? Do you need more documents?" },
    outbound: { rows: [outreachAfterFirst] },
  }));
  const latest = evaluateReviewConversation(facts({
    conversationId: "conv-thread-new002",
    latestInboundAtIso: "2026-10-05T00:00:00.000Z",
    primaryCaseId: "approval_status_inquiry",
    intentLabels: ["approval_status"],
    caseStampStale: true,
    inbound: { ...verified, body: "Hi, I applied already. Has my review been completed?" },
    outbound: { rows: [outreachAfterFirst] },
  }));
  const rows = groupReviewConversations([first, latest], (hash) => `k-${hash}`);
  assert.equal(rows.length, 1, "verified same From → one person row");
  const row = rows[0];
  assert.deepEqual(row.conversations.map((item) => item.conversationId), ["conv-thread-new002", "conv-thread-old001"], "latest thread first, original thread kept");
  assert.equal(row.conversationId, "conv-thread-new002");
  assert.equal(row.realReplies.value, 0, "outreach is not a real reply");
  assert.notEqual(row.sendBatch.reason, "recent_real_reply");
  assert.equal(row.question.status, "unresolved");
  assert.ok(row.claims.includes("지원 완료 주장 · 상대 주장(미확인)"));
  assert.equal(row.newInboundSinceJudgment, true);
  assert.equal(row.nextAction, "personal_review_status_check");
  assert.equal(row.nextActionLabel, "개인 심사 상태 확인(운영자)");
  assert.equal(row.sendBatch.bucket, "operator_judgment");
  assert.notEqual(row.draft.suggestedTemplateId, "A", "never invite someone who claims to have applied to apply");
  assert.equal(row.draft.suggestedTemplateId, null, "F is reference only, not preselected");
});

test("scope (super_admin): a personal-mailbox send to the same address is not SCP evidence; scope-less imports stay unknown", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const log = [];
      const dataset = [mkRow(1)];
      const deps = readers(log, dataset, {
        queryOutbound: async () => [
          { direction: "outbound", source: "sendEmail", sendMailAccountId: "personal-acct", deliveryState: "sent", replyToMessageRef: "message_sources/p", conversationId: "conv-personal-1", sentAtIso: "2026-10-04T03:00:00.000Z" },
        ],
      });
      const personalOnly = await call({}, { scanPage: makeScanPage(dataset, calls), ...deps });
      const deps2 = readers(log, dataset, {
        queryOutbound: async () => [
          { direction: "outbound", source: "external_sent_mail_import", deliveryState: "sent", kind: "manual_reply", sentAtIso: "2026-10-04T03:00:00.000Z" },
        ],
      });
      const scopeless = await call({}, { scanPage: makeScanPage(dataset, calls), ...deps2 });
      process.stdout.write(JSON.stringify({ a: personalOnly.rows[0].realReplies, aBatch: personalOnly.rows[0].sendBatch, b: scopeless.rows[0].realReplies }));
    })();
  `);
  assert.equal(result.a.value, 0);
  assert.equal(result.a.status, "confirmed", "another mailbox is simply out of the SCP board's scope");
  assert.notEqual(result.aBatch.reason, "recent_real_reply");
  assert.equal(result.b.value, 0);
  assert.equal(result.b.status, "partial");
  assert.equal(result.b.reason, "범위 근거 없는 발송 있음(미확인)");
});

test("codex round 1 regressions: sign-off stripping needs a sign-off, fixed fee needs a whole-message offer", () => {
  assert.equal(classifyShortInbound("Thanks\nSend Contract"), "other");
  const thanksSend = evaluateReviewConversation(facts({ primaryCaseId: "closing_acknowledgment", intentLabels: ["closing"], ...body("Thanks\nSend Contract") }));
  assert.equal(thanksSend.question.status, "unresolved");
  assert.equal(thanksSend.sendBatch.bucket, "operator_judgment");
  assert.equal(isFixedFeeOfferOnly("My fixed fee is 300 USD. Explain the rejection."), false);
  const feeReject = evaluateReviewConversation(facts({ primaryCaseId: "fixed_terms_inquiry", intentLabels: ["custom_terms_proposal"], ...body("My fixed fee is 300 USD. Explain the rejection.") }));
  assert.notEqual(feeReject.sendBatch.reason, "fixed_fee_proposal_only");
  assert.equal(feeReject.sendBatch.bucket, "operator_judgment");
  assert.equal(feeReject.question.status, "unresolved");
  assert.equal(isFixedFeeOfferOnly("Hi! We offer a sponsored video at a flat fee of 300 USD per video. Thanks!"), true);
});

test("summaries are redacted (addresses, phone numbers, handles) before leaving the server; single-conversation row keys are opaque", () => {
  const row = evaluateReviewConversation(facts({ inbound: { summaryKr: "연락처 someone@example.test, +82 10-1234-5678, @handle123 로 문의" } }));
  assert.doesNotMatch(row.summary.value, /someone@example\.test|1234-5678|@handle123/);
  assert.match(row.summary.value, /\[이메일\]/);
  const rows = groupReviewConversations([evaluateReviewConversation(facts({ inbound: { binding: null } }))], (value) => `k${value.length}`);
  assert.doesNotMatch(rows[0].rowKey, /conv-synthetic/);
});

test("scan projection carries metadata only; a sibling's humanGate privacy reason protects the address (zero body reads)", () => {
  const result = runProbe(`
    ${PRELUDE}
    const { SCAN_FIELDS } = require("./functions/chatAutoReviewBoard.ts");
    (async () => {
      const calls = [];
      const log = [];
      const dataset = [mkRow(1)];
      const deps = readers(log, dataset, {
        querySiblings: async () => [{ id: "conv-synth-sibling", mailAccountId: "scp", orgId: "T056", aiActive: true, humanGate: { reason: "privacy / data deletion request" } }],
      });
      const envelope = await call({}, { scanPage: makeScanPage(dataset, calls), ...deps });
      process.stdout.write(JSON.stringify({ SCAN_FIELDS, protectedReasons: envelope.rows[0].protectedReasons, bodyReads: log.filter((entry) => entry.startsWith("body:")), summary: envelope.rows[0].summary.value }));
    })();
  `);
  for (const field of ["messages", "lastMessage", "body", "text", "summaryKr", "bodyPreview", "autoReplyDraftText"]) assert.ok(!result.SCAN_FIELDS.includes(field), field);
  assert.ok(result.protectedReasons.includes("개인정보·삭제 요청"));
  assert.deepEqual(result.bodyReads, []);
  assert.equal(result.summary, null);
});

test("codex round 2: a verified-sender conversation under a DIFFERENT stored email protects the group before any body read; unregistered siblings are ignored", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const log = [];
      const dataset = [mkRow(1)];
      const deps = readers(log, dataset, {
        querySenderConversations: async (hash) => { log.push("sender:" + hash); return { rows: [{ id: "conv-synth-other-email", mailAccountId: "scp", orgId: "T056", aiActive: false }], capped: false }; },
      });
      const protectedRun = await call({}, { scanPage: makeScanPage(dataset, calls), ...deps });
      const log2 = [];
      const deps2 = readers(log2, dataset, {
        querySiblings: async () => [{ id: "conv-synth-unregistered", mailAccountId: "scp", orgId: "T056", aiActive: false, counterpartyRegistered: false }],
      });
      const unregisteredRun = await call({}, { scanPage: makeScanPage(dataset, calls), ...deps2 }, "manager");
      process.stdout.write(JSON.stringify({
        reasons: protectedRun.rows[0].protectedReasons,
        bodyReads: log.filter((entry) => entry.startsWith("body:")),
        senderLookups: log.filter((entry) => entry.startsWith("sender:")),
        unregisteredReasons: unregisteredRun.rows[0].protectedReasons,
        unregisteredQueue: unregisteredRun.rows[0].queued,
      }));
    })();
  `);
  assert.deepEqual(result.senderLookups, ["sender:h1"]);
  assert.ok(result.reasons.includes("같은 주소의 다른 대화 AI off"));
  assert.deepEqual(result.bodyReads, []);
  assert.deepEqual(result.unregisteredReasons, [], "an unregistered sibling hidden from the caller contributes nothing");
  assert.equal(result.unregisteredQueue.reason, "권한 밖 데이터 존재 가능");
});

test("codex round 3: sibling suppression protects before body reads; the pagination cursor is sealed (no readable ids/timestamps)", () => {
  const result = runProbe(`
    ${PRELUDE}
    const { sealReviewBoardCursor, openReviewBoardCursor } = require("./functions/chatAutoReviewBoard.ts");
    (async () => {
      const calls = [];
      const log = [];
      const dataset = [mkRow(1)];
      const deps = readers(log, dataset, {
        querySenderConversations: async () => ({ rows: [{ id: "conv-synth-alias", mailAccountId: "scp", orgId: "T056", aiActive: true, creatorEmail: "alias-address@example.test" }], capped: false }),
        findSuppression: async ({ email }) => { log.push("suppression:" + (email ?? "")); return { blocked: email === "alias-address@example.test" }; },
      });
      const envelope = await call({}, { scanPage: makeScanPage(dataset, calls), ...deps });
      const sealed = sealReviewBoardCursor({ docId: "conv-out-of-scope-secret", orderValue: "2026-10-04T00:00:00.000Z" });
      process.stdout.write(JSON.stringify({
        reasons: envelope.rows[0].protectedReasons,
        bodyReads: log.filter((entry) => entry.startsWith("body:")),
        sealedPlain: Buffer.from(sealed, "base64url").toString("latin1"),
        reopened: openReviewBoardCursor(sealed),
        tampered: openReviewBoardCursor(sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA")),
        legacy: openReviewBoardCursor(Buffer.from(JSON.stringify({ docId: "x", orderValue: "y" })).toString("base64url")),
        hasScanned: Object.prototype.hasOwnProperty.call(envelope, "scanned"),
      }));
    })();
  `);
  assert.ok(result.reasons.includes("수신 억제"));
  assert.deepEqual(result.bodyReads, []);
  assert.doesNotMatch(result.sealedPlain, /conv-out-of-scope-secret|2026-10-04/);
  assert.deepEqual(result.reopened, { docId: "conv-out-of-scope-secret", orderValue: "2026-10-04T00:00:00.000Z" });
  assert.equal(result.tampered, null);
  assert.equal(result.legacy, null, "a readable base64 JSON cursor is not accepted");
  assert.equal(result.hasScanned, false, "no global scan count in the payload");
});

test("codex round 4: a failed own-address suppression lookup fails closed (no body read); every sibling identity is suppression-checked", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const log = [];
      const dataset = [mkRow(1)];
      const failing = await call({}, { scanPage: makeScanPage(dataset, calls), ...readers(log, dataset, { findSuppression: async () => { throw new Error("lookup down"); } }) });
      const log2 = [];
      const many = Array.from({ length: 10 }, (_, i) => ({ id: "conv-synth-alias-" + i, mailAccountId: "scp", orgId: "T056", aiActive: true, creatorEmail: "alias" + i + "@example.test" }));
      const many2 = Array.from({ length: 9 }, (_, i) => ({ id: "conv-synth-sender-" + i, mailAccountId: "scp", orgId: "T056", aiActive: true, creatorEmail: "sender" + i + "@example.test" }));
      const checked = [];
      const deps2 = readers(log2, dataset, {
        querySiblings: async () => many.slice(0, 9),
        querySenderConversations: async () => ({ rows: many2, capped: false }),
        findSuppression: async ({ email }) => { checked.push(email); return { blocked: email === "sender8@example.test" }; },
      });
      const overflow = await call({}, { scanPage: makeScanPage(dataset, calls), ...deps2 });
      process.stdout.write(JSON.stringify({
        failingReasons: failing.rows[0].protectedReasons,
        failingBody: log.filter((entry) => entry.startsWith("body:")),
        checkedLast: checked.includes("sender8@example.test"),
        overflowReasons: overflow.rows[0].protectedReasons,
        overflowBody: log2.filter((entry) => entry.startsWith("body:")),
      }));
    })();
  `);
  assert.ok(result.failingReasons.includes("수신 억제 확인 불가"));
  assert.deepEqual(result.failingBody, []);
  assert.equal(result.checkedLast, true, "the 18th identity is still checked");
  assert.ok(result.overflowReasons.includes("수신 억제"));
  assert.deepEqual(result.overflowBody, []);
});

test("codex round 5: a sibling whose latest inbound is sender-mismatched protects the address before body reads; email-shaped names are redacted", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const log = [];
      const dataset = [mkRow(1, { creatorName: "someone.private@example.test" })];
      const base = readers(log, dataset);
      const deps = {
        ...base,
        querySiblings: async () => [{ id: "conv-synth-sib", mailAccountId: "scp", orgId: "T056", aiActive: true, lastMessageRef: "message_sources/sib-1", lastInboundAtIso: "x" }],
        readSourceMeta: async (id) => id === "sib-1"
          ? { conversationId: "conv-synth-sib", direction: "inbound", receivedAtIso: "x", inboundSenderHash: "hs", senderIdentityBinding: { status: "review_required", reasonCode: "sender_not_creator", inboundSenderHash: "hs" } }
          : base.readSourceMeta(id),
      };
      const envelope = await call({}, { scanPage: makeScanPage(dataset, calls), ...deps });
      process.stdout.write(JSON.stringify({ reasons: envelope.rows[0].protectedReasons, bodyReads: log.filter((entry) => entry.startsWith("body:")), name: envelope.rows[0].creatorName }));
    })();
  `);
  assert.ok(result.reasons.includes("발신자 불일치"));
  assert.deepEqual(result.bodyReads, []);
  assert.doesNotMatch(result.name, /someone\.private@example\.test/);
});

test("named synthetic regressions: CPM/minimum-videos questions and a short clarification ask stay with the operator", () => {
  for (const [text, questions] of [["What is actual View Rewards CPM? Is there minimum number of videos?", 2], ["wthat do you mean?", 1]]) {
    assert.equal(classifyShortInbound(text), "other", text);
    assert.equal(isFixedFeeOfferOnly(text), false, text);
    const row = evaluateReviewConversation(facts({ primaryCaseId: "confusion_or_short", intentLabels: [], ...body(text) }));
    assert.equal(row.question.questionCount, questions, text);
    assert.equal(row.sendBatch.bucket, "operator_judgment", text);
    assert.equal(row.question.status, "unresolved", text);
    assert.equal(row.draft.suggestedTemplateId, null, text);
  }
});

test("codex round 6: a sibling whose lastMessageRef is OUR outbound is checked via its located latest inbound; unlocatable → fail closed", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const dataset = [mkRow(1)];
      const run = async (findInboundAt) => {
        const log = [];
        const base = readers(log, dataset);
        const envelope = await call({}, { scanPage: makeScanPage(dataset, calls), ...base,
          querySiblings: async () => [{ id: "conv-synth-sib2", mailAccountId: "scp", orgId: "T056", aiActive: true, lastMessageRef: "message_sources/sib-out", lastInboundAtIso: "2026-10-03T00:00:00.000Z" }],
          readSourceMeta: async (id) => id === "sib-out" ? { conversationId: "conv-synth-sib2", direction: "outbound" } : base.readSourceMeta(id),
          findInboundAt: async (conversationId, at) => findInboundAt(conversationId, at),
        });
        return { reasons: envelope.rows[0].protectedReasons, bodyReads: log.filter((entry) => entry.startsWith("body:")) };
      };
      const located = await run(async (conversationId, at) => conversationId === "conv-synth-sib2"
        ? [{ id: "sib-in", data: { conversationId, direction: "inbound", receivedAtIso: at, inboundSenderHash: "hx", senderIdentityBinding: { status: "review_required", reasonCode: "sender_not_creator", inboundSenderHash: "hx" } } }]
        : []);
      const missing = await run(async () => []);
      process.stdout.write(JSON.stringify({ located, missing }));
    })();
  `);
  assert.ok(result.located.reasons.includes("발신자 불일치"));
  assert.deepEqual(result.located.bodyReads, []);
  assert.ok(result.missing.reasons.includes("같은 주소 대화 확인 불가"));
  assert.deepEqual(result.missing.bodyReads, []);
});

test("codex round 7: an unreadable org automation policy is never 'enabled' — row stays with the operator", () => {
  const row = evaluateReviewConversation(facts({ orgPolicyKnown: false }));
  assert.notEqual(row.sendBatch.bucket, "final_safety_wait");
  assert.ok(row.unknowns.some((line) => line.includes("조직 자동화 설정")));
  assert.equal(evaluateReviewConversation(facts({ orgPolicyKnown: true })).sendBatch.bucket, "final_safety_wait");
});

test("codex round 8: a protected case stamped on the latest inbound still protects after we replied (stale stamp), own row and sibling", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const run = async (dataset, siblings) => {
        const log = [];
        const base = readers(log, dataset);
        const envelope = await call({}, { scanPage: makeScanPage(dataset, calls), ...base,
          querySiblings: async () => siblings,
          readSourceMeta: async (id) => id.startsWith("out-") ? { conversationId: "conv-synth-000001", direction: "outbound" } : base.readSourceMeta(id),
          findInboundAt: async (conversationId, at) => [{ id: "in-1", data: { conversationId, direction: "inbound", receivedAtIso: at, inboundSenderHash: "h1", senderIdentityBinding: { status: "verified", inboundSenderHash: "h1" } } }],
        });
        return { reasons: envelope.rows[0].protectedReasons, summary: envelope.rows[0].summary.value, bodyReads: log.filter((entry) => entry.startsWith("body:")) };
      };
      const own = await run([mkRow(1, { autoCaseId: "settlement_dispute", autoCaseMessageRef: "message_sources/in-1", lastMessageRef: "message_sources/out-1", lastMessageFrom: "human" })], []);
      const sib = await run([mkRow(1)], [{ id: "conv-synth-sib3", mailAccountId: "scp", orgId: "T056", aiActive: true, autoCaseId: "settlement_dispute", autoCaseMessageRef: "message_sources/sib-in", lastMessageRef: "message_sources/sib-out" }]);
      process.stdout.write(JSON.stringify({ own, sib }));
    })();
  `);
  assert.ok(result.own.reasons.includes("정산 이의"));
  assert.deepEqual(result.own.bodyReads, []);
  assert.equal(result.own.summary, null);
  assert.ok(result.sib.reasons.includes("정산 이의"));
  assert.deepEqual(result.sib.bodyReads, []);
});

test("protection invariant: outreach, a real reply, a system notification or a reload never clear AI off / humanGate / unverified binding / protected stamps", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const dataset = [
        mkRow(1, { aiActive: false }),
        mkRow(2, { humanGate: { decision: "needs_review", reason: "rejection appeal" } }),
        mkRow(3, { autoCaseId: "settlement_dispute", autoCaseMessageRef: "message_sources/in-3" }),
        mkRow(4),
      ];
      const outbound = [
        { direction: "outbound", campaignId: "cp", targetId: "t", conversationId: "campaign-x", sendMailAccountId: "scp", deliveryState: "sent", sentAtIso: "2026-10-04T05:00:00.000Z" },
        { direction: "outbound", source: "sendEmail", sendMailAccountId: "scp", deliveryState: "sent", replyToMessageRef: "message_sources/in", conversationId: "conv-synth-000001", sentAtIso: "2026-10-04T06:00:00.000Z" },
        { direction: "outbound", source: "external_sent_mail_import", mailType: "uid_guide", sendMailAccountId: "scp", deliveryState: "sent", subject: "UID guide", sentAtIso: "2026-10-04T07:00:00.000Z" },
      ];
      const runs = [];
      for (let reload = 0; reload < 2; reload += 1) {
        const log = [];
        const base = readers(log, dataset);
        const envelope = await call({}, { scanPage: makeScanPage(dataset, calls), ...base,
          queryOutbound: async () => outbound,
          readSourceMeta: async (id) => {
            const meta = await base.readSourceMeta(id);
            return id === "in-4" ? { ...meta, senderIdentityBinding: { status: "review_required", reasonCode: "sender_not_creator", inboundSenderHash: "h4" } } : meta;
          },
        });
        runs.push({ protectedCount: envelope.counts.protectedConversations, bodyReads: log.filter((entry) => entry.startsWith("body:")).length, drafts: envelope.rows.filter((row) => row.draft.draftAllowed).length });
      }
      process.stdout.write(JSON.stringify(runs));
    })();
  `);
  for (const run of result) {
    assert.equal(run.protectedCount, 4);
    assert.equal(run.bodyReads, 0);
    assert.equal(run.drafts, 0);
  }
});

test("codex round 10: request constructions are never closings; redaction happens before truncation", () => {
  for (const text of ["Will you help", "Will you reply", "Can you send it", "please"]) assert.equal(classifyShortInbound(text), "other", text);
  for (const text of ["Thanks for your help!", "Will do, thanks", "Thank you for your reply"]) assert.equal(classifyShortInbound(text), "closing", text);
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const log = [];
      const prefix = "가".repeat(190);
      const dataset = [mkRow(1, { creatorName: "n".repeat(190) + " secret@example.test" })];
      const base = readers(log, dataset);
      const envelope = await call({}, { scanPage: makeScanPage(dataset, calls), ...base,
        readSourceBody: async () => ({ body: "How do I submit my video for the program please explain the steps in detail?", summaryKr: prefix + " secret@example.test" }),
      });
      process.stdout.write(JSON.stringify({ name: envelope.rows[0].creatorName, summary: envelope.rows[0].summary.value }));
    })();
  `);
  assert.doesNotMatch(result.name, /secret|@exa/);
  assert.doesNotMatch(result.summary ?? "", /secret|@exa/);
});

test("request phrasing with or without '?' stays unresolved with the operator, even under a closing label", () => {
  for (const text of ["Will you help", "Will you help?", "Would you reply", "Can you send the guide", "Could you tell me more", "Let me know the next step"]) {
    const row = evaluateReviewConversation(facts({ primaryCaseId: "closing_acknowledgment", intentLabels: ["closing"], ...body(text) }));
    assert.notEqual(row.sendBatch.reason, "closing_or_no_question", text);
    assert.equal(row.sendBatch.bucket, "operator_judgment", text);
    assert.equal(row.question.status, "unresolved", text);
  }
});

test("codex round 11: request phrasing defeats fixed-fee-only; punctuation-prefixed handles are redacted", () => {
  assert.equal(isFixedFeeOfferOnly("Thanks. Would you reply with your rate."), false);
  const row = evaluateReviewConversation(facts({ primaryCaseId: "fixed_terms_inquiry", intentLabels: ["custom_terms_proposal"], ...body("Thanks. Would you reply with your rate.") }));
  assert.notEqual(row.sendBatch.bucket, "excluded");
  assert.equal(row.question.status, "unresolved");
  const redacted = evaluateReviewConversation(facts({ inbound: { summaryKr: "Contact:@private_handle or (@other.handle)" } })).summary.value;
  assert.doesNotMatch(redacted, /private_handle|other\.handle/);
});

test("shared request/question guard and handle redaction at punctuation boundaries (summary and name)", () => {
  assert.equal(model.hasRequestOrQuestion("Thanks. Would you reply with your rate."), true);
  assert.equal(classifyShortInbound("Thanks. Would you reply with your rate."), "other");
  assert.equal(isFixedFeeOfferOnly("Thanks. Would you reply with your rate."), false);
  const summary = evaluateReviewConversation(facts({ inbound: { summaryKr: "Contact:@aa_handle (@bb.handle) @cc_handle, @dd_handle." } })).summary.value;
  assert.doesNotMatch(summary, /aa_handle|bb\.handle|cc_handle|dd_handle/);
  assert.equal(model.redactSummary("Name @ee_handle.").includes("ee_handle"), false);
});

test("codex round 12: imperative requests defeat fixed-fee-only; provenance compares the RAW summary (redaction only for display)", () => {
  assert.equal(isFixedFeeOfferOnly("My fixed fee is $100, reply with your decision."), false);
  assert.equal(isFixedFeeOfferOnly("We offer a sponsored video at a flat fee of 300 USD per video."), true);
  const longSame = "Submission instructions ".repeat(12).trim();
  const row = evaluateReviewConversation(facts({ inbound: { body: longSame, summaryKr: longSame.slice(0, 200), summaryRaw: longSame } }));
  assert.equal(row.summary.source, "summary_fallback");
  assert.notEqual(row.sendBatch.bucket, "final_safety_wait");
});

test("imperative requests after punctuation are requests; a long body identical to the stored summary is 요약본 end-to-end", () => {
  for (const text of ["My fixed fee is 100, reply with your decision.", "Our rate is 200 USD. Let us know.", "Confirm the deal."]) {
    assert.equal(model.hasRequestOrQuestion(text), true, text);
    assert.equal(isFixedFeeOfferOnly(text), false, text);
  }
  assert.equal(model.hasRequestOrQuestion("Thanks for your reply"), false, "a noun 'reply' mid-sentence is not an imperative");
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const log = [];
      const same = "Submission instructions ".repeat(12).trim();
      const dataset = [mkRow(1)];
      const envelope = await call({}, { scanPage: makeScanPage(dataset, calls), ...readers(log, dataset, { readSourceBody: async () => ({ body: same, summaryKr: same }) }) });
      process.stdout.write(JSON.stringify({ source: envelope.rows[0].summary.source, bucket: envelope.rows[0].sendBatch.bucket, reason: envelope.rows[0].sendBatch.reason }));
    })();
  `);
  assert.equal(result.source, "summary_fallback");
  assert.equal(result.bucket, "operator_judgment");
  assert.notEqual(result.reason, "closing_or_no_question");
});

test("codex round 13: an imperative offer request is not a fixed-fee statement", () => {
  for (const text of ["Offer me the standard rate.", "Offer me $100 per video.", "Pay 300 USD per video."]) {
    assert.equal(isFixedFeeOfferOnly(text), false, text);
    const row = evaluateReviewConversation(facts({ primaryCaseId: "fixed_terms_inquiry", intentLabels: ["custom_terms_proposal"], ...body(text) }));
    assert.notEqual(row.sendBatch.reason, "fixed_fee_proposal_only", text);
    assert.equal(row.sendBatch.bucket, "operator_judgment", text);
  }
  for (const text of ["We offer a sponsored video at a flat fee of 300 USD per video.", "My fixed fee is 300 USD per video.", "Our rate is $500 for a dedicated video."]) {
    assert.equal(isFixedFeeOfferOnly(text), true, text);
  }
});

test("fixed-fee-only conservative proof: table of accepted pure statements vs everything else", () => {
  const accepted = [
    "We offer a sponsored video at a flat fee of 300 USD per video.",
    "My fixed fee is 300 USD per video.",
    "Our rate is $500 for a dedicated video.",
    "Hi!\nMy rate is 200 USD per video.\nBest regards,",
    "My fixed fee is 100 USD.\nBest regards,",
    "I charge $150 per post.",
    "$300 per video.",
  ];
  const rejected = [
    "Hi offer me standard rate on my channel",
    "We would like our standard rate.",
    "My fixed fee is 100, reply with your decision",
    "Thanks. Would you reply with your rate.",
    "My fixed fee is 300 USD. Explain the rejection.",
    "Offer me $100 per video.",
    "Offer me the standard rate.",
    "Pay me 300 USD per video.",
    "Please pay 300 USD per video.",
    "My rate is 300 USD per video if you include usage rights",
    "My rate is 300 USD per video. Payment upfront.",
    "My rate is 300 USD per video and I need the brief by Friday",
    "My rate is 300 USD per video\\nBest regards,\\nOffer Me".replace(/\\\\n/g, "\n"),
    "My fixed fee is 100 USD.\nBest regards,\nOffer Me",
    "My fixed fee is 100 USD.\nBest regards,\nJohn Smith",
    "My fixed fee is 100 USD.\nRegards,\nDiscuss Terms",
    "Hi!\nMy rate is 200 USD per video.\nBest regards,\nAlex",
    "My fixed fee is 100 USD.\nThanks,\nPay me first",
    "My fixed fee is 100 USD.\nRegards\nPlease confirm",
    "My rate is 300-500 USD depending on length.",
    "Sponsored video price list attached.",
    "We are interested. My rate is 300 USD per video.",
  ];
  for (const text of accepted) assert.equal(isFixedFeeOfferOnly(text), true, `accept: ${text}`);
  for (const text of rejected) {
    assert.equal(isFixedFeeOfferOnly(text), false, `reject: ${text}`);
    const row = evaluateReviewConversation(facts({ primaryCaseId: "fixed_terms_inquiry", intentLabels: ["custom_terms_proposal"], ...body(text) }));
    assert.notEqual(row.sendBatch.reason, "fixed_fee_proposal_only", text);
    assert.equal(row.sendBatch.bucket, "operator_judgment", text);
  }
});

test("stale or unprovable non-protection labels never exclude; protection inputs are immutable", () => {
  const newQuestion = { inbound: { body: "Hi, how do I submit my second video?" } };
  const staleVendor = evaluateReviewConversation(facts({ labelsFresh: false, actorType: "vendor_or_notification", ...newQuestion }));
  assert.notEqual(staleVendor.sendBatch.reason, "vendor_or_auto");
  assert.equal(staleVendor.sendBatch.bucket, "operator_judgment");
  const staleOoo = evaluateReviewConversation(facts({ labelsFresh: false, primaryCaseId: "out_of_office", intentLabels: ["ooo"], inbound: { body: "hello dear" } }));
  assert.equal(staleOoo.sendBatch.bucket, "operator_judgment");
  assert.notEqual(staleOoo.sendBatch.reason, "vendor_or_auto");
  const staleClosing = evaluateReviewConversation(facts({ labelsFresh: false, primaryCaseId: "closing_acknowledgment", intentLabels: ["closing"], inbound: { body: "Sounds good, I will check the portal later" } }));
  assert.notEqual(staleClosing.sendBatch.reason, "closing_or_no_question");
  assert.equal(staleClosing.sendBatch.bucket, "operator_judgment");
  const freshVendor = evaluateReviewConversation(facts({ labelsFresh: true, actorType: "vendor_or_notification", ...newQuestion }));
  assert.equal(freshVendor.sendBatch.reason, "vendor_or_auto", "a label proven fresh still excludes as before");
  const staleProtected = evaluateReviewConversation(facts({ labelsFresh: false, primaryCaseId: "settlement_dispute", intentLabels: ["complaint"], inbound: { body: null, bodyRead: false } }));
  assert.equal(staleProtected.protected, true);
  assert.equal(staleProtected.draft.draftAllowed, false);
  assert.equal(staleProtected.summary.value, null);
});

test("callable: an actor label with no case id and no stamp ref is not provably fresh → the row is not excluded", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const log = [];
      const dataset = [
        mkRow(1, { autoCaseId: undefined, autoCaseMessageRef: undefined, autoCaseActorType: "vendor_or_notification", autoCaseIntentLabels: [] }),
        mkRow(2, { autoCaseActorType: "vendor_or_notification" }),
        mkRow(3, { autoCaseMessageRef: undefined, autoCaseActorType: "vendor_or_notification" }),
        mkRow(4, { autoCaseMessageRef: "message_sources/older-inbound", autoCaseActorType: "vendor_or_notification" }),
      ];
      const envelope = await call({}, { scanPage: makeScanPage(dataset, calls), ...readers(log, dataset) });
      const byId = Object.fromEntries(envelope.rows.flatMap((row) => row.conversations.map((item) => [item.conversationId, row.sendBatch])));
      process.stdout.write(JSON.stringify(byId));
    })();
  `);
  assert.notEqual(result["conv-synth-000001"].reason, "vendor_or_auto");
  assert.equal(result["conv-synth-000001"].bucket, "operator_judgment");
  assert.equal(result["conv-synth-000002"].reason, "vendor_or_auto", "(d) stamp ref == located inbound → label fresh → excluded as before");
  assert.notEqual(result["conv-synth-000003"].reason, "vendor_or_auto", "(b) label ref missing → not excluded");
  assert.notEqual(result["conv-synth-000004"].reason, "vendor_or_auto", "(c) label ref mismatched → not excluded");
});
