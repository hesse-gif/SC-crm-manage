#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SOURCE_PROJECT_ID,
  TARGET_COLLECTIONS,
  TARGET_DATABASE,
  TARGET_PROJECT_ID,
  assertProjectGuard,
  namespacedFluId,
  rowForExistingMessage,
  transformFluDocToMixmax,
} from './mixmax-import-flu.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(resolve(root, 'functions/package.json'));
const BACKUP_COLLECTION = 'mixmax_import_backups';
const CHECKPOINT_FILE = resolve(root, '.mixmax-import', 'reconcile-messages-v1.json');
const PAGE_SIZE = 100;
const NATIVE_EDIT_FIELDS = new Set(['updatedAt', 'editedAt', 'nativeEditAt', 'nativeEditedAt', 'nativeEditedBy', 'userEditedAt', 'editorUid']);

const stableHash = value => createHash('sha256').update(value).digest('hex').slice(0, 40);
const present = value => value !== undefined && value !== null && value !== '';

export const canonicalMessageTargetId = sourceId => namespacedFluId('messageRef', `message_sources/${sourceId}`);
export const legacyShortMessageTargetId = sourceId => namespacedFluId('messageRef', sourceId);

export function assertReconcileGuard(options) {
  assertProjectGuard(options);
  assert.equal(options.sourceProjectId, SOURCE_PROJECT_ID);
  assert.equal(options.targetProjectId, TARGET_PROJECT_ID);
  assert.equal(options.targetDatabase ?? TARGET_DATABASE, TARGET_DATABASE);
}

export function hasNativeEdit(data = {}) {
  return [...NATIVE_EDIT_FIELDS].some(field => present(data[field]));
}

export function isExpectedFluMessageSource(data = {}, sourceId) {
  return data.source === 'flu'
    && data.sourceSystem === 'flu'
    && data.sourceMetadata?.collection === 'message_sources'
    && data.sourceMetadata?.id === sourceId
    && data.sourceMetadata?.projectId === SOURCE_PROJECT_ID;
}

export function canMutateImportedMessage(data = {}, sourceId) {
  if (!data || data.source !== 'flu' || data.sourceSystem !== 'flu' || hasNativeEdit(data)) return false;
  const metadata = data.sourceMetadata ?? {};
  if (metadata.collection === 'message_sources') return metadata.id === sourceId && metadata.projectId === SOURCE_PROJECT_ID;
  if (metadata.collection === 'conversations.messages') return metadata.projectId === SOURCE_PROJECT_ID;
  return false;
}

export function mailHeaderPatch(source = {}) {
  const sourceHeaders = source.headers ?? source.mailHeaders ?? source.parsedHeaders;
  const headers = {};
  if (sourceHeaders && typeof sourceHeaders === 'object' && !Array.isArray(sourceHeaders)) {
    for (const [key, value] of Object.entries(sourceHeaders)) {
      const normalized = key.toLowerCase();
      if (!['message-id', 'in-reply-to', 'references', 'date', 'from', 'to', 'cc', 'reply-to'].includes(normalized)) continue;
      if (typeof value === 'string' && value.trim()) headers[normalized] = value.slice(0, 4000);
      if (Array.isArray(value)) headers[normalized] = value.filter(item => typeof item === 'string' && item.trim()).slice(0, 25);
    }
  }
  for (const [target, keys] of Object.entries({ messageId: ['messageId', 'messageID'], inReplyTo: ['inReplyTo'], references: ['references'] })) {
    const value = keys.map(key => source[key]).find(item => typeof item === 'string' && item.trim());
    if (value) headers[target] = value.slice(0, 4000);
  }
  return Object.keys(headers).length ? { headers } : {};
}

function projectedSourceRow(sourceId, sourceData, threadId) {
  const row = transformFluDocToMixmax({ collection: 'message_sources', id: sourceId, data: sourceData });
  return {
    ...row,
    data: {
      ...row.data,
      ...mailHeaderPatch(sourceData),
      threadId: threadId || row.data.threadId || '',
    },
  };
}

function patchForExisting(existingData, row) {
  return {
    ...row.data,
    threadId: existingData?.threadId || row.data.threadId || '',
  };
}

function backupIdForLegacy(sourceId, legacyTargetId) {
  return `message_source_legacy_${stableHash(`${sourceId}\0${legacyTargetId}`)}`;
}

function maybeUpsertMessage(operations, { targetId, existingData, row, createOnly = false }) {
  if (existingData) {
    if (!createOnly && canMutateImportedMessage(existingData, row.data.sourceMetadata.id)) {
      operations.push({ type: 'patch-message', targetId, data: patchForExisting(existingData, row) });
    } else {
      operations.push({ type: 'skip-message-native-or-unrelated', targetId });
    }
    return;
  }
  operations.push({ type: 'create-message', targetId, data: row.data });
}

function preserveThreadAssociation(operations, { canonicalData, aliasData, sourceId, sourceData, threadId }) {
  if (!threadId || canonicalData?.threadId === threadId) return;
  const row = projectedSourceRow(sourceId, sourceData, threadId);
  const alias = rowForExistingMessage(canonicalData, row);
  if (alias.targetId === canonicalMessageTargetId(sourceId)) return;
  maybeUpsertMessage(operations, { targetId: alias.targetId, existingData: aliasData, row: alias });
}

export function buildMessageReconcilePlan({ sourceId, sourceData = {}, canonicalData, legacyData, aliasDataByThreadId = {}, nowIso = new Date().toISOString() }) {
  const canonicalId = canonicalMessageTargetId(sourceId);
  const legacyId = legacyShortMessageTargetId(sourceId);
  const operations = [];
  const canonicalRow = projectedSourceRow(sourceId, sourceData, canonicalData?.threadId || legacyData?.threadId);

  maybeUpsertMessage(operations, { targetId: canonicalId, existingData: canonicalData, row: canonicalRow });
  const associationThreads = new Set([sourceData.conversationId ? namespacedFluId('conversations', sourceData.conversationId) : '', legacyData?.threadId].filter(Boolean));
  for (const threadId of associationThreads) {
    preserveThreadAssociation(operations, {
      canonicalData: canonicalData ?? canonicalRow.data,
      aliasData: aliasDataByThreadId[threadId],
      sourceId,
      sourceData,
      threadId,
    });
  }

  if (legacyData) {
    if (isExpectedFluMessageSource(legacyData, sourceId) && !hasNativeEdit(legacyData)) {
      operations.push({
        type: 'backup-and-delete-legacy',
        targetId: legacyId,
        backupId: backupIdForLegacy(sourceId, legacyId),
        backupData: {
          source: 'mixmax_import_reconcile',
          reason: 'legacy-short-message-ref-duplicate',
          targetCollection: TARGET_COLLECTIONS.messages,
          targetId: legacyId,
          sourceMetadata: legacyData.sourceMetadata,
          backedUpAt: nowIso,
          data: legacyData,
        },
      });
    } else {
      operations.push({ type: 'skip-legacy-native-or-unrelated', targetId: legacyId });
    }
  }

  return { canonicalId, legacyId, operations };
}

function countPlan(count, plan) {
  count.read += 1;
  for (const operation of plan.operations) {
    if (operation.type === 'create-message') count.created += 1;
    if (operation.type === 'patch-message') count.patched += 1;
    if (operation.type === 'backup-and-delete-legacy') count.removedLegacy += 1;
    if (operation.type.startsWith('skip')) count.skipped += 1;
  }
}

async function readCheckpoint(apply) {
  if (!apply) return {};
  try {
    return JSON.parse(await readFile(CHECKPOINT_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeCheckpoint(checkpoint) {
  await mkdir(dirname(CHECKPOINT_FILE), { recursive: true, mode: 0o700 });
  await writeFile(`${CHECKPOINT_FILE}.tmp`, JSON.stringify(checkpoint), { mode: 0o600 });
  await rename(`${CHECKPOINT_FILE}.tmp`, CHECKPOINT_FILE);
}

async function buildPlansFromPage(target, sourceDocs, reader) {
  const refs = [];
  for (const sourceDoc of sourceDocs) {
    refs.push(target.collection(TARGET_COLLECTIONS.messages).doc(canonicalMessageTargetId(sourceDoc.id)));
    refs.push(target.collection(TARGET_COLLECTIONS.messages).doc(legacyShortMessageTargetId(sourceDoc.id)));
  }
  const snaps = refs.length ? await reader.getAll(...refs) : [];
  const items = sourceDocs.map((sourceDoc, index) => ({
    sourceId: sourceDoc.id,
    sourceData: sourceDoc.data(),
    canonicalData: snaps[index * 2]?.exists ? snaps[index * 2].data() : undefined,
    legacyData: snaps[index * 2 + 1]?.exists ? snaps[index * 2 + 1].data() : undefined,
    aliasDataByThreadId: {},
  }));

  const aliasCandidates = [];
  const aliasRefs = [];
  const seenAliasRefs = new Set();
  for (const item of items) {
    const canonicalBase = item.canonicalData ?? projectedSourceRow(item.sourceId, item.sourceData, item.legacyData?.threadId).data;
    const candidateThreads = new Set([item.sourceData.conversationId ? namespacedFluId('conversations', item.sourceData.conversationId) : '', item.legacyData?.threadId].filter(Boolean));
    for (const threadId of candidateThreads) {
      if (canonicalBase.threadId === threadId) continue;
      const row = projectedSourceRow(item.sourceId, item.sourceData, threadId);
      const alias = rowForExistingMessage(canonicalBase, row);
      if (alias.targetId === canonicalMessageTargetId(item.sourceId)) continue;
      const ref = target.collection(TARGET_COLLECTIONS.messages).doc(alias.targetId);
      aliasCandidates.push({ item, threadId, targetId: alias.targetId });
      if (!seenAliasRefs.has(ref.path)) {
        seenAliasRefs.add(ref.path);
        aliasRefs.push(ref);
      }
    }
  }

  if (aliasRefs.length) {
    const aliasSnaps = await reader.getAll(...aliasRefs);
    const aliasByTargetId = new Map(aliasRefs.map((ref, index) => [ref.id, aliasSnaps[index]?.exists ? aliasSnaps[index].data() : undefined]));
    for (const candidate of aliasCandidates) {
      candidate.item.aliasDataByThreadId[candidate.threadId] = aliasByTargetId.get(candidate.targetId);
    }
  }

  return items.map(item => buildMessageReconcilePlan(item));
}

export function applyPlan(target, transaction, plan) {
  for (const operation of plan.operations) {
    if (operation.type === 'create-message') {
      transaction.create(target.collection(TARGET_COLLECTIONS.messages).doc(operation.targetId), operation.data);
    } else if (operation.type === 'patch-message') {
      transaction.set(target.collection(TARGET_COLLECTIONS.messages).doc(operation.targetId), operation.data, { merge: true });
    } else if (operation.type === 'backup-and-delete-legacy') {
      transaction.set(target.collection(BACKUP_COLLECTION).doc(operation.backupId), operation.backupData);
      transaction.delete(target.collection(TARGET_COLLECTIONS.messages).doc(operation.targetId));
    }
  }
}

export async function runReconcile(options) {
  assertReconcileGuard(options);
  if (process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Production reconcile refuses inherited emulator configuration');
  const { initializeApp, applicationDefault, deleteApp } = require('firebase-admin/app');
  const { getFirestore, FieldPath } = require('firebase-admin/firestore');
  const credential = applicationDefault();
  const sourceApp = initializeApp({ projectId: SOURCE_PROJECT_ID, credential }, 'flu-reconcile-readonly');
  const targetApp = initializeApp({ projectId: TARGET_PROJECT_ID, credential }, 'mixmax-reconcile');
  const source = getFirestore(sourceApp);
  const target = getFirestore(targetApp, TARGET_DATABASE);
  const checkpoint = await readCheckpoint(options.apply);
  const count = { read: 0, created: 0, patched: 0, removedLegacy: 0, skipped: 0 };
  let cursor = checkpoint.message_sources || '';
  let pageCount = 0;
  try {
    for (;;) {
      let query = source.collection('message_sources').orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      if (options.apply) {
        const committedPlans = await target.runTransaction(async transaction => {
          const plans = await buildPlansFromPage(target, page.docs, transaction);
          for (const plan of plans) {
            applyPlan(target, transaction, plan);
          }
          return plans;
        });
        for (const plan of committedPlans) countPlan(count, plan);
      } else {
        const plans = await buildPlansFromPage(target, page.docs, target);
        for (const plan of plans) {
          countPlan(count, plan);
        }
      }
      cursor = page.docs.at(-1).id;
      if (options.apply) {
        checkpoint.message_sources = cursor;
        await writeCheckpoint(checkpoint);
      }
      console.log(JSON.stringify({ collection: 'message_sources', ...count, mode: options.apply ? 'apply' : 'dry-run' }));
      if (options.maxPages && ++pageCount >= options.maxPages) break;
    }
    return count;
  } finally {
    await deleteApp(sourceApp);
    await deleteApp(targetApp);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply' && arg !== '--dry-run' && !/^--max-pages=[1-9]\d*$/.test(arg))) throw new Error('Use --dry-run or --apply, optionally --max-pages=N');
  const options = { apply: args.includes('--apply'), sourceProjectId: SOURCE_PROJECT_ID, targetProjectId: TARGET_PROJECT_ID, targetDatabase: TARGET_DATABASE, maxPages: Number(args.find(arg => arg.startsWith('--max-pages='))?.split('=')[1]) || undefined };
  runReconcile(options)
    .then(count => console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', targetDatabase: TARGET_DATABASE, count })))
    .catch(error => {
      console.error('Reconcile failed:', error.code ?? error.message);
      process.exitCode = 1;
    });
}
