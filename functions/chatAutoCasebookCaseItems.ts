// Casebook inbox — "실제 건 보기" (2026-10-03): lists WHICH pending conversations sit behind one
// casebook card's "대기 중 N건", so an operator can judge whether the classification is right.
//
// Sibling of chatAutoCasebookUnclassified.ts and built the same way, deliberately:
//   - same surface rules: non-guest, scp-entitled (assertScpEntitled), viewAs rejected loudly,
//     conversation scope = resolveCallerPendingAccess (the scope the caller's own snapshot uses);
//   - same pending set: rows come from scanUnrepliedInboxForScope with the precompute's
//     registration-gate semantics + fail-closed policy lookup, and every row goes through the SAME
//     toCompactRow/classifyPendingRow the counters use. A case card's N counts the rows whose bucket
//     is {managed, caseId}; the list keeps exactly those rows, so list and card can only differ by
//     the snapshot's age (the list is live — the UI labels it "현재 기준").
//   - bounded work + resumable cursor: same call/wall-clock budget; a cut-short scan never claims
//     `exhausted`.
// Differences: newest first (scan direction "desc"), and for a real case id the Firestore query is
// narrowed to that autoCaseId (composite index in firestore.indexes.json) so a card with a handful
// of items does not need a scan of the whole queue. If that index is not built yet the callable
// falls back to the un-narrowed scan (slower, same result).
//
// Buckets: a casebook case id (managed rows of that case; for an auto_close case — which has no
// displayed card — its fresh "closed" rows), "unclassified" (every unclassified reason), and
// "no_reply_needed" (managed + closed rows whose case isCasebookNoReplyNeeded — the 답장 불필요 overlay).
//
// SEC-P0-009: the payload carries NO message body, subject or prompt. The only free text is
// `summaryKr` — the server-generated Korean summary conversation.lastMessage already holds for the
// last inbound (chat-ai.ts persistReceivedEmail writes lastMessage = summaryKr together with
// lastMessageRef = autoCaseMessageRef) and that /chat already shows — bounded to 200 chars; plus a
// short Korean label for the hold reason (a finite map of known gate reason texts/codes; EVERYTHING else
// becomes a generic label — model-written reasons never cross this boundary).
import { encodePageCursor, decodePageCursor, conversationRegistrationGateFilter, projectConversationRecordForClient, scanUnrepliedInboxForScope } from "./read";
import { assertScpEntitled } from "./mailAccounts";
import { canReadConversationRowForScope } from "./conversationMailAccessScope";
import { CANONICAL_SCP_MAIL_ACCOUNT_ID } from "./mailConversationAuthorization";
import { CHAT_CASEBOOK, isCasebookNoReplyNeeded } from "./chatCasebook";
import { isChatAutoPermitCaseId } from "./chatAutoCasePermit";
import {
  classifyPendingRow,
  resolveCallerPendingAccess,
  toCompactRow,
  type ChatAutoCasebookPendingRowBucket,
  type ChatAutoCasebookUnclassifiedReason,
} from "./chatAutoCasebookPendingPrecompute";
import { boundedString, maskCreatorEmail, viewAsRequested } from "./chatAutoCasebookUnclassified";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  makeBehaviorLog,
  makeDeniedBehaviorLog,
  type CallableRequestShape,
} from "./shared";

const ACTION = "chat_auto_casebook_case_items.list";
export const CHAT_AUTO_CASEBOOK_CASE_ITEMS_DEFAULT_LIMIT = 25;
export const CHAT_AUTO_CASEBOOK_CASE_ITEMS_MAX_LIMIT = 50;
const SCAN_PAGE_LIMIT = 50;
export const CHAT_AUTO_CASEBOOK_CASE_ITEMS_MAX_SCAN_CALLS = 6;
export const CHAT_AUTO_CASEBOOK_CASE_ITEMS_BUDGET_MS = 25_000;
export const CHAT_AUTO_CASEBOOK_CASE_ITEMS_SUMMARY_MAX = 200;

export const CHAT_AUTO_CASEBOOK_CASE_ITEMS_UNCLASSIFIED = "unclassified";
export const CHAT_AUTO_CASEBOOK_CASE_ITEMS_NO_REPLY_NEEDED = "no_reply_needed";

const NO_REPLY_NEEDED_CASE_IDS: readonly string[] = CHAT_CASEBOOK.filter((item) => isCasebookNoReplyNeeded(item.id)).map((item) => item.id);

export type ListChatAutoCasebookCaseItemsRequest = {
  caseId?: string;
  cursor?: string | null;
  limit?: number;
};

export type ChatAutoCasebookCaseItemRow = {
  conversationId: string;
  /** The row's own fresh casebook case id (managed/closed rows); null for unclassified rows. */
  caseId: string | null;
  bucket: "managed" | "closed" | "unclassified";
  unclassifiedReason: ChatAutoCasebookUnclassifiedReason | null;
  creatorName: string | null;
  creatorHandle: string | null;
  creatorEmailMasked: string | null;
  programLabel: string | null;
  lastInboundAtIso: string | null;
  /** Server-generated Korean summary of the last inbound message (≤200 chars). Never the body. */
  summaryKr: string | null;
  inboundIntent: string | null;
  inboundIntentLabel: string | null;
  /** queued = draft waiting for auto-reply, held = waiting for a human. */
  replyState: "queued" | "held";
  /** Short Korean hold reason (mapped, or a truncated original); null when none is recorded. */
  holdReasonLabel: string | null;
};

export type ChatAutoCasebookCaseItemsEnvelope = {
  ok: true;
  caseId: string;
  rows: ChatAutoCasebookCaseItemRow[];
  nextCursor: string | null;
  exhausted: boolean;
  scannedAtIso: string;
  behaviorLog: Record<string, unknown>;
};

type CaseItemsDependencies = {
  resolveAccess?: typeof resolveCallerPendingAccess;
  scan?: typeof scanUnrepliedInboxForScope;
  now?: () => Date;
  nowMs?: () => number;
  budgetMs?: number;
  maxScanCalls?: number;
};

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument",
    errorCode: "chat_auto_casebook_case_items_invalid_argument",
  });
}

function parseCaseId(value: unknown): string {
  const caseId = typeof value === "string" ? value.trim() : "";
  if (
    caseId === CHAT_AUTO_CASEBOOK_CASE_ITEMS_UNCLASSIFIED
    || caseId === CHAT_AUTO_CASEBOOK_CASE_ITEMS_NO_REPLY_NEEDED
    || isChatAutoPermitCaseId(caseId)
  ) return caseId;
  throw invalidArgument("caseId must be a casebook case id, unclassified, or no_reply_needed");
}

function parseLimit(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (value === undefined || value === null || !Number.isFinite(num) || num <= 0) return CHAT_AUTO_CASEBOOK_CASE_ITEMS_DEFAULT_LIMIT;
  return Math.min(Math.floor(num), CHAT_AUTO_CASEBOOK_CASE_ITEMS_MAX_LIMIT);
}

/** The Firestore autoCaseId narrowing for a bucket, or null when it cannot be narrowed (unclassified
 *  includes rows with NO autoCaseId, which an equality/in filter can never match). */
function narrowCaseIdsFor(caseId: string): readonly string[] | null {
  if (caseId === CHAT_AUTO_CASEBOOK_CASE_ITEMS_UNCLASSIFIED) return null;
  if (caseId === CHAT_AUTO_CASEBOOK_CASE_ITEMS_NO_REPLY_NEEDED) return NO_REPLY_NEEDED_CASE_IDS.length > 0 ? NO_REPLY_NEEDED_CASE_IDS : null;
  return [caseId];
}

/** Does a classified row belong to the requested bucket? Mirrors how the counters attribute it. */
function bucketMatches(caseId: string, bucket: ChatAutoCasebookPendingRowBucket, rowAutoCaseId: string | null): boolean {
  if (caseId === CHAT_AUTO_CASEBOOK_CASE_ITEMS_UNCLASSIFIED) return bucket.kind === "unclassified";
  if (bucket.kind === "unclassified") return false;
  const ownCaseId = bucket.kind === "managed" ? bucket.caseId : rowAutoCaseId;
  if (!ownCaseId) return false;
  if (caseId === CHAT_AUTO_CASEBOOK_CASE_ITEMS_NO_REPLY_NEEDED) return isCasebookNoReplyNeeded(ownCaseId);
  return ownCaseId === caseId;
}

const INTENT_LABELS: Record<string, string> = {
  guide_interest: "가이드 관심",
  apply_how: "신청 방법",
  submit_how: "제출 방법",
  sample_request: "샘플 요청",
  partner_accept: "참여 수락",
  price_inquiry: "단가 문의",
  other_human: "기타(사람 확인)",
};

// Gate-reason code → short Korean label. First match wins, so the more specific patterns come first.
const HOLD_REASON_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/jev/i, "JEV 보류"],
  [/^counterparty_not_registered$/, "미등록 상대"],
  [/^duplicate_case_intent$/, "중복 문의"],
  [/^auto_reply_disabled_for_org$/, "조직 자동답장 꺼짐"],
  // MAIL_IDENTITY_CODES (mailIdentity.ts) — the finite set the queue writes as autoReplyBlockedReason.
  [/^identity_ok_unverified_subject$/, "발신 주소 미검증"],
  [/^identity_mismatch$/, "발신 주소 불일치"],
  [/^identity_unknown$/, "발신 주소 확인 불가"],
  [/^org_scp_not_assigned$/, "조직 메일함 미배정"],
  [/^운영자 차단$/, "운영자 차단"],
  [/hard safety stop/i, "안전 차단"],
  [/opt-out|legal threat/i, "수신거부·법적 위협"],
  [/delivery-status|bounce/i, "배달 이상"],
  [/missing payment|underpaid|settlement/i, "정산 이의"],
  [/press, media|partnership\/agency/i, "언론·제휴 문의"],
  [/agency|management|manager|representative/i, "에이전시·매니저 회신"],
  [/privacy|gdpr/i, "개인정보 문의"],
  [/frustration|tone shift|sudden pause/i, "불만·분위기 변화"],
  [/budget|rate|payment|reward terms|currency|amount/i, "금액·단가 언급"],
  [/contract|signature|usage-rights|exclusivity|cancellation/i, "계약·권리 조건"],
  [/call, meeting|phone|calendar|availability/i, "통화·미팅 요청"],
  [/schedule or launch-window/i, "일정 변경"],
  [/gratitude-only|gratitude/i, "감사 인사만"],
  [/soft decline|conditional interest/i, "소극적 거절"],
  [/confusing reply/i, "의도 불분명"],
  [/approval status/i, "승인 상태 문의"],
  [/counter.?offer/i, "역제안"],
];

export function holdReasonLabel(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const evidence = /creator evidence is below admin review threshold \((\d+)\/(\d+)/i.exec(raw);
  if (evidence) return `증거 부족(${evidence[1]}/${evidence[2]})`;
  for (const [pattern, label] of HOLD_REASON_RULES) {
    if (pattern.test(raw)) return label;
  }
  // Anything else is free text the model wrote (humanGate.reason) or an unknown code — it could echo the
  // inbound message or the prompt, so it never crosses the boundary: only the finite map above does.
  return "기타 보류 사유";
}

function projectCaseItemRow(row: Record<string, unknown>, bucket: ChatAutoCasebookPendingRowBucket): ChatAutoCasebookCaseItemRow {
  // The record projection is the allowlist: only keys the unreplied inbox already exposes to this
  // caller survive it (message bodies, refs and private fields never do).
  const projected = projectConversationRecordForClient(row);
  const rowAutoCaseId = typeof row.autoCaseId === "string" && isChatAutoPermitCaseId(row.autoCaseId) ? row.autoCaseId : null;
  const intentId = asString(asRecord(row.inboundIntent).id, "");
  const blockedReason = holdReasonLabel(row.autoReplyBlockedReason);
  const held = row.autoReplyStatus === "waiting_for_human" || blockedReason !== null;
  return {
    conversationId: asString(row.id),
    caseId: bucket.kind === "managed" ? bucket.caseId : bucket.kind === "closed" ? rowAutoCaseId : null,
    bucket: bucket.kind,
    unclassifiedReason: bucket.kind === "unclassified" ? bucket.reason : null,
    creatorName: boundedString(projected.creatorName, 200),
    creatorHandle: boundedString(projected.creatorHandle, 100),
    creatorEmailMasked: maskCreatorEmail(projected.creatorEmail),
    programLabel: boundedString(projected.programTitle, 120) ?? boundedString(projected.campaignTitle, 120),
    lastInboundAtIso: boundedString(projected.lastInboundAtIso, 40),
    summaryKr: boundedString(projected.lastMessage, CHAT_AUTO_CASEBOOK_CASE_ITEMS_SUMMARY_MAX),
    inboundIntent: intentId in INTENT_LABELS ? intentId : null,
    inboundIntentLabel: INTENT_LABELS[intentId] ?? null,
    replyState: held ? "held" : "queued",
    holdReasonLabel: blockedReason,
  };
}

function isMissingIndexError(error: unknown): boolean {
  const record = asRecord(error);
  return record.code === 9 || record.code === "failed-precondition" || /requires an index|FAILED_PRECONDITION/i.test(String(record.message ?? ""));
}

export async function listChatAutoCasebookCaseItems(
  request: CallableRequestShape,
  deps: CaseItemsDependencies = {},
): Promise<ChatAutoCasebookCaseItemsEnvelope> {
  const auth = assertNonGuestAuth(request, ACTION);
  const data = asRecord(request.data);
  // viewAs is rejected outright, same as the snapshot and the unclassified list: this list is
  // program-wide for every scp-entitled operator, so a preview could only ever show the OPERATOR's
  // own rows while they believe they are previewing someone else's.
  if (viewAsRequested(data)) {
    throw Object.assign(new Error("permission-denied: this console does not support viewAs preview"), {
      code: "permission-denied",
      errorCode: "chat_auto_casebook_case_items_view_as_unsupported",
      behaviorLog: makeDeniedBehaviorLog(request, ACTION, auth.gameId),
    });
  }
  await assertScpEntitled(auth, request, ACTION);

  const caseId = parseCaseId(data.caseId);
  const limit = parseLimit(data.limit);
  const requestedCursor = decodePageCursor(data.cursor);
  if (asString(data.cursor) && !requestedCursor) throw invalidArgument("cursor is not a valid scan cursor");

  const { access } = await (deps.resolveAccess ?? resolveCallerPendingAccess)(auth);
  const scan = deps.scan ?? scanUnrepliedInboxForScope;
  const registrationGate = conversationRegistrationGateFilter(auth.role, false);
  const nowMs = deps.nowMs ?? Date.now;
  const startMs = nowMs();
  const budgetMs = deps.budgetMs ?? CHAT_AUTO_CASEBOOK_CASE_ITEMS_BUDGET_MS;
  const maxScanCalls = deps.maxScanCalls ?? CHAT_AUTO_CASEBOOK_CASE_ITEMS_MAX_SCAN_CALLS;
  let narrowed = narrowCaseIdsFor(caseId);

  const rows: ChatAutoCasebookCaseItemRow[] = [];
  let cursor: { docId: string; orderValue: string } | null = requestedCursor
    ? { docId: requestedCursor.docId, orderValue: asString(requestedCursor.orderValue, "") }
    : null;
  let readTime: { seconds: number; nanoseconds: number } | undefined;
  let policy: Awaited<ReturnType<typeof scanUnrepliedInboxForScope>>["policy"] | undefined;
  let scanCalls = 0;
  let nextCursor: string | null = null;
  let exhausted = false;

  const runScan = () => scan({
    access,
    mailAccountId: CANONICAL_SCP_MAIL_ACCOUNT_ID,
    limit: SCAN_PAGE_LIMIT,
    cursor,
    direction: "desc",
    ...(narrowed ? { autoCaseIds: narrowed } : {}),
    ...(readTime ? { readTime } : {}),
    ...(policy ? { policy } : {}),
    policyFailureMode: "fail_closed",
    registrationGate,
  });

  for (;;) {
    if (scanCalls > 0 && (scanCalls >= maxScanCalls || nowMs() - startMs >= budgetMs)) {
      nextCursor = cursor ? encodePageCursor(cursor) : null;
      break;
    }
    let page: Awaited<ReturnType<typeof scanUnrepliedInboxForScope>>;
    try {
      page = await runScan();
    } catch (error) {
      // The narrowed query needs a composite index that may still be building right after a deploy:
      // fall back to the plain (index-backed) scan — slower, identical result because every row is
      // classified in memory below anyway.
      if (!narrowed || !isMissingIndexError(error)) throw error;
      narrowed = null;
      page = await runScan();
    }
    scanCalls += 1;
    readTime = page.readTime;
    policy = page.policy;

    for (let index = 0; index < page.rows.length; index += 1) {
      const row = page.rows[index];
      // Defense in depth: re-check the caller's scope in memory so a scan bug can never leak another
      // org's row through this list.
      if (!canReadConversationRowForScope(row, access, CANONICAL_SCP_MAIL_ACCOUNT_ID)) continue;
      const bucket = classifyPendingRow(toCompactRow(row));
      const rowAutoCaseId = typeof row.autoCaseId === "string" ? row.autoCaseId : null;
      if (!bucketMatches(caseId, bucket, rowAutoCaseId)) continue;
      rows.push(projectCaseItemRow(row, bucket));
      if (rows.length < limit) continue;
      if (index < page.rows.length - 1) {
        nextCursor = encodePageCursor({ docId: asString(row.id), orderValue: asString(row.lastInboundAtIso, "") });
      } else {
        nextCursor = page.nextCursor;
        exhausted = !page.nextCursor;
      }
      return finish(auth, caseId, rows, nextCursor, exhausted, deps);
    }

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
      nextCursor = page.nextCursor;
      break;
    }
    cursor = { docId: decoded.docId, orderValue: asString(decoded.orderValue, "") };
  }
  return finish(auth, caseId, rows, nextCursor, exhausted, deps);
}

function finish(
  auth: ReturnType<typeof assertNonGuestAuth>,
  caseId: string,
  rows: ChatAutoCasebookCaseItemRow[],
  nextCursor: string | null,
  exhausted: boolean,
  deps: CaseItemsDependencies,
): ChatAutoCasebookCaseItemsEnvelope {
  return {
    ok: true,
    caseId,
    rows,
    nextCursor,
    exhausted,
    scannedAtIso: (deps.now?.() ?? new Date()).toISOString(),
    behaviorLog: { ...makeBehaviorLog(auth, ACTION, "success") },
  };
}
