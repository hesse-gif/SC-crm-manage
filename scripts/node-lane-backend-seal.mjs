// W59b-7 [사고 ① 봉인]: 노드 테스트 레인이 **실제 백엔드에 단 1건도** 나가지 못하게 막는다.
//
// 사고 형상(2026-08-09 실측): `npm test`(노드 레인)는 프로젝트를 고정하지 않았고, firebase-admin 의
// initializeApp() 이 ADC 에서 프로젝트를 **지연 해석**해 `influchat-77db6`(프로드)에 붙었다.
// 그 상태에서 fetchYouTubeRecord 를 호출하는 기존 테스트들의 fire-and-forget 계측이 프로드
// `api_usage/youtube_pt_<PT일자>` 에 실제로 기록됐다(내 W59-6 테스트가 v2.bySlotSearchCalls 에
// 8건을 남긴 것을 읽어서 확인). W59-6 배포 후에는 이 경로가 **검색 버킷 원장(400콜/일 예산)** 을
// 오염시키므로 배포 선행 조건이다.
//
// ■ 왜 환경변수만으로는 부족한가 (실측 근거)
//   · GOOGLE_APPLICATION_CREDENTIALS 를 지워도 google-auth-library 는 **well-known 경로**
//     (`$HOME/.config/gcloud/application_default_credentials.json`)를 그대로 읽는다. 이 버전은
//     CLOUDSDK_CONFIG 를 보지 않는다(googleauth.js `_tryGetApplicationCredentialsFromWellKnownFile`
//     은 HOME 만 본다). HOME 을 갈아끼우는 것은 npm 캐시까지 흔드는 과한 조치다.
//   · 프로젝트 핀(GCLOUD_PROJECT=demo-flu)은 유효하지만, runtimeEnvironment.ts 의
//     currentProjectIds() 입력을 바꿔 3,000건 넘는 레인 전체의 런타임 분류를 건드린다.
//   → 그래서 봉인은 **자격증명이 아니라 RPC 경로**에 건다. 자격증명이 살아 있든 죽었든 무관하게
//     성립하는 것이 이 방식의 요점이다(리더 수용 기준: "ADC 가 살아 있어도 단 1건도").
//
// ■ 봉인 지점 (전 egress 가 지나는 병목)
//   · @google-cloud/firestore  Firestore.prototype.initializeIfNeeded
//     — **모든** RPC(commit·runTransaction·getAll·쿼리·watch)가 먼저 이걸 await 한다(write-batch.js:469
//       등). 그리고 이 안이 바로 ADC 로 프로젝트를 지연 해석하는 자리다 — 사고 ①의 기계 그 자체다.
//       여기서 끊으면 프로젝트 탐지조차 일어나지 않는다. 실측: 봉인 전 15.1초(자격증명 탐색) → 봉인 후 즉시.
//   · @google-cloud/firestore  Firestore.prototype.request / requestStream
//     — initializeIfNeeded 를 건너뛰는 경로가 생기더라도 실제 전송은 이 둘을 지난다(이중 방어).
//   · firebase-admin           HttpClient.prototype.send / sendWithRetry
//     — Auth·Storage 등 REST 계열 egress 병목.
//   전부 **로컬에서 즉시 throw** 한다. 네트워크를 시도하지 않으므로 gRPC UNAVAILABLE 재시도
//   백오프(실측 43초)도 발생하지 않는다.
//
// ■ 계약: 이 봉인은 노드 레인 **전용**이다. 에뮬 레인은 실제 로컬 에뮬레이터를 써야 하므로
//   run-node-tests.mjs 가 node 모드에서만 이 모듈을 주입한다(NODE_OPTIONS --import).
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const NODE_LANE_SEAL_MARKER = "__FLU_NODE_LANE_BACKEND_SEALED__";
export const NODE_LANE_SEAL_ERROR_CODE = "node_lane_backend_sealed";

const here = dirname(fileURLToPath(import.meta.url));
const requireFromFunctions = createRequire(join(here, "..", "functions", "package.json"));

function sealedError(surface) {
  const error = new Error(
    `[node-lane-backend-seal] ${surface} is sealed in the node test lane: `
    + "the node lane must never reach a real backend. "
    + "Move this test to the emulator lane (add the FIRESTORE_EMULATOR_HOST guard) "
    + "or inject a fake at the call site.",
  );
  error.code = NODE_LANE_SEAL_ERROR_CODE;
  error.errorCode = NODE_LANE_SEAL_ERROR_CODE;
  error.sealedSurface = surface;
  return error;
}

/** 봉인된 표면 목록 — 테스트가 "무엇이 실제로 잠겼는지"를 값으로 확인한다. */
export const sealedSurfaces = [];

function seal(target, methodName, surface) {
  if (typeof target?.[methodName] !== "function") {
    // 병목 이름이 사라졌다면 봉인이 조용히 무력화된 것이다 — 그건 즉시 실패여야 한다.
    throw new Error(
      `[node-lane-backend-seal] expected choke point ${surface} to exist; `
      + "the dependency shape changed and the seal would silently become a no-op.",
    );
  }
  Object.defineProperty(target, methodName, {
    configurable: true,
    writable: true,
    value: function nodeLaneSealed() {
      throw sealedError(surface);
    },
  });
  sealedSurfaces.push(surface);
}

function installSeal() {
  if (globalThis[NODE_LANE_SEAL_MARKER]) return;

  const { Firestore } = requireFromFunctions("@google-cloud/firestore");
  seal(Firestore.prototype, "initializeIfNeeded", "Firestore.initializeIfNeeded");
  seal(Firestore.prototype, "request", "Firestore.request");
  seal(Firestore.prototype, "requestStream", "Firestore.requestStream");

  // firebase-admin 은 서브패스 export 를 막아 두었으므로 패키지 루트에서 내부 모듈을 직접 잡는다.
  const adminEntry = requireFromFunctions.resolve("firebase-admin");
  const adminRoot = adminEntry.slice(0, adminEntry.indexOf("firebase-admin") + "firebase-admin".length);
  const apiRequest = requireFromFunctions(join(adminRoot, "lib", "utils", "api-request.js"));
  seal(apiRequest.HttpClient.prototype, "send", "firebase-admin HttpClient.send");
  seal(apiRequest.HttpClient.prototype, "sendWithRetry", "firebase-admin HttpClient.sendWithRetry");

  // 환경 경로로 닿을 수 있는 자격증명 출처도 함께 닫는다(봉인의 대체재가 아니라 보조 방어다).
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  process.env.METADATA_SERVER_DETECTION = "none";

  Object.defineProperty(globalThis, NODE_LANE_SEAL_MARKER, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      errorCode: NODE_LANE_SEAL_ERROR_CODE,
      surfaces: Object.freeze([...sealedSurfaces]),
      installedAtIso: new Date().toISOString(),
    }),
  });
}

installSeal();
