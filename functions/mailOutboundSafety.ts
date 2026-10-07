import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  mailIdentityBlockedError,
  mailIdentityBlocksMode,
  normalizeMailboxAddress,
  type MailIdentitySnapshot,
} from "./mailIdentity";
import {
  resolveMailIdentityContextForAccount,
  resolveOperationalMailIdentityContext,
  type OperationalMailIdentityContext,
} from "./mailProfiles";
import type { MailAccount } from "./mailAccounts";
import {
  CHAT_CASEBOOK,
  CHAT_CASEBOOK_CONTENT_HASH,
  CHAT_CASEBOOK_VERSION,
} from "./chatCasebook";
import {
  CHAT_AUTO_CASE_EXECUTION_LEDGER_COLLECTION,
  chatAutoCaseLedgerId,
  type ChatAutoCasePermitDisarmReason,
} from "./chatAutoCasePermit";
import { appendChatAutoCasePermitEvent, chatAutoPermitEventLedgerId } from "./chatAutoCasePermitStore";
import { readSettings } from "./settings";
import { asRecord, asString } from "./shared";
// W72 [R1 P1-3]: 레인 캡을 쿼터 예약 축으로 세우기 위한 설정 조회.
// [헤세 2026-09-03] 세 코호트 합산 캡을 같은 예약 트랜잭션의 축으로 세우기 위한 설정 조회.
import {
  readNudgeLaneDailyCapForPurpose,
  readNudgeTotalDailyCap,
  NUDGE_LANE_PURPOSE_TO_COHORT,
} from "./nudgeSequenceTemplates";
// W118: 레인별 킬스위치. 순수 분류 모듈이라 Firestore 의존이 없다.
import {
  hasServerOwnedMailLaneProvenance,
  resolveMailOutboundLane,
  type MailOutboundLane,
} from "./mailOutboundLanes";
import {
  classifyOutboundFailure,
  emailDomain,
  failedPrecondition,
  normalizeEmailAddress,
  safeOutboundFailureEvidence,
  safeMailDocId,
  type MailSafetyMode,
  type OutboundFailure,
} from "./mailSafetyShared";

export const OUTBOUND_SAFETY_STATE_PATH = "mail_safety_state/outbound";
export const OUTBOUND_ACTIVE_LOCK_RULE_ID = "mail-safety.outbound-lock";
export const OUTBOUND_ACTIVE_LOCK_REASON = "활성 메일 안전 잠금이 해제될 때까지 발송할 수 없습니다.";
export const OUTBOUND_MANUAL_PAUSE_RULE_ID = "mail-safety.manual-pause";
export const OUTBOUND_MANUAL_PAUSE_REASON = "설정에서 아웃리치 발송이 비활성화되어 있습니다";
// W118: 같은 ruleId 를 쓰되(하류 소비자·심각도 맵을 갈지 않는다) 사유 문면만 레인을 밝힌다.
export const OUTBOUND_NUDGE_PAUSE_REASON = "설정에서 독려 메일 발송이 비활성화되어 있습니다";

export type OutboundSafetyBlock = {
  readonly blocked: boolean;
  readonly ruleId?: string;
  readonly reason?: string;
  readonly blockedUntilIso?: string;
  /** W118: 어느 레인의 수동 정지에 걸렸는지. 하드락은 레인과 무관하므로 비운다. */
  readonly pausedLane?: MailOutboundLane;
};

const OUTBOUND_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const OUTBOUND_SUSPENSION_LOCK_MS = 24 * 60 * 60 * 1000;
const OUTBOUND_RATE_LIMIT_LOCK_MS = 60 * 60 * 1000;
const RECIPIENT_SUPPRESSION_FAILURE_KINDS = new Set<OutboundFailure["kind"]>(["invalid_recipient", "no_mx", "hard_bounce"]);
const BOUNCE_RATE_NUMERATOR_FAILURE_KINDS = new Set<OutboundFailure["kind"]>(["invalid_recipient", "hard_bounce"]);
const CHAT_AUTO_PERMIT_CASE_IDS = new Set(CHAT_CASEBOOK.map((item) => item.id));
const CHAT_AUTO_PERMIT_COMMITTED_REF_PATTERN =
  /^(?:message_sources|mail_outbound_log|auto_reply_queue|auto_reply_case_intents)\/[A-Za-z0-9_.:-]{1,180}$|^conversations\/[A-Za-z0-9_.:-]{1,180}\/messages\/[A-Za-z0-9_.:-]{1,180}$/;
const CHAT_AUTO_PERMIT_ADVERSE_SOURCE_REF_PATTERN =
  /^(?:mail_suppressions|mail_delivery_failures|message_sources|mail_outbound_log|auto_reply_queue|auto_reply_case_intents)\/[A-Za-z0-9_.:-]{1,180}$|^conversations\/[A-Za-z0-9_.:-]{1,180}\/messages\/[A-Za-z0-9_.:-]{1,180}$/;
const CHAT_AUTO_PERMIT_SERVER_OWNED_SOURCES = new Set([
  "receiveEmail",
  "sendEmail",
  "mail_outbound_log",
  "functions.chatAutoCasePermitStore",
]);
const SCP_VIDEO_RESULT_PROVIDER_RETRY_MAIL_TYPES = new Set([
  "content_approved",
  "content_changes_requested",
  "content_rejected",
]);

export function isServerOwnedVideoResultProviderRetry(data: Record<string, unknown>): boolean {
  return hasServerOwnedMailLaneProvenance(data)
    && asString(data.source) === "scp_outbox_mail_worker"
    && asString(data.mailPurpose) === "video_result_mail"
    && SCP_VIDEO_RESULT_PROVIDER_RETRY_MAIL_TYPES.has(asString(data.mailType));
}

export type ChatAutoPermitAdverseReason = Extract<
  ChatAutoCasePermitDisarmReason,
  | "send_failure"
  | "send_unknown_acceptance"
  | "send_blocked"
  | "bounce_or_suppression"
  | "complaint"
  | "opt_out"
  | "suppression"
  | "mail_safety_denied"
  | "case_unresolved_adverse_event"
>;

export type ChatAutoPermitAdverseAppendInput = {
  readonly caseId: string | null;
  readonly reason: ChatAutoPermitAdverseReason;
  readonly sourceRef: string;
  readonly nowIso: string;
  /** 지정되면 라이브 permit 의 pin 이 같을 때만 disarm(낡은 evidence 로 새 permit 을 내리지 않게). */
  readonly expectedPin?: { readonly casebookHash: string; readonly modelVersion: string };
};

export type ChatAutoPermitAdverseHookDeps = {
  readonly appendChatAutoCasePermitEvent?: (input: ChatAutoPermitAdverseAppendInput) => Promise<void>;
  readonly readChatAutoPermitCaseIdsFromCommittedRefs?: (sourceRefs: readonly string[]) => Promise<ReadonlySet<string>>;
  readonly readChatAutoPermitEvidenceFromCommittedRefs?: (sourceRefs: readonly string[]) => Promise<readonly ChatAutoPermitCommittedEvidence[]>;
};

export type ChatAutoPermitCommittedEvidence = {
  readonly caseId: string;
  readonly casebookHash: string;
  readonly modelVersion: string;
};

function isChatAutoPermitCaseId(value: unknown): value is string {
  return typeof value === "string" && CHAT_AUTO_PERMIT_CASE_IDS.has(value);
}

function safePermitRef(value: unknown, pattern: RegExp): string {
  const ref = asString(value, "");
  return pattern.test(ref) ? ref : "";
}

function hasServerOwnedChatAutoPermitProvenance(data: Record<string, unknown>): boolean {
  return (
    isChatAutoPermitCaseId(data.caseId) &&
    asString(data.casebookHash, "") === CHAT_CASEBOOK_CONTENT_HASH &&
    asString(data.casebookVersion, "") === CHAT_CASEBOOK_VERSION &&
    asString(data.gatewayModelVersion, "") !== "" &&
    asString(data.permitDecisionId, "") !== "" &&
    CHAT_AUTO_PERMIT_SERVER_OWNED_SOURCES.has(asString(data.source, ""))
  );
}

export function chatAutoPermitCommittedRefsFromMailData(
  data: Record<string, unknown>,
  extraRefs: readonly string[] = [],
): string[] {
  const refs = [
    safePermitRef(data.caseIntentRef, CHAT_AUTO_PERMIT_COMMITTED_REF_PATTERN),
    safePermitRef(data.sourceRef, CHAT_AUTO_PERMIT_COMMITTED_REF_PATTERN),
    safePermitRef(data.messageRef, CHAT_AUTO_PERMIT_COMMITTED_REF_PATTERN),
    safePermitRef(data.messageSourceRef, CHAT_AUTO_PERMIT_COMMITTED_REF_PATTERN),
    safePermitRef(data.outboundLogRef, CHAT_AUTO_PERMIT_COMMITTED_REF_PATTERN),
    safePermitRef(data.mailOutboxRef, CHAT_AUTO_PERMIT_COMMITTED_REF_PATTERN),
    ...extraRefs.map((ref) => safePermitRef(ref, CHAT_AUTO_PERMIT_COMMITTED_REF_PATTERN)),
  ];
  const trackingId = asString(data.trackingId, "");
  if (/^[A-Za-z0-9_.:-]{1,180}$/.test(trackingId)) refs.push(`mail_outbound_log/${trackingId}`);
  return [...new Set(refs.filter(Boolean))];
}

export async function readChatAutoPermitCaseIdsFromCommittedRefs(
  sourceRefs: readonly string[],
): Promise<ReadonlySet<string>> {
  const caseIds = new Set<string>();
  const refs = [...new Set(sourceRefs.map((ref) => safePermitRef(ref, CHAT_AUTO_PERMIT_COMMITTED_REF_PATTERN)).filter(Boolean))];
  for (const ref of refs) {
    const snapshot = await adminDb.doc(ref).get();
    const data = snapshot.data() ?? {};
    const caseId = asString(data.caseId, "");
    if (isChatAutoPermitCaseId(caseId) && hasServerOwnedChatAutoPermitProvenance(data)) caseIds.add(caseId);
  }
  return caseIds;
}

export async function readChatAutoPermitEvidenceFromCommittedRefs(
  sourceRefs: readonly string[],
): Promise<readonly ChatAutoPermitCommittedEvidence[]> {
  const evidence: ChatAutoPermitCommittedEvidence[] = [];
  const refs = [...new Set(sourceRefs.map((ref) => safePermitRef(ref, CHAT_AUTO_PERMIT_COMMITTED_REF_PATTERN)).filter(Boolean))];
  for (const ref of refs) {
    const snapshot = await adminDb.doc(ref).get();
    const data = snapshot.data() ?? {};
    const caseId = asString(data.caseId, "");
    if (isChatAutoPermitCaseId(caseId) && hasServerOwnedChatAutoPermitProvenance(data)) {
      evidence.push({ caseId, casebookHash: asString(data.casebookHash, ""), modelVersion: asString(data.gatewayModelVersion, "") });
    }
  }
  return evidence;
}

function isAlreadyExistsError(error: unknown): boolean {
  const record = asRecord(error);
  return record.code === 6 || record.code === "already-exists" || record.code === "ALREADY_EXISTS";
}

async function appendChatAutoPermitEventIdempotently(input: ChatAutoPermitAdverseAppendInput): Promise<void> {
  try {
    await appendChatAutoCasePermitEvent(input);
    return;
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
  const id = chatAutoPermitEventLedgerId(input);
  const snapshot = await adminDb.collection(CHAT_AUTO_CASE_EXECUTION_LEDGER_COLLECTION).doc(id).get();
  const data = snapshot.data() ?? {};
  if (
    snapshot.exists &&
    (data.caseId ?? null) === input.caseId &&
    asString(data.reason, "") === input.reason &&
    asString(data.sourceRef, "") === input.sourceRef
  ) {
    return;
  }
  throw Object.assign(new Error("chat auto permit adverse event collision"), {
    code: "already-exists",
    errorCode: "chat_auto_permit_adverse_event_collision",
  });
}

// P1-1 [적대 리뷰]: adverse-disarm(append)이 실패하면 억제/실패 기록 자체는 이미 커밋된 뒤다 —
// 그 disarm을 잃지 않으려면 재시도 가능한 흔적을 durable하게 남겨야 한다. 새 컬렉션을 만들지
// 않고 기존 scp_canary_alerts(운영 경보 컬렉션 — monitorOutboundOutputHeartbeat/scp-canary가
// 이미 씀)에 적재한다. 문서 id는 sourceRef+reason으로 결정적이라 같은 실패가 여러 pass에
// 걸쳐 반복돼도 새 문서가 아니라 같은 문서의 attempts만 늘어난다.
export const CHAT_AUTO_PERMIT_ADVERSE_RETRY_ALERT_KIND = "permit_adverse_retry" as const;

function chatAutoPermitAdverseRetryAlertId(sourceRef: string, reason: string): string {
  return safeMailDocId("permit_adverse_retry", `${sourceRef}:${reason}`);
}

async function recordChatAutoPermitAdverseRetryAlert(input: {
  reason: string;
  sourceRef: string;
  committedRefs: readonly string[];
  failedCaseIds: readonly (string | null)[];
  nowIso: string;
}): Promise<void> {
  const id = chatAutoPermitAdverseRetryAlertId(input.sourceRef, input.reason);
  await adminDb.collection("scp_canary_alerts").doc(id).set({
    id,
    kind: CHAT_AUTO_PERMIT_ADVERSE_RETRY_ALERT_KIND,
    status: "pending",
    reason: input.reason,
    sourceRef: input.sourceRef,
    committedRefs: input.committedRefs,
    failedCaseIds: input.failedCaseIds,
    attempts: FieldValue.increment(1),
    lastFailedAtIso: input.nowIso,
    createdAtIso: input.nowIso,
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export async function recordChatAutoPermitAdverseFromCommittedRefs(
  input: {
    readonly reason: Exclude<ChatAutoPermitAdverseReason, "case_unresolved_adverse_event">;
    readonly sourceRef: string;
    readonly committedRefs: readonly string[];
    readonly nowIso: string;
  },
  deps: ChatAutoPermitAdverseHookDeps = {},
): Promise<void> {
  const sourceRef = safePermitRef(input.sourceRef, CHAT_AUTO_PERMIT_ADVERSE_SOURCE_REF_PATTERN);
  if (!sourceRef) return;
  const append = deps.appendChatAutoCasePermitEvent ?? appendChatAutoPermitEventIdempotently;
  let caseIds: ReadonlySet<string>;
  // evidence pin 을 함께 읽어 disarm 트랜잭션에서 라이브 permit pin 과 대조한다. 케이스 id 리더만 주입된
  //   경우(pin 없음)는 종전 동작.
  const pinsByCase = new Map<string, ChatAutoPermitCommittedEvidence[]>();
  try {
    if (deps.readChatAutoPermitCaseIdsFromCommittedRefs) {
      caseIds = await deps.readChatAutoPermitCaseIdsFromCommittedRefs(input.committedRefs);
    } else {
      const evidence = await (deps.readChatAutoPermitEvidenceFromCommittedRefs ?? readChatAutoPermitEvidenceFromCommittedRefs)(input.committedRefs);
      caseIds = new Set(evidence.map((item) => item.caseId));
      for (const item of evidence) pinsByCase.set(item.caseId, [...(pinsByCase.get(item.caseId) ?? []), item]);
    }
  } catch (error) {
    await append({ caseId: null, reason: "case_unresolved_adverse_event", sourceRef, nowIso: input.nowIso });
    console.error("[chat-auto-permit-adverse] committed evidence lookup failed", {
      sourceRef,
      reason: input.reason,
      failureKind: safeOutboundFailureEvidence(error, "chat_auto_permit_adverse_lookup").failureKind,
    });
    return;
  }
  const validCaseIds = [...caseIds].filter(isChatAutoPermitCaseId);
  if (validCaseIds.length === 0) {
    await append({ caseId: null, reason: "case_unresolved_adverse_event", sourceRef, nowIso: input.nowIso });
    return;
  }
  // P1-1: 개별 케이스마다 독립적으로 시도한다 — 앞선 caseId의 append 실패가 뒤 caseId들의
  // disarm 시도 자체를 막으면 안 된다(종전 코드는 for 루프 중간에서 던지면 나머지를 건너뛰었다).
  const failures: Array<{ caseId: string; error: unknown }> = [];
  for (const caseId of validCaseIds) {
    try {
      const pins = pinsByCase.get(caseId) ?? [];
      const uniquePins = [...new Map(pins.map((pin) => [`${pin.casebookHash}|${pin.modelVersion}`, pin])).values()];
      if (uniquePins.length === 0) {
        await append({ caseId, reason: input.reason, sourceRef, nowIso: input.nowIso });
      } else {
        // evidence 가 서로 다른 pin 을 가리키면 각각 시도 — 라이브 permit pin 과 일치하는 것만 실제로 disarm 한다.
        for (const pin of uniquePins) {
          await append({ caseId, reason: input.reason, sourceRef, nowIso: input.nowIso, expectedPin: { casebookHash: pin.casebookHash, modelVersion: pin.modelVersion } });
        }
      }
    } catch (error) {
      failures.push({ caseId, error });
    }
  }
  if (failures.length > 0) {
    await recordChatAutoPermitAdverseRetryAlert({
      reason: input.reason,
      sourceRef,
      committedRefs: input.committedRefs,
      failedCaseIds: failures.map((failure) => failure.caseId),
      nowIso: input.nowIso,
    }).catch((alertError) => {
      console.error("[chat-auto-permit-adverse] retry alert record failed", {
        sourceRef,
        failureKind: safeOutboundFailureEvidence(alertError, "chat_auto_permit_adverse_retry_alert").failureKind,
      });
    });
    // 실패는 여전히 던진다(recordOutboundSendFailure 등 호출부의 기존 전파 계약 유지) — 단
    // 위에서 이미 재시도 가능한 흔적을 durable하게 남긴 뒤이므로, 이걸 삼키는 호출부(예:
    // mailSafetyPolicy.recordMailSuppression)에서도 disarm 자체는 유실되지 않는다.
    throw failures[0].error;
  }
}

/**
 * P1-1: drainChatAutoPermitAdverseRetryAlerts — scp_canary_alerts에 쌓인 permit_adverse_retry
 * 미해결 건을 다시 시도한다. index.ts의 monitorOutboundOutputHeartbeatSchedule(5분 주기 기존
 * 스케줄)이 매 pass 끝에 이 함수를 호출한다 — 새 onSchedule을 추가하지 않는다(이 저장소 규약,
 * onSchedule 총수 고정). 성공하면 status:"resolved"로 표시하고, 다시 실패하면 attempts만 늘려
 * 다음 pass에 맡긴다. 이 파일은 slackScheduledReports를 import하지 않는다(그 반대 방향 의존이
 * 이미 있어 — outreachSendHealthReport→mailOutboundSafety — 여기서 걸면 순환 참조가 생긴다).
 * 그래서 슬랙 통지 여부만 slackNotices로 반환하고, 실제 전송은 호출부(index.ts)가 한다.
 */
export async function drainChatAutoPermitAdverseRetryAlerts(
  nowIsoInput?: string,
  deps: ChatAutoPermitAdverseHookDeps = {},
): Promise<{
  scanned: number;
  resolved: number;
  stillPending: number;
  slackNotices: ReadonlyArray<{ sourceRef: string; reason: string; attempts: number }>;
}> {
  const nowIso = nowIsoInput ?? new Date().toISOString();
  const snapshot = await adminDb.collection("scp_canary_alerts")
    .where("kind", "==", CHAT_AUTO_PERMIT_ADVERSE_RETRY_ALERT_KIND)
    .limit(50)
    .get();
  let resolved = 0;
  let scanned = 0;
  const slackNotices: Array<{ sourceRef: string; reason: string; attempts: number }> = [];
  for (const doc of snapshot.docs) {
    const data = asRecord(doc.data());
    if (asString(data.status, "") !== "pending") continue;
    scanned += 1;
    const reason = asString(data.reason, "");
    const sourceRef = asString(data.sourceRef, "");
    const committedRefs = Array.isArray(data.committedRefs)
      ? data.committedRefs.filter((ref: unknown): ref is string => typeof ref === "string")
      : [];
    if (!reason || !sourceRef) continue;
    try {
      await recordChatAutoPermitAdverseFromCommittedRefs({
        reason: reason as Exclude<ChatAutoPermitAdverseReason, "case_unresolved_adverse_event">,
        sourceRef,
        committedRefs,
        nowIso,
      }, deps);
      await doc.ref.set({ status: "resolved", resolvedAtIso: nowIso }, { merge: true });
      resolved += 1;
    } catch (error) {
      console.error("[chat-auto-permit-adverse] retry sweep still failing", {
        sourceRef,
        failureKind: safeOutboundFailureEvidence(error, "chat_auto_permit_adverse_retry_sweep").failureKind,
      });
      // P1-1: 원래 실패(1) + 이 sweep에서도 또 실패(2) — 일시적 흔들림이 아니라 반복 실패다.
      // 같은 문서당 슬랙은 한 번만(notifiedSlackAtIso 선점) — 5분마다 스팸하지 않는다.
      const attempts = cleanNumber(data.attempts, 0);
      if (attempts >= 2 && !data.notifiedSlackAtIso) {
        await doc.ref.set({ notifiedSlackAtIso: nowIso }, { merge: true }).catch(() => undefined);
        slackNotices.push({ sourceRef, reason, attempts });
      }
    }
  }
  return { scanned, resolved, stillPending: scanned - resolved, slackNotices };
}

export function classifyBounceImpact(failure: Pick<OutboundFailure, "kind" | "reason">) {
  const smtpStatus = /(?:^|[\s;])([45]\d{2})(?=[\s-]|$)/.exec(failure.reason)?.[1] ?? "";
  const temporary = failure.kind === "hard_bounce" && smtpStatus.startsWith("4");
  return {
    suppressRecipient: RECIPIENT_SUPPRESSION_FAILURE_KINDS.has(failure.kind) && !temporary,
    countsTowardBounceRate: BOUNCE_RATE_NUMERATOR_FAILURE_KINDS.has(failure.kind) && !temporary,
    excludedNoMx: failure.kind === "no_mx",
    excludedTemporary: temporary,
  };
}

export type RampUpStep = {
  readonly day: number;
  readonly dailyCap: number;
};

export type OutboundPolicy = {
  readonly hourlyCap: number;
  readonly dailyCap: number;
  readonly burstCap: number;
  readonly burstWindowMinutes: number;
  readonly uniqueRecipientDailyCap: number;
  // A3(RT-3)/S3: 전역(차원 무관) 주간 총량 cap — sender/emailProfile/program/campaign
  // 어떤 차원으로도 우회 불가한 단일 global ledger 키에 대응(ADR-1 v2). UTC 월요일 00:00 시작.
  readonly weeklyTotalCap: number;
  readonly hardBounceLockThreshold: number;
  readonly highVolumeEnabled: boolean;
  readonly reputationStatus: string;
  // Warmup ramp-up: per-account-age daily cap ceiling. Steps are sorted by day;
  // the effective cap for an account `age` days old is the cap of the highest
  // step whose `day` <= age. Empty plan = no ramp restriction.
  readonly rampUpPlan: ReadonlyArray<RampUpStep>;
  // Random inter-send delay window (seconds) applied to LIVE sends only.
  readonly jitterMinSeconds: number;
  readonly jitterMaxSeconds: number;
  // W72-A [리더 승인 2026-08-12]: 캡 초과는 "보내면 안 되는 것"이 아니라 "지금은 못 보내는 것"이다.
  // 소비 재시도로 태우면 캡에 막힌 메일이 6회 만에 dead_letter 로 영구 폐기된다(코호트2 실측:
  // 일간 캡 여유가 1~7통인데 주당 76통을 적재하면 대다수가 이 경로를 탄다).
  // 그래서 비소모 유예로 돌리되, **유예에도 상한을 건다**(헤세 추가 조건: 무한 재시도 금지).
  // 수치는 일간 캡 재설계와 함께 확정되므로 여기서 주입만 가능하게 열어 둔다.
  readonly quotaDeferralCap: number;
};

export type QuotaReservation = {
  readonly allowed: true;
  readonly duplicate: boolean;
  readonly eventId: string;
  readonly dayKey: string;
  readonly hourKey: string;
  readonly weekKey: string;
};

export type WeeklyQuotaUsage = {
  readonly weekKey: string;
  readonly used: number;
  readonly cap: number;
};

function cleanNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

function cleanBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

// Parse a ramp-up plan from settings: keep only well-formed { day>=1, dailyCap>=0 }
// steps, dedupe by day (last wins), and sort ascending by day. Returns fallback
// when the value is absent so ramp-up stays opt-in.
function cleanRampUpPlan(value: unknown, fallback: ReadonlyArray<RampUpStep>): ReadonlyArray<RampUpStep> {
  if (!Array.isArray(value)) return fallback;
  const byDay = new Map<number, number>();
  for (const entry of value) {
    const record = asRecord(entry);
    const day = cleanNumber(record.day, 0);
    if (day < 1) continue;
    byDay.set(day, cleanNumber(record.dailyCap, 0));
  }
  return [...byDay.entries()]
    .map(([day, dailyCap]) => ({ day, dailyCap }))
    .sort((left, right) => left.day - right.day);
}

function currentDayKey(now: Date): string {
  return `day_${now.toISOString().slice(0, 10)}`;
}

function currentHourKey(now: Date): string {
  return `hour_${now.toISOString().slice(0, 13)}`;
}

function currentBurstKey(now: Date, minutes: number): string {
  const windowMs = Math.max(1, minutes) * 60_000;
  return `burst_${Math.floor(now.getTime() / windowMs)}`;
}

// A3(RT-3)/인터뷰 #1 확정: UTC 월요일 00:00 시작 — 기존 currentDayKey UTC 규약과 정렬해
// day/week 혼용 불일치를 피한다. 키는 그 주의 월요일 날짜(UTC)로 고정.
function currentWeekKey(now: Date): string {
  const utcMidnightMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayOfWeek = new Date(utcMidnightMs).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dayOfWeek + 6) % 7; // Mon=0
  const mondayMs = utcMidnightMs - daysSinceMonday * 24 * 60 * 60 * 1000;
  return `week_${new Date(mondayMs).toISOString().slice(0, 10)}`;
}

function mergePolicy(base: OutboundPolicy, record: Record<string, unknown>): OutboundPolicy {
  const dailyCapRaw = cleanNumber(record.dailyCap, base.dailyCap);
  const highVolumeEnabled = cleanBoolean(record.highVolumeEnabled, base.highVolumeEnabled);
  const reputationStatus = asString(record.reputationStatus, base.reputationStatus);
  const dailyCap = dailyCapRaw >= 500 && !(highVolumeEnabled && reputationStatus === "healthy") ? 499 : dailyCapRaw;
  const jitterMinSeconds = cleanNumber(record.jitterMinSeconds, base.jitterMinSeconds);
  const jitterMaxSecondsRaw = cleanNumber(record.jitterMaxSeconds, base.jitterMaxSeconds);
  return {
    hourlyCap: cleanNumber(record.hourlyCap, base.hourlyCap),
    dailyCap,
    burstCap: cleanNumber(record.burstCap, base.burstCap),
    burstWindowMinutes: cleanNumber(record.burstWindowMinutes, base.burstWindowMinutes),
    uniqueRecipientDailyCap: cleanNumber(record.uniqueRecipientDailyCap, base.uniqueRecipientDailyCap),
    weeklyTotalCap: cleanNumber(record.weeklyTotalCap, base.weeklyTotalCap),
    hardBounceLockThreshold: cleanNumber(record.hardBounceLockThreshold, base.hardBounceLockThreshold),
    highVolumeEnabled,
    reputationStatus,
    rampUpPlan: cleanRampUpPlan(record.rampUpPlan, base.rampUpPlan),
    jitterMinSeconds,
    jitterMaxSeconds: Math.max(jitterMinSeconds, jitterMaxSecondsRaw),
    quotaDeferralCap: cleanNumber(record.quotaDeferralCap, base.quotaDeferralCap),
  };
}

export async function readOutboundPolicy(): Promise<OutboundPolicy> {
  const defaults: OutboundPolicy = {
    hourlyCap: 10,
    dailyCap: 50,
    burstCap: 3,
    burstWindowMinutes: 10,
    uniqueRecipientDailyCap: 50,
    weeklyTotalCap: 50,
    hardBounceLockThreshold: 5,
    highVolumeEnabled: false,
    reputationStatus: "pilot",
    rampUpPlan: [],
    jitterMinSeconds: 30,
    jitterMaxSeconds: 180,
    // W72-A: 보수적 기본값. 실제 값은 레인 설정에서 주입한다(리더 확정: 레인별 250).
    quotaDeferralCap: 24,
  };
  const settings = await readSettings();
  const fromSettings = mergePolicy(defaults, asRecord(settings.mailSafety.outboundPolicy));
  const emailDoc = (await adminDb.doc("settings/email").get()).data();
  const emailRecord = asRecord(emailDoc);
  const outboundPolicy = asRecord(emailRecord.outboundPolicy);
  return mergePolicy(fromSettings, { ...emailRecord, ...outboundPolicy });
}

// Ramp-up cap for an account `ageDays` old: the dailyCap of the highest plan
// step whose `day` <= ageDays. Returns null when no step applies yet (account
// younger than the first step) or the plan is empty — callers treat null as
// "ramp imposes no restriction beyond the configured dailyCap".
export function rampUpDailyCap(policy: OutboundPolicy, ageDays: number): number | null {
  if (policy.rampUpPlan.length === 0) return null;
  let cap: number | null = null;
  for (const step of policy.rampUpPlan) {
    if (step.day <= ageDays) cap = step.dailyCap;
    else break;
  }
  return cap;
}

// Effective daily cap = min(configured dailyCap, ramp-up cap for current age).
// Ramp-up only ever tightens, never loosens.
export function effectiveDailyCap(policy: OutboundPolicy, ageDays: number): number {
  const ramp = rampUpDailyCap(policy, ageDays);
  return ramp === null ? policy.dailyCap : Math.min(policy.dailyCap, ramp);
}

// Account age in whole days since the warmup anchor (settings/email.warmupStartIso).
// No anchor → null (caller skips ramp restriction; configured dailyCap still bounds).
export function accountAgeDaysFrom(warmupStartIso: string, now = new Date()): number | null {
  if (!warmupStartIso) return null;
  const startMs = Date.parse(warmupStartIso);
  if (!Number.isFinite(startMs)) return null;
  const ageDays = Math.floor((now.getTime() - startMs) / (24 * 60 * 60 * 1000)) + 1;
  return Math.max(1, ageDays);
}

// Random jitter delay (ms) within the policy window. Live-send only — callers
// must NOT await this on dryRun so emulator tests stay fast.
export function pickJitterDelayMs(policy: OutboundPolicy): number {
  const min = Math.max(0, policy.jitterMinSeconds);
  const max = Math.max(min, policy.jitterMaxSeconds);
  const seconds = min + Math.random() * (max - min);
  return Math.round(seconds * 1000);
}

export async function readOutreachSendingEnabled(): Promise<boolean> {
  const snapshot = await adminDb.doc(OUTBOUND_SAFETY_STATE_PATH).get();
  return snapshot.data()?.outreachSendingEnabled === true;
}

/**
 * W118 — 독려 레인 킬스위치.
 *
 * **필드가 없으면 false(정지)** 다. 근거: 2026-09-03 09:20Z 부터 운영자가 아웃리치를 끈 상태이고,
 * 그 정지는 독려까지 함께 멈춰 있었다(같은 스위치 하나였다). 배포 순간 필드가 없다고 해서 독려가
 * **자동으로 재개되면** 운영자가 누르지 않은 발송이 나간다. 재개는 사람이 명시적으로 켜야 한다.
 * 콜러블이 값을 바꿀 때는 항상 명시적으로 기록한다(setNudgeSendingEnabled).
 */
export async function readNudgeSendingEnabled(): Promise<boolean> {
  const snapshot = await adminDb.doc(OUTBOUND_SAFETY_STATE_PATH).get();
  return snapshot.data()?.nudgeSendingEnabled === true;
}

export async function setOutreachSendingEnabled(enabled: boolean, updatedBy: string, updatedAtIso: string): Promise<void> {
  await adminDb.doc(OUTBOUND_SAFETY_STATE_PATH).set({
    outreachSendingEnabled: enabled,
    manualPauseUpdatedAtIso: updatedAtIso,
    manualPauseUpdatedBy: updatedBy,
    updatedAtIso,
  }, { merge: true });
}

export async function setNudgeSendingEnabled(enabled: boolean, updatedBy: string, updatedAtIso: string): Promise<void> {
  await adminDb.doc(OUTBOUND_SAFETY_STATE_PATH).set({
    nudgeSendingEnabled: enabled,
    // 레인별 변경 이력은 레인별로 남긴다 — 아웃리치 토글이 독려 이력을 덮어쓰면 "누가 언제 켰나"를
    // 못 읽는다.
    nudgePauseUpdatedAtIso: updatedAtIso,
    nudgePauseUpdatedBy: updatedBy,
    updatedAtIso,
  }, { merge: true });
}

/**
 * W118 — 이 레인이 **수동 정지** 상태인가(순수). 하드락(blockedUntilIso)은 여기 포함하지 않는다 —
 * 그건 시간이 지나면 풀리는 잠금이고 기존 유예(quota_deferred) 경로가 다룬다.
 * 거래성 레인은 수동 정지의 대상이 아니다.
 */
export function resolveMailLaneManualPause(
  data: Record<string, unknown>,
  lane: MailOutboundLane,
): boolean {
  if (lane === "transactional") return false;
  return lane === "nudge"
    ? data.nudgeSendingEnabled !== true
    : data.outreachSendingEnabled !== true;
}

/** 드레인이 **패스 시작에 한 번** 부르는 레인 정지 조회. 행 단위로 부르면 안 된다. */
export async function readMailLaneManualPause(lane: MailOutboundLane): Promise<boolean> {
  // 거래성은 어떤 문서 상태에서도 수동 정지 대상이 아니다 — 읽을 이유가 없다(발송당 1 read 절약).
  if (lane === "transactional") return false;
  const snapshot = await adminDb.doc(OUTBOUND_SAFETY_STATE_PATH).get();
  return resolveMailLaneManualPause(snapshot.data() ?? {}, lane);
}

export async function readOutboundSafetyBlock(
  nowIso: string,
  mode: MailSafetyMode = "auto_send",
  lane: MailOutboundLane = "outreach",
): Promise<OutboundSafetyBlock> {
  const snapshot = await adminDb.doc(OUTBOUND_SAFETY_STATE_PATH).get();
  return resolveOutboundSafetyBlock(snapshot.data() ?? {}, nowIso, mode, lane);
}

/**
 * 잠금 조회기의 주입 지점. 세 게이트(evaluateMailSafety · assertOutboundSendPermitted ·
 * assertRecipientDeliverabilityAllowed)가 **정말로 payload 의 레인을 보는지**를 노드 레인에서
 * 값으로 확인하기 위해 뚫었다. 프로덕션은 항상 기본값(Firestore 조회)을 쓴다.
 */
export type OutboundSafetyBlockReader = (
  nowIso: string,
  mode: MailSafetyMode,
  lane: MailOutboundLane,
) => Promise<OutboundSafetyBlock>;

export type MailLaneGateDeps = {
  readonly readOutboundSafetyBlock?: OutboundSafetyBlockReader;
  /**
   * 2026-09-10 adversarial review CRITICAL-2 (split-brain quota gate): the already-selected
   * mail_accounts/{accountId} this send will actually go out from. When given, the identity
   * kill-switch check and the "mailbox" quota dimension are scoped to THIS account instead of
   * always the global scp identity — otherwise every account's send shared one scp-only
   * identity/quota bucket, so disabling scp blocked unrelated accounts' sends (and vice versa),
   * and non-scp accounts never got their own hour/burst quota ledger. Omitted (existing callers)
   * keeps today's scp-only behavior byte-identical — resolveMailIdentityContextForAccount
   * delegates straight to resolveOperationalMailIdentityContext for kind "canonical_scp".
   */
  readonly mailAccount?: MailAccount;
};

/** 메일 레코드에서 레인을 읽어 그 레인 기준으로 잠금을 판정한다. */
export async function readOutboundSafetyBlockForMail(
  data: Record<string, unknown>,
  nowIso: string,
  mode: MailSafetyMode = "auto_send",
  readBlock: OutboundSafetyBlockReader = readOutboundSafetyBlock,
): Promise<OutboundSafetyBlock> {
  return readBlock(nowIso, mode, resolveMailOutboundLane(data));
}

export async function monitorOutboundOutputHeartbeat(nowIsoInput?: string) {
  const nowIso = nowIsoInput ?? new Date().toISOString();
  const dayKey = koreaDayKeyFrom(new Date(nowIso));
  const [safetySnapshot, approvedSnapshot, counterSnapshot] = await Promise.all([
    adminDb.doc(OUTBOUND_SAFETY_STATE_PATH).get(),
    adminDb.collection("campaign_outreach").where("deliveryState", "==", "approved")
      .select("liveSend", "dryRun", "liveSendBatchId", "liveSendBatchCap", "maxLiveSendBatchSends").get(),
    adminDb.collection("campaign_outreach_daily_counters").doc(dayKey).get(),
  ]);
  const safety = safetySnapshot.data() ?? {};
  const previous = asRecord(safety.outputHeartbeat);
  const sent = cleanNumber(counterSnapshot.data()?.sent, 0);
  const approved = approvedSnapshot.size;
  const batchAuthorized = approvedSnapshot.docs.some((doc) => {
    const row = doc.data() ?? {};
    const cap = cleanNumber(row.liveSendBatchCap, cleanNumber(row.maxLiveSendBatchSends, 0));
    return row.liveSend === true && row.dryRun !== true && asString(row.liveSendBatchId, "").trim() !== "" && cap > 0;
  });
  const block = resolveOutboundSafetyBlock(safety, nowIso);
  const silenceReason = approved === 0 ? "approved_empty" : block.blocked ? "outbound_safety_locked" : !batchAuthorized ? "batch_authorization_inactive" : "";
  if (silenceReason) {
    await adminDb.doc(OUTBOUND_SAFETY_STATE_PATH).set({
      outputHeartbeat: { active: false, status: "silenced", silenceReason, checkedAtIso: nowIso, dayKey, lastSentCount: sent, stagnantTicks: 0, approved },
    }, { merge: true });
    console.info("[outbound-output-heartbeat] silenced", { reason: silenceReason, approved, sent });
    return { status: "silenced", reason: silenceReason, approved, sent, stagnantTicks: 0, batchAuthorized };
  }
  const previousSent = cleanNumber(previous.lastSentCount, -1);
  const stagnantTicks = previous.active === true && previous.dayKey === dayKey && sent <= previousSent
    ? cleanNumber(previous.stagnantTicks, 0) + 1
    : 0;
  const status = stagnantTicks >= 3 ? "stalled" : "healthy";
  await adminDb.doc(OUTBOUND_SAFETY_STATE_PATH).set({
    outputHeartbeat: { active: true, status, silenceReason: "", checkedAtIso: nowIso, dayKey, lastSentCount: sent, stagnantTicks, approved },
  }, { merge: true });
  if (status === "stalled") {
    const evidence = { errorCode: "campaign_outreach_output_stalled", kind: "output_stall", ruleId: "campaign-outreach.output-heartbeat", approved, sent, stagnantTicks, createdAtIso: nowIso };
    console.error("[outbound-output-heartbeat] stalled", evidence);
    await adminDb.collection("scp_canary_alerts").doc("outbound-output-heartbeat-stalled").set({ status, ...evidence, createdAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  return { status, approved, sent, stagnantTicks, batchAuthorized };
}

/**
 * Convert the persisted lock document into the only public outbound-block shape.
 * Stored provider/bounce reasons are intentionally not returned: they can contain
 * recipient addresses or provider diagnostics. Invalid or expired timestamps are
 * treated as inactive and their stale reason/rule/unlock fields are omitted.
 */
export function resolveOutboundSafetyBlock(
  data: Record<string, unknown>,
  nowIso: string,
  mode: MailSafetyMode = "auto_send",
  lane: MailOutboundLane = "outreach",
): OutboundSafetyBlock {
  const blockedUntilIso = asString(data.blockedUntilIso, "");
  const blockedUntilMs = Date.parse(blockedUntilIso);
  const nowMs = Date.parse(nowIso);
  if (Number.isFinite(blockedUntilMs) && Number.isFinite(nowMs) && blockedUntilMs > nowMs) {
    return {
      blocked: true,
      ruleId: OUTBOUND_ACTIVE_LOCK_RULE_ID,
      reason: OUTBOUND_ACTIVE_LOCK_REASON,
      blockedUntilIso,
    };
  }
  if (mode === "manual_send") return { blocked: false };
  // W118 [프로드 사고 2026-09-03~05]: 수동 정지는 **레인 스위치**다. 종전에는 스위치가 하나뿐이라
  //   아웃리치를 끈 것이 지원확인·로그인승인·콘텐츠접수·온보딩까지 함께 죽였다.
  //   거래성 레인은 하드락(blockedUntilIso)과 나머지 안전 규칙에만 걸린다 — 수동 정지의 대상이
  //   아니다. 본인 행동이 유발한 확인 메일을 캠페인 스위치로 막을 이유가 없다.
  if (resolveMailLaneManualPause(data, lane)) {
    return {
      blocked: true,
      ruleId: OUTBOUND_MANUAL_PAUSE_RULE_ID,
      reason: lane === "nudge" ? OUTBOUND_NUDGE_PAUSE_REASON : OUTBOUND_MANUAL_PAUSE_REASON,
      pausedLane: lane,
    };
  }
  return { blocked: false };
}

export async function lockOutboundMail(reason: string, ruleId: string, lockMs: number, nowIso: string): Promise<void> {
  const blockedUntilIso = new Date(Date.parse(nowIso) + lockMs).toISOString();
  await adminDb.doc(OUTBOUND_SAFETY_STATE_PATH).set({
    status: "locked",
    reason,
    ruleId,
    blockedUntilIso,
    lastLockedAtIso: nowIso,
    updatedAtIso: nowIso,
    failureCount: FieldValue.increment(1),
  }, { merge: true });
}

function isCampaignColdmailQuotaScope(data: Record<string, unknown>): boolean {
  const mailType = asString(data.mailType, "").trim().toLowerCase();
  const source = asString(data.source, "").trim().toLowerCase();
  // The Program > Campaign daily/wave cap is a campaign-coldmail control only.
  // Transactional SCP result mail (qualification pass/fail, re-guide, etc.) still
  // goes through sender/emailProfile/global/unique provider safety below, but must
  // not be blocked because a campaign coldmail program bucket is full.
  return mailType === "campaign_coldmail" || source === "campaign_outreach";
}

/**
 * W59b-2 [리더 브리프 §2 · 물리 발신함 쿼터 키]
 *
 * 형상: hourly(120)/burst(20) 원장의 `sender` 차원이 **실제 발신함이 아니라** ownerEmail/profile 키였다
 * (data.from 이 비면 ownerEmail 로 떨어진다). 캠페인/프로그램 레이어드 프로필은 서로 다른 ownerEmail 을
 * 갖고도 **같은 물리 메일함**으로 resolve 될 수 있으므로, 다중 캠페인이 같은 발신함을 쓰면 시간당 캡이
 * 캠페인 수만큼 곱으로 뚫린다(현 프로드는 활성 1캠페인이라 잠복 상태).
 *
 * 수리: `mailbox` 차원(= 실제 SMTP from)을 추가하고 **hour/burst 를 그 축으로** 센다.
 * day/weekly 는 공유 원장이라 무변경이다(리더 브리프) — 그리고 day 키를 갈아끼우면 하루 중간에
 * 카운터가 0 으로 리셋돼 그날 캡이 두 배로 열린다.
 *
 * 전환 처리(리더 L2026-0809-11 승인)**였던 것**: legacy `sender` 축의 hour/burst 를 병행 유지했다.
 * 두 원장 중 타이트한 쪽이 이기므로 어느 순간에도 종전보다 느슨해지지 않았다 — 배포 시각 상수 같은
 * seam 이 필요 없었다(그 상수는 배포 때마다 사람이 맞춰야 하고 틀리면 조용히 캡이 열린다).
 * ⚠️ 이 병행은 **이미 끝났다**(아래). 현재형으로 읽으면 안 된다.
 *
 * ✅ 병행 해제 완료(W60-3, 2026-08-09 20:36 KST). 아래 조건을 실측으로 확인하고 sender 의 hour/burst 를 제거했다.
 *    이제 시간당/버스트 캡은 mailbox 축 단독이다. 이력 보존용으로 조건을 남긴다:
 * ⚠️ (해제 조건이었던 것) **마지막 legacy hour 창이 만료된 뒤**.
 *    hour 창이 burst 창보다 길므로 hour 기준이면 충분하고, 배포 완료 시각 + 1시간이 지나면 legacy
 *    hour/burst 원장에는 이 코드가 만든 카운트가 더 이상 남아 있지 않다(창 키가 시각으로 롤링된다).
 *    그 시점 이후 **sender 항목의 리터럴 periods 배열에서** "hour"/"burst" 두 값만 지우면 된다.
 *    (그 배열이 리터럴인 이유가 이것이다 — 공유 상수를 지우면 emailProfile·program·campaign 축의
 *     시간당/버스트 throttle 까지 함께 죽는다. W59d-F2.)
 *    확인 방법: mail_quota_ledger 에서 kind=sender + period=hour_<현재창> 문서가 더 이상 증가하지 않음.
 */
type QuotaDimension = {
  readonly kind: string;
  readonly value: string;
  /** 이 차원이 참여하는 창. day 는 공유 원장 축이라 종전 그대로다. */
  readonly periods: ReadonlyArray<"day" | "hour" | "burst">;
  /**
   * W72 [R1 P1-3]: 이 차원만의 day 캡. 지정하면 전역 `policy.dailyCap` 대신 이 값이 쓰인다.
   * 독려 레인처럼 **전역보다 좁은 개별 상한**을 같은 트랜잭션 안에서 강제하기 위한 축이다.
   */
  readonly dayCap?: number;
};

const ALL_QUOTA_PERIODS = ["day", "hour", "burst"] as const;

/**
 * W72 [R1 P1-3]: 독려 레인 축을 만든다. **순수 함수로 뽑은 이유**는 소스 문자열 테스트가
 * "가드를 `if (false)` 로 바꾸는" 뮤테이션을 못 잡았기 때문이다 — 판정을 값으로 확인할 수 있어야 한다.
 *
 * 캡이 null(독려 purpose 아님)이거나 purpose 가 비면 축을 세우지 않는다.
 */
export function buildNudgeLaneQuotaDimension(
  mailPurpose: string,
  dayCap: number | null,
): QuotaDimension | null {
  if (dayCap === null || !Number.isFinite(dayCap) || !mailPurpose) return null;
  return { kind: LANE_QUOTA_KIND, value: mailPurpose, periods: ["day"], dayCap };
}

/**
 * [헤세 2026-09-03 · 적대 리뷰 MEDIUM 수리] 세 코호트 **합산** 축을 만든다.
 *
 * `totalDailyQuotaAllows`(mailOutboundSafety.ts, 드레인이 쓰는 peek)는 트랜잭션 밖 read-then-act
 * 라 코호트2 드레인과 코호트1·3 드레인이 같은 순간에 돌면 둘 다 "199/200 허용"을 보고 동시에
 * 통과할 수 있다 — 구조적으로 캡을 넘긴다. 레인 캡이 바로 이 문제를 `LANE_QUOTA_KIND` 축으로
 * 풀었던 것과 같은 방식으로, **값이 고정된**(mailPurpose 무관) 축을 세워 예약 트랜잭션 안에서
 * 원자적으로 체크·증분한다 — value 가 고정이라 세 레인 전부가 **같은 한 문서**를 공유한다
 * (`buildNudgeLaneQuotaDimension` 은 레인마다 문서가 갈리지만, 이 축은 일부러 안 가른다).
 *
 * 캡이 null(합산 상한 미설정) 이면 축을 세우지 않는다 — 기존 동작(코호트별 캡만) 유지.
 */
export function buildNudgeTotalQuotaDimension(dayCap: number | null): QuotaDimension | null {
  if (dayCap === null || !Number.isFinite(dayCap)) return null;
  return { kind: NUDGE_TOTAL_QUOTA_KIND, value: NUDGE_TOTAL_QUOTA_VALUE, periods: ["day"], dayCap };
}

function quotaDimensions(
  data: Record<string, unknown>,
  physicalMailbox = "",
  nudgeLaneDayCap: number | null = null,
  nudgeTotalDayCap: number | null = null,
): QuotaDimension[] {
  const profile = asRecord(data.resolvedProfileSnapshot);
  const sender = normalizeEmailAddress(asString(data.from, asString(data.ownerEmail, "default-sender")));
  const emailProfile = asString(data.policyVersion, asString(profile.id, "global-mail-profile"));
  // W59d-F1: 호출부가 이미 정규화해 넘기지만, 여기서도 **주소 추출** 정규화를 건다 —
  // 트림+소문자만 하면 display name 형태가 다른 버킷이 되어 곱셈 구멍이 되살아난다.
  const mailbox = normalizeMailboxAddress(physicalMailbox);
  const dimensions: QuotaDimension[] = [
    // ⚠️ sender 가 **첫 항목**이어야 한다 — 아래 unique-recipient 원장이 dimensions[0] 을 키로 쓴다.
    // W60-3 [b1 병행 해제 · 조건 충족]: hour/burst 를 뺐다. 이제 시간당/버스트 캡은 **mailbox 축 단독**이다.
    //
    // 해제 조건(W59b-2 주석)은 "마지막 legacy hour 창 만료 후 = 배포 완료 + 1시간"이었다.
    // 근거: 배포 순간에는 mailbox 축이 시간창 **도중 0 부터** 시작하므로 그 창에서만 legacy 가
    // 이중 계상을 막아 준다. 창이 한 번 넘어가면 mailbox 카운터가 창 시작부터 온전히 커버한다.
    // 실측(artifacts/w60/w60-item3-precondition.md, 2026-08-09 19:55 KST):
    //   · mailbox 축 distinct value = 1 (물리 발신함 하나로 접힘 — 이 항목의 목적)
    //   · 같은 창의 legacy sender 축 distinct value = 4 (종전 모델이면 시간당 캡이 4배로 열려 있었다)
    //   · 양 축 최종 갱신 시각 동일 → 병행이 실제로 함께 가동됐다
    // 착수 시각(20:35 KST = 11:35Z)의 창 `hour_2026-08-09T11` 은 11:00Z 에 시작 = 배포 완료 이후 → 충족.
    //
    // day 는 그대로 둔다 — 공유 원장 축이고, day 키를 갈아끼우면 하루 중간에 카운터가 리셋돼
    // 그날 캡이 두 배로 열린다(W59b-2 의 원래 근거).
    { kind: "sender", value: sender || "default-sender", periods: ["day"] },
    { kind: "emailProfile", value: emailProfile, periods: ALL_QUOTA_PERIODS },
  ];
  // 물리 발신함을 해석하지 못한 경로(dry-run 등 provider 를 부르지 않는 예약)는 이 축을 세우지 않는다 —
  // 그 경로는 실제 메일함 용량을 소모하지 않으므로 세울 근거가 없다.
  // W60c-M1 [해제 후 주석 정합]: 종전 주석은 "종전 축만 쓴다"였는데, 병행 해제(W60-3)로 sender 에는
  //   day 밖에 없다 — 문장만 보면 "그 경로엔 시간당 캡이 없다"로 읽힌다. 실제로는 emailProfile 축이
  //   ALL_QUOTA_PERIODS(day·hour·burst)를 계속 들고 있어 시간당/버스트가 여전히 강제된다.
  //   즉 mailbox 축이 없을 때의 시간당 방파제는 **emailProfile** 이다.
  if (mailbox) {
    dimensions.push({ kind: "mailbox", value: mailbox, periods: ["hour", "burst"] });
  }
  if (isCampaignColdmailQuotaScope(data)) {
    dimensions.push(
      { kind: "program", value: asString(data.programId, ""), periods: ALL_QUOTA_PERIODS },
      { kind: "campaign", value: asString(data.campaignId, ""), periods: ALL_QUOTA_PERIODS },
    );
  }
  // W72 [R1 P1-3]: 독려 레인 축. 이 축이 **쿼터 예약 트랜잭션 안**에 있어야 하는 이유:
  //   ① 드레인의 read → send → increment 는 원자적이지 않아 250번째 발송 뒤 커밋이 실패하면
  //      다음 실행이 251번째를 허용한다. 여기서는 예약과 카운트가 한 트랜잭션이라 그 창이 없다.
  //   ② 드레인 밖(일반 sendEmail 콜러블 등)에서 같은 mailPurpose 로 보내면 레인 캡을 통째로
  //      우회한다. 모든 라이브 발송이 이 예약을 지나므로 여기 두면 경로와 무관하게 강제된다.
  const laneDimension = buildNudgeLaneQuotaDimension(asString(data.mailPurpose, ""), nudgeLaneDayCap);
  if (laneDimension) dimensions.push(laneDimension);
  // [헤세 2026-09-03] 합산 축 — 레인 축과 같은 이유로 트랜잭션에 둔다(위 buildNudgeTotalQuotaDimension 주석).
  const totalDimension = buildNudgeTotalQuotaDimension(nudgeTotalDayCap);
  if (totalDimension) dimensions.push(totalDimension);
  return dimensions.filter((item) => item.value);
}

function eventIdFor(data: Record<string, unknown>, source: string, mode: MailSafetyMode): string {
  const seed = [
    source,
    mode,
    asString(data.idempotencyKey, ""),
    asString(data.sendIntentKey, ""),
    asString(data.messageRef, ""),
    asString(data.trackingId, ""),
    asString(data.to, asString(data.creatorEmail, "")),
  ].filter(Boolean).join("|");
  return safeMailDocId("mail_quota_event", seed || `${source}:${mode}:${Date.now()}`);
}

function ledgerDocId(kind: string, value: string, period: string): string {
  return safeMailDocId("mail_quota", `${kind}:${value}:${period}`);
}

function reservationMarkerPatch(eventId: string): { reservations: Record<string, true> } {
  return { reservations: { [eventId]: true } };
}

function reservationMarked(data: unknown, eventId: string): boolean {
  const record = asRecord(data);
  const nested = asRecord(record.reservations);
  return nested[eventId] === true || record[`reservations.${eventId}`] === true;
}

function recipientMarkerPatch(recipientKey: string): { recipients: Record<string, true> } {
  return { recipients: { [recipientKey]: true } };
}

function recipientMarked(data: unknown, recipientKey: string): boolean {
  const record = asRecord(data);
  const nested = asRecord(record.recipients);
  return nested[recipientKey] === true || record[`recipients.${recipientKey}`] === true;
}

// A3(RT-3): 전역 weekly ledger 문서 키 — 차원(kind/value)이 고정("global"/"weekly-total")이라
// sender/emailProfile/program/campaign 어떤 값으로도 별도 버킷이 생기지 않는다(우회 차단의 핵심).
const WEEKLY_GLOBAL_KIND = "global";
const WEEKLY_GLOBAL_VALUE = "weekly-total";
export const OUTBOUND_GLOBAL_DAILY_TOTAL_CAP = 1500;

function weeklyLedgerRef(weekKey: string) {
  return adminDb.collection("mail_quota_ledger").doc(ledgerDocId(WEEKLY_GLOBAL_KIND, WEEKLY_GLOBAL_VALUE, weekKey));
}

// W72-A [리더 승인 2026-08-12 · 캡 초과를 비소모 유예로]: 캡 초과와 안전 잠금은 `failed-precondition`
// 이라는 **같은 code** 로 나가서 드레인이 일반 전송 실패와 구분할 수 없었다. 그 결과 캡에 막힌 메일이
// 시도를 소모하고 6회 만에 dead_letter 로 죽었다. `code` 는 그대로 두고(기존 호출자 판정 불변)
// `errorCode` 만 세분화한다 — 추가 정보이지 계약 변경이 아니다.
export const OUTBOUND_QUOTA_EXCEEDED_ERROR_CODE = "outbound_quota_exceeded";
export const OUTBOUND_SAFETY_LOCK_ERROR_CODE = "outbound_safety_lock_active";

function quotaExceeded(message: string): Error {
  return Object.assign(failedPrecondition(message), {
    errorCode: OUTBOUND_QUOTA_EXCEEDED_ERROR_CODE,
  });
}

// W72-A [리더 확정 2026-08-12 · 레인별 개별 캡]: 콜드메일 일캡 500 + 독려 3코호트 각 250/일.
// 전역 스택(dimension/weekly/unique)은 **그대로 통과**한다 — 이건 우회가 아니라 그 위에 얹는
// 추가 상한이다. 레인 캡을 먼저 보므로 독려가 콜드메일 캡을 잠식하기 전에 스스로 멈춘다.
//
// 새 컬렉션을 만들지 않는다: 기존 `mail_quota_ledger` 의 문서 형상({dimension:{kind,value},period,count})
// 을 그대로 쓰고 kind 만 "lane" 이다. 문서 ID 조회라 새 인덱스도 필요 없다.
const LANE_QUOTA_KIND = "lane";
/** W72 [R2-5]: 재촉 레인의 mailType. provider 실패 재시도 허용목록 판정에 쓴다. */
export const NUDGE_PROVIDER_RETRY_MAIL_TYPE = "application_video_reminder";

// [헤세 2026-09-03] 세 코호트 합산 캡 원장. value 를 **고정**해 세 레인이 문서 하나를 공유한다
// (lane 은 mailPurpose 마다 문서가 갈린다 — 여기는 일부러 안 가른다. WEEKLY_GLOBAL_KIND/VALUE 와
// 같은 "고정 kind/value = 공유 카운터" 패턴).
const NUDGE_TOTAL_QUOTA_KIND = "nudge_total";
const NUDGE_TOTAL_QUOTA_VALUE = "all-cohorts";

function laneLedgerRef(lane: string, dayKey: string) {
  return adminDb.collection("mail_quota_ledger").doc(ledgerDocId(LANE_QUOTA_KIND, lane, dayKey));
}

/** 오늘 이 레인이 이미 쓴 발송 수. 캡 판정 전용 읽기(쓰기 없음). */
export async function readLaneDailyCount(lane: string, now = new Date()): Promise<number> {
  const snapshot = await laneLedgerRef(lane, currentDayKey(now)).get();
  return cleanNumber(snapshot.data()?.count, 0);
}

/**
 * 레인 캡 **사전 확인용 peek**(clean-skip 판정). 강제는 여기가 아니라
 * `reserveOutboundQuotaAfterIdentity` 의 `lane` 차원이 **예약과 같은 트랜잭션에서** 한다.
 * 전역 weekly peek 과 같은 성격이라 race 는 허용되고 최종 정합성은 트랜잭션이 보장한다.
 *
 * W72 [R1 P1-3]: 종전에는 여기가 유일한 판정이었고 소비는 발송 뒤 별도 증분이었다. 그래서
 *   (a) 발송 성공 후 증분 실패 시 캡이 1 열리고 (b) 드레인 밖 경로는 증분을 아예 안 탔다.
 */
export async function laneDailyQuotaAllows(
  lane: string,
  cap: number,
  now = new Date(),
): Promise<{ allowed: boolean; used: number; cap: number }> {
  const used = await readLaneDailyCount(lane, now);
  return { allowed: cap > 0 && used < cap, used, cap };
}

/**
 * [헤세 2026-09-03] 세 코호트(`NUDGE_LANE_PURPOSE_TO_COHORT` 의 mailPurpose 들) **합산** 판정.
 * `laneDailyQuotaAllows` 와 **같은 카운터**(`readLaneDailyCount` → `mail_quota_ledger` 문서,
 * kind:"lane", 문서ID `mail_quota:lane:{mailPurpose}:{day_YYYY-MM-DD}`(UTC 일 경계, `currentDayKey`))
 * 를 레인별로 읽어 더할 뿐 새 카운터를 쓰지 않는다 — 레인 캡 판정과 이 판정 사이에 이중 계상이
 * 생기지 않는다(둘 다 같은 원장을 읽기만 한다, 쓰기는 예약 트랜잭션 한 곳뿐).
 *
 * `readCount` 는 테스트 주입용이다(기본은 실제 `readLaneDailyCount`) — 순수 합산/임계 로직을
 * Firestore 없이 검증하기 위한 것으로, `laneQuotaCheck`/`sendAdapter` 등 이 파일 이웃 함수들의
 * 기존 DI 패턴과 같다.
 */
export async function totalDailyQuotaAllows(
  cap: number | null,
  now = new Date(),
  readCount: (lane: string, now: Date) => Promise<number> = readLaneDailyCount,
): Promise<{ allowed: boolean; used: number; cap: number | null }> {
  if (cap === null) return { allowed: true, used: 0, cap: null };
  const lanes = Object.keys(NUDGE_LANE_PURPOSE_TO_COHORT);
  const counts = await Promise.all(lanes.map((lane) => readCount(lane, now)));
  const used = counts.reduce((sum, count) => sum + count, 0);
  return { allowed: cap > 0 && used < cap, used, cap };
}

// 큐 드레인 루프 사전확인(clean-skip)용 읽기 전용 peek. 강제 자체는 reserveOutboundQuota
// 동일 트랜잭션의 global weekly ledger 문서가 한다 — 여기는 그 문서를 그대로 읽을 뿐
// 별도 카운터가 아니다(A3 "동일-tx rollup"). race는 advisory pre-check라 허용 — 최종
// 정합성은 트랜잭션이 보장한다.
export async function readOutboundWeeklyUsage(now = new Date()): Promise<WeeklyQuotaUsage> {
  const policy = await readOutboundPolicy();
  const weekKey = currentWeekKey(now);
  const snapshot = await weeklyLedgerRef(weekKey).get();
  return { weekKey, used: cleanNumber(snapshot.data()?.count, 0), cap: policy.weeklyTotalCap };
}

export async function assertCanonicalMailIdentityForQuota(
  mode: MailSafetyMode,
): Promise<MailIdentitySnapshot> {
  return (await assertCanonicalMailIdentityContextForQuota(mode)).identity;
}

/**
 * W59b-2: 물리 발신함(quota 의 mailbox 차원)을 얻으려면 identity 가 아니라 **컨텍스트**가 필요하다.
 * 이 게이트는 이미 컨텍스트를 resolve 하므로(resolveOperationalMailIdentity 가 그 위 얇은 래퍼다)
 * 여기서 그대로 돌려주면 **추가 Firestore 읽기가 0** 이다 — getRuntimeIntegration 은 캐시가 없어서
 * 새로 부르면 예약마다 읽기가 늘어난다.
 */
async function assertCanonicalMailIdentityContextForQuota(
  mode: MailSafetyMode,
  mailAccount?: MailAccount,
): Promise<OperationalMailIdentityContext> {
  const context = mailAccount
    ? await resolveMailIdentityContextForAccount(mailAccount)
    : await resolveOperationalMailIdentityContext();
  if (mailIdentityBlocksMode(context.identity, mode)) {
    throw mailIdentityBlockedError(context.identity, "quota_reservation");
  }
  return context;
}

/**
 * 실제 발신함 주소. from 이 비면 SMTP 로그인 계정으로 떨어진다(둘 다 같은 물리 메일함을 가리킨다).
 *
 * W59d-F1 [리뷰 실측 · HIGH]: 여기서 normalizeEmailAddress(트림+소문자)를 쓰면
 * `Supercent SCP <scp@supercent.io>` 같은 display name 형태가 bare 주소와 **다른 값**이 되어
 * 물리 발신함 원장이 갈라진다 — 리뷰어 실측으로 게이트가 canonical 1개로 본 발신함이 hour 원장
 * 4개로 쪼개졌다. 그러면 이 항목이 막으려던 곱셈 구멍이 그대로 되살아난다.
 * identity 게이트가 canonical 비교에 쓰는 것과 **같은** 주소 추출 정규화를 쓴다(normalizeMailboxAddress:
 * `<>` 안의 주소만 뽑고, display name 에 주소나 꺾쇠가 섞이면 빈 문자열로 fail-closed).
 */
function physicalMailboxFromContext(context: OperationalMailIdentityContext): string {
  return normalizeMailboxAddress(context.smtp.from) || normalizeMailboxAddress(context.smtp.authUser);
}

async function reserveOutboundQuotaAfterIdentity(
  data: Record<string, unknown>,
  source: string,
  mode: MailSafetyMode,
  now = new Date(),
  physicalMailbox = "",
): Promise<QuotaReservation> {
  const policy = await readOutboundPolicy();
  const eventId = eventIdFor(data, source, mode);
  const dayKey = currentDayKey(now);
  const hourKey = currentHourKey(now);
  const weekKey = currentWeekKey(now);
  const burstKey = currentBurstKey(now, policy.burstWindowMinutes);
  const recipient = normalizeEmailAddress(asString(data.to, asString(data.creatorEmail, "")));
  // W72 [R2-5]: 재촉 레인이 빠져 있었다. 빠지면 markOutboundQuotaReservationRetryable 이
  //   조기 반환하고, 예약이 `reserved` 로 남아 다음 실행이 **중복 예약**으로 분류된다 →
  //   provider 를 부르지도 않고 `delivery_unknown:quota_reserved_without_provider_receipt` 로
  //   종결된다. 확실한 SMTP 미수락조차 재시도되지 않는 계약 파괴라 형제 레인과 동일하게 넣는다.
  const providerFailureRetryAllowed = [
    "scp_application_confirmed",
    "scp_content_submission_received",
    NUDGE_PROVIDER_RETRY_MAIL_TYPE,
  ].includes(asString(data.mailType)) || isServerOwnedVideoResultProviderRetry(data);
  const recipientKey = recipient ? safeMailDocId("recipient", recipient) : "";
  // [헤세 2026-09-05 · 적대 리뷰 HIGH-1/MED-2] 전역 1500/일 총량 캡은 라이브 아웃리치·독려의
  //   총 발송량을 묶어 두려는 상한이다. 거래성 레인(본인 행동이 유발한 확인·안내 메일)은
  //   레인 킬스위치의 대상도 아니었다(resolveMailLaneManualPause) — 같은 이유로 이 전역 캡의
  //   대상도 아니어야 한다. dry-run/비라이브 예약은 위 laneContactsProvider 가드와 같은 근거로
  //   제외한다: provider 를 부르지 않아 실제 발송 용량을 쓰지 않는데 캡을 갉아먹으면 그만큼
  //   실발송이 줄어든다.
  const skipsGlobalDailyCap = resolveMailOutboundLane(data) === "transactional" || data.dryRun === true;
  // W72 [R1 P1-3]: 레인 캡을 예약 트랜잭션의 축으로 세운다. 독려 purpose 가 아니면 null 이라
  //   기존 차원 구성이 그대로다(기존 3레인 동작 불변).
  // W72 [R2-2]: dry-run/비라이브 예약은 **레인 축을 세우지 않는다.** provider 를 부르지 않아
  //   실제 발송 용량을 쓰지 않는데 캡을 갉아먹으면 그만큼 실발송이 줄어든다(과소발송).
  //   같은 파일의 mailbox 축이 이미 같은 근거로 dry-run 을 제외한다 — 그 관례를 복제한다.
  const laneContactsProvider = data.dryRun !== true && data.liveSend !== false;
  const nudgeLaneDayCap = laneContactsProvider
    ? await readNudgeLaneDailyCapForPurpose(data.mailPurpose)
    : null;
  // [헤세 2026-09-03 · 적대 리뷰 MEDIUM 수리] 합산 캡도 레인 캡과 같은 조건으로만 읽는다 —
  //   `nudgeLaneDayCap !== null` 은 "이 발송이 독려 3레인 중 하나이고 provider 를 실제로 부른다"는
  //   사실을 이미 함축한다(readNudgeLaneDailyCapForPurpose 가 그 purpose 판정을 내부에서 한다).
  //   그 신호를 재사용하면 독려가 아닌 발송(콜드메일 등)에 합산 축을 잘못 세우는 일이 없고,
  //   purpose 판정을 두 번 하지 않는다.
  const nudgeTotalDayCap = nudgeLaneDayCap !== null ? await readNudgeTotalDailyCap() : null;
  const dimensions = quotaDimensions(data, physicalMailbox, nudgeLaneDayCap, nudgeTotalDayCap);
  const eventRef = adminDb.collection("mail_quota_events").doc(eventId);
  const rollupRef = adminDb.collection("mail_quota_rollups").doc(dayKey);
  const hourRollupRef = adminDb.collection("mail_quota_rollups").doc(hourKey);
  const weeklyRef = weeklyLedgerRef(weekKey);
  // W59b-2 / W60c-M1: 차원마다 참여하는 창이 다르다(quotaDimensions 주석).
  //   mailbox      — hour/burst 만 (시간당/버스트 캡의 **단독** 담당)
  //   sender       — day 만 (W60-3 병행 해제로 hour/burst 를 뺐다. 종전 주석의 "세 창 모두"는 폐기)
  //   emailProfile / program / campaign — 세 창 모두(종전 그대로)
  const periodPlans = {
    day: { key: dayKey, cap: policy.dailyCap },
    hour: { key: hourKey, cap: policy.hourlyCap },
    burst: { key: burstKey, cap: policy.burstCap },
  } as const;
  const ledgerRefs = dimensions.flatMap((dimension) => dimension.periods.map((period) => {
    const plan = periodPlans[period];
    // W72 [R1 P1-3]: 차원이 자기 day 캡을 들고 있으면 그 값이 이긴다(전역보다 좁을 때만 의미가 있다).
    const cap = period === "day" && typeof dimension.dayCap === "number" ? dimension.dayCap : plan.cap;
    return {
      ref: adminDb.collection("mail_quota_ledger").doc(ledgerDocId(dimension.kind, dimension.value, plan.key)),
      cap,
      period: plan.key,
      dimension,
    };
  }));
  const uniqueRef = adminDb.collection("mail_quota_unique_recipients").doc(ledgerDocId("sender", dimensions[0]?.value ?? "default-sender", dayKey));
  const laneLedgerItem = ledgerRefs.find((item) => item.dimension.kind === LANE_QUOTA_KIND) ?? null;
  // [헤세 2026-09-03] 합산 원장 항목 — 레인과 같은 방식으로 찾는다(고정 value 라 항상 같은 1개 문서).
  const totalLedgerItem = ledgerRefs.find((item) => item.dimension.kind === NUDGE_TOTAL_QUOTA_KIND) ?? null;
  return adminDb.runTransaction(async (transaction) => {
    const eventSnapshot = await transaction.get(eventRef);
    if (eventSnapshot.exists) {
      if (asString(eventSnapshot.data()?.status) === "retryable_failed") {
        const eventData = eventSnapshot.data() ?? {};
        const reservedLedgerDocIds = new Set(
          Array.isArray(eventData.quotaLedgerDocIds)
            ? eventData.quotaLedgerDocIds.map((value) => asString(value)).filter(Boolean)
            : [],
        );
        const ledgerReads = [];
        for (const item of ledgerRefs) {
          ledgerReads.push({ item, snapshot: await transaction.get(item.ref) });
        }
        const weeklySnapshot = await transaction.get(weeklyRef);
        const legacyDailyRollupDocId = asString(eventData.globalDailyRollupDocId, asString(eventData.dayKey));
        const needsGlobalDailyReservation = !skipsGlobalDailyCap && (
          eventData.globalDailyQuotaRefunded === true || legacyDailyRollupDocId !== dayKey
        );
        const globalDailySnapshot = needsGlobalDailyReservation ? await transaction.get(rollupRef) : null;
        const needsUniqueReservation = Boolean(recipientKey)
          && asString(eventData.uniqueRecipientLedgerDocId) !== uniqueRef.id;
        const uniqueSnapshot = needsUniqueReservation ? await transaction.get(uniqueRef) : null;
        const ledgersToReserve = [];
        for (const { item, snapshot } of ledgerReads) {
          const alreadyReservedHere =
            reservedLedgerDocIds.has(item.ref.id) || reservationMarked(snapshot.data(), eventId);
          const refunded =
            (item.dimension.kind === LANE_QUOTA_KIND && eventData.laneQuotaRefunded === true)
            || (item.dimension.kind === NUDGE_TOTAL_QUOTA_KIND && eventData.nudgeTotalQuotaRefunded === true);
          if (alreadyReservedHere && !refunded) continue;
          const count = cleanNumber(snapshot.data()?.count, 0);
          if (item.cap <= 0 || count >= item.cap) {
            throw quotaExceeded(`outbound mail quota exceeded for ${item.dimension.kind}:${item.period}`);
          }
          ledgersToReserve.push(item);
        }
        const needsWeeklyReservation =
          asString(eventData.weeklyLedgerDocId) !== weeklyRef.id
          && !reservationMarked(weeklySnapshot.data(), eventId)
          && asString(eventData.weekKey) !== weekKey;
        if (needsWeeklyReservation) {
          const weeklyCount = cleanNumber(weeklySnapshot.data()?.count, 0);
          if (policy.weeklyTotalCap > 0 && weeklyCount >= policy.weeklyTotalCap) {
            throw quotaExceeded(`outbound mail quota exceeded for ${WEEKLY_GLOBAL_KIND}:${WEEKLY_GLOBAL_VALUE}:${weekKey}`);
          }
        }
        if (globalDailySnapshot) {
          const globalDailyCount = cleanNumber(globalDailySnapshot.data()?.sent, 0);
          if (globalDailyCount >= OUTBOUND_GLOBAL_DAILY_TOTAL_CAP) {
            throw quotaExceeded(`outbound mail quota exceeded for ${WEEKLY_GLOBAL_KIND}:daily-total:${dayKey}`);
          }
        }
        if (needsUniqueReservation && uniqueSnapshot) {
          const knownRecipient = recipientMarked(uniqueSnapshot.data(), recipientKey);
          const uniqueCount = cleanNumber(uniqueSnapshot.data()?.uniqueRecipients, 0);
          if (!knownRecipient && uniqueCount >= policy.uniqueRecipientDailyCap) {
            throw quotaExceeded("outbound mail quota exceeded for unique recipients");
          }
        }
        for (const item of ledgersToReserve) {
          transaction.set(item.ref, {
            dimension: { kind: item.dimension.kind, value: item.dimension.value },
            period: item.period,
            count: FieldValue.increment(1),
            ...reservationMarkerPatch(eventId),
            updatedAtIso: now.toISOString(),
          }, { merge: true });
        }
        if (needsWeeklyReservation) {
          transaction.set(weeklyRef, {
            dimension: { kind: WEEKLY_GLOBAL_KIND, value: WEEKLY_GLOBAL_VALUE },
            period: weekKey,
            count: FieldValue.increment(1),
            ...reservationMarkerPatch(eventId),
            updatedAtIso: now.toISOString(),
          }, { merge: true });
        }
        if (needsGlobalDailyReservation) {
          transaction.set(rollupRef, {
            sent: FieldValue.increment(1),
            updatedAtIso: now.toISOString(),
          }, { merge: true });
        }
        if (needsUniqueReservation && uniqueSnapshot) {
          const knownRecipient = recipientMarked(uniqueSnapshot.data(), recipientKey);
          transaction.set(uniqueRef, {
            dayKey,
            sender: dimensions[0]?.value ?? "default-sender",
            uniqueRecipients: knownRecipient ? cleanNumber(uniqueSnapshot.data()?.uniqueRecipients, 0) : FieldValue.increment(1),
            ...recipientMarkerPatch(recipientKey),
            updatedAtIso: now.toISOString(),
          }, { merge: true });
        }
        transaction.set(eventRef, {
          dayKey, hourKey, weekKey, burstKey,
          status: "reserved",
          providerAttemptState: FieldValue.delete(),
          laneQuotaRefunded: FieldValue.delete(),
          nudgeTotalQuotaRefunded: FieldValue.delete(),
          globalDailyQuotaRefunded: FieldValue.delete(),
          // [헤세 2026-09-05 · HIGH-1/MED-2] 거래성/dry-run 은 전역 캡을 애초에 소비하지 않았다 —
          //   globalDailyRollupDocId 를 그냥 지우면 markOutboundQuotaReservationRetryable 의
          //   "이 필드가 없으면 레거시 이벤트다" 하위호환 폴백(eventData.dayKey)이 되살아나서
          //   같은 문제(남의 공유 일일 카운터를 잘못 감소)가 재발한다 — 그래서 **명시적** 마커를
          //   남겨 그 폴백보다 먼저 이긴다.
          skipsGlobalDailyCap,
          ...(skipsGlobalDailyCap ? { globalDailyRollupDocId: FieldValue.delete() } : { globalDailyRollupDocId: dayKey }),
          quotaLedgerDocIds: ledgerRefs.map((item) => item.ref.id),
          weeklyLedgerDocId: weeklyRef.id,
          uniqueRecipientLedgerDocId: recipientKey ? uniqueRef.id : FieldValue.delete(),
          ...(laneLedgerItem ? { laneLedgerDocId: laneLedgerItem.ref.id } : { laneLedgerDocId: FieldValue.delete() }),
          ...(totalLedgerItem ? { totalLedgerDocId: totalLedgerItem.ref.id } : { totalLedgerDocId: FieldValue.delete() }),
          reservationAttempts: FieldValue.increment(1),
          lastReservedAtIso: now.toISOString(),
          updatedAtIso: now.toISOString(),
        }, { merge: true });
        return { allowed: true, duplicate: false, eventId, dayKey, hourKey, weekKey };
      }
      return { allowed: true, duplicate: true, eventId, dayKey, hourKey, weekKey };
    }
    const snapshots = [];
    for (const item of ledgerRefs) snapshots.push({ item, snapshot: await transaction.get(item.ref) });
    // [헤세 2026-09-05 · HIGH-1/MED-2] 거래성 레인·dry-run 은 전역 1500/일 총량 캡을 읽지도, 체크하지도
    //   않는다 — resolveMailOutboundLane(data) 으로 서버가 판정한다(레인 킬스위치와 같은 이유).
    const globalDailySnapshot = skipsGlobalDailyCap ? null : await transaction.get(rollupRef);
    // A3(RT-3): global weekly ledger 읽기 — 차원별 snapshots와 별개로, 모든 트랜잭션이
    // 공유하는 단일 문서(우회 방지). 반드시 모든 write 이전에 읽는다(Firestore 트랜잭션 제약).
    const weeklySnapshot = await transaction.get(weeklyRef);
    for (const { item, snapshot } of snapshots) {
      const count = cleanNumber(snapshot.data()?.count, 0);
      if (item.cap <= 0 || count >= item.cap) {
        throw quotaExceeded(`outbound mail quota exceeded for ${item.dimension.kind}:${item.period}`);
      }
    }
    if (globalDailySnapshot) {
      const globalDailyCount = cleanNumber(globalDailySnapshot.data()?.sent, 0);
      if (globalDailyCount >= OUTBOUND_GLOBAL_DAILY_TOTAL_CAP) {
        throw quotaExceeded(`outbound mail quota exceeded for ${WEEKLY_GLOBAL_KIND}:daily-total:${dayKey}`);
      }
    }
    const weeklyCount = cleanNumber(weeklySnapshot.data()?.count, 0);
    if (policy.weeklyTotalCap > 0 && weeklyCount >= policy.weeklyTotalCap) {
      throw quotaExceeded(`outbound mail quota exceeded for ${WEEKLY_GLOBAL_KIND}:${WEEKLY_GLOBAL_VALUE}:${weekKey}`);
    }
    if (recipientKey) {
      const uniqueSnapshot = await transaction.get(uniqueRef);
      const knownRecipient = recipientMarked(uniqueSnapshot.data(), recipientKey);
      const uniqueCount = cleanNumber(uniqueSnapshot.data()?.uniqueRecipients, 0);
      if (!knownRecipient && uniqueCount >= policy.uniqueRecipientDailyCap) {
        throw quotaExceeded("outbound mail quota exceeded for unique recipients");
      }
      transaction.set(uniqueRef, {
        dayKey,
        sender: dimensions[0]?.value ?? "default-sender",
        uniqueRecipients: knownRecipient ? uniqueCount : FieldValue.increment(1),
        ...recipientMarkerPatch(recipientKey),
        updatedAtIso: now.toISOString(),
      }, { merge: true });
    }
    for (const { item } of snapshots) {
      transaction.set(item.ref, {
        // W59b-2: 저장 shape 은 종전 그대로 {kind, value} 다 — periods 는 **배급 규칙**이지 원장 사실이
        // 아니고, 넣으면 기존 모니터/조회가 읽는 문서 형상이 조용히 바뀐다.
        dimension: { kind: item.dimension.kind, value: item.dimension.value },
        period: item.period,
        count: FieldValue.increment(1),
        ...reservationMarkerPatch(eventId),
        updatedAtIso: now.toISOString(),
      }, { merge: true });
    }
    transaction.set(weeklyRef, {
      dimension: { kind: WEEKLY_GLOBAL_KIND, value: WEEKLY_GLOBAL_VALUE },
      period: weekKey,
      count: FieldValue.increment(1),
      ...reservationMarkerPatch(eventId),
      updatedAtIso: now.toISOString(),
    }, { merge: true });
    transaction.set(eventRef, {
      id: eventId, source, mode, recipient, dayKey, hourKey, weekKey, burstKey,
      status: "reserved", reservationAttempts: 1,
      // W72 [R2-2]: 환불 대상 레인 원장을 이벤트에 남긴다 — 없으면 나중에 무엇을 되돌릴지 모른다.
      ...(laneLedgerItem ? { laneLedgerDocId: laneLedgerItem.ref.id } : {}),
      // [헤세 2026-09-03] 합산 원장도 같은 이유로 남긴다(환불 대상 조회용).
      ...(totalLedgerItem ? { totalLedgerDocId: totalLedgerItem.ref.id } : {}),
      ...(providerFailureRetryAllowed
        ? { providerFailureRetryAllowed: true }
        : {}),
      // [헤세 2026-09-05 · HIGH-1/MED-2] 전역 캡을 소비하지 않은 예약(거래성/dry-run)은
      // globalDailyRollupDocId 를 남기지 않는다 — 남기면 나중에 환불 로직이 소비한 적 없는
      // 공유 일일 카운터를 잘못 감소시킨다. 필드를 그냥 생략하면
      // markOutboundQuotaReservationRetryable 의 "없으면 레거시 이벤트다"
      // 하위호환 폴백(eventData.dayKey)이 대신 그 자리를 채워 같은 사고가 재발하므로,
      // 그 폴백보다 먼저 이기는 명시적 마커를 남긴다.
      skipsGlobalDailyCap,
      ...(skipsGlobalDailyCap ? {} : { globalDailyRollupDocId: dayKey }),
      quotaLedgerDocIds: ledgerRefs.map((item) => item.ref.id),
      weeklyLedgerDocId: weeklyRef.id,
      uniqueRecipientLedgerDocId: recipientKey ? uniqueRef.id : FieldValue.delete(),
      createdAtIso: now.toISOString(), lastReservedAtIso: now.toISOString(),
      updatedAtIso: now.toISOString(),
    }, { merge: true });
    if (!skipsGlobalDailyCap) {
      transaction.set(rollupRef, { sent: FieldValue.increment(1), updatedAtIso: now.toISOString() }, { merge: true });
    }
    transaction.set(hourRollupRef, { sent: FieldValue.increment(1), updatedAtIso: now.toISOString() }, { merge: true });
    return { allowed: true, duplicate: false, eventId, dayKey, hourKey, weekKey };
  });
}

/**
 * @deprecated W60c-M2 — **프로덕션에서 부르지 마라. 테스트 전용 진입점이다.**
 *
 * 이 함수는 물리 발신함을 해석하지 않는다(아래 호출에서 5번째 인자를 넘기지 않으므로 mailbox = "").
 * 그래서 quotaDimensions 가 mailbox 축을 세우지 않는다. W60-3 이전에는 sender 축이 hour/burst 를
 * 함께 들고 있어 그래도 시간당 캡이 걸렸지만, **병행 해제 후에는 시간당/burst 담당이 mailbox 축
 * 단독**이다 — 즉 지금 이 함수를 프로덕션 경로에서 부르면 그 발송만 물리 발신함 시간당 캡을
 * 우회한다. 해제가 이 함수의 위험도를 바꿔 놓았다.
 *
 * 실발송 경로는 assertOutboundSendPermitted 를 쓴다(provider 접촉 여부를 보고 identityContext →
 * physicalMailboxFromContext 로 mailbox 를 넘긴다). 현재 프로덕션 호출부는 0 이고,
 * tests/w60c-quota-entrypoint-guard.test.mjs 가 그 상태를 계약으로 고정한다.
 *
 * ■ W61-B6 제거 검토 결과: **유예 연장.** (참조 전수 조사 2026-08-10)
 *   프로덕션 호출부는 0 이다 — 여기까지는 "데드코드"로 보인다. 그런데 전수로 세어 보면
 *   이 함수는 **테스트 3파일의 진입점**이다:
 *     · tests/mail-weekly-cap-transaction.test.mjs — 주간 캡 트랜잭션(롤오버 경계·동시성 레이스·
 *       캡 강제) 8개 호출부
 *     · tests/mail-safety-outbound-lock-quota-behavior.test.mjs — 아웃바운드 락·중복 예약 4개 호출부
 *     · tests/mail-identity-canonical-gate.test.mjs — 신원 게이트를 소스 문자열로 단정
 *   지우면 이 계약들의 커버리지가 함께 사라진다. assertOutboundSendPermitted 로 옮기려면
 *   identityContext 와 물리 발신함이 필요해서 **픽스처를 새로 짜야 한다** — 데드코드 제거가
 *   아니라 테스트 마이그레이션이고, 위험이 다르다.
 *
 *   제거 조건(둘 다 충족되면 지운다):
 *     ① 위 3파일이 assertOutboundSendPermitted 기준으로 재작성되어 같은 계약을 덮을 것
 *     ② 그 시점에도 프로덕션 호출부가 0 일 것(w60c 가드가 상시 확인한다)
 *   그때까지는 남긴다. 지금 지우면 "정리했다"면서 주간 캡 회귀 그물을 걷어내는 셈이다.
 */
export async function reserveOutboundQuota(
  data: Record<string, unknown>,
  source: string,
  mode: MailSafetyMode,
  now = new Date(),
): Promise<QuotaReservation> {
  await assertCanonicalMailIdentityForQuota(mode);
  return reserveOutboundQuotaAfterIdentity(data, source, mode, now);
}

export async function assertOutboundSendPermitted(data: Record<string, unknown>, source: string, mode: MailSafetyMode, deps: MailLaneGateDeps = {}): Promise<QuotaReservation> {
  // Explicit dry-run/non-live reservations do not contact the provider, regardless of mode.
  // Missing/ambiguous flags remain potentially live and therefore fail closed on identity.
  // reserveOutboundQuota keeps its direct public identity gate.
  const contactsProvider = data.dryRun !== true && data.liveSend !== false;
  // W59b-2: provider 를 부르는 예약만 물리 발신함 축을 세운다. dry-run 은 실제 메일함 용량을
  // 소모하지 않으므로 새 축을 세울 근거가 없고, 세우면 dry-run 이 실발송 캡을 갉아먹는다.
  const identityContext = contactsProvider
    ? await assertCanonicalMailIdentityContextForQuota(mode, deps.mailAccount)
    : null;
  const now = new Date();
  // W118: 잠금 판정은 이 메일의 **레인** 기준이다(resolveMailOutboundLane). 분류가 안 되면
  // outreach 로 닫히므로 스위치가 느슨해지는 방향으로 실패하지 않는다.
  const block = await readOutboundSafetyBlockForMail(
    data,
    now.toISOString(),
    mode,
    deps.readOutboundSafetyBlock ?? readOutboundSafetyBlock,
  );
  if (block.blocked) {
    const until = block.blockedUntilIso ? ` until ${block.blockedUntilIso}` : "";
    // W72-A: 잠금도 "지금은 못 보냄"이다. 캡과 같은 이유로 드레인이 구분할 수 있어야 한다.
    throw Object.assign(
      failedPrecondition(`outbound mail safety lock active${until}: ${block.reason}`),
      { errorCode: OUTBOUND_SAFETY_LOCK_ERROR_CODE },
    );
  }
  return reserveOutboundQuotaAfterIdentity(
    data,
    source,
    mode,
    now,
    identityContext ? physicalMailboxFromContext(identityContext) : "",
  );
}

export type OutboundProviderFailureDisposition =
  | "definitely_not_accepted"
  | "acceptance_unknown";

export async function markOutboundQuotaReservationRetryable(
  eventId: string,
  disposition: OutboundProviderFailureDisposition,
): Promise<void> {
  if (!/^mail_quota_event_[a-f0-9]{28}$/.test(eventId)) return;
  const ref = adminDb.collection("mail_quota_events").doc(eventId);
  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (
      !snapshot.exists ||
      snapshot.data()?.providerFailureRetryAllowed !== true ||
      asString(snapshot.data()?.status) === "sent"
    ) {
      return;
    }
    const nowIso = new Date().toISOString();
    if (disposition === "acceptance_unknown") {
      transaction.set(ref, {
        providerAttemptState: "acceptance_unknown",
        lastFailedAtIso: nowIso,
        updatedAtIso: nowIso,
      }, { merge: true });
      return;
    }
    // W72 [R2-2]: definite 미수락은 **발송 용량을 쓰지 않았다.** 레인 슬롯을 붙들고 있으면
    //   그날 실발송이 줄어든다(과소발송). 되돌리고, 재예약 때 다시 잡도록 표시한다.
    //   전역(sender/emailProfile/program/campaign/weekly) 축은 건드리지 않는다 — 기존 3레인의
    //   예약 의미를 바꾸지 않기 위해서다. [헤세 2026-09-03] 합산(nudge_total) 축은 레인과 같은
    //   성격(독려 전용 추가 상한)이라 레인과 **같은 방식**으로 환불한다.
    const laneLedgerDocId = asString(snapshot.data()?.laneLedgerDocId);
    const alreadyRefunded = snapshot.data()?.laneQuotaRefunded === true;
    const totalLedgerDocId = asString(snapshot.data()?.totalLedgerDocId);
    const alreadyTotalRefunded = snapshot.data()?.nudgeTotalQuotaRefunded === true;
    // [헤세 2026-09-05 · HIGH-1/MED-2] skipsGlobalDailyCap 이 참이면 이 이벤트는 전역 캡을
    //   애초에 소비하지 않았다 — 아래 "필드가 없으면 레거시 이벤트다" 하위호환 폴백
    //   (eventData.dayKey)이 대신 끼어들어 남의 공유 일일 카운터를 잘못 감소시키지 않도록
    //   명시적 마커로 그 폴백보다 먼저 막는다.
    const globalDailyRollupDocId = snapshot.data()?.skipsGlobalDailyCap === true
      ? ""
      : asString(snapshot.data()?.globalDailyRollupDocId, asString(snapshot.data()?.dayKey));
    const alreadyGlobalDailyRefunded = snapshot.data()?.globalDailyQuotaRefunded === true;
    const laneRef = laneLedgerDocId && !alreadyRefunded
      ? adminDb.collection("mail_quota_ledger").doc(laneLedgerDocId) : null;
    const totalRef = totalLedgerDocId && !alreadyTotalRefunded
      ? adminDb.collection("mail_quota_ledger").doc(totalLedgerDocId) : null;
    const globalDailyRef = globalDailyRollupDocId && !alreadyGlobalDailyRefunded
      ? adminDb.collection("mail_quota_rollups").doc(globalDailyRollupDocId)
      : null;
    // 트랜잭션은 모든 read 가 모든 write 보다 먼저여야 한다 — 두 read 를 먼저 다 하고 나서 쓴다.
    const laneSnapshot = laneRef ? await transaction.get(laneRef) : null;
    const totalSnapshot = totalRef ? await transaction.get(totalRef) : null;
    const globalDailySnapshot = globalDailyRef ? await transaction.get(globalDailyRef) : null;
    if (laneRef && laneSnapshot && cleanNumber(laneSnapshot.data()?.count, 0) > 0) {
      transaction.set(laneRef, { count: FieldValue.increment(-1), updatedAtIso: nowIso }, { merge: true });
    }
    if (totalRef && totalSnapshot && cleanNumber(totalSnapshot.data()?.count, 0) > 0) {
      transaction.set(totalRef, { count: FieldValue.increment(-1), updatedAtIso: nowIso }, { merge: true });
    }
    if (globalDailyRef && globalDailySnapshot && cleanNumber(globalDailySnapshot.data()?.sent, 0) > 0) {
      transaction.set(globalDailyRef, { sent: FieldValue.increment(-1), updatedAtIso: nowIso }, { merge: true });
    }
    transaction.set(ref, {
      status: "retryable_failed",
      providerAttemptState: "definitely_not_accepted",
      ...(laneLedgerDocId && !alreadyRefunded ? { laneQuotaRefunded: true } : {}),
      ...(totalLedgerDocId && !alreadyTotalRefunded ? { nudgeTotalQuotaRefunded: true } : {}),
      ...(globalDailyRollupDocId && !alreadyGlobalDailyRefunded ? { globalDailyQuotaRefunded: true } : {}),
      lastFailedAtIso: nowIso,
      updatedAtIso: nowIso,
    }, { merge: true });
  });
}

async function suppressRecipientAfterFailure(data: Record<string, unknown>, failure: OutboundFailure, nowIso: string): Promise<string | null> {
  if (!classifyBounceImpact(failure).suppressRecipient) return null;
  const email = normalizeEmailAddress(asString(data.to, asString(data.creatorEmail, "")));
  const domain = emailDomain(email);
  if (!email && !domain) return null;
  const id = safeMailDocId("suppress_failure", `${failure.kind}:${email || domain}`);
  const ref = adminDb.collection("mail_suppressions").doc(id);
  await ref.set({ id, email, domain, status: "active", source: "smtp-failure", reason: failure.reason, ruleId: failure.ruleId, severity: "blocked", createdAtIso: nowIso, updatedAtIso: nowIso }, { merge: true });
  return ref.path;
}

async function recentHardBounceCount(nowMs: number): Promise<{ permanent: number; noMxExcluded: number; temporaryExcluded: number }> {
  const snapshot = await adminDb.collection("mail_delivery_failures").where("createdAtMs", ">=", nowMs - OUTBOUND_FAILURE_WINDOW_MS).limit(200).get();
  return snapshot.docs.reduce((counts, doc) => {
    const impact = classifyBounceImpact({ kind: asString(doc.data()?.kind, "") as OutboundFailure["kind"], reason: asString(doc.data()?.reason, "") });
    if (impact.countsTowardBounceRate) counts.permanent += 1;
    if (impact.excludedNoMx) counts.noMxExcluded += 1;
    if (impact.excludedTemporary) counts.temporaryExcluded += 1;
    return counts;
  }, { permanent: 0, noMxExcluded: 0, temporaryExcluded: 0 });
}

// W19 ②: 반송률 판정의 분모. 24시간 롤링 발송 수를 정확히 세려면 campaign_outreach 전체를 범위
// 스캔해야 하므로(비용 과다), 이미 유지되는 일일 카운터 2일치(오늘·어제 KST)를 합산해 근사한다.
// 근사가 실제보다 **작게** 나오면 비율이 커져 잠금 쪽으로 기울므로 안전 방향이다.
const HARD_BOUNCE_RATE_LIMIT = 0.03; // 사용자 확정 중단 기준: 하드 반송률 3% 초과
const HARD_BOUNCE_RATE_MIN_SAMPLE = 50; // 표본이 이보다 작으면 비율이 불안정 → 절대 건수로 판정
// W43: 일일 카운터 문서 키의 정본. admin.ts 승인 여유 판정도 같은 문서를 같은 키로 읽어야 하므로
// 새 정의를 만들지 않고 이것을 내보낸다(키가 갈라지면 승인이 남의 날짜 누계를 보고 판정한다).
export function koreaDayKeyFrom(date: Date): string {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
async function recentOutboundSendCount(nowMs: number): Promise<number> {
  const keys = [koreaDayKeyFrom(new Date(nowMs)), koreaDayKeyFrom(new Date(nowMs - 24 * 60 * 60 * 1000))];
  let total = 0;
  for (const key of new Set(keys)) {
    const snapshot = await adminDb.collection("campaign_outreach_daily_counters").doc(key).get();
    const sent = snapshot.data()?.sent;
    total += typeof sent === "number" && Number.isFinite(sent) ? Math.max(0, Math.round(sent)) : 0;
  }
  return total;
}

export async function recordOutboundSendFailure(
  data: Record<string, unknown>,
  error: unknown,
  source: string,
  permitAdverseDeps: ChatAutoPermitAdverseHookDeps = {},
): Promise<void> {
  const evidence = safeOutboundFailureEvidence(error, `mail_delivery_failure:${source}`);
  const failure: OutboundFailure = {
    kind: evidence.failureKind,
    ruleId: evidence.failureRuleId,
    reason: evidence.failureReason,
  };
  if (failure.kind === "safety_lock") return;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const email = normalizeEmailAddress(asString(data.to, asString(data.creatorEmail, "")));
  const domain = emailDomain(email);
  const emailHash = email
    ? createHash("sha256").update(email).digest("hex")
    : "";
  const domainHash = domain
    ? createHash("sha256").update(domain).digest("hex")
    : "";
  const suppressionRef = await suppressRecipientAfterFailure(data, failure, nowIso);
  const failureId = safeMailDocId("failure", `${nowMs}:${source}:${email}:${asString(data.trackingId, "")}`);
  await adminDb.collection("mail_delivery_failures").doc(failureId).set({
    id: failureId, kind: failure.kind, ruleId: failure.ruleId, reason: failure.reason, source,
    email: FieldValue.delete(), domain: FieldValue.delete(), emailHash, domainHash,
    campaignId: asString(data.campaignId, ""), conversationId: asString(data.conversationId, ""),
    trackingId: asString(data.trackingId, ""), suppressionRef,
    errorCode: evidence.errorCode,
    correlationIdHash: evidence.correlationIdHash,
    error: FieldValue.delete(),
    errorText: FieldValue.delete(),
    errorMessage: FieldValue.delete(),
    stack: FieldValue.delete(),
    createdAtIso: nowIso, createdAtMs: nowMs,
  }, { merge: true });
  let permitAdverseError: unknown = null;
  if (failure.kind === "provider_suspension") await lockOutboundMail(failure.reason, failure.ruleId, OUTBOUND_SUSPENSION_LOCK_MS, nowIso);
  if (failure.kind === "rate_limit") await lockOutboundMail(failure.reason, failure.ruleId, OUTBOUND_RATE_LIMIT_LOCK_MS, nowIso);
  if (classifyBounceImpact(failure).countsTowardBounceRate) {
    const policy = await readOutboundPolicy();
    const bounceImpact = await recentHardBounceCount(nowMs);
    const bounceCount = bounceImpact.permanent;
    if (bounceCount >= policy.hardBounceLockThreshold) {
      // W19 ② [사용자 확정 기준 반영]: 종전 판정은 **절대 건수**뿐이라 발송량이 늘수록 필연적으로
      // 걸렸다 — 사용자 확정 중단 기준은 "하드 반송률 3% 초과"인데 코드는 "5건"이었다.
      // 실측(2026-08-04): 44건 발송 · 반송 5건 = 11.4% → 잠금이 옳았다. 그러나 램프 500/일에서
      // 5건은 1%인데도 같은 24시간 잠금이 걸려 대량 발송이 구조적으로 불가능했다.
      // 이제 표본이 충분할 때만 비율로 판정한다: 표본 < MIN_SAMPLE 이면 종전대로 절대 건수(보수적),
      // 이상이면 비율이 상한을 넘을 때만 잠근다. 어느 경로든 **잠금 자체는 약화되지 않는다**
      // (임계 미달이면 애초에 이 블록에 들어오지 않는다).
      const sampleSize = await recentOutboundSendCount(nowMs);
      const rate = sampleSize > 0 ? bounceCount / sampleSize : 1;
      const rateExceeded = sampleSize < HARD_BOUNCE_RATE_MIN_SAMPLE
        || rate > HARD_BOUNCE_RATE_LIMIT;
      if (rateExceeded) {
        const pct = sampleSize > 0 ? (rate * 100).toFixed(1) : "n/a";
        await lockOutboundMail(
          `최근 24시간 영구거절 ${bounceCount}건 · 미발송(MX없음) ${bounceImpact.noMxExcluded}건 제외 · 일시실패 ${bounceImpact.temporaryExcluded}건 제외(발송 ${sampleSize}건 대비 ${pct}%)가 감지되어 메일 발송을 중단합니다.`,
          "mail-safety.bounce-threshold",
          OUTBOUND_SUSPENSION_LOCK_MS,
          nowIso,
        );
      }
    }
  }
  try {
    await recordChatAutoPermitAdverseFromCommittedRefs({
      reason: "bounce_or_suppression",
      sourceRef: `mail_delivery_failures/${failureId}`,
      committedRefs: chatAutoPermitCommittedRefsFromMailData(data, suppressionRef ? [suppressionRef] : []),
      nowIso,
    }, permitAdverseDeps);
  } catch (error) {
    permitAdverseError = error;
    console.error("[chat-auto-permit-adverse] outbound failure hook failed", {
      failureId,
      failureKind: safeOutboundFailureEvidence(error, "chat_auto_permit_adverse_outbound_failure").failureKind,
    });
  }
  if (permitAdverseError) throw permitAdverseError;
}
