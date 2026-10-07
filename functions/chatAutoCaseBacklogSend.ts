// 케이스별 "보류 N건 지금 보내기" — backend (case-backlog-send, 2026-09-27; round-2 hardening
// 2026-09-28 after a codex adversarial review — see the round-2 comments throughout this file and
// autoReplyBacklog.ts for what changed and why).
//
// Context: arming a casebook case in /chat/auto (setChatAutoCasePermitArming,
// chatAutoCasePermitCallables.ts) does NOT retroactively release mail that was already held for
// human review under that case — the classification pipeline only runs at receive time or when a
// maintenance sweep (requeueAutoReplyBacklog, autoReplyBacklog.ts) explicitly re-examines a
// conversation. Today that sweep is manual, super_admin-only, and has no per-case scope. This file
// adds the two callables the case list needs for a per-case "보류 N건 지금 보내기" affordance:
//
//   - getChatAutoCaseHeldBacklogCount: cheap, bounded read for the "보류 N건" label.
//   - sendChatAutoCaseHeldBacklogNow: the actual release, scoped to one armed case, reusing
//     requeueAutoReplyBacklog's caseIdFilter (autoReplyBacklog.ts) so every existing safety gate
//     (JEV final judgment, English-only drafting, manual-reply exclusion, suppression/dedup, kill
//     switch, daily caps, scp@-only mailbox scoping, T049 auto-reply-off, permit armed+pinned to
//     the current release, explicit human-review holds) still applies unchanged — this callable
//     only narrows WHICH held conversations that existing pipeline looks at.
//
// Every casebook case here is an scp@ concept — both callables require the EFFECTIVE user (the
// viewAs target when the caller is genuinely using "대신 보기", otherwise the caller themself) to
// hold scp entitlement (functions/mailAccounts.ts's assertScpEntitled/isCallerScpEntitled, cherry-
// picked from fix/scp-surface-gate@8bcc4683 — see this branch's commit history), on top of role
// RBAC. The send callable additionally restricts requeueAutoReplyBacklog's own query to the
// canonical scp@ mailbox (a query predicate, not a post-classification filter) so an entitled
// operator's scoped action can still never reach another org's mailbox.
import { randomUUID } from "node:crypto";
import { FieldPath } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { resolveConversationMailAccessScope, type ConversationMailAccessScope } from "./conversationMailAccessScope";
import { canReadScpConversationRowForOrg } from "./mailConversationAuthorization";
import { runGatewayLive } from "./chat-ai";
import { isChatAutoPermitCaseId, type ChatAutoPermitCaseId } from "./chatAutoCasePermit";
import { getChatAutoCasePermitStatus, MUTATION_ROLES } from "./chatAutoCasePermitCallables";
import { CHAT_CASEBOOK_CONTENT_HASH } from "./chatCasebook";
import { cachedChatAutoPermitReleaseSourceCommit } from "./chatAutoPermitReleaseIdentity";
import {
  actorUidHash,
  AUTO_REPLY_BACKLOG_CONFIRM_TOKEN,
  MAX_LIMIT,
  MAX_MAX_AGE_HOURS,
  requeueAutoReplyBacklog,
  SELECTABLE_AUTO_REPLY_STATUSES,
  type AutoReplyBacklogDependencies,
  type RequeueAutoReplyBacklogResult,
} from "./autoReplyBacklog";
import { assertScpEntitled, isCallerScpEntitled } from "./mailAccounts";
import { resolveViewAsTarget } from "./mailAccountCallables";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  type AuthContext,
  type CallableRequestShape,
} from "./shared";

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument",
    errorCode: "chat_auto_case_backlog_invalid_argument",
  });
}

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(`failed-precondition: ${message}`), {
    code: "failed-precondition",
    errorCode: "chat_auto_case_backlog_failed_precondition",
  });
}

function permissionDenied(message: string): Error {
  return Object.assign(new Error(`permission-denied: ${message}`), {
    code: "permission-denied",
    errorCode: "chat_auto_case_backlog_scp_entitlement_required",
  });
}

function conversationPermissionDenied(): Error {
  return Object.assign(new Error("permission-denied: conversation access denied"), {
    code: "permission-denied",
    errorCode: "mail_conversation_forbidden",
  });
}

function requireKnownCaseId(value: unknown): ChatAutoPermitCaseId {
  if (typeof value === "string" && isChatAutoPermitCaseId(value)) return value;
  throw invalidArgument("caseId must be a known casebook case");
}

// Same fallback chain candidateTable.ts's own requestAuthTenantId uses — resolveViewAsTarget needs
// the caller's auth-tenant to look up the viewAs target's member doc against the right tenant scope.
function requestAuthTenantId(request: CallableRequestShape): string {
  const token = asRecord(request.auth?.token);
  const firebase = asRecord(token.firebase);
  return asString(token.tenant) || asString(token.tenantId) || asString(firebase.tenant) || "default";
}

// ── getChatAutoCaseHeldBacklogCount ─────────────────────────────────────────────────────────────
//
// Deliberately NOT a live reclassification (that is requeueAutoReplyBacklog's/
// sendChatAutoCaseHeldBacklogNow's job, and it costs a real LLM call per candidate). This is a
// cheap estimate for the "보류 N건" label: it scans the SAME bounded candidate population the
// backlog sweep selects from (SELECTABLE_AUTO_REPLY_STATUSES, lastMessageFrom==="creator", within
// MAX_MAX_AGE_HOURS) and, for each, attributes it to a case via chatAutoCaseHeldBacklogPrimaryCaseId
// below.
//
// [case-backlog-send round 8, 2026-09-28] feat/casebook-p1p2 landed a persisted, freshness-provable
// stamp — chat-ai.ts writes `autoCaseId`/`autoCaseMessageRef` on the conversation for every
// classified inbound. chatAutoCaseHeldBacklogPrimaryCaseId now prefers that stamp (trusted only
// when `autoCaseMessageRef` still matches the conversation's CURRENT `lastMessageRef`) and falls
// back to the pre-existing `caseCandidates[0].caseId` proxy only when the stamp is absent or stale.
//
// [case-backlog-send round 9, 2026-09-28, codex review] this attribution preference is KEPT even
// though the analogous cheap prefilter in requeueAutoReplyBacklog (autoReplyBacklog.ts's
// trustedStoredPrimaryCaseId call site) was reverted to permanently disabled. The two are NOT the
// same risk: that prefilter's mistake would silently SKIP a row a fresh judgment would have queued
// (a false negative baked into the actual send). This function only produces the "보류 N건" DISPLAY
// label — it never gates a real send; sendChatAutoCaseHeldBacklogNow always re-derives the
// authoritative caseId from a fresh `gateway.caseId` live judgment regardless of what this count
// says. A stale label here is, at worst, a slightly-off number shown to the operator before they
// click — self-correcting on the next count fetch, never a silently-dropped conversation.
//
// Staleness: this is still an attribution snapshot, not a live reclassification. A conversation
// resolved through some other path since then (a human replied, autoReplyStatus changed) drops out
// on its own next read because the query re-checks the LIVE autoReplyStatus/lastMessageFrom fields
// every time — only the case attribution itself can lag (and now self-heals via the freshness check
// above), and the authoritative gate for an actual send is always the live reclassification
// sendChatAutoCaseHeldBacklogNow runs, never this count.
const HELD_BACKLOG_COUNT_SCAN_CAP = MAX_LIMIT;

export type GetChatAutoCaseHeldBacklogCountRequest = {
  caseId: string;
  /** When present, estimate only this server-resolved conversation; never expands into a case scan. */
  conversationId?: string;
  viewAsUserId?: string;
  viewAsEmail?: string;
};
export type GetChatAutoCaseHeldBacklogCountResult = {
  ok: true;
  caseId: ChatAutoPermitCaseId;
  heldCount: number;
  scanCap: number;
  // true when the scan hit scanCap before exhausting the window — heldCount is then a LOWER bound
  // ("scanCap+ 건"), not an exact count. The UI should render it as such.
  scannedCapped: boolean;
  behaviorLog: Record<string, unknown>;
};

type HeldBacklogCountDependencies = {
  now?: () => Date;
  queryHeldConversations?: (input: { cutoffIso: string; limit: number }) => Promise<Array<{ data: Record<string, unknown> }>>;
  readTargetConversation?: (conversationId: string) => Promise<Record<string, unknown> | null>;
  readTargetSource?: (sourceId: string) => Promise<Record<string, unknown> | null>;
  resolveConversationMailAccessScope?: typeof resolveConversationMailAccessScope;
  canReadScpConversationRowForOrg?: typeof canReadScpConversationRowForOrg;
  resolveViewAsTarget?: typeof resolveViewAsTarget;
  isCallerScpEntitled?: typeof isCallerScpEntitled;
};

const TARGET_CONVERSATION_ID = /^[A-Za-z0-9_.:-]{1,180}$/;

function requireTargetConversationId(value: unknown): string {
  if (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= 180 &&
    TARGET_CONVERSATION_ID.test(value) &&
    value !== "." &&
    value !== ".." &&
    !/^__.*__$/.test(value)
  ) return value;
  throw invalidArgument("conversationId must be one exact conversation document id");
}

async function readConversationById(conversationId: string): Promise<Record<string, unknown> | null> {
  const snapshot = await adminDb.collection("conversations").doc(conversationId).get();
  return snapshot.exists ? snapshot.data() ?? {} : null;
}

async function readMessageSourceById(sourceId: string): Promise<Record<string, unknown> | null> {
  const snapshot = await adminDb.collection("message_sources").doc(sourceId).get();
  return snapshot.exists ? snapshot.data() ?? {} : null;
}

function isTargetHeldBacklogCandidate(
  data: Record<string, unknown>,
  source: Record<string, unknown> | null,
  conversationId: string,
  caseId: ChatAutoPermitCaseId,
  cutoffIso: string,
): boolean {
  const lastMessageRef = asString(data.lastMessageRef, "");
  const sourceId = lastMessageRef.startsWith("message_sources/")
    ? lastMessageRef.slice("message_sources/".length)
    : "";
  const lastInboundAtIso = asString(data.lastInboundAtIso, "");
  const lastInboundAt = Date.parse(lastInboundAtIso);
  return data.mailAccountId === "scp" &&
    data.lastMessageFrom === "creator" &&
    SELECTABLE_AUTO_REPLY_STATUSES.includes(data.autoReplyStatus as (typeof SELECTABLE_AUTO_REPLY_STATUSES)[number]) &&
    Number.isFinite(lastInboundAt) &&
    lastInboundAt >= Date.parse(cutoffIso) &&
    sourceId.length > 0 &&
    !sourceId.includes("/") &&
    source?.conversationId === conversationId &&
    source.messageRef === lastMessageRef &&
    source.direction === "inbound" &&
    Boolean(asString(source.creatorId, "")) &&
    (source.attributionReviewRequired !== true || asRecord(source.senderIdentityBinding).bindingScope === "identity_only") &&
    chatAutoCaseHeldBacklogPrimaryCaseId(data) === caseId;
}

// Exported for tests — pure, no Firestore.
//
// [case-backlog-send round 8, 2026-09-28] prefers the persisted autoCaseId stamp (chat-ai.ts, every
// classified inbound) when it is FRESH — autoCaseMessageRef still equal to the conversation's
// current lastMessageRef, the same freshness contract chatAutoCasePermitCallables.ts's own
// pendingCount attribution uses. A newer inbound reply can move lastMessageRef forward without
// re-stamping autoCaseMessageRef, so a stale stamp is never trusted; this falls back to the
// pre-existing caseCandidates[0].caseId proxy (possibly stale itself, but the best available signal)
// whenever the stamp is absent or stale.
export function chatAutoCaseHeldBacklogPrimaryCaseId(data: Record<string, unknown>): string | null {
  const autoCaseId = data.autoCaseId;
  const autoCaseMessageRef = data.autoCaseMessageRef;
  const isFreshStamp =
    typeof autoCaseId === "string" &&
    isChatAutoPermitCaseId(autoCaseId) &&
    typeof autoCaseMessageRef === "string" &&
    autoCaseMessageRef.length > 0 &&
    autoCaseMessageRef === asString(data.lastMessageRef, "");
  if (isFreshStamp) return autoCaseId;

  const denyReasons = Array.isArray(data.permitDenyReasons) ? data.permitDenyReasons : [];
  if (denyReasons.includes("case_unclassified")) return null;
  const candidates = Array.isArray(data.caseCandidates) ? data.caseCandidates : [];
  if (candidates.length === 0) return null;
  const primary = asRecord(candidates[0]);
  const caseId = asString(primary.caseId, "");
  return caseId || null;
}

// [적대 리뷰, case-backlog-send round 2, 2026-09-28] mailAccountId=="scp" — the SAME predicate
// sendChatAutoCaseHeldBacklogNow's own send path already applies (autoReplyBacklog.ts's
// defaultQueryCandidates restrictToMailAccountId). Without it, an entitled viewer's "보류 N건"
// label could count rows from a mailbox other than scp@ — a count the send action itself can never
// reach (the send query is scp@-only), and worse, an entitlement leak across mailbox boundaries.
// No new composite index needed: this is the EXACT (mailAccountId, lastMessageFrom, autoReplyStatus,
// lastInboundAtIso, __name__) shape already required/registered for the scoped send query — see
// scripts/prod-index-control-plane.mjs's "지금 보내기" case-scoped sweep entry and
// firestore.indexes.json (both already carry it from that fix; nothing to add here).
async function defaultQueryHeldConversationsForCount(input: { cutoffIso: string; limit: number }): Promise<Array<{ data: Record<string, unknown> }>> {
  const snapshot = await adminDb
    .collection("conversations")
    .where("mailAccountId", "==", "scp")
    .where("lastMessageFrom", "==", "creator")
    .where("autoReplyStatus", "in", [...SELECTABLE_AUTO_REPLY_STATUSES])
    .where("lastInboundAtIso", ">=", input.cutoffIso)
    .orderBy("lastInboundAtIso", "asc")
    .limit(input.limit)
    .get();
  return snapshot.docs.map((doc) => ({ data: doc.data() ?? {} }));
}

async function defaultQuerySendCandidates(input: {
  cutoffIso: string;
  limit: number;
  cursor: { lastInboundAtIso: string; id: string } | null;
  restrictToMailAccountId?: string;
}): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  let query: FirebaseFirestore.Query = adminDb.collection("conversations");
  if (input.restrictToMailAccountId) query = query.where("mailAccountId", "==", input.restrictToMailAccountId);
  query = query
    .where("lastMessageFrom", "==", "creator")
    .where("autoReplyStatus", "in", [...SELECTABLE_AUTO_REPLY_STATUSES])
    .where("lastInboundAtIso", ">=", input.cutoffIso)
    .orderBy("lastInboundAtIso", "asc")
    .orderBy(FieldPath.documentId(), "asc");
  if (input.cursor) query = query.startAfter(input.cursor.lastInboundAtIso, input.cursor.id);
  const snapshot = await query.limit(input.limit).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() ?? {} }));
}

async function defaultReadConversationCandidatesByIds(ids: readonly string[]): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  if (ids.length === 0) return [];
  const refs = ids.map((id) => adminDb.collection("conversations").doc(id));
  const snapshots = await adminDb.getAll(...refs);
  return snapshots.map((snapshot, index) => ({
    id: ids[index],
    data: snapshot.exists ? snapshot.data() ?? {} : {},
  }));
}

export async function getChatAutoCaseHeldBacklogCount(
  request: CallableRequestShape,
  deps: HeldBacklogCountDependencies = {},
): Promise<GetChatAutoCaseHeldBacklogCountResult> {
  const auth = assertNonGuestAuth(request, "chat_auto_case_backlog.held_count");
  const data = asRecord(request.data);
  const caseId = requireKnownCaseId(data.caseId);

  // [적대 리뷰, round 2, 2026-09-28] Effective-user scp entitlement, viewAs-aware — a viewer without
  // scp entitlement (or "대신 보기" as one) must not see another org's held-count leak through this
  // read. Only a genuine super_admin caller may request viewAs at all (enforced inside
  // resolveViewAsTarget itself); the effective isSuperAdmin passed to isCallerScpEntitled reflects
  // the VIEWED target's role when viewAs is active, never the real caller's raw role — same contract
  // mailAccounts.ts's own ResolveMailAccountDeps.isSuperAdmin doc describes.
  const viewAsTarget = await (deps.resolveViewAsTarget ?? resolveViewAsTarget)(auth, data, requestAuthTenantId(request));
  const effectiveEmail = (viewAsTarget?.email ?? auth.email ?? "").toLowerCase();
  const effectiveIsSuperAdmin = viewAsTarget ? viewAsTarget.role === "super_admin" : auth.role === "super_admin";
  const effectiveUserId = viewAsTarget?.uid ?? auth.userId;
  // [적대 리뷰, main PR #220 round-5 FAIL-2, merged 2026-09-28] written as an explicit if/else
  // (rather than `(deps.isCallerScpEntitled ?? isCallerScpEntitled)(...)`) so the literal call
  // site `isCallerScpEntitled(effectiveEmail, ...)` is still present in this function's source —
  // the automated scp-gate scan (tests/scp-callable-entitlement.test.mjs) resolves gating by
  // regex-matching a literal `isCallerScpEntitled(`/`assertScpEntitled(` call, and a
  // nullish-coalesced function reference would silently evade that detection.
  const entitled = deps.isCallerScpEntitled
    ? await deps.isCallerScpEntitled(effectiveEmail, effectiveIsSuperAdmin, { userId: effectiveUserId })
    : await isCallerScpEntitled(effectiveEmail, effectiveIsSuperAdmin, { userId: effectiveUserId });
  if (!entitled) throw permissionDenied("scp entitlement required for the effective viewer");
  const accessScope = await (deps.resolveConversationMailAccessScope ?? resolveConversationMailAccessScope)({
    role: viewAsTarget?.role ?? auth.role,
    email: effectiveEmail,
    userId: effectiveUserId,
  });
  if (!accessScope.isSuperAdmin && !accessScope.hasScpEntitlement) {
    throw permissionDenied("scp entitlement required for the effective viewer");
  }
  const canReadRow = (row: Record<string, unknown>) =>
    canCallerReadScpRow(row, accessScope, deps.canReadScpConversationRowForOrg);

  const now = (deps.now ?? (() => new Date()))();
  const cutoffIso = new Date(now.getTime() - MAX_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();
  if (Object.prototype.hasOwnProperty.call(data, "conversationId")) {
    const conversationId = requireTargetConversationId(data.conversationId);
    const conversation = await (deps.readTargetConversation ?? readConversationById)(conversationId);
    const lastMessageRef = asString(conversation?.lastMessageRef, "");
    const sourceId = lastMessageRef.startsWith("message_sources/")
      ? lastMessageRef.slice("message_sources/".length)
      : "";
    const source = conversation && sourceId && !sourceId.includes("/")
      ? await (deps.readTargetSource ?? readMessageSourceById)(sourceId)
      : null;
    const heldCount = conversation &&
      canReadRow(conversation) &&
      isTargetHeldBacklogCandidate(conversation, source, conversationId, caseId, cutoffIso)
      ? 1
      : 0;
    return {
      ok: true,
      caseId,
      heldCount,
      scanCap: 1,
      scannedCapped: false,
      behaviorLog: { ...makeBehaviorLog(auth, "chat_auto_case_backlog.held_count", "success") },
    };
  }
  const rows = await (deps.queryHeldConversations ?? defaultQueryHeldConversationsForCount)({
    cutoffIso,
    limit: HELD_BACKLOG_COUNT_SCAN_CAP,
  });
  let heldCount = 0;
  for (const row of rows) {
    if (canReadRow(row.data) && chatAutoCaseHeldBacklogPrimaryCaseId(row.data) === caseId) heldCount += 1;
  }
  return {
    ok: true,
    caseId,
    heldCount,
    scanCap: HELD_BACKLOG_COUNT_SCAN_CAP,
    scannedCapped: rows.length >= HELD_BACKLOG_COUNT_SCAN_CAP,
    behaviorLog: { ...makeBehaviorLog(auth, "chat_auto_case_backlog.held_count", "success") },
  };
}

// ── sendChatAutoCaseHeldBacklogNow ──────────────────────────────────────────────────────────────

const BACKLOG_SEND_LOCK_COLLECTION = "chat_auto_case_backlog_send_locks";
const BACKLOG_SEND_AUDIT_COLLECTION = "chat_auto_case_backlog_send_audits";
// Comfortably longer than this callable's own configured timeoutSeconds (540s, matching
// requeueAutoReplyBacklog — see functions/index.ts) so the lock cannot expire out from under a
// still-running attempt, while still self-healing within minutes (not hours) if the process is
// killed before its `finally` release runs.
const BACKLOG_SEND_LOCK_TTL_MS = 15 * 60 * 1000;
// [적대 리뷰, round 2, 2026-09-28] one invocation now loops pages server-side instead of requiring
// the caller to re-click for every ~50-row page, bounded to MAX_LIMIT rows total per invocation
// (matches the sweep's own per-call ceiling) and to a wall-clock budget safely under the callable's
// own 540s timeout — whichever bound hits first stops the loop and returns a resumable cursor.
const TOTAL_ROW_CAP = MAX_LIMIT;
// [적대 리뷰, case-backlog-send round 2, 2026-09-28] tightened from 480s to 420s (per adversarial
// review guidance: "stop starting new rows well before 540s") — this is now also the ABSOLUTE
// per-row deadline threaded into requeueAutoReplyBacklog itself (see `deadlineMs` below), not just
// the between-page check, so the wider 120s remaining buffer (540s-420s) has to cover only an
// already-in-flight row finishing plus this callable's own attempt/audit writes, never a whole new
// page starting from scratch.
const WALL_CLOCK_BUDGET_MS = 420_000;
const DEFAULT_PAGE_LIMIT = 50;
// [적대 리뷰, round 2, 2026-09-28] COST-P0: bridges the dry-run pass's live judgment into the
// immediately-following real pass for the SAME row (conversation+message+casebook+release), so one
// "지금 보내기" click pays for at most one live model call per row, not two. Short-lived and scoped
// to a single invocation (see createBacklogSendGatewayJudgmentCache below) — it is not a durable
// cross-invocation cache and does not touch requeueAutoReplyBacklog's own bypassGatewayCache
// contract for any OTHER caller.
const GATEWAY_JUDGMENT_CACHE_TTL_MS = 5 * 60 * 1000;

function createBacklogSendGatewayJudgmentCache(underlying: typeof runGatewayLive): typeof runGatewayLive {
  const cache = new Map<string, { result: Awaited<ReturnType<typeof runGatewayLive>>; cachedAtMs: number }>();
  const releaseBuildSha = cachedChatAutoPermitReleaseSourceCommit() ?? "";
  const wrapped: typeof runGatewayLive = async (data, action, options) => {
    const conversationId = typeof data.conversationId === "string" ? data.conversationId : "";
    // [적대 리뷰, case-backlog-send round 2, 2026-09-28] keyed on the CONVERSATION's own persisted
    // lastMessageRef (buildAutoReplyBacklogGatewayInput's `conversationLastMessageRef` —
    // autoReplyBacklog.ts), never `data.messageRef` — that field is the SOURCE doc's own
    // originalMessageRef/messageRef, an external provider reference that can repeat across distinct
    // inbound message_sources records (e.g. a resend/bounce carrying the same external id). Keying
    // on the repeatable external reference could reuse a stale judgment for a conversation whose
    // latest inbound message actually changed between this invocation's dry-run and real pass.
    const conversationLastMessageRef = typeof data.conversationLastMessageRef === "string" ? data.conversationLastMessageRef : "";
    const key = [conversationId, conversationLastMessageRef, CHAT_CASEBOOK_CONTENT_HASH, releaseBuildSha].join("::");
    const nowMs = Date.now();
    const hit = cache.get(key);
    if (hit && nowMs - hit.cachedAtMs < GATEWAY_JUDGMENT_CACHE_TTL_MS) return hit.result;
    const result = await underlying(data, action, options);
    cache.set(key, { result, cachedAtMs: nowMs });
    return result;
  };
  return wrapped;
}

// A server-internal identity used ONLY to satisfy requeueAutoReplyBacklog's own
// assertNonGuestAuth(..., ["super_admin"]) gate — the REAL caller's identity (checked against
// MUTATION_ROLES + assertScpEntitled just below, in sendChatAutoCaseHeldBacklogNow itself) is what
// actually authorized this action and is what gets written to this file's own attempt/audit record
// (chat_auto_case_backlog_send_audits), never this synthetic actor. Same pattern
// chatAutoCasePermitCallables.ts's CHAT_AUTO_CASE_PERMIT_REFRESH_SYSTEM_ACTOR already uses to let a
// higher-level, differently-gated workflow drive an existing narrowly-gated tool without widening
// that tool's own RBAC.
const BACKLOG_SEND_SYSTEM_ACTOR: AuthContext = {
  userId: "chat-auto-case-backlog-send",
  role: "super_admin",
  team: "aix",
  ip: "0.0.0.0",
  gameId: "scp-automation",
  email: "chat-auto-case-backlog-send@supercent.io",
  name: "Chat Auto Case Backlog Send",
};

function requeueRequestFor(input: {
  caseId: ChatAutoPermitCaseId;
  dryRun: boolean;
  limit?: number;
  cursor?: string;
  // [적대 리뷰, case-backlog-send round 5, 2026-09-28] when provided, this call bypasses the
  // windowed query entirely (autoReplyBacklog.ts's own conversationIds request field) — `limit`/
  // `cursor` are then irrelevant and omitted. Used for the real (enqueue) pass so it operates on
  // the EXACT rows the preceding preview pass planned, never a fresh count-bounded re-query.
  conversationIds?: readonly string[];
}): CallableRequestShape {
  const actor = BACKLOG_SEND_SYSTEM_ACTOR;
  return {
    internalTrustedInvocation: true,
    auth: {
      uid: actor.userId,
      token: { role: actor.role, team: actor.team, gameId: actor.gameId, email: actor.email, name: actor.name },
    },
    data: {
      caseIdFilter: input.caseId,
      // Matches getChatAutoCaseHeldBacklogCount's window exactly — "지금 보내기" must be able to
      // reach every conversation the "보류 N건" label counted, not just the last 72h default.
      maxAgeHours: MAX_MAX_AGE_HOURS,
      ...(input.conversationIds
        ? { conversationIds: input.conversationIds }
        : { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) }),
      dryRun: input.dryRun,
      ...(input.dryRun ? {} : { confirm: AUTO_REPLY_BACKLOG_CONFIRM_TOKEN }),
    },
    rawRequest: { ip: actor.ip },
  };
}

type BacklogSendLockClaim = { ok: true; lockToken: string } | { ok: false; claimedAtIso: string };

async function defaultClaimBacklogSendLock(input: {
  caseId: string;
  actorUidHash: string;
  nowIso: string;
}): Promise<BacklogSendLockClaim> {
  const lockToken = randomUUID();
  const ref = adminDb.collection(BACKLOG_SEND_LOCK_COLLECTION).doc(input.caseId);
  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const existing = snapshot.exists ? (snapshot.data() ?? {}) : null;
    const claimedAtIso = existing ? asString(existing.claimedAtIso, "") : "";
    const expired = !claimedAtIso || Date.parse(input.nowIso) - Date.parse(claimedAtIso) > BACKLOG_SEND_LOCK_TTL_MS;
    if (existing && !expired) {
      return { ok: false, claimedAtIso };
    }
    transaction.set(ref, {
      caseId: input.caseId,
      lockToken,
      actorUidHash: input.actorUidHash,
      claimedAtIso: input.nowIso,
    });
    return { ok: true, lockToken };
  });
}

// Compare-and-delete, mirroring conversationAutoLane.ts's releaseConversationAutoLane — never
// clobbers a DIFFERENT attempt's lock (e.g. one that claimed after this attempt's own lock expired
// under BACKLOG_SEND_LOCK_TTL_MS). Tolerant of any failure: a release that never lands just waits
// out the TTL, same as an abandoned conversation-lane claim.
async function defaultReleaseBacklogSendLock(caseId: string, lockToken: string): Promise<void> {
  const ref = adminDb.collection(BACKLOG_SEND_LOCK_COLLECTION).doc(caseId);
  try {
    await adminDb.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return;
      const data = snapshot.data() ?? {};
      if (asString(data.lockToken, "") !== lockToken) return;
      transaction.delete(ref);
    });
  } catch (error) {
    console.error("[chatAutoCaseBacklogSend] lock release failed — tolerated (TTL self-heals)", {
      caseId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type BacklogSendSkipped = RequeueAutoReplyBacklogResult["skipped"];

function emptySkipped(): BacklogSendSkipped {
  return {
    takenOver: 0,
    alreadyReplied: 0,
    laneLocked: 0,
    aiInactive: 0,
    denied: 0,
    stale: 0,
    recentlyDenied: 0,
    orgExcluded: 0,
    manualReplyDetected: 0,
    caseMismatch: 0,
    humanReviewHeld: 0,
  };
}

function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

export type SendChatAutoCaseHeldBacklogNowRequest = {
  caseId: string;
  /** When present, reclassify/requeue this exact server-resolved conversation only. */
  conversationId?: string;
  limit?: number;
  cursor?: string;
};
export type SendChatAutoCaseHeldBacklogNowResult = {
  ok: true;
  caseId: ChatAutoPermitCaseId;
  // Count of held conversations that reclassified into caseId AND passed every existing gate in
  // the dry-run pass across every page processed this invocation (i.e. what the real pass(es)
  // below were expected to queue).
  planned: number;
  // [적대 리뷰, round 2, 2026-09-28] renamed from "sent" — requeueAutoReplyBacklog only WRITES an
  // auto_reply_queue doc with status "scheduled" (see autoReplyBacklog.ts's queueDocBase); actual
  // provider delivery happens later, asynchronously, via processAutoReplyQueue. Calling this "sent"
  // overstated what this callable itself guarantees.
  queued: number;
  scanned: number;
  // [적대 리뷰 round 2, 2026-09-28] merges BOTH the PREVIEW pass's skips (rows never planned — the
  // common case for an ineligible row: manual reply, case mismatch, mail safety, etc.) AND the
  // enqueue pass's skips (a planned row that dropped out on its second, real-commit judgment) across
  // every page. The internal "dry_run_preview" bookkeeping reason (and its matching `denied`
  // increments) is excluded — it only ever signals "this row IS `planned`", not a real skip reason.
  skipped: BacklogSendSkipped;
  denyReasons: Record<string, number>;
  senderIdentityDiagnostics: Record<string, number>;
  pagesProcessed: number;
  nextCursor: string | null;
  // [적대 리뷰, case-backlog-send round 3, 2026-09-28] "deadline" when the loop stopped because the
  // wall-clock budget ran out (between pages, OR mid-page with the enqueue pass cut before it could
  // scan anything past `nextCursor`) — never confuse this with a genuinely exhausted backlog
  // (nextCursor === null AND stoppedReason === null). null for every other stop (row cap reached,
  // or the backlog window is actually empty).
  stoppedReason: "deadline" | null;
  behaviorLog: Record<string, unknown>;
};

type SendChatAutoCaseHeldBacklogNowDependencies = {
  now?: () => Date;
  resolveModelVersion?: () => Promise<string> | string;
  resolveSourceCommit?: () => Promise<string> | string;
  getPermitStatus?: typeof getChatAutoCasePermitStatus;
  requeueBacklog?: typeof requeueAutoReplyBacklog;
  // Passed straight through to every requeueBacklog call this invocation makes (all pages, both the
  // dry-run and real pass of each), merged with the gateway-judgment cache wrapper — lets tests
  // exercise the REAL requeueAutoReplyBacklog pipeline end-to-end (queryCandidates/readSettings/
  // buildChatAutoPermitReceivePlan/etc.) while still controlling its Firestore-touching internals.
  // `runGatewayLive` here is the UNDERLYING function the cache wraps, not a replacement for caching.
  requeueDeps?: AutoReplyBacklogDependencies;
  claimLock?: typeof defaultClaimBacklogSendLock;
  releaseLock?: typeof defaultReleaseBacklogSendLock;
  totalRowCap?: number;
  wallClockBudgetMs?: number;
  nowMs?: () => number;
  newAttemptId?: () => string;
  assertScpEntitled?: typeof assertScpEntitled;
  readTargetConversation?: (conversationId: string) => Promise<Record<string, unknown> | null>;
  resolveConversationMailAccessScope?: typeof resolveConversationMailAccessScope;
  canReadScpConversationRowForOrg?: typeof canReadScpConversationRowForOrg;
};

function canCallerReadScpRow(
  row: Record<string, unknown>,
  scope: ConversationMailAccessScope,
  predicate: typeof canReadScpConversationRowForOrg = canReadScpConversationRowForOrg,
): boolean {
  return predicate(row, {
    viewerOrgId: scope.viewerOrgId,
    isSuperAdmin: scope.isSuperAdmin,
    hasScpEntitlement: scope.hasScpEntitlement,
  });
}

export async function sendChatAutoCaseHeldBacklogNow(
  request: CallableRequestShape,
  deps: SendChatAutoCaseHeldBacklogNowDependencies = {},
): Promise<SendChatAutoCaseHeldBacklogNowResult> {
  // RBAC: reuses arm/disarm/eval's own floor (MUTATION_ROLES) rather than
  // requeueAutoReplyBacklog's stricter super_admin-only gate — see BACKLOG_SEND_SYSTEM_ACTOR above
  // for how the inner sweep still gets the super_admin identity IT requires without granting that
  // role to the real caller.
  const auth = assertNonGuestAuth(request, "chat_auto_case_backlog.send_now", MUTATION_ROLES);
  // [적대 리뷰, round 2, 2026-09-28] role RBAC alone is not enough — a manager without scp
  // entitlement must not be able to trigger a real-mail sweep over scp@ data. No viewAs support
  // here (this is a mutation; the codebase's own convention — see mailAccountCallables.ts's
  // assertViewAsAllowed doc — is that "대신 보기" is a read-only preview and never elevates write
  // authority), so this always checks the REAL caller, never a viewAs target.
  // [적대 리뷰, main PR #220 round-5 FAIL-2, merged 2026-09-28] explicit if/else (not
  // `(deps.assertScpEntitled ?? assertScpEntitled)(...)`) so the automated scp-gate scan
  // (tests/scp-callable-entitlement.test.mjs, regex-matches a literal `assertScpEntitled(` call)
  // still detects this handler as scp-gated — see getChatAutoCaseHeldBacklogCount's matching note.
  if (deps.assertScpEntitled) {
    await deps.assertScpEntitled(auth, request, "chat_auto_case_backlog.send_now");
  } else {
    await assertScpEntitled(auth, request, "chat_auto_case_backlog.send_now");
  }
  const accessScope = await (deps.resolveConversationMailAccessScope ?? resolveConversationMailAccessScope)({
    role: auth.role,
    email: auth.email,
    userId: auth.userId,
  });
  if (!accessScope.isSuperAdmin && !accessScope.hasScpEntitlement) {
    throw permissionDenied("scp entitlement required for the effective viewer");
  }
  const canReadRow = (row: Record<string, unknown>) =>
    canCallerReadScpRow(row, accessScope, deps.canReadScpConversationRowForOrg);
  const data = asRecord(request.data);
  const caseId = requireKnownCaseId(data.caseId);
  const targetConversationId = Object.prototype.hasOwnProperty.call(data, "conversationId")
    ? requireTargetConversationId(data.conversationId)
    : undefined;
  if (targetConversationId && (
    Object.prototype.hasOwnProperty.call(data, "limit") ||
    Object.prototype.hasOwnProperty.call(data, "cursor")
  )) {
    throw invalidArgument("conversationId cannot be combined with limit or cursor");
  }
  const requestedLimit = typeof data.limit === "number" && Number.isFinite(data.limit) && data.limit > 0
    ? Math.floor(data.limit)
    : DEFAULT_PAGE_LIMIT;
  const initialCursor = typeof data.cursor === "string" && data.cursor ? data.cursor : undefined;

  const getPermitStatus = deps.getPermitStatus ?? getChatAutoCasePermitStatus;
  const requeueBacklog = deps.requeueBacklog ?? requeueAutoReplyBacklog;
  const claimLock = deps.claimLock ?? defaultClaimBacklogSendLock;
  const releaseLock = deps.releaseLock ?? defaultReleaseBacklogSendLock;
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const totalRowCap = targetConversationId ? 1 : deps.totalRowCap ?? TOTAL_ROW_CAP;
  const wallClockBudgetMs = deps.wallClockBudgetMs ?? WALL_CLOCK_BUDGET_MS;
  const nowMs = deps.nowMs ?? (() => Date.now());

  // Precondition: the case must be currently armed — same "armed" definition the /chat/auto status
  // panel itself shows (effectivePermitState in chatAutoCasePermitCallables.ts), reused via the
  // real status callable rather than re-deriving pin/eval/casebook-hash logic a second time here.
  const statusEnvelope = await getPermitStatus(
    { ...request, data: { caseIds: [caseId] } },
    { resolveModelVersion: deps.resolveModelVersion, resolveSourceCommit: deps.resolveSourceCommit },
  );
  const statusRow = statusEnvelope.rows.find((row) => row.caseId === caseId) ?? null;
  if (!statusRow || statusRow.state !== "armed") {
    throw failedPrecondition(
      `case "${caseId}" is not currently armed (state=${statusRow?.state ?? "unknown"}) — arm it before releasing its held backlog`,
    );
  }

  // Targeted mode has a hard no-fallback contract: resolve the one requested document only after
  // caller RBAC, SCP entitlement, and the live armed-case check. A missing id fails closed here;
  // it can never fall through to the whole-case windowed query.
  if (targetConversationId) {
    const target = await (deps.readTargetConversation ?? readConversationById)(targetConversationId);
    if (!target) throw failedPrecondition("the requested conversation is unavailable");
    if (!canReadRow(target)) throw conversationPermissionDenied();
  }

  // Idempotency / double-click safety: a per-case lock, held for the duration of the ENTIRE
  // multi-page loop below. This is on top of (not instead of) requeueAutoReplyBacklog's own
  // per-conversation transactional guard (defaultCommitAutoReplyBacklogRequeue re-checks for a live
  // auto_reply_queue job inside the same transaction as its write) — that guard alone already
  // prevents a literal double-send of any ONE conversation. This lock exists so a second concurrent
  // click doesn't ALSO burn a second full round of live LLM reclassification calls across the whole
  // held set, and so the reported counts describe one coherent attempt rather than two interleaved
  // ones.
  const claim = await claimLock({ caseId, actorUidHash: actorUidHash(auth.userId), nowIso });
  if (!claim.ok) {
    throw failedPrecondition(
      `a "지금 보내기" send is already in progress for case "${caseId}" (started ${claim.claimedAtIso}) — wait for it to finish before retrying`,
    );
  }

  // [적대 리뷰, round 2, 2026-09-28] Attempt audit record — created BEFORE any work starts, then
  // updated after every page and on both the success and failure exits, so a timeout or crash mid-
  // loop still leaves a durable record of the real operator's identity, caseId, and whatever
  // progress was actually made (never left silently attributed only to the inner sweep's synthetic
  // actor — see BACKLOG_SEND_SYSTEM_ACTOR above).
  const attemptId = (deps.newAttemptId ?? randomUUID)();
  const attemptRef = adminDb.collection(BACKLOG_SEND_AUDIT_COLLECTION).doc(attemptId);
  await attemptRef.set({
    attemptId,
    actorUidHash: actorUidHash(auth.userId),
    actorRole: auth.role,
    caseId,
    status: "started",
    params: targetConversationId
      ? { conversationId: targetConversationId }
      : { limit: requestedLimit, cursor: initialCursor ?? null },
    startedAtIso: nowIso,
  });

  const requeueDeps = deps.requeueDeps ?? {};
  const gatewayCache = createBacklogSendGatewayJudgmentCache(requeueDeps.runGatewayLive ?? runGatewayLive);
  const queryCandidates = requeueDeps.queryCandidates ?? defaultQuerySendCandidates;
  const readCandidatesByIds = requeueDeps.readCandidatesByIds ?? defaultReadConversationCandidatesByIds;
  const queryAuthorizedCandidates: NonNullable<AutoReplyBacklogDependencies["queryCandidates"]> = async (input) =>
    (await queryCandidates(input)).filter((candidate) => canReadRow(candidate.data));
  const readAuthorizedCandidatesByIds: NonNullable<AutoReplyBacklogDependencies["readCandidatesByIds"]> = async (ids) =>
    (await readCandidatesByIds(ids)).map((candidate) =>
      canReadRow(candidate.data) ? candidate : { id: candidate.id, data: {} },
    );
  const startMs = nowMs();
  // [적대 리뷰, case-backlog-send round 2, 2026-09-28] one ABSOLUTE deadline (not a fresh budget per
  // call) threaded into requeueAutoReplyBacklog's own per-row check (autoReplyBacklog.ts) — every
  // dry-run and real pass across every page of THIS invocation shares it, so a page's dry+real pass
  // together (not each separately) must fit inside the remaining wall-clock budget. Without this,
  // requeueAutoReplyBacklog only ever saw a per-page candidate array with no way to stop mid-page —
  // a single oversized page (up to MAX_LIMIT live-model round trips) could run past this callable's
  // own 540s timeout with no other budget check in between (see WALL_CLOCK_BUDGET_MS below for the
  // between-page check this complements, not replaces).
  const deadlineMs = startMs + wallClockBudgetMs;
  const sharedRequeueDeps: AutoReplyBacklogDependencies = {
    ...requeueDeps,
    queryCandidates: queryAuthorizedCandidates,
    readCandidatesByIds: readAuthorizedCandidatesByIds,
    authorizeConversationAtCommit: canReadRow,
    runGatewayLive: gatewayCache,
    nowMs,
    deadlineMs,
  };

  let totalPlanned = 0;
  let totalQueued = 0;
  let totalScanned = 0;
  let pagesProcessed = 0;
  const aggregatedSkipped: Record<string, number> = { ...emptySkipped() };
  const aggregatedDenyReasons: Record<string, number> = {};
  // Counts of why sender_not_creator fired (autoReplyBacklog.ts BacklogSenderIdentityDiagnostic).
  const aggregatedSenderIdentityDiagnostics: Record<string, number> = {};
  let cursor: string | undefined = initialCursor;
  // [적대 리뷰, case-backlog-send round 3, 2026-09-28] see SendChatAutoCaseHeldBacklogNowResult's
  // own doc comment — set ONLY when the wall-clock budget is why the loop stopped, so the caller
  // never has to guess whether a null-ish outcome means "done" or "ran out of time".
  let stoppedReason: "deadline" | null = null;

  try {
    for (;;) {
      if (totalScanned >= totalRowCap) break;
      const remainingMsBeforePage = deadlineMs - nowMs();
      if (remainingMsBeforePage <= 0) {
        stoppedReason = "deadline";
        break;
      }
      const pageLimit = targetConversationId ? 1 : Math.min(totalRowCap - totalScanned, requestedLimit);

      // [적대 리뷰, case-backlog-send round 3, 2026-09-28] preview and enqueue now get separate,
      // bounded shares of this page's remaining budget instead of both racing the SAME shared
      // deadline. Previously an expensive preview pass could consume the entire remaining budget on
      // its own, leaving the enqueue pass zero time to act on exactly what preview just found —
      // reproduced directly: `planned > 0`, `queued: 0`, `nextCursor: null`, silently read as "the
      // backlog is exhausted" by the `!sendResult.nextCursor` check below. Preview is capped at
      // HALF of what remains; enqueue keeps the FULL remaining budget (never reduced by however
      // long preview actually took), so enqueue is never worse off than if preview had taken zero
      // time. The deadlineHit branch further below is the remaining defense-in-depth for the
      // residual case where a single pathologically slow row still eats past enqueue's own share.
      const previewDeadlineMs = nowMs() + Math.floor(remainingMsBeforePage / 2);
      const previewRequeueDeps: AutoReplyBacklogDependencies = { ...sharedRequeueDeps, deadlineMs: previewDeadlineMs };

      // Always dry-run first: reclassifies this page's candidate window WITHOUT writing anything,
      // so "planned" reflects exactly what the real pass below is expected to queue. Reuses
      // requeueAutoReplyBacklog's own "dry_run_preview" denyReasons bucket, which — for a
      // caseIdFilter-scoped call — only fires for candidates that already passed every existing
      // gate AND matched this case (see autoReplyBacklog.ts's caseIdFilter comments). The real pass
      // immediately after reuses the SAME live judgment per row via gatewayCache (COST-P0 — at
      // most one live model call per row per invocation, not two).
      const dryRunResult = await requeueBacklog(
        requeueRequestFor({
          caseId,
          limit: pageLimit,
          cursor,
          dryRun: true,
          ...(targetConversationId ? { conversationIds: [targetConversationId] } : {}),
        }),
        previewRequeueDeps,
      );

      if (targetConversationId && (
        dryRunResult.plannedConversationIds.length > 1 ||
        dryRunResult.plannedConversationIds.some((id) => id !== targetConversationId)
      )) {
        throw failedPrecondition("targeted preview returned a conversation outside the requested target");
      }

      // [적대 리뷰, case-backlog-send round 5, 2026-09-28] planned >= queued must ALWAYS hold. Round
      // 4 bounded the enqueue pass by the NUMBER of rows preview scanned, then re-ran the windowed
      // query with that smaller limit — but a previewed row dropping out of the window before that
      // second query ran (a status change, a new inbound reply, etc.) could let a LATER,
      // never-previewed row slide into the freed slot and get queued (queued > planned remained
      // possible). Fixed properly: the enqueue pass now runs on the EXACT conversation ids preview
      // planned (autoReplyBacklog.ts's `conversationIds` request field — bypasses the windowed
      // query, re-reads each id fresh inside every existing gate), never a count-bounded re-query.
      // `totalScanned` is tracked from the PREVIEW pass now (it is the one running the windowed
      // query; the enqueue pass's own "scanned" is just its bounded id-list length, not backlog
      // coverage).
      totalPlanned += dryRunResult.plannedConversationIds.length;
      totalScanned += dryRunResult.scanned;
      pagesProcessed += 1;

      // [적대 리뷰 round 2, 2026-09-28] the PREVIEW pass's own skipped/denyReasons cover every row
      // THIS page scanned that did NOT make it into plannedConversationIds — a manual reply detected,
      // a case mismatch, mail safety denial, an unarmed/stale permit, etc. Previously these were
      // discarded entirely (only the tiny enqueue pass below, over the small PLANNED subset, was ever
      // merged in), so the caller-facing skipped/denyReasons wildly undercounted: any row denied
      // during preview — the common case for an ineligible row — never showed up in the breakdown at
      // all, and the attempt audit record (below) inherited the same gap.
      //
      // Every row requeueBacklog PLANS is ALSO deliberately counted once toward skipped.denied and
      // denyReasons.dry_run_preview (autoReplyBacklog.ts's "Second dryRun exit" — dry_run_preview is
      // how a caseIdFilter-scoped preview signals "this would be queued", not a real business skip
      // reason). That contribution is exactly `dryRunResult.plannedConversationIds.length` many
      // `denied` increments (a planned row is denied via no other branch in the same pass), so it is
      // subtracted before merging, and the "dry_run_preview" key itself is dropped — it must never
      // leak into the caller-facing denyReasons breakdown. The preview set (non-planned rows) and the
      // enqueue set (planned rows, re-judged below) are disjoint, so merging both here is additive
      // with no double counting.
      const previewSkipped: Record<string, number> = { ...dryRunResult.skipped };
      previewSkipped.denied = Math.max(0, (previewSkipped.denied ?? 0) - dryRunResult.plannedConversationIds.length);
      mergeCounts(aggregatedSkipped, previewSkipped);
      const previewDenyReasons: Record<string, number> = { ...dryRunResult.denyReasons };
      delete previewDenyReasons.dry_run_preview;
      mergeCounts(aggregatedDenyReasons, previewDenyReasons);
      mergeCounts(aggregatedSenderIdentityDiagnostics, dryRunResult.senderIdentityDiagnostics ?? {});

      let sendResult: RequeueAutoReplyBacklogResult | null = null;
      if (dryRunResult.plannedConversationIds.length > 0) {
        sendResult = await requeueBacklog(
          requeueRequestFor({ caseId, dryRun: false, conversationIds: dryRunResult.plannedConversationIds }),
          sharedRequeueDeps,
        );
        totalQueued += sendResult.requeued;
        // Enqueue-time skips: a planned row that dropped out during its SECOND (real-commit) pass —
        // e.g. a lane lock lost the race, or a manual reply landed between preview and enqueue. This
        // is the disjoint complement of previewSkipped above (planned rows only), so merging both is
        // safe.
        mergeCounts(aggregatedSkipped, sendResult.skipped);
        mergeCounts(aggregatedDenyReasons, sendResult.denyReasons);
        mergeCounts(aggregatedSenderIdentityDiagnostics, sendResult.senderIdentityDiagnostics ?? {});
      }

      await attemptRef.update({
        status: "in_progress",
        progress: {
          pagesProcessed,
          planned: totalPlanned,
          queued: totalQueued,
          scanned: totalScanned,
        },
        updatedAtIso: (deps.now ?? (() => new Date()))().toISOString(),
      });

      if (targetConversationId) {
        stoppedReason = dryRunResult.deadlineHit || sendResult?.deadlineHit ? "deadline" : null;
        cursor = undefined;
        break;
      }

      if (sendResult?.deadlineHit) {
        // The enqueue pass itself was cut short before finishing its own (already small, exact)
        // list — rare, since it works off a bounded list with the FULL remaining budget, but
        // possible for a single pathologically slow row. Preserve `cursor` UNCHANGED (never advance
        // to dryRunResult.nextCursor) so the next invocation's fresh preview re-discovers whichever
        // planned rows this pass never reached, instead of silently skipping past them.
        stoppedReason = "deadline";
        break;
      }

      if (dryRunResult.deadlineHit && dryRunResult.plannedConversationIds.length === 0) {
        // Preview's own deadline hit before it could plan even one row this page — nothing was
        // enqueued (the `if` above never ran).
        //
        // [codex review round 3, 2026-09-28] `dryRunResult.nextCursor` is NOT necessarily null here
        // — autoReplyBacklog.ts's `lastLookedAtCursor` (which nextCursor resumes from under
        // deadlineHit) advances for EVERY candidate the preview actually looked at, including ones it
        // examined and then skipped (manual reply, case mismatch, mail safety, etc.), not just
        // planned ones. A page that examines and skips N rows before running out of budget has
        // already made real progress — those N rows need no re-examination — so the outer cursor must
        // advance to `dryRunResult.nextCursor` when one exists. Only when the deadline hit before
        // looking at even the FIRST candidate this page (nextCursor genuinely null — zero progress)
        // does the outer cursor stay unchanged, so the generic `!dryRunResult.nextCursor` branch
        // below is never reached to misread a `null` here as "the backlog is exhausted". Without this
        // advance, a page whose skip-heavy prefix reliably re-triggers the same deadline on every
        // continuation could loop on the SAME already-examined rows forever, never reaching later
        // eligible mail past them.
        cursor = dryRunResult.nextCursor ?? cursor;
        stoppedReason = "deadline";
        break;
      }

      if (!dryRunResult.nextCursor) {
        cursor = undefined;
        break;
      }
      cursor = dryRunResult.nextCursor;

      if (dryRunResult.deadlineHit) {
        // The preview pass for this page already ran into deadline pressure — even though enqueue
        // (if anything was planned) completed cleanly, another full-sized page is unlikely to fit.
        // Stop here with the cursor already advanced above (every planned row for THIS page was
        // successfully handled), rather than attempting (and likely re-truncating) another page.
        stoppedReason = "deadline";
        break;
      }
    }

    const finalNextCursor = cursor ?? null;
    await attemptRef.update({
      status: "completed",
      counts: {
        planned: totalPlanned,
        queued: totalQueued,
        scanned: totalScanned,
        skipped: aggregatedSkipped,
        denyReasons: aggregatedDenyReasons,
        senderIdentityDiagnostics: aggregatedSenderIdentityDiagnostics,
      },
      pagesProcessed,
      nextCursor: finalNextCursor,
      stoppedReason,
      completedAtIso: (deps.now ?? (() => new Date()))().toISOString(),
    });

    return {
      ok: true,
      caseId,
      planned: totalPlanned,
      queued: totalQueued,
      scanned: totalScanned,
      skipped: aggregatedSkipped as BacklogSendSkipped,
      denyReasons: aggregatedDenyReasons,
      senderIdentityDiagnostics: aggregatedSenderIdentityDiagnostics,
      pagesProcessed,
      nextCursor: finalNextCursor,
      stoppedReason,
      behaviorLog: { ...makeBehaviorLog(auth, "chat_auto_case_backlog.send_now", "success") },
    };
  } catch (error) {
    try {
      await attemptRef.update({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        progress: { pagesProcessed, planned: totalPlanned, queued: totalQueued, scanned: totalScanned },
        failedAtIso: (deps.now ?? (() => new Date()))().toISOString(),
      });
    } catch (attemptWriteError) {
      console.error("[chatAutoCaseBacklogSend] failed to record attempt failure — tolerated", {
        caseId,
        attemptId,
        error: attemptWriteError instanceof Error ? attemptWriteError.message : String(attemptWriteError),
      });
    }
    throw error;
  } finally {
    await releaseLock(caseId, claim.lockToken);
  }
}
