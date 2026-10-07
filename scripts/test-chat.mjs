import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeLaneSealedEnv } from "./run-node-tests.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const node = process.execPath;

const nodeLaneTests = [
  "tests/chat-normalization.test.mjs",
  "tests/read-conversation-order-regression.test.mjs",
  "tests/mail-receipts-read-only-boundary.test.mjs",
  "tests/chat-foreground-sync-contract.test.mjs",
  "tests/permit-chat-auto-ui-contract.test.mjs",
  "tests/chat-auto-review-board-ui.test.mjs",
  "tests/emulator-reset-retry.test.mjs",
];

const builtFunctionTests = [
  "tests/chat-standalone-new-mail-contract.test.mjs",
  "tests/conversation-view-as-scope.test.mjs",
  "tests/permit-chat-auto-core.test.mjs",
  "tests/permit-chat-auto-integration.test.mjs",
  "tests/permit-chat-auto-counters.test.mjs",
  "tests/permit-chat-auto-public-projection.test.mjs",
];

function run(command, args, options = {}) {
  const env = nodeLaneSealedEnv({
    ...process.env,
    FIREBASE_PROJECT_ID: "demo-flu",
    GCLOUD_PROJECT: "demo-flu",
    ...options.env,
  });

  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env,
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

function maybeBuildFunctions() {
  if (!existsSync(join(root, "functions", "package.json"))) {
    throw new Error("[test-chat] functions/package.json is missing; cannot run Flu chat migration backend contracts.");
  }
  if (!existsSync(join(root, "functions", "node_modules"))) {
    throw new Error("[test-chat] functions/node_modules is missing. Run: npm --prefix functions install");
  }
  run("npm", ["--prefix", "functions", "run", "build"]);
  if (!existsSync(join(root, "functions", "lib", "chat-ai.js"))) {
    throw new Error("[test-chat] functions build did not produce functions/lib/chat-ai.js");
  }
  return true;
}

const runnable = [...nodeLaneTests];
if (maybeBuildFunctions()) runnable.push(...builtFunctionTests);

run(node, ["--test", "--test-reporter=spec", "--test-concurrency=1", ...runnable]);
