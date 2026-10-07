import { createHash, randomUUID } from "node:crypto";
import { FieldPath } from "firebase-admin/firestore";
import { adminDb, adminRuntimeEnvironment } from "./firebaseAdmin";
import { CHAT_CASEBOOK, isCasebookNoReplyNeeded } from "./chatCasebook";
import { chatCasebookLabel } from "./chatCasebookLabels";
import {
  chatAutoCaseAllowedLinkTokens,
  chatAutoCaseReplyLinkCatalog,
  chatAutoCaseReplyPin,
  chatAutoCaseReplyView,
  isChatAutoCaseSuggestionApplicable,
  readChatAutoCaseReplyState,
  type ChatAutoCaseReplyLinkCatalogEntry,
  type ChatAutoCaseReplyView,
} from "./chatAutoCaseReplies";
// Casebook inbox (2026-10-01): the snapshot only READS the scheduled job's precomputed default
// suggestions (one keyed doc get per applicable case) — it never generates one and never calls a model.
import {
  readChatAutoCaseDefaultSuggestions,
  type ChatAutoCaseDefaultSuggestionView,
} from "./chatAutoCaseSuggestionPrecompute";
import { chatAutoOverrideSemanticGuard, type ChatAutoOverrideSemanticGuardResult } from "./chatAutoOverrideSemanticGuard";
import {
  CHAT_AUTO_CASE_DECISION_LEDGER_COLLECTION,
  CHAT_AUTO_CASE_EVAL_RUNS_COLLECTION,
  CHAT_AUTO_MIN_CONSECUTIVE_UNEDITED_APPROVED_SENDS,
  chatAutoCasePermitPin,
  chatAutoOperatorOverrideAutoSendRefusal,
  chatAutoPermitAutoOkCaseIds,
  emptyChatAutoPermitCounters,
  isChatAutoArmableCaseId,
  isChatAutoPermitCaseId,
  chatAutoEvalCode,
  chatAutoEvalCodes,
  renderChatAutoServerDraft,
  type ChatAutoCasePermitDoc,
  type ChatAutoEvalEvidence,
  type ChatAutoEvalScenarioRecord,
  type ChatAutoPermitCaseId,
} from "./chatAutoCasePermit";
import {
  appendChatAutoCasePermitEvent,
  CHAT_AUTO_CASE_COMMITTED_SENDS_COLLECTION,
  deriveChatAutoCaseCounters,
  readChatAutoCasePermitMap,
  setChatAutoCasePermitFromVerifiedEvidence,
  writeChatAutoCaseEvalRun,
} from "./chatAutoCasePermitStore";
import {
  STAGING_FIRESTORE_DATABASE,
  STAGING_FUNCTIONS_FACADE_SYMBOL,
} from "./runtimeEnvironment";
// release-refresh-repin (2026-09-25): slackScheduledReports has no dependency on this file or on
// chatAutoCasePermitStore.ts (only mailOutboundSafety.ts imports the latter), so importing it here
// does not create a cycle — same reasoning chat-ai.ts previously documented for its own (now
// removed) use of this import.
import { postScheduledReportToSlack } from "./slackScheduledReports";
import { retryPendingChatAutoPermitDisarmAlerts } from "./chatAutoPermitDisarmAudit";
// codex adversarial review round 2 (2026-09-27): reuse the exact scp entitlement gate
// fix/scp-surface-gate added (functions/mailAccounts.ts, PR #216's accessibleAccounts
// projection) rather than a parallel one — chat_auto_case_* data is scp-program data, not
// general-purpose chat.
import { assertScpEntitled, isCallerScpEntitled } from "./mailAccounts";
// Same viewAs derivation the sibling Chat read callables use (functions/read.ts) — resolves
// request.data.viewAsUserId/viewAsEmail into a super_admin-verified target auth, or returns the
// caller's own auth unchanged when viewAs was not requested. No cycle: read.ts does not import
// this file or chatAutoCasePermit(.ts|Store.ts|Callables.ts). Still used by
// getChatAutoCasePermitStatus (kept, admin/verify) — the new snapshot callable below rejects
// viewAs outright instead of resolving it.
import { effectiveConversationAuth } from "./read";
// Casebook pending precompute (2026-09-29 casebook snapshot 504 hotfix) — see
// functions/chatAutoCasebookPendingPrecompute.ts's own doc comment. This callable no longer scans
// the unreplied inbox inline; it only ever reads the scheduled job's precomputed doc.
import {
  CHAT_AUTO_CASEBOOK_UNCLASSIFIED_REASONS,
  emptyUnclassifiedByReason,
  readCallerChatAutoCasebookPendingSnapshot,
  type ChatAutoCasebookPendingStatus,
  type ChatAutoCasebookUnclassifiedByReason,
  type PendingCaseTotals,
} from "./chatAutoCasebookPendingPrecompute";
import {
  assertNonGuestAuth,
  asRecord,
  makeBehaviorLog,
  makeDeniedBehaviorLog,
  type AuthContext,
  type CallableRequestShape,
} from "./shared";

export type GetChatAutoCasePermitStatusRequest = { caseIds?: string[] };
export type ChatAutoCasePermitStatusRow = {
  caseId: string;
  caseTitle: string;
  caseDescription: string;
  state: "default_off" | "candidate" | "armed" | "disarmed" | "stale_pin" | "eval_failed";
  armed: boolean;
  counterFloor: 20;
  counters: {
    consecutiveHumanUneditedApprovedSent: number;
    totalHumanUneditedApprovedSent: number;
    unavailableEvidenceCount: number;
  };
  pins: {
    casebookHash: string;
    casebookMatchesCurrent: boolean;
    modelVersion: string;
    modelMatchesCurrent: boolean;
  };
  eval: {
    status: "missing" | "passed" | "failed" | "unavailable" | "expired";
    runId: string | null;
    evaluatedAtIso: string | null;
    expiresAtIso: string | null;
    heldoutTotal: number;
    heldoutPassed: number;
    rerollTotal: number;
    rerollStable: number;
    transports: string[];
    estimatedCostUsd: number;
  };
  lastDisarmReason: string | null;
  caseCandidates: Array<{ caseId: string; title: string; reasonCode: string; clampReasonIds: string[] }>;
  armingSource: "operator_override" | "counter_floor" | null;
  overrideReason: string | null;
  // Casebook P1 (2026-09-27): the server-rendered reply text is already public template content
  // (functions/chatCasebook.ts autoReplyTemplate.template) — `rendered` below is already computed
  // for caseCandidates using the empty-factTokenIds/linkTokenIds default, which resolves to the
  // full published template text for any case that has one. null when the case has no template
  // (non-auto_ok cases without an autoReplyTemplate) or the template can't render.
  replyText: string | null;
};
export type ChatAutoCasePermitStatusEnvelope = {
  ok: true;
  rows: ChatAutoCasePermitStatusRow[];
  cache: { generatedAtIso: string; maxAgeSeconds: number };
  behaviorLog: Record<string, unknown>;
};
export type SetChatAutoCasePermitArmingRequest = {
  caseId: string;
  action: "arm" | "disarm";
  expectedCasebookHash: string;
  expectedModelVersion: string;
  expectedEvalRunId?: string;
  expectedCounterFloor: 20;
  // 헤세 정책 결정 2026-09-17: super_admin 전용 강제 arm. operatorOverride=true 면 20건 연속
  // 카운터 플로어를 건너뛴다 — eval 증거는 여전히 필수(§ setChatAutoCasePermitArming 참고).
  operatorOverride?: boolean;
  overrideReason?: string;
};
export type RunChatAutoCasePermitEvalRequest = {
  caseIds: string[];
  confirm: `RUN_CHAT_AUTO_CASE_PERMIT_EVAL:${string}`;
  bypassGatewayCache: true;
  applicationConversationId?: string;
};
export type ListChatAutoCaseDecisionLedgerRequest = { caseId?: string; cursor?: string; limit?: number };

export type ChatAutoCaseDecisionLedgerRow = {
  id: string;
  caseId: string | null;
  requestedState: string | null;
  evalRunId: string | null;
  createdAtIso: string | null;
  source: string | null;
};
export type ChatAutoCaseDecisionLedgerEnvelope = {
  ok: true;
  rows: ChatAutoCaseDecisionLedgerRow[];
  pageInfo: { limit: number; truncated: boolean; nextCursor: string | null };
  behaviorLog: Record<string, unknown>;
};

export type ChatAutoPermitEvalGatewayResult = {
  caseId?: string | null;
  humanGate?: { decision?: "auto_reply" | "needs_review" | "blocked" | string; ruleIds?: string[] } | null;
  /** Observability-only fields (0.6.108) — never read by verifyEvalResult's pass/fail. */
  lift?: string | null;
  draftSafetyRuleId?: string | null;
  jev?: {
    send?: { outcome?: string; reasons?: string[] } | null;
    template?: { rendered?: boolean; applied?: boolean } | null;
  } | null;
  cache?: { hit?: boolean } | null;
  costLog?: {
    provider?: string;
    model?: string;
    transport?: "ai_hub_gateway" | "vertex_direct" | "cache" | "unverified" | string;
    estimatedCostUsd?: number;
    cacheHit?: boolean;
  } | null;
  recovered?: boolean;
  fallback?: boolean;
  retry?: boolean;
};

export type ChatAutoPermitEvalScenario = {
  id: string;
  phase: "heldout" | "reroll";
  signal: string;
  expectedCaseId: ChatAutoPermitCaseId;
  expectedDecision?: "auto_reply" | "needs_review" | "blocked";
  hasInboundAttachments?: boolean;
  casebookHash: string;
  modelVersion: string;
  runIdSeed: string;
  applicationConversationId?: string;
  carryScpMailboxContext?: boolean;
};

// Cases whose production path REQUIRES a JEV consultation on top of the local gate (the toggle-gated
// lifts: pricing_guide_redirect, counter_offer_guideline_reply, approval_status_inquiry — see the
// *JevRequiredHoldReasonFor family in chat-ai.ts). Their eval must carry the canonical scp@ mailbox
// context like production inbound, otherwise JEV is never consulted and the case can never pass.
export const CHAT_AUTO_PERMIT_EVAL_JEV_CASE_IDS: ReadonlySet<string> = new Set([
  "pricing_guide_redirect",
  "counter_offer_guideline_reply",
  "approval_status_inquiry",
  // 2026-10-03: contact_channel_request's reply is toggle-gated (allowEmailOnlyRedirectForContactChannelRequest) and
  // requires JEV like the other lifted cases (contactChannelJevRequiredHoldReasonFor in chat-ai.ts).
  "contact_channel_request",
]);

type LedgerDocSnapshot = { id: string; data: () => Record<string, unknown>; get: (field: string) => unknown };
type LedgerReadResult = { docs: LedgerDocSnapshot[]; truncated: boolean; nextCursor: string | null };
type LedgerDependencies = {
  readDecisionLedger?: (input: { caseId: ChatAutoPermitCaseId | null; cursor: string | null; limit: number }) => Promise<LedgerReadResult>;
};

type EvalDependencies = {
  /** Model check of an operator-saved counter reply (fail closed); defaults to the Vertex callModel path. */
  semanticGuard?: (input: { caseId: ChatAutoPermitCaseId; text: string; revisionHash: string }) => Promise<ChatAutoOverrideSemanticGuardResult>;
  runGatewayEval?: (scenario: ChatAutoPermitEvalScenario) => Promise<ChatAutoPermitEvalGatewayResult | null>;
  resolveModelVersion?: () => Promise<string> | string;
  resolveSourceCommit?: () => Promise<string> | string;
  now?: () => Date;
  newRunNonce?: () => string;
  buildSha?: string;
  kRevision?: string;
  writeEvalRun?: typeof writeChatAutoCaseEvalRun;
  appendPermitEvent?: typeof appendChatAutoCasePermitEvent;
  readPermitMap?: typeof readChatAutoCasePermitMap;
  readLatestEvalMap?: (caseIds: readonly ChatAutoPermitCaseId[]) => Promise<Map<ChatAutoPermitCaseId, ChatAutoEvalEvidence>>;
  // codex adversarial review round 3 (2026-09-28): injectable seam for isReplyTextEntitled's
  // underlying check, so tests can reproduce a lookup failure without real Firestore/Peoply.
  checkReplyTextEntitled?: (auth: AuthContext) => Promise<boolean>;
  readCaseReplyState?: typeof readChatAutoCaseReplyState;
};

type ArmingDependencies = Pick<EvalDependencies, "resolveModelVersion" | "resolveSourceCommit" | "readPermitMap" | "readLatestEvalMap" | "now" | "checkReplyTextEntitled" | "readCaseReplyState" | "semanticGuard"> & {
  deriveCounters?: typeof deriveChatAutoCaseCounters;
  setPermit?: typeof setChatAutoCasePermitFromVerifiedEvidence;
};

// Exported (case-backlog-send, 2026-09-27) so chatAutoCaseBacklogSend.ts's per-case "지금 보내기"
// send callable can reuse the EXACT same RBAC floor arm/disarm/eval already use, per the explicit
// design decision to gate "release this case's held backlog" like arming, not like the generic
// super_admin-only requeueAutoReplyBacklog maintenance sweep it wraps internally.
export const MUTATION_ROLES = ["super_admin", "admin", "manager"] as const;
const MAX_STATUS_CASES = 30;
const MAX_LEDGER_LIMIT = 100;
const EVAL_TTL_MS = 24 * 60 * 60 * 1000;
const CLOUD_RUN_REVISION_PATTERN = /^[a-z][a-z0-9-]{0,62}-[0-9]{5}-[a-z0-9]+$/;

type PermitEvalFixture = {
  id: string;
  signal: string;
  expectedCaseId: ChatAutoPermitCaseId;
  // Optional: a classification-only negative (e.g. a signature-only messenger ID) pins the case, not the decision.
  expectedDecision?: "auto_reply" | "needs_review" | "blocked";
  // Safety negative: passes iff the final decision is a hold (needs_review/blocked — not auto_reply, not auto_close), whichever case the model picked
  // (expectedCaseId is then only the intended classification, not asserted).
  // negativeMode "held": must end needs_review/blocked. "no_case_reply": must not auto-reply AS expectedCaseId (any other
  // outcome, including a correct reclassification that auto-replies with its own template, is fine).
  negativeMode?: "held" | "no_case_reply";
  hasInboundAttachments?: boolean;
};

export const PERMIT_HELDOUT_FIXTURES_BY_CASE = {
  interest_next_steps: [
    { id: "interest-direct", signal: "I'm interested. Please send the program details and next steps.", expectedCaseId: "interest_next_steps", expectedDecision: "auto_reply" },
    { id: "interest-short", signal: "Interested — what should I do next?", expectedCaseId: "interest_next_steps", expectedDecision: "auto_reply" },
    { id: "interest-conditional", signal: "If this is still open, could you email me the brief and how to apply?", expectedCaseId: "interest_next_steps", expectedDecision: "auto_reply" },
    { id: "interest-mixed-links", signal: "I want to join and need both the guide and application link by email.", expectedCaseId: "interest_next_steps", expectedDecision: "auto_reply" },
    { id: "interest-multirequest", signal: "Can you share the brief, reward overview, and first step to start?", expectedCaseId: "interest_next_steps", expectedDecision: "auto_reply" },
  ],
  submission_support: [
    { id: "submission-how", signal: "How do I submit my YouTube video after uploading it?", expectedCaseId: "submission_support", expectedDecision: "auto_reply" },
    { id: "submission-confirm", signal: "I uploaded the video. Where should I send or confirm the submission?", expectedCaseId: "submission_support", expectedDecision: "auto_reply" },
    { id: "submission-short", signal: "Submission link please", expectedCaseId: "submission_support", expectedDecision: "auto_reply" },
    { id: "submission-conditional", signal: "If my video is ready, do I use the portal or email it here?", expectedCaseId: "submission_support", expectedDecision: "auto_reply" },
    { id: "submission-rules", signal: "Please remind me of the video submission rules and where to submit.", expectedCaseId: "submission_support", expectedDecision: "auto_reply" },
  ],
  requirements_question: [
    { id: "requirements-facecam", signal: "Is facecam mandatory or just recommended for the video?", expectedCaseId: "requirements_question", expectedDecision: "auto_reply" },
    { id: "requirements-caption", signal: "Can I use captions only, and what quality requirements should I follow?", expectedCaseId: "requirements_question", expectedDecision: "auto_reply" },
    { id: "requirements-short", signal: "What are the content requirements?", expectedCaseId: "requirements_question", expectedDecision: "auto_reply" },
    { id: "requirements-sample", signal: "If I use your sample video, can I repost it as-is or do I need to edit it?", expectedCaseId: "requirements_question", expectedDecision: "auto_reply" },
    { id: "requirements-mixed", signal: "Do I need captions, clear audio, and my face in the frame?", expectedCaseId: "requirements_question", expectedDecision: "auto_reply" },
  ],
  eligibility_question: [
    { id: "eligibility-country", signal: "Can I join from Brazil if my YouTube channel is eligible?", expectedCaseId: "eligibility_question", expectedDecision: "auto_reply" },
    { id: "eligibility-platform", signal: "Is TikTok supported, or is the program only for YouTube?", expectedCaseId: "eligibility_question", expectedDecision: "auto_reply" },
    { id: "eligibility-short", signal: "Who can apply?", expectedCaseId: "eligibility_question", expectedDecision: "auto_reply" },
    { id: "eligibility-multichannel", signal: "I have two YouTube channels. Can both apply separately?", expectedCaseId: "eligibility_question", expectedDecision: "auto_reply" },
    { id: "eligibility-age-subs", signal: "Do I need to be 19 and have 100 subscribers to participate?", expectedCaseId: "eligibility_question", expectedDecision: "auto_reply" },
  ],
  reward_overview: [
    { id: "reward-how", signal: "How does the reward work for views and creator code purchases?", expectedCaseId: "reward_overview", expectedDecision: "auto_reply" },
    { id: "reward-short", signal: "How much is the reward?", expectedCaseId: "reward_overview", expectedDecision: "auto_reply" },
    { id: "reward-threshold", signal: "When do you settle payment and what is the minimum amount?", expectedCaseId: "reward_overview", expectedDecision: "auto_reply" },
    { id: "reward-conditional", signal: "If I join, could you explain the standard reward rates by email?", expectedCaseId: "reward_overview", expectedDecision: "auto_reply" },
    { id: "reward-mixed", signal: "Please explain View Reward rates, Creator Code commission, and monthly settlement.", expectedCaseId: "reward_overview", expectedDecision: "auto_reply" },
  ],
  scp_application_received: [
    { id: "scp-received-direct", signal: "Did you receive my application?", expectedCaseId: "scp_application_received", expectedDecision: "auto_reply" },
    { id: "scp-received-confirm", signal: "I submitted my application — please confirm it was received.", expectedCaseId: "scp_application_received", expectedDecision: "auto_reply" },
    { id: "scp-received-status", signal: "Could you check the status and let me know if my application has been received?", expectedCaseId: "scp_application_received", expectedDecision: "auto_reply" },
  ],
  // 2026-09-24 (헤세 지시 — 가격/예산 문의 가이드 리다이렉트): 구체 counter-offer 없는 순수
  //   가격/예산 문의 — 숫자는 절대 기대하지 않는다(가이드-리다이렉트 응답).
  pricing_guide_redirect: [
    { id: "pricing-how-much", signal: "How much do you pay for this collab?", expectedCaseId: "pricing_guide_redirect", expectedDecision: "auto_reply" },
    { id: "pricing-budget-question", signal: "What's your budget for a video like this?", expectedCaseId: "pricing_guide_redirect", expectedDecision: "auto_reply" },
    { id: "pricing-rate-question", signal: "Can you tell me your rate for a sponsored video?", expectedCaseId: "pricing_guide_redirect", expectedDecision: "auto_reply" },
    { id: "pricing-quote-short", signal: "What's the quote for this?", expectedCaseId: "pricing_guide_redirect", expectedDecision: "auto_reply" },
    { id: "pricing-conditional", signal: "Before I apply, could you share your typical rate range by email?", expectedCaseId: "pricing_guide_redirect", expectedDecision: "auto_reply" },
  ],
  // 2026-09-24 (헤세 지시 — 역제안 가이드라인 금액 고정회신): 창작자가 같은 보상 구조(View
  //   Reward/Creator Code) 안에서 직접 금액을 역제안·인상 요청 — 계약/법무/통화/에이전시/독점권
  //   등 다른 신호나 지급 구조 변경 요구는 없다.
  counter_offer_guideline_reply: [
    { id: "counter-my-rate-usd", signal: "My rate is $500 per video, can you match that?", expectedCaseId: "counter_offer_guideline_reply", expectedDecision: "auto_reply" },
    // 0.6.107: "I usually get paid more" 의 "paid" 는 classifyScpInquiry 가 settlement(low) 로 분류해 템플릿 초안이 null →
    //   jev_required_template_unavailable 보류가 된다. 운영에서 정산 뉘앙스 문구는 보류하는 것이 의도(보수적, 유지)이므로
    //   eval 픽스처만 정산 표현 없는 명확한 역제안으로 바꾼다.
    { id: "counter-raise-rate", signal: "Can you raise the rate a bit? I usually charge more than this.", expectedCaseId: "counter_offer_guideline_reply", expectedDecision: "auto_reply" },
    { id: "counter-krw-amount", signal: "제 단가는 보통 30만원인데, 맞춰주실 수 있나요?", expectedCaseId: "counter_offer_guideline_reply", expectedDecision: "auto_reply" },
    { id: "counter-negotiate-ko", signal: "단가 협상 가능할까요? 저는 조회수당 더 받고 싶어요.", expectedCaseId: "counter_offer_guideline_reply", expectedDecision: "auto_reply" },
    { id: "counter-higher-cpm", signal: "Would you be able to offer a higher CPM rate for View Reward than the standard one?", expectedCaseId: "counter_offer_guideline_reply", expectedDecision: "auto_reply" },
  ],
  // 2026-09-29 (헤세 지시 — scp@ 프로드 사고, incident-2026-09-29-chat/five-auto-candidates.md):
  //   순수 "신청/계정 승인 여부·시점" 문의 — 접수 확인(scp_application_received)이 아니고,
  //   계약서·사용권 승인 등 계약 조건 문의도 아니다.
  approval_status_inquiry: [
    { id: "approval-account-yet", signal: "Is my account approved yet?", expectedCaseId: "approval_status_inquiry", expectedDecision: "auto_reply", hasInboundAttachments: false },
    { id: "approval-application-when", signal: "When will my application be approved?", expectedCaseId: "approval_status_inquiry", expectedDecision: "auto_reply", hasInboundAttachments: false },
    { id: "approval-account-check", signal: "Could you check whether my account has been approved?", expectedCaseId: "approval_status_inquiry", expectedDecision: "auto_reply", hasInboundAttachments: false },
    { id: "approval-attachment-present", signal: "Is my account approved yet?", expectedCaseId: "approval_status_inquiry", expectedDecision: "needs_review", hasInboundAttachments: true },
    { id: "approval-attachment-unknown", signal: "Is my account approved yet?", expectedCaseId: "approval_status_inquiry", expectedDecision: "needs_review" },
  ],
  // 2026-10-03 (헤세 결정 — contact_channel_request 자동 회신): 메신저로 연락을 옮기자는 요청에는 고정 이메일 전용 안내로
  //   회신한다(토글 allowEmailOnlyRedirectForContactChannelRequest ON 필요 — eval 전에 켜야 positives 가 통과한다).
  //   negative ids are intentionally NEUTRAL (the runner embeds ids in the safety seed — a descriptive id like "signature" or "price"
  //   would itself trip a hold rule and mask a classification miss). 1 price offer, 2 settlement, 3/4 signature-only ID, 5 negated,
  //   6 real call, 7 call-over-messenger, 8 agency, 9 mixed request (messenger ask + unrelated problem).
  //   positives = 순수 메신저 이동/번호 요청. negatives = 같은 요청에 다른 보호 신호가 섞였거나(금액 제안·불만/정산·대행사),
  //   서명에 메신저 ID 만 있고 질문은 다른 것이거나, 실제 통화/미팅 요청이라 사람이 봐야 하는 입력(케이스는 자연 분류 기준).
  contact_channel_request: [
    { id: "channel-add-whatsapp", signal: "Please add me on WhatsApp so we can talk there.", expectedCaseId: "contact_channel_request", expectedDecision: "auto_reply" },
    { id: "channel-telegram-discord", signal: "Let's talk on Telegram or Discord instead of email.", expectedCaseId: "contact_channel_request", expectedDecision: "auto_reply" },
    { id: "channel-send-number", signal: "Can you send your WhatsApp number?", expectedCaseId: "contact_channel_request", expectedDecision: "auto_reply" },
    { id: "channel-negative-1", signal: "Add me on WhatsApp. My rate is $500 per video, can you match that?", expectedCaseId: "counter_offer_guideline_reply", negativeMode: "held" },
    { id: "channel-negative-2", signal: "Message me on WhatsApp, I still have not received my payment for last month's reward.", expectedCaseId: "settlement_dispute", negativeMode: "held" },
    { id: "channel-negative-3", signal: "How do I submit my YouTube video after uploading it? Thanks, Jane. WhatsApp: +1 555 0100", expectedCaseId: "contact_channel_request", negativeMode: "no_case_reply" },
    { id: "channel-negative-4", signal: "Thanks, Jane. WhatsApp: +1 555 0100", expectedCaseId: "contact_channel_request", negativeMode: "no_case_reply" },
    { id: "channel-negative-5", signal: "No WhatsApp needed, email is fine.", expectedCaseId: "contact_channel_request", negativeMode: "no_case_reply" },
    { id: "channel-negative-6", signal: "Can we schedule a Zoom call tomorrow to discuss the program?", expectedCaseId: "call_request", negativeMode: "held" },
    { id: "channel-negative-7", signal: "Let's have a quick call over WhatsApp tomorrow.", expectedCaseId: "call_request", negativeMode: "held" },
    { id: "channel-negative-8", signal: "We are a talent agency representing several creators. Please WhatsApp me to discuss rates for our roster.", expectedCaseId: "contact_channel_request", negativeMode: "held" },
    { id: "channel-negative-9", signal: "Please add me on WhatsApp. I also cannot log in to my account and need help with that.", expectedCaseId: "contact_channel_request", negativeMode: "held" },
  ],
} as const satisfies Partial<Record<ChatAutoPermitCaseId, readonly PermitEvalFixture[]>>;

const COMMON_NEGATIVE_FIXTURES = [
  { id: "negative-fixed-terms", signal: "Can you guarantee USD 300 per month as a fixed payment instead of the standard reward?", expectedCaseId: "fixed_terms_inquiry", expectedDecision: "needs_review" },
] as const satisfies readonly PermitEvalFixture[];

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument",
    errorCode: "chat_auto_case_permit_invalid_argument",
  });
}

function autoSendRefused(message: string): Error {
  return Object.assign(new Error(`failed-precondition: ${message}`), {
    code: "failed-precondition",
    errorCode: "chat_auto_case_reply_auto_send_refused",
  });
}

// Deterministic render/link/amount validation, then the semantic model guard (fail closed). Used by arm and eval.
async function assertOverrideAutoSendable(
  caseId: ChatAutoPermitCaseId,
  saved: { text: string; revisionHash: string },
  purpose: string,
  deps: Pick<EvalDependencies, "semanticGuard">,
): Promise<void> {
  const refusal = chatAutoOperatorOverrideAutoSendRefusal(caseId, saved.text);
  if (refusal) throw autoSendRefused(`operator-edited reply cannot be ${purpose}: ${refusal}`);
  const verdict = await (deps.semanticGuard ?? chatAutoOverrideSemanticGuard)({ caseId, text: saved.text, revisionHash: saved.revisionHash });
  if (!verdict.ok) {
    throw autoSendRefused(`operator-edited reply cannot be ${purpose}: semantic guard refused it (${verdict.code})`);
  }
}

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(`failed-precondition: ${message}`), {
    code: "failed-precondition",
    errorCode: "chat_auto_case_permit_failed_precondition",
  });
}

function permissionDenied(message: string): Error {
  return Object.assign(new Error(`permission-denied: ${message}`), {
    code: "permission-denied",
    errorCode: "chat_auto_case_permit_operator_override_unauthorized",
  });
}

const OVERRIDE_REASON_MIN_LENGTH = 10;
const OVERRIDE_REASON_MAX_LENGTH = 300;

async function currentModelVersion(deps: Pick<EvalDependencies, "resolveModelVersion"> = {}): Promise<string> {
  const modelVersion = await deps.resolveModelVersion?.();
  if (typeof modelVersion !== "string" || modelVersion.trim().length === 0) {
    throw failedPrecondition("server Gateway model resolver is unavailable");
  }
  return modelVersion.trim();
}

function uniquePermitCaseIds(values: unknown, fallbackAll = false): ChatAutoPermitCaseId[] {
  const raw = Array.isArray(values) ? values : [];
  const ids = raw.filter(isChatAutoPermitCaseId);
  const unique = [...new Set(ids)].slice(0, MAX_STATUS_CASES);
  if (unique.length) return unique;
  return fallbackAll ? chatAutoPermitAutoOkCaseIds().slice(0, MAX_STATUS_CASES) : [];
}

function caseTitle(caseId: string): string {
  return chatCasebookLabel(caseId).title;
}

function evalStatus(evidence: ChatAutoEvalEvidence | null, nowIso: string): ChatAutoCasePermitStatusRow["eval"]["status"] {
  if (!evidence) return "missing";
  if (evidence.status === "passed" && new Date(evidence.expiresAtIso).getTime() <= new Date(nowIso).getTime()) {
    return "expired";
  }
  return evidence.status;
}

async function currentSourceCommit(deps: Pick<EvalDependencies, "resolveSourceCommit"> = {}): Promise<string | null> {
  let sourceCommit: unknown;
  try {
    sourceCommit = await deps.resolveSourceCommit?.();
  } catch {
    return null;
  }
  if (typeof sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(sourceCommit.trim())) return null;
  return sourceCommit.trim();
}

function evalEvidenceIsCurrentPassing(
  evidence: ChatAutoEvalEvidence | null,
  pin: ReturnType<typeof chatAutoCasePermitPin>,
  nowIso: string,
  sourceCommit: string | null,
): evidence is ChatAutoEvalEvidence {
  if (!evidence) return false;
  const nowMs = Date.parse(nowIso);
  const evaluatedMs = Date.parse(evidence.evaluatedAtIso);
  const expiresMs = Date.parse(evidence.expiresAtIso);
  const scenarioCount = evidence.heldout.total + evidence.reroll.total;
  const decisionCount = evidence.decisions.allow + evidence.decisions.deny + evidence.decisions.unavailable;
  return (
    evidence.status === "passed" &&
    evidence.casebookHash === pin.casebookHash &&
    evidence.modelVersion === pin.modelVersion &&
    sourceCommit !== null &&
    evidence.buildSha === sourceCommit &&
    typeof evidence.kRevision === "string" &&
    evidence.kRevision.trim().length > 0 &&
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

function effectivePermitState(input: {
  permit: ChatAutoCasePermitDoc | null;
  evidence: ChatAutoEvalEvidence | null;
  pin: ReturnType<typeof chatAutoCasePermitPin>;
  nowIso: string;
  sourceCommit: string | null;
}): ChatAutoCasePermitStatusRow["state"] {
  if (input.permit?.armed !== true) return input.permit?.state ?? "default_off";
  if (input.permit.casebookHash !== input.pin.casebookHash || input.permit.modelVersion !== input.pin.modelVersion) return "stale_pin";
  return evalEvidenceIsCurrentPassing(input.evidence, input.pin, input.nowIso, input.sourceCommit) ? input.permit.state : "eval_failed";
}

function freshestEvidence(permit: ChatAutoCasePermitDoc | null, latest: ChatAutoEvalEvidence | null): ChatAutoEvalEvidence | null {
  const permitEvidence = permit?.evalEvidence ?? null;
  if (!permitEvidence) return latest;
  if (!latest) return permitEvidence;
  return Date.parse(latest.evaluatedAtIso) >= Date.parse(permitEvidence.evaluatedAtIso) ? latest : permitEvidence;
}

// codex adversarial review round 2 (2026-09-27) P0: replyText is scp program content — only
// expose it to a caller who is super_admin or explicitly scp-entitled (isCallerScpEntitled,
// functions/mailAccounts.ts, the same accessibleAccounts projection getMyOrgContext.
// scpAccessGranted and every other scp-gated callable use). Unlike the other row fields (state/
// counters/eval/pins), which predate this review and stay exposed at the existing manager+/viewer+
// bar, replyText is new — gating just this field (rather than the whole already-shipped status
// callable) keeps existing non-scp consumers of this callable working unchanged.
async function defaultCheckReplyTextEntitled(auth: AuthContext): Promise<boolean> {
  return isCallerScpEntitled(auth.email ?? "", auth.role === "super_admin", { userId: auth.userId });
}

// codex adversarial review round 3 (2026-09-28) P1: this is an OPTIONAL enrichment riding on a
// REQUIRED core operation (a status read, or an arm/disarm mutation that has ALREADY been
// persisted by the time this runs — see setChatAutoCasePermitArming below). isCallerScpEntitled
// has no try/catch of its own; a genuine lookup failure (Peoply/Firestore transient error, not
// just "resolved but not entitled") must never fail the whole callable or report a completed
// mutation as an error — it must just omit replyText and log the failure for observability.
async function isReplyTextEntitled(
  auth: AuthContext,
  check: (auth: AuthContext) => Promise<boolean> = defaultCheckReplyTextEntitled,
): Promise<boolean> {
  try {
    return await check(auth);
  } catch (error) {
    console.error(
      "[chatAutoCasePermitCallables] replyText entitlement lookup failed — omitting replyText, reported outcome unaffected",
      { userId: auth.userId, error: error instanceof Error ? error.message : String(error) },
    );
    return false;
  }
}

function sanitizeStatusRow(
  caseId: ChatAutoPermitCaseId,
  permit: ChatAutoCasePermitDoc | null,
  latestEvidence: ChatAutoEvalEvidence | null,
  nowIso: string,
  modelVersion: string,
  sourceCommit: string | null,
  replyTextEntitled: boolean,
  currentCasebookHash = chatAutoCasePermitPin(modelVersion).casebookHash,
  overrideText: string | null = null,
): ChatAutoCasePermitStatusRow {
  const counters = permit?.counters ?? emptyChatAutoPermitCounters();
  const evidence = freshestEvidence(permit, latestEvidence);
  const pin = chatAutoCasePermitPin(modelVersion, currentCasebookHash);
  const rendered = renderChatAutoServerDraft({ caseId, factTokenIds: [], linkTokenIds: [] });
  return {
    caseId,
    caseTitle: caseTitle(caseId),
    caseDescription: chatCasebookLabel(caseId).description,
    state: effectivePermitState({ permit, evidence, pin, nowIso, sourceCommit }),
    armed: permit?.armed === true,
    counterFloor: CHAT_AUTO_MIN_CONSECUTIVE_UNEDITED_APPROVED_SENDS,
    counters: {
      consecutiveHumanUneditedApprovedSent: counters.consecutiveHumanUneditedApprovedSent,
      totalHumanUneditedApprovedSent: counters.totalHumanUneditedApprovedSent,
      unavailableEvidenceCount: counters.unavailableEvidenceCount,
    },
    pins: {
      casebookHash: permit?.casebookHash ?? pin.casebookHash,
      casebookMatchesCurrent: !permit || permit.casebookHash === pin.casebookHash,
      modelVersion: permit?.modelVersion ?? modelVersion,
      modelMatchesCurrent: !permit || permit.modelVersion === modelVersion,
    },
    eval: {
      status: evalStatus(evidence, nowIso),
      runId: evidence?.runId ?? null,
      evaluatedAtIso: evidence?.evaluatedAtIso ?? null,
      expiresAtIso: evidence?.expiresAtIso ?? null,
      heldoutTotal: evidence?.heldout.total ?? 0,
      heldoutPassed: evidence?.heldout.passed ?? 0,
      rerollTotal: evidence?.reroll.total ?? 0,
      rerollStable: evidence?.reroll.stable ?? 0,
      transports: evidence?.transports ?? [],
      estimatedCostUsd: evidence?.estimatedCostUsd ?? 0,
    },
    lastDisarmReason: permit?.lastDisarmReason ?? null,
    caseCandidates: rendered.status === "needs_review"
      ? [{ caseId, title: caseTitle(caseId), reasonCode: "server_render_unavailable", clampReasonIds: rendered.guard.clampReasonIds }]
      : [],
    armingSource: permit?.armingSource ?? null,
    overrideReason: permit?.overrideReason ?? null,
    replyText: replyTextEntitled && (overrideText ?? rendered.text).trim().length > 0 ? (overrideText ?? rendered.text) : null,
  };
}

async function latestEvalEvidence(caseId: ChatAutoPermitCaseId): Promise<ChatAutoEvalEvidence | null> {
  const snapshot = await adminDb
    .collection(CHAT_AUTO_CASE_EVAL_RUNS_COLLECTION)
    .where("caseId", "==", caseId)
    .orderBy("evaluatedAtIso", "desc")
    .limit(1)
    .get();
  return snapshot.docs[0]?.data() as ChatAutoEvalEvidence | undefined ?? null;
}

async function latestEvalEvidenceMap(caseIds: readonly ChatAutoPermitCaseId[]): Promise<Map<ChatAutoPermitCaseId, ChatAutoEvalEvidence>> {
  const entries = await Promise.all(caseIds.map(async (caseId) => [caseId, await latestEvalEvidence(caseId)] as const));
  return new Map(entries.filter((entry): entry is readonly [ChatAutoPermitCaseId, ChatAutoEvalEvidence] => entry[1] !== null));
}

async function statusEnvelope(
  request: CallableRequestShape,
  caseIds: ChatAutoPermitCaseId[],
  action: string,
  deps: Pick<EvalDependencies, "resolveModelVersion" | "resolveSourceCommit" | "readPermitMap" | "readLatestEvalMap" | "now" | "checkReplyTextEntitled" | "readCaseReplyState"> = {},
): Promise<ChatAutoCasePermitStatusEnvelope> {
  const auth = assertNonGuestAuth(request, action);
  const data = asRecord(request.data);
  // codex adversarial review round 3 (2026-09-28) P0: replyText entitlement must reflect the
  // viewAs-EFFECTIVE user, not the operator's own — a super_admin previewing a non-entitled
  // member must not see the template text via their own super_admin bypass. Only
  // getChatAutoCasePermitStatus (viewAsWriteGuard.ts allowlist) ever carries a real
  // viewAsUserId here; runChatAutoCasePermitEval's request never does (rejected upstream by the
  // guard before this runs), so effectiveConversationAuth is a no-op (returns auth unchanged) on
  // that path.
  const scopeAuth = await effectiveConversationAuth(auth, data);
  // 상태 판정의 "지금"도 주입 가능해야 한다 — 실제 시각을 박으면 만료(24h TTL) 판정이 달력에 묶여 테스트가 날짜와 함께 썩는다.
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const modelVersion = await currentModelVersion(deps);
  const sourceCommit = await currentSourceCommit(deps);
  const permits = await (deps.readPermitMap ?? readChatAutoCasePermitMap)(caseIds);
  const latest = await (deps.readLatestEvalMap ?? latestEvalEvidenceMap)(caseIds);
  const replyState = await (deps.readCaseReplyState ?? readChatAutoCaseReplyState)();
  const replyTextEntitled = await isReplyTextEntitled(scopeAuth, deps.checkReplyTextEntitled);
  return {
    ok: true,
    rows: caseIds.map((caseId) => sanitizeStatusRow(
      caseId,
      permits.get(caseId) ?? null,
      latest.get(caseId) ?? null,
      nowIso,
      modelVersion,
      sourceCommit,
      replyTextEntitled,
      chatAutoCaseReplyPin(caseId, replyState.overrides, replyState.revisions),
      replyState.overrides.get(caseId)?.text ?? null,
    )),
    cache: { generatedAtIso: nowIso, maxAgeSeconds: 15 },
    behaviorLog: { ...makeBehaviorLog(auth, action, "success") },
  };
}

export async function getChatAutoCasePermitStatus(
  request: CallableRequestShape,
  deps: Pick<EvalDependencies, "resolveModelVersion" | "resolveSourceCommit" | "readPermitMap" | "readLatestEvalMap" | "checkReplyTextEntitled" | "readCaseReplyState"> = {},
): Promise<ChatAutoCasePermitStatusEnvelope> {
  const data = asRecord(request.data);
  const caseIds = uniquePermitCaseIds(data.caseIds, !Array.isArray(data.caseIds));
  return statusEnvelope(request, caseIds, "chat_auto_case_permit.status", deps);
}

function assertSafeRuntimeForStagingAllowedCallable(): void {
  if (adminRuntimeEnvironment.runtimeEnvironment !== "staging") return;
  if (adminRuntimeEnvironment.databaseId !== STAGING_FIRESTORE_DATABASE) {
    throw failedPrecondition("staging Permit callable requires the named flu-staging database");
  }
}

export async function setChatAutoCasePermitArming(
  request: CallableRequestShape,
  deps: ArmingDependencies = {},
): Promise<ChatAutoCasePermitStatusEnvelope> {
  assertSafeRuntimeForStagingAllowedCallable();
  const auth = assertNonGuestAuth(request, "chat_auto_case_permit.arming", MUTATION_ROLES);
  const data = asRecord(request.data);
  const caseId = typeof data.caseId === "string" && isChatAutoPermitCaseId(data.caseId) ? data.caseId : null;
  if (!caseId) throw invalidArgument("caseId must be a known casebook case");
  const action = data.action === "arm" || data.action === "disarm" ? data.action : null;
  if (!action) throw invalidArgument("action must be arm or disarm");
  // F7 (auto-close 리뷰): auto_ok 가 아닌 케이스(closing_acknowledgment 등)의 arm 요청은
  //   여기서 거절한다 — dispatch 의 evaluateChatAutoCasePermit 이 case_not_auto_ok 로 항상
  //   거부하므로 그런 arm 상태는 절대 발송으로 이어지지 않는 무의미·오해 상태다.
  //   알려진 케이스이지만 arm 불가인 경우를 "알 수 없는 caseId" 오류와 구분해 명시적으로 알린다.
  if (action === "arm" && !isChatAutoArmableCaseId(caseId)) {
    throw invalidArgument(
      `caseId "${caseId}" cannot be armed — only casebook cases with auto_ok escalation are armable (dispatch always denies non-auto_ok cases)`,
    );
  }
  const replyState = await (deps.readCaseReplyState ?? readChatAutoCaseReplyState)();
  // 2026-10-02 (헤세 결정 — 운영자 저장 답신 자동발송): 저장본도 arm 할 수 있다. permit 핀(chatAutoCaseReplyPin)
  //   에 저장 revision 이 이미 들어 있어 armed permit 은 그 정확한 revision 에 묶이고, 저장/리셋은 기존
  //   mutateChatAutoCaseReply 대로 permit 을 disarm + eval 을 무효화한다. arm 은 super_admin 의
  //   operator_override 경로(사유 필수)로만 — 새 revision 은 카운터 플로어(핀 단위 20건)를 채울 수 없고,
  //   12h refresh 스윕(role:manager)이 대신 재승인하지 못하게 하는 기존 계약과 같은 이유다.
  const savedOverride = replyState.overrides.get(caseId);
  if (action === "arm" && !savedOverride && data.expectedReplyRevisionHash !== undefined) {
    throw failedPrecondition("the saved reply changed since it was confirmed; reload and confirm the current reply");
  }
  if (action === "arm" && savedOverride) {
    if (auth.role !== "super_admin") {
      throw permissionDenied("arming an operator-edited reply requires the super_admin role");
    }
    if (data.operatorOverride !== true) {
      throw failedPrecondition("operator-edited replies can only be armed through the operator override path (super_admin + reason)");
    }
    // The operator confirmed a specific saved revision; if the saved reply changed since (re-save/reset by
    //   someone else), refuse even before the pin check so the confirmation can never carry over.
    if (data.expectedReplyRevisionHash !== savedOverride.revisionHash) {
      throw failedPrecondition("the saved reply changed since it was confirmed; reload and confirm the current reply");
    }
    await assertOverrideAutoSendable(caseId, savedOverride, "armed", deps);
  }
  if (data.expectedCounterFloor !== CHAT_AUTO_MIN_CONSECUTIVE_UNEDITED_APPROVED_SENDS) {
    throw invalidArgument("expectedCounterFloor must be 20");
  }
  // 헤세 정책 결정 2026-09-17 — Task-91 SCP 문의 자동응대 즉시 발송: super_admin 이 사유를 남기고
  // 20건 연속 카운터 플로어를 우회해 arm 할 수 있게 한다. eval 증거·pin·caseId 등 다른 모든 arm
  // 전제조건은 그대로다(아래 action === "arm" 블록 참고) — 우회되는 건 카운터 플로어뿐이다.
  const operatorOverride = action === "arm" && data.operatorOverride === true;
  let overrideReason: string | null = null;
  if (operatorOverride) {
    if (auth.role !== "super_admin") {
      throw permissionDenied("operator override requires the super_admin role");
    }
    const reasonRaw = typeof data.overrideReason === "string" ? data.overrideReason.trim() : "";
    if (reasonRaw.length < OVERRIDE_REASON_MIN_LENGTH || reasonRaw.length > OVERRIDE_REASON_MAX_LENGTH) {
      throw invalidArgument(
        `overrideReason must be between ${OVERRIDE_REASON_MIN_LENGTH} and ${OVERRIDE_REASON_MAX_LENGTH} characters`,
      );
    }
    overrideReason = reasonRaw;
  }
  const modelVersion = await currentModelVersion(deps);
  const sourceCommit = await currentSourceCommit(deps);
  if (action === "arm" && !sourceCommit) throw failedPrecondition("server release identity is unavailable");
  const pin = chatAutoCasePermitPin(modelVersion, chatAutoCaseReplyPin(caseId, replyState.overrides, replyState.revisions));
  if (action === "arm" && (data.expectedCasebookHash !== pin.casebookHash || data.expectedModelVersion !== pin.modelVersion)) {
    throw failedPrecondition("casebook or model pin changed; reload status before arming");
  }

  const now = deps.now?.() ?? new Date();
  if (Number.isNaN(now.getTime())) throw failedPrecondition("arming clock was invalid");
  const nowIso = now.toISOString();
  const counters = await (deps.deriveCounters ?? deriveChatAutoCaseCounters)(caseId, { pin });
  const latest = await (deps.readLatestEvalMap ?? latestEvalEvidenceMap)([caseId]);
  const evidence = latest.get(caseId) ?? null;
  if (action === "arm") {
    const expectedEvalRunId = typeof data.expectedEvalRunId === "string" ? data.expectedEvalRunId : null;
    if (!expectedEvalRunId) throw invalidArgument("expectedEvalRunId is required to arm");
    if (!evidence || evidence.runId !== expectedEvalRunId) throw failedPrecondition("latest eval evidence changed; reload status before arming");
    if (!evalEvidenceIsCurrentPassing(evidence, pin, nowIso, sourceCommit)) throw failedPrecondition("fresh passing eval evidence is required");
    if (caseId === "scp_application_received" && evidence.decisions.allow <= 0) {
      throw failedPrecondition("scp_application_received requires at least one allow decision in fresh eval evidence");
    }
    if (!operatorOverride) {
      if (counters.consecutiveHumanUneditedApprovedSent < CHAT_AUTO_MIN_CONSECUTIVE_UNEDITED_APPROVED_SENDS) {
        throw failedPrecondition("counter floor not met");
      }
      if (counters.unavailableEvidenceCount > 0) throw failedPrecondition("counter evidence unavailable");
    }
  }
  const permit = await (deps.setPermit ?? setChatAutoCasePermitFromVerifiedEvidence)({
    caseId,
    requestedState: action === "arm" ? "armed" : "disarmed",
    pin,
    counters,
    evalEvidence: action === "arm" ? evidence : null,
    actorUid: auth.userId,
    actorRole: auth.role,
    nowIso,
    armingSource: operatorOverride ? "operator_override" : "counter_floor",
    overrideReason,
  });
  // codex adversarial review round 3 (2026-09-28) P1: setPermit above already persisted the
  // arm/disarm — isReplyTextEntitled's own try/catch (chatAutoCasePermitCallables.ts) ensures a
  // lookup failure here can only omit replyText, never turn this already-committed mutation into
  // a reported failure. No viewAs here (arming is never a preview — the caller's own auth is the
  // acting identity).
  const replyTextEntitled = await isReplyTextEntitled(auth, deps.checkReplyTextEntitled);
  return {
    ok: true,
    rows: [sanitizeStatusRow(
      caseId,
      permit,
      action === "arm" ? evidence : null,
      nowIso,
      modelVersion,
      sourceCommit,
      replyTextEntitled,
      pin.casebookHash,
      savedOverride?.text ?? null,
    )],
    cache: { generatedAtIso: nowIso, maxAgeSeconds: 0 },
    behaviorLog: { ...makeBehaviorLog(auth, "chat_auto_case_permit.arming", "success") },
  };
}

function assertNoCallerProof(data: Record<string, unknown>): void {
  for (const key of [
    "sourceCommit",
    "buildSha",
    "kRevision",
    "runtimeRevision",
    "modelVersion",
    "modelFingerprint",
    "evalEvidence",
    "proof",
    "counters",
    "status",
    "passed",
    "failed",
  ]) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      throw invalidArgument(`caller may not provide ${key}`);
    }
  }
}

function assertProductionEvalRuntime(deps: EvalDependencies): { buildSha: string; kRevision: string } {
  if (adminRuntimeEnvironment.runtimeEnvironment !== "production" || adminRuntimeEnvironment.databaseId !== "(default)") {
    throw failedPrecondition("Permit eval is production-only");
  }
  if ((globalThis as Record<symbol, unknown>)[STAGING_FUNCTIONS_FACADE_SYMBOL] === true) {
    throw failedPrecondition("Permit eval is denied in the staging facade");
  }
  const buildSha = deps.buildSha ?? "";
  if (!/^[a-f0-9]{40}$/.test(buildSha)) {
    throw failedPrecondition("server build SHA is unavailable");
  }
  const kRevision = deps.kRevision ?? process.env.K_REVISION ?? "";
  if (!CLOUD_RUN_REVISION_PATTERN.test(kRevision)) {
    throw failedPrecondition("server K_REVISION is unavailable");
  }
  return { buildSha, kRevision };
}

export function verifyEvalResult(
  result: ChatAutoPermitEvalGatewayResult | null,
  expectedCaseId: string,
  expectedDecision: "auto_reply" | "needs_review" | "blocked" | undefined,
  modelVersion: string,
  negativeMode: "held" | "no_case_reply" | undefined = undefined,
): { status: "passed" | "failed"; decision: "allow" | "deny" | "unavailable"; transport: "ai_hub_gateway" | "vertex_direct" | null; cost: number; failReason: string | null } {
  if (!result) return { status: "failed", decision: "unavailable", transport: null, cost: 0, failReason: "no_result" };
  const costLog = result.costLog ?? null;
  const transport = costLog?.transport;
  const cost = typeof costLog?.estimatedCostUsd === "number" ? costLog.estimatedCostUsd : Number.NaN;
  const reject =
    result.cache?.hit === true ||
    costLog?.cacheHit === true ||
    result.recovered === true ||
    result.fallback === true ||
    result.retry === true ||
    costLog?.model !== modelVersion ||
    !Number.isFinite(cost) ||
    cost < 0 ||
    (transport !== "ai_hub_gateway" && transport !== "vertex_direct");
  if (reject) {
    const rejectReason =
      result.cache?.hit === true || costLog?.cacheHit === true ? "cache_hit"
        : result.recovered === true || result.fallback === true || result.retry === true ? "recovered_fallback_or_retry"
        : costLog?.model !== modelVersion ? "model_mismatch"
        : !Number.isFinite(cost) || cost < 0 ? "cost_invalid"
        : "transport_invalid";
    return { status: "failed", decision: "unavailable", transport: null, cost: Number.isFinite(cost) && cost > 0 ? cost : 0, failReason: rejectReason };
  }
  const gotDecision = result.humanGate?.decision;
  const gotCaseId = result.caseId ?? null;
  const passed = negativeMode === "held"
    ? gotDecision === "needs_review" || gotDecision === "blocked"
    : negativeMode === "no_case_reply"
      ? gotDecision !== undefined && !(gotDecision === "auto_reply" && gotCaseId === expectedCaseId)
      : gotCaseId === expectedCaseId && (!expectedDecision || gotDecision === expectedDecision);
  return {
    status: passed ? "passed" : "failed",
    decision: gotDecision === "auto_reply" ? "allow" : gotDecision ? "deny" : "unavailable",
    transport,
    cost,
    failReason: passed ? null : !negativeMode && gotCaseId !== expectedCaseId ? "case_mismatch" : "decision_mismatch",
  };
}

// Per-scenario record for chat_auto_case_eval_runs.scenarios — enums/codes/ids ONLY (SEC-P0-009).
function buildEvalScenarioRecord(
  scenario: { id: string; expectedCaseId: string },
  phase: "heldout" | "reroll",
  result: ChatAutoPermitEvalGatewayResult | null,
  verification: { status: "passed" | "failed"; failReason: string | null },
): ChatAutoEvalScenarioRecord {
  const send = result?.jev?.send ?? null;
  const template = result?.jev?.template ?? null;
  const decision = chatAutoEvalCode(result?.humanGate?.decision);
  return {
    id: chatAutoEvalCode(scenario.id) ?? "invalid_id",
    phase,
    expectedCaseId: chatAutoEvalCode(scenario.expectedCaseId) ?? "invalid_id",
    caseId: chatAutoEvalCode(result?.caseId),
    decision,
    ruleIds: chatAutoEvalCodes(result?.humanGate?.ruleIds, 12),
    lift: chatAutoEvalCode(result?.lift),
    jev: {
      consulted: send !== null,
      outcome: chatAutoEvalCode(send?.outcome),
      reasons: chatAutoEvalCodes(send?.reasons, 8),
    },
    render: {
      status: !template ? "none" : template.applied === true ? "applied" : template.rendered === true ? "rendered" : "not_rendered",
      guard: chatAutoEvalCode(result?.draftSafetyRuleId),
    },
    verdict: { status: verification.status === "passed" ? "pass" : "fail", failReason: chatAutoEvalCode(verification.failReason) },
  };
}

async function defaultPermitGatewayEvalRunner(): Promise<ChatAutoPermitEvalGatewayResult | null> {
  throw failedPrecondition("server Gateway eval runner is not wired");
}

const SAFE_FIRESTORE_DOCUMENT_ID_MAX_LENGTH = 1500;

function safeFirestoreDocumentId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > SAFE_FIRESTORE_DOCUMENT_ID_MAX_LENGTH || trimmed.includes("/")) return null;
  return trimmed;
}

async function runEvalScenario(input: {
  scenario: PermitEvalFixture;
  phase: "heldout" | "reroll";
  caseId: ChatAutoPermitCaseId;
  pin: ReturnType<typeof chatAutoCasePermitPin>;
  modelVersion: string;
  applicationConversationId?: string;
  runner: (scenario: ChatAutoPermitEvalScenario) => Promise<ChatAutoPermitEvalGatewayResult | null>;
}): Promise<ReturnType<typeof verifyEvalResult> & { record: ChatAutoEvalScenarioRecord }> {
  try {
    const result = await input.runner({
      id: input.scenario.id,
      phase: input.phase,
      signal: input.scenario.signal,
      expectedCaseId: input.scenario.expectedCaseId,
      expectedDecision: "expectedDecision" in input.scenario ? input.scenario.expectedDecision : undefined,
      ...(typeof input.scenario.hasInboundAttachments === "boolean"
        ? { hasInboundAttachments: input.scenario.hasInboundAttachments }
        : {}),
      casebookHash: input.pin.casebookHash,
      modelVersion: input.modelVersion,
      runIdSeed: `${input.caseId}:${input.phase}:${input.scenario.id}`,
      ...(CHAT_AUTO_PERMIT_EVAL_JEV_CASE_IDS.has(input.caseId) ? { carryScpMailboxContext: true } : {}),
      ...(input.applicationConversationId ? { applicationConversationId: input.applicationConversationId } : {}),
    });
    const verification = verifyEvalResult(
      result,
      input.scenario.expectedCaseId,
      "expectedDecision" in input.scenario ? input.scenario.expectedDecision : undefined,
      input.modelVersion,
      "negativeMode" in input.scenario ? input.scenario.negativeMode : undefined,
    );
    return { ...verification, record: buildEvalScenarioRecord(input.scenario, input.phase, result, verification) };
  } catch {
    const verification = { status: "failed" as const, decision: "unavailable" as const, transport: null, cost: 0, failReason: "runner_error" };
    return { ...verification, record: buildEvalScenarioRecord(input.scenario, input.phase, null, verification) };
  }
}

export async function runChatAutoCasePermitEval(
  request: CallableRequestShape,
  deps: EvalDependencies = {},
): Promise<ChatAutoCasePermitStatusEnvelope & { runIds: string[]; permitEventOutcomes: Record<string, { disarmed: boolean; pinMismatch: boolean }> }> {
  const auth = assertNonGuestAuth(request, "chat_auto_case_permit.eval", MUTATION_ROLES);
  const data = asRecord(request.data);
  assertNoCallerProof(data);
  if (typeof data.confirm !== "string" || !data.confirm.startsWith("RUN_CHAT_AUTO_CASE_PERMIT_EVAL:")) {
    throw invalidArgument("confirm must start with RUN_CHAT_AUTO_CASE_PERMIT_EVAL:");
  }
  if (data.bypassGatewayCache !== true) throw invalidArgument("bypassGatewayCache must be true");
  const caseIds = uniquePermitCaseIds(data.caseIds, false);
  if (!caseIds.length) throw invalidArgument("caseIds must include at least one known case");
  const replyState = await (deps.readCaseReplyState ?? readChatAutoCaseReplyState)();
  // 2026-10-02: 저장본도 eval 가능 — 단 자동발송이 불가능한 문구(허용 토큰 밖/잔여 토큰/발명 URL/정본 외 금액)는
  //   모델 비용을 쓰기 전에 거부한다. eval 은 이 저장 revision 핀으로 기록된다(아래 pin).
  for (const caseId of caseIds) {
    const saved = replyState.overrides.get(caseId);
    if (saved) await assertOverrideAutoSendable(caseId, saved, "evaluated for automatic sending", deps);
  }
  let applicationConversationId: string | undefined;
  if (caseIds.includes("scp_application_received")) {
    if (auth.role !== "super_admin") {
      throw Object.assign(new Error("permission-denied: scp_application_received eval requires super_admin"), {
        code: "permission-denied",
        errorCode: "chat_auto_case_permit_eval_scp_requires_super_admin",
      });
    }
    const safeApplicationConversationId = safeFirestoreDocumentId(data.applicationConversationId);
    if (!safeApplicationConversationId) {
      throw invalidArgument("applicationConversationId must be a nonempty safe Firestore document id for scp_application_received");
    }
    applicationConversationId = safeApplicationConversationId;
  }
  const { buildSha, kRevision } = assertProductionEvalRuntime(deps);
  const now = deps.now?.() ?? new Date();
  if (Number.isNaN(now.getTime())) throw failedPrecondition("eval clock was invalid");
  const evaluatedAtIso = now.toISOString();
  const expiresAtIso = new Date(now.getTime() + EVAL_TTL_MS).toISOString();
  const modelVersion = await currentModelVersion(deps);
  const runner = deps.runGatewayEval ?? defaultPermitGatewayEvalRunner;
  const runIds: string[] = [];
  const permitEventOutcomes: Record<string, { disarmed: boolean; pinMismatch: boolean }> = {};

  for (const caseId of caseIds) {
    const pin = chatAutoCasePermitPin(modelVersion, chatAutoCaseReplyPin(caseId, replyState.overrides, replyState.revisions));
    let heldoutPassed = 0;
    let heldoutFailed = 0;
    let rerollStable = 0;
    let rerollUnstable = 0;
    const transports = new Set<"ai_hub_gateway" | "vertex_direct">();
    let estimatedCostUsd = 0;
    let allow = 0;
    let deny = 0;
    let unavailable = 0;

    const scenarioRecords: ChatAutoEvalScenarioRecord[] = [];
    const record = (verification: Awaited<ReturnType<typeof runEvalScenario>>, phase: "heldout" | "reroll") => {
      scenarioRecords.push(verification.record);
      if (phase === "heldout") {
        if (verification.status === "passed") heldoutPassed += 1;
        else heldoutFailed += 1;
      } else if (verification.status === "passed") rerollStable += 1;
      else rerollUnstable += 1;
      if (verification.transport) transports.add(verification.transport);
      estimatedCostUsd += verification.cost;
      if (verification.decision === "allow") allow += 1;
      else if (verification.decision === "deny") deny += 1;
      else unavailable += 1;
    };

    const heldoutBase = (PERMIT_HELDOUT_FIXTURES_BY_CASE as Partial<Record<ChatAutoPermitCaseId, readonly PermitEvalFixture[]>>)[caseId];
    if (!heldoutBase) throw invalidArgument("caseId must include an auto-ok Permit case with eval fixtures");
    const heldoutScenarios = [...heldoutBase, ...COMMON_NEGATIVE_FIXTURES];
    const rerollSeed = heldoutBase[0];
    const rerollScenarios = Array.from({ length: 3 }, (_, index) => ({
      ...rerollSeed,
      id: `${rerollSeed.id}-reroll-${index + 1}`,
    }));
    const scenarioApplicationConversationId = caseId === "scp_application_received" ? applicationConversationId : undefined;

    for (const scenario of heldoutScenarios) {
      record(await runEvalScenario({ scenario, phase: "heldout", caseId, pin, modelVersion, applicationConversationId: scenarioApplicationConversationId, runner }), "heldout");
    }
    for (const scenario of rerollScenarios) {
      record(await runEvalScenario({ scenario, phase: "reroll", caseId, pin, modelVersion, applicationConversationId: scenarioApplicationConversationId, runner }), "reroll");
    }

    const runId = createHash("sha256")
      .update(`${caseId}\u0000${buildSha}\u0000${kRevision}\u0000${evaluatedAtIso}\u0000${deps.newRunNonce?.() ?? randomUUID()}`)
      .digest("hex")
      .slice(0, 32);
    const evidence: ChatAutoEvalEvidence & { caseId: ChatAutoPermitCaseId; actualGatewayCalls: number; costSummary: { estimatedCostUsd: number }; scenarios: ChatAutoEvalScenarioRecord[] } = {
      status: heldoutFailed === 0 && rerollUnstable === 0 && transports.size > 0 ? "passed" : "failed",
      runId,
      caseId,
      buildSha,
      kRevision,
      casebookHash: pin.casebookHash,
      modelVersion,
      evaluatedAtIso,
      expiresAtIso,
      actualGatewayCall: true,
      bypassGatewayCache: true,
      heldout: { total: heldoutScenarios.length, passed: heldoutPassed, failed: heldoutFailed },
      reroll: { total: rerollScenarios.length, stable: rerollStable, unstable: rerollUnstable },
      decisions: { allow, deny, unavailable },
      transports: [...transports].sort(),
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
      actualGatewayCalls: heldoutScenarios.length + rerollScenarios.length,
      costSummary: { estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)) },
      scenarios: scenarioRecords,
    };
    await (deps.writeEvalRun ?? writeChatAutoCaseEvalRun)(evidence);
    if (evidence.status !== "passed") {
      const outcome = await (deps.appendPermitEvent ?? appendChatAutoCasePermitEvent)({
        caseId,
        reason: "eval_failed",
        sourceRef: `${CHAT_AUTO_CASE_EVAL_RUNS_COLLECTION}/${runId}`,
        nowIso: evaluatedAtIso,
        expectedPin: { casebookHash: pin.casebookHash, modelVersion },
      });
      // Injected test doubles may return nothing — treat that as the legacy "disarmed" contract.
      permitEventOutcomes[caseId] = outcome ?? { disarmed: true, pinMismatch: false };
    }
    runIds.push(runId);
  }
  const envelope = await statusEnvelope(request, caseIds, "chat_auto_case_permit.eval", deps);
  return { ...envelope, runIds, permitEventOutcomes };
}

function sanitizeDecisionLedgerRow(doc: LedgerDocSnapshot): ChatAutoCaseDecisionLedgerRow {
  const record = doc.data();
  return {
    id: doc.id,
    caseId: typeof record.caseId === "string" ? record.caseId : null,
    requestedState: typeof record.requestedState === "string" ? record.requestedState : null,
    evalRunId: typeof record.evalRunId === "string" ? record.evalRunId : null,
    createdAtIso: typeof record.createdAtIso === "string" ? record.createdAtIso : null,
    source: typeof record.source === "string" ? record.source : null,
  };
}

async function readDecisionLedger(input: {
  caseId: ChatAutoPermitCaseId | null;
  cursor: string | null;
  limit: number;
}): Promise<LedgerReadResult> {
  let query: FirebaseFirestore.Query = input.caseId
    ? adminDb.collection(CHAT_AUTO_CASE_DECISION_LEDGER_COLLECTION).where("caseId", "==", input.caseId)
    : adminDb.collection(CHAT_AUTO_CASE_DECISION_LEDGER_COLLECTION);
  query = query.orderBy("createdAtIso", "desc").orderBy(FieldPath.documentId(), "desc").limit(input.limit + 1);
  if (input.cursor?.includes("|")) {
    const [createdAtIso, docId] = input.cursor.split("|", 2);
    query = query.startAfter(createdAtIso, docId);
  }
  const snapshot = await query.get();
  const docs = snapshot.docs.slice(0, input.limit) as LedgerDocSnapshot[];
  const truncated = snapshot.docs.length > input.limit;
  const cursorDoc = truncated ? docs.at(-1) : null;
  return {
    docs,
    truncated,
    nextCursor: cursorDoc ? `${String(cursorDoc.get("createdAtIso") ?? "")}|${cursorDoc.id}` : null,
  };
}

export async function listChatAutoCaseDecisionLedger(
  request: CallableRequestShape,
  deps: LedgerDependencies = {},
): Promise<ChatAutoCaseDecisionLedgerEnvelope> {
  assertSafeRuntimeForStagingAllowedCallable();
  const auth = assertNonGuestAuth(request, "chat_auto_case_permit.ledger", MUTATION_ROLES);
  const data = asRecord(request.data);
  const requestedLimit = Math.floor(Number(data.limit));
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_LEDGER_LIMIT)
    : 50;
  const caseId = typeof data.caseId === "string" && isChatAutoPermitCaseId(data.caseId) ? data.caseId : null;
  const cursor = typeof data.cursor === "string" ? data.cursor : null;
  const page = await (deps.readDecisionLedger ?? readDecisionLedger)({ caseId, cursor, limit });
  return {
    ok: true,
    rows: page.docs.map(sanitizeDecisionLedgerRow),
    pageInfo: {
      limit,
      truncated: page.truncated,
      nextCursor: page.nextCursor,
    },
    behaviorLog: { ...makeBehaviorLog(auth, "chat_auto_case_permit.ledger", "success") },
  };
}

// ── Casebook snapshot (2026-09-28, "simplify in place" direction, owner-approved) ──────────────
// Replaces the old three-callable console (getChatAutoCasePermitStatus's replyText +
// getChatAutoCaseSendHistory + getChatAutoCaseUnhandledStats) with ONE read callable. Five review
// rounds on the old shape found real defects (missing entitlement, viewAs scope-state races,
// pagination correctness, and two DATA-DEFINITION mismatches: "미처리" counted historical denied
// decisions rather than a live backlog, and "확정 발송" mixed human/mock/failed sends). This
// callable fixes both definitions rather than re-patching the old ones:
//   - pending = the same unreplied-inbox rules already used to scope the flush backlog
//     (functions/read.ts listUnrepliedInboxHandler — reused by calling it, not forked), grouped
//     per case via the autoCaseId/autoCaseMessageRef stamp chat-ai.ts now writes for every
//     classified inbound (see functions/chat-ai.ts persistReceivedEmail).
//   - "확정 발송" = only sender=="ai" && deliveryState=="sent" && providerConfirmed==true rows.
// getChatAutoCasePermitStatus itself is UNCHANGED and stays (admin/verify still uses it); the
// arm/eval mutations (setChatAutoCasePermitArming, runChatAutoCasePermitEval) are untouched — the
// client refreshes this snapshot after calling them.
export type ChatAutoCaseCommittedSendRow = {
  id: string;
  conversationId: string | null;
  sender: "human" | "ai" | null;
  approval: "approved" | "rejected" | "skipped" | "unknown" | null;
  deliveryState: "sent" | "mock_sent" | "blocked" | "failed" | "skipped_duplicate" | "unknown" | null;
  providerConfirmed: boolean;
  bounced: boolean;
  complained: boolean;
  optedOut: boolean;
  suppressed: boolean;
  atIso: string | null;
};

type CommittedSendDocSnapshot = { id: string; data: () => Record<string, unknown>; get: (field: string) => unknown };
const COMMITTED_APPROVALS = new Set(["approved", "rejected", "skipped", "unknown"]);
const COMMITTED_DELIVERY_STATES = new Set(["sent", "mock_sent", "blocked", "failed", "skipped_duplicate", "unknown"]);

function sanitizeCommittedSendRow(doc: CommittedSendDocSnapshot): ChatAutoCaseCommittedSendRow {
  const record = doc.data();
  return {
    id: doc.id,
    conversationId: typeof record.conversationId === "string" ? record.conversationId : null,
    sender: record.sender === "human" || record.sender === "ai" ? record.sender : null,
    approval: typeof record.approval === "string" && COMMITTED_APPROVALS.has(record.approval)
      ? record.approval as ChatAutoCaseCommittedSendRow["approval"]
      : null,
    deliveryState: typeof record.deliveryState === "string" && COMMITTED_DELIVERY_STATES.has(record.deliveryState)
      ? record.deliveryState as ChatAutoCaseCommittedSendRow["deliveryState"]
      : null,
    providerConfirmed: record.providerConfirmed === true,
    bounced: record.bounced === true,
    complained: record.complained === true,
    optedOut: record.optedOut === true,
    suppressed: record.suppressed === true,
    atIso: typeof record.sentAtIso === "string" ? record.sentAtIso : null,
  };
}

const SNAPSHOT_CONFIRMED_SENDS_LIMIT = 20;

// "확정 발송" = provider-confirmed AI sends only — excludes human-authored sends, mock sends
// (staging/dev), and failed/blocked delivery attempts, which the old caseId+sentAtIso-only index
// let leak into the same list undifferentiated. Needs its own composite index (registered in
// firestore.indexes.json + PRODUCTION_REQUIRED_INDEXES) — the old chat_auto_case_committed_sends
// caseId+sentAtIso index this branch previously added is now dead and has been removed.
async function readLatestConfirmedSends(caseId: ChatAutoPermitCaseId): Promise<ChatAutoCaseCommittedSendRow[]> {
  const snapshot = await adminDb
    .collection(CHAT_AUTO_CASE_COMMITTED_SENDS_COLLECTION)
    .where("caseId", "==", caseId)
    .where("sender", "==", "ai")
    .where("deliveryState", "==", "sent")
    .where("providerConfirmed", "==", true)
    .orderBy("sentAtIso", "desc")
    .limit(SNAPSHOT_CONFIRMED_SENDS_LIMIT)
    .get();
  return snapshot.docs.map((doc) => sanitizeCommittedSendRow(doc as CommittedSendDocSnapshot));
}

// ── pending count (2026-09-29 casebook snapshot 504 hotfix) ─────────────────────────────────────
// This callable used to run the unreplied-inbox scan INLINE here (via listUnrepliedInboxHandler,
// cached 15s per caller scope) — slow enough in production (~900 conversation reads + ~200
// manual-reply checks) to hit the 60s Cloud Run request timeout and 504 the whole console. That
// scan now runs on a schedule instead (functions/chatAutoCasebookPendingPrecompute.ts
// writeChatAutoCasebookPendingSnapshots, index.ts chatAutoCasebookPendingPrecomputeSchedule, every
// 15 minutes) and persists one doc per scope to chat_auto_casebook_pending/{scopeKey}.
// computePendingCaseTotals below keeps its exact old name/signature (still the
// SnapshotDependencies.computePendingTotals seam getChatAutoCasebookSnapshot injects) but now only
// ever does a single fast Firestore doc get — never the scan — so this callable can no longer be
// blocked by it. See readChatAutoCasebookPendingSnapshot's own doc comment for the
// fresh/stale/missing contract the extra `status`/`computedAtIso` fields below carry to the UI.
export async function computePendingCaseTotals(
  request: CallableRequestShape,
  now?: () => Date,
): Promise<PendingCaseTotals & { status: ChatAutoCasebookPendingStatus; computedAtIso: string | null }> {
  // assertScpEntitled has already run in getChatAutoCasebookSnapshot before this is called —
  // re-deriving auth here is the same cheap, idempotent read every other handler in this file
  // does from the same request object, not a second authorization decision.
  const auth = assertNonGuestAuth(request, "chat_auto_casebook_snapshot.get.pending_snapshot_read");
  const read = await readCallerChatAutoCasebookPendingSnapshot(auth, now);
  if (read.status === "missing") {
    return { totalPending: 0, truncated: false, exact: false, countStatus: "unknown", asOfIso: null, byCaseId: new Map(), unclassifiedCount: 0, status: "missing", computedAtIso: null };
  }
  const byCaseId = new Map<ChatAutoPermitCaseId, number>();
  for (const [caseId, count] of Object.entries(read.data.byCaseId)) {
    if (isChatAutoPermitCaseId(caseId) && typeof count === "number") byCaseId.set(caseId, count);
  }
  return {
    totalPending: read.data.pendingTotal,
    truncated: read.data.truncated,
    exact: read.data.exact,
    countStatus: read.data.countStatus,
    asOfIso: read.data.asOfIso,
    byCaseId,
    unclassifiedCount: read.data.unclassifiedCount,
    ...(read.data.breakdown ? { breakdown: read.data.breakdown } : {}),
    status: read.status,
    computedAtIso: read.data.computedAtIso,
  };
}

// Casebook inbox (2026-10-01, AGG lane): per-row operator attention, derived ONLY from state the
// snapshot has already loaded for the row (effective permit state, eval evidence freshness/expiry,
// pin vs current casebook hash, casebook escalation, pendingCount) — no extra reads or model calls.
//   autoReply: "healthy" = armed AND the effective state is usable right now (eval fresh, pins
//     current, not expired); "armed_unhealthy" = armed but the effective state would not send;
//     "off" = not armed (including every case the casebook never auto-replies to).
//   needsHuman: pendingCount > 0 (waiting conversations — held rows when healthy) OR autoReply ===
//     "armed_unhealthy" (armed but would not send — someone must fix eval/pin) OR the pending count is
//     not PROVEN (snapshot missing/computing/lower_bound/truncated — an unknown backlog is never hidden).
//     An OFF case with a proven-exact 0 is NOT a human task (0.6.104 live check: 19/20 rows under
//     사람 처리 필요 hid the real work); it stays visible under 전체.
//   reasons (stable codes): not_armed · blocked_case (escalation is not auto_ok — no auto reply is
//     possible by casebook design) · pin_mismatch (permit pin != current casebook/model) ·
//     eval_expired (armed, evidence past expiresAtIso) · eval_stale (armed, evidence missing/failed/
//     not current for the pin or build) · pending_while_armed (healthy-or-not, rows are waiting).
export type ChatAutoCasebookRowAttention = {
  autoReply: "healthy" | "armed_unhealthy" | "off";
  needsHuman: boolean;
  reasons: string[];
};

export function chatAutoCasebookRowAttention(
  caseId: ChatAutoPermitCaseId,
  base: Pick<ChatAutoCasePermitStatusRow, "armed" | "state" | "eval">,
  pendingCount: number,
  pendingCountExact: boolean,
): ChatAutoCasebookRowAttention {
  const reasons: string[] = [];
  let autoReply: ChatAutoCasebookRowAttention["autoReply"];
  if (!isChatAutoArmableCaseId(caseId)) {
    autoReply = "off";
    reasons.push("blocked_case");
  } else if (!base.armed) {
    autoReply = "off";
    reasons.push("not_armed");
  } else if (base.state === "stale_pin") {
    autoReply = "armed_unhealthy";
    reasons.push("pin_mismatch");
  } else if (base.state === "eval_failed") {
    autoReply = "armed_unhealthy";
    reasons.push(base.eval.status === "expired" ? "eval_expired" : "eval_stale");
  } else if (base.state !== "armed") {
    // Defensive: an armed permit whose stored state is not "armed" cannot send either.
    autoReply = "armed_unhealthy";
    reasons.push("not_armed");
  } else {
    autoReply = "healthy";
  }
  // 답장 불필요 케이스(부재중 등, 0.6.105): 대기 대화가 있어도 사람 답장이 필요 없다 — 표시만 바꾼다.
  // 단 자동답장이 켜졌는데 고장(armed_unhealthy)이면 그대로 사람 확인, 대기 수가 증명되지 않았으면(비신선/하한/
  // 집계 전) 기존 규칙대로 숨기지 않는다.
  if (isCasebookNoReplyNeeded(caseId) && pendingCountExact && autoReply !== "armed_unhealthy") {
    return { autoReply, needsHuman: false, reasons: ["no_reply_needed"] };
  }
  if (autoReply !== "off" && pendingCount > 0) reasons.push("pending_while_armed");
  return { autoReply, needsHuman: pendingCount > 0 || autoReply === "armed_unhealthy" || !pendingCountExact, reasons };
}

// Per-case reply text explicitly states whether the visible text is static, edited, or unavailable.
export type ChatAutoCasebookSnapshotRow = Omit<ChatAutoCasePermitStatusRow, "replyText"> & {
  replyText: ChatAutoCaseReplyView;
  pendingCount: number;
  attention: ChatAutoCasebookRowAttention;
  // Casebook inbox (2026-10-01, contract §1): the link tokens (no fact tokens such as
  // GUIDELINE_AMOUNT) this case's reply may use, and the background-precomputed English default
  // suggestion (text only when status === "ready").
  allowedLinkTokens: string[];
  defaultSuggestion: ChatAutoCaseDefaultSuggestionView;
};

const PENDING_DEFAULT_SUGGESTION: ChatAutoCaseDefaultSuggestionView = {
  status: "pending",
  text: null,
  generatedAtIso: null,
  modelId: null,
};
const NOT_APPLICABLE_DEFAULT_SUGGESTION: ChatAutoCaseDefaultSuggestionView = {
  status: "not_applicable",
  text: null,
  generatedAtIso: null,
  modelId: null,
};

// Read-only and failure-tolerant by design: the suggestion doc is a convenience layer on top of the
// snapshot, so an unreadable collection must never take the whole console (counts, permits, reply
// text) down with it. On any failure every row degrades to "pending" (hard cases that never carry a
// suggestion stay "not_applicable" — that is static casebook truth, not read state) and the error is
// logged for the operator; the next snapshot retries.
async function readSnapshotDefaultSuggestions(
  caseIds: readonly ChatAutoPermitCaseId[],
  replyState: Awaited<ReturnType<typeof readChatAutoCaseReplyState>>,
  now: Date,
  read: typeof readChatAutoCaseDefaultSuggestions,
): Promise<Map<string, ChatAutoCaseDefaultSuggestionView>> {
  try {
    return await read(caseIds, replyState, now);
  } catch (error) {
    console.error("[getChatAutoCasebookSnapshot] default-suggestion read failed — every row degrades to pending", {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map(caseIds.map((caseId) => [
      caseId,
      isChatAutoCaseSuggestionApplicable(caseId) ? PENDING_DEFAULT_SUGGESTION : NOT_APPLICABLE_DEFAULT_SUGGESTION,
    ]));
  }
}

function sanitizeSnapshotRow(
  caseId: ChatAutoPermitCaseId,
  permit: ChatAutoCasePermitDoc | null,
  latestEvidence: ChatAutoEvalEvidence | null,
  nowIso: string,
  modelVersion: string,
  sourceCommit: string | null,
  pendingCount: number,
  pendingCountExact: boolean,
  replyState: Awaited<ReturnType<typeof readChatAutoCaseReplyState>>,
  defaultSuggestion: ChatAutoCaseDefaultSuggestionView,
): ChatAutoCasebookSnapshotRow {
  // replyTextEntitled is fixed `true` here — assertScpEntitled already gated the WHOLE snapshot
  // callable at its entry (single entitlement check, per the direction), unlike
  // getChatAutoCasePermitStatus which gates replyText per-row because that callable itself has no
  // blanket entitlement gate.
  const replyText = chatAutoCaseReplyView(caseId, replyState.overrides, replyState.revisions);
  const base = sanitizeStatusRow(caseId, permit, latestEvidence, nowIso, modelVersion, sourceCommit, true, replyText.casebookHash);
  return {
    ...base,
    replyText,
    pendingCount,
    attention: chatAutoCasebookRowAttention(caseId, base, pendingCount, pendingCountExact),
    allowedLinkTokens: chatAutoCaseAllowedLinkTokens(caseId),
    defaultSuggestion,
  };
}

function snapshotCaseIds(): ChatAutoPermitCaseId[] {
  // Every managed case EXCEPT auto_close: those threads are closed with zero review/reply by
  // casebook design (functions/chatCasebook.ts), so they have nothing to show in this console —
  // and in practice never accumulate "pending" rows either (their conversations don't stay in
  // waiting_for_human/draft_only once closed).
  return CHAT_CASEBOOK.filter((item) => item.escalation !== "auto_close").map((item) => item.id);
}

export type GetChatAutoCasebookSnapshotRequest = { selectedCaseId?: string };

export type ChatAutoCasebookPendingBreakdownEnvelope = {
  status: "available" | "unavailable";
  /** Sum of row.pendingCount over the displayed rows (every non-auto_close casebook case). */
  managedCaseTotal: number;
  /** Fresh stamps on auto_close cases — closed by design, deliberately not a displayed row. */
  closedCaseCount: number;
  unclassified: {
    total: number;
    byReason: ChatAutoCasebookUnclassifiedByReason;
    /** Subset of byReason.never_classified whose last inbound predates the stamp launch
     *  (CHAT_AUTO_CASE_STAMP_LAUNCH_ISO) — legacy mail, not a classification failure. null = unknown
     *  (older doc/row-cache), never 0. */
    neverClassifiedBeforeStampLaunch: number | null;
  };
  /**
   * 답장 불필요 오버레이(0.6.105, status==="available" 일 때만): 신선 스탬프 대기 중 noReplyNeeded 케이스
   * (부재중 등, 표시 행) + closedCaseCount(auto_close 종결 인사). 불변식(total = managed + closed + unclassified)
   * 은 그대로 — 이건 그 위에 겹쳐 보는 묶음일 뿐, 어떤 대화 상태도 바꾸지 않는다.
   */
  noReplyNeeded?: { total: number; byCaseId: Record<string, number> };
};

/** auto_close 케이스(closedCaseCount 가 세는 것) — 표시 행이 아니라 종결 묶음으로만 센다. */
const AUTO_CLOSE_SNAPSHOT_CASE_IDS = CHAT_CASEBOOK.filter((item) => item.escalation === "auto_close").map((item) => item.id);

function buildNoReplyNeededOverlay(
  rows: readonly ChatAutoCasebookSnapshotRow[],
  closedCaseCount: number,
): { total: number; byCaseId: Record<string, number> } | undefined {
  // closedCaseCount 는 auto_close 케이스 전체 합이라, 케이스가 하나일 때만 그 id 로 귀속할 수 있다.
  if (AUTO_CLOSE_SNAPSHOT_CASE_IDS.length !== 1) return undefined;
  const byCaseId: Record<string, number> = {};
  for (const row of rows) {
    if (isCasebookNoReplyNeeded(row.caseId)) byCaseId[row.caseId] = row.pendingCount;
  }
  byCaseId[AUTO_CLOSE_SNAPSHOT_CASE_IDS[0]] = closedCaseCount;
  const total = Object.values(byCaseId).reduce((sum, count) => sum + count, 0);
  return { total, byCaseId };
}

function buildPendingBreakdown(
  rows: readonly ChatAutoCasebookSnapshotRow[],
  pending: Pick<PendingCaseTotals, "totalPending" | "unclassifiedCount" | "breakdown">,
): ChatAutoCasebookPendingBreakdownEnvelope {
  const managedCaseTotal = rows.reduce((sum, row) => sum + row.pendingCount, 0);
  const unavailable: ChatAutoCasebookPendingBreakdownEnvelope = {
    status: "unavailable",
    managedCaseTotal,
    closedCaseCount: 0,
    unclassified: { total: pending.unclassifiedCount, byReason: emptyUnclassifiedByReason(), neverClassifiedBeforeStampLaunch: null },
  };
  const breakdown = pending.breakdown;
  if (!breakdown) return unavailable;
  const byReasonTotal = CHAT_AUTO_CASEBOOK_UNCLASSIFIED_REASONS.reduce((sum, reason) => sum + breakdown.unclassifiedByReason[reason], 0);
  if (
    byReasonTotal !== pending.unclassifiedCount
    || managedCaseTotal + breakdown.closedCaseCount + pending.unclassifiedCount !== pending.totalPending
  ) return unavailable;
  const noReplyNeeded = buildNoReplyNeededOverlay(rows, breakdown.closedCaseCount);
  return {
    status: "available",
    managedCaseTotal,
    closedCaseCount: breakdown.closedCaseCount,
    unclassified: {
      total: pending.unclassifiedCount,
      byReason: { ...breakdown.unclassifiedByReason },
      neverClassifiedBeforeStampLaunch: breakdown.neverClassifiedBeforeStampLaunch ?? null,
    },
    ...(noReplyNeeded ? { noReplyNeeded } : {}),
  };
}

export type ChatAutoCasebookSnapshotEnvelope = {
  ok: true;
  rows: ChatAutoCasebookSnapshotRow[];
  // status/computedAtIso (2026-09-29 hotfix): count/truncated always reflect the LAST precomputed
  // doc (never a live scan — see computePendingCaseTotals's doc comment), so the UI can render
  // "N분 전 기준" from computedAtIso and only needs a "계산 중" placeholder when status is
  // "missing" (no doc has ever been written for this scope yet). "stale" still carries real last-
  // known numbers — it is not an error state, just an aging one.
  pendingTotal: { count: number; truncated: boolean; exact: boolean; countStatus: "exact" | "lower_bound" | "unknown"; asOfIso: string | null; status: ChatAutoCasebookPendingStatus; computedAtIso: string | null };
  unclassifiedPendingCount: number;
  // Casebook inbox (2026-10-01, AGG lane): reconciles pendingTotal.count with the displayed rows.
  // "available" only when the pending doc carries the precompute's breakdown fields AND they add up
  // (managedCaseTotal + closedCaseCount + unclassified.total === pendingTotal.count, and byReason
  // sums to unclassified.total) — an old/missing/inconsistent doc is "unavailable", never zeros.
  pendingBreakdown: ChatAutoCasebookPendingBreakdownEnvelope;
  // Contract §1: the reviewed link catalog ({{TOKEN}} → label + url) the reply editor offers; the
  // per-row `allowedLinkTokens` says which of these a given case may use.
  replyLinkCatalog: ChatAutoCaseReplyLinkCatalogEntry[];
  selected: { caseId: string; sends: ChatAutoCaseCommittedSendRow[] } | null;
  cache: { generatedAtIso: string; maxAgeSeconds: number };
  behaviorLog: Record<string, unknown>;
};

type SnapshotDependencies = Pick<EvalDependencies, "resolveModelVersion" | "resolveSourceCommit" | "readPermitMap" | "readLatestEvalMap" | "now"> & {
  computePendingTotals?: typeof computePendingCaseTotals;
  readConfirmedSends?: typeof readLatestConfirmedSends;
  readCaseReplyState?: typeof readChatAutoCaseReplyState;
  readDefaultSuggestions?: typeof readChatAutoCaseDefaultSuggestions;
};

function viewAsRequested(data: Record<string, unknown>): boolean {
  return (typeof data.viewAsUserId === "string" && data.viewAsUserId.trim().length > 0)
    || (typeof data.viewAsEmail === "string" && data.viewAsEmail.trim().length > 0);
}

export async function getChatAutoCasebookSnapshot(
  request: CallableRequestShape,
  deps: SnapshotDependencies = {},
): Promise<ChatAutoCasebookSnapshotEnvelope> {
  const auth = assertNonGuestAuth(request, "chat_auto_casebook_snapshot.get");
  const data = asRecord(request.data);
  // Block viewAs entirely for this console (codex+devin direction review, 2026-09-28): this data
  // is program-wide for every scp-entitled operator, so a preview could only ever answer the
  // binary "is this member entitled" question — three of five review rounds on the old
  // three-callable console were viewAs scope-state races. Reject loudly here (directly unit-
  // testable without an emulator) rather than rely solely on this callable being absent from
  // viewAsWriteGuard.ts's allowlist (which also rejects it, as defense in depth) — a silent
  // ignore would show the OPERATOR's own real data while they believe they're previewing someone
  // else's, which is worse than an explicit block. The UI shows a blocked state and never calls
  // this while viewAs is active.
  if (viewAsRequested(data)) {
    throw Object.assign(new Error("permission-denied: this console does not support viewAs preview"), {
      code: "permission-denied",
      errorCode: "chat_auto_casebook_snapshot_view_as_unsupported",
      behaviorLog: makeDeniedBehaviorLog(request, "chat_auto_casebook_snapshot.get", auth.gameId),
    });
  }
  // Single entitlement gate for the whole callable (direction: "entitlement once at the snapshot
  // entry via assertScpEntitled") — replaces the old per-callable/per-field checks.
  await assertScpEntitled(auth, request, "chat_auto_casebook_snapshot.get");
  const selectedCaseId = typeof data.selectedCaseId === "string" && isChatAutoPermitCaseId(data.selectedCaseId)
    ? data.selectedCaseId
    : null;
  const nowDate = deps.now?.() ?? new Date();
  const nowIso = nowDate.toISOString();
  const modelVersion = await currentModelVersion(deps);
  const sourceCommit = await currentSourceCommit(deps);
  const caseIds = snapshotCaseIds();
  const [permits, latest, pending, { replyState, defaultSuggestions }] = await Promise.all([
    (deps.readPermitMap ?? readChatAutoCasePermitMap)(caseIds),
    (deps.readLatestEvalMap ?? latestEvalEvidenceMap)(caseIds),
    (deps.computePendingTotals ?? computePendingCaseTotals)(request, deps.now),
    // The suggestion read keys off the reply revisions, so it chains after the reply-state read —
    // still inside this Promise.all, so it overlaps the permit/eval/pending reads.
    (async () => {
      const state = await (deps.readCaseReplyState ?? readChatAutoCaseReplyState)();
      return {
        replyState: state,
        defaultSuggestions: await readSnapshotDefaultSuggestions(
          caseIds,
          state,
          nowDate,
          deps.readDefaultSuggestions ?? readChatAutoCaseDefaultSuggestions,
        ),
      };
    })(),
  ]);
  // A count may hide a case from the default view only when PROVEN zero: exact, not truncated, and
  // a FRESH snapshot. A stale exact 0 is only "zero as of the last precompute" — the precompute may
  // have stopped while new inquiries arrived — so stale/missing (like lower_bound/unknown) leave the
  // per-case 0 unproven and the row stays visible.
  const pendingCountExact = pending.exact === true && pending.countStatus === "exact" && !pending.truncated && pending.status === "fresh";
  const rows = caseIds.map((caseId) => sanitizeSnapshotRow(
    caseId,
    permits.get(caseId) ?? null,
    latest.get(caseId) ?? null,
    nowIso,
    modelVersion,
    sourceCommit,
    pending.byCaseId.get(caseId) ?? 0,
    pendingCountExact,
    replyState,
    defaultSuggestions.get(caseId) ?? PENDING_DEFAULT_SUGGESTION,
  ));
  const selected = selectedCaseId
    ? { caseId: selectedCaseId, sends: await (deps.readConfirmedSends ?? readLatestConfirmedSends)(selectedCaseId) }
    : null;
  return {
    ok: true,
    rows,
    pendingTotal: {
      count: pending.totalPending,
      truncated: pending.truncated,
      exact: pending.exact,
      countStatus: pending.countStatus,
      asOfIso: pending.asOfIso,
      status: pending.status ?? "fresh",
      computedAtIso: pending.computedAtIso ?? null,
    },
    unclassifiedPendingCount: pending.unclassifiedCount,
    pendingBreakdown: buildPendingBreakdown(rows, pending),
    replyLinkCatalog: chatAutoCaseReplyLinkCatalog(),
    selected,
    cache: { generatedAtIso: nowIso, maxAgeSeconds: 15 },
    behaviorLog: { ...makeBehaviorLog(auth, "chat_auto_casebook_snapshot.get", "success") },
  };
}

// 헤세 지시(2026-09-24, JEV 컨텍스트 모순 수리 부수 작업 — permit evalEvidence TTL 자연 만료 수리):
//   armed permit 의 evalEvidence 는 24h TTL 로 발송 시점(evalEvidencePasses, chatAutoCasePermit.ts)
//   과 상태 조회(effectivePermitState, 위)에서 모두 살아있는지 재확인되지만, 그 TTL 을 미리 갱신
//   하는 스케줄이 없어 계속 active 한 armed 케이스도 24h 마다 자연 만료해 다음 발송이 조용히
//   hold(jev_required_template_unavailable 류)로 빠진다(conv_13ioed9 실사고와 별개로 발견된
//   인접 사각지대). 이 진입점은 그 TTL 이 만료되기 전(<24h, 여유 있는 12h 주기 — index.ts
//   refreshChatAutoCasePermitsSchedule)에 armed 인 케이스만 골라 같은 eval
//   (runChatAutoCasePermitEval)을 다시 돌려 evalEvidence 를 갱신한다.
//
//   코덱스 적대 리뷰(2026-09-24) 지적: runChatAutoPermitGatewayEvalScenario(chat-ai.ts)는
//   scp_application_received 이외 케이스에는 mailAccountId/subject/body 를 싣지 않는다 — 이
//   스윕이 건드리는 케이스들(interest_next_steps 등)은 그 결과 jevRequired 가 false 가 되어
//   runGatewayLive 의 실제 JEV send-decision 콜은 상담되지 않는다(기존 runChatAutoCasePermitEval
//   자체의 특성이며 이 스윕이 새로 만든 문제가 아니다 — 수동 "eval 실행" 콘솔 버튼도 동일하다).
//   이 스윕이 실제로 재검증하는 것은 라이브 Gateway 트리아지 호출 + 케이스 분류 일치(heldout/
//   reroll)이며, evalEvidencePasses 가 요구하는 필드(actualGatewayCall/bypassGatewayCache/
//   heldout·reroll 전원 통과 등)를 갱신하는 데는 충분하다 — 다만 "라이브 JEV 재상담까지 보장"
//   이라고는 주장하지 않는다.
//
//   scp_application_received 는 super_admin 전용 + applicationConversationId(개인 신원 검증
//   경로)가 필수라 범용 스윕 대상에서 의도적으로 제외한다 — armed 여도 skipped 로 기록하고
//   건드리지 않는다(그 case 는 오늘도 발송 시점에 evalEvidencePasses 로 개별 재확인된다, 기존
//   동작 불변).
//
//   eval 실패는 이 스윕이 만들지 않는다 — runChatAutoCasePermitEval 자체가 이미 실패 시
//   appendChatAutoCasePermitEvent(reason:"eval_failed")로 permit 을 disarm 한다(기존 동작,
//   변경하지 않는다). 이 스윕은 그 결과를 console.error 로 눈에 보이게 남길 뿐이다(COST-P0:
//   비용은 evidence.costSummary 로 chat_auto_case_eval_runs 문서에 이미 기록된다 — 이 스윕이
//   별도 비용 로그를 추가하지 않는다).
//
// SYSTEM_ACTOR 패턴은 scpOutreach.ts/scpOutboxMailWorkers.ts 를 그대로 따른다 — 스케줄에는
//   최종 사용자가 없고, 스케줄 자체가 인가다. runChatAutoCasePermitEval 은 이미 production-only
//   런타임 게이트(assertProductionEvalRuntime)를 갖고 있어 비-production/스테이징에서는
//   자동으로 실패한다 — 아래에서 catch 해 로그만 남기고 조용히 넘어간다.
const CHAT_AUTO_CASE_PERMIT_REFRESH_SYSTEM_ACTOR: AuthContext = {
  userId: "chat-auto-permit-refresh-scheduler",
  role: "manager",
  team: "aix",
  ip: "0.0.0.0",
  gameId: "scp-automation",
  email: "chat-auto-permit-refresh@supercent.io",
  name: "Chat Auto Permit Refresh Scheduler",
};

// Build the CallableRequestShape runChatAutoCasePermitEval expects, carrying the synthetic
// scheduler actor (mailRequestFor()/scpOutreach.ts 와 동일 패턴) — 공개 입구가 아니라 서버가
// 만든 내부 스케줄 호출이므로 internalTrustedInvocation:true 로 provenance strip 대상에서 뺀다.
function chatAutoCasePermitRefreshRequestFor(caseIds: readonly ChatAutoPermitCaseId[]): CallableRequestShape {
  const actor = CHAT_AUTO_CASE_PERMIT_REFRESH_SYSTEM_ACTOR;
  return {
    internalTrustedInvocation: true,
    auth: {
      uid: actor.userId,
      token: {
        role: actor.role,
        team: actor.team,
        gameId: actor.gameId,
        email: actor.email,
        name: actor.name,
      },
    },
    data: {
      caseIds: [...caseIds],
      confirm: "RUN_CHAT_AUTO_CASE_PERMIT_EVAL:scheduled_permit_refresh",
      bypassGatewayCache: true,
    },
    rawRequest: { ip: actor.ip },
  };
}

export type ChatAutoCasePermitRefreshResult = {
  ok: true;
  scanned: number;
  refreshed: string[];
  failed: string[];
  skipped: string[];
  behaviorLog: Record<string, unknown>;
};

export async function refreshArmedChatAutoCasePermits(
  deps: EvalDependencies & Pick<ArmingDependencies, "setPermit"> & {
    // Testability seam (no emulator required) — the real default calls this module's own
    // runChatAutoCasePermitEval, which requires the production-only runtime gate.
    runPermitEval?: typeof runChatAutoCasePermitEval;
    // release-refresh-repin (2026-09-25): same injectable-Slack-poster seam
    // notifyChatAutoPermitReleaseDisarmOnce (chat-ai.ts) used to use — lets unit tests (e.g.
    // tests/chat-auto-case-permit-refresh-schedule.test.mjs) assert on the failure notification
    // without a real network call.
    postToSlack?: typeof postScheduledReportToSlack;
  } = {},
): Promise<ChatAutoCasePermitRefreshResult> {
  // 무장 해제 Slack 알림 중 전달 실패/유실분 재시도(운영 경로 전용 — 주입된 테스트 deps 에서는 건너뜀).
  if (!deps.readPermitMap) await retryPendingChatAutoPermitDisarmAlerts({ postToSlack: deps.postToSlack });
  const readPermits = deps.readPermitMap ?? readChatAutoCasePermitMap;
  const permitMap = await readPermits(chatAutoPermitAutoOkCaseIds());
  const replyState = await (deps.readCaseReplyState ?? readChatAutoCaseReplyState)();
  const skipped: string[] = [];
  const eligible: ChatAutoPermitCaseId[] = [];
  for (const [caseId, permit] of permitMap) {
    if (permit.armed !== true || permit.state !== "armed") continue;
    // scp_application_received requires super_admin + a specific applicationConversationId — out
    // of scope for a generic sweep (see module doc above); its own send-time re-check is unaffected.
    if (caseId === "scp_application_received") {
      skipped.push(caseId);
      continue;
    }
    // 코덱스 적대 리뷰(2026-09-24, 3회차): operator_override 로 arm 된 permit 을 "counter_floor"
    //   경로로 재-arm 하면 카운터 플로어 미달로 항상 실패한다(그 permit 이 애초에 override 로
    //   arm 된 이유가 플로어 미달이었으므로) — 매 12h 마다 조용히 failed 만 쌓인다. 반대로 이
    //   스윕이 armingSource 를 그대로 "operator_override" 로 재-write 하면, super_admin 이 아닌
    //   이 스윕의 SYSTEM_ACTOR(role:"manager") 가 새 override 를 승인한 것처럼 감사기록에 남는다
    //   (overrideActorUidHash/overrideAtIso 가 setChatAutoCasePermitFromVerifiedEvidence 안에서
    //   호출자 신원으로 다시 채워진다) — 둘 다 받아들일 수 없다. 어느 쪽도 하지 않고 처음부터
    //   제외한다 — eval 비용도 아낀다. operator_override 갱신은 여전히 사람이 콘솔에서 한다
    //   (이 스윕이 생기기 전과 동일한 동작).
    if (permit.armingSource === "operator_override") {
      skipped.push(caseId);
      continue;
    }
    // 2026-10-02 (헤세 결정 — 운영자 저장 답신 자동발송): 저장본이 있는 케이스는 계속 건너뛴다. 저장본 arm 은
    //   super_admin 의 operator_override 경로로만 가능한데(위 분기가 이미 그런 permit 을 제외한다), 이
    //   스윕의 SYSTEM_ACTOR(role:"manager")는 저장본을 재승인할 수 없고 counter_floor 로 재-write 하면
    //   저장 revision 에 대한 사람의 승인이 시스템 승인으로 둔갑한다. 가장 작은 안전 선택 — 저장본 permit
    //   의 evalEvidence 가 24h 뒤 만료되면 발송은 사람 검토로 되돌아가고(evaluateChatAutoCasePermit
    //   eval_not_passed), super_admin 이 콘솔에서 재검증·재무장한다.
    if (replyState.overrides.has(caseId)) {
      skipped.push(caseId);
      continue;
    }
    eligible.push(caseId);
  }
  if (eligible.length === 0) {
    return {
      ok: true,
      scanned: permitMap.size,
      refreshed: [],
      failed: [],
      skipped,
      behaviorLog: { ...makeBehaviorLog(CHAT_AUTO_CASE_PERMIT_REFRESH_SYSTEM_ACTOR, "chat_auto_case_permit.refresh", "success") },
    };
  }
  let evalPassed: ChatAutoPermitCaseId[] = [];
  // release-refresh-repin (2026-09-25, Codex gate round 1 MEDIUM): these three ARE NOT the same
  // outcome and must not be reported to Slack as one undifferentiated "disarmed" bucket —
  // evalFailedDisarmed is the only one runChatAutoCasePermitEval actually disarmed (its own
  // reason:"eval_failed" path, unchanged); evalCallThrew means the eval call itself never
  // completed (production-runtime gate, network, etc.) — those cases' permits are untouched,
  // still armed with stale evidence, NOT disarmed; writeBackFailed (populated further below) means
  // the eval passed but the re-pin write-back didn't land — also still armed with stale evidence,
  // not disarmed. `failed` (the function's existing return-shape contract) stays their union.
  let evalFailedDisarmed: string[] = [];
  // eval failed but appendChatAutoCasePermitEvent did NOT disarm (pin_mismatch no-op: the live permit is already
  // pinned to a newer casebook/model, or it was no longer armed) — must never be announced as "disarmed".
  let evalFailedNotDisarmed: string[] = [];
  let evalCallThrew: string[] = [];
  try {
    const request = chatAutoCasePermitRefreshRequestFor(eligible);
    const runEval = deps.runPermitEval ?? runChatAutoCasePermitEval;
    const result = await runEval(request, deps);
    for (const row of result.rows) {
      if (!eligible.includes(row.caseId as ChatAutoPermitCaseId)) continue;
      if (row.eval.status === "passed") evalPassed.push(row.caseId as ChatAutoPermitCaseId);
      else {
        const outcome = result.permitEventOutcomes?.[row.caseId];
        if (outcome && !outcome.disarmed) evalFailedNotDisarmed.push(row.caseId);
        else evalFailedDisarmed.push(row.caseId);
      }
    }
  } catch (error) {
    evalCallThrew = [...eligible];
    console.error("[refreshArmedChatAutoCasePermits] eval refresh threw", {
      caseIds: eligible,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (evalFailedDisarmed.length > 0) {
    // 알림: runChatAutoCasePermitEval 이 이미 실패한 caseId 를 disarm 했다(기존 동작, 위 모듈 doc
    //   참고) — 이 로그는 그 사실을 사람이 볼 수 있게 남기는 용도다(silent disarm 방지). Slack
    //   알림은 write-back 결과까지 전부 확정된 뒤 함수 끝에서 한 번에 보낸다(아래).
    console.error("[refreshArmedChatAutoCasePermits] eval refresh failed for armed permits", { failed: evalFailedDisarmed });
  }

  // 코덱스 적대 리뷰(2026-09-24, 1회차) BLOCKER 수리: runChatAutoCasePermitEval 은
  //   chat_auto_case_eval_runs 에 새 문서를 쓸 뿐, 발송 시점이 실제로 읽는 permit 의 embedded
  //   evalEvidence(chatAutoCasePermit.ts evaluateChatAutoCasePermit → evalEvidencePasses)는
  //   그대로 둔다 — eval 이 통과해도 permit 문서는 갱신되지 않아 원래 arm 시점의 24h TTL 로 그대로
  //   만료했다(기능이 이름만 "refresh"였던 버그). setChatAutoCasePermitArming 콜러블이 사람이
  //   arm 할 때 거치는 것과 같은 정본 write-back(setChatAutoCasePermitFromVerifiedEvidence)을
  //   통과한 케이스에만 적용한다. armingSource 는 항상 "counter_floor" 로 고정한다 —
  //   operator_override 로 arm 됐던 permit 은 이 스윕이 대신 재승인하지 않는다(super_admin 의
  //   명시적 사유가 필요한 사람 판단이고, 이 스윕의 SYSTEM_ACTOR 는 role:"manager" 라 애초에 그
  //   권한이 없다). 카운터/재확인 로직은 바로 아래 루프의 주석 참고(2회차 수리).
  // 코덱스 적대 리뷰(2026-09-24, 2회차) BLOCKER 수리 ①: deriveChatAutoCaseCounters 는 원장에서
  //   매번 다시 계산하는데, summarizeChatAutoPermitCounters(chatAutoCasePermitStore.ts)의 "eligible"
  //   조건은 event.sender === "human" 을 요구한다 — arm 된 permit 이 실제로 하는 **AI 자동발송**은
  //   sender:"ai" 라 이 조건을 절대 만족 못 하고, 그 결과 else 분기로 떨어져
  //   consecutiveHumanUneditedApprovedSent 를 0 으로 리셋한다(코덱스 실측). 즉 "정상적으로 잘
  //   돌고 있는 armed permit" 일수록 재계산된 카운터가 항상 0 이 되어 20건 플로어를 절대 못
  //   넘는다 — 이 스윕이 고치려던 TTL 문제를 스스로 재현하는 자기모순이었다. 카운터 재계산은
  //   원래 "arm **하기 전** 사람 검수 스트릭을 쌓는 단계"를 위한 것이지, 이미 armed 상태에서
  //   evalEvidence 만 새로고침하는 이 스윕의 책임이 아니다 — 이미 armed 인 permit 이 여기 도달했다는
  //   것 자체가 그 카운터가 최초 arm 시점에 이미 플로어를 넘었다는 증거이므로(그렇지 않으면애초에
  //   arm 이 안 됐다), 재계산하지 않고 **그대로 재사용**한다.
  // 코덱스 적대 리뷰(2026-09-24, 2회차) BLOCKER 수리 ②: eval 은 초~수십 초가 걸릴 수 있어, 그
  //   사이 사람이 콘솔에서 수동 disarm 하거나(setChatAutoCasePermitArming) 케이스북/모델 핀이
  //   바뀔 수 있다 — 최초 permitMap 읽기 시점의 armed 상태만 믿고 쓰면 그 사람의 disarm 결정을
  //   덮어쓴다. write-back 직전에 permit 을 다시 읽어 armed·state·casebookHash·modelVersion 이
  //   전부 그대로인지 재확인하고, 하나라도 바뀌었으면 이 케이스는 건드리지 않고 skipped 로 남긴다.
  const refreshed: ChatAutoPermitCaseId[] = [];
  const writeBackFailed: string[] = [];
  if (evalPassed.length > 0) {
    const modelVersion = await currentModelVersion(deps);
    const readPermitsForWriteback = deps.readPermitMap ?? readChatAutoCasePermitMap;
    const setPermit = deps.setPermit ?? setChatAutoCasePermitFromVerifiedEvidence;
    // Codex gate round 2 (HIGH — reproduced bug): this read (and the per-case
    // readPermitsForWriteback below) used to sit OUTSIDE any try/catch — a thrown read error
    // propagated out of the whole function, past the Slack notification and the `failed` return
    // field entirely (the caller's own try/catch only logs "refresh threw", naming no case ids).
    // Any read failure here now degrades the SAME way a write-back failure already does —
    // writeBackFailed + logged — instead of vanishing.
    let latestEvidence: Map<ChatAutoPermitCaseId, ChatAutoEvalEvidence>;
    let evidenceReadFailed = false;
    try {
      latestEvidence = await (deps.readLatestEvalMap ?? latestEvalEvidenceMap)(evalPassed);
    } catch (error) {
      evidenceReadFailed = true;
      writeBackFailed.push(...evalPassed);
      console.error("[refreshArmedChatAutoCasePermits] reading fresh eval evidence threw", {
        caseIds: evalPassed,
        error: error instanceof Error ? error.message : String(error),
      });
      latestEvidence = new Map();
    }
    for (const caseId of evalPassed) {
      const pin = chatAutoCasePermitPin(
        modelVersion,
        chatAutoCaseReplyPin(caseId, replyState.overrides, replyState.revisions),
      );
      // Already recorded as writeBackFailed above (the whole evidence read failed) — do not
      // double-push it.
      if (evidenceReadFailed) continue;
      const evidence = latestEvidence.get(caseId) ?? null;
      if (!evidence) {
        writeBackFailed.push(caseId);
        console.error("[refreshArmedChatAutoCasePermits] no fresh evidence found after a passed eval", { caseId });
        continue;
      }
      let liveMap: Map<ChatAutoPermitCaseId, ChatAutoCasePermitDoc>;
      try {
        liveMap = await readPermitsForWriteback([caseId]);
      } catch (error) {
        writeBackFailed.push(caseId);
        console.error("[refreshArmedChatAutoCasePermits] re-reading the live permit before write-back threw", {
          caseId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const livePermit = liveMap.get(caseId) ?? null;
      if (
        !livePermit ||
        livePermit.armed !== true ||
        livePermit.state !== "armed" ||
        livePermit.casebookHash !== pin.casebookHash ||
        livePermit.modelVersion !== pin.modelVersion ||
        livePermit.armingSource === "operator_override"
      ) {
        skipped.push(caseId);
        console.warn("[refreshArmedChatAutoCasePermits] permit changed during the refresh window — not re-arming", { caseId });
        continue;
      }
      try {
        const nowIso = (deps.now?.() ?? new Date()).toISOString();
        await setPermit({
          caseId,
          requestedState: "armed",
          pin,
          counters: livePermit.counters,
          evalEvidence: evidence,
          actorUid: CHAT_AUTO_CASE_PERMIT_REFRESH_SYSTEM_ACTOR.userId,
          actorRole: CHAT_AUTO_CASE_PERMIT_REFRESH_SYSTEM_ACTOR.role,
          nowIso,
          armingSource: "counter_floor",
          // 코덱스 적대 리뷰(2026-09-24, 3회차) BLOCKER 수리: 위 재확인 읽기와 실제 쓰기 사이에도
          //   여전히 틈이 있다(둘 다 별도 왕복) — 그 틈에 사람이 수동 disarm 하면(수동 disarm은
          //   lastDisarmReason 을 안 남겨 store 의 기존 "adverse disarm evidence" 가드로 못 잡는다,
          //   코덱스 실측) 이 쓰기가 그 결정을 덮어쓸 수 있었다. updatedAtIso 를 낙관적 동시성
          //   토큰으로 넘겨 store 함수 자신의 트랜잭션 안에서 한 번 더, 원자적으로 재확인한다.
          expectedCurrentUpdatedAtIso: livePermit.updatedAtIso,
        });
        refreshed.push(caseId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("permit changed since it was last read")) {
          skipped.push(caseId);
          console.warn("[refreshArmedChatAutoCasePermits] permit changed between re-read and write — not re-arming", { caseId });
          continue;
        }
        writeBackFailed.push(caseId);
        console.error("[refreshArmedChatAutoCasePermits] permit write-back failed (existing armed state left untouched)", {
          caseId,
          error: message,
        });
      }
    }
  }

  const failed = [...evalFailedDisarmed, ...evalFailedNotDisarmed, ...evalCallThrew, ...writeBackFailed];
  // release-refresh-repin (2026-09-25, 헤세 지시 — Codex gate round 1 MEDIUM 수리): "re-eval 통과 시
  //   re-pin, 실패 시에만 disarm + 알림" — 알림은 세 실패 범주가 전부 확정된 뒤(write-back 루프
  //   포함) 여기 함수 끝에서 한 번만, 범주별로 정확한 문구로 보낸다(위에서 바로 보내면 write-back
  //   단계에서 나중에 추가되는 실패는 영영 알림을 못 받았다 — 코덱스가 잡은 버그). 이 스윕은 12h
  //   주기 자연 호출과 배포 직후 트리거(processAutoReplyQueue의
  //   triggerChatAutoCasePermitRefreshOnReleaseChangeOnce) 양쪽에서 모두 최대 1일 2~3회 수준으로만
  //   실행되므로(호출당 1건) 별도 dedup 없이 매번 보낸다 — 실패해도 절대 던지지 않는다(알림 실패가
  //   disarm 자체를 되돌리거나 스윕을 막을 이유가 없다).
  if (failed.length > 0) {
    try {
      const postToSlack = deps.postToSlack ?? postScheduledReportToSlack;
      const lines = ["⚠️ *Chat Auto Permit 재평가 결과 이상*"];
      if (evalFailedDisarmed.length > 0) {
        lines.push(`재평가 실패 — 자동 disarm됨: ${evalFailedDisarmed.join(", ")}`);
      }
      if (evalFailedNotDisarmed.length > 0) {
        lines.push(`재평가 실패 — permit 상태는 변경되지 않음(pin_mismatch 또는 이미 비무장, disarm 아님): ${evalFailedNotDisarmed.join(", ")}`);
      }
      if (evalCallThrew.length > 0) {
        lines.push(`재평가 호출 자체가 실패 — disarm 여부 불확실(eval이 실행되지 못했을 수 있음): ${evalCallThrew.join(", ")}`);
      }
      if (writeBackFailed.length > 0) {
        lines.push(`재평가는 통과했지만 재무장 기록 실패 — permit은 armed 상태로 남아있으나 evalEvidence가 갱신되지 않음(이전 커밋 pin 그대로): ${writeBackFailed.join(", ")}`);
      }
      lines.push("자동 재무장(re-arm)은 하지 않습니다 — 검토 후 setChatAutoCasePermitArming으로 사람이 직접 확인/재무장하세요.");
      await postToSlack(lines.join("\n"));
    } catch (error) {
      console.error(
        "[refreshArmedChatAutoCasePermits] slack notify failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return {
    ok: true,
    scanned: permitMap.size,
    refreshed,
    failed,
    skipped,
    behaviorLog: { ...makeBehaviorLog(CHAT_AUTO_CASE_PERMIT_REFRESH_SYSTEM_ACTOR, "chat_auto_case_permit.refresh", "success") },
  };
}
