// /chat/auto 검토 보드 (2026-10-05) — PURE read model. No Firestore, no Gateway/model call, no writes.
//
// The callable (chatAutoReviewBoard.ts) gathers read-only facts per conversation and hands them here;
// everything that decides what the operator sees is a pure function so it can be tested with
// synthetic data. Three row states are modelled INDEPENDENTLY and never collapsed:
//   (a) sendBatch — is this conversation part of THIS automated/agent-proxy send batch? Only about the
//       automated batch: it never hides or blocks the human operator's existing manual paths.
//   (b) question  — does the latest inbound still carry an unresolved substantive question? A row
//       excluded for a recent real reply can still have an unresolved question.
//   (c) draft     — is there an existing system default reply to REVIEW? A draft never means sendable:
//       this board is review-only ("전송 불가(검토 전용)"). Draft lint runs client-side
//       (src/lib/scpReplyReview.ts) so the system default and the template library share one lint.
// Unknown-first: every derived fact carries a status (confirmed / partial / unknown); the board never
// infers that a reply, a registration or an original body exists from a missing field.
//
// Protection is decided from METADATA ONLY (assessReviewProtection) before the callable reads any
// inbound body: AI-off and protected conversations — and every conversation of the same address as
// one — are never body-read, summarised or drafted by the board.
import { CHAT_CASEBOOK } from "./chatCasebook";

export type ReviewFieldStatus = "confirmed" | "partial" | "unknown";
export type ReviewDerived<T> = { status: ReviewFieldStatus; value: T; reason: string | null };

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// ── outbound classification ──────────────────────────────────────────────────────────────────────

export type ReviewOutboundKind = "real_reply" | "possible_reply" | "outreach" | "nudge" | "system" | "not_sent" | "unknown";

export const REVIEW_OUTBOUND_KIND_LABELS: Record<ReviewOutboundKind, string> = {
  real_reply: "실제 회신",
  possible_reply: "회신 가능성(미확인)",
  outreach: "첫 연락·캠페인",
  nudge: "독려",
  system: "자동 안내",
  not_sent: "미발송",
  unknown: "종류 미확인",
};

/** Outbound kinds that settle "what was this mail" with certainty (anything else keeps the lookup partial). */
const SETTLED_KINDS: ReadonlySet<ReviewOutboundKind> = new Set(["real_reply", "outreach", "nudge", "system", "not_sent"]);
const NON_CREATOR_THREAD_PREFIX = /^(campaign|program|onboarding|application|nudge|worker|system|notification|scp[_-]?result|uid)[-_]/i;
const NUDGE_PATTERN = /nudge|reminder|독려/i;
const SYSTEM_PATTERN = /uid[\s_-]*guide|video[\s_-]*(result|approv|reject)|result[\s_-]*mail|scp[_-]?result|onboarding|application[\s_-]*(received|result)|welcome|notification|worker/i;
const REPLY_SUBJECT = /^\s*(re|aw|sv|답장|회신)\s*[:：]/i;
const SENT_STATES = new Set(["sent", "delivered", "opened", "clicked", "replied"]);

/**
 * Classifies ONE outbound message_sources record from metadata only (never the body).
 * `real_reply` is CONFIRMED only for a sendEmail send that replied to an inbound on a creator thread
 * (replyToMessageRef set, conversation present and not an outreach/nudge/worker/notification thread).
 * A Sent-folder import with a reply subject / In-Reply-To is only `possible_reply`: auto-replies and
 * notifications thread too.
 */
export function classifyReviewOutbound(source: Record<string, unknown>): ReviewOutboundKind {
  if (str(source.direction) && str(source.direction) !== "outbound") return "unknown";
  const deliveryState = str(source.deliveryState);
  if (source.dryRun === true || deliveryState === "mock_sent") return "not_sent";
  if (deliveryState && !SENT_STATES.has(deliveryState)) return "not_sent";
  const origin = str(source.source);
  const mailType = str(source.mailType);
  const kind = str(source.kind);
  const conversationId = str(source.conversationId);
  const subject = str(source.subject);
  const tags = `${origin} ${mailType} ${kind} ${conversationId}`;
  if (NUDGE_PATTERN.test(tags)) return "nudge";
  if (origin === "external_sent_mail_import") {
    if (SYSTEM_PATTERN.test(`${mailType} ${subject}`)) return "system";
    if (kind === "manual_reply" || REPLY_SUBJECT.test(subject) || str(source.inReplyTo) || str(source.inReplyToHash)) return "possible_reply";
    return "unknown";
  }
  if (origin === "sendEmail") {
    if (!conversationId) return "unknown";
    if (NON_CREATOR_THREAD_PREFIX.test(conversationId)) return SYSTEM_PATTERN.test(conversationId) ? "system" : "outreach";
    if (str(source.replyToMessageRef)) return "real_reply";
    return "unknown";
  }
  if (SYSTEM_PATTERN.test(tags)) return "system";
  if (str(source.campaignId) || str(source.targetId) || str(source.campaignCandidateRef) || NON_CREATOR_THREAD_PREFIX.test(conversationId)) return "outreach";
  return "unknown";
}

// ── inbound text signals (computed server-side from the body; only derived values leave) ──────────

function unquotedText(body: string): string {
  const lines: string[] = [];
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*On .+wrote:\s*$/i.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^\s*From:\s/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

export function countInboundQuestions(body: string | null | undefined): number {
  if (!body) return 0;
  return (unquotedText(body).match(/[?？]+/g) ?? []).length;
}

function hangulRatio(text: string): number {
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, "");
  if (!letters) return 0;
  const hangul = (letters.match(/[가-힣ㄱ-ㆎ]/g) ?? []).length;
  return hangul / letters.length;
}

export type ReviewSummarySource = "body" | "summary_fallback" | "unverified" | "none";

/**
 * Where the inbound text the board knows about comes from. Never upgrades a summary to an original:
 *   - "summary_fallback": no body, or the stored body is exactly the Korean summary → 요약본
 *   - "unverified": a short, mostly-Hangul body — could be a genuine Korean inquiry or a stored
 *     summary; the board cannot tell → 본문 출처 미확인 (never "원문 미확보", never "원문")
 *   - "body": a real body distinct from the summary
 */
export function inboundSummarySource(body: string | null | undefined, summaryKr: string | null | undefined): ReviewSummarySource {
  const cleanBody = str(body);
  const cleanSummary = str(summaryKr);
  if (!cleanBody) return cleanSummary ? "summary_fallback" : "none";
  if (cleanSummary && cleanBody === cleanSummary) return "summary_fallback";
  if (cleanBody.length <= 300 && hangulRatio(cleanBody) >= 0.6) return "unverified";
  return "body";
}

export const REVIEW_SUMMARY_SOURCE_LABELS: Record<ReviewSummarySource, string> = {
  body: "AI 요약 · 원문은 Chat 원문 보기에서",
  summary_fallback: "요약본 · 원문 미확보",
  unverified: "본문 출처 미확인",
  none: "요약 없음",
};

export type ReviewShortInboundKind = "greeting" | "closing" | "other";

const GREETING_TOKENS = new Set(["hi", "hii", "hiii", "hello", "helloo", "hey", "heyy", "dear", "greetings", "good", "morning", "afternoon", "evening", "day", "there", "team", "sir", "madam", "all", "everyone", "hola", "bonjour", "namaste", "안녕하세요", "안녕"]);
const THINKING_PHRASE = /^(?:i'?m|i am)?\s*(?:still\s+)?(?:thinking about it|considering it|let me think(?: about it)?|will think about it)$/;
const CLOSING_TOKENS = new Set([
  "thanks", "thank", "you", "thx", "ty", "ok", "okay", "okk", "got", "it", "noted", "sure", "great", "perfect", "cool", "understood",
  "will", "do", "received", "appreciate", "appreciated", "so", "much", "a", "lot", "very", "for", "the", "info", "information",
  "reply", "response", "your", "help", "kind", "regards", "best", "cheers", "awesome", "nice", "alright", "yes", "yep", "yeah",
  "감사합니다", "감사해요", "감사", "고마워요", "고맙습니다", "네", "넵", "알겠습니다", "확인했습니다",
]);
const EXTRA_REQUEST = /\b(brief|rights?|usage|license|tax|invoice|bank|paypal|payment|pay ?out|contract|timeline|deadline|schedule|when|send|share|confirm|account|exclusiv\w*|deliver\w*|please|can you|could you|need|want|tell me|let me know|guide|apply|submit|explain|clarify|check|update|help)\b/i;
const OTHER_TOPIC = /\b(reject\w*|review\w*|approv\w*|login|password|delete|privacy|refund|settlement|paid|unpaid|missing|problem|wrong|why|how|what|where|which)\b/i;

const REQUEST_CONSTRUCTION = /\b(will|would|can|could|should|do|does|did|is|are|may)\s+(you|u|your|someone|anyone|we|i)\b|\b(please|pls|plz|let me know|help me)\b/i;

// Imperatives at the start of the text or right after punctuation ("..., reply with your decision").
const IMPERATIVE_REQUEST = /(^|[.,;:!\n]\s*)(reply|respond|answer|confirm|decide|send|tell|share|explain|clarify|check|update|advise|let (me|us) know|get back)\b/i;

/** One shared guard for every "no reply needed" classifier (closing, greeting, fixed-fee-only). */
export function hasRequestOrQuestion(text: string): boolean {
  return /[?？]/.test(text) || REQUEST_CONSTRUCTION.test(text) || IMPERATIVE_REQUEST.test(text);
}

// A sign-off line: "Best regards," / "Regards" / "Cheers" / "Sincerely", or "Thanks," / "Thank you,"
// WITH a trailing comma (a bare "Thanks" is the message itself, not a sign-off).
const SIGN_OFF_LINE = /^(?:(?:best|kind|warm)?\s*regards|best|cheers|sincerely)[,!.]?$|^(?:thanks|thank you|many thanks),$/i;

function meaningfulLines(body: string): string[] {
  // No signature inference: an unknown trailing line (a "name") cannot be proven to be a signature, so
  // it is kept and must itself pass the classifier. Only explicit sign-off phrase lines are dropped.
  return unquotedText(body).split("\n").map((line) => line.trim()).filter((line) => line && !SIGN_OFF_LINE.test(line));
}

function tokensOf(text: string): string[] {
  return text.toLowerCase().replace(/[\p{P}\p{S}\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, " ").split(/\s+/).filter(Boolean);
}

/**
 * Short-inbound shape from the REAL body (never from labels), FULL match only:
 *   - greeting: the whole message (quotes/signature stripped) is greeting tokens (+ at most one
 *     capitalised name) and optionally a bare "thinking about it" — "Hello, please send a brief" is not.
 *   - closing: the whole message is thanks/ok/ack tokens or emoji only, with no question mark and no
 *     other word — "Thanks, please send the contract" is not.
 *   - other: everything else.
 */
export function classifyShortInbound(body: string | null | undefined): ReviewShortInboundKind {
  if (!body) return "other";
  const lines = meaningfulLines(body);
  const text = lines.join(" ").trim();
  if (!text) return "other";
  // Questions and request constructions ("Will you help", "please send") are never greeting/closing.
  if (hasRequestOrQuestion(text)) return "other";
  const tokens = tokensOf(text);
  if (tokens.length === 0) return "closing"; // emoji / punctuation only
  if (tokens.length > 12) return "other";
  // greeting (+ optional thinking phrase), full match
  const lowered = text.toLowerCase().replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "").replace(/[!.,~]+/g, " ").replace(/\s+/g, " ").trim();
  const thinking = lowered.match(/(?:i'?m|i am)?\s*(?:still\s+)?(?:thinking about it|considering it|let me think(?: about it)?|will think about it)$/);
  const head = thinking ? lowered.slice(0, thinking.index).trim() : lowered;
  const headTokens = tokensOf(head);
  const originalWords = text.split(/\s+/);
  const capitalised = new Set(originalWords.filter((word) => /^[\p{Lu}]/u.test(word)).map((word) => word.toLowerCase().replace(/[\p{P}\p{S}]/gu, "")));
  let nameBudget = 1;
  const greetingOk = (headTokens.length > 0 || Boolean(thinking))
    && headTokens.every((token) => GREETING_TOKENS.has(token) || (capitalised.has(token) && nameBudget-- > 0))
    && (headTokens.some((token) => GREETING_TOKENS.has(token)) || (Boolean(thinking) && headTokens.length === 0));
  if (greetingOk && (thinking || THINKING_PHRASE.test(head) || headTokens.length > 0)) return "greeting";
  if (tokens.every((token) => CLOSING_TOKENS.has(token) || GREETING_TOKENS.has(token)) && tokens.some((token) => CLOSING_TOKENS.has(token))) return "closing";
  return "other";
}

// ── fixed-fee-only: conservative whole-message proof ──────────────────────────────────────────────
// Board-side only. A message is "a fixed-fee offer and nothing else" ONLY when, after stripping
// greetings, sign-off/signature and quoted history, EVERY clause matches one of a few pure
// fee-statement shapes and no request / question / condition / negotiation marker appears anywhere.
// Anything not positively matched → not fee-only → operator judgment.
const FEE_FORBIDDEN_MARKERS = /\b(offer me|pay me|give me|send me|would like|like to|want|wants|wish|ask|asking|request|requesting|seek|would|could|can|will you|if|unless|only|include|including|require|required|need|needs|please|pls|deadline|date|by|rights?|usage|license|exclusiv\w*|brief|contract|invoice|payment|pay|paid upfront|upfront|advance|bank|paypal|tax|negotiat\w*|discount|budget|minimum|plus|extra|bonus|depend\w*|depending|between|range|or more|at least|reply|respond|answer|confirm|decide|decision|let (me|us) know|explain|reject\w*|review)\b/i;
const AMOUNT = /(?:[$€£₩]\s?)?\d+(?:,\d{3})*(?:\.\d+)?(?:k\b)?(?:\s?(?:usd|dollars?|eur|euros?|krw|won)\b)?/gi;
const UNIT = "(?:sponsored |dedicated )?(?:video|videos|post|posts|short|shorts|reel|reels|integration|integrations)";
const PER = `(?:per|for each|for a|for an|for one|a|an) ${UNIT}`;
const FEE_STATEMENT_SHAPES: readonly RegExp[] = [
  // my/our (standard|usual|fixed|flat|sponsorship) rate|fee|price [for a video] is <amt> [per video]
  new RegExp(`^(?:my|our)(?: (?:standard|usual|fixed|flat|sponsorship|sponsored))* (?:rate|fee|price|charge|cost)(?: for (?:a |an |one |each )?${UNIT})? (?:is|are|:) <amt>(?: ${PER})?$`),
  // I/we charge <amt> [per video]
  new RegExp(`^(?:i|we) charge <amt>(?: ${PER})?$`),
  // <amt> per video
  new RegExp(`^<amt> ${PER}$`),
  // we offer a sponsored video at a flat fee of <amt> [per video]
  new RegExp(`^(?:i|we) offer (?:a |an )?${UNIT} (?:at|for) (?:a )?(?:(?:flat|fixed|standard) )?(?:(?:fee|rate|price) )?(?:of )?<amt>(?: ${PER})?$`),
];

function isPleasantryClause(clause: string): boolean {
  const tokens = tokensOf(clause);
  return tokens.length === 0 || tokens.every((token) => GREETING_TOKENS.has(token) || CLOSING_TOKENS.has(token));
}

/** A fixed-fee/sponsorship offer statement and NOTHING else — conservative positive proof on the real body. */
export function isFixedFeeOfferOnly(body: string | null | undefined): boolean {
  if (!body) return false;
  // No signature inference here: only quoted history and explicit sign-off phrase lines are dropped;
  // every other line (a trailing name included) must itself be proven a fee statement or pleasantry.
  const text = unquotedText(body).split("\n").map((line) => line.trim()).filter((line) => line && !SIGN_OFF_LINE.test(line)).join("\n");
  if (!text || hasRequestOrQuestion(text) || FEE_FORBIDDEN_MARKERS.test(text)) return false;
  const clauses = text
    .split(/(?<=[.!。])\s+|\n+|;|\s+and\s+|\s+but\s+/i)
    .map((clause) => clause.trim().replace(/^[,:\-\s]+|[.!,:\s]+$/g, ""))
    .filter(Boolean);
  let statements = 0;
  for (const clause of clauses) {
    if (isPleasantryClause(clause)) continue;
    const normalized = clause.toLowerCase().replace(AMOUNT, "<amt>").replace(/\s+/g, " ").trim();
    if (!FEE_STATEMENT_SHAPES.some((shape) => shape.test(normalized))) return false;
    statements += 1;
  }
  return statements > 0;
}

// ── protection (metadata only — decided BEFORE any body read) ─────────────────────────────────────

export type ReviewProtectionInput = {
  aiActive: boolean | null;
  primaryCaseId: string | null;
  /** Every other case id stamped on the conversation (raw/stale autoCaseId, caseCandidates) — a
   *  protected case anywhere protects, even when the stamp is "stale" because we replied last. */
  extraCaseIds?: readonly string[];
  intentLabels: readonly string[];
  /** autoReplyBlockedReason / humanGate reason codes (gate texts), matched against a finite set. */
  gateReasonText: string;
  suppressionBlocked: boolean;
  /** Sender binding of the latest inbound, null when not linked / not read. */
  binding: { status: string; inboundSenderHash: string | null; reasonCode: string | null } | null;
  inboundSenderHash: string | null;
};

const PROTECTED_CASES: Record<string, string> = {
  opt_out_or_legal: "수신거부·법적",
  settlement_dispute: "정산 이의",
  discontinue_notice: "참여 중단·거절",
  access_concern: "계정 접근 문제",
};
const PROTECTED_INTENTS: Record<string, string> = {
  discontinue: "참여 중단·거절",
  complaint: "불만·이의 제기",
};
const PROTECTED_GATE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/opt-?out|unsubscribe|legal|lawyer|lawsuit|수신거부|법적/i, "수신거부·법적"],
  [/privacy|gdpr|personal data|delet(e|ion)|개인정보|삭제/i, "개인정보·삭제 요청"],
  [/reject|rejection|appeal|re-?review|반려|재심/i, "반려 이의"],
  [/login|log in|password|account access|locked|로그인|접근/i, "계정 접근 문제"],
  [/settlement|missing payment|underpaid|정산/i, "정산 이의"],
  [/impersonat|sender_not_creator|사칭/i, "발신자 불일치"],
];

export function senderIdentity(input: Pick<ReviewProtectionInput, "binding" | "inboundSenderHash">): {
  status: "verified" | "review_required" | "missing";
  fromMatches: boolean;
} {
  const binding = input.binding;
  if (!binding || !str(binding.status)) return { status: "missing", fromMatches: false };
  if (binding.status !== "verified") return { status: "review_required", fromMatches: false };
  const bindingHash = str(binding.inboundSenderHash);
  const actualHash = str(input.inboundSenderHash);
  // Both hashes must be present and equal — a missing hash is never a match.
  return { status: "verified", fromMatches: Boolean(bindingHash) && Boolean(actualHash) && bindingHash === actualHash };
}

/** Returns the protection reasons (empty = not protected). AI off is a protection reason too. */
export function assessReviewProtection(input: ReviewProtectionInput): string[] {
  const reasons = new Set<string>();
  if (input.aiActive === false) reasons.add("운영자 담당 (AI off)");
  if (input.suppressionBlocked) reasons.add("수신 억제");
  for (const caseId of [input.primaryCaseId, ...(input.extraCaseIds ?? [])]) {
    if (caseId && PROTECTED_CASES[caseId]) reasons.add(PROTECTED_CASES[caseId]);
  }
  for (const label of input.intentLabels) if (PROTECTED_INTENTS[label]) reasons.add(PROTECTED_INTENTS[label]);
  for (const [pattern, label] of PROTECTED_GATE_RULES) if (input.gateReasonText && pattern.test(input.gateReasonText)) reasons.add(label);
  const identity = senderIdentity(input);
  if (identity.status === "review_required" || (identity.status === "verified" && !identity.fromMatches) || str(input.binding?.reasonCode).includes("sender_not_creator")) {
    reasons.add("발신자 불일치");
  }
  return [...reasons];
}

// ── per-conversation evaluation ──────────────────────────────────────────────────────────────────

export type ReviewSendBatchBucket = "excluded" | "operator_judgment" | "final_safety_wait";
export type ReviewExclusionReason =
  | "recent_real_reply"
  | "queued"
  | "suppressed"
  | "ai_off"
  | "we_replied_last"
  | "not_pending"
  | "org_automation_off"
  | "vendor_or_auto"
  | "closing_or_no_question"
  | "fixed_fee_proposal_only"
  | "sender_mismatch"
  | "discontinued";

export const REVIEW_EXCLUSION_LABELS: Record<ReviewExclusionReason, string> = {
  recent_real_reply: "최근 14일 실제 회신",
  queued: "발송 대기열에 있음",
  suppressed: "수신 억제",
  ai_off: "운영자 담당 (AI off)",
  we_replied_last: "마지막 메시지가 우리 쪽",
  not_pending: "대기 아님(종결·처리됨)",
  org_automation_off: "자동화 꺼짐(조직)",
  vendor_or_auto: "업체·자동 메일",
  closing_or_no_question: "종결 인사 · 질문 없음",
  fixed_fee_proposal_only: "고정 단가 제안만 · 답장 없음",
  sender_mismatch: "발신자 확인 필요",
  discontinued: "참여 중단 알림",
};

export type ReviewNextAction =
  | "operator_owned_ai_off"
  | "suppressed"
  | "recent_real_reply_found"
  | "queued"
  | "we_replied_last"
  | "not_pending"
  | "org_automation_off"
  | "exclude_no_reply"
  | "vendor_auto"
  | "closing_no_reply"
  | "sender_check"
  | "discontinued"
  | "original_missing_judgment"
  | "personal_review_status_check"
  | "operator_judgment"
  | "policy_guide_draft_review"
  | "participation_guide_draft_review"
  | "reward_guide_draft_review"
  | "final_safety_check";

export const REVIEW_NEXT_ACTION_LABELS: Record<ReviewNextAction, string> = {
  operator_owned_ai_off: "운영자 담당 (AI off)",
  suppressed: "억제 · 발송 안 함",
  recent_real_reply_found: "최근 실제 회신 확인됨",
  queued: "대기열 있음",
  we_replied_last: "우리가 마지막으로 답함",
  not_pending: "대기 아님 · 처리됨",
  org_automation_off: "자동화 꺼짐(조직)",
  exclude_no_reply: "답장 없이 제외",
  vendor_auto: "업체·자동 메일 · 답장 없음",
  closing_no_reply: "종결 인사 · 답장 없음",
  sender_check: "발신자 확인",
  discontinued: "참여 중단 · 운영자 확인",
  original_missing_judgment: "원문 미확보 · 사람 판단",
  personal_review_status_check: "개인 심사 상태 확인(운영자)",
  operator_judgment: "운영자 판단",
  policy_guide_draft_review: "정책 안내 초안 검토",
  participation_guide_draft_review: "참여 안내 초안 검토",
  reward_guide_draft_review: "보상 가이드 안내 초안 검토",
  final_safety_check: "마지막 안전 확인",
};

const REVIEW_NEXT_ACTION_HANDLING: Record<ReviewNextAction, string> = {
  operator_owned_ai_off: "운영자가 직접 응대하는 대화입니다. 보드에서는 열람·초안을 만들지 않습니다.",
  suppressed: "수신 억제 대상이라 이번 자동 발송에서 빠집니다.",
  recent_real_reply_found: "최근 실제 회신이 있습니다. 질문에 답했는지 확인하세요.",
  queued: "이미 발송 대기열에 있습니다. 중복 발송 여부를 확인하세요.",
  we_replied_last: "마지막 메시지가 우리 쪽이라 이번 발송에서 빠집니다.",
  not_pending: "자동답장 대기 상태가 아닙니다(종결·처리됨).",
  org_automation_off: "이 조직은 자동화가 꺼져 있어 이번 자동 발송에서 빠집니다.",
  exclude_no_reply: "고정 단가 제안만 있어 답장 없이 제외합니다.",
  vendor_auto: "업체·자동 메일이라 답장하지 않습니다.",
  closing_no_reply: "감사·확인 인사만 있어 답장하지 않습니다.",
  sender_check: "실제 발신자가 크리에이터인지 먼저 확인하세요.",
  discontinued: "참여 중단 의사입니다. 운영자가 확인하세요.",
  original_missing_judgment: "원문이 없어 분류만으로 판단하지 않습니다. 대화를 열어 확인하세요.",
  personal_review_status_check: "지원·심사 상태는 이 조회로 확인할 수 없습니다. 운영자가 개인 상태를 확인하세요(F는 참고만).",
  operator_judgment: "운영자가 판단해 직접 답하세요.",
  policy_guide_draft_review: "개별 조정 불가(내부 정책) · 표준 조건 안내 초안을 검토하세요.",
  participation_guide_draft_review: "가이드 확인·지원 안내 초안을 검토하세요.",
  reward_guide_draft_review: "보상 구조는 가이드 안내로 답하는 초안을 검토하세요.",
  final_safety_check: "발송 가능 아님 · 최종 live 확인 필요",
};

/** Library template ids (src/lib/scpReplyTemplates.ts). The board only PRESELECTS; a human chooses. */
export type ReviewTemplateId = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "greeting_a" | "rate_policy";

export type ReviewInboundFacts = {
  /** confirmed = an INBOUND record of this conversation whose received time equals lastInboundAtIso. */
  link: "confirmed" | "unlinked" | "unknown";
  /** Only read for unprotected, AI-on addresses; used in memory, never returned. */
  body: string | null;
  bodyRead: boolean;
  summaryKr: string | null;
  /** The stored summary BEFORE redaction/truncation — provenance comparison only, never returned. */
  summaryRaw?: string | null;
  binding: { status: string; bindingScope: string | null; reasonCode: string | null; inboundSenderHash: string | null } | null;
  inboundSenderHash: string | null;
};

export type ReviewOutboundEvidence = { kind: ReviewOutboundKind; sentAtIso: string | null; conversationId: string | null };

export type ReviewDefaultReply = { text: string; sourceLabel: string } | null;

export type ReviewConversationFacts = {
  conversationId: string;
  mailAccountId: string | null;
  aiActive: boolean | null;
  autoReplyStatus: string | null;
  primaryCaseId: string | null;
  caseCandidateIds: string[];
  actorType: string | null;
  intentLabels: string[];
  gateReasonText: string;
  /** true when a newer inbound arrived after the case stamp (autoCaseMessageRef !== lastMessageRef). */
  caseStampStale: boolean;
  /** conversation.autoCaseLabelSource — "operator" when an operator corrected the case label. */
  labelSource: string | null;
  /**
   * true ONLY when the classification stamp (autoCaseMessageRef) is demonstrably the located latest
   * inbound. Otherwise (missing ref/source, mismatch) the non-protection labels (case, actor, intents)
   * are ignored for the current-question verdict → operator judgment. Protection inputs stay raw.
   */
  labelsFresh?: boolean;
  /** Raw autoCaseId + caseCandidates (protection only; never used as the displayed case). */
  protectionCaseIds?: string[];
  orgAutomationOff: boolean;
  /** false when the org automation policy could not be read — never treated as "enabled". */
  orgPolicyKnown?: boolean;
  creatorName: string | null;
  creatorHandle: string | null;
  creatorEmailMasked: string | null;
  programLabel: string | null;
  latestInboundAtIso: string | null;
  lastMessageFrom: string | null;
  summaryKr: string | null;
  inbound: ReviewInboundFacts;
  /** Protection reasons inherited from OTHER conversations of the same address (metadata only). */
  addressProtectionReasons: string[];
  outbound: { status: ReviewFieldStatus; reason: string | null; rows: ReviewOutboundEvidence[] };
  queue: { status: ReviewFieldStatus; liveCount: number; reason: string | null };
  suppression: { status: ReviewFieldStatus; blocked: boolean };
  defaultReplyFor: (caseId: string) => ReviewDefaultReply;
};

export type ReviewDraftState = {
  status: "system_default" | "none" | "not_allowed";
  draftAllowed: boolean;
  reason: string | null;
  caseId: string | null;
  label: string;
  sourceLabel: string | null;
  basisLabel: string | null;
  text: string | null;
  /** Library template the board PRESELECTS (a human still chooses); null = none suggested. */
  suggestedTemplateId: ReviewTemplateId | null;
  sendable: false;
  sendableLabel: "전송 불가(검토 전용)";
};

export type ReviewConversationEvaluation = {
  conversationId: string;
  conversationTail: string;
  primaryCaseId: string | null;
  primaryCaseLabel: string | null;
  evidenceCaseIds: string[];
  protected: boolean;
  protectedReasons: string[];
  sendBatch: { bucket: ReviewSendBatchBucket; reason: ReviewExclusionReason | null; reasonLabel: string | null; allReasons: ReviewExclusionReason[] };
  nextAction: ReviewNextAction;
  nextActionLabel: string;
  /** The board never claims human verification: only an existing operator label says otherwise. */
  classification: { kind: "auto" | "operator_label"; label: string };
  /** Creator claims the board cannot verify (e.g. "already applied"), always shown as 상대 주장(미확인). */
  claims: string[];
  /** A newer inbound than the last case judgment exists → the earlier verdict must be re-checked. */
  newInboundSinceJudgment: boolean;
  question: { status: "unresolved" | "not_needed" | "unknown"; label: string; questionCount: number | null; recommendedHandling: string };
  draft: ReviewDraftState;
  summary: ReviewDerived<string | null> & { source: ReviewSummarySource; sourceLabel: string };
  realReplies: ReviewDerived<number> & {
    latestAtIso: string | null;
    latestAfterInbound: boolean;
    possibleCount: number;
    evidence: Array<{ kind: ReviewOutboundKind; kindLabel: string; sentAtIso: string | null; sameConversation: boolean; conversationTail: string | null }>;
  };
  queued: ReviewDerived<boolean>;
  suppressed: ReviewDerived<boolean>;
  aiActive: ReviewDerived<boolean | null>;
  orgAutomationOff: boolean;
  identity: ReviewDerived<"verified" | "review_required" | "missing"> & { fromMatches: boolean; groupSenderHash: string | null };
  registration: ReviewDerived<"not_applicable" | "registered" | "unknown">;
  latestInboundAtIso: string | null;
  lastMessageSide: "creator" | "operator" | "unknown";
  creatorName: string | null;
  creatorHandle: string | null;
  creatorEmailMasked: string | null;
  programLabel: string | null;
  unknowns: string[];
};

const CASE_BY_ID = new Map(CHAT_CASEBOOK.map((item) => [item.id, item] as const));
const QUESTION_INTENTS = new Set(["reward_info_request", "brief_request", "contact_channel_request", "call_meeting_request", "settlement_question", "approval_status", "submission_help", "other"]);
const PENDING_STATUSES = new Set(["waiting_for_human", "draft_only"]);
const NO_REPLY_ACTIONS: ReadonlySet<ReviewNextAction> = new Set(["exclude_no_reply", "vendor_auto", "closing_no_reply", "discontinued", "suppressed", "operator_owned_ai_off"]);
const TEMPLATE_BY_CASE: Record<string, ReviewTemplateId> = {
  interest_next_steps: "A",
  eligibility_question: "A",
  submission_support: "B",
  requirements_question: "B",
  pricing_guide_redirect: "C",
  reward_overview: "C",
  contact_channel_request: "E",
  call_request: "E",
  counter_offer_guideline_reply: "rate_policy",
};

export const REVIEW_UNKNOWNS_ALWAYS = [
  "Reply-To 주소는 이 조회로 확인할 수 없습니다.",
  "Flu 밖에서 보낸 메일(보낸편지함 미편입)은 보이지 않습니다.",
  "발송 시점 잠금·사람 승인 게이트는 발송 순간에만 판정됩니다.",
];

/** Redacts addresses, phone numbers and @handles from server summaries before they leave the server. */
export function redactSummary(text: string | null | undefined): string | null {
  if (!text) return null;
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[이메일]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[전화번호]")
    // Any @handle not part of an address (addresses were replaced above), whatever precedes it.
    .replace(/@[\w.]{2,}/g, "@[계정]");
}

export function conversationTail(conversationId: string): string {
  return conversationId.slice(-6);
}

export function caseLabel(caseId: string | null): string | null {
  if (!caseId) return null;
  const item = CASE_BY_ID.get(caseId);
  return item?.autoReplyTemplate?.title ?? (item ? caseId.replace(/_/g, " ") : null);
}

function onlyIntents(labels: readonly string[], allowed: readonly string[]): boolean {
  return labels.every((label) => allowed.includes(label));
}

export function evaluateReviewConversation(facts: ReviewConversationFacts): ReviewConversationEvaluation {
  const labelsFresh = facts.labelsFresh !== false;
  const rawPrimary = facts.primaryCaseId && CASE_BY_ID.has(facts.primaryCaseId) ? facts.primaryCaseId : null;
  // Stale/unprovable labels never drive an exclusion or a "safe" verdict.
  const primary = labelsFresh ? rawPrimary : null;
  const primaryCase = primary ? CASE_BY_ID.get(primary) ?? null : null;
  const intents = labelsFresh ? facts.intentLabels : [];
  const actorType = labelsFresh ? facts.actorType : null;
  const linked = facts.inbound.link === "confirmed";
  const identity = senderIdentity(linked ? facts.inbound : { binding: null, inboundSenderHash: null });

  // protection (metadata + same-address inheritance) — the body was not read when this is non-empty
  const ownReasons = assessReviewProtection({
    aiActive: facts.aiActive,
    primaryCaseId: rawPrimary,
    extraCaseIds: [...(facts.protectionCaseIds ?? []), ...facts.caseCandidateIds],
    // Protection always uses the RAW labels, stale or not.
    intentLabels: facts.intentLabels,
    gateReasonText: facts.gateReasonText,
    suppressionBlocked: facts.suppression.blocked,
    binding: linked ? facts.inbound.binding : null,
    inboundSenderHash: linked ? facts.inbound.inboundSenderHash : null,
  });
  const protectedReasons = [...new Set([...ownReasons, ...facts.addressProtectionReasons])];
  const isProtected = protectedReasons.length > 0;

  // inbound text provenance
  const bodyRead = linked && facts.inbound.bodyRead && !isProtected;
  const summarySource: ReviewSummarySource = bodyRead
    ? inboundSummarySource(facts.inbound.body, facts.inbound.summaryRaw ?? facts.inbound.summaryKr ?? facts.summaryKr)
    : (facts.summaryKr || facts.inbound.summaryKr ? "summary_fallback" : "none");
  const realBody = bodyRead && summarySource === "body";
  const questionCount = bodyRead && (summarySource === "body" || summarySource === "unverified") ? countInboundQuestions(facts.inbound.body) : null;
  const shortKind = realBody ? classifyShortInbound(facts.inbound.body) : "other";
  const questionIntents = intents.filter((label) => QUESTION_INTENTS.has(label));

  // board-only operator rules — label-only verdicts need a real body
  const actorVendor = actorType === "agency_mcn" || actorType === "vendor_or_notification";
  const fixedFeeSignal = primary === "fixed_terms_inquiry" || intents.includes("custom_terms_proposal");
  const rateChange = primary === "counter_offer_guideline_reply";
  const greetingOnly = realBody && !actorVendor && questionCount === 0 && questionIntents.length === 0 && !fixedFeeSignal && !rateChange
    && shortKind === "greeting";
  const closingSignal = primary === "closing_acknowledgment"
    || (primary === "confusion_or_short" && onlyIntents(intents, ["closing"]) && !intents.includes("interest"));
  // Closing is concluded from the REAL body's full match only; a label alone never closes a row.
  const closingOnly = realBody && !greetingOnly && questionCount === 0 && questionIntents.length === 0 && shortKind === "closing";
  const fixedFeeShape = fixedFeeSignal && !rateChange && questionIntents.length === 0 && onlyIntents(intents, ["custom_terms_proposal", "interest", "closing"]);
  const fixedFeeOnly = realBody && fixedFeeShape && questionCount === 0 && isFixedFeeOfferOnly(facts.inbound.body);
  // Label signals that WOULD conclude "no reply" but lack a real body → never concluded.
  const originalMissing = !realBody && !isProtected && (closingSignal || fixedFeeShape || primary === "confusion_or_short" || (primary === "interest_next_steps" && questionIntents.length === 0));
  // Labels said "closing" / "fixed fee only" but the real body says otherwise → it is a request.
  const labelContradicted = realBody && ((closingSignal && !closingOnly && !greetingOnly) || (fixedFeeShape && !fixedFeeOnly));
  // Application / review status: the board cannot see the application or the review result.
  const reviewStatusAsk = primary === "approval_status_inquiry" || intents.includes("approval_status");
  const mixedQuestions = (questionCount ?? 0) >= 2 || questionIntents.length >= 2 || labelContradicted || (fixedFeeSignal && !fixedFeeOnly && !rateChange && !originalMissing);

  // real replies — only CONFIRMED real replies exclude; possible/unknown rows keep the lookup partial
  const latestInboundMs = Date.parse(facts.latestInboundAtIso ?? "");
  const realRows = facts.outbound.rows.filter((row) => row.kind === "real_reply")
    .sort((left, right) => (right.sentAtIso ?? "").localeCompare(left.sentAtIso ?? ""));
  const possibleCount = facts.outbound.rows.filter((row) => row.kind === "possible_reply").length;
  const unsettled = facts.outbound.rows.some((row) => !SETTLED_KINDS.has(row.kind));
  const replyStatus: ReviewFieldStatus = facts.outbound.status === "confirmed" && unsettled ? "partial" : facts.outbound.status;
  const latestReal = realRows[0] ?? null;
  const latestAfterInbound = Boolean(latestReal?.sentAtIso) && Number.isFinite(latestInboundMs) && Date.parse(latestReal!.sentAtIso!) >= latestInboundMs;

  // (a) send batch
  const reasons: ReviewExclusionReason[] = [];
  if (realRows.length > 0) reasons.push("recent_real_reply");
  if (facts.queue.liveCount > 0) reasons.push("queued");
  if (facts.suppression.blocked) reasons.push("suppressed");
  if (facts.aiActive === false) reasons.push("ai_off");
  if (facts.lastMessageFrom && facts.lastMessageFrom !== "creator") reasons.push("we_replied_last");
  if (facts.autoReplyStatus && !PENDING_STATUSES.has(facts.autoReplyStatus)) reasons.push("not_pending");
  if (facts.orgAutomationOff) reasons.push("org_automation_off");
  if (actorVendor || primary === "out_of_office" || intents.includes("ooo")) reasons.push("vendor_or_auto");
  if (closingOnly) reasons.push("closing_or_no_question");
  if (fixedFeeOnly) reasons.push("fixed_fee_proposal_only");
  if (protectedReasons.includes("발신자 불일치")) reasons.push("sender_mismatch");
  if (primary === "discontinue_notice" || intents.includes("discontinue")) reasons.push("discontinued");
  const representative = reasons[0] ?? null;
  const templateCase = greetingOnly ? "interest_next_steps" : primary;
  const defaultReply = templateCase ? facts.defaultReplyFor(templateCase) : null;
  const bucket: ReviewSendBatchBucket = representative
    ? "excluded"
    : isProtected || originalMissing || reviewStatusAsk || !primaryCase || primaryCase.escalation !== "auto_ok" || !defaultReply || mixedQuestions
      || replyStatus !== "confirmed" || facts.queue.status !== "confirmed" || facts.suppression.status !== "confirmed" || !realBody
      || facts.orgPolicyKnown === false
      ? "operator_judgment"
      : "final_safety_wait";

  // next action — one distinct value per rule, never merged
  const nextAction: ReviewNextAction = (() => {
    if (facts.aiActive === false) return "operator_owned_ai_off";
    if (facts.suppression.blocked) return "suppressed";
    switch (representative) {
      case "recent_real_reply": return "recent_real_reply_found";
      case "queued": return "queued";
      case "we_replied_last": return "we_replied_last";
      case "not_pending": return "not_pending";
      case "org_automation_off": return "org_automation_off";
      case "fixed_fee_proposal_only": return "exclude_no_reply";
      case "vendor_or_auto": return "vendor_auto";
      case "closing_or_no_question": return "closing_no_reply";
      case "sender_mismatch": return "sender_check";
      case "discontinued": return "discontinued";
      default: break;
    }
    if (isProtected) return "operator_judgment";
    if (reviewStatusAsk) return "personal_review_status_check";
    if (mixedQuestions) return "operator_judgment";
    if (originalMissing) return "original_missing_judgment";
    if (rateChange) return "policy_guide_draft_review";
    if (greetingOnly) return "participation_guide_draft_review";
    if (primary === "reward_overview") return "reward_guide_draft_review";
    return bucket === "final_safety_wait" ? "final_safety_check" : "operator_judgment";
  })();

  // (b) question — independent of (a)
  const questionNotNeeded = fixedFeeOnly || closingOnly || (actorVendor && questionIntents.length === 0) || (primary === "out_of_office");
  const questionUnresolved = !questionNotNeeded && (
    (questionCount ?? 0) > 0 || questionIntents.length > 0 || greetingOnly || labelContradicted
    || (primaryCase !== null && primaryCase.escalation !== "auto_close" && !originalMissing)
  );
  const questionStatus: ReviewConversationEvaluation["question"]["status"] = questionNotNeeded ? "not_needed" : questionUnresolved ? "unresolved" : "unknown";
  const questionLabel = questionStatus === "not_needed"
    ? (fixedFeeOnly ? "답장 불필요 (고정 단가 제안만)" : "답장 불필요")
    : questionStatus === "unresolved"
      ? (realRows.length > 0 || possibleCount > 0 ? "미해결 · 최근 회신이 답했는지 미확인" : "미해결 질문")
      : originalMissing ? "원문 미확보 · 질문 여부 미확인" : "질문 여부 미확인";
  const recommendedHandling = REVIEW_NEXT_ACTION_HANDLING[nextAction]
    + (questionStatus === "unresolved" && representative ? " 질문은 아직 열려 있습니다." : "");

  // (c) draft — review only; protected / AI-off / no-reply rows never get an agent draft
  const draftBlockReason = facts.aiActive === false
    ? "운영자 담당 (AI off) · 초안 없음"
    : isProtected
      ? `보호 대상(${protectedReasons.join("·")}) · 초안 없음`
      : NO_REPLY_ACTIONS.has(nextAction)
        ? "답장 없음 대상"
        : null;
  const draftText = !draftBlockReason ? defaultReply?.text ?? null : null;
  const suggestedTemplateId: ReviewTemplateId | null = draftBlockReason
    ? null
    : greetingOnly
      ? "greeting_a"
      : rateChange
        ? "rate_policy"
        : primary && TEMPLATE_BY_CASE[primary]
          ? TEMPLATE_BY_CASE[primary]
          // G (정산 일반) is never preselected: it is only for an account check actually in progress.
          : null;
  const draft: ReviewDraftState = {
    status: draftBlockReason ? "not_allowed" : draftText ? "system_default" : "none",
    draftAllowed: !draftBlockReason,
    reason: draftBlockReason ?? (draftText ? null : "시스템 기본 답신 없음"),
    caseId: draftText ? templateCase : null,
    label: draftText ? "현재 시스템 기본 답신 (운영자 승인 문구와 다름)" : draftBlockReason ?? "시스템 기본 답신 없음",
    sourceLabel: draftText ? defaultReply?.sourceLabel ?? null : null,
    // The rate-change wording is a 2026-10-05 operator decision, not a quote from past mail.
    basisLabel: draftText && rateChange ? "다음 행동 근거: 운영자 결정 (2026-10-05)" : null,
    text: draftText,
    suggestedTemplateId,
    sendable: false,
    sendableLabel: "전송 불가(검토 전용)",
  };

  // summary — omitted for protected / AI-off rows
  const summaryText = isProtected ? null : redactSummary(facts.inbound.summaryKr ?? facts.summaryKr ?? null);
  const summaryLabel = isProtected
    ? "보호·운영자 담당 대화라 표시하지 않음"
    : !linked ? "원문 미확인 · Chat 원문 보기에서 확인" : REVIEW_SUMMARY_SOURCE_LABELS[summarySource];

  const unknowns = [...REVIEW_UNKNOWNS_ALWAYS];
  if (replyStatus !== "confirmed") unknowns.push(`14일 회신 조회: ${facts.outbound.reason ?? (possibleCount > 0 ? "회신 가능성(미확인) 있음" : "종류 미확인 발송 있음")}`);
  if (facts.queue.status !== "confirmed") unknowns.push(`발송 대기열: ${facts.queue.reason ?? "미확인"}`);
  if (facts.suppression.status !== "confirmed") unknowns.push("수신 억제 조회 실패");
  if (facts.orgPolicyKnown === false) unknowns.push("조직 자동화 설정을 읽지 못함 · 꺼짐 여부 미확인");
  if (facts.inbound.link !== "confirmed") unknowns.push("최근 수신 기록이 이 대화에 연결돼 있는지 확인 못함");

  return {
    conversationId: facts.conversationId,
    conversationTail: conversationTail(facts.conversationId),
    primaryCaseId: primary,
    primaryCaseLabel: caseLabel(primary),
    evidenceCaseIds: facts.caseCandidateIds.filter((id) => id !== primary && CASE_BY_ID.has(id)).slice(0, 5),
    protected: isProtected,
    protectedReasons,
    sendBatch: { bucket, reason: representative, reasonLabel: representative ? REVIEW_EXCLUSION_LABELS[representative] : null, allReasons: reasons },
    nextAction,
    nextActionLabel: REVIEW_NEXT_ACTION_LABELS[nextAction],
    claims: reviewStatusAsk || primary === "scp_application_received" ? ["지원 완료 주장 · 상대 주장(미확인)"] : [],
    newInboundSinceJudgment: facts.caseStampStale,
    classification: facts.labelSource === "operator"
      ? { kind: "operator_label", label: "운영자 라벨" }
      : { kind: "auto", label: "자동 추천(원문 규칙)" },
    question: { status: questionStatus, label: questionLabel, questionCount, recommendedHandling },
    draft,
    summary: {
      status: isProtected || summarySource === "body" ? "confirmed" : summarySource === "none" ? "unknown" : "partial",
      value: summaryText,
      reason: isProtected ? "protected_or_ai_off" : summarySource === "body" ? null : REVIEW_SUMMARY_SOURCE_LABELS[summarySource],
      source: summarySource,
      sourceLabel: summaryLabel,
    },
    realReplies: {
      status: replyStatus,
      value: realRows.length,
      reason: replyStatus === "confirmed" ? null : facts.outbound.reason ?? (replyStatus === "partial" ? "미확인(부분 조회)" : "미확인"),
      latestAtIso: latestReal?.sentAtIso ?? null,
      latestAfterInbound,
      possibleCount,
      evidence: [...facts.outbound.rows]
        .sort((left, right) => Number(right.kind === "real_reply") - Number(left.kind === "real_reply") || (right.sentAtIso ?? "").localeCompare(left.sentAtIso ?? ""))
        .slice(0, 8)
        .map((row) => ({
          kind: row.kind,
          kindLabel: REVIEW_OUTBOUND_KIND_LABELS[row.kind],
          sentAtIso: row.sentAtIso,
          sameConversation: row.conversationId === facts.conversationId,
          conversationTail: row.conversationId ? conversationTail(row.conversationId) : null,
        })),
    },
    queued: { status: facts.queue.status, value: facts.queue.liveCount > 0, reason: facts.queue.reason },
    suppressed: { status: facts.suppression.status, value: facts.suppression.blocked, reason: facts.suppression.status === "confirmed" ? null : "조회 실패" },
    aiActive: { status: facts.aiActive === null ? "unknown" : "confirmed", value: facts.aiActive, reason: facts.aiActive === null ? "기록 없음" : null },
    orgAutomationOff: facts.orgAutomationOff,
    identity: {
      status: identity.status === "missing" ? "unknown" : "confirmed",
      value: identity.status,
      reason: !linked ? "최근 수신 기록 미연결" : identity.status === "missing" ? "발신자 연결 기록 없음" : null,
      fromMatches: identity.fromMatches,
      groupSenderHash: identity.status === "verified" && identity.fromMatches ? str(facts.inbound.inboundSenderHash) || null : null,
    },
    registration: facts.mailAccountId === "scp"
      ? { status: "confirmed", value: "not_applicable", reason: "SCP 메일함은 등록 판정 대상이 아님" }
      : { status: "unknown", value: "unknown", reason: "등록 필드만으로 판정하지 않음" },
    latestInboundAtIso: facts.latestInboundAtIso,
    lastMessageSide: facts.lastMessageFrom === "creator" ? "creator" : facts.lastMessageFrom ? "operator" : "unknown",
    creatorName: facts.creatorName,
    creatorHandle: facts.creatorHandle,
    creatorEmailMasked: facts.creatorEmailMasked,
    programLabel: facts.programLabel,
    unknowns,
  };
}

// ── grouping into person rows ────────────────────────────────────────────────────────────────────

export type ReviewBoardMember = {
  conversationId: string;
  conversationTail: string;
  primaryCaseId: string | null;
  primaryCaseLabel: string | null;
  latestInboundAtIso: string | null;
  protected: boolean;
};

export type ReviewBoardPersonRow = ReviewConversationEvaluation & {
  rowKey: string;
  grouping: { kind: "verified_sender" | "single_conversation"; label: string };
  conversations: ReviewBoardMember[];
};

function protectRow(row: ReviewBoardPersonRow, reasons: string[]): ReviewBoardPersonRow {
  const label = `보호 대상(${reasons.join("·")}) · 초안 없음`;
  const next: ReviewBoardPersonRow = {
    ...row,
    protected: true,
    protectedReasons: reasons,
    draft: { ...row.draft, status: "not_allowed", draftAllowed: false, reason: label, label, caseId: null, text: null, sourceLabel: null, basisLabel: null, suggestedTemplateId: null },
    summary: { ...row.summary, value: null, status: "confirmed", reason: "protected_or_ai_off", sourceLabel: "보호·운영자 담당 대화라 표시하지 않음" },
  };
  if (next.sendBatch.bucket === "final_safety_wait") next.sendBatch = { ...next.sendBatch, bucket: "operator_judgment" };
  if (next.nextAction === "final_safety_check" || next.nextAction.endsWith("_draft_review")) {
    next.nextAction = "operator_judgment";
    next.nextActionLabel = REVIEW_NEXT_ACTION_LABELS.operator_judgment;
  }
  return next;
}

/**
 * Merges conversations into one person row ONLY when the latest inbound carries a verified sender
 * binding AND the real From hash equals the binding hash (groupSenderHash, both non-empty).
 * Everything else stays one row per conversation. The representative is the newest inbound; a
 * protected (or AI-off) member protects the whole row. Exported for the client-side cross-page merge.
 */
export function groupReviewConversations(
  items: readonly ReviewConversationEvaluation[],
  keyFor: (senderHash: string) => string,
): ReviewBoardPersonRow[] {
  const groups = new Map<string, ReviewConversationEvaluation[]>();
  const order: string[] = [];
  for (const item of items) {
    // Opaque keys only — never a raw conversation id or address hash.
    const key = item.identity.groupSenderHash ? `p:${keyFor(item.identity.groupSenderHash)}` : `c:${keyFor(`conversation:${item.conversationId}`)}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(item);
  }
  return order.map((key) => {
    const members = [...groups.get(key)!].sort((left, right) => (right.latestInboundAtIso ?? "").localeCompare(left.latestInboundAtIso ?? ""));
    const head = members[0];
    const protectedReasons = [...new Set(members.flatMap((member) => member.protectedReasons))];
    const row: ReviewBoardPersonRow = {
      ...head,
      rowKey: key,
      claims: [...new Set(members.flatMap((member) => member.claims))],
      // A newer inbound on ANY thread than an older thread's judgment, or a stale stamp anywhere.
      newInboundSinceJudgment: members.some((member) => member.newInboundSinceJudgment) || members.length > 1,
      evidenceCaseIds: [...new Set(members.flatMap((member) => [member.primaryCaseId, ...member.evidenceCaseIds]).filter((id): id is string => Boolean(id) && id !== head.primaryCaseId))].slice(0, 6),
      grouping: key.startsWith("p:")
        ? { kind: "verified_sender", label: members.length > 1 ? `확인된 발신자 · 대화 ${members.length}개 묶음` : "확인된 발신자" }
        : { kind: "single_conversation", label: "대화 1개 · 발신자 묶음 근거 없음" },
      conversations: members.map((member) => ({
        conversationId: member.conversationId,
        conversationTail: member.conversationTail,
        primaryCaseId: member.primaryCaseId,
        primaryCaseLabel: member.primaryCaseLabel,
        latestInboundAtIso: member.latestInboundAtIso,
        protected: member.protected,
      })),
    };
    return protectedReasons.length > 0 && !head.protected ? protectRow(row, protectedReasons) : { ...row, protectedReasons };
  });
}
