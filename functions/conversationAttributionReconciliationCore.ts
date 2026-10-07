import { createHash } from "node:crypto";
import type {
  ConversationAttributionResolution,
  RankedAttributionCandidate,
} from "./conversationAttribution";
import { resolveCanonicalProgramId } from "./programCanonical";

export const CONVERSATION_ATTRIBUTION_RECONCILIATION_VERSION =
  "conversation_attribution_reconciliation_v1" as const;
export const CONVERSATION_ATTRIBUTION_PAGE_SIZE_DEFAULT = 20;
export const CONVERSATION_ATTRIBUTION_PAGE_SIZE_MAX = 100;

type CandidateClassification = {
  eligible: boolean;
  reasonCode:
    | "eligible_direct"
    | "eligible_review_required"
    | "eligible_legacy_missing_attribution"
    | "manual_final_preserved"
    | "already_program_attributed";
  expectedVersion: number;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function version(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function classifyConversationAttributionReconciliationCandidate(
  conversation: Record<string, unknown>,
): CandidateClassification {
  const attribution = record(conversation.attribution);
  const final = record(attribution.final);
  const expectedVersion = version(attribution.version);
  const finalSource = text(final.source);
  if (finalSource === "manual" || finalSource === "revert") {
    return { eligible: false, reasonCode: "manual_final_preserved", expectedVersion };
  }
  const legacyMissing = text(attribution.policyVersion) !== "conversation_attribution_v1"
    || expectedVersion < 1;
  if (legacyMissing) {
    return { eligible: true, reasonCode: "eligible_legacy_missing_attribution", expectedVersion };
  }
  if (conversation.attributionReviewRequired === true || attribution.reviewRequired === true) {
    return { eligible: true, reasonCode: "eligible_review_required", expectedVersion };
  }
  const finalBucket = text(final.primaryBucket);
  const topLevelProgramId = resolveCanonicalProgramId(conversation.programId ?? conversation.canonicalProgramId);
  const direct = finalBucket === "direct"
    || text(conversation.type) === "direct"
    || (!finalBucket && !topLevelProgramId);
  return direct
    ? { eligible: true, reasonCode: "eligible_direct", expectedVersion }
    : { eligible: false, reasonCode: "already_program_attributed", expectedVersion };
}

export function boundedConversationAttributionPageSize(value: unknown): number {
  if (value == null || value === "") return CONVERSATION_ATTRIBUTION_PAGE_SIZE_DEFAULT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > CONVERSATION_ATTRIBUTION_PAGE_SIZE_MAX) {
    throw Object.assign(new Error("page_size_out_of_range"), { code: "invalid-argument", errorCode: "bounded_conversation_attribution_page_size_page_size_out_range" });
  }
  return parsed;
}

export function stableConversationAttributionHash(value: unknown, length = 64): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, length);
}

function stableJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, seen)).join(",")}]`;
  if (typeof value !== "object") return JSON.stringify(String(value));
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  const source = value as Record<string, unknown>;
  const serialized = `{${Object.keys(source).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(source[key], seen)}`
  )).join(",")}}`;
  seen.delete(value);
  return serialized;
}

function evidenceHash(value: unknown): string {
  return `evidence_hash/${stableConversationAttributionHash(text(value), 32)}`;
}

function canonicalSnapshot<T extends Record<string, unknown>>(snapshot: T): T {
  if (text(snapshot.primaryBucket) !== "program") return snapshot;
  return {
    ...snapshot,
    programId: resolveCanonicalProgramId(snapshot.programId),
  };
}

function redactedCandidate(candidate: RankedAttributionCandidate): RankedAttributionCandidate {
  return {
    ...candidate,
    candidateRef: evidenceHash(candidate.candidateRef),
    evidenceRefs: Array.from(new Set((candidate.evidenceRefs ?? [])
      .map(evidenceHash))).sort(),
    programId: resolveCanonicalProgramId(candidate.programId),
    signalIds: Array.from(new Set((candidate.signalIds ?? []).map(text).filter(Boolean))).sort(),
  };
}

export function redactConversationAttributionResolutionEvidence(
  resolution: ConversationAttributionResolution,
  rejectedCandidateRefs: string[] = [],
): {
  resolution: ConversationAttributionResolution;
  rejectedCandidateRefs: string[];
} {
  return {
    resolution: {
      ...resolution,
      suggested: canonicalSnapshot({ ...resolution.suggested }),
      final: canonicalSnapshot({ ...resolution.final }),
      rankedCandidates: resolution.rankedCandidates.slice(0, 10).map(redactedCandidate),
    },
    rejectedCandidateRefs: Array.from(new Set(rejectedCandidateRefs.map(evidenceHash))).sort().slice(0, 20),
  };
}

function comparableSnapshot(value: unknown): Record<string, unknown> {
  const snapshot = record(value);
  const primaryBucket = text(snapshot.primaryBucket) === "program" ? "program" : "direct";
  return {
    primaryBucket,
    programId: primaryBucket === "program" ? resolveCanonicalProgramId(snapshot.programId) : "",
    campaignId: primaryBucket === "program" ? text(snapshot.campaignId) : "",
    source: text(snapshot.source) || "automatic",
    reasonId: text(snapshot.reasonId),
  };
}

export function conversationAttributionResolutionNeedsMaterialization(
  conversation: Record<string, unknown>,
  resolution: ConversationAttributionResolution,
): boolean {
  const classification = classifyConversationAttributionReconciliationCandidate(conversation);
  if (!classification.eligible) return false;
  if (classification.reasonCode === "eligible_legacy_missing_attribution") return true;
  const attribution = record(conversation.attribution);
  const current = {
    final: comparableSnapshot(attribution.final),
    suggested: comparableSnapshot(attribution.suggested),
    reviewRequired: attribution.reviewRequired === true || conversation.attributionReviewRequired === true,
    candidates: Array.isArray(attribution.rankedCandidates)
      ? (attribution.rankedCandidates as unknown[]).map((candidate) => {
          const row = record(candidate);
          return {
            programId: resolveCanonicalProgramId(row.programId),
            campaignId: text(row.campaignId),
            score: Number(row.score) || 0,
            confidence: Number(row.confidence) || 0,
            signalIds: Array.isArray(row.signalIds) ? row.signalIds.map(text).sort() : [],
          };
        })
      : [],
  };
  const next = {
    final: comparableSnapshot(resolution.final),
    suggested: comparableSnapshot(resolution.suggested),
    reviewRequired: resolution.reviewRequired,
    candidates: resolution.rankedCandidates.slice(0, 10).map((candidate) => ({
      programId: resolveCanonicalProgramId(candidate.programId),
      campaignId: text(candidate.campaignId),
      score: candidate.score,
      confidence: candidate.confidence,
      signalIds: [...candidate.signalIds].sort(),
    })),
  };
  return stableConversationAttributionHash(current) !== stableConversationAttributionHash(next);
}
