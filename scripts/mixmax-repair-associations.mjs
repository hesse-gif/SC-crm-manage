import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { SOURCE_PROJECT_ID, TARGET_PROJECT_ID, TARGET_DATABASE, SOURCE_METADATA_FIELDS, messageSourceId, namespacedFluId, transformConversationMessage, transformFluDocToMixmax, persistImportRows, rowForExistingMessage } from './mixmax-import-flu.mjs';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const apply = process.argv.includes('--apply');
assert.ok(process.argv.slice(2).every(arg => ['--apply', '--dry-run'].includes(arg)));
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, undefined);
const recovery = JSON.parse(await readFile(new URL('../.mixmax-import/association-recovery.json', import.meta.url), 'utf8'));
assert.equal(recovery.sourceProjectId, SOURCE_PROJECT_ID);
assert.equal(recovery.targetProjectId, TARGET_PROJECT_ID);
assert.equal(recovery.targetDatabase, TARGET_DATABASE);
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const a = initializeApp({projectId: SOURCE_PROJECT_ID}, 'association-source-readonly');
const b = initializeApp({projectId: TARGET_PROJECT_ID}, 'association-target');
const source = getFirestore(a); const target = getFirestore(b, TARGET_DATABASE);
const counts = {checked: 0, created: 0, skipped: 0, missingAfter: 0};
try {
  const mailboxes = new Map((await source.collection('mail_accounts').select(...SOURCE_METADATA_FIELDS.mail_accounts).get()).docs.map(doc => [doc.id, doc.data().mailbox || '']));
  for (const item of recovery.rows) {
    const match = /^conversations\/([^/]+)\/messages\/([^/]+)$/.exec(item.sourcePath);
    assert.ok(match, 'Unexpected source path');
    const [, conversationId, messageId] = match;
    const threadId = namespacedFluId('conversations', conversationId);
    assert.equal(threadId, item.expectedThreadId);
    const message = await source.doc(item.sourcePath).get();
    assert.ok(message.exists, 'Captured source message disappeared');
    if (!(await target.doc(`mixmax_threads/${threadId}`).get()).exists) {
      const conversation = await source.doc(`conversations/${conversationId}`).get();
      assert.ok(conversation.exists, 'Source conversation is unavailable');
      const data = conversation.data(); data.mailbox ||= mailboxes.get(data.mailAccountId) || '';
      await persistImportRows(target, [transformFluDocToMixmax({collection: 'conversations', id: conversationId, data})], apply, counts);
    }
    let projected = transformConversationMessage({conversationId, messageId, data: message.data()});
    const sourceId = messageSourceId(message.data().messageRef);
    if (sourceId) {
      const original = await source.doc(`message_sources/${sourceId}`).get();
      if (original.exists) projected = transformFluDocToMixmax({collection: 'message_sources', id: sourceId, data: {...original.data(), conversationId}});
    }
    assert.equal(projected.targetId, item.canonicalId, 'Audit and importer disagree on message identity');
    await persistImportRows(target, [projected], apply, counts);
    if (apply) {
      const canonical = (await target.doc(`mixmax_messages/${projected.targetId}`).get()).data();
      const expected = rowForExistingMessage(canonical, projected);
      const result = (await target.doc(`mixmax_messages/${expected.targetId}`).get()).data();
      if (result?.threadId !== threadId) counts.missingAfter++;
    }
    counts.checked++;
  }
  console.log(JSON.stringify({mode: apply ? 'apply' : 'dry-run', ...counts}));
  assert.equal(counts.missingAfter, 0, 'Captured associations remain missing');
} finally { await Promise.all([deleteApp(a), deleteApp(b)]); }
