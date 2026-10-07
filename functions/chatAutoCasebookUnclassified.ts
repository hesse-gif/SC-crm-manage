// Casebook inbox — unclassified pending list (2026-10-01, AGG lane).
//
// getChatAutoCasebookSnapshot reports HOW MANY pending conversations are unclassified (never
// classified / unknown case id / stale stamp — see chatAutoCasebookPendingPrecompute.ts's
// classifyPendingRow); this callable lists WHICH ones, so an operator can open each in /chat.
// It is a LIVE, bounded scan (not the snapshot's readTime), so the UI labels it "현재 기준".
//
// Same surface rules as the snapshot: non-guest, scp-entitled (assertScpEntitled), viewAs rejected
// loudly, conversation scope = the scope the caller's own pending snapshot uses
// (resolveCallerPendingAccess: super_admin = every row, anyone else = their org/direct-grant
// scope). Rows come from scanUnrepliedInboxForScope with the precompute's registration-gate
// semantics and fail-closed policy lookup, then each row goes through the SAME classifyPendingRow
// the counters use — so the list and the headline counts can never disagree about which bucket a
// conversation is in. The scan is paged through its own cursors until `limit` matching rows are
// collected or a bounded scan budget (call count / wall clock) is hit; a cut-short scan returns a
// resumable nextCursor and never claims `exhausted`. Projection is minimal (no message bodies) and
// the creator email is masked.
import { encodePageCursor, decodePageCursor, conversationRegistrationGateFilter, projectConversationRecordForClient, scanUnrepliedInboxForScope } from "./read";
import { assertScpEntitled } from "./mailAccounts";
import { canReadConversationRowForScope } from "./conversationMailAccessScope";
import { CANONICAL_SCP_MAIL_ACCOUNT_ID } from "./mailConversationAuthorization";
import {
  CHAT_AUTO_CASEBOOK_UNCLASSIFIED_REASONS,
  classifyPendingRow,
  isBeforeStampLaunch,
  resolveCallerPendingAccess,
  toCompactRow,
  type ChatAutoCasebookUnclassifiedReason,
} from "./chatAutoCasebookPendingPrecompute";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  makeBehaviorLog,
  makeDeniedBehaviorLog,
  type CallableRequestShape,
} from "./shared";

const ACTION = "chat_auto_casebook_unclassified.list";
export const CHAT_AUTO_CASEBOOK_UNCLASSIFIED_DEFAULT_LIMIT = 25;
export const CHAT_AUTO_CASEBOOK_UNCLASSIFIED_MAX_LIMIT = 50;
// Rows requested per scanner call. Each call can still read up to ~900 conversation docs and run
// up to this many manual-reply checks, so keep it small; paging continues over cursors instead.
const SCAN_PAGE_LIMIT = 50;
// Bounded work per request: at most this many scanner calls, and no NEW call after this much wall
// clock (the callable's own timeout is 60s; one call is started only while under budget).
export const CHAT_AUTO_CASEBOOK_UNCLASSIFIED_MAX_SCAN_CALLS = 6;
export const CHAT_AUTO_CASEBOOK_UNCLASSIFIED_BUDGET_MS = 25_000;

export type ListChatAutoCasebookUnclassifiedRequest = {
  reason?: ChatAutoCasebookUnclassifiedReason | "all";
  cursor?: string | null;
  limit?: number;
};

export type ChatAutoCasebookUnclassifiedRow = {
  conversationId: string;
  reason: ChatAutoCasebookUnclassifiedReason;
  creatorName: string | null;
  creatorEmailMasked: string | null;
  /** The conversation projection carries no subject today — null until it does. */
  subject: string | null;
  lastInboundAtIso: string | null;
  /** Every row comes from the canonical scp mailbox scan, so this is that account's id. */
  mailAccountLabel: string | null;
  /** true = a never_classified conversation whose last inbound predates the stamp launch
   *  (CHAT_AUTO_CASE_STAMP_LAUNCH_ISO): it arrived before stamping existed, so it was never a
   *  classification failure. Always false for the other reasons. */
  legacy: boolean;
};

export type ChatAutoCasebookUnclassifiedEnvelope = {
  ok: true;
  rows: ChatAutoCasebookUnclassifiedRow[];
  nextCursor: string | null;
  exhausted: boolean;
  scannedAtIso: string;
  behaviorLog: Record<string, unknown>;
};

type UnclassifiedDependencies = {
  resolveAccess?: typeof resolveCallerPendingAccess;
  scan?: typeof scanUnrepliedInboxForScope;
  now?: () => Date;
  /** Wall-clock reader for the scan budget only (tests inject a fake clock). */
  nowMs?: () => number;
  budgetMs?: number;
  maxScanCalls?: number;
};

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument",
    errorCode: "chat_auto_casebook_unclassified_invalid_argument",
  });
}

export function viewAsRequested(data: Record<string, unknown>): boolean {
  return (typeof data.viewAsUserId === "string" && data.viewAsUserId.trim().length > 0)
    || (typeof data.viewAsEmail === "string" && data.viewAsEmail.trim().length > 0);
}

function parseReason(value: unknown): ChatAutoCasebookUnclassifiedReason | "all" {
  if (value === undefined || value === null || value === "") return "all";
  if (value === "all") return "all";
  if ((CHAT_AUTO_CASEBOOK_UNCLASSIFIED_REASONS as readonly unknown[]).includes(value)) return value as ChatAutoCasebookUnclassifiedReason;
  throw invalidArgument("reason must be never_classified, unknown_case, stale_stamp, or all");
}

function parseLimit(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (value === undefined || value === null || !Number.isFinite(num) || num <= 0) return CHAT_AUTO_CASEBOOK_UNCLASSIFIED_DEFAULT_LIMIT;
  return Math.min(Math.floor(num), CHAT_AUTO_CASEBOOK_UNCLASSIFIED_MAX_LIMIT);
}

export function boundedString(value: unknown, maxLength: number): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : null;
}

// First character + domain stay readable ("a***@example.com") so an operator can tell senders
// apart without the full address crossing this callable's boundary.
export function maskCreatorEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim() : "";
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return `${email[0]}***${email.slice(at)}`;
}

function projectUnclassifiedRow(
  row: Record<string, unknown>,
  reason: ChatAutoCasebookUnclassifiedReason,
): ChatAutoCasebookUnclassifiedRow {
  // The record projection is the allowlist: only keys the unreplied inbox already exposes to this
  // caller survive it (message bodies, refs and private fields never do).
  const projected = projectConversationRecordForClient(row);
  return {
    conversationId: asString(row.id),
    reason,
    creatorName: boundedString(projected.creatorName, 200),
    creatorEmailMasked: maskCreatorEmail(projected.creatorEmail),
    subject: boundedString(projected.subject, 300),
    lastInboundAtIso: boundedString(projected.lastInboundAtIso, 40),
    mailAccountLabel: CANONICAL_SCP_MAIL_ACCOUNT_ID,
    legacy: reason === "never_classified" && isBeforeStampLaunch(row.lastInboundAtIso),
  };
}

export async function listChatAutoCasebookUnclassified(
  request: CallableRequestShape,
  deps: UnclassifiedDependencies = {},
): Promise<ChatAutoCasebookUnclassifiedEnvelope> {
  const auth = assertNonGuestAuth(request, ACTION);
  const data = asRecord(request.data);
  // viewAs is rejected outright, same as the snapshot: this list is program-wide for every
  // scp-entitled operator, so a preview could only ever show the OPERATOR's own rows while they
  // believe they are previewing someone else's.
  if (viewAsRequested(data)) {
    throw Object.assign(new Error("permission-denied: this console does not support viewAs preview"), {
      code: "permission-denied",
      errorCode: "chat_auto_casebook_unclassified_view_as_unsupported",
      behaviorLog: makeDeniedBehaviorLog(request, ACTION, auth.gameId),
    });
  }
  await assertScpEntitled(auth, request, ACTION);

  const reason = parseReason(data.reason);
  const limit = parseLimit(data.limit);
  const requestedCursor = decodePageCursor(data.cursor);
  if (asString(data.cursor) && !requestedCursor) throw invalidArgument("cursor is not a valid scan cursor");

  const { access } = await (deps.resolveAccess ?? resolveCallerPendingAccess)(auth);
  const scan = deps.scan ?? scanUnrepliedInboxForScope;
  // Same gate semantics as the precompute (hides only counterpartyRegistered===false rows; the
  // role is irrelevant because includeUnregistered is always false here).
  const registrationGate = conversationRegistrationGateFilter(auth.role, false);
  const nowMs = deps.nowMs ?? Date.now;
  const startMs = nowMs();
  const budgetMs = deps.budgetMs ?? CHAT_AUTO_CASEBOOK_UNCLASSIFIED_BUDGET_MS;
  const maxScanCalls = deps.maxScanCalls ?? CHAT_AUTO_CASEBOOK_UNCLASSIFIED_MAX_SCAN_CALLS;

  const rows: ChatAutoCasebookUnclassifiedRow[] = [];
  let cursor: { docId: string; orderValue: string } | null = requestedCursor
    ? { docId: requestedCursor.docId, orderValue: asString(requestedCursor.orderValue, "") }
    : null;
  let readTime: { seconds: number; nanoseconds: number } | undefined;
  let policy: Awaited<ReturnType<typeof scanUnrepliedInboxForScope>>["policy"] | undefined;
  let scanCalls = 0;
  let nextCursor: string | null = null;
  let exhausted = false;

  for (;;) {
    // Always run at least one scan call so a resumed/first request makes progress; after that, stop
    // starting new calls once the call-count or wall-clock budget is spent and hand back the cursor
    // of the first unscanned position (never `exhausted`).
    if (scanCalls > 0 && (scanCalls >= maxScanCalls || nowMs() - startMs >= budgetMs)) {
      nextCursor = cursor ? encodePageCursor(cursor) : null;
      break;
    }
    const page = await scan({
      access,
      mailAccountId: CANONICAL_SCP_MAIL_ACCOUNT_ID,
      limit: SCAN_PAGE_LIMIT,
      cursor,
      // Reuse the first page's fixed readTime + eligibility policy for every page of this request
      // (consistent view, no repeated settings/routing reads).
      ...(readTime ? { readTime } : {}),
      ...(policy ? { policy } : {}),
      policyFailureMode: "fail_closed",
      registrationGate,
    });
    scanCalls += 1;
    readTime = page.readTime;
    policy = page.policy;

    for (let index = 0; index < page.rows.length; index += 1) {
      const row = page.rows[index];
      // Defense in depth: the scanner already applies the caller's scope; re-check in memory so a
      // scan bug can never leak another org's row through this list.
      if (!canReadConversationRowForScope(row, access, CANONICAL_SCP_MAIL_ACCOUNT_ID)) continue;
      const bucket = classifyPendingRow(toCompactRow(row));
      if (bucket.kind !== "unclassified") continue;
      if (reason !== "all" && bucket.reason !== reason) continue;
      rows.push(projectUnclassifiedRow(row, bucket.reason));
      if (rows.length < limit) continue;
      // Limit reached: resume exactly after this row when more rows of this page remain
      // unexamined, otherwise from the scanner's own next position.
      if (index < page.rows.length - 1) {
        nextCursor = encodePageCursor({ docId: asString(row.id), orderValue: asString(row.lastInboundAtIso, "") });
      } else {
        nextCursor = page.nextCursor;
        exhausted = !page.nextCursor;
      }
      return finish(auth, rows, nextCursor, exhausted, deps);
    }

    // Page fully consumed without reaching the limit.
    if (!page.nextCursor) {
      exhausted = true;
      nextCursor = null;
      break;
    }
    const decoded = decodePageCursor(page.nextCursor);
    const advanced = decoded && !(
      cursor && cursor.docId === decoded.docId && cursor.orderValue === asString(decoded.orderValue, "")
    );
    if (!decoded || !advanced) {
      // A scanner cursor we cannot decode or that did not move would loop forever — hand it back
      // to the client as-is and report the scan as not exhausted.
      nextCursor = page.nextCursor;
      break;
    }
    cursor = { docId: decoded.docId, orderValue: asString(decoded.orderValue, "") };
  }
  return finish(auth, rows, nextCursor, exhausted, deps);
}

function finish(
  auth: ReturnType<typeof assertNonGuestAuth>,
  rows: ChatAutoCasebookUnclassifiedRow[],
  nextCursor: string | null,
  exhausted: boolean,
  deps: UnclassifiedDependencies,
): ChatAutoCasebookUnclassifiedEnvelope {
  return {
    ok: true,
    rows,
    nextCursor,
    exhausted,
    scannedAtIso: (deps.now?.() ?? new Date()).toISOString(),
    behaviorLog: { ...makeBehaviorLog(auth, ACTION, "success") },
  };
}
