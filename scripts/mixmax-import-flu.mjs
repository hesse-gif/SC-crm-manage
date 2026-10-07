#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_PROJECT_ID = 'influchat-77db6';
export const TARGET_PROJECT_ID = 'influencer-crm-296ca';
export const TARGET_DATABASE = 'mixmax';
export const WORKSPACE_ID = 'primary';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const SOURCE_METADATA_FIELDS = Object.freeze({ mail_accounts: ['accountId', 'mailbox'] });
const require = createRequire(resolve(root, 'functions/package.json'));
export const TARGET_COLLECTIONS = Object.freeze({ threads: 'mixmax_threads', messages: 'mixmax_messages', contacts: 'mixmax_contacts', templates: 'mixmax_templates', cases: 'mixmax_cases', drafts: 'mixmax_drafts', sequences: 'mixmax_sequences', sends: 'mixmax_sends' });
export const FORBIDDEN_SOURCE_COLLECTIONS = new Set(['settings', 'mail_oauth_credentials', 'mail_oauth_states', 'mail_accounts', 'secrets', 'tokens', 'integrations', 'auth', 'service_accounts']);
export const SOURCE_COLLECTION_PLAN = Object.freeze({ conversations: 'threads', message_sources: 'messages', creators: 'contacts', templates: 'templates', scp_mail_templates: 'templates', auto_reply_queue: 'drafts', chat_auto_casebook_proposal_outbox: 'drafts', auto_reply_case_intents: 'cases', chat_auto_case_permits: 'cases', programs: 'cases', campaigns: 'cases', mail_outbound_log: 'sends' });
const str = (...values) => values.find(value => typeof value === 'string' && value.trim())?.trim() ?? '';
const iso = (...values) => { for (let value of values) { if (value?.toDate) value = value.toDate(); if (value instanceof Date) value = value.toISOString(); if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString(); } return '1970-01-01T00:00:00.000Z'; };
const emails = value => [...new Set(String(Array.isArray(value) ? value.join(',') : value ?? '').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [])];
const hash = value => createHash('sha256').update(value).digest('hex');
export const namespacedFluId = (...parts) => `flu_${hash(JSON.stringify(parts)).slice(0, 40)}`;
export function messageSourceId(value) {
  if (typeof value !== 'string') return '';
  const id = value.startsWith('message_sources/') ? value.slice('message_sources/'.length) : value;
  return id && !id.includes('/') ? id : '';
}
const secretKey = key => /(?:token|password|secret|credential|privatekey|serviceaccount|apikey)/i.test(key.replace(/[^a-z0-9]/gi, ''));
export function sanitizeForImport(value) {
  if (Array.isArray(value)) return value.map(sanitizeForImport);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, secretKey(key) ? '[redacted-by-mixmax-import]' : sanitizeForImport(val)]));
  return value;
}
export function assertProjectGuard({ sourceProjectId, targetProjectId, apply, targetDatabase = TARGET_DATABASE }) {
  assert.equal(sourceProjectId, SOURCE_PROJECT_ID, `source project must be ${SOURCE_PROJECT_ID}`);
  assert.equal(targetProjectId, TARGET_PROJECT_ID, `target project must be ${TARGET_PROJECT_ID}`);
  assert.equal(targetDatabase, TARGET_DATABASE, 'Target must use the isolated mixmax database');
  assert.equal(typeof apply, 'boolean');
}
export function assertCollectionAllowed(collection) {
  if (FORBIDDEN_SOURCE_COLLECTIONS.has(collection) || secretKey(collection)) throw new Error(`Refusing to import forbidden source collection: ${collection}`);
  if (!SOURCE_COLLECTION_PLAN[collection]) throw new Error(`Source collection is not in the Mixmax import whitelist: ${collection}`);
}
function base(collection, id, nowIso) {
  return { workspaceId: WORKSPACE_ID, source: 'flu', sourceSystem: 'flu', sourceMetadata: { collection, id, projectId: SOURCE_PROJECT_ID }, importedAt: nowIso };
}
export function transformFluDocToMixmax({ collection, id, data = {}, nowIso = new Date().toISOString() }) {
  assertCollectionAllowed(collection);
  const kind = SOURCE_COLLECTION_PLAN[collection];
  const common = base(collection, id, nowIso);
  let projected;
  let targetId = namespacedFluId(collection, id);
  if (kind === 'threads') {
    targetId = namespacedFluId('conversations', id);
    projected = { ...common, contactId: namespacedFluId('creators', str(data.creatorId)), subject: str(data.subject, data.title, data.creatorName, data.creatorEmail, 'Imported conversation'), snippet: str(data.lastMessage, data.bodyPreview), mailbox: str(data.mailbox, data.accountMailbox), participantEmails: emails([data.creatorEmail, data.email, data.mailbox, data.accountMailbox]), lastMessageAt: iso(data.lastMessageAtIso, data.updatedAtIso, data.createdAtIso), unread: Number(data.unread) > 0, archived: Boolean(data.archivedAt || data.deletedAt), aiDraft: str(data.humanDraftSuggestion), aiState: str(data.autoReplyStatus), programId: str(data.programId), campaignId: str(data.campaignId), fluMailAccountId: str(data.mailAccountId) };
  } else if (kind === 'messages') {
    const conversationId = str(data.conversationId, data.threadId);
    targetId = namespacedFluId('messageRef', `message_sources/${id}`);
    projected = { ...common, threadId: conversationId ? namespacedFluId('conversations', conversationId) : '', from: str(data.from, data.fromEmail), to: emails(data.to || data.recipient), subject: str(data.subject), text: str(data.text, data.body, data.bodyText, data.bodyPreview, data.summaryKr).slice(0, 180000), html: '', direction: data.direction === 'outbound' ? 'outbound' : 'inbound', sentAt: iso(data.mailEventAtIso, data.sentAtIso, data.receivedAtIso, data.createdAtIso), mailbox: str(data.accountMailbox, data.mailbox) };
  } else if (kind === 'contacts') {
    projected = { ...common, name: str(data.name, data.creatorName, data.channelTitle, id), email: str(data.email, data.creatorEmail), handle: str(data.handle), platform: str(data.platform), followers: Number(data.followers || data.subscribers || 0), tags: Array.isArray(data.tags) ? data.tags.filter(tag => typeof tag === 'string').slice(0, 40) : [] };
  } else if (kind === 'templates') {
    projected = { ...common, name: str(data.name, data.title, data.caseId, id), subject: str(data.subject, data.subjectTemplate), body: str(data.body, data.text, data.replyText, data.bodyText, data.plainText).slice(0, 100000), category: str(data.category, collection), updatedAt: iso(data.updatedAtIso, data.updatedAt) };
  } else if (kind === 'drafts') {
    projected = { ...common, name: str(data.name, id), threadId: data.conversationId ? namespacedFluId('conversations', data.conversationId) : '', subject: str(data.subject), body: str(data.body, data.text, data.replyBody, data.draftText).slice(0, 100000), status: 'needs_review', originalStatus: str(data.status), updatedAt: iso(data.updatedAtIso, data.createdAtIso), ownerUid: '' };
  } else if (kind === 'sends') {
    projected = { ...common, ownerUid: '', threadId: data.conversationId ? namespacedFluId('conversations', data.conversationId) : '', to: emails(data.to || data.creatorEmail).join(', '), subject: str(data.subject), body: str(data.body, data.text, data.bodyText).slice(0, 100000), status: str(data.deliveryState, data.status, 'imported'), originalStatus: str(data.deliveryState, data.status), createdAt: iso(data.createdAtIso, data.sentAtIso, data.updatedAtIso), sentAt: iso(data.sentAtIso), importedReceipt: true, automaticRetryBlocked: true };
  } else {
    projected = { ...common, name: str(data.name, data.title, data.caseId, id), description: str(data.description, data.reason, data.summary).slice(0, 30000), body: str(data.replyText, data.body, data.text).slice(0, 80000), caseType: collection, originalStatus: str(data.status), automaticSendingEnabled: false };
  }
  return { targetCollection: TARGET_COLLECTIONS[kind], targetId, data: projected };
}
export function transformConversationMessage({ conversationId, messageId, data = {}, nowIso = new Date().toISOString() }) {
  const sourceId = messageSourceId(data.messageRef);
  return { targetCollection: TARGET_COLLECTIONS.messages, targetId: sourceId ? namespacedFluId('messageRef', `message_sources/${sourceId}`) : namespacedFluId('conversationMessage', conversationId, messageId), data: { ...base('conversations.messages', `${conversationId}/${messageId}`, nowIso), threadId: namespacedFluId('conversations', conversationId), from: str(data.author, data.fromEmail, data.from), to: emails(data.to), subject: str(data.subject), text: str(data.body, data.text, data.bodyText, data.bodyPreview, data.summaryKr).slice(0, 180000), html: '', direction: data.from === 'creator' ? 'inbound' : 'outbound', sentAt: iso(data.mailEventAtIso, data.sentAtIso, data.receivedAtIso, data.createdAtIso), mailbox: str(data.accountMailbox, data.mailbox) } };
}
export const targetWriteForExisting = (existing, projected) => existing ? { action: 'skip' } : { action: 'create', data: projected.data };
export function rowForExistingMessage(existing, row) {
  // A source message can appear in more than one conversation. Keep both thread
  // associations, without overwriting a previously imported or edited message.
  if (row.targetCollection === TARGET_COLLECTIONS.messages && existing?.threadId && row.data.threadId && existing.threadId !== row.data.threadId) {
    return { ...row, targetId: namespacedFluId('threadMessage', row.targetId, row.data.threadId) };
  }
  return row;
}
export async function persistImportRows(target, rows, apply, count) {
  const unique = [...new Map(rows.map(row => [`${row.targetCollection}/${row.targetId}/${row.data.threadId ?? ''}`, row])).values()];
  for (let i = 0; i < unique.length; i += 100) {
    const group = unique.slice(i, i + 100);
    const commit = async reader => {
      const existing = await reader.getAll(...group.map(row => target.doc(`${row.targetCollection}/${row.targetId}`)));
      const selected = group.map((row, index) => rowForExistingMessage(existing[index].data(), row));
      const refs = selected.map(row => target.doc(`${row.targetCollection}/${row.targetId}`));
      const final = await reader.getAll(...refs);
      let created = 0; let skipped = 0;
      const scheduled = new Set();
      selected.forEach((row, index) => {
        if (final[index].exists || scheduled.has(refs[index].path)) { skipped++; return; }
        scheduled.add(refs[index].path);
        if (apply) reader.create(refs[index], row.data);
        created++;
      });
      return { created, skipped };
    };
    // The existence read and create must be atomic: nested conversation pages can
    // reference the same canonical message concurrently. Firestore retries races.
    const result = apply ? await target.runTransaction(commit) : await commit(target);
    count.created += result.created; count.skipped += result.skipped;
  }
}
export function shouldCheckpoint(apply) { return apply === true; }
export async function runImport(options) {
  assertProjectGuard(options);
  if (process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Production import refuses inherited emulator configuration');
  const collections = options.collections ?? Object.keys(SOURCE_COLLECTION_PLAN);
  collections.forEach(assertCollectionAllowed);
  const { initializeApp, applicationDefault, deleteApp } = require('firebase-admin/app');
  const { getFirestore, FieldPath } = require('firebase-admin/firestore');
  const credential = applicationDefault();
  const sourceApp = initializeApp({ projectId: SOURCE_PROJECT_ID, credential }, 'flu-readonly');
  const targetApp = initializeApp({ projectId: TARGET_PROJECT_ID, credential }, 'mixmax-import');
  const source = getFirestore(sourceApp);
  const target = getFirestore(targetApp, TARGET_DATABASE);
  const checkpointDir = resolve(root, '.mixmax-import');
  const checkpointFile = resolve(checkpointDir, 'checkpoint-v2.json');
  let checkpoint = {};
  if (options.apply) { try { checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  const counts = {};
  let checkpointWrites = Promise.resolve();
  async function saveCheckpoint() {
    if (!shouldCheckpoint(options.apply)) return;
    const snapshot = JSON.stringify(checkpoint);
    checkpointWrites = checkpointWrites.then(async () => {
      await mkdir(checkpointDir, { recursive: true, mode: 0o700 });
      await writeFile(`${checkpointFile}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${checkpointFile}.tmp`, checkpointFile);
    });
    return checkpointWrites;
  }
  async function persist(rows, count) {
    await persistImportRows(target, rows, options.apply, count);
  }
  async function pages(ref, key, transform, count) {
    let cursor = checkpoint[key] || '';
    for (;;) {
      let q = ref.orderBy(FieldPath.documentId()).limit(100);
      if (cursor) q = q.startAfter(cursor);
      const page = await q.get();
      if (page.empty) break;
      const rows = [];
      // Bounded parallel reads improve one-time migration throughput without a timer.
      for (let offset = 0; offset < page.docs.length; offset += 12) {
        const group = page.docs.slice(offset, offset + 12);
        count.read += group.length;
        const results = await Promise.allSettled(group.map(transform));
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        rows.push(...results.map(result => result.value));
      }
      await persist(rows, count);
      cursor = page.docs.at(-1).id;
      if (options.apply) { checkpoint[key] = cursor; await saveCheckpoint(); }
      console.log(JSON.stringify({ collection: key.startsWith('messages:') ? 'conversationMessages' : key, ...count, mode: options.apply ? 'apply' : 'dry-run' }));
    }
  }
  try {
    // Read only non-secret mailbox labels; credentials/config are never copied.
    const mailboxes = new Map((await source.collection('mail_accounts').select(...SOURCE_METADATA_FIELDS.mail_accounts).get()).docs.map(doc => [doc.id, str(doc.data().mailbox)]));
    for (const collection of collections) {
      const count = counts[collection] = { read: 0, created: 0, skipped: 0 };
      await pages(source.collection(collection), collection, async doc => {
        const data = doc.data();
        if (collection === 'conversations') {
          data.mailbox ||= mailboxes.get(data.mailAccountId) || '';
          await pages(doc.ref.collection('messages'), `messages:${doc.id}`, async message => {
            const projected = transformConversationMessage({ conversationId: doc.id, messageId: message.id, data: message.data() });
            // Prefer canonical source body when present, without copying arbitrary source fields.
            const messageRef = messageSourceId(message.data().messageRef);
            if (messageRef) {
              const original = (await source.doc(`message_sources/${messageRef}`).get()).data();
              if (original) {
                const enriched = transformFluDocToMixmax({ collection: 'message_sources', id: messageRef, data: { ...original, conversationId: doc.id } });
                return enriched;
              }
            }
            return projected;
          }, count);
        }
        return transformFluDocToMixmax({ collection, id: doc.id, data });
      }, count);
    }
    return counts;
  } finally { await deleteApp(sourceApp); await deleteApp(targetApp); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply' && arg !== '--dry-run' && !arg.startsWith('--collections='))) throw new Error('Use --dry-run or --apply, optionally --collections=a,b');
  const options = { apply: args.includes('--apply'), sourceProjectId: SOURCE_PROJECT_ID, targetProjectId: TARGET_PROJECT_ID, collections: args.find(arg => arg.startsWith('--collections='))?.split('=')[1].split(',') };
  runImport(options).then(counts => console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', targetDatabase: TARGET_DATABASE, counts }))).catch(error => { console.error('Import failed:', error.code ?? error.message); process.exitCode = 1; });
}
