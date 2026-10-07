import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test, before } from "node:test";
import { fileURLToPath } from "node:url";

// S4/P4 (RT-4/A4, COST-P0-011 + Q3) — behavior tests for the on-demand chat-open prefill
// cost gate and the needs_review "reference-only" draft field. Wires gatewayProxy +
// withAutoPrefillCache exactly as index.ts does (`callable(withAutoPrefillCache(gatewayProxyHandler), ...)`)
// so the test exercises the real composition, not a re-implementation.

const here = dirname(fileURLToPath(import.meta.url));
const requireFromFunctions = createRequire(join(here, "..", "functions", "package.json"));
const admin = requireFromFunctions("firebase-admin");

const PROJECT_ID = process.env.GCLOUD_PROJECT || "demo-flu";
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("FIRESTORE_EMULATOR_HOST must be set — run this test against the Firestore emulator.");
}
process.env.FUNCTIONS_EMULATOR = "true";
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

const { gatewayProxy, receiveEmail } = await import(new URL("../functions/lib/chat-ai.js", import.meta.url));
const { withAutoPrefillCache } = await import(new URL("../functions/lib/chatDraftPrefillCache.js", import.meta.url));
const { setPeoplyClientForTests } = await import(new URL("../functions/lib/peoplyClient.js", import.meta.url));
const { clearMailAccountResolutionCache, MAIL_ACCOUNT_ACCESS_FIELD } = await import(new URL("../functions/lib/mailAccounts.js", import.meta.url));

const wrappedGatewayProxy = withAutoPrefillCache(gatewayProxy);

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
// Flu conversation org-filter round 11 (codex adversarial review round 11, finding #1):
// exactFeedbackScopeForGateway now applies the FULL mail-conversation predicate
// (canReadConversationRowForScope), which folds a blank mailAccountId into the canonical "scp"
// identity for ENTITLEMENT purposes too (not just the org gate) — matching listConversations'
// own behavior. MANAGER_AUTH's conversations here are ordinary, non-scp "direct" chat threads the
// caller owns; they need SOME positive mailbox entitlement to remain readable under the corrected
// predicate, same as any real employee would have via their own connected mailbox. `@demo-flu` is
// the emulator-only domain readExplicitMailAccountIds accepts for a per-user grant.
const MANAGER_PERSONAL_ACCOUNT_ID = `manager-personal-${RUN}`;
const MANAGER_AUTH = { uid: `manager-${RUN}`, token: { role: "manager", team: "AIX", email: `manager-${RUN}@demo-flu` } };

// Flu conversation org-filter round 4 (codex adversarial review round 2, 2026-09-28 owner scope
// decision) added a scp org-gate check to gatewayProxy (exactFeedbackScopeForGateway ->
// resolveConversationMailAccessScope) that resolves MANAGER_AUTH's email via Peoply on every call.
// None of this file's conversations are scp-stamped, so the gate itself is always a no-op here —
// but without ANY Peoply client configured, resolution fails closed as "directory unavailable"
// (a real outage), which broke every test in this file. resolveMailAccountForEmail/
// resolveVerifiedMailOrgForEmail (functions/mailAccounts.ts) treat ANY thrown error from
// getPerson — including a PeoplyClientError — as that same outage; the correct way to express
// "this caller confidently has no org" is a SUCCESSFUL getPerson response with no primary
// membership, not a thrown error.
function installDefaultPeoplyStub() {
  setPeoplyClientForTests({
    async getPerson(email) {
      return {
        directoryUpdatedAt: null,
        employee: {
          id: email, email, displayName: email, nickname: "", koreanName: "",
          department: "", title: "", jobName: "", status: "active", primaryMembership: "", slackUserId: null,
        },
        memberships: [],
      };
    },
  });
}

async function callGateway(data) {
  const conversationId = String(data?.conversationId ?? "").trim();
  assert.ok(conversationId, "gateway cache fixtures require an authoritative conversationId");
  await db.collection("conversations").doc(conversationId).set({
    id: conversationId,
    type: "direct",
    locale: "und",
    ownerUid: MANAGER_AUTH.uid,
    // Round 11: stamp the caller's own granted personal account so canReadConversationRowForScope
    // resolves it as that account (not folded into "scp") and finds it within
    // MANAGER_AUTH's authorizedMailAccountIds — see the grant set up in before().
    mailAccountId: MANAGER_PERSONAL_ACCOUNT_ID,
    attribution: {
      final: {
        primaryBucket: "direct",
        confidence: 1,
        source: "manual",
        reasonId: "test_authoritative_direct_scope",
      },
    },
  }, { merge: true });
  return wrappedGatewayProxy({ auth: MANAGER_AUTH, data, rawRequest: { ip: "127.0.0.1" } });
}

before(async () => {
  await db.doc("settings/email").set({
    inboundDefaultOwnerUid: `draft-owner-${RUN}`,
    inboundDefaultOwnerEmail: "scp@supercent.io",
  }, { merge: true });
  const nowIso = new Date().toISOString();
  // Round 11: MANAGER_AUTH's own personal (non-scp) mailbox entitlement — see the note by its
  // declaration above for why this is now required.
  await db.collection("mail_accounts").doc(MANAGER_PERSONAL_ACCOUNT_ID).set({
    // normalizeAccountMailbox (functions/mailAccounts.ts) requires a dotted domain — the
    // caller's own @demo-flu test email (no dot) is not a valid account mailbox value, so this
    // uses an unrelated but well-formed placeholder; entitlement here comes from the explicit
    // per-user grant below (members/{uid}.mailAccountIds), not from an ownerEmail match.
    label: "Manager personal", mailbox: `${MANAGER_PERSONAL_ACCOUNT_ID}@supercent.io`, kind: "external_smtp_imap", status: "active",
    ownerEmail: "", orgIds: [], smtp: {}, imap: {}, secretRef: `env:MANAGER_PERSONAL_TEST_${RUN}`,
    createdBy: "test", createdAt: nowIso, updatedBy: "test", updatedAt: nowIso,
  });
  await db.collection("members").doc(MANAGER_AUTH.uid).set({
    uid: MANAGER_AUTH.uid,
    email: MANAGER_AUTH.token.email,
    status: "active",
    role: "manager",
    [MAIL_ACCOUNT_ACCESS_FIELD]: [MANAGER_PERSONAL_ACCOUNT_ID],
  });
  installDefaultPeoplyStub();
  clearMailAccountResolutionCache();
});

test("autoPrefill: identical messageRef is served from cache on reopen, without a fresh gateway computation", async () => {
  const conversationId = `conv-prefill-${RUN}`;
  const messageRef = `msgref-prefill-${RUN}`;
  const payload = {
    conversationId,
    messageRef,
    intent: "chat-open-auto-prefill",
    signal: "human/헤세: 협업 제안 || creator/Creator: 좋아요, 진행하고 싶습니다!",
    gameId: "flu-chat",
    dryRun: true,
    autoPrefill: true,
  };

  const first = await callGateway(payload);
  assert.equal(first.ok, true);
  assert.notEqual(first.resolvedFromCache, true, "the first call for a new messageRef must compute fresh");

  const cacheSnapshot = await db.collection("chat_draft_prefill_cache").where("messageRef", "==", messageRef).limit(1).get();
  assert.equal(cacheSnapshot.empty, false, "a resolved autoPrefill call must persist a permanent cache record");
  const firstComputedAtIso = cacheSnapshot.docs[0].data().computedAtIso;
  // Red-team fix(S3): the cache key is no longer just conversationId+messageRef — the
  // record must also pin a contentHash of the raw `signal` so a later content change
  // under the same messageRef can be detected instead of served stale.
  assert.ok(cacheSnapshot.docs[0].data().contentHash, "cache record must persist a contentHash of the input signal");

  const second = await callGateway(payload);
  assert.equal(second.resolvedFromCache, true, "reopening the same conversation must be served from cache");
  assert.equal(second.source, "gateway-prefill-cache-hit");
  assert.equal(second.summaryKr, first.summaryKr);
  assert.equal(second.draftText, first.draftText);

  // Cache record itself must not have been rewritten by the second (served-from-cache) call.
  const cacheAfter = await db.collection("chat_draft_prefill_cache").where("messageRef", "==", messageRef).limit(1).get();
  assert.equal(cacheAfter.docs[0].data().computedAtIso, firstComputedAtIso);
});

test("autoPrefill: a canonical conversation alias does not reuse a cache across conversation authority", async () => {
  const messageRef = `msgref-prefill-alias-${RUN}`;
  const signal = "creator/Creator: 동일한 수신 회신";
  const first = await callGateway({
    conversationId: `conv-prefill-alias-source-${RUN}`,
    messageRef,
    intent: "chat-open-auto-prefill",
    signal,
    gameId: "flu-chat",
    dryRun: true,
    autoPrefill: true,
  });
  assert.notEqual(first.resolvedFromCache, true);

  const second = await callGateway({
    conversationId: `conv-prefill-alias-canonical-${RUN}`,
    messageRef,
    intent: "chat-open-auto-prefill",
    signal,
    gameId: "flu-chat",
    dryRun: true,
    autoPrefill: true,
  });
  assert.notEqual(second.resolvedFromCache, true, "a conversation alias must recompute until authority is independently proven");

  const cacheSnapshot = await db.collection("chat_draft_prefill_cache").where("messageRef", "==", messageRef).get();
  assert.equal(cacheSnapshot.size, 2, "the same messageRef must remain scoped to each authoritative conversation");
});

test("autoPrefill cache is invalidated by content — same messageRef with different signal content computes fresh instead of going stale", async () => {
  const conversationId = `conv-prefill-contenthash-${RUN}`;
  const messageRef = `msgref-prefill-contenthash-${RUN}`;

  const first = await callGateway({
    conversationId,
    messageRef,
    intent: "chat-open-auto-prefill",
    signal: "creator/Creator: 초기 회신 내용 A",
    gameId: "flu-chat",
    dryRun: true,
    autoPrefill: true,
  });
  assert.notEqual(first.resolvedFromCache, true);

  const cacheBefore = await db.collection("chat_draft_prefill_cache").where("messageRef", "==", messageRef).limit(1).get();
  assert.equal(cacheBefore.empty, false);
  const hashBefore = cacheBefore.docs[0].data().contentHash;
  assert.ok(hashBefore);

  // Same conversationId+messageRef, but the underlying signal content differs (e.g.
  // accumulated conversation context changed since the first prefill) — this must
  // recompute fresh, not silently serve the stale response for a different input.
  const second = await callGateway({
    conversationId,
    messageRef,
    intent: "chat-open-auto-prefill",
    signal: "creator/Creator: 다른 회신 내용 B",
    gameId: "flu-chat",
    dryRun: true,
    autoPrefill: true,
  });
  assert.notEqual(second.resolvedFromCache, true, "different signal content under the same messageRef must not hit the cache");

  const cacheAfter = await db.collection("chat_draft_prefill_cache").where("messageRef", "==", messageRef).limit(1).get();
  assert.equal(cacheAfter.size, 1, "the cache doc is overwritten in place, not duplicated per content variant");
  assert.notEqual(cacheAfter.docs[0].data().contentHash, hashBefore, "contentHash must reflect the new content");

  // A repeat of the SECOND (most recently computed) content must now hit cache.
  const third = await callGateway({
    conversationId,
    messageRef,
    intent: "chat-open-auto-prefill",
    signal: "creator/Creator: 다른 회신 내용 B",
    gameId: "flu-chat",
    dryRun: true,
    autoPrefill: true,
  });
  assert.equal(third.resolvedFromCache, true, "identical content as the most recent computation must hit cache");
});

test("autoPrefill cache is scoped per messageRef — a different inbound message computes fresh", async () => {
  const conversationId = `conv-prefill-${RUN}`;
  const first = await callGateway({
    conversationId,
    messageRef: `msgref-prefill-a-${RUN}`,
    intent: "chat-open-auto-prefill",
    signal: "creator/Creator: 회신 A",
    gameId: "flu-chat",
    dryRun: true,
    autoPrefill: true,
  });
  const second = await callGateway({
    conversationId,
    messageRef: `msgref-prefill-b-${RUN}`,
    intent: "chat-open-auto-prefill",
    signal: "creator/Creator: 회신 B",
    gameId: "flu-chat",
    dryRun: true,
    autoPrefill: true,
  });
  assert.notEqual(first.resolvedFromCache, true);
  assert.notEqual(second.resolvedFromCache, true, "a different messageRef must not hit another message's cache entry");
});

test("manual/retry calls (no autoPrefill flag) never touch the prefill cache", async () => {
  const conversationId = `conv-manual-${RUN}`;
  const messageRef = `msgref-manual-${RUN}`;
  const payload = {
    conversationId,
    messageRef,
    intent: "draft-next-email-reply",
    signal: "creator/Creator: 관심 있습니다",
    gameId: "flu-chat",
    dryRun: true,
    // autoPrefill intentionally omitted — matches handleAiDraft()/retry button behavior.
  };
  await callGateway(payload);
  await callGateway(payload);
  const cacheSnapshot = await db.collection("chat_draft_prefill_cache").where("messageRef", "==", messageRef).limit(1).get();
  assert.equal(cacheSnapshot.empty, true, "non-autoPrefill calls must never read/write the prefill cache");
});

test("needs_review inbound: humanDraftSuggestion is populated as a reference-only field, never as an auto-send draft", async () => {
  const conversationId = `conv-needs-review-${RUN}`;
  const trackingId = `flu-needs-review-${RUN}`;
  const response = await receiveEmail({
    auth: { uid: "mail-ingest-worker", token: { role: "admin", team: "system", email: "mail-ingest@supercent.io" } },
    data: {
      dryRun: true,
      draftOnly: true,
      conversationId,
      trackingId,
      subject: "Re: Collaboration proposal",
      // Matches HUMAN_REVIEW_RULES "schedule-human-review" — deterministic needs_review.
      body: "Can we schedule a call to discuss the launch window and posting date conflict?",
      text: "Can we schedule a call to discuss the launch window and posting date conflict?",
      signal: "Can we schedule a call to discuss the launch window and posting date conflict?",
      from: `needs-review-${RUN}@example.com`,
      creatorEmail: `needs-review-${RUN}@example.com`,
    },
    rawRequest: { ip: "127.0.0.1" },
  });
  assert.equal(response.ok, true);
  assert.equal(response.humanGate.decision, "needs_review");

  const conversationDoc = (await db.collection("conversations").doc(conversationId).get()).data();
  assert.ok(conversationDoc.humanDraftSuggestion, "needs_review must populate the reference-only humanDraftSuggestion field");
  assert.equal(conversationDoc.autoReplyDraftText, undefined, "autoReplyDraftText must stay deleted/absent for needs_review (unchanged semantics)");
  assert.equal(conversationDoc.autoReplyStatus, "waiting_for_human");
  assert.ok(conversationDoc.autoReplyBlockedReason);

  // Behavioral proof that humanDraftSuggestion never reaches any send path: needs_review
  // never creates an auto_reply_queue job (queued_for_send/auto_reply are mutually
  // exclusive with this branch in persistReceivedEmail), so none exists for this conversation.
  const queueSnapshot = await db.collection("auto_reply_queue").where("conversationId", "==", conversationId).get();
  assert.equal(queueSnapshot.empty, true, "needs_review must never enqueue an auto-send job (humanDraftSuggestion has no send path)");
});

test("autoPrefill: a cached draft for an explicit-scp conversation is not served after the caller's scp access is revoked", async () => {
  // Flu conversation org-filter round 3 (codex adversarial review round 3, finding #5): the
  // prefill cache key binds (userId, gameId, conversationId, messageRef) at WRITE time only — it
  // does not re-verify the caller's CURRENT scp grant/org eligibility on a later cache hit.
  const conversationId = `conv-prefill-scp-revoke-${RUN}`;
  const messageRef = `msgref-prefill-scp-revoke-${RUN}`;
  const callerEmail = `scp-prefill-revoke-${RUN}@example.com`;
  const REVOKE_AUTH = { uid: `revoke-caller-${RUN}`, token: { role: "manager", team: "AIX", email: callerEmail } };
  const nowIso = new Date().toISOString();

  await db.collection("mail_accounts").doc("scp").set({
    label: "SCP", mailbox: "scp@supercent.io", kind: "external_smtp_imap", status: "active",
    ownerEmail: "", orgIds: ["T046"], smtp: {}, imap: {}, secretRef: `env:PREFILL_REVOKE_TEST_${RUN}`,
    createdBy: "test", createdAt: nowIso, updatedBy: "test", updatedAt: nowIso,
  });
  await db.doc("settings/mail_routing").set({
    byOrgId: { T046: "scp" }, scpAllowedOrgIds: ["T046"], policyVersion: "mail-routing-v1",
    updatedBy: "test", updatedAt: nowIso,
  }, { merge: true });
  setPeoplyClientForTests({
    async getPerson(email) {
      if (email !== callerEmail) throw new Error(`unexpected person lookup: ${email}`);
      return {
        directoryUpdatedAt: null,
        employee: {
          id: `person-${email}`, email, displayName: email, nickname: "", koreanName: "",
          department: "", title: "", jobName: "", status: "active", primaryMembership: "T046", slackUserId: null,
        },
        memberships: [{
          orgId: "T046", organizationName: "T046", organizationPath: "T046",
          title: "", role: "member", source: "test", purpose: "primary", primary: true, managerEmail: null,
        }],
      };
    },
  });
  clearMailAccountResolutionCache();

  await db.collection("conversations").doc(conversationId).set({
    id: conversationId,
    type: "direct",
    locale: "und",
    ownerUid: REVOKE_AUTH.uid,
    mailAccountId: "scp",
    orgId: "T046",
    attribution: {
      final: {
        primaryBucket: "direct",
        confidence: 1,
        source: "manual",
        reasonId: "test_authoritative_direct_scope",
      },
    },
  }, { merge: true });

  const payload = {
    conversationId,
    messageRef,
    intent: "chat-open-auto-prefill",
    signal: "creator/Creator: 재확인 발송 회신",
    gameId: "flu-chat",
    dryRun: true,
    autoPrefill: true,
  };
  const first = await wrappedGatewayProxy({ auth: REVOKE_AUTH, data: payload, rawRequest: { ip: "127.0.0.1" } });
  assert.equal(first.ok, true, "the originally-granted T046 caller must be able to prime the cache");
  assert.notEqual(first.resolvedFromCache, true);

  const cacheSnapshot = await db.collection("chat_draft_prefill_cache").where("messageRef", "==", messageRef).limit(1).get();
  assert.equal(cacheSnapshot.empty, false, "the first call must have primed a cache record");

  // Revoke: T046 is no longer on the scp allowlist.
  await db.doc("settings/mail_routing").set({
    byOrgId: { T046: "scp" }, scpAllowedOrgIds: [], policyVersion: "mail-routing-v1",
    updatedBy: "test", updatedAt: new Date().toISOString(),
  }, { merge: true });
  clearMailAccountResolutionCache();

  // Same caller, same messageRef, identical signal content (same contentHash) — must NOT be
  // served from the now-stale cache. It falls through to a live recompute, which itself denies
  // via gatewayProxy's own scp org gate (functions/chat-ai.ts exactFeedbackScopeForGateway).
  await assert.rejects(
    () => wrappedGatewayProxy({ auth: REVOKE_AUTH, data: payload, rawRequest: { ip: "127.0.0.1" } }),
    (error) => error && error.code === "permission-denied",
    "a revoked caller must never be served the cached draft for a conversation it can no longer access",
  );

  // Restore the file-wide default stub (not null) — later tests in this file reuse MANAGER_AUTH
  // and rely on it resolving as "unresolved" rather than "directory unavailable".
  installDefaultPeoplyStub();
  clearMailAccountResolutionCache();
});

test("autoPrefill: a cached draft for an explicit-scp conversation is not served after the conversation itself is deleted", async () => {
  // Flu conversation org-filter round 5 (codex adversarial review round 5, finding #3): a missing
  // conversation doc previously read as `{}`, which the scp predicate treats as "not explicitly
  // scp" and passes through — a deleted conversation could keep serving its stale cached draft
  // forever (including after the caller's own grant was also revoked, since there is nothing left
  // to prove org match against).
  const conversationId = `conv-prefill-scp-deleted-${RUN}`;
  const messageRef = `msgref-prefill-scp-deleted-${RUN}`;
  const callerEmail = `scp-prefill-deleted-${RUN}@example.com`;
  const DELETE_AUTH = { uid: `deleted-caller-${RUN}`, token: { role: "manager", team: "AIX", email: callerEmail } };
  const nowIso = new Date().toISOString();

  await db.collection("mail_accounts").doc("scp").set({
    label: "SCP", mailbox: "scp@supercent.io", kind: "external_smtp_imap", status: "active",
    ownerEmail: "", orgIds: ["T046"], smtp: {}, imap: {}, secretRef: `env:PREFILL_DELETED_TEST_${RUN}`,
    createdBy: "test", createdAt: nowIso, updatedBy: "test", updatedAt: nowIso,
  });
  await db.doc("settings/mail_routing").set({
    byOrgId: { T046: "scp" }, scpAllowedOrgIds: ["T046"], policyVersion: "mail-routing-v1",
    updatedBy: "test", updatedAt: nowIso,
  }, { merge: true });
  setPeoplyClientForTests({
    async getPerson(email) {
      if (email !== callerEmail) throw new Error(`unexpected person lookup: ${email}`);
      return {
        directoryUpdatedAt: null,
        employee: {
          id: `person-${email}`, email, displayName: email, nickname: "", koreanName: "",
          department: "", title: "", jobName: "", status: "active", primaryMembership: "T046", slackUserId: null,
        },
        memberships: [{
          orgId: "T046", organizationName: "T046", organizationPath: "T046",
          title: "", role: "member", source: "test", purpose: "primary", primary: true, managerEmail: null,
        }],
      };
    },
  });
  clearMailAccountResolutionCache();

  await db.collection("conversations").doc(conversationId).set({
    id: conversationId,
    type: "direct",
    locale: "und",
    ownerUid: DELETE_AUTH.uid,
    mailAccountId: "scp",
    orgId: "T046",
    attribution: {
      final: {
        primaryBucket: "direct",
        confidence: 1,
        source: "manual",
        reasonId: "test_authoritative_direct_scope",
      },
    },
  }, { merge: true });

  const payload = {
    conversationId,
    messageRef,
    intent: "chat-open-auto-prefill",
    signal: "creator/Creator: 재확인 발송 회신 (deleted case)",
    gameId: "flu-chat",
    dryRun: true,
    autoPrefill: true,
  };
  const first = await wrappedGatewayProxy({ auth: DELETE_AUTH, data: payload, rawRequest: { ip: "127.0.0.1" } });
  assert.equal(first.ok, true, "the originally-granted T046 caller must be able to prime the cache");
  assert.notEqual(first.resolvedFromCache, true);

  const cacheSnapshot = await db.collection("chat_draft_prefill_cache").where("messageRef", "==", messageRef).limit(1).get();
  assert.equal(cacheSnapshot.empty, false, "the first call must have primed a cache record");

  // Delete the conversation itself — nothing left to reauthorize the cache hit against.
  await db.collection("conversations").doc(conversationId).delete();

  try {
    await assert.rejects(
      () => wrappedGatewayProxy({ auth: DELETE_AUTH, data: payload, rawRequest: { ip: "127.0.0.1" } }),
      // A denied cache reauthorization falls through to the live handler, which itself now finds
      // no scoped conversation at all (deleted) and fails with "failed-precondition" rather than
      // "permission-denied" — either way, the point is it never resolves with the stale cache hit.
      (error) => error && (error.code === "permission-denied" || error.code === "failed-precondition"),
      "a deleted conversation must never serve its stale cached draft — a missing doc is not proof of authorization",
    );
  } finally {
    installDefaultPeoplyStub();
    clearMailAccountResolutionCache();
  }
});

test("finding #1 (round 11): a revoked-grant manager is denied both a fresh gateway draft and a cached-draft hit for a LEGACY conversation (no mailAccountId)", async () => {
  // Flu conversation org-filter round 11 (codex adversarial review round 11, finding #1):
  // exactFeedbackScopeForGateway (functions/chat-ai.ts) and the prefill cache's reauth check
  // (functions/chatDraftPrefillCache.ts) previously used ONLY canReadScpConversationRowForOrg —
  // that predicate's very first non-super_admin branch is `if (!isExplicitScpMailAccountRow(row))
  // return true`, which is true (passes) for ANY legacy conversation with no mailAccountId at all,
  // regardless of the caller's mailbox entitlement. A manager whose scp grant was fully revoked
  // could still request a fresh draft, or read back a cache hit, for a known legacy
  // conversationId. The fix (canReadConversationRowForScope, same predicate listConversations
  // uses) additionally requires the caller to hold positive "scp" entitlement even for a legacy
  // row (normalizedMailAccountIdForRead folds a blank mailAccountId into the canonical scp
  // identity for entitlement purposes) — this test seeds a conversation with NO mailAccountId/
  // orgId field at all and revokes the caller's only path to that entitlement (org routing).
  const legacyConversationId = `conv-prefill-legacy-revoke-${RUN}`;
  const legacyMessageRef = `msgref-prefill-legacy-revoke-${RUN}`;
  const freshMessageRef = `msgref-prefill-legacy-revoke-fresh-${RUN}`;
  const callerEmail = `scp-prefill-legacy-revoke-${RUN}@example.com`;
  const REVOKE_AUTH = { uid: `legacy-revoke-caller-${RUN}`, token: { role: "manager", team: "AIX", email: callerEmail } };
  const nowIso = new Date().toISOString();

  await db.collection("mail_accounts").doc("scp").set({
    label: "SCP", mailbox: "scp@supercent.io", kind: "external_smtp_imap", status: "active",
    ownerEmail: "", orgIds: ["T046"], smtp: {}, imap: {}, secretRef: `env:PREFILL_LEGACY_REVOKE_TEST_${RUN}`,
    createdBy: "test", createdAt: nowIso, updatedBy: "test", updatedAt: nowIso,
  });
  await db.doc("settings/mail_routing").set({
    byOrgId: { T046: "scp" }, scpAllowedOrgIds: ["T046"], policyVersion: "mail-routing-v1",
    updatedBy: "test", updatedAt: nowIso,
  }, { merge: true });
  setPeoplyClientForTests({
    async getPerson(email) {
      if (email !== callerEmail) throw new Error(`unexpected person lookup: ${email}`);
      return {
        directoryUpdatedAt: null,
        employee: {
          id: `person-${email}`, email, displayName: email, nickname: "", koreanName: "",
          department: "", title: "", jobName: "", status: "active", primaryMembership: "T046", slackUserId: null,
        },
        memberships: [{
          orgId: "T046", organizationName: "T046", organizationPath: "T046",
          title: "", role: "member", source: "test", purpose: "primary", primary: true, managerEmail: null,
        }],
      };
    },
  });
  clearMailAccountResolutionCache();

  // A genuinely legacy row: no mailAccountId, no orgId — isExplicitScpMailAccountRow(row) is
  // false, so canReadScpConversationRowForOrg alone would pass this through unconditionally.
  await db.collection("conversations").doc(legacyConversationId).set({
    id: legacyConversationId,
    type: "direct",
    locale: "und",
    ownerUid: REVOKE_AUTH.uid,
    attribution: {
      final: {
        primaryBucket: "direct",
        confidence: 1,
        source: "manual",
        reasonId: "test_authoritative_direct_scope",
      },
    },
  }, { merge: true });

  const payload = {
    conversationId: legacyConversationId,
    messageRef: legacyMessageRef,
    intent: "chat-open-auto-prefill",
    signal: "creator/Creator: 재확인 발송 회신",
    gameId: "flu-chat",
    dryRun: true,
    autoPrefill: true,
  };
  const first = await wrappedGatewayProxy({ auth: REVOKE_AUTH, data: payload, rawRequest: { ip: "127.0.0.1" } });
  assert.equal(first.ok, true, "the originally-granted caller must be able to prime the cache for a legacy conversation");
  assert.notEqual(first.resolvedFromCache, true);

  const cacheSnapshot = await db.collection("chat_draft_prefill_cache").where("messageRef", "==", legacyMessageRef).limit(1).get();
  assert.equal(cacheSnapshot.empty, false, "the first call must have primed a cache record");

  // Revoke: T046 (the caller's only path to the "scp" entitlement) is no longer scp-assigned.
  await db.doc("settings/mail_routing").set({
    byOrgId: { T046: "scp" }, scpAllowedOrgIds: [], policyVersion: "mail-routing-v1",
    updatedBy: "test", updatedAt: new Date().toISOString(),
  }, { merge: true });
  clearMailAccountResolutionCache();

  try {
    // Cache hit path: same messageRef/contentHash — must NOT be served from the now-stale cache.
    await assert.rejects(
      () => wrappedGatewayProxy({ auth: REVOKE_AUTH, data: payload, rawRequest: { ip: "127.0.0.1" } }),
      (error) => error && error.code === "permission-denied",
      "a revoked caller must never be served a cached legacy-conversation draft just because the row itself is not explicit-scp-stamped",
    );
    // Fresh draft request path: a different messageRef never primes a cache entry, so this
    // exercises exactFeedbackScopeForGateway's own check directly (no cache involved at all).
    await assert.rejects(
      () => wrappedGatewayProxy({ auth: REVOKE_AUTH, data: { ...payload, messageRef: freshMessageRef }, rawRequest: { ip: "127.0.0.1" } }),
      (error) => error && error.code === "permission-denied" && error.errorCode === "gateway_proxy_conversation_scope_denied",
      "a revoked caller must never get a fresh gateway draft for a legacy conversation either",
    );
  } finally {
    installDefaultPeoplyStub();
    clearMailAccountResolutionCache();
  }
});

test("autoPrefill cache hashes long message references instead of truncating them into one key", async () => {
  const conversationId = `conv-prefill-collision-${RUN}`;
  const sharedPrefix = `msgref-${"a".repeat(340)}-`;
  const firstRef = `${sharedPrefix}tenant-a`;
  const secondRef = `${sharedPrefix}tenant-b`;
  const base = { conversationId, intent: "chat-open-auto-prefill", signal: "creator/Creator: scope collision probe", gameId: "flu-chat", dryRun: true, autoPrefill: true };
  const first = await callGateway({ ...base, messageRef: firstRef });
  const second = await callGateway({ ...base, messageRef: secondRef });
  assert.notEqual(first.resolvedFromCache, true);
  assert.notEqual(second.resolvedFromCache, true, "distinct long message refs must not collide after normalization/truncation");
  const rows = await db.collection("chat_draft_prefill_cache").where("conversationId", "==", conversationId).get();
  assert.equal(rows.size, 2);
  assert.notEqual(rows.docs[0].id, rows.docs[1].id);
});
