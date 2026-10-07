// W62-2 [헤세 · 지원 관리 탭] — apply 완료 · 영상 미제출자 트래킹 + 재촉/재발송
//
// ■ 왜 이 형상인가 (프로드 실측이 설계를 정했다 — artifacts/w62/w62-item2-findings.md)
//   · 미제출 56건 중 **54건은 크리에이터 신원이 해석되지 않는다**(identity 에 channelId/
//     portalCreatorId/fluCreatorId 가 2/56). 그래서 썸네일·핸들을 1차 범위에서 뺀다
//     (리더 판정 L2026-0810-04 (1) — (a)안: 있는 신원만 표시, 백필은 W63).
//   · 확인 메일 아웃박스 실측: delivered 26 · dead_letter 28. **모수를 나눈다**(판정 (2)):
//       delivered  → 재촉(nudge)      : "아직 안 올리셨네요"
//       dead_letter→ 확인 메일 재발송 : 처음 안내를 **받은 적이 없다**
//     이걸 안 나누면 받은 적 없는 사람에게 "다시 알려드립니다"를 보내게 된다.
//
// ■ 이메일 주소를 이 모듈이 다루지 않는다 (PII 비노출 — 판정 (3) 승인 구조)
//   확인 메일 경로가 이미 `applicationId → 수신자 해석 → 발송 → recipientEmailHash 기록`으로
//   동작한다(원문이 아니라 **해시**만 남는다). 재촉도 같은 아웃박스에 적재만 하고 수신자 해석은
//   드레인이 한다. 그래서 화면에도 응답에도 주소가 없다.
import { PORTAL_PROGRAM_ID } from "./scpPortalApplyBindingAuthority";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  type CallableRequestShape,
} from "./shared";
import { createHash } from "node:crypto";
import {
  NUDGE_COHORT2_KEY,
  NUDGE_TEMPLATE_UNMAPPED_REASON,
  nudgeTemplateKeyForSequence,
  readNudgeSequenceConfig,
} from "./nudgeSequenceTemplates";
// 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate, codex round-2 adversarial
// review): enqueueApplicationVideoReminder's only client UI is
// src/components/flu/scpAutomation/ApplicationVideoPendingPanel.tsx, exclusively rendered inside
// the entitlement-gated /flu/scp "지원 관리" tab — this callable sends real mail, so role alone
// (manager+) is not enough once scp is an explicit grant.
import { assertScpEntitled } from "./mailAccounts";

/** W62c-minor: 절단이 아니라 해시다 — 앞 12자 절단은 uid 원문 조각이 그대로 남는다. */
function hashOpaque(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

const APPLICATION_COLLECTION = "scp_application_management";
const VIDEO_STATE_COLLECTION = "scp_video_review_state";
// W114 수리②(nudgeCohortSweep.ts): 코호트2 사전 필터가 같은 컬렉션명을 복제 없이 재사용한다.
export const CONFIRM_OUTBOX_COLLECTION = "scp_application_confirmed_mail_outbox";
/** W62-2: 재촉 아웃박스. 확인 메일과 **다른 컬렉션**이다 — 한 컬렉션에 섞으면 드레인의 재시도
 *  상태와 dead_letter 통계가 뒤엉켜 "확인 메일이 몇 건 죽었나"를 다시 셀 수 없게 된다. */
export const VIDEO_REMINDER_OUTBOX_COLLECTION = "scp_application_video_reminder_outbox";
/** 재촉 이력. 쿨다운 판정과 화면의 "마지막 재촉 일시"가 같은 원장을 본다. */
export const VIDEO_REMINDER_HISTORY_COLLECTION = "scp_application_video_reminder_history";

/**
 * W62c-C3 [두 리뷰 수렴 · '재촉 완료 오표기 레인' 방지]
 *
 * 아웃박스에 적재하는 것과 메일이 나가는 것은 다른 사실이다. 소비자(드레인)가 없는 동안 enqueue 를
 * 열어 두면 이력이 남고 쿨다운이 시작되어, 화면은 "재촉함 · 다음 가능 8/13" 이라고 말하는데
 * **아무도 받지 않는다.** 게다가 쿨다운 때문에 3일간 다시 시도할 수도 없다 — 침묵이 잠기는 것이다.
 *
 * 그래서 배선 여부를 **코드가 스스로 주장**하게 만들고, 거짓 주장이 불가능하도록 테스트가
 * 이 상수와 실제 드레인·스케줄러의 존재를 함께 단정한다(tests/w62c-reminder-drain-wiring).
 * 메타 원인이 "소비자 존재를 묻는 테스트가 없었다"였으므로, 그 질문을 상수로 못 박는다.
 */
export const VIDEO_REMINDER_DRAIN_WIRED = true;

/** 브리프: "연타 방지(쿨다운, 예: 최소 3일)". 값을 코드에 고정해 화면·서버가 같은 기준을 쓴다. */
export const VIDEO_REMINDER_COOLDOWN_DAYS = 3;
export const VIDEO_REMINDER_COOLDOWN_MS = VIDEO_REMINDER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

/**
 * W72-B: "아직 결과가 안 난" 상태 집합. 이 중 하나라도 있으면 같은 사람에게 새 재촉을 적재하지 않는다.
 * `dead_letter`·`cancelled`·`suppressed`·`delivery_unknown` 은 종결이라 여기 없다 — 종결된 회차는
 * 다시 시도할 수 있어야 한다(그 회차는 아직 **받지 못했다**).
 */
export const IN_FLIGHT_REMINDER_STATES = new Set([
  "queued",
  "sending",
  "retryable_failed",
  "recipient_pending",
]);

/**
 * W72 [R2-3]: **봉인해서는 안 되는 종결 상태.**
 *
 * `delivery_unknown` 은 "SMTP 가 받았는지 모른다"는 뜻이다. 이걸 봉인해 같은 회차를 재개하면
 * 이미 도착한 메일을 한 번 더 보낼 수 있다 — 복구가 중복 발송이 된다.
 * 수신 확인은 사람이 원장(mail_outbound_log·provider)으로 대조할 문제이지 이 콜러블이 추정할
 * 문제가 아니다. 그래서 **자동 복구 대상에서 제외**한다.
 */
export const RESET_FORBIDDEN_REMINDER_STATES = new Set(["delivery_unknown"]);

/**
 * W72 [적대 리뷰 P1]: 회차를 delivered 로 판정하니 **영구 실패하는 수신자**의 회차가 영원히
 * 안 오른다 — dead_letter → 쿨다운 → 같은 회차 재적재 → 또 dead_letter 의 무한 루프다.
 * 상한 10 은 도달하지 않는데 발송 시도만 무한히 반복된다.
 *
 * 그래서 **회차당 적재 시도**에 별도 천장을 둔다. 회차 자체는 delivered 로만 오르되(헤세 의도),
 * 한 회차를 몇 번까지 다시 시도할지는 여기서 끊는다. 두 축은 서로를 대체하지 않는다.
 */
export const MAX_ENQUEUE_ATTEMPTS_PER_SEQUENCE = 3;

export type ApplicationVideoPendingAction = "nudge" | "resend_confirmation" | "blocked";

export type ApplicationVideoPendingRow = {
  readonly applicationId: string;
  readonly programId: string;
  readonly appliedAtIso: string;
  readonly daysSinceApply: number | null;
  /** 확인 메일이 실제로 전달됐는가 — 이 값이 재촉 가능 여부를 가른다. */
  readonly confirmationDelivery: "delivered" | "dead_letter" | "pending" | "unknown";
  readonly availableAction: ApplicationVideoPendingAction;
  readonly lastReminderAtIso: string;
  readonly reminderCount: number;
  readonly cooldownUntilIso: string;
  /** 해석된 신원이 있으면 표시용으로만 싣는다(56건 중 2건). 없으면 빈 문자열이다. */
  readonly creatorHandle: string;
  readonly creatorDisplayName: string;
};

function daysBetween(fromIso: string, nowMs: number): number | null {
  const parsed = Date.parse(fromIso);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((nowMs - parsed) / 86_400_000));
}

/**
 * W62-2: 어떤 조치가 가능한지를 **확인 메일 전달 상태로만** 정한다.
 *   delivered   → 재촉(그 사람은 안내를 받았고 안 올린 것이다)
 *   dead_letter → 확인 메일 재발송(안내를 받은 적이 없다)
 *   그 외(pending/unknown) → blocked. 아직 결과가 안 났거나 알 수 없으면 아무것도 보내지 않는다 —
 *     여기서 추측하면 "받았는지 모르는 사람"에게 재촉을 보내게 된다.
 */
export function resolveVideoPendingAction(
  confirmationDelivery: ApplicationVideoPendingRow["confirmationDelivery"],
): ApplicationVideoPendingAction {
  if (confirmationDelivery === "delivered") return "nudge";
  if (confirmationDelivery === "dead_letter") return "resend_confirmation";
  return "blocked";
}

/** 쿨다운은 **마지막 재촉 시각**으로만 계산한다(발송 성공/실패와 무관하게 연타를 막는다). */
export function videoReminderCooldownRemainingMs(
  lastReminderAtIso: string,
  nowMs: number,
  cooldownMs = VIDEO_REMINDER_COOLDOWN_MS,
): number {
  const last = Date.parse(lastReminderAtIso);
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, last + cooldownMs - nowMs);
}

/**
 * W72 스펙 [헤세 확정 2026-08-13]: "제출 혹은 읽은 시점에서 7일 후에 보내는 것 아니냐,
 * 바로 보내지면 안 된다."
 *
 * 첫 독려의 **하한 앵커**다. `videoReminderCooldownRemainingMs` 는 직전 독려만 보므로
 * 독려 이력이 없는 신규 지원자에게는 0 을 돌려준다 — apply 직후 첫 스윕에 바로 나갔다.
 * 그래서 apply 시각(`submittedAtIso`)에도 같은 cadence 를 건다.
 *
 * 두 앵커가 모두 있으면 **더 늦은 쪽**을 쓴다(max) — 어느 하나라도 아직 7일이 안 지났으면 못 보낸다.
 */
export function videoReminderGateRemainingMs(input: {
  lastReminderAtIso: string;
  appliedAtIso: string;
  nowMs: number;
  cooldownMs?: number;
}): number {
  const cooldownMs = input.cooldownMs ?? VIDEO_REMINDER_COOLDOWN_MS;
  const sinceLastReminder = videoReminderCooldownRemainingMs(input.lastReminderAtIso, input.nowMs, cooldownMs);
  const applied = Date.parse(input.appliedAtIso);
  if (!Number.isFinite(applied)) {
    // W72 마감리뷰 P1-4: 종전 주석("여는 방향으로 실패하지 않는다")은 **이력이 있을 때만** 참이었다.
    //   이력 0 + apply 미해석이면 두 항 모두 0 → 즉시 발송이다(리뷰어 값 실행 재현).
    //   apply 시각을 모르면 "7일이 지났다"를 **증명할 수 없다** — 닫는 방향으로 실패한다.
    //   이력이 있으면 그 기준은 그대로 유효하므로 살린다(구 데이터가 전부 멈추지 않는다).
    return sinceLastReminder > 0 ? sinceLastReminder : cooldownMs;
  }
  const sinceApply = Math.max(0, applied + cooldownMs - input.nowMs);
  return Math.max(sinceLastReminder, sinceApply);
}

async function readSubmittedKeys(): Promise<Set<string>> {
  const snapshot = await adminDb.collection(VIDEO_STATE_COLLECTION)
    .select("applicationId", "enrollmentId")
    .get();
  const keys = new Set<string>();
  for (const doc of snapshot.docs) {
    const row = doc.data() ?? {};
    const applicationId = asString(row.applicationId);
    const enrollmentId = asString(row.enrollmentId);
    if (applicationId) keys.add(applicationId);
    if (enrollmentId) keys.add(enrollmentId);
  }
  return keys;
}

/**
 * W62-2 조회 모델. W27 의 조인 규칙(태그가 아니라 **레코드별 조인**)을 그대로 쓴다:
 * application.identity.applicationId ↔ video_review_state.applicationId / enrollmentId.
 */
export async function listApplicationVideoPendingRows(request: CallableRequestShape) {
  // RBAC(브리프 P0): Guest 비노출. 조회는 운영자 이상 전원.
  const auth = assertNonGuestAuth(request, "application_video_pending.list");
  // 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate, codex round-2 adversarial
  // review): same reachability as enqueueApplicationVideoReminder below (only
  // ApplicationVideoPendingPanel.tsx, inside /flu/scp).
  await assertScpEntitled(auth, request, "application_video_pending.list");
  const data = asRecord(request.data);
  const limit = Math.min(500, Math.max(1, Math.trunc(Number(data.limit ?? 200))));
  // W62e-minor [독립 델타 · 비대칭 해소]: 발송 경로와 **같은 규칙**을 쓴다. 조회는 쓰기가 없어
  //   위험이 낮지만, 호출자가 시각을 정하면 쿨다운 잔여·경과일이 화면에서만 다르게 보인다 —
  //   "화면은 되는데 서버가 막는" 상태를 만드는 그 비대칭이다.
  const listClientNowMs = process.env.FUNCTIONS_EMULATOR === "true"
    ? Date.parse(asString(data.nowIso))
    : Number.NaN;
  const nowMs = Number.isFinite(listClientNowMs) ? listClientNowMs : Date.now();

  // W72 [R1 P2-7]: 쿨다운의 정본은 설정(cadenceDays)이다. 목록이 코드 상수를 말하면
  //   화면은 "3일"이라 하고 서버는 7일로 막는 비대칭이 생긴다 — 같은 값을 쓴다.
  const listNudgeConfig = await readNudgeSequenceConfig();
  const listCooldownDays = listNudgeConfig.cohorts.get(NUDGE_COHORT2_KEY)?.cadenceDays
    ?? VIDEO_REMINDER_COOLDOWN_DAYS;
  const listCooldownMs = listCooldownDays * 24 * 60 * 60 * 1000;

  const [applications, submitted] = await Promise.all([
    adminDb.collection(APPLICATION_COLLECTION).orderBy("submittedAtIso", "desc").limit(limit).get(),
    readSubmittedKeys(),
  ]);

  const pending = applications.docs.filter((doc) => {
    const identity = asRecord((doc.data() ?? {}).identity);
    const applicationId = asString(identity.applicationId) || doc.id;
    const enrollmentId = asString(identity.enrollmentId);
    return !submitted.has(applicationId) && !(enrollmentId && submitted.has(enrollmentId));
  });

  // W62d-minor [두 리뷰]: 종전에는 행마다 쿼리 2개를 **순차로** 돌았다(N+1). 56행이면 112 왕복이고
  //   목록이 커질수록 선형으로 늘어난다. 확인 상태는 **한 번에** 읽고, 이력은 getAll 로 배치한다.
  const applicationIds = pending.map((doc) => asString(asRecord((doc.data() ?? {}).identity).applicationId) || doc.id);
  const confirmStateByApplication = new Map<string, string>();
  for (let offset = 0; offset < applicationIds.length; offset += 10) {
    // Firestore `in` 상한은 10 이다 — 청크로 나눠 한 청크당 쿼리 1개만 쓴다.
    const chunk = applicationIds.slice(offset, offset + 10);
    if (chunk.length === 0) continue;
    const snapshot = await adminDb.collection(CONFIRM_OUTBOX_COLLECTION)
      .where("applicationId", "in", chunk)
      .select("applicationId", "deliveryState")
      .get();
    for (const doc of snapshot.docs) {
      const row = doc.data() ?? {};
      const key = asString(row.applicationId);
      if (!key) continue;
      // delivered 가 하나라도 있으면 delivered 다 — 재발송으로 행이 여럿일 수 있다.
      const state = asString(row.deliveryState);
      if (state === "delivered" || !confirmStateByApplication.has(key)) confirmStateByApplication.set(key, state);
    }
  }
  const historyByApplication = new Map<string, Record<string, unknown>>();
  for (let offset = 0; offset < applicationIds.length; offset += 100) {
    const chunk = applicationIds.slice(offset, offset + 100);
    if (chunk.length === 0) continue;
    const snapshots = await adminDb.getAll(
      ...chunk.map((id) => adminDb.collection(VIDEO_REMINDER_HISTORY_COLLECTION).doc(id)),
    );
    for (const snapshot of snapshots) {
      if (snapshot.exists) historyByApplication.set(snapshot.id, snapshot.data() ?? {});
    }
  }

  const rows: ApplicationVideoPendingRow[] = [];
  for (const doc of pending) {
    const record = doc.data() ?? {};
    const identity = asRecord(record.identity);
    const applicationId = asString(identity.applicationId) || doc.id;
    const confirmState = confirmStateByApplication.get(applicationId) ?? "";
    const hasConfirmRecord = confirmStateByApplication.has(applicationId);
    const confirmationDelivery: ApplicationVideoPendingRow["confirmationDelivery"] =
      confirmState === "delivered"
        ? "delivered"
        : confirmState === "dead_letter"
          ? "dead_letter"
          : !hasConfirmRecord
            ? "unknown"
            : "pending";
    const history = historyByApplication.get(applicationId) ?? {};
    const lastReminderAtIso = asString(history.lastReminderAtIso);
    const appliedAtIso = asString(record.submittedAtIso) || asString(record.createdAtIso);
    const remaining = videoReminderCooldownRemainingMs(lastReminderAtIso, nowMs, listCooldownMs);
    rows.push({
      applicationId,
      programId: asString(identity.programId) || asString(record.currentProgramId),
      appliedAtIso,
      daysSinceApply: appliedAtIso ? daysBetween(appliedAtIso, nowMs) : null,
      confirmationDelivery,
      availableAction: resolveVideoPendingAction(confirmationDelivery),
      lastReminderAtIso,
      // W72 [R1 P2-8]: 화면 "재촉 N회"는 **받은 통수**여야 한다. 구 스키마(`reminderCount`)는
      //   적재 카운터였고 W72-B 이후 갱신되지 않는다 — 그대로 두면 1통 받아도 "재촉 없음"이다.
      reminderCount: Number(history.deliveredCount ?? 0),
      cooldownUntilIso: remaining > 0 ? new Date(nowMs + remaining).toISOString() : "",
      creatorHandle: asString(record.creatorHandle),
      creatorDisplayName: asString(record.creatorDisplayName),
    });
  }

  const counts = {
    pending: rows.length,
    nudgeEligible: rows.filter((row) => row.availableAction === "nudge").length,
    resendEligible: rows.filter((row) => row.availableAction === "resend_confirmation").length,
    blocked: rows.filter((row) => row.availableAction === "blocked").length,
    inCooldown: rows.filter((row) => row.cooldownUntilIso).length,
  };
  return {
    ok: true,
    counts,
    // W72 [R1 P2-7]: 화면 문구가 코드 상수(3일)를 말하고 서버는 설정(7일)로 막는 불일치를 없앤다.
    cooldownDays: listCooldownDays,
    // W62c-C3: 화면이 버튼을 낼지 말지를 **서버 사실**로 정한다(클라 상수 복제 금지).
    // W62j-D1 [레인 인지]: 배선 사실만으로는 부족하다. 조회는 스테이징 파사드에서 approved 이고
    //   (W62i) 적재는 denied 이므로(W62h), 스테이징에서는 목록이 뜨는데 재촉 버튼만 눌리면
    //   not-found 가 난다 — "화면은 되는데 서버가 막는" 그 비대칭이다. 레인을 함께 본다.
    //   파사드는 자기 코드베이스가 아니면 로드 자체를 거부하므로(runtime/index.cjs 의
    //   FLU_FUNCTIONS_CODEBASE === "staging" 단정), 스테이징에서 이 값은 항상 false 이고
    //   화면의 기존 '재촉 대기 · 발송 워커 배선 후 활성화' 분기가 그대로 켜진다.
    reminderSendEnabled: VIDEO_REMINDER_DRAIN_WIRED && process.env.FLU_FUNCTIONS_CODEBASE !== "staging",
    rows,
    actorRole: auth.role,
  };
}

/**
 * W62-2 재촉 발송. **직접 SMTP 를 부르지 않는다** — 정규 아웃박스에 적재만 하고,
 * 승인·쿼터·suppression·dedup 게이트가 걸린 기존 드레인이 실제 발송을 한다(리더 지시).
 */
/**
 * W72 A: 코호트2 적재 **코어**. 콜러블과 스윕이 **같은 구현**을 쓴다.
 *
 * 가드를 두 벌 만들면(콜러블 한 벌, 스윕 한 벌) 한쪽만 고쳐졌을 때 스윕이 화면보다 헐거워진다 —
 * 상한·쿨다운·in-flight·회차 매핑이 전부 발송 안전 축이라 그 갈라짐이 곧 오발송이다.
 *
 * 예외 대신 **사유 코드를 돌려준다.** 스윕은 사유별로 세야 하고(측정), 콜러블은 그 사유를
 * 그대로 예외로 옮긴다(화면 문구). 던지는 쪽을 코어에 두면 스윕이 예외를 세게 된다.
 */
export type VideoReminderEnqueueOutcome =
  | { outcome: "queued"; outboxId: string; reminderSequence: number; cooldownUntilIso: string }
  | { outcome: "cooldown"; cooldownRemainingMs: number; cadenceDays: number }
  | { outcome: "not_found" }
  | { outcome: "already_submitted" }
  | { outcome: "confirmation_not_delivered" }
  | { outcome: "config_missing" }
  | { outcome: "drain_not_wired" }
  | { outcome: "in_flight" }
  | { outcome: "max_reached"; maxSends: number }
  | { outcome: "unmapped"; reminderSequence: number }
  | { outcome: "sequence_attempts_exhausted"; reminderSequence: number };

export async function enqueueVideoReminderForApplication(input: {
  applicationId: string;
  actorUserId: string;
  nowMs: number;
  /** 이미 읽어 둔 제출 키 집합(스윕이 배치로 한 번만 읽는다). 없으면 여기서 읽는다. */
  submittedKeys?: Set<string>;
}): Promise<VideoReminderEnqueueOutcome> {
  const applicationId = input.applicationId;
  const nowMs = input.nowMs;
  const nowIso = new Date(nowMs).toISOString();

  // W62c-C3: 소비자가 없으면 **아무 상태도 남기지 않고** 거절한다. 이력·쿨다운을 먼저 태우면
  //   "보냈다고 표시되는데 아무도 안 받는" 레인이 만들어지고, 쿨다운 때문에 재시도도 막힌다.
  if (!VIDEO_REMINDER_DRAIN_WIRED) return { outcome: "drain_not_wired" };

  const applicationSnapshot = await adminDb.collection(APPLICATION_COLLECTION).doc(applicationId).get();
  if (!applicationSnapshot.exists) return { outcome: "not_found" };
  const record = applicationSnapshot.data() ?? {};
  const identity = asRecord(record.identity);

  // 이미 영상을 올렸으면 재촉 자체가 오발송이다. 화면 상태가 낡았을 수 있으므로 서버가 다시 본다.
  const submitted = input.submittedKeys ?? await readSubmittedKeys();
  const enrollmentId = asString(identity.enrollmentId);
  if (submitted.has(applicationId) || (enrollmentId && submitted.has(enrollmentId))) {
    return { outcome: "already_submitted" };
  }

  // 모수 분리(리더 판정 2): 확인 메일이 전달된 사람에게만 재촉이 나간다.
  const confirmSnapshot = await adminDb.collection(CONFIRM_OUTBOX_COLLECTION)
    .where("applicationId", "==", applicationId).limit(1).get();
  const confirmState = asString(confirmSnapshot.docs[0]?.data()?.deliveryState);
  if (confirmState !== "delivered") return { outcome: "confirmation_not_delivered" };

  const programId = asString(identity.programId) || asString(record.currentProgramId);
  const historyRef = adminDb.collection(VIDEO_REMINDER_HISTORY_COLLECTION).doc(applicationId);

  // W72 [리더 확정]: 상한(10)·주기(주 1회)·회차별 문안 매핑은 **설정 문서 정본**에서 읽는다.
  //   코드 기본값으로 박지 않는다(브리프 §1-1a).
  const nudgeConfig = await readNudgeSequenceConfig();
  const cohortConfig = nudgeConfig.cohorts.get(NUDGE_COHORT2_KEY);
  // fail-closed. 다만 설정 부재는 **"상한 0회"가 아니다** — 같은 사유로 뭉치면 운영자가
  //   "이미 10번 보냈나?"를 확인하러 가고 진짜 원인(설정 문서 없음)은 화면 어디에도 안 뜬다.
  if (!cohortConfig) return { outcome: "config_missing" };
  const maxSends = cohortConfig.maxSends;
  const cooldownMs = cohortConfig.cadenceDays * 24 * 60 * 60 * 1000;

  // W62c-M5 [두 리뷰 수렴]: 이력 읽기 → 쿨다운 판정 → **두 개의 쓰기**가 트랜잭션 밖에 있었다.
  //   두 운영자가 동시에 누르면 둘 다 쿨다운을 통과하고 재촉이 두 번 나간다(연타 방지의 목적 상실).
  //   → 한 트랜잭션으로 묶는다.
  //
  // W72-B [리더 승인 2026-08-12 · 회차 판정을 delivered 기준으로]
  //   종전에는 이력의 `reminderCount` 를 **적재 시점에** 올려 회차를 확정했다. 그래서 캡·게이트에
  //   막혀 한 통도 안 나가도 회차가 탔다. 헤세 원문 의도는 "받은 10통"이지 "시도한 10번"이 아니다.
  //   → 회차와 상한을 **아웃박스의 delivered 행 수**로 판정한다. 원장이 하나라 사후 대조가 가능하다.
  //
  //   문서 키는 여전히 유일해야 하므로 **단조 증가하는 적재 순번**(enqueueSequence)을 쓴다.
  //   두 수는 다른 사실이다:
  //     reminderSequence  = deliveredCount + 1   ← 회차. 문안 매핑과 상한이 이 값을 본다
  //     enqueueSequence   = 총 적재 시도 + 1     ← 문서 키. 실패해서 다시 적재해도 새 문서가 된다
  //   dead_letter 난 3회차를 다시 적재하면 reminderSequence 는 그대로 3, 문서만 새로 생긴다.
  // 0.6.110: 프로그램/캠페인 오버라이드 해석 키 — **현재 배정**(currentCampaignId)이 우선이다(재배정은 현재 값만
  //   갱신하고 identity 는 원본을 보존한다). 신청 원장의 program 값은 포털 공통 스코프(`view-cpm`)일 수 있어
  //   그때는 캠페인 문서의 canonical programId 로 푼다. 오버라이드가 하나도 없으면 읽기 0(기존 동작 불변).
  const overrideProgramKeys: string[] = [];
  if (nudgeConfig.programOverrides.size > 0) {
    // 현재 배정 필드가 있으면(null/빈 값 포함) 그것이 정본이다 — 재배정으로 캠페인이 풀렸는데 identity 의 옛 캠페인이
    //   되살아나 현재 프로그램 오버라이드보다 앞서면 안 된다.
    const campaignId = Object.prototype.hasOwnProperty.call(record, "currentCampaignId")
      ? asString(record.currentCampaignId)
      : asString(identity.campaignId);
    let canonicalProgramId = asString(record.currentProgramId);
    if (campaignId) overrideProgramKeys.push(campaignId);
    if ((!canonicalProgramId || canonicalProgramId === PORTAL_PROGRAM_ID) && campaignId) {
      const campaignDoc = await adminDb.collection("campaigns").doc(campaignId).get();
      canonicalProgramId = asString(campaignDoc.data()?.programId) || asString(campaignDoc.data()?.canonicalProgramId);
    }
    if (canonicalProgramId && canonicalProgramId !== PORTAL_PROGRAM_ID) overrideProgramKeys.push(canonicalProgramId);
  }
  const outboxCollection = adminDb.collection(VIDEO_REMINDER_OUTBOX_COLLECTION);
  const outcome = await adminDb.runTransaction(async (transaction) => {
    const historySnapshot = await transaction.get(historyRef);
    // 회차의 정본은 이력이 아니라 아웃박스다. 이력의 카운터는 화면용 투영이고, 여기서 매번 대조해
    // 어긋나면 고쳐 쓴다(자가 치유) — 두 원장이 조용히 갈라지는 것을 막는다.
    const existingRows = await transaction.get(
      outboxCollection.where("applicationId", "==", applicationId),
    );
    const historyData = historySnapshot.exists ? (historySnapshot.data() ?? {}) : {};
    const lastReminderAtIso = asString(historyData.lastReminderAtIso);
    // W72 스펙 [헤세 2026-08-13]: 첫 독려도 apply 로부터 cadence 가 지나야 한다.
    const remaining = videoReminderGateRemainingMs({
      lastReminderAtIso,
      // 프로드 실측: apply 시각은 **최상위** submittedAtIso 다(identity 에는 없다).
      //   같은 파일 246행 부근의 목록 조회도 같은 필드를 정본으로 쓴다.
      appliedAtIso: asString(record.submittedAtIso),
      nowMs,
      cooldownMs,
    });
    if (remaining > 0) {
      return { cooldownRemainingMs: remaining, outboxId: "", blocked: "", reminderSequence: 0 };
    }

    let deliveredCount = 0;
    let inFlightCount = 0;
    // 적대 리뷰 P1: 같은 회차를 몇 번 시도했는지도 세야 한다. 안 세면 영구 실패 수신자에게
    //   dead_letter → 재적재가 무한 반복되고 상한(delivered 기준)은 영원히 도달하지 않는다.
    const attemptsBySequence = new Map<number, number>();
    for (const rowDoc of existingRows.docs) {
      const rowData = rowDoc.data() ?? {};
      const state = asString(rowData.deliveryState);
      const seq = Math.trunc(Number(rowData.reminderSequence ?? 0));
      // W72 [R1 P1-2]: 운영자가 복구 콜러블로 **봉인한** 실패 기록은 시도 예산에서 뺀다.
      //   삭제가 아니라 표시라 감사 추적은 그대로 남는다.
      if (Number.isSafeInteger(seq) && seq >= 1 && !rowData.sequenceResetAtIso) {
        attemptsBySequence.set(seq, (attemptsBySequence.get(seq) ?? 0) + 1);
      }
      if (state === "delivered") deliveredCount += 1;
      else if (IN_FLIGHT_REMINDER_STATES.has(state)) inFlightCount += 1;
    }

    // 같은 회차 중복 발송 방지: 아직 처리 중인 행이 있으면 새로 적재하지 않는다.
    //   쿨다운만으로는 못 막는다 — 쿨다운이 지나도 앞 행이 큐에 남아 있을 수 있다.
    if (inFlightCount > 0) {
      return { cooldownRemainingMs: 0, outboxId: "", blocked: "in_flight", reminderSequence: 0 };
    }
    // 상한: **받은 통수** 기준이다.
    if (deliveredCount >= maxSends) {
      return { cooldownRemainingMs: 0, outboxId: "", blocked: "max_reached", reminderSequence: 0 };
    }
    const reminderSequence = deliveredCount + 1;
    // 적대 리뷰 P1: 이 회차를 이미 N 번 시도했으면 멈춘다. 안 그러면 영구 실패 수신자에게
    //   같은 회차가 무한 재적재된다(delivered 가 안 되니 상한도 안 걸린다).
    if ((attemptsBySequence.get(reminderSequence) ?? 0) >= MAX_ENQUEUE_ATTEMPTS_PER_SEQUENCE) {
      return { cooldownRemainingMs: 0, outboxId: "", blocked: "sequence_attempts_exhausted", reminderSequence };
    }
    // 미설정 회차는 **적재 자체를 하지 않는다**(리더 확정). 임의 폴백 문안으로 보내지 않는다.
    const templateKey = nudgeTemplateKeyForSequence(
      nudgeConfig, NUDGE_COHORT2_KEY, reminderSequence, overrideProgramKeys,
    );
    if (!templateKey) {
      return { cooldownRemainingMs: 0, outboxId: "", blocked: "unmapped", reminderSequence };
    }

    const enqueueSequence = existingRows.size + 1;
    // W62e-MIN [Codex 델타]: 200자 절단이 결정적 키를 **충돌**시킬 수 있다 —
    //   긴 applicationId 두 개가 앞 200자가 같으면 순번까지 같아져 같은 문서를 가리킨다.
    //   순번 접미사가 잘려 나가면 더 나쁘다. 잘릴 때는 해시로 신원을 보존한다.
    const rawOutboxId = `${applicationId}__${enqueueSequence}`.replace(/[^A-Za-z0-9_.:@-]+/g, "_");
    const outboxId = rawOutboxId.length <= 200
      ? rawOutboxId
      : `${rawOutboxId.slice(0, 150)}__${hashOpaque(rawOutboxId).slice(0, 24)}__${enqueueSequence}`;

    // 아웃박스 행 형상은 확인 메일 레인과 같다 — 드레인이 같은 규약으로 읽는다.
    // W62e-minor [독립 델타]: set 이 아니라 **create** 다. 키가 이미 있으면 충돌로 실패해
    //   트랜잭션이 통째로 되감긴다(같은 사람에게 두 번 발송 방지).
    transaction.create(outboxCollection.doc(outboxId), {
      applicationId,
      programId,
      templateKind: "application_video_reminder",
      // W72: 이 행이 어떤 문안으로 나가야 하는지를 **적재 시점에 고정**한다. 발송 시점에 매핑이
      //   바뀌어도 이미 큐에 있는 행의 문안이 바뀌지 않는다(회차 ↔ 문안 대응의 재현성).
      nudgeCohort: NUDGE_COHORT2_KEY,
      nudgeTemplateKey: templateKey,
      locale: "en",
      deliveryState: "queued",
      transport: "unconfigured",
      attempts: 0,
      quotaDeferrals: 0,
      reminderSequence,
      enqueueSequence,
      ...(asString(identity.enrollmentId) ? { enrollmentId: asString(identity.enrollmentId) } : {}),
      // W62c-minor: 앞 12자 절단은 해시가 아니라 **원문 조각**이다(uid 가 그대로 샌다).
      requestedByHash: hashOpaque(input.actorUserId),
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(historyRef, {
      applicationId,
      lastReminderAtIso: nowIso,
      // 화면용 투영. 회차 판정은 이 값을 **쓰지 않는다**(위에서 아웃박스로 판정했다).
      deliveredCount,
      enqueueCount: enqueueSequence,
      lastRequestedSequence: reminderSequence,
      lastOutboxId: outboxId,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { cooldownRemainingMs: 0, outboxId, blocked: "", reminderSequence };
  });

  if (outcome.blocked === "in_flight") return { outcome: "in_flight" };
  if (outcome.blocked === "sequence_attempts_exhausted") {
    return { outcome: "sequence_attempts_exhausted", reminderSequence: outcome.reminderSequence };
  }
  if (outcome.blocked === "max_reached") return { outcome: "max_reached", maxSends };
  if (outcome.blocked === "unmapped") {
    return { outcome: "unmapped", reminderSequence: outcome.reminderSequence };
  }
  if (outcome.cooldownRemainingMs > 0) {
    return {
      outcome: "cooldown",
      cooldownRemainingMs: outcome.cooldownRemainingMs,
      cadenceDays: cohortConfig.cadenceDays,
    };
  }
  return {
    outcome: "queued",
    outboxId: outcome.outboxId,
    reminderSequence: outcome.reminderSequence,
    // W72 [R2-4]: 다음 가능 시각도 설정 정본 기준이다.
    cooldownUntilIso: new Date(nowMs + cooldownMs).toISOString(),
  };
}

/**
 * W62-2 재촉 발송 콜러블 — 코어를 부르고 **사유를 예외로 옮기는 얇은 껍데기**다.
 * 가드는 전부 코어에 있다(스윕과 같은 구현).
 */
export async function enqueueApplicationVideoReminder(request: CallableRequestShape) {
  // 발송은 조회보다 좁다 — viewer 는 실메일을 쏠 수 없다.
  const auth = assertNonGuestAuth(request, "application_video_pending.nudge", ["super_admin", "admin", "manager"]);
  await assertScpEntitled(auth, request, "application_video_pending.nudge");
  const data = asRecord(request.data);
  const applicationId = asString(data.applicationId).trim().slice(0, 200);
  // W62c-M4 [두 리뷰 수렴]: nowIso 는 **에뮬레이터에서만** 수용한다. 호출자가 시각을 정하면
  //   쿨다운을 과거로 밀어 연타 방지를 무력화할 수 있다. 운영에서는 서버 시각만 쓴다.
  const clientNowMs = process.env.FUNCTIONS_EMULATOR === "true"
    ? Date.parse(asString(data.nowIso))
    : Number.NaN;
  const nowMs = Number.isFinite(clientNowMs) ? clientNowMs : Date.now();
  if (!applicationId) {
    throw Object.assign(new Error("applicationId is required"), {
      code: "invalid-argument", errorCode: "application_video_reminder_application_id_required",
    });
  }

  const result = await enqueueVideoReminderForApplication({
    applicationId,
    actorUserId: asString(auth.userId),
    nowMs,
  });

  const fail = (message: string, errorCode: string, code = "failed-precondition") => Object.assign(
    new Error(message),
    { code, errorCode },
  );
  switch (result.outcome) {
    case "queued":
      return {
        ok: true,
        applicationId,
        outboxId: result.outboxId,
        queued: true,
        cooldownUntilIso: result.cooldownUntilIso,
      };
    case "drain_not_wired":
      throw fail(
        "재촉 메일 발송 워커가 아직 배선되지 않았습니다. 배선 후 활성화됩니다.",
        "application_video_reminder_drain_not_wired",
      );
    case "not_found":
      throw fail("application not found", "application_video_reminder_application_not_found", "not-found");
    case "already_submitted":
      throw fail("이미 영상을 제출한 지원자입니다.", "application_video_reminder_already_submitted");
    case "confirmation_not_delivered":
      throw fail(
        "확인 메일이 전달되지 않은 지원자입니다. 재촉이 아니라 확인 메일 재발송 대상입니다.",
        "application_video_reminder_confirmation_not_delivered",
      );
    case "config_missing":
      throw fail(
        "독려 회차 설정이 아직 활성화되지 않았습니다. 검수 > 메일 템플릿에서 회차 매핑을 먼저 저장해 주세요.",
        "application_video_reminder_sequence_config_missing",
      );
    case "in_flight":
      throw fail(
        "직전 재촉이 아직 발송 대기 중입니다. 처리된 뒤에 다시 시도해 주세요.",
        "application_video_reminder_in_flight",
      );
    case "sequence_attempts_exhausted":
      throw fail(
        `이 회차는 이미 ${MAX_ENQUEUE_ATTEMPTS_PER_SEQUENCE}회 시도해 전부 실패했습니다. 수신자 상태를 확인해 주세요.`,
        "application_video_reminder_sequence_attempts_exhausted",
      );
    case "max_reached":
      throw fail(
        `재촉 최대 횟수(${result.maxSends}회)를 이미 받은 지원자입니다.`,
        "application_video_reminder_max_reached",
      );
    case "unmapped":
      throw fail(
        "이 회차에 매핑된 메일 템플릿이 없습니다. 검수 > 메일 템플릿에서 먼저 지정해 주세요.",
        NUDGE_TEMPLATE_UNMAPPED_REASON,
      );
    case "cooldown":
    default:
      throw fail(
        // W72 [R2-4]: 문구도 설정 정본을 말한다.
        `재촉 쿨다운 중입니다(${result.outcome === "cooldown" ? result.cadenceDays : 0}일). ${new Date(nowMs + (result.outcome === "cooldown" ? result.cooldownRemainingMs : 0)).toISOString()} 이후 가능합니다.`,
        "application_video_reminder_cooldown_active",
      );
  }
}

/**
 * W72 [R1 P1-2] 회차 시도 예산 복구 — **운영자 콜러블. 자동 리셋은 하지 않는다.**
 *
 * 회차당 적재 시도 천장(`MAX_ENQUEUE_ATTEMPTS_PER_SEQUENCE`)은 영구 실패 수신자의 무한 재적재를
 * 막지만, 원인(주소 오타·SMTP 장애)을 고친 뒤에도 그 회차가 영영 잠긴다는 부작용이 있다.
 * 자동 리셋을 넣으면 천장이 사라지므로(고쳐지지 않은 원인도 계속 재시도된다) **사람이 판단**한다.
 *
 * 이 함수는 발송하지 않는다. 막힌 회차의 **종결된 시도 기록만** 봉인 표시해 다음 적재를 허용한다.
 *   · delivered 행은 절대 건드리지 않는다 — 회차 소모(받은 통수)의 정본이다.
 *   · in-flight 행이 있으면 거절한다 — 처리 중인 발송을 봉인하면 이중 발송이 된다.
 *   · 봉인된 행은 `sequenceResetAtIso` 로 남아 감사 추적이 끊기지 않는다(삭제하지 않는다).
 */
export async function resetApplicationVideoReminderSequence(request: CallableRequestShape) {
  // 발송과 같은 권한대다 — 시도 예산을 되살리는 것은 발송 가능성을 여는 조치다.
  const auth = assertNonGuestAuth(
    request,
    "application_video_pending.reset_sequence",
    ["super_admin", "admin", "manager"],
  );
  // 2026-09-27 codex adversarial review FAIL-4: same scp surface as
  // listApplicationVideoPending/enqueueApplicationVideoReminderMail above — a role-permitted but
  // non-entitled manager must not be able to reopen a nudge sequence's send budget either.
  await assertScpEntitled(auth, request, "application_video_pending.reset_sequence");
  const data = asRecord(request.data);
  const applicationId = asString(data.applicationId).trim().slice(0, 200);
  if (!applicationId) {
    throw Object.assign(new Error("applicationId is required"), {
      code: "invalid-argument", errorCode: "application_video_reminder_application_id_required",
    });
  }
  // W72 [R2-3]: 어느 회차를 복구할지 **명시**해야 한다. 생략을 허용하면 application 전체가
  //   한 번에 풀려 운영자가 지목하지 않은 회차의 시도 예산까지 열린다.
  const sequence = Math.trunc(Number(data.sequence));
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw Object.assign(new Error("복구할 회차(sequence)를 지정해 주세요."), {
      code: "invalid-argument", errorCode: "application_video_reminder_reset_sequence_required",
    });
  }
  const reason = asString(data.reason).trim().slice(0, 300);
  if (!reason) {
    // 근거 없는 복구를 막는다 — 무엇을 고쳤는지 적지 않으면 같은 실패가 그대로 반복된다.
    throw Object.assign(new Error("복구 사유(reason)가 필요합니다. 무엇을 고쳤는지 적어 주세요."), {
      code: "invalid-argument", errorCode: "application_video_reminder_reset_reason_required",
    });
  }

  const nowIso = new Date().toISOString();
  const outboxCollection = adminDb.collection(VIDEO_REMINDER_OUTBOX_COLLECTION);

  return adminDb.runTransaction(async (transaction) => {
    const rows = await transaction.get(outboxCollection.where("applicationId", "==", applicationId));
    let inFlight = 0;
    let blockedUnknown = 0;
    const sealable: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    for (const rowDoc of rows.docs) {
      const rowData = rowDoc.data() ?? {};
      const state = asString(rowData.deliveryState);
      if (state === "delivered") continue;
      if (IN_FLIGHT_REMINDER_STATES.has(state)) { inFlight += 1; continue; }
      // W72 [R2-3]: 수락 불명은 봉인하지 않는다 — 재개가 중복 발송이 될 수 있다.
      if (RESET_FORBIDDEN_REMINDER_STATES.has(state)) { blockedUnknown += 1; continue; }
      if (rowData.sequenceResetAtIso) continue;
      // W72 [R2-3]: 봉인 범위를 **회차 단위**로 좁힌다. application 전체를 한 번에 풀면
      //   운영자가 지목하지 않은 회차의 예산까지 함께 열린다.
      if (Math.trunc(Number(rowData.reminderSequence ?? 0)) !== sequence) continue;
      sealable.push(rowDoc);
    }
    if (blockedUnknown > 0 && sealable.length === 0) {
      throw Object.assign(
        new Error(
          `이 회차에는 수락 여부가 확인되지 않은 발송(${blockedUnknown}건)이 있습니다. `
          + "메일 원장으로 실제 수신을 대조한 뒤 처리해 주세요 — 자동 복구하면 중복 발송이 됩니다.",
        ),
        { code: "failed-precondition", errorCode: "application_video_reminder_delivery_unknown_blocks_reset" },
      );
    }
    if (inFlight > 0) {
      throw Object.assign(
        new Error("처리 중인 재촉이 있습니다. 완료된 뒤에 복구해 주세요."),
        { code: "failed-precondition", errorCode: "application_video_reminder_in_flight" },
      );
    }
    if (sealable.length === 0) {
      throw Object.assign(
        new Error("복구할 실패 기록이 없습니다."),
        { code: "failed-precondition", errorCode: "application_video_reminder_nothing_to_reset" },
      );
    }
    for (const rowDoc of sealable) {
      transaction.set(rowDoc.ref, {
        sequenceResetAtIso: nowIso,
        sequenceResetByHash: hashOpaque(asString(auth.userId)),
        sequenceResetReason: reason,
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return { ok: true, applicationId, sequence, releasedRows: sealable.length, resetAtIso: nowIso };
  });
}
