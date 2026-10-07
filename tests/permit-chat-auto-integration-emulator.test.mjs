import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";
import { test } from "node:test";
import { autoReplyPacingTestOverrides } from "./helpers/auto-reply-pacing-test-overrides.mjs";

const ENABLED = process.env.PERMIT_CHAT_AUTO_EMULATOR === "1";
const HOST = process.env.FIRESTORE_EMULATOR_HOST ?? "";
const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-flu";

function exactLocalDemoGuard() {
  assert.equal(ENABLED, true, "set PERMIT_CHAT_AUTO_EMULATOR=1 for this emulator-only test");
  assert.equal(HOST, "127.0.0.1:8180", "Permit emulator tests must use isolated Firestore emulator 127.0.0.1:8180");
  assert.equal(PROJECT, "demo-flu", "Permit emulator tests must use demo-flu only");
}

// [적대 리뷰 HIGH-3b] scripts/run-node-tests.mjs 의 requiresEmulator() 는 소스 문자열 패턴
// (예: `if (!process.env.FIRESTORE_EMULATOR_HOST)`)으로만 "이 파일은 에뮬 레인이다" 를 판정한다.
// 종전에는 이 파일의 게이트가 PERMIT_CHAT_AUTO_EMULATOR 전용 커스텀 조건뿐이라 그 패턴에 걸리지
// 않았다 — 그 결과 이 파일이 **노드 레인**(emulatorRequired=false)으로 분류돼 `npm run test:emu`
// (mode=emulator)가 영구히 건너뛰었다. 아래 리터럴 조건이 그 패턴과 정확히 일치해 이제 에뮬
// 레인 전용으로 분류된다(노드 레인에서는 파일 자체가 선택되지 않는다).
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  test("Permit chat auto emulator integration is opt-in", { skip: "set PERMIT_CHAT_AUTO_EMULATOR=1 with FIRESTORE_EMULATOR_HOST=127.0.0.1:8180 and GCLOUD_PROJECT=demo-flu" }, () => {});
} else if (!ENABLED) {
  test("Permit chat auto emulator integration is opt-in", { skip: "set PERMIT_CHAT_AUTO_EMULATOR=1 with FIRESTORE_EMULATOR_HOST=127.0.0.1:8180 and GCLOUD_PROJECT=demo-flu" }, () => {});
} else {
  exactLocalDemoGuard();
  process.env.GCLOUD_PROJECT = PROJECT;
  process.env.FIREBASE_CONFIG ||= JSON.stringify({ projectId: PROJECT });
  delete process.env.FUNCTIONS_EMULATOR;
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = "1025";
  process.env.SMTP_USER = "scp@supercent.io";
  process.env.SMTP_FROM = "scp@supercent.io";
  process.env.IMAP_HOST = "127.0.0.1";
  process.env.IMAP_PORT = "993";
  process.env.IMAP_USER = "scp@supercent.io";
  process.env.SMTP_PASSWORD ||= "permit-chat-auto-test-smtp-password";

  const smtpCalls = [];
  let smtpResponseMode = "accepted";
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain);
    if (request === "nodemailer") {
      const target = loaded?.default ?? loaded;
      if (target && !target.__permitChatAutoPatched) {
        target.__permitChatAutoPatched = true;
        target.createTransport = () => ({
          sendMail: async (message) => {
            smtpCalls.push({
              to: message?.to,
              subject: message?.subject,
              text: message?.text,
              inReplyTo: message?.inReplyTo,
              references: message?.references,
            });
            if (smtpResponseMode === "unconfirmed") {
              return { messageId: `permit-chat-auto-${smtpCalls.length}`, accepted: [], rejected: [message?.to] };
            }
            return { messageId: `permit-chat-auto-${smtpCalls.length}`, accepted: [message?.to], rejected: [] };
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
  const store = await import(new URL("../functions/lib/chatAutoCasePermitStore.js", import.meta.url));
  const mailCompiler = await import(new URL("../functions/lib/mailCompiler.js", import.meta.url));
  const profiles = await import(new URL("../functions/lib/mailProfiles.js", import.meta.url));
  const attest = await import(new URL("../functions/lib/mailProviderAttestation.js", import.meta.url));
  const { setOutreachSendingEnabled, OUTBOUND_SAFETY_STATE_PATH } = await import(new URL("../functions/lib/mailOutboundSafety.js", import.meta.url));

  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const CASE_ID = "interest_next_steps";
  const MODEL = "gemini-2.5-flash";
  const PIN = permit.chatAutoCasePermitPin(MODEL);
  const DRAFT = permit.renderChatAutoServerDraft({ caseId: CASE_ID, factTokenIds: [], linkTokenIds: [] });
  const RESOLVED_DRAFT = chatAi.substituteCasebookLinks(DRAFT.text);
  assert.equal(RESOLVED_DRAFT.leftoverToken, false);
  assert.equal(RESOLVED_DRAFT.inventedUrl, false);
  assert.match(RESOLVED_DRAFT.text, /https:\/\/creator\.supercent\.io\/apply/);
  assert.doesNotMatch(RESOLVED_DRAFT.text, /\{\{[A-Z0-9_]+\}\}/);
  const ORIGINAL_DRAFT_HASH = mailCompiler.compiledArtifactFingerprint(
    mailCompiler.compileMailArtifact({ body: RESOLVED_DRAFT.text, bodyFormat: "markdown" }),
  );

  async function snapshotDoc(path) {
    const snapshot = await db.doc(path).get();
    return snapshot.exists ? { exists: true, data: snapshot.data() } : { exists: false, data: null };
  }

  async function restoreDoc(path, snapshot) {
    if (snapshot.exists) await db.doc(path).set(snapshot.data, { merge: false });
    else await db.doc(path).delete().catch(() => undefined);
  }

  function koreaDayKey(date) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }

  async function withRestoredSharedDocs(fn) {
    const settingsSnapshot = await snapshotDoc("settings/default");
    const emailSettingsSnapshot = await snapshotDoc("settings/email");
    const outboundSnapshot = await snapshotDoc(OUTBOUND_SAFETY_STATE_PATH);
    const attestationSnapshot = await snapshotDoc(attest.MAIL_PROVIDER_ATTESTATION_PATH);
    const permitSnapshot = await snapshotDoc(`${permit.CHAT_AUTO_CASE_PERMIT_COLLECTION}/${CASE_ID}`);
    const dailyCounterSnapshot = await snapshotDoc(`auto_reply_daily_counters/${koreaDayKey(new Date())}`);
    const priorSmtpResponseMode = smtpResponseMode;
    try {
      await db.doc("settings/default").set({
        automation: autoReplyPacingTestOverrides({
          autoReplyEnabled: true,
          liveSendEnabled: true,
          // Legacy authorized auto-reply fixture: no scoped human-approval exemption involved.
          humanApprovalRequired: false,
          maxDailyAutoSends: 100000,
        }),
        programAi: { dryRunDefault: false },
        llmModelRoutes: { auto_reply_draft: MODEL },
        mailSafety: {
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
      await db.doc("settings/email").set({ practiceMode: false, updatedAt: new Date().toISOString(), updatedBy: `permit-chat-auto-${RUN}` }, { merge: true });
      await db.doc(`auto_reply_daily_counters/${koreaDayKey(new Date())}`).set({ sent: 0, updatedAtIso: new Date().toISOString() }, { merge: true });
      await setOutreachSendingEnabled(true, `permit-chat-auto-${RUN}`, new Date().toISOString());
      await activateMailProviderAttestation();
      return await fn();
    } finally {
      await Promise.all([
        restoreDoc("settings/default", settingsSnapshot),
        restoreDoc("settings/email", emailSettingsSnapshot),
        restoreDoc(OUTBOUND_SAFETY_STATE_PATH, outboundSnapshot),
        restoreDoc(attest.MAIL_PROVIDER_ATTESTATION_PATH, attestationSnapshot),
        restoreDoc(`${permit.CHAT_AUTO_CASE_PERMIT_COLLECTION}/${CASE_ID}`, permitSnapshot),
        restoreDoc(`auto_reply_daily_counters/${koreaDayKey(new Date())}`, dailyCounterSnapshot),
      ]);
      smtpResponseMode = priorSmtpResponseMode;
    }
  }


  async function activateMailProviderAttestation() {
    const identity = await profiles.resolveOperationalMailIdentity();
    assert.equal(identity.identityMatch, true, `mail identity must match canonical mailbox (${identity.identityCode})`);
    const receipt = attest.buildMailProviderAttestationReceipt({
      identity,
      diagnostic: {
        configFingerprint: identity.configFingerprint,
        diagnosticReceiptHash: "f".repeat(64),
        checkedAtIso: new Date().toISOString(),
        expiresAtIso: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      actorHash: attest.hashMailProviderAttestationActor(`permit-chat-auto-${RUN}`),
    });
    await db.doc(attest.MAIL_PROVIDER_ATTESTATION_PATH).set(receipt, { merge: false });
  }

  function auth(uid = `permit-user-${RUN}`) {
    return {
      uid,
      token: { role: "manager", team: "flu", email: "manager@supercent.io" },
    };
  }

  function evalEvidence(nowIso, overrides = {}) {
    const evaluated = new Date(Date.parse(nowIso) - 60_000).toISOString();
    const expires = new Date(Date.parse(nowIso) + 60 * 60_000).toISOString();
    return {
      status: "passed",
      runId: `permit-eval-${RUN}`,
      buildSha: "7ede011e",
      kRevision: "permit-revision-test",
      casebookHash: PIN.casebookHash,
      modelVersion: PIN.modelVersion,
      evaluatedAtIso: evaluated,
      expiresAtIso: expires,
      actualGatewayCall: true,
      bypassGatewayCache: true,
      heldout: { total: 1, passed: 1, failed: 0 },
      reroll: { total: 1, stable: 1, unstable: 0 },
      decisions: { allow: 2, deny: 0, unavailable: 0 },
      transports: ["ai_hub_gateway"],
      estimatedCostUsd: 0.001,
      ...overrides,
    };
  }

  function counters(count = 20) {
    return {
      consecutiveHumanUneditedApprovedSent: count,
      totalHumanUneditedApprovedSent: count,
      unavailableEvidenceCount: 0,
      lastEligibleMessageRef: `message_sources/permit-baseline-${RUN}`,
    };
  }

  async function armPermit(nowIso, overrides = {}) {
    return store.setChatAutoCasePermitFromVerifiedEvidence({
      caseId: CASE_ID,
      requestedState: "armed",
      pin: PIN,
      counters: counters(),
      evalEvidence: evalEvidence(nowIso, overrides.evalEvidence ?? {}),
      actorUid: `permit-actor-${RUN}`,
      actorRole: "manager",
      nowIso,
    });
  }

  function inboundSourceData({ conversationId, sourceId, draftHash = ORIGINAL_DRAFT_HASH, model = MODEL, from = `creator-${sourceId}@gmail.com`, providerMessageId } = {}) {
    return {
      direction: "inbound",
      conversationId,
      from,
      to: "scp@supercent.io",
      source: "receiveEmail",
      caseId: CASE_ID,
      casebookHash: PIN.casebookHash,
      casebookVersion: PIN.casebookVersion,
      gatewayModelVersion: model,
      gatewayTransport: "ai_hub_gateway",
      gatewayLedgerRef: `cost-${sourceId}`,
      permitDecisionId: `decision-${sourceId}`,
      draftCandidateHash: draftHash,
      createdAtIso: new Date().toISOString(),
      ...(providerMessageId ? { providerMessageId } : {}),
    };
  }

  function queueDoc({ id, conversationId, model = MODEL, draftHash = ORIGINAL_DRAFT_HASH, sendAfterIso = "2000-01-01T00:00:00.000Z", dryRun = true, liveSend = false, allowMockGatewayFallback = false, trackingId = id } = {}) {
    return {
      id,
      status: "scheduled",
      conversationId,
      threadId: conversationId,
      contextKey: `permit-${RUN}`,
      conversationRef: `conversations/${conversationId}`,
      sourceRef: `message_sources/${id}-source`,
      sourceRefs: [`message_sources/${id}-source`],
      trackingId,
      creatorId: `creator-${RUN}`,
      creatorName: "Permit Creator",
      creatorEmail: `permit-${id}@supercent.io`,
      summaryKr: "자동 회신 테스트",
      draftRef: `draft-${id}`,
      draftText: RESOLVED_DRAFT.text,
      to: `permit-${id}@supercent.io`,
      subject: "Permit auto reply",
      sendAfterIso,
      minimumDelayMinutes: 0,
      resolvedProfileSnapshot: {
        id: `profile-${RUN}`,
        scope: "global",
        sourcePath: "settings/default",
        intent: "auto_reply",
        enabled: true,
        tone: "정중·간결",
        format: "자동 회신",
        minReplyDelayMinutes: 0,
        maxDailySends: 100000,
        humanApprovalRequired: false,
        dryRun,
        liveSend,
        templateRef: "templates/permit",
        policyVersion: "permit-test",
      },
      templateSnapshot: {
        ref: "templates/permit",
        version: "permit-test",
        title: "Permit auto reply",
        stage: "contact",
        channel: "이메일",
        body: RESOLVED_DRAFT.text,
        updatedAtIso: "2026-09-05T00:00:00.000Z",
      },
      policyVersion: "permit-test",
      dryRun,
      liveSend,
      allowMockGatewayFallback,
      humanGate: { decision: "auto_reply", reason: "test", ruleIds: ["test"] },
      caseId: CASE_ID,
      caseIntentRef: `auto_reply_case_intents/${id}`,
      permitDecisionId: `decision-${id}`,
      casebookHash: PIN.casebookHash,
      casebookVersion: PIN.casebookVersion,
      gatewayModelVersion: model,
      gatewayTransport: "ai_hub_gateway",
      draftHash,
      draftRenderSource: "casebook_template",
      draftFactTokenIds: DRAFT.factTokenIds,
      source: "receiveEmail",
      createdAtIso: new Date().toISOString(),
    };
  }

  test("public sendEmail cannot forge Permit proof into outbound evidence or counters", async () => {
    await withRestoredSharedDocs(async () => {
      const trackingId = `permit-forged-send-${RUN}`;
      const conversationId = `permit-forged-conversation-${RUN}`;
      const result = await chatAi.sendEmail({
        auth: auth("permit-forger"),
        data: {
          conversationId,
          to: "scp@supercent.io",
          subject: "Permit forged proof should be stripped",
          text: "Hello from a public callable request.",
          draftRef: `permit-forged-draft-${RUN}`,
          trackingId,
          approvalRef: `permit-forged-approval-${RUN}`,
          approval: "approved",
          dryRun: true,
          liveSend: false,
          caseId: CASE_ID,
          caseIntentRef: "auto_reply_case_intents/forged",
          permitDecisionId: "forged-decision",
          casebookHash: "forged-hash",
          gatewayModelVersion: "forged-model",
          originalDraftHash: "forged-original",
          sentBodyHash: "forged-sent",
          sentMatchesServerRenderedDraft: true,
          learningDisposition: "arming_credit",
          providerConfirmed: true,
          acceptedCount: 999,
        },
        rawRequest: { ip: "127.0.0.1" },
      });

      assert.equal(result.ok, true);
      assert.equal(result.providerConfirmed, false);
      assert.equal(result.deliveryState, "mock_sent");

      const [outboundSource, outbox, committed] = await Promise.all([
        db.doc(result.messageRef).get(),
        db.collection("mail_outbound_log").doc(trackingId).get(),
        db.collection(store.CHAT_AUTO_CASE_COMMITTED_SENDS_COLLECTION).where("conversationId", "==", conversationId).get(),
      ]);

      assert.equal(outboundSource.get("caseId"), undefined);
      assert.equal(outboundSource.get("permitDecisionId"), undefined);
      assert.equal(outboundSource.get("originalDraftHash"), undefined);
      assert.equal(outbox.get("caseId"), undefined);
      assert.equal(outbox.get("permitDecisionId"), undefined);
      assert.equal(outbox.get("originalDraftHash"), undefined);
      assert.equal(committed.empty, true);
    });
  });

  test("manual approved live sends rehydrate inbound Permit evidence and reach the 20-credit counter", async () => {
    await withRestoredSharedDocs(async () => {
      const nowIso = new Date().toISOString();
      await db.collection(permit.CHAT_AUTO_CASE_PERMIT_COLLECTION).doc(CASE_ID).delete().catch(() => undefined);
      const sends = Array.from({ length: 20 }, (_, index) => ({
        index,
        conversationId: `permit-manual20-${RUN}-${index}`,
        sourceId: `permit-manual20-source-${RUN}-${index}`,
        trackingId: `permit-manual20-send-${RUN}-${index}`,
      }));
      for (const item of sends) {
        await db.collection("conversations").doc(item.conversationId).set({ aiActive: true, createdAtIso: nowIso }, { merge: true });
        const creatorEmail = `permit-manual20-${RUN}-${item.index}@gmail.com`;
        await db.collection("message_sources").doc(item.sourceId).set(inboundSourceData({ ...item, from: creatorEmail }), { merge: false });
        const before = smtpCalls.length;
        const result = await chatAi.sendEmail({
          auth: auth(`permit-manual20-${item.trackingId}`),
          data: {
            conversationId: item.conversationId,
            to: creatorEmail,
            subject: "Permit manual approved send",
            text: RESOLVED_DRAFT.text,
            draftRef: `draft-${item.trackingId}`,
            trackingId: item.trackingId,
            approvalRef: `approval-${item.trackingId}`,
            approval: "approved",
            intent: "chat_manual_reply",
            replyToMessageRef: `message_sources/${item.sourceId}`,
            dryRun: false,
            liveSend: true,
          },
          rawRequest: { ip: "127.0.0.1" },
        });
        assert.equal(result.deliveryState, "sent");
        assert.equal(result.providerConfirmed, true);
        assert.equal(smtpCalls.length, before + 1);
        assert.doesNotMatch(String(smtpCalls.at(-1)?.text ?? ""), /\{\{[A-Z0-9_]+\}\}/);
      }

      const permitDoc = await db.collection(permit.CHAT_AUTO_CASE_PERMIT_COLLECTION).doc(CASE_ID).get();
      assert.equal(permitDoc.get("counters.consecutiveHumanUneditedApprovedSent"), 20);
      const committed = await db.collection(store.CHAT_AUTO_CASE_COMMITTED_SENDS_COLLECTION)
        .where("caseId", "==", CASE_ID)
        .where("gatewayModelVersion", "==", MODEL)
        .get();
      const runEvents = committed.docs.filter((doc) => String(doc.get("conversationId") ?? "").startsWith(`permit-manual20-${RUN}-`));
      assert.equal(runEvents.length, 20);
      assert.equal(runEvents.every((doc) => doc.get("learningDisposition") === "arming_credit"), true);
    });
  });

  test("auto-reply mock dispatch persists non-sent state and does not count", async () => {
    await withRestoredSharedDocs(async () => {
      const nowIso = new Date().toISOString();
      await armPermit(nowIso);
      const id = `permit-mock-dispatch-${RUN}`;
      const conversationId = `permit-mock-dispatch-conv-${RUN}`;
      const dayRef = db.collection("auto_reply_daily_counters").doc(koreaDayKey(new Date()));
      const beforeSent = Number((await dayRef.get()).get("sent") ?? 0);
      await db.collection("conversations").doc(conversationId).set({ aiActive: true, createdAtIso: nowIso }, { merge: true });
      await db.collection("message_sources").doc(`${id}-source`).set(inboundSourceData({ conversationId, sourceId: `${id}-source` }), { merge: false });
      await db.collection("auto_reply_queue").doc(id).set(queueDoc({ id, conversationId, dryRun: false, liveSend: false, allowMockGatewayFallback: true }), { merge: false });
      const beforeSmtp = smtpCalls.length;

      const result = await chatAi.processAutoReplyQueue();

      assert.equal(result.sent, 0);
      assert.equal(result.mockSent, 1);
      assert.equal(smtpCalls.length, beforeSmtp);
      assert.equal(Number((await dayRef.get()).get("sent") ?? 0), beforeSent);
      const [queue, conversation, source, committed] = await Promise.all([
        db.collection("auto_reply_queue").doc(id).get(),
        db.collection("conversations").doc(conversationId).get(),
        db.collection("message_sources").doc(`${id}-source`).get(),
        db.collection(store.CHAT_AUTO_CASE_COMMITTED_SENDS_COLLECTION).where("conversationId", "==", conversationId).get(),
      ]);
      assert.equal(queue.get("status"), "mock_sent");
      assert.equal(conversation.get("autoReplyStatus"), "mock_sent");
      assert.equal(source.get("autoReplyStatus"), "mock_sent");
      assert.equal(conversation.get("autoRepliedCaseIds"), undefined);
      assert.equal(committed.empty, true);
      const permitDoc = await db.collection(permit.CHAT_AUTO_CASE_PERMIT_COLLECTION).doc(CASE_ID).get();
      assert.equal(permitDoc.get("armed"), true);
    });
  });

  test("auto-reply unconfirmed SMTP dispatch persists non-sent state and does not count", async () => {
    await withRestoredSharedDocs(async () => {
      const nowIso = new Date().toISOString();
      await armPermit(nowIso);
      smtpResponseMode = "unconfirmed";
      const id = `permit-unconfirmed-dispatch-${RUN}`;
      const conversationId = `permit-unconfirmed-dispatch-conv-${RUN}`;
      const dayRef = db.collection("auto_reply_daily_counters").doc(koreaDayKey(new Date()));
      const beforeSent = Number((await dayRef.get()).get("sent") ?? 0);
      await db.collection("conversations").doc(conversationId).set({ aiActive: true, createdAtIso: nowIso }, { merge: true });
      await db.collection("message_sources").doc(`${id}-source`).set(inboundSourceData({ conversationId, sourceId: `${id}-source` }), { merge: false });
      await db.collection("auto_reply_queue").doc(id).set(queueDoc({ id, conversationId, dryRun: false, liveSend: true }), { merge: false });
      const beforeSmtp = smtpCalls.length;

      const result = await chatAi.processAutoReplyQueue();

      assert.equal(result.sent, 0);
      assert.equal(result.unknown, 1);
      assert.equal(smtpCalls.length, beforeSmtp + 1);
      assert.equal(Number((await dayRef.get()).get("sent") ?? 0), beforeSent);
      const [queue, conversation, source, committed] = await Promise.all([
        db.collection("auto_reply_queue").doc(id).get(),
        db.collection("conversations").doc(conversationId).get(),
        db.collection("message_sources").doc(`${id}-source`).get(),
        db.collection(store.CHAT_AUTO_CASE_COMMITTED_SENDS_COLLECTION).where("conversationId", "==", conversationId).get(),
      ]);
      assert.equal(queue.get("status"), "send_unconfirmed");
      assert.equal(queue.get("providerConfirmed"), false);
      assert.equal(conversation.get("autoReplyStatus"), "send_unconfirmed");
      assert.equal(source.get("autoReplyStatus"), "send_unconfirmed");
      assert.equal(conversation.get("autoRepliedCaseIds"), undefined);
      assert.equal(committed.empty, true);
      const permitDoc = await db.collection(permit.CHAT_AUTO_CASE_PERMIT_COLLECTION).doc(CASE_ID).get();
      assert.equal(permitDoc.get("armed"), false);
      assert.equal(permitDoc.get("lastDisarmReason"), "send_unknown_acceptance");
    });
  });

  test("auto-reply evidence-pending outbox failure disarms and does not count", async () => {
    await withRestoredSharedDocs(async () => {
      const nowIso = new Date().toISOString();
      await armPermit(nowIso);
      const id = `permit-evidence-pending-dispatch-${RUN}`;
      const conversationId = `permit-evidence-pending-dispatch-conv-${RUN}`;
      const dayRef = db.collection("auto_reply_daily_counters").doc(koreaDayKey(new Date()));
      const beforeSent = Number((await dayRef.get()).get("sent") ?? 0);
      await db.collection("conversations").doc(conversationId).set({ aiActive: true, createdAtIso: nowIso }, { merge: true });
      await db.collection("message_sources").doc(`${id}-source`).set(inboundSourceData({ conversationId, sourceId: `${id}-source` }), { merge: false });
      await db.collection("auto_reply_queue").doc(id).set(queueDoc({ id, conversationId, dryRun: false, liveSend: true, trackingId: `bad!${RUN}` }), { merge: false });
      const beforeSmtp = smtpCalls.length;

      const result = await chatAi.processAutoReplyQueue();

      assert.equal(result.sent, 0);
      assert.equal(result.evidencePending, 1);
      assert.equal(result.ok, false);
      assert.equal(smtpCalls.length, beforeSmtp + 1);
      assert.equal(Number((await dayRef.get()).get("sent") ?? 0), beforeSent);
      const [queue, conversation, source, committed, permitDoc] = await Promise.all([
        db.collection("auto_reply_queue").doc(id).get(),
        db.collection("conversations").doc(conversationId).get(),
        db.collection("message_sources").doc(`${id}-source`).get(),
        db.collection(store.CHAT_AUTO_CASE_COMMITTED_SENDS_COLLECTION).where("conversationId", "==", conversationId).get(),
        db.collection(permit.CHAT_AUTO_CASE_PERMIT_COLLECTION).doc(CASE_ID).get(),
      ]);
      assert.equal(queue.get("status"), "sent_evidence_pending");
      assert.equal(queue.get("providerConfirmed"), true);
      assert.equal(conversation.get("autoReplyStatus"), "sent_evidence_pending");
      assert.equal(source.get("autoReplyStatus"), "sent_evidence_pending");
      assert.equal(conversation.get("autoRepliedCaseIds"), undefined);
      assert.equal(committed.empty, true);
      assert.equal(permitDoc.get("armed"), false);
      assert.equal(permitDoc.get("lastDisarmReason"), "send_unknown_acceptance");
    });
  });

  test("auto-reply confirmed SMTP dispatch writes sent and increments exactly once", async () => {
    await withRestoredSharedDocs(async () => {
      const nowIso = new Date().toISOString();
      await armPermit(nowIso);
      const id = `permit-confirmed-dispatch-${RUN}`;
      const conversationId = `permit-confirmed-dispatch-conv-${RUN}`;
      const dayRef = db.collection("auto_reply_daily_counters").doc(koreaDayKey(new Date()));
      const beforeSent = Number((await dayRef.get()).get("sent") ?? 0);
      await db.collection("conversations").doc(conversationId).set({ aiActive: true, createdAtIso: nowIso }, { merge: true });
      await db.collection("message_sources").doc(`${id}-source`).set(inboundSourceData({ conversationId, sourceId: `${id}-source` }), { merge: false });
      await db.collection("auto_reply_queue").doc(id).set(queueDoc({ id, conversationId, dryRun: false, liveSend: true }), { merge: false });
      const beforeSmtp = smtpCalls.length;

      const result = await chatAi.processAutoReplyQueue();

      assert.equal(result.sent, 1);
      assert.equal(result.confirmedSent, 1);
      assert.equal(smtpCalls.length, beforeSmtp + 1);
      assert.equal(Number((await dayRef.get()).get("sent") ?? 0), beforeSent + 1);
      const [queue, conversation, source] = await Promise.all([
        db.collection("auto_reply_queue").doc(id).get(),
        db.collection("conversations").doc(conversationId).get(),
        db.collection("message_sources").doc(`${id}-source`).get(),
      ]);
      assert.equal(queue.get("status"), "sent");
      assert.equal(queue.get("providerConfirmed"), true);
      assert.equal(conversation.get("autoReplyStatus"), "sent");
      assert.deepEqual(conversation.get("autoRepliedCaseIds"), [CASE_ID]);
      assert.equal(source.get("autoReplyStatus"), "sent");
    });
  });

  test("auto-reply confirmed SMTP dispatch threads In-Reply-To/References from the inbound source, like a manual reply", async () => {
    await withRestoredSharedDocs(async () => {
      const nowIso = new Date().toISOString();
      await armPermit(nowIso);
      const id = `permit-threading-dispatch-${RUN}`;
      const conversationId = `permit-threading-dispatch-conv-${RUN}`;
      const inboundProviderMessageId = `<abc-${RUN}@mail.gmail.com>`;
      await db.collection("conversations").doc(conversationId).set({ aiActive: true, createdAtIso: nowIso }, { merge: true });
      await db.collection("message_sources").doc(`${id}-source`).set(
        inboundSourceData({ conversationId, sourceId: `${id}-source`, providerMessageId: inboundProviderMessageId }),
        { merge: false },
      );
      await db.collection("auto_reply_queue").doc(id).set(queueDoc({ id, conversationId, dryRun: false, liveSend: true }), { merge: false });
      const beforeSmtp = smtpCalls.length;

      const result = await chatAi.processAutoReplyQueue();

      assert.equal(result.sent, 1);
      assert.equal(result.confirmedSent, 1);
      assert.equal(smtpCalls.length, beforeSmtp + 1);
      const sentMail = smtpCalls.at(-1);
      assert.equal(
        sentMail.inReplyTo,
        inboundProviderMessageId,
        "auto-reply must set In-Reply-To to the inbound source's providerMessageId, same as a manual reply",
      );
      assert.deepEqual(
        sentMail.references,
        [inboundProviderMessageId],
        "auto-reply must set References to the inbound source's providerMessageId, same as a manual reply",
      );
    });
  });

  test("auto-reply confirmed SMTP dispatch omits In-Reply-To/References when the inbound source has no providerMessageId", async () => {
    await withRestoredSharedDocs(async () => {
      const nowIso = new Date().toISOString();
      await armPermit(nowIso);
      const id = `permit-threading-dispatch-no-id-${RUN}`;
      const conversationId = `permit-threading-dispatch-no-id-conv-${RUN}`;
      await db.collection("conversations").doc(conversationId).set({ aiActive: true, createdAtIso: nowIso }, { merge: true });
      await db.collection("message_sources").doc(`${id}-source`).set(
        inboundSourceData({ conversationId, sourceId: `${id}-source` }),
        { merge: false },
      );
      await db.collection("auto_reply_queue").doc(id).set(queueDoc({ id, conversationId, dryRun: false, liveSend: true }), { merge: false });
      const beforeSmtp = smtpCalls.length;

      const result = await chatAi.processAutoReplyQueue();

      assert.equal(result.sent, 1);
      assert.equal(result.confirmedSent, 1);
      assert.equal(smtpCalls.length, beforeSmtp + 1);
      const sentMail = smtpCalls.at(-1);
      assert.equal(
        sentMail.inReplyTo,
        undefined,
        "auto-reply must omit In-Reply-To when the inbound source has no providerMessageId",
      );
      assert.equal(
        sentMail.references,
        undefined,
        "auto-reply must omit References when the inbound source has no providerMessageId",
      );
    });
  });

  test("dispatch rechecks current model pin before SMTP and blocks stale queued provenance", async () => {
    await withRestoredSharedDocs(async () => {
      const nowIso = new Date().toISOString();
      await armPermit(nowIso);
      const id = `permit-stale-dispatch-${RUN}`;
      const conversationId = `permit-stale-dispatch-conv-${RUN}`;
      await db.collection("conversations").doc(conversationId).set({ aiActive: true, createdAtIso: nowIso }, { merge: true });
      await db.collection("message_sources").doc(`${id}-source`).set(inboundSourceData({ conversationId, sourceId: `${id}-source`, model: "stale-model" }), { merge: false });
      await db.collection("auto_reply_queue").doc(id).set(queueDoc({ id, conversationId, model: "stale-model" }), { merge: false });
      const before = smtpCalls.length;

      const result = await chatAi.processAutoReplyQueue();

      assert.equal(result.ok, false);
      assert.ok(result.failed >= 1);
      assert.equal(smtpCalls.length, before);
      const queue = await db.collection("auto_reply_queue").doc(id).get();
      assert.equal(queue.get("status"), "failed");
      const events = await db.collection(permit.CHAT_AUTO_CASE_EXECUTION_LEDGER_COLLECTION)
        .where("sourceRef", "==", `auto_reply_queue/${id}`)
        .get();
      assert.equal(events.empty, false);
      assert.equal(events.docs.some((doc) => doc.get("reason") === "send_blocked"), true);
    });
  });

  test("receive Permit decision ledger replay is idempotent and preserves inbound safe draft", async () => {
    await withRestoredSharedDocs(async () => {
      const nowIso = new Date().toISOString();
      const conversationId = `permit-replay-conv-${RUN}`;
      const messageSourceId = `permit-replay-source-${RUN}`;
      const gateway = {
        summaryKr: "관심 있음 — 다음 단계 요청",
        draftText: "LLM freeform suggestion must not be the approved candidate.",
        draftPreview: "LLM freeform suggestion must not be the approved candidate.",
        messageRef: `message_sources/${messageSourceId}`,
        draftRef: `permit-replay-draft-${RUN}`,
        trackingId: `permit-replay-track-${RUN}`,
        humanGate: { decision: "auto_reply", reason: "test", ruleIds: ["test"] },
        inboundIntent: { id: "other_human", source: "model" },
        caseId: CASE_ID,
        cache: { key: `cache-${RUN}`, checked: true, hit: false, ttlSeconds: 3600 },
        costLog: {
          provider: "ai-hub",
          transport: "ai_hub_gateway",
          model: MODEL,
          cacheHit: false,
          inputTokens: 1,
          outputTokens: 1,
          estimatedCostUsd: 0.001,
          ledgerRef: `cost-${RUN}`,
        },
      };
      const request = {
        auth: auth("permit-receive-replay"),
        data: {
          conversationId,
          messageRef: `message_sources/${messageSourceId}`,
          trackingId: gateway.trackingId,
          from: `creator-replay-${RUN}@example.com`,
          to: "scp@supercent.io",
          subject: "Permit replay inbound",
          body: "Please send next steps.",
          dryRun: true,
          liveSend: false,
          imapIngestPayload: true,
          allowMockGatewayFallback: false,
        },
        rawRequest: { ip: "127.0.0.1" },
        internalTrustedInvocation: true,
      };
      const deps = { runGatewayLive: async () => gateway };

      const first = await chatAi.receiveEmail(request, deps);
      const second = await chatAi.receiveEmail(request, deps);

      assert.equal(first.queueState, "draft_only");
      assert.equal(second.queueState, "draft_only");
      const source = await db.collection("message_sources").doc(messageSourceId).get();
      assert.equal(source.get("autoReplyDraftText"), RESOLVED_DRAFT.text);
      assert.doesNotMatch(source.get("autoReplyDraftText"), /\{\{[A-Z0-9_]+\}\}/);
      assert.equal(source.get("humanDraftSuggestion"), gateway.draftText);
      const ledgers = await db.collection(permit.CHAT_AUTO_CASE_DECISION_LEDGER_COLLECTION)
        .where("conversationId", "==", conversationId)
        .where("messageSourceId", "==", messageSourceId)
        .get();
      assert.equal(ledgers.size, 1);
    });
  });
}
