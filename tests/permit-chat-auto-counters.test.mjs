import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

process.env.GCLOUD_PROJECT ||= "demo-flu";
process.env.FIREBASE_CONFIG ||= JSON.stringify({ projectId: process.env.GCLOUD_PROJECT });

const store = await import(new URL("../functions/lib/chatAutoCasePermitStore.js", import.meta.url));
const permit = await import(new URL("../functions/lib/chatAutoCasePermit.js", import.meta.url));
const PIN = permit.chatAutoCasePermitPin("permit-model-v1");
const STALE_PIN = permit.chatAutoCasePermitPin("stale-model");

function event(overrides = {}) {
  return {
    conversationId: "conversation-1",
    messageRef: "conversations/conversation-1/messages/m1",
    messageSourceRef: "message_sources/source-1",
    outboundLogRef: "mail_outbound_log/out-1",
    caseId: "interest_next_steps",
    casebookHash: PIN.casebookHash,
    gatewayModelVersion: "permit-model-v1",
    caseIntentRef: null,
    permitDecisionId: "decision-1",
    sender: "human",
    approval: "approved",
    deliveryState: "sent",
    providerConfirmed: true,
    acceptedCount: 1,
    rejectedCount: 0,
    originalDraftHash: "draft-hash",
    sentBodyHash: "draft-hash",
    sentMatchesServerRenderedDraft: true,
    bounced: false,
    complained: false,
    optedOut: false,
    suppressed: false,
    learningDisposition: "arming_credit",
    sentAtIso: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

test("human approved sent copies count even before an auto-send intent exists", () => {
  const counters = store.summarizeChatAutoPermitCounters([
    event({ messageRef: "m1", sentAtIso: "2026-09-05T00:00:00.000Z", caseIntentRef: null }),
    event({ messageRef: "m2", sentAtIso: "2026-09-05T00:01:00.000Z", caseIntentRef: null }),
  ], { pin: PIN });
  assert.equal(counters.consecutiveHumanUneditedApprovedSent, 2);
  assert.equal(counters.totalHumanUneditedApprovedSent, 2);
  assert.equal(counters.unavailableEvidenceCount, 0);
});

test("committed-send counter helper makes status usable before first arm", () => {
  const first = store.applyChatAutoCommittedSendEventToCounters(null, event({
    messageRef: "m1",
    sentAtIso: "2026-09-05T00:00:00.000Z",
    caseIntentRef: null,
  }), { pin: PIN });
  assert.equal(first.consecutiveHumanUneditedApprovedSent, 1);
  assert.equal(first.totalHumanUneditedApprovedSent, 1);
  assert.equal(first.unavailableEvidenceCount, 0);

  const second = store.applyChatAutoCommittedSendEventToCounters(first, event({
    messageRef: "m2",
    sentAtIso: "2026-09-05T00:01:00.000Z",
    caseIntentRef: null,
  }), { pin: PIN });
  assert.equal(second.consecutiveHumanUneditedApprovedSent, 2);
  assert.equal(second.totalHumanUneditedApprovedSent, 2);
  assert.equal(second.lastEligibleMessageRef, "m2");
});

test("historical rows missing new Permit evidence reset and get no credit", () => {
  const counters = store.summarizeChatAutoPermitCounters([
    event({ permitDecisionId: null, sentAtIso: "2026-09-05T00:00:00.000Z" }),
    event({ messageRef: "m2", sentAtIso: "2026-09-05T00:01:00.000Z" }),
  ], { pin: PIN });
  assert.equal(counters.consecutiveHumanUneditedApprovedSent, 1);
  assert.equal(counters.totalHumanUneditedApprovedSent, 1);
  assert.equal(counters.unavailableEvidenceCount, 1);
  assert.equal(counters.lastResetReason, "case_unresolved_adverse_event");
});

test("twenty stale-pin manual approvals do not count toward the current permit", () => {
  const staleEvents = Array.from({ length: 20 }, (_, index) => event({
    messageRef: `stale-${index}`,
    sentAtIso: `2026-09-05T00:${String(index).padStart(2, "0")}:00.000Z`,
    casebookHash: STALE_PIN.casebookHash,
    gatewayModelVersion: STALE_PIN.modelVersion,
  }));
  const counters = store.summarizeChatAutoPermitCounters(staleEvents, { pin: PIN });
  assert.equal(counters.consecutiveHumanUneditedApprovedSent, 0);
  assert.equal(counters.totalHumanUneditedApprovedSent, 0);
  assert.equal(counters.lastResetReason, "model_version_changed");
});

test("nineteen current approvals plus one stale event still denies the counter floor", () => {
  const currentEvents = Array.from({ length: 19 }, (_, index) => event({
    messageRef: `current-${index}`,
    sentAtIso: `2026-09-05T00:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  const staleEvent = event({
    messageRef: "stale-20",
    sentAtIso: "2026-09-05T00:20:00.000Z",
    gatewayModelVersion: STALE_PIN.modelVersion,
  });
  const counters = store.summarizeChatAutoPermitCounters([...currentEvents, staleEvent], { pin: PIN });
  assert.equal(counters.consecutiveHumanUneditedApprovedSent, 0);
  assert.equal(counters.totalHumanUneditedApprovedSent, 19);
  assert.equal(counters.lastResetReason, "model_version_changed");
});

test("twenty current pin approvals meet the counter floor", () => {
  const currentEvents = Array.from({ length: 20 }, (_, index) => event({
    messageRef: `current-${index}`,
    sentAtIso: `2026-09-05T00:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  const counters = store.summarizeChatAutoPermitCounters(currentEvents, { pin: PIN });
  assert.equal(counters.consecutiveHumanUneditedApprovedSent, 20);
  assert.equal(counters.totalHumanUneditedApprovedSent, 20);
  assert.equal(counters.lastResetReason, null);
});

test("stale event cannot be carried over from an existing current counter", () => {
  const current = {
    consecutiveHumanUneditedApprovedSent: 19,
    totalHumanUneditedApprovedSent: 19,
    lastEligibleMessageRef: "current-18",
    lastResetAtIso: null,
    lastResetReason: null,
    unavailableEvidenceCount: 0,
  };
  const counters = store.applyChatAutoCommittedSendEventToCounters(current, event({
    messageRef: "stale-race",
    sentAtIso: "2026-09-05T01:00:00.000Z",
    gatewayModelVersion: STALE_PIN.modelVersion,
  }), { pin: PIN });
  assert.equal(counters.consecutiveHumanUneditedApprovedSent, 0);
  assert.equal(counters.totalHumanUneditedApprovedSent, 19);
  assert.equal(counters.lastResetReason, "model_version_changed");
});

test("edited approved send resets counters but remains proposal-only eligible", () => {
  const counters = store.summarizeChatAutoPermitCounters([
    event({ messageRef: "m1", sentAtIso: "2026-09-05T00:00:00.000Z" }),
    event({
      messageRef: "m2",
      sentAtIso: "2026-09-05T00:01:00.000Z",
      sentBodyHash: "edited-hash",
      sentMatchesServerRenderedDraft: false,
      learningDisposition: "proposal_only_counter_reset",
    }),
  ], { pin: PIN });
  assert.equal(counters.consecutiveHumanUneditedApprovedSent, 0);
  assert.equal(counters.totalHumanUneditedApprovedSent, 1);
  assert.equal(counters.lastResetReason, "human_edited");
});

test("rejected or skipped rows are audit-only and reset", () => {
  for (const approval of ["rejected", "skipped"]) {
    const counters = store.summarizeChatAutoPermitCounters([
      event({ messageRef: "m1", sentAtIso: "2026-09-05T00:00:00.000Z" }),
      event({ messageRef: `m-${approval}`, sentAtIso: "2026-09-05T00:01:00.000Z", approval, learningDisposition: "rejected_audit_only" }),
    ], { pin: PIN });
    assert.equal(counters.consecutiveHumanUneditedApprovedSent, 0);
    assert.equal(counters.lastResetReason, "human_rejected");
  }
});

test("bounce, complaint, opt-out, and suppression reset with disarm reasons", () => {
  const cases = [
    ["bounced", "bounce_or_suppression"],
    ["complained", "complaint"],
    ["optedOut", "opt_out"],
    ["suppressed", "suppression"],
  ];
  for (const [flag, reason] of cases) {
    const counters = store.summarizeChatAutoPermitCounters([
      event({ messageRef: "m1", sentAtIso: "2026-09-05T00:00:00.000Z" }),
      event({ messageRef: `m-${flag}`, sentAtIso: "2026-09-05T00:01:00.000Z", [flag]: true, learningDisposition: "adverse_audit_only" }),
    ], { pin: PIN });
    assert.equal(counters.consecutiveHumanUneditedApprovedSent, 0);
    assert.equal(counters.lastResetReason, reason);
  }
});

test("AI-sent rows and unconfirmed provider rows do not increment human baseline", () => {
  const counters = store.summarizeChatAutoPermitCounters([
    event({ sender: "ai", messageRef: "ai", sentAtIso: "2026-09-05T00:00:00.000Z" }),
    event({ providerConfirmed: false, messageRef: "unconfirmed", sentAtIso: "2026-09-05T00:01:00.000Z" }),
  ], { pin: PIN });
  assert.equal(counters.consecutiveHumanUneditedApprovedSent, 0);
  assert.equal(counters.totalHumanUneditedApprovedSent, 0);
});

test("committed-send event id and proposal id are deterministic and path-safe", () => {
  const source = event({ messageRef: "conversations/a/messages/b", sentBodyHash: "edited" });
  assert.equal(store.chatAutoCommittedSendEventId(source), store.chatAutoCommittedSendEventId(source));
  assert.match(store.chatAutoCommittedSendEventId(source), /^[a-f0-9]{48}$/);
  assert.equal(store.chatAutoCaseProposalOutboxId(source), store.chatAutoCaseProposalOutboxId(source));
  assert.match(store.chatAutoCaseProposalOutboxId(source), /^[a-f0-9]{48}$/);
});

test("batch committed-send API creates private evidence and proposal-only outbox rows without caller payload merging", () => {
  const writes = [];
  const fakeBatch = {
    create(ref, data) {
      writes.push({ path: ref.path, data });
    },
  };
  const ref = store.writeChatAutoCommittedSendEventBatch(fakeBatch, event({
    sentBodyHash: "edited",
    sentMatchesServerRenderedDraft: false,
    learningDisposition: "proposal_only_counter_reset",
    proposalExampleText: "Please use this edited wording for creator@example.com https://example.com",
  }));
  assert.equal(writes.length, 2);
  assert.equal(writes[0].path, ref.path);
  assert.ok(writes[0].path.startsWith(`${store.CHAT_AUTO_CASE_COMMITTED_SENDS_COLLECTION}/`));
  assert.equal(writes[0].data.proposalExampleText, undefined);
  assert.ok(writes[1].path.startsWith(`${permit.CHAT_AUTO_CASEBOOK_PROPOSAL_OUTBOX_COLLECTION}/`));
  assert.equal(writes[1].data.status, "proposal_only");
  assert.equal(writes[1].data.sourceEventRef, ref.path);
  assert.equal(writes[1].data.sanitizedExampleText, "Please use this edited wording for [redacted-email] [redacted-url]");
});

test("confirmed manual edited send creates one scrubbed proposal sample", () => {
  const writes = [];
  const fakeBatch = {
    create(ref, data) {
      writes.push({ path: ref.path, data });
    },
  };
  store.writeChatAutoCommittedSendEventBatch(fakeBatch, event({
    sentBodyHash: "edited-human-body",
    sentMatchesServerRenderedDraft: false,
    learningDisposition: "proposal_only_counter_reset",
    proposalExampleText: "Creator alice@example.com asked for https://secret.test and token=abc123; reply with final steps.",
  }));
  const proposalWrites = writes.filter((write) => write.path.startsWith(`${permit.CHAT_AUTO_CASEBOOK_PROPOSAL_OUTBOX_COLLECTION}/`));
  assert.equal(proposalWrites.length, 1);
  assert.equal(proposalWrites[0].data.sanitizedExampleText, "Creator [redacted-email] asked for [redacted-url] and token=[redacted-secret] reply with final steps.");
  assert.doesNotMatch(proposalWrites[0].data.sanitizedExampleText, /alice@example|secret\.test|abc123/i);
});

test("forged proposal disposition does not create proposal outbox unless full human approved sent eligibility holds", () => {
  const deniedCases = [
    { approval: "rejected" },
    { deliveryState: "failed" },
    { deliveryState: "mock_sent" },
    { deliveryState: "skipped_duplicate" },
    { sender: "ai" },
    { complained: true },
    { providerConfirmed: false },
    { acceptedCount: 0 },
    { rejectedCount: 1 },
    { sentMatchesServerRenderedDraft: true, sentBodyHash: "draft-hash" },
    { proposalExampleText: "" },
  ];
  for (const overrides of deniedCases) {
    const writes = [];
    const fakeBatch = {
      create(ref, data) {
        writes.push({ path: ref.path, data });
      },
    };
    store.writeChatAutoCommittedSendEventBatch(fakeBatch, event({
      sentBodyHash: "edited",
      sentMatchesServerRenderedDraft: false,
      learningDisposition: "proposal_only_counter_reset",
      proposalExampleText: "reviewable edited text",
      ...overrides,
    }));
    assert.equal(writes.length, 1, JSON.stringify(overrides));
    assert.ok(writes[0].path.startsWith(`${store.CHAT_AUTO_CASE_COMMITTED_SENDS_COLLECTION}/`));
  }
});

test("sendEmail committed-send bridge passes only server-compiled text into proposal sample field", () => {
  const source = readFileSync(new URL("../functions/chat-ai.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /recordChatAutoCommittedSendEvent\(\{[\s\S]*proposalExampleText:\s*asString\(sendData\.text,\s*sendSourceBody\)[\s\S]*\},\s*\{\s*pin:\s*committedPin\s*\}\)/,
  );
  assert.match(source, /if\s*\(\s*permitOriginalDraftHash\s*&&\s*isChatAutoCaseId\(permitCaseId\)\s*\)\s*\{/);
});

test("case intent batch API reserves conversation/case pair with create-only hashed id", () => {
  const writes = [];
  const fakeBatch = {
    create(ref, data) {
      writes.push({ path: ref.path, data });
    },
  };
  const decision = {
    allowed: true,
    caseId: "interest_next_steps",
    intentId: permit.chatAutoCaseIntentId("conversation/with/slash", "interest_next_steps"),
    pin: permit.chatAutoCasePermitPin("permit-model-v1"),
    draft: permit.renderChatAutoServerDraft({ caseId: "interest_next_steps", factTokenIds: [], linkTokenIds: [] }),
    denyReasons: [],
  };
  const queueRef = { path: "auto_reply_queue/q1" };
  const ref = store.writeChatAutoCaseIntentBatch(fakeBatch, {
    conversationId: "conversation/with/slash",
    messageSourceId: "source-1",
    caseId: "interest_next_steps",
    queueRef,
    decision,
    nowIso: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, ref.path);
  assert.equal(ref.id, decision.intentId);
  assert.ok(writes[0].path.startsWith(`${permit.CHAT_AUTO_CASE_INTENTS_COLLECTION}/${decision.intentId}`));
  assert.equal(writes[0].data.queueRef, queueRef.path);
});

test("execution ledger identity includes phase so reserved and sent append separately", () => {
  const base = {
    conversationId: "conversation-1",
    messageSourceId: "source-1",
    caseId: "interest_next_steps",
  };
  const reserved = store.chatAutoCaseExecutionLedgerId({ ...base, result: "reserved" });
  const sent = store.chatAutoCaseExecutionLedgerId({ ...base, result: "sent" });
  assert.notEqual(reserved, sent);
  assert.equal(reserved, store.chatAutoCaseExecutionLedgerId({ ...base, result: "reserved" }));
});

test("decision ledger replay is idempotent only for the exact same record", () => {
  const record = {
    schemaVersion: permit.CHAT_AUTO_PERMIT_SCHEMA_VERSION,
    decisionId: "decision-1",
    conversationId: "conversation-1",
    messageSourceId: "source-1",
    caseId: "interest_next_steps",
    allowed: false,
    denyReasons: ["permit_missing"],
    pin: PIN,
    caseCandidates: [],
    clampReasonIds: [],
    gatewayCostLog: { provider: "ai-hub", model: PIN.modelVersion, transport: "ai_hub_gateway", estimatedCostUsd: 0.01 },
    createdAtIso: "2026-09-05T00:00:00.000Z",
    source: "functions.chatAutoCasePermitStore",
  };
  assert.equal(store.chatAutoDecisionLedgerRecordsMatch({ ...record, createdAt: {} }, record), true);
  assert.equal(
    store.chatAutoDecisionLedgerRecordsMatch(
      { ...record, denyReasons: ["permit_missing"] },
      { ...record, denyReasons: ["pin_mismatch"] },
    ),
    false,
  );
  // [적대 리뷰 MED-1] createdAtIso 만 다른 재시도는 no-op(멱등)이어야 한다 — 같은 decisionId 의
  //   정당한 재시도는 나머지 필드가 전부 동일하고 생성 시각만 달라진다. 종전에는 이 값이
  //   comparableKeys 에 들어 있어 재시도마다 "충돌하는 replay" 로 오판했다.
  assert.equal(
    store.chatAutoDecisionLedgerRecordsMatch(
      { ...record, createdAtIso: "2026-09-05T00:00:00.000Z" },
      { ...record, createdAtIso: "2026-09-05T00:05:00.000Z" },
    ),
    true,
    "a retry of the same decision differing only in createdAtIso must be a no-op",
  );
});

test("disarm API accepts null eval evidence without fabricating an eval receipt", () => {
  const source = readText("../functions/chatAutoCasePermitStore.ts");
  assert.match(source, /evalEvidence: ChatAutoEvalEvidence \| null/);
  assert.match(source, /evalRunId: input\.evalEvidence\?\.runId \?\? null/);
  assert.doesNotMatch(source, /buildSha: \"0+\"/);
});

function readText(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}
