// Behavioral test for functions/read.ts's effectiveConversationAuth (Flu/Task-50 적대 리뷰 P0-2) —
// the helper that listConversations/listConversationMessages/getMessageSource use to recompute
// Chat's org/account scope for a super_admin's "대신 보기" target instead of the caller's own.
// No emulator, no network: effectiveConversationAuth itself does no Firestore I/O beyond delegating
// to resolveViewAsTarget (functions/mailAccountCallables.ts), whose members-collection lookup is
// swapped for a fake db via mailAccounts.ts's setMailAccountsDbForTests (same seam
// tests/mail-account-callables.test.mjs uses).
// Run: npm --prefix functions run build && node --test tests/conversation-view-as-scope.test.mjs
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

const { effectiveConversationAuth } = await import(new URL("../functions/lib/read.js", import.meta.url));
const { setMailAccountsDbForTests } = await import(new URL("../functions/lib/mailAccounts.js", import.meta.url));
const { setMailAccountGrantAuthVerifierForTests } = await import(new URL("../functions/lib/mailAccountCallables.js", import.meta.url));

function createFakeDb(initialDocs = {}) {
  const store = new Map(Object.entries(initialDocs));
  function snapshotFor(path) {
    const exists = store.has(path);
    return { id: path.split("/").pop(), exists, data: () => (exists ? store.get(path) : undefined) };
  }
  function docRef(path) {
    return {
      async get() { return snapshotFor(path); },
      async set(data) { store.set(path, data); },
    };
  }
  return {
    collection(name) {
      return { doc(id) { return docRef(`${name}/${id}`); } };
    },
    doc(path) { return docRef(path); },
    __store: store,
  };
}

function auth(role, overrides = {}) {
  return { userId: `caller-${role}`, role, team: "AIX", ip: "127.0.0.1", gameId: "global", email: "boss@supercent.io", ...overrides };
}

beforeEach(() => {
  setMailAccountsDbForTests(createFakeDb());
  setMailAccountGrantAuthVerifierForTests({
    async getUser(uid) {
      if (uid !== "hesse-uid") throw Object.assign(new Error(`missing auth user: ${uid}`), { code: "auth/user-not-found" });
      return { uid: "hesse-uid", email: "hesse@supercent.io", emailVerified: true };
    },
  });
});

after(() => {
  setMailAccountsDbForTests(null);
  setMailAccountGrantAuthVerifierForTests(null);
});

test("effectiveConversationAuth: no viewAs fields in requestData returns the same auth object untouched", async () => {
  const callerAuth = auth("manager");
  const result = await effectiveConversationAuth(callerAuth, {});
  assert.equal(result, callerAuth, "must be the exact same reference — no derived object when viewAs isn't requested");
});

test("effectiveConversationAuth: a non-super_admin caller passing viewAsUserId/viewAsEmail is rejected (AUTH-P0-003)", async () => {
  await assert.rejects(
    effectiveConversationAuth(auth("admin"), { viewAsUserId: "hesse-uid", viewAsEmail: "hesse@supercent.io" }),
    (error) => {
      assert.equal(error.code, "permission-denied");
      assert.equal(error.errorCode, "view_as_forbidden");
      return true;
    },
  );
});

test("effectiveConversationAuth: an unverified viewAsUserId (no matching members doc) is rejected", async () => {
  await assert.rejects(
    effectiveConversationAuth(auth("super_admin"), { viewAsUserId: "ghost-uid", viewAsEmail: "ghost@supercent.io" }),
    (error) => {
      assert.equal(error.code, "invalid-argument");
      assert.equal(error.errorCode, "view_as_target_mismatch");
      return true;
    },
  );
});

test("effectiveConversationAuth: a super_admin with a verified target gets an auth derived from the TARGET's role/email/uid, not their own — role defaults to viewer when the member has none of the AuthContext-eligible roles", async () => {
  const db = createFakeDb({
    "members/hesse-uid": { uid: "hesse-uid", email: "hesse@supercent.io", name: "hesse", role: "manager", status: "active" },
  });
  setMailAccountsDbForTests(db);
  const callerAuth = auth("super_admin");
  const result = await effectiveConversationAuth(callerAuth, { viewAsUserId: "hesse-uid", viewAsEmail: "hesse@supercent.io" });
  assert.notEqual(result, callerAuth, "must be a derived object, not the caller's own auth");
  assert.equal(result.role, "manager", "role must be the TARGET's role — this is what makes super_admin/admin's org-scope bypass apply to the target instead of the caller");
  assert.equal(result.email, "hesse@supercent.io");
  assert.equal(result.userId, "hesse-uid");
  // team/ip/gameId are caller-derived bookkeeping fields, not identity — they carry over untouched.
  assert.equal(result.team, callerAuth.team);
});

test("effectiveConversationAuth: a verified target with no role or guest role is denied", async () => {
  for (const role of [undefined, "guest"]) {
    const db = createFakeDb({
      "members/hesse-uid": { uid: "hesse-uid", email: "hesse@supercent.io", name: "hesse", status: "active", ...(role ? { role } : {}) },
    });
    setMailAccountsDbForTests(db);
    await assert.rejects(
      effectiveConversationAuth(auth("super_admin"), { viewAsUserId: "hesse-uid", viewAsEmail: "hesse@supercent.io" }),
      (error) => error?.code === "permission-denied" && error?.errorCode === "view_as_target_role_invalid",
    );
  }
});
