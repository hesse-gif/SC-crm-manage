import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
if (process.env.GCLOUD_PROJECT !== 'demo-mixmax' || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) throw new Error('Sync test requires the local demo-mixmax emulator');
process.env.MIXMAX_GOOGLE_CLIENT_ID = 'emulator-client';
process.env.MIXMAX_GOOGLE_CLIENT_SECRET = 'emulator-secret';
const require = createRequire(resolve('functions/package.json'));
const { db } = require(resolve('.mixmax-functions/lib/common.js'));
const { syncMailbox } = require(resolve('.mixmax-functions/lib/gmail.js'));
const { threadDocId, messageDocId } = require(resolve('.mixmax-functions/lib/gmail-core.js'));
const id = 'sync-regression-account';
const ref = db.doc(`mixmax_connections/${id}`);
await ref.set({ workspaceId: 'sync-regression', ownerUid: 'sync-regression', email: 'qa@example.com', status: 'connected', historyId: '100' });
await db.doc(`mixmax_credentials/${id}`).set({ refreshToken: 'emulator-token' });
let fail = false;
let cursor = '101';
let historyRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async input => {
  const url = new URL(String(input));
  const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') return response({ access_token: 'local-only-token' });
  if (url.origin !== 'https://gmail.googleapis.com') throw new Error('Unexpected external request in sync test');
  if (url.pathname.endsWith('/history')) { historyRequests++; return response({ history: [{ messagesAdded: [{ message: { id: 'message-one', threadId: 'thread-one' } }] }], historyId: cursor }); }
  if (url.pathname.endsWith('/messages/message-one')) return response({ id: 'message-one', threadId: 'thread-one' });
  if (url.pathname.endsWith('/threads/thread-one')) {
    if (fail) return new Response('{}', { status: 503 });
    return response({ messages: [{ id: 'message-one', threadId: 'thread-one', labelIds: ['INBOX', 'UNREAD'], internalDate: '1791324000000', payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'creator@example.com' }, { name: 'To', value: 'qa@example.com' }, { name: 'Subject', value: 'Cursor regression' }], body: { data: Buffer.from('Persist me before advancing the cursor').toString('base64url') } } }] });
  }
  throw new Error(`Unmocked Gmail path: ${url.pathname}`);
};
try {
  await syncMailbox(id);
  assert.equal((await ref.get()).data().historyId, '101');
  assert.equal((await db.doc(`mixmax_messages/${messageDocId(id, 'message-one')}`).get()).data().text, 'Persist me before advancing the cursor');
  assert.equal((await db.doc(`mixmax_threads/${threadDocId(id, 'thread-one')}`).get()).data().unread, true);
  cursor = '102'; fail = true;
  await assert.rejects(syncMailbox(id), /Gmail sync failed/);
  assert.equal((await ref.get()).data().historyId, '101', 'failed projection must not advance history');
  assert.equal((await db.doc(`mixmax_sync_leases/${id}`).get()).exists, false, 'failure must release mailbox lease');
  fail = false;
  await syncMailbox(id);
  assert.equal((await ref.get()).data().historyId, '102');
  assert.equal((await db.collection('mixmax_messages').where('threadId','==',threadDocId(id,'thread-one')).get()).size, 1, 'retry must be idempotent');
  assert.equal(historyRequests, 3);
  console.log('Sync integration passed: durable cursor, retry recovery, idempotent projection, lease cleanup; all Gmail HTTP responses mocked.');
} finally {
  globalThis.fetch = originalFetch;
  await Promise.all([ref.delete(), db.doc(`mixmax_credentials/${id}`).delete(), db.doc(`mixmax_threads/${threadDocId(id, 'thread-one')}`).delete(), db.doc(`mixmax_messages/${messageDocId(id, 'message-one')}`).delete()]);
  await db.terminate();
}
