import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(readFileSync(resolve(root, 'firebase.mixmax.json'), 'utf8'));
assert.equal(config.functions.length, 1);
assert.equal(config.functions[0].codebase, 'mixmax');
assert.equal(config.functions[0].source, '.mixmax-functions');
assert.equal(config.firestore.database, 'mixmax');
assert.equal(config.firestore.rules, 'firestore.mixmax.rules');
assert.equal(config.hosting, undefined);
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, undefined);
const result = spawnSync(resolve(root, 'node_modules/.bin/firebase'), [
  'deploy', '--config', 'firebase.mixmax.json', '--project', 'influencer-crm-296ca',
  // Acknowledges retry policies on the two idempotent Gmail event handlers.
  '--only', 'functions:mixmax,firestore', '--non-interactive', '--force',
], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
