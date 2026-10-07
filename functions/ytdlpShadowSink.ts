/**
 * W63 Phase 1 — 섀도 쓰기 경계와 증거 싱크
 *
 * 정본: PRD §5.4·§7-7, 테스트 스펙 E1·E2·E3·E4.
 *
 * ■ 왜 "쓰지 마라"가 아니라 게이트인가
 *   PRD 사전부검 1번이 "워커가 운영 컬렉션에 직접 쓰고 검증 전에 캠페인 후보를 활성화했다"이다.
 *   주석으로 금지하면 다음 사람이 못 본다. 그래서 **쓰기 경로를 함수 하나로 좁히고**, 그 함수가
 *   허용 목록 밖이면 던진다. 금지 목록이 아니라 허용 목록인 이유: 새 운영 컬렉션이 생겨도
 *   자동으로 막힌다(fail-closed). 금지 목록은 새 컬렉션이 생길 때마다 사람이 기억해야 한다.
 *
 * ■ 킬스위치
 *   금지 쓰기 시도는 "막고 계속"이 아니라 **런 실패 + 킬스위치**다(PRD §5.4 마지막 문단).
 *   한 번이라도 새면 그 레인의 관측 전부를 믿을 수 없기 때문이다.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Timestamp } from "firebase-admin/firestore";
import { assertShadowTestSeamAllowed } from "./ytdlpShadowTestSeam";

// LOG-P0-010 180일 TTL: 값만 계산해 찍는다(firestore-admin의 Timestamp만 필요, ./firestoreTtl은
// 일부러 import하지 않는다) — 이 파일은 R2 P2-NEW-5(첫 소비자 모듈 그래프 고정 테스트,
// tests/w63-shadow-entrypoint-execution.test.mjs)로 전이 의존이 정확히 잠겨 있는 관측 전용
// 섀도 워커 경계다. 새 first-party 모듈을 여기 들이면 그 테스트가 깨진다 — 의도된 방어선이다.
const SHADOW_RUN_EXPIRE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

// P2-4 [적대 리뷰]: firestoreTtl.expireAt180DaysFromIso와 같은 유한성 가드를 로컬 복제한다 —
// 위 주석대로 그 모듈을 import할 수 없다(전이 의존 고정 테스트가 깨진다). finishedAtIso와
// startedAtIso가 둘 다 비어있거나 파싱 불가면 Date.parse가 NaN을 내고, 그걸 그대로
// Timestamp.fromMillis에 넘기면 원인이 안 보이는 SDK 예외가 난다 — 여기서 먼저 명확한
// RangeError로 fail-closed한다.
function finiteShadowRunBasisMs(value: number, source: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot derive shadow run TTL from invalid ${source}`);
  }
  return value;
}

/** 섀도가 쓸 수 있는 곳. 이 둘 말고는 없다(PRD §5.4 allowed writes). */
export const SHADOW_ALLOWED_COLLECTIONS: readonly string[] = Object.freeze([
  "discovery_shadow_runs",
  "workflow_jobs",
]);

/**
 * 참고용 명시 목록 — 게이트는 허용 목록으로 판정한다. 이 목록은 **사유 코드를 구체적으로**
 * 남기려고 둔다(어떤 클래스의 운영 컬렉션을 건드렸는지가 알림에 그대로 떠야 한다).
 */
export const SHADOW_FORBIDDEN_COLLECTIONS: readonly string[] = Object.freeze([
  "candidate_pool",
  "campaign_candidates",
  "program_campaign_targets",
  "campaigns",
  "campaign_outreach",
  "mail_outbox",
  "mail_outbound_log",
  "scp_coldmail_history",
  "program_outreach_dedup",
  "scp_application_management",
  "creators",
  "conversations",
]);

/** 섀도 결과가 절대 실을 수 없는 필드(스펙 E4). 권위 있는 준비 상태를 만들 수 없다. */
export const SHADOW_FORBIDDEN_RESULT_FIELDS: readonly string[] = Object.freeze([
  "ready",
  "selectedForKpi",
  "sendable",
  "approved",
  "deliveryState",
  "humanGate",
]);

export class ShadowWriteBoundaryError extends Error {
  readonly reasonCode: string;
  readonly killSwitch = true;
  constructor(reasonCode: string, message: string) {
    // 사유 코드를 **메시지 안에** 넣는다. 이 에러는 알림/로그로 그대로 흘러가는데, 거기서
    // reasonCode 프로퍼티까지 꺼내 보는 경로가 없으면 운영자는 "막혔다"만 보고 "왜"를 못 본다.
    // 사유는 항상 사람이 읽는 자리에 있어야 한다.
    super(`${reasonCode}: ${message}`);
    this.name = "ShadowWriteBoundaryError";
    this.reasonCode = reasonCode;
  }
}

/**
 * 경로를 세그먼트로 쪼갠다. **정규화하지 않는다** — 앞뒤 슬래시·`//`·공백 세그먼트는
 * 고쳐 줄 대상이 아니라 거절 대상이다. 고쳐 주면 통과한 경로가 입력과 달라지고,
 * 그러면 로그에 남은 경로와 실제로 판정된 경로가 다른 것이 된다.
 */
const segmentsOf = (path: string): readonly string[] => String(path ?? "").split("/");

/**
 * 섀도 모드에서 이 경로에 써도 되는가. **허용 목록 판정**이다.
 *
 * W63 2차 델타 MAJOR-1 — 허용 목록이 **서브트리 허가**로 읽히고 있었다.
 *   종전 판정은 `split("/")[0]`(컬렉션)과 `[1]`(문서)만 봤고 **세그먼트 수를 안 봤다**.
 *   그래서 `workflow_jobs/{ownJobId}/candidate_pool/c1` 이 통과했다 — 허용된 문서 밑에
 *   운영 컬렉션 이름을 달기만 하면 게이트가 열렸다. `discovery_shadow_runs/run-1/creators/x`
 *   도 마찬가지다. 하위 트리는 부모 문서가 아니다.
 *
 *   이제 **세그먼트 수 정확 일치(=2)** 로 판정한다. 섀도가 쓰는 것은 최상위 컬렉션의 문서
 *   하나뿐이고, 하위 컬렉션이 정말 필요해지면 그때 계약을 넓히는 게 맞다(fail-closed).
 *   workflow_jobs 는 그중에서도 정확히 `workflow_jobs/{ownJobId}` 하나다.
 */
export function assertShadowWriteAllowed(path: string, ownJobId: string): void {
  const raw = String(path ?? "");
  if (!raw.trim()) {
    throw new ShadowWriteBoundaryError("shadow_write_path_invalid", `쓰기 경로가 비었다: ${path}`);
  }
  const segments = segmentsOf(raw);
  // 컬렉션 경로(1개)·서브트리(3개 이상)·빈 세그먼트를 한 사유로 묶는다. 셋 다 "최상위 문서 하나가
  // 아니다"이고, 그 모양이 이 게이트가 아는 유일한 모양이다.
  if (segments.length !== 2 || segments.some((segment) => segment.trim() === "")) {
    throw new ShadowWriteBoundaryError(
      "shadow_write_path_not_document",
      `섀도는 최상위 컬렉션의 문서 하나에만 쓸 수 있다 — 세그먼트 ${segments.length}개 (경로 ${path})`,
    );
  }
  const [collection, docId] = segments;
  if (!SHADOW_ALLOWED_COLLECTIONS.includes(collection)) {
    const known = SHADOW_FORBIDDEN_COLLECTIONS.includes(collection) ? collection : "unlisted";
    throw new ShadowWriteBoundaryError(
      `shadow_forbidden_write:${known}`,
      `섀도 모드는 ${collection} 에 쓸 수 없다 (경로 ${path})`,
    );
  }
  // R1 P1-1: 두 허용 컬렉션 모두 **자기 잡 ID 문서 하나**만 쓴다. discovery_shadow_runs 를
  // 컬렉션 전체로 열어 두면 다른 런의 증거를 덮어쓸 수 있어 allowlist가 격리 경계가 아니다.
  // ownJobId 를 trim 해서 맞춰 주지 않는다 — 정확 일치만 허용한다.
  if (docId !== String(ownJobId ?? "")) {
    throw new ShadowWriteBoundaryError(
      "shadow_foreign_job_write",
      `섀도는 자기 잡(${ownJobId}) 문서 외에는 쓸 수 없다 (경로 ${path})`,
    );
  }
}

/** 중첩 payload 순회 상한. 이보다 깊으면 "검사 못 했다"이고, 그건 통과가 아니라 거절이다. */
export const SHADOW_PAYLOAD_MAX_DEPTH = 12;

const isMapLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 결과 payload 가 권위 있는 준비 상태를 참칭하지 않는지(스펙 E4).
 *
 * W63 2차 델타 MAJOR-2 — 한 겹만 보는 가드는 한 겹만 쓰면 되는 우회였다.
 *   종전에는 **top-level 키만** 봤다. `{ result: { ready: true } }` 는 그대로 통과했고,
 *   Firestore 는 중첩 맵을 그대로 저장하므로 소비자가 `doc.result.ready` 를 읽는 순간
 *   관측이 캠페인 상태로 읽힌다. 배열 원소(`{ items: [{ sendable: true }] }`)도 마찬가지였다.
 *
 *   이제 객체·배열을 **재귀 순회**한다. 사유 코드는 필드명 그대로 두고(알림 계약 유지) 어디서
 *   나왔는지는 메시지에 경로로 남긴다.
 *   깊이 초과·순환은 거절이다 — 검사하지 못한 것을 통과로 세는 게 fail-open 의 정의다.
 */
export function assertShadowResultNotAuthoritative(payload: Record<string, unknown>): void {
  // 조상 스택으로만 순환을 본다. 전역 방문 집합으로 하면 같은 객체를 두 자리에서 참조하는
  // 정상 payload(DAG)까지 순환으로 오탐한다.
  const ancestors = new Set<object>();

  const walk = (node: unknown, trail: string, depth: number): void => {
    if (!isMapLike(node) && !Array.isArray(node)) return;
    const where = trail || ".";
    if (depth > SHADOW_PAYLOAD_MAX_DEPTH) {
      throw new ShadowWriteBoundaryError(
        "shadow_payload_too_deep",
        `payload 가 검사 상한(${SHADOW_PAYLOAD_MAX_DEPTH})보다 깊다 — 검사되지 않은 깊이는 통과가 아니다 (경로 ${where})`,
      );
    }
    if (ancestors.has(node as object)) {
      throw new ShadowWriteBoundaryError(
        "shadow_payload_cyclic",
        `payload 에 순환 참조가 있다 — 전부 훑었다고 말할 수 없다 (경로 ${where})`,
      );
    }
    ancestors.add(node as object);

    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${trail}[${index}]`, depth + 1));
      ancestors.delete(node as object);
      return;
    }

    for (const field of SHADOW_FORBIDDEN_RESULT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(node, field)) {
        throw new ShadowWriteBoundaryError(
          `shadow_authoritative_field:${field}`,
          `섀도 결과는 ${field} 를 실을 수 없다 — 관측이 캠페인 상태로 읽힌다 (경로 ${trail ? `${trail}.${field}` : field})`,
        );
      }
    }
    // 드라이런 퍼널 투영은 허용하되 **비권위 라벨**이 반드시 붙어야 한다(스펙 E4 두 번째 조항).
    // 라벨은 투영을 들고 있는 **바로 그 객체**에 있어야 한다 — 조상에 한 번 붙이고 그 아래
    // 아무 투영이나 다는 걸 허용하면 라벨이 서류가 된다.
    if (Object.prototype.hasOwnProperty.call(node, "funnelProjection") && node.authoritative !== false) {
      throw new ShadowWriteBoundaryError(
        "shadow_projection_unlabeled",
        `드라이런 퍼널 투영에 authoritative:false 라벨이 없다 — 캠페인 상태로 소비될 수 있다 (경로 ${where})`,
      );
    }

    for (const [key, value] of Object.entries(node)) {
      walk(value, trail ? `${trail}.${key}` : key, depth + 1);
    }
    ancestors.delete(node as object);
  };

  walk(payload, "", 0);
}

export type ShadowRunSummary = {
  readonly runId: string;
  readonly jobId: string;
  readonly provider: "yt-dlp";
  readonly ytdlpVersion: string;
  readonly schemaVersion: number;
  readonly jobType: string;
  readonly queryPlanHash: string;
  readonly activationRef: string;
  readonly rawObservations: number;
  readonly uniqueChannels: number;
  readonly identityCompleteChannels: number;
  readonly schemaDrift: number;
  /**
   * W63 델타 M8: 신원 결측은 **런 실패가 아니다**(PRD §5.3 — flat 추출은 원래 신원을 자주 비운다).
   * 계약 위반(schemaDrift)과 예상된 결측을 한 통에 담으면 결측 1건이 canary 를 구조적으로 막는다.
   * 여기서는 세고 Phase 2 조회 후보로 남기기만 한다.
   */
  readonly identityIncomplete?: number;
  readonly operationalWrites: number;
  readonly leaseConflicts: number;
  readonly evidenceObject: string;
  readonly startedAtIso: string;
  readonly finishedAtIso: string;
  /** 실행/캡/활성화 실패처럼 집계값만으로 유도할 수 없는 터미널 실패 사유. */
  readonly terminalFailureReasons?: readonly string[];
};

/**
 * 요약 문서를 만든다. **성공으로 표시할 수 있는 조건**을 여기서 강제한다 —
 * 드리프트가 있는데 성공, 운영 쓰기가 있는데 성공, 증거 객체 없이 성공은 전부 불가능하다
 * (PRD §7-13 "스키마 드리프트는 성공으로 보고될 수 없다", 스펙 D4·E2·H3).
 *
 * W63 2차 델타 MAJOR-2(b) — **자기 가드가 첫 줄**이다.
 *   이 함수는 `...summary` 로 호출자 객체를 통째로 펼치면서 권위 가드를 한 번도 안 불렀다.
 *   그래서 shadowWrite 가 막는 필드를 요약에 실으면 그대로 문서가 됐다 — 게이트를 지나는
 *   payload 하나가 게이트를 거치지 않은 필드를 업고 들어가는 구조였다.
 *   만드는 쪽에서 가드를 부르지 않으면 "쓰기 통로가 하나"라는 계약이 통로 안에서 새어 나간다.
 */
export function buildShadowRunSummary(summary: ShadowRunSummary): Record<string, unknown> {
  assertShadowResultNotAuthoritative(summary as unknown as Record<string, unknown>);
  const failures: string[] = Array.isArray(summary.terminalFailureReasons)
    ? [...new Set(summary.terminalFailureReasons.filter((reason) => typeof reason === "string" && reason.trim()).map((reason) => reason.trim()))]
    : [];
  if (summary.operationalWrites !== 0) failures.push("operational_writes_nonzero");
  if (summary.leaseConflicts !== 0) failures.push("lease_conflicts_nonzero");
  if (summary.schemaDrift !== 0) failures.push("schema_drift_present");
  if (!summary.evidenceObject) failures.push("evidence_object_missing");
  if (!summary.ytdlpVersion) failures.push("provider_version_missing");
  const document: Record<string, unknown> = {
    ...summary,
    // 성공은 **유도되는 값**이다. 호출자가 status 를 직접 넘길 수 없다.
    status: failures.length === 0 ? "complete" : "failed",
    failureReasons: [...new Set(failures)],
    mode: "observation_only",
    operationalWritesAllowed: false,
    promotionEligible: false,
    // LOG-P0-010 180일 TTL: finishedAtIso 기준(비어 있으면 startedAtIso 폴백).
    expireAt: Timestamp.fromMillis(
      finiteShadowRunBasisMs(Date.parse(summary.finishedAtIso || summary.startedAtIso), "finishedAtIso/startedAtIso")
        + SHADOW_RUN_EXPIRE_AFTER_MS,
    ),
  };
  // 유도 필드까지 얹은 **최종 문서**로 한 번 더 본다. 나중에 이 함수가 필드를 더 붙일 때
  // 가드 밖에서 붙는 일이 없어야 한다.
  assertShadowResultNotAuthoritative(document);
  return document;
}

/**
 * W63 델타 C3(c) — 섀도가 쓰기를 하는 **유일한 통로**.
 *
 * 종전에는 assertShadowWriteAllowed 가 있었지만 그건 "호출해 주면 검사한다"였다.
 * 소비자가 안 부르고 adminDb 를 직접 쓰면 아무도 못 막는다 — 경계가 **관례**였지 구조가 아니었다.
 *
 * 이제 소비자는 이 래퍼만 쓴다. 래퍼가 경계 검사와 실제 쓰기를 한 함수 안에 묶으므로
 * "검사 없이 쓰기"라는 상태가 코드상 존재하지 않는다. writer 주입은 테스트 전용이고
 * 기본값은 서버 소유 Firestore 다.
 *
 * 막은 시도도 **센다**. 막았다고 없던 일이 되는 게 아니다 — 요약이 이 값으로 런을 실패시킨다.
 */
export type ShadowWriter = (path: string, data: Record<string, unknown>) => Promise<void>;

export type ShadowWriteContext = {
  readonly ownJobId: string;
  operationalWriteAttempts: number;
};

const defaultShadowWriter: ShadowWriter = async (path, data) => {
  // 이 모듈에서 Firestore 에 닿는 유일한 지점이다. 경계를 통과한 경로만 도달한다.
  const { adminDb } = await import("./firebaseAdmin");
  await adminDb.doc(path).set(data, { merge: true });
};

// R1 P1-7: 모듈 전역 writer 스위치는 한 테스트가 설치한 동안 같은 프로세스의 모든 쓰기를
// 가로챘다. AsyncLocalStorage 로 **호출 async 체인 하나**에만 writer를 붙이고, 실제 write 시점에도
// seam 가드를 다시 확인해 중간에 런타임 환경이 production으로 바뀐 경우 fail-closed 한다.
const shadowWriterForTest = new AsyncLocalStorage<ShadowWriter>();

export async function withShadowWriterForTest<T>(
  writer: ShadowWriter,
  operation: () => Promise<T>,
): Promise<T> {
  assertShadowTestSeamAllowed("withShadowWriterForTest");
  if (typeof writer !== "function") throw new TypeError("shadow_test_writer_invalid: writer 함수가 필요하다");
  if (typeof operation !== "function") throw new TypeError("shadow_test_operation_invalid: operation 함수가 필요하다");
  return shadowWriterForTest.run(writer, operation);
}

export async function shadowWrite(
  context: ShadowWriteContext,
  path: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    assertShadowWriteAllowed(path, context.ownJobId);
    assertShadowResultNotAuthoritative(data);
  } catch (error) {
    context.operationalWriteAttempts += 1;
    throw error;
  }
  const scopedTestWriter = shadowWriterForTest.getStore();
  if (scopedTestWriter) assertShadowTestSeamAllowed("withShadowWriterForTest");
  await (scopedTestWriter ?? defaultShadowWriter)(path, data);
}
