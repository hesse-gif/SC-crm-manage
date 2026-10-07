import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FINALIZE_COLLECTIONS,
  assertFinalizeGuard,
  expectedTargetForSourceId,
  missingSummary,
  summarizeCounts,
} from '../scripts/mixmax-finalize-import.mjs';
import { SOURCE_COLLECTION_PLAN, SOURCE_PROJECT_ID, TARGET_COLLECTIONS, TARGET_PROJECT_ID, namespacedFluId } from '../scripts/mixmax-import-flu.mjs';

test('finalize guards are pinned to Flu source and Mixmax named database', () => {
  assert.doesNotThrow(() => assertFinalizeGuard({ sourceProjectId: SOURCE_PROJECT_ID, targetProjectId: TARGET_PROJECT_ID, targetDatabase: 'mixmax', apply: false }));
  assert.throws(() => assertFinalizeGuard({ sourceProjectId: TARGET_PROJECT_ID, targetProjectId: TARGET_PROJECT_ID, targetDatabase: 'mixmax', apply: false }));
  assert.throws(() => assertFinalizeGuard({ sourceProjectId: SOURCE_PROJECT_ID, targetProjectId: SOURCE_PROJECT_ID, targetDatabase: 'mixmax', apply: false }));
  assert.throws(() => assertFinalizeGuard({ sourceProjectId: SOURCE_PROJECT_ID, targetProjectId: TARGET_PROJECT_ID, targetDatabase: '(default)', apply: false }));
});

test('finalize captures every import-plan collection deterministically', () => {
  assert.deepEqual(FINALIZE_COLLECTIONS, Object.keys(SOURCE_COLLECTION_PLAN));
  assert(FINALIZE_COLLECTIONS.includes('message_sources'));
});

test('expected target IDs match importer canonical IDs without reading source bodies', () => {
  assert.deepEqual(expectedTargetForSourceId('conversations', 'c1'), {
    targetCollection: TARGET_COLLECTIONS.threads,
    targetId: namespacedFluId('conversations', 'c1'),
  });
  assert.deepEqual(expectedTargetForSourceId('message_sources', 'm1'), {
    targetCollection: TARGET_COLLECTIONS.messages,
    targetId: namespacedFluId('messageRef', 'message_sources/m1'),
  });
  assert.deepEqual(expectedTargetForSourceId('templates', 't1'), {
    targetCollection: TARGET_COLLECTIONS.templates,
    targetId: namespacedFluId('templates', 't1'),
  });
});

test('count summaries expose only aggregate counts', () => {
  assert.deepEqual(summarizeCounts({ conversations: ['secret-id-1', 'secret-id-2'], message_sources: ['secret-id-3'] }), {
    conversations: 2,
    message_sources: 1,
  });
  assert.deepEqual(missingSummary({ conversations: [{ id: 'hidden' }], message_sources: [] }), {
    conversations: 1,
    message_sources: 0,
  });
});
