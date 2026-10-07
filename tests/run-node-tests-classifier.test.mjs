import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assertOfficialEmulatorEnvironment,
  requiresEmulator,
  selectNodeTestFiles,
  shouldRunTest,
} from "../scripts/run-node-tests.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("uppercase emulator guards are assigned only to the emulator lane", () => {
  const guardNames = [
    ["HAS", "FIRESTORE", "EMULATOR"].join("_"),
    ["HAS", "AUTH", "AND", "FIRESTORE", "EMULATORS"].join("_"),
  ];

  for (const guardName of guardNames) {
    const source = `const ${guardName} = Boolean(process.env);\ntest("emulator", { skip: !${guardName} }, () => {});`;
    assert.equal(requiresEmulator(source), true, `${guardName} must require emulators`);
    assert.equal(shouldRunTest(source, "emulator"), true);
    assert.equal(shouldRunTest(source, "node"), false);
  }
});

test("current uppercase-guarded suites are included by the official emulator classifier", () => {
  for (const path of [
    "tests/feed-manager-access.test.mjs",
    "tests/feed-proposal-learning.test.mjs",
    "tests/member-claims-sync.test.mjs",
  ]) {
    const source = read(path);
    assert.equal(requiresEmulator(source), true, `${path} must require emulators`);
    assert.equal(shouldRunTest(source, "emulator"), true);
    assert.equal(shouldRunTest(source, "node"), false);
  }
});

test("direct Firestore environment skip guards are included in the emulator lane", () => {
  const source = read("tests/participant-roster-intake-engine.test.mjs");
  assert.equal(requiresEmulator(source), true);
  assert.equal(shouldRunTest(source, "emulator"), true);
  assert.equal(shouldRunTest(source, "node"), false);

  const selected = selectNodeTestFiles({
    argv: [
      "node",
      "scripts/run-node-tests.mjs",
      "--emulator",
      "tests/participant-roster-intake-engine.test.mjs",
    ],
  });
  assert.deepEqual(selected, ["tests/participant-roster-intake-engine.test.mjs"]);
});

test("ordinary unit tests remain in the non-emulator lane", () => {
  const source = 'test("unit", () => {});';
  assert.equal(requiresEmulator(source), false);
  assert.equal(shouldRunTest(source, "emulator"), false);
  assert.equal(shouldRunTest(source, "node"), true);
});

test("package scripts route the classified files through the official emulator suite", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.scripts.test, "node scripts/run-node-tests.mjs");
  assert.match(
    packageJson.scripts["test:emu"],
    /firebase emulators:exec --only auth,functions,firestore --project demo-flu/,
  );
  assert.match(
    packageJson.scripts["test:emu"],
    /node scripts\/run-node-tests\.mjs --emulator/,
  );
});

test("emulator positional targets select only valid emulator suites and fail closed", () => {
  const selected = selectNodeTestFiles({
    argv: [
      "node",
      "scripts/run-node-tests.mjs",
      "--emulator",
      "tests/feed-proposal-learning.test.mjs",
      "tests/feed-manager-access.test.mjs",
    ],
  });
  assert.deepEqual(selected, [
    "tests/feed-manager-access.test.mjs",
    "tests/feed-proposal-learning.test.mjs",
  ]);

  const fullLane = selectNodeTestFiles({
    argv: ["node", "scripts/run-node-tests.mjs", "--emulator"],
  });
  assert.ok(fullLane.length > selected.length, "untargeted emulator mode must retain full discovery");
  assert.ok(selected.every((path) => fullLane.includes(path)));

  assert.throws(
    () =>
      selectNodeTestFiles({
        argv: ["node", "scripts/run-node-tests.mjs", "--emulator", "tests/../package.json"],
      }),
    /direct tests\/\*\.test\.mjs path/,
  );
  assert.throws(
    () =>
      selectNodeTestFiles({
        argv: [
          "node",
          "scripts/run-node-tests.mjs",
          "--emulator",
          "tests/not-present.test.mjs",
        ],
      }),
    /does not exist/,
  );
  assert.throws(
    () =>
      selectNodeTestFiles({
        argv: [
          "node",
          "scripts/run-node-tests.mjs",
          "--emulator",
          "tests/run-node-tests-classifier.test.mjs",
        ],
      }),
    /not in the emulator lane/,
  );
});

test("emulator mode accepts only loopback hosts on the explicit demo project", () => {
  const safeEnvironment = {
    GCLOUD_PROJECT: "demo-flu",
    GOOGLE_CLOUD_PROJECT: "demo-flu",
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099",
    FIREBASE_CONFIG: JSON.stringify({ projectId: "demo-flu" }),
  };

  assert.doesNotThrow(() => assertOfficialEmulatorEnvironment(safeEnvironment));
  assert.throws(
    () =>
      assertOfficialEmulatorEnvironment({
        ...safeEnvironment,
        GCLOUD_PROJECT: "influchat-77db6",
      }),
    /pinned to demo-flu/,
  );
  assert.throws(
    () =>
      assertOfficialEmulatorEnvironment({
        ...safeEnvironment,
        GOOGLE_CLOUD_PROJECT: "influchat-77db6",
      }),
    /pinned to demo-flu/,
  );
  assert.throws(
    () =>
      assertOfficialEmulatorEnvironment({
        ...safeEnvironment,
        FIRESTORE_EMULATOR_HOST: "firestore.googleapis.com:443",
      }),
    /loopback host/,
  );
  assert.throws(
    () =>
      assertOfficialEmulatorEnvironment({
        ...safeEnvironment,
        FIREBASE_AUTH_EMULATOR_HOST: undefined,
      }),
    /loopback host:port/,
  );
  assert.throws(
    () =>
      assertOfficialEmulatorEnvironment({
        ...safeEnvironment,
        FIREBASE_CONFIG: JSON.stringify({ projectId: "influchat-77db6" }),
      }),
    /pinned to demo-flu/,
  );
  assert.throws(
    () =>
      assertOfficialEmulatorEnvironment({
        FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
        FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      }),
    /requires GCLOUD_PROJECT or GOOGLE_CLOUD_PROJECT/,
  );
});
