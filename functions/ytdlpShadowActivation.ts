/**
 * W63 델타 C3 — 섀도 활성화의 **신뢰 소스**와 런타임 환경 해석
 *
 * ■ 무엇이 문제였나 (이중 리뷰 CRITICAL 수렴)
 *   1-b 커밋에서 활성화 근거·환경·킬스위치가 **전부 호출자 파라미터**였다.
 *   `buildShadowDiscoveryJob(request, activation, nowIso, env)` — 넷 다 호출자가 준다.
 *   프로덕션 호출부는 0 이었으니 아무도 거짓말을 한 적은 없지만, "기록 없이는 켜질 수 없는 구조"는
 *   **코드보다 강한 주장**이었다. 호출자가 활성화 객체를 지어내면 그대로 통과한다.
 *
 * ■ 수리 방향
 *   활성화는 **서버가 소유한 Firestore 문서에서 ID 로 조회**한다. 환경은 **런타임에서 해석**하고
 *   활성화 문서의 environment 와 대조한다. 호출자는 "어느 활성화를 쓸지"만 말할 수 있고,
 *   "활성화가 유효하다"고 말할 수는 없다.
 *
 * ■ fail-open 잔가지 제거 (적대 C3 · M1)
 *   · nowIso 파싱 실패는 거절이다. NaN 비교는 항상 false 라 만료 검사가 **통과**해 버린다.
 *   · revoked 는 `=== true` 만 보면 문자열 "true" 가 통과한다. `!== false && !== undefined` 면 거절.
 *     "취소됐는지 모르겠다"는 "취소 안 됐다"가 아니다.
 */
import { adminDb } from "./firebaseAdmin";
import {
  assertShadowTestSeamAllowed,
  resolveShadowRuntimeEnvironmentFrom,
  resolveShadowRuntimeEnvironmentResolutionFrom,
  shadowRuntimeIsProduction,
} from "./ytdlpShadowTestSeam";

export {
  ShadowTestSeamError,
  assertShadowTestSeamAllowed,
  resolveShadowRuntimeEnvironmentFrom,
  resolveShadowRuntimeEnvironmentResolutionFrom,
  shadowRuntimeIsProduction,
} from "./ytdlpShadowTestSeam";

/** 활성화 문서가 사는 곳. 서버 소유 — 호출자가 경로를 바꿀 수 없다. */
export const SHADOW_ACTIVATION_COLLECTION = "ytdlp_shadow_activations";

export type ShadowActivationRecord = {
  readonly providerPolicyApprovalRef: string;
  readonly activatedBy: string;
  readonly expiresAtIso: string;
  readonly environment: string;
  readonly revoked?: unknown;
};

export type ShadowActivationFailure = { readonly ok: false; readonly reasonCode: string; readonly detail: string };
export type ShadowActivationOk = { readonly ok: true; readonly activation: ShadowActivationRecord };
export type ShadowActivationResult = ShadowActivationOk | ShadowActivationFailure;

const fail = (reasonCode: string, detail: string): ShadowActivationFailure => ({ ok: false, reasonCode, detail });
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * W63 2차 델타 MAJOR-3 — 테스트 seam 을 **구조로** 좁힌다.
 *
 * 종전에는 `resolveShadowRuntimeEnvironment(env)`·`shadowLaneEnabled(testEnvOverride)`·
 * `loadShadowActivation(..., { reader })` 가 전부 **일반 파라미터**였고, "테스트 전용"은
 * 주석에만 있었다. 주석은 컴파일되지 않는다 — 프로덕션 호출부가 env 를 지어내면 킬스위치가
 * 켜지고, reader 를 지어내면 활성화 조회가 통째로 위조된다. C3 이 닫은 신뢰 경계가
 * seam 하나로 다시 열려 있었던 것이다.
 *
 * 두 겹으로 닫는다:
 *   (1) **함수 분리** — 프로덕션 진입점은 seam 파라미터를 아예 안 받는다. 타입 레벨에서
 *       주입이 불가능하고, `ForTest` 라는 이름이 프로덕션 코드에 나타나면 grep/리뷰에 걸린다.
 *   (2) **런타임 게이팅** — `ForTest` 진입점은 프로덕션 런타임에서 던진다. 라이브러리로
 *       import 해서 부르는 경로까지 막는다.
 */
/**
 * 런타임 환경 해석. 호출자 파라미터가 아니라 **프로세스가 실제로 어디서 도는지**를 본다.
 * 프로젝트 ID·FLU_ENV·NODE_ENV의 우선순위와 판정 불능 처리는 공통 seam 모듈 한 곳이 소유한다.
 */
export function resolveShadowRuntimeEnvironment(): string {
  return resolveShadowRuntimeEnvironmentFrom(process.env);
}

/** 테스트 전용: 환경 해석을 가짜 env 로 돌린다. */
export function resolveShadowRuntimeEnvironmentForTest(env?: Record<string, string | undefined>): string {
  assertShadowTestSeamAllowed("resolveShadowRuntimeEnvironmentForTest");
  return resolveShadowRuntimeEnvironmentFrom(env ?? process.env);
}

/**
 * 킬스위치. 정확히 "true" 일 때만 켜진다 — 느슨한 파서는 오타 한 번으로 켜진다.
 * 파라미터가 **없다**. 켜고 끄는 근거는 프로세스 환경 하나뿐이다.
 */
export function shadowLaneEnabled(): boolean {
  return process.env.FLU_YTDLP_SHADOW_ENABLED === "true";
}

/** 테스트 전용: 킬스위치를 가짜 env 로 판정한다. */
export function shadowLaneEnabledForTest(env?: Record<string, string | undefined>): boolean {
  assertShadowTestSeamAllowed("shadowLaneEnabledForTest");
  return (env ?? process.env).FLU_YTDLP_SHADOW_ENABLED === "true";
}

/** 활성화 문서 자체의 유효성. 조회 결과에만 적용한다. */
export function validateShadowActivationRecord(
  record: ShadowActivationRecord | null,
  runtimeEnvironment: string,
  runtimeEnvironmentResolved: boolean,
  nowIso: string,
): ShadowActivationFailure | null {
  if (!record) return fail("shadow_activation_missing", "활성화 문서를 찾을 수 없다");
  if (!text(record.providerPolicyApprovalRef)) {
    return fail("shadow_activation_ref_empty", "providerPolicyApprovalRef 가 비어 있다");
  }
  if (!text(record.activatedBy)) {
    return fail("shadow_activation_actor_missing", "activatedBy(활성화 주체)가 없다");
  }
  // "취소됐는지 모르겠다"는 "취소 안 됐다"가 아니다. false 이거나 아예 없을 때만 통과.
  if (record.revoked !== false && record.revoked !== undefined) {
    return fail("shadow_activation_revoked", "활성화가 취소됐거나 취소 상태를 읽을 수 없다");
  }
  const nowMs = Date.parse(text(nowIso));
  if (!Number.isFinite(nowMs)) {
    // NaN 은 어떤 비교에서도 false 라 만료 검사를 조용히 통과시킨다.
    return fail("shadow_activation_now_invalid", "현재 시각을 읽을 수 없다");
  }
  const expiresAtIso = text(record.expiresAtIso);
  if (!expiresAtIso) return fail("shadow_activation_expiry_missing", "만료 시각이 없다");
  const expiresMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresMs)) return fail("shadow_activation_expiry_invalid", "만료 시각을 읽을 수 없다");
  if (expiresMs <= nowMs) return fail("shadow_activation_expired", "활성화가 만료됐다");
  if (!runtimeEnvironmentResolved) {
    return fail("shadow_runtime_environment_unresolved", "런타임 환경을 해석할 수 없다");
  }
  if (text(record.environment) !== runtimeEnvironment) {
    return fail("shadow_activation_scope_mismatch", "활성화 환경과 실행 환경이 다르다");
  }
  return null;
}

export type ShadowActivationReader = (activationId: string) => Promise<ShadowActivationRecord | null>;

const defaultReader: ShadowActivationReader = async (activationId) => {
  const snapshot = await adminDb.collection(SHADOW_ACTIVATION_COLLECTION).doc(activationId).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data() ?? {};
  return {
    providerPolicyApprovalRef: text(data.providerPolicyApprovalRef),
    activatedBy: text(data.activatedBy),
    expiresAtIso: text(data.expiresAtIso),
    environment: text(data.environment),
    revoked: data.revoked,
  };
};

/** 테스트 전용 seam 묶음. 프로덕션 진입점은 이 타입을 **받지 않는다**. */
export type ShadowActivationTestSeams = {
  readonly reader?: ShadowActivationReader;
  readonly env?: Record<string, string | undefined>;
};

async function loadShadowActivationInternal(
  activationId: string,
  nowIso: string,
  seams: ShadowActivationTestSeams | null,
): Promise<ShadowActivationResult> {
  const id = text(activationId);
  if (!id) return fail("shadow_activation_id_missing", "활성화 ID 가 없다");
  const runtimeEnvironment = resolveShadowRuntimeEnvironmentResolutionFrom(seams?.env ?? process.env);
  const reader = seams?.reader ?? defaultReader;
  let record: ShadowActivationRecord | null = null;
  try {
    record = await reader(id);
  } catch (error) {
    // 조회 실패는 "활성화 없음"과 같게 다룬다 — 읽기 장애가 활성화로 읽히면 안 된다.
    return fail("shadow_activation_read_failed", `활성화 조회에 실패했다: ${(error as Error)?.message ?? ""}`.slice(0, 200));
  }
  const invalid = validateShadowActivationRecord(
    record,
    runtimeEnvironment.environment,
    runtimeEnvironment.resolved,
    nowIso,
  );
  if (invalid) return invalid;
  return { ok: true, activation: record! };
}

/**
 * 활성화를 **조회해서** 검증한다. 소비자는 이 함수만 쓴다 — 활성화 객체를 직접 받지 않는다.
 *
 * W63 2차 델타 MAJOR-3: seam 파라미터를 **없앴다**. 종전 시그니처는 `{ reader, env }` 를
 * 받았고 주석만 "테스트 전용"이었다 — 호출자가 reader 를 주면 활성화 조회가 통째로 위조된다.
 * 프로덕션 경로에서 활성화는 서버 소유 Firestore 문서 하나에서만 온다.
 */
export async function loadShadowActivation(activationId: string, nowIso: string): Promise<ShadowActivationResult> {
  return loadShadowActivationInternal(activationId, nowIso, null);
}

/** 테스트 전용: 활성화 조회를 가짜 reader/env 로 돌린다. */
export async function loadShadowActivationForTest(
  activationId: string,
  nowIso: string,
  seams: ShadowActivationTestSeams = {},
): Promise<ShadowActivationResult> {
  assertShadowTestSeamAllowed("loadShadowActivationForTest");
  return loadShadowActivationInternal(activationId, nowIso, seams);
}
