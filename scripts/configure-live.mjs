import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Public web config comes from the target-owned Mixmax web app.
const result = JSON.parse(execFileSync('firebase', ['apps:sdkconfig', 'web', '1:834858005811:web:58bffa2873218522df3a46', '--project', 'influencer-crm-296ca', '--json'], { encoding: 'utf8' }));
const config = result.result?.sdkConfig;
if (config?.projectId !== 'influencer-crm-296ca') throw new Error('Unexpected Firebase project; Mixmax must use its own backend.');
const fields = {
  apiKey: 'API_KEY', authDomain: 'AUTH_DOMAIN', projectId: 'PROJECT_ID',
  storageBucket: 'STORAGE_BUCKET', messagingSenderId: 'MESSAGING_SENDER_ID', appId: 'APP_ID',
};
for (const key of ['apiKey', 'authDomain', 'projectId', 'appId']) {
  if (typeof config[key] !== 'string' || !config[key] || /[\r\n]/.test(config[key])) throw new Error(`Invalid public Firebase field: ${key}`);
}
const lines = Object.entries(fields).flatMap(([key, name]) => typeof config[key] === 'string' && !/[\r\n]/.test(config[key]) ? [`NEXT_PUBLIC_FIREBASE_${name}=${config[key]}`] : []);
lines.push('NEXT_PUBLIC_FLU_RUNTIME_ENV=production', 'NEXT_PUBLIC_USE_EMULATOR=0', 'NEXT_PUBLIC_MIXMAX_INDEPENDENT=1');
writeFileSync(fileURLToPath(new URL('../.env.live.local', import.meta.url)), `${lines.join('\n')}\n`, { mode: 0o600 });
console.log('Configured Mixmax-owned Firebase in ignored .env.live.local.');
