// Casebook inbox — listChatAutoCasebookCaseItems (2026-10-03): node-lane tests for
// functions/chatAutoCasebookCaseItems.ts, the live, bounded, newest-first list behind a casebook card's "대기 중 N건".
// The scanner (scanUnrepliedInboxForScope) and the caller-scope resolver are injected, so everything here is hermetic (no Firestore/Peoply); the real
// classification (classifyPendingRow) and the real canReadConversationRowForScope scope predicate
// run for real. Auth tests use role "super_admin" (which isCallerScpEntitled always grants without
// any lookup) except where entitlement itself is under test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const callableSource = readFileSync(new URL("../functions/chatAutoCasebookCaseItems.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../functions/index.ts", import.meta.url), "utf8");

function runProbe(body, env = {}) {
  const source = `
    const fs = require("node:fs");
    const ts = require("typescript");
    require.extensions[".ts"] = (module, filename) => {
      const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2021,
          esModuleInterop: true,
        },
        fileName: filename,
      }).outputText;
      module._compile(compiled, filename);
    };
    ${body}
  `;
  const result = spawnSync(process.execPath, ["--input-type=commonjs", "--eval", source], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      GCLOUD_PROJECT: "influchat-77db6",
      GOOGLE_CLOUD_PROJECT: "influchat-77db6",
      FIREBASE_CONFIG: JSON.stringify({ projectId: "influchat-77db6" }),
      FLU_RUNTIME_ENV: "production",
      FLU_FIRESTORE_DATABASE: "(default)",
      FLU_FUNCTIONS_CODEBASE: "default",
      FUNCTIONS_EMULATOR: "",
      FIRESTORE_EMULATOR_HOST: "",
      FIREBASE_AUTH_EMULATOR_HOST: "",
      ...env,
    },
  });
  assert.equal(result.status, 0, `probe failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}


// Shared probe prelude: a fake scanner over a fixed dataset honoring the scanner's real contract in
// BOTH directions (resume strictly after (lastInboundAtIso, docId); at most `limit` rows per call;
// autoCaseIds narrowing; nextCursor only when more rows remain) and recording every call.
const PRELUDE = `
  const { listChatAutoCasebookCaseItems, holdReasonLabel } = require("./functions/chatAutoCasebookCaseItems.ts");
  const { deriveChatAutoCasebookPendingTotalsForScope, toCompactRow } = require("./functions/chatAutoCasebookPendingPrecompute.ts");
  const READ_TIME = { seconds: 1790726400, nanoseconds: 0 };
  const POLICY = { disabledOrgIds: [], mailRoutingByOrgId: {} };
  const enc = (docId, orderValue) => Buffer.from(JSON.stringify({ docId, orderValue }), "utf8").toString("base64url");
  // kind: n=never_classified, u=unknown_case, s=stale_stamp, m=managed interest_next_steps, p=managed price_inquiry-like second case,
  //       o=managed out_of_office (no-reply case), c=closed closing_acknowledgment
  const mkRow = (n, kind, extra = {}) => {
    const id = "conv-" + String(n).padStart(3, "0");
    const base = { id, orgId: "T056", mailAccountId: "scp", autoReplyStatus: "waiting_for_human", lastInboundAtIso: "2026-09-30T" + String(Math.floor(n / 60) % 24).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0") + ":00.000Z", creatorName: "Creator " + n, creatorEmail: "creator" + n + "@example.com", lastMessage: "요지 " + n, inboundIntent: { id: "guide_interest", source: "rule" } };
    const stamp = (caseId, fresh) => ({ autoCaseId: caseId, autoCaseMessageRef: "ref-" + n, lastMessageRef: fresh ? "ref-" + n : "ref-newer-" + n });
    if (kind === "n") return { ...base, ...extra };
    if (kind === "u") return { ...base, ...stamp("made_up_case", true), ...extra };
    if (kind === "s") return { ...base, ...stamp("interest_next_steps", false), ...extra };
    if (kind === "m") return { ...base, ...stamp("interest_next_steps", true), ...extra };
    if (kind === "o") return { ...base, ...stamp("out_of_office", true), ...extra };
    if (kind === "c") return { ...base, ...stamp("closing_acknowledgment", true), ...extra };
    throw new Error("bad kind " + kind);
  };
  const cmpKey = (row) => row.lastInboundAtIso + "|" + row.id;
  const makeScan = (dataset, calls, opts = {}) => async (input) => {
    calls.push(input);
    if (opts.failNarrowed && input.autoCaseIds) throw Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index."), { code: 9 });
    const dir = input.direction === "desc" ? -1 : 1;
    const all = [...dataset].sort((a, b) => dir * cmpKey(a).localeCompare(cmpKey(b)));
    let start = 0;
    if (input.cursor) {
      const cur = input.cursor.orderValue + "|" + input.cursor.docId;
      start = all.findIndex((row) => dir * cmpKey(row).localeCompare(cur) > 0);
      if (start === -1) start = all.length;
    }
    const remaining = all.slice(start)
      .filter((row) => input.registrationGate(row))
      .filter((row) => !input.autoCaseIds || input.autoCaseIds.includes(row.autoCaseId));
    const rows = remaining.slice(0, input.limit);
    const more = remaining.length > rows.length;
    const last = rows[rows.length - 1];
    return { rows, total: rows.length, truncated: more, nextCursor: more && last ? enc(last.id, last.lastInboundAtIso) : null, readTime: READ_TIME, policy: POLICY };
  };
  const fixedClock = () => { let t = 0; return () => t; };
  const superAdminAccess = { viewerOrgId: null, authorizedMailAccountIds: ["scp"], isSuperAdmin: true, hasScpEntitlement: true };
  const resolveSuperAdmin = async () => ({ scopeKey: "super_admin", access: superAdminAccess });
  const call = (data, deps, role) => listChatAutoCasebookCaseItems({ auth: { uid: "u1", token: { role: role ?? "super_admin", team: "platform", email: "operator@example.test" } }, rawRequest: { ip: "127.0.0.1" }, data }, { now: () => new Date("2026-10-03T00:00:00.000Z"), nowMs: fixedClock(), resolveAccess: resolveSuperAdmin, ...deps });
`;

// ── wiring ───────────────────────────────────────────────────────────────────────────────────────

test("wiring: entitlement gated once, registered like the unclassified list (named function expression, PEOPLY_API_KEY, not viewAs-allowlisted), staging-listed", () => {
  assert.equal((callableSource.match(/assertScpEntitled\(/g) ?? []).length, 1, "entitlement must be checked exactly once");
  assert.ok(callableSource.indexOf("assertScpEntitled(auth, request, ACTION)") > 0);
  assert.match(callableSource, /const ACTION = "chat_auto_casebook_case_items\.list";/);
  assert.match(
    indexSource,
    /export const listChatAutoCasebookCaseItems = callable\(\s*function listChatAutoCasebookCaseItems\(request\)\s*\{\s*return listChatAutoCasebookCaseItemsHandler\(request\);\s*\},\s*\["PEOPLY_API_KEY"\],\s*\);/,
  );
  const stagingRuntime = readFileSync(new URL("../functions-staging/runtime/index.cjs", import.meta.url), "utf8");
  assert.equal((stagingRuntime.match(/"listChatAutoCasebookCaseItems"/g) ?? []).length, 2, "listed with the oauth-read AND the peoply-read staging sets, like the unclassified list");
  const dataSource = readFileSync(new URL("../src/lib/data.ts", import.meta.url), "utf8");
  assert.match(dataSource, /"listChatAutoCasebookCaseItems",/);
  assert.doesNotMatch(dataSource, /listChatAutoCasebookCaseItems[^;]*viewAs/);
  const result = runProbe(`
    const { assertViewAsReadOnlyPayload } = require("./functions/viewAsWriteGuard.ts");
    let outcome = "no-throw";
    try { assertViewAsReadOnlyPayload("listChatAutoCasebookCaseItems", { viewAsUserId: "u", viewAsEmail: "e@x.test" }); }
    catch (error) { outcome = error.errorCode; }
    process.stdout.write(JSON.stringify({ outcome }));
  `);
  assert.equal(result.outcome, "view_as_write_forbidden", "must NOT be on VIEW_AS_READ_ALLOWLIST");
});

test("newest-first scans need DESCENDING composites: both the plain and the autoCaseId-narrowed shape are in the manifest with exact directions", () => {
  const indexes = JSON.parse(readFileSync(new URL("../firestore.indexes.json", import.meta.url), "utf8")).indexes;
  const shape = (entry) => entry.fields.map((field) => `${field.fieldPath}:${field.order}`).join(",");
  const conversations = new Set(indexes.filter((entry) => entry.collectionGroup === "conversations" && entry.queryScope === "COLLECTION").map(shape));
  assert.ok(conversations.has("lastMessageFrom:ASCENDING,autoReplyStatus:ASCENDING,lastInboundAtIso:DESCENDING,__name__:DESCENDING"));
  assert.ok(conversations.has("lastMessageFrom:ASCENDING,autoReplyStatus:ASCENDING,autoCaseId:ASCENDING,lastInboundAtIso:DESCENDING,__name__:DESCENDING"));
  // The scan orders lastInboundAtIso and the document id in the SAME direction as the callable asks for.
  const readSource = readFileSync(new URL("../functions/read.ts", import.meta.url), "utf8");
  assert.match(readSource, /\.orderBy\("lastInboundAtIso", scanDirection\)\s*\.orderBy\(FieldPath\.documentId\(\), scanDirection\)/);
});

// ── auth ─────────────────────────────────────────────────────────────────────────────────────────

test("blocks guests and unauthenticated callers before any scan", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const attempts = [];
      for (const request of [
        { rawRequest: { ip: "127.0.0.1" }, data: { caseId: "unclassified" } },
        { auth: { uid: "u1", token: { role: "guest" } }, rawRequest: { ip: "127.0.0.1" }, data: { caseId: "unclassified" } },
      ]) {
        attempts.push(await listChatAutoCasebookCaseItems(request, { scan: makeScan([], calls), resolveAccess: resolveSuperAdmin }).then(
          () => ({ ok: true }),
          (error) => ({ ok: false, code: error.code, result: error.behaviorLog?.result }),
        ));
      }
      process.stdout.write(JSON.stringify({ attempts, scans: calls.length }));
    })();
  `);
  assert.equal(result.attempts[0].code, "unauthenticated");
  assert.equal(result.attempts[1].code, "permission-denied");
  for (const attempt of result.attempts) assert.equal(attempt.result, "denied");
  assert.equal(result.scans, 0);
});

test("rejects any viewAsUserId/viewAsEmail payload loudly, before entitlement resolution or any scan", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const attempts = [];
      for (const data of [{ caseId: "unclassified", viewAsUserId: "target-uid" }, { caseId: "unclassified", viewAsEmail: "target@supercent.io" }]) {
        attempts.push(await call(data, { scan: makeScan([], calls) }, "viewer").then(
          () => ({ ok: true }),
          (error) => ({ ok: false, code: error.code, errorCode: error.errorCode, result: error.behaviorLog?.result }),
        ));
      }
      process.stdout.write(JSON.stringify({ attempts, scans: calls.length }));
    })();
  `);
  for (const attempt of result.attempts) {
    assert.equal(attempt.code, "permission-denied");
    assert.equal(attempt.errorCode, "chat_auto_casebook_case_items_view_as_unsupported");
    assert.equal(attempt.result, "denied");
  }
  assert.equal(result.scans, 0);
});

test("a non-entitled caller is denied by assertScpEntitled and no scan or scope resolution runs", () => {
  const result = runProbe(`
    const Module = require("node:module");
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (parent && String(parent.filename).endsWith("chatAutoCasebookCaseItems.ts") && request === "./mailAccounts") {
        return {
          assertScpEntitled: async (auth, req, action) => {
            throw Object.assign(new Error("permission-denied: scp entitlement required"), { code: "permission-denied", errorCode: "scp_entitlement_required", action });
          },
        };
      }
      return originalLoad.apply(this, arguments);
    };
    ${PRELUDE}
    (async () => {
      const calls = [];
      let resolved = 0;
      const outcome = await call({ caseId: "unclassified" }, { scan: makeScan([], calls), resolveAccess: async () => { resolved += 1; return resolveSuperAdmin(); } }, "viewer").then(
        () => ({ ok: true }),
        (error) => ({ ok: false, errorCode: error.errorCode, action: error.action }),
      );
      process.stdout.write(JSON.stringify({ outcome, scans: calls.length, resolved }));
    })();
  `);
  assert.equal(result.outcome.errorCode, "scp_entitlement_required");
  assert.equal(result.outcome.action, "chat_auto_casebook_case_items.list");
  assert.equal(result.scans, 0);
  assert.equal(result.resolved, 0);
});

// ── params ───────────────────────────────────────────────────────────────────────────────────────

test("caseId is validated against the canonical case list plus the two buckets; a malformed cursor is invalid-argument", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const outcome = async (data) => call(data, { scan: makeScan([], calls) }).then((e) => ({ ok: true, caseId: e.caseId }), (e) => ({ ok: false, code: e.code, errorCode: e.errorCode }));
      const bad = [await outcome({}), await outcome({ caseId: "" }), await outcome({ caseId: "made_up_case" }), await outcome({ caseId: 7 }), await outcome({ caseId: "interest_next_steps", cursor: "not-a-cursor" })];
      const scansAfterBad = calls.length;
      const good = [await outcome({ caseId: "interest_next_steps" }), await outcome({ caseId: "unclassified" }), await outcome({ caseId: "no_reply_needed" }), await outcome({ caseId: "closing_acknowledgment" })];
      process.stdout.write(JSON.stringify({ bad, scansAfterBad, good }));
    })();
  `);
  for (const attempt of result.bad) {
    assert.equal(attempt.ok, false);
    assert.equal(attempt.code, "invalid-argument");
    assert.equal(attempt.errorCode, "chat_auto_casebook_case_items_invalid_argument");
  }
  assert.equal(result.scansAfterBad, 0, "validation happens before any scan");
  assert.deepEqual(result.good.map((entry) => entry.caseId), ["interest_next_steps", "unclassified", "no_reply_needed", "closing_acknowledgment"]);
});

test("limit is applied to the returned rows: default 25, clamped to 50, floor 1", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const dataset = Array.from({ length: 80 }, (_, i) => mkRow(i + 1, "m"));
      const out = {};
      for (const [key, limit] of [["default", undefined], ["zero", 0], ["one", 1], ["huge", 500], ["frac", 7.9]]) {
        const envelope = await call({ caseId: "interest_next_steps", ...(limit === undefined ? {} : { limit }) }, { scan: makeScan(dataset, []) });
        out[key] = { n: envelope.rows.length, exhausted: envelope.exhausted, hasCursor: Boolean(envelope.nextCursor) };
      }
      process.stdout.write(JSON.stringify(out));
    })();
  `);
  assert.equal(result.default.n, 25);
  assert.equal(result.zero.n, 25);
  assert.equal(result.one.n, 1);
  assert.equal(result.huge.n, 50);
  assert.equal(result.frac.n, 7);
  for (const entry of Object.values(result)) assert.equal(entry.exhausted, false);
});

// ── order, narrowing, parity ─────────────────────────────────────────────────────────────────────

test("newest first: scans in desc direction, narrows the Firestore query to the case id, and returns rows by lastInboundAtIso desc", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const dataset = [mkRow(5, "m"), mkRow(9, "m"), mkRow(2, "m"), mkRow(7, "o"), mkRow(3, "n"), mkRow(8, "s")];
      const envelope = await call({ caseId: "interest_next_steps" }, { scan: makeScan(dataset, calls) });
      const un = [];
      const c2 = [];
      await call({ caseId: "unclassified" }, { scan: makeScan(dataset, c2) });
      const nr = [];
      await call({ caseId: "no_reply_needed" }, { scan: makeScan(dataset, nr) });
      process.stdout.write(JSON.stringify({ ids: envelope.rows.map((r) => r.conversationId), exhausted: envelope.exhausted, direction: calls[0].direction, narrow: calls[0].autoCaseIds, unNarrow: c2[0].autoCaseIds ?? null, nrNarrow: nr[0].autoCaseIds }));
    })();
  `);
  assert.deepEqual(result.ids, ["conv-009", "conv-005", "conv-002"], "managed rows of that case only (stale stamp / other case / unclassified excluded), newest first");
  assert.equal(result.exhausted, true);
  assert.equal(result.direction, "desc");
  assert.deepEqual(result.narrow, ["interest_next_steps"]);
  assert.equal(result.unNarrow, null, "unclassified includes rows with no autoCaseId, which a Firestore filter could never match");
  assert.deepEqual([...result.nrNarrow].sort(), ["closing_acknowledgment", "out_of_office"]);
});

test("PARITY: each bucket's list length equals the precompute's count over the same rows (managed per case, unclassified, closed, 답장 불필요 overlay)", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      let n = 0;
      const dataset = [];
      const add = (kind, count) => { for (let i = 0; i < count; i += 1) { n += 1; dataset.push(mkRow(n, kind)); } };
      add("m", 7); add("o", 4); add("c", 3); add("n", 5); add("u", 2); add("s", 3);
      // Not part of the pending set at all: counterpartyRegistered===false rows are hidden by the shared gate.
      n += 1; dataset.push(mkRow(n, "m", { counterpartyRegistered: false }));
      // Another org's rows must not be counted for an org-scoped caller — here the caller is super_admin so they are.
      const totals = deriveChatAutoCasebookPendingTotalsForScope(dataset.filter((row) => row.counterpartyRegistered !== false).map(toCompactRow), superAdminAccess, false);
      const list = async (caseId) => {
        const rows = [];
        let cursor;
        for (let guard = 0; guard < 20; guard += 1) {
          const e = await call({ caseId, limit: 4, ...(cursor ? { cursor } : {}) }, { scan: makeScan(dataset, []) });
          rows.push(...e.rows);
          if (e.exhausted || !e.nextCursor) break;
          cursor = e.nextCursor;
        }
        return rows;
      };
      const interest = await list("interest_next_steps");
      const ooo = await list("out_of_office");
      const closing = await list("closing_acknowledgment");
      const unclassified = await list("unclassified");
      const noReply = await list("no_reply_needed");
      process.stdout.write(JSON.stringify({
        expected: { interest: totals.byCaseId.get("interest_next_steps"), ooo: totals.byCaseId.get("out_of_office"), closed: totals.breakdown.closedCaseCount, unclassified: totals.unclassifiedCount },
        actual: { interest: interest.length, ooo: ooo.length, closing: closing.length, unclassified: unclassified.length, noReply: noReply.length },
        buckets: { closing: [...new Set(closing.map((r) => r.bucket))], interest: [...new Set(interest.map((r) => r.bucket))], unclassified: [...new Set(unclassified.map((r) => r.bucket))] },
        unique: new Set(unclassified.map((r) => r.conversationId)).size,
      }));
    })();
  `);
  assert.deepEqual(result.expected, { interest: 7, ooo: 4, closed: 3, unclassified: 10 });
  assert.equal(result.actual.interest, result.expected.interest);
  assert.equal(result.actual.ooo, result.expected.ooo);
  assert.equal(result.actual.closing, result.expected.closed);
  assert.equal(result.actual.unclassified, result.expected.unclassified);
  assert.equal(result.actual.noReply, result.expected.ooo + result.expected.closed, "답장 불필요 = 부재중 managed + 종결 closed, the same overlay the snapshot builds");
  assert.deepEqual(result.buckets.closing, ["closed"]);
  assert.deepEqual(result.buckets.interest, ["managed"]);
  assert.deepEqual(result.buckets.unclassified, ["unclassified"]);
  assert.equal(result.unique, result.expected.unclassified, "every row exactly once across pages");
});

test("cursor: pages resume newest-first without gaps or repeats, mid-page and across scanner pages, ending exhausted", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const dataset = Array.from({ length: 130 }, (_, i) => mkRow(i + 1, i % 2 === 0 ? "m" : "s"));
      const seen = [];
      const pages = [];
      let cursor;
      for (let guard = 0; guard < 30; guard += 1) {
        const e = await call({ caseId: "interest_next_steps", limit: 10, ...(cursor ? { cursor } : {}) }, { scan: makeScan(dataset, []) });
        pages.push(e.rows.length);
        seen.push(...e.rows.map((r) => r.conversationId));
        if (e.exhausted) break;
        cursor = e.nextCursor;
      }
      const expected = dataset.filter((r) => r.autoCaseId === "interest_next_steps" && r.autoCaseMessageRef === r.lastMessageRef)
        .sort((a, b) => (b.lastInboundAtIso + b.id).localeCompare(a.lastInboundAtIso + a.id)).map((r) => r.id);
      process.stdout.write(JSON.stringify({ seen, expected, pages }));
    })();
  `);
  assert.equal(result.expected.length, 65);
  assert.deepEqual(result.seen, result.expected);
  assert.equal(result.pages.at(-1) > 0 || result.pages.length > 1, true);
});

test("a bounded scan that is cut short hands back a resumable cursor and never claims exhausted", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      // 400 unclassified rows, none in the 답장 불필요 bucket; the index is "not built" so the scan is un-narrowed
      // and must page through them — capped at 2 scanner calls it has to stop early with a cursor.
      const dataset = Array.from({ length: 400 }, (_, i) => mkRow(i + 1, "n"));
      const calls = [];
      const e = await call({ caseId: "no_reply_needed", limit: 5 }, { scan: makeScan(dataset, calls, { failNarrowed: true }), maxScanCalls: 2 });
      const resumed = await call({ caseId: "no_reply_needed", limit: 5, cursor: e.nextCursor }, { scan: makeScan(dataset, [], { failNarrowed: true }), maxScanCalls: 2 });
      process.stdout.write(JSON.stringify({ n: e.rows.length, exhausted: e.exhausted, cursor: Boolean(e.nextCursor), plainCalls: calls.filter((c) => !c.autoCaseIds).length, resumedCursorDiffers: resumed.nextCursor !== e.nextCursor }));
    })();
  `);
  assert.equal(result.n, 0);
  assert.equal(result.exhausted, false);
  assert.equal(result.cursor, true);
  assert.equal(result.plainCalls, 2, "bounded by the call budget");
  assert.equal(result.resumedCursorDiffers, true, "the resumed request continues further down the queue");
});

test("when the narrowed query's composite index is not built yet, the scan falls back to the un-narrowed one with the same result", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const dataset = [mkRow(1, "m"), mkRow(2, "o"), mkRow(3, "m")];
      const e = await call({ caseId: "interest_next_steps" }, { scan: makeScan(dataset, calls, { failNarrowed: true }) });
      process.stdout.write(JSON.stringify({ ids: e.rows.map((r) => r.conversationId), narrowedFlags: calls.map((c) => Boolean(c.autoCaseIds)) }));
    })();
  `);
  assert.deepEqual(result.ids, ["conv-003", "conv-001"]);
  assert.deepEqual(result.narrowedFlags, [true, false]);
});

test("a non-index scan failure is NOT swallowed", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const outcome = await call({ caseId: "interest_next_steps" }, { scan: async () => { throw Object.assign(new Error("boom"), { code: 13 }); } }).then(() => "ok", (e) => e.message);
      process.stdout.write(JSON.stringify({ outcome }));
    })();
  `);
  assert.equal(result.outcome, "boom");
});

// ── projection (SEC-P0-009) ──────────────────────────────────────────────────────────────────────

test("projects only the contract fields: masked email, bounded summaryKr, NO bodies/subjects/drafts/refs", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const row = mkRow(1, "m", {
        creatorHandle: "jane_doe",
        creatorEmail: "Jane.Doe@Example.com",
        programTitle: "Snake Clash",
        lastMessage: "가" .repeat(500),
        autoReplyDraftText: "SECRET DRAFT",
        humanDraftSuggestion: "SECRET SUGGESTION",
        messages: [{ id: "m1", text: "SECRET MESSAGE TEXT", body: "SECRET BODY" }],
        subject: "SECRET SUBJECT",
        body: "SECRET RAW BODY",
        prompt: "SECRET PROMPT",
        autoReplyStatus: "draft_only",
      });
      const envelope = await call({ caseId: "interest_next_steps" }, { scan: makeScan([row], []) });
      process.stdout.write(JSON.stringify(envelope));
    })();
  `);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(Object.keys(result.rows[0]).sort(), [
    "bucket", "caseId", "conversationId", "creatorEmailMasked", "creatorHandle", "creatorName", "holdReasonLabel",
    "inboundIntent", "inboundIntentLabel", "lastInboundAtIso", "programLabel", "replyState", "summaryKr", "unclassifiedReason",
  ]);
  const item = result.rows[0];
  assert.equal(item.creatorEmailMasked, "J***@Example.com");
  assert.equal(item.creatorHandle, "jane_doe");
  assert.equal(item.programLabel, "Snake Clash");
  assert.equal(item.summaryKr.length, 200, "summaryKr is bounded to 200 chars");
  assert.equal(item.inboundIntent, "guide_interest");
  assert.equal(item.inboundIntentLabel, "가이드 관심");
  assert.equal(item.replyState, "queued");
  assert.equal(item.holdReasonLabel, null);
  assert.equal(item.caseId, "interest_next_steps");
  assert.equal(item.bucket, "managed");
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /SECRET/);
  assert.doesNotMatch(serialized, /Jane\.Doe/i);
  assert.doesNotMatch(serialized, /ref-1|ref-newer/);
  assert.equal(result.ok, true);
  assert.equal(result.caseId, "interest_next_steps");
  assert.equal(result.behaviorLog.action, "chat_auto_casebook_case_items.list");
  assert.equal(result.behaviorLog.result, "success");
});

test("hold reasons map gate reason text and codes to short Korean labels; unmapped free text becomes a generic label (never echoed)", () => {
  const result = runProbe(`
    ${PRELUDE}
    const cases = [
      "creator evidence is below admin review threshold (0/80, 0/2 signals)",
      "agency, management, manager, or representative replies require human review",
      "specific budget, rate, payment, or reward terms require human review",
      "currency, amount, or near-guide budget term requires human review",
      "contract, signature, usage-rights, exclusivity, revision, or cancellation terms require human review",
      "call, meeting, phone, calendar, or availability requests require human review because Flu collaboration is email-only",
      "gratitude-only reply without explicit commitment, request, or question — pilot policy routes to human review",
      "counter_offer_guideline_reply requires an actual JEV consultation before it can auto-send",
      "press, media, or partnership/agency outreach requires human review",
      "counterparty_not_registered",
      "duplicate_case_intent",
      "confidential_launch_2027",
      "identity_mismatch",
      "The creator said: please ping me at jane@example.com about my 500 followers",
      "x".repeat(200),
      "",
      undefined,
    ];
    process.stdout.write(JSON.stringify(cases.map((c) => holdReasonLabel(c))));
  `);
  assert.deepEqual(result.slice(0, 11), [
    "증거 부족(0/80)", "에이전시·매니저 회신", "금액·단가 언급", "금액·단가 언급", "계약·권리 조건", "통화·미팅 요청", "감사 인사만", "JEV 보류", "언론·제휴 문의", "미등록 상대", "중복 문의",
  ]);
  assert.equal(result[11], "기타 보류 사유", "an unknown snake_case string is not trusted as a code");
  assert.equal(result[12], "발신 주소 불일치", "known identity codes are mapped");
  assert.equal(result[13], "기타 보류 사유", "free model text never crosses the boundary");
  assert.equal(result[14], "기타 보류 사유");
  assert.equal(result[15], null);
  assert.equal(result[16], null);
  assert.doesNotMatch(JSON.stringify(result), /confidential_launch/);
  assert.doesNotMatch(JSON.stringify(result), /jane@example|500 followers/);
});

test("status: waiting_for_human or a recorded reason = 보류 (held) with the short reason; draft_only without a reason = 자동답장 대기 (queued)", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const dataset = [
        mkRow(1, "m", { autoReplyStatus: "waiting_for_human", autoReplyBlockedReason: "creator evidence is below admin review threshold (3/80, 1/2 signals)" }),
        mkRow(2, "m", { autoReplyStatus: "draft_only" }),
        mkRow(3, "m", { autoReplyStatus: "waiting_for_human" }),
        mkRow(4, "m", { autoReplyStatus: "draft_only", autoReplyBlockedReason: "specific budget, rate, payment, or reward terms require human review", inboundIntent: { id: "weird" } }),
      ];
      const e = await call({ caseId: "interest_next_steps" }, { scan: makeScan(dataset, []) });
      process.stdout.write(JSON.stringify(e.rows.map((r) => [r.conversationId, r.replyState, r.holdReasonLabel, r.inboundIntent])));
    })();
  `);
  assert.deepEqual(result, [
    ["conv-004", "held", "금액·단가 언급", null],
    ["conv-003", "held", null, "guide_interest"],
    ["conv-002", "queued", null, "guide_interest"],
    ["conv-001", "held", "증거 부족(3/80)", "guide_interest"],
  ]);
});

// ── scope ────────────────────────────────────────────────────────────────────────────────────────

test("scope isolation: an org caller is scanned with its OWN scope and never sees another org's rows (even if the scanner returned them)", () => {
  const result = runProbe(`
    const Module = require("node:module");
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (parent && String(parent.filename).endsWith("chatAutoCasebookCaseItems.ts") && request === "./mailAccounts") {
        return { assertScpEntitled: async () => {} };
      }
      return originalLoad.apply(this, arguments);
    };
    ${PRELUDE}
    (async () => {
      const calls = [];
      const orgAccess = { viewerOrgId: "T056", authorizedMailAccountIds: ["scp"], isSuperAdmin: false, hasScpEntitlement: true };
      const dataset = [mkRow(1, "m", { orgId: "T056" }), mkRow(2, "m", { orgId: "T046" }), mkRow(3, "m", { orgId: "T056" })];
      const envelope = await call({ caseId: "interest_next_steps" }, { scan: makeScan(dataset, calls), resolveAccess: async () => ({ scopeKey: "org:T056", access: orgAccess }) }, "manager");
      process.stdout.write(JSON.stringify({ ids: envelope.rows.map((row) => row.conversationId), access: calls[0].access, mailAccountId: calls[0].mailAccountId, gateOk: calls[0].registrationGate({ counterpartyRegistered: false }) }));
    })();
  `);
  assert.deepEqual(result.ids, ["conv-003", "conv-001"]);
  assert.equal(result.access.isSuperAdmin, false);
  assert.equal(result.mailAccountId, "scp");
  assert.equal(result.gateOk, false, "counterpartyRegistered===false rows stay hidden, same gate as the precompute");
});

test("uses the precompute's scan contract: scp mailbox, fail-closed policy, one fixed readTime/policy across calls", () => {
  const result = runProbe(`
    ${PRELUDE}
    (async () => {
      const calls = [];
      const dataset = Array.from({ length: 120 }, (_, i) => mkRow(i + 1, "n"));
      await call({ caseId: "unclassified", limit: 120 }, { scan: makeScan(dataset, calls) }).catch(() => null);
      process.stdout.write(JSON.stringify({ n: calls.length, modes: [...new Set(calls.map((c) => c.policyFailureMode))], firstHasReadTime: Boolean(calls[0].readTime), laterReadTimes: calls.slice(1).map((c) => c.readTime), laterPolicies: calls.slice(1).map((c) => Boolean(c.policy)), account: calls[0].mailAccountId }));
    })();
  `);
  assert.equal(result.account, "scp");
  assert.deepEqual(result.modes, ["fail_closed"]);
  assert.equal(result.firstHasReadTime, false);
  for (const readTime of result.laterReadTimes) assert.deepEqual(readTime, { seconds: 1790726400, nanoseconds: 0 });
  for (const hasPolicy of result.laterPolicies) assert.equal(hasPolicy, true);
});
