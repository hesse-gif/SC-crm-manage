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
assert.equal(manifest.productionDataStrategy, 'independent-mixmax-runtime-with-one-time-flu-import');
assert.equal(manifest.backendProject, 'influencer-crm-296ca');
assert.equal(manifest.database, 'mixmax');
for (const entry of manifest.files) {
  const digest = createHash('sha256').update(readFileSync(resolve(root, entry.path))).digest('hex');
  assert.equal(digest, entry.targetSha256, `Migration artifact changed after verification: ${entry.path}`);
  assert.ok(!/(^|\/)(\.env(?:\.|$)|node_modules\/|lib\/.*\.js$|.*\.log$)/.test(entry.path), `Unexpected imported file: ${entry.path}`);
}
assert.ok(manifest.independentRuntimeFiles.length > 0);
for (const entry of manifest.independentRuntimeFiles) {
  assert.equal(createHash('sha256').update(readFileSync(resolve(root, entry.path))).digest('hex'), entry.sha256, `Independent runtime artifact changed: ${entry.path}`);
}
const legacy = JSON.parse(read('firebase.json'));
assert.equal(JSON.parse(read('.firebaserc')).projects.default, 'demo-flu');
assert.ok(legacy.functions.every(codebase => codebase.predeploy.some(command => command.includes('block-deploy.mjs'))));
const firebase = JSON.parse(read('firebase.mixmax.json'));
assert.deepEqual(firebase.functions.map(item => [item.codebase, item.source]), [['mixmax', '.mixmax-functions']]);
assert.equal(firebase.firestore.database, 'mixmax');
assert.equal(firebase.firestore.rules, 'firestore.mixmax.rules');
assert.equal(JSON.parse(read('firebase.hosting.json')).hosting.target, 'mixmaxclone');
const entry = read('functions/mixmax/index.ts');
assert.doesNotMatch(entry, /\.\.\//);
assert.match(read('src/lib/firebase.ts'), /getFirestore\(firebaseApp, "mixmax"\)/);
assert.doesNotMatch(read('src/components/mixmax/Workspace.tsx'), /setInterval|from ["'].*lib\/chat/);
assert.doesNotMatch(read('src/lib/mixmax.ts'), /setInterval|influchat-77db6/);
assert.match(read('scripts/run-next.mjs'), /NEXT_PUBLIC_FIREBASE_PROJECT_ID !== 'influencer-crm-296ca'/);
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
assert.ok(tracked.every(path => !/(^|\/)\.env(?:\.|$)/.test(path) || path === '.env.example'), 'Environment credentials must not be committed.');
console.log(`Migration verified: ${manifest.files.length} source-derived files, pinned provenance, independent target runtime, isolated named database, blocked legacy deployment.`);
