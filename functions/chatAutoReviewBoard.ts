// /chat/auto 검토 보드 (2026-10-05) — listChatAutoReviewBoard: READ-ONLY callable.
//
// Population: every scp conversation the caller can already see that has received at least one
// inbound (newest activity first) — pending ones AND closed / we-replied-last / no-reply-needed /
// org-automation-off ones, which land in "이번 발송 제외" with their reason. Visibility is the SAME
// predicate the existing reads use (canReadConversationRowForScope for the scp mailbox + the
// registration gate + the scp org gate); nothing is widened. Verdicts come from the pure model in
// chatAutoReviewBoardModel.ts.
//
// Read order per conversation (body last, and only when allowed):
//   1. conversation metadata (already scanned)
//   2. latest inbound message_sources record — METADATA projection only (conversationId, sender
//      binding, sender hash; never body/text/summary/subject)
//   3. other conversations of the same address — metadata projection only (AI on/off, case, intent,
//      gate reason) for address-level protection and for the queue check
//   4. mail suppression lookup
//   → protection decided here (assessReviewProtection). AI-off or protected anywhere on the address
//     = the inbound body is NEVER read.
//   5. only for unprotected, AI-on addresses: the latest inbound body + summary (kept in memory to
//      count questions / detect greeting-closing; only derived values and the ≤200-char Korean
//      summary are returned)
//   6. outbound message_sources by toHash over 14 days (metadata projection, existing toHash/sentAtIso
//      index) and auto_reply_queue for every known conversation of the address.
// No write, no send, no queue mutation, no Gateway/model call. Bounded: ≤50 conversations,
// ≤MAX_SCAN_CALLS pages, wall-clock budget; a cut-short call returns a cursor, never `exhausted`.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { FieldPath } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { conversationRegistrationGateFilter } from "./read";
import { isCallerScpEntitled } from "./mailAccounts";
import { canReadConversationRowForScope, type ConversationMailAccessScope } from "./conversationMailAccessScope";
import { CANONICAL_SCP_MAIL_ACCOUNT_ID, canReadScpConversationRowForOrg } from "./mailConversationAuthorization";
import { resolveCallerPendingAccess } from "./chatAutoCasebookPendingPrecompute";
import { boundedString, maskCreatorEmail, viewAsRequested } from "./chatAutoCasebookUnclassified";
import { chatAutoCaseHeldBacklogPrimaryCaseId } from "./chatAutoCaseBacklogSend";
import { chatAutoCaseReplyView, readChatAutoCaseReplyState, type ChatAutoCaseReplyMap, type ChatAutoCaseReplyRevisionMap } from "./chatAutoCaseReplies";
import { isChatAutoPermitCaseId } from "./chatAutoCasePermit";
import { findMailSuppression } from "./mailSuppression";
import { isAutoReplyOrgExcluded } from "./mailHumanGate";
import { SETTINGS } from "./_settings-mock";
import { recipientIdentityHash } from "./recipientIdentityHash";
import {
  assessReviewProtection,
  classifyReviewOutbound,
  evaluateReviewConversation,
  groupReviewConversations,
  type ReviewBoardPersonRow,
  type ReviewConversationEvaluation,
  type ReviewConversationFacts,
  type ReviewDefaultReply,
  redactSummary,
  type ReviewInboundFacts,
  type ReviewOutboundEvidence,
} from "./chatAutoReviewBoardModel";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  makeBehaviorLog,
  makeDeniedBehaviorLog,
  type CallableRequestShape,
} from "./shared";

const ACTION = "chat_auto_review_board.list";
export const CHAT_AUTO_REVIEW_BOARD_DEFAULT_LIMIT = 25;
export const CHAT_AUTO_REVIEW_BOARD_MAX_LIMIT = 50;
export const CHAT_AUTO_REVIEW_BOARD_SCAN_PAGE = 100;
export const CHAT_AUTO_REVIEW_BOARD_MAX_SCAN_CALLS = 6;
export const CHAT_AUTO_REVIEW_BOARD_BUDGET_MS = 25_000;
export const CHAT_AUTO_REVIEW_BOARD_REPLY_WINDOW_DAYS = 14;
export const CHAT_AUTO_REVIEW_BOARD_OUTBOUND_LIMIT = 40;
export const CHAT_AUTO_REVIEW_BOARD_QUEUE_LIMIT = 20;
export const CHAT_AUTO_REVIEW_BOARD_SIBLING_LIMIT = 10;
const ROW_CONCURRENCY = 6;
const SUMMARY_MAX = 200;
const LIVE_QUEUE_STATUSES = new Set(["scheduled", "processing", "queued", "pending"]);
/** Initial scan projection — conversation METADATA only (no embedded messages, lastMessage or bodies). */
export const SCAN_FIELDS = [
  "mailAccountId", "orgId", "counterpartyRegistered", "creatorEmail", "creatorHandle", "creatorName", "programTitle", "campaignTitle",
  "aiActive", "autoReplyStatus", "autoReplyBlockedReason", "humanGate", "permitDenyReasons", "lastMessageFrom", "lastMessageAtIso",
  "lastInboundAtIso", "lastMessageRef", "autoCaseId", "autoCaseMessageRef", "caseCandidates", "autoCaseIntentLabels",
  "autoCaseActorType", "autoCaseLabelSource",
] as const;
/** Metadata-only projections — these field lists deliberately exclude body/text/summaryKr. */
export const SOURCE_META_FIELDS = ["conversationId", "senderIdentityBinding", "inboundSenderHash", "direction", "receivedAtIso"] as const;
export const SIBLING_META_FIELDS = ["lastInboundAtIso", "creatorEmail", "creatorHandle", "counterpartyRegistered", "humanGate", "aiActive", "autoCaseId", "autoCaseMessageRef", "lastMessageRef", "caseCandidates", "permitDenyReasons", "autoCaseIntentLabels", "autoReplyBlockedReason", "mailAccountId", "orgId"] as const;
export const OUTBOUND_META_FIELDS = ["mailAccountId", "sendMailAccountId", "direction", "source", "kind", "mailType", "conversationId", "subject", "replyToMessageRef", "inReplyTo", "inReplyToHash", "deliveryState", "dryRun", "sentAtIso", "campaignId", "targetId", "campaignCandidateRef"] as const;

export type ListChatAutoReviewBoardEnvelope = {
  ok: true;
  rows: ReviewBoardPersonRow[];
  counts: {
    conversations: number;
    people: number;
    protectedConversations: number;
    byBucket: { excluded: number; operator_judgment: number; final_safety_wait: number };
  };
  /** What "전체" covers for this caller — shown in the board header. */
  scope: { mailbox: "scp"; orgLabel: string; period: string; population: string };
  nextCursor: string | null;
  exhausted: boolean;
  verifiedAtIso: string;
  behaviorLog: Record<string, unknown>;
};

type Row = Record<string, unknown>;
type Cursor = { docId: string; orderValue: string };

export type ReviewBoardDependencies = {
  isCallerScpEntitled?: typeof isCallerScpEntitled;
  resolveAccess?: typeof resolveCallerPendingAccess;
  scanPage?: (input: { cursor: Cursor | null; limit: number }) => Promise<Row[]>;
  readDisabledOrgIds?: () => Promise<readonly string[]>;
  readSourceMeta?: (sourceId: string) => Promise<Row | null>;
  /** Metadata-only lookup of this conversation's inbound records received exactly at lastInboundAtIso. */
  findInboundAt?: (conversationId: string, receivedAtIso: string) => Promise<Array<{ id: string; data: Row }>>;
  readSourceBody?: (sourceId: string) => Promise<{ body: string | null; summaryKr: string | null } | null>;
  querySiblings?: (creatorEmail: string, limit: number) => Promise<Row[]>;
  /** Conversations of the same VERIFIED sender (inbound records with this sender hash) — metadata only. */
  querySenderConversations?: (inboundSenderHash: string, limit: number) => Promise<{ rows: Row[]; capped: boolean }>;
  queryOutbound?: (toHash: string, cutoffIso: string, limit: number) => Promise<Row[]>;
  queryQueue?: (conversationIds: readonly string[], limit: number) => Promise<Row[]>;
  findSuppression?: (input: { email?: string; handle?: string }) => Promise<{ blocked: boolean }>;
  readReplyState?: () => Promise<{ overrides: ChatAutoCaseReplyMap; revisions: ChatAutoCaseReplyRevisionMap }>;
  now?: () => Date;
  nowMs?: () => number;
  budgetMs?: number;
  maxScanCalls?: number;
};

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument",
    errorCode: "chat_auto_review_board_invalid_argument",
  });
}

function permissionDenied(request: CallableRequestShape, gameId: string): Error {
  return Object.assign(new Error("permission-denied: scp entitlement required"), {
    code: "permission-denied",
    errorCode: "chat_auto_review_board_scp_entitlement_required",
    behaviorLog: makeDeniedBehaviorLog(request, ACTION, gameId),
  });
}

function parseLimit(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (value === undefined || value === null || !Number.isFinite(num) || num <= 0) return CHAT_AUTO_REVIEW_BOARD_DEFAULT_LIMIT;
  return Math.min(Math.floor(num), CHAT_AUTO_REVIEW_BOARD_MAX_LIMIT);
}

function canCallerReadScpRow(row: Row, scope: ConversationMailAccessScope): boolean {
  return canReadScpConversationRowForOrg(row, {
    viewerOrgId: scope.viewerOrgId,
    isSuperAdmin: scope.isSuperAdmin,
    hasScpEntitlement: scope.hasScpEntitlement,
  });
}

// Existing conversations index (lastMessageAtIso DESC, __name__ ASC).
async function defaultScanPage(input: { cursor: Cursor | null; limit: number }): Promise<Row[]> {
  let query = adminDb.collection("conversations").select(...SCAN_FIELDS).orderBy("lastMessageAtIso", "desc").orderBy(FieldPath.documentId(), "asc");
  if (input.cursor) query = query.startAfter(input.cursor.orderValue, input.cursor.docId);
  const snapshot = await query.limit(input.limit).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

// Plain document read — NOT readSettings(), whose transaction may initialise settings/policy-cache docs.
async function defaultReadDisabledOrgIds(): Promise<readonly string[]> {
  const snapshot = await adminDb.collection("settings").doc("default").get();
  const stored = asRecord(asRecord(snapshot.data()).automation).autoReplyDisabledOrgIds;
  return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : [...SETTINGS.automation.autoReplyDisabledOrgIds];
}

async function defaultReadSourceMeta(sourceId: string): Promise<Row | null> {
  const snapshot = await adminDb.collection("message_sources").where(FieldPath.documentId(), "==", sourceId).select(...SOURCE_META_FIELDS).limit(1).get();
  return snapshot.empty ? null : snapshot.docs[0].data() ?? {};
}

// Equality-only filters: served by Firestore's single-field indexes, no composite index needed.
async function defaultFindInboundAt(conversationId: string, receivedAtIso: string): Promise<Array<{ id: string; data: Row }>> {
  const snapshot = await adminDb
    .collection("message_sources")
    .where("conversationId", "==", conversationId)
    .where("direction", "==", "inbound")
    .where("receivedAtIso", "==", receivedAtIso)
    .select(...SOURCE_META_FIELDS)
    .limit(2)
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() ?? {} }));
}

async function defaultReadSourceBody(sourceId: string): Promise<{ body: string | null; summaryKr: string | null } | null> {
  const snapshot = await adminDb.collection("message_sources").where(FieldPath.documentId(), "==", sourceId).select("body", "summaryKr").limit(1).get();
  if (snapshot.empty) return null;
  const data = snapshot.docs[0].data() ?? {};
  return { body: typeof data.body === "string" ? data.body : null, summaryKr: typeof data.summaryKr === "string" ? data.summaryKr : null };
}

async function defaultQuerySiblings(creatorEmail: string, limit: number): Promise<Row[]> {
  const snapshot = await adminDb.collection("conversations").where("creatorEmail", "==", creatorEmail).select(...SIBLING_META_FIELDS).limit(limit).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

// Same identity boundary as grouping: inbound records carrying this verified sender hash → their
// conversations (single-field equality; conversation metadata via a field mask, never bodies).
async function defaultQuerySenderConversations(inboundSenderHash: string, limit: number): Promise<{ rows: Row[]; capped: boolean }> {
  const sources = await adminDb.collection("message_sources").where("inboundSenderHash", "==", inboundSenderHash).select("conversationId").limit(limit).get();
  const ids = [...new Set(sources.docs.map((doc) => asString(doc.get("conversationId"))).filter((id) => id && !id.includes("/")))];
  if (ids.length === 0) return { rows: [], capped: false };
  const snapshots = await adminDb.getAll(...ids.map((id) => adminDb.collection("conversations").doc(id)), { fieldMask: [...SIBLING_META_FIELDS] });
  const rows = snapshots.filter((snapshot) => snapshot.exists).map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }));
  return { rows, capped: sources.size >= limit };
}

// Existing message_sources index (toHash ASC, sentAtIso DESC, __name__ ASC).
async function defaultQueryOutbound(toHash: string, cutoffIso: string, limit: number): Promise<Row[]> {
  const snapshot = await adminDb
    .collection("message_sources")
    .where("toHash", "==", toHash)
    .where("sentAtIso", ">=", cutoffIso)
    .orderBy("sentAtIso", "desc")
    .orderBy(FieldPath.documentId(), "asc")
    .select(...OUTBOUND_META_FIELDS)
    .limit(limit)
    .get();
  return snapshot.docs.map((doc) => doc.data() ?? {});
}

async function defaultQueryQueue(conversationIds: readonly string[], limit: number): Promise<Row[]> {
  const snapshot = await adminDb.collection("auto_reply_queue").where("conversationId", "in", [...conversationIds]).select("status", "conversationId").limit(limit).get();
  return snapshot.docs.map((doc) => doc.data() ?? {});
}

// Confidential pagination cursor: the scan position may sit on a conversation the caller cannot see,
// so the cursor is AES-256-GCM sealed (key derived from the function's bound server secret) instead of
// the reversible base64 JSON codec — a caller can resume, never read another conversation's id/time.
function cursorKey(): Buffer {
  const secret = process.env.PEOPLY_API_KEY || process.env.FLU_REVIEW_BOARD_CURSOR_SECRET || `local-only:${process.env.GCLOUD_PROJECT ?? ""}`;
  return createHash("sha256").update(`chat-auto-review-board-cursor-v1:${secret}`).digest();
}

export function sealReviewBoardCursor(cursor: Cursor): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cursorKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(cursor), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function openReviewBoardCursor(value: unknown): Cursor | null {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return null;
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", cursorKey(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const parsed = asRecord(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")));
    const docId = asString(parsed.docId);
    return docId ? { docId, orderValue: asString(parsed.orderValue, "") } : null;
  } catch {
    return null;
  }
}

function senderGroupKey(senderHash: string): string {
  return createHash("sha256").update(`chat-auto-review-board-v1:${senderHash}`).digest("hex").slice(0, 20);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Every case id stamped on a conversation (raw autoCaseId even if stale, caseCandidates) — protection only. */
function protectionCaseIds(row: Row): string[] {
  const ids = [asString(row.autoCaseId), ...(Array.isArray(row.caseCandidates) ? row.caseCandidates : []).map((candidate) => asString(asRecord(candidate).caseId))];
  return [...new Set(ids.filter((id) => isChatAutoPermitCaseId(id)))];
}

/** Redact first, then truncate; a trailing partial token with "@" or a digit run is dropped at the cut. */
function boundedRedacted(value: unknown, max: number): string | null {
  const redacted = redactSummary(asString(value));
  if (!redacted) return null;
  if (redacted.length <= max) return redacted;
  const cut = redacted.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const tail = lastSpace >= 0 ? cut.slice(lastSpace + 1) : cut;
  return /@|\d{3,}/.test(tail) ? cut.slice(0, Math.max(0, lastSpace)).trimEnd() : cut;
}

function gateReasonText(row: Row): string {
  return [asString(row.autoReplyBlockedReason), asString(asRecord(row.humanGate).reason), ...stringList(row.permitDenyReasons)].filter(Boolean).join(" | ");
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await promise };
  } catch {
    return { ok: false };
  }
}

type Readers = Required<Pick<ReviewBoardDependencies, "readSourceMeta" | "findInboundAt" | "readSourceBody" | "querySiblings" | "querySenderConversations" | "queryOutbound" | "queryQueue" | "findSuppression">>;

async function gatherFacts(
  row: Row,
  readers: Readers,
  defaultReplyFor: (caseId: string) => ReviewDefaultReply,
  disabledOrgIds: readonly string[] | null,
  cutoffIso: string,
  access: ConversationMailAccessScope,
  registrationGate: (row: Row) => boolean,
): Promise<ReviewConversationFacts> {
  const conversationId = asString(row.id);
  const lastMessageRef = asString(row.lastMessageRef, "");
  const refSourceId = lastMessageRef.startsWith("message_sources/") ? lastMessageRef.slice("message_sources/".length) : "";
  const creatorEmail = asString(row.creatorEmail, "");
  const creatorHandle = asString(row.creatorHandle, "");
  let primaryCaseId = chatAutoCaseHeldBacklogPrimaryCaseId(row);
  const intentLabels = stringList(row.autoCaseIntentLabels);
  const aiActive = typeof row.aiActive === "boolean" ? row.aiActive : null;

  const lastInboundAtIso = asString(row.lastInboundAtIso, "");
  // A record is the creator's latest inbound only when it IS inbound, belongs to THIS conversation and
  // was received at the conversation's lastInboundAtIso — lastMessageRef can point at our own
  // outbound when we replied last.
  const isLatestInbound = (record: Row | null): boolean => Boolean(record)
    && asString(record?.direction) === "inbound"
    && asString(record?.conversationId) === conversationId
    && Boolean(lastInboundAtIso)
    && asString(record?.receivedAtIso) === lastInboundAtIso;

  // 2-4: metadata only
  const [metaResult, siblingResult, suppressionResult] = await Promise.all([
    refSourceId && !refSourceId.includes("/") ? settle(readers.readSourceMeta(refSourceId)) : Promise.resolve(null),
    creatorEmail ? settle(readers.querySiblings(creatorEmail, CHAT_AUTO_REVIEW_BOARD_SIBLING_LIMIT)) : Promise.resolve(null),
    creatorEmail || creatorHandle
      ? settle(readers.findSuppression({ ...(creatorEmail ? { email: creatorEmail } : {}), ...(creatorHandle ? { handle: creatorHandle } : {}) }))
      : Promise.resolve(null),
  ]);
  let sourceId = "";
  let meta: Row | null = null;
  let link: ReviewInboundFacts["link"] = "unknown";
  if (metaResult?.ok && isLatestInbound(metaResult.value)) {
    sourceId = refSourceId;
    meta = metaResult.value;
    link = "confirmed";
  } else if (lastInboundAtIso) {
    const found = await settle(readers.findInboundAt(conversationId, lastInboundAtIso));
    const matches = found.ok ? found.value.filter((item) => isLatestInbound(item.data)) : [];
    if (matches.length === 1) {
      sourceId = matches[0].id;
      meta = matches[0].data;
      link = "confirmed";
    } else if (found.ok) {
      link = "unlinked";
    }
  }
  const bindingRecord = link === "confirmed" ? asRecord(meta?.senderIdentityBinding) : {};
  const binding = asString(bindingRecord.status)
    ? {
        status: asString(bindingRecord.status),
        bindingScope: asString(bindingRecord.bindingScope) || null,
        reasonCode: asString(bindingRecord.reasonCode) || null,
        inboundSenderHash: asString(bindingRecord.inboundSenderHash) || null,
      }
    : null;
  const inboundSenderHash = link === "confirmed" ? asString(meta?.inboundSenderHash) || null : null;
  const suppression = suppressionResult === null
    ? { status: "unknown" as const, blocked: false }
    : suppressionResult.ok
      ? { status: "confirmed" as const, blocked: suppressionResult.value.blocked === true }
      : { status: "unknown" as const, blocked: false };
  // Conversations of the same verified sender (the grouping boundary), looked up BEFORE any body read.
  const senderResult = inboundSenderHash ? await settle(readers.querySenderConversations(inboundSenderHash, CHAT_AUTO_REVIEW_BOARD_SIBLING_LIMIT)) : null;
  const senderCapped = Boolean(senderResult?.ok) && (senderResult as { ok: true; value: { capped: boolean } }).value.capped;
  const senderFailed = Boolean(inboundSenderHash) && (!senderResult || !senderResult.ok);
  // Same read gate as the scanned rows (scope + scp org + registration): a conversation of the same
  // address/sender outside it is ignored entirely (never used for protection, queue or reply evidence).
  const seenIds = new Set<string>([conversationId]);
  const otherConversations = [...(siblingResult?.ok ? siblingResult.value : []), ...(senderResult?.ok ? senderResult.value.rows : [])]
    .filter((sibling) => {
      const id = asString(sibling.id);
      if (!id || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });
  const siblings = otherConversations.filter((sibling) => registrationGate(sibling) && canReadConversationRowForScope(sibling, access, CANONICAL_SCP_MAIL_ACCOUNT_ID) && canCallerReadScpRow(sibling, access));
  const outOfScopeSiblings = otherConversations.length - siblings.length;
  const siblingsCapped = (Boolean(siblingResult?.ok) && (siblingResult as { ok: true; value: Row[] }).value.length >= CHAT_AUTO_REVIEW_BOARD_SIBLING_LIMIT) || senderCapped;
  const addressProtectionReasons = [...new Set(siblings.flatMap((sibling) => assessReviewProtection({
    aiActive: typeof sibling.aiActive === "boolean" ? sibling.aiActive : null,
    primaryCaseId: chatAutoCaseHeldBacklogPrimaryCaseId(sibling),
    extraCaseIds: protectionCaseIds(sibling),
    intentLabels: stringList(sibling.autoCaseIntentLabels),
    gateReasonText: gateReasonText(sibling),
    suppressionBlocked: false,
    binding: null,
    inboundSenderHash: null,
  })).map((reason) => (reason === "운영자 담당 (AI off)" ? "같은 주소의 다른 대화 AI off" : reason)))];
  // Sender binding of every in-scope member's latest inbound (metadata projection) — a member whose
  // latest inbound is review_required / From-mismatch protects the whole address before body reads.
  // The sibling's LATEST INBOUND is located like our own (lastMessageRef may be our outbound): it must be
  // inbound, of that conversation, received at its lastInboundAtIso. Not confirmable → fail closed.
  const siblingBindings = await Promise.all(siblings.map(async (sibling): Promise<{ ok: true; value: Row | null } | { ok: false }> => {
    const siblingId = asString(sibling.id);
    const siblingInboundAt = asString(sibling.lastInboundAtIso);
    if (!siblingInboundAt) return { ok: true, value: null }; // never received anything: no inbound to check
    const isSiblingInbound = (record: Row | null | undefined) => Boolean(record)
      && asString(record?.direction) === "inbound" && asString(record?.conversationId) === siblingId && asString(record?.receivedAtIso) === siblingInboundAt;
    const ref = asString(sibling.lastMessageRef);
    const refId = ref.startsWith("message_sources/") ? ref.slice("message_sources/".length) : "";
    if (refId && !refId.includes("/")) {
      const viaRef = await settle(readers.readSourceMeta(refId));
      if (viaRef.ok && isSiblingInbound(viaRef.value)) return { ok: true, value: viaRef.value };
    }
    const found = await settle(readers.findInboundAt(siblingId, siblingInboundAt));
    const matches = found.ok ? found.value.filter((item) => isSiblingInbound(item.data)) : [];
    return matches.length === 1 ? { ok: true, value: matches[0].data } : { ok: false };
  }));
  for (const result of siblingBindings) {
    if (!result.ok) {
      addressProtectionReasons.push("같은 주소 대화 확인 불가");
      continue;
    }
    const meta = result.value;
    if (!meta) continue;
    const memberBinding = asRecord(meta.senderIdentityBinding);
    const reasons = assessReviewProtection({
      aiActive: null,
      primaryCaseId: null,
      intentLabels: [],
      gateReasonText: "",
      suppressionBlocked: false,
      binding: asString(memberBinding.status)
        ? { status: asString(memberBinding.status), inboundSenderHash: asString(memberBinding.inboundSenderHash) || null, reasonCode: asString(memberBinding.reasonCode) || null }
        : null,
      inboundSenderHash: asString(meta.inboundSenderHash) || null,
    });
    addressProtectionReasons.push(...reasons);
  }
  // Suppression of every in-scope group member's OWN address/handle (they can differ under one verified
  // sender) — checked before any body read.
  const ownIdentities = new Set([creatorEmail.toLowerCase(), creatorHandle.toLowerCase()].filter(Boolean));
  const siblingIdentities = new Map<string, { email?: string; handle?: string }>();
  for (const sibling of siblings) {
    const email = asString(sibling.creatorEmail).toLowerCase();
    const handle = asString(sibling.creatorHandle).toLowerCase();
    if ((email && !ownIdentities.has(email)) || (handle && !ownIdentities.has(handle))) {
      siblingIdentities.set(`${email}|${handle}`, { ...(email ? { email } : {}), ...(handle ? { handle } : {}) });
    }
  }
  // Every identity is checked (bounded by the sibling caps); more than the bound fails closed.
  const identityList = [...siblingIdentities.values()];
  if (identityList.length > CHAT_AUTO_REVIEW_BOARD_SIBLING_LIMIT * 2) addressProtectionReasons.push("같은 주소 대화 확인 불가");
  const siblingSuppression = await Promise.all(identityList.slice(0, CHAT_AUTO_REVIEW_BOARD_SIBLING_LIMIT * 2).map((input) => settle(readers.findSuppression(input))));
  if (siblingSuppression.some((result) => result.ok && result.value.blocked === true)) addressProtectionReasons.push("수신 억제");
  if (siblingSuppression.some((result) => !result.ok)) addressProtectionReasons.push("같은 주소 대화 확인 불가");
  // A sibling lookup that failed or was capped cannot prove the address is unprotected.
  if ((creatorEmail && (!siblingResult || !siblingResult.ok)) || siblingsCapped || senderFailed) addressProtectionReasons.push("같은 주소 대화 확인 불가");
  // A stamp whose autoCaseMessageRef is the LOCATED latest inbound is that inbound's case even when
  // lastMessageRef moved on to our outbound reply.
  const rawCaseId = asString(row.autoCaseId);
  if (link === "confirmed" && sourceId && isChatAutoPermitCaseId(rawCaseId) && asString(row.autoCaseMessageRef) === `message_sources/${sourceId}`) primaryCaseId = rawCaseId;
  const ownProtection = assessReviewProtection({
    aiActive,
    primaryCaseId,
    extraCaseIds: protectionCaseIds(row),
    intentLabels,
    gateReasonText: gateReasonText(row),
    suppressionBlocked: suppression.blocked,
    binding: binding ? { status: binding.status, inboundSenderHash: binding.inboundSenderHash, reasonCode: binding.reasonCode } : null,
    inboundSenderHash,
  });
  // Fail closed: an own-address suppression lookup that failed (or had no address to check) blocks
  // body reads, summaries and drafts exactly like a suppression hit.
  if (suppression.status !== "confirmed") addressProtectionReasons.push("수신 억제 확인 불가");
  const mayReadBody = link === "confirmed" && ownProtection.length === 0 && addressProtectionReasons.length === 0;

  // 5: body — only for unprotected, AI-on addresses
  const bodyResult = mayReadBody ? await settle(readers.readSourceBody(sourceId)) : null;
  const bodyRecord = bodyResult?.ok ? bodyResult.value : null;
  const inbound: ReviewInboundFacts = {
    link,
    body: bodyRecord?.body ?? null,
    bodyRead: Boolean(bodyRecord),
    // Redact BEFORE truncating so a cut can never leave a partial address behind.
    summaryKr: bodyRecord ? boundedRedacted(bodyRecord.summaryKr, SUMMARY_MAX) : null,
    summaryRaw: bodyRecord?.summaryKr ?? null,
    binding,
    inboundSenderHash,
  };

  // 6: outbound + queue (metadata only)
  const toHash = inboundSenderHash ?? (creatorEmail ? recipientIdentityHash(creatorEmail) : "");
  const queueIds = [conversationId, ...siblings.map((sibling) => asString(sibling.id)).filter(Boolean)].slice(0, 30);
  const [outboundResult, queueResult] = await Promise.all([
    toHash ? settle(readers.queryOutbound(toHash, cutoffIso, CHAT_AUTO_REVIEW_BOARD_OUTBOUND_LIMIT)) : Promise.resolve(null),
    settle(readers.queryQueue(queueIds, CHAT_AUTO_REVIEW_BOARD_QUEUE_LIMIT)),
  ]);
  let outbound: ReviewConversationFacts["outbound"];
  if (!toHash) outbound = { status: "unknown", reason: "주소 기록 없음", rows: [] };
  else if (!outboundResult || !outboundResult.ok) outbound = { status: "unknown", reason: "조회 실패", rows: [] };
  else {
    // Only SCP-mailbox mail bound to a conversation the caller can read counts as evidence. Mail from
    // another mailbox (e.g. a personal account) is not SCP evidence at all; mail whose scope cannot be
    // established is dropped and the field is marked partial.
    const visibleIds = new Set([conversationId, ...siblings.map((sibling) => asString(sibling.id))]);
    const outboundRecords = outboundResult.value.filter((record) => asString(record.direction, "outbound") === "outbound");
    let hiddenExists = false;
    let scopeUnknown = false;
    const inScope = outboundRecords.filter((record) => {
      const account = asString(record.sendMailAccountId) || asString(record.mailAccountId);
      const boundConversation = asString(record.conversationId);
      if (account && account !== CANONICAL_SCP_MAIL_ACCOUNT_ID) return false;
      if (boundConversation && visibleIds.has(boundConversation)) return true;
      if (access.isSuperAdmin && account === CANONICAL_SCP_MAIL_ACCOUNT_ID) return true;
      if (!account) scopeUnknown = true;
      else hiddenExists = true;
      return false;
    });
    const rows: ReviewOutboundEvidence[] = inScope
      .map((record) => ({ kind: classifyReviewOutbound(record), sentAtIso: boundedString(record.sentAtIso, 40), conversationId: boundedString(record.conversationId, 300) }));
    const capped = outboundResult.value.length >= CHAT_AUTO_REVIEW_BOARD_OUTBOUND_LIMIT;
    outbound = capped
      ? { status: "partial", reason: "미확인(부분 조회)", rows }
      : hiddenExists
        ? { status: "partial", reason: "권한 밖 데이터 존재 가능", rows }
        : scopeUnknown
          ? { status: "partial", reason: "범위 근거 없는 발송 있음(미확인)", rows }
          : { status: "confirmed", reason: null, rows };
  }
  let queue: ReviewConversationFacts["queue"];
  if (!queueResult.ok) queue = { status: "unknown", liveCount: 0, reason: "조회 실패" };
  else {
    const liveCount = queueResult.value.filter((job) => LIVE_QUEUE_STATUSES.has(asString(job.status))).length;
    const capped = queueResult.value.length >= CHAT_AUTO_REVIEW_BOARD_QUEUE_LIMIT;
    const siblingGap = (Boolean(creatorEmail) && (!siblingResult || !siblingResult.ok)) || siblingsCapped || senderFailed;
    queue = capped || siblingGap || outOfScopeSiblings > 0
      ? { status: "partial", liveCount, reason: capped ? "미확인(부분 조회)" : siblingGap ? "같은 주소의 다른 대화 확인 불가" : "권한 밖 데이터 존재 가능" }
      : { status: "confirmed", liveCount, reason: null };
  }

  const caseCandidateIds = (Array.isArray(row.caseCandidates) ? row.caseCandidates : [])
    .map((candidate) => asString(asRecord(candidate).caseId))
    .filter((id) => isChatAutoPermitCaseId(id));
  return {
    conversationId,
    mailAccountId: asString(row.mailAccountId) || null,
    aiActive,
    autoReplyStatus: asString(row.autoReplyStatus) || null,
    primaryCaseId,
    caseCandidateIds,
    actorType: asString(row.autoCaseActorType) || null,
    intentLabels,
    gateReasonText: gateReasonText(row),
    labelSource: asString(row.autoCaseLabelSource) || null,
    labelsFresh: link === "confirmed" && Boolean(sourceId) && asString(row.autoCaseMessageRef) === `message_sources/${sourceId}`,
    protectionCaseIds: protectionCaseIds(row),
    // Stale = the stamp is not on the LOCATED latest inbound (an outbound reply after it does not make it stale).
    caseStampStale: Boolean(rawCaseId) && asString(row.autoCaseMessageRef) !== (link === "confirmed" && sourceId ? `message_sources/${sourceId}` : asString(row.lastMessageRef)),
    orgAutomationOff: disabledOrgIds !== null && isAutoReplyOrgExcluded({ orgId: row.orgId, mailAccountId: row.mailAccountId, disabledOrgIds }),
    orgPolicyKnown: disabledOrgIds !== null,
    // Some stored names are email addresses (src/lib/chat-people.ts) — redact like summaries.
    creatorName: boundedRedacted(row.creatorName, 200),
    creatorHandle: boundedString(row.creatorHandle, 100),
    creatorEmailMasked: maskCreatorEmail(row.creatorEmail),
    programLabel: boundedString(row.programTitle, 120) ?? boundedString(row.campaignTitle, 120),
    latestInboundAtIso: boundedString(row.lastInboundAtIso, 40),
    lastMessageFrom: asString(row.lastMessageFrom) || null,
    // Summary only from the confirmed inbound record, read after protection was decided.
    summaryKr: null,
    inbound,
    addressProtectionReasons,
    outbound,
    queue,
    suppression,
    defaultReplyFor,
  };
}

/** Strips anything address-derived before the payload leaves the server. */
function sanitizeRow(row: ReviewBoardPersonRow): ReviewBoardPersonRow {
  return { ...row, identity: { ...row.identity, groupSenderHash: null } };
}

export async function listChatAutoReviewBoard(
  request: CallableRequestShape,
  deps: ReviewBoardDependencies = {},
): Promise<ListChatAutoReviewBoardEnvelope> {
  const auth = assertNonGuestAuth(request, ACTION);
  const data = asRecord(request.data);
  if (viewAsRequested(data)) {
    throw Object.assign(new Error("permission-denied: this console does not support viewAs preview"), {
      code: "permission-denied",
      errorCode: "chat_auto_review_board_view_as_unsupported",
      behaviorLog: makeDeniedBehaviorLog(request, ACTION, auth.gameId),
    });
  }
  // Literal isCallerScpEntitled call (not a nullish-coalesced reference) so the scp-gate scans in
  // tests/scp-callable-entitlement.test.mjs detect this handler as gated — same pattern as
  // chatAutoCaseBacklogSend.ts getChatAutoCaseHeldBacklogCount.
  const entitled = deps.isCallerScpEntitled
    ? await deps.isCallerScpEntitled(auth.email ?? "", auth.role === "super_admin", { userId: auth.userId })
    : await isCallerScpEntitled(auth.email ?? "", auth.role === "super_admin", { userId: auth.userId });
  if (!entitled) throw permissionDenied(request, auth.gameId);

  const limit = parseLimit(data.limit);
  const requestedCursor = openReviewBoardCursor(data.cursor);
  if (asString(data.cursor) && !requestedCursor) throw invalidArgument("cursor is not a valid scan cursor");

  const { access } = await (deps.resolveAccess ?? resolveCallerPendingAccess)(auth);
  if (!access.isSuperAdmin && !access.hasScpEntitlement) throw permissionDenied(request, auth.gameId);
  const registrationGate = conversationRegistrationGateFilter(auth.role, false);
  const now = (deps.now ?? (() => new Date()))();
  const nowMs = deps.nowMs ?? Date.now;
  const startMs = nowMs();
  const budgetMs = deps.budgetMs ?? CHAT_AUTO_REVIEW_BOARD_BUDGET_MS;
  const maxScanCalls = deps.maxScanCalls ?? CHAT_AUTO_REVIEW_BOARD_MAX_SCAN_CALLS;
  const cutoffIso = new Date(now.getTime() - CHAT_AUTO_REVIEW_BOARD_REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const scanPage = deps.scanPage ?? defaultScanPage;
  const readers: Readers = {
    readSourceMeta: deps.readSourceMeta ?? defaultReadSourceMeta,
    findInboundAt: deps.findInboundAt ?? defaultFindInboundAt,
    readSourceBody: deps.readSourceBody ?? defaultReadSourceBody,
    querySiblings: deps.querySiblings ?? defaultQuerySiblings,
    querySenderConversations: deps.querySenderConversations ?? defaultQuerySenderConversations,
    queryOutbound: deps.queryOutbound ?? defaultQueryOutbound,
    queryQueue: deps.queryQueue ?? defaultQueryQueue,
    findSuppression: deps.findSuppression ?? ((input: { email?: string; handle?: string }) => findMailSuppression(input)),
  };
  const [replyState, disabledOrgs] = await Promise.all([
    settle((deps.readReplyState ?? readChatAutoCaseReplyState)()),
    settle((deps.readDisabledOrgIds ?? defaultReadDisabledOrgIds)()),
  ]);
  const disabledOrgIds = disabledOrgs.ok ? disabledOrgs.value : null;
  const defaultReplyFor = (caseId: string): ReviewDefaultReply => {
    if (!replyState.ok || !isChatAutoPermitCaseId(caseId)) return null;
    const view = chatAutoCaseReplyView(caseId, replyState.value.overrides, replyState.value.revisions);
    if (!view.text) return null;
    return { text: view.text, sourceLabel: view.source === "operator_override" ? `운영자 편집본(rev ${view.revision})` : "Flu 케이스북 정본" };
  };

  const evaluations: ReviewConversationEvaluation[] = [];
  let cursor: Cursor | null = requestedCursor ? { docId: requestedCursor.docId, orderValue: asString(requestedCursor.orderValue, "") } : null;
  let scanCalls = 0;
  let exhausted = false;

  scanLoop: for (;;) {
    if (scanCalls > 0 && (scanCalls >= maxScanCalls || nowMs() - startMs >= budgetMs)) break;
    const page = await scanPage({ cursor, limit: CHAT_AUTO_REVIEW_BOARD_SCAN_PAGE });
    scanCalls += 1;
    let index = 0;
    while (index < page.length) {
      if (evaluations.length >= limit || (evaluations.length > 0 && nowMs() - startMs >= budgetMs)) break scanLoop;
      const batch: Row[] = [];
      let consumed = 0;
      while (index + consumed < page.length && batch.length < Math.min(limit - evaluations.length, ROW_CONCURRENCY)) {
        const row = page[index + consumed];
        consumed += 1;
        if (!asString(row.lastInboundAtIso)) continue;
        if (!registrationGate(row)) continue;
        if (!canReadConversationRowForScope(row, access, CANONICAL_SCP_MAIL_ACCOUNT_ID) || !canCallerReadScpRow(row, access)) continue;
        batch.push(row);
      }
      const facts = await Promise.all(batch.map((row) => gatherFacts(row, readers, defaultReplyFor, disabledOrgIds, cutoffIso, access, registrationGate)));
      for (const fact of facts) evaluations.push(evaluateReviewConversation(fact));
      index += consumed;
      const last = page[index - 1];
      if (last) cursor = { docId: asString(last.id), orderValue: asString(last.lastMessageAtIso, "") };
    }
    if (page.length < CHAT_AUTO_REVIEW_BOARD_SCAN_PAGE) {
      exhausted = true;
      break;
    }
  }

  const rows = groupReviewConversations(evaluations, senderGroupKey).map(sanitizeRow);
  const byBucket = { excluded: 0, operator_judgment: 0, final_safety_wait: 0 };
  for (const row of rows) byBucket[row.sendBatch.bucket] += 1;
  return {
    ok: true,
    rows,
    counts: {
      conversations: evaluations.length,
      people: rows.length,
      protectedConversations: evaluations.filter((item) => item.protected).length,
      byBucket,
    },
    scope: {
      mailbox: "scp",
      orgLabel: access.isSuperAdmin ? "전체 조직" : access.viewerOrgId ? `조직 ${access.viewerOrgId}` : "배정 조직",
      period: "기간 제한 없음",
      population: "받은 문의가 1건 이상인 SCP 대화(제외·답장된 대화 포함, 첫 연락만 받은 대화 제외)",
    },
    nextCursor: exhausted || !cursor ? null : sealReviewBoardCursor(cursor),
    exhausted,
    verifiedAtIso: now.toISOString(),
    behaviorLog: { ...makeBehaviorLog(auth, ACTION, "success") },
  };
}
