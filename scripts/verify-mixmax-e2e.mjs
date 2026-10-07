import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { seedMixmaxEmulator } from './seed-mixmax-emulator.mjs';

if (process.env.GCLOUD_PROJECT !== 'demo-mixmax' || !process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Run via demo-mixmax emulators:exec');
await seedMixmaxEmulator();
execFileSync(process.execPath, ['scripts/verify-mixmax-sync.mjs'], { stdio: 'inherit', env: process.env });
await mkdir('artifacts/verification', { recursive: true });
const port = '3218';
const env = { ...process.env, MIXMAX_PLAYWRIGHT_PORT: port, NEXT_PUBLIC_MIXMAX_INDEPENDENT: '1', NEXT_PUBLIC_USE_EMULATOR: '1', NEXT_PUBLIC_FLU_RUNTIME_ENV: 'production', NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: '127.0.0.1:8480', NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9499', NEXT_PUBLIC_FUNCTIONS_EMULATOR_HOST: '127.0.0.1:5401' };
const server = spawn(process.execPath, ['scripts/run-next.mjs', 'dev', '--emulator', '--port', port], { env, stdio: 'inherit' });
const stop = () => { server.kill('SIGTERM'); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  const deadline = Date.now() + 180000;
  let ready = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('Next server exited before ready');
    try { ready = (await fetch(`http://127.0.0.1:${port}/mail`)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Mixmax dev server readiness timed out');
  const code = await new Promise((resolveCode, reject) => {
    const child = spawn(process.execPath, [resolve('node_modules/@playwright/test/cli.js'), 'test', '--config', 'playwright.mixmax.config.ts'], { env, stdio: 'inherit' });
    child.on('error', reject); child.on('exit', resolveCode);
  });
  process.exitCode = code ?? 1;
} finally { stop(); }
