import { ImapFlow } from "imapflow";
import { simpleParser, type HeaderValue, type ParsedMail } from "mailparser";
import type { DocumentData } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";
import { envSecret, getRuntimeIntegration, liveIntegrationsEnabled, publicBoolean, publicNumber, publicString, requireEnvSecret } from "./liveIntegrations";
import { isValidImapMailboxFolder, resolveImapMailbox, safeImapMailboxName } from "./mailImapConfiguration";
import { computeCursorUidGap, shouldAdvanceImapCursor } from "./mailImapCursor";
import { safeOutboundFailureEvidence } from "./mailSafetyShared";
import type { MailAccount } from "./mailAccounts";
import {
  getMailOAuthAccessToken as defaultGetMailOAuthAccessToken,
  MailOAuthError,
  type GetMailOAuthAccessTokenDeps,
} from "./mailOAuth";
import { requireTransportSecret, resolveExternalSecretEnvName } from "./mailTransport";
import { extractQuotedOriginalRecipientEmail } from "./mailQuotedReplyAttribution";
import {
  normalizeInboundRoutingFlags,
  routingFlagsFromHeaderMap,
  routingFlagsFromRawHeaderBlock,
  type InboundRoutingFlags,
} from "./mailInboundRoute";

// W76-A: 빈 성공(`{empty:true}`)이 "새 메일 없음"과 "커서 오염으로 있는 메일을 못 봄"을 구분하지
// 못하면 관측이 상태를 가린다. 그 격차를 실어 보내 호출부(processImapIngestQueue)가
// 임계 초과 시 ok:false로 승격할 수 있게 한다.
//
// W76-M(보수화): 격차 판정축을 **UIDNEXT-1 추정에서 실제 검색 결과로** 옮겼다.
//   UIDNEXT 는 "다음에 부여할 UID"라 메일을 지워도(expunge) 계속 오른다. 그래서
//   `uidNext-1 - cursor.lastUid` 는 **정상적으로 비운 메일박스에서도 영원히 양수**가 되고,
//   그 상태로 ok:false 를 승격하면 인입이 멀쩡한데도 경보가 꺼지지 않는다(재개 게이트가 영구 차단).
//   반대로 커서 오염은 `cursor.lastUid+1:*` 검색이 **실제로 UID 를 돌려주는데** 빈 성공을
//   보고하는 형상이라, 검색 결과 수(unseenUidCount)가 더 정확하고 더 강한 검출기다.
//   cursorUidGap 은 관측값으로 남기되 **상한 추정치**로만 취급한다.
export type LiveInboundEmail = {
  empty: true;
  cursorLastUid?: number;
  mailboxUidNext?: number;
  cursorUidGap?: number;
  unseenUidCount?: number;
  // PLAN-ORG-MAIL-IDENTITY Slice 4: which mail_accounts/{accountId} this scan ran against.
  mailAccountId?: string;
  accountMailbox?: string;
} | {
  empty: false;
  trackingId: string;
  messageRef: string;
  signal: string;
  // Optional because the raw-header parser fallback cannot reliably inspect MIME parts.
  // Unknown attachment state must stay unknown and fail closed at approval-status gates.
  hasAttachments?: boolean;
  fromMasked: string | null;
  // 회신-아웃바운드 From-주소 매칭용 정규화 발신 주소(서버 내부 전용, 클라 payload엔 fromMasked만 노출).
  fromNormalized: string | null;
  subject: string;
  body: string | null;
  receivedAtIso: string;
  providerMessageId?: string | null;
  replyHeaders: {
    inReplyTo: string | null;
    references: string[];
  };
  // classification_v1: minimal normalized notification/bulk header evidence (List-Unsubscribe / List-ID /
  // Precedence / Auto-Submitted) for receiveEmail's inbound routing — never a raw header dump. Absent when
  // none of the headers is present.
  routingHeaders?: InboundRoutingFlags;
  // conv_13ioeao (2026-09-27): the quoted original recipient (To/An) address parsed out of a
  // quoted-reply header block in the RAW body — set only when the quoted sender (From/Von) is
  // our canonical scp@ mailbox. See functions/mailQuotedReplyAttribution.ts.
  quotedOriginalRecipientEmail: string | null;
  // 파서 소유 표식: stripQuotedReply 가 인용/이력 줄을 한 줄이라도 제거했다. body 는 이미 잘려 있어 역제안 허용목록이
  // 인용을 볼 수 없으므로, 이 표식이 true 면 역제안 자동 승격을 막는다(인용 원문은 어디에도 싣지 않는다 — SEC-P0-009).
  quotedHistoryStripped?: boolean;
  dedupeKey: string;
  imap: {
    cursorDocId: string;
    uid: number;
    uidValidity: string;
    mailbox: string;
    user: string;
    cursorAdvanceAllowed: boolean;
  };
  // PLAN-ORG-MAIL-IDENTITY Slice 4: which mail_accounts/{accountId} ingested this message, and
  // that account's mailbox address — stamped by chat-ai.ts onto conversations/messages.
  mailAccountId: string;
  accountMailbox: string;
};

type CursorState = {
  readonly lastUid: number;
  readonly uidValidity: string;
};

export type ParsedEmailSource = {
  readonly subject: string;
  readonly from: string | null;
  readonly body: string | null;
  readonly hasAttachments?: boolean;
  readonly date: Date | null;
  readonly messageId: string | null;
  readonly trackingId: string | null;
  readonly inReplyTo: string | null;
  readonly references: string[];
  readonly quotedOriginalRecipientEmail: string | null;
  readonly quotedHistoryStripped?: boolean;
  readonly routingFlags?: InboundRoutingFlags | null;
};

function safeMailSourceId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 140);
  return normalized || "message";
}

function cleanNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

// PLAN-ORG-MAIL-IDENTITY Slice 4: `source` distinguishes the scp mailbox ("imap", unchanged —
// byte-identical cursor doc id to pre-Slice-4) from other accounts ("imap:<accountId>") so
// concurrent per-account scans never collide on the same cursor document.
function cursorDocument(source: string, user: string, mailbox: string) {
  return adminDb.collection("mail_ingest_cursors").doc(safeMailSourceId(`${source}:${user}:${mailbox}`));
}

function readCursorState(data: DocumentData | undefined, currentUidValidity: string): CursorState {
  const record = asRecord(data);
  const storedUidValidity = asString(record.uidValidity, "");
  return {
    lastUid: storedUidValidity === currentUidValidity ? cleanNumber(record.lastUid, 0) : 0,
    uidValidity: currentUidValidity,
  };
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

function normalizeEmailMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[<>]/g, "").trim();
  return normalized.length > 0 ? normalized : null;
}

function dateFromUnknown(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function stripQuotedReplyWithFlag(value: string): { text: string; stripped: boolean } {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  let stripped = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      /^>/.test(trimmed)
      || /^On .+wrote:$/i.test(trimmed)
      || /^20\d{2}년 .+작성:$/i.test(trimmed)
      || /^-{2,}\s*Original Message\s*-{2,}$/i.test(trimmed)
      || /^(From|Sent|To|Subject):\s/i.test(trimmed)
    ) {
      stripped = true;
      break;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), stripped };
}

function normalizeParsedEmailBodyWithFlag(value: string): { body: string; quotedHistoryStripped: boolean } {
  const { text, stripped } = stripQuotedReplyWithFlag(value);
  const cleaned = text
    .replace(/\u0000/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { body: cleaned.length > 20000 ? `${cleaned.slice(0, 20000)}\n\n[truncated]` : cleaned, quotedHistoryStripped: stripped };
}

function headerString(value: HeaderValue | undefined): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const first = value.find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    return first?.trim() ?? null;
  }
  if (value instanceof Date) return value.toISOString();
  const record = asRecord(value);
  return asString(record.value, "") || null;
}

function headerMessageIds(value: HeaderValue | undefined): string[] {
  const raw = headerString(value);
  if (!raw) return [];
  return raw.split(/\s+/).map(normalizeEmailMessageId).filter((item): item is string => item !== null);
}

// PLAN-ORG-MAIL-IDENTITY Slice 4: for a non-scp account, prefix with the accountId so the same
// message seen in two different mailboxes (e.g. forwarded/CC'd into both scp and a personal
// workspace_oauth mailbox) never collides on the same message_sources/messageRef dedupe key.
// scp keeps the exact pre-Slice-4 ref shape (no prefix) — byte-identical dedup behavior.
function stableInboundMessageRef(args: { readonly messageId: string | null; readonly mailbox: string; readonly uidValidity: string; readonly uid: number; readonly mailAccountId: string }): string {
  const base = args.messageId ? `messageid/${args.messageId}` : `imap/${args.mailbox}/${args.uidValidity}/${args.uid}`;
  return args.mailAccountId && args.mailAccountId !== "scp" ? `${args.mailAccountId}/${base}` : base;
}

export type LiveMailMeta = {
  readonly mailbox: string;
  readonly uidValidity: string;
  readonly uid: number;
  readonly user: string;
  readonly cursorDocId: string;
  readonly cursorAdvanceAllowed: boolean;
  readonly internalDate?: unknown;
  readonly mailAccountId: string;
  readonly accountMailbox: string;
};

// Shared "parsed email + IMAP position" -> LiveInboundEmail builder, reused by both the
// forward-scanning readImapLatestLive loop and the explicit-UID rescan fetch below.
export function liveInboundFromParsed(parsed: ParsedEmailSource, meta: LiveMailMeta): Extract<LiveInboundEmail, { empty: false }> {
  const body = parsed.body ?? "";
  const messageRef = stableInboundMessageRef({ messageId: parsed.messageId, mailbox: meta.mailbox, uidValidity: meta.uidValidity, uid: meta.uid, mailAccountId: meta.mailAccountId });
  return {
    empty: false,
    trackingId: parsed.trackingId ?? safeMailSourceId(`imap-${meta.mailbox}-${meta.uidValidity}-${meta.uid}`),
    messageRef,
    signal: [parsed.subject, body].filter(Boolean).join(" | ").slice(0, 1200),
    ...(typeof parsed.hasAttachments === "boolean" ? { hasAttachments: parsed.hasAttachments } : {}),
    fromMasked: parsed.from ? maskEmail(parsed.from) : null,
    fromNormalized: parsed.from ? parsed.from.trim().toLowerCase() : null,
    subject: parsed.subject,
    body: parsed.body,
    receivedAtIso: (parsed.date ?? dateFromUnknown(meta.internalDate) ?? new Date()).toISOString(),
    providerMessageId: parsed.messageId,
    replyHeaders: {
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
    },
    ...(parsed.routingFlags ? { routingHeaders: parsed.routingFlags } : {}),
    quotedOriginalRecipientEmail: parsed.quotedOriginalRecipientEmail,
    ...(typeof parsed.quotedHistoryStripped === "boolean" ? { quotedHistoryStripped: parsed.quotedHistoryStripped } : {}),
    dedupeKey: safeMailSourceId(messageRef),
    imap: {
      cursorDocId: meta.cursorDocId,
      uid: meta.uid,
      uidValidity: meta.uidValidity,
      mailbox: meta.mailbox,
      user: meta.user,
      cursorAdvanceAllowed: meta.cursorAdvanceAllowed,
    },
    mailAccountId: meta.mailAccountId,
    accountMailbox: meta.accountMailbox,
  };
}

export async function parseEmailSource(source: Buffer): Promise<ParsedEmailSource> {
  try {
    const parsed: ParsedMail = await simpleParser(source);
    const bodySource = typeof parsed.text === "string" && parsed.text.trim()
      ? parsed.text
      : typeof parsed.html === "string"
        ? parsed.html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ")
        : "";
    const normalized = bodySource.trim() ? normalizeParsedEmailBodyWithFlag(bodySource) : null;
    return {
      subject: asString(parsed.subject, "Inbound creator email"),
      from: parsed.from?.value?.[0]?.address ?? null,
      body: normalized?.body ?? null,
      hasAttachments: parsed.attachments.length > 0,
      date: dateFromUnknown(parsed.date),
      messageId: normalizeEmailMessageId(parsed.messageId),
      trackingId: headerString(parsed.headers.get("x-flu-tracking-id")),
      inReplyTo: normalizeEmailMessageId(headerString(parsed.headers.get("in-reply-to"))),
      references: headerMessageIds(parsed.headers.get("references")),
      routingFlags: normalizeInboundRoutingFlags(routingFlagsFromHeaderMap(parsed.headers)),
      // Must run on the RAW bodySource, BEFORE normalizeParsedEmailBody/stripQuotedReply below
      // removes the quoted header block this depends on.
      quotedOriginalRecipientEmail: extractQuotedOriginalRecipientEmail(bodySource),
      quotedHistoryStripped: normalized?.quotedHistoryStripped === true,
    };
  } catch (error) {
    // 깨진 MIME/인코딩으로 simpleParser가 throw해도 런 전체를 중단시키지 않는다 —
    //   원문 헤더에서 최소 필드(subject/from/message-id/tracking/reply)만 정규식으로 회수(graceful degrade).
    const evidence = safeOutboundFailureEvidence(error, "imap-live.parse-email-source");
    console.warn("[imap-live] simpleParser failed; raw-header fallback", {
      errorCode: evidence.errorCode,
      kind: evidence.failureKind,
      ruleId: evidence.failureRuleId,
      correlationIdHash: evidence.correlationIdHash,
    });
    return parseEmailSourceFallback(source);
  }
}

// simpleParser 실패 시 원문 버퍼 헤더 블록에서 매칭에 필요한 최소 필드만 회수한다. 원문 본문은 저장하지 않는다(SEC-P0-009).
export function parseEmailSourceFallback(source: Buffer): ParsedEmailSource {
  const text = source.toString("utf8");
  const headerBlock = text.split(/\r?\n\r?\n/, 1)[0] ?? text.slice(0, 4000);
  const header = (name: string): string | null => {
    const m = headerBlock.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
    return m ? m[1].trim() : null;
  };
  const fromRaw = header("From");
  const emailMatch = fromRaw ? fromRaw.match(/[^<>\s]+@[^<>\s]+/) : null;
  const referencesRaw = header("References");
  const bodyRaw = text.split(/\r?\n\r?\n/).slice(1).join("\n\n");
  const normalizedFallback = bodyRaw.trim() ? normalizeParsedEmailBodyWithFlag(bodyRaw) : null;
  return {
    subject: header("Subject") ?? "Inbound creator email",
    from: emailMatch ? emailMatch[0].toLowerCase() : null,
    body: normalizedFallback?.body ?? null,
    // MIME structure is not trustworthy after parser failure; keep this absent for fail-closed gates.
    date: dateFromUnknown(header("Date")),
    messageId: normalizeEmailMessageId(header("Message-ID") ?? header("Message-Id")),
    trackingId: header("X-Flu-Tracking-Id"),
    inReplyTo: normalizeEmailMessageId(header("In-Reply-To")),
    references: referencesRaw ? referencesRaw.split(/\s+/).map(normalizeEmailMessageId).filter((item): item is string => item !== null) : [],
    routingFlags: normalizeInboundRoutingFlags(routingFlagsFromRawHeaderBlock(headerBlock)),
    quotedOriginalRecipientEmail: extractQuotedOriginalRecipientEmail(bodyRaw),
    quotedHistoryStripped: normalizedFallback?.quotedHistoryStripped === true,
  };
}

// ---------- PLAN-ORG-MAIL-IDENTITY Slice 4: shared forward-scan, parameterized by connection ----------

export type ImapFlowLike = {
  connect(): Promise<unknown>;
  logout(): Promise<unknown>;
  mailboxOpen(mailbox: string, options?: Record<string, unknown>): Promise<{ uidValidity: unknown; uidNext: unknown }>;
  search(query: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  fetchOne(
    range: string,
    fetchOptions: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ source?: Buffer; internalDate?: unknown } | null | undefined>;
};

export type CreateImapFlowClientFn = (options: Record<string, unknown>) => ImapFlowLike;

export function defaultCreateImapFlowClient(options: Record<string, unknown>): ImapFlowLike {
  return new ImapFlow(options as unknown as ConstructorParameters<typeof ImapFlow>[0]) as unknown as ImapFlowLike;
}

export type LiveImapAuth = { readonly user: string; readonly pass?: string; readonly accessToken?: string };

export type ImapScanConnection = {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly mailbox: string;
  readonly maxBytes: number;
  readonly auth: LiveImapAuth;
  // "imap" for the scp mailbox (byte-identical to pre-Slice-4), "imap:<accountId>" otherwise.
  readonly source: string;
  readonly mailAccountId: string;
  readonly accountMailbox: string;
};

// The exact scan loop readImapLatestLive always ran, now parameterized by connection + an
// injectable ImapFlow-like client (tests inject a fake; production uses the real ImapFlow).
async function scanImapMailboxLatest(
  connection: ImapScanConnection,
  data: Record<string, unknown>,
  createClient: CreateImapFlowClientFn,
): Promise<LiveInboundEmail | null> {
  const expectedTrackingId = asString(data.expectedTrackingId, "");
  const expectedProviderMessageId = normalizeEmailMessageId(data.expectedProviderMessageId);
  const maxExpectedScan = Math.max(1, Math.min(cleanNumber(data.imapMaxScan, 50), 100));

  const client = createClient({
    host: connection.host,
    port: connection.port,
    secure: connection.secure,
    auth: connection.auth,
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    maxLiteralSize: Math.max(64_000, connection.maxBytes),
  });
  await client.connect();
  try {
    const opened = await client.mailboxOpen(connection.mailbox, { readOnly: true });
    const uidValidity = String(opened.uidValidity);
    // W76-A: mailboxUidNext captured from the SAME mailboxOpen round-trip (no extra IMAP call).
    const mailboxUidNext = cleanNumber(opened.uidNext, 1);
    const cursorRef = cursorDocument(connection.source, connection.auth.user, connection.mailbox);
    const cursor = readCursorState((await cursorRef.get()).data(), uidValidity);
    const nextUidRange = `${cursor.lastUid + 1}:*`;
    const found = await client.search({ uid: nextUidRange }, { uid: true });
    const targetedScan = Boolean(expectedTrackingId || expectedProviderMessageId);
    const uids = Array.isArray(found) ? (found as number[]).filter((uid) => uid > cursor.lastUid) : [];
    const scanUids = targetedScan
      ? uids.sort((a, b) => b - a).slice(0, maxExpectedScan)
      : uids.sort((a, b) => a - b).slice(0, 1);
    for (const uid of scanUids) {
      const fetched = await client.fetchOne(String(uid), { uid: true, source: { maxLength: connection.maxBytes }, envelope: true, internalDate: true }, { uid: true });
      if (!fetched || !fetched.source) continue;
      const parsed = await parseEmailSource(fetched.source);
      const body = parsed.body ?? "";
      const replyHeaderIds = [parsed.inReplyTo, ...parsed.references].filter((value): value is string => Boolean(value));
      const trackingMatches = expectedTrackingId
        ? parsed.trackingId === expectedTrackingId || parsed.subject.includes(expectedTrackingId) || body.includes(expectedTrackingId)
        : false;
      const providerMatches = expectedProviderMessageId ? replyHeaderIds.includes(expectedProviderMessageId) : false;
      if ((expectedTrackingId || expectedProviderMessageId) && !trackingMatches && !providerMatches) {
        continue;
      }
      return liveInboundFromParsed(parsed, {
        mailbox: connection.mailbox,
        uidValidity: cursor.uidValidity,
        uid,
        user: connection.auth.user,
        cursorDocId: cursorRef.id,
        cursorAdvanceAllowed: shouldAdvanceImapCursor({ previousLastUid: cursor.lastUid, uid, targetedScan }),
        internalDate: fetched.internalDate,
        mailAccountId: connection.mailAccountId,
        accountMailbox: connection.accountMailbox,
      });
    }
    return {
      empty: true,
      cursorLastUid: cursor.lastUid,
      mailboxUidNext,
      // 상한 추정치(UIDNEXT-1 기준) — 관측용으로만 남긴다.
      cursorUidGap: computeCursorUidGap(mailboxUidNext, cursor.lastUid),
      // W76-M: 판정축. 커서 위로 **실제로 존재하는** 미처리 UID 수다.
      //   빈 성공인데 이 값이 양수면 있는 메일을 못 보고 있다는 뜻이고, 지운 메일은 여기 안 잡힌다.
      unseenUidCount: uids.length,
      mailAccountId: connection.mailAccountId,
      accountMailbox: connection.accountMailbox,
    };
  } finally {
    await client.logout();
  }
}

export async function readImapLatestLive(_data: Record<string, unknown>): Promise<LiveInboundEmail | null> {
  if (!liveIntegrationsEnabled("imap")) return null;
  const config = await getRuntimeIntegration("mailImap");
  const host = publicString(config, "host", "IMAP_HOST", "");
  const port = publicNumber(config, "port", "IMAP_PORT", 993);
  const secure = publicBoolean(config, "secure", "IMAP_SECURE", port === 993);
  const user = publicString(config, "username", "IMAP_USER", "");
  const mailbox = resolveImapMailbox(config);
  const maxBytes = publicNumber(config, "maxBytes", "IMAP_MAX_BYTES", 262_144);
  if (!host) throw Object.assign(new Error("IMAP host is not configured."), { code: "failed-precondition", errorCode: "read_imap_latest_live_imap_host_configured" });
  if (!user) throw Object.assign(new Error("IMAP username is not configured."), { code: "failed-precondition", errorCode: "read_imap_latest_live_imap_username_configured" });
  const pass = requireEnvSecret("IMAP_PASSWORD", "IMAP");
  // Thin wrapper over the scp account (PLAN-ORG-MAIL-IDENTITY Slice 4) — same host/port/
  // secure/user/pass/mailbox resolution and the exact same "imap" cursor source as before, so
  // every existing caller/test of readImapLatestLive stays byte-identical.
  return scanImapMailboxLatest(
    { host, port, secure, mailbox, maxBytes, auth: { user, pass }, source: "imap", mailAccountId: "scp", accountMailbox: user },
    _data,
    defaultCreateImapFlowClient,
  );
}

const OAUTH_IMAP_HOST_DEFAULT = "imap.gmail.com";
const OAUTH_IMAP_PORT_DEFAULT = 993;
const DEFAULT_IMAP_MAX_BYTES = 262_144;

function imapAccountConfigError(field: string, accountId: string): Error {
  return Object.assign(
    new Error(`IMAP ${field} is not configured for mail account ${accountId}.`),
    { code: "failed-precondition", errorCode: "read_imap_latest_live_for_account_imap_config_missing" },
  );
}

export type ResolveImapConnectionForAccountDeps = {
  readonly getRuntimeIntegration?: typeof getRuntimeIntegration;
  readonly envSecret?: (envName: string) => string;
  readonly getMailOAuthAccessToken?: typeof defaultGetMailOAuthAccessToken;
  readonly oauthDeps?: GetMailOAuthAccessTokenDeps;
};

/**
 * Builds the ImapFlow connection options for one mail_accounts/{accountId} doc, per kind
 * (PLAN-ORG-MAIL-IDENTITY Slice 4) —
 *   canonical_scp    -> today's exact path (getRuntimeIntegration("mailImap") + IMAP_PASSWORD).
 *   external_smtp_imap -> account.imap public config + the env secret named by account.secretRef
 *                        (functions/mailTransport.ts's resolveExternalSecretEnvName/
 *                        requireTransportSecret — reused, not duplicated).
 *   workspace_oauth   -> imap.gmail.com:993 secure (overridable via account.imap) with
 *                        auth:{user:account.mailbox, accessToken} from getMailOAuthAccessToken.
 * Shared by readImapLatestLiveForAccount below (forward cursor scan) AND
 * functions/mailImapBackfill.ts (bounded SINCE-date scan) so the two never resolve a
 * different connection for the same account.
 */
export async function resolveImapConnectionForAccount(
  account: Pick<MailAccount, "accountId" | "kind" | "mailbox" | "imap" | "secretRef">,
  deps: ResolveImapConnectionForAccountDeps = {},
): Promise<ImapScanConnection> {
  const fetchRuntimeIntegration = deps.getRuntimeIntegration ?? getRuntimeIntegration;
  const readEnvSecret = deps.envSecret ?? envSecret;
  // scp keeps the exact pre-Slice-4 cursor source ("imap") — every other account gets a
  // distinct source so cursor docs never collide across accounts.
  const source = account.accountId === "scp" ? "imap" : `imap:${account.accountId}`;

  if (account.kind === "canonical_scp") {
    const config = await fetchRuntimeIntegration("mailImap");
    const host = publicString(config, "host", "IMAP_HOST", "");
    const port = publicNumber(config, "port", "IMAP_PORT", 993);
    const secure = publicBoolean(config, "secure", "IMAP_SECURE", port === 993);
    const user = publicString(config, "username", "IMAP_USER", "");
    const mailbox = resolveImapMailbox(config);
    const maxBytes = publicNumber(config, "maxBytes", "IMAP_MAX_BYTES", DEFAULT_IMAP_MAX_BYTES);
    if (!host) throw imapAccountConfigError("host", account.accountId);
    if (!user) throw imapAccountConfigError("username", account.accountId);
    const pass = requireEnvSecret("IMAP_PASSWORD", "IMAP");
    return { host, port, secure, mailbox, maxBytes, auth: { user, pass }, source, mailAccountId: account.accountId, accountMailbox: account.mailbox };
  }

  if (account.kind === "workspace_oauth") {
    const imapPublic = asRecord(account.imap);
    const host = typeof imapPublic.host === "string" && imapPublic.host.trim() ? imapPublic.host.trim() : OAUTH_IMAP_HOST_DEFAULT;
    const port = typeof imapPublic.port === "number" && Number.isFinite(imapPublic.port) ? imapPublic.port : OAUTH_IMAP_PORT_DEFAULT;
    const secure = typeof imapPublic.secure === "boolean" ? imapPublic.secure : true;
    const mailbox = resolveImapMailbox({ public: imapPublic });
    const maxBytes = typeof imapPublic.maxBytes === "number" && Number.isFinite(imapPublic.maxBytes) ? imapPublic.maxBytes : DEFAULT_IMAP_MAX_BYTES;
    const getAccessToken = deps.getMailOAuthAccessToken ?? defaultGetMailOAuthAccessToken;
    let accessToken: string;
    try {
      const token = await getAccessToken(account.accountId, deps.oauthDeps);
      accessToken = token.accessToken;
    } catch (error) {
      if (error instanceof MailOAuthError && error.code === "revoked") {
        throw Object.assign(
          new Error(`mail OAuth credential for account ${account.accountId} has been revoked`),
          { code: "failed-precondition", errorCode: "read_imap_latest_live_for_account_oauth_revoked" },
        );
      }
      throw Object.assign(
        new Error(`mail OAuth access token is unavailable for account ${account.accountId}`),
        { code: "failed-precondition", errorCode: "read_imap_latest_live_for_account_oauth_unavailable" },
      );
    }
    return { host, port, secure, mailbox, maxBytes, auth: { user: account.mailbox, accessToken }, source, mailAccountId: account.accountId, accountMailbox: account.mailbox };
  }

  // external_smtp_imap
  const imapPublic = asRecord(account.imap);
  const host = asString(imapPublic.host, "");
  const port = typeof imapPublic.port === "number" && Number.isFinite(imapPublic.port) ? imapPublic.port : 993;
  const secure = typeof imapPublic.secure === "boolean" ? imapPublic.secure : port === 993;
  const user = asString(imapPublic.authUser, asString(imapPublic.username, account.mailbox));
  const mailbox = resolveImapMailbox({ public: imapPublic });
  const maxBytes = typeof imapPublic.maxBytes === "number" && Number.isFinite(imapPublic.maxBytes) ? imapPublic.maxBytes : DEFAULT_IMAP_MAX_BYTES;
  if (!host) throw imapAccountConfigError("host", account.accountId);
  const envName = resolveExternalSecretEnvName(account.accountId, account.secretRef);
  const pass = requireTransportSecret(readEnvSecret, envName, account.accountId);
  return { host, port, secure, mailbox, maxBytes, auth: { user, pass }, source, mailAccountId: account.accountId, accountMailbox: account.mailbox };
}

export type ReadImapLatestLiveForAccountDeps = ResolveImapConnectionForAccountDeps & {
  readonly createImapClient?: CreateImapFlowClientFn;
};

/** Account-aware entry point (PLAN-ORG-MAIL-IDENTITY Slice 4) — see resolveImapConnectionForAccount above. */
export async function readImapLatestLiveForAccount(
  account: Pick<MailAccount, "accountId" | "kind" | "mailbox" | "imap" | "secretRef">,
  data: Record<string, unknown>,
  deps: ReadImapLatestLiveForAccountDeps = {},
): Promise<LiveInboundEmail | null> {
  if (!liveIntegrationsEnabled("imap")) return null;
  const connection = await resolveImapConnectionForAccount(account, deps);
  return scanImapMailboxLatest(connection, data, deps.createImapClient ?? defaultCreateImapFlowClient);
}

// RT-1/A1: manual recovery path for a dead-lettered UID. Unlike readImapLatestLive
// (which only searches forward from `cursor.lastUid + 1`, so anything the cursor has
// already advanced past is unreachable), this fetches one explicit UID directly —
// the only way to recover a poison message after the cursor has moved past it.
// Never advances the shared cursor (cursorAdvanceAllowed is always false here); a
// uidValidity mismatch means the mailbox UID numbering was reset server-side, so the
// caller must fall back to the preserved dead-letter payload instead of live re-fetch.
export async function fetchImapMessageByUid(args: {
  readonly mailbox: string;
  readonly uid: number;
  readonly uidValidity?: string;
}): Promise<LiveInboundEmail | null> {
  if (!liveIntegrationsEnabled("imap")) return null;
  const uid = cleanNumber(args.uid, 0);
  if (uid <= 0) throw Object.assign(new Error("fetchImapMessageByUid requires a positive uid."), { code: "invalid-argument", errorCode: "fetch_imap_message_by_uid_fetch_imap_message_by_uid" });
  if (!isValidImapMailboxFolder(args.mailbox)) {
    throw Object.assign(new Error("fetchImapMessageByUid requires a valid mailbox folder."), { code: "invalid-argument", errorCode: "fetch_imap_message_by_uid_fetch_imap_message_by_uid_2" });
  }
  const mailbox = safeImapMailboxName(args.mailbox);

  const config = await getRuntimeIntegration("mailImap");
  const host = publicString(config, "host", "IMAP_HOST", "");
  const port = publicNumber(config, "port", "IMAP_PORT", 993);
  const secure = publicBoolean(config, "secure", "IMAP_SECURE", port === 993);
  const user = publicString(config, "username", "IMAP_USER", "");
  const maxBytes = publicNumber(config, "maxBytes", "IMAP_MAX_BYTES", 262_144);
  if (!host) throw Object.assign(new Error("IMAP host is not configured."), { code: "failed-precondition", errorCode: "fetch_imap_message_by_uid_imap_host_configured" });
  if (!user) throw Object.assign(new Error("IMAP username is not configured."), { code: "failed-precondition", errorCode: "fetch_imap_message_by_uid_imap_username_configured" });
  const pass = requireEnvSecret("IMAP_PASSWORD", "IMAP");

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass },
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    maxLiteralSize: Math.max(64_000, maxBytes),
  });
  await client.connect();
  try {
    const opened = await client.mailboxOpen(mailbox, { readOnly: true });
    const uidValidity = opened.uidValidity.toString();
    if (args.uidValidity && args.uidValidity !== uidValidity) {
      throw Object.assign(
        new Error(`IMAP uidValidity mismatch for mailbox ${mailbox}: dead-letter recorded ${args.uidValidity}, mailbox is now ${uidValidity}. UID numbering was reset; recover from the preserved dead-letter payload instead.`),
        { code: "failed-precondition", errorCode: "fetch_imap_message_by_uid_imap_uid_validity_mismatch_mailbox" },
      );
    }
    const fetched = await client.fetchOne(String(uid), { uid: true, source: { maxLength: maxBytes }, envelope: true, internalDate: true }, { uid: true });
    if (!fetched || !fetched.source) return { empty: true, mailAccountId: "scp", accountMailbox: user };
    const parsed = await parseEmailSource(fetched.source);
    return liveInboundFromParsed(parsed, {
      mailbox,
      uidValidity,
      uid,
      user,
      cursorDocId: cursorDocument("imap", user, mailbox).id,
      cursorAdvanceAllowed: false,
      internalDate: fetched.internalDate,
      mailAccountId: "scp",
      accountMailbox: user,
    });
  } finally {
    await client.logout();
  }
}
