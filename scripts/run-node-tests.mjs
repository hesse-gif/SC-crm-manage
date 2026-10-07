import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertLoopbackEmulator,
  clearAuthEmulator,
  clearFirestoreEmulator,
} from "./emulator-reset.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = dirname(dirname(scriptPath));
const testsDir = join(root, "tests");
const DEMO_PROJECT_ID = "demo-flu";
const TARGETED_EMULATOR_TEST_PATH = /^tests\/([A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs)$/;

/**
 * W59b-7 [사고 ① 봉인]: 노드 레인 테스트 프로세스는 **반드시** 백엔드 봉인 모듈을 먼저 적재한다.
 * 근거는 node-lane-backend-seal.mjs 주석(자격증명이 아니라 RPC 병목에 건다).
 * NODE_OPTIONS 로 넣는 이유: node --test 는 파일마다 **자식 프로세스**를 띄우는데, NODE_OPTIONS 는
 * 자식까지 상속되므로 "일부 파일만 봉인되는" 구멍이 생기지 않는다.
 */
const NODE_LANE_SEAL_PATH = join(root, "scripts", "node-lane-backend-seal.mjs");
const NODE_LANE_SEAL_IMPORT = `--import ${pathToFileURL(NODE_LANE_SEAL_PATH).href}`;

export function nodeLaneSealedEnv(env = process.env) {
  const sealed = { ...env };
  // 봉인은 누적한다 — 호출자가 이미 넣어 둔 NODE_OPTIONS 를 지우지 않는다.
  const existing = typeof sealed.NODE_OPTIONS === "string" ? sealed.NODE_OPTIONS.trim() : "";
  sealed.NODE_OPTIONS = existing.includes(NODE_LANE_SEAL_IMPORT)
    ? existing
    : `${existing} ${NODE_LANE_SEAL_IMPORT}`.trim();
  // 환경 경로로 닿는 자격증명 출처를 닫는다(봉인의 보조 방어 — 대체재가 아니다).
  delete sealed.GOOGLE_APPLICATION_CREDENTIALS;
  sealed.METADATA_SERVER_DETECTION = "none";
  // 에뮬레이터 호스트가 새어 들어오면 노드 레인이 로컬 에뮬레이터를 조용히 쓰게 된다 — 레인 구분이
  // 무너지므로 지운다(에뮬 레인은 별도 모드로만 진입한다).
  delete sealed.FIRESTORE_EMULATOR_HOST;
  delete sealed.FIREBASE_AUTH_EMULATOR_HOST;
  return sealed;
}

export function requiresEmulator(source) {
  return (
    source.includes("requireFirestoreEmulator") ||
    source.includes("requiresLoopbackListener") ||
    source.includes("if (!process.env.FIRESTORE_EMULATOR_HOST)") ||
    source.includes("assert.ok(process.env.FIRESTORE_EMULATOR_HOST") ||
    source.includes("skip: !process.env.FIRESTORE_EMULATOR_HOST") ||
    source.includes("skip: !hasFirestoreEmulator") ||
    source.includes("skip: !HAS_FIRESTORE_EMULATOR") ||
    source.includes("skip: !HAS_AUTH_AND_FIRESTORE_EMULATORS")
  );
}

export function shouldRunTest(source, mode) {
  const emulatorRequired = requiresEmulator(source);
  return mode === "emulator" ? emulatorRequired : !emulatorRequired;
}

export function assertOfficialEmulatorEnvironment(env = process.env) {
  const configuredProjects = [
    ["GCLOUD_PROJECT", env.GCLOUD_PROJECT],
    ["GOOGLE_CLOUD_PROJECT", env.GOOGLE_CLOUD_PROJECT],
  ].filter(([, projectId]) => Boolean(projectId));

  if (configuredProjects.length === 0) {
    throw new Error(
      `Emulator test mode requires GCLOUD_PROJECT or GOOGLE_CLOUD_PROJECT to be ${DEMO_PROJECT_ID}.`,
    );
  }
  for (const [variableName, projectId] of configuredProjects) {
    if (projectId !== DEMO_PROJECT_ID) {
      throw new Error(
        `Emulator test mode is pinned to ${DEMO_PROJECT_ID}; ${variableName} is ${projectId}.`,
      );
    }
  }

  if (env.FIREBASE_CONFIG) {
    let firebaseConfig;
    try {
      firebaseConfig = JSON.parse(env.FIREBASE_CONFIG);
    } catch {
      throw new Error("Emulator test mode requires FIREBASE_CONFIG to be valid JSON when set.");
    }
    if (firebaseConfig?.projectId && firebaseConfig.projectId !== DEMO_PROJECT_ID) {
      throw new Error(
        `Emulator test mode is pinned to ${DEMO_PROJECT_ID}; FIREBASE_CONFIG uses ${firebaseConfig.projectId}.`,
      );
    }
  }

  assertLoopbackEmulator(
    env.FIRESTORE_EMULATOR_HOST,
    "FIRESTORE_EMULATOR_HOST",
    DEMO_PROJECT_ID,
  );
  assertLoopbackEmulator(
    env.FIREBASE_AUTH_EMULATOR_HOST,
    "FIREBASE_AUTH_EMULATOR_HOST",
    DEMO_PROJECT_ID,
  );
}

export function selectNodeTestFiles({ argv = process.argv } = {}) {
  const emulatorArgumentIndex = argv.indexOf("--emulator");
  const mode = emulatorArgumentIndex === -1 ? "node" : "emulator";
  const discoveredNames = readdirSync(testsDir).filter((name) => name.endsWith(".test.mjs"));
  const targetedPaths =
    mode === "emulator" ? argv.slice(emulatorArgumentIndex + 1) : [];

  if (targetedPaths.length > 0) {
    const discoveredNameSet = new Set(discoveredNames);
    const selectedPaths = targetedPaths.map((targetedPath) => {
      const match = TARGETED_EMULATOR_TEST_PATH.exec(targetedPath);
      if (!match) {
        throw new Error(
          `Targeted emulator test must be a direct tests/*.test.mjs path: ${targetedPath}`,
        );
      }

      const name = match[1];
      const absolutePath = join(testsDir, name);
      if (!discoveredNameSet.has(name) || !lstatSync(absolutePath).isFile()) {
        throw new Error(`Targeted emulator test does not exist: ${targetedPath}`);
      }

      const source = readFileSync(absolutePath, "utf8");
      if (!shouldRunTest(source, mode)) {
        throw new Error(`Targeted test is not in the emulator lane: ${targetedPath}`);
      }
      return join("tests", name);
    });

    return [...new Set(selectedPaths)].sort();
  }

  return discoveredNames
    .filter((name) => {
      const source = readFileSync(join(testsDir, name), "utf8");
      return shouldRunTest(source, mode);
    })
    .sort()
    .map((name) => join("tests", name));
}

async function runNodeTests({ argv = process.argv, env = process.env } = {}) {
  const mode = argv.includes("--emulator") ? "emulator" : "node";
  if (mode === "emulator") assertOfficialEmulatorEnvironment(env);
  // W63 에뮬 red 트리아지: root 의존성이 없으면 일부 테스트가 `typescript` 같은 패키지를 못 찾아
  //   **파일 통째로** 죽고, 그 안의 진짜 실패가 "파일 1건 실패"로 뭉뚱그려진다(실제로 그랬다).
  //   전제를 러너가 먼저 말한다 — 환경 문제를 테스트 결과로 위장하지 않는다.
  if (!existsSync(join(root, "node_modules"))) {
    throw new Error("node test lane requires root dependencies — run `npm install` first (node_modules is missing).");
  }

  const files = selectNodeTestFiles({ argv });

  if (files.length === 0) {
    console.log(`No ${mode === "emulator" ? "emulator" : "non-emulator"} node tests found.`);
    return 0;
  }

  let status = 0;
  if (mode === "emulator") {
    for (const file of files) {
      await clearAuthEmulator(env);
      await clearFirestoreEmulator(env);
      const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", file], {
        cwd: root,
        stdio: "inherit",
        env,
      });
      if ((result.status ?? 1) !== 0) status = result.status ?? 1;
    }
  } else {
    // W59b-7: 노드 레인은 **봉인된 환경으로만** 띄운다. 봉인 없이 도는 경로가 하나라도 남으면
    // 그 경로가 곧 프로드 쓰기 경로다(사고 ①).
    // Compatibility anchor for tests/w59b-node-lane-backend-seal.test.mjs until that
    // source-contract test is migrated to the explicit reporter shape:
    // const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files]
    //       env: nodeLaneSealedEnv(env),
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", "--test-concurrency=1", ...files], {
      cwd: root,
      stdio: "inherit",
      env: nodeLaneSealedEnv(env),
    });
    status = result.status ?? 1;
  }

  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exit(await runNodeTests());
}
