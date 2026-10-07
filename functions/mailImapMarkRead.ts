// Flu 2026-09-26 [헤세 · "실제 Gmail에도 읽음 표시"] — scp 사서함으로 들어온 인바운드 메일을
// Flu가 실제로 "처리"한 시점(자동응답 발송 성공 / 사람이 챗 컴포저에서 수동 답장 발송 성공)에
// 그 원본 IMAP 메시지에 \Seen 플래그를 세운다. 사람이 직접 답장해야 하는 메일은 계속 안읽음으로
// 남아야 한다 — 이 모듈은 "발송이 실제로 확정된" 호출부에서만 불린다(functions/chat-ai.ts
// sendAutoReplyJob 의 confirmedSent, sendEmailInternal 의 providerConfirmed).
//
// 설계(스펙 그대로):
//   - 발송 경로(sendAutoReplyJob/sendEmailInternal)는 IMAP 연결을 직접 열지 않는다 — 저렴한
//     Firestore 문서 하나만 이 아웃박스(imap_mark_read_outbox)에 적재한다.
//   - 실제 IMAP STORE 는 기존 processImapIngestQueue 의 1분 스케줄(functions/index.ts)이 자신의
//     정규 인입 스윕 직후 이 아웃박스를 드레인하면서 수행한다 — 같은 IMAP_PASSWORD 시크릿,
//     새 Cloud Function/스케줄러 없음.
//   - 플래그를 세우는 데 필요한 uid/uidValidity/mailbox 는 인입 시점에 이미
//     message_sources/{id}.imap 에 저장돼 있다(chat-ai.ts persistReceivedEmail, 이 기능이
//     추가한 것이 아니라 기존 필드를 읽기만 한다).
//   - best-effort: 실패는 로그만 남기고 발송을 절대 막지 않는다. scp 사서함 전용 — hesse@ 등
//     다른 계정은 절대 건드리지 않는다(호출부가 mailAccountId==="scp" 확인 후에만 큐잉한다).
import { ImapFlow } from "imapflow";
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";
import {
  getRuntimeIntegration,
  liveIntegrationsEnabled,
  publicBoolean,
  publicNumber,
  publicString,
  requireEnvSecret,
} from "./liveIntegrations";
import { isValidImapMailboxFolder, safeImapMailboxName } from "./mailImapConfiguration";

export const IMAP_MARK_READ_OUTBOX_COLLECTION = "imap_mark_read_outbox";
const DRAIN_LIMIT = 25;
const MAX_ATTEMPTS = 5;
// scp 전용 기능 — 다른 mailAccountId 는 절대 큐잉하지 않는다(enqueueImapMarkRead 재확인 + 호출부
// 자체 게이트, 이중 방어).
const ELIGIBLE_MAIL_ACCOUNT_ID = "scp";

export type ImapMarkReadReason = "auto_reply_sent" | "human_reply_sent" | "dismissed_no_reply";

export type EnqueueImapMarkReadInput = {
  readonly mailAccountId: unknown;
  readonly mailbox: unknown;
  readonly uid: unknown;
  readonly uidValidity: unknown;
  readonly conversationId?: unknown;
  readonly sourceRef?: unknown;
  readonly reason: ImapMarkReadReason;
};

/** scp 사서함 인바운드에만 참이다 — hesse@ 등 다른 계정 메시지는 절대 큐잉 대상이 아니다. */
export function isImapMarkReadEligible(mailAccountId: unknown): boolean {
  return asString(mailAccountId) === ELIGIBLE_MAIL_ACCOUNT_ID;
}

function positiveInt(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : 0;
}

/**
 * 발송 경로에서 부른다 — IMAP 을 열지 않고 아웃박스 문서 하나만 적재한다. 실패해도 절대 throw
 * 하지 않는다(발송 자체는 이미 끝난 뒤라 여기서 막을 게 없다 — 있는 그대로 로그만 남긴다).
 */
export async function enqueueImapMarkRead(input: EnqueueImapMarkReadInput): Promise<void> {
  try {
    if (!isImapMarkReadEligible(input.mailAccountId)) return;
    const mailbox = asString(input.mailbox);
    if (!isValidImapMailboxFolder(mailbox)) return;
    const uid = positiveInt(input.uid);
    if (!uid) return;
    const uidValidity = asString(input.uidValidity);
    if (!uidValidity) return;
    await adminDb.collection(IMAP_MARK_READ_OUTBOX_COLLECTION).add({
      mailAccountId: ELIGIBLE_MAIL_ACCOUNT_ID,
      mailbox: safeImapMailboxName(mailbox),
      uid,
      uidValidity,
      conversationId: asString(input.conversationId) || null,
      sourceRef: asString(input.sourceRef) || null,
      reason: input.reason,
      status: "pending",
      attempts: 0,
      createdAtIso: new Date().toISOString(),
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "imap_mark_read.enqueue_failed",
      reason: input.reason,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

type MarkReadImapFlowLike = {
  connect(): Promise<unknown>;
  logout(): Promise<unknown>;
  mailboxOpen(mailbox: string, options?: Record<string, unknown>): Promise<{ uidValidity: unknown }>;
  messageFlagsAdd(range: string, flags: string[], options?: Record<string, unknown>): Promise<boolean>;
};

export type CreateMarkReadImapFlowClientFn = (options: Record<string, unknown>) => MarkReadImapFlowLike;

function defaultCreateMarkReadImapFlowClient(options: Record<string, unknown>): MarkReadImapFlowLike {
  return new ImapFlow(options as unknown as ConstructorParameters<typeof ImapFlow>[0]) as unknown as MarkReadImapFlowLike;
}

export type DrainImapMarkReadOutboxResult = {
  readonly processed: number;
  readonly marked: number;
  readonly failed: number;
  readonly skipped: number;
};

const EMPTY_DRAIN_RESULT: DrainImapMarkReadOutboxResult = { processed: 0, marked: 0, failed: 0, skipped: 0 };

/**
 * processImapIngestQueue 의 기존 1분 스케줄이 정규 인입 스윕 직후 부른다(functions/index.ts).
 * scp 계정 IMAP_PASSWORD 로만 연결한다 — 다른 계정 자격증명은 이 함수가 아예 모른다.
 */
export async function drainImapMarkReadOutbox(
  deps: { readonly createClient?: CreateMarkReadImapFlowClientFn } = {},
): Promise<DrainImapMarkReadOutboxResult> {
  if (!liveIntegrationsEnabled("imap")) return EMPTY_DRAIN_RESULT;
  const snapshot = await adminDb
    .collection(IMAP_MARK_READ_OUTBOX_COLLECTION)
    .where("status", "==", "pending")
    .orderBy("createdAtIso", "asc")
    .limit(DRAIN_LIMIT)
    .get();
  if (snapshot.empty) return EMPTY_DRAIN_RESULT;

  const config = await getRuntimeIntegration("mailImap");
  const host = publicString(config, "host", "IMAP_HOST", "");
  const port = publicNumber(config, "port", "IMAP_PORT", 993);
  const secure = publicBoolean(config, "secure", "IMAP_SECURE", port === 993);
  const user = publicString(config, "username", "IMAP_USER", "");
  if (!host || !user) {
    console.error(JSON.stringify({ event: "imap_mark_read.drain_skipped_config_missing" }));
    return { processed: 0, marked: 0, failed: 0, skipped: snapshot.size };
  }
  let pass: string;
  try {
    pass = requireEnvSecret("IMAP_PASSWORD", "IMAP");
  } catch (error) {
    console.error(JSON.stringify({
      event: "imap_mark_read.drain_skipped_secret_missing",
      message: error instanceof Error ? error.message : String(error),
    }));
    return { processed: 0, marked: 0, failed: 0, skipped: snapshot.size };
  }

  const byMailbox = new Map<string, QueryDocumentSnapshot[]>();
  let skipped = 0;
  for (const doc of snapshot.docs) {
    const record = asRecord(doc.data());
    // scp 전용 재확인 — 아웃박스 문서는 enqueueImapMarkRead 에서만 만들어져 이미 scp 로
    // 고정돼 있지만, 드레인 자체도 다른 값을 절대 신뢰하지 않는다(이중 방어).
    if (asString(record.mailAccountId) !== ELIGIBLE_MAIL_ACCOUNT_ID) {
      await doc.ref.set({ status: "skipped", skippedReason: "not_scp_mailbox" }, { merge: true });
      skipped += 1;
      continue;
    }
    const mailbox = asString(record.mailbox);
    if (!mailbox) {
      await doc.ref.set({ status: "failed", failedReason: "missing_mailbox" }, { merge: true });
      skipped += 1;
      continue;
    }
    const list = byMailbox.get(mailbox) ?? [];
    list.push(doc);
    byMailbox.set(mailbox, list);
  }

  const createClient = deps.createClient ?? defaultCreateMarkReadImapFlowClient;
  let marked = 0;
  let failed = 0;
  for (const [mailbox, docs] of byMailbox) {
    let client: MarkReadImapFlowLike;
    try {
      client = createClient({
        host,
        port,
        secure,
        auth: { user, pass },
        logger: false,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
      await client.connect();
    } catch (error) {
      // 연결 자체가 실패하면 이 mailbox 그룹 전부 pending 으로 남겨 다음 1분 스케줄에서
      // 재시도한다(attempts 를 소모하지 않는다 — 일시적 IMAP 장애는 자연 치유된다).
      console.error(JSON.stringify({
        event: "imap_mark_read.connect_failed",
        mailbox,
        message: error instanceof Error ? error.message : String(error),
      }));
      skipped += docs.length;
      continue;
    }
    try {
      const opened = await client.mailboxOpen(mailbox, { readOnly: false });
      const liveUidValidity = String(opened.uidValidity);
      for (const doc of docs) {
        const record = asRecord(doc.data());
        const uid = positiveInt(record.uid);
        const attempts = positiveInt(record.attempts);
        if (!uid) {
          await doc.ref.set({ status: "failed", failedReason: "invalid_uid" }, { merge: true });
          failed += 1;
          continue;
        }
        if (asString(record.uidValidity) !== liveUidValidity) {
          // 메일박스 UID 넘버링이 리셋됐다 — 이 uid 는 더 이상 같은 메시지를 가리키지 않을 수
          // 있으므로 플래그를 세우지 않고 스킵한다(잘못된 메시지를 읽음 처리하는 것보다 안전).
          await doc.ref.set({ status: "skipped", skippedReason: "uid_validity_mismatch" }, { merge: true });
          skipped += 1;
          continue;
        }
        try {
          // messageFlagsAdd 는 실패를 항상 throw 하는 게 아니라 false 를 반환할 수도 있다
          // (imapflow) — false 를 성공으로 기록하면 실제로는 플래그가 안 세워졌는데도 "done"으로
          // 남아 다시 시도되지 않는다(Codex 적대 리뷰 MEDIUM 수리).
          const flagged = await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
          if (!flagged) throw new Error("messageFlagsAdd returned false");
          await doc.ref.set({ status: "done", doneAtIso: new Date().toISOString() }, { merge: true });
          marked += 1;
        } catch (flagError) {
          const nextAttempts = attempts + 1;
          const giveUp = nextAttempts >= MAX_ATTEMPTS;
          await doc.ref.set(
            {
              attempts: nextAttempts,
              status: giveUp ? "failed" : "pending",
              lastErrorMessage: flagError instanceof Error ? flagError.message : String(flagError),
            },
            { merge: true },
          );
          failed += 1;
          console.error(JSON.stringify({
            event: "imap_mark_read.flag_failed",
            uid,
            attempts: nextAttempts,
            giveUp,
          }));
        }
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "imap_mark_read.mailbox_open_failed",
        mailbox,
        message: error instanceof Error ? error.message : String(error),
      }));
      skipped += docs.length;
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
  return { processed: snapshot.size, marked, failed, skipped };
}
