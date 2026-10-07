// Handler-level standalone compose coverage. This file must run only against an isolated
// Firestore emulator: it uses unique fixture ids and restores every pre-existing document it
// temporarily overlays. No provider/API or real mailbox is contacted.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const projectId = "demo-flu";
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("FIRESTORE_EMULATOR_HOST must be set — run this test against an isolated Firestore emulator.");
}
process.env.FUNCTIONS_EMULATOR = "true";
process.env.GCLOUD_PROJECT = projectId;
process.env.GOOGLE_CLOUD_PROJECT = projectId;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId });
process.env.FLU_RUNTIME_ENV = "emulator";
process.env.FLU_FIRESTORE_DATABASE = "(default)";
process.env.FLU_FUNCTIONS_CODEBASE = "default";

const here = dirname(fileURLToPath(import.meta.url));
const requireFromFunctions = createRequire(join(here, "..", "functions", "package.json"));
const admin = requireFromFunctions("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId });
const db = admin.firestore();

const {
  STANDALONE_NEW_MAIL_INTENT,
  assertStandaloneNewMailPayload,
  sendEmail,
  standaloneNewMailConversationId,
  standaloneNewMailIdempotencyKey,
} = await import(new URL("../functions/lib/chat-ai.js", import.meta.url));
const {
  MAIL_ACCOUNTS_COLLECTION,
  MAIL_ROUTING_DOC_PATH,
  clearMailAccountResolutionCache,
  setMailAccountsRuntimeIntegrationForTests,
} = await import(new URL("../functions/lib/mailAccounts.js", import.meta.url));
const { setPeoplyClientForTests } = await import(new URL("../functions/lib/peoplyClient.js", import.meta.url));
const { safeMailDocId } = await import(new URL("../functions/lib/mailSafetyShared.js", import.meta.url));

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const GROWTH_EMAIL = `growth-${RUN}@supercent.io`;
const GROWTH_CHILD = `growth-child-${RUN}`;
const GROWTH_PARENT = `growth-parent-${RUN}`;
const AIX_EMAIL = `aix-${RUN}@supercent.io`;
const AIX_ORG = `aix-org-${RUN}`;
const UNCONNECTED_EMAIL = `unconnected-${RUN}@supercent.io`;
const UNCONNECTED_ORG = `unconnected-org-${RUN}`;
const PROVIDER_EMAIL = `provider-${RUN}@supercent.io`;
const PROVIDER_ORG = `provider-org-${RUN}`;
const PERSONAL_ACCOUNT_ID = `aix-${RUN}`;
const PROVIDER_ACCOUNT_ID = `provider-${RUN}`;
const RECIPIENT = "t.growth@supercent.io";
// This is the legacy recipient-only id used by the pre-standalone path. It is deliberately
// pre-seeded so the test proves that the new account-scoped ids do not reuse or overwrite it.
const LEGACY_CONVERSATION_ID = "mail-t-growth-supercent-io";
const PERSONAL_LEGACY_CONVERSATION_ID = `legacy-personal-${RUN}`;
const PROVIDER_CONVERSATION_ID = standaloneNewMailConversationId(RECIPIENT, PROVIDER_ACCOUNT_ID);
const PROVIDER_INBOUND_MESSAGE_ID = `provider-inbound-${RUN}`;
const TEST_START_ISO = new Date().toISOString();

const GLOBAL_PREIMAGE_PATHS = [
  MAIL_ROUTING_DOC_PATH,
  "settings/default",
  "settings/email",
  "settings/policy_cache",
  "mail_safety_state/outbound",
  `conversations/${LEGACY_CONVERSATION_ID}`,
  `conversations/${PERSONAL_LEGACY_CONVERSATION_ID}`,
  `conversations/${PROVIDER_CONVERSATION_ID}`,
  `conversations/${PROVIDER_CONVERSATION_ID}/messages/${PROVIDER_INBOUND_MESSAGE_ID}`,
  `${MAIL_ACCOUNTS_COLLECTION}/${PERSONAL_ACCOUNT_ID}`,
  `${MAIL_ACCOUNTS_COLLECTION}/${PROVIDER_ACCOUNT_ID}`,
];
const preimages = new Map();
const cleanupPaths = new Set(GLOBAL_PREIMAGE_PATHS);
const trackingIds = new Set();
const testRecipients = new Set([RECIPIENT]);
const conversationIds = new Set([
  LEGACY_CONVERSATION_ID,
  PERSONAL_LEGACY_CONVERSATION_ID,
  PROVIDER_CONVERSATION_ID,
]);

async function rememberPreimage(path) {
  if (preimages.has(path)) return;
  const snapshot = await db.doc(path).get();
  preimages.set(path, { exists: snapshot.exists, data: snapshot.exists ? snapshot.data() : undefined });
  cleanupPaths.add(path);
}

async function restoreOrDelete(path) {
  const preimage = preimages.get(path);
  if (preimage?.exists) {
    await db.doc(path).set(preimage.data);
  } else {
    await db.doc(path).delete();
  }
}

function accountDoc(accountId, mailbox, ownerEmail) {
  return {
    label: `${accountId} test account`,
    mailbox,
    kind: "workspace_oauth",
    status: "active",
    ownerEmail,
    orgIds: [],
    smtp: {},
    imap: {},
    secretRef: `oauth:mail_oauth_credentials/${accountId}`,
    createdBy: "standalone-emulator-test",
    createdAt: TEST_START_ISO,
    updatedBy: "standalone-emulator-test",
    updatedAt: TEST_START_ISO,
  };
}

function person(email, primaryMembership) {
  return {
    directoryUpdatedAt: null,
    employee: {
      id: `person-${email}`,
      email,
      displayName: email,
      nickname: "",
      koreanName: "",
      department: "",
      title: "",
      jobName: "",
      status: "active",
      primaryMembership,
      slackUserId: null,
    },
    memberships: [{
      orgId: primaryMembership,
      organizationName: primaryMembership,
      organizationPath: primaryMembership,
      title: "",
      role: "member",
      source: "standalone-emulator-test",
      purpose: "primary",
      primary: true,
      managerEmail: null,
    }],
  };
}

function request(email, data) {
  return {
    auth: {
      uid: `standalone-${email}`,
      token: { role: "manager", team: "Growth", email },
    },
    data,
    rawRequest: { ip: "127.0.0.1" },
  };
}

function standalonePayload(label, senderAccountId, overrides = {}) {
  const payload = {
    intent: STANDALONE_NEW_MAIL_INTENT,
    draftRef: `standalone-draft-${RUN}-${label}`,
    trackingId: `standalone-track-${RUN}-${label}`,
    approvalRef: `standalone-approval-${RUN}-${label}`,
    approval: "approved",
    senderAccountId,
    to: RECIPIENT,
    subject: `Growth internal message ${label}`,
    text: `Standalone test body ${label}.`,
    fromRole: "human",
    dryRun: true,
    liveSend: false,
    ...overrides,
  };
  trackingIds.add(payload.trackingId);
  testRecipients.add(String(payload.to).trim().toLowerCase());
  return payload;
}

function quotaEventId(payload) {
  const recipient = String(payload.to ?? RECIPIENT).trim().toLowerCase();
  const seed = `${payload.draftRef}:${payload.trackingId}:${payload.approvalRef}:${payload.approval}`;
  const idempotencyKey = payload.intent === STANDALONE_NEW_MAIL_INTENT
    ? standaloneNewMailIdempotencyKey(seed, String(payload.senderAccountId ?? ""), recipient)
    : seed;
  const eventSeed = [
    "sendEmail",
    "manual_send",
    idempotencyKey,
    payload.sendIntentKey,
    payload.messageRef,
    payload.trackingId,
    recipient,
  ].filter(Boolean).join("|");
  return safeMailDocId("mail_quota_event", eventSeed);
}

function quotaPaths(payload, mailbox, now = new Date()) {
  const day = `day_${now.toISOString().slice(0, 10)}`;
  const hour = `hour_${now.toISOString().slice(0, 13)}`;
  const burst = `burst_${Math.floor(now.getTime() / (10 * 60_000))}`;
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monday = new Date(utcMidnight - ((now.getUTCDay() + 6) % 7) * 24 * 60 * 60 * 1000);
  const week = `week_${monday.toISOString().slice(0, 10)}`;
  const ledger = (kind, value, period) => `mail_quota_ledger/${safeMailDocId("mail_quota", `${kind}:${value}:${period}`)}`;
  return [
    `mail_quota_events/${quotaEventId(payload)}`,
    ledger("sender", mailbox, day),
    ledger("emailProfile", "global-mail-profile", day),
    ledger("emailProfile", "global-mail-profile", hour),
    ledger("emailProfile", "global-mail-profile", burst),
    `mail_quota_ledger/${safeMailDocId("mail_quota", `global:weekly-total:${week}`)}`,
    `mail_quota_unique_recipients/${safeMailDocId("mail_quota", `sender:${mailbox}:${day}`)}`,
    `mail_quota_rollups/${hour}`,
    `mail_quota_rollups/${day}`,
  ];
}

async function sideEffectSnapshot(trackingId, recipient = RECIPIENT) {
  const [outbox, sources, events] = await Promise.all([
    db.collection("mail_outbound_log").doc(trackingId).get(),
    db.collection("message_sources").where("trackingId", "==", trackingId).get(),
    db.collection("mail_quota_events").where("recipient", "==", recipient).get(),
  ]);
  return {
    outbox: outbox.exists ? outbox.data() : null,
    sources: sources.docs.map((doc) => ({ id: doc.id, data: doc.data() })),
    events: events.docs
      .filter((doc) => doc.data()?.source === "sendEmail")
      .map((doc) => ({ id: doc.id, data: doc.data() })),
  };
}

async function expectRejected(
  email,
  payload,
  expected,
  existingConversationPath = "",
  { allowOutboxMutation = false } = {},
) {
  const before = await sideEffectSnapshot(payload.trackingId);
  const existingBefore = existingConversationPath
    ? await db.doc(existingConversationPath).get()
    : null;
  await assert.rejects(
    () => sendEmail(request(email, payload)),
    (error) => expected(error),
  );
  const after = await sideEffectSnapshot(payload.trackingId);
  if (allowOutboxMutation) {
    assert.deepEqual(after.sources, before.sources, "pending rejection must not create an outbound source");
    assert.deepEqual(after.events, before.events, "pending rejection must not create a quota event");
  } else {
    assert.deepEqual(after, before, "preflight rejection must not create audit/source/quota side effects");
  }
  if (existingBefore) {
    const existingAfter = await db.doc(existingConversationPath).get();
    assert.deepEqual(existingAfter.data(), existingBefore.data(), "preflight rejection must not mutate the foreign conversation");
  }
}

async function cleanupDynamicArtifacts() {
  for (const trackingId of trackingIds) {
    cleanupPaths.add(`mail_outbound_log/${trackingId}`);
    const [sources, failures] = await Promise.all([
      db.collection("message_sources").where("trackingId", "==", trackingId).get(),
      db.collection("mail_delivery_failures").where("trackingId", "==", trackingId).get(),
    ]);
    for (const doc of sources.docs) cleanupPaths.add(doc.ref.path);
    for (const doc of failures.docs) cleanupPaths.add(doc.ref.path);
  }
  for (const conversationId of conversationIds) {
    const sourceRef = `conversations/${conversationId}`;
    const [refresh, nodes, messages] = await Promise.all([
      db.collection("scp_lifecycle_refresh_outbox").where("sourceRef", "==", sourceRef).get(),
      db.collection("knowledge_nodes").where("entityRefs", "array-contains", sourceRef).get(),
      db.collection("conversations").doc(conversationId).collection("messages").get(),
    ]);
    for (const doc of refresh.docs) cleanupPaths.add(doc.ref.path);
    for (const doc of nodes.docs) {
      cleanupPaths.add(doc.ref.path);
      const edges = await db.collection("knowledge_edges").where("from", "==", doc.ref.path).get();
      for (const edge of edges.docs) cleanupPaths.add(edge.ref.path);
    }
    for (const doc of messages.docs) cleanupPaths.add(doc.ref.path);
  }
  for (const recipient of testRecipients) {
    const quotaEvents = await db.collection("mail_quota_events").where("recipient", "==", recipient).get();
    for (const doc of quotaEvents.docs) {
      const data = doc.data() ?? {};
      if (data.source !== "sendEmail") continue;
      const createdAt = Date.parse(String(data.createdAtIso ?? ""));
      if (Number.isFinite(createdAt) && createdAt >= Date.parse(TEST_START_ISO) - 1_000) {
        cleanupPaths.add(doc.ref.path);
        for (const path of data.quotaLedgerDocIds ?? []) cleanupPaths.add(`mail_quota_ledger/${path}`);
        if (typeof data.weeklyLedgerDocId === "string") cleanupPaths.add(`mail_quota_ledger/${data.weeklyLedgerDocId}`);
        if (typeof data.uniqueRecipientLedgerDocId === "string") cleanupPaths.add(`mail_quota_unique_recipients/${data.uniqueRecipientLedgerDocId}`);
        if (typeof data.hourKey === "string") cleanupPaths.add(`mail_quota_rollups/${data.hourKey}`);
        if (typeof data.dayKey === "string" && data.skipsGlobalDailyCap !== true) cleanupPaths.add(`mail_quota_rollups/${data.dayKey}`);
      }
    }
  }
  await Promise.all([...cleanupPaths].map((path) => restoreOrDelete(path)));
}

before(async () => {
  for (const path of GLOBAL_PREIMAGE_PATHS) await rememberPreimage(path);
  setMailAccountsRuntimeIntegrationForTests(async (key) => ({
    key,
    public: {
      host: "smtp.emulator.invalid",
      username: "scp@supercent.io",
      fromAddress: "scp@supercent.io",
    },
    secrets: {},
  }));
  setPeoplyClientForTests({
    async getPerson(email) {
      if (email === GROWTH_EMAIL) return person(email, GROWTH_CHILD);
      if (email === AIX_EMAIL) return person(email, AIX_ORG);
      if (email === UNCONNECTED_EMAIL) return person(email, UNCONNECTED_ORG);
      if (email === PROVIDER_EMAIL) return person(email, PROVIDER_ORG);
      throw new Error("directory person not found");
    },
    async getOrganization(orgId) {
      if (orgId === GROWTH_CHILD) return { id: orgId, name: "Growth child", parentId: GROWTH_PARENT };
      if (orgId === GROWTH_PARENT) return { id: orgId, name: "Growth", parentId: null };
      return { id: orgId, name: orgId, parentId: null };
    },
  });
  await Promise.all([
    db.doc(MAIL_ROUTING_DOC_PATH).set({
      defaultAccountId: "scp",
      byOrgId: { [GROWTH_PARENT]: "scp" },
      scpAllowedOrgIds: [GROWTH_PARENT],
      personalMailAllowedOrgIds: null,
      chatPersonalViewDefaultOrgIds: [],
      policyVersion: "standalone-emulator-test",
      updatedBy: "standalone-emulator-test",
      updatedAt: TEST_START_ISO,
    }),
    db.doc("settings/default").set({
      automation: { aiAutomationEnabled: true, liveSendEnabled: false },
      mailSafety: {
        emergencyShutdownEnabled: false,
        emergencyKeywords: [],
        blockedEmails: [],
        blockedDomains: [],
        suppressedHandles: [],
        outboundPolicy: {
          hourlyCap: 100,
          dailyCap: 100,
          burstCap: 100,
          burstWindowMinutes: 10,
          uniqueRecipientDailyCap: 100,
          weeklyTotalCap: 100,
          jitterMinSeconds: 0,
          jitterMaxSeconds: 0,
        },
      },
    }, { merge: true }),
    db.doc("settings/email").set({
      outboundPolicy: {
        hourlyCap: 100,
        dailyCap: 100,
        burstCap: 100,
        burstWindowMinutes: 10,
        uniqueRecipientDailyCap: 100,
        weeklyTotalCap: 100,
        jitterMinSeconds: 0,
        jitterMaxSeconds: 0,
      },
    }, { merge: true }),
    db.doc("mail_safety_state/outbound").set({ blockedUntilIso: "" }, { merge: true }),
    db.collection(MAIL_ACCOUNTS_COLLECTION).doc(PERSONAL_ACCOUNT_ID).set(
      accountDoc(PERSONAL_ACCOUNT_ID, AIX_EMAIL, AIX_EMAIL),
    ),
    db.collection(MAIL_ACCOUNTS_COLLECTION).doc(PROVIDER_ACCOUNT_ID).set(
      accountDoc(PROVIDER_ACCOUNT_ID, PROVIDER_EMAIL, PROVIDER_EMAIL),
    ),
    db.doc(`conversations/${LEGACY_CONVERSATION_ID}`).set({
      id: LEGACY_CONVERSATION_ID,
      mailAccountId: "scp",
      lastMessage: "legacy SCP history must remain unchanged",
      creatorEmail: RECIPIENT,
    }),
    db.doc(`conversations/${PERSONAL_LEGACY_CONVERSATION_ID}`).set({
      id: PERSONAL_LEGACY_CONVERSATION_ID,
      mailAccountId: PERSONAL_ACCOUNT_ID,
      lastMessage: "other personal history must remain unchanged",
    }),
    db.doc(`conversations/${PROVIDER_CONVERSATION_ID}`).set({
      id: PROVIDER_CONVERSATION_ID,
      threadId: PROVIDER_CONVERSATION_ID,
      contextKey: `mail:${PROVIDER_CONVERSATION_ID}`,
      mailAccountId: PROVIDER_ACCOUNT_ID,
      lastMessage: "existing inbound provider fixture",
    }),
    db.doc(`conversations/${PROVIDER_CONVERSATION_ID}/messages/${PROVIDER_INBOUND_MESSAGE_ID}`).set({
      id: PROVIDER_INBOUND_MESSAGE_ID,
      from: "creator",
      deliveryState: "received",
      createdAtIso: new Date(Date.now() - 60_000).toISOString(),
      text: "Inbound fixture before provider failure.",
    }),
  ]);
  clearMailAccountResolutionCache();
});

after(async () => {
  try {
    await cleanupDynamicArtifacts();
  } finally {
    setPeoplyClientForTests(null);
    setMailAccountsRuntimeIntegrationForTests(null);
    clearMailAccountResolutionCache();
  }
});

test("Growth SCP and AIX personal standalone sends bind the same recipient to separate conversations", async () => {
  const growthPayload = standalonePayload("growth", "scp");
  const aixPayload = standalonePayload("aix", PERSONAL_ACCOUNT_ID);
  const growthConversationId = standaloneNewMailConversationId(RECIPIENT, "scp");
  const aixConversationId = standaloneNewMailConversationId(RECIPIENT, PERSONAL_ACCOUNT_ID);
  conversationIds.add(growthConversationId);
  conversationIds.add(aixConversationId);
  await Promise.all([
    ...quotaPaths(growthPayload, "scp@supercent.io").map(rememberPreimage),
    ...quotaPaths(aixPayload, AIX_EMAIL).map(rememberPreimage),
    rememberPreimage(`conversations/${growthConversationId}`),
    rememberPreimage(`conversations/${aixConversationId}`),
  ]);

  const [growthResult, aixResult] = await Promise.all([
    sendEmail(request(GROWTH_EMAIL, growthPayload)),
    sendEmail(request(AIX_EMAIL, aixPayload)),
  ]);

  assert.equal(growthResult.ok, true);
  assert.equal(growthResult.deliveryState, "mock_sent");
  assert.equal(growthResult.persisted, true);
  assert.equal(growthResult.conversationId, growthConversationId);
  assert.equal(aixResult.ok, true);
  assert.equal(aixResult.deliveryState, "mock_sent");
  assert.equal(aixResult.persisted, true);
  assert.equal(aixResult.conversationId, aixConversationId);
  assert.notEqual(growthResult.conversationId, aixResult.conversationId);

  const [growthConversation, aixConversation, legacyConversation, personalLegacy] = await Promise.all([
    db.doc(`conversations/${growthConversationId}`).get(),
    db.doc(`conversations/${aixConversationId}`).get(),
    db.doc(`conversations/${LEGACY_CONVERSATION_ID}`).get(),
    db.doc(`conversations/${PERSONAL_LEGACY_CONVERSATION_ID}`).get(),
  ]);
  assert.equal(growthConversation.data()?.mailAccountId, "scp");
  assert.equal(aixConversation.data()?.mailAccountId, PERSONAL_ACCOUNT_ID);
  assert.equal(growthConversation.data()?.threadId, growthConversationId);
  assert.equal(aixConversation.data()?.threadId, aixConversationId);
  assert.equal(growthConversation.data()?.contextKey, `mail:${growthConversationId}`);
  assert.equal(aixConversation.data()?.contextKey, `mail:${aixConversationId}`);
  assert.equal(legacyConversation.data()?.lastMessage, "legacy SCP history must remain unchanged");
  assert.equal(personalLegacy.data()?.lastMessage, "other personal history must remain unchanged");

  for (const payload of [growthPayload, aixPayload]) {
    const sourceRows = await db.collection("message_sources").where("trackingId", "==", payload.trackingId).get();
    assert.equal(sourceRows.size, 1);
    const source = sourceRows.docs[0].data();
    assert.equal(source.direction, "outbound");
    assert.equal(source.intent, STANDALONE_NEW_MAIL_INTENT);
    assert.equal(source.replyToMessageRef, "");
    assert.equal(source.conversationId, payload.senderAccountId === "scp" ? growthConversationId : aixConversationId);
    assert.equal(source.mailAccountId, payload.senderAccountId);
    const outbox = await db.collection("mail_outbound_log").doc(payload.trackingId).get();
    assert.equal(outbox.data()?.deliveryState, "mock_sent");
    assert.equal(outbox.data()?.conversationId, source.conversationId);
  }
});

test("standalone retries are idempotent and tracking ids cannot cross account or recipient bindings", async () => {
  const retryRecipient = `retry-${RUN}@example.test`;
  const retryPayload = standalonePayload("same-request-retry", "scp", { to: retryRecipient });
  const retryConversationId = standaloneNewMailConversationId(retryRecipient, "scp");
  conversationIds.add(retryConversationId);
  await Promise.all([
    ...quotaPaths(retryPayload, "scp@supercent.io").map(rememberPreimage),
    rememberPreimage(`conversations/${retryConversationId}`),
  ]);

  const first = await sendEmail(request(GROWTH_EMAIL, retryPayload));
  const retry = await sendEmail(request(GROWTH_EMAIL, retryPayload));
  assert.equal(first.ok, true);
  assert.equal(first.deliveryState, "mock_sent");
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.deliveryState, "skipped_duplicate");
  assert.equal(retry.conversationId, retryConversationId);

  const crossAccount = { ...retryPayload, senderAccountId: PERSONAL_ACCOUNT_ID };
  await expectRejected(
    AIX_EMAIL,
    crossAccount,
    (error) => error?.errorCode === "send_email_standalone_tracking_binding_conflict",
  );

  const otherRecipient = `other-${RUN}@example.test`;
  const crossRecipient = { ...retryPayload, to: otherRecipient };
  await expectRejected(
    GROWTH_EMAIL,
    crossRecipient,
    (error) => error?.errorCode === "send_email_standalone_tracking_binding_conflict",
    "",
  );
  const otherRecipientSources = await db.collection("message_sources")
    .where("trackingId", "==", retryPayload.trackingId)
    .get();
  assert.equal(otherRecipientSources.docs[0]?.data()?.to, retryRecipient);
});

test("concurrent standalone tracking collisions allow only one account binding to claim", async () => {
  const concurrentRecipient = `concurrent-${RUN}@example.test`;
  const firstPayload = standalonePayload("concurrent-scp", "scp", { to: concurrentRecipient });
  const secondPayload = { ...firstPayload, senderAccountId: PERSONAL_ACCOUNT_ID };
  const firstConversationId = standaloneNewMailConversationId(concurrentRecipient, "scp");
  const secondConversationId = standaloneNewMailConversationId(concurrentRecipient, PERSONAL_ACCOUNT_ID);
  conversationIds.add(firstConversationId);
  conversationIds.add(secondConversationId);
  await Promise.all([
    ...quotaPaths(firstPayload, "scp@supercent.io").map(rememberPreimage),
    ...quotaPaths(secondPayload, AIX_EMAIL).map(rememberPreimage),
    rememberPreimage(`conversations/${firstConversationId}`),
    rememberPreimage(`conversations/${secondConversationId}`),
  ]);

  const outcomes = await Promise.allSettled([
    sendEmail(request(GROWTH_EMAIL, firstPayload)),
    sendEmail(request(AIX_EMAIL, secondPayload)),
  ]);
  const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(
    rejected[0].reason?.errorCode,
    "send_email_standalone_tracking_binding_conflict",
  );
  assert.equal(fulfilled[0].value.ok, true);
  assert.equal(fulfilled[0].value.deliveryState, "mock_sent");
});

test("standalone reservations expose pending reconciliation and only known pre-provider failures retry", async () => {
  const activeRecipient = `active-${RUN}@example.test`;
  const activePayload = standalonePayload("active-reservation", "scp", { to: activeRecipient });
  const activeConversationId = standaloneNewMailConversationId(activeRecipient, "scp");
  conversationIds.add(activeConversationId);
  await Promise.all([
    rememberPreimage(`mail_outbound_log/${activePayload.trackingId}`),
    rememberPreimage(`conversations/${activeConversationId}`),
  ]);
  await db.collection("mail_outbound_log").doc(activePayload.trackingId).set({
    trackingId: activePayload.trackingId,
    conversationId: activeConversationId,
    conversationRef: `conversations/${activeConversationId}`,
    deliveryState: "binding_reserved",
    bindingState: "in_flight",
    bindingLeaseExpiresAtIso: new Date(Date.now() + 60_000).toISOString(),
    providerAttemptState: "not_attempted",
    standaloneBinding: true,
    draftRef: activePayload.draftRef,
    approvalRef: activePayload.approvalRef,
  });
  await expectRejected(
    GROWTH_EMAIL,
    activePayload,
    (error) => error?.errorCode === "send_email_standalone_delivery_pending"
      && error?.bindingState === "in_flight",
  );
  const activeRow = (await db.collection("mail_outbound_log").doc(activePayload.trackingId).get()).data();
  assert.equal(activeRow?.deliveryState, "binding_reserved");
  assert.equal(activeRow?.bindingState, "in_flight");

  const staleRecipient = `stale-${RUN}@example.test`;
  const stalePayload = standalonePayload("stale-reservation", "scp", { to: staleRecipient });
  const staleConversationId = standaloneNewMailConversationId(staleRecipient, "scp");
  conversationIds.add(staleConversationId);
  await Promise.all([
    rememberPreimage(`mail_outbound_log/${stalePayload.trackingId}`),
    rememberPreimage(`conversations/${staleConversationId}`),
  ]);
  await db.collection("mail_outbound_log").doc(stalePayload.trackingId).set({
    trackingId: stalePayload.trackingId,
    conversationId: staleConversationId,
    conversationRef: `conversations/${staleConversationId}`,
    deliveryState: "binding_reserved",
    bindingState: "in_flight",
    bindingLeaseExpiresAtIso: new Date(Date.now() - 60_000).toISOString(),
    providerAttemptState: "not_attempted",
    standaloneBinding: true,
    draftRef: stalePayload.draftRef,
    approvalRef: stalePayload.approvalRef,
  });
  await expectRejected(
    GROWTH_EMAIL,
    stalePayload,
    (error) => error?.errorCode === "send_email_standalone_reconciliation_required"
      && error?.reconciliationRequired === true,
    "",
    { allowOutboxMutation: true },
  );
  const staleRow = (await db.collection("mail_outbound_log").doc(stalePayload.trackingId).get()).data();
  assert.equal(staleRow?.deliveryState, "acceptance_unknown");
  assert.equal(staleRow?.bindingState, "reconciliation_required");
  assert.equal(staleRow?.automaticRetryBlocked, true);
  await expectRejected(
    GROWTH_EMAIL,
    stalePayload,
    (error) => error?.errorCode === "send_email_standalone_reconciliation_required",
  );

  const unknownRecipient = `unknown-${RUN}@example.test`;
  const unknownPayload = standalonePayload("unknown-reservation", "scp", { to: unknownRecipient });
  const unknownConversationId = standaloneNewMailConversationId(unknownRecipient, "scp");
  conversationIds.add(unknownConversationId);
  await Promise.all([
    rememberPreimage(`mail_outbound_log/${unknownPayload.trackingId}`),
    rememberPreimage(`conversations/${unknownConversationId}`),
  ]);
  await db.collection("mail_outbound_log").doc(unknownPayload.trackingId).set({
    trackingId: unknownPayload.trackingId,
    conversationId: unknownConversationId,
    conversationRef: `conversations/${unknownConversationId}`,
    deliveryState: "acceptance_unknown",
    bindingState: "reconciliation_required",
    providerAttemptState: "acceptance_unknown",
    reconciliationRequired: true,
    automaticRetryBlocked: true,
    standaloneBinding: true,
    draftRef: unknownPayload.draftRef,
    approvalRef: unknownPayload.approvalRef,
  });
  await expectRejected(
    GROWTH_EMAIL,
    unknownPayload,
    (error) => error?.errorCode === "send_email_standalone_reconciliation_required"
      && error?.automaticRetryBlocked === true,
  );
  await expectRejected(
    GROWTH_EMAIL,
    unknownPayload,
    (error) => error?.errorCode === "send_email_standalone_reconciliation_required",
  );

  const evidenceRecipient = `evidence-${RUN}@example.test`;
  const evidencePayload = standalonePayload("evidence-pending", "scp", { to: evidenceRecipient });
  const evidenceConversationId = standaloneNewMailConversationId(evidenceRecipient, "scp");
  conversationIds.add(evidenceConversationId);
  await Promise.all([
    rememberPreimage(`mail_outbound_log/${evidencePayload.trackingId}`),
    rememberPreimage(`conversations/${evidenceConversationId}`),
  ]);
  await db.collection("mail_outbound_log").doc(evidencePayload.trackingId).set({
    trackingId: evidencePayload.trackingId,
    conversationId: evidenceConversationId,
    conversationRef: `conversations/${evidenceConversationId}`,
    deliveryState: "sent_evidence_pending",
    bindingState: "reconciliation_required",
    providerAttemptState: "accepted_pending_evidence",
    reconciliationRequired: true,
    automaticRetryBlocked: true,
    standaloneBinding: true,
    draftRef: evidencePayload.draftRef,
    approvalRef: evidencePayload.approvalRef,
  });
  await expectRejected(
    GROWTH_EMAIL,
    evidencePayload,
    (error) => error?.errorCode === "send_email_standalone_reconciliation_required"
      && error?.deliveryState === "sent_evidence_pending",
  );
  await expectRejected(
    GROWTH_EMAIL,
    evidencePayload,
    (error) => error?.errorCode === "send_email_standalone_reconciliation_required",
  );

  const retryableRecipient = `retryable-${RUN}@example.test`;
  const retryablePayload = standalonePayload("known-retryable", "scp", { to: retryableRecipient });
  const retryableConversationId = standaloneNewMailConversationId(retryableRecipient, "scp");
  conversationIds.add(retryableConversationId);
  await Promise.all([
    rememberPreimage(`mail_outbound_log/${retryablePayload.trackingId}`),
    rememberPreimage(`conversations/${retryableConversationId}`),
    ...quotaPaths(retryablePayload, "scp@supercent.io").map(rememberPreimage),
  ]);
  await db.collection("mail_outbound_log").doc(retryablePayload.trackingId).set({
    trackingId: retryablePayload.trackingId,
    conversationId: retryableConversationId,
    conversationRef: `conversations/${retryableConversationId}`,
    deliveryState: "retryable_failed",
    bindingState: "retryable",
    providerAttemptState: "definitely_not_accepted",
    standaloneBinding: true,
    draftRef: retryablePayload.draftRef,
    approvalRef: retryablePayload.approvalRef,
  });
  const retriedKnownFailure = await sendEmail(request(GROWTH_EMAIL, retryablePayload));
  assert.equal(retriedKnownFailure.ok, true);
  assert.equal(retriedKnownFailure.deliveryState, "mock_sent");
  const retryableRow = (await db.collection("mail_outbound_log").doc(retryablePayload.trackingId).get()).data();
  assert.equal(retryableRow?.deliveryState, "mock_sent");
  assert.equal(retryableRow?.bindingState, "terminal");
  assert.equal(retryableRow?.reconciliationRequired, false);
});

test("standalone sender and context preflights reject without provider, conversation, audit, or quota writes", async () => {
  const forged = standalonePayload("forged-context", "scp", {
    conversationId: LEGACY_CONVERSATION_ID,
    replyToMessageRef: "message_sources/forged-reply",
  });
  await expectRejected(
    GROWTH_EMAIL,
    forged,
    (error) => error?.errorCode === "send_email_standalone_context_forbidden",
    `conversations/${LEGACY_CONVERSATION_ID}`,
  );

  const forgedSuppressionException = standalonePayload("forged-infly-exception", "scp", {
    allowInflyOverlap: true,
  });
  await expectRejected(
    GROWTH_EMAIL,
    forgedSuppressionException,
    (error) => error?.errorCode === "send_email_standalone_context_forbidden",
  );

  const aliases = standalonePayload("alias-mismatch", "scp", { viewAccountId: PERSONAL_ACCOUNT_ID });
  await expectRejected(
    GROWTH_EMAIL,
    aliases,
    (error) => error?.code === "permission-denied" && error?.errorCode === "send_email_sender_override_not_allowed",
  );

  const missingApproval = standalonePayload("missing-approval", "scp", { approval: "pending" });
  await expectRejected(
    GROWTH_EMAIL,
    missingApproval,
    (error) => error?.errorCode === "send_email_standalone_approval_required",
  );

  const unconnected = standalonePayload("unconnected", `unconnected-${RUN}`);
  await expectRejected(
    UNCONNECTED_EMAIL,
    unconnected,
    (error) => error?.code === "failed-precondition" && error?.errorCode === "send_email_sender_personal_connection_required",
  );

  const foreignSender = standalonePayload("foreign-sender", "scp");
  await expectRejected(
    AIX_EMAIL,
    foreignSender,
    (error) => error?.code === "permission-denied" && error?.errorCode === "send_email_sender_override_not_allowed",
  );
});

test("provider failure leaves the existing account-bound thread unchanged and creates no success row", async () => {
  const payload = standalonePayload("provider-failure", PROVIDER_ACCOUNT_ID, {
    dryRun: false,
    liveSend: true,
  });
  const ambiguousRecipient = `ambiguous-provider-${RUN}@supercent.io`;
  const ambiguousPayload = standalonePayload("provider-acceptance-unknown", PROVIDER_ACCOUNT_ID, {
    to: ambiguousRecipient,
    dryRun: false,
    liveSend: true,
  });
  const ambiguousConversationId = standaloneNewMailConversationId(ambiguousRecipient, PROVIDER_ACCOUNT_ID);
  conversationIds.add(ambiguousConversationId);
  const beforeConversation = await db.doc(`conversations/${PROVIDER_CONVERSATION_ID}`).get();
  const beforeInbound = await db.doc(`conversations/${PROVIDER_CONVERSATION_ID}/messages/${PROVIDER_INBOUND_MESSAGE_ID}`).get();
  await Promise.all([
    ...quotaPaths(payload, PROVIDER_EMAIL).map(rememberPreimage),
    rememberPreimage(`conversations/${PROVIDER_CONVERSATION_ID}`),
    rememberPreimage(`conversations/${PROVIDER_CONVERSATION_ID}/messages/${PROVIDER_INBOUND_MESSAGE_ID}`),
    ...quotaPaths(ambiguousPayload, PROVIDER_EMAIL).map(rememberPreimage),
    rememberPreimage(`conversations/${ambiguousConversationId}`),
  ]);

  const liveIntegrations = requireFromFunctions("./lib/liveIntegrations.js");
  const mailProfiles = requireFromFunctions("./lib/mailProfiles.js");
  const mailTransport = requireFromFunctions("./lib/mailTransport.js");
  const originalLiveEnabled = liveIntegrations.liveIntegrationsEnabled;
  const originalResolveAccountContext = mailProfiles.resolveMailIdentityContextForAccount;
  const originalResolveOperationalIdentity = mailProfiles.resolveOperationalMailIdentity;
  const originalBuildTransport = mailTransport.buildMailTransportForAccount;
  let providerFailureCode = "EENVELOPE";
  let providerCalls = 0;
  const fakeIdentity = {
    identityMatch: true,
    identityCode: "identity_ok_unverified_subject",
    configFingerprint: "a".repeat(64),
    providerSubjectVerified: true,
    mismatches: [],
  };
  const fakeContext = {
    identity: fakeIdentity,
    smtp: {
      config: { key: "mailSmtp", public: {}, secrets: {} },
      host: "smtp.emulator.invalid",
      port: 587,
      secure: false,
      authUser: PROVIDER_EMAIL,
      from: PROVIDER_EMAIL,
      replyTo: PROVIDER_EMAIL,
    },
    imap: {
      config: { key: "mailImap", public: {}, secrets: {} },
      host: "imap.emulator.invalid",
      port: 993,
      secure: true,
      authUser: PROVIDER_EMAIL,
    },
  };
  liveIntegrations.liveIntegrationsEnabled = () => true;
  mailProfiles.resolveMailIdentityContextForAccount = async () => fakeContext;
  mailProfiles.resolveOperationalMailIdentity = async () => fakeIdentity;
  mailTransport.buildMailTransportForAccount = async () => ({
    transporter: {
      async sendMail() {
        providerCalls += 1;
        throw Object.assign(new Error("mock provider failure"), { code: providerFailureCode });
      },
    },
    from: PROVIDER_EMAIL,
    replyTo: PROVIDER_EMAIL,
    identity: fakeIdentity,
    transportFingerprint: "provider-failure-test",
  });
  try {
    await assert.rejects(
      () => sendEmail(request(PROVIDER_EMAIL, payload)),
      (error) => error?.fluSmtpAttemptStarted === true
        && error?.errorCode === "smtp_attempt_failure_smtp_transport_attempt",
    );

    providerFailureCode = "ETIMEDOUT";
    await assert.rejects(
      () => sendEmail(request(PROVIDER_EMAIL, ambiguousPayload)),
      (error) => error?.code === "mail_delivery_ambiguous"
        && error?.errorCode === "send_email_smtp_acceptance_unknown_automatic_resend",
    );
    assert.equal(providerCalls, 2, "the first acceptance-unknown attempt reaches the provider once");
    const [unknownOutbox, unknownConversation, unknownSources] = await Promise.all([
      db.collection("mail_outbound_log").doc(ambiguousPayload.trackingId).get(),
      db.doc(`conversations/${ambiguousConversationId}`).get(),
      db.collection("message_sources").where("trackingId", "==", ambiguousPayload.trackingId).get(),
    ]);
    assert.equal(unknownOutbox.data()?.deliveryState, "acceptance_unknown");
    assert.equal(unknownOutbox.data()?.bindingState, "reconciliation_required");
    assert.equal(unknownOutbox.data()?.reconciliationRequired, true);
    assert.equal(unknownOutbox.data()?.automaticRetryBlocked, true);
    assert.equal(unknownConversation.exists, false, "unknown acceptance must not create a conversation");
    assert.equal(unknownSources.empty, true, "unknown acceptance must not create a message source");

    const beforeUnknownRetry = await sideEffectSnapshot(ambiguousPayload.trackingId, ambiguousRecipient);
    await assert.rejects(
      () => sendEmail(request(PROVIDER_EMAIL, ambiguousPayload)),
      (error) => error?.errorCode === "send_email_standalone_reconciliation_required",
    );
    assert.equal(providerCalls, 2, "reconciliation retry must not call the provider again");
    const afterUnknownRetry = await sideEffectSnapshot(ambiguousPayload.trackingId, ambiguousRecipient);
    assert.deepEqual(afterUnknownRetry, beforeUnknownRetry, "reconciliation retry must not mutate the held row");
  } finally {
    liveIntegrations.liveIntegrationsEnabled = originalLiveEnabled;
    mailProfiles.resolveMailIdentityContextForAccount = originalResolveAccountContext;
    mailProfiles.resolveOperationalMailIdentity = originalResolveOperationalIdentity;
    mailTransport.buildMailTransportForAccount = originalBuildTransport;
  }

  const [afterConversation, afterInbound, outbox, sources] = await Promise.all([
    db.doc(`conversations/${PROVIDER_CONVERSATION_ID}`).get(),
    db.doc(`conversations/${PROVIDER_CONVERSATION_ID}/messages/${PROVIDER_INBOUND_MESSAGE_ID}`).get(),
    db.collection("mail_outbound_log").doc(payload.trackingId).get(),
    db.collection("message_sources").where("trackingId", "==", payload.trackingId).get(),
  ]);
  assert.deepEqual(afterConversation.data(), beforeConversation.data());
  assert.deepEqual(afterInbound.data(), beforeInbound.data());
  assert.equal(outbox.exists, false, "provider failure must not be recorded as a successful outbound row");
  assert.equal(sources.empty, true, "provider failure must not persist an outbound message source");
});

test("standalone definite provider failure settles quota so the same request retries through the provider", async () => {
  const retryRecipient = `retry-provider-${RUN}@supercent.io`;
  const payload = standalonePayload("definite-provider-retry", PROVIDER_ACCOUNT_ID, {
    to: retryRecipient,
    dryRun: false,
    liveSend: true,
  });
  const conversationId = standaloneNewMailConversationId(retryRecipient, PROVIDER_ACCOUNT_ID);
  conversationIds.add(conversationId);
  await Promise.all([
    ...quotaPaths(payload, PROVIDER_EMAIL).map(rememberPreimage),
    rememberPreimage(`conversations/${conversationId}`),
  ]);

  const liveIntegrations = requireFromFunctions("./lib/liveIntegrations.js");
  const mailProfiles = requireFromFunctions("./lib/mailProfiles.js");
  const mailTransport = requireFromFunctions("./lib/mailTransport.js");
  const originalLiveEnabled = liveIntegrations.liveIntegrationsEnabled;
  const originalResolveAccountContext = mailProfiles.resolveMailIdentityContextForAccount;
  const originalResolveOperationalIdentity = mailProfiles.resolveOperationalMailIdentity;
  const originalBuildTransport = mailTransport.buildMailTransportForAccount;
  const fakeIdentity = {
    identityMatch: true,
    identityCode: "identity_ok_unverified_subject",
    configFingerprint: "b".repeat(64),
    providerSubjectVerified: true,
    mismatches: [],
  };
  const fakeContext = {
    identity: fakeIdentity,
    smtp: {
      config: { key: "mailSmtp", public: {}, secrets: {} },
      host: "smtp.emulator.invalid",
      port: 587,
      secure: false,
      authUser: PROVIDER_EMAIL,
      from: PROVIDER_EMAIL,
      replyTo: PROVIDER_EMAIL,
    },
    imap: {
      config: { key: "mailImap", public: {}, secrets: {} },
      host: "imap.emulator.invalid",
      port: 993,
      secure: true,
      authUser: PROVIDER_EMAIL,
    },
  };
  let providerCalls = 0;
  let failProvider = true;
  liveIntegrations.liveIntegrationsEnabled = () => true;
  mailProfiles.resolveMailIdentityContextForAccount = async () => fakeContext;
  mailProfiles.resolveOperationalMailIdentity = async () => fakeIdentity;
  mailTransport.buildMailTransportForAccount = async () => ({
    transporter: {
      async sendMail(message) {
        providerCalls += 1;
        if (failProvider) {
          failProvider = false;
          throw Object.assign(new Error("mock definite provider failure"), { code: "EENVELOPE" });
        }
        return {
          messageId: `standalone-retry-${providerCalls}`,
          accepted: [message?.to],
          rejected: [],
        };
      },
    },
    from: PROVIDER_EMAIL,
    replyTo: PROVIDER_EMAIL,
    identity: fakeIdentity,
    transportFingerprint: "standalone-definite-retry-test",
  });

  try {
    await assert.rejects(
      () => sendEmail(request(PROVIDER_EMAIL, payload)),
      (error) => error?.fluSmtpAttemptStarted === true
        && error?.errorCode === "smtp_attempt_failure_smtp_transport_attempt",
    );
    const eventId = quotaEventId(payload);
    const [failedEvent, releasedBinding] = await Promise.all([
      db.collection("mail_quota_events").doc(eventId).get(),
      db.collection("mail_outbound_log").doc(payload.trackingId).get(),
    ]);
    assert.equal(failedEvent.data()?.status, "retryable_failed");
    assert.equal(failedEvent.data()?.providerAttemptState, "definitely_not_accepted");
    assert.equal(failedEvent.data()?.providerFailureRetryAllowed, true);
    assert.equal(releasedBinding.exists, false, "only a confirmed quota settlement may release the binding");

    const retried = await sendEmail(request(PROVIDER_EMAIL, payload));
    assert.equal(providerCalls, 2, "the retry must invoke the standalone provider exactly once");
    assert.equal(retried.ok, true);
    assert.equal(retried.duplicate, false);
    assert.equal(retried.deliveryState, "sent");
    assert.equal(retried.providerConfirmed, true);
    assert.equal(retried.persisted, true);
    assert.equal(retried.conversationId, conversationId);

    const [outbox, sources, retriedEvent] = await Promise.all([
      db.collection("mail_outbound_log").doc(payload.trackingId).get(),
      db.collection("message_sources").where("trackingId", "==", payload.trackingId).get(),
      db.collection("mail_quota_events").doc(eventId).get(),
    ]);
    assert.equal(outbox.data()?.deliveryState, "sent");
    assert.equal(outbox.data()?.bindingState, "terminal");
    assert.equal(outbox.data()?.persisted, true);
    assert.equal(outbox.data()?.providerConfirmed, true);
    assert.equal(sources.size, 1);
    assert.equal(retriedEvent.data()?.status, "reserved");
    assert.equal(retriedEvent.data()?.providerAttemptState, undefined);
  } finally {
    liveIntegrations.liveIntegrationsEnabled = originalLiveEnabled;
    mailProfiles.resolveMailIdentityContextForAccount = originalResolveAccountContext;
    mailProfiles.resolveOperationalMailIdentity = originalResolveOperationalIdentity;
    mailTransport.buildMailTransportForAccount = originalBuildTransport;
  }
});

test("chat_manual_reply keeps its missing-inbound safety gate for external recipients", async () => {
  const payload = {
    intent: "chat_manual_reply",
    draftRef: `legacy-reply-draft-${RUN}`,
    trackingId: `legacy-reply-track-${RUN}`,
    approvalRef: `legacy-reply-approval-${RUN}`,
    approval: "approved",
    senderAccountId: "scp",
    to: `external-${RUN}@example.test`,
    subject: "Legacy reply safety",
    text: "This must remain a reply-only lane.",
    fromRole: "human",
    dryRun: true,
    liveSend: false,
  };
  trackingIds.add(payload.trackingId);
  const result = await sendEmail(request(GROWTH_EMAIL, payload));
  assert.equal(result.ok, false);
  assert.equal(result.deliveryState, "blocked");
  assert.equal(result.blockedRuleId, "mail-safety.chat-manual-reply.missing-inbound");
  assert.equal(result.persisted, false);
  const sources = await db.collection("message_sources").where("trackingId", "==", payload.trackingId).get();
  assert.equal(sources.empty, true);
});
