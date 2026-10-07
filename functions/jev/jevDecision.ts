import type { HumanGate } from "../mailHumanGate";
import { callJev, type JevTransport, type JevTransportName } from "./jevClient";
import type { JevCacheScope } from "./jevCache";
import {
  JEV_MODEL_ID,
  JEV_PROVIDER,
  validateJevQuestions,
  type JevAnswer,
  type JevChoiceQuestion,
  type JevNoulQuestion,
  type JevQuestion,
  type JevRequest,
  type JevScoreQuestion,
} from "./jevTypes";

// JEV product-decision adapter.
//
// SCOPE (required integration): JEV/TypeSafe informs (a) template selection and (b) send/no-send
// semantic decisions. It is an ADVISORY layer only. Hard product gates — canonical sender,
// suppression/opt-out, bounce, duplicate/thread-loop, caps/time windows, current-profile /
// trusted-source / revision CAS, permit + original-dry-run — always dominate, and this module can
// never UPGRADE a decision: it may only hold an `auto_reply` back to `needs_review`.
//
// FAIL-CLOSED INVARIANT: unavailable / uncertain / malformed / below-threshold JEV output NEVER
// authorizes a send. Every such case resolves to `hold`.
//
// Docs (verified 2026-09-21): https://docs.typesafe.ai — one batched call per decision
// (speculative fan-out), confidence-gated routing, uncertain probabilities routed to human review.

export const JEV_SEND_QUESTION_IDS = {
  allowed: "send_allowed",
  route: "reply_route",
  risk: "send_risk",
} as const;

export const JEV_TEMPLATE_QUESTION_ID = "template_id";

export const JEV_ROUTE_SEND = "send_auto_reply";
export const JEV_ROUTE_HOLD = "hold_for_review";

// Confidence-gated routing thresholds (env-tunable; invalid values fall back to the safe default).
const JEV_SEND_NOUL_MIN_DEFAULT = 0.9;
const JEV_SEND_CONFIDENCE_MIN_DEFAULT = 0.7;
// Risk is a 1..5 score; anything above this holds for human review.
const JEV_SEND_RISK_MAX_DEFAULT = 2;

function threshold(envName: string, fallback: number, min: number, max: number): number {
  // F1 (adversarial review, HIGH): `Number("")` and `Number("   ")` are 0, so a blank env var
  //   would silently become a fail-open threshold (e.g. confidence 0.01 would pass a 0 minimum).
  //   An unset OR blank value must always fall back to the safe default.
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") return fallback;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= min && configured <= max ? configured : fallback;
}

export function jevSendNoulMin(): number {
  return threshold("JEV_SEND_NOUL_MIN", JEV_SEND_NOUL_MIN_DEFAULT, 0, 1);
}

export function jevSendConfidenceMin(): number {
  return threshold("JEV_SEND_CONFIDENCE_MIN", JEV_SEND_CONFIDENCE_MIN_DEFAULT, 0, 1);
}

export function jevSendRiskMax(): number {
  return threshold("JEV_SEND_RISK_MAX", JEV_SEND_RISK_MAX_DEFAULT, 1, 5);
}

export type JevApprovedReplyPolicy = {
  actions: string;
  limits: string;
};

// Canonical, non-payload decision material. Never the raw mail body, address, or model response text.
export type JevDecisionContext = {
  summary: string;
  inboundIntent: string;
  humanGateDecision: string;
  humanGateRuleIds: string[];
  programId?: string;
  // Trusted canonical casebook skeleton/never metadata only. Required for send decisions; optional
  // for legacy template-selection contexts.
  approvedReplyPolicy?: JevApprovedReplyPolicy | null;
  // 2026-09-24 (root-cause fix — post-lift JEV context): humanGateDecision/humanGateRuleIds above
  //   must already be the POST-lift final gate (see chat-ai.ts computePreJevHumanGate), not the
  //   pre-model routingGate. When that post-lift gate was reached by a restrictive-only business
  //   rule lift (evidence exemption, pricing guide redirect, counter-offer guideline), this names
  //   which lift applied so JEV reads a consistent "auto_reply because of X" signal instead of a
  //   contradictory hold-reason + approved-policy combination that used to push it to a safety hold.
  appliedLift?: string | null;
  // Cache routing only — deliberately NOT part of canonicalState(): the scope/keys are never
  // serialized into the externally sent JEV request body.
  cacheScope?: JevCacheScope;
  bypassCache?: boolean;
};

export type JevSendOutcome = "send" | "hold";

// Additive provenance: the egress lane + cache status that ACTUALLY produced a parsed JEV result.
// Sourced exclusively from the real `JevTransportResult` returned by the transport/cache seam. It is
// deliberately ABSENT whenever the provider was never reached (transport/pre-call failure) and is
// never synthesized from configuration. Consumed later by the sanitized gateway receipt; on its own
// it is not proof that a direct provider call happened.
export type JevDecisionProvenance = {
  transport: JevTransportName;
  cacheHit: boolean;
};

export type JevSendDecision = {
  kind: "send_or_not";
  outcome: JevSendOutcome;
  confidence: number;
  riskScore: number | null;
  reasons: string[];
  // true when the hold is due to an unavailable/uncertain/malformed judgement rather than a confident
  // "do not send". Both hold; this flag exists for monitoring + human-review prioritisation.
  degraded: boolean;
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  provenance?: JevDecisionProvenance;
};

export type JevTemplateSelection = {
  templateId: string | null;
  confidence: number;
  reasons: string[];
  degraded: boolean;
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  provenance?: JevDecisionProvenance;
};

function sendDecisionQuestions(): Record<string, JevQuestion> {
  const allowed: JevNoulQuestion = {
    type: "noul",
    instructions:
      "Using only the canonical topic/summary and the provided canonical approved-reply policy/actions/"
      + "limits, judge ONLY the semantic suitability of the canonical approved standard reply. Runtime "
      + "authorization, consent, suppression, bounce, dedup, caps, "
      + "time windows, permit, CAS, and dry-run enforcement are independent and are not part of this "
      + "semantic judgement. Absent operational data is not evidence of either a pass or semantic "
      + "unsafety. Known canonical opt-out, unsafe, ambiguous, or unsupported-reply signals still hold.",
    criteria: {
      true: "The canonical approved standard reply is semantically appropriate and low-risk for the canonical topic/summary and provided canonical approved-reply policy/actions/limits. Operational enforcement is separate.",
      false: "The canonical approved standard reply is semantically inappropriate, ambiguous, or the semantic context or provided canonical approved-reply policy/actions/limits is insufficient. Missing operational facts alone is not evidence for this false result.",
    },
  };
  const route: JevChoiceQuestion = {
    type: "choice",
    instructions:
      "Using only the canonical topic/summary and the provided canonical approved-reply policy/actions/"
      + "limits, choose the semantically appropriate route for the canonical approved standard reply. Runtime "
      + "authorization, consent, suppression, bounce, dedup, caps, time "
      + "windows, permit, CAS, and dry-run enforcement are independent and are not part of this semantic "
      + "judgement. Choose the safest hold when the canonical approved standard reply is semantically "
      + "inappropriate, ambiguous, or semantically under-contextualized.",
    criteria: {
      [JEV_ROUTE_SEND]: "The canonical approved standard reply is semantically appropriate for the canonical topic/summary and provided canonical approved-reply policy/actions/limits.",
      [JEV_ROUTE_HOLD]: "The canonical approved standard reply is semantically inappropriate, ambiguous, or the semantic context or provided canonical approved-reply policy/actions/limits is insufficient; use the safest available hold.",
    },
  };
  const risk: JevScoreQuestion = {
    type: "score",
    instructions:
      "Using only the canonical topic/summary and the provided canonical approved-reply policy/actions/"
      + "limits, judge ONLY the semantic risk that the canonical approved standard reply is inappropriate "
      + "or harmful. Runtime authorization, consent, suppression, bounce, "
      + "dedup, caps, time windows, permit, CAS, and dry-run enforcement are independent and are not part "
      + "of this semantic judgement. Absent operational data is not evidence of either a pass or semantic "
      + "unsafety. Known canonical opt-out, unsafe, ambiguous, or unsupported-reply signals still hold.",
    criteria: [
      "1 - negligible semantic risk",
      "2 - low semantic risk",
      "3 - moderate semantic risk",
      "4 - high semantic risk",
      "5 - severe semantic risk",
    ],
  };
  return {
    [JEV_SEND_QUESTION_IDS.allowed]: allowed,
    [JEV_SEND_QUESTION_IDS.route]: route,
    [JEV_SEND_QUESTION_IDS.risk]: risk,
  };
}

function canonicalApprovedReplyPolicy(
  policy: JevApprovedReplyPolicy | null | undefined,
): JevApprovedReplyPolicy | null {
  if (!policy || typeof policy !== "object") return null;
  if (typeof policy.actions !== "string" || typeof policy.limits !== "string") return null;
  const actions = policy.actions.trim();
  const limits = policy.limits.trim();
  if (!actions || !limits || actions.length > 3000 || limits.length > 3000) return null;
  return { actions, limits };
}

function canonicalState(
  context: JevDecisionContext,
  approvedReplyPolicy: JevApprovedReplyPolicy | null = canonicalApprovedReplyPolicy(context.approvedReplyPolicy),
  decisionScope: "semantic_reply_suitability" | "approved_template_selection" = "semantic_reply_suitability",
): Record<string, unknown> {
  const state: Record<string, unknown> = {
    decision_scope: decisionScope,
    summary: String(context.summary ?? ""),
    inbound_intent: String(context.inboundIntent ?? ""),
    existing_human_gate: String(context.humanGateDecision ?? ""),
    existing_rule_ids: Array.isArray(context.humanGateRuleIds) ? context.humanGateRuleIds.slice(0, 20) : [],
    program_id: context.programId ? String(context.programId) : undefined,
  };
  // Whitelist only the trusted policy fields; never spread the source object.
  if (approvedReplyPolicy) state.approved_reply_policy = approvedReplyPolicy;
  if (context.appliedLift) state.applied_lift = String(context.appliedLift);
  return state;
}

function heldDecision(
  reason: string,
  options: { degraded: boolean; confidence?: number; riskScore?: number | null },
  meta: Partial<Pick<JevSendDecision, "provider" | "modelId" | "inputTokens" | "outputTokens" | "estimatedCostUsd" | "provenance">> = {},
): JevSendDecision {
  const decision: JevSendDecision = {
    kind: "send_or_not",
    outcome: "hold",
    confidence: options.confidence ?? 0,
    riskScore: options.riskScore ?? null,
    reasons: [reason],
    degraded: options.degraded,
    provider: meta.provider ?? JEV_PROVIDER,
    modelId: meta.modelId ?? JEV_MODEL_ID,
    inputTokens: meta.inputTokens ?? 0,
    outputTokens: meta.outputTokens ?? 0,
    estimatedCostUsd: meta.estimatedCostUsd ?? 0,
  };
  // Only a real transport/cache result carries provenance; absence is preserved for pre-call holds.
  if (meta.provenance) decision.provenance = meta.provenance;
  return decision;
}

function answerOf<T extends JevAnswer["type"]>(
  answers: Record<string, JevAnswer>,
  id: string,
  type: T,
): Extract<JevAnswer, { type: T }> | null {
  const answer = answers[id];
  return answer && answer.type === type ? (answer as Extract<JevAnswer, { type: T }>) : null;
}

/**
 * Batched send/no-send decision. Exactly one JEV call. Any transport error, missing answer, malformed
 * answer, or below-threshold confidence resolves to `hold` — this function never throws to the caller.
 */
export async function runJevSendDecision(
  context: JevDecisionContext,
  transport?: JevTransport,
): Promise<JevSendDecision> {
  const approvedReplyPolicy = canonicalApprovedReplyPolicy(context.approvedReplyPolicy);
  if (!approvedReplyPolicy) {
    return heldDecision("jev_reply_policy_unavailable", { degraded: true });
  }

  const questions = sendDecisionQuestions();
  const request: JevRequest = {
    state: canonicalState(context, approvedReplyPolicy),
    model: JEV_MODEL_ID,
    questions,
  };
  let result;
  try {
    validateJevQuestions(questions);
    result = await callJev(request, transport, {
      cacheScope: context.cacheScope,
      bypassCache: context.bypassCache,
    });
  } catch (error) {
    const reason = error && typeof error === "object" && "errorCode" in error
      ? `jev_egress_failed:${String((error as { errorCode: unknown }).errorCode)}`
      : "jev_egress_failed";
    return heldDecision(reason, { degraded: true });
  }

  const meta = {
    provider: result.provider,
    modelId: result.response.model || JEV_MODEL_ID,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    provenance: { transport: result.transport, cacheHit: result.cacheHit === true },
  };
  const answers = result.response.answers;
  const allowed = answerOf(answers, JEV_SEND_QUESTION_IDS.allowed, "noul");
  const route = answerOf(answers, JEV_SEND_QUESTION_IDS.route, "choice");
  const risk = answerOf(answers, JEV_SEND_QUESTION_IDS.risk, "score");

  if (!allowed) return heldDecision("jev_answer_missing:send_allowed", { degraded: true }, meta);
  if (!route) return heldDecision("jev_answer_missing:reply_route", { degraded: true }, meta);
  if (!risk) return heldDecision("jev_answer_missing:send_risk", { degraded: true }, meta);

  // Official contract (https://docs.typesafe.ai/primitives/score): the wire `score` is
  //   continuous over 0..criteria.length-1 (i.e. 0..4 for a 5-point rubric), NOT 1..N.
  //   The application risk policy below (JEV_SEND_RISK_MAX, env 1..5, low risk max 2) is on
  //   the normalized app scale = wire raw + 1. Validate the raw wire value first, then
  //   normalize; a malformed or out-of-range raw score (-5, 5, …) is an *unavailable*
  //   judgement, not a low-risk one — the one-sided threshold comparison would otherwise let
  //   a negative score pass as "safe". Report the raw wire value unchanged on out-of-range.
  if (!Number.isFinite(risk.score) || risk.score < 0 || risk.score > 4) {
    return heldDecision(
      "jev_risk_out_of_range",
      { degraded: true, confidence: route.confidence, riskScore: risk.score },
      meta,
    );
  }

  // Normalized app score (1..5): wire raw 0 => app 1, raw 1 => app 2, raw 1.01 => app 2.01.
  const appRiskScore = risk.score + 1;
  const decisionConfidence = Math.min(route.confidence, risk.confidence);

  const noulMin = jevSendNoulMin();
  const confidenceMin = jevSendConfidenceMin();
  const riskMax = jevSendRiskMax();

  if (allowed.noul < noulMin) {
    return heldDecision("jev_noul_below_threshold", { degraded: false, confidence: decisionConfidence, riskScore: appRiskScore }, meta);
  }
  if (route.choice !== JEV_ROUTE_SEND) {
    return heldDecision(`jev_route:${route.choice === JEV_ROUTE_HOLD ? "hold_for_review" : "unrecognized"}`, { degraded: route.choice !== JEV_ROUTE_HOLD, confidence: decisionConfidence, riskScore: appRiskScore }, meta);
  }
  if (decisionConfidence < confidenceMin) {
    return heldDecision("jev_confidence_below_threshold", { degraded: false, confidence: decisionConfidence, riskScore: appRiskScore }, meta);
  }
  if (appRiskScore > riskMax) {
    return heldDecision("jev_risk_above_threshold", { degraded: false, confidence: decisionConfidence, riskScore: appRiskScore }, meta);
  }

  return {
    kind: "send_or_not",
    outcome: "send",
    confidence: decisionConfidence,
    riskScore: appRiskScore,
    reasons: ["jev_send_allowed"],
    degraded: false,
    ...meta,
  };
}

/**
 * Template selection via a single `choice` question whose options are the candidate template ids.
 * Returns `templateId: null` when JEV is unavailable, uncertain, or picks an unknown option — the
 * caller MUST then fall back to its existing deterministic template selection.
 */
export async function runJevTemplateSelection(
  context: JevDecisionContext,
  candidates: readonly string[],
  transport?: JevTransport,
  candidateCriteria?: Readonly<Record<string, string>>,
): Promise<JevTemplateSelection> {
  const unique = Array.from(new Set(candidates.map((id) => String(id).trim()).filter(Boolean)));
  const base = {
    provider: JEV_PROVIDER,
    modelId: JEV_MODEL_ID,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
  if (unique.length < 2) {
    // Fewer than two real options is not a choice task; do not spend a call or fabricate a selection.
    return { templateId: null, confidence: 0, reasons: ["jev_template_insufficient_candidates"], degraded: true, ...base };
  }

  const criteria: Record<string, string> = {};
  for (const id of unique) {
    criteria[id] =
      candidateCriteria?.[id]?.trim() ||
      "Approved SCP reply template candidate for the canonical inquiry state.";
  }
  const question: JevChoiceQuestion = {
    type: "choice",
    instructions: "Choose the single best reply template for this inbound inquiry from the candidates.",
    criteria,
  };
  const questions: Record<string, JevQuestion> = { [JEV_TEMPLATE_QUESTION_ID]: question };
  const request: JevRequest = {
    state: canonicalState(context, canonicalApprovedReplyPolicy(context.approvedReplyPolicy), "approved_template_selection"),
    model: JEV_MODEL_ID,
    questions,
  };

  let result;
  try {
    validateJevQuestions(questions);
    result = await callJev(request, transport, {
      cacheScope: context.cacheScope,
      bypassCache: context.bypassCache,
    });
  } catch (error) {
    const reason = error && typeof error === "object" && "errorCode" in error
      ? `jev_egress_failed:${String((error as { errorCode: unknown }).errorCode)}`
      : "jev_egress_failed";
    return { templateId: null, confidence: 0, reasons: [reason], degraded: true, ...base };
  }

  const meta = {
    provider: result.provider,
    modelId: result.response.model || JEV_MODEL_ID,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    provenance: { transport: result.transport, cacheHit: result.cacheHit === true },
  };
  const answer = answerOf(result.response.answers, JEV_TEMPLATE_QUESTION_ID, "choice");
  if (!answer) {
    return { templateId: null, confidence: 0, reasons: ["jev_answer_missing:template_id"], degraded: true, ...meta };
  }
  if (!unique.includes(answer.choice)) {
    return { templateId: null, confidence: answer.confidence, reasons: ["jev_template_unknown_option"], degraded: true, ...meta };
  }
  if (answer.confidence < jevSendConfidenceMin()) {
    return { templateId: null, confidence: answer.confidence, reasons: ["jev_template_confidence_below_threshold"], degraded: false, ...meta };
  }
  return { templateId: answer.choice, confidence: answer.confidence, reasons: ["jev_template_selected"], degraded: false, ...meta };
}

/**
 * Restrictive-only combination with the deterministic human gate.
 *
 * Invariant (locked by tests): the returned gate is NEVER a higher-authority decision than the input.
 *   - `null`/`undefined` decision (the JEV lane was NOT consulted: unconfigured, or the gate was never
 *     `auto_reply`) -> gate returned UNCHANGED. A disabled lane must not close a thread either; this is
 *     what keeps existing behavior byte-for-byte when JEV is off, and it is deliberately NOT a hold.
 *   - non-`auto_reply` gate (blocked / needs_review / auto_close) -> returned unchanged.
 *   - `auto_reply` + JEV hold (unavailable / uncertain / malformed / below-threshold)
 *     -> downgraded to `needs_review`.
 *   - `auto_reply` + JEV send -> unchanged `auto_reply`.
 * JEV can therefore never re-open a blocked or review-bound thread.
 */
export function combineJevWithHumanGate(
  gate: HumanGate,
  decision: JevSendDecision | null | undefined,
  options: { requiredHoldReason?: string | null } = {},
): HumanGate {
  if (gate.decision !== "auto_reply") return gate;
  // Lane not consulted -> strict no-op. Only a real `hold` from a consulted lane may downgrade.
  if (!decision) {
    if (
      typeof options.requiredHoldReason === "string" &&
      options.requiredHoldReason.length > 0
    ) {
      return {
        decision: "needs_review",
        reason: "jev_required_hold:" + options.requiredHoldReason,
        ruleIds: Array.from(new Set([...gate.ruleIds, "jev_required_hold"])),
      };
    }
    return gate;
  }
  if (decision.outcome !== "send") {
    // Lane-integrity violations outrank a semantic send hold: an unverified canonical identity
    // invalidates the whole required lane regardless of what the consulted decision judged. Other
    // required reasons (unconfigured/decision_missing) only apply when no decision was produced.
    if (options.requiredHoldReason === "jev_required_identity_unverified") {
      return {
        decision: "needs_review",
        reason: "jev_required_hold:" + options.requiredHoldReason,
        ruleIds: Array.from(new Set([...gate.ruleIds, "jev_required_hold", "jev_send_hold"])),
      };
    }
    const reason = decision.reasons[0] ?? "jev_send_hold";
    return {
      decision: "needs_review",
      reason: `jev_send_hold:${reason}`,
      ruleIds: Array.from(new Set([...gate.ruleIds, "jev_send_hold"])),
    };
  }
  return gate;
}
