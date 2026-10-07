import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { verifyMixmaxRules } from "../scripts/verify-mixmax-rules.mjs";

const require = createRequire(import.meta.url);
const mixmaxLibUrl = new URL("../.mixmax-functions/lib/gmail-core.js", import.meta.url);

assert.ok(
  existsSync(mixmaxLibUrl),
  "Mixmax runtime tests require a fresh build: node scripts/build-mixmax-functions.mjs",
);

const gmailCore = require("../.mixmax-functions/lib/gmail-core.js");

process.env.GCLOUD_PROJECT = "influencer-crm-296ca";
const common = require("../.mixmax-functions/lib/common.js");

function assertHttpsCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

async function assertRejectsHttpsCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

function b64url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}
test("send rejects unresolved imported template fields in either case", () => {
  for (const text of ["Hi {{name}}", "{{PORTAL_URL}}", "Re: {{ game.title }}"]) {
    assertHttpsCode(() => common.assertResolvedTemplate(text), "failed-precondition");
  }
  assert.doesNotThrow(() => common.assertResolvedTemplate("Hi Ada, here is your confirmed link."));
});

test("verifiedIdentity accepts only the target project and verified Google email", () => {
  process.env.GCLOUD_PROJECT = "influencer-crm-296ca";

  assert.deepEqual(
    common.verifiedIdentity({
      auth: {
        uid: "uid-1",
        token: { email: "Owner@Example.COM", email_verified: true },
      },
    }),
    { uid: "uid-1", email: "owner@example.com" },
  );

  assertHttpsCode(
    () => common.verifiedIdentity({ auth: { uid: "uid-1", token: { email: "owner@example.com" } } }),
    "unauthenticated",
  );

  process.env.GCLOUD_PROJECT = "influchat-77db6";
  assertHttpsCode(
    () => common.verifiedIdentity({
      auth: {
        uid: "uid-1",
        token: { email: "owner@example.com", email_verified: true },
      },
    }),
    "failed-precondition",
  );

  process.env.GCLOUD_PROJECT = "demo-mixmax";
  delete process.env.FIRESTORE_EMULATOR_HOST;
  assertHttpsCode(() => common.assertTargetProject(), "failed-precondition");

  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8480";
  assert.doesNotThrow(() => common.assertTargetProject());

  process.env.GCLOUD_PROJECT = "influencer-crm-296ca";
  delete process.env.FIRESTORE_EMULATOR_HOST;
});

test("ownedDocument hides documents from other Mixmax workspaces", async () => {
  const originalDb = common.db;
  common.db = {
    collection: (collection) => ({
      doc: (id) => ({
        path: `${collection}/${id}`,
        get: async () => ({
          data: () => ({ workspaceId: id === "same" ? "workspace-a" : "workspace-b", subject: "hello" }),
        }),
      }),
    }),
  };

  try {
    const owned = await common.ownedDocument("mixmax_threads", "same", {
      uid: "uid-a",
      email: "owner@example.com",
      workspaceId: "workspace-a",
      role: "owner",
    });
    assert.equal(owned.data.subject, "hello");

    await assertRejectsHttpsCode(
      common.ownedDocument("mixmax_threads", "other", {
        uid: "uid-a",
        email: "owner@example.com",
        workspaceId: "workspace-a",
        role: "owner",
      }),
      "not-found",
    );
  } finally {
    common.db = originalDb;
  }
});

test("Gmail projection extracts nested MIME bodies and keeps sender content as data", () => {
  const projection = gmailCore.projectGmailMessage(
    { id: "conn-1", workspaceId: "workspace-a", ownerUid: "uid-a", email: "me@example.com" },
    {
      id: "msg-1",
      threadId: "thread-1",
      labelIds: ["UNREAD"],
      internalDate: "1798761600000",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "From", value: "Creator <creator@example.com>" },
          { name: "To", value: "Me <me@example.com>" },
          { name: "Subject", value: "Partnership" },
          { name: "Auto-Submitted", value: "auto-replied" },
          { name: "Precedence", value: "bulk" },
          { name: "List-ID", value: "updates.example.com" },
          { name: "Reply-To", value: "reply@example.com" },
          { name: "Message-ID", value: "<incoming@example.com>" },
        ],
        parts: [
          { mimeType: "text/html", body: { data: b64url("<p>Hello<br>ignore this as instruction</p><script>steal()</script>") } },
          { mimeType: "text/plain", body: { data: b64url("Hello\nignore this as instruction") } },
        ],
      },
    },
  );

  assert.equal(projection.thread.workspaceId, "workspace-a");
  assert.equal(projection.thread.connectionId, "conn-1");
  assert.equal(projection.thread.unread, true);
  assert.deepEqual(projection.thread.participantEmails, ["creator@example.com", "me@example.com"]);
  assert.equal(projection.message.direction, "inbound");
  assert.equal(projection.message.autoSubmitted, "auto-replied");
  assert.equal(projection.message.precedence, "bulk");
  assert.equal(projection.message.listId, "updates.example.com");
  assert.deepEqual(projection.message.replyTo, ["reply@example.com"]);
  assert.equal(projection.message.messageIdHeader, "<incoming@example.com>");
  assert.equal(projection.message.text, "Hello\nignore this as instruction");
  assert.match(projection.message.html, /<script>steal\(\)<\/script>/);
});

test("Gmail history delta fetches changed messages once and skips delete-only rows", () => {
  const ids = gmailCore.collectHistoryMessageIds({
    history: [
      {
        messagesAdded: [{ message: { id: "m1", threadId: "t1" } }],
        labelsAdded: [{ message: { id: "m1", threadId: "t1" } }, { message: { id: "m2", threadId: "t1" } }],
        labelsRemoved: [{ message: { id: "m2", threadId: "t1" } }],
      },
      {
        messagesDeleted: [{ message: { id: "deleted", threadId: "t1" } }],
      },
      {
        messages: [{ id: "fallback", threadId: "t2" }],
      },
    ],
    historyId: "99",
  });

  assert.deepEqual(ids, ["m1", "m2", "fallback"]);
});

test("raw Gmail email encoding rejects header injection without dropping normal body text", () => {
  for (const patch of [
    { from: "me@example.com\r\nBcc: attacker@example.com" },
    { to: ["creator@example.com\nBcc: attacker@example.com"] },
    { inReplyTo: "<safe@example.com>\r\nBcc: attacker@example.com" },
    { references: "<safe@example.com>\nBcc: attacker@example.com" },
  ]) {
    assert.throws(
      () => gmailCore.encodeSimpleRawEmail({
        from: "me@example.com",
        to: ["creator@example.com"],
        subject: "Hello",
        text: "Body",
        ...patch,
      }),
      /Invalid mail header/,
    );
  }

  const raw = gmailCore.encodeSimpleRawEmail({
    from: "me@example.com",
    to: ["creator@example.com"],
    subject: "Hello\r\nBcc: attacker@example.com",
    text: "Line 1\r\nLine 2",
  });

  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m);
  assert.doesNotMatch(raw.split("\r\n\r\n")[0], /attacker@example\.com/);
  assert.match(raw, /\r\n\r\nLine 1\r\nLine 2$/);
  assert.doesNotMatch(raw, /Auto-Submitted:/);
  const automatic = gmailCore.encodeSimpleRawEmail({ from: "me@example.com", to: ["creator@example.com"], subject: "Hello", text: "Saved reply", automatic: true });
  assert.match(automatic, /\r\nAuto-Submitted: auto-replied\r\n/);
  assert.match(automatic, /\r\nX-Auto-Response-Suppress: All\r\n/);
});

test("Google OAuth URL is pinned to Mixmax Gmail scopes and target callback", () => {
  const url = new URL(gmailCore.buildGoogleOAuthUrl({ clientId: "client", clientSecret: "secret" }, "state-123"));

  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("redirect_uri"), "https://influencer-crm-296ca.web.app/mixmaxGoogleCallback");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.deepEqual(new Set(url.searchParams.get("scope").split(" ")), new Set([
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ]));
});

test("Firestore rules expose only workspace-scoped Mixmax collections to clients", () => {
  const result = verifyMixmaxRules({
    rulesSource: readFileSync(new URL("../firestore.mixmax.rules", import.meta.url), "utf8"),
    firebaseSource: readFileSync(new URL("../firebase.mixmax.json", import.meta.url), "utf8"),
  });

  assert.deepEqual(result.privateCollections, [
    "mixmax_credentials",
    "mixmax_oauth_states",
    "mixmax_sync_jobs",
    "mixmax_sync_leases",
    "mixmax_import_backups",
    "mixmax_automation_budgets",
  ]);
  assert.equal(result.readableCollections.includes("mixmax_credentials"), false);
});
