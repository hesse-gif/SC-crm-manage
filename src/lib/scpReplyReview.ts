// /chat/auto 검토 보드 (2026-10-05) — client-side pure helpers: draft lint (shared by the system
// default reply and the template library), cross-page row merge, live counts and URL state.
// Review-only: nothing here sends, schedules or saves.
import type { ChatAutoReviewBoardRow, ChatAutoReviewBucket } from "@/lib/data";

export const SCP_REQUIRED_SIGNATURE = "Super Creator Partners Team";
const LINK_TOKENS = new Set(["APPLY_LINK", "GUIDE_LINK", "SUBMIT_LINK", "SAMPLE_LINK", "GUIDELINE_AMOUNT"]);
const GUIDE_URL = /https?:\/\/creator\.supercent\.io\/[^\s)]*view=guide/i;
const APPLY_URL = /https?:\/\/creator\.supercent\.io\/apply\b/i;

export type ScpLintCheck = { id: string; label: string; ok: boolean; detail: string | null };

/** Draft review lint. Every check is reported separately; any failure = "요건 미충족". */
export function lintScpReplyDraft(text: string, inboundQuestionCount: number | null): ScpLintCheck[] {
  const body = text.replace(/\r\n?/g, "\n");
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  const lastLine = lines.at(-1) ?? "";
  const tokens = [...body.matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g)].map((match) => match[1]);
  const unknownTokens = [...new Set(tokens.filter((token) => !LINK_TOKENS.has(token)))];
  const otherPlaceholders = body.match(/\[(?:name|creator|channel|amount|date|link)[^\]]*\]|<[A-Z_]{3,}>/gi) ?? [];
  const withoutUrls = body.replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, "").replace(/\{\{[^}]*\}\}/g, "");
  const nonEnglish = withoutUrls.match(/[^\x00-\x7F‘’“”–—…]/g) ?? [];
  const amountHits = [
    ...(withoutUrls.match(/[$€£₩¥]\s?\d|\d[\d,.]*\s?(usd|krw|eur|dollars?|won|원|만원)\b/gi) ?? []),
    ...(tokens.includes("GUIDELINE_AMOUNT") ? ["{{GUIDELINE_AMOUNT}}"] : []),
    ...(withoutUrls.match(/\b\d+(?:[.,]\d+)?\s?%|\b\d{2,}\b/g) ?? []),
    // Any number (even one digit) next to a rate/price/payment word.
    ...(withoutUrls.match(/\b\d+(?:[.,]\d+)?\s*(?:per\s+(?:view|video|post|\d)|cpm|usd|fee|dollars?)\b|\b(?:rate|price|fee|pay|paid|payment|cpm|reward)\b[^.\n]{0,20}?\b\d+(?:[.,]\d+)?\b/gi) ?? []),
  ];
  const forbidden = withoutUrls.match(/\b(outage|issue|error|bug)s?\b|장애/gi) ?? [];
  const promises = withoutUrls.match(/\bguarantee[ds]?\b|\bwill pay\b|\bpromise[ds]?\b|\bwe will (?:definitely|surely)\b|\bexceptions?\b(?! for)|\bspecial (?:arrangement|deal|rate|terms)\b|\bwe can offer\b/gi) ?? [];
  const approvalClaim = withoutUrls.match(/no separate approval|you (?:are|have been|were) approved|approval (?:is|was) (?:granted|complete)/gi) ?? [];
  const hasGuide = tokens.includes("GUIDE_LINK") || GUIDE_URL.test(body);
  const hasApply = tokens.some((token) => token === "APPLY_LINK" || token === "SUBMIT_LINK") || APPLY_URL.test(body);
  return [
    { id: "english_only", label: "영어만 사용", ok: nonEnglish.length === 0, detail: nonEnglish.length ? `영어 외 문자 ${nonEnglish.length}자` : null },
    {
      id: "delay_apology",
      label: "답장 지연 사과",
      ok: /sorry for the (?:slow|late|delayed) (?:reply|response)|sorry for the delay|apologi[sz]e for the (?:delay|late|slow)/i.test(body),
      detail: null,
    },
    { id: "guide_link", label: "가이드 링크", ok: hasGuide, detail: null },
    { id: "guide_chatbot", label: "Guide 탭 챗봇 안내", ok: /chat\s?bot/i.test(body) && /guide tab/i.test(body), detail: null },
    { id: "apply_or_support_link", label: "지원·안내 링크", ok: hasApply || hasGuide, detail: hasApply ? "지원 링크" : hasGuide ? "가이드 링크로 안내" : null },
    { id: "signature", label: `서명 "${SCP_REQUIRED_SIGNATURE}"`, ok: lastLine === SCP_REQUIRED_SIGNATURE, detail: lastLine && lastLine !== SCP_REQUIRED_SIGNATURE ? `현재 서명: ${lastLine.slice(0, 40)}` : null },
    { id: "no_forbidden_words", label: "금지어 없음 (outage·issue·error·bug·장애)", ok: forbidden.length === 0, detail: forbidden.length ? [...new Set(forbidden.map((hit) => hit.toLowerCase()))].join(", ") : null },
    { id: "no_amounts", label: "금액·숫자 없음", ok: amountHits.length === 0, detail: amountHits.length ? [...new Set(amountHits)].slice(0, 4).join(", ") : null },
    { id: "no_promises", label: "보장·예외·약속 표현 없음", ok: promises.length === 0, detail: promises.length ? [...new Set(promises.map((hit) => hit.toLowerCase()))].join(", ") : null },
    { id: "no_approval_claim", label: "승인 여부 단정 없음", ok: approvalClaim.length === 0, detail: approvalClaim[0] ?? null },
    {
      id: "placeholders_resolved",
      label: "치환 안 된 자리표시 없음",
      ok: unknownTokens.length === 0 && otherPlaceholders.length === 0,
      detail: [...unknownTokens.map((token) => `{{${token}}}`), ...otherPlaceholders].join(", ") || (tokens.length ? "링크 토큰은 발송 시 치환" : null),
    },
    {
      id: "single_question_inbound",
      label: "받은 메일 질문 1개 이하",
      ok: inboundQuestionCount !== null && inboundQuestionCount <= 1,
      detail: inboundQuestionCount === null ? "원문 미확보 · 확인 불가" : inboundQuestionCount > 1 ? `질문 ${inboundQuestionCount}개` : null,
    },
  ];
}

/** What a passing lint means — never a policy/fact/recipient/send approval. */
export const SCP_LINT_PASS_COPY = "기계 검사에서 해당 표현 미검출";
export const SCP_LINT_FAIL_COPY = "요건 미충족";
export const SCP_LINT_LIMITS = "문자로 쓴 금액(two dollars), 바꿔 말한 예외·약속, 영어가 섞인 다른 언어, 맥락에 따른 사실 오류는 검사가 놓칠 수 있어요.";

export function lintPassed(checks: readonly ScpLintCheck[]): boolean {
  return checks.length > 0 && checks.every((check) => check.ok);
}

/** The only shape a "대화 열기" link may take — never a bare /chat. */
export function chatConversationHref(conversationId: string | null | undefined): string | null {
  const id = typeof conversationId === "string" ? conversationId.trim() : "";
  return id ? `/chat?conversationId=${encodeURIComponent(id)}` : null;
}

// ── cross-page merge ───────────────────────────────────────────────────────────────────────────────

function protectMerged(row: ChatAutoReviewBoardRow, reasons: string[]): ChatAutoReviewBoardRow {
  const label = `보호 대상(${reasons.join("·")}) · 초안 없음`;
  const demote = row.nextAction === "final_safety_check" || row.nextAction.endsWith("_draft_review");
  return {
    ...row,
    protected: true,
    protectedReasons: reasons,
    sendBatch: row.sendBatch.bucket === "final_safety_wait" ? { ...row.sendBatch, bucket: "operator_judgment" } : row.sendBatch,
    nextAction: demote ? "operator_judgment" : row.nextAction,
    nextActionLabel: demote ? "운영자 판단" : row.nextActionLabel,
    draft: { ...row.draft, status: "not_allowed", draftAllowed: false, reason: label, label, caseId: null, text: null, sourceLabel: null, basisLabel: null, suggestedTemplateId: null },
    summary: { ...row.summary, value: null, status: "confirmed", reason: "protected_or_ai_off", sourceLabel: "보호·운영자 담당 대화라 표시하지 않음" },
  };
}

/**
 * Merges a newly loaded page into the rows already shown, by the server's opaque rowKey (a verified
 * sender's key repeats across pages; unverified rows are keyed per conversation). The newest inbound
 * stays the representative; protection is group-level — any protected member protects the row.
 */
export function mergeReviewBoardRows(existing: readonly ChatAutoReviewBoardRow[], incoming: readonly ChatAutoReviewBoardRow[]): ChatAutoReviewBoardRow[] {
  const byKey = new Map<string, ChatAutoReviewBoardRow>();
  const order: string[] = [];
  for (const row of [...existing, ...incoming]) {
    const current = byKey.get(row.rowKey);
    if (!current) {
      byKey.set(row.rowKey, row);
      order.push(row.rowKey);
      continue;
    }
    const newer = (row.latestInboundAtIso ?? "") > (current.latestInboundAtIso ?? "") ? row : current;
    const seen = new Set<string>();
    const conversations = [...current.conversations, ...row.conversations]
      .filter((item) => (seen.has(item.conversationId) ? false : (seen.add(item.conversationId), true)))
      .sort((left, right) => (right.latestInboundAtIso ?? "").localeCompare(left.latestInboundAtIso ?? ""));
    const reasons = [...new Set([...current.protectedReasons, ...row.protectedReasons])];
    let merged: ChatAutoReviewBoardRow = {
      ...newer,
      conversations,
      grouping: { ...newer.grouping, label: conversations.length > 1 ? `확인된 발신자 · 대화 ${conversations.length}개 묶음` : newer.grouping.label },
      evidenceCaseIds: [...new Set([...current.evidenceCaseIds, ...row.evidenceCaseIds, ...[current.primaryCaseId, row.primaryCaseId].filter((id): id is string => Boolean(id))])]
        .filter((id) => id !== newer.primaryCaseId),
      protectedReasons: reasons,
      claims: [...new Set([...current.claims, ...row.claims])],
      newInboundSinceJudgment: current.newInboundSinceJudgment || row.newInboundSinceJudgment || conversations.length > 1,
    };
    if (reasons.length > 0 && !newer.protected) merged = protectMerged(merged, reasons);
    byKey.set(row.rowKey, merged);
  }
  return order.map((key) => byKey.get(key)!);
}

export type ReviewBoardCounts = {
  /** Rows per tab — rows mix two units (verified address groups and single unverified conversations). */
  rows: Record<"all" | ChatAutoReviewBucket, number>;
  verifiedGroups: Record<"all" | ChatAutoReviewBucket, number>;
  unverifiedConversations: Record<"all" | ChatAutoReviewBucket, number>;
  conversations: number;
  protectedConversations: number;
};

/** Live counts over the loaded rows. Never presented as unique people: two units are kept apart. */
export function reviewBoardCounts(rows: readonly ChatAutoReviewBoardRow[]): ReviewBoardCounts {
  const empty = () => ({ all: 0, excluded: 0, operator_judgment: 0, final_safety_wait: 0 });
  const counts: ReviewBoardCounts = { rows: empty(), verifiedGroups: empty(), unverifiedConversations: empty(), conversations: 0, protectedConversations: 0 };
  for (const row of rows) {
    const bucket = row.sendBatch.bucket;
    counts.rows.all += 1;
    counts.rows[bucket] += 1;
    const unit = row.grouping.kind === "verified_sender" ? counts.verifiedGroups : counts.unverifiedConversations;
    unit.all += 1;
    unit[bucket] += 1;
    counts.conversations += row.conversations.length;
    counts.protectedConversations += row.protected ? row.conversations.length : row.conversations.filter((item) => item.protected).length;
  }
  return counts;
}

// ── URL state (?rb=tab&rbOpen=rowKey&rbTpl=template&rbY=scroll) ────────────────────────────────────

export type ReviewBoardTab = "all" | ChatAutoReviewBucket;
export const REVIEW_BOARD_TABS: readonly ReviewBoardTab[] = ["all", "excluded", "operator_judgment", "final_safety_wait"];
/** template: null = unset (use the recommendation), "none" = explicitly nothing selected. */
export type ReviewBoardUrlState = { tab: ReviewBoardTab; open: string | null; template: string | null; scrollY: number | null; pages: number };
export const REVIEW_BOARD_MAX_RESTORE_PAGES = 8;

export function parseReviewBoardUrlState(params: Pick<URLSearchParams, "get">): ReviewBoardUrlState {
  const tab = params.get("rb");
  const open = params.get("rbOpen");
  const template = params.get("rbTpl");
  const rawScroll = params.get("rbY");
  const scroll = rawScroll === null || rawScroll === "" ? Number.NaN : Number(rawScroll);
  const pages = Number(params.get("rbPages"));
  return {
    tab: REVIEW_BOARD_TABS.includes(tab as ReviewBoardTab) ? (tab as ReviewBoardTab) : "all",
    open: open && open.length <= 120 ? open : null,
    template: template && /^[A-Za-z_]{1,20}$/.test(template) ? template : null,
    // 0 is a real position (top) and must round-trip; absent = null.
    scrollY: Number.isFinite(scroll) && scroll >= 0 ? Math.round(scroll) : null,
    pages: Number.isInteger(pages) && pages > 1 ? Math.min(pages, REVIEW_BOARD_MAX_RESTORE_PAGES) : 1,
  };
}

/** Which template a row shows: "none" = nothing; null/unknown = the recommendation. */
export function resolveTemplateChoice<T extends { id: string }>(param: string | null, recommended: T | null, find: (id: string) => T | null): T | null {
  if (param === "none") return null;
  return (param ? find(param) : null) ?? recommended;
}

/** Returns the query string with only the board keys replaced; unrelated params are preserved. */
export function buildReviewBoardSearch(current: string, next: Partial<ReviewBoardUrlState>): string {
  const params = new URLSearchParams(current);
  const set = (key: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === "") params.delete(key);
    else params.set(key, value);
  };
  if ("tab" in next) set("rb", next.tab === "all" ? null : next.tab);
  if ("open" in next) set("rbOpen", next.open ?? null);
  if ("template" in next) set("rbTpl", next.template ?? null);
  if ("scrollY" in next) set("rbY", typeof next.scrollY === "number" && next.scrollY >= 0 ? String(next.scrollY) : null);
  if ("pages" in next) set("rbPages", next.pages && next.pages > 1 ? String(next.pages) : null);
  const text = params.toString();
  return text ? `?${text}` : "";
}
