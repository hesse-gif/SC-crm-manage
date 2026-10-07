import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { CHAT_AUTO_CASE_EXECUTION_LEDGER_COLLECTION } from "./chatAutoCasePermit";
import { postScheduledReportToSlack } from "./slackScheduledReports";

// 2026-10-02 silent-disarm 사고 수리: armed:true → armed:false 로 permit 을 내리는 모든 경로는
//   (1) execution ledger 에 전이 기록(caseId·사유 코드·actor·시각·이전/다음 상태)을 남기고
//   (2) 커밋 후 Slack 운영 알림을 보낸다. 알림은 케이스당 쿨다운으로 스팸을 막고, 사유 코드·케이스 id·
//   해시 actor 만 싣는다(PII 없음). 알림 실패는 절대 throw 하지 않는다.

export const CHAT_AUTO_PERMIT_DISARM_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const DISARM_ALERT_STATE_COLLECTION = "mail_safety_state";

export type ChatAutoPermitDisarmTransition = {
  caseId: string;
  reason: string;
  /** "system" 또는 actorHash — 원문 uid/이메일 금지. */
  actor: string;
  nowIso: string;
  previousState: string | null;
  nextState: string;
  /** "inert": permit 은 armed 로 남지만 카운터 floor 미달로 자동발송이 실효 정지(조용한 정지 방지용 기록). */
  effect?: "disarmed" | "inert";
};

export function chatAutoPermitDisarmLedgerFields(input: ChatAutoPermitDisarmTransition): Record<string, unknown> {
  const inert = input.effect === "inert";
  return {
    transition: inert ? "armed_to_inert" : "armed_to_disarmed",
    previousArmed: true,
    previousState: input.previousState,
    nextArmed: inert,
    nextState: input.nextState,
    transitionActor: input.actor,
    transitionReason: input.reason,
  };
}

export function createChatAutoPermitDisarmLedgerEntry(
  transaction: FirebaseFirestore.Transaction,
  db: typeof adminDb,
  input: ChatAutoPermitDisarmTransition,
): string {
  const id = createHash("sha256")
    .update(JSON.stringify(["permit_disarm_transition", input.caseId, input.reason, input.actor, input.nowIso]))
    .digest("hex")
    .slice(0, 40);
  transaction.set(db.collection(CHAT_AUTO_CASE_EXECUTION_LEDGER_COLLECTION).doc(id), {
    schemaVersion: 1,
    caseId: input.caseId,
    reason: input.reason,
    sourceRef: `permit_disarm_transition:${input.actor}`,
    ...chatAutoPermitDisarmLedgerFields(input),
    createdAtIso: input.nowIso,
    createdAt: FieldValue.serverTimestamp(),
    source: "functions.chatAutoPermitDisarmAudit",
  });
  return id;
}

const DISARM_ALERT_LEASE_MS = 2 * 60 * 1000;

function alertStateRef(db: typeof adminDb, caseId: string) {
  return db.collection(DISARM_ALERT_STATE_COLLECTION).doc(`chat_auto_permit_disarm_alert_${caseId}`);
}

/** disarm 트랜잭션 안에서 호출: 전달 대기 알림을 disarm 과 원자적으로 남긴다(커밋 직후 유실 방지). */
export function queueChatAutoPermitDisarmAlertInTransaction(
  transaction: FirebaseFirestore.Transaction,
  db: typeof adminDb,
  input: ChatAutoPermitDisarmTransition,
): void {
  transaction.set(alertStateRef(db, input.caseId), {
    caseId: input.caseId,
    pendingAlert: true,
    pending: { reason: input.reason, actor: input.actor, previousState: input.previousState, nextState: input.nextState, nowIso: input.nowIso, effect: input.effect ?? "disarmed" },
  }, { merge: true });
}

export async function notifyChatAutoPermitDisarmed(
  input: ChatAutoPermitDisarmTransition,
  deps: { db?: typeof adminDb; postToSlack?: typeof postScheduledReportToSlack; now?: () => number } = {},
): Promise<void> {
  try {
    const db = deps.db ?? adminDb;
    const ref = alertStateRef(db, input.caseId);
    const clock = deps.now ?? Date.now;
    // 리스·쿨다운은 이벤트 시각(nowIso)이 아니라 처리 시각 기준 — 긴 eval 뒤의 낡은 timestamp 로 리스가 즉시 만료되지 않게.
    const leaseId = createHash("sha256").update(`${input.caseId}:${clock()}:${Math.random()}`).digest("hex").slice(0, 16);
    const shouldNotify = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const data = snapshot.exists ? (snapshot.data() ?? {}) : {};
      const now = clock();
      const postedMs = typeof data.lastPostedAtIso === "string" ? Date.parse(data.lastPostedAtIso) : NaN;
      const leaseMs = typeof data.leaseUntilIso === "string" ? Date.parse(data.leaseUntilIso) : NaN;
      if (Number.isFinite(postedMs) && now - postedMs < CHAT_AUTO_PERMIT_DISARM_ALERT_COOLDOWN_MS) {
        // 쿨다운으로 의도적으로 억제 — 원장에는 남아 있으므로 pending 은 닫는다.
        transaction.set(ref, { pendingAlert: false }, { merge: true });
        return false;
      }
      if (Number.isFinite(leaseMs) && leaseMs > now) return false;
      transaction.set(ref, {
        caseId: input.caseId,
        pendingAlert: true,
        pending: { reason: input.reason, actor: input.actor, previousState: input.previousState, nextState: input.nextState, nowIso: input.nowIso, effect: input.effect ?? "disarmed" },
        leaseId,
        leaseUntilIso: new Date(now + DISARM_ALERT_LEASE_MS).toISOString(),
      }, { merge: true });
      return true;
    });
    if (!shouldNotify) return;
    let posted = false;
    try {
      const result = await (deps.postToSlack ?? postScheduledReportToSlack)([
        input.effect === "inert"
          ? "⚠️ *Chat Auto Permit 자동응답 실효 정지됨 (armed 유지, 카운터 floor 미달)*"
          : "⚠️ *Chat Auto Permit 자동응답 무장 해제됨*",
        `대상: ${input.caseId}`,
        `사유: ${input.reason} · 주체: ${input.actor === "system" ? "system" : "operator"}`,
        `상태: ${input.previousState ?? "armed"} → ${input.nextState}`,
        "자동 재무장은 하지 않습니다 — 원인 확인 후 setChatAutoCasePermitArming 으로 재무장하세요. (케이스당 1시간 1회만 알림)",
      ].join("\n"));
      posted = result.posted;
    } finally {
      // 내 lease 가 아직 유효할 때만 마무리한다(오래된 시도가 새 상태를 덮어쓰지 않게).
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if ((snapshot.data() ?? {}).leaseId !== leaseId) return;
        transaction.set(ref, posted
          ? { pendingAlert: false, lastPostedAtIso: new Date(clock()).toISOString(), leaseUntilIso: null, leaseId: null }
          : { leaseUntilIso: null, leaseId: null }, { merge: true });
      });
    }
  } catch (error) {
    console.error("[chatAutoPermitDisarmAudit] slack notify failed", error instanceof Error ? error.message : String(error));
  }
}

/** Slack 전달에 실패했거나 커밋 직후 유실된 알림을 재시도한다(refresh 스윕이 호출). 던지지 않는다. */
export async function retryPendingChatAutoPermitDisarmAlerts(
  deps: { db?: typeof adminDb; postToSlack?: typeof postScheduledReportToSlack; now?: () => number } = {},
): Promise<number> {
  try {
    const db = deps.db ?? adminDb;
    const snapshot = await db.collection(DISARM_ALERT_STATE_COLLECTION).where("pendingAlert", "==", true).limit(10).get();
    const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
    for (const doc of snapshot.docs) {
      const data = doc.data() ?? {};
      const pending = (data.pending ?? {}) as Record<string, unknown>;
      if (typeof data.caseId !== "string" || typeof pending.reason !== "string") continue;
      await notifyChatAutoPermitDisarmed({
        caseId: data.caseId,
        reason: pending.reason,
        actor: typeof pending.actor === "string" ? pending.actor : "system",
        previousState: typeof pending.previousState === "string" ? pending.previousState : null,
        nextState: typeof pending.nextState === "string" ? pending.nextState : "disarmed",
        effect: pending.effect === "inert" ? "inert" : "disarmed",
        nowIso,
      }, { db, postToSlack: deps.postToSlack, now: deps.now });
    }
    return snapshot.size;
  } catch (error) {
    console.error("[chatAutoPermitDisarmAudit] retry pending failed", error instanceof Error ? error.message : String(error));
    return 0;
  }
}
