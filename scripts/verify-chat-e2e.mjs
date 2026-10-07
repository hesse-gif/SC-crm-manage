import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const specs = [
  "e2e/migration-chat-core.spec.ts",
  "e2e/migration-chat-live-update.spec.ts",
  "e2e/migration-oauth.spec.ts",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      GCLOUD_PROJECT: "demo-flu",
      GOOGLE_CLOUD_PROJECT: "demo-flu",
      FIREBASE_CONFIG: JSON.stringify({ projectId: "demo-flu" }),
      NEXT_PUBLIC_USE_EMULATOR: "1",
      NEXT_PUBLIC_FLU_RUNTIME_ENV: "production",
      NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      NEXT_PUBLIC_FUNCTIONS_EMULATOR_HOST: "127.0.0.1:5001",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      FUNCTIONS_EMULATOR_HOST: "127.0.0.1:5001",
      ...options.env,
    },
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(join(root, "functions", "node_modules"))) {
  throw new Error("functions/node_modules is missing; install dependencies before verify:e2e.");
}

run("npm", ["--prefix", "functions", "run", "build"]);
run("npm", ["run", "build"]);

const command = [
  "node scripts/seed-emulator.mjs",
  "&&",
  "PLAYWRIGHT_PORT=3107",
  "PLAYWRIGHT_USE_BUILT_SERVER=1",
  "npx playwright test",
  ...specs,
  "--project=chromium",
].join(" ");

run("firebase", ["emulators:exec", "--only", "auth,functions,firestore", "--project", "demo-flu", command]);
