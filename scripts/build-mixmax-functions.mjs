import { mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '.mixmax-functions');
mkdirSync(output, { recursive: true });
const source = JSON.parse(readFileSync(resolve(root, 'functions/package.json'), 'utf8'));
const dependencies = Object.fromEntries(['firebase-admin', 'firebase-functions'].map(name => [name, source.dependencies[name]]));
writeFileSync(resolve(output, 'package.json'), JSON.stringify({ name: 'mixmax-runtime', private: true, main: 'lib/index.js', engines: { node: '22' }, dependencies }, null, 2) + '\n');
if (!existsSync(resolve(output, 'node_modules'))) symlinkSync(resolve(root, 'functions/node_modules'), resolve(output, 'node_modules'), 'dir');
const result = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'functions/tsconfig.mixmax.json'], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
