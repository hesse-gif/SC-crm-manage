import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const require = createRequire(import.meta.url);

const permitCore = await import("../functions/lib/chatAutoCasePermit.js");
const permitStore = await import("../functions/lib/chatAutoCasePermitStore.js");
const pendingPrecompute = await import("../functions/lib/chatAutoCasebookPendingPrecompute.js");
const suggestionPrecompute = await import("../functions/lib/chatAutoCaseSuggestionPrecompute.js");

const readSource = readFileSync(new URL("../functions/read.ts", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../functions/settings.ts", import.meta.url), "utf8");
const settingsDefaultsSource = readFileSync(new URL("../functions/_settings-mock.ts", import.meta.url), "utf8");
const dataSource = readFileSync(new URL("../src/lib/data.ts", import.meta.url), "utf8");
const adminSource = readFileSync(new URL("../functions/admin.ts", import.meta.url), "utf8");
const seedSource = readFileSync(new URL("../functions/seedData.ts", import.meta.url), "utf8");
const firestoreRules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
const stagingRules = readFileSync(new URL("../firestore.staging.rules", import.meta.url), "utf8");

const PRIVATE_COLLECTIONS = [
  permitCore.CHAT_AUTO_CASE_PERMIT_COLLECTION,
  permitCore.CHAT_AUTO_CASE_DECISION_LEDGER_COLLECTION,
  permitCore.CHAT_AUTO_CASE_EXECUTION_LEDGER_COLLECTION,
  permitCore.CHAT_AUTO_CASE_EVAL_RUNS_COLLECTION,
  permitCore.CHAT_AUTO_CASEBOOK_PROPOSAL_OUTBOX_COLLECTION,
  permitCore.CHAT_AUTO_CASE_INTENTS_COLLECTION,
  // Casebook pending precompute (2026-09-29 casebook snapshot 504 hotfix) — server-only scheduled
  // job output (functions/chatAutoCasebookPendingPrecompute.ts); getChatAutoCasebookSnapshot is the
  // only reader, via a keyed doc get, never a client-facing dataset key.
  pendingPrecompute.CHAT_AUTO_CASEBOOK_PENDING_COLLECTION,
  // Default reply suggestions (casebook inbox, 2026-10-01) — server-only scheduled job output
  // (functions/chatAutoCaseSuggestionPrecompute.ts); the snapshot reads it by keyed doc get only.
  suggestionPrecompute.CHAT_AUTO_CASE_DEFAULT_SUGGESTIONS_COLLECTION,
];
const COUNTER_PIN = permitCore.chatAutoCasePermitPin("gemini-3.1-flash-lite");

const PERMIT_PROOF_FIELDS = [
  "chatAutoCasePermits",
  "casePermits",
  "evalEvidence",
  "consecutiveHumanUneditedApprovedSent",
  "totalHumanUneditedApprovedSent",
  "unavailableEvidenceCount",
  "gatewayLedgerRef",
  "gatewayTransport",
  "permitDecisionId",
  "caseIntentRef",
  "rawGatewayRequest",
  "rawGatewayResponse",
  "providerTrace",
];

function sliceFunction(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} must exist`);
  const nextExport = source.indexOf("\nexport async function", start + declaration.length);
  return source.slice(start, nextExport === -1 ? undefined : nextExport);
}

function buildDecisionInput(overrides = {}) {
  const pin = permitCore.chatAutoCasePermitPin("gemini-3.1-flash-lite");
  return {
    conversationId: "conversation-private-isolation",
    messageSourceId: "message-source-private-isolation",
    caseId: "interest_next_steps",
    humanGateDecision: "auto_reply",
    gatewayCostLog: {
      provider: "ai-hub",
      model: pin.modelVersion,
      transport: "ai_hub_gateway",
      estimatedCostUsd: 0.01,
    },
    globalAutoReplyEnabled: true,
    conversationAiActive: true,
    dryRun: false,
    draftOnly: false,
    senderTrusted: true,
    senderIsCreator: true,
    permit: null,
    currentPin: pin,
    serverRenderedDraft: permitCore.renderChatAutoServerDraft({
      caseId: "interest_next_steps",
      factTokenIds: [],
      linkTokenIds: [],
    }),
    caseAlreadyReserved: false,
    caseAlreadySent: false,
    mailSafetyAllowed: true,
    profileEnabled: true,
    nowIso: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

function completeCommittedEvent(overrides = {}) {
  return {
    conversationId: "conversation-private-isolation",
    messageRef: "conversations/conversation-private-isolation/messages/m1",
    messageSourceRef: "message_sources/source-private-isolation",
    outboundLogRef: "mail_outbound_log/outbound-private-isolation",
    caseId: "interest_next_steps",
    casebookHash: COUNTER_PIN.casebookHash,
    gatewayModelVersion: COUNTER_PIN.modelVersion,
    caseIntentRef: "auto_reply_case_intents/conversation-private-isolation__interest_next_steps",
    permitDecisionId: "decision-private-isolation",
    sender: "human",
    approval: "approved",
    deliveryState: "sent",
    providerConfirmed: true,
    acceptedCount: 1,
    rejectedCount: 0,
    originalDraftHash: "draft-hash",
    sentBodyHash: "draft-hash",
    sentMatchesServerRenderedDraft: true,
    bounced: false,
    complained: false,
    optedOut: false,
    suppressed: false,
    learningDisposition: "arming_credit",
    sentAtIso: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

test("Permit private collection constants include the closed server-owned collection set", () => {
  assert.equal(permitCore.CHAT_AUTO_CASE_PERMIT_COLLECTION, "chat_auto_case_permits");
  assert.deepEqual(PRIVATE_COLLECTIONS, [
    "chat_auto_case_permits",
    "chat_auto_case_decision_ledger",
    "chat_auto_case_execution_ledger",
    "chat_auto_case_eval_runs",
    "chat_auto_casebook_proposal_outbox",
    "auto_reply_case_intents",
    "chat_auto_casebook_pending",
    "chat_auto_case_reply_default_suggestions",
  ]);
  assert.equal(new Set(PRIVATE_COLLECTIONS).size, PRIVATE_COLLECTIONS.length);
});

test("fixed getDataset read allowlist cannot select Permit private collections", () => {
  const datasetUnion = readSource.match(/export type DatasetKey =([\s\S]*?)const STAGING_EXTERNAL_DATASET_KEYS/);
  const readKeyMap = readSource.match(/const \[\s*creatorsRead[\s\S]*?\] = await Promise\.all\(\[([\s\S]*?)\]\);/);
  assert.ok(datasetUnion, "DatasetKey union must be present");
  assert.ok(readKeyMap, "getDataset readKey mapping must be present");

  for (const collection of PRIVATE_COLLECTIONS) {
    assert.doesNotMatch(datasetUnion[1], new RegExp(`"${collection}"`));
    assert.doesNotMatch(readKeyMap[1], new RegExp(`readKey\\([^\\n]*"${collection}"`));
  }
});

test("rawRecords is pinned to raw_records and cannot name arbitrary private collections", () => {
  assert.match(readSource, /readKey\("rawRecords", "raw_records"\)/);
  assert.doesNotMatch(readSource, /readKey\("rawRecords",\s*(?:requestData|data|request\.data|asString)/);
  for (const collection of PRIVATE_COLLECTIONS) {
    assert.doesNotMatch(readSource, new RegExp(`rawRecords[\\s\\S]{0,160}${collection}`));
  }
});

test("conversation public projection omits Permit proof, counters, and raw Gateway fields", () => {
  const allowlist = readSource.match(/const PUBLIC_CONVERSATION_RECORD_KEYS = new Set\(\[([\s\S]*?)\]\.map\(normalizedPrivateKey\)\);/);
  assert.ok(allowlist, "PUBLIC_CONVERSATION_RECORD_KEYS must be present");
  for (const field of PERMIT_PROOF_FIELDS) {
    assert.doesNotMatch(allowlist[1], new RegExp(`"${field}"`));
  }
});

test("settings defaults and client settings payloads do not expose Permit proof fields", () => {
  const defaultsAutomation = settingsDefaultsSource.match(/automation: \{([\s\S]*?)\n  \},\n  humanReviewPolicy:/);
  const datasetTypes = dataSource.match(/export type DatasetKey =([\s\S]*?)export interface DatasetPayload/);
  assert.ok(defaultsAutomation, "settings automation defaults must be present");
  assert.ok(datasetTypes, "client dataset payload types must be present");

  for (const field of PERMIT_PROOF_FIELDS) {
    assert.doesNotMatch(defaultsAutomation[1], new RegExp(field));
    assert.doesNotMatch(datasetTypes[1], new RegExp(field));
  }
  assert.doesNotMatch(settingsSource, /CHAT_AUTO_CASE_PERMIT_COLLECTION|chat_auto_case_permits/);
});

test("caller-injected settings proof cannot arm a missing private Permit doc", () => {
  const decision = permitCore.evaluateChatAutoCasePermit(buildDecisionInput({
    automation: {
      chatAutoCasePermits: {
        interest_next_steps: {
          armed: true,
          evalEvidence: { status: "passed" },
          counters: { consecutiveHumanUneditedApprovedSent: 999 },
        },
      },
    },
  }));

  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.denyReasons, ["permit_missing"]);
});

test("settings update writes only settings-owned documents when caller injects Permit-shaped automation", async () => {
  const firebaseAdmin = require("../functions/lib/firebaseAdmin.js");
  const settings = require("../functions/lib/settings.js");
  const originalAdminDb = firebaseAdmin.adminDb;
  const writes = [];
  const gets = new Map([
    ["settings/default", {
      exists: true,
      data: () => ({
        revision: 1,
        automation: { autoReplyEnabled: false },
      }),
    }],
    ["settings/policy_cache", {
      exists: false,
      data: () => ({}),
    }],
  ]);
  const fakeDb = {
    doc: (path) => ({ path }),
    collection: (path) => ({
      path,
      doc: (id = "generated-id") => ({ path: `${path}/${id}`, id }),
    }),
    runTransaction: async (callback) => callback({
      get: async (ref) => gets.get(ref.path) ?? { exists: false, data: () => ({}) },
      set: (ref, data, options) => writes.push({ op: "set", path: ref.path, data, options }),
      create: (ref, data) => writes.push({ op: "create", path: ref.path, data }),
    }),
  };

  firebaseAdmin.adminDb = fakeDb;
  try {
    const result = await settings.updateSettings({
      auth: { uid: "manager-private-isolation", token: { role: "manager", team: "flu", gameId: "global" } },
      data: {
        expectedRevision: 1,
        patch: {
          automation: {
            autoReplyEnabled: true,
            chatAutoCasePermits: {
              interest_next_steps: {
                armed: true,
                evalEvidence: { status: "passed", runId: "caller-forged" },
                counters: { consecutiveHumanUneditedApprovedSent: 999 },
              },
            },
          },
        },
      },
      rawRequest: { ip: "127.0.0.1" },
    });

    assert.equal(result.ok, true);
    assert.deepEqual([...new Set(writes.map((write) => write.path.split("/")[0]))].sort(), [
      "settings",
      "settings_audit_log",
    ]);
    for (const collection of PRIVATE_COLLECTIONS) {
      assert.equal(writes.some((write) => write.path.startsWith(`${collection}/`)), false);
    }
  } finally {
    firebaseAdmin.adminDb = originalAdminDb;
  }
});

test("counter summary gives no arming credit to historical rows missing new Permit evidence", () => {
  const counters = permitStore.summarizeChatAutoPermitCounters([
    completeCommittedEvent({ permitDecisionId: null }),
  ], { pin: COUNTER_PIN });

  assert.equal(counters.consecutiveHumanUneditedApprovedSent, 0);
  assert.equal(counters.totalHumanUneditedApprovedSent, 0);
  assert.equal(counters.unavailableEvidenceCount, 1);
  assert.equal(counters.lastResetReason, "case_unresolved_adverse_event");
});

test("counter summary credits only complete human approved provider-confirmed sends", () => {
  const counters = permitStore.summarizeChatAutoPermitCounters([
    completeCommittedEvent({ sentAtIso: "2026-09-05T00:00:00.000Z" }),
    completeCommittedEvent({ sentAtIso: "2026-09-05T00:01:00.000Z", messageRef: "conversations/conversation-private-isolation/messages/m2" }),
  ], { pin: COUNTER_PIN });

  assert.equal(counters.consecutiveHumanUneditedApprovedSent, 2);
  assert.equal(counters.totalHumanUneditedApprovedSent, 2);
  assert.equal(counters.unavailableEvidenceCount, 0);
  assert.equal(counters.lastEligibleMessageRef, "conversations/conversation-private-isolation/messages/m2");
});

test("Permit intent writer ignores caller collection hints and creates the fixed private intent path", () => {
  const firebaseAdmin = require("../functions/lib/firebaseAdmin.js");
  const originalAdminDb = firebaseAdmin.adminDb;
  const batchCreates = [];
  const fakeDb = {
    collection: (path) => ({
      path,
      doc: (id) => ({ path: `${path}/${id}`, id }),
    }),
  };
  const fakeBatch = {
    create: (ref, data) => batchCreates.push({ ref, data }),
  };

  firebaseAdmin.adminDb = fakeDb;
  try {
    const ref = permitStore.writeChatAutoCaseIntentBatch(fakeBatch, {
      conversationId: "conversation-private-isolation",
      messageSourceId: "source-private-isolation",
      caseId: "interest_next_steps",
      queueRef: "auto_reply_queue/queue-private-isolation",
      nowIso: "2026-09-05T00:00:00.000Z",
      decision: {
        allowed: true,
        caseId: "interest_next_steps",
        intentId: "caller-forged-intent-id",
        pin: permitCore.chatAutoCasePermitPin("gemini-3.1-flash-lite"),
        draft: permitCore.renderChatAutoServerDraft({
          caseId: "interest_next_steps",
          factTokenIds: [],
          linkTokenIds: [],
        }),
      },
      collection: "chat_auto_case_permits",
      path: "chat_auto_case_permits/interest_next_steps",
    });

    assert.match(ref.path, /^auto_reply_case_intents\/(?:conversation-private-isolation__interest_next_steps|aci_[a-f0-9]{40})$/);
    assert.notEqual(ref.path, "chat_auto_case_permits/interest_next_steps");
    assert.equal(batchCreates.length, 1);
    assert.equal(batchCreates[0].ref.path, ref.path);
    assert.equal(batchCreates[0].data.source, "functions.chatAutoCasePermitStore");
    assert.equal(batchCreates[0].data.collection, undefined);
    assert.equal(batchCreates[0].data.path, undefined);
  } finally {
    firebaseAdmin.adminDb = originalAdminDb;
  }
});

test("generic admin writer callables do not accept arbitrary collection or path selectors", () => {
  const writerFunctions = [
    sliceFunction(adminSource, "export async function recordLlmUsage"),
    sliceFunction(adminSource, "export async function createSeedData"),
    sliceFunction(adminSource, "export async function upsertTemplate"),
  ].join("\n");

  assert.doesNotMatch(writerFunctions, /data\.(?:collection|collectionName|collectionPath|path|docPath)\b/);
  assert.match(writerFunctions, /adminDb\.collection\("llm_usage"\)/);
  assert.match(writerFunctions, /adminDb\.collection\("templates"\)/);
  assert.match(writerFunctions, /for \(const \{ collection, docs, idField, seedWrite \} of SEED_COLLECTIONS\)/);
});

test("seed collections omit all Permit private collections", () => {
  const seedCollections = seedSource.match(/export const SEED_COLLECTIONS:[\s\S]*?= \[([\s\S]*?)\];/);
  assert.ok(seedCollections, "SEED_COLLECTIONS must be present");
  for (const collection of PRIVATE_COLLECTIONS) {
    assert.doesNotMatch(seedCollections[1], new RegExp(`collection:\\s*"${collection}"`));
  }
});

test("Firestore client rules have no direct read or write rule for Permit private collections", () => {
  assert.match(firestoreRules, /match \/\{document=\*\*\} \{\s*allow write: if false;/);
  assert.match(stagingRules, /match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
  for (const collection of PRIVATE_COLLECTIONS) {
    assert.doesNotMatch(firestoreRules, new RegExp(`match /${collection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`));
    assert.doesNotMatch(stagingRules, new RegExp(`match /${collection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`));
  }
});
