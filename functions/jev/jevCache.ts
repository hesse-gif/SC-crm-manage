import { createHash } from "crypto";
import type { JevTransportResult } from "./jevClient";
import {
  parseJevResponse,
  type JevAnswer,
  type JevChoiceAnswer,
  type JevNoulAnswer,
  type JevRequest,
  type JevResponse,
  type JevScoreAnswer,
} from "./jevTypes";

export type JevCacheScope = {
  tenantKey: string;
  messageId: string;
  revision: string;
  policyVersion: string;
};

export type JevCacheStore = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
};

export const JEV_CACHE_TTL_MS = 300000;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function jevCacheKey(
  request: JevRequest,
  route: string,
  endpoint: string,
  scope: JevCacheScope,
): string {
  if (
    !scope.tenantKey?.trim() ||
    !scope.messageId?.trim() ||
    !scope.revision?.trim() ||
    !scope.policyVersion?.trim()
  ) {
    return "";
  }
  const canonical = canonicalJson({ request, scope, route, endpoint });
  return createHash("sha256").update(canonical).digest("hex");
}

function validConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function sanitizeAnswer(
  question: JevRequest["questions"][string],
  answer: JevAnswer,
): JevAnswer | null {
  if (question.type === "noul") {
    if (answer.type !== "noul") return null;
    if (!Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) return null;
    const noul: JevNoulAnswer = { type: "noul", noul: answer.noul };
    return noul;
  }

  if (question.type === "choice") {
    if (answer.type !== "choice") return null;
    if (!Object.prototype.hasOwnProperty.call(question.criteria, answer.choice)) return null;
    if (!validConfidence(answer.confidence)) return null;
    const choice: JevChoiceAnswer = {
      type: "choice",
      choice: answer.choice,
      probabilities: {},
      confidence: answer.confidence,
    };
    return choice;
  }

  if (answer.type !== "score") return null;
  // Official contract (https://docs.typesafe.ai/primitives/score): the wire `score` is
  //   continuous over 0..criteria.length-1 (0..4 for a 5-point rubric), NOT 1..N, and
  //   fractional values are allowed. The +1 app-scale normalization happens later in
  //   jevDecision; validate the raw wire value here.
  if (
    !Number.isFinite(answer.score) ||
    answer.score < 0 ||
    answer.score > question.criteria.length - 1 ||
    !validConfidence(answer.confidence)
  ) {
    return null;
  }
  const score: JevScoreAnswer = {
    type: "score",
    score: answer.score,
    legend: "",
    probabilities: {},
    confidence: answer.confidence,
  };
  return score;
}

export function cacheableJevResult(
  request: JevRequest,
  result: JevTransportResult,
): JevTransportResult | null {
  if (result === null || typeof result !== "object") return null;
  const parsed = parseJevResponse(result.response);
  if (!parsed) return null;

  const answers: Record<string, JevAnswer> = {};
  const questionIds = Object.keys(request.questions);
  if (questionIds.length === 0) return null;

  for (const id of questionIds) {
    const question = request.questions[id];
    const answer = parsed.answers[id];
    if (!question || !answer) return null;
    const sanitized = sanitizeAnswer(question, answer);
    if (!sanitized) return null;
    answers[id] = sanitized;
  }

  const response: JevResponse = {
    model: request.model,
    answers,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  return {
    response,
    transport: result.transport,
    provider: result.provider,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
}
