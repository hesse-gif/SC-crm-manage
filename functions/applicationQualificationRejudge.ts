// 수동 재판정 콜러블 — channel_not_found_pending_review 에 갇힌 신청(및 updatedAtIso desc
// 상위 창 밖이라 스윕이 영구히 못 닿는 미판정 신청)을 id 단건으로 다시 판정 파이프라인에 태운다.
//
// 배경(프로덕션 조사): scp_application_management 의 대부분 문서는 identity.channelId 가 계약상
// 비어 있다(지원 시점 OAuth 검증을 통과한 채널에만 채워진다). 그 문서들은 스윕이 YouTube 호출
// 없이 not_found 로 단락시켜 qualification 마커(terminal — 다시 스캔하지 않는다)를 남겼고,
// undoApplicationQualificationDecision 은 주석만 달 뿐 재판정하지 않는다. 게다가 스윕은
// updatedAtIso desc LIMIT 50 창만 훑어 오래된 문서는 창 밖에 있다.
//
// 그래서 이 콜러블은 마커를 지우고 끝내지 않고 **판정 자체를 문서별로 직접 다시 실행한다**
// (judgeApplicationEligibilityForRecord — 주기 스윕과 같은 함수: 같은 판정 코어, 같은 원장,
// 같은 일시실패 재시도, 같은 자동반려 게이트). 재판정 결과는 최초 결정을 덮어쓰지 않고 다음
// seq(application_qualification_decisions/<app>__<seq+1>)에 쓰고, 직전 결정에는 같은
// 트랜잭션에서 superseded 주석을 새긴다 — 원장 이력이 보존된다.
//
// 일시 실패(api_error/timeout)로 백오프에 들어간 재판정은 qualificationRetry 마커가 seq·감사
// 컨텍스트를 실어 다음 스윕 pass 가 이어 쓴다 — 문서가 스캔 창 밖이어도 마커는 남는다.
//
// 게이트: manager+ · 기본 dry-run(dryRun!==false) · 실제 실행은 confirm 토큰 필수
// (sheetLeadProgramScopeRepair.ts 와 같은 수리 콜러블 계약).
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { readSettings } from "./settings";
import { SCP_APPLICATION_MANAGEMENT_COLLECTION } from "./applicationManagementStore";
import {
  INITIAL_QUALIFICATION_DECISION_SEQ,
  latestApplicationQualificationDecision,
  sanitizeApplicationId,
} from "./applicationQualificationLedger";
import { judgeApplicationEligibilityForRecord } from "./applicationEligibilityJudgeSweep";
import type { YouTubeApiClient } from "./youtubeEnrichmentService";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  makeBehaviorLog,
  type CallableRequestShape,
  type Role,
} from "./shared";

const OPERATOR_ROLES: readonly Exclude<Role, "guest">[] = ["super_admin", "admin", "manager"];
const ACTION = "application_qualification.rejudge";
// 재판정 대상 마커 — 스윕이 channelId 없이 단락시켜 만든 terminal 마커다. 다른 reasonCode 는
// 실제 판정 결과이므로 사람이 명시적으로 재판정 범위를 넓히기 전까진 건드리지 않는다.
const REJUDGE_REASON_CODE = "channel_not_found_pending_review";
// 회당 상한 — 문서별 YouTube 왕복(해소 + 구독자 조회)이 직렬이므로 콜러블 타임아웃 예산 안에 둔다.
// 초과 입력은 조용히 자르지 않고 invalid-argument 로 거절한다(적대적 리뷰 F6) — 오퍼레이터가
// 55건을 2번에 나눠 보냈다고 착각하게 만들지 않는다.
const MAX_REJUDGE_IDS = 25;
// 콜러블 타임아웃(300s, index.ts 등록)보다 30초 일찍 새 id 처리를 멈춘다 — 문서별 직렬 왕복이
// 예산을 초과해 함수가 kill 되면 마지막 id 가 판정 도중 torn 상태로 남을 수 있다(적대적 리뷰 F2).
// 남은 id 는 "deferred" 로 보고해 오퍼레이터가 같은 파라미터로 다시 부르게 한다.
const REJUDGE_TIME_BUDGET_MS = 270_000;

export const APPLICATION_QUALIFICATION_REJUDGE_CONFIRMATION = "rejudge-application-qualification-v1";

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode: "invalid_argument_unauthorized" });
}

export interface RejudgeCandidate {
  id: string;
  // 비-문자열/빈 id 도 건별 error 엔트리로 보고한다 — 목록 하나가 깨졌다고 배치 전체를 죽이지
  // 않는다(적대적 리뷰 F6). invalidReason 이 있으면 id 는 빈 문자열이고 조회는 건너뛴다.
  invalidReason?: string;
}

// 입력 원본 순서를 유지하되 중복은 관리 문서 doc id 기준으로 합친다 — "a.b" 와 "a:b" 는
// sanitizeApplicationId 가 같은 doc id 로 정규화하므로 같은 문서를 두 번 판정하지 않는다.
// 순수 파서다(Firestore/YouTube 에 닿지 않는다) — 파싱 자체는 핸들러를 거치지 않고 직접 단위
// 테스트한다. 핸들러 경유 테스트는 dry-run 여도 코어가 관리 문서를 읽으러 adminDb 에 나가므로
// 노드 레인 봉인(node-lane-backend-seal.mjs)에 걸린다.
export function applicationIdList(value: unknown): RejudgeCandidate[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const candidates: RejudgeCandidate[] = [];
  for (const item of value) {
    const id = typeof item === "string" ? item.trim() : "";
    if (!id) {
      candidates.push({
        id: "",
        invalidReason: `applicationId entries must be non-empty strings (got ${JSON.stringify(item)?.slice(0, 80) ?? String(item)})`,
      });
      continue;
    }
    const docId = sanitizeApplicationId(id);
    if (seen.has(docId)) continue;
    seen.add(docId);
    candidates.push({ id });
  }
  return candidates;
}

export type RejudgeApplicationStatus =
  | "not_found"        // 관리 문서 자체가 없다
  | "skipped"          // 재판정 대상 마커가 아니다(이미 판정됨 — 다른 reasonCode)
  | "would_judge"      // dry-run — 미판정 문서(최초 판정 대상)
  | "would_rejudge"    // dry-run — channel_not_found_pending_review 재판정 대상
  | "judged"           // 판정 완료 — 원장에 쓰였다(recorded === "written")
  | "idempotent"       // 해당 seq 의 결정 문서가 이미 있다(비정상 — 보고용)
  | "retry_scheduled"  // 일시 실패 — qualificationRetry 마커를 남기고 백오프 진입
  | "deferred"         // 시간 예산 소진 — 처리하지 않고 다음 호출로 미뤘다(재호출 안내)
  | "error";

export interface RejudgeApplicationResultEntry {
  applicationId: string;
  status: RejudgeApplicationStatus;
  firstJudgment: boolean;
  verdict?: string;
  reasonCode?: string | null;
  decisionSeq?: number;
  decisionRef?: string;
  channelId?: string | null;
  channelIdSource?: string | null;
  applied?: boolean;
  message?: string;
}

export interface RejudgeApplicationQualificationOptions {
  // 핸들러는 applicationIdList 가 만든 후보(무효 항목은 invalidReason 포함)를 넘긴다.
  // 코어 단위 테스트는 편의상 string 배열을 그대로 넘길 수 있다.
  applicationIds: Array<string | RejudgeCandidate>;
  by: string;
  dryRun: boolean;
  now?: Date;
  firestore?: FirebaseFirestore.Firestore;
  youtubeApi?: YouTubeApiClient;
  autoDecisionSettings?: { autoRejectEnabled: boolean; autoApproveEnabled: boolean };
}

export interface RejudgeApplicationQualificationResult {
  dryRun: boolean;
  requested: number;
  eligible: number;
  judged: number;
  retryScheduled: number;
  skipped: number;
  notFound: number;
  deferred: number;
  errors: number;
  results: RejudgeApplicationResultEntry[];
}

export async function rejudgeApplicationQualification(
  options: RejudgeApplicationQualificationOptions,
): Promise<RejudgeApplicationQualificationResult> {
  const db = options.firestore ?? adminDb;
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const dryRun = options.dryRun !== false;
  const autoDecision = options.autoDecisionSettings ?? { autoRejectEnabled: false, autoApproveEnabled: false };
  // 실제 벽시계 데드라인 — options.now 는 판정 타임스탬프용 고정값이라 경과 측정에 쓸 수 없다.
  const deadlineAtMs = Date.now() + REJUDGE_TIME_BUDGET_MS;

  const result: RejudgeApplicationQualificationResult = {
    dryRun,
    requested: options.applicationIds.length,
    eligible: 0, judged: 0, retryScheduled: 0, skipped: 0, notFound: 0, deferred: 0, errors: 0,
    results: [],
  };

  let deferredRest = false;
  for (const candidate of options.applicationIds) {
    const { id: applicationId, invalidReason } = typeof candidate === "string" ? { id: candidate } : candidate;
    if (invalidReason) {
      result.errors += 1;
      result.results.push({ applicationId, status: "error", firstJudgment: false, message: invalidReason });
      continue;
    }
    if (deferredRest) {
      result.deferred += 1;
      result.results.push({ applicationId, status: "deferred", firstJudgment: false, message: "time budget exhausted — re-call with the remaining ids" });
      continue;
    }
    // dry-run 은 YouTube 호출이 없어 예산을 태우지 않는다 — 실제 실행에만 가드를 둔다.
    if (!dryRun && Date.now() > deadlineAtMs) {
      deferredRest = true;
      result.deferred += 1;
      result.results.push({ applicationId, status: "deferred", firstJudgment: false, message: "time budget exhausted — re-call with the remaining ids" });
      continue;
    }
    try {
      // 입력은 운영자가 identity.applicationId(문서 안에 원본 값으로 보관되는 포털 id —
      // scpCreatorPipelineV3Receiver.ts IDENTIFIER_PATTERN 상 . / : 도 유효)를 그대로 복사해
      // 올 수 있다. 관리 문서 doc id 는 생성 시점부터 storeDocId(=sanitizeApplicationId)로
      // 고정되므로(applicationManagementStore.ts) 조회·판정·마커 쓰기는 정규화된 doc id 로
      // 통일한다 — 스윕이 doc.id 를 넘기는 것과 같은 모델이다. raw 입력으로 조회하면
      // "app.contract:001" 같은 문서를 못 찾아 not_found 로 빠진다(적대적 리뷰 M-1).
      const managementDocId = sanitizeApplicationId(applicationId);
      const managementRef = db.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION).doc(managementDocId);
      const snap = await managementRef.get();
      if (!snap.exists) {
        result.notFound += 1;
        result.results.push({ applicationId, status: "not_found", firstJudgment: false });
        continue;
      }
      const data = snap.data() ?? {};
      const qualification = data.qualification && typeof data.qualification === "object" && !Array.isArray(data.qualification)
        ? data.qualification as Record<string, unknown>
        : null;
      const markerReason = typeof qualification?.reasonCode === "string" ? qualification.reasonCode : null;
      // 대상 = channel_not_found_pending_review 마커(재판정) 또는 아직 미판정(최초 판정 —
      // 스캔 창 밖 백로그도 이 경로로 id 단건 판정할 수 있다).
      const firstJudgment = !qualification;
      if (!firstJudgment && markerReason !== REJUDGE_REASON_CODE) {
        result.skipped += 1;
        result.results.push({ applicationId, status: "skipped", firstJudgment: false, reasonCode: markerReason });
        continue;
      }
      result.eligible += 1;

      const latest = await latestApplicationQualificationDecision(managementDocId, db);
      const decisionSeq = (latest?.seq ?? INITIAL_QUALIFICATION_DECISION_SEQ - 1) + 1;

      if (dryRun) {
        result.results.push({
          applicationId,
          status: firstJudgment ? "would_judge" : "would_rejudge",
          firstJudgment,
          reasonCode: markerReason,
          decisionSeq,
          decisionRef: latest?.ref,
        });
        continue;
      }

      // 재시도 마커만 지우고 updatedAtIso 를 지금으로 옮긴다 — qualification 마커는 판정이 새로
      // 쓸 때(또는 handleTransientLookupFailure 의 재시도 마커 쓰기가 지울 때)까지 **그대로 둔다**.
      // 콜러블이 이 쓰기 직후 죽으면(torn) 문서는 종전 terminal 마커를 유지해 다음 재판정 호출이
      // 다시 집고, 재시도 경로로 넘어간 뒤 죽으면 qualificationRetry 가 스윕 백오프로 자연 치유된다 —
      // 마커를 미리 지우면 "마커 없음 + 원장 __1 존재" torn 문서가 매 스윕마다 YouTube 호출 +
      // idempotent 원장 재시도를 무한 반복한다(적대적 리뷰 F2). updatedAtIso 갱신은 스윕이
      // updatedAtIso desc 상위 창만 훑기 때문에 창 밖 문서를 되돌리는 통로다(미판정 문서도 같이).
      await managementRef.set({
        qualificationRetry: FieldValue.delete(),
        updatedAtIso: nowIso,
      }, { merge: true });
      // 판정 함수에 넘길 스냅샷에서도 같은 마커를 지운다 — 재판정의 재시도 카운터는 새로 시작한다.
      const effectiveData = { ...data };
      delete effectiveData.qualification;
      delete effectiveData.qualificationRetry;

      const run = await judgeApplicationEligibilityForRecord({
        db,
        // 판정 파이프라인도 doc id 로 통일한다 — 안쪽의 handleTransientLookupFailure /
        // recordApplicationQualificationDecision 도 같은 doc 을 가리켜야 한다(스윕은 doc.id 를 넘긴다).
        applicationId: managementDocId,
        data: effectiveData,
        now,
        youtubeApi: options.youtubeApi,
        autoDecision,
        decisionSeq,
        rejudged: { by: options.by, fromDecisionRef: latest?.ref ?? null },
      });

      if (run.outcome === "retry_scheduled") {
        result.retryScheduled += 1;
        result.results.push({
          applicationId, status: "retry_scheduled", firstJudgment,
          decisionSeq, channelId: run.channelId, channelIdSource: run.channelIdSource,
        });
        continue;
      }
      if (run.recorded === "written") result.judged += 1;
      result.results.push({
        applicationId,
        status: run.recorded === "written" ? "judged" : "idempotent",
        firstJudgment,
        verdict: run.judge?.verdict,
        reasonCode: run.judge?.reasonCode,
        decisionSeq,
        channelId: run.channelId,
        channelIdSource: run.channelIdSource,
        applied: run.applied,
      });
    } catch (error) {
      result.errors += 1;
      result.results.push({
        applicationId,
        status: "error",
        firstJudgment: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

export async function rejudgeApplicationQualificationHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, ACTION, OPERATOR_ROLES);
  const data = asRecord(request.data);
  const candidates = applicationIdList(data.applicationIds);
  if (candidates.length === 0) {
    throw invalidArgument(`applicationIds is required (1-${MAX_REJUDGE_IDS} non-empty ids)`);
  }
  // 상한 초과는 조용히 자르지 않고 거절한다 — "25건만 처리됐는데 전부라고 착각"을 막는다.
  if (candidates.length > MAX_REJUDGE_IDS) {
    throw invalidArgument(`applicationIds supports at most ${MAX_REJUDGE_IDS} ids per call (${candidates.length} given) — split the batch`);
  }
  const dryRun = data.dryRun !== false;
  if (!dryRun && asString(data.confirm) !== APPLICATION_QUALIFICATION_REJUDGE_CONFIRMATION) {
    throw Object.assign(new Error("failed-precondition: apply confirmation is required"), {
      code: "failed-precondition",
      errorCode: "application_qualification_rejudge_apply_confirmation_required",
    });
  }
  const result = await rejudgeApplicationQualification({
    applicationIds: candidates,
    by: auth.userId,
    dryRun,
    now: new Date(),
    // dry-run 은 YouTube 호출도 설정 조회도 하지 않는다 — 실제 실행 때만 자동반려 게이트를 읽는다.
    autoDecisionSettings: dryRun ? undefined : (await readSettings()).automation.applicationAutoDecision,
  });
  return { ...result, behaviorLog: makeBehaviorLog(auth, ACTION, "success") };
}
