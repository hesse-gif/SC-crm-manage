import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(resolve('functions/package.json'));
if (process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Casebook migration refuses inherited emulator configuration');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { CHAT_CASEBOOK, CHAT_CASEBOOK_VERSION, isCasebookDraftForbidden } = require(resolve('functions/lib/chatCasebook.js'));
const source = getFirestore(initializeApp({ projectId: 'influchat-77db6' }, 'casebook-readonly-source'));
const target = getFirestore(initializeApp({ projectId: 'influencer-crm-296ca' }, 'casebook-target'), 'mixmax');
const overrides = (await source.doc('chat_auto_case_replies/config').get()).data()?.cases ?? {};
const apply = process.argv.includes('--apply');
let created = 0; let skipped = 0;
for (const item of CHAT_CASEBOOK) {
  const ref = target.doc(`mixmax_cases/casebook_${item.id}`);
  if ((await ref.get()).exists) { skipped++; continue; }
  const override = typeof overrides[item.id]?.text === 'string' ? overrides[item.id].text : '';
  const data = { workspaceId: 'primary', source: 'flu', caseType: 'chat_casebook', caseId: item.id, name: item.autoReplyTemplate?.title ?? item.id.replaceAll('_', ' '), description: item.signals, body: override || item.autoReplyTemplate?.template || item.skeleton, skeleton: item.skeleton, never: item.never, draftForbidden: isCasebookDraftForbidden(item.id), noReplyNeeded: Boolean(item.noReplyNeeded || item.escalation === 'auto_close'), originalEscalation: item.escalation, automaticSendingEnabled: false, version: CHAT_CASEBOOK_VERSION, sourceMetadata: { collection: 'chat_auto_case_replies/config', code: 'functions/chatCasebook.ts', sourceCommit: 'be5915aeb455b3ce378e022125dcc09d514b8d8d' }, importedAt: new Date().toISOString() };
  if (apply) await ref.create(data);
  created++;
}
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', cases: created, skipped, targetProject: 'influencer-crm-296ca', targetDatabase: 'mixmax' }));
