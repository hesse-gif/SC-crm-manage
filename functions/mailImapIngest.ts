import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import type { DocumentData, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { simpleParser, type HeaderValue, type ParsedMail } from "mailparser";
import { adminDb } from "./firebaseAdmin";
import { expireAt180DaysFromTimestamp } from "./firestoreTtl";
import { receiveEmail } from "./chat-ai";
import { recordBounceFromEmail } from "./mailBounce";
import { readImapLatestLiveForAccount as defaultReadImapLatestLiveForAccount, type LiveInboundEmail } from "./mailImapLive";
import {
  readMailAccounts,
  readMailRouting,
  resolveMailAccountForEmail,
  type MailAccount,
  type MailAccountKind,
  type MailRouting,
} from "./mailAccounts";
import {
  resolveImapBatchSize,
  resolveImapCursorGapAlertThreshold,
  resolveImapMaxRunSeconds,
  resolveImapRunLimit,
} from "./mailImapThroughput";
import {
  safeMailDocId,
} from "./mailSafetyShared";
import { extractQuotedOriginalRecipientEmail } from "./mailQuotedReplyAttribution";
import { normalizeInboundRoutingFlags, routingFlagsFromHeaderMap } from "./mailInboundRoute";
import { asRecord, asString } from "./shared";

export type ImapIngestOptions = {
  readonly limit?: number;
  readonly source?: string;
};

// PLAN-ORG-MAIL-IDENTITY Slice 4 — test-only seam (mirrors setMailAccountsDbForTests in
// functions/mailAccounts.ts / setMailOAuthFetchForTests in functions/mailOAuth.ts). Live IMAP
// scanning is unconditionally gated off in the emulator/test environment (liveIntegrationsEnabled
// returns false whenever FUNCTIONS_EMULATOR==="true"), so the ONLY way to exercise the
// per-account iteration loop (multiple accounts, per-account failure isolation, per-account
// cursor source) against the real Firestore emulator — without a real IMAP server — is to
// inject a fake per-account mail reader here.
let readImapLatestLiveForAccountOverrideForTests: typeof defaultReadImapLatestLiveForAccount | null = null;
export function setReadImapLatestLiveForAccountForTests(
  fn: typeof defaultReadImapLatestLiveForAccount | null,
): void {
  readImapLatestLiveForAccountOverrideForTests = fn;
}
function resolveReadImapLatestLiveForAccount(): typeof defaultReadImapLatestLiveForAccount {
  return readImapLatestLiveForAccountOverrideForTests ?? defaultReadImapLatestLiveForAccount;
}

export type ImapIngestResult = {
  readonly ok: boolean;
  readonly runId: string;
  readonly fetched: number;
  readonly matched: number;
  readonly bounced: number;
  readonly ignored: number;
  readonly quarantined: number;
  readonly errors: number;
  // W76-A: 라이브 메일박스가 "빈 성공"을 보고한 순간의 커서 격차(mailboxUidNext-1 - cursor.lastUid).
  // 정상이면 0 — 양수인데 ok:true면 커서가 오염되어 있는 메일을 못 보는 상태다(관측 가능해야 한다).
  readonly cursorUidGap?: number;
  // W76-M: 위 값은 UIDNEXT-1 기준 **상한 추정치**다(지운 메일도 세어 과대 보고된다).
  //   실제 판정은 이 값 — 빈 성공 순간 커서 위에 존재하던 미처리 UID 수 — 으로 한다.
  readonly unseenUidCount?: number;
  // 격차가 설정 임계(기본 0)를 초과해 이번 run이 그 이유로 ok:false로 승격됐는지.
  readonly cursorGapAlert?: boolean;
  // PLAN-ORG-MAIL-IDENTITY Slice 4: per-account breakdown of the live scan above (scp first,
  // then every other active IMAP-capable account) — one account's auth/OAuth failure never
  // stops the others; its outcome is recorded here instead.
  readonly perAccount?: readonly PerAccountImapIngestOutcome[];
};

export type PerAccountImapIngestOutcome = {
  readonly mailAccountId: string;
  readonly source: string;
  readonly ok: boolean;
  readonly fetched: number;
  readonly matched: number;
  readonly bounced: number;
  readonly ignored: number;
  readonly quarantined: number;
  readonly errors: number;
  readonly cursorUidGap?: number;
  readonly unseenUidCount?: number;
  readonly failureCode?: string;
};

type MailOutcome = "matched" | "bounced" | "ignored" | "quarantined" | "unmatched";
type InboundFailureStage = "imap_fetch" | "parse" | "bounce_classification" | "route_persist" | "cursor" | "unknown";
type SafeInboundFailureEvidence = {
  failureStage: InboundFailureStage;
  failureCode: string;
  failureRuleId: string;
  failureReason: string;
  errorCode: string;
  correlationIdHash: string;
};

class InboundProcessingError extends Error {
  readonly inboundStage: InboundFailureStage;
  readonly privateCause: unknown;

  constructor(stage: InboundFailureStage, cause: unknown) {
    super(`mail inbound ${stage} failed`);
    this.name = "InboundProcessingError";
    this.inboundStage = stage;
    this.privateCause = cause;
  }
}

async function atInboundStage<T>(stage: InboundFailureStage, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw error instanceof InboundProcessingError ? error : new InboundProcessingError(stage, error);
  }
}

function privateInboundErrorText(error: unknown): string {
  const source = error instanceof InboundProcessingError ? error.privateCause : error;
  if (!source || typeof source !== "object") return String(source ?? "unknown");
  const row = source as Record<string, unknown>;
  return [row.name, row.code, row.message]
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map(String)
    .join(" ") || "unknown";
}

function safeInboundFailureEvidence(error: unknown, scope: string, fallbackStage: InboundFailureStage = "unknown"): SafeInboundFailureEvidence {
  const stage = error instanceof InboundProcessingError ? error.inboundStage : fallbackStage;
  const code = `mail_inbound_${stage}_failed`;
  return {
    failureStage: stage,
    failureCode: code,
    failureRuleId: `mail-inbound.${stage}-failed`,
    failureReason: "받은 메일 처리 중 내부 단계가 실패했습니다. 운영자가 해당 단계를 확인해야 합니다.",
    errorCode: code,
    correlationIdHash: createHash("sha256")
      .update(`${scope}\u0000${privateInboundErrorText(error)}`)
      .digest("hex")
      .slice(0, 24),
  };
}

// Decide the run-log outcome from a receiveEmail response. "matched" counts ONLY
// allowChat creator replies (the inbound reached Chat). Gated noise becomes "ignored",
// quarantined senders become "quarantined".
function outcomeFromReceiveResponse(record: Record<string, unknown>): MailOutcome {
  const allowChat = record.allowChat === true;
  const messageRef = asString(record.messageRef, "");
  const route = asString(record.route, "");
  // A non-Chat route verdict wins over an outbound match: a quarantined/blocked outbound-match conflict must not be
  // counted as matched (that hid quarantines and inflated matches).
  if (allowChat) return messageRef ? "matched" : "unmatched";
  if (route === "unknown_quarantine") return "quarantined";
  if (route) return "ignored";
  if (asString(record.matchedOutboundRef, "")) return messageRef ? "matched" : "unmatched";
  return messageRef ? "matched" : "unmatched";
}

// RT-1/A1 (poison head-of-line): 라이브 스캔 중 같은 UID가 이 횟수를 초과해 실패하면 자동 skip이
// 아니라 데드레터+커서 전진(원자적)으로 넘어간다. settings.email.imap.poisonMaxRetries로 조정 가능.
const DEFAULT_IMAP_POISON_MAX_RETRIES = 3;

type ImapThroughput = {
  readonly batchSize: number;
  readonly maxRunSeconds: number;
  readonly poisonMaxRetries: number;
  readonly cursorGapAlertThreshold: number;
};

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

async function readImapThroughput(): Promise<ImapThroughput> {
  const settings = (await adminDb.doc("settings/default").get()).data() ?? {};
  const imap = asRecord(asRecord(settings.email).imap);
  return {
    batchSize: resolveImapBatchSize(imap.batchSize),
    maxRunSeconds: resolveImapMaxRunSeconds(imap.maxRunSeconds),
    poisonMaxRetries: positiveInt(imap.poisonMaxRetries, DEFAULT_IMAP_POISON_MAX_RETRIES),
    cursorGapAlertThreshold: resolveImapCursorGapAlertThreshold(imap.cursorGapAlertThreshold),
  };
}

type QueuedMail = {
  readonly id: string;
  readonly refPath: string;
  readonly data: Record<string, unknown>;
};

export type LiveMail = Extract<LiveInboundEmail, { readonly empty: false }>;

function numericUid(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function rawMailSource(data: Record<string, unknown>): string {
  return asString(data.raw, asString(data.source, asString(data.rfc822, "")));
}

function headerString(value: HeaderValue | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)?.trim() ?? "";
  }
  if (value instanceof Date) return value.toISOString();
  const record = asRecord(value);
  return asString(record.value, "");
}

function headerMessageIds(value: HeaderValue | undefined): string[] {
  const raw = headerString(value);
  if (!raw) return [];
  return raw.split(/\s+/).map((item) => item.replace(/[<>]/g, "").trim()).filter(Boolean);
}

function normalizeParsedBody(parsed: ParsedMail): string {
  const html = typeof parsed.html === "string"
    ? parsed.html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ")
    : "";
  return asString(parsed.text, html)
    .replace(/\u0000/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 20000);
}

function normalizeMessageId(value: unknown): string {
  return asString(value, "").replace(/[<>]/g, "").trim();
}

function addressObjectText(value: ParsedMail["to"]): string {
  if (Array.isArray(value)) return value.map((item) => item.text).filter(Boolean).join(", ");
  return value?.text ?? "";
}

async function normalizeQueuedMailData(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = rawMailSource(data);
  if (!raw) return data;
  const parsed = await simpleParser(Buffer.from(raw, "utf8"));
  const body = normalizeParsedBody(parsed) || raw;
  const messageId = normalizeMessageId(parsed.messageId);
  const trackingId = headerString(parsed.headers.get("x-flu-tracking-id"));
  const inReplyTo = normalizeMessageId(headerString(parsed.headers.get("in-reply-to")));
  const references = headerMessageIds(parsed.headers.get("references"));
  const receivedAtIso = parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime())
    ? parsed.date.toISOString()
    : asString(data.receivedAtIso, asString(data.createdAtIso, new Date().toISOString()));
  return {
    ...data,
    raw,
    subject: asString(data.subject, asString(parsed.subject, "Inbound creator email")),
    hasInboundAttachments: parsed.attachments.length > 0,
    from: asString(data.from, parsed.from?.value?.[0]?.address ?? ""),
    to: asString(data.to, addressObjectText(parsed.to)),
    body: asString(data.body, asString(data.text, body)),
    text: asString(data.text, body),
    signal: asString(data.signal, [asString(parsed.subject, ""), body].filter(Boolean).join(" | ").slice(0, 1200)),
    receivedAtIso,
    providerMessageId: asString(data.providerMessageId, messageId),
    messageRef: asString(data.messageRef, messageId ? `messageid/${messageId}` : ""),
    trackingId: asString(data.trackingId, trackingId),
    replyHeaders: {
      ...asRecord(data.replyHeaders),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references.length > 0 ? { references } : {}),
    },
    // classification_v1: the queue path parses the raw RFC822 itself — same minimal routing flags as the
    // live IMAP path (never the raw header block). A pre-existing flag set on the queue doc is kept.
    ...(() => {
      const flags = normalizeInboundRoutingFlags(routingFlagsFromHeaderMap(parsed.headers))
        ?? normalizeInboundRoutingFlags(data.routingHeaders);
      return flags ? { routingHeaders: flags } : {};
    })(),
    // conv_13ioeao (2026-09-27): this queue path never strips the quoted-reply block out of
    // `body`, so the raw parsed body is where the quoted header block still lives.
    quotedOriginalRecipientEmail: asString(
      data.quotedOriginalRecipientEmail,
      extractQuotedOriginalRecipientEmail(body) ?? "",
    ),
    // 이 큐 경로는 인용 이력을 잘라 내지 않는다(원문 본문 그대로) — 허용목록이 인용을 그대로 본다.
    quotedHistoryStripped: false,
  };
}

function queuedMailFromDoc(doc: QueryDocumentSnapshot<DocumentData>): QueuedMail {
  return { id: doc.id, refPath: doc.ref.path, data: doc.data() ?? {} };
}

function cursorDocId(source: string, data: Record<string, unknown>): string {
  const mailbox = asString(data.mailbox, "INBOX");
  const user = asString(data.user, asString(data.accountEmail, "default"));
  return safeMailDocId("mail_cursor", `${source}:${user}:${mailbox}`);
}

async function advanceCursor(source: string, mail: QueuedMail, messageRef: string, nowIso: string): Promise<boolean> {
  const uid = numericUid(mail.data.uid);
  if (uid <= 0) return false;
  const uidValidity = asString(mail.data.uidValidity, "");
  const ref = adminDb.collection("mail_ingest_cursors").doc(cursorDocId(source, mail.data));
  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.data() ?? {};
    const currentUidValidity = asString(current.uidValidity, "");
    const currentUid = currentUidValidity === uidValidity ? numericUid(current.lastUid) : 0;
    if (uid <= currentUid) return;
    transaction.set(ref, {
      source,
      mailbox: asString(mail.data.mailbox, "INBOX"),
      user: asString(mail.data.user, asString(mail.data.accountEmail, "default")),
      uidValidity,
      lastUid: uid,
      lastMessageRef: messageRef,
      updatedAtIso: nowIso,
    }, { merge: true });
  });
  return true;
}

async function markQueuedMailProcessed(mail: QueuedMail, patch: Record<string, unknown>): Promise<void> {
  await adminDb.doc(mail.refPath).set({
    ...patch,
    status: "processed",
    processedAtIso: new Date().toISOString(),
    failureKind: FieldValue.delete(),
    failureRuleId: FieldValue.delete(),
    failureReason: FieldValue.delete(),
    errorCode: FieldValue.delete(),
    correlationIdHash: FieldValue.delete(),
    error: FieldValue.delete(),
    errorText: FieldValue.delete(),
    errorMessage: FieldValue.delete(),
    lastError: FieldValue.delete(),
    failureStack: FieldValue.delete(),
    stack: FieldValue.delete(),
  }, { merge: true });
}

async function markQueuedMailError(mail: QueuedMail, error: unknown, runId: string): Promise<void> {
  const evidence = safeInboundFailureEvidence(error, `imap-ingest.queue:${runId}:${mail.refPath}`, "route_persist");
  await adminDb.doc(mail.refPath).set({
    status: "error",
    runId,
    ...evidence,
    error: FieldValue.delete(),
    errorText: FieldValue.delete(),
    errorMessage: FieldValue.delete(),
    lastError: FieldValue.delete(),
    failureStack: FieldValue.delete(),
    stack: FieldValue.delete(),
    errorAtIso: new Date().toISOString(),
  }, { merge: true });
}

export function liveMailData(
  inbound: LiveMail,
  runId: string,
  source: string,
  orgId: string | null,
  // Flu/Task-47: the ingesting account's kind (mail_accounts/{id}.kind) — chat-ai.ts's
  // persistReceivedEmail uses it to decide whether this message's From address needs a
  // candidate_pool registration check at all (canonical_scp mail stays fully unstamped).
  accountKind: MailAccountKind,
): Record<string, unknown> {
  return {
    // W76-③: 종전에는 `dryRun:true` + `draftOnly:true` 를 못 박아 **설정과 무관하게** 모든
    //   인입 회신이 초안으로만 남았다(자동 안내가 구조적으로 불가). 그런데 워커가 dryRun 을
    //   켠 진짜 이유는 "게이트웨이/IMAP 가 죽어도 관측을 계속한다"는 목 폴백 하나였다.
    //   그 축만 분리해 가져간다 — dryRun 의 절대 경계(설정 무관 발송 금지)는 그대로 둔다.
    //   승격 판정은 receiveEmail 이 한다: eval 명시 auto_reply + 라이브 분류 + 설정 ON.
    allowMockGatewayFallback: true,
    imapIngestPayload: true,
    skipLiveImapRead: true,
    ingestRunId: runId,
    ingestSource: source,
    trackingId: inbound.trackingId,
    messageRef: inbound.messageRef,
    providerMessageId: inbound.providerMessageId ?? "",
    from: inbound.fromNormalized ?? inbound.fromMasked ?? "",
    to: "",
    subject: inbound.subject,
    body: inbound.body ?? inbound.signal,
    text: inbound.body ?? inbound.signal,
    signal: inbound.signal,
    ...(typeof inbound.hasAttachments === "boolean" ? { hasInboundAttachments: inbound.hasAttachments } : {}),
    receivedAtIso: inbound.receivedAtIso,
    replyHeaders: inbound.replyHeaders,
    ...(inbound.routingHeaders ? { routingHeaders: inbound.routingHeaders } : {}),
    quotedOriginalRecipientEmail: inbound.quotedOriginalRecipientEmail ?? "",
    ...(typeof inbound.quotedHistoryStripped === "boolean" ? { quotedHistoryStripped: inbound.quotedHistoryStripped } : {}),
    ingestImap: inbound.imap,
    // PLAN-ORG-MAIL-IDENTITY Slice 4: which mail_accounts/{accountId} this message came in
    // through, and the org (resolved once per account per run, not per message) chat-ai.ts
    // stamps onto conversations/{id} + the message doc.
    mailAccountId: inbound.mailAccountId,
    accountMailbox: inbound.accountMailbox,
    mailAccountKind: accountKind,
    ...(orgId ? { orgId } : {}),
  };
}

export async function readInboundDefaultOwnerFields(): Promise<Record<string, unknown>> {
  const settings = (await adminDb.doc("settings/email").get()).data() ?? {};
  const ownerUid = asString(settings.inboundDefaultOwnerUid, "");
  if (!ownerUid) return {};
  const ownerEmail = asString(settings.inboundDefaultOwnerEmail, "");
  const ownerName = asString(settings.inboundDefaultOwnerName, "");
  const ownerRole = asString(settings.inboundDefaultOwnerRole, "manager");
  return {
    ownerUid,
    createdBy: ownerUid,
    createdByRole: ownerRole,
    ...(ownerEmail ? { ownerEmail, createdByEmail: ownerEmail } : {}),
    ...(ownerName ? { ownerName } : {}),
  };
}

export function withInboundDefaultOwner(
  data: Record<string, unknown>,
  ownerFields: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(ownerFields).length === 0) return data;
  return { ...ownerFields, ...data };
}

async function advanceLiveCursor(inbound: LiveMail, messageRef: string, nowIso: string): Promise<void> {
  if (!inbound.imap.cursorAdvanceAllowed) return;
  await adminDb.collection("mail_ingest_cursors").doc(inbound.imap.cursorDocId).set({
    uidValidity: inbound.imap.uidValidity,
    lastUid: inbound.imap.uid,
    mailbox: inbound.imap.mailbox,
    user: inbound.imap.user,
    updatedAtIso: nowIso,
    lastMessageRef: messageRef,
  }, { merge: true });
}

function liveErrorDocId(source: string, mailbox: string, uidValidity: string, uid: number): string {
  // NOTE: stable key WITHOUT runId (unlike the old per-run doc id) — this doc is the
  // per-message poison counter across runs, and (Q9/RT-1) the rescan source once
  // status transitions to "dead_letter".
  return safeMailDocId("mail_ingest_error", `${source}:${mailbox}:${uidValidity}:${uid}`);
}

export type LiveMailFailureOutcome = {
  readonly deadLettered: boolean;
  readonly failureCount: number;
  readonly errorRefPath: string;
};

// RT-1/A1 (poison head-of-line, BLOCKER): a live-mailbox scan processes the lowest
// unseen UID first and stops the whole run on the first exception without advancing
// the cursor — so a single unprocessable message retries forever and blocks every
// later message. Track failures per (source, mailbox, uidValidity, uid) across runs;
// once the count exceeds poisonMaxRetries, atomically (a) preserve UID/uidValidity +
// a sanitized payload in the SAME `mail_ingest_errors` doc (promoted to the rescan
// source, never auto-deleted — Q9) and (b) advance the cursor past this UID, in one
// transaction so the cursor can never move without the dead-letter record existing.
export async function recordLiveMailFailureAndMaybeDeadLetter(
  inbound: LiveMail,
  source: string,
  runId: string,
  error: unknown,
  poisonMaxRetries: number,
): Promise<LiveMailFailureOutcome> {
  const errorRef = adminDb.collection("mail_ingest_errors").doc(
    liveErrorDocId(source, inbound.imap.mailbox, inbound.imap.uidValidity, inbound.imap.uid),
  );
  const evidence = safeInboundFailureEvidence(
    error,
    `imap-ingest.live:${source}:${inbound.imap.mailbox}:${inbound.imap.uidValidity}:${inbound.imap.uid}`,
    "route_persist",
  );
  const nowIso = new Date().toISOString();
  const maxRetries = Math.max(1, poisonMaxRetries);
  const outcome = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(errorRef);
    const previous = snapshot.data() ?? {};
    const failureCount = (typeof previous.failureCount === "number" ? previous.failureCount : 0) + 1;
    const deadLettered = failureCount >= maxRetries;
    transaction.set(errorRef, {
      runId,
      source,
      mailbox: inbound.imap.mailbox,
      uid: inbound.imap.uid,
      uidValidity: inbound.imap.uidValidity,
      messageRef: inbound.messageRef,
      trackingId: inbound.trackingId,
      ...evidence,
      error: FieldValue.delete(),
      errorText: FieldValue.delete(),
      errorMessage: FieldValue.delete(),
      lastError: FieldValue.delete(),
      failureStack: FieldValue.delete(),
      stack: FieldValue.delete(),
      failureCount,
      firstFailedAtIso: asString(previous.firstFailedAtIso, nowIso),
      lastFailedAtIso: nowIso,
      status: deadLettered ? "dead_letter" : "retry_pending",
      createdAtIso: asString(previous.createdAtIso, nowIso),
      ...(deadLettered
        ? {
          deadLetterAtIso: nowIso,
          // Operator-visible ack flag — no automatic deletion/expiry (Q9: preserve, don't purge).
          deadLetterAcknowledged: false,
          // sanitized payload only (SEC-P0-009) — no raw RFC822 retained, PII-minimized default.
          payload: {
            subject: inbound.subject,
            fromMasked: inbound.fromMasked,
            signal: inbound.signal,
            receivedAtIso: inbound.receivedAtIso,
            providerMessageId: inbound.providerMessageId ?? null,
            replyHeaders: inbound.replyHeaders,
          },
        }
        : {}),
    }, { merge: true });
    if (deadLettered) {
      // Cursor advance and dead-letter preservation happen in the SAME transaction —
      // the cursor can never move past this UID unless the dead-letter record exists.
      transaction.set(adminDb.collection("mail_ingest_cursors").doc(inbound.imap.cursorDocId), {
        source,
        uidValidity: inbound.imap.uidValidity,
        lastUid: inbound.imap.uid,
        mailbox: inbound.imap.mailbox,
        user: inbound.imap.user,
        updatedAtIso: nowIso,
        lastMessageRef: inbound.messageRef,
        lastAdvanceReason: "poison_dead_letter",
      }, { merge: true });
    }
    return { deadLettered, failureCount };
  });
  return { ...outcome, errorRefPath: errorRef.path };
}

async function processOneLiveMail(
  inbound: LiveMail,
  source: string,
  orgId: string | null,
  runId: string,
  accountKind: MailAccountKind,
): Promise<MailOutcome> {
  const mailData = withInboundDefaultOwner(liveMailData(inbound, runId, source, orgId, accountKind), await readInboundDefaultOwnerFields());
  const bounce = await atInboundStage("bounce_classification", () => recordBounceFromEmail(mailData));
  const nowIso = new Date().toISOString();
  if (bounce.bounced) {
    await atInboundStage("cursor", () => advanceLiveCursor(inbound, bounce.sourceRef ?? inbound.messageRef, nowIso));
    return "bounced";
  }
  const response = await atInboundStage("route_persist", () => receiveEmail({
    // R1-P1-6: 서버 소유 표식(allowMockGatewayFallback·imapIngestPayload)은 공개 콜러블
    //   입구에서 strip 된다. 이 워커는 내부 호출임을 명시해야 그 축을 세울 수 있다.
    internalTrustedInvocation: true,
    auth: { uid: "mail-ingest-worker", token: { role: "admin", team: "system", email: "mail-ingest@supercent.io" } },
    data: mailData,
    rawRequest: { ip: "127.0.0.1" },
  }));
  const record = asRecord(response);
  const messageRef = asString(record.messageRef, "");
  // Gated noise is still fully processed (route recorded) — advance the cursor so it is
  // not re-fetched. Use the inbound messageRef when the gate produced no Chat messageRef.
  await atInboundStage("cursor", () => advanceLiveCursor(inbound, messageRef || inbound.messageRef, nowIso));
  return outcomeFromReceiveResponse(record);
}

// PLAN-ORG-MAIL-IDENTITY Slice 4: scans ONE account's mailbox. `limit` and `deadlineMs` are a
// budget SHARED across every account in this run (computed once by the caller) — not a
// per-account allowance — so adding more active accounts never multiplies a single run's
// worst-case IMAP round-trips or wall-clock time past what one mailbox always used.
async function syncLiveMailboxForAccount(
  account: MailAccount,
  source: string,
  orgId: string | null,
  runId: string,
  limit: number,
  deadlineMs: number,
  poisonMaxRetries: number,
): Promise<Pick<ImapIngestResult, "fetched" | "matched" | "bounced" | "ignored" | "quarantined" | "errors" | "cursorUidGap" | "unseenUidCount">> {
  let fetched = 0;
  let matched = 0;
  let bounced = 0;
  let ignored = 0;
  let quarantined = 0;
  let errors = 0;
  // W76-A: last cursor-vs-mailbox gap observed from an `{empty:true}` read. Stays undefined when
  // the loop never hits an empty read (limit/deadline exhausted first) — nothing to report yet.
  let cursorUidGap: number | undefined;
  // W76-M: 빈 성공 순간 커서 위에 **실제로 존재하던** 미처리 UID 수(검색 결과 기준).
  //   지운 메일은 여기 안 잡히므로 UIDNEXT 추정과 달리 오경보가 나지 않는다.
  let unseenUidCount: number | undefined;
  for (let index = 0; index < limit; index += 1) {
    // Stop fetching new mail once the run-time budget is spent; cursor-safe because
    // raw-persist/route already advanced the cursor for every mail processed so far.
    if (Date.now() >= deadlineMs) break;
    const inbound = await atInboundStage("imap_fetch", () => resolveReadImapLatestLiveForAccount()(account, { imapMaxScan: 100 }));
    if (!inbound) break;
    if (inbound.empty) {
      cursorUidGap = inbound.cursorUidGap ?? 0;
      // W76-M: 판정은 실제 미처리 UID 수로 한다(아래 syncLiveMailboxForAccount 반환에 실어 보낸다).
      unseenUidCount = inbound.unseenUidCount;
      break;
    }
    fetched += 1;
    try {
      const outcome = await processOneLiveMail(inbound, source, orgId, runId, account.kind);
      if (outcome === "matched") matched += 1;
      if (outcome === "bounced") bounced += 1;
      if (outcome === "ignored") ignored += 1;
      if (outcome === "quarantined") quarantined += 1;
    } catch (error) {
      errors += 1;
      const failure = await recordLiveMailFailureAndMaybeDeadLetter(inbound, source, runId, error, poisonMaxRetries);
      // Still within the retry budget: stop this run without advancing the cursor so
      // the next scheduled run retries the SAME UID (head-of-line, unchanged today).
      // Once dead-lettered, the cursor already advanced atomically above — keep
      // draining the rest of this run's budget instead of stopping early.
      if (!failure.deadLettered) break;
    }
  }
  return { fetched, matched, bounced, ignored, quarantined, errors, cursorUidGap, unseenUidCount };
}

// scp accounts for org routing implicitly (the pre-Slice-4 default); a self-linked
// workspace_oauth account's own ownerEmail resolves back to itself (source "user_linked",
// orgId null — mailAccounts.ts's own documented precedence: a self-connected mailbox is
// tied to the PERSON, not one org), so in practice this falls through to the routing lookup
// below for every kind today. Kept as resolveMailAccountForEmail (not a duplicated Peoply
// call) so any future change to that precedence is picked up here for free.
async function resolveOrgIdForAccount(account: MailAccount, routing: MailRouting): Promise<string | null> {
  if (account.kind === "workspace_oauth" && account.ownerEmail) {
    try {
      const resolved = await resolveMailAccountForEmail(account.ownerEmail);
      if (resolved.orgId) return resolved.orgId;
    } catch {
      // fail-open — Peoply errors already resolve to a fallback inside resolveMailAccountForEmail;
      // this catch only guards against something else going wrong, and falls through below.
    }
  }
  for (const [orgId, mappedAccountId] of Object.entries(routing.byOrgId)) {
    if (mappedAccountId === account.accountId) return orgId;
  }
  return null;
}

// scp always polls first (today's sole mailbox, so it keeps the same effective priority it
// always had under the shared per-run budget); the rest keep readMailAccounts()' existing
// alphabetical order.
function orderAccountsScpFirst(accounts: readonly MailAccount[]): MailAccount[] {
  const scp = accounts.find((account) => account.accountId === "scp");
  const others = accounts.filter((account) => account.accountId !== "scp");
  return scp ? [scp, ...others] : [...others];
}

async function processOneQueuedMail(mail: QueuedMail, source: string, runId: string): Promise<MailOutcome> {
  const mailData = withInboundDefaultOwner(await atInboundStage("parse", () => normalizeQueuedMailData(mail.data)), await readInboundDefaultOwnerFields());
  const normalizedMail = { ...mail, data: mailData };
  const bounce = await atInboundStage("bounce_classification", () => recordBounceFromEmail(mailData));
  const nowIso = new Date().toISOString();
  if (bounce.bounced) {
    await markQueuedMailProcessed(mail, {
      runId,
      source,
      bounceClassification: bounce.classification,
      matchedSourceRef: bounce.sourceRef ?? "",
    });
    await advanceCursor(source, normalizedMail, bounce.sourceRef ?? mail.refPath, nowIso);
    return "bounced";
  }
  const payload = {
    ...mailData,
    // W76-③: 큐 경로도 라이브 경로와 **같은 축**을 쓴다(판정이 갈리면 화면과 발송이 어긋난다).
    //   dryRun 은 `...mailData` 로 이미 그대로 넘어간다 — R1-P2-2: 조건부 spread 는 no-op 이었다.
    //   워커가 필요한 목 폴백만 별도 축으로 준다.
    allowMockGatewayFallback: true,
    imapIngestPayload: true,
    skipLiveImapRead: true,
    ingestRunId: runId,
    ingestSource: source,
    ingestImap: {
      mailbox: asString(mailData.mailbox, "INBOX"),
      user: asString(mailData.user, asString(mailData.accountEmail, "default")),
      uid: numericUid(mailData.uid),
      uidValidity: asString(mailData.uidValidity, ""),
      cursorDocId: cursorDocId(source, mailData),
    },
  };
  const response = await atInboundStage("route_persist", () => receiveEmail({
    // R1-P1-6: 서버 소유 표식(allowMockGatewayFallback·imapIngestPayload)은 공개 콜러블
    //   입구에서 strip 된다. 이 워커는 내부 호출임을 명시해야 그 축을 세울 수 있다.
    internalTrustedInvocation: true,
    auth: { uid: "mail-ingest-worker", token: { role: "admin", team: "system", email: "mail-ingest@supercent.io" } },
    data: payload,
    rawRequest: { ip: "127.0.0.1" },
  }));
  const record = asRecord(response);
  const messageRef = asString(record.messageRef, "");
  const route = asString(record.route, "");
  await markQueuedMailProcessed(mail, {
    runId,
    source,
    messageRef,
    conversationRef: asString(record.conversationRef, ""),
    queueState: asString(record.queueState, ""),
    ...(route ? { route, allowChat: record.allowChat === true } : {}),
  });
  // Route-gated noise has no Chat messageRef; advance the cursor anyway so it is not
  // re-fetched (raw is already persisted/routed before the cursor advances).
  await atInboundStage("cursor", () => advanceCursor(source, normalizedMail, messageRef || mail.refPath, nowIso));
  return outcomeFromReceiveResponse(record);
}

export async function processImapIngestQueue(options: ImapIngestOptions = {}): Promise<ImapIngestResult> {
  const source = asString(options.source, "imap");
  const throughput = await readImapThroughput();
  const limit = resolveImapRunLimit(options.limit, throughput.batchSize);
  const runId = safeMailDocId("mail_ingest_run", `${source}:${Date.now()}:${Math.random()}`);
  const runRef = adminDb.collection("mail_ingest_runs").doc(runId);
  const startedAt = Timestamp.now();
  const startedAtIso = startedAt.toDate().toISOString();
  await runRef.set({
    runId,
    source,
    status: "running",
    startedAtIso,
    createdAt: startedAt,
    expireAt: expireAt180DaysFromTimestamp(startedAt),
  }, { merge: true });
  let fetched = 0;
  let matched = 0;
  let bounced = 0;
  let ignored = 0;
  let quarantined = 0;
  let errors = 0;
  let runFailureEvidence: SafeInboundFailureEvidence | null = null;
  let liveFetched = 0;
  let cursorUidGap: number | undefined;
  // W76-M: 경보 판정에 쓰는 실제 미처리 UID 수(검색 결과 기준).
  let unseenUidCount: number | undefined;
  const perAccount: PerAccountImapIngestOutcome[] = [];
  if (source !== "queued") {
    // PLAN-ORG-MAIL-IDENTITY Slice 4: poll every ACTIVE, IMAP-capable mail account (scp first,
    // matching its pre-Slice-4 sole-mailbox priority) instead of only the synthesized scp
    // mailbox. `limit`/deadlineMs below are a budget SHARED across every account in this run —
    // not a per-account allowance — so this stays bounded the same way a single mailbox always
    // was, regardless of how many accounts get connected.
    let accounts: MailAccount[] = [];
    let routing: MailRouting | null = null;
    try {
      [accounts, routing] = await Promise.all([readMailAccounts(), readMailRouting()]);
    } catch (error) {
      errors += 1;
      runFailureEvidence ??= safeInboundFailureEvidence(error, `imap-ingest.run:${runId}:accounts`, "imap_fetch");
    }
    const activeAccounts = orderAccountsScpFirst(accounts.filter((account) => account.status === "active"));
    const deadlineMs = Date.now() + Math.max(1, throughput.maxRunSeconds) * 1000;
    let remainingBudget = limit;
    for (const account of activeAccounts) {
      if (remainingBudget <= 0 || Date.now() >= deadlineMs) break;
      const accountSource = account.accountId === "scp" ? "imap" : `imap:${account.accountId}`;
      const orgId = routing ? await resolveOrgIdForAccount(account, routing) : null;
      try {
        const live = await syncLiveMailboxForAccount(account, accountSource, orgId, runId, remainingBudget, deadlineMs, throughput.poisonMaxRetries);
        remainingBudget -= live.fetched;
        liveFetched += live.fetched;
        fetched += live.fetched;
        matched += live.matched;
        bounced += live.bounced;
        ignored += live.ignored;
        quarantined += live.quarantined;
        errors += live.errors;
        if (live.cursorUidGap !== undefined) cursorUidGap = Math.max(cursorUidGap ?? 0, live.cursorUidGap);
        if (live.unseenUidCount !== undefined) unseenUidCount = Math.max(unseenUidCount ?? 0, live.unseenUidCount);
        perAccount.push({
          mailAccountId: account.accountId,
          source: accountSource,
          ok: live.errors === 0,
          fetched: live.fetched,
          matched: live.matched,
          bounced: live.bounced,
          ignored: live.ignored,
          quarantined: live.quarantined,
          errors: live.errors,
          ...(live.cursorUidGap !== undefined ? { cursorUidGap: live.cursorUidGap } : {}),
          ...(live.unseenUidCount !== undefined ? { unseenUidCount: live.unseenUidCount } : {}),
        });
      } catch (error) {
        // One account's auth/OAuth/connection failure must never stop the others.
        errors += 1;
        const evidence = safeInboundFailureEvidence(error, `imap-ingest.run:${runId}:live:${account.accountId}`, "imap_fetch");
        runFailureEvidence ??= evidence;
        perAccount.push({
          mailAccountId: account.accountId,
          source: accountSource,
          ok: false,
          fetched: 0,
          matched: 0,
          bounced: 0,
          ignored: 0,
          quarantined: 0,
          errors: 1,
          failureCode: evidence.failureCode,
        });
      }
    }
  }
  // W76-A: a "빈 성공"(ok:true, fetched:0) must not hide a poisoned cursor. If the mailbox holds
  // more UIDs than the cursor has consumed at the moment a scan reports empty, something is wrong
  // (cursor corruption, uidValidity rollover, etc.) — surface it and escalate to ok:false so the
  // dashboard's "수신 처리 실패" banner cannot stay silent while replies pile up unseen.
  //
  // W76-M(보수화): 판정축을 UIDNEXT-1 추정에서 **실제 검색 결과**(unseenUidCount)로 옮겼다.
  //   UIDNEXT 는 메일을 지워도 계속 오르므로 `uidNext-1 - lastUid` 는 정상적으로 비운
  //   메일박스에서도 영원히 양수다. 그걸로 ok:false 를 승격하면 인입이 멀쩡한데 경보가 안 꺼지고,
  //   그 상태에서는 재개 게이트가 영구 차단된다(운영이 경보를 무시하기 시작하는 쪽이 더 위험하다).
  //   실제 미처리 UID 수는 지운 메일을 세지 않으면서 커서 오염은 그대로 잡는다.
  //   unseenUidCount 를 못 얻은 구형 경로에서는 종전처럼 cursorUidGap 으로 판정한다(fail-closed 유지).
  const gapSignal = unseenUidCount ?? cursorUidGap;
  const cursorGapAlert = gapSignal !== undefined && gapSignal > throughput.cursorGapAlertThreshold;
  if (cursorGapAlert) {
    runFailureEvidence ??= {
      failureStage: "imap_fetch",
      failureCode: "mail_inbound_cursor_uid_gap_exceeded",
      failureRuleId: "mail-inbound.cursor-uid-gap-exceeded",
      failureReason: `빈 성공으로 보고됐지만 커서 위에 미처리 메일 ${gapSignal}건이 실제로 존재합니다. 커서 오염 여부를 확인하세요.`,
      errorCode: "mail_inbound_cursor_uid_gap_exceeded",
      correlationIdHash: createHash("sha256").update(`imap-ingest.cursor-gap:${runId}:${gapSignal}`).digest("hex").slice(0, 24),
    };
  }
  // `batchSize` is one run-wide ceiling, not one allowance for the live mailbox
  // plus another allowance for the queued fallback.
  const remaining = Math.max(0, limit - liveFetched);
  const snapshot = remaining > 0
    ? await adminDb.collection("mail_ingest_queue").where("status", "==", "queued").limit(remaining).get()
    : null;
  const mails = (snapshot?.docs ?? [])
    .map(queuedMailFromDoc)
    .sort((left, right) => {
      const byMailbox = asString(left.data.mailbox, "").localeCompare(asString(right.data.mailbox, ""));
      return byMailbox === 0 ? numericUid(left.data.uid) - numericUid(right.data.uid) : byMailbox;
    });
  fetched += mails.length;
  for (const mail of mails) {
    try {
      const outcome = await processOneQueuedMail(mail, source, runId);
      if (outcome === "matched") matched += 1;
      if (outcome === "bounced") bounced += 1;
      if (outcome === "ignored") ignored += 1;
      if (outcome === "quarantined") quarantined += 1;
    } catch (error) {
      errors += 1;
      runFailureEvidence ??= safeInboundFailureEvidence(error, `imap-ingest.run:${runId}:queue`, "route_persist");
      await markQueuedMailError(mail, error, runId);
    }
  }
  const result = {
    ok: errors === 0 && !cursorGapAlert,
    runId,
    fetched,
    matched,
    bounced,
    ignored,
    quarantined,
    errors,
    ...(cursorUidGap !== undefined ? { cursorUidGap } : {}),
    // W76-M: 판정에 쓴 실제 미처리 UID 수를 원장에 남긴다 — 경보가 왜 켜졌는지(혹은 왜 안 켜졌는지)
    //   나중에 UIDNEXT 추정값과 나란히 놓고 볼 수 있어야 한다.
    ...(unseenUidCount !== undefined ? { unseenUidCount } : {}),
    ...(cursorGapAlert ? { cursorGapAlert } : {}),
    ...(perAccount.length > 0 ? { perAccount } : {}),
  };
  await runRef.set({
    ...result,
    status: result.ok ? "ok" : "error",
    finishedAtIso: new Date().toISOString(),
    ...(runFailureEvidence ?? {}),
    error: FieldValue.delete(),
    errorText: FieldValue.delete(),
    errorMessage: FieldValue.delete(),
    lastError: FieldValue.delete(),
    failureStack: FieldValue.delete(),
    stack: FieldValue.delete(),
  }, { merge: true });
  return result;
}
