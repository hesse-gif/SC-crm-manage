/**
 * W63 공통 테스트 seam 가드.
 *
 * 프로덕션 진입점에 writer/env 같은 주입축을 두지 않되, 계약 테스트는 외부 시스템 없이
 * 실행해야 한다. `ForTest` seam 은 이 의존 없는 리프 모듈의 가드를 반드시 먼저 통과한다.
 * firebase-admin 을 import 하지 않으므로 이 가드를 쓰는 모듈에 DB 접근이 전이되지 않는다.
 */
const text = (value: unknown): string => (typeof value === "string" ? value.trim().toLowerCase() : "");

export type ShadowRuntimeEnvironment = "production" | "staging" | "emulator";
export type ShadowRuntimeEnvironmentResolution = Readonly<{
  environment: ShadowRuntimeEnvironment;
  resolved: boolean;
}>;

/**
 * 섀도 런타임 환경 판정의 단일 정본.
 *
 * R1 P1-6: 종전에는 FLU_ENV 를 먼저 읽어 production 프로젝트에서도 `staging`으로
 * 위장할 수 있었고, 아무 신호도 없으면 테스트 seam 이 열렸다. 프로젝트/런타임의 production
 * 신호가 항상 이기며, 서로 충돌하거나 판정할 수 없는 조합도 production 으로 닫는다.
 */
export function resolveShadowRuntimeEnvironmentResolutionFrom(
  env: Record<string, string | undefined>,
): ShadowRuntimeEnvironmentResolution {
  const nodeEnvironment = text(env.NODE_ENV);
  const explicitEnvironment = text(env.FLU_ENV);
  const projects = [text(env.GCLOUD_PROJECT), text(env.GOOGLE_CLOUD_PROJECT)].filter(Boolean);

  if (
    nodeEnvironment === "production"
    || explicitEnvironment === "production"
    || projects.includes("influchat-77db6")
  ) {
    return { environment: "production", resolved: true };
  }

  if (projects.length > 0) {
    const onlyEmulatorProject = projects.every((project) => project === "demo-flu");
    if (onlyEmulatorProject && (!explicitEnvironment || explicitEnvironment === "emulator")) {
      return { environment: "emulator", resolved: true };
    }
    // 모르는 프로젝트 또는 프로젝트/FLU_ENV 충돌은 비프로덕션이라고 추측하지 않는다. seam 을
    // 닫기 위한 안전 환경은 production이지만 activation과 대조할 만큼 해석됐다고 표시하지 않는다.
    return { environment: "production", resolved: false };
  }

  if (explicitEnvironment === "staging" || explicitEnvironment === "emulator") {
    return { environment: explicitEnvironment, resolved: true };
  }

  // 신호 부재·오타·새 환경은 seam 을 여는 근거가 아니다. 다만 이 production은 안전 기본값이지
  // 실제 environment를 식별했다는 뜻이 아니므로 activation 검증에는 resolved:false를 전달한다.
  return { environment: "production", resolved: false };
}

/** seam 게이트용 안전 환경. 판정 불능도 production으로 닫는 R1 계약을 유지한다. */
export function resolveShadowRuntimeEnvironmentFrom(
  env: Record<string, string | undefined>,
): ShadowRuntimeEnvironment {
  return resolveShadowRuntimeEnvironmentResolutionFrom(env).environment;
}

export class ShadowTestSeamError extends Error {
  readonly reasonCode = "shadow_test_seam_forbidden";
  readonly killSwitch = true;

  constructor(seam: string) {
    super(`shadow_test_seam_forbidden: ${seam} 은 테스트 전용 진입점이다 — 프로덕션 런타임에서는 열리지 않는다`);
    this.name = "ShadowTestSeamError";
  }
}

/** 주입값이 아니라 실제 프로세스 환경만 보고 fail-closed 로 판정한다. */
export function shadowRuntimeIsProduction(): boolean {
  return resolveShadowRuntimeEnvironmentFrom(process.env) === "production";
}

export function assertShadowTestSeamAllowed(seam: string): void {
  if (shadowRuntimeIsProduction()) throw new ShadowTestSeamError(seam);
}
