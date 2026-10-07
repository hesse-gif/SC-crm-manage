#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SOURCE_COLLECTION_PLAN,
  SOURCE_METADATA_FIELDS,
  SOURCE_PROJECT_ID,
  TARGET_COLLECTIONS,
  TARGET_DATABASE,
  TARGET_PROJECT_ID,
  assertCollectionAllowed,
  assertProjectGuard,
  messageSourceId,
  namespacedFluId,
  persistImportRows,
  transformConversationMessage,
  transformFluDocToMixmax,
} from './mixmax-import-flu.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(resolve(root, 'functions/package.json'));
const INVENTORY_DIR = resolve(root, '.mixmax-import');
const PAGE_SIZE = 500;
const TARGET_GET_SIZE = 250;
const WRITE_SIZE = 100;

const str = value => (typeof value === 'string' && value.trim() ? value.trim() : '');

export const FINALIZE_COLLECTIONS = Object.freeze(Object.keys(SOURCE_COLLECTION_PLAN));

export function assertFinalizeGuard(options) {
  assertProjectGuard(options);
  assert.equal(options.sourceProjectId, SOURCE_PROJECT_ID);
  assert.equal(options.targetProjectId, TARGET_PROJECT_ID);
  assert.equal(options.targetDatabase ?? TARGET_DATABASE, TARGET_DATABASE);
}

export function expectedTargetForSourceId(collection, id) {
  assertCollectionAllowed(collection);
  const kind = SOURCE_COLLECTION_PLAN[collection];
  let targetId = namespacedFluId(collection, id);
  if (collection === 'conversations') targetId = namespacedFluId('conversations', id);
  if (collection === 'message_sources') targetId = namespacedFluId('messageRef', `message_sources/${id}`);
  return { targetCollection: TARGET_COLLECTIONS[kind], targetId };
}

export function summarizeCounts(collections) {
  return Object.fromEntries(Object.entries(collections).map(([collection, ids]) => [collection, ids.length]));
}

export function missingSummary(missing) {
  return Object.fromEntries(Object.entries(missing).map(([collection, rows]) => [collection, rows.length]));
}

function inventoryPath(capturedAt) {
  return resolve(INVENTORY_DIR, `finalize-inventory-${capturedAt.replace(/[:.]/g, '-')}.json`);
}

async function saveInventory(inventory) {
  const path = inventoryPath(inventory.capturedAt);
  await mkdir(INVENTORY_DIR, { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, JSON.stringify(inventory), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
  return path;
}

async function loadInventory(path) {
  const inventory = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(inventory.sourceProjectId, SOURCE_PROJECT_ID);
  for (const collection of Object.keys(inventory.collections ?? {})) assertCollectionAllowed(collection);
  return inventory;
}

export async function captureSourceInventory(source, capturedAt = new Date().toISOString()) {
  const { FieldPath } = require('firebase-admin/firestore');
  const collections = {};
  for (const collection of FINALIZE_COLLECTIONS) {
    let cursor = '';
    const ids = [];
    for (;;) {
      let query = source.collection(collection).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.select().get();
      if (page.empty) break;
      ids.push(...page.docs.map(doc => doc.id));
      cursor = page.docs.at(-1).id;
    }
    collections[collection] = ids;
  }
  return { sourceProjectId: SOURCE_PROJECT_ID, capturedAt, captureCompletedAt: new Date().toISOString(), collections };
}

export async function findMissingTargets(target, inventory) {
  const missing = Object.fromEntries(Object.keys(inventory.collections).map(collection => [collection, []]));
  for (const [collection, ids] of Object.entries(inventory.collections)) {
    for (let offset = 0; offset < ids.length; offset += TARGET_GET_SIZE) {
      const group = ids.slice(offset, offset + TARGET_GET_SIZE);
      const expected = group.map(id => ({ id, ...expectedTargetForSourceId(collection, id) }));
      const refs = expected.map(row => target.collection(row.targetCollection).doc(row.targetId));
      const snaps = refs.length ? await target.getAll(...refs, { fieldMask: ['source'] }) : [];
      snaps.forEach((snap, index) => {
        if (!snap.exists) missing[collection].push(expected[index]);
      });
    }
  }
  return missing;
}

async function readMailboxes(source) {
  const snapshot = await source.collection('mail_accounts').select(...SOURCE_METADATA_FIELDS.mail_accounts).get();
  return new Map(snapshot.docs.map(doc => [doc.id, str(doc.data().mailbox)]));
}

async function sourceDocRows(source, collection, missingRows, mailboxes) {
  const rows = [];
  for (const missing of missingRows) {
    const snap = await source.collection(collection).doc(missing.id).get();
    if (!snap.exists) continue;
    const data = snap.data();
    if (collection === 'conversations') data.mailbox ||= mailboxes.get(data.mailAccountId) || '';
    rows.push(transformFluDocToMixmax({ collection, id: snap.id, data }));
  }
  return rows;
}

async function nestedConversationRows(source, conversationIds) {
  const rows = [];
  for (const conversationId of conversationIds) {
    const messages = await source.collection('conversations').doc(conversationId).collection('messages').get();
    for (const message of messages.docs) {
      const data = message.data();
      const sourceId = messageSourceId(data.messageRef);
      if (sourceId) {
        const original = await source.doc(`message_sources/${sourceId}`).get();
        if (original.exists) {
          rows.push(transformFluDocToMixmax({ collection: 'message_sources', id: sourceId, data: { ...original.data(), conversationId } }));
          continue;
        }
      }
      rows.push(transformConversationMessage({ conversationId, messageId: message.id, data }));
    }
  }
  return rows;
}

async function persistRowsInChunks(target, rows, apply, count) {
  for (let offset = 0; offset < rows.length; offset += WRITE_SIZE) {
    await persistImportRows(target, rows.slice(offset, offset + WRITE_SIZE), apply, count);
  }
}

async function createMissingFromInventory({ source, target, missing, apply }) {
  const mailboxes = await readMailboxes(source);
  const totals = {};
  for (const collection of FINALIZE_COLLECTIONS) {
    const count = totals[collection] = { read: missing[collection]?.length ?? 0, created: 0, skipped: 0 };
    const rows = await sourceDocRows(source, collection, missing[collection] ?? [], mailboxes);
    await persistRowsInChunks(target, rows, apply, count);
    if (collection === 'conversations' && missing[collection]?.length) {
      const nested = await nestedConversationRows(source, missing[collection].map(row => row.id));
      await persistRowsInChunks(target, nested, apply, count);
    }
  }
  return totals;
}

export async function runFinalize(options) {
  assertFinalizeGuard(options);
  if (process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Production finalize refuses inherited emulator configuration');
  const { initializeApp, applicationDefault, deleteApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const credential = applicationDefault();
  const sourceApp = initializeApp({ projectId: SOURCE_PROJECT_ID, credential }, 'flu-finalize-readonly');
  const targetApp = initializeApp({ projectId: TARGET_PROJECT_ID, credential }, 'mixmax-finalize');
  const source = getFirestore(sourceApp);
  const target = getFirestore(targetApp, TARGET_DATABASE);
  try {
    const inventory = options.inventoryPath ? await loadInventory(options.inventoryPath) : await captureSourceInventory(source);
    const savedInventoryPath = options.inventoryPath ?? await saveInventory(inventory);
    const missingBefore = await findMissingTargets(target, inventory);
    const created = await createMissingFromInventory({ source, target, missing: missingBefore, apply: options.apply });
    const missingAfter = options.apply ? await findMissingTargets(target, inventory) : missingBefore;
    const result = {
      mode: options.apply ? 'apply' : 'dry-run',
      capturedAt: inventory.capturedAt,
      captureCompletedAt: inventory.captureCompletedAt,
      inventoryPath: savedInventoryPath,
      targetDatabase: TARGET_DATABASE,
      captured: summarizeCounts(inventory.collections),
      missingBefore: missingSummary(missingBefore),
      created,
      missingAfter: missingSummary(missingAfter),
      note: 'Only IDs explicitly captured in this inventory are in scope. Flu remains live; later additions and edits are not continuously mirrored.',
    };
    console.log(JSON.stringify(result));
    if (options.apply && Object.values(missingAfter).some(rows => rows.length)) throw new Error('Captured source IDs remain missing in the target');
    return result;
  } finally {
    await deleteApp(sourceApp);
    await deleteApp(targetApp);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply' && arg !== '--dry-run' && !arg.startsWith('--inventory='))) throw new Error('Use --dry-run or --apply, optionally --inventory=.mixmax-import/finalize-inventory-...');
  const options = {
    apply: args.includes('--apply'),
    inventoryPath: args.find(arg => arg.startsWith('--inventory='))?.slice('--inventory='.length),
    sourceProjectId: SOURCE_PROJECT_ID,
    targetProjectId: TARGET_PROJECT_ID,
    targetDatabase: TARGET_DATABASE,
  };
  runFinalize(options).catch(error => {
    console.error('Finalize failed:', error.code ?? error.message);
    process.exitCode = 1;
  });
}
