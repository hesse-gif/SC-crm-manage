import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const permit = await import(new URL("../functions/lib/chatAutoCasePermit.js", import.meta.url));
const casebook = await import(new URL("../functions/lib/chatCasebook.js", import.meta.url));

const NOW = "2026-09-05T08:00:00.000Z";
const MODEL = "permit-model-v1";
const pin = permit.chatAutoCasePermitPin(MODEL);

function evalEvidence(overrides = {}) {
  return {
    status: "passed",
    runId: "eval-run-1",
    buildSha: "7ede011e",
    kRevision: "cowrie-qa",
    casebookHash: pin.casebookHash,
    modelVersion: pin.modelVersion,
    evaluatedAtIso: "2026-09-05T07:00:00.000Z",
    expiresAtIso: "2026-09-06T07:00:00.000Z",
    actualGatewayCall: true,
    bypassGatewayCache: true,
    heldout: { total: 2, passed: 2, failed: 0 },
    reroll: { total: 1, stable: 1, unstable: 0 },
    decisions: { allow: 1, deny: 2, unavailable: 0 },
    transports: ["ai_hub_gateway"],
    estimatedCostUsd: 0.01,
    ...overrides,
  };
}

function counters(overrides = {}) {
  return {
    consecutiveHumanUneditedApprovedSent: 20,
    totalHumanUneditedApprovedSent: 20,
    lastEligibleMessageRef: "conversations/c1/messages/m1",
    lastResetAtIso: null,
    lastResetReason: null,
    unavailableEvidenceCount: 0,
    ...overrides,
  };
}

function permitDoc(overrides = {}) {
  return {
    schemaVersion: permit.CHAT_AUTO_PERMIT_SCHEMA_VERSION,
    caseId: "interest_next_steps",
    state: "armed",
    armed: true,
    casebookHash: pin.casebookHash,
    casebookVersion: pin.casebookVersion,
    modelVersion: pin.modelVersion,
    counters: counters(),
    evalEvidence: evalEvidence(),
    updatedAtIso: NOW,
    updatedAt: {},
    updatedByHash: "actor",
    source: "functions.chatAutoCasePermit",
    ...overrides,
  };
}

function decisionInput(overrides = {}) {
  return {
    conversationId: "conversation/with/slash",
    messageSourceId: "message-source-1",
    caseId: "interest_next_steps",
    humanGateDecision: "auto_reply",
    gatewayCostLog: { provider: "ai-hub", model: MODEL, transport: "ai_hub_gateway", estimatedCostUsd: 0.01 },
    globalAutoReplyEnabled: true,
    conversationAiActive: true,
    dryRun: false,
    draftOnly: false,
    senderTrusted: true,
    senderIsCreator: true,
    permit: permitDoc(),
    currentPin: pin,
    serverRenderedDraft: permit.renderChatAutoServerDraft({
      caseId: "interest_next_steps",
      factTokenIds: [],
      linkTokenIds: [],
    }),
    caseAlreadyReserved: false,
    caseAlreadySent: false,
    mailSafetyAllowed: true,
    profileEnabled: true,
    nowIso: NOW,
    ...overrides,
  };
}

function denyReasons(overrides) {
  const decision = permit.evaluateChatAutoCasePermit(decisionInput(overrides));
  assert.equal(decision.allowed, false);
  return decision.denyReasons;
}

test("Permit core does not import chat-ai", () => {
  const source = readFileSync(new URL("../functions/chatAutoCasePermit.ts", import.meta.url), "utf8");
  assert.ok(!source.includes("chat-ai"));
});

test("all current auto_ok casebook cases have server-rendered templates bound into the casebook hash", () => {
  const autoOk = casebook.CHAT_CASEBOOK.filter((entry) => entry.escalation === "auto_ok");
  assert.ok(autoOk.length > 0);
  assert.deepEqual(
    permit.chatAutoPermitAutoOkCaseIds().sort(),
    autoOk.map((entry) => entry.id).sort(),
  );
  for (const entry of autoOk) {
    assert.ok(entry.autoReplyTemplate?.template.includes("Best regards,\nSupercent"), entry.id);
    const rendered = permit.renderChatAutoServerDraft({ caseId: entry.id, factTokenIds: [], linkTokenIds: [] });
    assert.equal(rendered.status, "rendered", entry.id);
  }
});

test("missing permit fails closed", () => {
  assert.ok(denyReasons({ permit: null }).includes("permit_missing"));
});

test("unknown case fails closed as unclassified", () => {
  assert.ok(denyReasons({ caseId: "fallback_unclassified" }).includes("case_unclassified"));
});

test("non-auto-ok case fails closed", () => {
  const rendered = permit.renderChatAutoServerDraft({ caseId: "asset_request", factTokenIds: [], linkTokenIds: [] });
  const reasons = denyReasons({ caseId: "asset_request", serverRenderedDraft: rendered });
  assert.ok(reasons.includes("case_not_auto_ok"));
  assert.ok(reasons.includes("server_render_unavailable"));
});

test("stale pin and gateway model mismatch deny", () => {
  const reasons = denyReasons({
    gatewayCostLog: { provider: "ai-hub", model: "older-model", transport: "ai_hub_gateway", estimatedCostUsd: 0.01 },
    permit: permitDoc({ modelVersion: "older-model" }),
  });
  assert.ok(reasons.includes("pin_mismatch"));
});

test("permit for another case fails closed with permit_case_mismatch", () => {
  const reasons = denyReasons({
    permit: permitDoc({ caseId: "submission_support" }),
  });
  assert.ok(reasons.includes("permit_case_mismatch"));
});

test("cached or unverified gateway transport denies", () => {
  assert.ok(denyReasons({ gatewayCostLog: { provider: "ai-hub", model: MODEL, transport: "cache", estimatedCostUsd: 0 } }).includes("gateway_transport_unverified"));
  assert.ok(denyReasons({ gatewayCostLog: { provider: "ai-hub", model: MODEL, transport: "unverified", estimatedCostUsd: 0 } }).includes("gateway_transport_unverified"));
});

test("eval evidence must be fresh, complete, actual, noncached, and numerically valid", () => {
  assert.ok(denyReasons({ permit: permitDoc({ evalEvidence: evalEvidence({ expiresAtIso: "not-a-date" }) }) }).includes("eval_not_passed"));
  assert.ok(denyReasons({ permit: permitDoc({ evalEvidence: evalEvidence({ evaluatedAtIso: "2026-09-06T00:00:00.000Z" }) }) }).includes("eval_not_passed"));
  assert.ok(denyReasons({ permit: permitDoc({ evalEvidence: evalEvidence({ heldout: { total: 2, passed: 1, failed: 1 } }) }) }).includes("eval_not_passed"));
  assert.ok(denyReasons({ permit: permitDoc({ evalEvidence: evalEvidence({ reroll: { total: 1, stable: 0, unstable: 1 } }) }) }).includes("eval_not_passed"));
  assert.ok(denyReasons({ permit: permitDoc({ evalEvidence: evalEvidence({ transports: ["unverified"] }) }) }).includes("eval_not_passed"));
  assert.ok(denyReasons({ permit: permitDoc({ evalEvidence: evalEvidence({ estimatedCostUsd: Number.NaN }) }) }).includes("eval_not_passed"));
});

test("counter floor requires finite current committed counters", () => {
  assert.ok(denyReasons({ permit: permitDoc({ counters: counters({ consecutiveHumanUneditedApprovedSent: 19 }) }) }).includes("counter_floor_not_met"));
  assert.ok(denyReasons({ permit: permitDoc({ counters: counters({ consecutiveHumanUneditedApprovedSent: Number.NaN }) }) }).includes("counter_floor_not_met"));
  assert.ok(denyReasons({ permit: permitDoc({ counters: counters({ unavailableEvidenceCount: 1 }) }) }).includes("counter_floor_not_met"));
  assert.ok(denyReasons({ permit: permitDoc({ counters: counters({ unavailableEvidenceCount: 1 }) }) }).includes("counter_evidence_unavailable"));
});

// [적대 리뷰 HIGH-3] operator_override는 "20건 연속" 카운터 플로어만 우회한다 — 발송 시점의
// unavailableEvidenceCount>0 서킷브레이커는 override 여부와 무관하게 무조건 발송을 막아야 한다.
test("operator_override bypasses only the consecutive-counter floor, never the evidence-unavailable circuit breaker", () => {
  // Sanity: override does bypass a below-floor consecutive counter (the intended behavior).
  const bypassed = permit.evaluateChatAutoCasePermit(
    decisionInput({
      permit: permitDoc({
        armingSource: "operator_override",
        counters: counters({ consecutiveHumanUneditedApprovedSent: 0, unavailableEvidenceCount: 0 }),
      }),
    }),
  );
  assert.equal(bypassed.allowed, true);

  // The fix under test: override-armed permit + unavailableEvidenceCount 1 must still deny.
  const reasons = denyReasons({
    permit: permitDoc({
      armingSource: "operator_override",
      counters: counters({ consecutiveHumanUneditedApprovedSent: 0, unavailableEvidenceCount: 1 }),
    }),
  });
  assert.ok(reasons.includes("counter_evidence_unavailable"));
  assert.ok(!reasons.includes("counter_floor_not_met"), "override must still bypass the consecutive-counter floor itself");
});

test("F-4: sender not attributable to a creator record denies with sender_not_creator", () => {
  assert.ok(denyReasons({ senderIsCreator: false }).includes("sender_not_creator"));
});

test("case reservation and actual send memory deny duplicate send", () => {
  assert.ok(denyReasons({ caseAlreadyReserved: true }).includes("case_already_reserved"));
  assert.ok(denyReasons({ caseAlreadySent: true }).includes("case_already_sent"));
});

test("unknown fact or link tokens clamp server rendering to needs_review", () => {
  const unknownFact = permit.renderChatAutoServerDraft({
    caseId: "interest_next_steps",
    factTokenIds: ["unknown.fact"],
    linkTokenIds: [],
  });
  assert.equal(unknownFact.status, "needs_review");
  assert.ok(unknownFact.guard.clampReasonIds.includes("unsupported_fact_token"));

  const unknownLink = permit.renderChatAutoServerDraft({
    caseId: "interest_next_steps",
    factTokenIds: [],
    linkTokenIds: ["UNSUPPORTED_LINK"],
  });
  assert.equal(unknownLink.status, "needs_review");
  assert.ok(unknownLink.guard.clampReasonIds.includes("unsupported_link_token"));
});

test("factual guard rejects arbitrary free-form draft text", () => {
  const guard = permit.evaluateChatAutoDraftFactualClaims({
    caseId: "interest_next_steps",
    draftText: "We guarantee approval and can offer a custom bonus.",
    evidenceRefs: ["program.apply"],
  });
  assert.equal(guard.status, "needs_review");
  assert.ok(guard.clampReasonIds.includes("unsupported_factual_claim"));
});

test("all gates passing allows and produces a Firestore path-safe stable intent id", () => {
  const decision = permit.evaluateChatAutoCasePermit(decisionInput());
  assert.equal(decision.allowed, true);
  assert.equal(decision.intentId, permit.chatAutoCaseIntentId("conversation/with/slash", "interest_next_steps"));
  assert.match(decision.intentId, /^aci_[a-f0-9]{40}$/);
});
