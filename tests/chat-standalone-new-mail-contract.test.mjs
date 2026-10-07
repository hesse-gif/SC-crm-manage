import assert from "node:assert/strict";
import { test } from "node:test";

const {
  STANDALONE_NEW_MAIL_INTENT,
  assertStandaloneNewMailConversationBinding,
  assertStandaloneNewMailPayload,
  standaloneNewMailConversationId,
  standaloneNewMailIdempotencyKey,
} = await import(new URL("../functions/lib/chat-ai.js", import.meta.url));

function validPayload(overrides = {}) {
  return {
    intent: STANDALONE_NEW_MAIL_INTENT,
    draftRef: "fresh-draft-contract-test",
    trackingId: "fresh-tracking-contract-test",
    approvalRef: "fresh-approval-contract-test",
    approval: "approved",
    senderAccountId: "sender-a",
    to: " t.growth@supercent.io ",
    subject: "Internal group message",
    text: "A message for the Growth team.",
    fromRole: "human",
    dryRun: true,
    liveSend: false,
    ...overrides,
  };
}

test("standalone new mail accepts a fresh approved compose payload", () => {
  assert.doesNotThrow(() => assertStandaloneNewMailPayload(validPayload()));
});

test("standalone new mail rejects client conversation, source, reply, and workflow context", () => {
  for (const field of [
    "conversationId",
    "threadId",
    "source",
    "sourceRef",
    "replyToMessageRef",
    "replyHeaders",
    "references",
    "programId",
    "campaignId",
    "allowInflyOverlap",
    "mailPurpose",
    "templateKind",
  ]) {
    assert.throws(
      () => assertStandaloneNewMailPayload(validPayload({ [field]: field === "references" ? ["forged"] : "forged" })),
      (error) => error?.code === "failed-precondition"
        && error?.errorCode === "send_email_standalone_context_forbidden",
      `forged ${field} context must be rejected`,
    );
  }
});

test("standalone new mail requires explicit sender, tracking, approval, and human body fields", () => {
  for (const [field, expectedCode] of [
    ["senderAccountId", "send_email_standalone_sender_account_required"],
    ["trackingId", "send_email_standalone_tracking_ref_required"],
    ["approvalRef", "send_email_standalone_approval_ref_required"],
    ["approval", "send_email_standalone_approval_required"],
    ["draftRef", "send_email_standalone_draft_ref_required"],
    ["subject", "send_email_standalone_subject_required"],
    ["text", "send_email_standalone_body_required"],
  ]) {
    const value = field === "approval" ? "pending" : "";
    assert.throws(
      () => assertStandaloneNewMailPayload(validPayload({ [field]: value })),
      (error) => error?.code === "failed-precondition" && error?.errorCode === expectedCode,
      `${field} must be required by the standalone compose contract`,
    );
  }

  assert.throws(
    () => assertStandaloneNewMailPayload(validPayload({ approval: "pending" })),
    (error) => error?.errorCode === "send_email_standalone_approval_required",
  );
  assert.throws(
    () => assertStandaloneNewMailPayload(validPayload({ fromRole: "ai" })),
    (error) => error?.errorCode === "send_email_standalone_manual_only",
  );
  assert.throws(
    () => assertStandaloneNewMailPayload(validPayload({ fromRole: undefined })),
    (error) => error?.errorCode === "send_email_standalone_manual_only",
  );
});

test("standalone sender aliases must all agree with senderAccountId", () => {
  assert.doesNotThrow(() => assertStandaloneNewMailPayload(validPayload({
    viewAccountId: "sender-a",
    accountId: "sender-a",
    mailAccountId: "sender-a",
  })));
  assert.throws(
    () => assertStandaloneNewMailPayload(validPayload({ viewAccountId: "sender-b" })),
    (error) => error?.code === "permission-denied"
      && error?.errorCode === "send_email_sender_override_not_allowed",
  );
});

test("standalone conversation ids are stable per normalized recipient and selected sender account", () => {
  const growthId = standaloneNewMailConversationId(" T.GROWTH@SUPERCENT.IO ", "scp");
  const growthIdAgain = standaloneNewMailConversationId("t.growth@supercent.io", "scp");
  const personalId = standaloneNewMailConversationId("t.growth@supercent.io", "aix-personal");
  assert.match(growthId, /^mail-scp-[0-9a-f]{40}$/);
  assert.equal(growthIdAgain, growthId);
  assert.notEqual(personalId, growthId, "the same recipient must not share a conversation across sender accounts");
  assert.match(personalId, /^mail-aix-personal-[0-9a-f]{40}$/);
});

test("standalone delivery identity is account and recipient scoped", () => {
  const base = "draft:tracking:approval:approved";
  const scpGrowth = standaloneNewMailIdempotencyKey(base, "scp", "T.GROWTH@SUPERCENT.IO");
  assert.equal(
    standaloneNewMailIdempotencyKey(base, "scp", "t.growth@supercent.io"),
    scpGrowth,
  );
  assert.notEqual(
    standaloneNewMailIdempotencyKey(base, "aix-personal", "t.growth@supercent.io"),
    scpGrowth,
  );
  assert.notEqual(
    standaloneNewMailIdempotencyKey(base, "scp", "other@supercent.io"),
    scpGrowth,
  );
});

test("standalone conversation binding allows only the selected account (legacy blank means SCP)", () => {
  assert.doesNotThrow(() => assertStandaloneNewMailConversationBinding(null, "aix-personal"));
  assert.doesNotThrow(() => assertStandaloneNewMailConversationBinding({ mailAccountId: "aix-personal" }, "aix-personal"));
  assert.doesNotThrow(() => assertStandaloneNewMailConversationBinding({}, "scp"));
  assert.throws(
    () => assertStandaloneNewMailConversationBinding({}, "aix-personal"),
    (error) => error?.code === "failed-precondition"
      && error?.errorCode === "send_email_standalone_conversation_account_conflict",
  );
  assert.throws(
    () => assertStandaloneNewMailConversationBinding({ mailAccountId: "scp" }, "aix-personal"),
    (error) => error?.errorCode === "send_email_standalone_conversation_account_conflict",
  );
});
