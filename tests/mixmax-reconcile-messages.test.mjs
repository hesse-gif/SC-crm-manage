import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertReconcileGuard,
  buildMessageReconcilePlan,
  canonicalMessageTargetId,
  hasNativeEdit,
  isExpectedFluMessageSource,
  legacyShortMessageTargetId,
  mailHeaderPatch,
} from '../scripts/mixmax-reconcile-messages.mjs';
import { SOURCE_PROJECT_ID, TARGET_PROJECT_ID, namespacedFluId } from '../scripts/mixmax-import-flu.mjs';

const fluMessage = sourceId => ({
  workspaceId: 'primary',
  source: 'flu',
  sourceSystem: 'flu',
  sourceMetadata: { collection: 'message_sources', id: sourceId, projectId: SOURCE_PROJECT_ID },
  threadId: namespacedFluId('conversations', 'legacy-thread'),
  text: 'short body',
});

test('reconcile guards stay pinned to Flu source and Mixmax target database', () => {
  assert.doesNotThrow(() => assertReconcileGuard({ sourceProjectId: SOURCE_PROJECT_ID, targetProjectId: TARGET_PROJECT_ID, targetDatabase: 'mixmax', apply: false }));
  assert.throws(() => assertReconcileGuard({ sourceProjectId: TARGET_PROJECT_ID, targetProjectId: TARGET_PROJECT_ID, targetDatabase: 'mixmax', apply: false }));
  assert.throws(() => assertReconcileGuard({ sourceProjectId: SOURCE_PROJECT_ID, targetProjectId: SOURCE_PROJECT_ID, targetDatabase: 'mixmax', apply: false }));
  assert.throws(() => assertReconcileGuard({ sourceProjectId: SOURCE_PROJECT_ID, targetProjectId: TARGET_PROJECT_ID, targetDatabase: '(default)', apply: false }));
});

test('legacy short duplicate is backed up and deleted only after canonical association is present', () => {
  const sourceId = 'mail-1';
  const canonicalThread = namespacedFluId('conversations', 'canonical-thread');
  const legacyThread = namespacedFluId('conversations', 'legacy-thread');
  const plan = buildMessageReconcilePlan({
    sourceId,
    sourceData: { conversationId: 'source-thread', body: 'full body', headers: { 'Message-ID': '<m1>', Received: 'private-hop' } },
    canonicalData: { ...fluMessage(sourceId), sourceMetadata: { collection: 'conversations.messages', id: 'c/m', projectId: SOURCE_PROJECT_ID }, threadId: canonicalThread, text: 'preview' },
    legacyData: { ...fluMessage(sourceId), threadId: legacyThread },
    aliasDataByThreadId: {},
    nowIso: '2026-10-07T00:00:00.000Z',
  });
  assert.equal(plan.canonicalId, canonicalMessageTargetId(sourceId));
  assert.equal(plan.legacyId, legacyShortMessageTargetId(sourceId));
  assert(plan.operations.some(operation => operation.type === 'patch-message' && operation.targetId === canonicalMessageTargetId(sourceId)));
  assert(plan.operations.some(operation => operation.type === 'create-message' && operation.data.threadId === legacyThread));
  const removal = plan.operations.find(operation => operation.type === 'backup-and-delete-legacy');
  assert(removal);
  assert.equal(removal.backupData.data.text, 'short body');
  const canonicalPatch = plan.operations.find(operation => operation.type === 'patch-message' && operation.targetId === canonicalMessageTargetId(sourceId));
  assert.equal(canonicalPatch.data.threadId, canonicalThread);
  assert.equal(canonicalPatch.data.text, 'full body');
  assert.deepEqual(canonicalPatch.data.headers, { 'message-id': '<m1>' });
});

test('native edits and unrelated legacy documents are never overwritten or deleted', () => {
  const sourceId = 'mail-2';
  assert.equal(hasNativeEdit({ updatedAt: '2026-10-07T00:00:00.000Z' }), true);
  assert.equal(isExpectedFluMessageSource(fluMessage(sourceId), sourceId), true);
  assert.equal(isExpectedFluMessageSource({ ...fluMessage(sourceId), sourceMetadata: { collection: 'message_sources', id: 'other', projectId: SOURCE_PROJECT_ID } }, sourceId), false);
  const plan = buildMessageReconcilePlan({
    sourceId,
    sourceData: { body: 'source body' },
    canonicalData: { ...fluMessage(sourceId), updatedAt: '2026-10-07T00:00:00.000Z', text: 'human edit' },
    legacyData: { ...fluMessage(sourceId), updatedAt: '2026-10-07T00:00:00.000Z' },
  });
  assert(plan.operations.some(operation => operation.type === 'skip-message-native-or-unrelated' && operation.targetId === canonicalMessageTargetId(sourceId)));
  assert(plan.operations.some(operation => operation.type === 'skip-legacy-native-or-unrelated'));
  assert(!plan.operations.some(operation => operation.type === 'backup-and-delete-legacy'));
});

test('dry-run planning creates the same operation list without checkpoint or write side effects', () => {
  const sourceId = 'mail-3';
  const plan = buildMessageReconcilePlan({ sourceId, sourceData: { conversationId: 'c', body: 'full' }, canonicalData: undefined, legacyData: fluMessage(sourceId) });
  assert(plan.operations.some(operation => operation.type === 'create-message' && operation.targetId === canonicalMessageTargetId(sourceId)));
  assert(plan.operations.some(operation => operation.type === 'backup-and-delete-legacy'));
});

test('mail header patch keeps only useful message headers', () => {
  assert.deepEqual(mailHeaderPatch({ headers: { 'Message-ID': '<m>', 'DKIM-Signature': 'secret', To: ['a@example.com'] }, inReplyTo: '<parent>' }), {
    headers: { 'message-id': '<m>', to: ['a@example.com'], inReplyTo: '<parent>' },
  });
});
