// Task-95 §3 트리거 + 적용. materializeApplicationManagementRecord 성공 시점을 직접 후킹하지
// 않는다 — 그 함수는 scpCreatorPipelineV3Receiver.ts/scpFluApplicationCommand.ts/
// scpIntegrationEventV2.ts 3곳에서 트랜잭션 안에서 호출되고, YouTube 조회는 그 트랜잭션 안에서
// 하면 안 되는 외부 I/O 다. 대신 기존 1분 스케줄(drainScpCreatorPipelineV3ManagementAck,
// functions/index.ts, R25-B 편승 전례와 동일 패턴)에 편승한다 — "6시간 sweep 은 너무 느림"
// (TICKET-MAP Task-95) 기준을 만족하면서 새 onSchedule 을 만들지 않는다(핀 42 유지).
//
// scanLimit/processLimit 구조는 scpCreatorPipelineV3ManagementAckStore.ts 의
// backfillDeclaredAudienceCountry 와 같은 스타일(Firestore 는 "필드 부재"를 서버측에서 걸러주지
// 않으므로 메모리에서 필터링, 상한을 둔다).

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { readSettings } from "./settings";
import { SCP_APPLICATION_MANAGEMENT_COLLECTION } from "./applicationManagementStore";
import {
  APPLICATION_ELIGIBILITY_DEFAULT_MINIMUM_SUBSCRIBERS,
  APPLICATION_ELIGIBILITY_JUDGE_VERSION,
  judgeApplicationEligibility,
  type ApplicationEligibilityJudgeResult,
  type ApplicationEligibilityLookupStatus,
} from "./applicationEligibilityJudge";
import {
  INITIAL_QUALIFICATION_DECISION_SEQ,
  markApplicationQualificationDecisionApplied,
  recordApplicationQualificationDecision,
  type ApplicationChannelIdSource,
} from "./applicationQualificationLedger";
import { enqueueLoginRejectedMail } from "./scpAdminBridgeCallables";
import {
  sendScpAdminBridgeCreatorCommand,
  type ScpAdminBridgeCommandOperator,
} from "./scpAdminBridgeClient";
import {
  makeYouTubeDataApiClient,
  resolveYouTubeChannelExact,
  resolveYouTubeChannelIdForHandle,
  type YouTubeApiClient,
} from "./youtubeEnrichmentService";
import { normalizeHandle } from "./scpLifecycleProjection";

// application.reject 커맨드용 합성 오퍼레이터 — 사람 auth 가 없는 스케줄 트리거이므로 감사에
// "자동화가 실행했다"가 남는 식별자를 쓴다. emailMasked 는 포털 마스킹 정규식
// (scpAdminBridgeCallables.ts 의 OPERATOR_EMAIL_MASK_PATTERN, `^[^\s@]{0,2}\*\*\*@[^\s@]+\.[^\s@]+$`)
// 을 그대로 만족하는 고정 문자열이다.
const AUTO_DECISION_OPERATOR: ScpAdminBridgeCommandOperator = {
  fluUid: "system:application-eligibility-judge",
  role: "manager",
  emailMasked: "ai***@flu.internal",
};

const DEFAULT_SCAN_LIMIT = 50;
const DEFAULT_PROCESS_LIMIT = 10;
const YOUTUBE_LOOKUP_TIMEOUT_MS = 8000;

// AR-1 [적대적 리뷰 2026-09-17, MEDIUM]: YouTube 조회의 api_error/timeout(쿼터 403 포함 — 403은
// youtubeEnrichmentService.ts youtubeGet 이 던지는 일반 Error 라 lookupSubscriberCountByChannelId
// catch 에서 이미 "api_error"로 분류된다)은 **일시적** 실패다. 이걸 곧바로 human_review 원장에
// 영구 기록하면 서비스가 잠깐 흔들릴 때마다 신청자가 사람 검토 큐에 영구히 눌러앉는다(재판정
// 경로가 없다 — sweepApplicationEligibilityJudge 는 qualification 마커가 있으면 다시는 스캔하지
// 않는다). 대신 scpCreatorPipelineV3ManagementAckStore.ts releaseForRetry 와 같은 계약(attempts
// 증가 → 상한 도달 시에만 종결, 아니면 백오프 테이블로 다음 시도 예약)을 그대로 따른다 — 백오프는
// attempts(증가 **전** 값)로 인덱싱하고 배열 길이를 넘으면 마지막 값에 clamp 한다.
const TRANSIENT_LOOKUP_RETRY_BACKOFF_MS: readonly number[] = [
  60 * 60 * 1000, // 1차 실패 → 1시간 뒤 재시도
  4 * 60 * 60 * 1000, // 2차 실패 → 4시간 뒤 재시도
  24 * 60 * 60 * 1000, // 3차 실패는 상한(MAX_TRANSIENT_LOOKUP_ATTEMPTS)에 걸려 이 값 대신 종결한다
];
const MAX_TRANSIENT_LOOKUP_ATTEMPTS = 3;

interface SubscriberLookup {
  subscriberCount: number | null;
  hiddenSubscriberCount: boolean;
  lookupStatus: ApplicationEligibilityLookupStatus;
}

interface QualificationRetryMarker {
  attempts: number;
  lastError: ApplicationEligibilityLookupStatus;
  nextAttemptAtIso: string;
  // 수동 재판정(applicationQualificationRejudge.ts)이 시작한 판정이 백오프에 들어가면, 다음
  // 스윕 pass 가 원장을 같은 seq/감사로 이어 쓸 수 있게 마커에 싣는다. 일반(최초) 판정은
  // 이 필드들이 없다 — 마커 형상은 기존과 동일하다.
  decisionSeq?: number;
  rejudgedBy?: string;
  rejudgedFrom?: string;
}

function readQualificationRetryMarker(value: unknown): QualificationRetryMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const attempts = typeof record.attempts === "number" && Number.isFinite(record.attempts) ? record.attempts : 0;
  const nextAttemptAtIso = typeof record.nextAttemptAtIso === "string" ? record.nextAttemptAtIso : "";
  if (!nextAttemptAtIso) return null;
  const lastError = typeof record.lastError === "string"
    ? record.lastError as ApplicationEligibilityLookupStatus
    : "api_error";
  const decisionSeq = typeof record.decisionSeq === "number" && Number.isInteger(record.decisionSeq) && record.decisionSeq > INITIAL_QUALIFICATION_DECISION_SEQ
    ? record.decisionSeq
    : undefined;
  const rejudgedBy = typeof record.rejudgedBy === "string" && record.rejudgedBy ? record.rejudgedBy : undefined;
  const rejudgedFrom = typeof record.rejudgedFrom === "string" && record.rejudgedFrom ? record.rejudgedFrom : undefined;
  return { attempts, lastError, nextAttemptAtIso, decisionSeq, rejudgedBy, rejudgedFrom };
}

// 일시적 조회 실패 1건을 처리한다 — 상한 미만이면 원장에 아무것도 쓰지 않고(관측 가능한
// qualificationRetry 마커만 남긴다) 상한에 도달하면 그때만 human_review 로 종결한다.
async function handleTransientLookupFailure(input: {
  db: FirebaseFirestore.Firestore;
  applicationId: string;
  channelId: string | null;
  channelIdSource: ApplicationChannelIdSource | null;
  priorRetry: QualificationRetryMarker | null;
  lookup: SubscriberLookup;
  now: Date;
  decisionSeq: number;
  rejudged?: { by: string; fromDecisionRef: string | null };
}): Promise<{ finalized: boolean; judge?: ApplicationEligibilityJudgeResult; recorded?: "written" | "idempotent" }> {
  const { db, applicationId, channelId, channelIdSource, priorRetry, lookup, now, decisionSeq, rejudged } = input;
  const priorAttempts = priorRetry?.attempts ?? 0;
  const attempts = priorAttempts + 1;
  const managementRef = db.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION).doc(applicationId);

  if (attempts >= MAX_TRANSIENT_LOOKUP_ATTEMPTS) {
    const judge: ApplicationEligibilityJudgeResult = {
      version: APPLICATION_ELIGIBILITY_JUDGE_VERSION,
      verdict: "human_review",
      reasonCode: "subscriber_lookup_unavailable_after_retries",
      evidence: {
        subscriberCount: null,
        hiddenSubscriberCount: false,
        lookupStatus: lookup.lookupStatus,
        minimumSubscribers: APPLICATION_ELIGIBILITY_DEFAULT_MINIMUM_SUBSCRIBERS,
      },
    };
    const recorded = await recordApplicationQualificationDecision({
      applicationId, judge, channelId,
      channelIdSource: channelIdSource ?? undefined,
      now, decisionSeq, rejudged, firestore: db,
    });
    // 종결됐으니 임시 마커는 지운다 — qualification 마커가 이미 후속 스캔에서 이 문서를 걸러내므로
    // 이 삭제가 실패해도(best-effort) 정확성에는 영향이 없다.
    await managementRef.set({ qualificationRetry: FieldValue.delete() }, { merge: true }).catch(() => {});
    return { finalized: true, judge, recorded: recorded.status };
  }

  const backoffMs = TRANSIENT_LOOKUP_RETRY_BACKOFF_MS[
    Math.min(priorAttempts, TRANSIENT_LOOKUP_RETRY_BACKOFF_MS.length - 1)
  ];
  const marker: QualificationRetryMarker = {
    attempts,
    lastError: lookup.lookupStatus,
    nextAttemptAtIso: new Date(now.getTime() + backoffMs).toISOString(),
  };
  // 재판정 컨텍스트는 백오프를 넘겨 다음 pass 까지 살려야 한다 — 아니면 상한 종결 시점에
  // 최초 seq(기본 1)로 기록을 시도해 idempotent 로 빠지고 마커 없는 문서만 남는다.
  if (decisionSeq > INITIAL_QUALIFICATION_DECISION_SEQ) marker.decisionSeq = decisionSeq;
  if (rejudged) {
    marker.rejudgedBy = rejudged.by;
    if (rejudged.fromDecisionRef) marker.rejudgedFrom = rejudged.fromDecisionRef;
  }
  // qualification 삭제를 이 쓰기에 합친다 — 수동 재판정(applicationQualificationRejudge.ts)은
  // 판정 전에 terminal 마커를 지우지 않으므로(크래시 시 종전 마커로 자연 복귀), 문서가
  // 재시도 경로로 넘어가는 이 시점에 지워야 스윕 필터가 다음 pass 에 다시 집는다. 일반 스윕
  // 경로에서는 qualification 이 애초에 없으므로 이 delete 는 no-op 이다(적대적 리뷰 F2).
  await managementRef.set(
    { qualificationRetry: marker, qualification: FieldValue.delete() },
    { merge: true },
  );
  return { finalized: false };
}

async function lookupSubscriberCountByChannelId(
  api: YouTubeApiClient,
  channelId: string,
): Promise<SubscriberLookup> {
  try {
    const response = await api.channelsList({ part: "snippet,statistics", id: channelId }, { timeoutMs: YOUTUBE_LOOKUP_TIMEOUT_MS });
    const item = (response.items ?? [])[0];
    if (!item) return { subscriberCount: null, hiddenSubscriberCount: false, lookupStatus: "not_found" };
    if (item.statistics?.hiddenSubscriberCount === true) {
      return { subscriberCount: null, hiddenSubscriberCount: true, lookupStatus: "hidden" };
    }
    const raw = Number(item.statistics?.subscriberCount);
    if (!Number.isFinite(raw)) return { subscriberCount: null, hiddenSubscriberCount: false, lookupStatus: "api_error" };
    return { subscriberCount: raw, hiddenSubscriberCount: false, lookupStatus: "ok" };
  } catch (error) {
    // AbortSignal.timeout() 이 만드는 DOMException 은 name === "TimeoutError" 다
    // (youtubeEnrichmentService.ts youtubeGet 의 AbortSignal.timeout(options.timeoutMs) 참고).
    const isTimeout = error instanceof Error && error.name === "TimeoutError";
    return { subscriberCount: null, hiddenSubscriberCount: false, lookupStatus: isTimeout ? "timeout" : "api_error" };
  }
}

export type DeclaredChannelResolution =
  | { status: "resolved"; channelId: string; via: "channel_url" | "handle" }
  | { status: "not_found" }
  | { status: "api_error" | "timeout" };

// identity.channelId 가 없는 문서(계약상 대부분 — channelId 는 지원 시점에 이미 OAuth 검증된
// 채널일 때만 채워진다)의 판정용 channelId 폴백. 지원서 자가신고 값(declaredIdentity,
// applicationDeclaredIdentitySweep.ts 가 포털 answers 에서 백필)을 channelUrl → handle 순으로
// **정확 조회**만 한다 — resolveYouTubeChannel 의 search.list 폴백(fuzzy ranking)은 채널 소유
// 증명이 아니므로 채택하지 않는다(scpPortalCreatorBinding.ts tier 3 와 같은 결론). 실패는
// "없음"(not_found — 종전과 동일하게 human_review)과 "지금 못 물어봄"(api_error/timeout —
// qualificationRetry 재시도 경로)을 구분한다.
export async function resolveChannelIdFromDeclaredIdentity(
  api: Pick<YouTubeApiClient, "channelsList"> | undefined,
  declared: Record<string, unknown>,
): Promise<DeclaredChannelResolution> {
  const channelUrl = typeof declared.channelUrl === "string" ? declared.channelUrl.trim() : "";
  // scpPortalCreatorBinding.ts 와 같은 정규화 — 자가신고 핸들은 대소문자·공백·@ 접두가 제각각이다.
  const declaredHandle = normalizeHandle(declared.handle);
  if (!channelUrl && !declaredHandle) return { status: "not_found" };
  if (!api) return { status: "api_error" };
  try {
    if (channelUrl) {
      const resolved = await resolveYouTubeChannelExact(api, channelUrl, { timeoutMs: YOUTUBE_LOOKUP_TIMEOUT_MS });
      const resolvedHandle = resolved ? normalizeHandle(resolved.channel.snippet?.customUrl) : null;
      // 자가신고 두 필드(URL·핸들)가 서로 다른 채널을 가리키면 URL 쪽을 믿지 않는다 —
      // stale/오기입 자가신고로 남의 채널을 판정하는 것을 막는 교차 확인(추가 API 호출 없이
      // 이미 받은 snippet.customUrl 로 검증). 어긋나면 더 엄격한 handle 단계로 넘긴다.
      if (resolved?.channel.id && !(declaredHandle && resolvedHandle && declaredHandle !== resolvedHandle)) {
        return { status: "resolved", channelId: resolved.channel.id, via: "channel_url" };
      }
    }
    if (declaredHandle) {
      const ownership = await resolveYouTubeChannelIdForHandle(api, declaredHandle, { timeoutMs: YOUTUBE_LOOKUP_TIMEOUT_MS });
      if (ownership.candidateCount === 1 && ownership.channelId) {
        return { status: "resolved", channelId: ownership.channelId, via: "handle" };
      }
    }
    return { status: "not_found" };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "TimeoutError";
    return { status: isTimeout ? "timeout" : "api_error" };
  }
}

export interface ApplicationEligibilityJudgeSweepOptions {
  firestore?: FirebaseFirestore.Firestore;
  now?: Date;
  youtubeApi?: YouTubeApiClient;
  scanLimit?: number;
  processLimit?: number;
  autoDecisionSettings?: { autoRejectEnabled: boolean; autoApproveEnabled: boolean };
}

export interface ApplicationEligibilityJudgeSweepResult {
  scanned: number;
  candidates: number;
  judged: number;
  approved: number;
  rejected: number;
  humanReview: number;
  applied: number;
  errors: number;
  // AR-1: 일시적 조회 실패(api_error/timeout)로 원장에 아무것도 안 쓰고 다음 시도로 미룬 건수 —
  // 관측용(이게 안 보이면 "judged=0"이 정지인지 재시도 대기인지 구분이 안 된다).
  retryScheduled: number;
}

// 사람 UI(ScpCreatorDirectoryPanel.approveApplicationOnce/rejectApplicationOnce)와 같은 두 단계:
// submitted 상태면 먼저 start-review 를 열어야 reject 가 먹는다. "in_review 에서만 반려 가능"은
// 포털 브리지 자신이 최종 검증한다 — Flu 쪽에는 신청 건별 상태를 값싸게 조회하는 API가 없어서
// (fetchScpAdminBridgeCreatorsDirectory 는 페이지 커서만 지원, applicationId 단건 조회 없음)
// 로컬에서 재확인하지 않는다. reject 커맨드의 실패(및 그 사유)가 사실상의 전제조건 검증이다.
async function applyAutoReject(
  applicationId: string,
  judge: ApplicationEligibilityJudgeResult,
  lookup: SubscriberLookup,
  now: Date,
  decisionSeq: number,
  db: FirebaseFirestore.Firestore,
): Promise<boolean> {
  try {
    await sendScpAdminBridgeCreatorCommand({
      operator: AUTO_DECISION_OPERATOR,
      command: "application.start-review",
      targetId: applicationId,
    });
  } catch {
    // best-effort — 이미 in_review 거나 브리지가 일시적으로 막혀도 reject 시도는 계속한다.
  }

  let outcome: Awaited<ReturnType<typeof sendScpAdminBridgeCreatorCommand>> = null;
  try {
    outcome = await sendScpAdminBridgeCreatorCommand({
      operator: AUTO_DECISION_OPERATOR,
      command: "application.reject",
      targetId: applicationId,
      params: { reasonCode: judge.reasonCode },
    });
  } catch (error) {
    console.warn("[application-eligibility-judge] auto-reject command threw", {
      applicationId,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  if (!outcome || !outcome.ok) {
    console.warn("[application-eligibility-judge] auto-reject rejected by bridge", {
      applicationId,
      code: outcome && !outcome.ok ? outcome.error : "transport_failure",
    });
    return false;
  }

  // 사람 반려 경로(scpAdminBridgeCallables.ts scpPortalCreatorCommandHandler)와 동일한 "재신청
  // 안내" 메일 큐잉 — 직접 호출하지 않으면 자동 반려만 메일 없이 나가는 회귀가 생긴다. 이 판정
  // 코어의 reject reasonCode 는 언제나 subscriber_below_minimum 하나뿐이다.
  try {
    await enqueueLoginRejectedMail(
      applicationId,
      "subscriber_below_minimum",
      typeof lookup.subscriberCount === "number" ? lookup.subscriberCount : undefined,
      now,
    );
  } catch (error) {
    console.warn("[application-eligibility-judge] login_rejected enqueue failed", {
      applicationId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  await markApplicationQualificationDecisionApplied(applicationId, "application.reject", now, decisionSeq, db);
  return true;
}

export interface JudgeApplicationEligibilityRecordInput {
  db: FirebaseFirestore.Firestore;
  applicationId: string;
  // 관리 문서 데이터(이미 읽은 스냅샷) — qualification/qualificationRetry 마커는 이 함수가
  // 판정 자격을 판단하는 데 쓰지 않는다(선별은 호출자 책임).
  data: Record<string, unknown>;
  now: Date;
  youtubeApi?: YouTubeApiClient;
  autoDecision: { autoRejectEnabled: boolean; autoApproveEnabled: boolean };
  // 원장 문서 seq — 최초 판정은 1, 수동 재판정은 직전 seq + 1. 일시 실패로 백오프에 들어간
  // 재판정은 qualificationRetry 마커가 이 값을 다음 pass 까지 싣는다.
  decisionSeq?: number;
  // 수동 재판정(applicationQualificationRejudge.ts)일 때만 — 원장 감사 꼬리표.
  rejudged?: { by: string; fromDecisionRef: string | null };
}

export interface JudgeApplicationEligibilityRecordResult {
  outcome: "judged" | "retry_scheduled";
  judge: ApplicationEligibilityJudgeResult | null;
  channelId: string | null;
  channelIdSource: ApplicationChannelIdSource | null;
  recorded: "written" | "idempotent" | null;
  applied: boolean;
}

// 관리 문서 1건에 대한 판정 파이프라인 — 주기 스윕(sweepApplicationEligibilityJudge)과 수동
// 재판정(applicationQualificationRejudge.ts)이 같은 함수를 쓴다. 해소 순서:
//   1) identity.channelId (기존 — 지원 시점 OAuth 검증된 채널)
//   2) declaredIdentity.channelUrl → declaredIdentity.handle (자가신고 폴백, 정확 조회만)
//   3) 둘 다 없으면 not_found — YouTube 호출 없이 channel_not_found_pending_review.
// 판정 계약은 스윕과 완전히 동일하다(같은 판정 코어·같은 원장 기록·같은 재시도/자동반려 경로).
export async function judgeApplicationEligibilityForRecord(
  input: JudgeApplicationEligibilityRecordInput,
): Promise<JudgeApplicationEligibilityRecordResult> {
  const { db, applicationId, data, now } = input;
  const decisionSeq = input.decisionSeq ?? INITIAL_QUALIFICATION_DECISION_SEQ;
  const identity = data.identity && typeof data.identity === "object" && !Array.isArray(data.identity)
    ? data.identity as Record<string, unknown>
    : {};
  let channelId = typeof identity.channelId === "string" && identity.channelId ? identity.channelId : null;
  let channelIdSource: ApplicationChannelIdSource | null = channelId ? "identity" : null;

  // YouTube 클라이언트는 필요할 때만 만든다 — channelId 도 자가신고 증거도 없는 문서는
  // API 예산을 쓰지 않는다(not_found 판정은 조회 없이 내린다).
  let api = input.youtubeApi;
  let apiInitFailed = false;
  const ensureApi = (): YouTubeApiClient | undefined => {
    if (!api && !apiInitFailed) {
      try {
        api = makeYouTubeDataApiClient();
      } catch {
        apiInitFailed = true;
      }
    }
    return api;
  };

  let lookup: SubscriberLookup | null = null;
  if (!channelId) {
    const declared = data.declaredIdentity && typeof data.declaredIdentity === "object" && !Array.isArray(data.declaredIdentity)
      ? data.declaredIdentity as Record<string, unknown>
      : {};
    const resolution = await resolveChannelIdFromDeclaredIdentity(ensureApi(), declared);
    if (resolution.status === "resolved") {
      channelId = resolution.channelId;
      channelIdSource = "declared_identity";
    } else if (resolution.status === "api_error" || resolution.status === "timeout") {
      // 해소 시도 자체가 일시 실패 — "없음"이 아니라 "못 물어봄"이므로 재시도 경로로 태운다.
      lookup = { subscriberCount: null, hiddenSubscriberCount: false, lookupStatus: resolution.status };
    }
  }
  if (!lookup) {
    if (!channelId) {
      // 신원 매핑에 channelId 가 아예 없고 자가신고 폴백도 실패하면 조회할 것이 없다 —
      // not_found 와 동일하게 취급해 human_review 로 보낸다(판정 코어 계약 그대로, lookupStatus 는 5종 고정).
      lookup = { subscriberCount: null, hiddenSubscriberCount: false, lookupStatus: "not_found" };
    } else {
      const client = ensureApi();
      lookup = client
        ? await lookupSubscriberCountByChannelId(client, channelId)
        : { subscriberCount: null, hiddenSubscriberCount: false, lookupStatus: "api_error" };
    }
  }

  // AR-1 [적대적 리뷰 2026-09-17, MEDIUM]: api_error/timeout 은 구독자 수와 무관한 *일시적*
  // 조회 실패다 — judgeApplicationEligibility 를 거치면 곧장 human_review 원장 기록이 되어
  // 서비스가 잠깐 흔들릴 때마다(쿼터 403 포함) 영구 사람 검토로 눌러앉는다. 재시도 상한 전까지는
  // 원장에 아무것도 쓰지 않고 qualificationRetry 마커만 남긴다.
  if (lookup.lookupStatus === "api_error" || lookup.lookupStatus === "timeout") {
    const priorRetry = readQualificationRetryMarker(data.qualificationRetry);
    const outcome = await handleTransientLookupFailure({
      db, applicationId, channelId, channelIdSource, priorRetry, lookup, now,
      decisionSeq, rejudged: input.rejudged,
    });
    if (outcome.finalized && outcome.judge) {
      return {
        outcome: "judged",
        judge: outcome.judge,
        channelId,
        channelIdSource,
        recorded: outcome.recorded ?? "written",
        applied: false,
      };
    }
    return { outcome: "retry_scheduled", judge: null, channelId, channelIdSource, recorded: null, applied: false };
  }

  const judge = judgeApplicationEligibility({
    subscriberCount: lookup.subscriberCount,
    hiddenSubscriberCount: lookup.hiddenSubscriberCount,
    lookupStatus: lookup.lookupStatus,
    minimumSubscribers: APPLICATION_ELIGIBILITY_DEFAULT_MINIMUM_SUBSCRIBERS,
  });

  const recorded = await recordApplicationQualificationDecision({
    applicationId, judge, channelId,
    channelIdSource: channelIdSource ?? undefined,
    now,
    decisionSeq,
    rejudged: input.rejudged,
    firestore: db,
  });

  let applied = false;
  // autoApproveEnabled 는 절대 여기서 읽지 않는다 — approve 자동 적용은 코드 발급 시점 확정
  // (TICKET-MAP §3 결정 #5) 전까지 하드 OFF. 설정값이 true 여도 무시한다.
  if (recorded.status === "written" && judge.verdict === "reject" && input.autoDecision.autoRejectEnabled === true) {
    applied = await applyAutoReject(applicationId, judge, lookup, now, decisionSeq, db);
  }

  return { outcome: "judged", judge, channelId, channelIdSource, recorded: recorded.status, applied };
}

export async function sweepApplicationEligibilityJudge(
  options: ApplicationEligibilityJudgeSweepOptions = {},
): Promise<ApplicationEligibilityJudgeSweepResult> {
  const db = options.firestore ?? adminDb;
  const now = options.now ?? new Date();
  const scanLimit = Math.min(Math.max(options.scanLimit ?? DEFAULT_SCAN_LIMIT, 1), 200);
  const processLimit = Math.min(Math.max(options.processLimit ?? DEFAULT_PROCESS_LIMIT, 1), 25);
  const autoDecision = options.autoDecisionSettings
    ?? (await readSettings()).automation.applicationAutoDecision;

  const result: ApplicationEligibilityJudgeSweepResult = {
    scanned: 0, candidates: 0, judged: 0, approved: 0, rejected: 0, humanReview: 0, applied: 0, errors: 0,
    retryScheduled: 0,
  };

  const snapshot = await db.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION)
    .orderBy("updatedAtIso", "desc")
    .limit(scanLimit)
    .get();
  result.scanned = snapshot.size;

  const nowIso = now.toISOString();
  // Firestore 는 "qualification 필드 부재"를 서버측 where 로 걸러주지 않는다 — 메모리에서
  // 필터링하고, YouTube 조회 예산은 processLimit 으로 캡한다.
  // AR-1: qualificationRetry.nextAttemptAtIso 가 미래인 문서(일시적 실패로 백오프 대기 중)도
  // 이번 pass 의 후보에서 뺀다 — 아니면 매 pass 마다 같은 실패를 즉시 재시도해 쿼터만 태운다.
  const candidates = snapshot.docs.filter((doc) => {
    const data = doc.data();
    if (data.qualification) return false;
    const retry = readQualificationRetryMarker(data.qualificationRetry);
    if (retry && retry.nextAttemptAtIso > nowIso) return false;
    return true;
  }).slice(0, processLimit);
  result.candidates = candidates.length;

  for (const doc of candidates) {
    const applicationId = doc.id;
    try {
      const data = doc.data() ?? {};
      // 백오프 마커가 실어 준 재판정 컨텍스트(수동 재판정이 일시 실패로 미뤄진 문서)를 이어
      // 쓴다 — 없으면 최초 판정(seq 1)과 동일하다.
      const priorRetry = readQualificationRetryMarker(data.qualificationRetry);
      const run = await judgeApplicationEligibilityForRecord({
        db,
        applicationId,
        data,
        now,
        youtubeApi: options.youtubeApi,
        autoDecision,
        decisionSeq: priorRetry?.decisionSeq,
        rejudged: priorRetry?.rejudgedBy
          ? { by: priorRetry.rejudgedBy, fromDecisionRef: priorRetry.rejudgedFrom ?? null }
          : undefined,
      });

      if (run.outcome === "retry_scheduled") {
        result.retryScheduled += 1;
        continue;
      }
      result.judged += 1;
      if (run.judge?.verdict === "approve") result.approved += 1;
      else if (run.judge?.verdict === "reject") result.rejected += 1;
      else result.humanReview += 1;
      if (run.applied) result.applied += 1;
    } catch (error) {
      result.errors += 1;
      console.warn("[application-eligibility-judge] sweep item failed", {
        applicationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
