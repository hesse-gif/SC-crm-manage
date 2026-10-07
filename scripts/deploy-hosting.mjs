import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(readFileSync(resolve(root, 'firebase.hosting.json'), 'utf8'));
if (config.functions || config.firestore || config.hosting?.target !== 'mixmaxclone' || config.hosting?.public !== 'out') {
  throw new Error('Only the Mixmaxclone static Hosting target may be deployed.');
}
const build = spawnSync(process.execPath, ['scripts/run-next.mjs', 'build', '--live', '--export'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
for (const file of ['index.html', 'chat.html', 'chat/auto.html', 'login.html']) {
  if (!existsSync(resolve(root, 'out', file))) throw new Error(`Missing exported route ${file}`);
}
const deployed = spawnSync(resolve(root, 'node_modules/.bin/firebase'), [
  'deploy', '--config', 'firebase.hosting.json', '--project', 'influencer-crm-296ca',
  '--only', 'hosting:mixmaxclone', '--non-interactive',
], { cwd: root, stdio: 'inherit' });
process.exit(deployed.status ?? 1);
