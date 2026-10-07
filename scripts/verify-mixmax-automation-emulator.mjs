import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Run after `node scripts/build-mixmax-functions.mjs`:
//   firebase emulators:exec --only firestore --project demo-mixmax "GCLOUD_PROJECT=demo-mixmax node scripts/verify-mixmax-automation-emulator.mjs"
if (
  process.env.GCLOUD_PROJECT !== "demo-mixmax" ||
  !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")
) {
  throw new Error("Automation emulator verification requires the local demo-mixmax Firestore emulator");
}

process.env.GOOGLE_CLOUD_PROJECT = "demo-mixmax";
process.env.FUNCTIONS_EMULATOR = "true";
process.env.MIXMAX_GOOGLE_CLIENT_ID = "emulator-client";
process.env.MIXMAX_GOOGLE_CLIENT_SECRET = "emulator-secret";
process.env.MIXMAX_GOOGLE_OAUTH_READY = "true";
process.env.MIXMAX_AI_MODEL = "gemini-3.8-flash";
process.env.geminiApiKey = "emulator-gemini-key";

const require = createRequire(resolve("functions/package.json"));
const { db } = require(resolve(".mixmax-functions/lib/common.js"));
const core = require(resolve(".mixmax-functions/lib/automation-core.js"));
const index = require(resolve(".mixmax-functions/lib/index.js"));

const run = `autoemu_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const workspaceId = `${run}_workspace`;
const ownerUid = `${run}_owner`;
const ownerEmail = `${run}@example.com`;
const connectionId = `${run}_conn`;
const gmailThreadLatest = new Map();
const sendFailures = [];
const classifierQueue = [];
const sendCalls = [];
const geminiCalls = [];
let tokenRequests = 0;
let beforeGeminiResponse = null;

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function callableRequest(data) {
  return {
    data,
    auth: { uid: ownerUid, token: { email: ownerEmail, email_verified: true } },
    rawRequest: { ip: "127.0.0.1" },
  };
}

function unwrap(value) {
  return value?.result ?? value;
}

function snapshot(data, exists = data !== null && data !== undefined) {
  return { exists, data: () => data };
}

function writtenEvent(paramName, id, beforeData, afterData) {
  return {
    params: { [paramName]: id },
    data: {
      before: snapshot(beforeData, Boolean(beforeData)),
      after: snapshot(afterData, Boolean(afterData)),
    },
  };
}

function threadEvent(threadId, beforeData, afterData) {
  return writtenEvent("threadId", threadId, beforeData, afterData);
}

function runEvent(runId, afterData) {
  return writtenEvent("runId", runId, null, afterData);
}

function decodedRaw(body) {
  return Buffer.from(JSON.parse(body).raw, "base64url").toString("utf8");
}

function queueClassifier(result) {
  classifierQueue.push(result);
}

function latestClassifierPayload() {
  const text = geminiCalls.at(-1)?.contents?.[0]?.parts?.[0]?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

function assertNoSend(label) {
  assert.equal(sendCalls.length, 0, label);
}

async function doc(path) {
  return (await db.doc(path).get()).data();
}

async function collectionRows(collection, field, value) {
  const snap = await db.collection(collection).where(field, "==", value).get();
  return snap.docs.map(row => ({ id: row.id, ...row.data() }));
}

async function assertRejectsWithMessage(action, pattern, label) {
  await assert.rejects(action, error => {
    assert.match(String(error?.message ?? error), pattern, label);
    return true;
  });
}

async function seedBase() {
  await Promise.all([
    db.doc(`mixmax_members/${ownerUid}`).set({ uid: ownerUid, email: ownerEmail, workspaceId, role: "owner" }),
    db.doc(`mixmax_connections/${connectionId}`).set({
      workspaceId,
      ownerUid,
      email: ownerEmail,
      status: "connected",
      automationEnabled: false,
      automationDailyClassificationCap: 100,
      automationDailySendCap: 20,
    }),
    db.doc(`mixmax_credentials/${connectionId}`).set({ workspaceId, ownerUid, refreshToken: "emulator-refresh-token" }),
  ]);
}

async function seedInbound({
  suffix,
  sentAt = iso(-60_000),
  text = "What are your creator partnership rates?",
  from = "Creator <creator@example.com>",
  to = [ownerEmail],
  cc = [],
  autoSubmitted = "",
  precedence = "",
  listId = "",
  latestDirection = "inbound",
} = {}) {
  const threadId = `${run}_thread_${suffix}`;
  const messageId = `${run}_msg_${suffix}`;
  const gmailThreadId = `${run}_gmail_thread_${suffix}`;
  const gmailMessageId = `${run}_gmail_msg_${suffix}`;
  const thread = {
    workspaceId,
    ownerUid,
    source: "gmail",
    connectionId,
    gmailThreadId,
    latestMessageId: messageId,
    latestMessageDirection: latestDirection,
    lastMessageAt: sentAt,
    subject: `Automation ${suffix}`,
    mailbox: ownerEmail,
  };
  const message = {
    workspaceId,
    connectionId,
    threadId,
    source: "gmail",
    direction: "inbound",
    from,
    to,
    cc,
    replyTo: [],
    subject: thread.subject,
    text,
    sentAt,
    gmailMessageId,
    autoSubmitted,
    precedence,
    listId,
    labelIds: ["INBOX"],
  };
  gmailThreadLatest.set(gmailThreadId, gmailMessageId);
  await Promise.all([
    db.doc(`mixmax_threads/${threadId}`).set(thread),
    db.doc(`mixmax_messages/${messageId}`).set(message),
  ]);
  return { threadId, messageId, gmailThreadId, gmailMessageId, thread, message };
}

async function seedFollowup(existing, suffix, sentAt = iso(1_000)) {
  const messageId = `${run}_msg_${suffix}`;
  const gmailMessageId = `${run}_gmail_msg_${suffix}`;
  const thread = {
    ...(await doc(`mixmax_threads/${existing.threadId}`)),
    latestMessageId: messageId,
    latestMessageDirection: "inbound",
    lastMessageAt: sentAt,
  };
  const message = {
    workspaceId,
    connectionId,
    threadId: existing.threadId,
    source: "gmail",
    direction: "inbound",
    from: "Creator <creator@example.com>",
    to: [ownerEmail],
    cc: [],
    replyTo: [],
    subject: thread.subject,
    text: "Following up on the same rates question.",
    sentAt,
    gmailMessageId,
    autoSubmitted: "",
    precedence: "",
    listId: "",
    labelIds: ["INBOX"],
  };
  gmailThreadLatest.set(existing.gmailThreadId, gmailMessageId);
  await Promise.all([
    db.doc(`mixmax_threads/${existing.threadId}`).set(thread),
    db.doc(`mixmax_messages/${messageId}`).set(message),
  ]);
  return { ...existing, messageId, gmailMessageId, thread, message };
}

async function approveCase({ caseId, name = "Rates", description = "Creator asks for rates", body = "Thanks for reaching out. Our saved response is attached.", enabled = true }) {
  const result = unwrap(await index.mixmaxConfigureCaseAutomation.run(callableRequest({
    connectionId,
    caseId,
    enabled,
    name,
    description,
    body,
  })));
  assert.equal(result.caseId, caseId);
  return result;
}

async function enqueue(thread) {
  await index.mixmaxThreadAutomationEnqueue.run(threadEvent(thread.threadId, null, thread.thread));
  return core.automationRunId(thread.threadId, thread.messageId);
}

async function job(runId, options = {}) {
  const runDoc = await doc(`mixmax_automation_runs/${runId}`);
  await index.mixmaxAutomationJob.run(runEvent(runId, options.eventStatus ? { ...runDoc, status: options.eventStatus } : runDoc));
  return doc(`mixmax_automation_runs/${runId}`);
}

async function seedRun(thread, patch = {}) {
  const runId = core.automationRunId(thread.threadId, thread.messageId);
  const data = {
    workspaceId,
    ownerUid,
    connectionId,
    threadId: thread.threadId,
    messageId: thread.messageId,
    gmailThreadId: thread.gmailThreadId,
    status: "pending",
    attempts: 0,
    createdAt: iso(),
    updatedAt: iso(),
    ...patch,
  };
  await db.doc(`mixmax_automation_runs/${runId}`).set(data);
  return runId;
}

async function expectHeld(runId, reason) {
  const runDoc = await job(runId);
  assert.equal(runDoc.status, "held");
  assert.equal(runDoc.reason, reason);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin === "https://generativelanguage.googleapis.com") {
    geminiCalls.push(JSON.parse(init.body));
    const next = classifierQueue.shift();
    if (!next) throw new Error("No queued classifier response");
    if (beforeGeminiResponse) {
      const hook = beforeGeminiResponse;
      beforeGeminiResponse = null;
      await hook();
    }
    return response({ candidates: [{ content: { parts: [{ text: JSON.stringify(next) }] } }] });
  }
  if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
    tokenRequests += 1;
    return response({ access_token: "local-only-token" });
  }
  if (url.origin !== "https://gmail.googleapis.com") throw new Error(`Unexpected external request: ${url.toString()}`);
  const threadMatch = url.pathname.match(/\/threads\/([^/]+)$/);
  if (threadMatch) {
    const gmailThreadId = decodeURIComponent(threadMatch[1]);
    const latest = gmailThreadLatest.get(gmailThreadId);
    return response({
      messages: latest ? [{
        id: latest,
        threadId: gmailThreadId,
        payload: { headers: [{ name: "Message-ID", value: `<${latest}@example.com>` }] },
      }] : [],
    });
  }
  if (url.pathname.endsWith("/messages/send")) {
    const raw = decodedRaw(init.body);
    sendCalls.push({ raw, body: JSON.parse(init.body) });
    const status = sendFailures.shift();
    if (status) return response({ error: "provider failure" }, status);
    return response({ id: `${run}_sent_${sendCalls.length}`, threadId: JSON.parse(init.body).threadId });
  }
  throw new Error(`Unmocked Gmail path: ${url.pathname}`);
};

try {
  await seedBase();

  const historical = await seedInbound({ suffix: "historical", sentAt: iso(-3_600_000) });
  queueClassifier({
    caseId: "",
    confidence: 0.62,
    noReply: false,
    reason: "new_rates_case",
    proposedName: "Rates request",
    proposedDescription: "Creator asks for campaign rates",
    proposedReply: "Candidate draft for review only.",
  });
  const analyze = unwrap(await index.mixmaxAnalyzeThread.run(callableRequest({ threadId: historical.threadId, connectionId })));
  assert.equal(analyze.status, "needs_review");
  const pendingCase = await doc(`mixmax_cases/${analyze.caseId}`);
  assert.equal(pendingCase.status, "needs_review");
  assert.equal(pendingCase.sourceThreadId, historical.threadId);
  assertNoSend("historical analyze must create review artifacts without sending");

  await db.doc(`mixmax_cases/${analyze.caseId}`).update({
    skeleton: "Only match direct creator rate questions.",
    importNever: "Do not match agency payment disputes.",
    never: "Do not promise a campaign.",
  });
  const approval = await approveCase({ caseId: analyze.caseId, body: "Approved saved response from Handle." });
  const approvedCase = await doc(`mixmax_cases/${analyze.caseId}`);
  assert.equal(approvedCase.policyDigest, core.automationPolicyDigest({
    name: approvedCase.name,
    description: approvedCase.description,
    body: approvedCase.body,
    skeleton: approvedCase.skeleton,
    never: approvedCase.never,
    importNever: approvedCase.importNever,
    draftForbidden: approvedCase.draftForbidden,
    noReplyNeeded: approvedCase.noReplyNeeded,
  }));
  assert.equal(approval.policyDigest, approvedCase.policyDigest);
  assertNoSend("enabling a case must not send to historical mail");

  for (let index = 0; index < 120; index += 1) {
    await db.doc(`mixmax_cases/${run}_context_${index}`).set({
      workspaceId,
      ownerUid,
      caseType: index % 2 === 0 ? "program" : "campaign",
      name: `Context ${index}`,
      description: "Context-only imported program metadata",
      body: "Context only",
      createdAt: iso(),
      updatedAt: iso(),
    });
  }

  const fresh = await seedInbound({ suffix: "fresh", sentAt: iso(1_000) });
  queueClassifier({ caseId: analyze.caseId, confidence: 0.97, noReply: false, reason: "matched_rates" });
  const freshRunId = await enqueue(fresh);
  const freshRun = await job(freshRunId);
  assert.equal(freshRun.status, "sent");
  assert.equal(sendCalls.length, 1);
  assert.match(sendCalls[0].raw, /Approved saved response from Handle\.$/);
  assert.match(sendCalls[0].raw, /\r\nAuto-Submitted: auto-replied\r\n/);
  assert.equal((await doc(`mixmax_sends/auto_${freshRunId}`)).body, "Approved saved response from Handle.");
  const freshPayload = latestClassifierPayload();
  assert.equal(freshPayload.cases.some(row => String(row.id).includes("_context_")), false, "context-only program/campaign cases must not enter classifier routing");
  assert.ok(freshPayload.cases.length >= 1 && freshPayload.cases.length < 120, "101+ context cases must not trip the old registry cap");

  await Promise.all([
    index.mixmaxThreadAutomationEnqueue.run(threadEvent(fresh.threadId, null, fresh.thread)),
    index.mixmaxThreadAutomationEnqueue.run(threadEvent(fresh.threadId, null, fresh.thread)),
  ]);
  const duplicateRuns = await collectionRows("mixmax_automation_runs", "threadId", fresh.threadId);
  assert.equal(duplicateRuns.length, 1, "duplicate thread events must resolve to one automation run");
  const sendsAfterDuplicate = sendCalls.length;
  await Promise.all([
    index.mixmaxAutomationJob.run(runEvent(freshRunId, await doc(`mixmax_automation_runs/${freshRunId}`))),
    index.mixmaxAutomationJob.run(runEvent(freshRunId, await doc(`mixmax_automation_runs/${freshRunId}`))),
  ]);
  assert.equal(sendCalls.length, sendsAfterDuplicate, "duplicate job events must not send twice");

  const sameCaseFollowup = await seedFollowup(fresh, "fresh_followup", iso(1_500));
  queueClassifier({ caseId: analyze.caseId, confidence: 0.97, noReply: false, reason: "matched_rates_again" });
  const sameCaseRunId = await seedRun(sameCaseFollowup);
  const sameCaseRun = await job(sameCaseRunId);
  assert.equal(sameCaseRun.status, "held");
  assert.equal(sameCaseRun.reason, "case_already_sent");

  const lowConfidence = await seedInbound({ suffix: "low_conf", sentAt: iso(2_000) });
  queueClassifier({ caseId: analyze.caseId, confidence: 0.42, noReply: false, reason: "low_confidence", proposedName: "Low confidence", proposedDescription: "Needs human", proposedReply: "Review draft." });
  const lowRunId = await seedRun(lowConfidence);
  const lowRun = await job(lowRunId);
  assert.equal(lowRun.status, "needs_review");
  assert.equal(lowRun.reason, "low_confidence");

  const invalidClassifier = await seedInbound({ suffix: "invalid_classifier", sentAt: iso(2_500) });
  queueClassifier({ caseId: analyze.caseId, confidence: "1", noReply: false, reason: "invalid_confidence_type" });
  const invalidClassifierRunId = await seedRun(invalidClassifier);
  await assertRejectsWithMessage(
    () => job(invalidClassifierRunId),
    /Automation processing failed/,
    "invalid classifier JSON must fail before send",
  );
  assert.equal((await doc(`mixmax_automation_runs/${invalidClassifierRunId}`)).status, "retry");

  const noReply = await seedInbound({ suffix: "noreply", sentAt: iso(3_000) });
  queueClassifier({ caseId: analyze.caseId, confidence: 0.99, noReply: true, reason: "no_reply_needed", proposedName: "FYI", proposedDescription: "No reply", proposedReply: "" });
  const noReplyRunId = await seedRun(noReply);
  const noReplyRun = await job(noReplyRunId);
  assert.equal(noReplyRun.status, "needs_review");
  const noReplyCase = await doc(`mixmax_cases/${noReplyRun.caseId}`);
  assert.equal(noReplyCase.noReplyNeeded, true);
  assert.equal((await collectionRows("mixmax_drafts", "threadId", noReply.threadId)).length, 0, "no-reply candidates must not create review drafts");

  const disabled = await seedInbound({ suffix: "disabled", sentAt: iso(4_000) });
  await approveCase({ caseId: analyze.caseId, enabled: false, body: "Approved saved response from Handle." });
  queueClassifier({ caseId: analyze.caseId, confidence: 0.99, noReply: false, reason: "matched_disabled" });
  await expectHeld(await seedRun(disabled), "case_not_approved");
  await approveCase({ caseId: analyze.caseId, enabled: true, body: "Approved saved response from Handle." });

  const changedPolicy = await seedInbound({ suffix: "changed_policy", sentAt: iso(5_000) });
  await db.doc(`mixmax_cases/${analyze.caseId}`).update({ body: "Edited after approval." });
  queueClassifier({ caseId: analyze.caseId, confidence: 0.99, noReply: false, reason: "matched_changed_policy" });
  await expectHeld(await seedRun(changedPolicy), "case_not_approved");
  await approveCase({ caseId: analyze.caseId, enabled: true, body: "Approved saved response from Handle." });

  const modelPin = await seedInbound({ suffix: "model_pin", sentAt: iso(5_500) });
  const modelCase = await doc(`mixmax_cases/${analyze.caseId}`);
  await db.doc(`mixmax_cases/${analyze.caseId}`).update({
    automation: {
      ...modelCase.automation,
      [connectionId]: { ...modelCase.automation[connectionId], modelVersion: "different-model" },
    },
  });
  queueClassifier({ caseId: analyze.caseId, confidence: 0.99, noReply: false, reason: "matched_old_model" });
  await expectHeld(await seedRun(modelPin), "case_not_approved");
  await approveCase({ caseId: analyze.caseId, enabled: true, body: "Approved saved response from Handle." });

  const paused = await seedInbound({ suffix: "paused", sentAt: iso(6_000) });
  await db.doc(`mixmax_connections/${connectionId}`).update({ automationEnabled: false });
  await expectHeld(await seedRun(paused), "account_paused");
  await db.doc(`mixmax_connections/${connectionId}`).update({ automationEnabled: true, automationEnabledAt: iso(-1_000) });

  const memberDisabled = await seedInbound({ suffix: "member_disabled", sentAt: iso(7_000) });
  await db.doc(`mixmax_members/${ownerUid}`).update({ disabled: true });
  await expectHeld(await seedRun(memberDisabled), "member_inactive");
  await db.doc(`mixmax_members/${ownerUid}`).update({ disabled: false });

  const mutationDuringClassification = await seedInbound({ suffix: "mutation", sentAt: iso(8_000) });
  queueClassifier({ caseId: analyze.caseId, confidence: 0.99, noReply: false, reason: "matched_then_mutated" });
  const mutationRunId = await seedRun(mutationDuringClassification);
  const originalGemini = classifierQueue.length;
  const firstGeminiCallCount = geminiCalls.length;
  beforeGeminiResponse = async () => {
    await approveCase({ caseId: analyze.caseId, enabled: true, body: "Reapproved while classifier was returning." });
  };
  const mutationRun = await job(mutationRunId);
  assert.equal(classifierQueue.length, originalGemini - 1);
  assert.equal(geminiCalls.length, firstGeminiCallCount + 1);
  assert.equal(mutationRun.status, "held");
  assert.equal(mutationRun.reason, "case_not_approved");
  await approveCase({ caseId: analyze.caseId, enabled: true, body: "Approved saved response from Handle." });

  const providerAmbiguous = await seedInbound({ suffix: "provider_ambiguous", sentAt: iso(9_000) });
  const alternateCaseId = `${run}_case_followup`;
  await approveCase({ caseId: alternateCaseId, name: "Follow-up", description: "Creator asks a different follow-up", body: "Alternate approved response." });
  sendFailures.push(503);
  queueClassifier({ caseId: analyze.caseId, confidence: 0.99, noReply: false, reason: "matched_provider_ambiguous" });
  const providerRunId = await seedRun(providerAmbiguous);
  const providerRun = await job(providerRunId);
  assert.equal(providerRun.status, "needs_confirmation");
  assert.equal(providerRun.reason, "provider_uncertain");

  const newerWhileUnknown = await seedFollowup(providerAmbiguous, "provider_newer", iso(9_500));
  queueClassifier({ caseId: alternateCaseId, confidence: 0.99, noReply: false, reason: "newer_while_unknown" });
  const newerRunId = await seedRun(newerWhileUnknown);
  const newerHeld = await job(newerRunId);
  assert.equal(newerHeld.status, "held");
  assert.equal(newerHeld.reason, "send_in_flight");
  const resolved = unwrap(await index.mixmaxResolveAutomationRun.run(callableRequest({ runId: providerRunId, outcome: "not_sent" })));
  assert.equal(resolved.status, "operator_confirmed_not_sent");
  assert.equal((await doc(`mixmax_automation_runs/${newerRunId}`)).status, "pending");

  const classificationBudget = await seedInbound({ suffix: "classification_budget", sentAt: iso(10_000) });
  await db.doc(`mixmax_connections/${connectionId}`).update({ automationDailyClassificationCap: 0 });
  await expectHeld(await seedRun(classificationBudget), "classification_budget");
  await db.doc(`mixmax_connections/${connectionId}`).update({ automationDailyClassificationCap: 100 });

  const sendBudget = await seedInbound({ suffix: "send_budget", sentAt: iso(11_000) });
  const budgetId = core.dailyBudgetId(workspaceId, connectionId, iso());
  await db.doc(`mixmax_automation_budgets/${budgetId}`).set({ workspaceId, connectionId, date: iso().slice(0, 10), sends: 20 }, { merge: true });
  queueClassifier({ caseId: analyze.caseId, confidence: 0.99, noReply: false, reason: "matched_send_budget" });
  await expectHeld(await seedRun(sendBudget), "send_budget");
  await db.doc(`mixmax_automation_budgets/${budgetId}`).delete();

  const activeLease = await seedInbound({ suffix: "active_lease", sentAt: iso(11_500) });
  const activeLeaseRunId = await seedRun(activeLease, { status: "processing", leaseExpiresAt: Date.now() + 300_000, updatedAt: iso() });
  const activeLeaseEvent = { ...(await doc(`mixmax_automation_runs/${activeLeaseRunId}`)), status: "pending" };
  await assertRejectsWithMessage(
    () => index.mixmaxAutomationJob.run(runEvent(activeLeaseRunId, activeLeaseEvent)),
    /Automation lease busy/,
    "active lease redelivery must ask the platform to retry the original event",
  );
  assert.equal((await doc(`mixmax_automation_runs/${activeLeaseRunId}`)).status, "processing");

  const selfProcessing = await seedInbound({ suffix: "self_processing", sentAt: iso(11_700) });
  const selfProcessingRunId = await seedRun(selfProcessing, { status: "processing", attempts: 2, leaseExpiresAt: Date.now() + 300_000, updatedAt: iso() });
  await index.mixmaxAutomationJob.run(runEvent(selfProcessingRunId, await doc(`mixmax_automation_runs/${selfProcessingRunId}`)));
  assert.equal((await doc(`mixmax_automation_runs/${selfProcessingRunId}`)).attempts, 2, "self processing event must be ignored");

  const staleLease = await seedInbound({ suffix: "stale_lease", sentAt: iso(12_000) });
  queueClassifier({ caseId: analyze.caseId, confidence: 0.99, noReply: false, reason: "matched_stale_lease" });
  const staleRunId = await seedRun(staleLease, { status: "processing", leaseExpiresAt: Date.now() - 1_000, updatedAt: iso(-900_000) });
  const staleRun = await job(staleRunId, { eventStatus: "pending" });
  assert.equal(staleRun.status, "sent");

  const attemptCap = await seedInbound({ suffix: "attempt_cap", sentAt: iso(12_500) });
  const attemptCapRunId = await seedRun(attemptCap, { attempts: 5 });
  const attemptCapRun = await job(attemptCapRunId);
  assert.equal(attemptCapRun.status, "failed");
  assert.equal(attemptCapRun.reason, "attempt_limit");

  const oldMessageAfterApproval = await seedInbound({ suffix: "old_after_approval", sentAt: "2020-01-01T00:00:00.000Z" });
  await expectHeld(await seedRun(oldMessageAfterApproval), "account_paused");

  const totalSends = sendCalls.length;
  assert.equal(totalSends, 3, "only fresh, provider-attempt, and stale-lease scenarios should attempt Gmail send");
  assert.equal(tokenRequests, totalSends, "Gmail tokens should only be fetched for actual provider attempts");
  assert.equal(classifierQueue.length, 0, "all queued classifier responses should be consumed");

  console.log("Automation emulator integration passed: analyze review flow, future-only enablement, trigger/job send, duplicate idempotency, policy/account/member/budget/lease/provider guards; all Gemini/Gmail HTTP mocked.");
} finally {
  globalThis.fetch = originalFetch;
  const collections = [
    "mixmax_members",
    "mixmax_connections",
    "mixmax_credentials",
    "mixmax_threads",
    "mixmax_messages",
    "mixmax_cases",
    "mixmax_drafts",
    "mixmax_automation_runs",
    "mixmax_automation_budgets",
    "mixmax_sends",
    "mixmax_sync_jobs",
  ];
  for (const collection of collections) {
    const rows = await db.collection(collection).where("workspaceId", "==", workspaceId).get().catch(() => ({ docs: [] }));
    for (const row of rows.docs) await row.ref.delete().catch(() => undefined);
  }
  await Promise.all([
    db.doc(`mixmax_members/${ownerUid}`).delete().catch(() => undefined),
    db.doc(`mixmax_connections/${connectionId}`).delete().catch(() => undefined),
    db.doc(`mixmax_credentials/${connectionId}`).delete().catch(() => undefined),
  ]);
  await db.terminate();
}
