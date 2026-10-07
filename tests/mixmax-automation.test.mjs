import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { verifyMixmaxRules } from "../scripts/verify-mixmax-rules.mjs";

const require = createRequire(import.meta.url);
const automationCoreUrl = new URL("../.mixmax-functions/lib/automation-core.js", import.meta.url);

assert.ok(
  existsSync(automationCoreUrl),
  "Mixmax automation tests require a fresh build: node scripts/build-mixmax-functions.mjs",
);

const core = require("../.mixmax-functions/lib/automation-core.js");

test("automation policy digest changes when the saved reply or no-reply flags change", () => {
  const base = core.automationPolicyDigest({
    name: "Rates",
    description: "Price inquiry",
    body: "Thanks, our rate card is attached.",
    noReplyNeeded: false,
    draftForbidden: false,
  });

  assert.notEqual(base, core.automationPolicyDigest({
    name: "Rates",
    description: "Price inquiry",
    body: "Thanks, please see the updated rate card.",
    noReplyNeeded: false,
    draftForbidden: false,
  }));

  assert.notEqual(base, core.automationPolicyDigest({
    name: "Rates",
    description: "Price inquiry",
    body: "Thanks, our rate card is attached.",
    noReplyNeeded: true,
    draftForbidden: false,
  }));
});

test("automation enablement is future-only for new Gmail messages", () => {
  const connection = {
    id: "gmail_1",
    email: "me@example.com",
    automationEnabled: true,
    automationEnabledAt: "2026-10-07T10:00:00.000Z",
  };

  assert.equal(core.isAutomationEnabledForMessage(connection, "2026-10-07T09:59:59.999Z"), false);
  assert.equal(core.isAutomationEnabledForMessage(connection, "2026-10-07T10:00:00.000Z"), true);
  assert.equal(core.isAutomationEnabledForMessage({ ...connection, automationEnabled: false }, "2026-10-07T10:01:00.000Z"), false);
});

test("direct auto replies reject loops, list mail, multi-party mail and ambiguous senders", () => {
  const base = {
    direction: "inbound",
    from: "Creator <creator@example.com>",
    to: ["me@example.com"],
    cc: [],
    replyTo: [],
    labelIds: ["INBOX"],
    autoSubmitted: "",
    precedence: "",
    listId: "",
  };

  assert.deepEqual(core.directReplyAddress(base, "me@example.com"), { ok: true, to: "creator@example.com" });
  assert.equal(core.directReplyAddress({ ...base, autoSubmitted: "auto-replied" }, "me@example.com").reason, "auto_submitted");
  assert.equal(core.directReplyAddress({ ...base, listId: "<list.example.com>" }, "me@example.com").reason, "mailing_list");
  assert.equal(core.directReplyAddress({ ...base, cc: ["other@example.com"] }, "me@example.com").reason, "multi_party");
  assert.equal(core.directReplyAddress({ ...base, from: "A <a@example.com>, B <b@example.com>" }, "me@example.com").reason, "ambiguous_sender");
  assert.equal(core.directReplyAddress({ ...base, from: "No Reply <noreply@example.com>" }, "me@example.com").reason, "system_sender");
  assert.equal(core.directReplyAddress({ ...base, labelIds: ["TRASH"] }, "me@example.com").reason, "unsafe_label");
});

test("automation ids are deterministic and per-message", () => {
  assert.equal(core.automationRunId("thread-a", "message-a"), core.automationRunId("thread-a", "message-a"));
  assert.notEqual(core.automationRunId("thread-a", "message-a"), core.automationRunId("thread-a", "message-b"));
  assert.match(core.pendingCaseId("primary", "thread-a", "message-a"), /^case_[a-f0-9]{32}$/);
});

test("classifier authorization fields cannot be omitted or coerced", () => {
  const valid = { caseId: "known", confidence: 0.95, noReply: false };
  assert.deepEqual(core.parseClassifierJson(JSON.stringify(valid)), valid);
  for (const invalid of [
    { ...valid, noReply: "false" },
    { ...valid, confidence: "1" },
    { ...valid, confidence: 9 },
    { ...valid, caseId: null },
    { caseId: "known", confidence: 1 },
    { ...valid, proposedName: "a".repeat(201) },
  ]) assert.throws(() => core.parseClassifierJson(JSON.stringify(invalid)));
});

test("policy pins include complete negative constraints and invalid dates cannot grant activation", () => {
  const prefix = "x".repeat(4000);
  assert.notEqual(core.automationPolicyDigest({ never: prefix + "A" }), core.automationPolicyDigest({ never: prefix + "B" }));
  assert.equal(core.isAutomationEnabledForMessage({ id: "a", automationEnabled: true, automationEnabledAt: "2026-10-07T00:00:00.000Z" }, "invalid"), false);
});

test("Mixmax automation functions are exported and owner-scoped runs are readable", () => {
  const indexSource = readFileSync(new URL("../functions/mixmax/index.ts", import.meta.url), "utf8");
  for (const name of [
    "mixmaxSetAutomationSettings",
    "mixmaxAnalyzeThread",
    "mixmaxConfigureCaseAutomation",
    "mixmaxResolveAutomationRun",
    "mixmaxThreadAutomationEnqueue",
    "mixmaxAutomationJob",
  ]) {
    assert.match(indexSource, new RegExp(`\\b${name}\\b`));
  }

  const result = verifyMixmaxRules({
    rulesSource: readFileSync(new URL("../firestore.mixmax.rules", import.meta.url), "utf8"),
    firebaseSource: readFileSync(new URL("../firebase.mixmax.json", import.meta.url), "utf8"),
  });
  assert.equal(result.readableCollections.includes("mixmax_automation_runs"), true);
  assert.equal(result.privateCollections.includes("mixmax_automation_budgets"), true);
});
