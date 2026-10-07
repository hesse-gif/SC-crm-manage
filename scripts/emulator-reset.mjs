const DEFAULT_RESET_TIMEOUT_MS = 5_000;
const MAX_RESET_ATTEMPTS = 3;
const AUTH_TENANT_IDS = ["flu-staging-emulator", "flu-wrong-emulator"];
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504]);
// W60-7 [에뮬 레인 EPIPE — 81파일 미실행의 원인]
//
// 실측: 긴 에뮬 레인(파일마다 자식 프로세스 + 매 파일 앞 리셋 2회)에서 약 153번째 파일 즈음
// `Auth emulator accounts reset transport failed on **attempt 1/3**: EPIPE` 로 러너가 통째로 죽었다.
// "attempt 1/3" 이 원인을 그대로 말해 준다 — EPIPE 가 이 집합에 없어 **재시도 없이 즉시 throw** 됐다.
//
// EPIPE 는 ECONNRESET 과 같은 사건의 반대편이다: 서버(에뮬레이터)가 keep-alive 연결을 재활용/정리하는
// 순간에 우리가 그 소켓으로 쓰면, 읽는 쪽이 먼저 알면 ECONNRESET, 쓰는 쪽이 먼저 알면 EPIPE 다.
// 하나만 재시도 대상으로 두는 것은 분류 누락이지 정책이 아니다. 즉시 재시도로 대부분 해소된다
// (다음 요청은 새 소켓을 얻는다).
const RETRYABLE_ERROR_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ETIMEDOUT"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function consumeResponse(response) {
  await response.arrayBuffer();
}

function getErrorCode(error) {
  return error?.code || error?.cause?.code || null;
}

function isAbortTimeout(error) {
  return (
    error?.name === "TimeoutError" ||
    error?.name === "AbortError" ||
    error?.cause?.name === "TimeoutError" ||
    error?.cause?.name === "AbortError"
  );
}

function isRetryableTransportError(error) {
  return RETRYABLE_ERROR_CODES.has(getErrorCode(error)) || isAbortTimeout(error);
}

function buildResetFailure({ targetName, phase, attempt, status, error }) {
  const detail = status
    ? `HTTP ${status}`
    : isAbortTimeout(error)
      ? "timeout"
      : getErrorCode(error) || error?.name || "transport failure";
  return new Error(`${targetName} reset ${phase} on attempt ${attempt}/${MAX_RESET_ATTEMPTS}: ${detail}.`);
}

export function assertLoopbackEmulator(host, variableName, projectId) {
  if (projectId !== "demo-flu") {
    throw new Error(`${variableName} reset is pinned to demo-flu; received ${projectId}.`);
  }

  if (
    typeof host !== "string" ||
    host.length === 0 ||
    host !== host.trim() ||
    /\s/.test(host) ||
    /[/@?#]/.test(host)
  ) {
    throw new Error(`${variableName} reset requires a bare loopback host:port.`);
  }

  let url;
  try {
    url = new URL(`http://${host}`);
  } catch {
    throw new Error(`${variableName} reset requires a valid loopback host:port.`);
  }

  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${variableName} reset requires a bare loopback host:port.`);
  }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error(`${variableName} reset requires a loopback host; received ${url.hostname}.`);
  }
  if (!/^\d+$/.test(url.port)) {
    throw new Error(`${variableName} reset requires an explicit numeric emulator port.`);
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${variableName} reset requires a valid emulator port.`);
  }
}

export async function resetEmulatorDelete({
  host,
  variableName,
  projectId,
  path,
  targetName,
  timeoutMs = DEFAULT_RESET_TIMEOUT_MS,
}) {
  assertLoopbackEmulator(host, variableName, projectId);
  for (let attempt = 1; attempt <= MAX_RESET_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(`http://${host}${path}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const failure = buildResetFailure({
        targetName,
        phase: "transport failed",
        attempt,
        error,
      });
      if (!isRetryableTransportError(error) || attempt === MAX_RESET_ATTEMPTS) {
        throw failure;
      }
      await sleep(100 * attempt);
      continue;
    }

    try {
      await consumeResponse(response);
    } catch (error) {
      const failure = buildResetFailure({
        targetName,
        phase: "body read failed",
        attempt,
        error,
      });
      if (!isRetryableTransportError(error) || attempt === MAX_RESET_ATTEMPTS) {
        throw failure;
      }
      await sleep(100 * attempt);
      continue;
    }

    if (response.ok) return;
    const failure = buildResetFailure({
      targetName,
      phase: "failed",
      attempt,
      status: response.status,
    });
    if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === MAX_RESET_ATTEMPTS) {
      throw failure;
    }
    await sleep(100 * attempt);
  }
}

export async function clearFirestoreEmulator(env = process.env) {
  const host = env.FIRESTORE_EMULATOR_HOST;
  if (!host) return;
  const projectId = env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || "demo-flu";
  for (const databaseId of ["(default)", "flu-staging"]) {
    await resetEmulatorDelete({
      host,
      variableName: "FIRESTORE_EMULATOR_HOST",
      projectId,
      path: `/emulator/v1/projects/${projectId}/databases/${databaseId}/documents`,
      targetName: `Firestore emulator database ${databaseId}`,
    });
  }
}

export async function clearAuthEmulator(env = process.env) {
  const host = env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!host) return;
  const projectId = env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || "demo-flu";
  const accountPaths = [
    `/emulator/v1/projects/${projectId}/accounts`,
    ...AUTH_TENANT_IDS.map(
      (tenantId) => `/emulator/v1/projects/${projectId}/tenants/${tenantId}/accounts`,
    ),
  ];
  for (const accountPath of accountPaths) {
    await resetEmulatorDelete({
      host,
      variableName: "FIREBASE_AUTH_EMULATOR_HOST",
      projectId,
      path: accountPath,
      targetName: "Auth emulator accounts",
    });
  }
}

export const __testables = {
  AUTH_TENANT_IDS,
  DEFAULT_RESET_TIMEOUT_MS,
  MAX_RESET_ATTEMPTS,
  RETRYABLE_ERROR_CODES,
  isRetryableTransportError,
};
