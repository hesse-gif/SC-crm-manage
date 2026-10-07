import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const signatureSource = readFileSync(new URL("../functions/mailSignature.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../functions/index.ts", import.meta.url), "utf8");
const dataSource = readFileSync(new URL("../src/lib/data.ts", import.meta.url), "utf8");
const receiptsSource = readFileSync(new URL("../src/app/(app)/chat/receipts/page.tsx", import.meta.url), "utf8");

function functionSlice(source, exportedName, nextExportedName) {
  const startMarker = "export async function " + exportedName;
  const endMarker = "export async function " + nextExportedName;
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, "missing " + startMarker);
  assert.ok(end > start, "missing " + endMarker + " after " + startMarker);
  return source.slice(start, end);
}

test("mail receipt listing is a projection-only read with no memoization or lifecycle enqueue", () => {
  const listSlice = functionSlice(signatureSource, "listMailOutbox", "reconcileMailOutboxReplies");

  assert.doesNotMatch(listSlice, /\.set\s*\(/);
  assert.doesNotMatch(listSlice, /\.update\s*\(/);
  assert.doesNotMatch(listSlice, /\.create\s*\(/);
  assert.doesNotMatch(listSlice, /enqueueScpLifecycleRefreshEvent\s*\(/);
  assert.doesNotMatch(listSlice, /FieldValue\./);
  assert.match(listSlice, /conversationHasReply\s*\(/);
  assert.match(listSlice, /const ledgerHasReply = row\.hasReply === true/);
  assert.match(
    listSlice,
    /hasReplySource:\s*ledgerHasReply\s*\?\s*"ledger"\s*:\s*hasReply\s*\?\s*"live_projection"\s*:\s*"none"/,
  );
});

test("reply memoization is exposed only as an explicit bounded reconcile callable", () => {
  const reconcileSlice = functionSlice(signatureSource, "reconcileMailOutboxReplies", "conversationHasReply");

  assert.match(reconcileSlice, /mail_outbox\.reconcile_replies/);
  assert.match(reconcileSlice, /dryRun/);
  assert.match(reconcileSlice, /actual/);
  assert.match(reconcileSlice, /Math\.min\([^\n]*100/);
  assert.match(reconcileSlice, /hasReply:\s*true/);
  assert.match(reconcileSlice, /enqueueScpLifecycleRefreshEvent\s*\(/);
  assert.match(indexSource, /reconcileMailOutboxReplies as reconcileMailOutboxRepliesHandler/);
  assert.match(indexSource, /export const reconcileMailOutboxReplies = callable\(reconcileMailOutboxRepliesHandler, \["PEOPLY_API_KEY"\]\)/);
  assert.match(dataSource, /"reconcileMailOutboxReplies"/);
  assert.match(dataSource, /export const reconcileMailOutboxReplies/);
});

test("receipts UI separates refresh from a confirmed explicit reconcile action", () => {
  assert.match(receiptsSource, /aria-label="수신확인 새로고침"/);
  assert.match(receiptsSource, /회신 상태 재조정/);
  assert.match(receiptsSource, /reconcileMailOutboxReplies\(\{\s*dryRun:\s*true/);
  assert.match(receiptsSource, /reconcileMailOutboxReplies\(\{\s*dryRun:\s*false,\s*actual:\s*true/);
  assert.match(receiptsSource, /window\.confirm/);
});
