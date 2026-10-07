// Flu/Task-48 [Chat 계정 보기] — live behavior of the personal-account view end to end, against
// the Firestore emulator (mail_accounts/settings/mail_routing/conversations are real docs — see
// tests/chat-org-scope.test.mjs's own header for why this needs the emulator rather than the
// swappable fake-db seam tests/chat-mail-account-view-permission-denied.test.mjs uses):
//   - a caller with an active self-linked (workspace_oauth) personal account, filtering
//     listConversations by mailAccountId=their own account, sees only rows stamped with that
//     account — a legacy row with no mailAccountId stamp is excluded (2026-09-11 adversarial
//     review P1-3, same rule tests/chat-org-scope.test.mjs already covers for a generic
//     external_smtp_imap account; this file exercises it for a real self-linked personal account).
//   - a mailAccountId belonging to another org is denied with permission-denied.
//   - setMailRouting revoking personalMailAllowedOrgIds for the caller's org disables their
//     active personal account (disableAccountsForRevokedOrgs, functions/mailAccountCallables.ts)
//     — a follow-up listConversations request for that (now disabled) account is denied, and
//     getMyOrgContext forces the caller back onto the org account view.
//
// Seeding pattern copied from tests/chat-org-scope.test.mjs.
// Run: npm run test:emu (or `node --test tests/chat-mail-account-view-emulator.test.mjs` directly
// against a running emulator).
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

const { listConversations } = await import(new URL("../functions/lib/read.js", import.meta.url));
const { setMailRouting, getMyOrgContext } = await import(new URL("../functions/lib/mailAccountCallables.js", import.meta.url));
const { clearMailAccountResolutionCache } = await import(new URL("../functions/lib/mailAccounts.js", import.meta.url));
const { setPeoplyClientForTests, PeoplyClientError } = await import(new URL("../functions/lib/peoplyClient.js", import.meta.url));

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const ORG_A = `org-view-a-${RUN}`;
const ORG_B = `org-view-b-${RUN}`;
const ACCOUNT_A = `acct-view-a-${RUN}`;
const ACCOUNT_B = `acct-view-b-${RUN}`;
const PERSONAL_ACCOUNT = `acct-view-personal-${RUN}`;
const MANAGER_EMAIL = `manager-view-${RUN}@supercent.io`;
const MANAGER_UID = `manager-view-${RUN}`;

const CONV_PERSONAL_STAMPED = `conv-${RUN}-view-personal-stamped`;
const CONV_LEGACY_UNSTAMPED = `conv-${RUN}-view-legacy-unstamped`;

function request(role, { uid, email, data = {} } = {}) {
  return {
    data,
    auth: { uid: uid ?? `${role}-${RUN}`, token: { role, team: "AIX", email: email ?? `${role}-${RUN}@supercent.io` } },
    rawRequest: { ip: "127.0.0.1" },
  };
}

before(async () => {
  const nowIso = new Date().toISOString();
  await Promise.all([
    db.collection("mail_accounts").doc(ACCOUNT_A).set({
      label: "Org A account", mailbox: `ops-view-a-${RUN}@example.com`, kind: "external_smtp_imap", status: "active",
      ownerEmail: "", orgIds: [ORG_A], smtp: {}, imap: {}, secretRef: "env:MAIL_EXT_VIEW_ACCOUNT_A_PASSWORD_TEST",
      createdBy: "test", createdAt: nowIso, updatedBy: "test", updatedAt: nowIso,
    }),
    db.collection("mail_accounts").doc(ACCOUNT_B).set({
      label: "Org B account", mailbox: `ops-view-b-${RUN}@example.com`, kind: "external_smtp_imap", status: "active",
      ownerEmail: "", orgIds: [ORG_B], smtp: {}, imap: {}, secretRef: "env:MAIL_EXT_VIEW_ACCOUNT_B_PASSWORD_TEST",
      createdBy: "test", createdAt: nowIso, updatedBy: "test", updatedAt: nowIso,
    }),
    db.collection("mail_accounts").doc(PERSONAL_ACCOUNT).set({
      label: "Manager's personal mailbox", mailbox: MANAGER_EMAIL, kind: "workspace_oauth", status: "active",
      ownerEmail: MANAGER_EMAIL, orgIds: [], smtp: {}, imap: {},
      secretRef: `oauth:mail_oauth_credentials/${PERSONAL_ACCOUNT}`,
      createdBy: "test", createdAt: nowIso, updatedBy: "test", updatedAt: nowIso,
    }),
    db.doc("settings/mail_routing").set({
      defaultAccountId: "scp",
      byOrgId: { [ORG_A]: ACCOUNT_A, [ORG_B]: ACCOUNT_B },
      personalMailAllowedOrgIds: [ORG_A],
      chatPersonalViewDefaultOrgIds: [],
      policyVersion: "mail-routing-v1",
      updatedBy: "test",
      updatedAt: nowIso,
    }),
  ]);

  setPeoplyClientForTests({
    async getPerson(email) {
      if (email === MANAGER_EMAIL) return { employee: { primaryMembership: ORG_A }, memberships: [] };
      throw new PeoplyClientError("not_found", "no such person");
    },
    async getOrganization(orgId) {
      if (orgId === ORG_A) {
        return {
          id: ORG_A, name: "Org A View Display", hrOrgCode: null, parentId: null, active: true,
          type: "team", source: "test", organizationLevel: "", organizationLevelLabel: "", leaders: [],
        };
      }
      throw new PeoplyClientError("forbidden", "Peoply rejected the key", { httpStatus: 403 });
    },
  });
  clearMailAccountResolutionCache();

  await Promise.all([
    db.collection("conversations").doc(CONV_PERSONAL_STAMPED).set({
      lastMessageAtIso: nowIso, createdAtIso: nowIso, creatorName: "Personal-account stamped row",
      orgId: ORG_A, mailAccountId: PERSONAL_ACCOUNT,
    }),
    db.collection("conversations").doc(CONV_LEGACY_UNSTAMPED).set({
      lastMessageAtIso: nowIso, createdAtIso: nowIso, creatorName: "Org A legacy row (no mailAccountId)",
      orgId: ORG_A,
    }),
  ]);
});

after(async () => {
  setPeoplyClientForTests(null);
  clearMailAccountResolutionCache();
  await Promise.all([
    db.collection("mail_accounts").doc(ACCOUNT_A).delete().catch(() => undefined),
    db.collection("mail_accounts").doc(ACCOUNT_B).delete().catch(() => undefined),
    db.collection("mail_accounts").doc(PERSONAL_ACCOUNT).delete().catch(() => undefined),
    db.collection("conversations").doc(CONV_PERSONAL_STAMPED).delete().catch(() => undefined),
    db.collection("conversations").doc(CONV_LEGACY_UNSTAMPED).delete().catch(() => undefined),
    db.collection("user_preferences").doc(MANAGER_UID).delete().catch(() => undefined),
  ]);
});

test("listConversations: mailAccountId=own personal account returns only rows stamped with that account (legacy unstamped rows excluded)", async () => {
  const response = await listConversations(request("manager", {
    uid: MANAGER_UID, email: MANAGER_EMAIL, data: { limit: 500, mailAccountId: PERSONAL_ACCOUNT },
  }));
  assert.equal(response.ok, true);
  assert.equal(response.viewMailAccountId, PERSONAL_ACCOUNT);
  const ids = response.rows.map((row) => row.id);
  assert.ok(ids.includes(CONV_PERSONAL_STAMPED), "the row stamped with the caller's own personal account must be visible");
  assert.ok(!ids.includes(CONV_LEGACY_UNSTAMPED), "a legacy row with no mailAccountId stamp must be excluded from a personal account filter");
});

test("listConversations: another org's mailAccountId is denied with permission-denied", async () => {
  await assert.rejects(
    () => listConversations(request("manager", {
      uid: MANAGER_UID, email: MANAGER_EMAIL, data: { limit: 500, mailAccountId: ACCOUNT_B },
    })),
    (error) => error && error.code === "permission-denied",
  );
});

test("setMailRouting revoking personalMailAllowedOrgIds for the caller's org disables their personal account; a follow-up request for it is denied and getMyOrgContext forces the org view", async () => {
  const routingResponse = await setMailRouting(request("admin", { data: { personalMailAllowedOrgIds: [] } }));
  assert.equal(routingResponse.ok, true);
  assert.ok(
    (routingResponse.disabledAccountIds ?? []).includes(PERSONAL_ACCOUNT),
    "revoking org-a from personalMailAllowedOrgIds must disable the manager's active personal account",
  );

  const disabledDoc = await db.collection("mail_accounts").doc(PERSONAL_ACCOUNT).get();
  assert.equal(disabledDoc.data().status, "disabled");

  await assert.rejects(
    () => listConversations(request("manager", {
      uid: MANAGER_UID, email: MANAGER_EMAIL, data: { limit: 500, mailAccountId: PERSONAL_ACCOUNT },
    })),
    (error) => error && error.code === "permission-denied",
    "the now-disabled personal account must no longer be accessible to its own owner",
  );

  const orgContext = await getMyOrgContext(request("manager", { uid: MANAGER_UID, email: MANAGER_EMAIL }));
  assert.equal(orgContext.ok, true);
  assert.equal(orgContext.personalMailConnectAllowed, false);
  assert.equal(orgContext.chatMailAccountView, "org", "the toggle must be forced back to the org view once personal connect is revoked");
  assert.equal(orgContext.viewMailAccountId, ACCOUNT_A, "viewMailAccountId must land on the org account, not the disabled personal account");
});
