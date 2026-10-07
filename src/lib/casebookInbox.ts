import type {
  ChatAutoCasebookAttention,
  ChatAutoCasebookCaseItemRow,
  ChatAutoCasebookDefaultSuggestion,
  ChatAutoCasebookPendingBreakdown,
  ChatAutoCasebookReplyLink,
  ChatAutoCasebookSnapshotEnvelope,
  ChatAutoCasebookUnclassifiedReason,
} from "@/lib/data";

// Casebook inbox (2026-10-01): pure view-model helpers for /chat/auto's casebook console — sorting,
// the 사람 처리 필요 / 자동답장 설정됨 / 전체 view filter, the total-breakdown arithmetic, link-insert
// helpers, and tolerant normalizers for the new snapshot fields. Everything here is a read-only
// projection of the server snapshot (no server mutation, no I/O) so it can be unit-tested directly.
// Type-only imports keep this file loadable by the plain node test runner after transpilation.

export const CASEBOOK_UNCLASSIFIED_KEY = "__unclassified__";

export type CasebookInboxFilter = "needs_human" | "auto_healthy" | "no_reply_needed" | "all";
export const CASEBOOK_DEFAULT_FILTER: CasebookInboxFilter = "needs_human";

export const CASEBOOK_FILTER_LABELS: Record<CasebookInboxFilter, string> = {
  needs_human: "사람 처리 필요",
  auto_healthy: "자동답장 설정됨",
  no_reply_needed: "답장 불필요",
  all: "전체",
};

/** Server attention reason for a case whose pending conversations need no human reply (부재중 등). */
export const CASEBOOK_NO_REPLY_NEEDED_REASON = "no_reply_needed";

/** Labels for the 답장 불필요 explanation line, in display order; unknown case ids fall back to their id. */
const NO_REPLY_NEEDED_CASE_LABELS: Array<[string, string]> = [
  ["out_of_office", "부재중"],
  ["closing_acknowledgment", "종결 인사"],
];

export interface CasebookReplyNeededHeadline {
  total: number;
  replyNeeded: number;
  noReplyNeeded: number;
  /** e.g. [{ label: "부재중", count: 80 }, { label: "종결 인사", count: 11 }] */
  parts: Array<{ label: string; count: number }>;
}

/**
 * "답장 필요 N건" headline (0.6.105): N = total − noReplyNeeded.total. Only over a PROVEN total — exact,
 * not truncated (kind "exact") AND a fresh snapshot — with a consistent overlay. A stale snapshot may be
 * missing newer inquiries, so subtracting from it would understate the work: it keeps the plain
 * "N건 대기 중" total with its stale label (as does an older server / unproven count). The total itself
 * is never rewritten.
 */
export function replyNeededHeadline(
  totalCount: number,
  kind: PendingDisplayKind,
  status: ChatAutoCasebookSnapshotEnvelope["pendingTotal"]["status"],
  breakdown: ChatAutoCasebookPendingBreakdown | null | undefined,
): CasebookReplyNeededHeadline | null {
  if (kind !== "exact" || status !== "fresh" || !breakdown || breakdown.status !== "available" || !breakdown.noReplyNeeded) return null;
  const { total, byCaseId } = breakdown.noReplyNeeded;
  if (total > totalCount) return null;
  const known = new Set(NO_REPLY_NEEDED_CASE_LABELS.map(([id]) => id));
  const parts = [
    ...NO_REPLY_NEEDED_CASE_LABELS.filter(([id]) => id in byCaseId).map(([id, label]) => ({ label, count: byCaseId[id] })),
    ...Object.keys(byCaseId).filter((id) => !known.has(id)).sort().map((id) => ({ label: id, count: byCaseId[id] })),
  ];
  return { total: totalCount, replyNeeded: totalCount - total, noReplyNeeded: total, parts };
}

export const CASEBOOK_UNCLASSIFIED_REASONS: ChatAutoCasebookUnclassifiedReason[] = [
  "never_classified",
  "unknown_case",
  "stale_stamp",
];

/** Case stamping launched 2026-09-28; never-classified mail older than that was never stampable. */
export const CASEBOOK_STAMP_LAUNCH_LABEL = "9/28";

export const CASEBOOK_UNCLASSIFIED_REASON_LABELS: Record<ChatAutoCasebookUnclassifiedReason, string> = {
  never_classified: "분류 기록 없음",
  unknown_case: "알 수 없는 케이스",
  stale_stamp: "최신 메일 미분류",
};

/**
 * The 미분류 card's single reason line: only the reasons that actually have conversations, with the
 * pre-launch subset folded into 분류 기록 없음 — e.g. "분류 기록 없음 287건 (이 중 280건은 9/28 분류 도입
 * 전 메일)". Empty string when every reason is 0.
 */
export function unclassifiedReasonSummary(
  byReason: Record<ChatAutoCasebookUnclassifiedReason, number>,
  legacyCount: number | null,
): string {
  return CASEBOOK_UNCLASSIFIED_REASONS
    .filter((reason) => byReason[reason] > 0)
    .map((reason) => {
      const base = `${CASEBOOK_UNCLASSIFIED_REASON_LABELS[reason]} ${byReason[reason]}건`;
      return reason === "never_classified" && legacyCount !== null && legacyCount > 0
        ? `${base} (이 중 ${legacyCount}건은 ${CASEBOOK_STAMP_LAUNCH_LABEL} 분류 도입 전 메일)`
        : base;
    })
    .join(" · ");
}

// ── pending count display kind ───────────────────────────────────────────────────────────────
// "exact": a completed full scan — integers may be shown. "lower_bound": the scan hit its cap, so
// every number is a floor ("N건 이상"). "computing": a doc exists but cannot prove a number.
// "missing": no precompute has ever written a doc. None of the last three may ever look like a 0.
export type PendingDisplayKind = "exact" | "lower_bound" | "computing" | "missing";

export function pendingDisplayKind(
  pendingTotal: Pick<ChatAutoCasebookSnapshotEnvelope["pendingTotal"], "count" | "truncated" | "status" | "exact" | "countStatus">,
): PendingDisplayKind {
  if (pendingTotal.status === "missing") return "missing";
  if (pendingTotal.exact && pendingTotal.countStatus === "exact" && !pendingTotal.truncated) return "exact";
  if ((pendingTotal.truncated || pendingTotal.countStatus === "lower_bound") && pendingTotal.count > 0) return "lower_bound";
  return "computing";
}

/**
 * Whether the 미분류 entry belongs in the default 사람 처리 필요 view: yes when conversations are waiting,
 * and ALSO whenever its count is not a proven number (lower bound / 집계 중 / 집계 전) — an unknown
 * backlog is never hidden. Only a known (exact) 0 from a FRESH snapshot hides it: a stale exact 0 may
 * still be displayed with its as-of time, but new inquiries may have arrived since, so it never hides.
 */
export function unclassifiedNeedsHuman(
  count: number,
  kind: PendingDisplayKind,
  status: ChatAutoCasebookSnapshotEnvelope["pendingTotal"]["status"],
): boolean {
  return count > 0 || kind !== "exact" || status !== "fresh";
}

/** "N건" / "N건 이상" / "집계 중" / "집계 전" — never a bare 0 unless the scan was complete. */
export function pendingCountLabel(kind: PendingDisplayKind, count: number): string {
  if (kind === "exact") return `${count}건`;
  if (kind === "lower_bound") return `${count}건 이상`;
  return kind === "missing" ? "집계 전" : "집계 중";
}

// ── total breakdown ("전체 대기 N건 = 케이스 M건 + 미분류 U건 (+ 종결 C건)") ─────────────────
export interface CasebookBreakdownEquation {
  total: number;
  managed: number;
  unclassified: number;
  closed: number;
  /** managed + unclassified + closed. */
  sum: number;
  /** True when the parts add up to the total (contract §1 invariant). */
  consistent: boolean;
}

export function breakdownEquation(
  totalCount: number,
  breakdown: ChatAutoCasebookPendingBreakdown | null | undefined,
): CasebookBreakdownEquation | null {
  if (!breakdown || breakdown.status !== "available") return null;
  const managed = breakdown.managedCaseTotal;
  const unclassified = breakdown.unclassified.total;
  const closed = breakdown.closedCaseCount;
  const sum = managed + unclassified + closed;
  return { total: totalCount, managed, unclassified, closed, sum, consistent: sum === totalCount };
}

// ── rows / entries ───────────────────────────────────────────────────────────────────────────
export interface CasebookInboxRowLike {
  caseId: string;
  pendingCount: number;
  attention?: ChatAutoCasebookAttention;
}

/** An absent `attention` (older server) means "unknown" — never hide a row on a guess. */
export function rowNeedsHuman(row: Pick<CasebookInboxRowLike, "attention">): boolean {
  return row.attention ? row.attention.needsHuman : true;
}

export function rowAutoReplyHealthy(row: Pick<CasebookInboxRowLike, "attention">): boolean {
  return row.attention?.autoReply === "healthy";
}

/** Only the server's explicit reason marks a row 답장 불필요 — an older server never does. */
export function rowNoReplyNeeded(row: Pick<CasebookInboxRowLike, "attention">): boolean {
  return row.attention?.reasons.includes(CASEBOOK_NO_REPLY_NEEDED_REASON) === true;
}

export type CasebookInboxEntry<R extends CasebookInboxRowLike = CasebookInboxRowLike> =
  | { kind: "case"; key: string; row: R; pendingCount: number; canonicalIndex: number; needsHuman: boolean; autoHealthy: boolean; noReplyNeeded: boolean }
  | { kind: "unclassified"; key: string; pendingCount: number; canonicalIndex: number; needsHuman: boolean; autoHealthy: false; noReplyNeeded: false };

/**
 * One list for the console: every case row plus (optionally) the "미분류" bucket as a first-class
 * entry. Sorted by pendingCount desc; ties fall back to the server's canonical row order (the
 * array index of `rows`, with 미분류 after every case) so the order is deterministic and identical
 * across refreshes that carry the same numbers.
 */
export function buildInboxEntries<R extends CasebookInboxRowLike>(
  rows: R[],
  unclassified: { pendingCount: number; needsHuman: boolean } | null,
): Array<CasebookInboxEntry<R>> {
  const entries: Array<CasebookInboxEntry<R>> = rows.map((row, index) => ({
    kind: "case" as const,
    key: row.caseId,
    row,
    pendingCount: row.pendingCount,
    canonicalIndex: index,
    needsHuman: rowNeedsHuman(row),
    autoHealthy: rowAutoReplyHealthy(row),
    noReplyNeeded: rowNoReplyNeeded(row),
  }));
  if (unclassified) {
    entries.push({
      kind: "unclassified",
      key: CASEBOOK_UNCLASSIFIED_KEY,
      pendingCount: unclassified.pendingCount,
      canonicalIndex: rows.length,
      needsHuman: unclassified.needsHuman,
      autoHealthy: false,
      noReplyNeeded: false,
    });
  }
  return entries.sort((a, b) => b.pendingCount - a.pendingCount || a.canonicalIndex - b.canonicalIndex);
}

type FilterableEntry = Pick<CasebookInboxEntry, "needsHuman" | "autoHealthy"> & { noReplyNeeded?: boolean };

export function entryMatchesFilter(entry: FilterableEntry, filter: CasebookInboxFilter): boolean {
  if (filter === "all") return true;
  if (filter === "no_reply_needed") return entry.noReplyNeeded === true;
  return filter === "needs_human" ? entry.needsHuman : entry.autoHealthy;
}

/** Filter is a pure view filter. `pinnedKeys` (an open/dirty editor) always stay visible so a view
 *  change can never unmount a human's unsaved text. */
export function filterInboxEntries<E extends Pick<CasebookInboxEntry, "key"> & FilterableEntry>(
  entries: E[],
  filter: CasebookInboxFilter,
  pinnedKeys: ReadonlySet<string>,
): E[] {
  return entries.filter((entry) => pinnedKeys.has(entry.key) || entryMatchesFilter(entry, filter));
}

export function inboxFilterCounts(entries: FilterableEntry[]): Record<CasebookInboxFilter, number> {
  return {
    needs_human: entries.filter((entry) => entry.needsHuman).length,
    auto_healthy: entries.filter((entry) => entry.autoHealthy).length,
    no_reply_needed: entries.filter((entry) => entry.noReplyNeeded === true).length,
    all: entries.length,
  };
}

/** Sum of every VISIBLE entry's pending count — case rows plus the 미분류 entry when it is shown — so
 *  "현재 보이는 합계" matches what the operator can see. Hidden entries are never folded in. */
export function visiblePendingTotal(entries: Array<Pick<CasebookInboxEntry, "pendingCount">>): number {
  return entries.reduce((sum, entry) => sum + entry.pendingCount, 0);
}

// ── attention badges ─────────────────────────────────────────────────────────────────────────
export type CasebookBadgeTone = "ok" | "warn" | "danger" | "neutral";
export interface CasebookAttentionBadge {
  label: string;
  tone: CasebookBadgeTone;
}

export function attentionBadges(
  row: Pick<CasebookInboxRowLike, "attention" | "pendingCount">,
  pendingKind: PendingDisplayKind,
): CasebookAttentionBadge[] {
  const attention = row.attention;
  if (!attention) return [];
  const badges: CasebookAttentionBadge[] = [];
  const push = (badge: CasebookAttentionBadge) => {
    if (!badges.some((existing) => existing.label === badge.label)) badges.push(badge);
  };
  if (attention.autoReply === "healthy") push({ label: "자동답장 설정됨", tone: "ok" });
  if (attention.autoReply === "armed_unhealthy") push({ label: "자동답장 점검 필요", tone: "warn" });
  for (const reason of attention.reasons) {
    if (reason === "not_armed") push({ label: "자동답장 꺼짐", tone: "neutral" });
    else if (reason === "eval_expired") push({ label: "검증 만료", tone: "danger" });
    else if (reason === "eval_stale") push({ label: "검증 갱신 필요", tone: "warn" });
    else if (reason === "pin_mismatch") push({ label: "설정 불일치", tone: "danger" });
    else if (reason === "blocked_case") push({ label: "자동응답 차단", tone: "neutral" });
    else if (reason === CASEBOOK_NO_REPLY_NEEDED_REASON) push({ label: "답장 불필요", tone: "neutral" });
    else if (reason === "pending_while_armed") {
      push({
        label: pendingKind === "exact" || pendingKind === "lower_bound"
          ? `자동답장 중 보류 ${pendingCountLabel(pendingKind, row.pendingCount)}`
          : "자동답장 중 보류 있음",
        tone: "warn",
      });
    }
    // Unknown codes are ignored on purpose: a newer server may add reasons this build can't word.
  }
  if (attention.autoReply === "off") push({ label: "자동답장 꺼짐", tone: "neutral" });
  return badges;
}

// ── reply link catalog / insertion ───────────────────────────────────────────────────────────
const LINK_TOKEN_LABELS: Record<string, string> = {
  GUIDE_LINK: "가이드 링크",
  APPLY_LINK: "신청 링크",
  SUBMIT_LINK: "제출 링크",
  SAMPLE_LINK: "샘플 링크",
};
const LINK_TOKEN_ORDER = ["GUIDE_LINK", "APPLY_LINK", "SUBMIT_LINK", "SAMPLE_LINK"];
export const PRIMARY_LINK_TOKEN = "GUIDE_LINK";

export interface CaseReplyLinkChoice {
  token: string;
  label: string;
  url: string | null;
  /** False when this case's reply may not use the link (shown disabled with a reason). */
  allowed: boolean;
  primary: boolean;
}

/** Catalog entries for one case's "링크 넣기" control. Hidden entirely (empty list) for an older
 *  server that sends no per-case allow-list — never offer a link the server hasn't approved. */
export function casebookLinkChoices(
  row: { allowedLinkTokens?: string[] },
  catalog: ChatAutoCasebookReplyLink[] | undefined,
): CaseReplyLinkChoice[] {
  if (!row.allowedLinkTokens) return [];
  const allowedSet = new Set(row.allowedLinkTokens);
  const byToken = new Map<string, ChatAutoCasebookReplyLink>();
  for (const entry of catalog ?? []) byToken.set(entry.token, entry);
  const tokens = byToken.size > 0 ? Array.from(byToken.keys()) : Array.from(allowedSet);
  const order = (token: string) => {
    const index = LINK_TOKEN_ORDER.indexOf(token);
    return index === -1 ? LINK_TOKEN_ORDER.length : index;
  };
  return tokens
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map((token) => ({
      token,
      label: LINK_TOKEN_LABELS[token] ?? byToken.get(token)?.label ?? token,
      url: byToken.get(token)?.url ?? null,
      allowed: allowedSet.has(token),
      primary: token === PRIMARY_LINK_TOKEN,
    }));
}

/** Replace the textarea selection with `insert`; null when the result would exceed `maxLength`. */
export function insertAtSelection(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  insert: string,
  maxLength: number,
): { text: string; caret: number } | null {
  const clamp = (value: number) => Math.min(Math.max(Number.isFinite(value) ? value : text.length, 0), text.length);
  const a = clamp(selectionStart);
  const b = clamp(selectionEnd);
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  const next = text.slice(0, start) + insert + text.slice(end);
  if (next.length > maxLength) return null;
  return { text: next, caret: start + insert.length };
}

// ── tolerant normalizers for the contract §1 fields ──────────────────────────────────────────
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeAttention(value: unknown): ChatAutoCasebookAttention | undefined {
  const source = record(value);
  const autoReply = source.autoReply;
  if (autoReply !== "healthy" && autoReply !== "armed_unhealthy" && autoReply !== "off") return undefined;
  if (typeof source.needsHuman !== "boolean") return undefined;
  return { autoReply, needsHuman: source.needsHuman, reasons: strings(source.reasons) };
}

export function normalizeDefaultSuggestion(value: unknown): ChatAutoCasebookDefaultSuggestion | undefined {
  const source = record(value);
  const status = source.status;
  if (status !== "ready" && status !== "stale" && status !== "pending" && status !== "failed" && status !== "not_applicable") return undefined;
  const text = typeof source.text === "string" && source.text.trim().length > 0 ? source.text : null;
  // A "ready" suggestion with no text is unusable — present it as not ready rather than as empty text.
  if (status === "ready" && !text) return { status: "failed", text: null, generatedAtIso: null, modelId: null };
  return {
    status,
    // Old text is never carried on a non-ready status: it must not be presented as current.
    text: status === "ready" ? text : null,
    generatedAtIso: typeof source.generatedAtIso === "string" && source.generatedAtIso ? source.generatedAtIso : null,
    modelId: typeof source.modelId === "string" && source.modelId ? source.modelId : null,
  };
}

/** The per-row extras of ChatAutoCasebookSnapshotRow, normalized. Spread into the row. */
export function normalizeCasebookRowExtras(row: {
  attention?: unknown;
  allowedLinkTokens?: unknown;
  defaultSuggestion?: unknown;
}): {
  attention?: ChatAutoCasebookAttention;
  allowedLinkTokens?: string[];
  defaultSuggestion?: ChatAutoCasebookDefaultSuggestion;
} {
  return {
    attention: normalizeAttention(row.attention),
    allowedLinkTokens: Array.isArray(row.allowedLinkTokens) ? strings(row.allowedLinkTokens) : undefined,
    defaultSuggestion: normalizeDefaultSuggestion(row.defaultSuggestion),
  };
}

export function normalizePendingBreakdown(value: unknown): ChatAutoCasebookPendingBreakdown | undefined {
  const source = record(value);
  if (source.status !== "available" && source.status !== "unavailable") return undefined;
  const unclassified = record(source.unclassified);
  const byReason = record(unclassified.byReason);
  const managedCaseTotal = finiteNumber(source.managedCaseTotal);
  const closedCaseCount = finiteNumber(source.closedCaseCount);
  const total = finiteNumber(unclassified.total);
  const never = finiteNumber(byReason.never_classified);
  const unknown = finiteNumber(byReason.unknown_case);
  const stale = finiteNumber(byReason.stale_stamp);
  if (
    source.status !== "available"
    || managedCaseTotal === null || closedCaseCount === null || total === null
    || never === null || unknown === null || stale === null
  ) {
    // Malformed "available" data is treated as unavailable rather than rendered half-wrong.
    return {
      status: "unavailable",
      managedCaseTotal: 0,
      closedCaseCount: 0,
      unclassified: { total: 0, byReason: { never_classified: 0, unknown_case: 0, stale_stamp: 0 } },
    };
  }
  // Optional: only a plausible figure (never more than the never-classified bucket) is kept.
  const legacy = finiteNumber(unclassified.neverClassifiedBeforeStampLaunch);
  // Optional 답장 불필요 overlay: kept only when every part is a count and they add up to its total.
  const overlay = record(source.noReplyNeeded);
  const overlayTotal = finiteNumber(overlay.total);
  const overlayEntries = Object.entries(record(overlay.byCaseId)).map(([id, count]) => [id, finiteNumber(count)] as const);
  const noReplyNeeded = overlayTotal !== null
    && overlayEntries.every(([, count]) => count !== null)
    && overlayEntries.reduce((sum, [, count]) => sum + (count ?? 0), 0) === overlayTotal
    ? { total: overlayTotal, byCaseId: Object.fromEntries(overlayEntries) as Record<string, number> }
    : null;
  return {
    status: "available",
    managedCaseTotal,
    closedCaseCount,
    unclassified: {
      total,
      byReason: { never_classified: never, unknown_case: unknown, stale_stamp: stale },
      ...(legacy !== null && legacy <= never ? { neverClassifiedBeforeStampLaunch: legacy } : {}),
    },
    ...(noReplyNeeded ? { noReplyNeeded } : {}),
  };
}

export function normalizeReplyLinkCatalog(value: unknown): ChatAutoCasebookReplyLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const entries: ChatAutoCasebookReplyLink[] = [];
  for (const item of value) {
    const source = record(item);
    const token = typeof source.token === "string" ? source.token : "";
    if (!/^[A-Z][A-Z0-9_]*$/.test(token) || seen.has(token)) continue;
    seen.add(token);
    entries.push({
      token,
      label: typeof source.label === "string" ? source.label : token,
      url: typeof source.url === "string" ? source.url : "",
    });
  }
  return entries;
}

// ── 실제 건 보기 (2026-10-03): view helpers for the per-card item list ─────────────────────────────

/** Pseudo case ids the case-items callable accepts besides a real casebook case id. */
export const CASEBOOK_ITEMS_UNCLASSIFIED = "unclassified";
export const CASEBOOK_ITEMS_NO_REPLY_NEEDED = "no_reply_needed";
export const CASEBOOK_ITEMS_PAGE_SIZE = 25;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad2 = (value: number) => String(value).padStart(2, "0");

/** "10.02 13:26" in KST (fixed +9, no DST) — "" for a missing/invalid time. */
export function formatKstShort(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const kst = new Date(ms + KST_OFFSET_MS);
  return `${pad2(kst.getUTCMonth() + 1)}.${pad2(kst.getUTCDate())} ${pad2(kst.getUTCHours())}:${pad2(kst.getUTCMinutes())}`;
}

export function relativeKo(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.max(0, Math.floor((nowMs - ms) / 60_000));
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

/** "10.02 13:26 · 18시간 전" */
export function caseItemTimeLabel(iso: string | null | undefined, nowMs: number): string {
  const short = formatKstShort(iso);
  if (!short) return "시각 없음";
  return `${short} · ${relativeKo(iso, nowMs)}`;
}

/** Top hold reasons over the loaded rows, e.g. [{label:"증거 부족(0/80)", count:12}, ...]. */
export function topHoldReasons(rows: readonly Pick<ChatAutoCasebookCaseItemRow, "holdReasonLabel">[], limit = 3): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.holdReasonLabel) counts.set(row.holdReasonLabel, (counts.get(row.holdReasonLabel) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

/** "N건 · 최근 수신 10.02 13:26 · 보류 사유 상위: A 3, B 2". `more` = the list continues past the loaded rows. */
export function caseItemsGroupSummary(
  rows: readonly Pick<ChatAutoCasebookCaseItemRow, "holdReasonLabel" | "lastInboundAtIso">[],
  more: boolean,
): string {
  const latest = rows.map((row) => row.lastInboundAtIso).filter((iso): iso is string => Boolean(iso && Number.isFinite(Date.parse(iso))))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const parts = [`${rows.length}건${more ? "+" : ""}`];
  if (latest) parts.push(`최근 수신 ${formatKstShort(latest)}`);
  const reasons = topHoldReasons(rows);
  if (reasons.length > 0) parts.push(`보류 사유 상위: ${reasons.map((item) => `${item.label} ${item.count}`).join(", ")}`);
  return parts.join(" · ");
}

/** Short label for the case a 답장 불필요 / 종결 row was filed under; unknown ids fall back to the id. */
export function noReplyCaseLabel(caseId: string | null | undefined): string {
  if (!caseId) return "";
  return NO_REPLY_NEEDED_CASE_LABELS.find(([id]) => id === caseId)?.[1] ?? caseId;
}
