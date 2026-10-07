import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const node = process.execPath;

for (const args of [
  ["scripts/build-mixmax-functions.mjs"],
  ["--test", "--test-concurrency=1", "tests/mixmax-automation.test.mjs"],
]) {
  const result = spawnSync(node, args, { cwd: root, stdio: "inherit" });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}
