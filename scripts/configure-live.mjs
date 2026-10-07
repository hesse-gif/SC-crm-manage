import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Firebase web configuration is public. Auth and callable authorization remain
// on the existing Flu backend; no server credential is downloaded or stored.
const response = await fetch('https://sc-flu.web.app/__/firebase/init.json');
if (!response.ok) throw new Error(`Public Firebase configuration unavailable (${response.status}).`);
const config = await response.json();
if (config.projectId !== 'influchat-77db6') throw new Error('Unexpected Firebase project; refusing to change the shared backend.');
const fields = {
  apiKey: 'API_KEY', authDomain: 'AUTH_DOMAIN', projectId: 'PROJECT_ID',
  storageBucket: 'STORAGE_BUCKET', messagingSenderId: 'MESSAGING_SENDER_ID', appId: 'APP_ID',
};
for (const key of ['apiKey', 'authDomain', 'projectId', 'appId']) {
  if (typeof config[key] !== 'string' || !config[key] || /[\r\n]/.test(config[key])) throw new Error(`Invalid public Firebase field: ${key}`);
}
const lines = Object.entries(fields).flatMap(([key, name]) => typeof config[key] === 'string' && !/[\r\n]/.test(config[key]) ? [`NEXT_PUBLIC_FIREBASE_${name}=${config[key]}`] : []);
lines.push('NEXT_PUBLIC_FLU_RUNTIME_ENV=production', 'NEXT_PUBLIC_USE_EMULATOR=0');
writeFileSync(fileURLToPath(new URL('../.env.live.local', import.meta.url)), `${lines.join('\n')}\n`, { mode: 0o600 });
console.log('Configured shared Flu live data in ignored .env.live.local. Sign in with your existing Flu account.');
