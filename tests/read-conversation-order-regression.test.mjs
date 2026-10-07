import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readSource = readFileSync(new URL("../functions/read.ts", import.meta.url), "utf8");
const indexesSource = readFileSync(new URL("../firestore.indexes.json", import.meta.url), "utf8");

test("conversation pages are queried by last message time, not row update time", () => {
  assert.match(readSource, /if \(key === "conversations"\) return \{ field: "lastMessageAtIso", direction: "desc" \}/);
  assert.doesNotMatch(
    readSource,
    /key === "conversations"[\s\S]{0,160}return \{ field: "updatedAtIso", direction: "desc" \}/,
  );
});

test("ordered dataset reads degrade to document order while composite indexes build", () => {
  assert.match(readSource, /function shouldRetryQueryWithoutCompositeIndex\(error: unknown, order: CollectionOrder\)/);
  assert.doesNotMatch(readSource, /shouldRetryOwnerQueryWithoutCompositeIndex|if \(!ownerUid \|\| !order\.field\)/);
  assert.match(
    readSource,
    /let fallbackQuery: Query = adminDb\.collection\(name\);[\s\S]{0,520}fallbackQuery = fallbackQuery\.orderBy\(FieldPath\.documentId\(\)\)/,
  );
});

test("Firestore indexes support latest-message conversation pagination", () => {
  const indexes = JSON.parse(indexesSource);
  const conversationIndexes = indexes.indexes.filter((index) => index.collectionGroup === "conversations");
  assert.ok(conversationIndexes.some((index) => JSON.stringify(index.fields) === JSON.stringify([
    { fieldPath: "lastMessageAtIso", order: "DESCENDING" },
    { fieldPath: "__name__", order: "ASCENDING" },
  ])));
  assert.ok(conversationIndexes.some((index) => JSON.stringify(index.fields) === JSON.stringify([
    { fieldPath: "ownerUid", order: "ASCENDING" },
    { fieldPath: "lastMessageAtIso", order: "DESCENDING" },
    { fieldPath: "__name__", order: "ASCENDING" },
  ])));
});

test("campaign dataset reads newest rows first so route filters survive bulk seeds", () => {
  assert.match(readSource, /key === "campaigns" \|\|[\s\S]{0,520}return \{ field: "updatedAtIso", direction: "desc" \}/);
});

test("Firestore indexes support latest campaign pagination", () => {
  const indexes = JSON.parse(indexesSource);
  const campaignIndexes = indexes.indexes.filter((index) => index.collectionGroup === "campaigns");
  assert.ok(campaignIndexes.some((index) => JSON.stringify(index.fields) === JSON.stringify([
    { fieldPath: "updatedAtIso", order: "DESCENDING" },
    { fieldPath: "__name__", order: "ASCENDING" },
  ])));
  assert.ok(campaignIndexes.some((index) => JSON.stringify(index.fields) === JSON.stringify([
    { fieldPath: "ownerUid", order: "ASCENDING" },
    { fieldPath: "updatedAtIso", order: "DESCENDING" },
    { fieldPath: "__name__", order: "ASCENDING" },
  ])));
});

test("Firestore indexes support SCP lifecycle profile pagination", () => {
  const indexes = JSON.parse(indexesSource);
  const profileIndexes = indexes.indexes.filter((index) => index.collectionGroup === "scp_lifecycle_profiles");
  assert.ok(profileIndexes.some((index) => JSON.stringify(index.fields) === JSON.stringify([
    { fieldPath: "stateEnteredAt", order: "DESCENDING" },
    { fieldPath: "__name__", order: "ASCENDING" },
  ])));
  assert.ok(profileIndexes.some((index) => JSON.stringify(index.fields) === JSON.stringify([
    { fieldPath: "currentState", order: "ASCENDING" },
    { fieldPath: "stateEnteredAt", order: "DESCENDING" },
    { fieldPath: "__name__", order: "ASCENDING" },
  ])));
});
