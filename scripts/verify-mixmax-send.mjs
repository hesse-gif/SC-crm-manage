import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Run after `node scripts/build-mixmax-functions.mjs`:
//   firebase emulators:exec --only firestore --project demo-mixmax "GCLOUD_PROJECT=demo-mixmax node scripts/verify-mixmax-send.mjs"
if (
  process.env.GCLOUD_PROJECT !== "demo-mixmax" ||
  !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")
) {
  throw new Error("Send guard test requires the local demo-mixmax Firestore emulator");
}

process.env.MIXMAX_GOOGLE_CLIENT_ID = "emulator-client";
process.env.MIXMAX_GOOGLE_CLIENT_SECRET = "emulator-secret";
process.env.MIXMAX_GOOGLE_OAUTH_READY = "true";
process.env.FUNCTIONS_EMULATOR = "true";

const require = createRequire(resolve("functions/package.json"));
const { db } = require(resolve(".mixmax-functions/lib/common.js"));
const { sendForConnection, GmailSendAttemptError } = require(resolve(".mixmax-functions/lib/gmail.js"));
const { mixmaxSendMail } = require(resolve(".mixmax-functions/lib/workspace.js"));

const runId = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const workspaceId = `send_guard_${runId}`;
const ownerUid = `owner_${runId}`;
const ownerEmail = `owner-${runId}@example.com`;
const connectionId = `conn_${runId}`;
const threadId = `thread_${runId}`;
const messageId = `msg_${runId}`;
const gmailThreadId = `gmail_thread_${runId}`;
let latestGmailMessageId = "gmail_inbound_1";
let sendResponseStatus = 200;
let sendCalls = [];
let tokenRequests = 0;
let threadRequests = 0;

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

function errorCode(error) {
  return typeof error?.code === "string" ? error.code.replace(/^functions\//, "") : "";
}

function decodedRaw(body) {
  const parsed = JSON.parse(body);
  return Buffer.from(parsed.raw, "base64url").toString("utf8");
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
    tokenRequests += 1;
    return response({ access_token: "local-only-token" });
  }
  if (url.origin !== "https://gmail.googleapis.com") throw new Error(`Unexpected external request: ${url.toString()}`);
  if (url.pathname.endsWith(`/threads/${encodeURIComponent(gmailThreadId)}`)) {
    threadRequests += 1;
    return response({
      messages: [{
        id: latestGmailMessageId,
        threadId: gmailThreadId,
        payload: { headers: [{ name: "Message-ID", value: `<${latestGmailMessageId}@example.com>` }] },
      }],
    });
  }
  if (url.pathname.endsWith("/messages/send")) {
    sendCalls.push({ raw: decodedRaw(init.body), body: JSON.parse(init.body) });
    return response(sendResponseStatus === 200 ? { id: `sent_${sendCalls.length}`, threadId: gmailThreadId } : { error: "temporarily unavailable" }, sendResponseStatus);
  }
  throw new Error(`Unmocked Gmail path: ${url.pathname}`);
};

try {
  await Promise.all([
    db.doc(`mixmax_members/${ownerUid}`).set({ uid: ownerUid, email: ownerEmail, workspaceId, role: "owner" }),
    db.doc(`mixmax_connections/${connectionId}`).set({ workspaceId, ownerUid, email: ownerEmail, status: "connected" }),
    db.doc(`mixmax_credentials/${connectionId}`).set({ workspaceId, ownerUid, refreshToken: "emulator-refresh-token" }),
    db.doc(`mixmax_threads/${threadId}`).set({
      workspaceId,
      source: "gmail",
      connectionId,
      gmailThreadId,
      latestMessageId: messageId,
      latestMessageDirection: "inbound",
      automationSendingRunId: `run_${runId}`,
      subject: "Race guard",
    }),
  ]);

  const sent = await sendForConnection(
    connectionId,
    { from: ownerEmail, to: ["creator@example.com"], subject: "Auto reply", text: "Saved response", automatic: true },
    gmailThreadId,
    { expectedGmailMessageId: latestGmailMessageId },
  );
  assert.equal(sent.id, "sent_1");
  assert.equal(sendCalls.length, 1, "matching provider state should send exactly once");
  assert.match(sendCalls[0].raw, /\r\nAuto-Submitted: auto-replied\r\n/);
  assert.match(sendCalls[0].raw, /\r\nX-Auto-Response-Suppress: All\r\n/);
  assert.match(sendCalls[0].raw, /\r\nIn-Reply-To: <gmail_inbound_1@example\.com>\r\n/);

  latestGmailMessageId = "gmail_inbound_2";
  const staleSendCount = sendCalls.length;
  await assert.rejects(
    () => sendForConnection(
      connectionId,
      { from: ownerEmail, to: ["creator@example.com"], subject: "Stale auto reply", text: "Saved response", automatic: true },
      gmailThreadId,
      { expectedGmailMessageId: "gmail_inbound_1" },
    ),
    (error) => {
      assert.ok(error instanceof GmailSendAttemptError);
      assert.equal(error.uncertain, false, "stale provider thread must be a known no-send failure");
      return true;
    },
  );
  assert.equal(sendCalls.length, staleSendCount, "stale provider thread must not call Gmail send");

  latestGmailMessageId = "gmail_inbound_3";
  const beforeSendCount = sendCalls.length;
  await assert.rejects(
    () => sendForConnection(
      connectionId,
      { from: ownerEmail, to: ["creator@example.com"], subject: "Claim lost", text: "Saved response", automatic: true },
      gmailThreadId,
      { expectedGmailMessageId: latestGmailMessageId, beforeSend: async () => { throw new Error("claim lost"); } },
    ),
    (error) => {
      assert.ok(error instanceof GmailSendAttemptError);
      assert.equal(error.uncertain, false, "beforeSend rejection must be a known no-send failure");
      return true;
    },
  );
  assert.equal(sendCalls.length, beforeSendCount, "beforeSend rejection must not call Gmail send");

  sendResponseStatus = 503;
  await assert.rejects(
    () => sendForConnection(
      connectionId,
      { from: ownerEmail, to: ["creator@example.com"], subject: "Ambiguous provider", text: "Saved response", automatic: true },
      gmailThreadId,
      { expectedGmailMessageId: latestGmailMessageId },
    ),
    (error) => {
      assert.ok(error instanceof GmailSendAttemptError);
      assert.equal(error.uncertain, true, "5xx Gmail send failure must require confirmation before retry");
      return true;
    },
  );
  assert.equal(sendCalls.length, beforeSendCount + 1, "provider ambiguity happens after one Gmail send attempt");

  const manualSendCount = sendCalls.length;
  const manualTokenCount = tokenRequests;
  await assert.rejects(
    () => mixmaxSendMail.run(callableRequest({
      connectionId,
      threadId,
      to: "creator@example.com",
      subject: "Manual reply",
      body: "I will take this one.",
      requestId: `manual_${runId}`,
    })),
    (error) => {
      assert.equal(errorCode(error), "failed-precondition", "manual send must wait while automation send is in-flight");
      return true;
    },
  );
  assert.equal(sendCalls.length, manualSendCount, "manual in-flight guard must not call Gmail send");
  assert.equal(tokenRequests, manualTokenCount, "manual in-flight guard must reject before refreshing Gmail tokens");

  assert.ok(threadRequests >= 4, "provider thread metadata was checked before automatic sends");
  console.log("Send guard integration passed: automatic headers, stale provider no-send, beforeSend no-send, 5xx confirmation, manual in-flight guard; all Gmail HTTP mocked.");
} finally {
  globalThis.fetch = originalFetch;
  await Promise.all([
    db.doc(`mixmax_members/${ownerUid}`).delete().catch(() => undefined),
    db.doc(`mixmax_connections/${connectionId}`).delete().catch(() => undefined),
    db.doc(`mixmax_credentials/${connectionId}`).delete().catch(() => undefined),
    db.doc(`mixmax_threads/${threadId}`).delete().catch(() => undefined),
    db.doc(`mixmax_messages/${messageId}`).delete().catch(() => undefined),
    db.doc(`mixmax_sends/${ownerUid}_manual_${runId}`).delete().catch(() => undefined),
    db.doc(`mixmax_sync_jobs/${connectionId}`).delete().catch(() => undefined),
  ]);
  await db.terminate();
}
