import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import {
  CHAT_CASEBOOK,
  CHAT_CASEBOOK_CONTENT_HASH,
  CHAT_CASEBOOK_VERSION,
  type CasebookLinkToken,
} from "./chatCasebook";
import { substituteCasebookLinks } from "./casebookLinkResolver";

export const CHAT_AUTO_CASE_PERMIT_COLLECTION = "chat_auto_case_permits" as const;
export const CHAT_AUTO_CASE_DECISION_LEDGER_COLLECTION = "chat_auto_case_decision_ledger" as const;
export const CHAT_AUTO_CASE_EXECUTION_LEDGER_COLLECTION = "chat_auto_case_execution_ledger" as const;
export const CHAT_AUTO_CASE_EVAL_RUNS_COLLECTION = "chat_auto_case_eval_runs" as const;
export const CHAT_AUTO_CASEBOOK_PROPOSAL_OUTBOX_COLLECTION = "chat_auto_casebook_proposal_outbox" as const;
export const CHAT_AUTO_CASE_INTENTS_COLLECTION = "auto_reply_case_intents" as const;
export const CHAT_AUTO_PERMIT_SCHEMA_VERSION = 1 as const;
export const CHAT_AUTO_MIN_CONSECUTIVE_UNEDITED_APPROVED_SENDS = 20 as const;

export type ChatAutoPermitCaseId = (typeof CHAT_CASEBOOK)[number]["id"];
export type ChatAutoPermitGatewayCostLog = {
  provider: string;
  model: string;
  transport: "ai_hub_gateway" | "vertex_direct" | "cache" | "unverified" | string;
  estimatedCostUsd: number;
  cacheHit?: boolean;
};
export type ChatAutoPermitGatewayOutcome = {
  caseId: string | null;
  // auto_close (종결 인사 케이스): 발송 후보가 아니라 스레드 종결 — evaluateChatAutoCasePermit
  //   은 human_gate_not_auto_reply 로 거절한다(퍼밋은 auto_reply 판정만 arm 대상으로 삼는다).
  humanGateDecision: "auto_reply" | "needs_review" | "blocked" | "auto_close";
  costLog: ChatAutoPermitGatewayCostLog;
};
export type ChatAutoCasePermitState = "default_off" | "candidate" | "armed" | "disarmed" | "stale_pin" | "eval_failed";
export type ChatAutoCasePermitDisarmReason =
  | "human_edited"
  | "human_rejected"
  | "send_failure"
  | "send_unknown_acceptance"
  | "send_blocked"
  | "bounce_or_suppression"
  | "complaint"
  | "opt_out"
  | "suppression"
  | "casebook_hash_changed"
  | "model_version_changed"
  | "eval_expired"
  | "eval_failed"
  | "case_removed"
  | "mail_safety_denied"
  | "case_unresolved_adverse_event"
  // [적대 리뷰 MED-3] 커밋 A 아래서 arm 된 permit 이 커밋 B 아래서 그대로 자동발송되는 것을 막는
  // 발송시점 게이트(sendAutoReplyJob)의 전용 disarm 사유.
  | "release_identity_changed";
export type ChatAutoCasePermitDenyReason =
  | "global_off"
  | "conversation_off"
  | "dry_run"
  | "draft_only"
  | "untrusted_sender"
  // F-4 (AUTO-MAIL-SAFETY-DESIGN-2026-09-16.md §B "③민감 갭"): inbound sender has no
  // creatorId/applicationId/creator-email match on this conversation's attribution (personal
  // account: not in candidate_pool; scp/canonical account: zero discoverInboundConversationAttribution
  // evidence) — the receive-time gate forces draft_only and records this reason instead of ever
  // auto-sending.
  | "sender_not_creator"
  // Positive allowlist (2026-10-03): no current VERIFIED sender binding (legacy row, quoted-only, different/
  // missing From, shared address...). Deliberately NOT sender_not_creator: the backlog dismiss cleanup
  // selects that reason, and an attributed creator awaiting identity verification must never be dismissed.
  | "sender_identity_unverified"
  | "gateway_transport_unverified"
  | "human_gate_not_auto_reply"
  | "case_unclassified"
  | "case_not_auto_ok"
  | "unsupported_factual_claim"
  | "server_render_unavailable"
  | "permit_missing"
  | "permit_disarmed"
  | "permit_case_mismatch"
  | "pin_mismatch"
  | "eval_missing"
  | "eval_not_passed"
  | "counter_floor_not_met"
  | "counter_evidence_unavailable"
  | "case_already_reserved"
  | "case_already_sent"
  | "mail_safety_blocked"
  | "profile_disabled"
  // Task-91 확장 ④⑤: SCP 상태 문의(scpInquiryClassifier.ts) 전용 사유 — 기존 20종과 별개 축으로,
  // buildChatAutoPermitReceivePlan 이후 호출부(receiveEmail 인바운드 경로)의 SCP 게이트가 추가로
  // 붙인다(evaluateChatAutoCasePermit 자체는 이 사유를 채우지 않는다). scp_type_disabled:
  // automation.scpInquiryAutoReply 의 해당 유형 토글이 꺼져 있음. scp_facts_unavailable: 리졸버가
  // facts:null 을 반환(정본 부재/미확신). SCP 게이트의 "발신자가 어떤 scp_application_management
  // 레코드로도 귀속되지 않음"(식별 게이트) 사유는 위에서 F-4 가 이미 정의한 "sender_not_creator"
  // 리터럴을 그대로 재사용한다 — 별도 멤버를 새로 추가하지 않는다(merge 중복 방지).
  | "scp_type_disabled"
  | "scp_facts_unavailable";
export type ChatAutoLearningDisposition =
  | "arming_credit"
  | "proposal_only_counter_reset"
  | "rejected_audit_only"
  | "adverse_audit_only";
export type ChatAutoCasePermitCounters = {
  consecutiveHumanUneditedApprovedSent: number;
  totalHumanUneditedApprovedSent: number;
  lastEligibleMessageRef: string | null;
  lastResetAtIso: string | null;
  lastResetReason: ChatAutoCasePermitDisarmReason | null;
  unavailableEvidenceCount: number;
};
export type ChatAutoCasePermitPin = {
  casebookVersion: typeof CHAT_CASEBOOK_VERSION;
  casebookHash: string;
  modelVersion: string;
};
export type ChatAutoEvalEvidence = {
  status: "passed" | "failed" | "unavailable";
  runId: string;
  buildSha: string;
  kRevision: string;
  casebookHash: string;
  modelVersion: string;
  evaluatedAtIso: string;
  expiresAtIso: string;
  actualGatewayCall: true;
  bypassGatewayCache: true;
  heldout: { total: number; passed: number; failed: number };
  reroll: { total: number; stable: number; unstable: number };
  decisions: { allow: number; deny: number; unavailable: number };
  transports: Array<"ai_hub_gateway" | "vertex_direct">;
  estimatedCostUsd: number;
};
// 2026-10-02 (0.6.108): per-scenario eval observability. ONLY enums/codes/ids — never raw mail text,
// prompts, model responses, summaries or PII (SEC-P0-009). Every string goes through chatAutoEvalCode.
export type ChatAutoEvalScenarioRecord = {
  id: string;
  phase: "heldout" | "reroll";
  expectedCaseId: string;
  caseId: string | null;
  decision: string | null;
  ruleIds: string[];
  lift: string | null;
  jev: { consulted: boolean; outcome: string | null; reasons: string[] };
  render: { status: string; guard: string | null };
  verdict: { status: "pass" | "fail"; failReason: string | null };
};
const EVAL_CODE_PATTERN = /^[A-Za-z0-9_.:\-]{1,64}$/;
/** Returns the value only when it is a short code-like token; anything else (free text, '@', spaces) is dropped. */
export function chatAutoEvalCode(value: unknown): string | null {
  return typeof value === "string" && EVAL_CODE_PATTERN.test(value) ? value : null;
}
export function chatAutoEvalCodes(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const code = chatAutoEvalCode(item);
    if (code !== null) out.push(code);
    if (out.length >= max) break;
  }
  return out;
}
export type ChatAutoDraftFactualClaimGuard = {
  status: "passed" | "needs_review";
  clampReasonIds: string[];
  unsupportedClaimCount: number;
  evidenceRefs: string[];
};
export type ChatAutoNeedsReviewCandidate = {
  caseId: ChatAutoPermitCaseId;
  title: string;
  reasonCode: string;
  clampReasonIds: string[];
};
export type ChatAutoServerRenderedDraft = {
  status: "rendered" | "needs_review";
  text: string;
  draftHash: string;
  renderSource: "casebook_template" | "operator_override";
  factTokenIds: string[];
  linkTokenIds: string[];
  guard: ChatAutoDraftFactualClaimGuard;
};
export type ChatAutoCasePermitDoc = {
  schemaVersion: typeof CHAT_AUTO_PERMIT_SCHEMA_VERSION;
  caseId: ChatAutoPermitCaseId;
  state: ChatAutoCasePermitState;
  armed: boolean;
  casebookHash: string;
  casebookVersion: typeof CHAT_CASEBOOK_VERSION;
  modelVersion: string;
  counters: ChatAutoCasePermitCounters;
  evalEvidence: ChatAutoEvalEvidence | null;
  lastDecisionAtIso?: string;
  lastDisarmReason?: ChatAutoCasePermitDisarmReason;
  // 헤세 정책 결정 2026-09-17: super_admin 이 20건 연속 카운터 플로어를 우회해 arm 했는지 표시한다.
  // "armed" 인 doc 에만 실린다(disarm 은 전체 doc 을 덮어써 지운다) — armingSource 가 없으면 기존
  // 정상 카운터-플로어 경로로 arm 된 것이다.
  armingSource?: "operator_override" | "counter_floor";
  overrideReason?: string;
  overrideActorUidHash?: string;
  overrideAtIso?: string;
  updatedAtIso: string;
  updatedAt: FirebaseFirestore.FieldValue;
  updatedByHash: string;
  source: "functions.chatAutoCasePermit";
};
export type ChatAutoCasePermitDecisionInput = {
  conversationId: string;
  messageSourceId: string;
  caseId: string | null;
  humanGateDecision: "auto_reply" | "needs_review" | "blocked" | "auto_close";
  gatewayCostLog: ChatAutoPermitGatewayCostLog;
  globalAutoReplyEnabled: boolean;
  conversationAiActive: boolean;
  dryRun: boolean;
  draftOnly: boolean;
  senderTrusted: boolean;
  // F-4: does this conversation's attribution evidence tie the sender to a creator record
  // (creatorId/applicationId/creator-email match, or personal-account candidate_pool
  // registration)? false denies with "sender_not_creator" — distinct from senderTrusted, which is
  // about the ingest transport (IMAP/ai fromRole), not who the sender is.
  senderIsCreator: boolean;
  // default true; false => "sender_identity_unverified" (separate from sender_not_creator, see the reason's comment)
  senderIdentityVerified?: boolean;
  permit: ChatAutoCasePermitDoc | null;
  currentPin: ChatAutoCasePermitPin;
  serverRenderedDraft: ChatAutoServerRenderedDraft | null;
  caseAlreadyReserved: boolean;
  caseAlreadySent: boolean;
  mailSafetyAllowed: boolean;
  profileEnabled: boolean;
  nowIso: string;
};
export type ChatAutoCasePermitDecision =
  | { allowed: true; caseId: ChatAutoPermitCaseId; intentId: string; pin: ChatAutoCasePermitPin; draft: ChatAutoServerRenderedDraft; denyReasons?: [] }
  | { allowed: false; caseId: ChatAutoPermitCaseId | null; denyReasons: ChatAutoCasePermitDenyReason[]; pin: ChatAutoCasePermitPin; caseCandidates: ChatAutoNeedsReviewCandidate[]; clampReasonIds: string[] };

const CASES_BY_ID = new Map(CHAT_CASEBOOK.map((item) => [item.id, item]));
const AUTO_OK_CASE_IDS = new Set(
  CHAT_CASEBOOK.filter((item) => item.escalation === "auto_ok").map((item) => item.id),
);

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isChatAutoPermitCaseId(value: unknown): value is ChatAutoPermitCaseId {
  return typeof value === "string" && CASES_BY_ID.has(value);
}

// F7 (auto-close 리뷰): arm 가능한 케이스 = escalation 이 auto_ok 인 케이스뿐이다.
//   needs_review/blocked_suppression/auto_close 케이스(예: closing_acknowledgment)는
//   분류는 되지만 dispatch 의 evaluateChatAutoCasePermit 이 case_not_auto_ok 로 항상
//   거부하므로 arm 상태가 절대 발송으로 이어지지 않는다 — arming callable 이 요청을
//   입구에서 거절하는 데 쓰는 정본 판정.
export function isChatAutoArmableCaseId(value: unknown): value is ChatAutoPermitCaseId {
  return typeof value === "string" && AUTO_OK_CASE_IDS.has(value);
}

export function chatAutoCasePermitPin(modelVersion: string, casebookHash = CHAT_CASEBOOK_CONTENT_HASH): ChatAutoCasePermitPin {
  return {
    casebookVersion: CHAT_CASEBOOK_VERSION,
    casebookHash,
    modelVersion,
  };
}

export function chatAutoCaseIntentId(conversationId: string, caseId: string): string {
  return `aci_${sha256Hex(JSON.stringify(["auto_reply_case_intent", conversationId, caseId])).slice(0, 40)}`;
}

export function chatAutoCaseLedgerId(parts: {
  conversationId: string;
  messageSourceId: string;
  caseId: string | null;
  kind: "decision" | "execution";
}): string {
  // [적대 리뷰 LOW] chatAutoCaseIntentId 와 같은 JSON.stringify 구분자로 정규화한다 —
  // 종전 \u0000 join 은 이 파일에서만 쓰던 별도 규약이었다.
  return sha256Hex(JSON.stringify([
    parts.kind,
    parts.conversationId,
    parts.messageSourceId,
    parts.caseId ?? "unclassified",
  ])).slice(0, 40);
}

export function evaluateChatAutoDraftFactualClaims(input: {
  draftText: string;
  caseId: ChatAutoPermitCaseId;
  evidenceRefs: string[];
}): ChatAutoDraftFactualClaimGuard {
  const casebookCase = CASES_BY_ID.get(input.caseId);
  const template = casebookCase?.autoReplyTemplate;
  const tokenMatches = [...input.draftText.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((match) => match[1]);
  const allowedLinks = new Set<CasebookLinkToken>(casebookCase?.links ?? []);
  const unknownLinkToken = tokenMatches.some((token) => !allowedLinks.has(token as CasebookLinkToken));
  const expectedEvidence = new Set(template?.factTokenIds ?? []);
  const evidenceMatchesTemplate =
    input.evidenceRefs.length === expectedEvidence.size &&
    input.evidenceRefs.every((ref) => expectedEvidence.has(ref));
  const exactTemplate = Boolean(template) && input.draftText.trim() === template!.template.trim();
  const outsideCasebook = !casebookCase || !template || !exactTemplate || !evidenceMatchesTemplate;
  const clampReasonIds = [
    ...(unknownLinkToken ? ["unsupported_link_token"] : []),
    ...(template && !evidenceMatchesTemplate ? ["unsupported_fact_token"] : []),
    ...(outsideCasebook ? ["unsupported_factual_claim"] : []),
  ];
  return {
    status: clampReasonIds.length ? "needs_review" : "passed",
    clampReasonIds,
    unsupportedClaimCount: clampReasonIds.length,
    evidenceRefs: input.evidenceRefs.slice(0, 8),
  };
}

// 2026-10-02 (헤세 결정 — 운영자 저장 답신 자동발송): counter_offer_guideline_reply 의 운영자 저장본은
//   "정본 {{GUIDELINE_AMOUNT}} 문장 외의 어떤 금액도 말하지 않는다"가 계약이다. 패턴으로 "금액 모양"을
//   잡는 방식은 우회가 끝이 없어(공백 여러 개, 전각 숫자, NBSP, "fifty dollars", "50k" …) fail-closed 로
//   바꿨다: NFKC 정규화 + 모든 공백(NBSP 포함) 축약 후, 허용 토큰({{…}})을 자리표시자로 바꾼 본문에서
//   ① 숫자(유니코드 Nd 전부)는 한 글자도 허용하지 않는다 — 이 케이스의 저장본이 숫자를 말할 이유는
//   없다(숫자는 오직 {{GUIDELINE_AMOUNT}} 가 서버에서 풀어 주는 정본 문장에만 있다. "7 days" 같은
//   일반 숫자도 금지하는 대가는 의도된 보수성이다), ② 통화 기호/코드/단어는 숫자 없이도 금지,
//   ③ 영어 기수 단어(zero…ninety, 하이픈 합성어, hundred/…/dozen/grand/half/k, a couple of)는 위치와 무관하게 전부 금지한다.
const COUNTER_OFFER_CURRENCY_PATTERN =
  /[$€£¥₩₹¢]|\b(?:usd|us\$|krw|eur|gbp|jpy|inr|cny|dollars?|cents?|bucks?|euros?|pounds?|yen|rupees?|won)\b|원|달러|엔화|유로|만원|천원|센트/i;
// 영어 기수 단어는 위치와 무관하게 전부 거부한다(금전 단어와의 거리 판정은 "fee … set at fifty" 로 우회됐다).
const COUNTER_OFFER_NUMBER_WORD_PATTERN =
  /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|hundreds|thousand|thousands|million|millions|billion|billions|trillion|trillions|dozen|dozens|grand|half|k)$/i;
// Codex round 4 (F): multiplier / comparative / exception wording that implies a different payment even
//   without a number ("We can pay twice the published rate."). The owner's own text ("we're not able to offer a
//   custom rate") contains none of these on purpose — "custom rate" alone is allowed, "custom rate offer" is not.
const COUNTER_OFFER_COMPARATIVE_PATTERN =
  /\b(?:twice|double|doubled|triple|tripled|quadruple|quadrupled|extra|additional|bonus|bonuses|premium|raise|raised|raises|increase|increased|increases|higher|above|exception|exceptions|more\s+than|top[- ]?up|special\s+rate|custom\s+rate\s+offer)\b/i;
const COUNTER_OFFER_NUMBER_PHRASE_PATTERN = /\ba\s+couple\s+of\b/i;

function normalizeForMoneyScan(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/\{\{[^{}]*\}\}/g, " TOKEN ")
    .replace(/[\s\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g, " ")
    .trim();
}

export function operatorOverrideHasExtraAmount(caseId: ChatAutoPermitCaseId, text: string): boolean {
  if (caseId !== "counter_offer_guideline_reply") return false;
  const normalized = normalizeForMoneyScan(text);
  if (/\p{Nd}/u.test(normalized)) return true;
  // English-only policy (owner: replies are always English): any non-ASCII letter is refused, which also closes
  //   Korean/other-script number words ("오십 불") that the English word lists cannot see.
  if (/(?![\x00-\x7f])[\p{L}\p{M}]/u.test(normalized)) return true;
  if (COUNTER_OFFER_COMPARATIVE_PATTERN.test(normalized)) return true;
  if (COUNTER_OFFER_CURRENCY_PATTERN.test(normalized)) return true;
  if (COUNTER_OFFER_NUMBER_PHRASE_PATTERN.test(normalized)) return true;
  const words = normalized.split(/[^\p{L}-]+/u).filter(Boolean);
  for (const word of words) {
    for (const part of word.split("-")) {
      if (part && COUNTER_OFFER_NUMBER_WORD_PATTERN.test(part)) return true;
    }
  }
  return false;
}

/** The permit is armed for exactly this casebook pin (the override revision is part of the pin). */
export function chatAutoPermitArmedForPin(
  permit: Pick<ChatAutoCasePermitDoc, "armed" | "state" | "casebookHash"> | null | undefined,
  casebookHash: string,
): boolean {
  return Boolean(permit) && permit!.armed === true && permit!.state === "armed" && permit!.casebookHash === casebookHash;
}

export function renderChatAutoServerDraft(input: {
  caseId: ChatAutoPermitCaseId;
  factTokenIds: readonly string[];
  linkTokenIds: readonly string[];
  operatorOverrideText?: string;
  // 운영자 저장본은 기본적으로 항상 사람 검토다(needs_review). 호출자가 "이 정확한 저장 revision 에
  //   대해 permit 이 armed(핀 일치)"임을 확인했을 때만 true 로 넘긴다 — 그때만 저장 문구가 그대로
  //   rendered 가 된다. evaluateChatAutoCasePermit 가 permit/핀/eval 을 독립적으로 다시 검증한다.
  operatorOverrideArmed?: boolean;
}): ChatAutoServerRenderedDraft {
  const casebookCase = CASES_BY_ID.get(input.caseId);
  if (typeof input.operatorOverrideText === "string") {
    const text = input.operatorOverrideText.trim();
    const validOperatorReply = text.length > 0 && text.length <= 4_000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) && !/<\/?[a-z][^>]*>/i.test(text) && !containsUnreviewedReplyLink(text) && !hasUnsupportedCasebookReplyToken(text, input.caseId);
    const extraAmount = validOperatorReply && operatorOverrideHasExtraAmount(input.caseId, text);
    if (validOperatorReply && !extraAmount && input.operatorOverrideArmed === true && casebookCase?.escalation === "auto_ok") {
      return {
        status: "rendered",
        text,
        draftHash: sha256Hex(text),
        renderSource: "operator_override",
        factTokenIds: [],
        linkTokenIds: [],
        guard: { status: "passed", clampReasonIds: [], unsupportedClaimCount: 0, evidenceRefs: [] },
      };
    }
    const guard: ChatAutoDraftFactualClaimGuard = {
      status: "needs_review",
      clampReasonIds: ["operator_override_requires_human_review"],
      unsupportedClaimCount: 1,
      evidenceRefs: [],
    };
    return {
      status: "needs_review",
      text: validOperatorReply ? text : "",
      draftHash: sha256Hex(validOperatorReply ? text : ""),
      renderSource: "operator_override",
      factTokenIds: [],
      linkTokenIds: [],
      guard: !validOperatorReply
        ? { ...guard, clampReasonIds: ["operator_override_invalid"] }
        : extraAmount
          ? { ...guard, clampReasonIds: ["operator_override_extra_amount"] }
          : guard,
    };
  }
  const template = casebookCase?.autoReplyTemplate;
  const allowedLinks = new Set<CasebookLinkToken>(casebookCase?.links ?? []);
  const unknownLinkToken = input.linkTokenIds.some((token) => !allowedLinks.has(token as CasebookLinkToken));
  const expectedFactTokenIds = template?.factTokenIds ?? [];
  const factTokenIds = input.factTokenIds.length ? input.factTokenIds.slice(0, 16) : [...expectedFactTokenIds];
  const unknownFactToken = factTokenIds.some((token) => !expectedFactTokenIds.includes(token));
  const linkTokenIds = input.linkTokenIds.length ? input.linkTokenIds.slice(0, 8) : [...(casebookCase?.links ?? [])];
  const text = template && !unknownLinkToken && !unknownFactToken ? template.template.trim() : "";
  const guard = evaluateChatAutoDraftFactualClaims({
    draftText: text,
    caseId: input.caseId,
    evidenceRefs: [...factTokenIds],
  });
  const clampReasonIds = [
    ...guard.clampReasonIds,
    ...(unknownLinkToken ? ["unsupported_link_token"] : []),
    ...(unknownFactToken ? ["unsupported_fact_token"] : []),
  ];
  const finalGuard: ChatAutoDraftFactualClaimGuard = {
    ...guard,
    status: clampReasonIds.length ? "needs_review" : guard.status,
    clampReasonIds: [...new Set(clampReasonIds)],
    unsupportedClaimCount: clampReasonIds.length,
  };
  return {
    status: finalGuard.status === "passed" && casebookCase?.escalation === "auto_ok" ? "rendered" : "needs_review",
    text,
    draftHash: sha256Hex(text),
    renderSource: "casebook_template",
    factTokenIds: [...factTokenIds],
    linkTokenIds,
    guard: finalGuard,
  };
}

/**
 * Arm/eval-time validation of an operator-saved reply with the SAME renderer + link resolution the
 * dispatch path uses (renderChatAutoServerDraft with operatorOverrideText, then the
 * resolveChatAutoServerDraftBody equivalent: substituteCasebookLinks, no leftover token, no invented
 * URL). Returns the reason a saved reply must not be sent automatically, or null when it may be.
 */
export function chatAutoOperatorOverrideAutoSendRefusal(caseId: ChatAutoPermitCaseId, text: string): string | null {
  const rendered = renderChatAutoServerDraft({
    caseId,
    factTokenIds: [],
    linkTokenIds: [],
    operatorOverrideText: text,
    operatorOverrideArmed: true,
  });
  if (rendered.status !== "rendered" || rendered.guard.status !== "passed") {
    const reason = rendered.guard.clampReasonIds[0] ?? "case_not_auto_ok";
    return reason === "operator_override_extra_amount"
      ? "the saved reply states an amount other than the canonical {{GUIDELINE_AMOUNT}} statement"
      : reason === "operator_override_invalid"
        ? "the saved reply uses a token or link that is not allowed for this case, or is not plain text"
        : `the saved reply cannot be rendered for automatic sending (${reason})`;
  }
  const substituted = substituteCasebookLinks(rendered.text);
  if (substituted.leftoverToken) return "the saved reply leaves an unresolved {{TOKEN}} after link resolution";
  if (substituted.inventedUrl) return "the saved reply contains a URL outside the canonical link set";
  return null;
}

export function containsUnreviewedReplyLink(text: string): boolean {
  // A plain greeting (Hi:)) or a heading followed by whitespace is not a URI.
  // Known link schemes remain blocked even when whitespace follows their colon.
  return /(?:\b(?:https?|ftps?|mailto|tel|data|javascript|vbscript|file|blob|cid):|\b[a-z][a-z0-9+.-]*:(?=[^\s)])|\/\/\S|\bwww\.)/i.test(text)
    || /(?:^|[\s(])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s]*)?/i.test(text);
}

export function hasUnsupportedCasebookReplyToken(text: string, caseId: ChatAutoPermitCaseId): boolean {
  const allowed = new Set(CASES_BY_ID.get(caseId)?.links ?? []);
  const tokens = [...text.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]);
  if (tokens.some((token) => !allowed.has(token as CasebookLinkToken))) return true;
  return /\{\{|\}\}/.test(text.replace(/\{\{[^{}]+\}\}/g, ""));
}

function isFiniteNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isFiniteIso(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time);
}

/**
 * [적대 리뷰 LOW] `chatAutoCasePermitStore.ts` 의 `evalEvidenceMatchesPin` 과 조건이 완전히
 * 동일했다(파라미터 형태만 달랐다) — 하나가 갱신되고 다른 하나가 안 따라가는 드리프트를 막기
 * 위해 이 함수 하나로 합친다. store.ts 는 이 함수를 그대로 가져다 쓴다.
 */
export function evalEvidencePasses(
  evidence: ChatAutoEvalEvidence,
  pin: ChatAutoCasePermitPin,
  nowIso: string,
): boolean {
  const nowMs = Date.parse(nowIso);
  const evaluatedMs = Date.parse(evidence.evaluatedAtIso);
  const expiresMs = Date.parse(evidence.expiresAtIso);
  const scenarioCount = evidence.heldout.total + evidence.reroll.total;
  const decisionCount = evidence.decisions.allow + evidence.decisions.deny + evidence.decisions.unavailable;
  return (
    evidence.status === "passed" &&
    evidence.casebookHash === pin.casebookHash &&
    evidence.modelVersion === pin.modelVersion &&
    evidence.actualGatewayCall === true &&
    evidence.bypassGatewayCache === true &&
    evidence.heldout.total > 0 &&
    evidence.heldout.passed === evidence.heldout.total &&
    evidence.heldout.failed === 0 &&
    evidence.reroll.total > 0 &&
    evidence.reroll.stable === evidence.reroll.total &&
    evidence.reroll.unstable === 0 &&
    decisionCount === scenarioCount &&
    evidence.decisions.unavailable === 0 &&
    evidence.transports.length > 0 &&
    evidence.transports.every((transport) => transport === "ai_hub_gateway" || transport === "vertex_direct") &&
    Number.isFinite(evidence.estimatedCostUsd) &&
    evidence.estimatedCostUsd >= 0 &&
    Number.isFinite(nowMs) &&
    Number.isFinite(evaluatedMs) &&
    Number.isFinite(expiresMs) &&
    evaluatedMs <= nowMs &&
    expiresMs > nowMs
  );
}

function countersWellFormed(counters: ChatAutoCasePermitCounters): boolean {
  return (
    isFiniteNonNegativeInteger(counters.consecutiveHumanUneditedApprovedSent) &&
    isFiniteNonNegativeInteger(counters.totalHumanUneditedApprovedSent) &&
    isFiniteNonNegativeInteger(counters.unavailableEvidenceCount) &&
    counters.totalHumanUneditedApprovedSent >= counters.consecutiveHumanUneditedApprovedSent
  );
}

function countersPass(counters: ChatAutoCasePermitCounters): boolean {
  return (
    countersWellFormed(counters) &&
    counters.consecutiveHumanUneditedApprovedSent >= CHAT_AUTO_MIN_CONSECUTIVE_UNEDITED_APPROVED_SENDS &&
    counters.unavailableEvidenceCount === 0
  );
}

export function buildChatAutoNeedsReviewCandidates(input: {
  caseId: string | null;
  clampReasonIds: readonly string[];
  ruleIds: readonly string[];
}): ChatAutoNeedsReviewCandidate[] {
  const candidateIds = [
    ...(isChatAutoPermitCaseId(input.caseId) ? [input.caseId] : []),
    ...CHAT_CASEBOOK
      .filter((item) => item.escalation !== "blocked_suppression")
      .map((item) => item.id),
  ];
  return [...new Set(candidateIds)].slice(0, 4).map((caseId) => {
    const item = CASES_BY_ID.get(caseId)!;
    return {
      caseId,
      title: item.id.replace(/_/g, " "),
      reasonCode: input.clampReasonIds[0] ?? input.ruleIds[0] ?? "needs_review",
      clampReasonIds: input.clampReasonIds.slice(0, 6),
    };
  });
}

/**
 * Send-point re-judgement of the permit-derived predicates evaluateChatAutoCasePermit applies at dispatch time (caseId,
 * armed/state, pins, eval evidence validity at `nowIso`, counter floor / evidence-unavailable breaker, operator-override
 * counter exemption). Used inside the SMTP-start transaction over the transactionally read permit doc; can only deny.
 */
export function chatAutoPermitStillAuthorizesSend(
  permit: ChatAutoCasePermitDoc | null | undefined,
  caseId: string,
  pin: ChatAutoCasePermitPin,
  nowIso: string,
): boolean {
  if (!permit || permit.caseId !== caseId) return false;
  if (!permit.armed || permit.state !== "armed") return false;
  if (permit.casebookHash !== pin.casebookHash || permit.casebookVersion !== pin.casebookVersion || permit.modelVersion !== pin.modelVersion) return false;
  if (!permit.evalEvidence || !evalEvidencePasses(permit.evalEvidence, pin, nowIso)) return false;
  const operatorOverrideArmed = permit.armingSource === "operator_override";
  if (!permit.counters || !countersWellFormed(permit.counters) || (!operatorOverrideArmed && !countersPass(permit.counters))) return false;
  return permit.counters.unavailableEvidenceCount === 0;
}

export function evaluateChatAutoCasePermit(input: ChatAutoCasePermitDecisionInput): ChatAutoCasePermitDecision {
  const denyReasons: ChatAutoCasePermitDenyReason[] = [];
  const caseId = isChatAutoPermitCaseId(input.caseId) ? input.caseId : null;
  const casebookCase = caseId ? CASES_BY_ID.get(caseId) : null;

  if (!input.globalAutoReplyEnabled) denyReasons.push("global_off");
  if (!input.conversationAiActive) denyReasons.push("conversation_off");
  if (input.dryRun) denyReasons.push("dry_run");
  if (input.draftOnly) denyReasons.push("draft_only");
  if (!input.senderTrusted) denyReasons.push("untrusted_sender");
  if (!input.senderIsCreator) denyReasons.push("sender_not_creator");
  if (input.senderIdentityVerified === false) denyReasons.push("sender_identity_unverified");
  if (input.gatewayCostLog.transport !== "ai_hub_gateway" && input.gatewayCostLog.transport !== "vertex_direct") {
    denyReasons.push("gateway_transport_unverified");
  }
  if (input.gatewayCostLog.model !== input.currentPin.modelVersion) denyReasons.push("pin_mismatch");
  if (input.humanGateDecision !== "auto_reply") denyReasons.push("human_gate_not_auto_reply");
  if (!caseId) denyReasons.push("case_unclassified");
  if (casebookCase && casebookCase.escalation !== "auto_ok") denyReasons.push("case_not_auto_ok");
  if (!input.serverRenderedDraft || input.serverRenderedDraft.status !== "rendered") {
    denyReasons.push("server_render_unavailable");
  }
  if (input.serverRenderedDraft?.guard.status === "needs_review") {
    denyReasons.push("unsupported_factual_claim");
  }
  // 운영자 저장본이 rendered 로 올라오려면 permit 이 "이 정확한 저장 revision(핀)"에 armed 여야 한다 —
  //   호출자가 operatorOverrideArmed 를 잘못 넘겨도 여기서 독립적으로 다시 막는다.
  if (
    input.serverRenderedDraft?.renderSource === "operator_override" &&
    input.serverRenderedDraft.status === "rendered" &&
    !chatAutoPermitArmedForPin(input.permit, input.currentPin.casebookHash)
  ) {
    denyReasons.push("unsupported_factual_claim");
  }
  if (!input.permit) {
    denyReasons.push("permit_missing");
  } else {
    if (input.permit.caseId !== caseId) denyReasons.push("permit_case_mismatch");
    if (!input.permit.armed || input.permit.state !== "armed") denyReasons.push("permit_disarmed");
    if (
      input.permit.casebookHash !== input.currentPin.casebookHash ||
      input.permit.casebookVersion !== input.currentPin.casebookVersion ||
      input.permit.modelVersion !== input.currentPin.modelVersion
    ) {
      denyReasons.push("pin_mismatch");
    }
    if (!input.permit.evalEvidence) {
      denyReasons.push("eval_missing");
    } else if (!evalEvidencePasses(input.permit.evalEvidence, input.currentPin, input.nowIso)) {
      denyReasons.push("eval_not_passed");
    }
    // 헤세 정책 결정 2026-09-17: operator_override 로 arm 된 permit 은 발송 시점에도 20건 연속
    // 카운터 플로어 때문에 다시 막히면 안 된다 — arm 을 우회한 게 send-time 재검사로 무력화되는
    // 것을 막는다. 단 카운터 필드 자체가 깨져 있으면(비정상 값) override 여부와 무관하게 막는다.
    // [적대 리뷰 HIGH-3] override는 "20건 연속" 카운터 플로어만 우회한다 — unavailableEvidenceCount
    // (증거 확보 실패 발생) 서킷브레이커는 override 여부와 무관하게 무조건 발송을 막는다. 이걸
    // 우회 대상에 넣으면 operator override 가 인접 부작용 신호(evidence unavailable)까지 함께
    // 무력화해버려 "카운터 플로어만" 이라는 정책 의도를 벗어난다.
    const operatorOverrideArmed = input.permit.armingSource === "operator_override";
    if (!countersWellFormed(input.permit.counters) || (!operatorOverrideArmed && !countersPass(input.permit.counters))) {
      denyReasons.push("counter_floor_not_met");
    }
    if (input.permit.counters.unavailableEvidenceCount > 0) {
      denyReasons.push("counter_evidence_unavailable");
    }
  }
  if (input.caseAlreadyReserved) denyReasons.push("case_already_reserved");
  if (input.caseAlreadySent) denyReasons.push("case_already_sent");
  if (!input.mailSafetyAllowed) denyReasons.push("mail_safety_blocked");
  if (!input.profileEnabled) denyReasons.push("profile_disabled");

  const uniqueDenyReasons = [...new Set(denyReasons)];
  if (uniqueDenyReasons.length === 0 && caseId && input.serverRenderedDraft) {
    return {
      allowed: true,
      caseId,
      intentId: chatAutoCaseIntentId(input.conversationId, caseId),
      pin: input.currentPin,
      draft: input.serverRenderedDraft,
      denyReasons: [],
    };
  }
  const clampReasonIds = input.serverRenderedDraft?.guard.clampReasonIds ?? [];
  return {
    allowed: false,
    caseId,
    denyReasons: uniqueDenyReasons,
    pin: input.currentPin,
    caseCandidates: buildChatAutoNeedsReviewCandidates({
      caseId,
      clampReasonIds,
      ruleIds: uniqueDenyReasons,
    }),
    clampReasonIds,
  };
}

export function providerConfirmedAutoRepliedCaseIdsUnionUpdate(
  caseId: ChatAutoPermitCaseId,
  caseIntentRef: string,
): {
  autoRepliedCaseIds: FirebaseFirestore.FieldValue;
  autoRepliedCaseIntentRefs: FirebaseFirestore.FieldValue;
  autoRepliedCaseUpdatedAt: FirebaseFirestore.FieldValue;
} {
  return {
    autoRepliedCaseIds: FieldValue.arrayUnion(caseId),
    autoRepliedCaseIntentRefs: FieldValue.arrayUnion(caseIntentRef),
    autoRepliedCaseUpdatedAt: FieldValue.serverTimestamp(),
  };
}

export function emptyChatAutoPermitCounters(): ChatAutoCasePermitCounters {
  return {
    consecutiveHumanUneditedApprovedSent: 0,
    totalHumanUneditedApprovedSent: 0,
    lastEligibleMessageRef: null,
    lastResetAtIso: null,
    lastResetReason: null,
    unavailableEvidenceCount: 0,
  };
}

export function chatAutoPermitAutoOkCaseIds(): ChatAutoPermitCaseId[] {
  return CHAT_CASEBOOK.filter((item) => AUTO_OK_CASE_IDS.has(item.id)).map((item) => item.id);
}

export type ChatAutoConfirmedSendGateInput = {
  duplicateSent: boolean;
  deliveryState: "sent" | "mock_sent";
  providerConfirmed: boolean;
  acceptedCount: number;
  persisted: boolean;
  outboxOk: boolean;
};

/**
 * [적대 리뷰 HIGH-3] autoRepliedCaseIds 유니온 갱신(providerConfirmedAutoRepliedCaseIdsUnionUpdate)은
 * **제공자가 확정 수신한 발송**에만 일어나야 한다. 여섯 조건을 호출부에 인라인 불리언으로 흩어
 * 두면(예전 형태) 소스-정규식 테스트로는 `&&` 하나가 `||`로 바뀌는 뮤테이션을 못 잡는다 —
 * W72 레인캡이 같은 이유로 순수 함수로 뽑았던 것과 같은 패턴이다. 값으로 확인할 수 있게 뽑는다.
 */
export function chatAutoConfirmedSendGate(input: ChatAutoConfirmedSendGateInput): boolean {
  return (
    !input.duplicateSent &&
    input.deliveryState === "sent" &&
    input.providerConfirmed &&
    input.acceptedCount > 0 &&
    input.persisted === true &&
    input.outboxOk === true
  );
}

/**
 * [적대 리뷰 MED-3] 커밋 A 아래서 arm 된 permit 이 커밋 B 배포 후에도 그대로 자동발송을 계속하면
 * 안 된다 — arm 시점의 buildSha(evalEvidence.buildSha)를 발송 시점의 서버 release identity 와
 * 대조한다. evalEvidence 가 없거나(permit_missing/eval_missing 등 다른 게이트가 이미 막는다)
 * 서버 release identity 를 못 구하면(비-production 런타임 — 이 아티팩트는 배포 스크립트가
 * production 에만 만든다) 이 축에서는 막지 않는다 — "모른다"를 이 축의 새로운 차단 사유로
 * 쓰지 않는다(기존 다른 게이트가 그 경우를 이미 담당한다).
 */
export function chatAutoPermitReleaseIdentityMatches(
  evalEvidence: ChatAutoEvalEvidence | null,
  currentSourceCommit: string | null,
): boolean {
  if (!evalEvidence || !currentSourceCommit) return true;
  return evalEvidence.buildSha === currentSourceCommit;
}
