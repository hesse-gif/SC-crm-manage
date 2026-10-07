// TypeSafe / JEV request+response contract (official docs, verified 2026-09-21).
//   Source of truth: https://docs.typesafe.ai — POST https://api.typesafe.ai/v1/systemone
//   Auth: `Authorization: Bearer <API_KEY>`, body `{ state, model, questions }`, model `"jev-latest"`.
//   Response: `{ model, answers: { <id>: Answer }, usage: { input_tokens, output_tokens } }`.
// These types are the ONLY shape this codebase may send/accept for the JEV lane. Anything that does
// not validate against them is treated as a malformed response by the decision layer (fail-closed).

export const JEV_MODEL_ID = "jev-latest";
export const JEV_DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

// Docs: `choice` criteria is a map of option -> rubric, capped at 255 entries.
export const JEV_CHOICE_CRITERIA_MAX = 255;
// Docs: `score` criteria is an ORDERED array of 2..10 levels.
export const JEV_SCORE_CRITERIA_MIN = 2;
export const JEV_SCORE_CRITERIA_MAX = 10;

export type JevNoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
};

export type JevChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

export type JevScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: string[];
};

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

// `state` is the untrusted inbound material under judgement. The adapter always passes a *canonical*
// object (see jevDecision.ts) rather than a raw mail body so we never widen what leaves the boundary.
export type JevState = string | Record<string, unknown> | unknown[];

export type JevRequest = {
  state: JevState;
  model: string;
  questions: Record<string, JevQuestion>;
};

export type JevNoulAnswer = { type: "noul"; noul: number };
export type JevChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type JevScoreAnswer = {
  type: "score";
  score: number;
  legend: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export type JevUsage = { input_tokens: number; output_tokens: number };

export type JevResponse = {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
};

// Provider identity recorded on cost/usage logs. TypeSafe is its own provider; we do NOT relabel it
// as `vertex` (SEC-P0-009 / monitoring honesty).
export const JEV_PROVIDER = "typesafe";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unitNumber(value: unknown): number | null {
  const n = finiteNumber(value);
  return n !== null && n >= 0 && n <= 1 ? n : null;
}

/**
 * Structural validation of a JEV answer. Returns null when the answer is missing, the wrong `type`,
 * or numerically malformed. Callers MUST treat null as "no usable answer" (fail-closed), never as 0.
 */
export function parseJevAnswer(value: unknown): JevAnswer | null {
  if (!isPlainObject(value)) return null;
  if (value.type === "noul") {
    const noul = unitNumber(value.noul);
    return noul === null ? null : { type: "noul", noul };
  }
  if (value.type === "choice") {
    const confidence = unitNumber(value.confidence);
    if (typeof value.choice !== "string" || confidence === null) return null;
    return {
      type: "choice",
      choice: value.choice,
      probabilities: isPlainObject(value.probabilities) ? (value.probabilities as Record<string, number>) : {},
      confidence,
    };
  }
  if (value.type === "score") {
    const score = finiteNumber(value.score);
    const confidence = unitNumber(value.confidence);
    if (score === null || confidence === null) return null;
    return {
      type: "score",
      score,
      legend: typeof value.legend === "string" ? value.legend : "",
      probabilities: isPlainObject(value.probabilities) ? (value.probabilities as Record<string, number>) : {},
      confidence,
    };
  }
  return null;
}

/**
 * Validates a full response envelope. `usage` is optional in practice, so a missing/partial usage block
 * degrades to zeros rather than rejecting an otherwise usable answer set (tokens are monitoring-only;
 * they never gate a send). A missing `answers` object is a malformed response -> null.
 */
export function parseJevResponse(value: unknown): JevResponse | null {
  if (!isPlainObject(value)) return null;
  if (!isPlainObject(value.answers)) return null;
  const answers: Record<string, JevAnswer> = {};
  for (const [id, raw] of Object.entries(value.answers)) {
    const parsed = parseJevAnswer(raw);
    if (parsed) answers[id] = parsed;
  }
  const usageRaw = isPlainObject(value.usage) ? value.usage : {};
  return {
    model: typeof value.model === "string" ? value.model : "",
    answers,
    usage: {
      input_tokens: finiteNumber(usageRaw.input_tokens) ?? 0,
      output_tokens: finiteNumber(usageRaw.output_tokens) ?? 0,
    },
  };
}

/** Validates an outgoing question set against the documented caps before any egress. */
export function validateJevQuestions(questions: Record<string, JevQuestion>): void {
  const ids = Object.keys(questions);
  if (ids.length === 0) {
    throw new Error("JEV request must contain at least one question.");
  }
  for (const id of ids) {
    const question = questions[id];
    if (!question || typeof question.instructions !== "string" || !question.instructions.trim()) {
      throw new Error(`JEV question ${JSON.stringify(id)} must have non-empty instructions.`);
    }
    if (question.type === "choice") {
      const options = Object.keys(question.criteria ?? {});
      if (options.length === 0 || options.length > JEV_CHOICE_CRITERIA_MAX) {
        throw new Error(`JEV choice question ${JSON.stringify(id)} must have 1..${JEV_CHOICE_CRITERIA_MAX} options.`);
      }
    }
    if (question.type === "score") {
      const levels = Array.isArray(question.criteria) ? question.criteria.length : 0;
      if (levels < JEV_SCORE_CRITERIA_MIN || levels > JEV_SCORE_CRITERIA_MAX) {
        throw new Error(`JEV score question ${JSON.stringify(id)} must have ${JEV_SCORE_CRITERIA_MIN}..${JEV_SCORE_CRITERIA_MAX} ordered levels.`);
      }
    }
  }
}
