import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(resolve(root, path), 'utf8');
const manifest = JSON.parse(read('migration/source-manifest.json'));
assert.equal(manifest.source.commit, 'be5915aeb455b3ce378e022125dcc09d514b8d8d');
assert.equal(manifest.productionDataStrategy, 'shared-existing-flu-backend');
for (const entry of manifest.files) {
  const digest = createHash('sha256').update(readFileSync(resolve(root, entry.path))).digest('hex');
  assert.equal(digest, entry.targetSha256, `Migration artifact changed after verification: ${entry.path}`);
  assert.ok(!/(^|\/)(\.env(?:\.|$)|node_modules\/|lib\/.*\.js$|.*\.log$)/.test(entry.path), `Unexpected imported file: ${entry.path}`);
}
const firebase = JSON.parse(read('firebase.json'));
assert.equal(JSON.parse(read('.firebaserc')).projects.default, 'demo-flu');
assert.ok(!firebase.hosting, 'The companion app must not deploy over Flu hosting.');
assert.ok(firebase.functions.every(codebase => codebase.predeploy.some(command => command.includes('block-deploy.mjs'))));
assert.equal(JSON.parse(read('functions/package.json')).main, 'lib/chat-entry.js');
const entry = read('functions/chat-entry.ts');
assert.doesNotMatch(entry, /export\s+\*/);
const endpointEvidence = execFileSync(process.execPath, [
  '--import', resolve(root, 'scripts/node-lane-backend-seal.mjs'),
  '-e', `
    const assert = require('node:assert/strict');
    const source = require('./functions/lib/index.js');
    const local = require('./functions/lib/chat-entry.js');
    const callableNames = Object.entries(source).filter(([, fn]) => fn?.__endpoint?.callableTrigger).map(([name]) => name);
    assert.ok(callableNames.length > 0);
    for (const name of callableNames) {
      assert.equal(local[name], source[name], 'Missing or replaced callable: ' + name);
      assert.ok(!local[name].__endpoint.secretEnvironmentVariables?.length, 'Remote secret binding: ' + name);
    }
    for (const name of Object.keys(local)) {
      assert.ok(name === 'assignGuestClaims' || callableNames.includes(name), 'Worker unexpectedly exported: ' + name);
    }
    console.log(JSON.stringify({ callableCount: callableNames.length, workerExports: 0 }));
  `,
], { cwd: root, encoding: 'utf8', env: { ...process.env, GCLOUD_PROJECT: 'demo-flu', FIREBASE_CONFIG: '{"projectId":"demo-flu"}', METADATA_SERVER_DETECTION: 'none' } });
console.log(endpointEvidence.trim());
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
assert.ok(tracked.every(path => !/(^|\/)\.env(?:\.|$)/.test(path) || path === '.env.example'), 'Environment credentials must not be committed.');
console.log(`Migration verified: ${manifest.files.length} source-derived files, pinned provenance, shared live backend, emulator-only backend.`);
