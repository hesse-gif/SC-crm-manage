import { createHash, randomBytes } from "node:crypto";
import { FieldPath, FieldValue, Timestamp, type Transaction } from "firebase-admin/firestore";
import { ImapFlow } from "imapflow";
import { simpleParser, type HeaderValue, type ParsedMail } from "mailparser";
import { adminDb } from "./firebaseAdmin";
import { stitchExternalSentConversationsCore } from "./externalSentConversationStitch";
import { expireAt180DaysFromIso, expireAt180DaysFromTimestamp } from "./firestoreTtl";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  type CallableRequestShape,
} from "./shared";
import {
  getRuntimeIntegration,
  liveIntegrationsEnabled,
  publicBoolean,
  publicNumber,
  publicString,
  requireEnvSecret,
} from "./liveIntegrations";
import {
  PERSONAL_MAIL_ACCOUNT_KINDS,
  readMailAccounts,
  type MailAccount,
} from "./mailAccounts";
import {
  resolveImapConnectionForAccount,
  type ResolveImapConnectionForAccountDeps,
} from "./mailImapLive";
import { safeOutboundFailureEvidence } from "./mailSafetyShared";

const OUTBOX_COLLECTION = "mail_outbound_log";
const MESSAGE_SOURCES_COLLECTION = "message_sources";
const AUDIT_COLLECTION = "external_sent_mail_import_audits";
const PREVIEW_CLAIMS_COLLECTION = "external_sent_mail_import_preview_claims";
const PROVIDER_UNIQUENESS_COLLECTION = "mail_provider_message_uniqueness";
const SENT_CURSOR_COLLECTION = "mail_sent_import_cursors";
const TRACKING_ID_RE = /^[A-Za-z0-9_-]{4,120}$/;
const IMPORT_ROLES = ["super_admin", "admin", "manager"] as const;
const MAX_FIXTURE_MESSAGES = 25;
const DEFAULT_SENT_MAILBOX = "[Gmail]/Sent Mail";
const PREVIEW_TOKEN_VERSION = "sent-import-v1";
const PREVIEW_REQUIRED_CODE = "mail-safety.sent-import-preview-required";
const PREVIEW_MISMATCH_CODE = "mail-safety.sent-import-preview-mismatch";
const PREVIEW_EXPIRED_CODE = "mail-safety.sent-import-preview-expired";
const MAILBOX_NOT_ALLOWED_CODE = "mail-safety.sent-import-mailbox-not-allowed";
const FROM_NOT_ALLOWED_CODE = "mail-safety.sent-import-from-not-allowed";
const IMAP_RUNTIME_ERROR_CODE = "mail-safety.sent-import-imap-runtime-failed";
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const FIXTURE_SENT_FROM = "scp@supercent.io";

/**
 * W117 (헤세 결정 2026-08-23): 편입 메일의 **본문 전문을 저장한다**.
 *
 * 이건 실수로 풀린 봉인이 아니라 **노출 등급 정렬**이다. 툴 발송 레인은 이미 본문 전문을
 * `message_sources.body` 에 싣는다(chat-ai.persistSentEmail — visibleText/body). 같은 사람이
 * 같은 수신자에게 보낸 같은 메일인데 발송 경로가 flu 밖이었다는 이유만으로 본문이 사라지면,
 * 화면은 "우리가 무슨 말을 보냈는지" 를 제목으로만 추측하게 된다. 요약·맥락 파악이 안 된다.
 * 그래서 편입 레인을 툴 발송 레인과 **같은 등급**으로 맞춘다 — 새 등급을 만드는 게 아니다.
 *
 * 남는 경계(그대로 유지):
 *   - 로그에는 본문 원문을 절대 싣지 않는다(closed log contract, imapRuntimeFailure 참조).
 *   - 감사 문서·프리뷰 클레임은 계속 카운트/해시만 담는다.
 *   - 콜러블 응답(publicCandidate)도 본문을 돌려주지 않는다 — 저장은 원장까지다.
 *   - 원장(mail_outbound_log)에는 프리뷰만 싣는다. 전문은 소스 문서 한 곳에만 둔다(비대 방지).
 */
const MAX_STORED_BODY_CHARS = 64_000;
const BODY_PREVIEW_CHARS = 240;

type ParsedSentMail = {
  sourceId: string;
  subject: string;
  to: string;
  toMasked: string;
  toHash: string;
  fromHash: string;
  sentAtIso: string;
  providerMessageId: string;
  providerMessageIdNormalized: string;
  headerTrackingId: string;
  pixelTrackingId: string;
  /** W117: 본문 전문(상한 절단). 저장 근거는 MAX_STORED_BODY_CHARS 주석 참조. */
  body: string;
  /** W117: 상한을 넘겨 절단됐는가 — 화면이 "전문"과 "잘린 전문"을 구분할 수 있어야 한다. */
  bodyTruncated: boolean;
  bodyPreview: string;
  /** 절단과 무관하게 **원문 전체**의 해시다 — 멱등/중복 판정 축이라 바뀌면 안 된다. */
  bodyHash: string;
  htmlHash: string;
  uid?: number;
  mailbox?: string;
  uidValidity?: string;
  /**
   * Manual-reply learning capture: normalized (bracket-stripped) `In-Reply-To` header,
   * "" when absent. This is the primary signal used to pair a reply to the specific
   * inbound `message_sources` doc it answers (see `pairInboundForReply` below) — inbound
   * docs keep their raw, un-lowercased `providerMessageId` (functions/chat-ai.ts
   * receiveEmail), so this stays un-lowercased too for an exact match.
   */
  inReplyTo: string;
  /** Normalized `References` header chain, most-recent-last, capped at 5 ids. */
  references: string[];
};

type ImportCandidate = ParsedSentMail & {
  trackingId: string;
  idempotencyKey: string;
  source: "external_sent_mail_import";
  mailType: "manual_external_gmail";
  /** Source mail_accounts row that performed THIS import ("scp" for the canonical runtime). */
  mailAccountId: string;
  /**
   * Account stamp actually written to ledger/source docs. An existing row keeps the account
   * that first imported it — a second account seeing the same Message-ID is a duplicate and
   * must not re-attribute the ledger to itself.
   */
  attributedMailAccountId: string;
  trustedTracking: boolean;
  unsafe: boolean;
  skipReason: string;
  duplicateReason: string;
  existingOutboxPath?: string;
  existingMessageSourcePath?: string;
  /**
   * Manual-reply learning capture: "manual_reply" when this Sent-folder message is
   * reply-shaped (an `In-Reply-To` header, or a "Re:"-prefixed subject once paired to an
   * inbound). "" for everything else (cold outreach, notices) — never guessed from the
   * subject alone, since a real pairing is what excludes bulk/templated sends.
   */
  kind: "manual_reply" | "";
  /** `message_sources/{id}` doc id of the paired inbound creator message, "" if none found. */
  pairedInboundMessageSourceId: string;
  needsOutboxWrite: boolean;
  needsMessageSourceWrite: boolean;
  needsProviderUniquenessWrite: boolean;
  providerUniquenessExists: boolean;
  providerUniquenessPath: string;
  ledgerAssertions: readonly {
    path: string;
    stateHash: string;
  }[];
  providerQueryAssertions: readonly {
    collection: typeof OUTBOX_COLLECTION | typeof MESSAGE_SOURCES_COLLECTION;
    field: "providerMessageIdHash" | "providerMessageIdNormalized" | "providerMessageId";
    value: string;
    resultHash: string;
  }[];
};

/**
 * W114 (프로드 실측 2026-08-20T22:20:36Z): 수신자 없는 메일 한 통이 `invalid-argument` 를 던져
 * 읽기 단계 전체를 막고 커서가 lastUid=1,775 에서 정지했다. 이 카운트는 "건너뛴 메일이 있다"를
 * 조용히 삼키지 않기 위한 것이다(W112 F-C: seed_not_found 가 조용한 0 을 만든 사고 재발 방지).
 */
type ParseSkipReason = "no_recipient" | "unparseable";

type ParseSkipCounts = {
  noRecipient: number;
  unparseable: number;
};

function emptyParseSkipCounts(): ParseSkipCounts {
  return { noRecipient: 0, unparseable: 0 };
}

function totalParseSkipCount(counts: ParseSkipCounts): number {
  return counts.noRecipient + counts.unparseable;
}

function addParseSkip(counts: ParseSkipCounts, reason: ParseSkipReason): void {
  if (reason === "no_recipient") counts.noRecipient += 1;
  else counts.unparseable += 1;
}

/**
 * 어떤 에러가 여기(메시지 파싱 단계)에서 던져졌는지가 skip 가능 여부를 가른다 — 문자열
 * 매칭이 아니라 명시적 태그로 판별한다(메시지 텍스트가 나중에 바뀌어도 분류가 깨지지 않게).
 * IMAP 인증·권한·쿼터 실패는 이 태그를 달지 않는다(runImapRuntimeOperation 이 별도 코드로
 * 던지고, 이 분류기를 통과하는 자리 자체를 지나지 않는다) — 그래서 태그가 없는 에러는
 * "이 메시지 내용을 해석할 수 없었다"는 뜻으로 취급해 건너뛴다.
 */
function classifyParseSkipReason(error: unknown): ParseSkipReason {
  const tagged = error && typeof error === "object"
    ? (error as { parseSkipReason?: unknown }).parseSkipReason
    : undefined;
  return tagged === "no_recipient" ? "no_recipient" : "unparseable";
}

/** SEC-P0-009: 메일 주소·제목·본문은 절대 싣지 않는다 — UID/소스ID 와 사유 코드만. */
function logSkippedParseFailure(identity: { uid?: number; sourceId?: string }, reason: ParseSkipReason): void {
  console.warn("[sent-import]", JSON.stringify({
    outcome: "skipped_unparseable_message",
    reason,
    ...(typeof identity.uid === "number" ? { uid: identity.uid } : {}),
    ...(identity.sourceId ? { sourceId: identity.sourceId } : {}),
  }));
}

type SentReadResult = {
  rows: ParsedSentMail[];
  sourceMode: SentSourceMode;
  scopeFingerprint: string;
  /** 파싱 불가로 건너뛴 메일 수(사유별). 조용한 스킵 방지 — 항상 채워서 반환한다. */
  skipped: ParseSkipCounts;
  cursor?: {
    refPath: string;
    nextLastUid: number;
    expectedExists: boolean;
    expectedLastUid: number;
    expectedUidValidity: string;
    expectedVersion: number;
    expectedStateHash: string;
    uidValidity: string;
    mailbox: string;
    user: string;
  };
  /**
   * W117: 이번 스캔이 **실제로 지나온 UID 구간**. 편입 커서(`cursor`)와 달리 Firestore 상태가
   * 아니라 이번 회차의 사실이다 — 백필(hydrate)이 자기 커서를 전진시키는 데 쓴다. 파싱에 실패해
   * `rows` 에 들어오지 못한 UID 도 여기엔 반영된다(그래야 같은 불량 UID 를 영원히 재스캔하지 않는다).
   */
  scan?: { uidValidity: string; maxUid: number };
};

/** W117: 편입 커서 대신 호출자가 지정한 UID 창을 읽는다(백필 전용 — 커서 문서를 읽지도 쓰지도 않는다). */
type SentReadWindow = { afterUid: number };

type SentSourceMode = "fixture" | "imap";

type ResolvedSentScope = {
  sourceMode: SentSourceMode;
  scopeFingerprint: string;
  allowedSentMailboxes: string[];
  allowedFromHashes: string[];
  /**
   * Which mail_accounts row this scope reads Sent for. "scp" is the canonical operational
   * mailbox (runtime mailImap integration); personal accounts carry their own accountId so
   * imported ledger/source rows can be attributed and account-scoped views can filter.
   */
  mailAccountId: string;
  imap?: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    mailbox: string;
    maxBytes: number;
    limit: number;
    emulator: boolean;
    discoverBySpecialUse: boolean;
    /**
     * Pre-resolved auth for personal-account scopes (OAuth accessToken or the env secret the
     * account's secretRef names). Absent for the canonical SCP scope, which keeps reading
     * IMAP_PASSWORD lazily inside the live read so its behavior stays byte-identical.
     */
    auth?: { user: string; pass?: string; accessToken?: string };
    /**
     * Cursor-document namespace. Canonical keeps the historical `user` value so its existing
     * cursor document is untouched; personal accounts use their accountId so two accounts can
     * never share a cursor doc even when their IMAP logins collide.
     */
    cursorUser?: string;
  };
};

type ListedSentMailbox = {
  path: string;
  flags?: ReadonlySet<string>;
  specialUse?: string | null;
};

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument", errorCode: "invalid_argument_unauthorized",
  });
}

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(`failed-precondition: ${message}`), {
    code: "failed-precondition", errorCode: "failed_precondition_unauthorized",
  });
}

function codedFailedPrecondition(
  errorCode: string,
  message: string,
  details: Record<string, unknown> = {},
): Error {
  return Object.assign(
    failedPrecondition(`${errorCode}: ${message}`),
    { errorCode, ...details },
  );
}

type ImapRuntimeStage = "connect" | "list" | "open" | "search" | "fetch" | "logout";

function imapRuntimeFailure(stage: ImapRuntimeStage, error: unknown): Error {
  const evidence = safeOutboundFailureEvidence(error, `external-sent-imap:${stage}`);
  const { errorCode: providerErrorCode, ...safeEvidence } = evidence;
  // Closed log contract: raw provider errors, mailbox names, users, and message
  // content never cross this boundary.
  console.error(IMAP_RUNTIME_ERROR_CODE, {
    stage,
    errorCode: evidence.errorCode,
    kind: evidence.failureKind,
    ruleId: evidence.failureRuleId,
    correlationIdHash: evidence.correlationIdHash,
  });
  return codedFailedPrecondition(
    IMAP_RUNTIME_ERROR_CODE,
    `IMAP Sent 조회를 완료하지 못했습니다. 참조 코드 ${evidence.correlationIdHash}`,
    {
      clientCode: IMAP_RUNTIME_ERROR_CODE,
      providerErrorCode,
      ...safeEvidence,
    },
  );
}

async function runImapRuntimeOperation<T>(
  stage: ImapRuntimeStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw imapRuntimeFailure(stage, error);
  }
}

function safeId(value: string, fallback = "id"): string {
  const normalized = value
    .replace(/[<>]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
  return normalized || fallback;
}

function normalizeEmail(value: unknown): string {
  return asString(value, "").trim().toLowerCase();
}

function maskEmail(value: string): string {
  if (!value) return "";
  const [local = "", domain = ""] = value.split("@");
  return `${local.slice(0, Math.min(2, local.length)) || "*"}***@${domain}`;
}

function emailHash(value: string): string {
  const normalized = normalizeEmail(value);
  return normalized
    ? createHash("sha256").update(normalized).digest("hex").slice(0, 24)
    : "";
}

function listStrings(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,;]/)
      : [];
  return values
    .map((entry) => asString(entry, "").trim())
    .filter(Boolean);
}

function normalizeMailboxKey(value: unknown): string {
  return asString(value, "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function uniqueMailboxNames(values: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const value of values) {
    const mailbox = asString(value, "").trim();
    const key = normalizeMailboxKey(mailbox);
    if (key && !byKey.has(key)) byKey.set(key, mailbox);
  }
  return [...byKey.values()];
}

function mailboxNotAllowed(): Error {
  return codedFailedPrecondition(
    MAILBOX_NOT_ALLOWED_CODE,
    "서버에서 승인된 Sent 폴더만 가져올 수 있습니다.",
  );
}

function isServerDeclaredSentMailbox(mailbox: ListedSentMailbox): boolean {
  return mailbox.flags?.has("\\Sent") === true;
}

/**
 * Resolve only a server-declared Sent mailbox.
 *
 * A configured/selected mailbox must match exactly and carry the server's
 * literal `\\Sent` LIST flag. ImapFlow's name-inferred `specialUse` value is
 * intentionally ignored because it is not authoritative server evidence.
 * When no mailbox was configured, Gmail accounts whose localized Sent path is
 * not `[Gmail]/Sent Mail` may use the single server-declared `\\Sent` folder.
 * Multiple candidates remain ambiguous and fail closed.
 */
export function resolveServerSentMailbox(input: {
  selectedMailbox: string;
  discoverBySpecialUse: boolean;
  listedMailboxes: readonly ListedSentMailbox[];
}): string {
  if (input.discoverBySpecialUse) {
    const sentCandidates = input.listedMailboxes.filter((entry) =>
      isServerDeclaredSentMailbox(entry),
    );
    if (sentCandidates.length !== 1) throw mailboxNotAllowed();
    return sentCandidates[0].path;
  }
  const exact = input.listedMailboxes.find(
    (entry) => entry.path === input.selectedMailbox,
  );
  if (!exact || !isServerDeclaredSentMailbox(exact)) throw mailboxNotAllowed();
  return exact.path;
}

function selectAllowedSentMailbox(
  requested: unknown,
  configuredMailboxes: readonly string[],
): string {
  const allowed = uniqueMailboxNames(configuredMailboxes);
  if (allowed.length === 0) throw mailboxNotAllowed();
  const requestedValue = asString(requested, "").trim();
  const selectedKey = normalizeMailboxKey(requestedValue || allowed[0]);
  if (!selectedKey || selectedKey === "inbox") throw mailboxNotAllowed();
  const selected = allowed.find((mailbox) => normalizeMailboxKey(mailbox) === selectedKey);
  if (!selected) throw mailboxNotAllowed();
  return selected;
}

function approvedFromHashes(user: string, aliases: unknown): string[] {
  const normalized = [user, ...listStrings(aliases)]
    .map((value) => normalizeEmail(value))
    .filter((value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value));
  return [...new Set(normalized.map(emailHash).filter(Boolean))].sort();
}

function assertApprovedFrom(
  rows: readonly ParsedSentMail[],
  allowedFromHashes: readonly string[],
): void {
  const allowed = new Set(allowedFromHashes);
  if (
    allowed.size === 0
    || rows.some((row) => !row.fromHash || !allowed.has(row.fromHash))
  ) {
    throw codedFailedPrecondition(
      FROM_NOT_ALLOWED_CODE,
      "구성된 발신 계정 또는 승인 별칭의 메일만 가져올 수 있습니다.",
    );
  }
}

function hashHex(value: string, length = 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function normalizeMessageId(value: unknown): string {
  return asString(value, "").replace(/[<>]/g, "").trim();
}

function providerMessageIdHash(value: unknown, length = 64): string {
  const normalized = normalizeMessageId(value).toLowerCase();
  return normalized ? hashHex(normalized, length) : "";
}

function providerUniquenessDocument(providerMessageIdNormalized: string) {
  return adminDb.collection(PROVIDER_UNIQUENESS_COLLECTION)
    .doc(`provider-${providerMessageIdHash(providerMessageIdNormalized, 40)}`);
}

function previewClaimDocument(previewToken: string) {
  return adminDb.collection(PREVIEW_CLAIMS_COLLECTION)
    .doc(`claim-${hashHex(previewToken, 40)}`);
}

function ledgerStateHash(exists: boolean, data: Record<string, unknown>): string {
  return hashHex(JSON.stringify({
    exists,
    trackingId: asString(data.trackingId, ""),
    externalTrackingId: asString(data.externalTrackingId, ""),
    legacyProviderMessageIdPresent: Object.prototype.hasOwnProperty.call(data, "providerMessageId"),
    legacyProviderMessageIdValueHash: hashHex(asString(data.providerMessageId, ""), 64),
    legacyProviderMessageIdNormalizedPresent: Object.prototype.hasOwnProperty.call(data, "providerMessageIdNormalized"),
    legacyProviderMessageIdNormalizedValueHash: hashHex(asString(data.providerMessageIdNormalized, ""), 64),
    storedProviderMessageIdHash: asString(data.providerMessageIdHash, ""),
    recipientHash: asString(data.recipientHash, ""),
    toHash: asString(data.toHash, ""),
    fromHash: asString(data.fromHash, ""),
    toValueHash: hashHex(asString(data.to, ""), 64),
    toMaskedHash: hashHex(asString(data.toMasked, ""), 64),
    subjectHash: asString(data.subjectHash, "") || hashHex(asString(data.subject, ""), 24),
    sentAtIso: asString(data.sentAtIso, ""),
    deliveryState: asString(data.deliveryState, ""),
    direction: asString(data.direction, ""),
    source: asString(data.source, ""),
    sourceRef: asString(data.sourceRef, ""),
    mailType: asString(data.mailType, ""),
    idempotencyKey: asString(data.idempotencyKey, ""),
  }), 40);
}

function queryResultHash(
  docs: readonly FirebaseFirestore.QueryDocumentSnapshot[],
): string {
  return hashHex(JSON.stringify(docs.map((doc) => ({
    path: doc.ref.path,
    stateHash: ledgerStateHash(true, asRecord(doc.data())),
  })).sort((left, right) => left.path.localeCompare(right.path))), 40);
}

function cursorDocumentVersion(data: Record<string, unknown>): number {
  const value = Number(data.version ?? 0);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function cursorStateHash(exists: boolean, data: Record<string, unknown>): string {
  return hashHex(JSON.stringify({
    exists,
    version: cursorDocumentVersion(data),
    lastUid: Math.max(0, Math.trunc(Number(data.lastUid ?? 0) || 0)),
    uidValidityHash: hashHex(asString(data.uidValidity, ""), 32),
    mailboxHash: hashHex(asString(data.mailbox, ""), 32),
    userHash: hashHex(asString(data.user, ""), 32),
    source: asString(data.source, ""),
    updatedByHash: hashHex(asString(data.updatedBy, ""), 32),
  }), 40);
}

function previewToken(): string {
  return `${PREVIEW_TOKEN_VERSION}.${randomBytes(16).toString("hex")}`;
}

function validPreviewToken(value: string): boolean {
  return new RegExp(`^${PREVIEW_TOKEN_VERSION}\\.[a-f0-9]{32}$`).test(value);
}

function isoDate(value: unknown, fallback = new Date()): string {
  if (value instanceof Date && !Number.isNaN(value.getTime()))
    return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback.toISOString();
}

function headerString(value: HeaderValue | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    const first = value.find(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    );
    return first?.trim() ?? "";
  }
  if (value instanceof Date) return value.toISOString();
  const record = asRecord(value);
  return asString(record.value, "");
}

function textFromHtml(html: string): string {
  return html
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTrackingIdFromHtml(value: string): string {
  const decoded = value.replace(/&amp;/g, "&");
  const pixelMatch = decoded.match(
    /mailOpenPixel[^"'\s<>]*[?&]tid=([^&"'\s<>]+)/i,
  );
  const genericMatch = decoded.match(/[?&]tid=([^&"'\s<>]+)/i);
  const raw = pixelMatch?.[1] ?? genericMatch?.[1] ?? "";
  try {
    const decodedTid = decodeURIComponent(raw).trim();
    return TRACKING_ID_RE.test(decodedTid) ? decodedTid : "";
  } catch {
    return TRACKING_ID_RE.test(raw) ? raw : "";
  }
}

function extractAddress(value: unknown): string {
  const record = asRecord(value);
  const address = asString(record.address, "");
  if (address) return address;
  const text = asString(value, "");
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0] ?? "";
}

function firstRecipient(parsed: ParsedMail): string {
  const to = parsed.to as unknown;
  const record = asRecord(to);
  const value = Array.isArray(record.value) ? record.value : [];
  for (const entry of value) {
    const address = extractAddress(entry);
    if (address) return normalizeEmail(address);
  }
  if (Array.isArray(to)) {
    for (const item of to) {
      const nested = asRecord(item);
      const nestedValue = Array.isArray(nested.value) ? nested.value : [];
      for (const entry of nestedValue) {
        const address = extractAddress(entry);
        if (address) return normalizeEmail(address);
      }
    }
  }
  return normalizeEmail(extractAddress(parsed.headers.get("to")));
}

function firstSender(parsed: ParsedMail): string {
  const from = parsed.from as unknown;
  const record = asRecord(from);
  const value = Array.isArray(record.value) ? record.value : [];
  for (const entry of value) {
    const address = extractAddress(entry);
    if (address) return normalizeEmail(address);
  }
  if (Array.isArray(from)) {
    for (const item of from) {
      const nested = asRecord(item);
      const nestedValue = Array.isArray(nested.value) ? nested.value : [];
      for (const entry of nestedValue) {
        const address = extractAddress(entry);
        if (address) return normalizeEmail(address);
      }
    }
  }
  return normalizeEmail(extractAddress(parsed.headers.get("from")));
}

function stableExternalTrackingId(parsed: ParsedSentMail): string {
  const seed = [
    parsed.providerMessageIdNormalized || parsed.sourceId,
    parsed.toHash,
    parsed.sentAtIso,
    hashHex(parsed.subject, 16),
  ].join("|");
  return `external-sent-${hashHex(seed, 28)}`;
}

async function parseRawSentMail(
  raw: Buffer,
  sourceId: string,
  meta: Partial<ParsedSentMail> = {},
): Promise<ParsedSentMail> {
  const parsed = await simpleParser(raw);
  const html = typeof parsed.html === "string" ? parsed.html : "";
  const text =
    typeof parsed.text === "string" && parsed.text.trim()
      ? parsed.text.trim()
      : textFromHtml(html);
  const subject = asString(parsed.subject, "(제목 없음)").slice(0, 500);
  const to = normalizeEmail(firstRecipient(parsed));
  const fromHash = emailHash(firstSender(parsed));
  if (!to)
    // W114: 이 태그가 classifyParseSkipReason 의 판별 근거다 — 메시지 문자열이 아니라
    // 명시적 필드로 분류해, 이 메일 한 통을 건너뛰고 커서를 전진시켜도 안전함을 표시한다.
    throw Object.assign(
      invalidArgument("Sent-mail import requires at least one To recipient."),
      { parseSkipReason: "no_recipient" as const },
    );
  const providerMessageId =
    normalizeMessageId(parsed.messageId) || safeId(sourceId);
  const providerMessageIdNormalized =
    normalizeMessageId(providerMessageId).toLowerCase();
  const metaSentAt = asString(meta.sentAtIso, "");
  const sentAtIso = isoDate(
    parsed.date ?? parsed.headers.get("date"),
    metaSentAt ? new Date(metaSentAt) : new Date(0),
  );
  const headerTrackingId = headerString(
    parsed.headers.get("x-flu-tracking-id"),
  );
  const pixelTrackingId = extractTrackingIdFromHtml(`${html}\n${text}`);
  // Manual-reply learning capture: mailparser already strips angle brackets from
  // inReplyTo/references, but normalizeMessageId is applied defensively in case a raw
  // fixture/header string still carries them.
  const inReplyTo = normalizeMessageId(parsed.inReplyTo);
  const referencesRaw = Array.isArray(parsed.references)
    ? parsed.references
    : typeof parsed.references === "string"
      ? parsed.references.split(/\s+/)
      : [];
  const references = [...new Set(
    referencesRaw.map((value) => normalizeMessageId(value)).filter(Boolean),
  )].slice(-5);
  const bodyPreview = text.replace(/\s+/g, " ").slice(0, BODY_PREVIEW_CHARS);
  // W117: 전문 저장. 상한을 넘기면 자르되 **잘랐다는 사실을 남긴다** — 조용히 자르면 화면이
  // 잘린 본문을 전문으로 오독한다. bodyHash 는 계속 원문 전체를 해싱한다(멱등 축 불변).
  const bodyTruncated = text.length > MAX_STORED_BODY_CHARS;
  const body = bodyTruncated ? text.slice(0, MAX_STORED_BODY_CHARS) : text;
  return {
    sourceId,
    subject,
    to,
    toMasked: maskEmail(to),
    toHash: emailHash(to),
    fromHash,
    sentAtIso,
    providerMessageId,
    providerMessageIdNormalized,
    headerTrackingId: TRACKING_ID_RE.test(headerTrackingId)
      ? headerTrackingId
      : "",
    pixelTrackingId,
    body,
    bodyTruncated,
    bodyPreview,
    bodyHash: hashHex(text, 32),
    htmlHash: html ? hashHex(html, 32) : "",
    inReplyTo,
    references,
    ...meta,
  };
}

function fixtureMessageToRaw(
  message: Record<string, unknown>,
  index: number,
): Buffer {
  const raw = asString(message.raw, "");
  if (raw) return Buffer.from(raw, "utf8");
  const headers = asRecord(message.headers);
  const subject = asString(message.subject, `Manual sent mail ${index + 1}`);
  const to = asString(message.to, "fixture-recipient@example.test");
  const from = asString(message.from, FIXTURE_SENT_FROM);
  const date = asString(message.sentAtIso, "2000-01-01T00:00:00.000Z");
  const messageId = asString(
    message.providerMessageId,
    `<fixture-${hashHex(`${index}|${to}|${subject}|${date}`, 20)}@example.test>`,
  );
  const html = asString(message.html, "");
  const text = asString(
    message.text,
    html ? textFromHtml(html) : "Fixture body",
  );
  const headerLines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    ...Object.entries(headers)
      .filter(([, value]) => asString(value, ""))
      .map(([key, value]) => `${key}: ${asString(value, "")}`),
    "MIME-Version: 1.0",
    html
      ? 'Content-Type: text/html; charset="UTF-8"'
      : 'Content-Type: text/plain; charset="UTF-8"',
  ];
  return Buffer.from(
    `${headerLines.join("\r\n")}\r\n\r\n${html || text}`,
    "utf8",
  );
}

async function parseFixtureMessages(
  data: Record<string, unknown>,
): Promise<{ rows: ParsedSentMail[]; skipped: ParseSkipCounts }> {
  const rawMessages = Array.isArray(data.messages) ? data.messages : [];
  if (rawMessages.length === 0) return { rows: [], skipped: emptyParseSkipCounts() };
  if (process.env.FUNCTIONS_EMULATOR !== "true") {
    throw failedPrecondition(
      "mail-safety.sent-import-fixtures-emulator-only: fixture messages are rejected outside the Functions emulator.",
    );
  }
  if (rawMessages.length > MAX_FIXTURE_MESSAGES)
    throw invalidArgument(
      `messages can contain at most ${MAX_FIXTURE_MESSAGES} entries`,
    );
  const rows: ParsedSentMail[] = [];
  const skipped = emptyParseSkipCounts();
  for (const [index, entry] of rawMessages.entries()) {
    const record = asRecord(entry);
    const sourceId = safeId(asString(record.sourceId, `fixture-${index + 1}`));
    // W114: 한 통의 파싱 실패가 배치 전체를 막지 않는다 — 건너뛰고 사유를 남긴 뒤 계속한다.
    try {
      rows.push(await parseRawSentMail(fixtureMessageToRaw(record, index), sourceId));
    } catch (error) {
      const reason = classifyParseSkipReason(error);
      addParseSkip(skipped, reason);
      logSkippedParseFailure({ sourceId }, reason);
    }
  }
  return { rows, skipped };
}

function sentCursorDocument(user: string, mailbox: string) {
  return adminDb
    .collection(SENT_CURSOR_COLLECTION)
    .doc(safeId(`imap-sent:${user}:${mailbox}`));
}

function sentScopeFingerprint(input: {
  source: SentSourceMode;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  mailbox?: string;
  maxBytes?: number;
  limit?: number;
  credentialReference?: string;
  runtime?: string;
  mailboxResolution?: "configured" | "server-special-use";
  allowedSentMailboxes?: readonly string[];
  allowedFromHashes?: readonly string[];
  /**
   * Personal-account discriminator. Deliberately omitted for the canonical "scp" scope so
   * every pre-existing fingerprint (preview claims, replay checks, pinned test expectations)
   * stays byte-identical; only personal-account scopes fold their accountId in.
   */
  mailAccountId?: string;
}): string {
  return hashHex(JSON.stringify({
    source: input.source,
    host: input.host ?? "",
    port: input.port ?? 0,
    secure: input.secure ?? false,
    userHash: hashHex(input.user ?? "", 32),
    mailboxHash: hashHex(input.mailbox ?? "", 32),
    maxBytes: input.maxBytes ?? 0,
    limit: input.limit ?? 0,
    credentialReferenceHash: hashHex(input.credentialReference ?? "", 32),
    runtime: input.runtime ?? "",
    mailboxResolution: input.mailboxResolution ?? "configured",
    allowedMailboxHashes: [...(input.allowedSentMailboxes ?? [])]
      .map((mailbox) => hashHex(normalizeMailboxKey(mailbox), 32))
      .sort(),
    allowedFromHashes: [...(input.allowedFromHashes ?? [])].sort(),
    ...(input.mailAccountId && input.mailAccountId !== "scp"
      ? { mailAccountId: input.mailAccountId }
      : {}),
  }), 48);
}

async function resolveSentScope(
  data: Record<string, unknown>,
  expectedSourceMode?: SentSourceMode,
): Promise<ResolvedSentScope> {
  const fixtureMessages = Array.isArray(data.messages) ? data.messages : [];
  if (fixtureMessages.length > 0) {
    if (process.env.FUNCTIONS_EMULATOR !== "true") {
      throw failedPrecondition(
        "mail-safety.sent-import-fixtures-emulator-only: fixture messages are rejected outside the Functions emulator.",
      );
    }
    const allowedFromHashes = approvedFromHashes("", FIXTURE_SENT_FROM);
    return {
      sourceMode: "fixture",
      scopeFingerprint: sentScopeFingerprint({
        source: "fixture",
        runtime: "functions-emulator",
        allowedFromHashes,
      }),
      allowedSentMailboxes: [],
      allowedFromHashes,
      mailAccountId: "scp",
    };
  }

  const emulatorImap = asRecord(data.emulatorImap);
  if (Object.keys(emulatorImap).length > 0) {
    if (process.env.FUNCTIONS_EMULATOR !== "true") {
      throw failedPrecondition(
        "mail-safety.sent-import-emulator-imap-only: the IMAP test adapter is rejected outside the Functions emulator.",
      );
    }
    const host = asString(emulatorImap.host, "imap.emulator.test");
    const port = Math.max(1, Math.trunc(Number(emulatorImap.port ?? 993)));
    const secure = emulatorImap.secure !== false;
    const user = asString(emulatorImap.user, "sent-import-emulator@example.test");
    const allowedSentMailboxes = uniqueMailboxNames([
      ...listStrings(emulatorImap.allowedSentMailboxes),
      ...listStrings(emulatorImap.sentMailboxAllowlist),
    ]);
    const mailbox = selectAllowedSentMailbox(
      asString(data.sentMailbox, "") || emulatorImap.mailbox,
      allowedSentMailboxes.length > 0 ? allowedSentMailboxes : [DEFAULT_SENT_MAILBOX],
    );
    const specialUse = asString(emulatorImap.specialUse, "").trim().toLowerCase();
    if (specialUse !== "\\sent") throw mailboxNotAllowed();
    const allowedFromHashes = approvedFromHashes(
      user,
      emulatorImap.approvedFromAliases,
    );
    if (allowedFromHashes.length === 0) {
      throw codedFailedPrecondition(
        FROM_NOT_ALLOWED_CODE,
        "승인된 발신 계정이 구성되지 않았습니다.",
      );
    }
    const maxBytes = Math.max(64_000, Math.trunc(Number(emulatorImap.maxBytes ?? 262_144)));
    const limit = Math.min(Math.max(Math.trunc(Number(data.limit ?? emulatorImap.limit ?? 20)), 1), 50);
    const credentialReference = asString(emulatorImap.configRevision, "emulator-config-v1");
    return {
      sourceMode: "imap",
      scopeFingerprint: sentScopeFingerprint({
        source: "imap",
        host,
        port,
        secure,
        user,
        mailbox,
        maxBytes,
        limit,
        credentialReference,
        runtime: "functions-emulator-imap",
        allowedSentMailboxes: allowedSentMailboxes.length > 0
          ? allowedSentMailboxes
          : [DEFAULT_SENT_MAILBOX],
        allowedFromHashes,
      }),
      allowedSentMailboxes: allowedSentMailboxes.length > 0
        ? allowedSentMailboxes
        : [DEFAULT_SENT_MAILBOX],
      allowedFromHashes,
      mailAccountId: "scp",
      imap: {
        host,
        port,
        secure,
        user,
        mailbox,
        maxBytes,
        limit,
        emulator: true,
        discoverBySpecialUse: false,
      },
    };
  }

  // A completed fixture token can be replayed without parsing or resubmitting its
  // original fixture body. This branch is emulator-only and performs no mailbox I/O.
  if (expectedSourceMode === "fixture") {
    if (process.env.FUNCTIONS_EMULATOR !== "true") throw previewMismatch();
    const allowedFromHashes = approvedFromHashes("", FIXTURE_SENT_FROM);
    return {
      sourceMode: "fixture",
      scopeFingerprint: sentScopeFingerprint({
        source: "fixture",
        runtime: "functions-emulator",
        allowedFromHashes,
      }),
      allowedSentMailboxes: [],
      allowedFromHashes,
      mailAccountId: "scp",
    };
  }

  if (!liveIntegrationsEnabled("imap"))
    throw failedPrecondition(
      "Live IMAP is disabled in this environment; use dryRun fixture messages in emulator tests.",
    );
  const config = await getRuntimeIntegration("mailImap");
  const host = publicString(config, "host", "IMAP_HOST", "");
  const port = publicNumber(config, "port", "IMAP_PORT", 993);
  const secure = publicBoolean(config, "secure", "IMAP_SECURE", port === 993);
  const user = publicString(config, "username", "IMAP_USER", "");
  const configuredSentMailbox = asString(
    config.public.sentMailbox,
    process.env.IMAP_SENT_MAILBOX ?? "",
  );
  const configuredSentMailboxAllowlist = uniqueMailboxNames([
    ...listStrings(config.public.sentMailboxAllowlist),
    ...listStrings(process.env.IMAP_SENT_MAILBOX_ALLOWLIST),
  ]);
  const discoverBySpecialUse = !configuredSentMailbox
    && configuredSentMailboxAllowlist.length === 0;
  const primarySentMailbox = configuredSentMailbox
    || configuredSentMailboxAllowlist[0]
    || DEFAULT_SENT_MAILBOX;
  const allowedSentMailboxes = uniqueMailboxNames([
    primarySentMailbox,
    ...configuredSentMailboxAllowlist,
  ]);
  const mailbox = selectAllowedSentMailbox(data.sentMailbox, allowedSentMailboxes);
  const allowedFromHashes = approvedFromHashes(
    user,
    process.env.IMAP_SENT_FROM_ALIASES,
  );
  const maxBytes = publicNumber(config, "maxBytes", "IMAP_MAX_BYTES", 262_144);
  const limit = Math.min(Math.max(Math.trunc(Number(data.limit ?? 20)), 1), 50);
  if (!host) throw failedPrecondition("IMAP host is not configured.");
  if (!user) throw failedPrecondition("IMAP username is not configured.");
  if (!mailbox) throw failedPrecondition("IMAP sent mailbox is not configured.");
  if (allowedFromHashes.length === 0) {
    throw codedFailedPrecondition(
      FROM_NOT_ALLOWED_CODE,
      "승인된 발신 계정이 구성되지 않았습니다.",
    );
  }
  const credentialReference = asString(
    asRecord(config.secrets.password).fingerprint,
    process.env.IMAP_PASSWORD ? "env-secret-present" : "",
  );
  return {
    sourceMode: "imap",
    scopeFingerprint: sentScopeFingerprint({
      source: "imap",
      host,
      port,
      secure,
      user,
      mailbox,
      maxBytes,
      limit,
      credentialReference,
      runtime: "functions-live-imap",
      mailboxResolution: discoverBySpecialUse
        ? "server-special-use"
        : "configured",
      allowedSentMailboxes,
      allowedFromHashes,
    }),
    allowedSentMailboxes,
    allowedFromHashes,
    mailAccountId: "scp",
    imap: {
      host,
      port,
      secure,
      user,
      mailbox,
      maxBytes,
      limit,
      emulator: false,
      discoverBySpecialUse,
    },
  };
}

/**
 * Personal-account Sent scope (PLAN-ORG-MAIL-IDENTITY follow-up: personal Sent ingest).
 *
 * The canonical path above can only ever read the runtime `mailImap` integration (scp's
 * mailbox), so a linked personal account's Sent folder never entered the ledger — "did the
 * recipient reply to mail I sent from hesse@…" was unanswerable for anything not sent through
 * scp. This resolver keeps the same fail-closed contract (approved Sent folder + approved From
 * hashes + \Sent server flag) but sources host/auth from `resolveImapConnectionForAccount`
 * (mailImapLive.ts — the same function the inbound account loop uses, so OAuth refresh and
 * env-secret resolution are not re-implemented here).
 *
 * Per-account rules that differ from the canonical scope, deliberately:
 *   - From filter = the account's own mailbox + `imap.sentFromAliases` (public config, comma
 *     separated). The SCP-only `IMAP_SENT_FROM_ALIASES` env var is NEVER consulted here — a
 *     canonical alias must not silently authorize sends from someone's personal mailbox.
 *   - Sent mailbox = `imap.sentMailbox` when configured; workspace_oauth defaults to
 *     "[Gmail]/Sent Mail"; external_smtp_imap with nothing configured falls back to
 *     server-declared \Sent discovery (resolveServerSentMailbox fails closed on ambiguity).
 *   - Cursor doc is namespaced by accountId (`imap-sent:{accountId}:{mailbox}`), not by IMAP
 *     user — two accounts may share a login user on different hosts and must not share a cursor.
 *   - Dedupe stays GLOBAL on provider Message-ID (buildCandidate queries both collections and
 *     `mail_provider_message_uniqueness` by normalized id, none of it connection-scoped) — a
 *     message already imported via SCP is reported `provider_message_duplicate`, not re-written.
 */
export type SentImportAccount = Pick<
  MailAccount,
  "accountId" | "kind" | "mailbox" | "imap" | "secretRef" | "status"
>;

async function resolveSentScopeForAccount(
  account: SentImportAccount,
  data: Record<string, unknown>,
  deps: ResolveImapConnectionForAccountDeps = {},
): Promise<ResolvedSentScope> {
  if (!PERSONAL_MAIL_ACCOUNT_KINDS.has(account.kind)) {
    throw invalidArgument("sent-import account scope requires a personal mail account.");
  }
  if (account.status !== "active") {
    throw codedFailedPrecondition(
      FROM_NOT_ALLOWED_CODE,
      "비활성 메일 계정의 Sent 는 수집하지 않습니다.",
    );
  }
  const imapPublic = asRecord(account.imap);
  const accountFromHashes = approvedFromHashes(
    account.mailbox,
    listStrings(imapPublic.sentFromAliases),
  );
  if (accountFromHashes.length === 0) {
    throw codedFailedPrecondition(
      FROM_NOT_ALLOWED_CODE,
      "승인된 발신 계정이 구성되지 않았습니다.",
    );
  }

  // Raw fixture messages (emulator-only) — same contract as the canonical fixture scope, but
  // the From allowlist is the account's mailbox (+ configured sentFromAliases), never scp's.
  if (Array.isArray(data.messages) && data.messages.length > 0) {
    if (process.env.FUNCTIONS_EMULATOR !== "true") {
      throw failedPrecondition(
        "mail-safety.sent-import-fixtures-emulator-only: fixture messages are rejected outside the Functions emulator.",
      );
    }
    return {
      sourceMode: "fixture",
      scopeFingerprint: sentScopeFingerprint({
        source: "fixture",
        runtime: "functions-emulator-account",
        allowedFromHashes: accountFromHashes,
        mailAccountId: account.accountId,
      }),
      allowedSentMailboxes: [],
      allowedFromHashes: accountFromHashes,
      mailAccountId: account.accountId,
    };
  }

  // Emulator seam — same fixture contract as the canonical scope, but the cursor namespace,
  // From allowlist, and attribution are all derived from the account.
  const emulatorImap = asRecord(data.emulatorImap);
  if (Object.keys(emulatorImap).length > 0) {
    if (process.env.FUNCTIONS_EMULATOR !== "true") {
      throw failedPrecondition(
        "mail-safety.sent-import-emulator-imap-only: the IMAP test adapter is rejected outside the Functions emulator.",
      );
    }
    const host = asString(emulatorImap.host, "imap.emulator.test");
    const port = Math.max(1, Math.trunc(Number(emulatorImap.port ?? 993)));
    const secure = emulatorImap.secure !== false;
    const user = asString(emulatorImap.user, "") || account.mailbox;
    const allowedSentMailboxes = uniqueMailboxNames([
      ...listStrings(emulatorImap.allowedSentMailboxes),
      ...listStrings(emulatorImap.sentMailboxAllowlist),
    ]);
    const mailbox = selectAllowedSentMailbox(
      asString(data.sentMailbox, "") || emulatorImap.mailbox,
      allowedSentMailboxes.length > 0 ? allowedSentMailboxes : [DEFAULT_SENT_MAILBOX],
    );
    const specialUse = asString(emulatorImap.specialUse, "").trim().toLowerCase();
    if (specialUse !== "\\sent") throw mailboxNotAllowed();
    // Emulator fixtures may additionally name approvedFromAliases so tests can simulate a
    // configured alias; the account's own mailbox always stays the primary identity.
    const allowedFromHashes = [
      ...new Set([
        ...accountFromHashes,
        ...approvedFromHashes("", emulatorImap.approvedFromAliases),
      ]),
    ].sort();
    const maxBytes = Math.max(64_000, Math.trunc(Number(emulatorImap.maxBytes ?? 262_144)));
    const limit = Math.min(Math.max(Math.trunc(Number(data.limit ?? emulatorImap.limit ?? 20)), 1), 50);
    const credentialReference = asString(emulatorImap.configRevision, "emulator-config-v1");
    return {
      sourceMode: "imap",
      scopeFingerprint: sentScopeFingerprint({
        source: "imap",
        host,
        port,
        secure,
        user,
        mailbox,
        maxBytes,
        limit,
        credentialReference,
        runtime: "functions-emulator-imap-account",
        allowedSentMailboxes: allowedSentMailboxes.length > 0
          ? allowedSentMailboxes
          : [DEFAULT_SENT_MAILBOX],
        allowedFromHashes,
        mailAccountId: account.accountId,
      }),
      allowedSentMailboxes: allowedSentMailboxes.length > 0
        ? allowedSentMailboxes
        : [DEFAULT_SENT_MAILBOX],
      allowedFromHashes,
      mailAccountId: account.accountId,
      imap: {
        host,
        port,
        secure,
        user,
        mailbox,
        maxBytes,
        limit,
        emulator: true,
        discoverBySpecialUse: false,
        cursorUser: account.accountId,
      },
    };
  }

  if (!liveIntegrationsEnabled("imap")) {
    throw failedPrecondition(
      "Live IMAP is disabled in this environment; use dryRun fixture messages in emulator tests.",
    );
  }
  // Connection+auth come from the shared resolver — workspace_oauth gets the Gmail defaults
  // and a fresh access token, external_smtp_imap gets its public config + named env secret.
  // The resolved `connection.mailbox` is the account's INBOX and is intentionally ignored:
  // Sent is selected below, never the inbox.
  const connection = await resolveImapConnectionForAccount(account, deps);
  const user = connection.auth.user;
  const host = connection.host;
  const port = connection.port;
  const secure = connection.secure;
  const maxBytes = Math.max(64_000, connection.maxBytes);
  const limit = Math.min(Math.max(Math.trunc(Number(data.limit ?? 20)), 1), 50);
  const configuredSentMailbox = asString(imapPublic.sentMailbox, "");
  const configuredAllowlist = uniqueMailboxNames(listStrings(imapPublic.sentMailboxAllowlist));
  const requestedSentMailbox = asString(data.sentMailbox, "");
  // No configured hint at all -> let the server declare its single \Sent folder (the same
  // discovery the canonical scope uses). For Gmail (workspace_oauth) that IS
  // "[Gmail]/Sent Mail"; for Dovecot/Exchange it is whatever the server flags, so no
  // provider-specific constant is needed here. A configured or requested value must exist on
  // the server AND carry \Sent — resolveServerSentMailbox enforces both, failing closed.
  const discoverBySpecialUse = !configuredSentMailbox
    && !requestedSentMailbox
    && configuredAllowlist.length === 0;
  const allowedSentMailboxes = uniqueMailboxNames([
    configuredSentMailbox || requestedSentMailbox || configuredAllowlist[0] || "",
    ...configuredAllowlist,
    ...(requestedSentMailbox ? [requestedSentMailbox] : []),
  ]);
  const mailbox = discoverBySpecialUse
    ? ""
    : selectAllowedSentMailbox(requestedSentMailbox, allowedSentMailboxes);
  if (!host) throw failedPrecondition("IMAP host is not configured for this mail account.");
  if (!user) throw failedPrecondition("IMAP username is not configured for this mail account.");
  if (!mailbox && !discoverBySpecialUse) {
    throw failedPrecondition("IMAP sent mailbox is not configured for this mail account.");
  }
  return {
    sourceMode: "imap",
    scopeFingerprint: sentScopeFingerprint({
      source: "imap",
      host,
      port,
      secure,
      user,
      mailbox,
      maxBytes,
      limit,
      credentialReference: account.secretRef,
      runtime: "functions-live-imap-account",
      mailboxResolution: discoverBySpecialUse ? "server-special-use" : "configured",
      allowedSentMailboxes,
      allowedFromHashes: accountFromHashes,
      mailAccountId: account.accountId,
    }),
    allowedSentMailboxes,
    allowedFromHashes: accountFromHashes,
    mailAccountId: account.accountId,
    imap: {
      host,
      port,
      secure,
      user,
      mailbox,
      maxBytes,
      limit,
      emulator: false,
      discoverBySpecialUse,
      auth: { user, pass: connection.auth.pass, accessToken: connection.auth.accessToken },
      cursorUser: account.accountId,
    },
  };
}

function cursorFromSnapshot(
  snapshot: FirebaseFirestore.DocumentSnapshot,
  input: { nextLastUid: number; uidValidity: string; mailbox: string; user: string },
): NonNullable<SentReadResult["cursor"]> {
  const cursorData = asRecord(snapshot.data());
  return {
    refPath: snapshot.ref.path,
    nextLastUid: input.nextLastUid,
    expectedExists: snapshot.exists,
    expectedLastUid: Math.max(0, Math.trunc(Number(cursorData.lastUid ?? 0) || 0)),
    expectedUidValidity: asString(cursorData.uidValidity, ""),
    expectedVersion: cursorDocumentVersion(cursorData),
    expectedStateHash: cursorStateHash(snapshot.exists, cursorData),
    uidValidity: input.uidValidity,
    mailbox: input.mailbox,
    user: input.user,
  };
}

async function readEmulatorSentMailboxMessages(
  data: Record<string, unknown>,
  scope: ResolvedSentScope,
  window?: SentReadWindow,
): Promise<SentReadResult> {
  const imap = scope.imap;
  if (!imap?.emulator || process.env.FUNCTIONS_EMULATOR !== "true") throw previewMismatch();
  const emulatorImap = asRecord(data.emulatorImap);
  if (emulatorImap.failIfRead === true) {
    throw failedPrecondition("mail-safety.sent-import-emulator-imap-read-forbidden");
  }
  const runtimeFailureStage = asString(emulatorImap.runtimeFailureStage, "");
  if (runtimeFailureStage) {
    if (!["connect", "list", "open", "search", "fetch", "logout"].includes(runtimeFailureStage)) {
      throw invalidArgument("emulatorImap.runtimeFailureStage is invalid");
    }
    throw imapRuntimeFailure(
      runtimeFailureStage as ImapRuntimeStage,
      new Error(asString(emulatorImap.runtimeFailureMessage, "emulated IMAP runtime failure")),
    );
  }
  const uidValidity = asString(emulatorImap.uidValidity, "1");
  const cursorUser = imap.cursorUser ?? imap.user;
  const cursorRef = sentCursorDocument(cursorUser, imap.mailbox);
  // W117: 백필 창이 오면 편입 커서 문서를 아예 만지지 않는다(읽지도 쓰지도 않는다) —
  // 백필이 편입 진행률을 흔들면 아직 편입되지 않은 메일이 조용히 건너뛰어진다.
  const cursorSnapshot = window ? undefined : await cursorRef.get();
  const cursorData = asRecord(cursorSnapshot?.data());
  const expectedLastUid = Math.max(0, Math.trunc(Number(cursorData.lastUid ?? 0) || 0));
  const lastUid = window
    ? window.afterUid
    : asString(cursorData.uidValidity, "") === uidValidity ? expectedLastUid : 0;
  const rawMessages = Array.isArray(emulatorImap.messages) ? emulatorImap.messages : [];
  if (rawMessages.length > MAX_FIXTURE_MESSAGES) {
    throw invalidArgument(`emulatorImap.messages can contain at most ${MAX_FIXTURE_MESSAGES} entries`);
  }
  const entries = rawMessages.map((entry, index) => ({
    record: asRecord(entry),
    index,
    uid: Math.max(1, Math.trunc(Number(asRecord(entry).uid ?? index + 1))),
  })).filter((entry) => entry.uid > lastUid)
    .sort((left, right) => left.uid - right.uid)
    .slice(0, imap.limit);
  const rows: ParsedSentMail[] = [];
  const skipped = emptyParseSkipCounts();
  let maxUid = lastUid;
  for (const entry of entries) {
    // W114: maxUid 는 파싱 성공 여부와 무관하게 "이 UID 를 봤다"를 기록한다 — 이래야
    // 건너뛴 메일도 커서가 넘어가고, 다음 회차가 같은 UID 를 영원히 재시도하지 않는다.
    maxUid = Math.max(maxUid, entry.uid);
    const sourceId = safeId(`imap-${imap.mailbox}-${uidValidity}-${entry.uid}`);
    try {
      rows.push(await parseRawSentMail(
        fixtureMessageToRaw(entry.record, entry.index),
        sourceId,
        { uid: entry.uid, mailbox: imap.mailbox, uidValidity },
      ));
    } catch (error) {
      const reason = classifyParseSkipReason(error);
      addParseSkip(skipped, reason);
      logSkippedParseFailure({ uid: entry.uid }, reason);
    }
  }
  const scan = { uidValidity, maxUid };
  if (!cursorSnapshot) {
    return { rows, sourceMode: "imap", scopeFingerprint: scope.scopeFingerprint, skipped, scan };
  }
  const cursor = cursorFromSnapshot(cursorSnapshot, {
    nextLastUid: maxUid,
    uidValidity,
    mailbox: imap.mailbox,
    user: cursorUser,
  });
  if (emulatorImap.mutateCursorAfterRead === true && data.dryRun === false) {
    const driftLastUid = Math.max(
      cursor.expectedLastUid + 1,
      Math.trunc(Number(emulatorImap.driftLastUid ?? cursor.nextLastUid + 1)),
    );
    await cursorRef.set({
      version: cursor.expectedVersion + 1,
      lastUid: driftLastUid,
      uidValidity,
      mailbox: imap.mailbox,
      user: cursorUser,
      source: "external_sent_mail_import_emulator_drift",
      updatedBy: "emulator-drift",
    }, { merge: true });
  }
  return { rows, sourceMode: "imap", scopeFingerprint: scope.scopeFingerprint, skipped, cursor, scan };
}

async function readSentMailboxMessages(
  data: Record<string, unknown>,
  scope: ResolvedSentScope,
  window?: SentReadWindow,
): Promise<SentReadResult> {
  if (scope.sourceMode !== "imap" || !scope.imap) throw previewMismatch();
  if (scope.imap.emulator) return readEmulatorSentMailboxMessages(data, scope, window);
  const {
    host,
    port,
    secure,
    user,
    mailbox: selectedMailbox,
    maxBytes,
    limit,
    discoverBySpecialUse,
  } = scope.imap;
  // Canonical SCP keeps its historical lazy IMAP_PASSWORD read; personal-account scopes carry
  // pre-resolved auth (OAuth accessToken or the account's env secret) from
  // resolveSentScopeForAccount so no second secret lookup — and no IMAP_PASSWORD — is needed.
  const auth = scope.imap.auth ?? { user, pass: requireEnvSecret("IMAP_PASSWORD", "IMAP") };
  const cursorUser = scope.imap.cursorUser ?? user;
  const client = new ImapFlow({
    host,
    port,
    secure,
    auth,
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    maxLiteralSize: Math.max(64_000, maxBytes),
  });
  await runImapRuntimeOperation("connect", () => client.connect());
  try {
    const listedMailboxes: Awaited<ReturnType<ImapFlow["list"]>> =
      await runImapRuntimeOperation("list", () => client.list());
    const mailbox = resolveServerSentMailbox({
      selectedMailbox,
      discoverBySpecialUse,
      listedMailboxes,
    });
    const opened = await runImapRuntimeOperation(
      "open",
      () => client.mailboxOpen(mailbox, { readOnly: true }),
    );
    const uidValidity = opened.uidValidity.toString();
    // W117: 백필 창이 오면 편입 커서를 읽지도 쓰지도 않는다 — 두 레인이 같은 커서를 공유하면
    // 백필이 편입 진행률을 앞당겨 아직 편입 안 된 메일을 영영 건너뛴다.
    const cursorSnapshot = window
      ? undefined
      : await sentCursorDocument(cursorUser, mailbox).get();
    const cursorData = asRecord(cursorSnapshot?.data());
    const lastUid = window
      ? window.afterUid
      : asString(cursorData.uidValidity, "") === uidValidity
        ? Number(cursorData.lastUid ?? 0)
        : 0;
    const found = await runImapRuntimeOperation(
      "search",
      () => client.search(
        { uid: `${Math.max(1, lastUid + 1)}:*` },
        { uid: true },
      ),
    );
    const uids = (Array.isArray(found) ? found : [])
      .filter((uid) => uid > lastUid)
      .sort((a, b) => a - b)
      .slice(0, limit);
    const rows: ParsedSentMail[] = [];
    const skipped = emptyParseSkipCounts();
    let maxUid = lastUid;
    for (const uid of uids) {
      // W114: maxUid 갱신은 fetch/parse 결과와 무관하게 먼저 일어난다 — 이 UID 를 건너뛰어도
      // 커서는 지나쳐야 다음 회차가 같은 UID 를 영원히 재시도하지 않는다.
      maxUid = Math.max(maxUid, uid);
      // fetch 는 IMAP 서버 접근이다(runImapRuntimeOperation 로 감쌈) — 실패하면 시스템 레벨
      // 문제로 취급해 그대로 던진다. 여기서 잡지 않는다.
      const fetched = await runImapRuntimeOperation(
        "fetch",
        () => client.fetchOne(
          String(uid),
          { uid: true, source: { maxLength: maxBytes }, internalDate: true },
          { uid: true },
        ),
      );
      if (!fetched || !fetched.source) {
        addParseSkip(skipped, "unparseable");
        logSkippedParseFailure({ uid }, "unparseable");
        continue;
      }
      const sourceId = safeId(`imap-${mailbox}-${uidValidity}-${uid}`);
      // 여기부터는 이미 받은 바이트를 "해석"하는 단계다 — 이 메일 내용의 문제이므로 건너뛴다.
      try {
        rows.push(
          await parseRawSentMail(fetched.source, sourceId, {
            uid,
            mailbox,
            uidValidity,
            ...(fetched.internalDate instanceof Date
              ? { sentAtIso: fetched.internalDate.toISOString() }
              : {}),
          }),
        );
      } catch (error) {
        const reason = classifyParseSkipReason(error);
        addParseSkip(skipped, reason);
        logSkippedParseFailure({ uid }, reason);
      }
    }
    return {
      rows,
      sourceMode: "imap",
      scopeFingerprint: scope.scopeFingerprint,
      skipped,
      scan: { uidValidity, maxUid },
      ...(cursorSnapshot
        ? {
          cursor: cursorFromSnapshot(cursorSnapshot, {
            nextLastUid: maxUid,
            uidValidity,
            mailbox,
            user: cursorUser,
          }),
        }
        : {}),
    };
  } finally {
    try {
      await client.logout();
    } catch (error) {
      imapRuntimeFailure("logout", error);
    }
  }
}

/**
 * Manual-reply learning capture — pairs a Sent-folder message to the specific inbound
 * `message_sources` doc it replies to, using the raw (un-lowercased, bracket-stripped)
 * `providerMessageId` inbound writers keep (functions/chat-ai.ts receiveEmail). Tries
 * `In-Reply-To` first, then each `References` id from most-recent to oldest. Equality-
 * only query (`direction` + `providerMessageId`), no composite index needed.
 *
 * Cold-outreach/templated sends carry neither header and rarely start a subject with
 * "Re:" (they open a new thread), so this read is skipped entirely for the common case.
 */
async function pairInboundForReply(
  parsed: ParsedSentMail,
): Promise<{ kind: "manual_reply" | ""; pairedInboundMessageSourceId: string }> {
  const isReplyShapedSubject = /^re[:：]/i.test(parsed.subject.trim());
  const candidateIds = [parsed.inReplyTo, ...[...parsed.references].reverse()].filter(Boolean);
  if (candidateIds.length === 0) {
    return { kind: isReplyShapedSubject ? "manual_reply" : "", pairedInboundMessageSourceId: "" };
  }
  for (const candidateId of candidateIds) {
    const snapshot = await adminDb.collection(MESSAGE_SOURCES_COLLECTION)
      .where("direction", "==", "inbound")
      .where("providerMessageId", "==", candidateId)
      .limit(1)
      .get();
    if (!snapshot.empty) {
      return { kind: "manual_reply", pairedInboundMessageSourceId: snapshot.docs[0].id };
    }
  }
  // A real In-Reply-To/References header is still a reliable reply signal even when the
  // referenced inbound row can't be found (e.g. imported before this feature shipped).
  return { kind: "manual_reply", pairedInboundMessageSourceId: "" };
}

async function buildCandidate(
  parsed: ParsedSentMail,
  mailAccountId = "scp",
): Promise<ImportCandidate> {
  const trustedTracking = TRACKING_ID_RE.test(parsed.headerTrackingId);
  const proposedTrackingId = trustedTracking
    ? parsed.headerTrackingId
    : stableExternalTrackingId(parsed);
  const canonicalProviderMessageIdHash = providerMessageIdHash(parsed.providerMessageIdNormalized);
  const providerUniquenessHash = providerMessageIdHash(parsed.providerMessageIdNormalized, 40);
  const providerUniquenessRef = providerUniquenessDocument(parsed.providerMessageIdNormalized);
  const [
    providerSourceHashQuery,
    providerSourceNormalizedQuery,
    providerSourceLegacyQuery,
    providerOutboxHashQuery,
    providerOutboxNormalizedQuery,
    providerOutboxLegacyQuery,
    providerUniquenessSnapshot,
  ] = await Promise.all([
    adminDb.collection(MESSAGE_SOURCES_COLLECTION)
      .where("providerMessageIdHash", "==", canonicalProviderMessageIdHash)
      .get(),
    adminDb.collection(MESSAGE_SOURCES_COLLECTION)
      .where("providerMessageIdNormalized", "==", parsed.providerMessageIdNormalized)
      .get(),
    adminDb.collection(MESSAGE_SOURCES_COLLECTION)
      .where("providerMessageId", "==", parsed.providerMessageId)
      .get(),
    adminDb.collection(OUTBOX_COLLECTION)
      .where("providerMessageIdHash", "==", canonicalProviderMessageIdHash)
      .get(),
    adminDb.collection(OUTBOX_COLLECTION)
      .where("providerMessageIdNormalized", "==", parsed.providerMessageIdNormalized)
      .get(),
    adminDb.collection(OUTBOX_COLLECTION)
      .where("providerMessageId", "==", parsed.providerMessageId)
      .get(),
    providerUniquenessRef.get(),
  ]);
  const providerSourceDocs = [...new Map([
    ...providerSourceHashQuery.docs,
    ...providerSourceNormalizedQuery.docs,
    ...providerSourceLegacyQuery.docs,
  ].map((doc) => [doc.ref.path, doc])).values()].filter((doc) => {
    const data = asRecord(doc.data());
    return asString(data.direction, "") === "outbound"
      || asString(data.source, "") === "external_sent_mail_import";
  });
  const providerOutboxDocs = [...new Map([
    ...providerOutboxHashQuery.docs,
    ...providerOutboxNormalizedQuery.docs,
    ...providerOutboxLegacyQuery.docs,
  ].map((doc) => [doc.ref.path, doc])).values()];
  const providerUniquenessData = asRecord(providerUniquenessSnapshot.data());
  const providerTrackingIds = [...new Set([
    asString(providerUniquenessData.trackingId, ""),
    ...providerSourceDocs.map((doc) => asString(doc.data().trackingId, "")),
    ...providerOutboxDocs.map((doc) => asString(doc.data().trackingId, doc.id)),
  ].filter((value) => TRACKING_ID_RE.test(value)))].sort();
  let unsafe = false;
  let skipReason = "";
  if (new Set(providerTrackingIds).size > 1) {
    unsafe = true;
    skipReason = "provider_message_ledger_conflict";
  }
  const trackingId = providerTrackingIds[0] ?? proposedTrackingId;
  const outboxRef = adminDb.collection(OUTBOX_COLLECTION).doc(trackingId);
  const providerOutboxDoc = providerOutboxDocs.find((doc) => doc.ref.path === outboxRef.path);
  const existingOutbox = providerOutboxDoc
    ? providerOutboxDoc
    : await outboxRef.get();
  const existing = existingOutbox.exists ? asRecord(existingOutbox.data()) : {};
  const existingToHash = asString(existing.toHash, "");
  const existingFromHash = asString(existing.fromHash, "");
  const existingSubject = asString(existing.subject, "");
  const existingProviderMessageId = normalizeMessageId(
    asString(existing.providerMessageIdNormalized, asString(existing.providerMessageId, "")),
  ).toLowerCase();
  const existingProviderMessageIdHash = asString(existing.providerMessageIdHash, "").toLowerCase();
  const providerToHashes = [
    asString(providerUniquenessData.recipientHash, ""),
    ...providerSourceDocs.map((doc) => asString(doc.data().toHash, "")),
    ...providerOutboxDocs.map((doc) => asString(doc.data().toHash, "")),
  ].filter(Boolean);
  if (!unsafe && providerToHashes.some((value) => value !== parsed.toHash)) {
    unsafe = true;
    skipReason = "provider_message_recipient_mismatch";
  }
  const providerFromHashes = [
    ...providerSourceDocs.map((doc) => asString(doc.data().fromHash, "")),
    ...providerOutboxDocs.map((doc) => asString(doc.data().fromHash, "")),
  ].filter(Boolean);
  if (!unsafe && providerFromHashes.some((value) => value !== parsed.fromHash)) {
    unsafe = true;
    skipReason = "provider_message_from_mismatch";
  }
  if (!unsafe && trustedTracking && trackingId === proposedTrackingId && existingOutbox.exists) {
    if (existingToHash && existingToHash !== parsed.toHash) {
      unsafe = true;
      skipReason = "tracking_recipient_mismatch";
    } else if (existingProviderMessageId && existingProviderMessageId !== parsed.providerMessageIdNormalized) {
      unsafe = true;
      skipReason = "tracking_provider_message_id_mismatch";
    } else if (
      !existingProviderMessageId
      && existingProviderMessageIdHash
      && existingProviderMessageIdHash !== canonicalProviderMessageIdHash
    ) {
      unsafe = true;
      skipReason = "tracking_provider_message_id_mismatch";
    }
  }
  const sourceRef = adminDb
    .collection(MESSAGE_SOURCES_COLLECTION)
    .doc(safeId(`external-sent-${trackingId}`));
  const providerSourceDoc = providerSourceDocs.find((doc) => doc.ref.path === sourceRef.path)
    ?? providerSourceDocs[0];
  const existingMessageSource = providerSourceDoc?.ref.path === sourceRef.path
    ? providerSourceDoc
    : await sourceRef.get();
  const existingMessageSourceData = existingMessageSource.exists
    ? asRecord(existingMessageSource.data())
    : {};
  /**
   * W117-R2 (프로드 실측 2026-08-24) — **다른 레인의 원장 행을 편입 행으로 덮지 않는다.**
   *
   * ■ 실제로 일어난 경로 (이 파일의 라인으로 확정)
   *   :1262-1266 `providerTrackingIds` 는 Message-ID 로 찾은 **아웃박스 행의 trackingId(없으면 doc id)**
   *   까지 후보에 넣는다. :1273 `const trackingId = providerTrackingIds[0] ?? proposedTrackingId` 가
   *   그 값을 채택하므로, 툴이 이미 보낸 메일의 Sent 사본을 읽으면 trackingId 가 툴 행 id
   *   (`application-confirmed-…`)가 된다. :1304 의 안전 분기는 `trackingId === proposedTrackingId`
   *   일 때만 도는 탓에 이 경로를 보지 못한다.
   *   그 다음 `completeOutbox` 는 `existingFromHash === parsed.fromHash` 를 요구하는데
   *   툴 원장 쓰기(mailSignature.recordMailOutboundLog)는 **fromHash 를 쓰지 않는다** —
   *   그래서 항상 false → `needsOutboxWrite` true → merge 쓰기가 그 행의 `source` 를
   *   `external_sent_mail_import` 로 **덮었다**. 반면 `needsMessageSourceWrite` 는
   *   `providerSourceDocs.length === 0 && !existingMessageSource.exists` 가 거짓이라 false 였다.
   *   결과가 정확히 프로드 표본의 형상이다: 툴 doc id + source=external + `external-sent-{tid}` 문서 부재.
   *
   * ■ 판별축은 "이 레인이 만든 소스 문서가 있는가"다
   *   레거시 편입 행(source=legacy_sent_import 등)도 이 레인의 것이며 `external-sent-{tid}` 문서를
   *   갖는다 — 그건 계속 마이그레이션되어야 한다(테스트로 봉인돼 있다). 그래서 소스 문서 부재를
   *   1차 조건으로 두고, 거기에 **임포터가 결코 쓰지 않는 필드**의 존재를 증거로 더한다.
   *   둘 다 맞으면 이미 원장에 있는 발송이므로 아무것도 쓰지 않고 중복으로 남긴다.
   */
  const toolLaneEvidenceFields = [
    "deliverySource",
    "conversationId",
    "approvalRef",
    "compiledHash",
    "contentHash",
    "subjectHash",
    "providerConfirmed",
    "acceptedCount",
    "persisted",
  ] as const;
  const foreignLedgerRow = Boolean(
    existingOutbox.exists
    && !existingMessageSource.exists
    && toolLaneEvidenceFields.some((field) =>
      Object.prototype.hasOwnProperty.call(existing, field)),
  );

  const existingMessageSourceHasRawProviderId = Object.prototype.hasOwnProperty.call(
    existingMessageSourceData,
    "providerMessageId",
  ) || Object.prototype.hasOwnProperty.call(existingMessageSourceData, "providerMessageIdNormalized");
  const completeMessageSourceProviderIdentity = Boolean(
    existingMessageSource.exists
    && asString(existingMessageSourceData.providerMessageIdHash, "") === canonicalProviderMessageIdHash
    && !existingMessageSourceHasRawProviderId,
  );
  const providerMessageAlreadyKnown = Boolean(
    providerSourceDocs.length > 0
    || providerOutboxDocs.length > 0
    || providerUniquenessSnapshot.exists,
  );
  const completeOutbox = Boolean(
    existingOutbox.exists &&
    asString(existing.sentAtIso, "") &&
    asString(existing.deliveryState, "") &&
    existingFromHash === parsed.fromHash &&
    (existingSubject || asString(existing.subjectHash, "")) &&
    (existingToHash ||
      asString(existing.toMasked, "") ||
      asString(existing.to, "")) &&
    existingProviderMessageIdHash === canonicalProviderMessageIdHash &&
    !Object.prototype.hasOwnProperty.call(existing, "providerMessageId") &&
    !Object.prototype.hasOwnProperty.call(existing, "providerMessageIdNormalized"),
  );
  const completeProviderUniqueness = Boolean(
    providerUniquenessSnapshot.exists
    && asString(providerUniquenessData.schemaVersion, "") === "mail-provider-message-uniqueness-v2"
    && asString(providerUniquenessData.providerMessageIdHash, "") === providerUniquenessHash
    && !Object.prototype.hasOwnProperty.call(providerUniquenessData, "providerMessageId")
    && !Object.prototype.hasOwnProperty.call(providerUniquenessData, "providerMessageIdNormalized"),
  );
  const assertionSnapshots = [
    providerUniquenessSnapshot,
    ...providerSourceDocs,
    ...providerOutboxDocs,
    existingOutbox,
    existingMessageSource,
  ];
  const ledgerAssertions = [...new Map(assertionSnapshots.map((snapshot) => {
    const data = asRecord(snapshot.data());
    return [snapshot.ref.path, {
      path: snapshot.ref.path,
      stateHash: ledgerStateHash(snapshot.exists, data),
    }] as const;
  })).values()].sort((left, right) => left.path.localeCompare(right.path));
  const providerQueryAssertions: ImportCandidate["providerQueryAssertions"] = [
    {
      collection: MESSAGE_SOURCES_COLLECTION,
      field: "providerMessageIdHash" as const,
      value: canonicalProviderMessageIdHash,
      resultHash: queryResultHash(providerSourceHashQuery.docs),
    },
    {
      collection: MESSAGE_SOURCES_COLLECTION,
      field: "providerMessageIdNormalized" as const,
      value: parsed.providerMessageIdNormalized,
      resultHash: queryResultHash(providerSourceNormalizedQuery.docs),
    },
    {
      collection: MESSAGE_SOURCES_COLLECTION,
      field: "providerMessageId" as const,
      value: parsed.providerMessageId,
      resultHash: queryResultHash(providerSourceLegacyQuery.docs),
    },
    {
      collection: OUTBOX_COLLECTION,
      field: "providerMessageIdHash" as const,
      value: canonicalProviderMessageIdHash,
      resultHash: queryResultHash(providerOutboxHashQuery.docs),
    },
    {
      collection: OUTBOX_COLLECTION,
      field: "providerMessageIdNormalized" as const,
      value: parsed.providerMessageIdNormalized,
      resultHash: queryResultHash(providerOutboxNormalizedQuery.docs),
    },
    {
      collection: OUTBOX_COLLECTION,
      field: "providerMessageId" as const,
      value: parsed.providerMessageId,
      resultHash: queryResultHash(providerOutboxLegacyQuery.docs),
    },
  ];
  const replyPairing = await pairInboundForReply(parsed);
  return {
    ...parsed,
    trackingId,
    idempotencyKey: hashHex(
      `${trackingId}|${parsed.providerMessageIdNormalized}|${parsed.toHash}|${parsed.fromHash}|${parsed.sentAtIso}`,
      32,
    ),
    source: "external_sent_mail_import",
    mailType: "manual_external_gmail",
    mailAccountId,
    kind: replyPairing.kind,
    pairedInboundMessageSourceId: replyPairing.pairedInboundMessageSourceId,
    attributedMailAccountId: asString(existing.mailAccountId, "")
      || asString(existingMessageSourceData.mailAccountId, "")
      || mailAccountId,
    trustedTracking,
    unsafe,
    skipReason,
    duplicateReason: foreignLedgerRow
      ? "already_recorded_by_other_lane"
      : providerMessageAlreadyKnown ? "provider_message_duplicate" : "",
    existingOutboxPath: existingOutbox.exists ? existingOutbox.ref.path : undefined,
    existingMessageSourcePath: providerSourceDoc?.ref.path ?? (existingMessageSource.exists
      ? sourceRef.path
      : undefined),
    needsOutboxWrite: !unsafe && !foreignLedgerRow && !completeOutbox,
    needsMessageSourceWrite: !unsafe && !foreignLedgerRow && (
      (providerSourceDocs.length === 0 && !existingMessageSource.exists)
      || (existingMessageSource.exists
        && existingMessageSource.ref.path === sourceRef.path
        && !completeMessageSourceProviderIdentity)
    ),
    // 다른 레인의 발송에 이 레인 이름으로 uniqueness 를 남기면 그것도 거짓 기록이다.
    needsProviderUniquenessWrite: !unsafe && !foreignLedgerRow && !completeProviderUniqueness,
    providerUniquenessExists: providerUniquenessSnapshot.exists,
    providerUniquenessPath: providerUniquenessRef.path,
    ledgerAssertions,
    providerQueryAssertions,
  };
}

function dedupeBatchCandidates(candidates: ImportCandidate[]): ImportCandidate[] {
  const recipientSets = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const recipients = recipientSets.get(candidate.providerMessageIdNormalized) ?? new Set<string>();
    recipients.add(candidate.toHash);
    recipientSets.set(candidate.providerMessageIdNormalized, recipients);
  }
  const unsafeProviderIds = new Set([...recipientSets.entries()]
    .filter(([, recipients]) => recipients.size > 1)
    .map(([providerMessageId]) => providerMessageId));
  const byProviderMessageId = new Map<string, ImportCandidate>();
  return candidates.map((candidate) => {
    if (unsafeProviderIds.has(candidate.providerMessageIdNormalized)) {
      return {
        ...candidate,
        unsafe: true,
        skipReason: "provider_message_recipient_mismatch",
        needsOutboxWrite: false,
        needsMessageSourceWrite: false,
        needsProviderUniquenessWrite: false,
      };
    }
    const existing = byProviderMessageId.get(candidate.providerMessageIdNormalized);
    if (!existing) {
      byProviderMessageId.set(candidate.providerMessageIdNormalized, candidate);
      return candidate;
    }
    return {
      ...candidate,
      trackingId: existing.trackingId,
      idempotencyKey: existing.idempotencyKey,
      unsafe: candidate.unsafe || existing.unsafe,
      skipReason: candidate.skipReason || existing.skipReason,
      duplicateReason: "provider_message_duplicate",
      existingOutboxPath: existing.existingOutboxPath,
      existingMessageSourcePath: existing.existingMessageSourcePath,
      needsOutboxWrite: false,
      needsMessageSourceWrite: false,
      needsProviderUniquenessWrite: false,
      providerUniquenessExists: existing.providerUniquenessExists,
      providerUniquenessPath: existing.providerUniquenessPath,
      ledgerAssertions: existing.ledgerAssertions,
    };
  });
}

function requestFingerprintFor(
  actorUid: string,
  actorRole: string,
  parsedRows: ParsedSentMail[],
  scopeFingerprint: string,
  issuedAtIso: string,
  expiresAtIso: string,
  cursor?: SentReadResult["cursor"],
): string {
  const material = {
    version: PREVIEW_TOKEN_VERSION,
    actorHash: hashHex(actorUid, 32),
    actorRole,
    issuedAtIso,
    expiresAtIso,
    scopeFingerprint,
    rows: parsedRows.map((row) => ({
      sourceIdHash: hashHex(row.sourceId, 32),
      subjectHash: hashHex(row.subject, 64),
      toHash: row.toHash,
      fromHash: row.fromHash,
      sentAtIso: row.sentAtIso,
      providerMessageIdExactHash: hashHex(row.providerMessageId, 64),
      providerMessageIdCanonicalHash: providerMessageIdHash(row.providerMessageIdNormalized),
      headerTrackingIdHash: hashHex(row.headerTrackingId, 32),
      pixelTrackingIdHash: hashHex(row.pixelTrackingId, 32),
      bodyHash: row.bodyHash,
      htmlHash: row.htmlHash,
      uid: row.uid ?? null,
      mailboxHash: hashHex(row.mailbox ?? "", 32),
      uidValidityHash: hashHex(row.uidValidity ?? "", 32),
    })),
    cursor: cursor
      ? {
        refHash: hashHex(cursor.refPath, 32),
        nextLastUid: cursor.nextLastUid,
        expectedExists: cursor.expectedExists,
        expectedLastUid: cursor.expectedLastUid,
        expectedUidValidityHash: hashHex(cursor.expectedUidValidity, 32),
        expectedVersion: cursor.expectedVersion,
        expectedStateHash: cursor.expectedStateHash,
        uidValidityHash: hashHex(cursor.uidValidity, 16),
        mailboxHash: hashHex(cursor.mailbox, 32),
        userHash: hashHex(cursor.user, 32),
      }
      : undefined,
  };
  return hashHex(JSON.stringify(material), 64);
}

function shouldWriteCursor(cursor: NonNullable<SentReadResult["cursor"]>): boolean {
  return !cursor.expectedExists
    || cursor.nextLastUid !== cursor.expectedLastUid
    || cursor.uidValidity !== cursor.expectedUidValidity;
}

function candidateWritePlanMaterial(
  candidate: ImportCandidate,
  context: { actorUid: string; actorRole: string; runId: string; importedAtIso: string },
) {
  const sourceId = safeId(`external-sent-${candidate.trackingId}`);
  const sourceRefPath = `${MESSAGE_SOURCES_COLLECTION}/${sourceId}`;
  return {
    trackingId: candidate.trackingId,
    idempotencyKey: candidate.idempotencyKey,
    unsafe: candidate.unsafe,
    skipReason: candidate.skipReason,
    duplicateReason: candidate.duplicateReason,
    assertions: candidate.ledgerAssertions,
    providerQueryAssertions: candidate.providerQueryAssertions.map((assertion) => ({
      collection: assertion.collection,
      field: assertion.field,
      valueHash: hashHex(assertion.value, 64),
      resultHash: assertion.resultHash,
    })),
    outbox: {
      write: !candidate.unsafe && candidate.needsOutboxWrite,
      pathHash: hashHex(`${OUTBOX_COLLECTION}/${candidate.trackingId}`, 40),
      merge: true,
      fields: {
        trackingId: candidate.trackingId,
        toValueHash: hashHex(candidate.toMasked, 64),
        toMaskedValueHash: hashHex(candidate.toMasked, 64),
        toHash: candidate.toHash,
        fromHash: candidate.fromHash,
        subjectValueHash: hashHex(candidate.subject, 64),
        // W117: 쓰기 계획은 실제로 쓰는 필드를 그대로 비춘다 — 평문은 담지 않는다(값 해시).
        bodyPreviewValueHash: hashHex(candidate.bodyPreview, 64),
        deliveryState: "sent",
        providerMessageIdHash: providerMessageIdHash(candidate.providerMessageIdNormalized),
        providerMessageIdOperation: "delete",
        providerMessageIdNormalizedOperation: "delete",
        draftRef: "",
        gameId: "scp-automation",
        sentByUserIdHash: hashHex(context.actorUid, 32),
        sentByRole: context.actorRole,
        sentAtIso: candidate.sentAtIso,
        source: candidate.source,
        sourceRefHash: hashHex(sourceRefPath, 40),
        mailType: candidate.mailType,
        mailAccountId: candidate.attributedMailAccountId,
        // hasReply:false is written only on a fresh ledger row — an existing row keeps whatever
        // the reply reconciler already memoized (merge must never clobber a detected reply).
        hasReplyOperation: candidate.existingOutboxPath ? "preserve" : "set-false",
        openCountOperation: "increment:0",
      },
    },
    messageSource: {
      write: !candidate.unsafe && candidate.needsMessageSourceWrite,
      pathHash: hashHex(sourceRefPath, 40),
      merge: true,
      fields: {
        id: sourceId,
        direction: "outbound",
        source: candidate.source,
        mailType: candidate.mailType,
        mailAccountId: candidate.attributedMailAccountId,
        trackingId: candidate.trackingId,
        externalTrackingId: candidate.trackingId,
        extractedPixelTrackingIdHash: hashHex(candidate.pixelTrackingId, 32),
        extractedPixelTrackingIdIsNull: !candidate.pixelTrackingId,
        providerMessageIdHash: providerMessageIdHash(candidate.providerMessageIdNormalized),
        providerMessageIdOperation: "delete",
        providerMessageIdNormalizedOperation: "delete",
        toMaskedValueHash: hashHex(candidate.toMasked, 64),
        toHash: candidate.toHash,
        fromHash: candidate.fromHash,
        subjectValueHash: hashHex(candidate.subject, 64),
        subjectHash: hashHex(candidate.subject, 24),
        // W117: 전문·프리뷰·절단 플래그도 계획에 실린다(평문 아닌 값 해시로).
        bodyValueHash: hashHex(candidate.body, 64),
        bodyTruncated: candidate.bodyTruncated,
        bodyPreviewValueHash: hashHex(candidate.bodyPreview, 64),
        bodyHash: candidate.bodyHash,
        htmlHash: candidate.htmlHash,
        sentAtIso: candidate.sentAtIso,
        deliveryState: "sent",
        importedAtIso: context.importedAtIso,
        importRunIdHash: hashHex(context.runId, 40),
        idempotencyKey: candidate.idempotencyKey,
        createdByHash: hashHex(context.actorUid, 32),
        updatedAtOperation: "serverTimestamp",
      },
    },
    providerUniqueness: {
      write: !candidate.unsafe && candidate.needsProviderUniquenessWrite,
      pathHash: hashHex(candidate.providerUniquenessPath, 40),
      operation: candidate.providerUniquenessExists ? "merge" : "create",
      fields: {
        schemaVersion: "mail-provider-message-uniqueness-v2",
        providerMessageIdHash: providerMessageIdHash(candidate.providerMessageIdNormalized, 40),
        providerMessageIdOperation: candidate.providerUniquenessExists ? "delete" : "omit",
        providerMessageIdNormalizedOperation: candidate.providerUniquenessExists ? "delete" : "omit",
        recipientHash: candidate.toHash,
        trackingId: candidate.trackingId,
        mailAccountId: candidate.attributedMailAccountId,
        outboxRefHash: hashHex(`${OUTBOX_COLLECTION}/${candidate.trackingId}`, 40),
        messageSourceRefHash: hashHex(sourceRefPath, 40),
        source: "external_sent_mail_import",
        timestampOperation: candidate.providerUniquenessExists
          ? "updatedAt:serverTimestamp"
          : "createdAt:serverTimestamp",
      },
    },
  };
}

function planFingerprintFor(
  requestFingerprint: string,
  candidates: ImportCandidate[],
  context: {
    actorUid: string;
    actorRole: string;
    runId: string;
    importedAtIso: string;
    claimRefPath: string;
    auditRefPath: string;
    cursor?: SentReadResult["cursor"];
  },
): string {
  const safeCandidates = candidates.filter((candidate) => !candidate.unsafe);
  const pendingCandidates = safeCandidates.filter((candidate) =>
    candidate.needsOutboxWrite
    || candidate.needsMessageSourceWrite
    || candidate.needsProviderUniquenessWrite);
  return hashHex(JSON.stringify({
    version: PREVIEW_TOKEN_VERSION,
    requestFingerprint,
    transaction: {
      runIdHash: hashHex(context.runId, 40),
      actorHash: hashHex(context.actorUid, 32),
      actorRole: context.actorRole,
      importedAtIso: context.importedAtIso,
      claimRefHash: hashHex(context.claimRefPath, 40),
      auditRefHash: hashHex(context.auditRefPath, 40),
      candidates: candidates.map((candidate) => candidateWritePlanMaterial(candidate, context)),
      cursor: context.cursor
        ? {
          refHash: hashHex(context.cursor.refPath, 40),
          expectedExists: context.cursor.expectedExists,
          expectedLastUid: context.cursor.expectedLastUid,
          expectedUidValidityHash: hashHex(context.cursor.expectedUidValidity, 32),
          expectedVersion: context.cursor.expectedVersion,
          expectedStateHash: context.cursor.expectedStateHash,
          write: shouldWriteCursor(context.cursor),
          writeFields: {
            version: context.cursor.expectedVersion + 1,
            mailboxHash: hashHex(context.cursor.mailbox, 32),
            userHash: hashHex(context.cursor.user, 32),
            uidValidityHash: hashHex(context.cursor.uidValidity, 32),
            lastUid: context.cursor.nextLastUid,
            updatedAtOperation: "serverTimestamp",
            updatedByHash: hashHex(context.actorUid, 32),
            source: "external_sent_mail_import",
          },
        }
        : null,
      auditWrite: {
        schemaVersion: "external-sent-import-audit-counts-v3",
        status: "completed",
        dryRun: false,
        actorRole: context.actorRole,
        verificationFingerprintOperation: "derived-from-bound-plan",
        counts: {
          candidateCount: candidates.length,
          pendingWriteCount: pendingCandidates.length,
          importedOutbox: safeCandidates.filter((candidate) => candidate.needsOutboxWrite).length,
          importedMessageSources: safeCandidates.filter((candidate) => candidate.needsMessageSourceWrite).length,
          skippedUnsafe: candidates.length - safeCandidates.length,
          skippedDuplicate: safeCandidates.filter((candidate) =>
            !candidate.needsOutboxWrite
            && !candidate.needsMessageSourceWrite
            && !candidate.needsProviderUniquenessWrite).length,
        },
        cursorAdvanced: Boolean(context.cursor && shouldWriteCursor(context.cursor)),
        createdAtOperation: "serverTimestamp",
      },
      claimUpdate: {
        status: "completed",
        auditRefHash: hashHex(context.auditRefPath, 40),
        verificationFingerprintOperation: "derived-from-bound-plan",
        completedAtOperation: "serverTimestamp",
      },
    },
  }), 64);
}

function publicCandidate(candidate: ImportCandidate, includeAttributionIdentity = false) {
  const sourceRef = `${MESSAGE_SOURCES_COLLECTION}/${safeId(`external-sent-${candidate.trackingId}`)}`;
  return {
    trackingId: candidate.trackingId,
    trackingIdMasked: maskTracking(candidate.trackingId),
    toMasked: candidate.toMasked,
    toHash: candidate.toHash,
    subjectHash: hashHex(candidate.subject, 16),
    sentAtIso: candidate.sentAtIso,
    providerMessageIdHash: providerMessageIdHash(candidate.providerMessageIdNormalized, 16),
    trustedTracking: candidate.trustedTracking,
    pixelTrackingIdMasked: candidate.pixelTrackingId
      ? maskTracking(candidate.pixelTrackingId)
      : "",
    unsafe: candidate.unsafe,
    skipReason: candidate.skipReason,
    duplicateReason: candidate.duplicateReason,
    needsOutboxWrite: candidate.needsOutboxWrite,
    needsMessageSourceWrite: candidate.needsMessageSourceWrite,
    needsProviderUniquenessWrite: candidate.needsProviderUniquenessWrite,
    ...(includeAttributionIdentity && !candidate.unsafe ? {
      attributionIdentity: {
        outboxRef: `${OUTBOX_COLLECTION}/${candidate.trackingId}`,
        messageSourceRef: sourceRef,
        trackingId: candidate.trackingId,
        providerMessageIdHash: providerMessageIdHash(candidate.providerMessageIdNormalized),
        expectedAttributionVersion: 0,
        supersedesAuditRef: "",
      },
    } : {}),
  };
}

function maskTracking(value: string): string {
  if (!value) return "";
  if (value.length <= 10) return `${value.slice(0, 3)}…`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function previewMismatch(): Error {
  return codedFailedPrecondition(
    PREVIEW_MISMATCH_CODE,
    "dry-run 이후 후보 또는 원장 상태가 변경되었습니다. 다시 미리보기를 실행하세요.",
  );
}

function effectiveNowMs(data: Record<string, unknown>): number {
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    const emulated = Date.parse(asString(data.emulatorNowIso, ""));
    if (Number.isFinite(emulated)) return emulated;
  }
  return Date.now();
}

async function insertEmulatorProviderPhantom(
  data: Record<string, unknown>,
  candidates: readonly ImportCandidate[],
): Promise<void> {
  const phantom = asRecord(data.emulatorProviderPhantom);
  if (Object.keys(phantom).length === 0) return;
  if (process.env.FUNCTIONS_EMULATOR !== "true") {
    throw failedPrecondition(
      "mail-safety.sent-import-emulator-phantom-only: the provider phantom adapter is rejected outside the Functions emulator.",
    );
  }
  const candidate = candidates[0];
  if (!candidate) throw invalidArgument("emulatorProviderPhantom requires an import candidate.");
  const collection = asString(phantom.collection, MESSAGE_SOURCES_COLLECTION);
  if (collection !== MESSAGE_SOURCES_COLLECTION && collection !== OUTBOX_COLLECTION) {
    throw invalidArgument("emulatorProviderPhantom.collection must be message_sources or mail_outbound_log.");
  }
  const documentId = safeId(
    asString(phantom.documentId, `provider-phantom-${hashHex(candidate.idempotencyKey, 20)}`),
  );
  const trackingId = safeId(asString(phantom.trackingId, `phantom-${documentId}`));
  await adminDb.collection(collection).doc(documentId).create({
    trackingId,
    ...(collection === MESSAGE_SOURCES_COLLECTION
      ? { id: documentId, direction: "outbound" }
      : {}),
    providerMessageIdHash: providerMessageIdHash(candidate.providerMessageIdNormalized),
    toHash: candidate.toHash,
    toMasked: candidate.toMasked,
    subject: candidate.subject,
    subjectHash: hashHex(candidate.subject, 24),
    sentAtIso: candidate.sentAtIso,
    deliveryState: "sent",
    source: "external_sent_mail_import_concurrent_phantom",
    mailType: candidate.mailType,
    createdAt: FieldValue.serverTimestamp(),
  });
}

function validatePreviewClaimIdentity(
  claim: Record<string, unknown>,
  actorUid: string,
  actorRole: string,
): void {
  const issuedAtMs = Date.parse(asString(claim.issuedAtIso, ""));
  const expiresAtMs = Date.parse(asString(claim.expiresAtIso, ""));
  if (
    asString(claim.version, "") !== PREVIEW_TOKEN_VERSION
    || asString(claim.actorHash, "") !== hashHex(actorUid, 32)
    || asString(claim.actorRole, "") !== actorRole
    || !Number.isFinite(issuedAtMs)
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= issuedAtMs
    || expiresAtMs - issuedAtMs > PREVIEW_TTL_MS
  ) {
    throw previewMismatch();
  }
}

function validatePendingPreviewClaimExpiry(
  claim: Record<string, unknown>,
  nowMs: number,
): void {
  const expiresAtMs = Date.parse(asString(claim.expiresAtIso, ""));
  if (nowMs > expiresAtMs) {
    throw codedFailedPrecondition(
      PREVIEW_EXPIRED_CODE,
      "dry-run 미리보기 유효 시간이 만료되었습니다. 다시 미리보기를 실행하세요.",
    );
  }
}

function validatePreviewClaimEnvelope(
  claim: Record<string, unknown>,
  actorUid: string,
  actorRole: string,
  nowMs: number,
): void {
  validatePreviewClaimIdentity(claim, actorUid, actorRole);
  validatePendingPreviewClaimExpiry(claim, nowMs);
}

function verificationFingerprintFor(
  claim: Record<string, unknown>,
  claimRefPath: string,
  auditRefPath: string,
): string {
  return hashHex(JSON.stringify({
    version: PREVIEW_TOKEN_VERSION,
    actorHash: asString(claim.actorHash, ""),
    actorRole: asString(claim.actorRole, ""),
    sourceMode: asString(claim.sourceMode, ""),
    scopeFingerprint: asString(claim.scopeFingerprint, ""),
    requestFingerprint: asString(claim.requestFingerprint, ""),
    planFingerprint: asString(claim.planFingerprint, ""),
    claimRefHash: hashHex(claimRefPath, 40),
    auditRefHash: hashHex(auditRefPath, 40),
  }), 64);
}

type CompletedReplay = {
  candidateCount: number;
  safeCandidateCount: number;
  skippedUnsafe: number;
  duplicateCount: number;
  auditRef: string;
  allowedSentMailboxes: string[];
};

function nonNegativeCount(record: Record<string, unknown>, field: string): number {
  const value = Number(record[field] ?? 0);
  if (!Number.isInteger(value) || value < 0) throw previewMismatch();
  return value;
}

async function readCompletedReplay(input: {
  actorUid: string;
  actorRole: string;
  data: Record<string, unknown>;
  claimRef: FirebaseFirestore.DocumentReference;
  auditRef: FirebaseFirestore.DocumentReference;
  claim: Record<string, unknown>;
}): Promise<CompletedReplay | null> {
  // Completion is permanent evidence. TTL gates only the transition from a
  // pending preview into writes; a completed token remains a verified no-write
  // idempotency key after expiry.
  validatePreviewClaimIdentity(input.claim, input.actorUid, input.actorRole);
  if (asString(input.claim.status, "") !== "completed") return null;

  const claimedSourceMode = asString(input.claim.sourceMode, "") as SentSourceMode;
  if (claimedSourceMode !== "fixture" && claimedSourceMode !== "imap") throw previewMismatch();
  const currentScope = await resolveSentScope(input.data, claimedSourceMode);
  if (
    currentScope.sourceMode !== claimedSourceMode
    || currentScope.scopeFingerprint !== asString(input.claim.scopeFingerprint, "")
  ) {
    throw previewMismatch();
  }

  const auditSnapshot = await input.auditRef.get();
  if (!auditSnapshot.exists) throw previewMismatch();
  const audit = asRecord(auditSnapshot.data());
  const expectedVerificationFingerprint = verificationFingerprintFor(
    input.claim,
    input.claimRef.path,
    input.auditRef.path,
  );
  if (
    asString(input.claim.auditRef, "") !== input.auditRef.path
    || asString(input.claim.verificationFingerprint, "") !== expectedVerificationFingerprint
    || asString(audit.status, "") !== "completed"
    || asString(audit.verificationFingerprint, "") !== expectedVerificationFingerprint
  ) {
    throw previewMismatch();
  }
  const claimCounts = asRecord(input.claim.counts);
  const auditCounts = asRecord(audit.counts);
  const candidateCount = nonNegativeCount(claimCounts, "candidateCount");
  const skippedUnsafe = nonNegativeCount(claimCounts, "skippedUnsafe");
  if (
    skippedUnsafe > candidateCount
    || nonNegativeCount(auditCounts, "candidateCount") !== candidateCount
    || nonNegativeCount(auditCounts, "skippedUnsafe") !== skippedUnsafe
  ) {
    throw previewMismatch();
  }
  const safeCandidateCount = candidateCount - skippedUnsafe;
  return {
    candidateCount,
    safeCandidateCount,
    skippedUnsafe,
    duplicateCount: safeCandidateCount,
    auditRef: input.auditRef.path,
    allowedSentMailboxes: currentScope.allowedSentMailboxes,
  };
}

function transactionWriteCandidate(
  transaction: Transaction,
  candidate: ImportCandidate,
  runId: string,
  actor: string,
  actorRole: string,
  importedAtIso: string,
) {
  if (candidate.unsafe) return;
  const sourceId = safeId(`external-sent-${candidate.trackingId}`);
  const sourceRef = adminDb.collection(MESSAGE_SOURCES_COLLECTION).doc(sourceId);
  if (candidate.needsOutboxWrite) {
    transaction.set(adminDb.collection(OUTBOX_COLLECTION).doc(candidate.trackingId), {
      trackingId: candidate.trackingId,
      to: candidate.toMasked,
      toMasked: candidate.toMasked,
      toHash: candidate.toHash,
      subject: candidate.subject,
      // W117: 원장에는 **프리뷰만** 싣는다(전문은 소스 문서 한 곳). 원장은 목록·스티치가 통째로
      // 스캔하는 축이라 전문을 실으면 읽기 비용이 행 수만큼 커진다.
      bodyPreview: candidate.bodyPreview,
      fromHash: candidate.fromHash,
      deliveryState: "sent",
      providerMessageIdHash: providerMessageIdHash(candidate.providerMessageIdNormalized),
      providerMessageId: FieldValue.delete(),
      providerMessageIdNormalized: FieldValue.delete(),
      draftRef: "",
      gameId: "scp-automation",
      sentByUserId: actor,
      sentByRole: actorRole,
      sentAtIso: candidate.sentAtIso,
      source: candidate.source,
      sourceRef: sourceRef.path,
      mailType: candidate.mailType,
      // Personal Sent ingest: account attribution on the ledger row so account-scoped views
      // and "mail sent from <account>" unanswered queries can tell scp and personal sends apart.
      mailAccountId: candidate.attributedMailAccountId,
      // Newly imported rows start as unanswered — mail_ingest_gaps sweeps `hasReply == false`
      // (an absent field never matches that query) and reconcileMailOutboxReplies flips it to
      // true via the stitched conversation. On an EXISTING row we preserve whatever is there:
      // merge must never clobber an already-memoized reply.
      ...(candidate.existingOutboxPath ? {} : { hasReply: false }),
      openCount: FieldValue.increment(0),
    }, { merge: true });
  }
  if (candidate.needsMessageSourceWrite) {
    transaction.set(sourceRef, {
      id: sourceId,
      direction: "outbound",
      source: candidate.source,
      mailType: candidate.mailType,
      mailAccountId: candidate.attributedMailAccountId,
      trackingId: candidate.trackingId,
      externalTrackingId: candidate.trackingId,
      extractedPixelTrackingId: candidate.pixelTrackingId || null,
      providerMessageIdHash: providerMessageIdHash(candidate.providerMessageIdNormalized),
      providerMessageId: FieldValue.delete(),
      providerMessageIdNormalized: FieldValue.delete(),
      toMasked: candidate.toMasked,
      toHash: candidate.toHash,
      fromHash: candidate.fromHash,
      subject: candidate.subject,
      subjectHash: hashHex(candidate.subject, 24),
      // W117: 전문은 여기 한 곳에만 둔다 — hover 뷰어(getMessageSource)가 읽는 축이다.
      body: candidate.body,
      bodyTruncated: candidate.bodyTruncated,
      bodyPreview: candidate.bodyPreview,
      bodyHash: candidate.bodyHash,
      htmlHash: candidate.htmlHash,
      sentAtIso: candidate.sentAtIso,
      deliveryState: "sent",
      importedAtIso,
      importRunId: runId,
      idempotencyKey: candidate.idempotencyKey,
      createdBy: actor,
      updatedAt: FieldValue.serverTimestamp(),
      // Manual-reply learning capture (see functions/manualReplyLearning.ts) — tags this
      // row so the same-tick capture pass and the backfill callable can find it without
      // re-parsing the message. "" clears any stale value on a re-import.
      ...(candidate.kind ? { kind: candidate.kind } : { kind: FieldValue.delete() }),
      ...(candidate.inReplyTo ? { inReplyTo: candidate.inReplyTo } : { inReplyTo: FieldValue.delete() }),
      ...(candidate.references.length > 0
        ? { references: candidate.references }
        : { references: FieldValue.delete() }),
      ...(candidate.pairedInboundMessageSourceId
        ? { pairedInboundMessageSourceId: candidate.pairedInboundMessageSourceId }
        : { pairedInboundMessageSourceId: FieldValue.delete() }),
    }, { merge: true });
  }
  if (candidate.needsProviderUniquenessWrite) {
    const providerUniquenessRef = adminDb.doc(candidate.providerUniquenessPath);
    const providerUniquenessFields = {
      schemaVersion: "mail-provider-message-uniqueness-v2",
      providerMessageIdHash: providerMessageIdHash(candidate.providerMessageIdNormalized, 40),
      recipientHash: candidate.toHash,
      trackingId: candidate.trackingId,
      // Which account first imported this provider message — global Message-ID dedupe means the
      // second importer is a no-write duplicate, so this records the lane that won the race.
      mailAccountId: candidate.attributedMailAccountId,
      outboxRef: `${OUTBOX_COLLECTION}/${candidate.trackingId}`,
      messageSourceRef: sourceRef.path,
      source: "external_sent_mail_import",
    };
    if (candidate.providerUniquenessExists) {
      transaction.set(providerUniquenessRef, {
        ...providerUniquenessFields,
        providerMessageId: FieldValue.delete(),
        providerMessageIdNormalized: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    } else {
      transaction.create(providerUniquenessRef, {
        ...providerUniquenessFields,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  }
}

async function applyPreviewClaim(input: {
  actorUid: string;
  actorRole: string;
  claimRef: FirebaseFirestore.DocumentReference;
  auditRef: FirebaseFirestore.DocumentReference;
  requestFingerprint: string;
  planFingerprint: string;
  candidates: ImportCandidate[];
  cursor?: SentReadResult["cursor"];
  nowMs: number;
}): Promise<{
  idempotentReplay: boolean;
  writtenOutbox: number;
  writtenMessageSources: number;
}> {
  return adminDb.runTransaction(async (transaction) => {
    const [claimSnapshot, auditSnapshot] = await Promise.all([
      transaction.get(input.claimRef),
      transaction.get(input.auditRef),
    ]);
    if (!claimSnapshot.exists) throw previewMismatch();
    const claim = asRecord(claimSnapshot.data());
    validatePreviewClaimIdentity(claim, input.actorUid, input.actorRole);
    const claimedPlanFingerprint = asString(claim.planFingerprint, "");
    const issuedAtIso = asString(claim.issuedAtIso, "");
    const verificationFingerprint = verificationFingerprintFor(
      claim,
      input.claimRef.path,
      input.auditRef.path,
    );
    if (auditSnapshot.exists) {
      const audit = asRecord(auditSnapshot.data());
      if (
        asString(claim.status, "") !== "completed"
        || asString(claim.requestFingerprint, "") !== input.requestFingerprint
        || asString(claim.auditRef, "") !== input.auditRef.path
        || asString(claim.verificationFingerprint, "") !== verificationFingerprint
        || asString(audit.status, "") !== "completed"
        || asString(audit.verificationFingerprint, "") !== verificationFingerprint
      ) {
        throw previewMismatch();
      }
      return { idempotentReplay: true, writtenOutbox: 0, writtenMessageSources: 0 };
    }
    validatePendingPreviewClaimExpiry(claim, input.nowMs);
    if (asString(claim.requestFingerprint, "") !== input.requestFingerprint) throw previewMismatch();
    if (asString(claim.status, "") !== "pending" || claimedPlanFingerprint !== input.planFingerprint) {
      throw previewMismatch();
    }

    const expectedAssertions = new Map(input.candidates
      .flatMap((candidate) => candidate.ledgerAssertions)
      .map((assertion) => [assertion.path, assertion.stateHash] as const));
    const assertionRefs = [...expectedAssertions.keys()].map((path) => adminDb.doc(path));
    const assertionSnapshots = assertionRefs.length > 0
      ? await transaction.getAll(...assertionRefs)
      : [];
    for (const snapshot of assertionSnapshots) {
      const actualStateHash = ledgerStateHash(snapshot.exists, asRecord(snapshot.data()));
      if (expectedAssertions.get(snapshot.ref.path) !== actualStateHash) throw previewMismatch();
    }
    const expectedProviderQueries = new Map(input.candidates
      .flatMap((candidate) => candidate.providerQueryAssertions)
      .map((assertion) => [
        `${assertion.collection}|${assertion.field}|${assertion.value}`,
        assertion,
      ] as const));
    for (const assertion of expectedProviderQueries.values()) {
      const snapshot = await transaction.get(
        adminDb.collection(assertion.collection)
          .where(assertion.field, "==", assertion.value),
      );
      if (queryResultHash(snapshot.docs) !== assertion.resultHash) throw previewMismatch();
    }
    if (input.cursor) {
      const cursorSnapshot = await transaction.get(adminDb.doc(input.cursor.refPath));
      const cursorData = asRecord(cursorSnapshot.data());
      if (
        cursorSnapshot.exists !== input.cursor.expectedExists
        || cursorDocumentVersion(cursorData) !== input.cursor.expectedVersion
        || cursorStateHash(cursorSnapshot.exists, cursorData) !== input.cursor.expectedStateHash
      ) {
        throw previewMismatch();
      }
    }

    let writtenOutbox = 0;
    let writtenMessageSources = 0;
    for (const candidate of input.candidates) {
      transactionWriteCandidate(
        transaction,
        candidate,
        input.auditRef.id,
        input.actorUid,
        input.actorRole,
        issuedAtIso,
      );
      if (!candidate.unsafe && candidate.needsOutboxWrite) writtenOutbox += 1;
      if (!candidate.unsafe && candidate.needsMessageSourceWrite) writtenMessageSources += 1;
    }
    if (input.cursor && shouldWriteCursor(input.cursor)) {
      transaction.set(adminDb.doc(input.cursor.refPath), {
        version: input.cursor.expectedVersion + 1,
        mailbox: input.cursor.mailbox,
        user: input.cursor.user,
        uidValidity: input.cursor.uidValidity,
        lastUid: input.cursor.nextLastUid,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: input.actorUid,
        source: "external_sent_mail_import",
      }, { merge: true });
    }
    const safeCandidates = input.candidates.filter((candidate) => !candidate.unsafe);
    const pendingCandidates = safeCandidates.filter((candidate) =>
      candidate.needsOutboxWrite
      || candidate.needsMessageSourceWrite
      || candidate.needsProviderUniquenessWrite);
    // LOG-P0-010 180일 TTL: transaction 안에서는 FieldValue.serverTimestamp() 값을 즉시 읽을 수
    // 없어 expireAt 계산 basis로 못 쓴다. input.nowMs 는 이 claim의 공식 "now"(issuedAtIso/
    // expiresAtIso 도 같은 값에서 파생) 이고 재시도 간에도 고정이라 이 문서의 createdAt 으로 안전하다.
    const createdAt = Timestamp.fromMillis(input.nowMs);
    transaction.set(input.auditRef, {
      schemaVersion: "external-sent-import-audit-counts-v3",
      status: "completed",
      dryRun: false,
      actorRole: input.actorRole,
      verificationFingerprint,
      counts: {
        candidateCount: input.candidates.length,
        pendingWriteCount: pendingCandidates.length,
        importedOutbox: writtenOutbox,
        importedMessageSources: writtenMessageSources,
        skippedUnsafe: input.candidates.length - safeCandidates.length,
        skippedDuplicate: safeCandidates.filter((candidate) =>
          !candidate.needsOutboxWrite
          && !candidate.needsMessageSourceWrite
          && !candidate.needsProviderUniquenessWrite).length,
      },
      cursorAdvanced: Boolean(input.cursor && shouldWriteCursor(input.cursor)),
      createdAt,
      expireAt: expireAt180DaysFromTimestamp(createdAt),
    });
    transaction.update(input.claimRef, {
      status: "completed",
      auditRef: input.auditRef.path,
      verificationFingerprint,
      completedAt: FieldValue.serverTimestamp(),
    });
    return { idempotentReplay: false, writtenOutbox, writtenMessageSources };
  });
}

/**
 * W111-A (헤세): scp@supercent.io 의 발송분을 **자동으로** 원장에 수집한다.
 *
 * 왜 필요한가 — 프로드 실측:
 *   자동 수집(processImapIngestQueue)은 INBOX 만 읽는다. 아웃바운드는 flu 를 **통해** 보낼 때만
 *   기록되므로, 그 밖의 경로로 나간 scp 발송분은 원장에 없다. 인바운드 "Re:" 462건 중 **144건**은
 *   대응하는 원본 발송이 원장에 아예 없었다(원본 제목 26종, 최다는 합격 통보 "You're in!" 38회).
 *   화면에서는 우리가 아무 말도 안 한 것처럼 보이고, 그래서 응대 상태·리포트 회신 지표가 같이 틀린다.
 *   `mail_sent_import_cursors` 가 0건 = 지금껏 한 번도 수집된 적이 없다.
 *
 * 왜 이렇게 만드는가 — **기존 수동 임포터의 파이프라인과 안전장치를 하나도 벗기지 않는다.**
 *   발신 허용목록(구성된 IMAP 계정 = scp@supercent.io), 메일박스 special-use 검증, 후보 지문,
 *   provider uniqueness 멱등, 감사 로그, 트랜잭션 적용까지 전부 그대로 탄다.
 *   빠지는 건 dry-run 과 apply **사이의 사람** 하나뿐이고, 그게 자동화의 목적이다.
 *   새 쓰기 경로를 만들지 않는다 — 그걸 만들면 그 자체가 우회로이자 결함이 된다.
 *
 * 안전 성질:
 *   - 커서(`mail_sent_import_cursors`)로 증분만 읽는다. 실패하면 커서가 전진하지 않아 다음 회차에 재시도된다.
 *   - 회당 상한은 기존 `limit` 규칙(최대 50)을 그대로 쓴다. 첫 실행의 밀린 분량은 여러 회차로 나뉜다.
 *   - 시스템 액터는 실제 관리자와 **구분되는** 식별자를 쓴다(감사 로그에서 사람 승인과 섞이면 안 된다).
 */
const SCHEDULED_IMPORT_ACTOR_UID = "system:scheduled-sent-import";
const SCHEDULED_IMPORT_ACTOR_ROLE = "system_scheduled";

export async function importSentMailToOutboxScheduled(
  options: {
    limit?: number;
    nowMs?: number;
    /**
     * 테스트 주입(리뷰 HIGH): 이 함수는 프로드가 아니면 liveIntegrationsEnabled("imap") 가 항상
     * false 라 어떤 환경에서도 본문 로직에 도달할 수 없었다 — 그래서 테스트가 소스 정규식뿐이었다.
     * 수동 임포터가 이미 지원하는 것과 **같은** 에뮬레이터 전용 주입구를 그대로 흘려보낸다
     * (emulatorImap / messages 는 resolveSentScope 가 FUNCTIONS_EMULATOR 밖에서 거부한다).
     */
    emulatorImap?: Record<string, unknown>;
    messages?: unknown[];
    sentMailbox?: string;
    /**
     * Personal-account mode: read this mail_accounts row's Sent folder instead of the
     * canonical scp mailbox. Connection/auth come from resolveImapConnectionForAccount and
     * imported rows are stamped with account.accountId. `accountDeps` lets tests inject the
     * OAuth/secret seams (unused when emulatorImap drives the read).
     */
    account?: SentImportAccount;
    accountDeps?: ResolveImapConnectionForAccountDeps;
  } = {},
): Promise<{
  ok: boolean;
  skippedReason?: string;
  /** Which mail_accounts row this run read for ("scp" when no account was supplied). */
  mailAccountId: string;
  candidateCount: number;
  importedOutbox: number;
  importedMessageSources: number;
  /** 발신 계정이 승인 목록과 달라 이번 배치에서 제외된 메일 수(배치를 막지 않는다). */
  skippedUnapprovedFrom: number;
  /** W114: 수신자가 없어 파싱 자체가 불가능해 건너뛴 메일 수(배치를 막지 않는다). */
  skippedNoRecipient: number;
  /** W114: 그 밖의 파싱 실패(인코딩·헤더 결손 등)로 건너뛴 메일 수(배치를 막지 않는다). */
  skippedUnparseable: number;
  /**
   * 이번 배치가 원장에 확보한 편입 행의 trackingId 들(=안전 후보). 호출자가 **방금 편입분만**
   * 이어서 처리할 수 있게 돌려준다(대화 물질화 편승). 쓰기 계획 지문과는 무관한 반환값이라
   * 임포트 계약을 건드리지 않는다.
   */
  importedTrackingIds: string[];
  /**
   * Manual-reply learning capture (functions/manualReplyLearning.ts): the subset of this
   * batch's safe candidates that are reply-shaped AND paired to a specific inbound
   * message. The scheduled tick (functions/index.ts processImapIngestQueue) feeds these
   * into captureManualReplyLearningCandidatesForImportedReplies right after import.
   */
  importedReplyCandidates: { sourceId: string; mailAccountId: string }[];
  cursorAdvanced: boolean;
}> {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const limit = Math.min(Math.max(Math.trunc(Number(options.limit ?? 25)), 1), 50);
  const injected = options.emulatorImap ?? options.messages;
  const data: Record<string, unknown> = {
    limit,
    ...(options.emulatorImap ? { emulatorImap: options.emulatorImap } : {}),
    ...(options.messages ? { messages: options.messages } : {}),
    ...(options.sentMailbox ? { sentMailbox: options.sentMailbox } : {}),
  };
  const runMailAccountId = options.account?.accountId ?? "scp";
  // 라이브 IMAP 이 꺼진 환경(스테이징·에뮬)에서는 건너뛴다 — 던지면 재시도만 쌓인다.
  // 단 에뮬레이터 주입이 들어온 경우엔 그 경로로 진행한다(테스트가 본문에 도달할 수 있어야 한다).
  if (!injected && !liveIntegrationsEnabled("imap")) {
    return {
      ok: true, skippedReason: "imap_disabled", mailAccountId: runMailAccountId,
      candidateCount: 0, importedOutbox: 0, importedMessageSources: 0,
      skippedUnapprovedFrom: 0, skippedNoRecipient: 0, skippedUnparseable: 0, importedTrackingIds: [],
      importedReplyCandidates: [],
      cursorAdvanced: false,
    };
  }

  const token = previewToken();
  const claimRef = previewClaimDocument(token);
  const runId = `external_sent_import_${hashHex(token, 32)}`;
  const auditRef = adminDb.collection(AUDIT_COLLECTION).doc(runId);

  const scope = options.account
    ? await resolveSentScopeForAccount(options.account, data, options.accountDeps ?? {})
    : await resolveSentScope(data);
  const liveRead = options.messages
    ? { ...(await parseFixtureMessages(data)), sourceMode: "fixture" as const, scopeFingerprint: scope.scopeFingerprint }
    : await readSentMailboxMessages(data, scope);
  const allRows = liveRead.rows;
  // W114: 새로 스캔한 uid 가 전부 파싱 실패로 건너뛰어져도 커서는 그 uid 들을 이미 지나쳤다
  // (readSentMailboxMessages 의 maxUid 는 파싱 성공과 무관하게 갱신된다) — 그래서 여기서 조기
  // return 하면 그 진행이 저장되지 않고 다음 회차가 같은 불량 uid 를 영원히 재스캔한다.
  // 커서가 실제로 전진해야 하는 경우엔 후보가 비어도 파이프라인을 끝까지 흘려보낸다
  // (skippedUnapprovedFrom 의 MEDIUM 재검 수정과 같은 이유).
  const cursorNeedsWrite = Boolean(liveRead.cursor && shouldWriteCursor(liveRead.cursor));
  if (allRows.length === 0 && !cursorNeedsWrite) {
    return {
      ok: true,
      skippedReason: totalParseSkipCount(liveRead.skipped) > 0 ? "no_parseable_messages" : "no_new_messages",
      mailAccountId: scope.mailAccountId,
      candidateCount: 0, importedOutbox: 0, importedMessageSources: 0, skippedUnapprovedFrom: 0,
      skippedNoRecipient: liveRead.skipped.noRecipient, skippedUnparseable: liveRead.skipped.unparseable,
      importedTrackingIds: [], importedReplyCandidates: [], cursorAdvanced: false,
    };
  }

  // 리뷰 HIGH: 수동 경로의 assertApprovedFrom 은 **배치 전체**를 던진다(사람이 보고 판단하라는 뜻).
  //   스케줄 경로에서 그러면 승인 안 된 메일 한 통이 배치 전체를 막고, 커서가 전진하지 않아
  //   **같은 구간을 10분마다 영원히 재시도**한다 — 정상 메일까지 영구 정체된다.
  //   형제 함수 mailImapIngest 의 검증된 패턴(메시지별 격리)을 따라, 승인 밖 발신은 이번 배치에서
  //   빼고 나머지를 진행한다. From 불일치는 일시 오류가 아니라 "우리 메일이 아니다"라는 확정이라
  //   건너뛰고 커서를 전진시키는 게 맞다. 몇 건을 건너뛰었는지는 숫자로 남긴다.
  const allowedFrom = new Set(scope.allowedFromHashes);
  const parsedRows = allRows.filter((row) => row.fromHash && allowedFrom.has(row.fromHash));
  const skippedUnapprovedFrom = allRows.length - parsedRows.length;
  if (skippedUnapprovedFrom > 0) {
    console.warn("[sent-import]", JSON.stringify({
      outcome: "skipped_unapproved_from",
      mailAccountId: scope.mailAccountId,
      count: skippedUnapprovedFrom,
    }));
  }
  // 리뷰 재검(MEDIUM): 여기서 조기 return 하면 **창 전체가 승인 밖일 때** 커서가 전혀 안 움직여
  //   그 창과 그 뒤 모든 uid 가 영구 정체된다(HIGH 2 의 좁은 잔여 버전). 후보가 비어도
  //   applyPreviewClaim 까지 흘려보내면 shouldWriteCursor 가 커서만 전진시키는 무해한 경로를 탄다.
  //   그래서 조기 return 하지 않고, 아래 파이프라인을 빈 후보로 그대로 통과시킨다.
  //   남은 행이 있으면 전부 승인 발신이어야 한다 — 수동 경로와 같은 게이트를 최종 확인으로 건다.
  if (parsedRows.length > 0) assertApprovedFrom(parsedRows, scope.allowedFromHashes);

  const issuedAtIso = new Date(nowMs).toISOString();
  const expiresAtIso = new Date(nowMs + PREVIEW_TTL_MS).toISOString();
  const requestFingerprint = requestFingerprintFor(
    SCHEDULED_IMPORT_ACTOR_UID,
    SCHEDULED_IMPORT_ACTOR_ROLE,
    parsedRows,
    liveRead.scopeFingerprint,
    issuedAtIso,
    expiresAtIso,
    liveRead.cursor,
  );
  const candidates = dedupeBatchCandidates(
    await Promise.all(parsedRows.map((row) => buildCandidate(row, scope.mailAccountId))),
  );
  const safeCandidates = candidates.filter((candidate) => !candidate.unsafe);
  const pendingCandidates = safeCandidates.filter(
    (candidate) => candidate.needsOutboxWrite
      || candidate.needsMessageSourceWrite
      || candidate.needsProviderUniquenessWrite,
  );
  const planFingerprint = planFingerprintFor(requestFingerprint, candidates, {
    actorUid: SCHEDULED_IMPORT_ACTOR_UID,
    actorRole: SCHEDULED_IMPORT_ACTOR_ROLE,
    runId,
    importedAtIso: issuedAtIso,
    claimRefPath: claimRef.path,
    auditRefPath: auditRef.path,
    cursor: liveRead.cursor,
  });

  // 수동 경로의 dry-run 단계와 **같은 클레임**을 만든다(형태·검증 규칙 동일). 사람이 그 사이에
  // 개입하지 않을 뿐, applyPreviewClaim 의 지문·신원·만료 검증은 그대로 통과해야 한다.
  await claimRef.create({
    schemaVersion: "external-sent-import-preview-claim-v3",
    version: PREVIEW_TOKEN_VERSION,
    status: "pending",
    actorHash: hashHex(SCHEDULED_IMPORT_ACTOR_UID, 32),
    actorRole: SCHEDULED_IMPORT_ACTOR_ROLE,
    sourceMode: liveRead.sourceMode,
    requestFingerprint,
    planFingerprint,
    scopeFingerprint: liveRead.scopeFingerprint,
    issuedAtIso,
    expiresAtIso,
    counts: {
      candidateCount: candidates.length,
      safeCandidateCount: safeCandidates.length,
      pendingWriteCount: pendingCandidates.length,
      skippedUnsafe: candidates.length - safeCandidates.length,
      skippedDuplicate: safeCandidates.filter((candidate) =>
        !candidate.needsOutboxWrite
        && !candidate.needsMessageSourceWrite
        && !candidate.needsProviderUniquenessWrite).length,
    },
    createdAt: FieldValue.serverTimestamp(),
  });

  const applied = await applyPreviewClaim({
    actorUid: SCHEDULED_IMPORT_ACTOR_UID,
    actorRole: SCHEDULED_IMPORT_ACTOR_ROLE,
    claimRef,
    auditRef,
    requestFingerprint,
    planFingerprint,
    candidates,
    cursor: liveRead.cursor,
    nowMs,
  });

  // W114: 감사 컬렉션에 "몇 통이 왜 빠졌나"를 남긴다(W112 F-C 재발 방지 — 조용한 스킵 금지).
  // planFingerprint/counts 는 candidates(=파싱에 성공한 행) 기준 쓰기 계획 검증 계약이라
  // 건드리지 않는다 — 이건 그 계약과 무관한 보충 진단 정보라 트랜잭션 밖에서 별도 merge 로 남긴다.
  if (totalParseSkipCount(liveRead.skipped) > 0) {
    await auditRef.set({
      skippedParse: {
        noRecipient: liveRead.skipped.noRecipient,
        unparseable: liveRead.skipped.unparseable,
      },
    }, { merge: true });
  }

  console.log("[sent-import]", JSON.stringify({
    outcome: "scheduled_import",
    mailAccountId: scope.mailAccountId,
    candidateCount: candidates.length,
    safeCandidateCount: safeCandidates.length,
    importedOutbox: applied.writtenOutbox,
    importedMessageSources: applied.writtenMessageSources,
    idempotentReplay: applied.idempotentReplay,
    skippedUnapprovedFrom,
    skippedNoRecipient: liveRead.skipped.noRecipient,
    skippedUnparseable: liveRead.skipped.unparseable,
    cursorAdvanced: Boolean(liveRead.cursor),
  }));

  return {
    ok: true,
    ...(parsedRows.length === 0 ? { skippedReason: "no_approved_messages" } : {}),
    mailAccountId: scope.mailAccountId,
    candidateCount: candidates.length,
    importedOutbox: applied.writtenOutbox,
    importedMessageSources: applied.writtenMessageSources,
    skippedUnapprovedFrom,
    skippedNoRecipient: liveRead.skipped.noRecipient,
    skippedUnparseable: liveRead.skipped.unparseable,
    importedTrackingIds: safeCandidates.map((candidate) => candidate.trackingId),
    importedReplyCandidates: safeCandidates
      .filter((candidate) => candidate.kind === "manual_reply" && candidate.pairedInboundMessageSourceId)
      .map((candidate) => ({
        sourceId: safeId(`external-sent-${candidate.trackingId}`),
        mailAccountId: candidate.attributedMailAccountId,
      })),
    cursorAdvanced: Boolean(liveRead.cursor),
  };
}

/**
 * Scheduled personal-account Sent pass — the loop the canonical-only importer never had.
 *
 * Mirrors the per-account discipline processImapIngestQueue's inbound loop already proved
 * (mailImapIngest.ts): iterate ACTIVE personal mail accounts (workspace_oauth +
 * external_smtp_imap), give each the same bounded batch limit, and isolate failures so one
 * account's revoked OAuth grant or missing env secret can never stall the others or the
 * canonical run that already completed. Failures are classified through
 * safeOutboundFailureEvidence — no secret, token, mailbox content, or raw provider error is
 * ever logged.
 */
export type PersonalSentImportOutcome = {
  mailAccountId: string;
  ok: boolean;
  skippedReason?: string;
  candidateCount: number;
  importedOutbox: number;
  importedMessageSources: number;
  importedTrackingIds: string[];
  importedReplyCandidates: { sourceId: string; mailAccountId: string }[];
  cursorAdvanced: boolean;
  /** Present only when the account's run threw — classified evidence, never raw error text. */
  failureCode?: string;
  correlationIdHash?: string;
};

export async function importSentMailForActivePersonalAccounts(
  input: {
    limit?: number;
    nowMs?: number;
    /** Test seam: pre-read account list. Production passes nothing -> readMailAccounts(). */
    accounts?: readonly MailAccount[];
    accountDeps?: ResolveImapConnectionForAccountDeps;
    /** Emulator seam: per-account emulatorImap fixtures (keyed by accountId). */
    emulatorImapByAccountId?: Record<string, Record<string, unknown>>;
  } = {},
): Promise<{
  ok: boolean;
  outcomes: PersonalSentImportOutcome[];
  importedTrackingIds: string[];
  importedReplyCandidates: { sourceId: string; mailAccountId: string }[];
}> {
  const accounts = input.accounts ?? await readMailAccounts();
  const targets = accounts.filter((account) =>
    PERSONAL_MAIL_ACCOUNT_KINDS.has(account.kind) && account.status === "active");
  const outcomes: PersonalSentImportOutcome[] = [];
  const importedTrackingIds: string[] = [];
  const importedReplyCandidates: { sourceId: string; mailAccountId: string }[] = [];
  for (const account of targets) {
    try {
      const result = await importSentMailToOutboxScheduled({
        limit: input.limit,
        nowMs: input.nowMs,
        account,
        accountDeps: input.accountDeps,
        ...(input.emulatorImapByAccountId?.[account.accountId]
          ? { emulatorImap: input.emulatorImapByAccountId[account.accountId] }
          : {}),
      });
      importedTrackingIds.push(...result.importedTrackingIds);
      importedReplyCandidates.push(...result.importedReplyCandidates);
      outcomes.push({
        mailAccountId: account.accountId,
        ok: true,
        ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}),
        candidateCount: result.candidateCount,
        importedOutbox: result.importedOutbox,
        importedMessageSources: result.importedMessageSources,
        importedTrackingIds: result.importedTrackingIds,
        importedReplyCandidates: result.importedReplyCandidates,
        cursorAdvanced: result.cursorAdvanced,
      });
    } catch (error) {
      const evidence = safeOutboundFailureEvidence(
        error,
        `personal-sent-import:${account.accountId}`,
      );
      console.warn("[sent-import]", JSON.stringify({
        outcome: "personal_account_failed",
        mailAccountId: account.accountId,
        errorCode: evidence.errorCode,
        failureKind: evidence.failureKind,
        failureRuleId: evidence.failureRuleId,
        correlationIdHash: evidence.correlationIdHash,
      }));
      outcomes.push({
        mailAccountId: account.accountId,
        ok: false,
        candidateCount: 0,
        importedOutbox: 0,
        importedMessageSources: 0,
        importedTrackingIds: [],
        importedReplyCandidates: [],
        cursorAdvanced: false,
        failureCode: evidence.errorCode,
        correlationIdHash: evidence.correlationIdHash,
      });
    }
  }
  return {
    ok: outcomes.every((outcome) => outcome.ok),
    outcomes,
    importedTrackingIds,
    importedReplyCandidates,
  };
}

export async function importManualSentMailToOutbox(
  request: CallableRequestShape,
) {
  const auth = assertNonGuestAuth(
    request,
    "mail_external_sent_import.run",
    IMPORT_ROLES,
  );
  const data = asRecord(request.data);
  const nowMs = effectiveNowMs(data);
  const dryRun = data.dryRun !== false;
  const actual = data.actual === true || data.execute === true;
  if (!dryRun && !actual) {
    throw invalidArgument("actual:true is required when dryRun is false.");
  }
  const suppliedPreviewToken = asString(data.previewToken, "").trim();
  if (!dryRun && !suppliedPreviewToken) {
    throw codedFailedPrecondition(
      PREVIEW_REQUIRED_CODE,
      "적용 전에 동일 범위의 dry-run 미리보기가 필요합니다.",
    );
  }
  if (!dryRun && !validPreviewToken(suppliedPreviewToken)) throw previewMismatch();

  const effectivePreviewToken = dryRun ? previewToken() : suppliedPreviewToken;
  const claimRef = previewClaimDocument(effectivePreviewToken);
  const runId = `external_sent_import_${hashHex(effectivePreviewToken, 32)}`;
  const auditRef = adminDb.collection(AUDIT_COLLECTION).doc(runId);
  const suppliedClaimSnapshot = dryRun ? undefined : await claimRef.get();
  if (!dryRun && !suppliedClaimSnapshot?.exists) throw previewMismatch();
  const suppliedClaim = asRecord(suppliedClaimSnapshot?.data());

  if (!dryRun) {
    const completedReplay = await readCompletedReplay({
      actorUid: auth.userId,
      actorRole: auth.role,
      data,
      claimRef,
      auditRef,
      claim: suppliedClaim,
    });
    if (completedReplay) {
      return {
        ok: true,
        dryRun: false,
        mode: "actual",
        candidateCount: completedReplay.candidateCount,
        safeCandidateCount: completedReplay.safeCandidateCount,
        pendingWriteCount: 0,
        skippedUnsafe: completedReplay.skippedUnsafe,
        duplicateCount: completedReplay.duplicateCount,
        importedOutbox: 0,
        importedMessageSources: 0,
        rows: [],
        previewStateful: false,
        sideEffects: [],
        businessWritesApplied: false,
        auditRef: completedReplay.auditRef,
        allowedSentMailboxes: completedReplay.allowedSentMailboxes,
        idempotentReplay: true,
      };
    }
  }

  const claimedSourceMode = dryRun
    ? undefined
    : asString(suppliedClaim.sourceMode, "") as SentSourceMode;
  if (!dryRun) {
    validatePreviewClaimEnvelope(suppliedClaim, auth.userId, auth.role, nowMs);
    if (
      asString(suppliedClaim.status, "") !== "pending"
      || (claimedSourceMode !== "fixture" && claimedSourceMode !== "imap")
    ) {
      throw previewMismatch();
    }
  }
  const scope = await resolveSentScope(data, claimedSourceMode);
  if (!dryRun && (
    scope.sourceMode !== claimedSourceMode
    || scope.scopeFingerprint !== asString(suppliedClaim.scopeFingerprint, "")
  )) {
    throw previewMismatch();
  }
  const liveRead: SentReadResult = scope.sourceMode === "fixture"
    ? {
      ...(await parseFixtureMessages(data)),
      sourceMode: "fixture",
      scopeFingerprint: scope.scopeFingerprint,
    }
    : await readSentMailboxMessages(data, scope);
  const parsedRows = liveRead.rows;
  assertApprovedFrom(parsedRows, scope.allowedFromHashes);
  const issuedAtIso = dryRun
    ? new Date(nowMs).toISOString()
    : asString(suppliedClaim.issuedAtIso, "");
  const expiresAtIso = dryRun
    ? new Date(Date.parse(issuedAtIso) + PREVIEW_TTL_MS).toISOString()
    : asString(suppliedClaim.expiresAtIso, "");
  const requestFingerprint = requestFingerprintFor(
    auth.userId,
    auth.role,
    parsedRows,
    liveRead.scopeFingerprint,
    issuedAtIso,
    expiresAtIso,
    liveRead.cursor,
  );
  const candidates = dedupeBatchCandidates(
    // The manual importer only ever resolves the canonical scope, so scp attribution applies.
    await Promise.all(parsedRows.map((row) => buildCandidate(row, scope.mailAccountId))),
  );
  const safeCandidates = candidates.filter((candidate) => !candidate.unsafe);
  const pendingCandidates = safeCandidates.filter(
    (candidate) => candidate.needsOutboxWrite
      || candidate.needsMessageSourceWrite
      || candidate.needsProviderUniquenessWrite,
  );
  const planFingerprint = planFingerprintFor(requestFingerprint, candidates, {
    actorUid: auth.userId,
    actorRole: auth.role,
    runId,
    importedAtIso: issuedAtIso,
    claimRefPath: claimRef.path,
    auditRefPath: auditRef.path,
    cursor: liveRead.cursor,
  });
  if (dryRun) {
    await claimRef.create({
      schemaVersion: "external-sent-import-preview-claim-v3",
      version: PREVIEW_TOKEN_VERSION,
      status: "pending",
      actorHash: hashHex(auth.userId, 32),
      actorRole: auth.role,
      sourceMode: liveRead.sourceMode,
      requestFingerprint,
      planFingerprint,
      scopeFingerprint: liveRead.scopeFingerprint,
      issuedAtIso,
      expiresAtIso,
      counts: {
        candidateCount: candidates.length,
        safeCandidateCount: safeCandidates.length,
        pendingWriteCount: pendingCandidates.length,
        skippedUnsafe: candidates.length - safeCandidates.length,
        skippedDuplicate: safeCandidates.filter((candidate) =>
          !candidate.needsOutboxWrite
          && !candidate.needsMessageSourceWrite
          && !candidate.needsProviderUniquenessWrite).length,
      },
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  if (!dryRun) await insertEmulatorProviderPhantom(data, candidates);
  const applied = dryRun
    ? { idempotentReplay: false, writtenOutbox: 0, writtenMessageSources: 0 }
    : await applyPreviewClaim({
      actorUid: auth.userId,
      actorRole: auth.role,
      claimRef,
      auditRef,
      requestFingerprint,
      planFingerprint,
      candidates,
      cursor: liveRead.cursor,
      nowMs,
    });
  const responseCandidates = applied.idempotentReplay
    ? candidates.map((candidate) => candidate.unsafe ? candidate : ({
      ...candidate,
      duplicateReason: "provider_message_duplicate",
      needsOutboxWrite: false,
      needsMessageSourceWrite: false,
      needsProviderUniquenessWrite: false,
    }))
    : candidates;
  const responsePendingWriteCount = applied.idempotentReplay ? 0 : pendingCandidates.length;
  const responseDuplicateCount = applied.idempotentReplay
    ? safeCandidates.length
    : safeCandidates.filter((candidate) =>
      !candidate.needsOutboxWrite
      && !candidate.needsMessageSourceWrite
      && !candidate.needsProviderUniquenessWrite).length;

  return {
    ok: true,
    dryRun,
    mode: dryRun ? "dry_run" : "actual",
    candidateCount: candidates.length,
    safeCandidateCount: safeCandidates.length,
    pendingWriteCount: responsePendingWriteCount,
    skippedUnsafe: candidates.filter((candidate) => candidate.unsafe).length,
    duplicateCount: responseDuplicateCount,
    importedOutbox: applied.writtenOutbox,
    importedMessageSources: applied.writtenMessageSources,
    rows: responseCandidates.map((candidate) => publicCandidate(
      candidate,
      !dryRun && (candidate.needsOutboxWrite || candidate.needsMessageSourceWrite),
    )),
    ...(dryRun ? { previewToken: effectivePreviewToken } : {}),
    previewStateful: dryRun,
    sideEffects: dryRun
      ? ["preview_claim"]
      : applied.idempotentReplay
        ? []
        : [
          ...(applied.writtenOutbox > 0 ? ["mail_outbound_log"] : []),
          ...(applied.writtenMessageSources > 0 ? ["message_sources"] : []),
          "reconciliation_audit",
          "preview_claim_status",
        ],
    previewClaimFingerprint: dryRun ? hashHex(claimRef.path, 40) : undefined,
    businessWritesApplied: !dryRun && (applied.writtenOutbox > 0 || applied.writtenMessageSources > 0),
    auditRef: dryRun ? undefined : auditRef.path,
    idempotentReplay: applied.idempotentReplay,
    allowedSentMailboxes: scope.allowedSentMailboxes,
    // W114: 이 창을 읽으며 파싱 실패로 건너뛴 메일(수신자 없음 등) — 조용히 사라지지 않게 노출한다.
    skippedNoRecipient: liveRead.skipped.noRecipient,
    skippedUnparseable: liveRead.skipped.unparseable,
    cursorPreview: liveRead.cursor
      ? {
          mailbox: liveRead.cursor.mailbox,
          nextLastUid: liveRead.cursor.nextLastUid,
          uidValidity: liveRead.cursor.uidValidity,
        }
      : undefined,
  };
}

/**
 * W117 백필 — **이미 편입된 발송분의 본문을 IMAP 에서 되찾아 원장에 채운다**.
 *
 * ■ 무엇이 남아 있고 무엇이 없는가 (실측: transactionWriteCandidate 의 쓰기 집합)
 *   편입 행에 남는 식별자는 `providerMessageIdHash`(정규화 Message-ID 의 sha256) 하나뿐이다.
 *   원문 Message-ID 는 `FieldValue.delete()` 로 지워지고, IMAP `uid`/`mailbox`/`uidValidity` 는
 *   애초에 쓰지 않는다. 그래서 **IMAP SEARCH HEADER Message-ID 로 되찾는 길은 없다** — 검색에
 *   넣을 원문 id 가 우리 쪽에 없다.
 *
 * ■ 그래서 방향을 뒤집는다 (추측 없음)
 *   메일함에서 우리가 아는 값을 **만들어** 맞춘다: Sent 편지함을 UID 순으로 훑으며 각 메일의
 *   Message-ID 를 같은 방식으로 정규화·해싱해 원장 행을 등가 조회한다. 제목+날짜 근사 검색은
 *   쓰지 않는다 — 같은 제목의 대량 발송이 실제로 존재하고(합격 통보 38회 등, W111-A 실측),
 *   근사 매칭은 남의 대화에 남의 본문을 붙이는 오귀속을 만든다.
 *
 * ■ 오귀속 방지 2중 잠금
 *   ① Message-ID 해시 등가 일치 + 그 결과가 **정확히 1건**일 것(0건·2건 이상은 손대지 않는다).
 *   ② 되찾은 본문의 `bodyHash` 가 원장에 이미 있는 `bodyHash` 와 **일치**할 것.
 *      ②가 핵심이다 — 해시가 같다는 건 같은 본문이라는 뜻이고, 다르면 그 메일이 아니거나 내용이
 *      바뀐 것이므로 채우지 않는다. 즉 이 레인은 **새로운 사실을 만들지 않고**, 이미 원장이
 *      해시로 알고 있던 본문의 평문을 복원할 뿐이다.
 *
 * ■ 커서와 예산
 *   편입 커서(`mail_sent_import_cursors`)는 만지지 않는다 — 공유하면 백필이 편입 진행률을 앞당겨
 *   아직 편입 안 된 메일을 영영 건너뛴다. 자체 커서는 `"{uidValidity}:{lastUid}"` 문자열로
 *   호출자에게 돌려주고 다음 호출이 그대로 넘긴다(상태 문서 없음). uidValidity 가 바뀌면 UID 가
 *   재사용됐다는 뜻이라 커서를 버리고 처음부터 다시 훑는다(`cursorReset`).
 *   회당 상한은 IMAP 왕복이라 보수적으로 잡는다(기본 25, 최대 50).
 */
const BODY_HYDRATE_AUDIT_COLLECTION = "external_sent_body_hydrate_audits";
const BODY_HYDRATE_MAX_ROWS = 50;
const BODY_HYDRATE_DEFAULT_ROWS = 25;
const BODY_HYDRATE_SOURCE = "external_sent_body_hydrate";

export type ExternalSentBodyHydrateResult = {
  ok: boolean;
  dryRun: boolean;
  mode: "dry_run" | "actual";
  /** 라이브 IMAP 이 꺼진 환경에서 아무것도 하지 않고 돌아왔을 때의 사유. */
  skippedReason?: string;
  /** 이번 회차가 메일함에서 읽어 해석에 성공한 메일 수. */
  scanned: number;
  /** 본문을 채운(또는 dryRun 에서 채울) 소스 문서 수. */
  hydrated: number;
  /**
   * 본문은 이미 있었는데 원장 프리뷰만 비어 있어 되돌린 수(부분 하이드레이션 복구).
   * `hydrated` 와 구분한다 — 이건 본문을 새로 채운 게 아니다.
   */
  previewRepairs: number;
  /** 원장 행에 프리뷰를 새로 쓴 수. */
  ledgerPreviewWrites: number;
  /** W117-R1 진단축: Message-ID 해시로 지목한 수. */
  matchedByProviderId: number;
  /**
   * W117-R1 진단축: 본문+수신자 해시로 지목한 수. 이 숫자가 크면 원인은 Message-ID **입력**쪽
   * (헤더 부재 → 합성 id, uidValidity/UID 변동)이지 본문·정규화 쪽이 아니다.
   */
  matchedByBodyIdentity: number;
  /**
   * 이번 회차가 읽은 메일 중 Message-ID 헤더가 없어 합성 id 로 떨어진 수.
   * `matchedByBodyIdentity` 와 함께 보면 원인이 한 줄로 확정된다.
   */
  syntheticProviderId: number;
  /** 이미 물질화된 대화 메시지의 문구를 갱신한 수(스티치 relabel 재사용). */
  relabeledMessages: number;
  /**
   * 본문은 채웠지만 문구 갱신이 실패한 수. 본문 쓰기는 이미 끝났으므로 이 회차를 통째로 되돌리지
   * 않고 숫자로 남긴다 — 형제 콜러블(`stitchExternalSentConversations` mode: "relabel")로 잇는다.
   */
  relabelFailed: number;
  /** 발신 계정이 승인 목록 밖이라 건너뛴 수. */
  skippedUnapprovedFrom: number;
  /** 대응하는 편입 행을 못 찾은 수(편입되지 않은 메일 — 손대지 않는다). */
  skippedNoLedgerRow: number;
  /** 같은 Message-ID 해시의 편입 행이 2건 이상이라 지목할 수 없던 수. */
  skippedAmbiguous: number;
  /** 본문 해시가 원장 값과 달라 채우지 않은 수(오귀속 방지 — 무추측). */
  skippedBodyHashMismatch: number;
  /** 이미 본문이 있어 건드릴 필요가 없던 수(멱등). */
  alreadyHydrated: number;
  skippedNoRecipient: number;
  skippedUnparseable: number;
  /** 시간 예산 소진으로 이번 회차가 손대지 않은 수. 커서는 여기까지만 전진한다. */
  deferred: number;
  auditRef: string;
  cursor: string;
  nextCursor: string;
  /** uidValidity 가 바뀌어 커서를 버리고 처음부터 훑었는가. */
  cursorReset: boolean;
  done: boolean;
};

type HydrateCursor = { uidValidity: string; lastUid: number };

/** `"{uidValidity}:{lastUid}"`. 형식이 아니면 커서 없음으로 취급한다(처음부터). */
function parseHydrateCursor(value: string): HydrateCursor | undefined {
  const match = /^([^:]{1,64}):(\d{1,12})$/.exec(value.trim());
  if (!match) return undefined;
  return { uidValidity: match[1], lastUid: Math.max(0, Math.trunc(Number(match[2]))) };
}

function formatHydrateCursor(uidValidity: string, lastUid: number): string {
  return `${uidValidity}:${Math.max(0, Math.trunc(lastUid))}`;
}

/** 편입 행을 지목한 축. 다음 회차의 숫자가 곧 원인 진단이 되도록 결말과 함께 남긴다. */
type HydrateMatchAxis = "provider_message_id" | "body_identity";

/** 편입 레인이 쓴 행만 대상으로 좁힌다(툴 발송·인바운드 원문은 이 레인의 것이 아니다). */
function externalImportDocs(
  docs: readonly FirebaseFirestore.QueryDocumentSnapshot[],
): FirebaseFirestore.QueryDocumentSnapshot[] {
  return docs.filter((doc) =>
    asString(asRecord(doc.data()).source, "") === "external_sent_mail_import");
}

/**
 * 되찾은 메일 한 통을 원장 행에 맞춘다. 맞출 수 없으면 **사유를 돌려주고 아무것도 쓰지 않는다**.
 * 여기서 "못 맞췄다"와 "이미 돼 있다"를 구분하는 게 이 레인의 정직성 축이다.
 *
 * ■ W117-R1 (프로드 실측 2026-08-24): Message-ID 축 하나로는 부족했다
 *   전량 순회 211회차 결과 hydrated 1,924 / noLedger 8,595 / mismatch 0. 메일함(~10,519통)과
 *   편입 원장(10,403행)이 거의 1:1인데 82%가 "대응 행 없음"으로 떨어졌다 — 툴 메일이 아니라
 *   **매칭 실패**다. 편입 당시 코드(76cb3299)와 현재의 `normalizeMessageId`·`providerMessageIdHash`
 *   ·`hashHex`·`safeId` 는 **바이트 단위로 동일**해(git 대조 완료) 정규화 드리프트는 원인이 아니다.
 *   남는 갈래는 전부 Message-ID **입력**쪽이다: 헤더가 없어 합성 id(`imap-{mailbox}-{uidValidity}-{uid}`)로
 *   떨어진 메일은 그 사이 uidValidity/UID 가 바뀌면 같은 메일이라도 다른 해시가 된다.
 *
 * ■ 그래서 두 번째 축을 **추측이 아니라 등가 일치로** 연다
 *   `bodyHash`(본문 전문 해시) + `toHash`(수신자 해시) **둘 다 등가 일치**하고 그 결과가 정확히
 *   1건일 때만 지목한다. 제목+날짜 근사 검색과 다르다 — 본문이 한 글자라도 다르면 해시가 어긋나고,
 *   같은 본문의 대량 발송(합격 통보 38회)은 수신자 축이 갈라놓는다. 둘 다 같고 2건 이상이면
 *   같은 사람에게 같은 본문을 두 번 보낸 것이라 어느 행인지 알 수 없으므로 **손대지 않는다**.
 *   즉 오귀속 불가라는 성질은 그대로다: 이 레인은 여전히 원장이 이미 알고 있던 사실만 복원한다.
 */
async function resolveHydrateTarget(parsed: ParsedSentMail): Promise<
  | {
    kind: "target";
    ref: FirebaseFirestore.DocumentReference;
    trackingId: string;
    /** 본문은 이미 있고 원장 프리뷰만 비어 있던 행(부분 하이드레이션 복구). */
    repairOnly: boolean;
    /** 어느 축이 이 행을 지목했는가 — 회차 숫자가 곧 원인 진단이 된다. */
    axis: HydrateMatchAxis;
  }
  | { kind: "skip"; reason: "no_ledger_row" | "ambiguous" | "body_hash_mismatch" | "already_hydrated" }
> {
  const canonicalHash = providerMessageIdHash(parsed.providerMessageIdNormalized);
  const byProviderId = externalImportDocs((await adminDb
    .collection(MESSAGE_SOURCES_COLLECTION)
    .where("providerMessageIdHash", "==", canonicalHash)
    .limit(5)
    .get()).docs);
  // 2건 이상이면 어느 쪽이 이 메일인지 모른다 — 지어내지 않고 사람이 볼 수 있게 숫자로 남긴다.
  if (byProviderId.length > 1) return { kind: "skip", reason: "ambiguous" };
  let axis: HydrateMatchAxis = "provider_message_id";
  let doc = byProviderId[0];
  if (!doc) {
    // 축 ②: 본문 해시 + 수신자 해시 등가 일치(둘 다). 본문 해시가 없으면 대조축 자체가 없다.
    if (!parsed.bodyHash || !parsed.toHash) return { kind: "skip", reason: "no_ledger_row" };
    const byBodyIdentity = externalImportDocs((await adminDb
      .collection(MESSAGE_SOURCES_COLLECTION)
      .where("bodyHash", "==", parsed.bodyHash)
      .where("toHash", "==", parsed.toHash)
      .limit(5)
      .get()).docs);
    if (byBodyIdentity.length === 0) return { kind: "skip", reason: "no_ledger_row" };
    if (byBodyIdentity.length > 1) return { kind: "skip", reason: "ambiguous" };
    doc = byBodyIdentity[0];
    axis = "body_identity";
  }
  const data = asRecord(doc.data());
  // ② 본문 해시 잠금: 원장이 해시로 알고 있던 그 본문일 때만 평문을 복원한다.
  // (축 ② 로 온 행은 이 조건이 곧 조회 키라 항상 참이다 — 그래도 한 곳에서 다시 확인한다.)
  if (asString(data.bodyHash, "") !== parsed.bodyHash) {
    return { kind: "skip", reason: "body_hash_mismatch" };
  }
  const trackingId = asString(data.trackingId, "");
  if (asString(data.body, "")) {
    // 본문만 보고 넘기면 **부분 하이드레이션**이 영영 남는다: 본문은 들어갔는데 원장 프리뷰가
    // 비어 있는 행은 다음 회차에도 already_hydrated 로 스킵돼 목록·스티치가 계속 제목만 쓴다.
    // 그래서 원장 프리뷰 유무까지 보고, 비어 있으면 복구 대상으로 돌려준다.
    // 이 추가 읽기는 already_hydrated 후보에서만 일어난다(회차당 상한 = limit, IMAP 왕복에 비해 무시할 비용).
    if (!trackingId) return { kind: "skip", reason: "already_hydrated" };
    const ledger = await adminDb.collection(OUTBOX_COLLECTION).doc(trackingId).get();
    if (asString(asRecord(ledger.data()).bodyPreview, "")) {
      return { kind: "skip", reason: "already_hydrated" };
    }
    return { kind: "target", ref: doc.ref, trackingId, repairOnly: true, axis };
  }
  return { kind: "target", ref: doc.ref, trackingId, repairOnly: false, axis };
}

export async function hydrateExternalSentBodiesCore(
  input: {
    cursor?: string;
    limit?: number;
    dryRun?: boolean;
    deadlineMs?: number;
    actorUid?: string;
    actorRole?: string;
    /** 에뮬레이터 전용 주입구 — resolveSentScope 가 FUNCTIONS_EMULATOR 밖에서 거부한다. */
    emulatorImap?: Record<string, unknown>;
    sentMailbox?: string;
  } = {},
): Promise<ExternalSentBodyHydrateResult> {
  const dryRun = input.dryRun !== false;
  const cursor = asString(input.cursor, "");
  const actorUid = asString(input.actorUid, "");
  const actorRole = asString(input.actorRole, "");
  const limit = Math.min(
    Math.max(Math.trunc(Number(input.limit ?? BODY_HYDRATE_DEFAULT_ROWS)) || BODY_HYDRATE_DEFAULT_ROWS, 1),
    BODY_HYDRATE_MAX_ROWS,
  );
  const deadlineMs = Number.isFinite(Number(input.deadlineMs))
    ? Number(input.deadlineMs)
    : Number.POSITIVE_INFINITY;
  const data: Record<string, unknown> = {
    limit,
    ...(input.emulatorImap ? { emulatorImap: input.emulatorImap } : {}),
    ...(input.sentMailbox ? { sentMailbox: input.sentMailbox } : {}),
  };
  const empty: ExternalSentBodyHydrateResult = {
    ok: true, dryRun, mode: dryRun ? "dry_run" : "actual", scanned: 0, hydrated: 0,
    previewRepairs: 0, ledgerPreviewWrites: 0, relabeledMessages: 0, relabelFailed: 0,
    matchedByProviderId: 0, matchedByBodyIdentity: 0, syntheticProviderId: 0, skippedUnapprovedFrom: 0,
    skippedNoLedgerRow: 0, skippedAmbiguous: 0, skippedBodyHashMismatch: 0, alreadyHydrated: 0,
    skippedNoRecipient: 0, skippedUnparseable: 0, deferred: 0, auditRef: "", cursor,
    nextCursor: cursor, cursorReset: false, done: false,
  };
  // 라이브 IMAP 이 꺼진 환경(스테이징·에뮬)에서는 조용히 건너뛴다 — 던지면 재시도만 쌓인다.
  if (!input.emulatorImap && !liveIntegrationsEnabled("imap")) {
    return { ...empty, skippedReason: "imap_disabled", done: true };
  }

  const scope = await resolveSentScope(data);
  if (scope.sourceMode !== "imap") {
    // 본문 복원은 메일함에서만 나온다 — fixture 경로는 이 레인의 대상이 아니다.
    return { ...empty, skippedReason: "imap_source_required", done: true };
  }
  const requested = parseHydrateCursor(cursor);
  const firstRead = await readSentMailboxMessages(data, scope, {
    afterUid: requested?.lastUid ?? 0,
  });
  const scanUidValidity = firstRead.scan?.uidValidity ?? "";
  // uidValidity 가 바뀌면 서버가 UID 를 재사용했다는 뜻이다 — 이전 커서의 UID 는 다른 메일을
  // 가리킨다. 그 커서로 계속 가면 구간을 통째로 건너뛴다. 버리고 처음부터 다시 훑는다.
  const cursorReset = Boolean(requested && scanUidValidity && requested.uidValidity !== scanUidValidity);
  const read = cursorReset
    ? await readSentMailboxMessages(data, scope, { afterUid: 0 })
    : firstRead;
  const rows = read.rows;
  const scan = read.scan;

  const allowedFrom = new Set(scope.allowedFromHashes);
  const counts = {
    scanned: 0, hydrated: 0, previewRepairs: 0, ledgerPreviewWrites: 0, relabeledMessages: 0,
    relabelFailed: 0, matchedByProviderId: 0, matchedByBodyIdentity: 0, syntheticProviderId: 0,
    skippedUnapprovedFrom: 0, skippedNoLedgerRow: 0, skippedAmbiguous: 0,
    skippedBodyHashMismatch: 0, alreadyHydrated: 0, deferred: 0,
  };
  const skipCounter = {
    no_ledger_row: "skippedNoLedgerRow",
    ambiguous: "skippedAmbiguous",
    body_hash_mismatch: "skippedBodyHashMismatch",
    already_hydrated: "alreadyHydrated",
  } as const;
  const hydratedTrackingIds: string[] = [];
  const hydratedAtIso = new Date().toISOString();
  /** 예산이 끊겼을 때 커서는 **실제로 처리한 마지막 UID** 까지만 간다(안 그러면 남은 메일을 영영 건너뛴다). */
  let lastProcessedUid = 0;

  for (const row of rows) {
    if (Date.now() > deadlineMs) {
      counts.deferred += 1;
      continue;
    }
    if (!row.fromHash || !allowedFrom.has(row.fromHash)) {
      counts.skippedUnapprovedFrom += 1;
      lastProcessedUid = Math.max(lastProcessedUid, row.uid ?? 0);
      continue;
    }
    counts.scanned += 1;
    // Message-ID 헤더가 없어 합성 id 로 떨어진 메일 — 축 ① 이 UID/uidValidity 변동에 취약해지는
    // 정확히 그 부류다. 원인을 사람이 숫자 한 줄로 읽을 수 있게 센다(추가 조회 없음).
    if (row.providerMessageId === safeId(row.sourceId)) counts.syntheticProviderId += 1;
    const target = await resolveHydrateTarget(row);
    if (target.kind === "skip") {
      counts[skipCounter[target.reason]] += 1;
      lastProcessedUid = Math.max(lastProcessedUid, row.uid ?? 0);
      continue;
    }
    if (target.repairOnly) counts.previewRepairs += 1;
    else counts.hydrated += 1;
    if (target.axis === "body_identity") counts.matchedByBodyIdentity += 1;
    else counts.matchedByProviderId += 1;
    if (!dryRun) {
      // 소스 본문과 원장 프리뷰는 **한 배치로 원자적으로** 쓴다. 순차 쓰기였다면 그 사이에서
      // 끊길 때 본문만 들어간 부분 상태가 남고, 다음 회차가 그걸 완료로 오독한다(위 복구 분기와
      // 한 쌍이다 — 이 배치가 새 부분 상태를 만들지 않고, 그 분기가 남은 것을 되돌린다).
      const batch = adminDb.batch();
      batch.set(target.ref, {
        // 전방 편입(transactionWriteCandidate)과 **같은 자리**에 같은 모양으로 쓴다.
        body: row.body,
        bodyTruncated: row.bodyTruncated,
        bodyPreview: row.bodyPreview,
        bodyHydratedAtIso: hydratedAtIso,
        bodyHydrationSource: BODY_HYDRATE_SOURCE,
        // 어느 축으로 지목했는지 행에 남긴다 — 사후에 "왜 이 본문이 여기 붙었나"를 되짚을 근거다.
        bodyHydrationMatch: target.axis,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      if (target.trackingId) {
        batch.set(adminDb.collection(OUTBOX_COLLECTION).doc(target.trackingId),
          { bodyPreview: row.bodyPreview }, { merge: true });
      }
      await batch.commit();
      if (target.trackingId) {
        counts.ledgerPreviewWrites += 1;
        hydratedTrackingIds.push(target.trackingId);
      }
    }
    lastProcessedUid = Math.max(lastProcessedUid, row.uid ?? 0);
  }

  // 이미 물질화된 대화 메시지의 문구는 **스티치의 relabel 을 그대로 재사용**해 갱신한다.
  // 여기서 메시지 문서를 직접 쓰면 같은 문서에 두 번째 쓰기 경로가 생긴다 — 그게 곧 우회로다.
  if (!dryRun && hydratedTrackingIds.length > 0) {
    // 본문은 이미 원장에 들어갔다(내구적). 여기서 던지면 그 회차는 실패로 보이지만 다음 회차는
    // `alreadyHydrated` 로 지나가 문구 갱신이 영영 누락된다 — 그래서 격리하고 숫자로 남긴다.
    // 실패분은 형제 콜러블(`stitchExternalSentConversations` mode: "relabel")로 따로 돌릴 수 있다.
    try {
      const relabel = await stitchExternalSentConversationsCore({
        mode: "relabel",
        trackingIds: hydratedTrackingIds,
        // 형제 콜러블과 같은 예산을 공유한다 — 안 넘기면 relabel 이 무한 예산으로 돌아
        // 함수 상한(300s)을 넘길 수 있다.
        stitchDeadlineMs: deadlineMs,
        actorUid: actorUid || undefined,
        actorRole: actorRole || undefined,
      });
      counts.relabeledMessages = relabel.relabeled;
    } catch (error) {
      counts.relabelFailed = hydratedTrackingIds.length;
      console.error("[external-sent-body-hydrate]", JSON.stringify({
        outcome: "relabel_failed",
        count: hydratedTrackingIds.length,
        errorCode: safeOutboundFailureEvidence(error, "external-sent-body-hydrate:relabel").errorCode,
      }));
    }
  }

  // 창이 상한까지 차지 않았으면 더 읽을 메일이 없다는 뜻이다. **파싱 실패로 rows 에 못 들어온
  // UID 도 이 창이 소비한 것**이라 함께 센다 — rows 만 세면 불량 메일 몇 통 때문에 아직 남은
  // 구간을 "다 훑었다"로 잘못 끝낸다.
  const consumedUidCount = rows.length + totalParseSkipCount(read.skipped);
  const exhausted = consumedUidCount < limit && counts.deferred === 0;
  // 리셋 회차에서 진행이 0이면 **옛 uidValidity 의 lastUid 로 되돌아가면 안 된다** — 그 숫자는
  // 새 validity 에서 다른 메일을 가리키므로, 결합하는 순간 그 앞 구간이 통째로 영구 스킵된다.
  // 리셋은 "처음부터 다시"라는 뜻이므로 진행이 없으면 0 으로 남는다.
  const deferredFallbackUid = cursorReset ? 0 : (requested?.lastUid ?? 0);
  const nextUid = counts.deferred > 0
    ? (lastProcessedUid || deferredFallbackUid)
    : Math.max(scan?.maxUid ?? 0, lastProcessedUid);
  const nextCursor = exhausted || !scanUidValidity
    ? ""
    : formatHydrateCursor(scanUidValidity, nextUid);

  let auditRef = "";
  if (!dryRun && counts.scanned > 0) {
    const auditDoc = adminDb.collection(BODY_HYDRATE_AUDIT_COLLECTION).doc();
    // LOG-P0-010: 회차당 감사 문서 1건. 평문(본문·제목·수신자)은 남기지 않는다 — 숫자와 커서뿐이다.
    await auditDoc.set({
      id: auditDoc.id,
      schemaVersion: "external-sent-body-hydrate-audit-v1",
      actorUidHash: hashHex(actorUid, 32),
      actorRole,
      runAtIso: hydratedAtIso,
      expireAt: expireAt180DaysFromIso(hydratedAtIso),
      cursorStart: cursor,
      cursorEnd: nextCursor,
      cursorReset,
      ...counts,
      skippedNoRecipient: read.skipped.noRecipient,
      skippedUnparseable: read.skipped.unparseable,
      createdAt: FieldValue.serverTimestamp(),
    });
    auditRef = auditDoc.path;
  }

  const result: ExternalSentBodyHydrateResult = {
    ok: true,
    dryRun,
    mode: dryRun ? "dry_run" : "actual",
    ...counts,
    skippedNoRecipient: read.skipped.noRecipient,
    skippedUnparseable: read.skipped.unparseable,
    auditRef,
    cursor,
    nextCursor,
    cursorReset,
    done: !nextCursor,
  };
  // 회차당 로그 한 줄. 본문·제목·수신자 원문은 절대 싣지 않는다(closed log contract).
  console.log("[external-sent-body-hydrate]", JSON.stringify({
    outcome: "run",
    dryRun,
    actorRole,
    ...counts,
    cursorReset,
    auditWritten: Boolean(auditRef),
    cursorAdvanced: Boolean(nextCursor),
  }));
  return result;
}

/**
 * 백필 콜러블. `dryRun` 이 기본이고 `{ dryRun: false, actual: true }` 에서만 쓴다.
 * 역할 게이트는 형제 편입 콜러블(`importManualSentMailToOutbox`)과 같은 등급이다 —
 * 이 레인은 그 편입분에만 작용하므로 더 넓지도 좁지도 않아야 한다.
 */
export async function hydrateExternalSentBodies(
  request: CallableRequestShape,
): Promise<ExternalSentBodyHydrateResult | ExternalSentSourceRepairResult> {
  const auth = assertNonGuestAuth(request, "mail_external_sent_body_hydrate.run", IMPORT_ROLES);
  const data = asRecord(request.data);
  const dryRun = data.dryRun !== false;
  const actual = data.actual === true || data.execute === true;
  if (!dryRun && !actual) {
    throw Object.assign(
      new Error("invalid-argument: actual:true is required when dryRun is false."),
      { code: "invalid-argument", errorCode: "hydrate_external_sent_bodies_actual_required" },
    );
  }
  // W117-R2 복구 모드. 같은 역할 게이트·같은 dryRun 계약을 쓰되 **IMAP 에 붙기 전에** 갈라진다 —
  // 분류 복원은 순수 원장 작업이라 메일함 접속이 필요 없다(불필요한 프로드 메일함 접근 금지).
  if (asString(data.mode, "") === "reclassify") {
    return repairExternalSentSourceMisclassificationCore({
      cursor: asString(data.cursor, ""),
      limit: Number(data.limit),
      dryRun,
      deadlineMs: Date.now() + 240_000,
      actorUid: auth.userId,
      actorRole: auth.role,
    });
  }
  return hydrateExternalSentBodiesCore({
    cursor: asString(data.cursor, ""),
    limit: Number(data.limit),
    dryRun,
    // 함수 예산(300s) 안에서 감사 문서 쓰기까지 끝나도록 여유를 남긴다 — 형제 스티치와 같은 규칙.
    deadlineMs: Date.now() + 240_000,
    actorUid: auth.userId,
    actorRole: auth.role,
    ...(Object.keys(asRecord(data.emulatorImap)).length > 0
      ? { emulatorImap: asRecord(data.emulatorImap) }
      : {}),
    ...(asString(data.sentMailbox, "") ? { sentMailbox: asString(data.sentMailbox, "") } : {}),
  });
}

/**
 * W117-R2 데이터 복구 — **오염된 편입 분류를 되돌린다**.
 *
 * ■ 무엇이 오염됐나 (프로드 실측 2026-08-24)
 *   드레인 임포터가 툴 발송의 Sent 사본을 읽으면서 그 툴 원장 행의 `source` 를
 *   `external_sent_mail_import` 로 덮었다(경로는 buildCandidate 의 W117-R2 주석 참조).
 *   증상 3종: ① external 총계 오염(10,403 중 상당수가 툴 행) ② 스티치가 툴 메일을 물질화해
 *   자동 메일이 "보낸편지함 가져옴" 으로 노출(툴 행 자체가 external 이 되어 중복 억제도 무력)
 *   ③ 본문 백필이 구조적으로 불가(대응 `message_sources/external-sent-{tid}` 문서가 없다).
 *
 * ■ 판별과 복원은 **증거로만** 한다 (지어내지 않는다)
 *   판별: `source == external_sent_mail_import` 인데 `message_sources/external-sent-{tid}` 가 **없다**.
 *         이 레인은 정상 편입 시 그 문서를 반드시 만든다(레거시 마이그레이션 행도 갖고 있다).
 *   복원값: 툴 원장 쓰기(mailSignature.recordMailOutboundLog)가 발송 시점에 남긴 **`deliverySource`**
 *         (= 그 레인이 준 `source` 원본). 즉 우리가 값을 고르는 게 아니라 **원래 기록을 되읽는다**.
 *   `deliverySource` 가 없거나 편입값과 같아 원 값을 알 수 없으면 **손대지 않고** 숫자로만 남긴다
 *   (`unresolvedOriginalSource`) — 근거 없는 복원은 두 번째 오염이다.
 *
 * ■ 동반 정리
 *   - 끊긴 포인터: `sourceRef` 가 없는 `external-sent-{tid}` 를 가리키면 그때만 지운다(증명 가능).
 *   - 물질화 메시지: 기존 `hiddenReason: "tool_duplicate"` 레인으로 숨긴다 — 새 숨김 축을 만들지
 *     않으므로 기존 `{ mode: "unhide" }` 로 그대로 가역이다. 복원 뒤에는 그 행이 스티치의 대상에서
 *     빠지므로(source 가 바뀐다) **이 회차에 같이** 해야 한다.
 *   - 대화 목록 프리뷰는 고쳐 쓰지 않는다 — 지어낼 값이 없다. 형제 레인과 같이 숫자로만 남긴다.
 */
const SOURCE_REPAIR_AUDIT_COLLECTION = "external_sent_source_repair_audits";
const SOURCE_REPAIR_MAX_ROWS = 200;
const SOURCE_REPAIR_DEFAULT_ROWS = 100;
const HIDDEN_TOOL_DUPLICATE_REASON = "tool_duplicate";

export type ExternalSentSourceRepairResult = {
  ok: boolean;
  dryRun: boolean;
  mode: "reclassify";
  /** 이번 회차가 훑은 `source == external_sent_mail_import` 행 수. */
  scanned: number;
  /** 대응 소스 문서가 있어 정상 편입으로 확인된 행 수(무동작). */
  intact: number;
  /** `deliverySource` 증거로 원 레인 값을 되돌린 행 수. */
  restored: number;
  /** 되돌린 행의 물질화 메시지를 숨긴 수(tool_duplicate — unhide 로 가역). */
  hiddenMessages: number;
  /** 숨긴 메시지가 대화 목록 프리뷰로 남아 있는 수(고쳐 쓰지 않고 숫자로만 남긴다). */
  previewStaleAfterHide: number;
  /** 없는 소스 문서를 가리키던 `sourceRef` 를 지운 수. */
  danglingSourceRefsCleared: number;
  /** 오염으로 보이지만 원 레인 값을 알 수 없어 **손대지 않은** 행 수. */
  unresolvedOriginalSource: number;
  /** 되돌린 행 중 `mailType` 이 아직 임포터 값(`manual_external_gmail`)인 수(후속 판단용). */
  mailTypeStillImporter: number;
  /** 문서 id 와 본문 trackingId 가 어긋나 손대지 않은 행 수. */
  skippedIdMismatch: number;
  /** 시간 예산 소진으로 손대지 않은 행 수. 커서는 여기까지만 전진한다. */
  deferred: number;
  auditRef: string;
  cursor: string;
  nextCursor: string;
  done: boolean;
};

export async function repairExternalSentSourceMisclassificationCore(
  input: {
    cursor?: string;
    limit?: number;
    dryRun?: boolean;
    deadlineMs?: number;
    actorUid?: string;
    actorRole?: string;
  } = {},
): Promise<ExternalSentSourceRepairResult> {
  const dryRun = input.dryRun !== false;
  const cursor = asString(input.cursor, "");
  const actorUid = asString(input.actorUid, "");
  const actorRole = asString(input.actorRole, "");
  const limit = Math.min(
    Math.max(Math.trunc(Number(input.limit ?? SOURCE_REPAIR_DEFAULT_ROWS)) || SOURCE_REPAIR_DEFAULT_ROWS, 1),
    SOURCE_REPAIR_MAX_ROWS,
  );
  const deadlineMs = Number.isFinite(Number(input.deadlineMs))
    ? Number(input.deadlineMs)
    : Number.POSITIVE_INFINITY;

  // 형제 스티치와 **같은 스캔 모양**을 쓴다(등가 + 문서 id 정렬) — 프로드에서 이미 도는 형태라
  // 색인 요구가 새로 생기지 않는다.
  let query = adminDb
    .collection(OUTBOX_COLLECTION)
    .where("source", "==", "external_sent_mail_import")
    .orderBy(FieldPath.documentId());
  if (cursor) query = query.startAfter(cursor);
  const snapshot = await query.limit(limit).get();

  const counts = {
    scanned: 0, intact: 0, restored: 0, hiddenMessages: 0, previewStaleAfterHide: 0,
    danglingSourceRefsCleared: 0, unresolvedOriginalSource: 0, mailTypeStillImporter: 0,
    skippedIdMismatch: 0, deferred: 0,
  };
  const repairedAtIso = new Date().toISOString();
  let lastProcessedId = "";

  for (const doc of snapshot.docs) {
    if (Date.now() > deadlineMs) {
      counts.deferred += 1;
      continue;
    }
    counts.scanned += 1;
    const data = asRecord(doc.data());
    const trackingId = asString(data.trackingId, "");
    // 문서 id 와 본문 trackingId 가 다르면 어느 쪽이 진짜인지 모른다 — 형제 스티치와 같은 판단.
    if (!trackingId || trackingId !== doc.id) {
      counts.skippedIdMismatch += 1;
      lastProcessedId = doc.id;
      continue;
    }
    const sourceDocRef = adminDb
      .collection(MESSAGE_SOURCES_COLLECTION)
      .doc(safeId(`external-sent-${trackingId}`));
    if ((await sourceDocRef.get()).exists) {
      counts.intact += 1;
      lastProcessedId = doc.id;
      continue;
    }
    const deliverySource = asString(data.deliverySource, "");
    if (!deliverySource || deliverySource === "external_sent_mail_import") {
      // 원 레인 값을 알 수 없다. 여기서 무언가를 고르면 그게 두 번째 오염이다 — 숫자로만 남긴다.
      counts.unresolvedOriginalSource += 1;
      lastProcessedId = doc.id;
      continue;
    }

    const danglingSourceRef = asString(data.sourceRef, "") === sourceDocRef.path;
    const stitchedConversationId = asString(data.stitchedConversationId, "");
    const messageRef = stitchedConversationId
      ? adminDb.collection("conversations").doc(stitchedConversationId)
        .collection("messages").doc(`msg-external-sent-${trackingId}`)
      : undefined;
    let hideMessage = false;
    let previewStale = false;
    if (messageRef) {
      const messageSnapshot = await messageRef.get();
      if (messageSnapshot.exists) {
        const messageData = asRecord(messageSnapshot.data());
        hideMessage = asString(messageData.hiddenReason, "") !== HIDDEN_TOOL_DUPLICATE_REASON;
        if (hideMessage) {
          const conversation = asRecord((await adminDb.collection("conversations")
            .doc(stitchedConversationId).get()).data());
          previewStale = asString(conversation.lastMessage, "") === asString(messageData.text, "")
            && Boolean(asString(messageData.text, ""));
        }
      }
    }

    counts.restored += 1;
    if (danglingSourceRef) counts.danglingSourceRefsCleared += 1;
    if (hideMessage) counts.hiddenMessages += 1;
    if (previewStale) counts.previewStaleAfterHide += 1;
    if (asString(data.mailType, "") === "manual_external_gmail") counts.mailTypeStillImporter += 1;

    if (!dryRun) {
      // 분류 복원과 메시지 숨김은 한 배치다 — 사이에서 끊기면 "툴 행인데 화면엔 편입 메시지"
      // 라는 어중간한 상태가 남는다.
      const batch = adminDb.batch();
      batch.set(doc.ref, {
        source: deliverySource,
        sourceReclassifiedFrom: "external_sent_mail_import",
        sourceReclassifiedAtIso: repairedAtIso,
        ...(danglingSourceRef ? { sourceRef: FieldValue.delete() } : {}),
      }, { merge: true });
      if (hideMessage && messageRef) {
        batch.set(messageRef, {
          hiddenReason: HIDDEN_TOOL_DUPLICATE_REASON,
          hiddenAtIso: repairedAtIso,
        }, { merge: true });
      }
      await batch.commit();
    }
    lastProcessedId = doc.id;
  }

  const exhausted = snapshot.docs.length < limit && counts.deferred === 0;
  const nextCursor = exhausted ? "" : (lastProcessedId || cursor);

  let auditRef = "";
  if (!dryRun && counts.scanned > 0) {
    const auditDoc = adminDb.collection(SOURCE_REPAIR_AUDIT_COLLECTION).doc();
    // 평문(제목·수신자·본문)은 남기지 않는다 — 숫자와 커서뿐이다.
    await auditDoc.set({
      id: auditDoc.id,
      schemaVersion: "external-sent-source-repair-audit-v1",
      actorUidHash: hashHex(actorUid, 32),
      actorRole,
      runAtIso: repairedAtIso,
      expireAt: expireAt180DaysFromIso(repairedAtIso),
      cursorStart: cursor,
      cursorEnd: nextCursor,
      ...counts,
      createdAt: FieldValue.serverTimestamp(),
    });
    auditRef = auditDoc.path;
  }

  const result: ExternalSentSourceRepairResult = {
    ok: true,
    dryRun,
    mode: "reclassify",
    ...counts,
    auditRef,
    cursor,
    nextCursor,
    done: !nextCursor,
  };
  console.log("[external-sent-source-repair]", JSON.stringify({
    outcome: "run",
    dryRun,
    actorRole,
    ...counts,
    auditWritten: Boolean(auditRef),
    cursorAdvanced: Boolean(nextCursor),
  }));
  return result;
}
