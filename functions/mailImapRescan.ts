import { adminDb } from "./firebaseAdmin";
import { receiveEmail } from "./chat-ai";
import { fetchImapMessageByUid, readImapLatestLive, type LiveInboundEmail } from "./mailImapLive";
import { safeMailDocId } from "./mailSafetyShared";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";

// S2/P2 (RT-1/A1) — operator-triggered recovery for a poison-quarantined (dead-lettered)
// IMAP message. Two recovery keys are supported (Q9):
//  - trackingId: forwards to the existing targeted live scan (readImapLatestLive).
//  - uid + mailbox (+ uidValidity): the ONLY recovery path once the shared cursor has
//    already advanced past the UID (readImapLatestLive only searches forward from the
//    cursor) — fetches that exact message directly and never moves the cursor.
// Recovered mail re-enters through the same receiveEmail/persistReceivedEmail dedup
// path as normal ingestion (messageId/messageRef match) — re-running a rescan for an
// already-ingested message is a no-op duplicate, not a second Chat message.

const RESCAN_ROLES = ["super_admin", "admin", "manager"] as const;

type LiveMail = Extract<LiveInboundEmail, { readonly empty: false }>;

function cleanUid(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode: "invalid_argument_unauthorized" });
}

// Re-submits an already-fetched LiveMail through the standard receiveEmail dedup path
// (skipLiveImapRead so receiveEmail does not attempt its own live fetch — same contract
// as the scheduled ingest worker in mailImapIngest.ts).
export async function ingestRescannedMail(inbound: LiveMail, source: string): Promise<Record<string, unknown>> {
  const mailData = {
    dryRun: true,
    draftOnly: true,
    imapIngestPayload: true,
    skipLiveImapRead: true,
    ingestRunId: safeMailDocId("mail_rescan_run", `${source}:${Date.now()}:${Math.random()}`),
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
    receivedAtIso: inbound.receivedAtIso,
    replyHeaders: inbound.replyHeaders,
    ...(inbound.routingHeaders ? { routingHeaders: inbound.routingHeaders } : {}),
    quotedOriginalRecipientEmail: inbound.quotedOriginalRecipientEmail ?? "",
    ...(typeof inbound.quotedHistoryStripped === "boolean" ? { quotedHistoryStripped: inbound.quotedHistoryStripped } : {}),
    ingestImap: inbound.imap,
    // Same server-derived account stamp as the scheduled ingest worker (mailImapIngest.ts
    // liveMailData): without it a recovered message never gets the IMAP provenance marker and
    // the held-backlog sender-identity check (autoReplyBacklog.ts) can never pass for it.
    mailAccountId: inbound.mailAccountId,
    accountMailbox: inbound.accountMailbox,
  };
  const response = await receiveEmail({
    // R2-P2: 형제 경로(mailImapIngest)와 **같은 신뢰 축**을 명시한다. 지금은 이 경로가
    //   dryRun/draftOnly 를 못 박아 실피해가 0이지만, 그 못 박기를 정리하는 순간
    //   서버 소유 표식이 조용히 strip 되어 신뢰 축만 사라진다.
    internalTrustedInvocation: true,
    auth: { uid: "mail-rescan-worker", token: { role: "admin", team: "system", email: "mail-rescan@supercent.io" } },
    data: mailData,
    rawRequest: { ip: "127.0.0.1" },
  });
  return asRecord(response);
}

async function markDeadLetterRecovered(source: string, mailbox: string, uidValidity: string, uid: number, messageRef: string): Promise<void> {
  const key = safeMailDocId("mail_ingest_error", `${source}:${mailbox}:${uidValidity}:${uid}`);
  await adminDb.collection("mail_ingest_errors").doc(key).set({
    status: "recovered",
    recoveredAtIso: new Date().toISOString(),
    recoveredMessageRef: messageRef,
  }, { merge: true });
}

// Composite "ingest + mark dead-letter recovered" used by the uid-mode recovery branch
// below. Exported separately (independent of the live IMAP fetch step) so the
// ingest-and-dedup half of UID recovery is directly testable without a live mailbox.
export async function recoverDeadLetteredUidMail(inbound: LiveMail, source: string, uid: number): Promise<Record<string, unknown>> {
  const result = await ingestRescannedMail(inbound, source);
  const messageRef = asString(result.messageRef, inbound.messageRef);
  await markDeadLetterRecovered(source, inbound.imap.mailbox, inbound.imap.uidValidity, uid, messageRef);
  return result;
}

export async function rescanImapByTrackingId(request: CallableRequestShape) {
  const ctx = assertNonGuestAuth(request, "mail_ingest.rescan", RESCAN_ROLES);
  const data = asRecord(request.data);
  const source = asString(data.source, "imap");
  const trackingId = asString(data.trackingId, "");
  const uid = cleanUid(data.uid);
  const mailbox = asString(data.mailbox, "");
  const uidValidity = asString(data.uidValidity, "");

  if (!trackingId && uid <= 0) {
    throw invalidArgument("rescanImapByTrackingId requires either trackingId or uid+mailbox.");
  }
  if (uid > 0 && !mailbox) {
    throw invalidArgument("uid-based rescan requires mailbox.");
  }

  const recoveryMode: "trackingId" | "uid" = uid > 0 ? "uid" : "trackingId";
  const inbound = uid > 0
    ? await fetchImapMessageByUid({ mailbox, uid, uidValidity: uidValidity || undefined })
    : await readImapLatestLive({ expectedTrackingId: trackingId, imapMaxScan: 100 });

  if (!inbound || inbound.empty) {
    return {
      ok: true,
      found: false,
      recoveryMode,
      behaviorLog: makeBehaviorLog(ctx, `mail_ingest.rescan(${recoveryMode}:not_found)`, "success", ctx.gameId),
    };
  }

  const result = uid > 0
    ? await recoverDeadLetteredUidMail(inbound, source, uid)
    : await ingestRescannedMail(inbound, source);
  const messageRef = asString(result.messageRef, inbound.messageRef);

  return {
    ok: true,
    found: true,
    recoveryMode,
    duplicate: result.duplicate === true,
    messageRef,
    conversationRef: asString(result.conversationRef, ""),
    route: asString(result.route, ""),
    allowChat: result.allowChat === true,
    behaviorLog: makeBehaviorLog(ctx, `mail_ingest.rescan(${recoveryMode})`, "success", ctx.gameId),
  };
}
