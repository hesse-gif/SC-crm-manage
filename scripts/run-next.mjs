import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const [command = 'dev', ...args] = process.argv.slice(2);
if (!['dev', 'build', 'start'].includes(command)) throw new Error('Expected dev, build or start.');
const emulator = args.includes('--emulator') || (!args.includes('--live') && process.env.NEXT_PUBLIC_USE_EMULATOR === '1');
const env = { ...process.env };
if (emulator) {
  env.NEXT_PUBLIC_USE_EMULATOR = '1';
  delete env.NEXT_PUBLIC_FIREBASE_AUTH_TENANT_ID;
  env.NEXT_PUBLIC_FLU_RUNTIME_ENV = 'production';
  env.MIXMAX_NEXT_DIST_DIR = '.next';
} else {
  const configPath = resolve(root, '.env.live.local');
  if (!existsSync(configPath)) throw new Error('Run npm run configure:live first, or use npm run dev:emu for local fixtures.');
  const allowed = /^NEXT_PUBLIC_(FIREBASE_(API_KEY|AUTH_DOMAIN|PROJECT_ID|STORAGE_BUCKET|MESSAGING_SENDER_ID|APP_ID|APPCHECK_SITE_KEY)|FLU_RUNTIME_ENV|USE_EMULATOR)$/;
  for (const line of readFileSync(configPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && allowed.test(match[1])) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  if (env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== 'influchat-77db6') throw new Error('Live mode must share the existing Flu Firebase project.');
  env.NEXT_PUBLIC_USE_EMULATOR = '0';
  env.NEXT_PUBLIC_FLU_RUNTIME_ENV = 'production';
  delete env.NEXT_PUBLIC_FIREBASE_AUTH_TENANT_ID;
  env.MIXMAX_NEXT_DIST_DIR = '.next-live';
}
if (args.includes('--export')) {
  if (command !== 'build') throw new Error('Static export requires build.');
  env.MIXMAX_STATIC_EXPORT = '1';
  env.MIXMAX_NEXT_DIST_DIR = 'out';
}
const nextArgs = args.filter(arg => !['--live', '--emulator', '--export'].includes(arg));
console.log(`Mixmaxclone: ${emulator ? 'local emulator data' : 'shared Flu live data'} (${command})`);
const child = spawn(process.execPath, [resolve(root, 'node_modules/next/dist/bin/next'), command, ...nextArgs], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
