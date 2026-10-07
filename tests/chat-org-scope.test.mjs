// Behavioral test for PLAN-ORG-MAIL-IDENTITY Slice 5 account-scoped Chat (functions/read.ts
// resolveConversationOrgScope / canReadConversationForAuth, functions/mailAccountCallables.ts
// getMyOrgContext, functions/userPreferences.ts setUserPreference):
//   - manager/viewer see only conversations whose normalized mailAccountId is in their strict
//     personal + explicitly mapped shared mailbox set. Blank legacy rows normalize to canonical
//     `scp` only for callers entitled to that account; stale row.orgId metadata never revokes a
//     proven account entitlement.
//   - super_admin may inspect the full account inventory; admin still needs its own strict
//     entitlement and may pass { orgId } only as an additional exact metadata filter.
//   - the single-conversation and message-source reads enforce the same positive account rule;
//     an unmapped/foreign account is denied, including direct source references.
//   - getMyOrgContext returns a token/secret-free projection and degrades to orgName:null when
//     Peoply forbids the getOrganization lookup (never throws).
//   - setUserPreference rejects an unknown key and a guest caller.
//
// Firestore emulator required (mail_accounts/settings/mail_routing/conversations are real docs —
// functions/read.ts's adminDb has no injectable seam). Run: npm run test:emu (or `node --test
// tests/chat-org-scope.test.mjs` directly against a running emulator).
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

const { listConversations, listConversationMessages, getMessageSource, getDataset } = await import(new URL("../functions/lib/read.js", import.meta.url));
const { getMyOrgContext } = await import(new URL("../functions/lib/mailAccountCallables.js", import.meta.url));
const { setUserPreference } = await import(new URL("../functions/lib/userPreferences.js", import.meta.url));
const { clearMailAccountResolutionCache } = await import(new URL("../functions/lib/mailAccounts.js", import.meta.url));
const { setPeoplyClientForTests, PeoplyClientError } = await import(new URL("../functions/lib/peoplyClient.js", import.meta.url));

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const ORG_A = `org-a-${RUN}`;
const ORG_B = `org-b-${RUN}`;
const ORG_FORBIDDEN = `org-forbidden-${RUN}`;
const ACCOUNT_A = `acct-a-${RUN}`;
const ACCOUNT_B = `acct-b-${RUN}`;
const PERSONAL_A = `personal-a-${RUN}`;
const ORG_A_MANAGER_EMAIL = `manager-org-a-${RUN}@supercent.io`;
const FORBIDDEN_ORG_MANAGER_EMAIL = `manager-org-forbidden-${RUN}@supercent.io`;

const CONV_LEGACY = `conv-${RUN}-legacy`;
const CONV_ORG_A = `conv-${RUN}-org-a`;
const CONV_ORG_B = `conv-${RUN}-org-b`;

const MSG_SOURCE_LEGACY = `msg-src-${RUN}-legacy`;
const MSG_SOURCE_ORG_A = `msg-src-${RUN}-org-a`;
const MSG_SOURCE_ORG_B = `msg-src-${RUN}-org-b`;
let previousMailRoutingData;

// 2026-09-11 gate fix: recursively collect only primitive string VALUES (never key names) — see
// the getMyOrgContext token/secret-free projection test below for why.
function collectStringLeaves(value, out = []) {
  if (typeof value === "string") { out.push(value); return out; }
  if (Array.isArray(value)) { for (const item of value) collectStringLeaves(item, out); return out; }
  if (value && typeof value === "object") { for (const v of Object.values(value)) collectStringLeaves(v, out); return out; }
  return out;
}

function request(role, { uid, email, data = {} } = {}) {
  if (role === "guest") {
    return { data, auth: { uid: uid ?? `guest-${RUN}`, token: { role: "guest", team: "AIX" } }, rawRequest: { ip: "127.0.0.1" } };
  }
  return {
    data,
    auth: { uid: uid ?? `${role}-${RUN}`, token: { role, team: "AIX", email: email ?? `${role}-${RUN}@supercent.io` } },
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

before(async () => {
  const nowIso = new Date().toISOString();
  const routingSnapshot = await db.doc("settings/mail_routing").get();
  previousMailRoutingData = routingSnapshot.exists ? routingSnapshot.data() : null;
  const existingRouting = previousMailRoutingData && typeof previousMailRoutingData === "object"
    ? previousMailRoutingData
    : {};
  const existingByOrgId = existingRouting.byOrgId && typeof existingRouting.byOrgId === "object"
    ? existingRouting.byOrgId
    : {};
  await Promise.all([
    db.collection("mail_accounts").doc(ACCOUNT_A).set({
      label: "Org A account", mailbox: `ops-a-${RUN}@example.com`, kind: "external_smtp_imap", status: "active",
      ownerEmail: "", orgIds: [ORG_A], smtp: {}, imap: {}, secretRef: "env:MAIL_EXT_ACCOUNT_A_PASSWORD_TEST",
      createdBy: "test", createdAt: nowIso, updatedBy: "test", updatedAt: nowIso,
    }),
    db.collection("mail_accounts").doc(ACCOUNT_B).set({
      label: "Org B account", mailbox: `ops-b-${RUN}@example.com`, kind: "external_smtp_imap", status: "active",
      ownerEmail: "", orgIds: [ORG_B], smtp: {}, imap: {}, secretRef: "env:MAIL_EXT_ACCOUNT_B_PASSWORD_TEST",
      createdBy: "test", createdAt: nowIso, updatedBy: "test", updatedAt: nowIso,
    }),
    db.collection("mail_accounts").doc(PERSONAL_A).set({
      label: "Org A personal", mailbox: `${ORG_A_MANAGER_EMAIL}`, kind: "workspace_oauth", status: "active",
      ownerEmail: ORG_A_MANAGER_EMAIL, orgIds: [ORG_A], smtp: {}, imap: {},
      secretRef: `oauth:mail_oauth_credentials/${PERSONAL_A}`,
      createdBy: "test", createdAt: nowIso, updatedBy: "test", updatedAt: nowIso,
    }),
    db.doc("settings/mail_routing").set({
      defaultAccountId: "scp",
      // ORG_A is explicitly entitled to the canonical SCP mailbox. ORG_B remains a separate
      // shared account so cross-account filtering stays covered.
      byOrgId: { ...existingByOrgId, [ORG_A]: "scp", [ORG_B]: ACCOUNT_B },
      scpAllowedOrgIds: null,
      policyVersion: "mail-routing-v1",
      updatedBy: "test",
      updatedAt: nowIso,
    }, { merge: true }),
  ]);

  setPeoplyClientForTests({
    async getPerson(email) {
      if (email === ORG_A_MANAGER_EMAIL) return peoplyPersonDetail(email, ORG_A);
      if (email === FORBIDDEN_ORG_MANAGER_EMAIL) return peoplyPersonDetail(email, ORG_FORBIDDEN);
      throw new PeoplyClientError("not_found", "no such person");
    },
    async getOrganization(orgId) {
      if (orgId === ORG_A) {
        return {
          id: ORG_A, name: "Org A Display", hrOrgCode: null, parentId: null, active: true,
          type: "team", source: "test", organizationLevel: "", organizationLevelLabel: "", leaders: [],
        };
      }
      throw new PeoplyClientError("forbidden", "Peoply rejected the key", { httpStatus: 403 });
    },
  });
  clearMailAccountResolutionCache();

  // 대화 시드: lastMessageAtIso 는 conversations 의 orderBy 축(functions/read.ts
  // collectionOrderForKey) — Firestore 는 이 필드가 없는 문서를 orderBy 쿼리 결과에서 아예
  // 제외하므로 모든 행에 반드시 있어야 한다(레거시 행도 orgId 만 없을 뿐 이 필드는 있다).
  await Promise.all([
    db.collection("conversations").doc(CONV_LEGACY).set({
      lastMessageAtIso: nowIso, createdAtIso: nowIso, creatorName: "Legacy row (no orgId)",
    }),
    db.collection("conversations").doc(CONV_ORG_A).set({
      lastMessageAtIso: nowIso, createdAtIso: nowIso, creatorName: "Org A SCP row", orgId: ORG_A,
      mailAccountId: "scp",
    }),
    db.collection("conversations").doc(CONV_ORG_B).set({
      lastMessageAtIso: nowIso, createdAtIso: nowIso, creatorName: "Org B row", orgId: ORG_B,
      mailAccountId: ACCOUNT_B,
    }),
    // message_sources 시드 (2026-09-10 adversarial review HIGH 잔여 갭): getMessageSource 가
    // 대화 org 스코프를 실제로 적용하는지 확인하려면 각 대화를 가리키는 원문 문서가 필요하다.
    db.collection("message_sources").doc(MSG_SOURCE_LEGACY).set({
      conversationId: CONV_LEGACY, subject: "Legacy message source", from: "creator@example.com", to: "scp@supercent.io",
    }),
    db.collection("message_sources").doc(MSG_SOURCE_ORG_A).set({
      conversationId: CONV_ORG_A, subject: "Org A message source", from: "creator@example.com", to: "scp@supercent.io",
    }),
    db.collection("message_sources").doc(MSG_SOURCE_ORG_B).set({
      conversationId: CONV_ORG_B, subject: "Org B message source", from: "creator@example.com", to: "scp@supercent.io",
    }),
  ]);
});

after(async () => {
  setPeoplyClientForTests(null);
  clearMailAccountResolutionCache();
  await Promise.all([
    db.collection("mail_accounts").doc(ACCOUNT_A).delete().catch(() => undefined),
    db.collection("mail_accounts").doc(ACCOUNT_B).delete().catch(() => undefined),
    db.collection("mail_accounts").doc(PERSONAL_A).delete().catch(() => undefined),
    db.collection("conversations").doc(CONV_LEGACY).delete().catch(() => undefined),
    db.collection("conversations").doc(CONV_ORG_A).delete().catch(() => undefined),
    db.collection("conversations").doc(CONV_ORG_B).delete().catch(() => undefined),
    db.collection("message_sources").doc(MSG_SOURCE_LEGACY).delete().catch(() => undefined),
    db.collection("message_sources").doc(MSG_SOURCE_ORG_A).delete().catch(() => undefined),
    db.collection("message_sources").doc(MSG_SOURCE_ORG_B).delete().catch(() => undefined),
    db.collection("user_preferences").doc(`manager-${RUN}`).delete().catch(() => undefined),
  ]);
  if (previousMailRoutingData) {
    await db.doc("settings/mail_routing").set(previousMailRoutingData);
  } else {
    await db.doc("settings/mail_routing").delete().catch(() => undefined);
  }
  clearMailAccountResolutionCache();
});

test("listConversations: manager sees entitled SCP/legacy rows, another shared account is hidden", async () => {
  const response = await listConversations(request("manager", { email: ORG_A_MANAGER_EMAIL, data: { limit: 500 } }));
  assert.equal(response.ok, true);
  const ids = response.rows.map((row) => row.id);
  assert.ok(ids.includes(CONV_LEGACY), "legacy (no orgId) row must stay visible");
  assert.ok(ids.includes(CONV_ORG_A), "own-org row must be visible");
  assert.ok(!ids.includes(CONV_ORG_B), "another org's row must be hidden");
  assert.equal(response.viewerOrgId, ORG_A);
  assert.equal(response.orgFilterApplied, true);
});

// Flu conversation org-filter round 4 (codex adversarial review round 2): round 3 added an scp
// org-scope predicate to getDataset's "conversations" key, believing it needed the same gate
// listConversations already applies. It doesn't run at all — "conversations" is a
// PAGED_DATASET_KEYS entry, unconditionally excluded before getDataset's own role/entitlement
// checks even see it (functions/read.ts). That dead branch has been removed. This regression-guards
// the fact: if a future change ever makes "conversations" reachable here again, it MUST go back
// through functions/conversationMailAccessScope.ts's predicate, not silently return raw rows.
test("getDataset: conversations key is a paged dataset key and is never populated by this bulk callable", async () => {
  const response = await getDataset(request("super_admin", { data: { keys: ["conversations"], limit: 500 } }));
  assert.equal(response.ok, true);
  assert.deepEqual(response.conversations, [], "conversations must stay empty here — real access goes through listConversations instead");
});

test("listConversations: viewer gets the same strict account restriction as manager", async () => {
  const response = await listConversations(request("viewer", { email: ORG_A_MANAGER_EMAIL, data: { limit: 500 } }));
  const ids = response.rows.map((row) => row.id);
  assert.ok(ids.includes(CONV_LEGACY));
  assert.ok(ids.includes(CONV_ORG_A));
  assert.ok(!ids.includes(CONV_ORG_B));
});

test("listConversations: admin without own entitlement sees no rows; entitled admin may add an org metadata filter", async () => {
  const unentitled = await listConversations(request("admin", { data: { limit: 500 } }));
  const unentitledIds = unentitled.rows.map((row) => row.id);
  assert.equal(unentitledIds.includes(CONV_LEGACY), false);
  assert.equal(unentitledIds.includes(CONV_ORG_A), false);
  assert.equal(unentitledIds.includes(CONV_ORG_B), false);
  assert.equal(unentitled.orgFilterApplied, false);
  assert.equal(unentitled.viewerOrgId, null);

  const entitled = await listConversations(request("admin", { email: ORG_A_MANAGER_EMAIL, data: { limit: 500 } }));
  const entitledIds = entitled.rows.map((row) => row.id);
  assert.ok(entitledIds.includes(CONV_LEGACY));
  assert.ok(entitledIds.includes(CONV_ORG_A));
  assert.ok(!entitledIds.includes(CONV_ORG_B));

  const filtered = await listConversations(request("admin", { email: ORG_A_MANAGER_EMAIL, data: { limit: 500, orgId: ORG_A } }));
  const filteredIds = filtered.rows.map((row) => row.id);
  assert.deepEqual(filteredIds, [CONV_ORG_A]);
  assert.equal(filtered.orgFilterApplied, true);
});

test("listConversationMessages: denies a manager/admin outside the account whitelist, while super_admin retains inventory access", async () => {
  await assert.rejects(
    () => listConversationMessages(request("manager", { email: ORG_A_MANAGER_EMAIL, data: { conversationId: CONV_ORG_B } })),
    (error) => error && error.code === "permission-denied",
  );
  const ownOrgRead = await listConversationMessages(request("manager", { email: ORG_A_MANAGER_EMAIL, data: { conversationId: CONV_ORG_A } }));
  assert.equal(ownOrgRead.ok, true);
  const legacyRead = await listConversationMessages(request("manager", { email: ORG_A_MANAGER_EMAIL, data: { conversationId: CONV_LEGACY } }));
  assert.equal(legacyRead.ok, true);

  await assert.rejects(
    () => listConversationMessages(request("admin", { email: ORG_A_MANAGER_EMAIL, data: { conversationId: CONV_ORG_B } })),
    (error) => error && error.code === "permission-denied",
  );
  const superAdminRead = await listConversationMessages(request("super_admin", { data: { conversationId: CONV_ORG_B } }));
  assert.equal(superAdminRead.ok, true);
});

test("getMessageSource: applies the same strict account whitelist to linked sources and preserves super_admin inventory access", async () => {
  await assert.rejects(
    () => getMessageSource(request("manager", { email: ORG_A_MANAGER_EMAIL, data: { messageRef: `message_sources/${MSG_SOURCE_ORG_B}` } })),
    (error) => error && error.code === "permission-denied",
    "a manager must not read another org's conversation's message source",
  );
  await assert.rejects(
    () => getMessageSource(request("viewer", { email: ORG_A_MANAGER_EMAIL, data: { messageRef: `message_sources/${MSG_SOURCE_ORG_B}` } })),
    (error) => error && error.code === "permission-denied",
    "a viewer must not read another org's conversation's message source either",
  );

  const ownOrgRead = await getMessageSource(request("manager", { email: ORG_A_MANAGER_EMAIL, data: { messageRef: `message_sources/${MSG_SOURCE_ORG_A}` } }));
  assert.equal(ownOrgRead.ok, true);
  assert.equal(ownOrgRead.found, true);

  const legacyRead = await getMessageSource(request("manager", { email: ORG_A_MANAGER_EMAIL, data: { messageRef: `message_sources/${MSG_SOURCE_LEGACY}` } }));
  assert.equal(legacyRead.ok, true);
  assert.equal(legacyRead.found, true);

  await assert.rejects(
    () => getMessageSource(request("admin", { email: ORG_A_MANAGER_EMAIL, data: { messageRef: `message_sources/${MSG_SOURCE_ORG_B}` } })),
    (error) => error && error.code === "permission-denied",
  );
  const superAdminRead = await getMessageSource(request("super_admin", { data: { messageRef: `message_sources/${MSG_SOURCE_ORG_B}` } }));
  assert.equal(superAdminRead.ok, true);
  assert.equal(superAdminRead.found, true);
});

test("getMyOrgContext: token/secret-free projection, resolves org name via Peoply", async () => {
  const response = await getMyOrgContext(request("manager", { email: ORG_A_MANAGER_EMAIL }));
  assert.equal(response.ok, true);
  assert.equal(response.orgId, ORG_A);
  assert.equal(response.orgName, "Org A Display");
  assert.equal(typeof response.accountLabel, "string");
  assert.equal(typeof response.accountMailbox, "string");
  assert.equal(typeof response.linked, "boolean");
  assert.equal(typeof response.mailConnectNoticeDismissed, "boolean");
  assert.deepEqual(
    response.accessibleAccounts.map((account) => account.accountId).sort(),
    [PERSONAL_A, "scp"].sort(),
    "history view candidates include the caller's personal account and explicit SCP route",
  );
  assert.equal(response.personalAccount.accountId, PERSONAL_A);
  assert.equal(response.orgAccount.accountId, "scp");
  assert.deepEqual(response.usableSenders.map((account) => account.accountId), [PERSONAL_A, "scp"]);
  assert.equal(response.defaultSenderId, "scp");
  assert.equal(response.senderBlockedReason, null);
  assert.equal(response.orgResolutionStatus, "resolved");
  // Flu/Task-51 (scp 계정 배정 허용): getMyOrgContext now also returns orgAccountAssigned —
  // whether this caller's org may resolve the canonical scp account (see
  // functions/mailAccountCallables.ts). Keep this key list in sync with that response shape.
  assert.deepEqual(
    Object.keys(response).sort(),
    [
      "accessibleAccounts", "accountLabel", "accountMailbox", "behaviorLog", "chatMailAccountView",
      "defaultSenderId", "linked", "mailConnectNoticeDismissed", "navPreset", "ok", "orgAccount", "orgAccountAssigned",
      "orgId", "orgName", "orgResolutionStatus", "partnerDataSource", "personalAccount", "personalMailConnectAllowed",
      "senderBlockedReason", "usableSenders", "viewMailAccountId",
      // Flu/Task-50: null on every non-viewAs call (this test never passes viewAsUserId/viewAsEmail)
      // — the key is always present so a viewAs consumer can rely on it without an `in` check.
      "viewingAs",
    ].sort(),
  );
  // 2026-09-11 gate fix: scan VALUES only, not key names — accessibleAccounts (Flu/Task-48)
  // nests toMailAccountPublic's own intentionally-safe `secretRefKind` field ("env"/"oauth"/
  // "none", never the real secretRef), whose KEY name itself contains the substring "secret" and
  // tripped the old JSON.stringify(response) scan on every call, unrelated to any actual leaked
  // value. The real security intent — no secret VALUE ever reaches this projection — is what a
  // values-only scan actually verifies.
  const serializedValues = collectStringLeaves(response).join(" | ").toLowerCase();
  for (const forbidden of ["token", "secret", "password", "apikey", "credential"]) {
    assert.ok(!serializedValues.includes(forbidden), `projection must not contain "${forbidden}"`);
  }
});

test("getMyOrgContext: degrades to orgName:null when Peoply forbids the org lookup, never throws", async () => {
  const response = await getMyOrgContext(request("manager", { email: FORBIDDEN_ORG_MANAGER_EMAIL }));
  assert.equal(response.ok, true);
  assert.equal(response.orgId, ORG_FORBIDDEN);
  assert.equal(response.orgName, null);
});

test("setUserPreference: rejects an unknown key and a guest caller", async () => {
  await assert.rejects(
    () => setUserPreference(request("manager", { uid: `manager-${RUN}`, data: { key: "notARealPreferenceKey" } })),
    (error) => error && error.code === "invalid-argument",
  );
  await assert.rejects(
    () => setUserPreference(request("guest", { data: { key: "mailConnectNoticeDismissedAt" } })),
    (error) => error && (error.code === "permission-denied" || error.code === "unauthenticated"),
  );
  const ok = await setUserPreference(request("manager", { uid: `manager-${RUN}`, data: { key: "mailConnectNoticeDismissedAt" } }));
  assert.equal(ok.ok, true);
  assert.equal(ok.key, "mailConnectNoticeDismissedAt");
});

test("listConversations: a manager whose org is sparse relative to the underlying page (interleaved with many other-org rows) still gets a full page via backfill, and cursor pagination advances without duplicates (2026-09-10 adversarial review HIGH-3)", async () => {
  const ORG_NOISE = `org-noise-${RUN}`;
  const NOISE_COUNT = 8;
  const TARGET_COUNT = 5;
  // Keep this owned fixture ahead of unrelated emulator rows while preserving the intended
  // ordering: eight foreign-account rows first, then five entitled SCP rows.
  const baseMs = Date.now() + 60_000;
  const noiseIds = [];
  const targetIds = [];
  const writes = [];
  // Most-recent rows (higher index = further back in time) all belong to another account, so a
  // single underlying Firestore page (sized limit+1) contains ZERO of the manager's entitled
  // SCP rows — only functions/read.ts's MAX_HIDDEN_PAGE_SCAN_PAGES backfill loop can surface them.
  for (let i = 0; i < NOISE_COUNT; i += 1) {
    const id = `conv-${RUN}-sparse-noise-${i}`;
    noiseIds.push(id);
    writes.push(db.collection("conversations").doc(id).set({
      lastMessageAtIso: new Date(baseMs - i * 1000).toISOString(),
      createdAtIso: new Date(baseMs - i * 1000).toISOString(),
      creatorName: `Sparse noise ${i}`,
      orgId: ORG_NOISE,
      mailAccountId: ACCOUNT_B,
    }));
  }
  for (let i = 0; i < TARGET_COUNT; i += 1) {
    const id = `conv-${RUN}-sparse-target-${i}`;
    targetIds.push(id);
    writes.push(db.collection("conversations").doc(id).set({
      lastMessageAtIso: new Date(baseMs - (NOISE_COUNT + i) * 1000).toISOString(),
      createdAtIso: new Date(baseMs - (NOISE_COUNT + i) * 1000).toISOString(),
      creatorName: `Sparse target ${i}`,
      orgId: ORG_A,
      mailAccountId: "scp",
    }));
  }
  await Promise.all(writes);
  try {
    // Requested limit is padded above TARGET_COUNT: this emulator's conversations collection
    // also has the module-level CONV_ORG_A/CONV_LEGACY rows (same org scope, timestamped before
    // this fixture), which legitimately consume a
    // couple of slots ahead of this test's own rows. The point being proven is backfill (every
    // sparse-target row is found despite being buried behind 8 noise rows on the same page(s)),
    // not an exact row count.
    const response = await listConversations(request("manager", { email: ORG_A_MANAGER_EMAIL, data: { limit: TARGET_COUNT + 3 } }));
    assert.equal(response.ok, true);
    assert.ok(
      response.rows.length >= TARGET_COUNT,
      `backfill must return at least a full page even though the manager's org is sparse relative to the underlying page size (got ${response.rows.length})`,
    );
    const ids = response.rows.map((row) => row.id);
    for (const id of targetIds) assert.ok(ids.includes(id), `${id} must be present`);
    for (const id of noiseIds) assert.ok(!ids.includes(id), `${id} (another account) must never leak`);

    // Cursor progression: walk with a tiny page size until every target row has been seen (or a
    // generous page bound is hit) — proves the cursor advances and never repeats a row. Stops
    // once all targets are found rather than draining to nextCursor:null, since this emulator's
    // conversations collection may hold rows from other test files sharing the same instance.
    const seen = new Set();
    let cursor = "";
    let iterations = 0;
    while (seen.size < TARGET_COUNT && iterations < 10) {
      iterations += 1;
      const page = await listConversations(request("manager", { email: ORG_A_MANAGER_EMAIL, data: { limit: 2, cursor } }));
      for (const row of page.rows) {
        if (targetIds.includes(row.id)) {
          assert.ok(!seen.has(row.id), `row ${row.id} must not repeat across pages`);
          seen.add(row.id);
        }
        assert.ok(!noiseIds.includes(row.id), `${row.id} (another account) must never leak into a page`);
      }
      if (!page.pageInfo.nextCursor) break;
      cursor = page.pageInfo.nextCursor;
    }
    assert.equal(seen.size, TARGET_COUNT, "cursor pagination must reach every target row within a bounded number of pages");
  } finally {
    await Promise.all(
      [...noiseIds, ...targetIds].map((id) => db.collection("conversations").doc(id).delete().catch(() => undefined)),
    );
  }
});

// ---------- Flu/Task-48: [Chat 계정 보기] mailAccountId validation/filtering ----------

test("listConversations: mailAccountId narrows to the caller's entitled personal account; the personal filter excludes legacy SCP rows without the stamp (2026-09-11 adversarial review P1-3)", async () => {
  const nowIso = new Date().toISOString();
  const stampedId = `conv-${RUN}-mailacct-a-stamped`;
  const unstampedId = `conv-${RUN}-mailacct-a-unstamped`;
  await Promise.all([
    db.collection("conversations").doc(stampedId).set({
      lastMessageAtIso: nowIso, createdAtIso: nowIso, creatorName: "Org A personal row", orgId: ORG_A, mailAccountId: PERSONAL_A,
    }),
    db.collection("conversations").doc(unstampedId).set({
      lastMessageAtIso: nowIso, createdAtIso: nowIso, creatorName: "Org A legacy row (no mailAccountId)", orgId: ORG_A,
    }),
  ]);
  try {
    const response = await listConversations(request("manager", {
      email: ORG_A_MANAGER_EMAIL, data: { limit: 500, mailAccountId: PERSONAL_A },
    }));
    assert.equal(response.ok, true);
    assert.equal(response.viewMailAccountId, PERSONAL_A);
    const ids = response.rows.map((row) => row.id);
    assert.ok(ids.includes(stampedId), "the row stamped with the requested account must be visible");
    // PERSONAL_A is a personal (non-scp — PERSONAL_MAIL_ACCOUNT_KINDS) account: a row with no
    // mailAccountId stamp predates every non-scp account and can only ever have been the
    // canonical scp mailbox, so it must never leak into a personal account's filtered view — the
    // org view (no mailAccountId filter at all) keeps the legacy carve-out, proven separately by
    // the "manager sees own-org + legacy rows only" test above.
    assert.ok(!ids.includes(unstampedId), "a legacy row with no mailAccountId stamp must be excluded from a personal account filter");
    assert.ok(!ids.includes(CONV_ORG_B), "another account's row is still excluded, independent of the account filter");
  } finally {
    await Promise.all([
      db.collection("conversations").doc(stampedId).delete().catch(() => undefined),
      db.collection("conversations").doc(unstampedId).delete().catch(() => undefined),
    ]);
  }
});

test("listConversations: a manager passing another org's mailAccountId is rejected with permission-denied (ticket 완료 조건: 다른 조직의 계정 id를 파라미터로 넣으면 서버가 거부한다)", async () => {
  await assert.rejects(
    () => listConversations(request("manager", { email: ORG_A_MANAGER_EMAIL, data: { limit: 500, mailAccountId: ACCOUNT_B } })),
    (error) => error && error.code === "permission-denied",
  );
});

test("listConversations: a manager passing an unknown mailAccountId is rejected", async () => {
  await assert.rejects(
    () => listConversations(request("manager", { email: ORG_A_MANAGER_EMAIL, data: { limit: 500, mailAccountId: `${ACCOUNT_A}-does-not-exist` } })),
    (error) => error && error.code === "permission-denied",
  );
});

test("listConversations: admin without strict entitlement cannot select a known foreign mailbox; super_admin retains inventory access", async () => {
  await assert.rejects(
    () => listConversations(request("admin", { data: { limit: 500, mailAccountId: ACCOUNT_B } })),
    (error) => error && error.code === "permission-denied",
  );
  await assert.rejects(
    () => listConversations(request("admin", { email: ORG_A_MANAGER_EMAIL, data: { limit: 500, mailAccountId: ACCOUNT_B } })),
    (error) => error && error.code === "permission-denied",
  );
  const filtered = await listConversations(request("super_admin", { data: { limit: 500, mailAccountId: ACCOUNT_B } }));
  assert.equal(filtered.ok, true);
  assert.equal(filtered.viewMailAccountId, ACCOUNT_B);

  await assert.rejects(
    () => listConversations(request("admin", { data: { limit: 500, mailAccountId: `${ACCOUNT_B}-does-not-exist` } })),
    (error) => error && error.code === "permission-denied",
  );
});

test("listConversationMessages: a manager passing another org's mailAccountId is denied even for their own org's conversation", async () => {
  await assert.rejects(
    () => listConversationMessages(request("manager", {
      email: ORG_A_MANAGER_EMAIL, data: { conversationId: CONV_ORG_A, mailAccountId: ACCOUNT_B },
    })),
    (error) => error && error.code === "permission-denied",
  );
});

test("getMessageSource: a manager passing another org's mailAccountId is denied even for their own org's message source", async () => {
  await assert.rejects(
    () => getMessageSource(request("manager", {
      email: ORG_A_MANAGER_EMAIL, data: { messageRef: `message_sources/${MSG_SOURCE_ORG_A}`, mailAccountId: ACCOUNT_B },
    })),
    (error) => error && error.code === "permission-denied",
  );
});

// ---------- Flu/Task-51: explicit canonical SCP entitlement and legacy-row preservation ----------
// `scpAllowedOrgIds` predates the strict byOrgId mailbox entitlement. It remains an operational
// setting, but it must not revoke a caller's newly proven explicit SCP view or grant an unmapped
// caller a default SCP view. This regression keeps the old allowlist fixture while asserting the
// current positive account boundary for list, room, and source reads.
test("explicit byOrgId SCP entitlement preserves legacy history while ORG_A is on scpAllowedOrgIds, is revoked the moment ORG_A is excluded (2026-09-27 security fix — killua/T049 leak: an explicit direct route is no longer exempt from the allowlist), and unmapped/admin-without-entitlement callers remain denied throughout", async () => {
  await db.doc("settings/mail_routing").set({ scpAllowedOrgIds: [ORG_A] }, { merge: true });
  clearMailAccountResolutionCache();
  try {
    const managerList = await listConversations(request("manager", { email: ORG_A_MANAGER_EMAIL, data: { limit: 500 } }));
    const managerIds = managerList.rows.map((row) => row.id);
    assert.ok(managerIds.includes(CONV_LEGACY), "explicit SCP route must preserve unstamped legacy rows");
    assert.ok(managerIds.includes(CONV_ORG_A), "explicit SCP route must preserve stamped SCP rows");
    assert.ok(!managerIds.includes(CONV_ORG_B), "the caller's SCP entitlement must not include account B");

    for (const conversationId of [CONV_LEGACY, CONV_ORG_A]) {
      const messages = await listConversationMessages(request("manager", { email: ORG_A_MANAGER_EMAIL, data: { conversationId } }));
      assert.equal(messages.ok, true, `entitled manager can read ${conversationId}`);
    }
    for (const [conversationId, messageSourceId] of [[CONV_LEGACY, MSG_SOURCE_LEGACY], [CONV_ORG_A, MSG_SOURCE_ORG_A]]) {
      const source = await getMessageSource(request("manager", { email: ORG_A_MANAGER_EMAIL, data: { messageRef: `message_sources/${messageSourceId}` } }));
      assert.equal(source.ok, true, `entitled manager can read source for ${conversationId}`);
      assert.equal(source.found, true);
    }

    const unmappedList = await listConversations(request("manager", { email: FORBIDDEN_ORG_MANAGER_EMAIL, data: { limit: 500 } }));
    assert.equal(unmappedList.rows.some((row) => [CONV_LEGACY, CONV_ORG_A].includes(row.id)), false, "unmapped org must not inherit default SCP history");
    await assert.rejects(
      () => listConversationMessages(request("manager", { email: FORBIDDEN_ORG_MANAGER_EMAIL, data: { conversationId: CONV_LEGACY } })),
      (error) => error && error.code === "permission-denied",
    );

    const unentitledAdminList = await listConversations(request("admin", { data: { limit: 500 } }));
    assert.equal(unentitledAdminList.rows.some((row) => [CONV_LEGACY, CONV_ORG_A, CONV_ORG_B].includes(row.id)), false, "admin without a verified entitlement must not read mailbox rows");
    await assert.rejects(
      () => listConversationMessages(request("admin", { data: { conversationId: CONV_ORG_B } })),
      (error) => error && error.code === "permission-denied",
    );

    const superAdminList = await listConversations(request("super_admin", { data: { limit: 500 } }));
    const superAdminIds = superAdminList.rows.map((row) => row.id);
    assert.ok(superAdminIds.includes(CONV_LEGACY));
    assert.ok(superAdminIds.includes(CONV_ORG_A));
    assert.ok(superAdminIds.includes(CONV_ORG_B));
    const superAdminSource = await getMessageSource(request("super_admin", { data: { messageRef: `message_sources/${MSG_SOURCE_ORG_B}` } }));
    assert.equal(superAdminSource.ok, true);
    assert.equal(superAdminSource.found, true);

    // 2026-09-27 security fix (killua/T049 production leak): ORG_A's byOrgId mapping to scp is
    // still a direct, explicit route — but scpAllowedOrgIds now governs it too. Once ORG_A itself
    // is excluded, that explicit route must no longer grant access; there is no more "explicit
    // route beats the allowlist" exemption for the canonical scp mailbox.
    await db.doc("settings/mail_routing").set({ scpAllowedOrgIds: [ORG_B] }, { merge: true });
    clearMailAccountResolutionCache();
    const excludedList = await listConversations(request("manager", { email: ORG_A_MANAGER_EMAIL, data: { limit: 500 } }));
    assert.equal(
      excludedList.rows.some((row) => [CONV_LEGACY, CONV_ORG_A].includes(row.id)),
      false,
      "ORG_A's explicit byOrgId route to scp must no longer grant access once ORG_A itself is off scpAllowedOrgIds",
    );
    await assert.rejects(
      () => listConversationMessages(request("manager", { email: ORG_A_MANAGER_EMAIL, data: { conversationId: CONV_LEGACY } })),
      (error) => error && error.code === "permission-denied",
      "the same explicit route must be denied for a single-conversation read too",
    );
  } finally {
    await db.doc("settings/mail_routing").set({ scpAllowedOrgIds: null }, { merge: true });
    clearMailAccountResolutionCache();
  }
});
