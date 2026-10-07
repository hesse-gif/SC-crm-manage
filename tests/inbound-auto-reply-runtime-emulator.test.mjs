// Runtime proof for the scoped inbound auto-reply human-approval exception.
//
// This intentionally drives the real compiled receiveEmail -> auto_reply_queue ->
// processAutoReplyQueue path. nodemailer is intercepted before chat-ai is imported, so no
// provider or network call can escape the process.
//
// Run serially because settings/default, integrations/default, provider attestation, Permit,
// and auto-reply counters are shared emulator fixtures:
//   npm --prefix functions run build
//   firebase emulators:exec --only auth,firestore --project demo-flu \
//     "node --test --test-concurrency=1 tests/inbound-auto-reply-runtime-emulator.test.mjs"
import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { autoReplyPacingTestOverrides } from "./helpers/auto-reply-pacing-test-overrides.mjs";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("FIRESTORE_EMULATOR_HOST must be set — this is an emulator-only runtime test.");
}

const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-flu";
assert.equal(PROJECT, "demo-flu", "runtime mail proof may only use the demo-flu emulator project");
delete process.env.FUNCTIONS_EMULATOR;
process.env.GCLOUD_PROJECT = PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
process.env.FIREBASE_CONFIG ||= JSON.stringify({ projectId: PROJECT });
process.env.FLU_RUNTIME_ENV = "emulator";
process.env.FLU_FIRESTORE_DATABASE = "(default)";
process.env.FLU_FUNCTIONS_CODEBASE = "default";

const MAILBOX = "scp@supercent.io";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "1025";
process.env.SMTP_USER = MAILBOX;
process.env.SMTP_FROM = MAILBOX;
process.env.IMAP_HOST = "127.0.0.1";
process.env.IMAP_PORT = "993";
process.env.IMAP_USER = MAILBOX;
process.env.SMTP_PASSWORD ||= "inbound-runtime-emulator-smtp-password";
process.env.IMAP_PASSWORD ||= "inbound-runtime-emulator-imap-password";

const smtpCalls = [];
const originalLoad = Module._load;
Module._load = function inboundRuntimeTransportStub(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (request === "nodemailer") {
    const target = loaded?.default ?? loaded;
    if (target && !target.__inboundRuntimePatched) {
      target.__inboundRuntimePatched = true;
      target.createTransport = () => ({
        sendMail: async (message) => {
          smtpCalls.push({
            to: message?.to,
            from: message?.from,
            subject: message?.subject,
            text: message?.text,
            inReplyTo: message?.inReplyTo,
            references: message?.references,
          });
          return {
            messageId: `inbound-runtime-${smtpCalls.length}@example.test`,
            accepted: [message?.to],
            rejected: [],
          };
        },
        verify: async () => true,
        close: () => {},
      });
    }
  }
  return loaded;
};

const requireFromFunctions = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = requireFromFunctions("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const chatAi = await import(new URL("../functions/lib/chat-ai.js", import.meta.url));
const permit = await import(new URL("../functions/lib/chatAutoCasePermit.js", import.meta.url));
const permitStore = await import(new URL("../functions/lib/chatAutoCasePermitStore.js", import.meta.url));
const profiles = await import(new URL("../functions/lib/mailProfiles.js", import.meta.url));
const attest = await import(new URL("../functions/lib/mailProviderAttestation.js", import.meta.url));
const safety = await import(new URL("../functions/lib/mailOutboundSafety.js", import.meta.url));

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const CASE_ID = "interest_next_steps";
const MODEL = "gemini-2.5-flash";
const PROGRAM_ID = `inbound-runtime-program-${RUN}`;
const PERMIT_PATH = `${permit.CHAT_AUTO_CASE_PERMIT_COLLECTION}/${CASE_ID}`;
const SHARED_PATHS = [
  "settings/default",
  "settings/email",
  "integrations/default",
  safety.OUTBOUND_SAFETY_STATE_PATH,
  attest.MAIL_PROVIDER_ATTESTATION_PATH,
  PERMIT_PATH,
  `auto_reply_daily_counters/${koreaDayKey(new Date())}`,
  `auto_reply_hourly_counters/${koreaHourKey(new Date())}`,
];
const sharedSnapshots = new Map();

async function snapshot(path) {
  const row = await db.doc(path).get();
  return row.exists ? { exists: true, data: row.data() } : { exists: false, data: null };
}

async function restore(path, saved) {
  if (saved.exists) await db.doc(path).set(saved.data, { merge: false });
  else await db.doc(path).delete().catch(() => undefined);
}

function koreaDayKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function koreaHourKey(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}`;
}

function closedBusinessWindowForNow() {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", hour: "2-digit", hourCycle: "h23",
  }).format(new Date()));
  const startHour = (hour + 2) % 24;
  const endHour = (hour + 3) % 24;
  return { enabled: true, startHour, startMinute: 0, endHour, endMinute: 0, weekdaysOnly: false };
}

async function configurePolicy({
  humanApprovalRequired = true,
  allowedAccountIds = ["scp"],
  liveSendEnabled = true,
  dryRunDefault = false,
  maxDailyAutoSends = 100000,
  businessHours,
} = {}) {
  await db.doc("settings/default").set({
    automation: autoReplyPacingTestOverrides({
      aiAutomationEnabled: true,
      autoReplyEnabled: true,
      liveSendEnabled,
      humanApprovalRequired,
      inboundAutoReplyAllowedMailAccountIds: allowedAccountIds,
      // auto-reply-approval-bypass (2026-09-25): this file's whole purpose is proving the
      // trusted-inbound-mailbox exception's OWN scoping/revocation/tamper invariants (this
      // policy's allowedAccountIds above, in particular) — explicitly keep the new, independent
      // Permit-provenance bypass (default true) OFF here so revoking allowedAccountIds keeps
      // blocking dispatch exactly as this file expects. By 헤세's design the Permit-provenance
      // bypass is deliberately NOT gated by inboundAutoReplyAllowedMailAccountIds — it has its
      // own kill-switch and its own coverage in tests/auto-reply-approval-bypass.test.mjs.
      autoReplyBypassesProfileHumanApproval: false,
      minReplyDelayMinutes: 0,
      autoReplyJitterMaxMinutes: 0,
      autoReplyBurstSpreadMinutes: 0,
      maxDailyAutoSends,
      ...(businessHours ? { autoReplyBusinessHoursKst: businessHours } : {}),
    }),
    programAi: {
      enabled: true,
      dryRunDefault,
      minProgramReplyDelayMinutes: 0,
      maxPerProgramDailySends: 100000,
    },
    humanReviewPolicy: { lowDataReviewMode: "lenient" },
    llmModelRoutes: { auto_reply_draft: MODEL },
    mailSafety: {
      emergencyShutdownEnabled: false,
      emergencyKeywords: [],
      blockedEmails: [],
      blockedDomains: [],
      suppressedHandles: [],
      outboundPolicy: {
        weeklyTotalCap: 100000,
        dailyCap: 100000,
        hourlyCap: 100000,
        burstCap: 100000,
        uniqueRecipientDailyCap: 100000,
        jitterMinSeconds: 0,
        jitterMaxSeconds: 0,
      },
    },
  }, { merge: true });
}

async function activateMailProviderAttestation() {
  const identity = await profiles.resolveOperationalMailIdentity();
  assert.equal(identity.identityMatch, true, `canonical mail identity mismatch (${identity.identityCode})`);
  const receipt = attest.buildMailProviderAttestationReceipt({
    identity,
    diagnostic: {
      configFingerprint: identity.configFingerprint,
      diagnosticReceiptHash: "f".repeat(64),
      checkedAtIso: new Date().toISOString(),
      expiresAtIso: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    actorHash: attest.hashMailProviderAttestationActor(`inbound-runtime-${RUN}`),
  });
  await db.doc(attest.MAIL_PROVIDER_ATTESTATION_PATH).set(receipt, { merge: false });
}

async function armPermit() {
  const now = new Date();
  const pin = permit.chatAutoCasePermitPin(MODEL);
  await permitStore.setChatAutoCasePermitFromVerifiedEvidence({
    caseId: CASE_ID,
    requestedState: "armed",
    pin,
    counters: {
      consecutiveHumanUneditedApprovedSent: permit.CHAT_AUTO_MIN_CONSECUTIVE_UNEDITED_APPROVED_SENDS,
      totalHumanUneditedApprovedSent: permit.CHAT_AUTO_MIN_CONSECUTIVE_UNEDITED_APPROVED_SENDS,
      lastEligibleMessageRef: `message_sources/inbound-runtime-permit-${RUN}`,
      lastResetAtIso: null,
      lastResetReason: null,
      unavailableEvidenceCount: 0,
    },
    evalEvidence: {
      status: "passed",
      runId: `inbound-runtime-eval-${RUN}`,
      buildSha: `inbound-runtime-build-${RUN}`,
      kRevision: `inbound-runtime-k-${RUN}`,
      casebookHash: pin.casebookHash,
      modelVersion: pin.modelVersion,
      // Every negative dispatch may add newer adverse evidence. Re-arming uses a fresh verified
      // run at this call's clock, and the synthetic inbound is received immediately afterward.
      evaluatedAtIso: now.toISOString(),
      expiresAtIso: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      actualGatewayCall: true,
      bypassGatewayCache: true,
      // evalEvidencePasses requires decisionCount === heldout.total + reroll.total.
      heldout: { total: 1, passed: 1, failed: 0 },
      reroll: { total: 1, stable: 1, unstable: 0 },
      decisions: { allow: 1, deny: 1, unavailable: 0 },
      transports: ["ai_hub_gateway"],
      estimatedCostUsd: 0,
    },
    actorUid: `inbound-runtime-${RUN}`,
    actorRole: "admin",
    nowIso: now.toISOString(),
  });
}

function gatewayStub() {
  return {
    runGatewayLive: async () => ({
      caseId: CASE_ID,
      summaryKr: "다음 단계 안내 요청",
      draftText: "This freeform model draft must not replace the server casebook draft.",
      draftPreview: "This freeform model draft must not replace the server casebook draft.",
      draftRef: `inbound-runtime-draft-${RUN}`,
      messageRef: "",
      trackingId: "",
      humanGate: { decision: "auto_reply", reason: "safe next-step request", ruleIds: ["safe-info-request-auto-reply"] },
      inboundIntent: { id: CASE_ID, source: "rule" },
      cache: { hit: false, key: `inbound-runtime-cache-${RUN}` },
      costLog: {
        transport: "ai_hub_gateway", provider: "ai-hub", model: MODEL,
        estimatedCostUsd: 0, ledgerRef: `inbound-runtime-cost-${RUN}`,
      },
    }),
  };
}

function creatorEmail(seed) {
  // gmail.com has stable MX evidence; SMTP itself remains fully intercepted below.
  return `creator-${RUN}-${seed}@gmail.com`;
}

async function seedAttribution(seed) {
  const email = creatorEmail(seed);
  await db.collection("program_applications").doc(`inbound-runtime-app-${RUN}-${seed}`).set({
    programId: PROGRAM_ID,
    email,
    ownerUid: `inbound-runtime-owner-${RUN}`,
  }, { merge: true });
}

function receiveRequest(seed, { trusted = true, includeAccount = true, dryRun = false, liveSend } = {}) {
  const email = creatorEmail(seed);
  return {
    auth: {
      uid: `inbound-runtime-admin-${RUN}`,
      token: { role: "admin", team: "AIX", email: "admin@supercent.io" },
    },
    data: {
      // Put the scenario discriminator first: several durable IDs are deliberately truncated to
      // bounded lengths, so a long common prefix would collapse otherwise independent cases.
      conversationId: `irc-${seed}-${RUN}`,
      trackingId: `irt-${seed}-${RUN}`,
      messageRef: `irm-${seed}-${RUN}`,
      from: email,
      creatorEmail: email,
      to: MAILBOX,
      subject: "Re: Super Creator Partners",
      body: "Could you send the brief and next steps?",
      signal: "Could you send the brief and next steps?",
      gameId: PROGRAM_ID,
      programId: PROGRAM_ID,
      receivedAtIso: new Date().toISOString(),
      imapIngestPayload: true,
      skipLiveImapRead: true,
      allowMockGatewayFallback: true,
      dryRun,
      ...(typeof liveSend === "boolean" ? { liveSend } : {}),
      ...(includeAccount ? { mailAccountId: "scp", accountMailbox: MAILBOX } : {}),
    },
    rawRequest: { ip: "127.0.0.1" },
    ...(trusted ? { internalTrustedInvocation: true } : {}),
  };
}

async function receiveQueued(seed, options = {}) {
  await configurePolicy(options.policy);
  await armPermit();
  await seedAttribution(seed);
  const response = await chatAi.receiveEmail(receiveRequest(seed, options.request), gatewayStub());
  const source = await db.doc(response.messageRef).get();
  const conversation = await db.doc(response.conversationRef).get();
  assert.equal(response.queueState, "queued_for_send", `${seed}: receiveEmail did not create a live queue: ${JSON.stringify({
    permitDenyReasons: source.get("permitDenyReasons"),
    autoReplyBlockedReason: source.get("autoReplyBlockedReason"),
    sourceQueueState: source.get("queueState"),
    conversationStatus: conversation.get("autoReplyStatus"),
  })}`);
  const queuePath = conversation.get("autoReplyQueueRef");
  assert.match(String(queuePath), /^auto_reply_queue\//, `${seed}: queue ref missing`);
  const queue = await db.doc(queuePath).get();
  assert.equal(queue.exists, true, `${seed}: queue row missing`);
  return { response, source, conversation, queuePath, queue };
}

async function runWithoutSmtp(label, mutate, { policy, request } = {}) {
  const row = await receiveQueued(label, { policy, request });
  await mutate(row);
  const before = smtpCalls.length;
  const result = await chatAi.processAutoReplyQueue();
  assert.equal(smtpCalls.length, before, `${label}: blocked runtime reached SMTP`);
  const queue = await db.doc(row.queuePath).get();
  assert.notEqual(queue.get("status"), "sent", `${label}: blocked runtime was recorded as sent`);
  // Every case is an isolated synthetic conversation. Remove its one-shot case reservation so
  // the next matrix row cannot inherit a durable reservation if canonical ID normalization
  // intentionally converges two synthetic fixtures.
  const caseIntentRef = row.queue.get("caseIntentRef");
  if (typeof caseIntentRef === "string" && /^auto_reply_case_intents\/[^/]+$/.test(caseIntentRef)) {
    await db.doc(caseIntentRef).delete();
  }
  return { ...row, result, queue };
}

before(async () => {
  for (const path of SHARED_PATHS) sharedSnapshots.set(path, await snapshot(path));
  await Promise.all([
    db.doc(`auto_reply_daily_counters/${koreaDayKey(new Date())}`).set({ sent: 0, updatedAtIso: new Date().toISOString() }, { merge: true }),
    db.doc(`auto_reply_hourly_counters/${koreaHourKey(new Date())}`).set({ sent: 0, updatedAtIso: new Date().toISOString() }, { merge: true }),
    db.collection("programs").doc(PROGRAM_ID).set({ id: PROGRAM_ID, title: "Inbound runtime fixture" }, { merge: true }),
    db.doc("settings/email").set({ practiceMode: false, updatedAt: new Date().toISOString(), updatedBy: `inbound-runtime-${RUN}` }, { merge: true }),
    db.doc("integrations/default").set({
      mailSmtp: {
        public: { host: "127.0.0.1", port: 1025, secure: false, username: MAILBOX, fromAddress: MAILBOX },
        secrets: {},
      },
      mailImap: {
        public: { host: "127.0.0.1", port: 993, secure: true, username: MAILBOX, mailbox: "INBOX" },
        secrets: {},
      },
    }, { merge: true }),
  ]);
  await configurePolicy();
  await safety.setOutreachSendingEnabled(true, `inbound-runtime-${RUN}`, new Date().toISOString());
  await activateMailProviderAttestation();
});

after(async () => {
  Module._load = originalLoad;
  for (const [path, saved] of sharedSnapshots) await restore(path, saved);
});

test("trusted inbound auto-reply exception is scoped, revocable, and preserves all prior send gates", async () => {
  // Positive: a real receiveEmail invocation writes the server-only marker, queues, and the real
  // worker calls the strictly mocked transport exactly once for the same creator/account.
  const positive = await receiveQueued("positive");
  assert.deepEqual(positive.source.get("inboundMailProvenance"), { kind: "imap", accountId: "scp", mailbox: MAILBOX });
  assert.deepEqual(positive.queue.get("inboundMailProvenance"), { kind: "imap", accountId: "scp", mailbox: MAILBOX });
  assert.equal(positive.source.get("mailAccountId"), "scp");
  assert.equal(positive.source.get("accountMailbox"), MAILBOX);
  assert.equal(positive.queue.get("mailAccountId"), "scp");
  assert.equal(positive.queue.get("accountMailbox"), MAILBOX);
  const positiveBefore = smtpCalls.length;
  const positiveResult = await chatAi.processAutoReplyQueue();
  const positiveQueueAfter = await db.doc(positive.queuePath).get();
  assert.equal(positiveResult.confirmedSent, 1, JSON.stringify({
    result: positiveResult,
    queueStatus: positiveQueueAfter.get("status"),
    failureReason: positiveQueueAfter.get("failureReason"),
    errorCode: positiveQueueAfter.get("errorCode"),
    smtpDelta: smtpCalls.length - positiveBefore,
  }));
  assert.equal(smtpCalls.length, positiveBefore + 1, "trusted SCP inbound must reach SMTP exactly once");
  assert.equal(smtpCalls.at(-1)?.to, creatorEmail("positive"));
  assert.match(String(smtpCalls.at(-1)?.from), /scp@supercent\.io/i);
  // Flu conversation org-filter round 22 (codex adversarial review round 22, finding #1): the
  // outbox pager (mailSignature.ts pageAuthorizedOutboxRows) gates scp rows by the mail_outbound_log
  // receipt's OWN mailAccountId — auto-reply never stamped it before this round, so a real
  // confirmed scp-sent auto-reply's receipt read as unstamped/legacy and bypassed the scp
  // grant+org check entirely. This is the one place in this file that reaches a genuine confirmed
  // send end-to-end (receiveEmail -> queue -> processAutoReplyQueue -> recordMailOutboundLog), so
  // assert the fix here rather than duplicating this entire harness in a new file.
  const positiveOutboxReceipt = await db.collection("mail_outbound_log").doc(`irt-positive-${RUN}`).get();
  assert.equal(positiveOutboxReceipt.exists, true, "the confirmed send must have written its own mail_outbound_log receipt");
  assert.equal(
    positiveOutboxReceipt.get("mailAccountId"),
    "scp",
    "auto-reply's outbox receipt must carry the resolved sender mailAccountId",
  );
  const positiveAgain = await chatAi.processAutoReplyQueue();
  assert.equal(smtpCalls.length, positiveBefore + 1, "a sent queue must not send twice");
  assert.equal(positiveAgain.confirmedSent, 0);
  await db.doc(positive.queue.get("caseIntentRef")).delete();

  // Public SEND_ROLE cannot forge the marker. It is downgraded before queue creation under the
  // human-approval-required profile, even with byte-identical marker-looking payload fields.
  await configurePolicy();
  await armPermit();
  await seedAttribution("public-forgery");
  const publicBefore = smtpCalls.length;
  await assert.rejects(
    () => chatAi.receiveEmail(receiveRequest("public-forgery", { trusted: false }), gatewayStub()),
    (error) => error?.code === "failed-precondition",
    "public SEND_ROLE must not retain the internal IMAP/fallback markers",
  );
  assert.equal((await db.doc(`message_sources/irm-public-forgery-${RUN}`).get()).exists, false);
  assert.equal(smtpCalls.length, publicBefore);

  // Dispatch re-binds every server-owned axis. Each row was genuinely queued by receiveEmail;
  // only the indicated durable evidence is poisoned after enqueue.
  const poisonCases = [
    ["poison-job-recipient", async ({ queuePath }) => db.doc(queuePath).set({ to: `attacker-${RUN}@example.com` }, { merge: true })],
    ["poison-source-ref", async ({ queuePath }) => db.doc(queuePath).set({ sourceRef: `other_sources/${RUN}` }, { merge: true })],
    ["poison-source-conversation", async ({ source }) => source.ref.set({ conversationId: `other-${RUN}` }, { merge: true })],
    ["poison-source-thread", async ({ source }) => source.ref.set({ threadId: `other-${RUN}` }, { merge: true })],
    ["poison-source-context", async ({ source }) => source.ref.set({ contextKey: `other-${RUN}` }, { merge: true })],
    ["poison-source-message", async ({ source }) => source.ref.set({ messageRef: `message_sources/other-${RUN}` }, { merge: true })],
    ["poison-source-creator", async ({ source }) => source.ref.set({ creatorEmail: `other-${RUN}@example.com` }, { merge: true })],
    ["poison-conversation-account", async ({ conversation }) => conversation.ref.set({ mailAccountId: `other-${RUN}` }, { merge: true })],
    ["poison-job-account", async ({ queuePath }) => db.doc(queuePath).set({ mailAccountId: `other-${RUN}` }, { merge: true })],
    ["poison-mailbox", async ({ source, queuePath }) => Promise.all([
      source.ref.set({ inboundMailProvenance: { kind: "imap", accountId: "scp", mailbox: `other-${RUN}@example.com` } }, { merge: true }),
      db.doc(queuePath).set({ accountMailbox: `other-${RUN}@example.com` }, { merge: true }),
    ])],
    ["poison-account-status", async ({ source, conversation, queuePath }) => {
      const accountId = `disabled-${RUN}`;
      const mailbox = `disabled-${RUN}@example.com`;
      await db.collection("mail_accounts").doc(accountId).set({
        label: "disabled runtime account", mailbox, kind: "external_smtp_imap", status: "disabled",
        ownerEmail: "", orgIds: [], smtp: {}, imap: {}, secretRef: "env:MAIL_EXT_RUNTIME_PASSWORD",
        createdBy: "test", createdAt: new Date().toISOString(), updatedBy: "test", updatedAt: new Date().toISOString(),
      });
      await configurePolicy({ allowedAccountIds: [accountId] });
      await Promise.all([
        source.ref.set({ inboundMailProvenance: { kind: "imap", accountId, mailbox } }, { merge: true }),
        conversation.ref.set({ mailAccountId: accountId }, { merge: true }),
        db.doc(queuePath).set({ mailAccountId: accountId, accountMailbox: mailbox }, { merge: true }),
      ]);
    }],
  ];
  for (const [label, poison] of poisonCases) await runWithoutSmtp(label, poison);

  // Fresh settings/profile reads at dispatch make revocation immediate.
  await runWithoutSmtp("revoke-allowlist", async () => configurePolicy({ allowedAccountIds: [] }));
  await runWithoutSmtp("profile-dry-after-queue", async () => configurePolicy({ dryRunDefault: true }));
  await runWithoutSmtp("profile-live-off-after-queue", async () => configurePolicy({ liveSendEnabled: false }));
  await runWithoutSmtp("immutable-original-dryrun", async ({ queuePath }) => {
    await configurePolicy({ liveSendEnabled: true, dryRunDefault: false });
    await db.doc(queuePath).set({ dryRun: true, liveSend: true }, { merge: true });
  });

  // Legacy authorized behavior remains: humanApprovalRequired=false needs neither the new
  // allowlist nor the trusted provenance marker. The invocation is internal/IMAP-trusted for the
  // existing Permit sender gate, but deliberately omits account identity, so no new marker exists.
  const legacy = await receiveQueued("legacy-no-marker", {
    policy: { humanApprovalRequired: false, allowedAccountIds: [] },
    request: { trusted: true, includeAccount: false },
  });
  assert.equal(legacy.source.get("inboundMailProvenance"), undefined);
  assert.equal(legacy.queue.get("inboundMailProvenance"), undefined);
  const legacyBefore = smtpCalls.length;
  const legacyResult = await chatAi.processAutoReplyQueue();
  assert.equal(legacyResult.confirmedSent, 1);
  assert.equal(smtpCalls.length, legacyBefore + 1, "legacy humanApproval=false path regressed");
  assert.equal(smtpCalls.at(-1)?.to, creatorEmail("legacy-no-marker"));
  await db.doc(legacy.queue.get("caseIntentRef")).delete();

  // Existing Permit denial remains before SMTP.
  await runWithoutSmtp("permit-revoked", async () => db.doc(PERMIT_PATH).delete());

  // Existing suppression remains before SMTP.
  await runWithoutSmtp("suppressed-recipient", async () => {
    const email = creatorEmail("suppressed-recipient");
    await db.collection("mail_suppressions").doc(`inbound-runtime-suppression-${RUN}`).set({
      id: `inbound-runtime-suppression-${RUN}`,
      email,
      domain: "gmail.com",
      ruleId: "mail-safety.complaint-keyword",
      reason: "synthetic unsubscribe fixture",
      severity: "blocked",
      source: "inbound-runtime-test",
      createdAtIso: new Date().toISOString(),
    });
  });

  // Existing daily cap remains a clean deferral: no claim and no SMTP.
  const capped = await runWithoutSmtp("daily-cap", async () => configurePolicy({ maxDailyAutoSends: 0 }));
  assert.equal(capped.queue.get("status"), "scheduled");
  await capped.queue.ref.set({ status: "cancelled", cancelledReason: "test_cleanup" }, { merge: true });

  // Existing business window remains a clean deferral.
  const windowed = await runWithoutSmtp("business-window", async () => configurePolicy({ businessHours: closedBusinessWindowForNow() }));
  assert.equal(windowed.queue.get("status"), "scheduled");
  assert.ok((windowed.result.deferredOutsideWindow ?? 0) >= 1);
  await windowed.queue.ref.set({ status: "cancelled", cancelledReason: "test_cleanup" }, { merge: true });

  // Existing human takeover remains terminal and cannot reach SMTP.
  const takeover = await runWithoutSmtp("human-takeover", async ({ conversation }) => {
    await conversation.ref.set({ aiActive: false, manualIntervention: { status: "open" } }, { merge: true });
  });
  assert.equal(takeover.queue.get("status"), "cancelled");
  assert.equal(takeover.queue.get("cancelledReason"), "human_takeover");

  assert.equal(smtpCalls.length, 2, "only scoped trusted inbound and legacy humanApproval=false may reach SMTP");
  assert.deepEqual(smtpCalls.map((call) => call.to), [
    creatorEmail("positive"),
    creatorEmail("legacy-no-marker"),
  ]);
});
