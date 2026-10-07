// Task-100 F-6: 반려 후 재제출 독려 메일. video_resubmission_cycles 를 target(=사이클 문서 자체,
// 별도 target 컬렉션 불필요 — scpVideoSubmissionReminder.ts 와 달리 target 은 이미 사이클 문서가
// 겸한다)으로, scp_resubmission_nudge_mail_outbox 를 occurrence(=발송 시도 1건) 아웃박스로 쓴다.
//
// 재사용: defaultMailSendAdapter/defaultRecipientResolver(scpOutboxMailWorkers.ts, 코호트2 드레인과
// 동일) — 안전판(레인 정지·GA 파일럿 펜스·SMTP 게이트·발송 시점 재검사·중복 감지)을 그대로 물려받는다.
// resolveNudgeSequenceTemplateByKey — 발행 문서가 없으면 **보내지 않는다**(코드 폴백 없음, "draft
// copy" 요구사항 그대로: 운영자가 편집기에서 문안을 발행해야 실제로 나간다).
//
// 스케줄: 새 onSchedule 을 만들지 않는다(핀 42) — 적재는 processVideoSubmissionRemindersSchedule 에,
// 발송은 scpApplicationVideoReminderMailWorker 에 피기백한다(index.ts).

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asString } from "./shared";
import {
  VIDEO_RESUBMISSION_CYCLE_COLLECTION,
  planNextResubmissionNudgeOccurrence,
  planResubmissionCycleChurn,
  type ResubmissionCycleStatus,
} from "./videoResubmissionCycleCore";
import { readResubmissionCyclePolicy } from "./resubmissionCyclePolicy";
import { videoReviewReasonCodeNudgePhrase } from "./videoReviewReasonCodeCatalog";
import {
  defaultMailSendAdapter,
  defaultRecipientResolver,
  type MailSendAdapter,
  type RecipientResolver,
  type OutboundMailMessage,
} from "./scpOutboxMailWorkers";
import { resolveNudgeSequenceTemplateByKey } from "./scpReceiptMailTemplates";
import { readMailLaneManualPause, laneDailyQuotaAllows, totalDailyQuotaAllows } from "./mailOutboundSafety";
import { readNudgeLaneQuotaConfig, readNudgeTotalDailyCap, NUDGE_COHORT4_KEY } from "./nudgeSequenceTemplates";

export const SCP_RESUBMISSION_NUDGE_MAIL_OUTBOX_COLLECTION = "scp_resubmission_nudge_mail_outbox";
export const RESUBMISSION_NUDGE_MAIL_PURPOSE = "resubmission_nudge";
export const RESUBMISSION_NUDGE_TEMPLATE_KIND = "resubmission_nudge_en";
const SCP_CREATOR_PORTAL_LINK = "https://creator.supercent.io";

// ---- 2026-09-28 사고 최소 안전장치(코덱스 라운드1~3 이후 최종) --------------------------------------
// video_resubmission_cycles 는 submissionId(영상) 단위 원장이라, 영상 여러 개가 legacy 배치로 한
// 번에 반려된 창작자 1명이 사이클마다 독립적으로 나가는 독려 때문에 근접 중복 메일을 여러 통 받을
// 수 있다. 앞선 세 라운드는 드레인 시점 recipient 마커(라운드1~2)와 적재 시점 recipient 합류
// (라운드3)로 막으려다가 매번 새 경합(마커 해제 타이밍·delivery_unknown 판정·비원자적 3중 쓰기·
// KST 롤오버, 그리고 적재 재설계의 레거시 행 이중발송·유실된 append·미확정 상태의 조기 카운트·
// 시크릿 미바인딩)을 만들었다 — **사이클 단위 occurrence 는 손대지 않는다.** 대신 발송 직전에
// "같은 recipient 가 최근에 이미 받았는가"만 보고, 맞으면 그냥 queued 로 미룬다: 사이클도
// 안 건드리고(전진 없음) occurrence 도 안 건드린다(합류·종결 없음) — 유실도 유령 발송도 생길 수
// 없다. 최악의 경우 다중 영상 창작자가 ~20시간에 한 통만 받는다(그 이상 자주는 안 간다).
const RECIPIENT_SEND_GAP_MS = 20 * 60 * 60 * 1000;

function canonicalRecipientEmail(email: string): string {
  return email.trim().toLowerCase();
}

// scpOutboxMailWorkers.ts 의 recipientEmailHash 관례와 동일: 이메일 원문은 저장하지 않는다.
function recipientHashFor(email: string): string {
  return createHash("sha256").update(canonicalRecipientEmail(email)).digest("hex").slice(0, 32);
}

/** target(사이클 문서 id) × 회차 → 결정적 occurrence id (scpVideoSubmissionReminder.ts 와 같은 sha256 규율). */
export function resubmissionNudgeOccurrenceId(cycleDocId: string, nudgeSeq: number): string {
  return createHash("sha256").update(`resubmission-nudge:${cycleDocId}:${nudgeSeq}`).digest("hex").slice(0, 40);
}

/** deadlineAtIso → 사람이 읽는 날짜(UTC 기준 YYYY-MM-DD). 파싱 불가면 빈 문자열(치환 실패 방지는 렌더러가 한다). */
export function formatResubmissionDeadline(deadlineAtIso: string): string {
  const ms = Date.parse(deadlineAtIso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
}

// ---- §1 enqueue: 사이클 스윕 → 독려 occurrence 적재 + 기한초과 종결 --------------------------------

const CYCLE_SCAN_LIMIT = 200;

export type EnqueueResubmissionNudgeOccurrencesResult = {
  scanned: number;
  enqueued: number;
  churned: number;
};

export async function enqueueResubmissionNudgeOccurrences(
  now: Date = new Date(),
): Promise<EnqueueResubmissionNudgeOccurrencesResult> {
  const nowIso = now.toISOString();
  const result: EnqueueResubmissionNudgeOccurrencesResult = { scanned: 0, enqueued: 0, churned: 0 };

  const snapshot = await adminDb
    .collection(VIDEO_RESUBMISSION_CYCLE_COLLECTION)
    .where("status", "==", "awaiting_resubmission")
    .limit(CYCLE_SCAN_LIMIT)
    .get();
  // 2026-08-28 비용 리포트 item 8/T1-4 와 같은 원칙(scpOutboxMailWorkers.ts): 이 정책 문서는
  // 스캔 대상이 있을 때만 읽는다. 이 스텝은 processVideoSubmissionRemindersSchedule(3분)에
  // 피기백돼 매 틱 돈다 — 빈 스캔에도 무조건 읽으면 1 read/틱이 영구히 나간다(T1-4 와 동일 절약).
  if (snapshot.empty) return result;
  const policy = await readResubmissionCyclePolicy();

  for (const doc of snapshot.docs) {
    result.scanned += 1;
    const row = doc.data() ?? {};
    const rejectedAtIso = asString(row.rejectedAtIso);
    const deadlineAtIso = asString(row.deadlineAtIso);
    if (!rejectedAtIso || !deadlineAtIso) continue;
    const nudgesSent = Math.max(0, Math.trunc(Number(row.nudgesSent ?? 0)));

    // 기한 초과 + 독려 소진(또는 애초에 정책 disabled) → churned. 독려 계산보다 먼저 본다 —
    // 둘은 서로 배타적이다(videoResubmissionCycleCore.ts 헤더 참고). 이 판정은 이 스윕이 조회한
    // 스냅샷(과거 시점) 기준이라 값싼 사전 필터일 뿐이다 — 실제 쓰기는 아래 트랜잭션이 한다.
    if (planResubmissionCycleChurn({
      status: "awaiting_resubmission",
      deadlineAtIso,
      nudgesSentCount: nudgesSent,
      policyMaxNudges: policy.maxNudges,
      nowIso,
    })) {
      // [코덱스 라운드7] 위 판정은 스캔 스냅샷 기준이라, 그 사이 다른 트랜잭션(재제출 등)이
      // 상태를 이미 바꿨을 수 있다 — 그대로 덮어쓰면 방금 resubmitted 된 사이클을 도로 churned
      // 로 되돌려 지표를 오염시킨다. 트랜잭션으로 다시 읽어 **여전히** awaiting_resubmission
      // 이고 실제로 기한이 지났을 때만 churn 한다. 재확인에 걸리면(상태가 이미 바뀌었거나 기한
      // 판정이 달라졌으면) 이번 틱은 그냥 넘어간다 — 다음 스윕(3분 뒤)이 새 스냅샷으로 다시
      // 본다, 잃는 것이 없다.
      const churned = await adminDb.runTransaction(async (tx) => {
        const freshSnap = await tx.get(doc.ref);
        const freshData = freshSnap.data() ?? {};
        const freshStatus = asString(freshData.status) as ResubmissionCycleStatus;
        const freshDeadlineAtIso = asString(freshData.deadlineAtIso) || deadlineAtIso;
        const freshNudgesSent = Math.max(0, Math.trunc(Number(freshData.nudgesSent ?? nudgesSent)));
        if (!planResubmissionCycleChurn({
          status: freshStatus,
          deadlineAtIso: freshDeadlineAtIso,
          nudgesSentCount: freshNudgesSent,
          policyMaxNudges: policy.maxNudges,
          nowIso,
        })) {
          return false;
        }
        tx.set(doc.ref, {
          status: "churned", updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return true;
      });
      if (churned) result.churned += 1;
      continue;
    }

    const plan = planNextResubmissionNudgeOccurrence({
      rejectedAtIso,
      nudgesSent,
      policyEnabled: policy.enabled,
      policyMaxNudges: policy.maxNudges,
      policyNudgeIntervalDays: policy.nudgeIntervalDays,
      deadlineAtIso,
      nowIso,
    });
    if (!plan) continue;

    const occurrenceId = resubmissionNudgeOccurrenceId(doc.id, plan.nudgeSeq);
    // [코덱스 라운드6] 이 회차가 드레인에서 이미 기한초과로 취소된 적이 있으면(미루면 기한을
    // 넘겨 발송을 포기한 경우, resubmissionNudgeMail.ts §2) 다시 만들려 하지 않는다 — create()
    // 는 기존 문서를 만나면 ALREADY_EXISTS 로 안전하게 실패하지만, 이 사이클의 실제 기한
    // (deadlineAtIso)이 지나 위 churn 판정이 닫을 때까지 매 스윕(3분)마다 헛된 쓰기 시도가
    // 반복된다. 미리 걸러 그 반복을 없앤다.
    const existingOccurrence = await adminDb
      .collection(SCP_RESUBMISSION_NUDGE_MAIL_OUTBOX_COLLECTION)
      .doc(occurrenceId)
      .get();
    if (existingOccurrence.exists) {
      const existingData = existingOccurrence.data() ?? {};
      if (
        asString(existingData.deliveryState) === "cancelled" &&
        asString(existingData.cancelledReason) === "deadline_exceeded"
      ) {
        continue;
      }
    }
    try {
      // create 로 적재 — 같은 회차가 두 번 스캔돼도(스케줄 겹침) 키가 중복을 막는다
      // (W86-B 형제 아웃박스와 같은 규율).
      await adminDb.collection(SCP_RESUBMISSION_NUDGE_MAIL_OUTBOX_COLLECTION).doc(occurrenceId).create({
        cycleDocId: doc.id,
        submissionId: asString(row.submissionId),
        applicationId: asString(row.applicationId),
        cycleSeq: Number(row.cycleSeq ?? 0),
        nudgeSeq: plan.nudgeSeq,
        reasonCode: asString(row.reasonCode, "other_documented"),
        deadlineAtIso,
        deliveryState: "queued",
        attempts: 0,
        createdAtIso: nowIso,
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      });
      result.enqueued += 1;
    } catch {
      // ALREADY_EXISTS — 이 회차는 이미 적재됨(정상, 이중 적재 아님).
    }
  }
  return result;
}

// ---- §2 drain: occurrence 발송 (발송 직전 사이클 재검사 포함) --------------------------------------

export type DrainResubmissionNudgeOutboxOptions = {
  batchLimit?: number;
  now?: Date;
  sendAdapter?: MailSendAdapter;
  recipientResolver?: RecipientResolver;
  lanePauseCheck?: (lane: "nudge") => Promise<boolean>;
  totalQuotaCheck?: typeof totalDailyQuotaAllows;
};

export type DrainResubmissionNudgeOutboxResult = {
  scanned: number;
  sent: number;
  cancelled: number;
  skipped: number;
  laneCapped: number;
  totalCapped: number;
  templateUnmapped: number;
  lanePaused: boolean;
  /** 같은 recipient 가 최근(20시간) 이미 독려를 받아 이번 발송을 미룸(비소모 — queued 유지). */
  deferred: number;
};

export async function drainResubmissionNudgeOutbox(
  options: DrainResubmissionNudgeOutboxOptions = {},
): Promise<DrainResubmissionNudgeOutboxResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const batchLimit = Math.min(Math.max(Math.trunc(options.batchLimit ?? 10), 1), 50);
  const sendAdapter = options.sendAdapter ?? defaultMailSendAdapter;
  const recipientResolver = options.recipientResolver ?? defaultRecipientResolver;
  const lanePauseCheck = options.lanePauseCheck ?? readMailLaneManualPause;
  const totalQuotaCheck = options.totalQuotaCheck ?? totalDailyQuotaAllows;
  const result: DrainResubmissionNudgeOutboxResult = {
    scanned: 0, sent: 0, cancelled: 0, skipped: 0, laneCapped: 0, totalCapped: 0, templateUnmapped: 0, lanePaused: false,
    deferred: 0,
  };
  // 이번 드레인 호출(한 패스) 안에서 이미 발송이 확정된 recipient — Firestore 조회 없이 즉시
  // 판정한다(같은 패스 안의 형제는 아직 "sent" 로 커밋되지 않았을 수 있어 쿼리만으로는 못 잡는다).
  const sentRecipientHashesThisPass = new Map<string, string>();

  // W118 클린스킵: 정지 중이면 조회조차 하지 않는다(코호트①③·② 드레인과 같은 규율).
  if (await lanePauseCheck("nudge")) {
    result.lanePaused = true;
    return result;
  }

  // [코덱스 라운드4] 기아(starvation) 방지 — 미룬(deferred) 행은 "queued" 가 아니라 별도
  // "deferred" 상태로 옮긴다. 그렇지 않으면 미룬 행이(오래된 createdAtIso 탓에) due-query 페이지
  // (batchLimit)를 계속 채워 정작 새로 도래한 다른 recipient 의 행을 밀어낸다. 리스가 지난
  // deferred 행만 여기서 "queued" 로 되돌린다 — 형제 레인의 stale-sending 리클레임과 같은 패턴
  // (scpOutboxMailWorkers.ts reclaimStaleSendingOutboxRows). 레거시 행(이 상태 자체가 없던 시절의
  // "queued" 행)은 애초에 "deferred" 로 옮겨진 적이 없으므로 이 승격 스텝과 무관하게 아래
  // due-query 로 그대로 드레인된다 — 백필이 필요 없다.
  const duePromotions = await adminDb
    .collection(SCP_RESUBMISSION_NUDGE_MAIL_OUTBOX_COLLECTION)
    .where("deliveryState", "==", "deferred")
    .where("deferredUntilIso", "<=", nowIso)
    .orderBy("deferredUntilIso", "asc")
    .limit(50)
    .get();
  await Promise.all(duePromotions.docs.map((promoted) => promoted.ref.set({
    deliveryState: "queued",
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })));

  const due = (await adminDb
    .collection(SCP_RESUBMISSION_NUDGE_MAIL_OUTBOX_COLLECTION)
    .where("deliveryState", "==", "queued")
    .orderBy("createdAtIso", "asc")
    .limit(batchLimit)
    .get()).docs;
  if (due.length === 0) return result;

  const laneConfig = await readNudgeLaneQuotaConfig(NUDGE_COHORT4_KEY);
  const totalDailyCap = await readNudgeTotalDailyCap();

  for (const doc of due) {
    result.scanned += 1;
    const row = doc.data() ?? {};
    const cycleDocId = asString(row.cycleDocId);
    const applicationId = asString(row.applicationId);
    if (!cycleDocId || !applicationId) { result.skipped += 1; continue; }

    // 레인 캡은 클레임 전에 본다(코호트2 드레인과 같은 순서) — 캡 초과면 조회만 하고 행은
    // queued 로 남겨 다음 주기에 다시 본다(독려 cadence 는 일 단위라 정밀한 유예 축이 불필요).
    const laneQuota = await laneDailyQuotaAllows(RESUBMISSION_NUDGE_MAIL_PURPOSE, laneConfig.dailyCap, now);
    if (!laneQuota.allowed) { result.laneCapped += 1; continue; }
    const totalQuota = await totalQuotaCheck(totalDailyCap, now);
    if (!totalQuota.allowed) { result.totalCapped += 1; continue; }

    // 배치 중간 정지 재확인(TOCTOU) — 코호트2 드레인과 같은 규율.
    if (await lanePauseCheck("nudge")) { result.lanePaused = true; break; }

    // 클레임 + **발송 직전 재검사(F-6 요구)** — 한 트랜잭션에서 같이 본다: 이 사이클이 더 이상
    // awaiting_resubmission 이 아니면(재제출·승인·재반려·기한종결 어느 쪽이든) 발송을 취소한다.
    const cycleRef = adminDb.collection(VIDEO_RESUBMISSION_CYCLE_COLLECTION).doc(cycleDocId);
    const claim = await adminDb.runTransaction(async (tx) => {
      const [outboxSnap, cycleSnap] = await Promise.all([
        tx.get(doc.ref),
        tx.get(cycleRef),
      ]);
      if (!outboxSnap.exists || asString(outboxSnap.data()?.deliveryState) !== "queued") {
        return { outcome: "already_claimed" as const };
      }
      const cycleStatus = asString(cycleSnap.data()?.status);
      if (cycleStatus !== "awaiting_resubmission") {
        tx.set(doc.ref, {
          deliveryState: "cancelled",
          cancelledReason: cycleStatus || "cycle_missing",
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return { outcome: "cancelled" as const };
      }
      // [코덱스 라운드4] 클레임 시점에도 기한을 다시 본다 — 이 행이(레인캡·recipient 미룸 등으로)
      // 오래 대기하다 사이클은 아직 awaiting_resubmission 인데 자기 기한만 지났을 수 있다. 만료된
      // 독려를 보내지 않는다 — 이 레인이 이미 쓰는 만료 종결 상태(취소)를 그대로 재사용한다.
      // [코덱스 라운드5] 행만 취소하고 사이클을 그대로 두면 nudgesSent 가 못 늘어(발송이 없으니)
      // enqueue 스윕의 churn 조건(nudgesSent>=maxNudges)이 영원히 안 걸려 사이클이 열린 채로
      // 갇힌다 — 이 레인이 기한 종료에 이미 쓰는 사이클 상태("churned")로 같은 트랜잭션에서
      // 직접 닫는다(cycleSnap 을 이미 이 트랜잭션에서 읽었으므로 여전히 awaiting_resubmission
      // 임이 보장된다).
      const rowDeadlineAtIso = asString(outboxSnap.data()?.deadlineAtIso);
      if (rowDeadlineAtIso && Date.parse(rowDeadlineAtIso) <= now.getTime()) {
        tx.set(doc.ref, {
          deliveryState: "cancelled",
          cancelledReason: "deadline_exceeded",
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        tx.set(cycleRef, {
          status: "churned",
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return { outcome: "cancelled" as const };
      }
      tx.set(doc.ref, {
        deliveryState: "sending", updatedAtIso: nowIso, updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { outcome: "claimed" as const };
    });
    if (claim.outcome === "already_claimed") { result.skipped += 1; continue; }
    if (claim.outcome === "cancelled") { result.cancelled += 1; continue; }

    const reasonCode = asString(row.reasonCode, "other_documented");
    const deadlineAtIso = asString(row.deadlineAtIso);
    const templateValues: Record<string, string> = {
      reason_message: videoReviewReasonCodeNudgePhrase(reasonCode),
      deadline: formatResubmissionDeadline(deadlineAtIso),
      portal_link: SCP_CREATOR_PORTAL_LINK,
      program_name: "Super Creator Partners",
      supercent_brand: "Super Creator Partners",
    };
    // 발행 문서가 없으면 보내지 않는다(코드 폴백 없음 — "draft copy" 요구사항: 운영자가 편집기에서
    // 문안을 발행해야 실제로 나간다). 비소모 유예 — 다음 주기에 그대로 재시도된다.
    const rendered = await resolveNudgeSequenceTemplateByKey(
      RESUBMISSION_NUDGE_TEMPLATE_KIND,
      RESUBMISSION_NUDGE_TEMPLATE_KIND,
      templateValues,
    );
    if (!rendered) {
      await doc.ref.set({
        deliveryState: "queued",
        lastErrorCode: "resubmission_nudge_template_unmapped",
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      result.templateUnmapped += 1;
      continue;
    }

    const recipient = await recipientResolver({ applicationId, kind: RESUBMISSION_NUDGE_MAIL_PURPOSE });
    if (!recipient?.email) {
      await doc.ref.set({
        deliveryState: "queued",
        attempts: FieldValue.increment(1),
        lastErrorCode: "recipient_unresolved",
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      result.skipped += 1;
      continue;
    }
    const recipientHash = recipientHashFor(recipient.email);

    // 발송 직전 recipient 축 최소 안전장치 — 같은 recipient 가 최근(20시간) 이미 확정 발송을
    // 받았으면 이번 건은 미룬다. 같은 패스 안의 형제는 in-memory 맵으로(Firestore 커밋을 기다릴
    // 필요 없음), 이전 패스의 형제는 단일 색인 조회(recipientHash ==, deliveryState ==,
    // sentAtIso >=)로 잡는다. recipientHash 가 없는(이 수리 이전) 과거 sent 행은 조회에 안 걸려
    // "모른다"로 취급된다 — 그 자체가 배포 전환일의 유일한 예외이며 차단 사유는 아니다.
    const sentInThisPassAtIso = sentRecipientHashesThisPass.get(recipientHash);
    let deferUntilIso: string | null = sentInThisPassAtIso
      ? new Date(Date.parse(sentInThisPassAtIso) + RECIPIENT_SEND_GAP_MS).toISOString()
      : null;
    if (!deferUntilIso) {
      const cutoffIso = new Date(now.getTime() - RECIPIENT_SEND_GAP_MS).toISOString();
      const recentSent = await adminDb
        .collection(SCP_RESUBMISSION_NUDGE_MAIL_OUTBOX_COLLECTION)
        .where("recipientHash", "==", recipientHash)
        .where("deliveryState", "==", "sent")
        .where("sentAtIso", ">=", cutoffIso)
        .orderBy("sentAtIso", "desc")
        .limit(1)
        .get();
      if (!recentSent.empty) {
        const lastSentAtIso = asString(recentSent.docs[0].data()?.sentAtIso);
        deferUntilIso = lastSentAtIso
          ? new Date(Date.parse(lastSentAtIso) + RECIPIENT_SEND_GAP_MS).toISOString()
          : null;
      }
    }
    if (deferUntilIso) {
      // [코덱스 라운드4] 미루는 순간이 이 사이클의 기한을 넘기면, 미뤄봐야 다시 볼 기회가
      // 영영 없다 — 미루는 대신 이 occurrence 만 지금 만료로 종결한다(이 레인이 이미 쓰는 만료
      // 상태(취소)를 그대로 재사용한다).
      // [코덱스 라운드6] 사이클은 여기서 건드리지 않는다(라운드5 되돌림) — "이 nudgeSeq 를 더
      // 못 보낸다"는 창작자가 실제로 재제출할 수 있는 기한(deadlineAtIso)이 지났다는 뜻이
      // 아니다. 여기서 조기에 churn 하면 지표를 오염시키고 아직 재제출 가능한 창작자를
      // 화면에서 숨긴다. 사이클은 실제 기한이 지나야 enqueue 스윕의 churn 판정
      // (planResubmissionCycleChurn, videoResubmissionCycleCore.ts)이 닫는다 — 그 판정은
      // 이제 독려 소진 여부와 무관하게 기한만 본다(같은 파일 라운드6 주석 참고), 그래서
      // nudgesSent 가 못 늘어도 사이클이 갇히지 않는다.
      if (deadlineAtIso && Date.parse(deferUntilIso) > Date.parse(deadlineAtIso)) {
        await doc.ref.set({
          deliveryState: "cancelled",
          cancelledReason: "deadline_exceeded",
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        result.cancelled += 1;
        continue;
      }
      await doc.ref.set({
        deliveryState: "deferred",
        deferredUntilIso: deferUntilIso,
        lastErrorCode: "resubmission_nudge_recipient_recent_send",
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      result.deferred += 1;
      continue;
    }

    const message: OutboundMailMessage = {
      to: recipient.email,
      subject: rendered.subject,
      text: rendered.text,
      ...(rendered.bodyFormat === "text" ? {} : { html: rendered.htmlSource || rendered.html }),
      trackingId: doc.id,
      draftRef: `resubmission-nudge-outbox-${doc.id}`,
      approvalRef: `resubmission-nudge-outbox-${doc.id}-approval`,
      mailPurpose: RESUBMISSION_NUDGE_MAIL_PURPOSE,
      templateKind: RESUBMISSION_NUDGE_TEMPLATE_KIND,
      mailType: RESUBMISSION_NUDGE_MAIL_PURPOSE,
      gameId: "scp-automation",
      sourceRef: doc.ref.path,
      conversationId: `resubmission-nudge-${applicationId}`,
      applicationId,
      fenceApplicationId: applicationId,
    };

    const sendResult = await sendAdapter(message);
    if (sendResult.sent) {
      await Promise.all([
        doc.ref.set({
          deliveryState: "sent",
          sentAtIso: nowIso,
          recipientHash,
          providerMessageId: sendResult.providerMessageId ?? null,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }),
        adminDb.collection(VIDEO_RESUBMISSION_CYCLE_COLLECTION).doc(cycleDocId).set({
          nudgesSent: FieldValue.increment(1),
          lastNudgeAtIso: nowIso,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }),
      ]);
      sentRecipientHashesThisPass.set(recipientHash, nowIso);
      result.sent += 1;
      continue;
    }
    // 비소모 스킵(레인 정지·GA 미개방·SMTP 미설정)은 시도를 소모하지 않는다 — 코호트2 드레인의
    // isNonConsumingSendSkipReason 과 같은 판정을 여기서도 재현한다(그 함수를 직접 재사용하면
    // scpOutboxMailWorkers 의 내부 어댑터 실패 코드 접두사에 결합되므로 판정만 복제, 접두사는 동일).
    const reason = asString(sendResult.reason);
    const nonConsuming = reason === "provider_unconfigured"
      || reason.startsWith("pilot_fence_denied")
      || reason.startsWith("lane_paused:");
    await doc.ref.set({
      deliveryState: "queued",
      ...(nonConsuming ? {} : { attempts: FieldValue.increment(1) }),
      lastErrorCode: reason.slice(0, 160),
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    result.skipped += 1;
  }
  return result;
}
