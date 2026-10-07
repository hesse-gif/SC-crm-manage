// Handler-level regression for the legacy SCP history boundary. The fixture uses a verified
// Peoply parent route and real Firestore emulator reads; no mail provider or production API is
// contacted. Run with `node --test` while the Firestore emulator is running, or via
// `npm run test:emu -- tests/chat-mail-history-account-boundary-emulator.test.mjs`.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "demo-flu";
process.env.GCLOUD_PROJECT = projectId;
process.env.GOOGLE_CLOUD_PROJECT = projectId;
process.env.FUNCTIONS_EMULATOR = "true";
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("FIRESTORE_EMULATOR_HOST must be set — run this test against the Firestore emulator.");
}

const here = dirname(fileURLToPath(import.meta.url));
const requireFromFunctions = createRequire(join(here, "..", "functions", "package.json"));
const admin = requireFromFunctions("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId });
const db = admin.firestore();

const { listConversations, listConversationMessages, getMessageSource } =
  await import(new URL("../functions/lib/read.js", import.meta.url));
const {
  clearMailAccountResolutionCache,
  MAIL_ACCOUNTS_COLLECTION,
  MAIL_ROUTING_DOC_PATH,
  setMailAccountsRuntimeIntegrationForTests,
} = await import(new URL("../functions/lib/mailAccounts.js", import.meta.url));
const { setPeoplyClientForTests } = await import(new URL("../functions/lib/peoplyClient.js", import.meta.url));

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const GROWTH_PARENT = `growth-parent-${RUN}`;
const GROWTH_CHILD = `growth-strategy-${RUN}`;
const AIX_ORG = `aix-org-${RUN}`;
const SAM_EMAIL = `sam-${RUN}@supercent.io`;
const AIX_EMAIL = `aix-${RUN}@supercent.io`;
const PERSONAL_AIX = `personal-aix-${RUN}`;
const CONV_LEGACY = `conv-${RUN}-legacy-scp`;
const CONV_STAMPED = `conv-${RUN}-stamped-scp`;
const SOURCE_LEGACY = `source-${RUN}-legacy-scp`;
const SOURCE_STAMPED = `source-${RUN}-stamped-scp`;
const SOURCE_ORPHAN = `source-${RUN}-orphan`;
const SOURCE_MISSING_CONVERSATION = `source-${RUN}-missing-conversation`;
const MISSING_CONVERSATION = `conv-${RUN}-missing`;

function request(role, email, data) {
  return {
    data,
    auth: { uid: `${role}-${email}`, token: { role, team: "Growth", email } },
    rawRequest: { ip: "127.0.0.1" },
  };
}

function peoplyPersonDetail(email, primaryMembership) {
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
      source: "test",
      purpose: "primary",
      primary: true,
      managerEmail: null,
    }],
  };
}

const runtimeIntegration = async (key) => ({
  key,
  public: { username: "scp@supercent.io" },
  secrets: {},
});

before(async () => {
  const nowIso = new Date().toISOString();
  setMailAccountsRuntimeIntegrationForTests(runtimeIntegration);
  setPeoplyClientForTests({
    async getPerson(email) {
      if (email === SAM_EMAIL) return peoplyPersonDetail(email, GROWTH_CHILD);
      if (email === AIX_EMAIL) return peoplyPersonDetail(email, AIX_ORG);
      throw new Error("directory person not found");
    },
    async getOrganization(orgId) {
      if (orgId === GROWTH_CHILD) {
        return { id: GROWTH_CHILD, name: "Growth Strategy", parentId: GROWTH_PARENT };
      }
      if (orgId === GROWTH_PARENT) {
        return { id: GROWTH_PARENT, name: "Growth", parentId: null };
      }
      throw new Error("directory organization not found");
    },
  });
  await Promise.all([
    db.collection(MAIL_ACCOUNTS_COLLECTION).doc(PERSONAL_AIX).set({
      label: "AIX personal", mailbox: `aix-${RUN}@example.com`, kind: "workspace_oauth", status: "active",
      ownerEmail: AIX_EMAIL, orgIds: [AIX_ORG], smtp: {}, imap: {},
      secretRef: `oauth:mail_oauth_credentials/${PERSONAL_AIX}`,
      createdBy: "test", createdAt: nowIso, updatedBy: "test", updatedAt: nowIso,
    }),
    db.doc(MAIL_ROUTING_DOC_PATH).set({
      defaultAccountId: "scp",
      byOrgId: { [GROWTH_PARENT]: "scp" },
      // Keep the legacy assignment list compatible with the current policy while proving the
      // actual entitlement comes from the explicit parent mapping.
      scpAllowedOrgIds: [GROWTH_PARENT],
      personalMailAllowedOrgIds: null,
      policyVersion: "mail-routing-v1",
      updatedBy: "test", updatedAt: nowIso,
    }),
    db.collection("conversations").doc(CONV_LEGACY).set({
      lastMessageAtIso: nowIso, createdAtIso: nowIso, creatorName: "Legacy SCP history",
      orgId: "stale-org-from-old-routing",
    }),
    db.collection("conversations").doc(CONV_STAMPED).set({
      lastMessageAtIso: new Date(Date.parse(nowIso) - 1000).toISOString(),
      createdAtIso: nowIso, creatorName: "Stamped SCP history", mailAccountId: "scp",
      orgId: "stale-child-org-from-old-routing",
    }),
    db.collection("message_sources").doc(SOURCE_LEGACY).set({
      conversationId: CONV_LEGACY, subject: "Legacy SCP source", from: "creator@example.com", to: "scp@supercent.io",
    }),
    db.collection("message_sources").doc(SOURCE_STAMPED).set({
      conversationId: CONV_STAMPED, subject: "Stamped SCP source", from: "creator@example.com", to: "scp@supercent.io",
    }),
    db.collection("message_sources").doc(SOURCE_ORPHAN).set({
      subject: "Unbound source", from: "creator@example.com", to: "scp@supercent.io",
    }),
    db.collection("message_sources").doc(SOURCE_MISSING_CONVERSATION).set({
      conversationId: MISSING_CONVERSATION, subject: "Missing conversation source", from: "creator@example.com", to: "scp@supercent.io",
    }),
  ]);
  clearMailAccountResolutionCache();
});

after(async () => {
  setPeoplyClientForTests(null);
  setMailAccountsRuntimeIntegrationForTests(null);
  clearMailAccountResolutionCache();
  await Promise.all([
    db.collection(MAIL_ACCOUNTS_COLLECTION).doc(PERSONAL_AIX).delete().catch(() => undefined),
    db.collection("conversations").doc(CONV_LEGACY).delete().catch(() => undefined),
    db.collection("conversations").doc(CONV_STAMPED).delete().catch(() => undefined),
    db.collection("message_sources").doc(SOURCE_LEGACY).delete().catch(() => undefined),
    db.collection("message_sources").doc(SOURCE_STAMPED).delete().catch(() => undefined),
    db.collection("message_sources").doc(SOURCE_ORPHAN).delete().catch(() => undefined),
    db.collection("message_sources").doc(SOURCE_MISSING_CONVERSATION).delete().catch(() => undefined),
  ]);
});

test("Growth parent-routed SCP view preserves legacy history across list, room, and source reads", async () => {
  const beforeSnapshots = await Promise.all([
    db.collection("conversations").doc(CONV_LEGACY).get(),
    db.collection("conversations").doc(CONV_STAMPED).get(),
    db.collection("message_sources").doc(SOURCE_LEGACY).get(),
    db.collection("message_sources").doc(SOURCE_STAMPED).get(),
  ]);
  const list = await listConversations(request("manager", SAM_EMAIL, { limit: 500, mailAccountId: "scp" }));
  const ids = list.rows.map((row) => row.id);
  assert.equal(list.ok, true);
  assert.equal(list.viewMailAccountId, "scp");
  assert.ok(ids.includes(CONV_LEGACY), "unstamped legacy SCP history must remain visible");
  assert.ok(ids.includes(CONV_STAMPED), "stamped SCP history must remain visible");

  for (const conversationId of [CONV_LEGACY, CONV_STAMPED]) {
    const room = await listConversationMessages(request("manager", SAM_EMAIL, {
      conversationId, mailAccountId: "scp",
    }));
    assert.equal(room.ok, true, `${conversationId} room read should be authorized by the same SCP view`);
  }
  for (const sourceId of [SOURCE_LEGACY, SOURCE_STAMPED]) {
    const source = await getMessageSource(request("manager", SAM_EMAIL, {
      messageRef: `message_sources/${sourceId}`, mailAccountId: "scp",
    }));
    assert.equal(source.ok, true, `${sourceId} source read should be authorized by the same SCP view`);
  }

  const afterSnapshots = await Promise.all([
    db.collection("conversations").doc(CONV_LEGACY).get(),
    db.collection("conversations").doc(CONV_STAMPED).get(),
    db.collection("message_sources").doc(SOURCE_LEGACY).get(),
    db.collection("message_sources").doc(SOURCE_STAMPED).get(),
  ]);
  assert.deepEqual(afterSnapshots.map((snapshot) => snapshot.data()), beforeSnapshots.map((snapshot) => snapshot.data()));
});

test("AIX personal-only view cannot read SCP history or claim another personal account", async () => {
  await assert.rejects(
    () => listConversationMessages(request("manager", AIX_EMAIL, { conversationId: CONV_LEGACY })),
    (error) => error && error.code === "permission-denied",
    "direct room reads must require an account in the caller's strict whitelist",
  );
  await assert.rejects(
    () => getMessageSource(request("manager", AIX_EMAIL, { messageRef: `message_sources/${SOURCE_LEGACY}` })),
    (error) => error && error.code === "permission-denied",
    "direct source reads must use the same strict whitelist",
  );
  await assert.rejects(
    () => listConversations(request("manager", AIX_EMAIL, { limit: 500, mailAccountId: "scp" })),
    (error) => error && error.code === "permission-denied",
    "an unconfigured user cannot select the canonical SCP view",
  );
  await assert.rejects(
    () => listConversations(request("manager", SAM_EMAIL, { limit: 500, mailAccountId: PERSONAL_AIX })),
    (error) => error && error.code === "permission-denied",
    "a Growth user cannot select AIX's personal account",
  );
  await assert.rejects(
    () => getMessageSource(request("manager", SAM_EMAIL, {
      messageRef: `message_sources/${SOURCE_ORPHAN}`, mailAccountId: "scp",
    })),
    (error) => error && error.code === "permission-denied",
    "an unbound source cannot inherit SCP access from a requested view",
  );
  const missingConversationSource = await getMessageSource(request("manager", SAM_EMAIL, {
    messageRef: `message_sources/${SOURCE_MISSING_CONVERSATION}`, mailAccountId: "scp",
  }));
  assert.equal(missingConversationSource.ok, false);
  assert.equal(missingConversationSource.found, false);
});
