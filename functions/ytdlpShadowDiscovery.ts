/**
 * W63 Phase 1 — yt-dlp 섀도 발굴 레인: 잡 계약과 프로듀서
 *
 * 정본: `.omx/plans/prd-ytdlp-shadow-discovery.md` §5.2, 테스트 스펙 C1·C2·C3·F1·F2.
 *
 * 이 파일은 **잡을 만들 수 있는 유일한 경로**다. 그리고 기본값은 꺼져 있다.
 *
 * ■ 활성화 조건 (리더 L2026-0810-30 완화 반영)
 *   원안은 "서면 컴플라이언스 승인 문서"였고, 헤세 지시로 **리더 활성화 지시**로 바뀌었다.
 *   완화된 것은 *무엇을 근거로 켜는가* 하나뿐이다 — default-OFF·킬스위치·fail-closed·
 *   금지 트리거·metadata-only·운영 컬렉션 0쓰기는 전부 그대로다.
 *   활성화 기록 자체는 리더가 남긴다. 이 코드는 **기록 없이는 켜질 수 없는 구조**만 만든다.
 *
 * ■ 왜 트리거를 이렇게까지 좁히는가 (PRD §3.4·사전부검 3번)
 *   쿼터 소진·403·429·일일 리셋·캠페인 shortfall·메일 리필로 yt-dlp 를 부르는 순간, 그건
 *   "쿼터 제한을 우회하는 자동화"로 읽힌다. 기술적 격리는 법적 승인이 아니다. 그래서 트리거를
 *   화이트리스트(명시 오퍼레이터/카나리)로 두고, 나머지는 **호출자가 무슨 사유를 싣든** 거절한다.
 */
import { createHash } from "node:crypto";

// W63 델타 M6: 리프 모듈에서 가져온다. discovery.ts 경유였을 때는 firebase-admin 이 전이로 딸려와
//   "프로듀서는 순수 함수"라는 단정이 텍스트로만 참이었다.
import { SHADOW_DISCOVERY_JOB_TYPE } from "./discoveryJobTypes";
import {
  assertShadowTestSeamAllowed,
  loadShadowActivation,
  loadShadowActivationForTest,
  resolveShadowRuntimeEnvironment,
  resolveShadowRuntimeEnvironmentForTest,
  shadowLaneEnabled,
  shadowLaneEnabledForTest,
  type ShadowActivationTestSeams,
} from "./ytdlpShadowActivation";

export const SHADOW_DISCOVERY_ENGINE = "yt-dlp" as const;
export const SHADOW_DISCOVERY_MODE = "observation_only" as const;
export const SHADOW_DISCOVERY_SCHEMA_VERSION = 1 as const;

/** 이 값들만 잡을 만들 수 있다. 나머지는 전부 거절이다(스펙 C3). */
export const SHADOW_ALLOWED_TRIGGERS: readonly string[] = Object.freeze([
  "operator_manual",
  "leader_canary",
  // W75: 리더가 승인한 별도 promotion scheduler만 쓰는 명시 트리거. shortfall·쿼터·HTTP 오류는
  // 아래 금지 목록에 계속 남고, 활성화 문서·킬스위치·metadata-only 계약을 모두 통과해야 한다.
  "scheduled_promotion",
]);

/**
 * 명시적으로 **금지된** 트리거(스펙 C2). 화이트리스트만으로도 막히지만, 이 목록을 따로 두는 이유는
 * 사유 코드를 남기기 위해서다 — "왜 안 만들어졌나"가 `shadow_trigger_prohibited:quota_exhausted`
 * 처럼 정확히 나와야 운영자가 우회를 시도하지 않는다. 틀린 사유는 없는 사유보다 비싸다.
 */
export const SHADOW_PROHIBITED_TRIGGERS: readonly string[] = Object.freeze([
  "quota_exhausted",
  "quota_below_threshold",
  "http_403",
  "http_429",
  "api_timeout",
  "daily_quota_reset",
  "campaign_shortfall",
  "mail_refill_shortfall",
  "discovery_shortfall",
]);

export const SHADOW_CAPS = Object.freeze({
  maxQueries: 20,
  maxItemsPerQuery: 50,
  timeoutMs: 10 * 60 * 1000,
  maxRetries: 2,
  maxOutputBytes: 8 * 1024 * 1024,
});

// W63 델타 C3: 활성화 타입·검증·킬스위치는 **신뢰 소스 모듈**(ytdlpShadowActivation.ts)이 소유한다.
//   여기서 호출자 파라미터로 받으면 "기록 없이는 못 켠다"가 코드보다 강한 주장이 된다.
export type { ShadowActivationRecord } from "./ytdlpShadowActivation";

export type ShadowJobRequest = {
  readonly runId: string;
  readonly sourceRunRef: string;
  // W63 델타 C3: environment 를 호출자에게서 받지 않는다. 런타임에서 해석해 활성화와 대조한다.
  readonly trigger: string;
  readonly queryPlan: readonly string[];
  readonly maxQueries?: number;
  readonly maxItemsPerQuery?: number;
  readonly scope?: { readonly programId?: string; readonly campaignId?: string; readonly canonicalProgramId?: string };
};

export type ShadowJobRejection = { readonly ok: false; readonly reasonCode: string; readonly detail: string };
export type ShadowJobAccepted = { readonly ok: true; readonly job: Record<string, unknown> };
export type ShadowJobResult = ShadowJobAccepted | ShadowJobRejection;

const reject = (reasonCode: string, detail: string): ShadowJobRejection => ({ ok: false, reasonCode, detail });
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

// W63 델타 C3: 킬스위치와 활성화 검증은 ytdlpShadowActivation.ts 로 옮겼다.
//   · shadowLaneEnabled — process.env 고정(주입은 테스트 전용으로 좁힘)
//   · loadShadowActivation — 서버 소유 Firestore 문서에서 **조회**해서 검증
//   · resolveShadowRuntimeEnvironment — 환경을 런타임에서 해석
// 호출자는 "어느 활성화를 쓸지"만 말할 수 있고 "활성화가 유효하다"고 말할 수는 없다.

/** 트리거 검증(스펙 C2·C3). 금지 사유를 **먼저** 본다 — 사유 코드를 정확히 남기기 위해서다. */
export function validateShadowTrigger(trigger: string): ShadowJobRejection | null {
  const value = text(trigger);
  if (!value) return reject("shadow_trigger_missing", "트리거가 없다 — 명시 카나리 의도가 필요하다");
  if (SHADOW_PROHIBITED_TRIGGERS.includes(value)) {
    return reject(`shadow_trigger_prohibited:${value}`, "쿼터/에러/부족 조건은 섀도 레인을 켤 수 없다");
  }
  if (!SHADOW_ALLOWED_TRIGGERS.includes(value)) {
    return reject("shadow_trigger_not_allowed", "허용 목록에 없는 트리거다");
  }
  return null;
}

/** 쿼리 계획 해시. 같은 계획·같은 스키마면 같은 값이어야 한다(스펙 F2). */
export function shadowQueryPlanHash(queryPlan: readonly string[]): string {
  const normalized = [...new Set(queryPlan.map((q) => text(q)).filter(Boolean))].sort();
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 32);
}

/**
 * 결정적 멱등키(스펙 F2). 활성화 스코프·런·쿼리계획·스키마버전에서 유도한다.
 * 같은 입력이면 같은 키 → 같은 논리 런 하나. 중복 배달이 관측치를 부풀리지 않는다.
 */
export function shadowIdempotencyKey(input: {
  activationRef: string;
  runId: string;
  queryPlanHash: string;
  schemaVersion: number;
}): string {
  const seed = [text(input.activationRef), text(input.runId), text(input.queryPlanHash), String(input.schemaVersion)].join("\u0000");
  return `ytdlp_shadow_${createHash("sha256").update(seed).digest("hex").slice(0, 40)}`;
}

/**
 * 섀도 잡 문서를 만든다 — **만들기만 한다**. 여기서 Firestore 에 쓰지 않는다.
 *
 * W63 델타 C3: 활성화는 호출자가 주는 객체가 아니라 **activationId 로 조회**한다.
 *   환경도 호출자가 아니라 런타임에서 해석해 활성화 문서와 대조한다.
 *   즉 호출자가 할 수 있는 말은 "이 활성화를 쓰겠다"까지이고, "이 활성화는 유효하다"는 아니다.
 *   조회 자체는 읽기라 여전히 운영 컬렉션에 아무것도 쓰지 않는다.
 *
 * W63 2차 델타 MAJOR-3: 그 C3 경계가 **seam 하나로 다시 열려 있었다**.
 *   `options.reader`/`options.testEnvOverride` 가 일반 파라미터였고 "테스트 전용"은 주석뿐이었다.
 *   reader 를 주면 활성화 조회가 통째로 위조되고, testEnvOverride 를 주면 킬스위치와 환경 대조가
 *   동시에 무력해진다 — C3 이 닫은 것을 정확히 되돌리는 인자다.
 *   프로덕션 진입점에서 seam 파라미터를 **삭제**했다(타입 레벨 차단). 주입이 필요한 테스트는
 *   `buildShadowDiscoveryJobForTest` 를 쓰고, 그 진입점은 프로덕션 런타임에서 던진다.
 */
async function buildShadowDiscoveryJobInternal(
  request: ShadowJobRequest,
  activationId: string,
  nowIso: string,
  seams: ShadowActivationTestSeams | null,
): Promise<ShadowJobResult> {
  // seams 가 null 인 경로가 프로덕션이다. 분기 자체가 호출자에게 노출되지 않는다.
  if (!(seams ? shadowLaneEnabledForTest(seams.env) : shadowLaneEnabled())) {
    return reject("shadow_lane_disabled", "섀도 레인이 꺼져 있다(기본값)");
  }
  const triggerRejection = validateShadowTrigger(request.trigger);
  if (triggerRejection) return triggerRejection;

  const loaded = seams
    ? await loadShadowActivationForTest(activationId, nowIso, seams)
    : await loadShadowActivation(activationId, nowIso);
  if (!loaded.ok) return reject(loaded.reasonCode, loaded.detail);
  const activation = loaded.activation;
  const runtimeEnvironment = seams
    ? resolveShadowRuntimeEnvironmentForTest(seams.env)
    : resolveShadowRuntimeEnvironment();

  const runId = text(request.runId);
  if (!runId) return reject("shadow_run_id_missing", "runId 가 없다");
  if (!text(request.sourceRunRef)) return reject("shadow_source_run_ref_missing", "sourceRunRef 가 없다");

  const queryPlan = [...new Set(request.queryPlan.map((q) => text(q)).filter(Boolean))];
  if (queryPlan.length === 0) return reject("shadow_query_plan_empty", "쿼리 계획이 비어 있다");

  const maxQueries = request.maxQueries ?? SHADOW_CAPS.maxQueries;
  const maxItemsPerQuery = request.maxItemsPerQuery ?? SHADOW_CAPS.maxItemsPerQuery;
  // 상한은 낮추는 방향으로만 받는다. 호출자가 올리면 캡이 캡이 아니다.
  if (!Number.isInteger(maxQueries) || maxQueries < 1 || maxQueries > SHADOW_CAPS.maxQueries) {
    return reject("shadow_cap_max_queries_invalid", `maxQueries 는 1..${SHADOW_CAPS.maxQueries} 여야 한다`);
  }
  if (!Number.isInteger(maxItemsPerQuery) || maxItemsPerQuery < 1 || maxItemsPerQuery > SHADOW_CAPS.maxItemsPerQuery) {
    return reject("shadow_cap_max_items_invalid", `maxItemsPerQuery 는 1..${SHADOW_CAPS.maxItemsPerQuery} 여야 한다`);
  }
  if (queryPlan.length > maxQueries) {
    return reject("shadow_query_plan_over_cap", "쿼리 계획이 상한을 넘는다");
  }
  // 스코프 충돌은 fail-closed(스펙 F1). 캠페인만 있고 프로그램이 없으면 귀속이 모호하다.
  const scope = request.scope ?? {};
  if (text(scope.campaignId) && !text(scope.programId)) {
    return reject("shadow_scope_campaign_without_program", "캠페인 스코프에 프로그램이 없다");
  }
  if (text(scope.canonicalProgramId) && text(scope.programId)
    && text(scope.canonicalProgramId) !== text(scope.programId)) {
    return reject("shadow_scope_program_conflict", "정규 프로그램 ID 가 서로 다르다");
  }

  const queryPlanHash = shadowQueryPlanHash(queryPlan);
  // W63 델타 M7: PRD §5.2 필드명 계약 복원. L-30 은 *무엇을 근거로 켜는가* 를 완화한 것이지
  //   필드 삭제 승인이 아니었다. 활성화 참조를 이 필드로 싣고, **활성화 주체 신원**을 함께 남긴다
  //   — 누가 켰는지가 없으면 사후에 "왜 켜져 있었나"를 물을 대상이 없다.
  const providerPolicyApprovalRef = text(activation.providerPolicyApprovalRef);
  return {
    ok: true,
    job: {
      type: SHADOW_DISCOVERY_JOB_TYPE,
      engine: SHADOW_DISCOVERY_ENGINE,
      mode: SHADOW_DISCOVERY_MODE,
      schemaVersion: SHADOW_DISCOVERY_SCHEMA_VERSION,
      status: "queued",
      // 운영 쓰기 금지를 잡 문서에 **명시**로 박는다. 워커가 이 값을 다시 확인한다.
      operationalWritesAllowed: false,
      providerPolicyApprovalRef,
      activatedBy: text(activation.activatedBy),
      activationId: text(activationId),
      activationExpiresAtIso: text(activation.expiresAtIso),
      environment: runtimeEnvironment,
      trigger: text(request.trigger),
      runId,
      sourceRunRef: text(request.sourceRunRef),
      queryPlan,
      queryPlanHash,
      idempotencyKey: shadowIdempotencyKey({
        activationRef: providerPolicyApprovalRef,
        runId,
        queryPlanHash,
        schemaVersion: SHADOW_DISCOVERY_SCHEMA_VERSION,
      }),
      maxQueries,
      maxItemsPerQuery,
      timeoutMs: SHADOW_CAPS.timeoutMs,
      maxRetries: SHADOW_CAPS.maxRetries,
      maxOutputBytes: SHADOW_CAPS.maxOutputBytes,
      ...(text(scope.programId) ? { programId: text(scope.programId) } : {}),
      ...(text(scope.campaignId) ? { campaignId: text(scope.campaignId) } : {}),
      ...(text(scope.canonicalProgramId) ? { canonicalProgramId: text(scope.canonicalProgramId) } : {}),
      queuedAtIso: nowIso,
      createdAtIso: nowIso,
    },
  };
}

/**
 * 프로덕션 진입점. seam 파라미터가 **없다** — 활성화는 서버 소유 Firestore 에서만 오고,
 * 킬스위치·환경은 프로세스 env 에서만 온다. 호출자가 줄 수 있는 것은 요청·활성화 ID·시각뿐이다.
 */
export async function buildShadowDiscoveryJob(
  request: ShadowJobRequest,
  activationId: string,
  nowIso: string,
): Promise<ShadowJobResult> {
  return buildShadowDiscoveryJobInternal(request, activationId, nowIso, null);
}

/**
 * 테스트 전용 진입점. 활성화 reader 와 env 를 주입한다.
 * 프로덕션 런타임(NODE_ENV=production 또는 FLU_ENV/프로젝트가 production)에서는 던진다 —
 * 이름만으로는 라이브러리 import 를 막을 수 없으니 런타임에서도 한 번 더 막는다.
 */
export async function buildShadowDiscoveryJobForTest(
  request: ShadowJobRequest,
  activationId: string,
  nowIso: string,
  seams: ShadowActivationTestSeams = {},
): Promise<ShadowJobResult> {
  assertShadowTestSeamAllowed("buildShadowDiscoveryJobForTest");
  return buildShadowDiscoveryJobInternal(request, activationId, nowIso, seams);
}
