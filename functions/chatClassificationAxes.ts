// Classification axes (casebook classification contract, 2026-10-03) — pure, import-free.
//
// The casebook picks ONE primary case per inbound (autoCaseId, kept as the compatible primary). The
// primary case alone cannot say WHO is writing or WHAT they asked, so agency/MCN status leaked into
// the case label (fixed_terms_inquiry) and several asks in one mail collapsed into one. This module
// adds two separate axes next to the primary case:
//   - actorType      who wrote the mail
//   - intentLabels[] what they asked (multi-label)
// plus the contract version stamped with them. Axes are LABELS: they never loosen a gate, never touch
// sender attribution, suppression, human review or permits (those stay with their existing owners).

// The contract version constant lives in chatCasebook.ts (CHAT_CLASSIFICATION_CONTRACT_VERSION) next to the
// casebook text and hash it versions — this module stays import-free so tests can load it as plain TS.

export const CHAT_ACTOR_TYPES = ["creator", "agency_mcn", "vendor_or_notification", "unknown"] as const;
export type ChatActorType = (typeof CHAT_ACTOR_TYPES)[number];

export const CHAT_INTENT_LABELS = [
  "interest",
  "reward_info_request",
  "brief_request",
  "custom_terms_proposal",
  "contact_channel_request",
  "call_meeting_request",
  "complaint",
  "discontinue",
  "closing",
  "ooo",
  "settlement_question",
  "approval_status",
  "submission_help",
  "other",
] as const;
export type ChatIntentLabel = (typeof CHAT_INTENT_LABELS)[number];

export const CHAT_INTENT_LABELS_MAX = 8;

export type ChatClassificationAxes = {
  actorType: ChatActorType;
  intentLabels: ChatIntentLabel[];
};

/** Where a stamped label came from: the gateway model, or an operator-corrected label. */
export type ChatClassificationLabelSource = "model" | "operator";

const ACTOR_SET: ReadonlySet<string> = new Set(CHAT_ACTOR_TYPES);
const INTENT_SET: ReadonlySet<string> = new Set(CHAT_INTENT_LABELS);

export function isChatActorType(value: unknown): value is ChatActorType {
  return typeof value === "string" && ACTOR_SET.has(value);
}

export function isChatIntentLabel(value: unknown): value is ChatIntentLabel {
  return typeof value === "string" && INTENT_SET.has(value);
}

/** Whitelist + dedupe + cap. Anything not in the contract is dropped (never persisted as free text). */
export function normalizeChatIntentLabels(value: unknown): ChatIntentLabel[] {
  if (!Array.isArray(value)) return [];
  const out: ChatIntentLabel[] = [];
  for (const entry of value) {
    if (isChatIntentLabel(entry) && !out.includes(entry)) out.push(entry);
    if (out.length >= CHAT_INTENT_LABELS_MAX) break;
  }
  return out;
}

/**
 * Axes from a gateway model JSON. Returns null ONLY when the model supplied neither axis at all (mock paths,
 * pre-contract payloads) — non-fixed-terms cases then keep the single-case behavior byte-for-byte, while the
 * intent guard drops an axis-less fixed_terms_inquiry (see guardCaseByIntent). If either
 * key is present (even null, empty, malformed or unknown-valued) the axes exist: an invalid/missing actorType becomes
 * "unknown" and invalid intents are dropped (never guessed), so a present-but-empty axis can never bypass the
 * fixed_terms_inquiry guard.
 */
export function extractChatClassificationAxes(json: { actorType?: unknown; intentLabels?: unknown }): ChatClassificationAxes | null {
  // Key PRESENCE, not value: an explicit null/undefined axis is still a supplied (empty) axis.
  const supplied = Object.prototype.hasOwnProperty.call(json, "actorType") || Object.prototype.hasOwnProperty.call(json, "intentLabels");
  if (!supplied) return null;
  return {
    actorType: isChatActorType(json.actorType) ? json.actorType : "unknown",
    intentLabels: normalizeChatIntentLabels(json.intentLabels),
  };
}

/** True when a (case, intents) pair breaks the fixed_terms_inquiry invariant (needs custom_terms_proposal). */
export function violatesFixedTermsInvariant(caseId: string, intentLabels: readonly ChatIntentLabel[]): boolean {
  return caseId === "fixed_terms_inquiry" && !intentLabels.includes("custom_terms_proposal");
}

/**
 * Visible, human-handled cases a mis-picked fixed_terms_inquiry may be remapped to. Deliberately EXCLUDES
 * every no-reply / auto_close case (closing_acknowledgment, out_of_office): a remap must never hide a
 * thread the gate still holds for a human.
 */
const FIXED_TERMS_REMAP_BY_INTENT: ReadonlyArray<readonly [ChatIntentLabel, string]> = [
  ["contact_channel_request", "contact_channel_request"],
  ["call_meeting_request", "call_request"],
  ["approval_status", "approval_status_inquiry"],
  ["submission_help", "submission_support"],
  ["reward_info_request", "reward_overview"],
  ["settlement_question", "reward_overview"],
  ["brief_request", "interest_next_steps"],
  ["interest", "interest_next_steps"],
  ["discontinue", "discontinue_notice"],
];

export type ChatCaseIntentGuard = {
  /** The case to stamp. null = no honest case fits (caller treats it as unclassifiable / fallback). */
  caseId: string | null;
  /** Set when the guard changed the model's pick. */
  remappedFrom?: string;
};

/**
 * fixed_terms_inquiry is ONLY for custom_terms_proposal (they propose their own fixed fee / flat rate /
 * contract / exclusivity / payment-structure change). Agency/MCN status alone — or interest, reward and
 * brief requests — must not select it. When the model supplied intents without custom_terms_proposal the
 * label is remapped by intent; with no remappable intent (including an EMPTY intent list once the model supplied
 * axes at all) it is dropped (null) rather than kept wrong. Only fixed_terms_inquiry is affected: every other case
 * passes through unchanged whether or not axes exist.
 *
 * This guard only relabels the PRIMARY CASE. The human gate is computed from the model's original pick
 * (chat-ai.ts computePreJevHumanGate), so a remap can never turn a held mail into an auto-send, and
 * agency stays a separate hold under the existing human-review policy.
 */
export function guardCaseByIntent(caseId: string, axes: ChatClassificationAxes | null): ChatCaseIntentGuard {
  if (caseId !== "fixed_terms_inquiry") return { caseId };
  // No axes at all: current-contract model outputs always carry them (the schema requires both and the cache key
  // rotates with CHAT_CLASSIFICATION_CONTRACT_VERSION), so a fixed_terms_inquiry without axes is an unverifiable
  // pick — it is dropped rather than kept without its required custom_terms_proposal evidence.
  if (!axes) return { caseId: null, remappedFrom: caseId };
  if (axes.intentLabels.includes("custom_terms_proposal")) return { caseId };
  for (const [intent, target] of FIXED_TERMS_REMAP_BY_INTENT) {
    if (axes.intentLabels.includes(intent)) return { caseId: target, remappedFrom: caseId };
  }
  return { caseId: null, remappedFrom: caseId };
}

/** The persisted shape on the conversation stamp and the message source (no free text, no PII). */
export type ChatClassificationStamp = {
  actorType: ChatActorType;
  intentLabels: ChatIntentLabel[];
  contractVersion: string;
  labelSource: ChatClassificationLabelSource;
  /** The model's original case when the intent guard relabeled it. */
  guardedFromCaseId?: string;
};
