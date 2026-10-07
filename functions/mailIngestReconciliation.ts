import { adminDb } from "./firebaseAdmin";
import { safeMailDocId } from "./mailSafetyShared";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";

// S2/P2 (RT-1 acceptance b) — mail_outbound_log against IMAP ingest reconciliation.
// Purely observational: never mutates outbound/ingest state, only writes an operator
// ledger (`mail_ingest_gaps`) so a stalled reply thread can be triaged. Both source
// queries are single-field equality (no composite Firestore index required); the
// N-day cutoff and dead-letter correlation are computed in memory.

const DEFAULT_REPLY_WAIT_DAYS = 5;
const SWEEP_LIMIT = 200;
const DEAD_LETTER_SCAN_LIMIT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

const SWEEP_ROLES = ["super_admin", "admin", "manager"] as const;

export type MailIngestGapsSweepResult = {
  readonly ok: boolean;
  readonly scanned: number;
  readonly gapsRecorded: number;
  readonly replyWaitDays: number;
};

async function readReplyWaitDays(): Promise<number> {
  const settings = (await adminDb.doc("settings/default").get()).data() ?? {};
  const email = asRecord(settings.email);
  const reconciliation = asRecord(email.reconciliation);
  const value = reconciliation.replyWaitDays;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_REPLY_WAIT_DAYS;
}

// 발송 trackingId 대비 회신 ingest 비교 — N일 경과했는데 hasReply=false인 발송 건을, 같은 구간에
// 발생한 IMAP dead-letter(포이즌 메시지, RT-1)와 상관지어 mail_ingest_gaps ledger에 기록한다.
// trackingId 없는 포이즌 메시지도 잡기 위해 정확한 1:1 매칭 대신 "발송 이후 발생한 dead-letter
// 존재 여부"로 상관시킨다 — 자동 조치 없음, 운영자 관측/재스캔 트리거용.
export async function sweepMailIngestGaps(now: Date = new Date()): Promise<MailIngestGapsSweepResult> {
  const replyWaitDays = await readReplyWaitDays();
  const cutoffMs = now.getTime() - replyWaitDays * DAY_MS;

  const [outboundSnapshot, deadLetterSnapshot] = await Promise.all([
    adminDb.collection("mail_outbound_log").where("hasReply", "==", false).limit(SWEEP_LIMIT).get(),
    adminDb.collection("mail_ingest_errors").where("status", "==", "dead_letter").limit(DEAD_LETTER_SCAN_LIMIT).get(),
  ]);

  const deadLetters = deadLetterSnapshot.docs
    .map((doc) => ({ id: doc.id, deadLetterAtIso: asString(doc.data().deadLetterAtIso, "") }))
    .filter((entry): entry is { id: string; deadLetterAtIso: string } => Boolean(entry.deadLetterAtIso));

  let scanned = 0;
  let gapsRecorded = 0;
  const batch = adminDb.batch();
  for (const doc of outboundSnapshot.docs) {
    const row = doc.data() ?? {};
    const trackingId = asString(row.trackingId, doc.id);
    const sentAtIso = asString(row.sentAtIso, "");
    if (!sentAtIso) continue;
    const sentAtMs = Date.parse(sentAtIso);
    if (!Number.isFinite(sentAtMs) || sentAtMs > cutoffMs) continue; // not overdue yet
    scanned += 1;
    const daysWaiting = Math.floor((now.getTime() - sentAtMs) / DAY_MS);
    const correlatedDeadLetterIds = deadLetters
      .filter((entry) => Date.parse(entry.deadLetterAtIso) >= sentAtMs)
      .map((entry) => entry.id)
      .slice(0, 5);
    const gapRef = adminDb.collection("mail_ingest_gaps").doc(safeMailDocId("mail_ingest_gap", trackingId));
    batch.set(gapRef, {
      trackingId,
      to: asString(row.to, ""),
      subject: asString(row.subject, ""),
      sentAtIso,
      daysWaiting,
      // 편입 발신은 conversationId 대신 전용 축(stitchedConversationId)에만 쓴다 — 두 축을
      // 모두 싣는다. mailAccountId 는 어느 계정의 Sent 에서 온 미답신인가의 구분축이다
      // (개인 계정 Sent 편입 — feat/personal-sent-ingest).
      mailAccountId: asString(row.mailAccountId, ""),
      conversationId: asString(row.conversationId, "") || asString(row.stitchedConversationId, ""),
      likelyIngestIssue: correlatedDeadLetterIds.length > 0,
      correlatedDeadLetterIds,
      checkedAtIso: now.toISOString(),
    }, { merge: true });
    gapsRecorded += 1;
  }
  if (gapsRecorded > 0) await batch.commit();
  return { ok: true, scanned, gapsRecorded, replyWaitDays };
}

export async function sweepMailIngestGapsCallable(request: CallableRequestShape) {
  const ctx = assertNonGuestAuth(request, "mail_ingest.sweepGaps", SWEEP_ROLES);
  const result = await sweepMailIngestGaps();
  return {
    ...result,
    behaviorLog: makeBehaviorLog(ctx, `mail_ingest.sweepGaps(${result.gapsRecorded})`, "success", ctx.gameId),
  };
}
