// Focused emulator integration for the member mailbox grant path.
// Uses the deployed v2 CloudFunction `.run()` wrapper objects from functions/lib/index.js and
// the real Firestore emulator. This proves wrapper-level auth/RBAC, audit persistence, Manager
// SCP read/sender entitlement, revoke behavior, and no unexpected business data mutation without
// touching production or sending mail.
// Run:
//   firebase emulators:exec --only auth,functions,firestore --project demo-flu \
//     "node scripts/run-node-tests.mjs --emulator tests/member-mail-account-access-callable-emulator.test.mjs"
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("FIRESTORE_EMULATOR_HOST must be set — run this test with firebase emulators:exec.");
}
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error("FIREBASE_AUTH_EMULATOR_HOST must be set — run this test with firebase emulators:exec.");
}

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "demo-flu";
process.env.GCLOUD_PROJECT = projectId;
process.env.GOOGLE_CLOUD_PROJECT = projectId;
process.env.FUNCTIONS_EMULATOR = "true";

const here = dirname(fileURLToPath(import.meta.url));
const requireFromFunctions = createRequire(join(here, "..", "functions", "package.json"));
const admin = requireFromFunctions("firebase-admin");
const { FieldValue } = requireFromFunctions("firebase-admin/firestore");
if (!admin.apps.length) admin.initializeApp({ projectId });
const db = admin.firestore();
const authAdmin = admin.auth();
const index = await import(new URL("../functions/lib/index.js", import.meta.url));
const adminModule = await import(new URL("../functions/lib/admin.js", import.meta.url));

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SUPER_UID = `member-mail-super-${RUN}`;
const ADMIN_UID = `member-mail-admin-${RUN}`;
const GUEST_UID = `member-mail-guest-${RUN}`;
const MANAGER_UID = `member-mail-manager-${RUN}`;
const SUPER_EMAIL = `member-mail-super-${RUN}@supercent.io`;
const ADMIN_EMAIL = `member-mail-admin-${RUN}@supercent.io`;
const GUEST_EMAIL = `member-mail-guest-${RUN}@supercent.io`;
const MANAGER_EMAIL = "scp@supercent.io";
const CONVERSATION_ID = `member-mail-conv-${RUN}`;
const ALIAS_MEMBER_ID = `member-mail-alias-${RUN}`;
const UID_MISMATCH_MEMBER_ID = `member-mail-uid-mismatch-${RUN}`;
const START_ISO = new Date().toISOString();
const AUDIT_COLLECTIONS = new Set(["behavior_logs", "callableRuns", "engineSnapshots"]);

function auth(uid, email, role) {
  return { uid, token: { role, team: "AIX", email } };
}

function request(authContext, data = {}) {
  return { auth: authContext, data, rawRequest: { ip: "127.0.0.1" }, app: undefined };
}

function unwrap(response) {
  return response?.result ?? response;
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code.replace(/^functions\//, "") : "";
}

function canonical(value) {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value?.toMillis === "function") return { __timestampMillis: value.toMillis() };
  if (typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

async function digestBusinessCollections() {
  const collections = (await db.listCollections())
    .filter((collection) => !AUDIT_COLLECTIONS.has(collection.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const rows = [];
  for (const collection of collections) {
    const snapshot = await collection.get();
    for (const doc of snapshot.docs.sort((left, right) => left.id.localeCompare(right.id))) {
      const data = doc.data();
      const path = doc.ref.path ?? `${collection.id}/${doc.id}`;
      rows.push({
        path,
        data: path === `members/${MANAGER_UID}`
          ? canonical({
              ...data,
              mailAccountIds: "<allowed-to-change>",
              mailAccountAccessUpdatedBy: "<allowed-to-change>",
              mailAccountAccessUpdatedAtIso: "<allowed-to-change>",
            })
          : canonical(data),
      });
    }
  }
  const serialized = JSON.stringify(rows);
  return { count: rows.length, hash: createHash("sha256").update(serialized).digest("hex") };
}

async function grantAuditRows() {
  const snapshot = await db.collection("behavior_logs")
    .where("action", "==", "mail_accounts.member_access.update")
    .get();
  return snapshot.docs.map((doc) => doc.data()).filter((row) => row.userId === SUPER_UID);
}

before(async () => {
  await Promise.all([
    authAdmin.createUser({ uid: SUPER_UID, email: SUPER_EMAIL, emailVerified: true }).catch(() => undefined),
    authAdmin.createUser({ uid: ADMIN_UID, email: ADMIN_EMAIL, emailVerified: true }).catch(() => undefined),
    authAdmin.createUser({ uid: GUEST_UID, email: GUEST_EMAIL, emailVerified: true }).catch(() => undefined),
    authAdmin.createUser({ uid: MANAGER_UID, email: MANAGER_EMAIL, emailVerified: true }).catch(() => undefined),
    db.collection("members").doc(SUPER_UID).set({ id: SUPER_UID, uid: SUPER_UID, email: SUPER_EMAIL, role: "super_admin", team: "AIX", status: "active", createdAt: START_ISO, updatedAt: START_ISO }),
    db.collection("members").doc(ADMIN_UID).set({ id: ADMIN_UID, uid: ADMIN_UID, email: ADMIN_EMAIL, role: "admin", team: "AIX", status: "active", createdAt: START_ISO, updatedAt: START_ISO }),
    db.collection("members").doc(MANAGER_UID).set({
      id: MANAGER_UID,
      uid: MANAGER_UID,
      email: MANAGER_EMAIL,
      name: "SCP Manager Mailbox Identity",
      role: "manager",
      team: "AIX",
      status: "active",
      createdAt: START_ISO,
      updatedAt: START_ISO,
    }),
    db.collection("members").doc(ALIAS_MEMBER_ID).set({
      id: ALIAS_MEMBER_ID,
      uid: ALIAS_MEMBER_ID,
      email: MANAGER_EMAIL,
      name: "Stale SCP Alias Grant",
      role: "manager",
      team: "AIX",
      status: "active",
      mailAccountIds: ["scp"],
      createdAt: START_ISO,
      updatedAt: START_ISO,
    }),
    db.collection("members").doc(UID_MISMATCH_MEMBER_ID).set({
      id: UID_MISMATCH_MEMBER_ID,
      uid: `${UID_MISMATCH_MEMBER_ID}-stored`,
      email: `uid-mismatch-${RUN}@supercent.io`,
      name: "Stored UID Mismatch",
      role: "manager",
      team: "AIX",
      status: "active",
      createdAt: START_ISO,
      updatedAt: START_ISO,
    }),
    db.collection("members").doc(GUEST_UID).set({
      id: GUEST_UID,
      uid: GUEST_UID,
      email: GUEST_EMAIL,
      name: "Guest Control",
      role: "guest",
      team: "AIX",
      status: "active",
      createdAt: START_ISO,
      updatedAt: START_ISO,
    }),
    db.collection("integrations").doc("default").set({
      mailSmtp: { public: { host: "smtp.example.com", port: 587, secure: false, username: MANAGER_EMAIL, fromAddress: MANAGER_EMAIL }, secrets: { password: { fingerprint: "emulator" } } },
      mailImap: { public: { host: "imap.example.com", port: 993, secure: true, username: MANAGER_EMAIL }, secrets: { password: { fingerprint: "emulator" } } },
    }, { merge: true }),
    db.collection("conversations").doc(CONVERSATION_ID).set({
      id: CONVERSATION_ID,
      creatorName: "SCP member mailbox grant proof",
      mailAccountId: "scp",
      lastMessageAtIso: START_ISO,
      createdAtIso: START_ISO,
      updatedAt: FieldValue.serverTimestamp(),
    }),
  ]);
});

after(async () => {
  await Promise.all([
    db.collection("members").doc(SUPER_UID).delete().catch(() => undefined),
    db.collection("members").doc(ADMIN_UID).delete().catch(() => undefined),
    db.collection("members").doc(MANAGER_UID).delete().catch(() => undefined),
    db.collection("members").doc(ALIAS_MEMBER_ID).delete().catch(() => undefined),
    db.collection("members").doc(UID_MISMATCH_MEMBER_ID).delete().catch(() => undefined),
    db.collection("members").doc(GUEST_UID).delete().catch(() => undefined),
    db.collection("integrations").doc("default").delete().catch(() => undefined),
    db.collection("conversations").doc(CONVERSATION_ID).delete().catch(() => undefined),
    authAdmin.deleteUser(SUPER_UID).catch(() => undefined),
    authAdmin.deleteUser(ADMIN_UID).catch(() => undefined),
    authAdmin.deleteUser(GUEST_UID).catch(() => undefined),
    authAdmin.deleteUser(MANAGER_UID).catch(() => undefined),
  ]);
});

test("deployed wrapper grants and revokes SCP mailbox access only for super_admin", async () => {
  assert.equal(typeof index.setMemberMailAccountAccess.run, "function");
  assert.equal(typeof index.getMyOrgContext.run, "function");
  assert.equal(typeof index.listConversations.run, "function");

  const superAuth = auth(SUPER_UID, SUPER_EMAIL, "super_admin");
  const adminAuth = auth(ADMIN_UID, ADMIN_EMAIL, "admin");
  const guestAuth = auth(GUEST_UID, GUEST_EMAIL, "guest");
  const managerAuth = auth(MANAGER_UID, MANAGER_EMAIL, "manager");

  for (const [label, callerAuth] of [["admin", adminAuth], ["guest", guestAuth]]) {
    await assert.rejects(
      () => index.setMemberMailAccountAccess.run(request(callerAuth, { uid: MANAGER_UID, mailAccountIds: ["scp"] })),
      (error) => {
        assert.equal(errorCode(error), "permission-denied", `${label} must not update member mailbox grants`);
        return true;
      },
    );
  }

  await assert.rejects(
    () => index.setMemberMailAccountAccess.run(request(superAuth, { uid: ALIAS_MEMBER_ID, mailAccountIds: ["scp"] })),
    (error) => {
      assert.equal(errorCode(error), "invalid-argument", "stale same-email alias without a matching verified Auth UID must not receive grant writes");
      return true;
    },
  );
  const aliasAfterDirectGrantAttempt = (await db.collection("members").doc(ALIAS_MEMBER_ID).get()).data();
  assert.deepEqual(aliasAfterDirectGrantAttempt.mailAccountIds, ["scp"], "rejected alias grant must preserve the stale alias fixture only");
  assert.equal("mailAccountAccessUpdatedBy" in aliasAfterDirectGrantAttempt, false);
  assert.equal("mailAccountAccessUpdatedAtIso" in aliasAfterDirectGrantAttempt, false);

  await assert.rejects(
    () => index.setMemberMailAccountAccess.run(request(superAuth, { uid: UID_MISMATCH_MEMBER_ID, mailAccountIds: ["scp"] })),
    (error) => {
      assert.equal(errorCode(error), "invalid-argument", "stored uid mismatch must reject before grant metadata is written");
      return true;
    },
  );
  const mismatchAfterDirectGrantAttempt = (await db.collection("members").doc(UID_MISMATCH_MEMBER_ID).get()).data();
  assert.equal(mismatchAfterDirectGrantAttempt.uid, `${UID_MISMATCH_MEMBER_ID}-stored`);
  assert.equal("mailAccountIds" in mismatchAfterDirectGrantAttempt, false);
  assert.equal("mailAccountAccessUpdatedBy" in mismatchAfterDirectGrantAttempt, false);
  assert.equal("mailAccountAccessUpdatedAtIso" in mismatchAfterDirectGrantAttempt, false);

  await assert.rejects(
    () => index.listConversations.run(request(managerAuth, { mailAccountId: "scp", ids: [CONVERSATION_ID] })),
    (error) => {
      assert.equal(errorCode(error), "permission-denied", "manager must not read SCP mailbox before the explicit grant");
      return true;
    },
  );

  const baselineDigest = await digestBusinessCollections();
  const grant = unwrap(await index.setMemberMailAccountAccess.run(request(superAuth, { uid: MANAGER_UID, mailAccountIds: ["scp", "scp"] })));
  assert.equal(grant.ok, true);
  assert.equal(grant.uid, MANAGER_UID);
  assert.deepEqual(grant.mailAccountIds, ["scp"]);

  const grantedMember = (await db.collection("members").doc(MANAGER_UID).get()).data();
  assert.equal(grantedMember.uid, MANAGER_UID);
  assert.equal(grantedMember.email, MANAGER_EMAIL);
  assert.equal(grantedMember.role, "manager", "mailbox grant must not elevate role");
  assert.equal(grantedMember.status, "active", "mailbox grant must not change member status");
  assert.deepEqual(grantedMember.mailAccountIds, ["scp"]);
  assert.equal(grantedMember.mailAccountAccessUpdatedBy, SUPER_UID);
  assert.equal(typeof grantedMember.mailAccountAccessUpdatedAtIso, "string");

  const orgContext = unwrap(await index.getMyOrgContext.run(request(managerAuth)));
  assert.equal(orgContext.ok, true);
  assert.equal(orgContext.orgResolutionStatus, "unresolved");
  assert.equal(orgContext.defaultSenderId, "scp");
  assert.deepEqual(orgContext.usableSenders.map((account) => account.accountId), ["scp"]);
  assert.deepEqual(orgContext.accessibleAccounts.map((account) => account.accountId), ["scp"]);
  assert.equal(orgContext.accountMailbox, MANAGER_EMAIL);

  const readResponse = unwrap(await index.listConversations.run(request(managerAuth, { mailAccountId: "scp", ids: [CONVERSATION_ID] })));
  assert.equal(readResponse.ok, true);
  assert.deepEqual(readResponse.rows.map((row) => row.id), [CONVERSATION_ID]);
  assert.equal(readResponse.viewMailAccountId, "scp");

  const adminMembers = unwrap(await index.getDataset.run(request(adminAuth, { keys: ["members"] }))).members;
  const adminMember = adminMembers.find((member) => member.id === MANAGER_UID);
  assert.ok(adminMember, "admin keeps member rows for role-management UI");
  assert.equal("mailAccountIds" in adminMember, false, "admin member projection redacts mailbox grants");
  assert.equal("mailAccountAccessUpdatedBy" in adminMember, false);
  assert.equal("mailAccountAccessUpdatedAtIso" in adminMember, false);

  const superMembers = unwrap(await index.getDataset.run(request(superAuth, { keys: ["members"] }))).members;
  const superMember = superMembers.find((member) => member.id === MANAGER_UID);
  assert.deepEqual(superMember.mailAccountIds, ["scp"], "super_admin projection includes mailbox grants for the grant UI");
  assert.equal(superMember.mailAccountAccessUpdatedBy, SUPER_UID);

  const businessAfterGrant = await digestBusinessCollections();
  assert.equal(businessAfterGrant.hash, baselineDigest.hash, "grant may only change target member grant fields plus audit collections");
  assert.equal(businessAfterGrant.count, baselineDigest.count);

  const revoke = unwrap(await index.setMemberMailAccountAccess.run(request(superAuth, { uid: MANAGER_UID, mailAccountIds: [] })));
  assert.equal(revoke.ok, true);
  assert.deepEqual(revoke.mailAccountIds, []);

  const revokedMember = (await db.collection("members").doc(MANAGER_UID).get()).data();
  assert.equal(revokedMember.role, "manager", "revoke must not alter role");
  assert.equal(revokedMember.status, "active", "revoke must not alter status");
  assert.deepEqual(revokedMember.mailAccountIds, []);
  assert.equal(revokedMember.mailAccountAccessUpdatedBy, SUPER_UID);

  const contextAfterRevoke = unwrap(await index.getMyOrgContext.run(request(managerAuth)));
  assert.equal(contextAfterRevoke.ok, true);
  assert.equal(contextAfterRevoke.defaultSenderId, null);
  assert.equal(contextAfterRevoke.senderBlockedReason, "personal_connection_required");
  assert.deepEqual(contextAfterRevoke.usableSenders, []);
  assert.deepEqual(contextAfterRevoke.accessibleAccounts, []);

  await assert.rejects(
    () => index.listConversations.run(request(managerAuth, { mailAccountId: "scp", ids: [CONVERSATION_ID] })),
    (error) => {
      assert.equal(errorCode(error), "permission-denied", "manager must lose SCP read access after revoke");
      return true;
    },
  );

  const businessAfterRevoke = await digestBusinessCollections();
  assert.equal(businessAfterRevoke.hash, baselineDigest.hash, "revoke must restore the business digest apart from allowed member audit fields");
  assert.equal(businessAfterRevoke.count, baselineDigest.count);

  const aliasBootstrap = await adminModule.requestAccess(request(managerAuth, { bootstrap: true }));
  assert.equal(aliasBootstrap.ok, false, "a same-email alias grant must not authorize the exact Auth UID during bootstrap");
  assert.equal(aliasBootstrap.status, "mailbox_access_required");
  assert.equal(aliasBootstrap.role, "guest");
  const exactAfterAliasBootstrap = (await db.collection("members").doc(MANAGER_UID).get()).data();
  assert.notDeepEqual(exactAfterAliasBootstrap.mailAccountIds, ["scp"], "bootstrap must not copy alias mailbox grants onto members/{auth.uid}");

  const auditRows = await grantAuditRows();
  assert.equal(auditRows.length, 2, "grant and revoke must both be audited as SuperAdmin member-access updates");
  assert.ok(auditRows.every((row) => row.role === "super_admin"));
});
