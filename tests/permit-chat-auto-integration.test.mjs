import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const permit = await import(new URL("../functions/lib/chatAutoCasePermit.js", import.meta.url));
const store = await import(new URL("../functions/lib/chatAutoCasePermitStore.js", import.meta.url));
const mailCompiler = await import(new URL("../functions/lib/mailCompiler.js", import.meta.url));
const chatSource = readFileSync(new URL("../functions/chat-ai.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../functions/index.ts", import.meta.url), "utf8");

function sliceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `${startNeedle} must exist`);
  if (endNeedle === "__EOF__") return source.slice(start);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `${endNeedle} must exist after ${startNeedle}`);
  return source.slice(start, end);
}

const currentModelResolver = sliceBetween(
  chatSource,
  "export async function resolveChatAutoPermitCurrentModelVersion",
  "// programs/{id}.mailTemplate",
);
const liveGateway = sliceBetween(
  chatSource,
  "export async function runGatewayLive",
  `/**
 * W119`,
);
const stagingEval = sliceBetween(
  chatSource,
  "export async function runStagingAiGatewayEval",
  "export async function cancelQueuedAutoRepliesForHumanTakeover",
);
const receivePlan = sliceBetween(
  chatSource,
  "async function buildChatAutoPermitReceivePlan",
  "export async function gatewayProxy",
);
const receivePersist = sliceBetween(
  chatSource,
  "async function persistReceivedEmail",
  "function summarizeAiOutboundBody",
);
const queueJob = sliceBetween(
  chatSource,
  "async function sendAutoReplyJob",
  "function autoReplyDailyCounterDoc",
);
const sendStripper = sliceBetween(
  chatSource,
  "export function stripServerOwnedMailRequestProvenance",
  "export async function sendEmail",
);
const sendEmail = sliceBetween(
  chatSource,
  "export async function sendEmail",
  "__EOF__",
);

test("chat-ai binds Permit core and store with static imports only", () => {
  assert.match(chatSource, /chatAutoCasePermitPin[\s\S]*from "\.\/chatAutoCasePermit"/);
  assert.match(chatSource, /renderChatAutoServerDraft[\s\S]*from "\.\/chatAutoCasePermit"/);
  assert.match(chatSource, /evaluateChatAutoCasePermit[\s\S]*from "\.\/chatAutoCasePermit"/);
  assert.match(chatSource, /from "\.\/chatAutoCasePermitStore"/);
  assert.match(chatSource, /export async function resolveChatAutoPermitCurrentModelVersion/);
  assert.match(chatSource, /export async function runGatewayLive/);
  assert.doesNotMatch(chatSource, /optionalRequire|require\("\.\/chatAutoCasePermit/);
  assert.doesNotMatch(chatSource, /chatAutoPermitFallback/);
});

test("Permit model pin resolves from the current auto_reply_draft route and eval can bypass cache", () => {
  assert.match(currentModelResolver, /gatewayTaskForGate\(\{ decision: "auto_reply"/);
  assert.match(currentModelResolver, /selectConfiguredGatewayModel/);
  assert.match(liveGateway, /options:\s*RunGatewayLiveOptions = \{\}/);
  assert.match(liveGateway, /options\.bypassCache === true \|\| options\.bypassGatewayCache === true/);
  assert.match(liveGateway, /const cached = bypassCache \? null : await gatewayCacheLookup/);
  assert.match(liveGateway, /if \(!bypassCache\)/);
  assert.match(chatSource, /export async function runChatAutoPermitGatewayEvalScenario/);
  assert.match(chatSource, /"chat_auto_case_permit_eval",[\s\S]*\{ bypassCache: true \}/);
  assert.match(stagingEval, /\{ bypassCache: true \}/);
});

test("receive Permit plan derives evidence server-side and never reads caller token or proof fields", () => {
  assert.match(receivePlan, /resolveChatAutoPermitCurrentModelVersion\(\)/);
  assert.match(receivePlan, /chatAutoCasePermitPin\(modelVersion, caseId \? chatAutoCaseReplyPin\(caseId, replyState\.overrides, replyState\.revisions\) : CHAT_CASEBOOK_CONTENT_HASH\)/);
  assert.match(receivePlan, /model:\s*asString\(input\.gateway\.costLog\.model/);
  assert.match(receivePlan, /readChatAutoCasePermit\(caseId\)/);
  // 0.6.106: an operator-saved reply renders as sendable only when the permit is armed for that exact revision pin.
  assert.match(receivePlan, /const overrideArmedForPin = Boolean\(activeReplyOverride\) && chatAutoPermitArmedForPin\(permit, pin\.casebookHash\)/);
  assert.match(receivePlan, /operatorOverrideText: activeReplyOverride\.text, operatorOverrideArmed: overrideArmedForPin/);
  assert.match(receivePlan, /renderChatAutoServerDraft\(\{/);
  assert.match(receivePlan, /evaluateChatAutoCasePermit/);
  assert.match(receivePlan, /caseAlreadyReserved:\s*caseIntentSnapshot\?\.exists === true/);
  assert.match(receivePlan, /gatewayModelVersion:\s*asString\(input\.gateway\.costLog\.model/);
  assert.match(receivePlan, /const resolvedDraft = resolveChatAutoServerDraftBody\(serverRenderedDraft\)/);
  assert.match(receivePlan, /const draftHash = resolvedDraft\.hash/);
  for (const forbidden of [
    /input\.data\.factTokenIds/,
    /input\.data\.linkTokenIds/,
    /input\.data\.casebookHash/,
    /input\.data\.evalEvidence/,
    /input\.data\.permitDecisionId/,
    /input\.data\.gatewayLedgerRef/,
  ]) {
    assert.doesNotMatch(receivePlan, forbidden);
  }
});

test("receive queues only a typed allowed Permit draft and keeps denied cases as review candidates", () => {
  assert.match(receivePersist, /recordChatAutoDecisionLedger/);
  assert.match(receivePersist, /writeChatAutoCaseIntentBatch\(\s*batch/);
  assert.match(receivePersist, /batch\.set\(\s*queueRef/);
  assert.match(receivePersist, /const permitDraft = chatAutoPermitReceivePlan\.resolvedDraftText/);
  assert.doesNotMatch(receivePersist, /const permitDraft = .*gateway\.draftText/);
  assert.match(receivePersist, /const canonicalDraftHash = chatAutoPermitReceivePlan\.resolvedDraftHash/);
  assert.match(receivePersist, /draftText:\s*permitDraft/);
  assert.match(receivePersist, /humanDraftSuggestion:\s*gateway\.draftText/);
  assert.match(receivePersist, /autoReplyDraftText:\s*reviewDraft/);
  assert.match(receivePersist, /const reviewDraft = chatAutoPermitReceivePlan\.resolvedDraftText/);
  assert.doesNotMatch(receivePersist, /autoReplyDraftText:\s*gateway\.draftText/);
  assert.match(receivePersist, /caseCandidates/);
  assert.match(receivePersist, /clampReasonIds/);
  assert.match(receivePersist, /coreDraftHash:\s*chatAutoPermitReceivePlan\.coreDraftHash/);
});

// Casebook per-case attribution (2026-09-28, owner-approved direction; folded into the atomic
// batch write 2026-09-29 — incident 2026-09-29 scp@ 48h audit). History: round 7 first added this
// stamp inside the main receive `batch` only (missing from the case-intent-collision `retryBatch`).
// Rounds 8-12 then moved it to a SEPARATE, best-effort `conversationRef.update(...)` issued AFTER
// whichever of batch.commit()/retryBatch.commit() succeeded, gated by an exact-timestamp
// optimistic-concurrency precondition (lastUpdateTime) so a genuinely concurrent newer inbound
// could never be clobbered by an older one's delayed stamp.
//
// That precondition-gated design turned out to silently lose the stamp far more often than the
// "rare, benign race" rounds 8-12 designed for: a live 48h production audit found conversations
// where the model HAD returned a valid, casebook-matched caseId (confirmed via the escalation
// clamp's own `casebook ${id}: ...` reason string) but still carried no autoCaseId at all, because
// some unrelated write to the same conversation (e.g. requeueAutoReplyBacklog's sweep, which
// independently re-reads/re-writes every "waiting_for_human" conversation on its own schedule)
// landed in the ~1.5s window between this invocation's own commit and its follow-up update() — an
// outcome the code treated as an expected, never-retried skip, permanently hiding the case from
// feat/case-backlog-send's sweep even though classification itself succeeded.
//
// Fix: write the three stamp fields directly onto `conversationData` — the SAME object `batch`
// (and, via its spread, `retryBatch`) already merges into conversationRef below alongside
// lastMessageRef/lastMessageFrom/etc — instead of a separate post-commit write. This gives the
// stamp the exact same last-write-wins ordering lastMessageRef itself already has for genuinely
// concurrent/replayed inbound on one conversation (a pre-existing, accepted, documented
// limitation — not something this fix needs to solve), so it introduces no new race: whichever
// inbound's batch commits last simply owns lastMessageRef AND the case stamp together, atomically,
// every time. Structural proof (matching this file's own established convention —
// persistReceivedEmail is too large/dependency-heavy to execute directly in the node lane).
test("receive persist stamps autoCaseId/autoCaseClassifiedAtIso/autoCaseMessageRef into the SAME atomic conversationRef write as lastMessageRef, not a separate post-commit update", () => {
  const stampIndex = receivePersist.indexOf("conversationData.autoCaseId = gateway.caseId");
  assert.ok(stampIndex >= 0, "the per-case attribution stamp must exist in persistReceivedEmail");
  assert.match(
    receivePersist,
    // 0.6.105 D: + the truncated no-reply guard (a clipped 부재중/종결 인사 verdict is not stamped).
    // classification_v1: + the classification-axes stamp fields written inside the same atomic merge.
    /if \(isChatAutoCaseId\(gateway\.caseId\) && !\(gatewaySignalTruncated && isCasebookNoReplyNeeded\(gateway\.caseId\)\)\) \{\s*\n\s*conversationData\.autoCaseId = gateway\.caseId;\s*\n\s*conversationData\.autoCaseClassifiedAtIso = receivedAtIso;\s*\n\s*conversationData\.autoCaseMessageRef = storedMessageRef;\s*\n(?:\s*\/\/[^\n]*\n)*\s*Object\.assign\(conversationData, autoCaseClassificationStampFields\(gateway\.classification\)\);\s*\n\s*\}/,
    "the stamp must assign directly onto conversationData, guarded by isChatAutoCaseId(gateway.caseId)",
  );
  const batchCommitIndex = receivePersist.indexOf("await batch.commit();");
  assert.ok(batchCommitIndex > 0, "the main batch commit must exist");
  assert.ok(stampIndex < batchCommitIndex, "the stamp must be assigned onto conversationData BEFORE the batch commits, so it rides the same atomic write — never after");
  const conversationDataDeclIndex = receivePersist.indexOf("const conversationData: Record<string, unknown> = {");
  assert.ok(conversationDataDeclIndex >= 0 && conversationDataDeclIndex < stampIndex, "the stamp assignment must come after conversationData is declared");
  // The old separate-write design (precondition update + timeout race + silent-skip catch) must be
  // fully gone — this is the actual bug this fix removes.
  assert.doesNotMatch(receivePersist, /conversationRef\.update\(/, "the stamp must never be a separate conversationRef.update() call");
  assert.doesNotMatch(receivePersist, /receiveCommitWriteTime/, "the fragile commit-writeTime precondition plumbing must be fully removed");
  assert.doesNotMatch(receivePersist, /chat_auto_case_attribution_stamp_timeout/, "the timeout-raced separate write must be fully removed");
  assert.doesNotMatch(chatSource, /function latestCommitWriteTime/, "the helper that only existed to support the removed precondition write must be fully removed");
});

test("receive persist's collision retry path inherits the case stamp via conversationData's spread, without deleting it", () => {
  const retrySetIndex = receivePersist.indexOf("retryBatch.set(conversationRef, {");
  assert.ok(retrySetIndex >= 0, "the collision-retry conversationRef write must exist");
  const retryPatch = receivePersist.slice(retrySetIndex, receivePersist.indexOf("}, { merge: true });", retrySetIndex));
  assert.match(retryPatch, /\.\.\.conversationData/, "the retry patch must spread conversationData (which already carries the case stamp when applicable)");
  assert.doesNotMatch(retryPatch, /autoCaseId:\s*FieldValue\.delete\(\)/, "the retry path must not delete the case stamp the colliding inbound was itself classified into");
});

test("recordChatAutoDecisionLedger's coverage boundary is documented at its call site", () => {
  const ledgerCallIndex = receivePersist.indexOf("if (chatAutoPermitReceivePlan) {");
  assert.ok(ledgerCallIndex >= 0, "the ledger call site must exist");
  const precedingComment = receivePersist.slice(Math.max(0, ledgerCallIndex - 600), ledgerCallIndex);
  assert.match(
    precedingComment,
    /records only model-auto_reply-\s*(?:\/\/\s*)?gated outcomes/,
    "a comment must document that this ledger never records needs_review/blocked/pre-pipeline mail",
  );
});

test("receive case-intent reservation is atomic with queue and has one safe-draft collision retry", () => {
  // Structural wiring: the reservation write and the retry-on-collision branch must still exist
  // in the shape persistReceivedEmail relies on (commit ordering, adminDb.batch() for the retry).
  const queueWriteIndex = receivePersist.indexOf("batch.set(\n          queueRef");
  const intentIndex = receivePersist.indexOf("writeChatAutoCaseIntentBatch(\n          batch");
  const commitIndex = receivePersist.indexOf("await batch.commit()");
  const ledgerIndex = receivePersist.indexOf("await recordChatAutoDecisionLedger({");
  assert.ok(intentIndex >= 0 && queueWriteIndex > intentIndex && commitIndex > queueWriteIndex);
  assert.ok(ledgerIndex > commitIndex, "decision ledger writes after inbound batch/retry commits");
  assert.match(receivePersist, /isChatAutoCaseIntentCreateCollision\(error\)/);
  assert.match(receivePersist, /duplicate_case_intent/);
  assert.match(receivePersist, /const retryBatch = adminDb\.batch\(\)/);
  assert.match(receivePersist, /retryBatch\.set\(sourceRef/);
  assert.match(receivePersist, /retryBatch\.set\(conversationRef/);
  assert.match(receivePersist, /retryBatch\.set\(messageDocRef/);
  assert.match(receivePersist, /await retryBatch\.commit\(\)/);
  assert.match(receivePersist, /throw error/);

  // [적대 리뷰 HIGH-3a] Behavioral proof of the *mechanism* that makes the reservation atomic:
  // the same (conversationId, caseId) must always reserve the SAME document id (writeChatAutoCaseIntentBatch
  // targets `chatAutoCaseIntentId(conversationId, caseId)`), so a concurrent/duplicate inbound event for
  // the same case collides on Firestore's real create()-on-existing-doc error instead of silently
  // creating a second reservation. isChatAutoCaseIntentCreateCollision must recognize exactly that real
  // error shape (and only that shape) so the retry path treats it as a safe duplicate, not a genuine
  // write failure. These are the real, exported functions actually used by persistReceivedEmail — no
  // regex is involved below.
  const conversationId = "conv-atomic-reservation";
  const caseId = "interest_next_steps";
  const otherCaseId = "reward_overview";
  assert.equal(
    permit.chatAutoCaseIntentId(conversationId, caseId),
    permit.chatAutoCaseIntentId(conversationId, caseId),
    "the same (conversationId, caseId) must reserve the same document id on every call",
  );
  assert.notEqual(
    permit.chatAutoCaseIntentId(conversationId, caseId),
    permit.chatAutoCaseIntentId(conversationId, otherCaseId),
    "a different case must not collide with an unrelated reservation",
  );

  const created = [];
  const fakeBatch = { create: (ref, data) => created.push({ ref, data }) };
  const decision = {
    allowed: true,
    caseId,
    intentId: "intent-atomic-1",
    pin: permit.chatAutoCasePermitPin("permit-model-atomic"),
    draft: permit.renderChatAutoServerDraft({ caseId, factTokenIds: [], linkTokenIds: [] }),
  };
  const ref = store.writeChatAutoCaseIntentBatch(fakeBatch, {
    conversationId,
    messageSourceId: "source-atomic-1",
    caseId,
    queueRef: "auto_reply_queue/q-atomic-1",
    decision,
    nowIso: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(created.length, 1, "the reservation must be exactly one create() call");
  assert.equal(
    ref.id,
    permit.chatAutoCaseIntentId(conversationId, caseId),
    "the reservation write must target the deterministic collision-detection id",
  );
  assert.equal(created[0].data.allowed, true);
  assert.equal(created[0].data.caseId, caseId);

  const realFirestoreAlreadyExists = Object.assign(
    new Error("6 ALREADY_EXISTS: Document already exists: projects/demo/databases/(default)/documents/x"),
    { code: 6 },
  );
  assert.equal(
    store.isChatAutoCaseIntentCreateCollision(realFirestoreAlreadyExists),
    true,
    "a real Firestore create()-collision (numeric gRPC code 6) must be recognized",
  );
  assert.equal(
    store.isChatAutoCaseIntentCreateCollision(Object.assign(new Error("conflict"), { code: "already-exists" })),
    true,
  );
  assert.equal(
    store.isChatAutoCaseIntentCreateCollision(new Error("Document already exists")),
    true,
    "a message-shaped collision without a code must still be recognized",
  );
  assert.equal(
    store.isChatAutoCaseIntentCreateCollision(Object.assign(new Error("permission denied"), { code: 7 })),
    false,
    "a genuine write failure must NOT be misclassified as a safe duplicate",
  );
  assert.equal(
    store.isChatAutoCaseIntentCreateCollision(new Error("network timeout")),
    false,
  );
});

test("auto-reply worker fails closed for legacy queues and updates sent-case union only after confirmed evidence", () => {
  assert.match(queueJob, /legacy queues fail closed/);
  assert.match(queueJob, /appendChatAutoCasePermitEvent/);
  for (const field of [
    "caseId",
    "caseIntentRef",
    "permitDecisionId",
    "casebookHash",
    "gatewayModelVersion",
    "draftHash",
    "draftRenderSource",
  ]) {
    assert.match(queueJob, new RegExp(`job\\.${field}`));
  }
  assert.match(queueJob, /resolveChatAutoPermitCurrentModelVersion\(\{[\s\S]*settings: dispatchSettings,[\s\S]*config: dispatchConfig/);
  assert.match(queueJob, /currentPin:\s*chatAutoCasePermitPin\(dispatchModelVersion, dispatchCasebookHash\)/);
  assert.match(queueJob, /model:\s*job\.gatewayModelVersion/);
  assert.match(queueJob, /providerConfirmedAutoRepliedCaseIdsUnionUpdate\(job\.caseId, job\.caseIntentRef\)/);
  assert.match(queueJob, /const adverseReason = evidencePending \|\| unknown \? "send_unknown_acceptance" : ""/);
  assert.match(queueJob, /appendChatAutoCasePermitEvent\(\{[\s\S]*reason:\s*"send_unknown_acceptance"/);
  // [적대 리뷰 HIGH-3a] sendAutoReplyJob must gate the union update through the shared,
  // independently-tested predicate below rather than recomputing the six conditions inline
  // (a source-regex on the inline booleans could not catch a mutated `&&`/`||`).
  assert.match(
    queueJob,
    /confirmedSent = chatAutoConfirmedSendGate\(/,
    "confirmedSent must be computed by the shared predicate, not recomputed inline",
  );
  assert.match(queueJob, /if \(confirmedSent && isChatAutoCaseId\(job\.caseId\)\)/);

  // Behavioral proof of the gate itself: exercise the REAL exported chatAutoConfirmedSendGate
  // with every single-condition flip and assert the union update fires only when every
  // condition holds.
  const confirmedBaseline = {
    duplicateSent: false,
    deliveryState: "sent",
    providerConfirmed: true,
    acceptedCount: 1,
    persisted: true,
    outboxOk: true,
  };
  assert.equal(permit.chatAutoConfirmedSendGate(confirmedBaseline), true);
  for (const [field, value] of [
    ["duplicateSent", true],
    ["deliveryState", "mock_sent"],
    ["providerConfirmed", false],
    ["acceptedCount", 0],
    ["persisted", false],
    ["outboxOk", false],
  ]) {
    assert.equal(
      permit.chatAutoConfirmedSendGate({ ...confirmedBaseline, [field]: value }),
      false,
      `flipping ${field} to ${JSON.stringify(value)} must not confirm the send`,
    );
  }

  const unionPatch = permit.providerConfirmedAutoRepliedCaseIdsUnionUpdate("interest_next_steps", "auto_reply_case_intents/x");
  assert.deepEqual(
    Object.keys(unionPatch).sort(),
    ["autoRepliedCaseIds", "autoRepliedCaseIntentRefs", "autoRepliedCaseUpdatedAt"].sort(),
  );
});

test("dispatch holds (not disarms) send when the armed permit's build commit no longer matches the deployed release", () => {
  // [적대 리뷰 MED-3] a permit armed under commit A must not auto-send under commit B.
  assert.match(
    queueJob,
    /chatAutoPermitReleaseIdentityMatches\(dispatchPermit\.evalEvidence, cachedChatAutoPermitReleaseSourceCommit\(\)\)/,
    "sendAutoReplyJob must thread the cached release identity into the send-time gate",
  );
  // release-refresh-repin (2026-09-25, 헤세 지시): this gate must NOT disarm the permit itself
  // anymore — refreshArmedChatAutoCasePermits (triggered promptly on release change, see
  // triggerChatAutoCasePermitRefreshOnReleaseChangeOnce) re-pins it automatically when eligible.
  // The job is held (autoReplyReleaseIdentityPending) and retried, not failed.
  const releaseIdentityBlock = sliceBetween(
    queueJob,
    "dispatchPermit?.armed === true &&",
    "const dispatchDecision = evaluateChatAutoCasePermit(",
  );
  assert.doesNotMatch(releaseIdentityBlock, /appendChatAutoCasePermitEvent/);
  assert.doesNotMatch(releaseIdentityBlock, /reason:\s*"release_identity_changed"/);
  assert.match(releaseIdentityBlock, /autoReplyReleaseIdentityPending:\s*true/);
  assert.doesNotMatch(releaseIdentityBlock, /throw pipelinePreconditionFailure/);
  assert.doesNotMatch(releaseIdentityBlock, /throw failedPrecondition/);

  const armedAtCommitA = {
    status: "passed",
    buildSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    evaluatedAtIso: "2026-09-01T00:00:00.000Z",
    expiresAtIso: "2026-12-01T00:00:00.000Z",
  };
  // Same commit still deployed: the send-time gate must not block.
  assert.equal(
    permit.chatAutoPermitReleaseIdentityMatches(armedAtCommitA, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    true,
  );
  // A new commit was deployed since arming: the send-time gate must block.
  assert.equal(
    permit.chatAutoPermitReleaseIdentityMatches(armedAtCommitA, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    false,
  );
  // No eval evidence at all (permit_missing/eval_missing already deny elsewhere) — this axis
  // must not add a second, redundant block reason.
  assert.equal(permit.chatAutoPermitReleaseIdentityMatches(null, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), true);
  // Release identity unavailable (non-production runtime, e.g. emulator/dev) — must not block,
  // since other gates already fail closed for that environment.
  assert.equal(permit.chatAutoPermitReleaseIdentityMatches(armedAtCommitA, null), true);
});

// release-refresh-repin (2026-09-25, 헤세 지시 — 근본 설계 확장): pins the new hold-and-retry
// machinery for a per-case release-identity mismatch, mirroring the pre-existing global-switch-pause
// pattern but WITHOUT breaking the sweep (other cases may already be pinned to the current release).
test("sendAutoReplyJob: release-identity-mismatch marker is read by a dedicated helper and released without disarming (per-case, not sweep-wide)", () => {
  const markerHelper = sliceBetween(
    chatSource,
    "function autoReplyReleaseIdentityPendingFromError(error: unknown): boolean {",
    "// release-refresh-repin (2026-09-25): per-CASE (not global) hold",
  );
  assert.match(markerHelper, /autoReplyReleaseIdentityPending === true/);

  const releaseHelper = sliceBetween(
    chatSource,
    "async function releaseAutoReplyJobForReleaseIdentityPending(",
    "export async function processAutoReplyQueue(",
  );
  assert.match(releaseHelper, /status:\s*"scheduled"/);
  assert.match(releaseHelper, /processingStartedAtIso:\s*FieldValue\.delete\(\)/);
  assert.match(releaseHelper, /attemptCount:\s*FieldValue\.increment\(-1\)/);

  const catchBlock = sliceBetween(
    chatSource,
    "if (autoReplyReleaseIdentityPendingFromError(error)) {",
    "const identityCode = mailIdentityCodeFromError(error);",
  );
  assert.match(catchBlock, /releaseAutoReplyJobForReleaseIdentityPending\(job, nowIso\)/);
  assert.match(catchBlock, /result\.releaseIdentityPending = \(result\.releaseIdentityPending \?\? 0\) \+ 1;/);
  // Unlike the global-switch-pause branch just above it (which `break`s the whole sweep), this
  // must `continue` — a release-identity hold is per-case, other jobs must still get a chance to
  // dispatch in the same pass.
  assert.match(catchBlock, /continue;/);
  assert.doesNotMatch(catchBlock, /break;/);
});

// release-refresh-repin (2026-09-25): the refresh that re-pins armed permits under the current
// release must run promptly (once per distinct deployed release) instead of waiting up to the 12h
// refreshChatAutoCasePermitsSchedule cadence — otherwise every job hits the hold above until then.
test("processAutoReplyQueue triggers the release-change permit refresh once, after the pause gates, before claiming jobs", () => {
  const sweepEntry = readFileSync(new URL("../functions/chat-ai.ts", import.meta.url), "utf8");
  const trigger = sliceBetween(
    sweepEntry,
    "async function triggerChatAutoCasePermitRefreshOnReleaseChangeOnce(nowIso: string): Promise<void> {",
    "export async function processAutoReplyQueue(): Promise<AutoReplyQueueResult> {",
  );
  assert.match(trigger, /cachedChatAutoPermitReleaseSourceCommit\(\)/);
  assert.match(trigger, /adminDb\.runTransaction/);
  assert.match(trigger, /refreshArmedChatAutoCasePermits\(\{/);
  assert.match(trigger, /buildSha: currentSourceCommit,/);

  const sweepBody = sliceBetween(
    chatSource,
    "export async function processAutoReplyQueue(): Promise<AutoReplyQueueResult> {",
    "async function conversationTakenOverByHuman(",
  );
  const pauseGate = sweepBody.indexOf("pausedByGlobalSwitch: true,");
  const triggerCall = sweepBody.indexOf("await triggerChatAutoCasePermitRefreshOnReleaseChangeOnce(nowIso);");
  const claimQuery = sweepBody.indexOf('.where("status", "==", "scheduled")');
  assert.notEqual(pauseGate, -1);
  assert.notEqual(triggerCall, -1);
  assert.notEqual(claimQuery, -1);
  assert.ok(pauseGate < triggerCall, "refresh trigger must come after the autoReplyEnabled pause gate");
  assert.ok(triggerCall < claimQuery, "refresh trigger must come before jobs are claimed for this pass");
});

test("index.ts: processAutoReplyQueue is granted the gateway-eval secrets and a longer timeout for the release-change refresh", () => {
  const fnBlock = sliceBetween(
    indexSource,
    "export const processAutoReplyQueue = onSchedule(",
    "// 콜드/대량 아웃리치 드레인 워커",
  );
  assert.match(fnBlock, /secrets:\s*\["SMTP_PASSWORD",\s*"AI_HUB_LLM_API_KEY",\s*"JEV_API_KEY",\s*"SLACK_BOT_TOKEN"\]/);
  assert.match(fnBlock, /timeoutSeconds:\s*480/);
  // Codex gate round 1 (HIGH): gen2's default concurrency (80) would otherwise let a slow
  // (refresh-triggering) invocation overlap the next 5-minute invocation on the same instance.
  assert.match(fnBlock, /concurrency:\s*1,/);
  assert.match(fnBlock, /\(result\.releaseIdentityPending \?\? 0\) > 0/);
});

// Codex gate round 1 (HIGH): refreshArmedChatAutoCasePermits can now post to Slack from EITHER
// scheduler — both must carry the token or the alert this whole extension depends on silently
// never posts (postScheduledReportToSlack returns {posted:false} without throwing on a missing
// token, so a missing secret produces no error signal at all, just silence).
test("index.ts: refreshChatAutoCasePermitsSchedule also carries SLACK_BOT_TOKEN", () => {
  const fnBlock = sliceBetween(
    indexSource,
    "export const refreshChatAutoCasePermitsSchedule = onSchedule(",
    "export const listChatAutoCaseDecisionLedger",
  );
  assert.match(fnBlock, /secrets:\s*\["AI_HUB_LLM_API_KEY",\s*"JEV_API_KEY",\s*"SLACK_BOT_TOKEN"\]/);
});

// Codex gate round 1 (MEDIUM — real bug): Firestore transaction callbacks can be retried
// internally on contention; mutating a variable declared OUTSIDE the callback (as the original
// version did) leaks state from an earlier, superseded attempt into the final outcome. The claim
// decision must be the transaction's own return value instead.
test("triggerChatAutoCasePermitRefreshOnReleaseChangeOnce: claim decision is the transaction's return value, not an externally-mutated variable", () => {
  const trigger = sliceBetween(
    chatSource,
    "async function triggerChatAutoCasePermitRefreshOnReleaseChangeOnce(nowIso: string): Promise<void> {",
    "export async function processAutoReplyQueue(): Promise<AutoReplyQueueResult> {",
  );
  assert.match(trigger, /shouldRefresh = await adminDb\.runTransaction/);
  assert.match(trigger, /return false;/);
  assert.match(trigger, /return true;/);
  assert.doesNotMatch(trigger, /shouldRefresh = true;/);
});

// Codex gate round 1 (HIGH): a released job kept its ORIGINAL sendAfterIso, so several
// simultaneously-stale cases could repeatedly re-claim and re-consume a pass's
// maxAutoRepliesPerPass cap every 5 minutes until re-pinned. Pushing sendAfterIso forward removes
// it from "due" for one retry interval instead.
test("releaseAutoReplyJobForReleaseIdentityPending: pushes sendAfterIso forward so the job is not immediately due again", () => {
  const releaseHelper = sliceBetween(
    chatSource,
    "async function releaseAutoReplyJobForReleaseIdentityPending(",
    "async function recoverStaleAutoReplyJobs(",
  );
  assert.match(releaseHelper, /AUTO_REPLY_RELEASE_IDENTITY_PENDING_RETRY_DELAY_MS/);
  assert.match(releaseHelper, /sendAfterIso:\s*retryAfterIso,/);
});

// Codex gate round 1 (HIGH): armingSource:"operator_override" permits are the ONE case the
// automated refresh sweep deliberately never touches (chatAutoCasePermitCallables.ts) — without an
// explicit ping here, that case's hold has no path to prompt operator visibility at all.
test("sendAutoReplyJob: an operator_override-armed permit's release-identity hold pings ops (deduped once per case+release), not just an aggregate counter", () => {
  const releaseIdentityBlock = sliceBetween(
    queueJob,
    "dispatchPermit?.armed === true &&",
    "const dispatchDecision = evaluateChatAutoCasePermit(",
  );
  assert.match(releaseIdentityBlock, /dispatchPermit\.armingSource === "operator_override"/);
  assert.match(releaseIdentityBlock, /notifyOperatorOverridePermitReleasePendingOnce\(job\.caseId, currentSourceCommit, nowIso\)/);

  const notifier = sliceBetween(
    chatSource,
    "async function notifyOperatorOverridePermitReleasePendingOnce(",
    "async function sendAutoReplyJob(",
  );
  assert.match(notifier, /adminDb\.runTransaction/);
  assert.match(notifier, /postScheduledReportToSlack/);
  // Codex gate round 2 (HIGH — reproduced bug): postScheduledReportToSlack resolves {posted:false}
  // rather than throwing on a transport/API failure — deduping on "was a send ATTEMPTED" (not "did
  // it actually land") would permanently suppress the only ping for a (caseId, sourceCommit) pair
  // the first time Slack delivery merely hiccups. Dedup must require confirmed delivery.
  assert.match(notifier, /if \(asString\(data\.sourceCommit, ""\) === sourceCommit && data\.posted === true\) return false;/);
  assert.match(notifier, /if \(result\.posted\) \{/);
  assert.match(notifier, /ref\.set\(\{ posted: true \}, \{ merge: true \}\);/);
});

// Same class of bug, second gap in the same function: sendEmailLive only returns null here when it
// short-circuits on the dryRun/liveSend flags or the smtp integration switch (mailbox identity IS
// resolved before the switch check, but neither path ever constructs a transport or calls
// transporter.sendMail) — no SMTP attempt was made either way, so this is also a pipeline/config
// precondition, not an SMTP delivery failure or content-risk signal.
test("sendAutoReplyJob: live-SMTP-unavailable throw is tagged pipelinePreconditionFailure, not the untagged failedPrecondition", () => {
  const liveSmtpUnavailableBlock = sliceBetween(
    queueJob,
    "if (!liveDelivery && !mockMailAllowed(data)) {",
    "providerMessageId =",
  );
  assert.match(
    liveSmtpUnavailableBlock,
    /throw pipelinePreconditionFailure\(\s*"auto-reply live SMTP unavailable; configure SMTP or run in emulator dry-run\."/,
  );
  assert.doesNotMatch(liveSmtpUnavailableBlock, /throw failedPrecondition\(\s*"auto-reply live SMTP unavailable/);
});

test("markAutoReplyFailed: logs a sanitized failure category + throw-site frames for every failed job (diagnosability follow-up)", () => {
  const markFailed = sliceBetween(
    chatSource,
    "export function sanitizedThrowSiteFrames(error: unknown): string {",
    "async function markAutoReplyIdentityBlocked(",
  );
  assert.match(markFailed, /console\.error\("\[auto-reply-queue\] job failed", \{/);
  assert.match(markFailed, /throwSiteFrames: sanitizedThrowSiteFrames\(error\),/);
  assert.match(markFailed, /correlationIdHash: failure\.correlationIdHash,/);
  assert.match(markFailed, /pipelinePrecondition,/);
  // Codex gate round 1 (2026-09-25): the field must describe what THIS handler did, not the
  // permit's overall end state — a gate that already disarmed the permit itself before throwing
  // (e.g. the release-identity-mismatch one) must not be reported as "not disarmed".
  assert.match(markFailed, /permitDisarmedByThisCall:/);
  assert.doesNotMatch(markFailed, /permitDisarmed:/);
  // Codex gate round 1 (2026-09-25, HIGH): must never log the raw error message/response/command —
  // only the fixed/classified safeOutboundFailureEvidence fields plus stack FRAME lines (never the
  // message line, which can carry recipient content or, per mailTransport.ts, an account id/
  // secretRef in a pre-send error).
  assert.doesNotMatch(markFailed, /errorStack/);
  assert.match(markFailed, /error\.stack/);
  assert.match(markFailed, /filter\(\(line\) => \/\^\\s\*at\\s\/\.test\(line\)\)/);
  // Codex gate round 2 (2026-09-25, HIGH — bypass found): a naive "any line starting with 'at '"
  // filter leaks a multi-line error MESSAGE whose own line happens to start with "at ". The fix
  // strips the exact header (`String(error)`, byte-for-byte what V8 puts at the start of `.stack`)
  // before ever splitting into lines, and fails closed to "" if `.stack` doesn't start with it —
  // no unsafe per-line-only fallback.
  assert.match(markFailed, /const header = String\(error\);/);
  assert.match(markFailed, /if \(!error\.stack\.startsWith\(header\)\) return "";/);
  // errorName must be allowlisted against known Error subclasses, not logged verbatim (round 2).
  assert.match(markFailed, /errorName: sanitizedErrorName\(error\),/);
  assert.doesNotMatch(markFailed, /errorName: error instanceof Error \? error\.name/);
  // Never logs the job's own content (draftText/creatorEmail/etc) — only the error shape + a few
  // non-PII job identifiers.
  assert.doesNotMatch(markFailed.split("console.error(")[1], /job\.draftText|job\.creatorEmail|job\.to\b/);
});

test("W119: auto-reply worker classifies its own send as the transactional mail lane via server-owned provenance", () => {
  // The lane must come from a server-constructed marker (mailOutboundLanes.serverOwnedMailLaneProvenance),
  // never from job/client-controlled fields — a public callable input cannot reach this code path
  // (processAutoReplyQueue is an onSchedule function, not a callable), but the classification still
  // must not be inferable from arbitrary payload fields.
  assert.match(queueJob, /mailPurpose:\s*"auto_reply"/);
  assert.match(queueJob, /\.\.\.serverOwnedMailLaneProvenance\(CHAT_AUTO_REPLY_LANE_SOURCE\)/);
  assert.match(chatSource, /const CHAT_AUTO_REPLY_LANE_SOURCE = "auto_reply_queue"/);
  assert.match(
    chatSource,
    /const outboundBlock = await readOutboundSafetyBlock\(nowIso, "auto_reply", "transactional"\)/,
    "the sweep-level pre-check must also read the transactional lane, not the default outreach lane",
  );
});

test("outbound evidence carries canonical Permit hashes into source, queue, and mail log", () => {
  assert.match(queueJob, /dispatchResolvedDraft\.hash !== job\.draftHash/);
  assert.match(queueJob, /const sentBodyHash = chatAutoCanonicalDraftHash\(job\.draftText\)/);
  assert.match(queueJob, /originalDraftHash:\s*job\.draftHash/);
  assert.match(queueJob, /sentMatchesServerRenderedDraft/);
  assert.match(queueJob, /learningDisposition/);
  assert.match(queueJob, /mail_outbound_log|recordMailOutboundLog/);
  assert.match(queueJob, /caseIntentRef:\s*job\.caseIntentRef/);
  assert.match(queueJob, /permitDecisionId:\s*job\.permitDecisionId/);
});

test("public sendEmail strips forged Permit proof while internal provenance can be logged canonically", () => {
  for (const field of [
    "caseId",
    "caseIntentRef",
    "permitDecisionId",
    "casebookHash",
    "gatewayModelVersion",
    "originalDraftHash",
    "sentBodyHash",
    "sentMatchesServerRenderedDraft",
    "learningDisposition",
    "providerConfirmed",
    "acceptedCount",
    "rejectedCount",
  ]) {
    assert.match(sendStripper, new RegExp(`delete stripped\\.${field}`));
  }
  assert.match(sendEmail, /permitOriginalDraftHash/);
  assert.match(sendEmail, /compiledArtifactFingerprint\(sendArtifact\)/);
  assert.match(sendEmail, /permitSentMatchesServerRenderedDraft/);
  assert.match(sendEmail, /learningDisposition:\s*permitLearningDisposition/);
});

test("server-rendered Permit candidate uses the same canonical hash path as sent body evidence", () => {
  const draft = permit.renderChatAutoServerDraft({
    caseId: "interest_next_steps",
    factTokenIds: [],
    linkTokenIds: [],
  });
  assert.equal(draft.status, "rendered");

  assert.match(chatSource, /function resolveChatAutoServerDraftBody[\s\S]*substituteCasebookLinks\(draft\.text\)/);
  assert.match(chatSource, /draftCandidateHash:\s*draftHash/);
  assert.match(chatSource, /const coreDraftHash = draft\?\.draftHash \?\? ""/);
  assert.match(chatSource, /coreDraftHash:\s*resolvedDraft\.coreDraftHash/);

  const resolvedDraftText = draft.text
    .replace(/\{\{APPLY_LINK\}\}/g, "[Apply to Super Creator Partners](https://creator.supercent.io/apply)")
    .replace(/\{\{GUIDE_LINK\}\}/g, "[Super Creator Partners Guide](https://creator.supercent.io/?locale=en&view=guide&track=fixed-cpm#guide-overview)");
  assert.match(resolvedDraftText, /https:\/\/creator\.supercent\.io\/apply/);
  assert.match(resolvedDraftText, /https:\/\/creator\.supercent\.io\/\?locale=en&view=guide/);
  assert.doesNotMatch(resolvedDraftText, /\{\{[A-Z0-9_]+\}\}/);

  const candidateHash = mailCompiler.compiledArtifactFingerprint(
    mailCompiler.compileMailArtifact({ body: resolvedDraftText, bodyFormat: "markdown" }),
  );
  const exactSentHash = mailCompiler.compiledArtifactFingerprint(
    mailCompiler.compileMailArtifact({ body: resolvedDraftText, bodyFormat: "markdown" }),
  );
  const editedSentHash = mailCompiler.compiledArtifactFingerprint(
    mailCompiler.compileMailArtifact({ body: `${resolvedDraftText}\n\nEdited by human.`, bodyFormat: "markdown" }),
  );

  assert.equal(candidateHash, exactSentHash);
  assert.notEqual(candidateHash, editedSentHash);

  const exactCounters = store.summarizeChatAutoPermitCounters([{
    conversationId: "conv-hash-exact",
    messageRef: "conversations/conv-hash-exact/messages/m1",
    messageSourceRef: "message_sources/exact",
    outboundLogRef: "mail_outbound_log/exact",
    caseId: "interest_next_steps",
    casebookHash: permit.chatAutoCasePermitPin("permit-model-v1").casebookHash,
    gatewayModelVersion: "permit-model-v1",
    caseIntentRef: null,
    permitDecisionId: "decision-exact",
    sender: "human",
    approval: "approved",
    deliveryState: "sent",
    providerConfirmed: true,
    acceptedCount: 1,
    rejectedCount: 0,
    originalDraftHash: candidateHash,
    sentBodyHash: exactSentHash,
    sentMatchesServerRenderedDraft: true,
    bounced: false,
    complained: false,
    optedOut: false,
    suppressed: false,
    learningDisposition: "arming_credit",
    sentAtIso: "2026-09-05T00:00:00.000Z",
  }], { pin: permit.chatAutoCasePermitPin("permit-model-v1") });
  assert.equal(exactCounters.consecutiveHumanUneditedApprovedSent, 1);

  const editedCounters = store.summarizeChatAutoPermitCounters([{
    conversationId: "conv-hash-edited",
    messageRef: "conversations/conv-hash-edited/messages/m1",
    messageSourceRef: "message_sources/edited",
    outboundLogRef: "mail_outbound_log/edited",
    caseId: "interest_next_steps",
    casebookHash: permit.chatAutoCasePermitPin("permit-model-v1").casebookHash,
    gatewayModelVersion: "permit-model-v1",
    caseIntentRef: null,
    permitDecisionId: "decision-edited",
    sender: "human",
    approval: "approved",
    deliveryState: "sent",
    providerConfirmed: true,
    acceptedCount: 1,
    rejectedCount: 0,
    originalDraftHash: candidateHash,
    sentBodyHash: editedSentHash,
    sentMatchesServerRenderedDraft: false,
    bounced: false,
    complained: false,
    optedOut: false,
    suppressed: false,
    learningDisposition: "proposal_only_counter_reset",
    sentAtIso: "2026-09-05T00:00:00.000Z",
  }], { pin: permit.chatAutoCasePermitPin("permit-model-v1") });
  assert.equal(editedCounters.consecutiveHumanUneditedApprovedSent, 0);
  assert.equal(editedCounters.lastResetReason, "human_edited");
});

test("chat-ai writes committed send events for counter flow from server-derived Permit metadata", () => {
  assert.match(sendEmail, /recordChatAutoCommittedSendEvent/);
  assert.match(chatSource, /replyToMessageRef/);
  assert.match(chatSource, /originalDraftHash:\s*asString\(source\.draftCandidateHash/);
  assert.match(sendEmail, /providerConfirmed/);
  assert.match(sendEmail, /acceptedCount:\s*liveDelivery\?\.acceptedCount \?\? 0/);
  assert.match(sendEmail, /learningDisposition:\s*permitLearningDisposition/);
  assert.match(sendStripper, /delete stripped\.originalDraftHash/);
});
