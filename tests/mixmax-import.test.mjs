import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertProjectGuard, assertCollectionAllowed, namespacedFluId, sanitizeForImport, transformFluDocToMixmax, transformConversationMessage, targetWriteForExisting, rowForExistingMessage, shouldCheckpoint, SOURCE_METADATA_FIELDS, SOURCE_PROJECT_ID, TARGET_PROJECT_ID } from '../scripts/mixmax-import-flu.mjs';
test('source/target/database guards reject changed destinations', () => {
 const options={sourceProjectId:SOURCE_PROJECT_ID,targetProjectId:TARGET_PROJECT_ID,apply:false};
 assert.doesNotThrow(()=>assertProjectGuard(options));
 for(const patch of [{sourceProjectId:TARGET_PROJECT_ID},{targetProjectId:SOURCE_PROJECT_ID},{targetDatabase:'(default)'}]) assert.throws(()=>assertProjectGuard({...options,...patch}));
 assert.throws(()=>assertCollectionAllowed('mail_oauth_credentials'));
 assert.throws(()=>assertCollectionAllowed('unknown'));
});
test('dry run cannot advance the apply checkpoint',()=>{ assert.equal(shouldCheckpoint(false),false); assert.equal(shouldCheckpoint(true),true); });
test('projection is an allowlist and cannot preserve unknown secrets',()=>{
 const data={creatorEmail:'person@example.com',refreshToken:'SECRET',smtpPassword:'SECRET',nested:{privateKey:'SECRET'},lastMessage:'Hello'};
 const row=transformFluDocToMixmax({collection:'conversations',id:'a',data});
 assert.equal(JSON.stringify(row).includes('SECRET'),false);
 assert.equal(row.data.source,'flu'); assert.deepEqual(row.data.participantEmails,['person@example.com']);
 assert.equal(sanitizeForImport(data).refreshToken,'[redacted-by-mixmax-import]');
});
test('source ids never collide after punctuation normalization or truncation',()=>{
 assert.notEqual(namespacedFluId('a/b'),namespacedFluId('a_b'));
 assert.notEqual(namespacedFluId('x'.repeat(500)+'a'),namespacedFluId('x'.repeat(500)+'b'));
 assert.equal(namespacedFluId('a'),namespacedFluId('a'));
});
test('canonical messages share ids with source bodies and preserve full body',()=>{
 const nested=transformConversationMessage({conversationId:'c',messageId:'m',data:{messageRef:'r',text:'preview'}});
 const original=transformFluDocToMixmax({collection:'message_sources',id:'r',data:{conversationId:'c',body:'full body',to:'x@example.com',receivedAtIso:'2026-10-01T00:00:00Z'}});
 assert.equal(nested.targetId,original.targetId); assert.equal(nested.data.threadId,original.data.threadId);
 const pathReference=transformConversationMessage({conversationId:'c',messageId:'m',data:{messageRef:'message_sources/r',text:'preview'}});
 assert.equal(pathReference.targetId,original.targetId);
 assert.equal(original.data.text,'full body'); assert.deepEqual(original.data.to,['x@example.com']); assert.equal(original.data.sentAt,'2026-10-01T00:00:00.000Z');
});
test('existing native modifications are preserved on rerun',()=>{ assert.equal(targetWriteForExisting({body:'edited'},{data:{body:'source'}}).action,'skip'); });
test('mail account exception reads only explicit non-secret metadata fields',()=>{
 assert.deepEqual(SOURCE_METADATA_FIELDS, {mail_accounts:['accountId','mailbox']});
 assert.throws(()=>assertCollectionAllowed('mail_accounts'));
});
test('shared source message retains each conversation association on rerun',()=>{
 const row=transformFluDocToMixmax({collection:'message_sources',id:'shared',data:{conversationId:'second'}});
 const alias=rowForExistingMessage({threadId:'first'},row);
 assert.notEqual(alias.targetId,row.targetId);
 assert.equal(alias.data.threadId,row.data.threadId);
 assert.equal(rowForExistingMessage({threadId:'first'},row).targetId,alias.targetId);
 assert.equal(rowForExistingMessage({threadId:row.data.threadId},row).targetId,row.targetId);
});
test('outbound receipts preserve delivery outcome and cannot become send jobs',()=>{
 const row=transformFluDocToMixmax({collection:'mail_outbound_log',id:'receipt',data:{to:'person@example.com',deliveryState:'blocked',sentAtIso:'2026-10-01T00:00:00Z',refreshToken:'SECRET'}});
 assert.equal(row.targetCollection,'mixmax_sends'); assert.equal(row.data.status,'blocked');
 assert.equal(row.data.automaticRetryBlocked,true); assert.equal(row.data.importedReceipt,true);
 assert.equal(row.data.ownerUid,''); assert.equal(JSON.stringify(row).includes('SECRET'),false);
});
