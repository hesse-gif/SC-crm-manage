// Casebook pending precompute (2026-09-29, casebook snapshot 504 hotfix; single-scan redesign
// 2026-09-29 same day, adversarial review round 1)
//
// Production incident: getChatAutoCasebookSnapshot (functions/chatAutoCasePermitCallables.ts) ran
// the unreplied-inbox pending scan INLINE on every call — up to ~900 conversation reads
// (UNREPLIED_INBOX_MAX_SCAN_PAGES x UNREPLIED_INBOX_SCAN_LIMIT in functions/read.ts) plus up to
// ~200 manual-reply IMAP/Gmail checks (detectManualReplySinceInbound, each up to
// MANUAL_REPLY_PROBE_LIMIT=50 Firestore reads) plus a Peoply org lookup — slow enough in
// production to hit the 60s Cloud Run request timeout (504), taking down both the pending section
// AND the per-case auto-send section of /chat/auto with it, since they shared the one callable.
//
// Fix (round 1): getChatAutoCasebookSnapshot never runs this scan — it only ever reads a
// precomputed doc (fast, single Firestore get). A scheduled job precomputes pending counts into
// `chat_auto_casebook_pending/{scopeKey}`.
//
// Fix (round 1 adversarial review, same day): round 1 shipped the scheduled job running the FULL
// scan+manual-reply-check pipeline ONCE PER SCOPE (super_admin + each configured org) — up to
// ~10,900 reads x N scopes per tick, ~9.6M reads/day at a 5-minute cadence, AND round 1's scope
// enumeration only covered settings/mail_routing.scpAllowedOrgIds, so an entitled caller holding a
// DIRECT per-member scp grant (functions/mailAccounts.ts MAIL_ACCOUNT_ACCESS_FIELD) whose own org
// was never in that list could resolve to an `org:<id>` scope key with no doc ever written for it —
// permanently stuck at "missing" ("계산 중"), because the reader had no fallback.
//
// This redesign fixes both:
//   1. The scan (Firestore conversations scan + manual-reply checks) runs with the super_admin
//      (unfiltered) access. Every scope's counts are DERIVED IN MEMORY from that already-scanned,
//      already-manual-reply-checked row set by re-applying canReadConversationRowForScope (the same
//      per-row predicate listUnrepliedInboxHandler always used) — zero additional Firestore reads
//      per scope. Pages are checkpointed and resumed across ticks as necessary; cost is O(scan),
//      not O(scan x scopes), regardless of how many orgs exist.
//   2. Scope coverage now includes org ids resolved from members holding a DIRECT scp grant (see
//      directGrantOrgIds below, enumerated from the `members` collection — MAIL_ACCOUNT_ACCESS_FIELD
//      array-contains "scp" — not just settings/mail_routing.scpAllowedOrgIds), PLUS a fixed
//      "no_resolved_org" bucket shared by every entitled-but-org-unresolved caller (this bucket's
//      visible row set never depends on WHICH such caller is asking — canReadScpConversationRowForOrg
//      denies every explicit-scp row alike when viewerOrgId is null, per
//      functions/mailConversationAuthorization.ts's fail-closed doctrine — so one shared doc is
//      correct for all of them, not an approximation). AS A SECOND LAYER OF DEFENSE — in case org
//      enumeration still misses some caller's specific org (a brand-new org, a Peoply hiccup during
//      enumeration, a still-newer grant since the last tick) — the same single scan's row set (in
//      compact form) is ALSO cached in one shared doc (CHAT_AUTO_CASEBOOK_PENDING_ROW_CACHE_DOC_ID).
//      getChatAutoCasebookSnapshot falls back to it — deriving that one caller's own scope on demand,
//      in memory, from already-scanned data (cheap: one extra Firestore GET, zero additional
//      scanning) — before ever reporting "missing".
//
// Fix (round 2 adversarial review, same day): round 1's shared row cache stored the RAW
// autoCaseMessageRef/lastMessageRef Firestore reference strings — these are derived from inbound
// email Message-ID headers (functions/chat-ai.ts persistReceivedEmail/mailImapIngest.ts) and, even
// after safeMessageSourceId's doc-id character sanitization, still carry recognizable
// PII-derived tokens (e.g. a sender local-part/domain like "jane"/"example"/"com" survives with `-`
// in place of `@`/`.`). SEC-P0-009 (no raw prompt/response/query payloads exposed) applies the same
// way to this cache. The cache now stores ONLY: mailAccountId, canonical orgId, autoCaseId, and the
// PRECOMPUTED boolean isFreshAutoCaseStamp (== autoCaseMessageRef === lastMessageRef, computed once
// here from the real refs and never persisted) — everything the per-scope predicate
// (canReadConversationRowForScope) and the case-bucketing rule need, nothing PII-derived.
//
// Fix (round 3 adversarial review, 2026-09-29):
//   1. Round 2's compact row shape also kept `conversationId` on the theory that it was always an
//      opaque makeId() hash. That is false on the standalone/program-mail send path
//      (functions/chat-ai.ts's sendEmail: `data.conversationId = \`mail-${safeMessageSourceId(
//      bareRecipient)}\``) — a bare-recipient send with no explicit conversationId derives one
//      DIRECTLY from the recipient's email address (e.g. "jane@example.com" survives as
//      "mail-jane-example-com"), the exact PII-derived-doc-id shape round 2 already flagged for
//      autoCaseMessageRef/lastMessageRef. `conversationId` was never read by
//      canReadConversationRowForScope (it filters on row.orgId/row.mailAccountId only — see
//      conversationMailAccessScope.ts) or by bucketCompactRowsByCase (autoCaseId/
//      isFreshAutoCaseStamp only) — nothing downstream needs it, so it is removed from the compact
//      row shape entirely rather than hashed.
//   2. scanUnrepliedInboxForScope's candidate cap (functions/read.ts UNREPLIED_INBOX_MAX_LIMIT=200)
//      is GLOBAL across org rows ordered by lastInboundAtIso, not per scope. The prior fixed-iteration
//      design could therefore publish lower bounds (including false zeros) for a busy backlog.
//      The current implementation resumes the scanner cursor from a persisted checkpoint across
//      ticks and publishes exact snapshots only after traversal drains. The 200-row constant here
//      is a per-call work-unit size, never a total/display cap.
//
// Fix (round 4 adversarial review, 2026-09-29):
//   1. readCallerChatAutoCasebookPendingSnapshot let a STALE per-scope doc win unconditionally over
//      the shared row cache, even when the cache was fresher (e.g. this scope's own doc write failed
//      on a later tick — round 4's fix #2 below makes that a real, expected possibility under load —
//      while the SAME tick's row-cache write still succeeded). Callers kept seeing old counts despite
//      fresher, scope-filterable data sitting one doc read away. A stale primary now triggers the
//      same on-demand row-cache derivation a missing primary already used, and whichever result was
//      actually computed more recently wins — see readCallerChatAutoCasebookPendingSnapshot below.
//   2. directGrantOrgIds's per-member org resolution and writeChatAutoCasebookPendingSnapshots's
//      per-scope doc write were both fully sequential, unbounded loops — the ~3.14M reads/day figure
//      (index.ts) only ever bounded the scan itself, not these two loops. Enough direct grants or
//      configured orgs could exhaust the schedule's 300s budget before the run ever reached (or long
//      after badly delaying) the shared row-cache write every reader's fallback depends on. Now:
//        - Both loops run through runWithBoundedConcurrency (a small fixed-lane pool,
//          CHAT_AUTO_CASEBOOK_PENDING_POOL_CONCURRENCY=10 lanes) instead of one Firestore round trip
//          at a time.
//        - The row cache is written FIRST, immediately after the scan and before any per-scope work,
//          so it is already fresh (and available to fix #1's fallback) even if the per-scope loop
//          below is then cut short.
//        - A wall-clock deadline guard (CHAT_AUTO_CASEBOOK_PENDING_SCOPE_WRITE_DEADLINE_MS, 30s short
//          of the schedule's 300s timeoutSeconds) stops issuing NEW scope-doc writes once this tick
//          has run long; already-dispatched writes are left to finish, but no further scope in the
//          queue is started. Skipped scopes are collected and logged (never silently dropped) — their
//          callers keep resolving through fix #1's fresher-row-cache fallback until a later tick
//          catches up.
//
// Fix (exact pending counts, 2026-09-30): the old scan/display caps only yielded lower bounds for
// busy scopes. The schedule now folds each returned page into bounded per-scope counters, persists
// cursor + counters together in `_progress`, and publishes scope counts only after the traversal
// drains. Deadlines/errors preserve every last-complete scope doc; the next tick resumes its cursor.
// The compact `_row_cache` remains independently capped and is exact only when the full traversal
// fit in its 600-row bound; overflow is explicitly reported as a lower bound.
//
// Pending breakdown (2026-10-01, casebook inbox AGG lane): every scope also accumulates WHY a pending
// conversation is not a displayed case row, so the console can reconcile its headline total —
// pendingTotal === managed (Σ displayed-case byCaseId) + closedCaseCount (fresh stamp on an
// auto_close case, never a displayed row) + unclassifiedCount, where unclassifiedCount is split into
// never_classified / unknown_case / stale_stamp with that priority (each conversation counted
// exactly once — see classifyPendingRow). The split is derived from fields the compact row already
// carries (autoCaseId + the precomputed isFreshAutoCaseStamp boolean), so no new data is persisted
// per row. Docs/progress written before this change lack the breakdown fields; readers treat that as
// "unavailable" (never as zeros), and an in-flight pre-breakdown progress checkpoint is restarted so
// its aggregates are never published half-populated.
import { adminDb } from "./firebaseAdmin";
import { MAIL_ACCOUNT_ACCESS_FIELD, readMailRouting } from "./mailAccounts";
import {
  conversationRegistrationGateFilter,
  decodePageCursor,
  scanUnrepliedInboxForScope,
  type UnrepliedInboxScopeScanPolicy,
} from "./read";
import {
  canReadConversationRowForScope,
  resolveConversationMailAccessScope,
  type ConversationMailAccessScope,
} from "./conversationMailAccessScope";
import { CANONICAL_SCP_MAIL_ACCOUNT_ID, canonicalScpOrgId } from "./mailConversationAuthorization";
import { isChatAutoPermitCaseId, type ChatAutoPermitCaseId } from "./chatAutoCasePermit";
import { CHAT_CASEBOOK } from "./chatCasebook";
import { asString, type AuthContext } from "./shared";

export const CHAT_AUTO_CASEBOOK_PENDING_COLLECTION = "chat_auto_casebook_pending";
// Page size for each bounded scanUnrepliedInboxForScope work unit. This is not a total/display cap:
// exact per-scope counts continue over cursors until the queue drains.
export const CHAT_AUTO_CASEBOOK_PENDING_SCAN_LIMIT = 200;
export const CHAT_AUTO_CASEBOOK_PENDING_PROGRESS_DOC_ID = "_progress";
export const CHAT_AUTO_CASEBOOK_PENDING_ROW_CACHE_MAX_ROWS = 600;
// Round 4 adversarial review (2026-09-29): fixed-lane concurrency for the two previously fully
// sequential loops in this module — directGrantOrgIds's per-member org resolution and
// writeChatAutoCasebookPendingSnapshots's per-scope doc write (see runWithBoundedConcurrency below).
// 10 is an arbitrary-but-conservative choice: high enough to matter when either list grows past a
// handful of entries, low enough that it can never itself dominate the read/write budget documented
// above.
export const CHAT_AUTO_CASEBOOK_PENDING_POOL_CONCURRENCY = 10;
// 30s short of the schedule's 300s timeoutSeconds (chatAutoCasebookPendingPrecomputeSchedule,
// index.ts). This is the wall-clock budget for the complete scan, cache write, target discovery, and
// scope-write pipeline. The handler returns at the deadline, cooperative loops stop dispatching work,
// and monotonic transactions keep late in-flight writes from replacing data from a newer tick.
export const CHAT_AUTO_CASEBOOK_PENDING_SCOPE_WRITE_DEADLINE_MS = 270_000;
// UI contract: a snapshot older than this is shown with its own asOfIso ("마지막 계산 시각")
// rather than as a live number — the scheduled job runs every 15 minutes, so 45 minutes tolerates
// two missed ticks before the console calls it stale (still not an error state — see
// PendingHeadlineCard in src/app/(app)/chat/auto/page.tsx).
export const CHAT_AUTO_CASEBOOK_PENDING_STALE_AFTER_MS = 45 * 60 * 1000;
// Firestore's read-time query window is bounded. Restart a resumable traversal with a new snapshot
// before the one-hour REST readTime limit, leaving the last completed counts visible meanwhile.
export const CHAT_AUTO_CASEBOOK_PENDING_READ_TIME_MAX_AGE_MS = 55 * 60 * 1000;
export const CHAT_AUTO_CASEBOOK_PENDING_SUPER_ADMIN_SCOPE_KEY = "super_admin";
export const CHAT_AUTO_CASEBOOK_PENDING_NO_ORG_SCOPE_KEY = "no_resolved_org";
// Doc id for the shared per-tick row cache. Never collides with a real scope key — every real key
// is either the fixed "super_admin"/"no_resolved_org" or an "org:<id>" prefix, none of which starts
// with "_".
export const CHAT_AUTO_CASEBOOK_PENDING_ROW_CACHE_DOC_ID = "_row_cache";

async function writePendingSnapshotIfNewer(docId: string, doc: Record<string, unknown>): Promise<void> {
  const ref = adminDb.collection(CHAT_AUTO_CASEBOOK_PENDING_COLLECTION).doc(docId);
  await adminDb.runTransaction(async (transaction) => {
    const current = await transaction.get(ref);
    const currentIso = current.exists ? (current.data() as Record<string, unknown> | undefined)?.computedAtIso : null;
    const incomingIso = doc.computedAtIso;
    const currentMs = typeof currentIso === "string" ? Date.parse(currentIso) : Number.NaN;
    const incomingMs = typeof incomingIso === "string" ? Date.parse(incomingIso) : Number.NaN;
    if (Number.isFinite(currentMs) && Number.isFinite(incomingMs) && currentMs > incomingMs) return;
    transaction.set(ref, doc);
  });
}

export type ChatAutoCasebookPendingStatus = "fresh" | "stale" | "missing";

export type ChatAutoCasebookUnclassifiedReason = "never_classified" | "unknown_case" | "stale_stamp";
export const CHAT_AUTO_CASEBOOK_UNCLASSIFIED_REASONS: readonly ChatAutoCasebookUnclassifiedReason[] = [
  "never_classified",
  "unknown_case",
  "stale_stamp",
];
export type ChatAutoCasebookUnclassifiedByReason = Record<ChatAutoCasebookUnclassifiedReason, number>;
/** Why this scope's pending conversations are not displayed case rows (see the module doc comment). */
export type ChatAutoCasebookPendingBreakdown = {
  closedCaseCount: number;
  unclassifiedByReason: ChatAutoCasebookUnclassifiedByReason;
  /** Subset of never_classified whose newest inbound predates CHAT_AUTO_CASE_STAMP_LAUNCH_ISO — mail
   *  that could never have been stamped because the stamping code did not exist yet. null/undefined =
   *  unknown (a doc/row-cache written before this field shipped): never presented as 0. */
  neverClassifiedBeforeStampLaunch?: number | null;
};

/** Earliest `autoCaseClassifiedAtIso` observed in production (2026-10-01 read-only measurement): the
 *  moment chat-ai.ts started stamping conversations. A never_classified pending conversation whose
 *  last inbound is older than this is "legacy" — it arrived before stamping existed, not because a
 *  classification failed. Diagnostic only; it never changes which bucket a row is in. */
export const CHAT_AUTO_CASE_STAMP_LAUNCH_ISO = "2026-09-28T16:43:10.000Z";
const CHAT_AUTO_CASE_STAMP_LAUNCH_MS = Date.parse(CHAT_AUTO_CASE_STAMP_LAUNCH_ISO);

/** True when `lastInboundAtIso` is a valid timestamp strictly before the stamp launch. A missing or
 *  unparseable timestamp is false — an unknown date is never claimed to be legacy. */
export function isBeforeStampLaunch(lastInboundAtIso: unknown): boolean {
  if (typeof lastInboundAtIso !== "string") return false;
  const ms = Date.parse(lastInboundAtIso);
  return Number.isFinite(ms) && ms < CHAT_AUTO_CASE_STAMP_LAUNCH_MS;
}

export type ChatAutoCasebookPendingDoc = {
  scopeKey: string;
  pendingTotal: number;
  truncated: boolean;
  byCaseId: Record<string, number>;
  unclassifiedCount: number;
  /** Undefined on docs written before the breakdown shipped — readers report "unavailable". */
  breakdown?: ChatAutoCasebookPendingBreakdown;
  computedAtIso: string;
  /** True only when the complete traversal is represented by this count (including an untruncated shared cache). */
  exact: boolean;
  countStatus: "exact" | "lower_bound" | "unknown";
  asOfIso: string;
};

export type PendingCaseTotals = {
  totalPending: number;
  truncated: boolean;
  exact: boolean;
  countStatus: "exact" | "lower_bound" | "unknown";
  asOfIso: string | null;
  byCaseId: Map<ChatAutoPermitCaseId, number>;
  unclassifiedCount: number;
  /** Absent/undefined = the source doc predates the breakdown ("unavailable"). */
  breakdown?: ChatAutoCasebookPendingBreakdown;
};

export type ChatAutoCasebookPendingReadResult =
  | { status: "fresh"; data: ChatAutoCasebookPendingDoc }
  | { status: "stale"; data: ChatAutoCasebookPendingDoc }
  | { status: "missing"; data: null };

export type ChatAutoCasebookPendingScopeTarget = { scopeKey: string; access: ConversationMailAccessScope };

/**
 * The compact, PII-free row shape cached for on-demand per-scope derivation (2026-09-29 round 2
 * adversarial review, tightened round 3): only the fields canReadConversationRowForScope's
 * predicate and the autoCaseId bucketing rule actually need, computed once here and never
 * re-derivable back into anything PII-bearing. Deliberately EXCLUDES:
 *   - autoCaseMessageRef/lastMessageRef — Firestore reference strings derived from inbound email
 *     Message-ID headers (functions/chat-ai.ts persistReceivedEmail/mailImapIngest.ts) that can
 *     still carry a recognizable sender local-part/domain fragment even after
 *     safeMessageSourceId's doc-id character sanitization (e.g. "jane@example.com" survives as
 *     "jane-example-com").
 *   - conversationId (round 3 adversarial review, 2026-09-29) — round 2 kept this on the theory
 *     that a `conversations/{id}` doc id is always an opaque makeId() hash. That is false on the
 *     standalone/program-mail send path: functions/chat-ai.ts's sendEmail derives
 *     `mail-${safeMessageSourceId(bareRecipient)}` DIRECTLY from the recipient's email address when
 *     no conversationId is supplied, carrying the exact same PII-derived-doc-id shape as the refs
 *     above (e.g. "mail-jane-example-com"). Nothing downstream ever read it —
 *     canReadConversationRowForScope filters on row.orgId/row.mailAccountId only (see
 *     conversationMailAccessScope.ts), and bucketCompactRowsByCase keys on autoCaseId/
 *     isFreshAutoCaseStamp only — so it is removed rather than hashed.
 */
export type ChatAutoCasebookPendingCompactRow = {
  orgId: string | null;
  mailAccountId: string | null;
  autoCaseId: string | null;
  /** Precomputed once from the real (never-persisted) refs: autoCaseMessageRef === lastMessageRef —
   *  i.e. no newer inbound has arrived since chat-ai.ts classified this row into its case. */
  isFreshAutoCaseStamp: boolean;
  /** Precomputed from lastInboundAtIso (a boolean only — the timestamp itself is not persisted).
   *  Absent on row-cache docs written before this field shipped. */
  lastInboundBeforeStampLaunch?: boolean;
};

function superAdminAccess(): ConversationMailAccessScope {
  return {
    viewerOrgId: null,
    authorizedMailAccountIds: [CANONICAL_SCP_MAIL_ACCOUNT_ID],
    isSuperAdmin: true,
    hasScpEntitlement: true,
  };
}

function orgAccess(canonicalOrgId: string): ConversationMailAccessScope {
  return {
    viewerOrgId: canonicalOrgId,
    authorizedMailAccountIds: [CANONICAL_SCP_MAIL_ACCOUNT_ID],
    isSuperAdmin: false,
    hasScpEntitlement: true,
  };
}

function noOrgAccess(): ConversationMailAccessScope {
  return {
    viewerOrgId: null,
    authorizedMailAccountIds: [CANONICAL_SCP_MAIL_ACCOUNT_ID],
    isSuperAdmin: false,
    hasScpEntitlement: true,
  };
}

/** Deterministic scope key for a resolved access — used both to pick which precomputed doc to read
 *  and to label a doc the scheduled job writes. Kept as the single source of truth so the writer
 *  and reader can never drift apart. */
function scopeKeyForAccess(access: ConversationMailAccessScope): string {
  if (access.isSuperAdmin) return CHAT_AUTO_CASEBOOK_PENDING_SUPER_ADMIN_SCOPE_KEY;
  if (!access.hasScpEntitlement) return "no_scp_grant";
  return access.viewerOrgId
    ? `org:${canonicalScpOrgId(access.viewerOrgId)}`
    : CHAT_AUTO_CASEBOOK_PENDING_NO_ORG_SCOPE_KEY;
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight at once (round 4 adversarial
 * review, 2026-09-29) — replaces two previously fully-sequential loops in this module:
 * directGrantOrgIds's per-member org resolution and writeChatAutoCasebookPendingSnapshots's
 * per-scope doc write. A fixed number of lanes each pull the next item until the list is exhausted.
 * `worker` is responsible for catching its own per-item errors (both call sites already do this) —
 * this pool never lets one item's rejection stop the other lanes or the pool as a whole.
 */
async function runWithBoundedConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  let nextIndex = 0;
  async function lane(): Promise<void> {
    for (;;) {
      if (!shouldContinue()) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }
  const laneCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: laneCount }, () => lane()));
}

type DirectGrantMember = { role: string; email: string; userId: string };

async function defaultReadDirectGrantMembers(): Promise<DirectGrantMember[]> {
  const snapshot = await adminDb
    .collection("members")
    .where(MAIL_ACCOUNT_ACCESS_FIELD, "array-contains", CANONICAL_SCP_MAIL_ACCOUNT_ID)
    .get();
  return snapshot.docs.map((doc) => {
    const data = (doc.data() ?? {}) as Record<string, unknown>;
    return {
      role: typeof data.role === "string" ? data.role : "viewer",
      email: typeof data.email === "string" ? data.email : "",
      userId: doc.id,
    };
  });
}

/**
 * Org ids resolved from members holding a DIRECT scp grant (mailAccountIds array-contains "scp" on
 * their own `members/{uid}` doc — functions/mailAccounts.ts's per-user entitlement path, independent
 * of settings/mail_routing.scpAllowedOrgIds). This is what round 1 of this precompute missed
 * entirely (codex adversarial review, 2026-09-29): a direct grant is a valid, real entitlement path
 * (isCallerScpEntitled/assertScpEntitled honor it), so those members' own scopes must be precomputed
 * too, not just the configured-org set. A super_admin member is skipped — resolveCallerPendingAccess
 * below short-circuits any super_admin caller to the "super_admin" scope before ever resolving a
 * per-user grant, so a super_admin's own org (if any) is never looked up here. Bounded cost: direct
 * grants are a rare, explicit exception path (not general org membership), so this list and the
 * Peoply lookups below are expected to be small (single digits) — see the module doc comment for the
 * full per-tick cost accounting. Round 4 adversarial review (2026-09-29): resolved with bounded
 * concurrency (CHAT_AUTO_CASEBOOK_PENDING_POOL_CONCURRENCY lanes via runWithBoundedConcurrency)
 * instead of one Peoply round trip at a time — this list is normally tiny, but nothing previously
 * bounded it, so a larger list could have quietly eaten into the schedule's 300s budget one lookup
 * at a time.
 */
export async function directGrantOrgIds(
  deps: { readMembers?: () => Promise<DirectGrantMember[]> } = {},
  shouldContinue: () => boolean = () => true,
): Promise<string[]> {
  if (!shouldContinue()) return [];
  const members = await (deps.readMembers ?? defaultReadDirectGrantMembers)();
  if (!shouldContinue()) return [];
  const candidates = members.filter((member) => member.role !== "super_admin" && Boolean(member.email));
  const orgIds: string[] = [];
  await runWithBoundedConcurrency(candidates, CHAT_AUTO_CASEBOOK_PENDING_POOL_CONCURRENCY, async (member) => {
    try {
      const scope = await resolveConversationMailAccessScope({
        role: member.role as Parameters<typeof resolveConversationMailAccessScope>[0]["role"],
        email: member.email,
        userId: member.userId,
      });
      if (!scope.isSuperAdmin && scope.viewerOrgId) orgIds.push(canonicalScpOrgId(scope.viewerOrgId));
    } catch (error) {
      // A single member's org resolution failing (Peoply hiccup) must not block enumerating the
      // rest — that member simply falls back to the no_resolved_org bucket or the shared row-cache
      // on-demand derivation (see the module doc comment) instead of getting their own fast doc.
      console.error("[chatAutoCasebookPendingPrecompute] resolving a direct-grant member's org failed — falls back to no_resolved_org/on-demand derivation", {
        memberDocId: member.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, shouldContinue);
  return orgIds;
}

/**
 * The full set of {scopeKey, access} targets the scheduled precompute writes one doc each for:
 * super_admin, no_resolved_org (shared by every entitled-but-org-unresolved caller), and one per
 * canonicalized org from EITHER settings/mail_routing.scpAllowedOrgIds (or, when that is
 * unconfigured/null — fail-open per mailAccounts.ts's isScpAssignedToOrg doctrine — the orgs mapped
 * to the canonical scp account in mail_routing.byOrgId) OR a member's direct scp grant
 * (directGrantOrgIds above). A readMailRouting/direct-grant enumeration failure degrades gracefully
 * (logs and continues with whatever DID resolve) rather than failing the whole precompute run — any
 * org missed here still gets a correct on-demand answer via the shared row-cache fallback
 * (deriveFromSharedRowCache below), just not the fast per-scope doc.
 */
export async function chatAutoCasebookPendingScopeTargets(
  deps: {
    readRouting?: typeof readMailRouting;
    directGrantOrgIds?: typeof directGrantOrgIds;
  } = {},
  shouldContinue: () => boolean = () => true,
): Promise<ChatAutoCasebookPendingScopeTarget[]> {
  const targets: ChatAutoCasebookPendingScopeTarget[] = [
    { scopeKey: CHAT_AUTO_CASEBOOK_PENDING_SUPER_ADMIN_SCOPE_KEY, access: superAdminAccess() },
    { scopeKey: CHAT_AUTO_CASEBOOK_PENDING_NO_ORG_SCOPE_KEY, access: noOrgAccess() },
  ];

  let configuredOrgIds: string[] = [];
  try {
    if (!shouldContinue()) return targets;
    const routing = await (deps.readRouting ?? readMailRouting)();
    const rawOrgIds = Array.isArray(routing.scpAllowedOrgIds) && routing.scpAllowedOrgIds.length > 0
      ? routing.scpAllowedOrgIds
      : Object.entries(routing.byOrgId)
          .filter(([, accountId]) => accountId === CANONICAL_SCP_MAIL_ACCOUNT_ID)
          .map(([orgId]) => orgId);
    configuredOrgIds = rawOrgIds.map((orgId) => canonicalScpOrgId(orgId)).filter((orgId) => orgId.length > 0);
  } catch (error) {
    console.error("[chatAutoCasebookPendingPrecompute] readMailRouting failed — configured-org enumeration skipped this tick", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let grantedOrgIds: string[] = [];
  try {
    if (!shouldContinue()) return targets;
    grantedOrgIds = await (deps.directGrantOrgIds ?? directGrantOrgIds)({}, shouldContinue);
  } catch (error) {
    console.error("[chatAutoCasebookPendingPrecompute] direct-grant org enumeration failed — those members fall back to on-demand derivation", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const canonicalOrgIds = [...new Set([...configuredOrgIds, ...grantedOrgIds])];
  for (const orgId of canonicalOrgIds) targets.push({ scopeKey: `org:${orgId}`, access: orgAccess(orgId) });
  return targets;
}

// 2026-09-29 round 2 adversarial review: autoCaseMessageRef/lastMessageRef (raw Firestore reference
// strings, PII-derived — see ChatAutoCasebookPendingCompactRow's own doc comment) are read here from
// the full scanned row and compared IMMEDIATELY, in memory — the comparison result
// (isFreshAutoCaseStamp) is all that ever reaches the compact row / the cached doc. The two ref
// strings themselves are discarded at the end of this function call and never persisted anywhere.
export function toCompactRow(row: Record<string, unknown>): ChatAutoCasebookPendingCompactRow {
  const autoCaseMessageRef = typeof row.autoCaseMessageRef === "string" ? row.autoCaseMessageRef : null;
  const lastMessageRef = typeof row.lastMessageRef === "string" ? row.lastMessageRef : null;
  return {
    orgId: typeof row.orgId === "string" ? row.orgId : null,
    mailAccountId: typeof row.mailAccountId === "string" ? row.mailAccountId : null,
    autoCaseId: typeof row.autoCaseId === "string" ? row.autoCaseId : null,
    isFreshAutoCaseStamp: Boolean(autoCaseMessageRef) && autoCaseMessageRef === lastMessageRef,
    lastInboundBeforeStampLaunch: isBeforeStampLaunch(row.lastInboundAtIso),
  };
}

const AUTO_CLOSE_CASE_IDS: ReadonlySet<string> = new Set(
  CHAT_CASEBOOK.filter((item) => item.escalation === "auto_close").map((item) => item.id),
);

export function emptyUnclassifiedByReason(): ChatAutoCasebookUnclassifiedByReason {
  return { never_classified: 0, unknown_case: 0, stale_stamp: 0 };
}

export type ChatAutoCasebookPendingRowBucket =
  | { kind: "managed"; caseId: ChatAutoPermitCaseId }
  | { kind: "closed" }
  | { kind: "unclassified"; reason: ChatAutoCasebookUnclassifiedReason };

/**
 * The single place that decides which bucket one pending conversation belongs to — every consumer
 * (per-tick counters, on-demand row-cache derivation, the live unclassified list callable) calls this
 * so the counts and the list can never disagree. Each row lands in exactly ONE bucket; unclassified
 * reasons are checked in priority order never_classified > unknown_case > stale_stamp:
 *   - never_classified: no autoCaseId on the conversation at all
 *   - unknown_case: autoCaseId present but not a known casebook case id
 *   - stale_stamp: known case id, but autoCaseMessageRef is missing or !== lastMessageRef (a newer
 *     inbound arrived after chat-ai.ts classified the thread)
 *   - closed: fresh stamp on an auto_close case (thread is closed by casebook design, no displayed row)
 *   - managed: fresh stamp on any other known case (a displayed row)
 */
export function classifyPendingRow(
  row: Pick<ChatAutoCasebookPendingCompactRow, "autoCaseId" | "isFreshAutoCaseStamp">,
): ChatAutoCasebookPendingRowBucket {
  if (!row.autoCaseId) return { kind: "unclassified", reason: "never_classified" };
  if (!isChatAutoPermitCaseId(row.autoCaseId)) return { kind: "unclassified", reason: "unknown_case" };
  if (!row.isFreshAutoCaseStamp) return { kind: "unclassified", reason: "stale_stamp" };
  return AUTO_CLOSE_CASE_IDS.has(row.autoCaseId) ? { kind: "closed" } : { kind: "managed", caseId: row.autoCaseId };
}

/**
 * Groups rows by the autoCaseId chat-ai.ts stamps on every classified inbound (functions/chat-ai.ts
 * persistReceivedEmail) via classifyPendingRow above — a row only counts toward a case when
 * isFreshAutoCaseStamp is true (no newer inbound has arrived since classification — see toCompactRow
 * above for how that boolean is derived from the real, never-persisted refs); everything else falls
 * into unclassifiedCount (split by reason) or, for fresh auto_close stamps, closedCaseCount.
 * Pure/in-memory — shared by both the per-tick precompute and the on-demand shared-row-cache
 * derivation.
 */
function bucketCompactRowsByCase(rows: readonly ChatAutoCasebookPendingCompactRow[]): {
  byCaseId: Map<ChatAutoPermitCaseId, number>;
  unclassifiedCount: number;
  breakdown: ChatAutoCasebookPendingBreakdown;
} {
  const byCaseId = new Map<ChatAutoPermitCaseId, number>();
  const breakdown: ChatAutoCasebookPendingBreakdown = { closedCaseCount: 0, unclassifiedByReason: emptyUnclassifiedByReason() };
  let unclassifiedCount = 0;
  let neverClassifiedBeforeLaunch = 0;
  // A row-cache doc written before the launch flag existed cannot say how many rows are legacy.
  let launchSplitKnown = true;
  for (const row of rows) {
    const bucket = classifyPendingRow(row);
    if (bucket.kind === "managed") byCaseId.set(bucket.caseId, (byCaseId.get(bucket.caseId) ?? 0) + 1);
    else if (bucket.kind === "closed") breakdown.closedCaseCount += 1;
    else {
      unclassifiedCount += 1;
      breakdown.unclassifiedByReason[bucket.reason] += 1;
      if (bucket.reason === "never_classified") {
        if (typeof row.lastInboundBeforeStampLaunch !== "boolean") launchSplitKnown = false;
        else if (row.lastInboundBeforeStampLaunch) neverClassifiedBeforeLaunch += 1;
      }
    }
  }
  breakdown.neverClassifiedBeforeStampLaunch = launchSplitKnown ? neverClassifiedBeforeLaunch : null;
  return { byCaseId, unclassifiedCount, breakdown };
}

/**
 * Derives one scope's totals from compact rows by re-applying the conversation-read predicate. This
 * is used for the bounded shared-row-cache fallback; exact scheduled snapshots are accumulated page
 * by page by countPendingPage. Propagate truncation so fallback data is never presented as exact.
 */
export function deriveChatAutoCasebookPendingTotalsForScope(
  rows: readonly ChatAutoCasebookPendingCompactRow[],
  access: ConversationMailAccessScope,
  scanTruncated: boolean,
): PendingCaseTotals {
  const visible = rows.filter((row) => canReadConversationRowForScope(row, access, CANONICAL_SCP_MAIL_ACCOUNT_ID));
  const { byCaseId, unclassifiedCount, breakdown } = bucketCompactRowsByCase(visible);
  return {
    totalPending: visible.length,
    truncated: scanTruncated,
    exact: false,
    countStatus: scanTruncated ? "lower_bound" : "unknown",
    asOfIso: null,
    byCaseId,
    unclassifiedCount,
    breakdown,
  };
}

type ScopePendingAggregate = {
  pendingTotal: number;
  byCaseId: Record<string, number>;
  unclassifiedCount: number;
  /** Absent on aggregates checkpointed before the breakdown shipped (see breakdownVersion below). */
  closedCaseCount?: number;
  unclassifiedByReason?: ChatAutoCasebookUnclassifiedByReason;
  /** Absent on a checkpoint folded before this counter existed — published as null (unknown). */
  neverClassifiedBeforeStampLaunch?: number;
};
type PendingSnapshotReadTime = { seconds: number; nanoseconds: number };
type PendingPrecomputeProgress = {
  version: 1;
  /** 1 once every scope aggregate tracks closedCaseCount/unclassifiedByReason. A checkpoint without
   *  it was folded by the pre-breakdown code and is restarted, never resumed (its aggregates would
   *  publish a breakdown that silently misses the already-folded pages). */
  breakdownVersion?: 1;
  status: "in_progress" | "error" | "publishing" | "complete";
  scanStartedAtIso: string;
  /** Publication time for freshness; the fixed Firestore point-in-time is stored separately. */
  completedAtIso?: string;
  snapshotReadTime: PendingSnapshotReadTime | null;
  scanPolicy: UnrepliedInboxScopeScanPolicy | null;
  updatedAtIso: string;
  cursor: { docId: string; orderValue: string } | null;
  targets: ChatAutoCasebookPendingScopeTarget[];
  countsByScope: Record<string, ScopePendingAggregate>;
  rowCacheRows: ChatAutoCasebookPendingCompactRow[];
  rowCacheOverflow: boolean;
  errorMessage?: string;
};

function emptyScopeAggregate(): ScopePendingAggregate {
  return { pendingTotal: 0, byCaseId: {}, unclassifiedCount: 0, closedCaseCount: 0, unclassifiedByReason: emptyUnclassifiedByReason(), neverClassifiedBeforeStampLaunch: 0 };
}

function pendingReadTimeIso(readTime: PendingSnapshotReadTime | null): string | null {
  return readTime
    ? new Date(readTime.seconds * 1000 + readTime.nanoseconds / 1_000_000).toISOString()
    : null;
}

function scopeTargetsSignature(targets: readonly ChatAutoCasebookPendingScopeTarget[]): string {
  return JSON.stringify(targets.map(({ scopeKey, access }) => ({
    scopeKey,
    access: {
      viewerOrgId: access.viewerOrgId,
      authorizedMailAccountIds: [...access.authorizedMailAccountIds].sort(),
      isSuperAdmin: access.isSuperAdmin,
      hasScpEntitlement: access.hasScpEntitlement,
    },
  })).sort((left, right) => left.scopeKey.localeCompare(right.scopeKey)));
}

function makeProgress(nowIso: string, targets: ChatAutoCasebookPendingScopeTarget[]): PendingPrecomputeProgress {
  return {
    version: 1,
    breakdownVersion: 1,
    status: "in_progress",
    scanStartedAtIso: nowIso,
    updatedAtIso: nowIso,
    snapshotReadTime: null,
    scanPolicy: null,
    cursor: null,
    targets,
    countsByScope: Object.fromEntries(targets.map((target) => [target.scopeKey, emptyScopeAggregate()])),
    rowCacheRows: [],
    rowCacheOverflow: false,
  };
}

function asPendingProgress(value: unknown): PendingPrecomputeProgress | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PendingPrecomputeProgress>;
  if (raw.version !== 1 || !Array.isArray(raw.targets) || !raw.countsByScope || typeof raw.countsByScope !== "object") return null;
  if (raw.status !== "in_progress" && raw.status !== "error" && raw.status !== "publishing") return null;
  if (raw.cursor !== null && (!raw.cursor || typeof raw.cursor.docId !== "string" || typeof raw.cursor.orderValue !== "string")) return null;
  const readTime = raw.snapshotReadTime;
  const snapshotReadTime = readTime && Number.isInteger(readTime.seconds) && Number.isInteger(readTime.nanoseconds)
    && readTime.seconds >= 0 && readTime.nanoseconds >= 0 && readTime.nanoseconds < 1_000_000_000
    ? { seconds: readTime.seconds, nanoseconds: readTime.nanoseconds }
    : null;
  const policy = raw.scanPolicy;
  const scanPolicy = policy && Array.isArray(policy.disabledOrgIds)
    && policy.disabledOrgIds.every((orgId) => typeof orgId === "string")
    && policy.mailRoutingByOrgId && typeof policy.mailRoutingByOrgId === "object"
      ? {
          disabledOrgIds: [...policy.disabledOrgIds],
          mailRoutingByOrgId: { ...policy.mailRoutingByOrgId },
        }
      : null;
  return {
    version: 1,
    ...(raw.breakdownVersion === 1 ? { breakdownVersion: 1 as const } : {}),
    status: raw.status,
    scanStartedAtIso: typeof raw.scanStartedAtIso === "string" ? raw.scanStartedAtIso : new Date().toISOString(),
    updatedAtIso: typeof raw.updatedAtIso === "string" ? raw.updatedAtIso : new Date().toISOString(),
    snapshotReadTime,
    scanPolicy,
    cursor: raw.cursor ?? null,
    targets: raw.targets as ChatAutoCasebookPendingScopeTarget[],
    countsByScope: raw.countsByScope as Record<string, ScopePendingAggregate>,
    rowCacheRows: Array.isArray(raw.rowCacheRows) ? raw.rowCacheRows.slice(0, CHAT_AUTO_CASEBOOK_PENDING_ROW_CACHE_MAX_ROWS) : [],
    rowCacheOverflow: raw.rowCacheOverflow === true,
    ...(typeof raw.errorMessage === "string" ? { errorMessage: raw.errorMessage } : {}),
  };
}

function countPendingPage(
  rows: readonly Record<string, unknown>[],
  targets: readonly ChatAutoCasebookPendingScopeTarget[],
  countsByScope: Record<string, ScopePendingAggregate>,
): ChatAutoCasebookPendingCompactRow[] {
  const compactRows = rows.map(toCompactRow);
  for (const compact of compactRows) {
    for (const target of targets) {
      if (!canReadConversationRowForScope(compact, target.access, CANONICAL_SCP_MAIL_ACCOUNT_ID)) continue;
      const counts = countsByScope[target.scopeKey] ?? (countsByScope[target.scopeKey] = emptyScopeAggregate());
      counts.pendingTotal += 1;
      const bucket = classifyPendingRow(compact);
      if (bucket.kind === "managed") {
        counts.byCaseId[bucket.caseId] = (counts.byCaseId[bucket.caseId] ?? 0) + 1;
      } else if (bucket.kind === "closed") {
        counts.closedCaseCount = (counts.closedCaseCount ?? 0) + 1;
      } else {
        counts.unclassifiedCount += 1;
        const byReason = counts.unclassifiedByReason ?? (counts.unclassifiedByReason = emptyUnclassifiedByReason());
        byReason[bucket.reason] += 1;
        if (
          bucket.reason === "never_classified"
          && compact.lastInboundBeforeStampLaunch === true
          && counts.neverClassifiedBeforeStampLaunch !== undefined
        ) {
          counts.neverClassifiedBeforeStampLaunch += 1;
        }
      }
    }
  }
  return compactRows;
}

/** Background exact count refresh. Pages are folded into a small per-scope aggregate immediately;
 * no full message/row set is retained. Each scanner call can read up to 900 conversation docs plus
 * 200 manual-reply probes × 50 message-source docs (about 10,900 reads); the 270s invocation budget
 * is the total work bound, and `_progress` checkpoints cursor + aggregates so later ticks can finish
 * larger queues. Per-scope snapshots and the separately bounded compact row cache are written only
 * after the scan drains. A failed or interrupted traversal leaves last-complete scope snapshots intact. */
export async function writeChatAutoCasebookPendingSnapshots(
  deps: {
    now?: () => Date;
    /** Wall-clock reader for the deadline guard ONLY — independent of `now` above (which stamps
     *  computedAtIso and, in tests, is typically fixed). Defaults to Date.now. */
    nowMs?: () => number;
    /** Total wall-clock budget for the full pipeline: scan, target discovery, row-cache write, and
     *  per-scope writes. Defaults to the 270s production guard below; tests inject tiny values. */
    deadlineMs?: number;
    scan?: typeof scanUnrepliedInboxForScope;
    scopeTargets?: typeof chatAutoCasebookPendingScopeTargets;
    writeDoc?: (docId: string, doc: Record<string, unknown>) => Promise<void>;
    readProgress?: () => Promise<unknown>;
  } = {},
): Promise<{
  ok: true;
  scopeKeys: string[];
  failed: string[];
  skipped: string[];
  rowCacheWritten: boolean;
  deadlineExceeded: boolean;
}> {
  const nowMs = deps.nowMs ?? Date.now;
  const startMs = nowMs();
  const deadlineMs = deps.deadlineMs ?? CHAT_AUTO_CASEBOOK_PENDING_SCOPE_WRITE_DEADLINE_MS;
  let deadlineExceeded = false;
  let resolveDeadline!: () => void;
  const deadlineReached = new Promise<void>((resolve) => { resolveDeadline = resolve; });
  const timer = setTimeout(() => {
    deadlineExceeded = true;
    resolveDeadline();
  }, Math.max(0, deadlineMs));
  const hasDeadlineExpired = (): boolean => {
    if (deadlineExceeded || nowMs() - startMs >= deadlineMs) {
      deadlineExceeded = true;
      resolveDeadline();
      return true;
    }
    return false;
  };
  const raceStage = async <T>(work: Promise<T>): Promise<{ timedOut: true } | { timedOut: false; value: T }> => {
    if (hasDeadlineExpired()) return { timedOut: true };
    return Promise.race([
      work.then((value) => ({ timedOut: false as const, value })),
      deadlineReached.then(() => ({ timedOut: true as const })),
    ]);
  };
  const raceStartedStage = async <T>(work: Promise<T>): Promise<{ timedOut: true } | { timedOut: false; value: T }> => Promise.race([
    work.then((value) => ({ timedOut: false as const, value })),
    deadlineReached.then(() => ({ timedOut: true as const })),
  ]);
  const markDeadlineExceeded = (): void => {
    deadlineExceeded = true;
    resolveDeadline();
  };
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const writeDoc = deps.writeDoc ?? writePendingSnapshotIfNewer;
  const readProgress = deps.readProgress ?? (deps.writeDoc ? async () => null : async () => {
    const snapshot = await adminDb.collection(CHAT_AUTO_CASEBOOK_PENDING_COLLECTION).doc(CHAT_AUTO_CASEBOOK_PENDING_PROGRESS_DOC_ID).get();
    return snapshot.exists ? snapshot.data() : null;
  });
  let progress: PendingPrecomputeProgress | null = null;

  const saveProgress = async (next: PendingPrecomputeProgress): Promise<void> => {
    next.updatedAtIso = (deps.now?.() ?? new Date()).toISOString();
    await writeDoc(CHAT_AUTO_CASEBOOK_PENDING_PROGRESS_DOC_ID, { ...next, computedAtIso: next.scanStartedAtIso });
    progress = next;
  };

  try {
    const targetResult = await raceStage((deps.scopeTargets ?? chatAutoCasebookPendingScopeTargets)(undefined, () => !hasDeadlineExpired()));
    if (targetResult.timedOut || hasDeadlineExpired()) {
      markDeadlineExceeded();
      console.error("[chatAutoCasebookPendingPrecompute] stopped during scope target discovery — last complete counts are unchanged");
      return {
        ok: true,
        scopeKeys: [],
        failed: [],
        skipped: [],
        rowCacheWritten: false,
        deadlineExceeded,
      };
    }
    const targets = targetResult.value;
    const existing = asPendingProgress(await readProgress());
    const targetsSignature = scopeTargetsSignature(targets);
    const existingTargetsSignature = existing ? scopeTargetsSignature(existing.targets) : "";
    const existingReadTimeMs = existing?.snapshotReadTime
      ? existing.snapshotReadTime.seconds * 1000 + existing.snapshotReadTime.nanoseconds / 1_000_000
      : Number.NaN;
    const readTimeAgeMs = (deps.now?.() ?? new Date()).getTime() - existingReadTimeMs;
    const readTimeReusable = Boolean(existing?.snapshotReadTime)
      && (existing?.status === "publishing" || Boolean(existing?.scanPolicy))
      && (existing?.status === "publishing" || (readTimeAgeMs >= -60_000 && readTimeAgeMs <= CHAT_AUTO_CASEBOOK_PENDING_READ_TIME_MAX_AGE_MS));
    progress = existing && existing.status !== "complete" && readTimeReusable
      && existing.breakdownVersion === 1
      && targetsSignature === existingTargetsSignature
      ? existing
      : makeProgress(nowIso, targets);
    if (progress.status !== "publishing") {
      progress.status = "in_progress";
      delete progress.errorMessage;
      const initialProgressSave = await raceStage(saveProgress(progress));
      if (initialProgressSave.timedOut) {
        markDeadlineExceeded();
        return { ok: true, scopeKeys: [], failed: [], skipped: targets.map((target) => target.scopeKey), rowCacheWritten: false, deadlineExceeded };
      }
    }

    const scan = deps.scan ?? scanUnrepliedInboxForScope;
    const registrationGate = conversationRegistrationGateFilter("super_admin", false);
    let scanComplete = progress.status === "publishing";
    while (!scanComplete && !hasDeadlineExpired()) {
      const pageResult = await raceStartedStage(scan({
        access: superAdminAccess(),
        mailAccountId: CANONICAL_SCP_MAIL_ACCOUNT_ID,
        limit: CHAT_AUTO_CASEBOOK_PENDING_SCAN_LIMIT,
        cursor: progress.cursor,
        readTime: progress.snapshotReadTime ?? undefined,
        policy: progress.scanPolicy ?? undefined,
        policyFailureMode: "fail_closed",
        registrationGate,
        shouldContinue: () => !hasDeadlineExpired(),
      }));
      if (pageResult.timedOut) break;
      const page = pageResult.value;
      const pageReadTime = page.readTime;
      const pageReadTimeMatches = pageReadTime
        && (!progress.snapshotReadTime
          || (pageReadTime.seconds === progress.snapshotReadTime.seconds
            && pageReadTime.nanoseconds === progress.snapshotReadTime.nanoseconds));
      const pagePolicy = page.policy;
      const pagePolicyMatches = pagePolicy
        && (!progress.scanPolicy || JSON.stringify(pagePolicy) === JSON.stringify(progress.scanPolicy));
      if (!pageReadTimeMatches || !pagePolicyMatches) {
        progress = makeProgress(nowIso, targets);
        progress.status = "error";
        progress.errorMessage = !pageReadTimeMatches
          ? "scan omitted or changed its fixed Firestore readTime"
          : "scan omitted or changed its frozen eligibility policy";
        await saveProgress(progress);
        console.error("[chatAutoCasebookPendingPrecompute] cannot publish exact counts — scanner did not preserve its readTime and eligibility policy");
        return { ok: true, scopeKeys: [], failed: [], skipped: targets.map((target) => target.scopeKey), rowCacheWritten: false, deadlineExceeded };
      }
      progress.snapshotReadTime = {
        seconds: pageReadTime.seconds,
        nanoseconds: pageReadTime.nanoseconds,
      };
      progress.scanPolicy = {
        disabledOrgIds: [...pagePolicy.disabledOrgIds],
        mailRoutingByOrgId: { ...pagePolicy.mailRoutingByOrgId },
      };
      const nextCursor = page.nextCursor ? decodePageCursor(page.nextCursor) : null;
      const hasMore = page.truncated || Boolean(page.nextCursor);
      if (hasMore && !nextCursor) {
        progress.status = "error";
        progress.errorMessage = "scan reported more rows without a resumable cursor";
        await saveProgress(progress);
        console.error("[chatAutoCasebookPendingPrecompute] cannot publish exact counts — incomplete scan did not return a resumable cursor");
        return { ok: true, scopeKeys: [], failed: [], skipped: targets.map((target) => target.scopeKey), rowCacheWritten: false, deadlineExceeded };
      }
      const compactRows = countPendingPage(page.rows, progress.targets, progress.countsByScope);
      for (const compact of compactRows) {
        if (progress.rowCacheRows.length < CHAT_AUTO_CASEBOOK_PENDING_ROW_CACHE_MAX_ROWS) progress.rowCacheRows.push(compact);
        else progress.rowCacheOverflow = true;
      }
      if (hasMore) {
        const cursor = { docId: nextCursor!.docId, orderValue: asString(nextCursor!.orderValue, "") };
        if (progress.cursor?.docId === cursor.docId && progress.cursor.orderValue === cursor.orderValue) {
          progress.status = "error";
          progress.errorMessage = "scan cursor did not advance";
          await saveProgress(progress);
          console.error("[chatAutoCasebookPendingPrecompute] cannot publish exact counts — scan cursor did not advance");
          return { ok: true, scopeKeys: [], failed: [], skipped: targets.map((target) => target.scopeKey), rowCacheWritten: false, deadlineExceeded };
        }
        progress.cursor = cursor;
      } else {
        progress.cursor = null;
        progress.status = "publishing";
        progress.completedAtIso = (deps.now?.() ?? new Date()).toISOString();
        scanComplete = true;
      }
      // Cursor and every scope's delta are saved in the same single-document write. A failed write
      // leaves the prior cursor in place, so replaying this page cannot publish a double count.
      await saveProgress(progress);
    }
    if (!scanComplete) {
      if (!deadlineExceeded) markDeadlineExceeded();
      progress.status = "in_progress";
      await saveProgress(progress).catch((error) => console.error("[chatAutoCasebookPendingPrecompute] could not persist scan checkpoint", {
        error: error instanceof Error ? error.message : String(error),
      }));
      return { ok: true, scopeKeys: [], failed: [], skipped: targets.map((target) => target.scopeKey), rowCacheWritten: false, deadlineExceeded };
    }
    if (hasDeadlineExpired()) {
      markDeadlineExceeded();
      return { ok: true, scopeKeys: [], failed: [], skipped: targets.map((target) => target.scopeKey), rowCacheWritten: false, deadlineExceeded };
    }

    const completedAtIso = progress.completedAtIso ?? (deps.now?.() ?? new Date()).toISOString();
    const asOfIso = pendingReadTimeIso(progress.snapshotReadTime);
    if (!asOfIso) throw new Error("completed scan is missing its fixed Firestore readTime");
    let rowCacheWritten = false;
    try {
      const cacheResult = await raceStage(writeDoc(CHAT_AUTO_CASEBOOK_PENDING_ROW_CACHE_DOC_ID, {
        rows: progress.rowCacheRows,
        truncated: progress.rowCacheOverflow,
        exact: !progress.rowCacheOverflow,
        countStatus: progress.rowCacheOverflow ? "lower_bound" : "exact",
        computedAtIso: completedAtIso,
        asOfIso,
      }));
      if (cacheResult.timedOut) markDeadlineExceeded();
      else rowCacheWritten = true;
    } catch (error) {
      console.error("[chatAutoCasebookPendingPrecompute] failed to write the bounded shared row cache", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (hasDeadlineExpired()) markDeadlineExceeded();

    const scopeKeys: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    const scopeWrites = runWithBoundedConcurrency(progress.targets, CHAT_AUTO_CASEBOOK_PENDING_POOL_CONCURRENCY, async (target) => {
      if (hasDeadlineExpired()) {
        markDeadlineExceeded();
        skipped.push(target.scopeKey);
        console.error("[chatAutoCasebookPendingPrecompute] skipped a scope's write — this tick's deadline guard was reached; its callers fall back to the (already-written) shared row cache until a later tick catches up", {
          scopeKey: target.scopeKey,
        });
        return;
      }
      try {
        const totals = progress!.countsByScope[target.scopeKey] ?? emptyScopeAggregate();
        const doc: ChatAutoCasebookPendingDoc = {
          scopeKey: target.scopeKey,
          pendingTotal: totals.pendingTotal,
          truncated: false,
          byCaseId: totals.byCaseId,
          unclassifiedCount: totals.unclassifiedCount,
          breakdown: {
            closedCaseCount: totals.closedCaseCount ?? 0,
            unclassifiedByReason: { ...emptyUnclassifiedByReason(), ...totals.unclassifiedByReason },
            neverClassifiedBeforeStampLaunch: totals.neverClassifiedBeforeStampLaunch ?? null,
          },
          computedAtIso: completedAtIso,
          exact: true,
          countStatus: "exact",
          asOfIso,
        };
        await writeDoc(target.scopeKey, doc);
        scopeKeys.push(target.scopeKey);
      } catch (error) {
        failed.push(target.scopeKey);
        console.error("[chatAutoCasebookPendingPrecompute] failed to derive/write pending snapshot for scope", {
          scopeKey: target.scopeKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, () => !hasDeadlineExpired());
    const scopeWriteResult = await raceStage(scopeWrites);
    if (scopeWriteResult.timedOut) markDeadlineExceeded();
    if (deadlineExceeded) {
      const accounted = new Set([...scopeKeys, ...failed, ...skipped]);
      for (const target of progress.targets) {
        if (!accounted.has(target.scopeKey)) skipped.push(target.scopeKey);
      }
    }

    // A completed traversal stays in `publishing` until every exact scope doc has been written.
    // A later tick can retry these idempotent writes without replaying the already-counted scan.
    progress.status = failed.length === 0 && skipped.length === 0 ? "complete" : "publishing";
    progress.errorMessage = failed.length > 0 || skipped.length > 0 ? "one or more completed scope snapshots could not be published" : undefined;
    await saveProgress(progress).catch((error) => console.error("[chatAutoCasebookPendingPrecompute] could not persist completion status", {
      error: error instanceof Error ? error.message : String(error),
    }));

    return { ok: true, scopeKeys: [...scopeKeys], failed: [...failed], skipped: [...skipped], rowCacheWritten, deadlineExceeded };
  } catch (error) {
    if (progress) {
      progress.status = "error";
      progress.errorMessage = error instanceof Error ? error.message : String(error);
      await saveProgress(progress).catch((saveError) => console.error("[chatAutoCasebookPendingPrecompute] could not persist error status", {
        error: saveError instanceof Error ? saveError.message : String(saveError),
      }));
    }
    console.error("[chatAutoCasebookPendingPrecompute] exact count refresh failed; last complete scope snapshots were preserved", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: true, scopeKeys: [], failed: progress?.targets.map((target) => target.scopeKey) ?? [], skipped: [], rowCacheWritten: false, deadlineExceeded };
  } finally {
    clearTimeout(timer);
  }
}

async function readPendingDocRaw(docId: string): Promise<{ raw: Record<string, unknown>; computedAtIso: string; asOfIso: string; asOfMs: number } | null> {
  const snapshot = await adminDb.collection(CHAT_AUTO_CASEBOOK_PENDING_COLLECTION).doc(docId).get();
  if (!snapshot.exists) return null;
  const raw = (snapshot.data() ?? {}) as Record<string, unknown>;
  const computedAtIso = typeof raw.computedAtIso === "string" ? raw.computedAtIso : null;
  const computedAtMs = computedAtIso ? Date.parse(computedAtIso) : Number.NaN;
  if (!computedAtIso || !Number.isFinite(computedAtMs)) return null;
  const asOfIso = asOfIsoFromRaw(raw, computedAtIso);
  const asOfMs = Date.parse(asOfIso);
  if (!Number.isFinite(asOfMs)) return null;
  return { raw, computedAtIso, asOfIso, asOfMs };
}

function statusForAge(computedAtMs: number, now?: () => Date): "fresh" | "stale" {
  const nowMs = (now?.() ?? new Date()).getTime();
  const ageMs = nowMs - computedAtMs;
  return !Number.isFinite(ageMs) || ageMs > CHAT_AUTO_CASEBOOK_PENDING_STALE_AFTER_MS ? "stale" : "fresh";
}

function asOfIsoFromRaw(raw: Record<string, unknown>, fallbackIso: string): string {
  const candidate = typeof raw.asOfIso === "string" ? raw.asOfIso : "";
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : fallbackIso;
}

/** Strict parse of the persisted breakdown: any missing/non-finite/negative field means the doc
 *  predates the breakdown (or is corrupt) and the reader must say "unavailable", never assume zeros. */
function parsePendingBreakdown(value: unknown): ChatAutoCasebookPendingBreakdown | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const byReasonRaw = raw.unclassifiedByReason;
  if (!byReasonRaw || typeof byReasonRaw !== "object") return undefined;
  const isCount = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0;
  if (!isCount(raw.closedCaseCount)) return undefined;
  const unclassifiedByReason = emptyUnclassifiedByReason();
  for (const reason of CHAT_AUTO_CASEBOOK_UNCLASSIFIED_REASONS) {
    const count = (byReasonRaw as Record<string, unknown>)[reason];
    if (!isCount(count)) return undefined;
    unclassifiedByReason[reason] = count;
  }
  // Optional field: absent/invalid/impossible (> never_classified) on an older doc = unknown (null).
  const beforeLaunch = isCount(raw.neverClassifiedBeforeStampLaunch)
    && raw.neverClassifiedBeforeStampLaunch <= unclassifiedByReason.never_classified
    ? raw.neverClassifiedBeforeStampLaunch
    : null;
  return { closedCaseCount: raw.closedCaseCount, unclassifiedByReason, neverClassifiedBeforeStampLaunch: beforeLaunch };
}

/** Fast path (single Firestore doc get, no scan) — the primary read getChatAutoCasebookSnapshot
 *  tries first, for the caller's own enumerated scope key. */
export async function readChatAutoCasebookPendingSnapshot(
  scopeKey: string,
  now?: () => Date,
): Promise<ChatAutoCasebookPendingReadResult> {
  const found = await readPendingDocRaw(scopeKey);
  if (!found) return { status: "missing", data: null };
  const { raw, computedAtIso, asOfIso, asOfMs } = found;
  const byCaseIdRaw = raw.byCaseId;
  const breakdown = parsePendingBreakdown(raw.breakdown);
  const doc: ChatAutoCasebookPendingDoc = {
    scopeKey,
    pendingTotal: typeof raw.pendingTotal === "number" ? raw.pendingTotal : 0,
    truncated: raw.truncated === true,
    byCaseId: byCaseIdRaw && typeof byCaseIdRaw === "object" ? (byCaseIdRaw as Record<string, number>) : {},
    unclassifiedCount: typeof raw.unclassifiedCount === "number" ? raw.unclassifiedCount : 0,
    ...(breakdown ? { breakdown } : {}),
    computedAtIso,
    exact: raw.exact === true && raw.truncated !== true,
    countStatus: raw.exact === true && raw.truncated !== true ? "exact" : raw.truncated === true ? "lower_bound" : "unknown",
    asOfIso,
  };
  return { status: statusForAge(asOfMs, now), data: doc };
}

/**
 * The "compute it on demand ONLY if cheap" fallback (2026-09-29 adversarial review fix): reads the
 * ONE shared per-tick row cache (already scanned, already manual-reply-checked — no Firestore scan
 * here, just one doc GET) and derives this specific caller's scope in memory. This is what makes an
 * unenumerated org (a brand-new org, a direct grant whose org enumeration missed this tick) still
 * resolve to a correct number instead of a permanent "missing" — at the cost of one extra doc read,
 * never a re-scan.
 */
async function deriveFromSharedRowCache(
  access: ConversationMailAccessScope,
  now?: () => Date,
): Promise<ChatAutoCasebookPendingReadResult> {
  const found = await readPendingDocRaw(CHAT_AUTO_CASEBOOK_PENDING_ROW_CACHE_DOC_ID);
  if (!found) return { status: "missing", data: null };
  const { raw, computedAtIso, asOfIso, asOfMs } = found;
  const rows = Array.isArray(raw.rows) ? (raw.rows as ChatAutoCasebookPendingCompactRow[]) : [];
  const truncated = raw.truncated === true;
  const totals = deriveChatAutoCasebookPendingTotalsForScope(rows, access, truncated);
  const doc: ChatAutoCasebookPendingDoc = {
    scopeKey: scopeKeyForAccess(access),
    pendingTotal: totals.totalPending,
    truncated: totals.truncated,
    byCaseId: Object.fromEntries(totals.byCaseId),
    unclassifiedCount: totals.unclassifiedCount,
    ...(totals.breakdown ? { breakdown: totals.breakdown } : {}),
    computedAtIso,
    exact: !truncated,
    countStatus: truncated ? "lower_bound" : "exact",
    asOfIso,
  };
  return { status: statusForAge(asOfMs, now), data: doc };
}

/**
 * Resolves a caller's own access scope (and its scope key) — moved here (unchanged logic) from
 * chatAutoCasePermitCallables.ts's former pendingScanCacheKeyForCaller, which cached the INLINE scan
 * result per caller scope; that scan (and its cache) is gone, but callers still need the same
 * scope resolution to know which scheduled-precompute doc is theirs (and, on a miss, to derive their
 * own totals from the shared row cache). super_admin is short-circuited locally (matching
 * isCallerScpEntitled/assertScpEntitled's own contract elsewhere in this codebase) so the hermetic
 * super_admin-only node-lane tests never need a real Firestore/Peoply lookup.
 */
export async function resolveCallerPendingAccess(
  auth: Pick<AuthContext, "role" | "email" | "userId">,
): Promise<{ scopeKey: string; access: ConversationMailAccessScope }> {
  if (auth.role === "super_admin") {
    const access = superAdminAccess();
    return { scopeKey: scopeKeyForAccess(access), access };
  }
  const access = await resolveConversationMailAccessScope({
    role: auth.role as Parameters<typeof resolveConversationMailAccessScope>[0]["role"],
    email: auth.email,
    userId: auth.userId,
  });
  return { scopeKey: scopeKeyForAccess(access), access };
}

/**
 * getChatAutoCasebookSnapshot's one dependency: resolve the caller's scope, read its precomputed
 * doc, and fall back to the cheap on-demand row-cache derivation above before ever reporting
 * "missing" — and (round 4 adversarial review, 2026-09-29) also when the primary doc is merely
 * STALE, if the row cache turns out to have been computed more recently. Round 3 made a stale
 * scope-write failure (round 4's own bounded-concurrency/deadline-guard fix above makes this a real,
 * expected possibility under load, not just a rare error) invisible to this reader — a stale primary
 * used to win unconditionally, even while a fresher, scope-filterable row cache sat one doc read
 * away (the SAME tick's row-cache write can succeed independently of any one scope's own write
 * failing). A fresh primary still returns immediately with no extra read — this only adds one doc
 * GET on the already-uncommon "stale" path, never on the common "fresh" path.
 */
export async function readCallerChatAutoCasebookPendingSnapshot(
  auth: Pick<AuthContext, "role" | "email" | "userId">,
  now?: () => Date,
): Promise<ChatAutoCasebookPendingReadResult> {
  const { scopeKey, access } = await resolveCallerPendingAccess(auth);
  const primary = await readChatAutoCasebookPendingSnapshot(scopeKey, now);
  if (primary.status === "fresh") return primary;
  let fromCache: ChatAutoCasebookPendingReadResult;
  try {
    fromCache = await deriveFromSharedRowCache(access, now);
  } catch (error) {
    console.error("[chatAutoCasebookPendingPrecompute] failed to read/derive shared row-cache fallback — preserving the primary pending snapshot result", {
      scopeKey,
      primaryStatus: primary.status,
      error: error instanceof Error ? error.message : String(error),
    });
    return primary;
  }
  if (fromCache.status === "missing") return primary;
  if (primary.status === "missing") return fromCache;
  // Both a stale primary and a row-cache-derived result exist — prefer whichever was actually
  // computed more recently rather than assuming the primary (this scope's own dedicated doc) is
  // always the newer of the two.
  const primaryMs = Date.parse(primary.data.computedAtIso);
  const cacheMs = Date.parse(fromCache.data.computedAtIso);
  return Number.isFinite(cacheMs) && (!Number.isFinite(primaryMs) || cacheMs > primaryMs) ? fromCache : primary;
}
