import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  FieldPath,
  FieldValue,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
  type Transaction,
} from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { expireAt180DaysFromIso } from "./firestoreTtl";
import { resolveCanonicalProgramId } from "./programCanonical";
import { isScpLikeProgramId } from "./scpProgramAlias";
import { assertMutationOwner, mutationOwnerUids } from "./mutationAuthorization";
import { resolveConversationMailAccessScope } from "./conversationMailAccessScope";
import { canReadScpConversationRowForOrg } from "./mailConversationAuthorization";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  type CallableRequestShape,
} from "./shared";

export const CONVERSATION_ATTRIBUTION_POLICY_VERSION = "conversation_attribution_v1" as const;
const AUDIT_COLLECTION = "conversation_attribution_audits";
const AMBIGUITY_DELTA = 10;
const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;
const MANUAL_RECLASSIFICATION_CLAIMS_COLLECTION = "conversation_attribution_reclassification_claims";
const MANUAL_RECLASSIFICATION_ACTIONS_COLLECTION = "conversation_attribution_reclassification_actions";
const MANUAL_RECLASSIFICATION_PREVIEW_TTL_MS = 30 * 60 * 1000;
const MANUAL_RECLASSIFICATION_MAX_EVIDENCE_REFS = 50;

export type ConversationAttributionBucket = "program" | "direct";
export type ConversationAttributionSource = "automatic" | "manual" | "revert";
export type ConversationAttributionStatus = "legacy/unrecorded" | "automatic" | "manual_confirmed";

export type ConversationAttributionSnapshot = {
  primaryBucket: ConversationAttributionBucket;
  programId?: string;
  campaignId?: string;
  confidence: number;
  source: ConversationAttributionSource;
  reasonId: string;
  decidedAtIso?: string;
};

export type ConversationAttributionState = {
  policyVersion: typeof CONVERSATION_ATTRIBUTION_POLICY_VERSION;
  attributionStatus: Exclude<ConversationAttributionStatus, "legacy/unrecorded">;
  version: number;
  reviewRequired: boolean;
  original: ConversationAttributionSnapshot;
  suggested: ConversationAttributionSnapshot;
  final: ConversationAttributionSnapshot;
  rankedCandidates: RankedAttributionCandidate[];
  updatedAtIso: string;
};

export type AttributionSignals = {
  providerThreadMatch?: boolean;
  providerMessageMatch?: boolean;
  inReplyToMatch?: boolean;
  referencesMatch?: boolean;
  trackingIdMatch?: boolean;
  authoritativeRelationshipMatch?: boolean;
  // conv_13ioeao (2026-09-27): the reply's SMTP From doesn't match anything we emailed, but its
  // body quotes an "Von/From/발신: scp@supercent.io ... An/To/수신: <address>" header block whose
  // quoted recipient matches a REAL outbound record of ours (see mailQuotedReplyAttribution.ts +
  // discoverInboundConversationAttribution below). Weighted below in_reply_to/references — those
  // are RFC threading headers the mail server itself guarantees; this is a best-effort parse of
  // client-quoted text.
  quotedOriginalRecipientMatch?: boolean;
  explicitContextMatch?: boolean;
  senderHashMatch?: boolean;
  recipientHashMatch?: boolean;
  normalizedSubjectMatch?: boolean;
  creatorHistoryMatch?: boolean;
  outreachHistoryMatch?: boolean;
  youtubeUrlMatch?: boolean;
  linkMatch?: boolean;
  withinDays?: number;
};

export type AttributionCandidateInput = {
  candidateRef: string;
  evidenceRefs?: string[];
  programId?: string;
  campaignId?: string;
  creatorIdentityKey?: string;
  signals?: AttributionSignals;
};

export type RankedAttributionCandidate = {
  candidateRef: string;
  evidenceRefs: string[];
  programId: string;
  campaignId?: string;
  creatorIdentityKey: string;
  score: number;
  confidence: number;
  exact: boolean;
  signalIds: string[];
};

export type ConversationAttributionResolution = {
  suggested: ConversationAttributionSnapshot;
  final: ConversationAttributionSnapshot;
  reviewRequired: boolean;
  reasonId:
    | "exact_match_auto_program"
    | "high_confidence_auto_program"
    | "ambiguous_candidate_review"
    | "fuzzy_candidate_review"
    | "ownership_conflict_review"
    | "low_confidence_direct"
    | "no_program_evidence_direct";
  rankedCandidates: RankedAttributionCandidate[];
  // 2026-09-27 (헤세 지시 — 보류메일 재고): ownership_conflict_review 전용 부가 신호. 충돌을
  //   일으킨 프로그램 후보 전부가 우리 SCP 프로그램군(scpProgramAlias.isScpLikeProgramId)이고
  //   최소 1개 이상 근거가 있을 때만 true — 외부/미상 프로그램이 하나라도 섞이면 false(안전
  //   우선). ownership_conflict_review 가 아닌 다른 reasonId 에서는 항상 undefined.
  ownershipConflictAllOurScpPrograms?: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeEvidenceRef(value: unknown): string {
  const raw = asString(value);
  if (!raw) return "";
  if (/^[a-zA-Z0-9_.:-]+\/[a-zA-Z0-9_.:-]+$/.test(raw)) return raw.slice(0, 400);
  return `evidence_hash/${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

function safeCreatorIdentityKey(value: unknown): string {
  const raw = asString(value)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .slice(0, 300);
  if (!raw) return "identity:unknown";
  if (/^(creator|channel|handle|youtube|candidate|recipient):[a-z0-9_.:@/-]+$/.test(raw)) {
    return raw;
  }
  return `identity:${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
}

export function normalizeAttributionSubject(value: unknown): string {
  return asString(value)
    .toLowerCase()
    .replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function scoreCandidate(input: AttributionCandidateInput): RankedAttributionCandidate | null {
  const programId = resolveCanonicalProgramId(input.programId);
  if (!programId) return null;
  const signals = input.signals ?? {};
  const signalIds: string[] = [];
  const add = (condition: boolean | undefined, id: string, points: number): number => {
    if (!condition) return 0;
    signalIds.push(id);
    return points;
  };

  const exactSignalScores = [
    add(signals.providerThreadMatch, "provider_thread", 100),
    add(signals.providerMessageMatch, "provider_message", 100),
    add(signals.inReplyToMatch, "in_reply_to", 100),
    add(signals.referencesMatch, "references", 100),
    add(signals.trackingIdMatch, "tracking_id", 98),
    add(signals.authoritativeRelationshipMatch, "authoritative_relationship", 98),
    add(signals.quotedOriginalRecipientMatch, "quoted_original_recipient", 96),
  ];
  const exactScore = Math.max(0, ...exactSignalScores);
  let score = exactScore;
  if (exactScore === 0) {
    score += add(signals.explicitContextMatch, "explicit_context", 90);
    score += add(signals.senderHashMatch, "sender_hash", 35);
    score += add(signals.recipientHashMatch, "recipient_hash", 10);
    score += add(signals.normalizedSubjectMatch, "normalized_subject", 20);
    score += add(signals.creatorHistoryMatch, "creator_history", 15);
    score += add(signals.outreachHistoryMatch, "outreach_history", 10);
    score += add(signals.youtubeUrlMatch, "youtube_url", 15);
    score += add(signals.linkMatch, "link", 10);
    const withinDays = Number(signals.withinDays);
    if (Number.isFinite(withinDays) && withinDays >= 0) {
      if (withinDays <= 14) {
        signalIds.push("time_window_14d");
        score += 10;
      } else if (withinDays <= 30) {
        signalIds.push("time_window_30d");
        score += 6;
      } else if (withinDays <= 90) {
        signalIds.push("time_window_90d");
        score += 2;
      }
    }
  } else {
    // Exact relationship authority determines the score, but identity provenance
    // still belongs in the evidence trail for every exact email lookup shape.
    add(signals.senderHashMatch, "sender_hash", 0);
    add(signals.recipientHashMatch, "recipient_hash", 0);
  }
  score = clamp(score, 0, exactScore > 0 ? 100 : 95);
  const evidenceRefs = Array.from(new Set([
    input.candidateRef,
    ...(Array.isArray(input.evidenceRefs) ? input.evidenceRefs : []),
  ].map(safeEvidenceRef).filter(Boolean))).sort();
  return {
    candidateRef: evidenceRefs[0] ?? safeEvidenceRef(input.candidateRef),
    evidenceRefs,
    programId,
    ...(asString(input.campaignId) ? { campaignId: asString(input.campaignId) } : {}),
    creatorIdentityKey: safeCreatorIdentityKey(input.creatorIdentityKey),
    score,
    confidence: score / 100,
    exact: exactScore > 0,
    signalIds: Array.from(new Set(signalIds)).sort(),
  };
}

function directSnapshot(reasonId: string, confidence: number): ConversationAttributionSnapshot {
  return {
    primaryBucket: "direct",
    confidence: clamp(confidence, 0, 1),
    source: "automatic",
    reasonId,
  };
}

function programSnapshot(
  candidate: RankedAttributionCandidate,
  reasonId: string,
): ConversationAttributionSnapshot {
  return {
    primaryBucket: "program",
    programId: candidate.programId,
    ...(candidate.campaignId ? { campaignId: candidate.campaignId } : {}),
    confidence: candidate.confidence,
    source: "automatic",
    reasonId,
  };
}

export function resolveConversationAttribution(input: {
  candidates?: AttributionCandidateInput[];
}): ConversationAttributionResolution {
  const rankedCandidates = (input.candidates ?? [])
    .map(scoreCandidate)
    .filter((candidate): candidate is RankedAttributionCandidate => Boolean(candidate))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.programId !== right.programId) return left.programId.localeCompare(right.programId);
      const byCampaign = (left.campaignId ?? "").localeCompare(right.campaignId ?? "");
      return byCampaign || left.creatorIdentityKey.localeCompare(right.creatorIdentityKey);
    });
  const top = rankedCandidates[0];
  if (!top) {
    const snapshot = directSnapshot("no_program_evidence_direct", 1);
    return {
      suggested: snapshot,
      final: snapshot,
      reviewRequired: false,
      reasonId: "no_program_evidence_direct",
      rankedCandidates,
    };
  }

  // Duplicate evidence rows for the same program/campaign must not hide the first
  // genuinely competing target. Compare the top candidate with the highest-ranked
  // distinct target, not merely rankedCandidates[1].
  const competing = rankedCandidates.find((candidate) => (
    candidate.programId !== top.programId
    || (candidate.campaignId ?? "") !== (top.campaignId ?? "")
  ));
  // Exact RFC/thread/tracking evidence is authoritative over fuzzy similarity.
  // Only candidates from the same evidence tier can make the result ambiguous;
  // otherwise a strong fuzzy candidate could incorrectly demote an exact reply.
  const ambiguous = Boolean(competing) &&
    top.exact === competing?.exact &&
    top.score - (competing?.score ?? 0) < AMBIGUITY_DELTA;
  if (ambiguous) {
    return {
      suggested: programSnapshot(top, "ambiguous_candidate_review"),
      final: directSnapshot("ambiguous_candidate_review", 1 - top.confidence),
      reviewRequired: true,
      reasonId: "ambiguous_candidate_review",
      rankedCandidates,
    };
  }

  if (top.exact) {
    const reasonId = "exact_match_auto_program";
    const snapshot = programSnapshot(top, reasonId);
    return {
      suggested: snapshot,
      final: snapshot,
      reviewRequired: false,
      reasonId,
      rankedCandidates,
    };
  }
  return {
    suggested: programSnapshot(top, "fuzzy_candidate_review"),
    final: directSnapshot("fuzzy_candidate_review", 1 - top.confidence),
    reviewRequired: true,
    reasonId: "fuzzy_candidate_review",
    rankedCandidates,
  };
}

function cleanSnapshot(value: unknown, fallback: ConversationAttributionSnapshot): ConversationAttributionSnapshot {
  const data = asRecord(value);
  const primaryBucket = data.primaryBucket === "program" ? "program" : data.primaryBucket === "direct" ? "direct" : fallback.primaryBucket;
  const programId = primaryBucket === "program" ? resolveCanonicalProgramId(data.programId ?? fallback.programId) : "";
  if (primaryBucket === "program" && !programId) return fallback;
  const source = data.source === "manual" || data.source === "revert" ? data.source : "automatic";
  return {
    primaryBucket,
    ...(programId ? { programId } : {}),
    ...(programId && asString(data.campaignId ?? fallback.campaignId) ? { campaignId: asString(data.campaignId ?? fallback.campaignId) } : {}),
    confidence: clamp(Number(data.confidence ?? fallback.confidence) || 0, 0, 1),
    source,
    reasonId: asString(data.reasonId, fallback.reasonId),
    ...(asString(data.decidedAtIso) ? { decidedAtIso: asString(data.decidedAtIso) } : {}),
  };
}

function recordedAttributionStatus(final: ConversationAttributionSnapshot): Exclude<ConversationAttributionStatus, "legacy/unrecorded"> {
  return final.source === "manual" || final.source === "revert" ? "manual_confirmed" : "automatic";
}

function originalSnapshot(conversation: Record<string, unknown>): ConversationAttributionSnapshot {
  const programId = resolveCanonicalProgramId(conversation.programId);
  return programId
    ? {
        primaryBucket: "program",
        programId,
        ...(asString(conversation.campaignId) ? { campaignId: asString(conversation.campaignId) } : {}),
        confidence: 1,
        source: "automatic",
        reasonId: "original_top_level_program",
      }
    : directSnapshot("original_unassigned_direct", 1);
}

export function mergeAutomaticConversationAttribution(
  conversation: Record<string, unknown>,
  resolution: ConversationAttributionResolution,
  nowIso = new Date().toISOString(),
): ConversationAttributionState {
  const existing = asRecord(conversation.attribution);
  const fallbackOriginal = originalSnapshot(conversation);
  const original = cleanSnapshot(existing.original, fallbackOriginal);
  const existingFinal = cleanSnapshot(existing.final, resolution.final);
  const manualFinal = existingFinal.source === "manual" || existingFinal.source === "revert";
  const final = {
    ...(manualFinal ? existingFinal : resolution.final),
    decidedAtIso: manualFinal ? existingFinal.decidedAtIso ?? nowIso : nowIso,
  };
  return {
    policyVersion: CONVERSATION_ATTRIBUTION_POLICY_VERSION,
    attributionStatus: recordedAttributionStatus(final),
    version: Math.max(0, Number(existing.version) || 0) + 1,
    reviewRequired: manualFinal ? false : resolution.reviewRequired,
    original,
    suggested: { ...resolution.suggested, decidedAtIso: nowIso },
    final,
    rankedCandidates: resolution.rankedCandidates,
    updatedAtIso: nowIso,
  };
}

export function resolveInboundConversationAttribution(input: {
  matchedOutboundRef?: string;
  matchBasis?: string;
  programId?: string;
  campaignId?: string;
  normalizedSubjectMatch?: boolean;
  withinDays?: number;
}): ConversationAttributionResolution {
  const programId = resolveCanonicalProgramId(input.programId);
  if (!programId) return resolveConversationAttribution({ candidates: [] });
  const matchBasis = asString(input.matchBasis);
  const signals: AttributionSignals = matchBasis === "reply_header"
    ? { inReplyToMatch: true }
    : matchBasis === "tracking_id"
      ? { trackingIdMatch: true }
      : matchBasis === "from_address"
        ? {
            senderHashMatch: true,
            normalizedSubjectMatch: input.normalizedSubjectMatch === true,
            creatorHistoryMatch: true,
            outreachHistoryMatch: true,
            withinDays: input.withinDays,
          }
        : {};
  return resolveConversationAttribution({
    candidates: [{
      candidateRef: asString(input.matchedOutboundRef, "program_context/current"),
      programId,
      campaignId: input.campaignId,
      creatorIdentityKey: "identity:unknown",
      signals,
    }],
  });
}

export type InboundAttributionEvidence = {
  candidateRef: string;
  programId?: string;
  campaignId?: string;
  campaignProgramId?: string;
  programVerified?: boolean;
  evidenceOwnerUid?: string;
  programOwnerUid?: string;
  campaignOwnerUid?: string;
  ownershipConflict?: boolean;
  subject?: string;
  observedAtIso?: string;
  senderHashMatch?: boolean;
  recipientHashMatch?: boolean;
  creatorHistoryMatch?: boolean;
  outreachHistoryMatch?: boolean;
  youtubeUrlMatch?: boolean;
  linkMatch?: boolean;
  exactLink?: boolean;
  authoritativeRelationshipMatch?: boolean;
  explicitContextMatch?: boolean;
  verifiedWorkflowContext?: boolean;
  creatorIdentityKey?: string;
  quotedOriginalRecipientMatch?: boolean;
};

export type InboundAttributionMaterialization = {
  resolution: ConversationAttributionResolution;
  rejectedCandidateRefs: string[];
};

type CandidateAccumulator = {
  candidateRef: string;
  evidenceRefs: Set<string>;
  programId: string;
  campaignId?: string;
  creatorIdentityKey: string;
  signals: AttributionSignals;
};

function safeOwnerUid(value: unknown): string {
  const uid = asString(value);
  return uid && !uid.includes("/") && uid.length <= 200 ? uid : "";
}

function exactSignalsFor(matchBasis: string): AttributionSignals {
  if (matchBasis === "reply_header") return { inReplyToMatch: true };
  if (matchBasis === "tracking_id") return { trackingIdMatch: true };
  return {};
}

function mergeSignals(target: AttributionSignals, source: AttributionSignals): void {
  for (const [key, value] of Object.entries(source) as Array<[keyof AttributionSignals, boolean | number | undefined]>) {
    if (key === "withinDays") {
      const current = Number(target.withinDays);
      const next = Number(value);
      if (Number.isFinite(next) && next >= 0 && (!Number.isFinite(current) || current < 0 || next < current)) {
        target.withinDays = next;
      }
      continue;
    }
    if (value === true) (target as Record<string, unknown>)[key] = true;
  }
}

function evidenceWithinDays(observedAtIso: unknown, receivedAtIso: unknown): number | undefined {
  const observed = Date.parse(asString(observedAtIso));
  const received = Date.parse(asString(receivedAtIso));
  if (!Number.isFinite(observed) || !Number.isFinite(received)) return undefined;
  return Math.max(0, Math.floor((received - observed) / 86_400_000));
}

function ownershipConflict(input: {
  evidence: InboundAttributionEvidence;
  requesterUid?: string;
  requesterRole?: string;
}): boolean {
  if (input.evidence.ownershipConflict === true) return true;
  const owners = Array.from(new Set([
    input.evidence.evidenceOwnerUid,
    input.evidence.programOwnerUid,
    input.evidence.campaignOwnerUid,
  ].map(safeOwnerUid).filter(Boolean)));
  if (owners.length > 1) return true;
  if (input.requesterRole !== "manager") return false;
  const requesterUid = safeOwnerUid(input.requesterUid);
  const programOwnerUid = safeOwnerUid(input.evidence.programOwnerUid);
  return !requesterUid || !programOwnerUid || owners.length !== 1 || programOwnerUid !== requesterUid;
}

function ownershipReviewResolution(
  rankedCandidates: RankedAttributionCandidate[] = [],
  allOurScpPrograms = false,
): ConversationAttributionResolution {
  const snapshot = directSnapshot("ownership_conflict_review", 1);
  return {
    suggested: snapshot,
    final: snapshot,
    reviewRequired: true,
    reasonId: "ownership_conflict_review",
    rankedCandidates,
    ...(allOurScpPrograms ? { ownershipConflictAllOurScpPrograms: true } : {}),
  };
}

export function materializeInboundAttributionEvidence(input: {
  evidence?: InboundAttributionEvidence[];
  inboundSubject?: string;
  receivedAtIso?: string;
  matchedOutboundRef?: string;
  matchBasis?: string;
  explicitProgramId?: string;
  explicitCampaignId?: string;
  requesterUid?: string;
  requesterRole?: string;
  hardAmbiguity?: boolean;
}): InboundAttributionMaterialization {
  const inboundSubject = normalizeAttributionSubject(input.inboundSubject);
  const matchedOutboundRef = safeEvidenceRef(input.matchedOutboundRef);
  const explicitProgramId = resolveCanonicalProgramId(input.explicitProgramId);
  const explicitCampaignId = asString(input.explicitCampaignId);
  const rejectedCandidateRefs = new Set<string>();
  // 2026-09-27 (헤세 지시 — 보류메일 재고): ownershipConflict() 로 거절된 항목의 programId 만
  //   따로 모은다(invalidProgram/invalidCampaign 거절은 소유권 충돌이 아니므로 제외) —
  //   ownership_conflict_review 가 "우리 SCP 프로그램끼리의 충돌"인지 판정하는 유일한 근거.
  const rejectedOwnershipConflictProgramIds = new Set<string>();
  const grouped = new Map<string, CandidateAccumulator>();
  const exactBasis = asString(input.matchBasis) === "reply_header"
    || asString(input.matchBasis) === "tracking_id";
  let rejectedExactTarget = false;

  for (const evidence of input.evidence ?? []) {
    const candidateRef = safeEvidenceRef(evidence.candidateRef);
    const programId = resolveCanonicalProgramId(evidence.programId);
    if (!candidateRef || !programId) continue;
    const campaignId = asString(evidence.campaignId);
    const campaignProgramId = resolveCanonicalProgramId(evidence.campaignProgramId);
    const invalidProgram = evidence.programVerified !== true;
    const invalidCampaign = Boolean(campaignId) && (!campaignProgramId || campaignProgramId !== programId);
    const hasOwnershipConflict = ownershipConflict({
      evidence,
      requesterUid: input.requesterUid,
      requesterRole: input.requesterRole,
    });
    if (invalidProgram || invalidCampaign || hasOwnershipConflict) {
      rejectedCandidateRefs.add(candidateRef);
      if (hasOwnershipConflict) rejectedOwnershipConflictProgramIds.add(programId);
      if (exactBasis && (
        evidence.exactLink === true
        || Boolean(matchedOutboundRef && candidateRef === matchedOutboundRef)
      )) {
        rejectedExactTarget = true;
      }
      continue;
    }

    const creatorIdentityKey = safeCreatorIdentityKey(evidence.creatorIdentityKey);
    const targetKey = `${programId}|${campaignId}|${creatorIdentityKey}`;
    const accumulator = grouped.get(targetKey) ?? {
      candidateRef,
      evidenceRefs: new Set<string>(),
      programId,
      ...(campaignId ? { campaignId } : {}),
      creatorIdentityKey,
      signals: {},
    };
    accumulator.evidenceRefs.add(candidateRef);
    if (candidateRef.localeCompare(accumulator.candidateRef) < 0) accumulator.candidateRef = candidateRef;
    const exact = exactBasis && (
      evidence.exactLink === true
      || Boolean(matchedOutboundRef && candidateRef === matchedOutboundRef)
    );
    const withinDays = evidenceWithinDays(evidence.observedAtIso, input.receivedAtIso);
    mergeSignals(accumulator.signals, {
      ...(exact ? exactSignalsFor(asString(input.matchBasis)) : {}),
      authoritativeRelationshipMatch: evidence.authoritativeRelationshipMatch === true,
      explicitContextMatch: evidence.verifiedWorkflowContext === true
        && evidence.explicitContextMatch === true
        && Boolean(
          explicitProgramId
          && explicitProgramId === programId
          && (!explicitCampaignId || explicitCampaignId === campaignId)
        ),
      senderHashMatch: evidence.senderHashMatch === true,
      recipientHashMatch: evidence.recipientHashMatch === true,
      normalizedSubjectMatch: Boolean(
        inboundSubject &&
        normalizeAttributionSubject(evidence.subject) === inboundSubject
      ),
      creatorHistoryMatch: evidence.creatorHistoryMatch === true,
      outreachHistoryMatch: evidence.outreachHistoryMatch === true,
      youtubeUrlMatch: evidence.youtubeUrlMatch === true,
      linkMatch: evidence.linkMatch === true,
      quotedOriginalRecipientMatch: evidence.quotedOriginalRecipientMatch === true,
      withinDays,
    });
    grouped.set(targetKey, accumulator);
  }

  const candidates: AttributionCandidateInput[] = Array.from(grouped.values()).map((candidate) => ({
    candidateRef: candidate.candidateRef,
    evidenceRefs: Array.from(candidate.evidenceRefs).sort(),
    programId: candidate.programId,
    ...(candidate.campaignId ? { campaignId: candidate.campaignId } : {}),
    creatorIdentityKey: candidate.creatorIdentityKey,
    signals: candidate.signals,
  }));
  // 2026-09-27 (헤세 지시 — 보류메일 재고): 이 충돌에 관여한 프로그램(거절된 것 + 살아남아
  //   랭크된 것) 전부가 우리 SCP 프로그램군일 때만 true — 하나라도 외부/미상이면 false.
  const conflictProgramIds = new Set<string>([
    ...rejectedOwnershipConflictProgramIds,
    ...candidates.map((candidate) => candidate.programId).filter((id): id is string => Boolean(id)),
  ]);
  const ownershipConflictAllOurScpPrograms =
    conflictProgramIds.size > 0 &&
    Array.from(conflictProgramIds).every((id) => isScpLikeProgramId(id));
  const baseResolution = candidates.length === 0 && rejectedCandidateRefs.size > 0
    ? ownershipReviewResolution([], ownershipConflictAllOurScpPrograms)
    : resolveConversationAttribution({ candidates });
  const top = baseResolution.rankedCandidates[0];
  const resolution: ConversationAttributionResolution = rejectedExactTarget
    ? ownershipReviewResolution(baseResolution.rankedCandidates, ownershipConflictAllOurScpPrograms)
    : input.hardAmbiguity === true && top
    ? {
        suggested: programSnapshot(top, "ambiguous_candidate_review"),
        final: directSnapshot("ambiguous_candidate_review", 1 - top.confidence),
        reviewRequired: true,
        reasonId: "ambiguous_candidate_review",
        rankedCandidates: baseResolution.rankedCandidates,
      }
    : baseResolution;
  return {
    resolution,
    rejectedCandidateRefs: Array.from(rejectedCandidateRefs).sort(),
  };
}

type AttributionEvidenceDocument = {
  path: string;
  collection:
    | "message_sources"
    | "campaign_outreach"
    | "scp_coldmail_history"
    | "mail_outbound_log"
    | "creator_links"
    | "program_sheet_leads"
    | "program_applications"
    | "submissions"
    | "reviews"
    | "explicit_context";
  data: Record<string, unknown>;
  exactLink?: boolean;
  exactSenderMatch?: boolean;
  exactSenderHashMatch?: boolean;
  exactRelationshipMatch?: boolean;
  // conv_13ioeao: set only on rows fetched via the quotedOriginalRecipientEmail-keyed queries
  // below — NOT inferred from field name (unlike exactSenderMatch/exactSenderHashMatch above),
  // because collections like scp_coldmail_history key on emailLower/emailHash, which the
  // sourceRecipient/sourceHash locals in the evidence loop below never inspect.
  quotedRecipientMatch?: boolean;
};

function attributionEmailHash(value: unknown): string {
  const normalized = asString(value).trim().toLowerCase();
  return normalized
    ? createHash("sha256").update(normalized).digest("hex").slice(0, 24)
    : "";
}

function isFirestoreMissingIndexError(error: unknown): boolean {
  const row = asRecord(error);
  const code = row.code;
  const message = asString(row.message, "").toLowerCase();
  return (code === 9 || code === "failed-precondition" || code === "9")
    && message.includes("requires an index");
}

function attributionCreatorIdentity(
  record: Record<string, unknown>,
  fallbackRecipientHash = "",
): string {
  const nestedApplicant = asRecord(record.applicant);
  const normalizeToken = (value: unknown): string => asString(value)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/\s+/g, "");
  const creatorId = normalizeToken(record.creatorId);
  if (creatorId) return safeCreatorIdentityKey(`creator:${creatorId}`);
  const channelId = normalizeToken(
    record.channelId ?? record.youtubeChannelId ?? record.creatorChannelId,
  );
  if (channelId) return safeCreatorIdentityKey(`channel:${channelId}`);
  const handle = normalizeToken(record.creatorHandle ?? record.handle);
  if (handle) return safeCreatorIdentityKey(`handle:${handle}`);
  const youtubeUrl = asString(
    record.youtubeUrl,
    asString(record.channelUrl, asString(nestedApplicant.youtubeUrl)),
  );
  if (youtubeUrl) {
    try {
      const parsed = new URL(youtubeUrl);
      const canonical = `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`;
      if (canonical) return safeCreatorIdentityKey(`youtube:${canonical}`);
    } catch {
      const canonical = normalizeToken(youtubeUrl);
      if (canonical) return safeCreatorIdentityKey(`youtube:${canonical}`);
    }
  }
  const candidateId = normalizeToken(record.candidateId ?? record.leadId ?? record.applicationId);
  if (candidateId) return safeCreatorIdentityKey(`candidate:${candidateId}`);
  const recipientHash = asString(
    record.toHash,
    asString(record.recipientHash, fallbackRecipientHash),
  );
  return safeCreatorIdentityKey(
    recipientHash ? `recipient:${recipientHash}` : "identity:unknown",
  );
}

/**
 * EVERY explicit identity key one record asserts for its creator (creator:/channel:/handle:/youtube:/
 * candidate:). attributionCreatorIdentity picks only the first by priority; a single authoritative record
 * (our own outbound) that carries several identifiers proves they name ONE creator.
 */
export function attributionCreatorIdentityKeys(record: Record<string, unknown>): string[] {
  const nestedApplicant = asRecord(record.applicant);
  const token = (value: unknown): string => asString(value).normalize("NFKC").trim().toLowerCase().replace(/^@+/, "").replace(/\s+/g, "");
  const keys: string[] = [];
  const add = (key: string) => { const safe = safeCreatorIdentityKey(key); if (safe !== "identity:unknown") keys.push(safe); };
  const creatorId = token(record.creatorId);
  if (creatorId) add(`creator:${creatorId}`);
  const channelId = token(record.channelId ?? record.youtubeChannelId ?? record.creatorChannelId);
  if (channelId) add(`channel:${channelId}`);
  const handle = token(record.creatorHandle ?? record.handle);
  if (handle) add(`handle:${handle}`);
  const youtubeUrl = asString(record.youtubeUrl, asString(record.channelUrl, asString(nestedApplicant.youtubeUrl)));
  if (youtubeUrl) {
    try {
      const parsed = new URL(youtubeUrl);
      const canonical = `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`;
      if (canonical) add(`youtube:${canonical}`);
    } catch {
      const canonical = token(youtubeUrl);
      if (canonical) add(`youtube:${canonical}`);
    }
  }
  const candidateId = token(record.candidateId ?? record.leadId ?? record.applicationId);
  if (candidateId) add(`candidate:${candidateId}`);
  return Array.from(new Set(keys));
}

/**
 * Synthetic system actors (scheduled workers) that author outreach documents on behalf of nobody in
 * particular. EXACT allowlist of the service identities the codebase itself defines (scpOutboxMailWorkers.ts,
 * scpOutreach.ts, chat-ai.ts canary, scpVideoSubmissionReminder.ts, mailImapIngest.ts) — deliberately not a
 * `scp-*` prefix match, so a real or look-alike owner uid can never be waved through.
 */
export const SYSTEM_AUTOMATION_OWNER_UIDS: ReadonlySet<string> = new Set([
  "mail-ingest-worker",
  "scp-outbox-mail-worker",
  "scp-outreach-scheduler",
  "scp-canary-scheduler",
  "scp-video-reminder-scheduler",
]);

// `mail-ingest-worker` is skipped for every record kind (historic behavior). The other system actors are
// skipped ONLY for evidence documents (sent outreach rows they authored): a system sender is the author
// of the send, not a competing owner of the program. Program/campaign docs keep the strict behavior.
export function attributionOwner(
  record: Record<string, unknown>,
  options: { ignoreSystemAutomationOwners?: boolean } = {},
): { ownerUid: string; conflict: boolean } {
  const ignored = (owner: string): boolean => owner === "mail-ingest-worker"
    || (options.ignoreSystemAutomationOwners === true && SYSTEM_AUTOMATION_OWNER_UIDS.has(owner));
  const explicitOwners = Array.from(new Set([
    record.programOwnerUid,
    record.ownerUid,
    record.ownerUserId,
    record.managerUid,
  ].map(safeOwnerUid).filter((owner) => owner && !ignored(owner))));
  // createdBy is a legacy fallback, never a second owner once an explicit owner
  // exists. Treating it as co-equal rejected otherwise-valid program evidence when
  // an administrator created a program on behalf of its manager.
  const owners = explicitOwners.length > 0
    ? explicitOwners
    : Array.from(new Set([record.createdBy]
      .map(safeOwnerUid)
      .filter((owner) => owner && !ignored(owner))));
  return { ownerUid: owners.length === 1 ? owners[0] : "", conflict: owners.length > 1 };
}

function evidenceObservedAt(record: Record<string, unknown>): string {
  return asString(
    record.sentAtIso,
    asString(record.lastMessageAtIso, asString(record.updatedAtIso, asString(record.createdAtIso))),
  );
}

function isAuthoritativeSentOutreach(document: AttributionEvidenceDocument): boolean {
  if (!["message_sources", "campaign_outreach", "scp_coldmail_history", "mail_outbound_log"].includes(document.collection)) {
    return false;
  }
  if (document.collection === "message_sources" && asString(document.data.direction) !== "outbound") return false;
  return Boolean(asString(
    document.data.sentAtIso,
    asString(document.data.deliveredAtIso),
  ));
}

type AuthoritativeWorkflowCollection = "program_applications" | "submissions" | "reviews";

function authoritativeWorkflowCollection(
  value: unknown,
): AuthoritativeWorkflowCollection | null {
  const match = /^(program_applications|submissions|reviews)\/[A-Za-z0-9_.:-]+$/.exec(asString(value));
  return (match?.[1] as AuthoritativeWorkflowCollection | undefined) ?? null;
}

function authoritativeWorkflowRef(value: unknown): string {
  const ref = safeEvidenceRef(value);
  return authoritativeWorkflowCollection(ref) ? ref : "";
}

function isAuthoritativeWorkflowRelationship(document: AttributionEvidenceDocument): boolean {
  return document.exactRelationshipMatch === true
    && Boolean(authoritativeWorkflowCollection(document.path));
}

// conv_13ioeao spoof guard, second layer: a quoted header block alone is not enough to grant an
// exact-tier attribution signal — the reply's own subject (normally "Re: <original subject>")
// must be at least roughly consistent with the outbound record's stored subject. Absence on
// either side never blocks (older/plain-text rows often have no stored subject) — only an
// actual, present mismatch does.
export function quotedRecipientSubjectConsistent(inboundSubject: unknown, docSubject: unknown): boolean {
  const normalizedInbound = normalizeAttributionSubject(inboundSubject);
  const normalizedDoc = normalizeAttributionSubject(docSubject);
  if (!normalizedInbound || !normalizedDoc) return true;
  return normalizedInbound === normalizedDoc
    || (normalizedDoc.length >= 6 && normalizedInbound.includes(normalizedDoc))
    || (normalizedInbound.length >= 6 && normalizedDoc.includes(normalizedInbound));
}

function attributionContextMatch(inboundText: string, labels: unknown[]): boolean {
  const normalizedInbound = normalizeAttributionSubject(inboundText);
  if (!normalizedInbound) return false;
  for (const label of labels) {
    const tokens = normalizeAttributionSubject(label)
      .split(" ")
      .filter((token) => token.length >= 4 && !["creator", "program", "campaign", "supercent"].includes(token));
    if (tokens.length === 0) continue;
    const matches = tokens.filter((token) => normalizedInbound.includes(token));
    if (matches.some((token) => token.length >= 7) || matches.length >= Math.min(2, tokens.length)) return true;
  }
  return false;
}

function conversationAttributionTarget(record: Record<string, unknown>): { programId: string; campaignId: string; manualDirect: boolean } {
  const attribution = asRecord(record.attribution);
  const final = asRecord(attribution.final);
  if (final.source === "manual" || final.source === "revert") {
    if (final.primaryBucket === "direct") return { programId: "", campaignId: "", manualDirect: true };
    if (final.primaryBucket === "program") {
      return {
        programId: resolveCanonicalProgramId(final.programId),
        campaignId: asString(final.campaignId),
        manualDirect: false,
      };
    }
  }
  return {
    programId: resolveCanonicalProgramId(record.programId ?? record.canonicalProgramId),
    campaignId: asString(record.campaignId),
    manualDirect: false,
  };
}

// conv_13ioeao: re-tags queryEvidenceDocuments results found via a quotedOriginalRecipientEmail
// query as quotedRecipientMatch, and clears the exactSenderMatch/exactSenderHashMatch markers
// queryEvidenceDocuments infers from field name alone — those markers exist to answer "does the
// ACTUAL SMTP sender match this row", which is a different question the quoted-recipient lookup
// must never answer yes to on its own.
function asQuotedRecipientEvidence(rows: AttributionEvidenceDocument[]): AttributionEvidenceDocument[] {
  return rows.map((row) => ({
    ...row,
    exactSenderMatch: false,
    exactSenderHashMatch: false,
    quotedRecipientMatch: true,
  }));
}

async function queryEvidenceDocuments(
  collection: AttributionEvidenceDocument["collection"],
  field: string,
  value: string,
  orderField = "",
  transaction?: Transaction,
): Promise<AttributionEvidenceDocument[]> {
  if (!value || collection === "explicit_context") return [];
  const pageSize = 200;
  const maxRows = 2_000;
  const readRows = async (ordered: boolean): Promise<AttributionEvidenceDocument[]> => {
    const rows: AttributionEvidenceDocument[] = [];
    let cursor: QueryDocumentSnapshot | null = null;
    while (rows.length < maxRows) {
      let query = adminDb.collection(collection).where(field, "==", value);
      query = ordered && orderField
        ? query
            .orderBy(orderField, "desc")
            .orderBy(FieldPath.documentId(), "asc")
        : query.orderBy(FieldPath.documentId(), "asc");
      if (cursor) query = query.startAfter(cursor);
      const limited = query.limit(Math.min(pageSize, maxRows - rows.length));
      // Inside a repair transaction the evidence QUERIES are transactional reads too.
      const snapshot = transaction ? await transaction.get(limited) : await limited.get();
      for (const doc of snapshot.docs) {
        const exactSenderHashMatch = field === "toHash" || field === "emailHash";
        const exactSenderMatch = exactSenderHashMatch || [
          "toNormalized",
          "to",
          "creatorEmail",
          "emailLower",
          "email",
          "applicant.email",
          "applicant.emailLower",
        ].includes(field);
        rows.push({
          path: doc.ref.path,
          collection,
          data: doc.data() ?? {},
          ...(exactSenderMatch ? { exactSenderMatch: true } : {}),
          ...(exactSenderHashMatch ? { exactSenderHashMatch: true } : {}),
        });
      }
      if (snapshot.size < pageSize) break;
      cursor = snapshot.docs.at(-1) ?? null;
      if (!cursor) break;
    }
    return rows;
  };
  try {
    return await readRows(Boolean(orderField));
  } catch (error) {
    if (!orderField || !isFirestoreMissingIndexError(error)) throw error;
    // Equality lookups are covered by Firestore's single-field index. A missing
    // timestamp composite must not make an otherwise valid inbound message disappear.
    return readRows(false);
  }
}

function validMessageSourceRef(value: unknown): string {
  const ref = safeEvidenceRef(value);
  return /^message_sources\/[A-Za-z0-9_.:-]+$/.test(ref) ? ref : "";
}

export async function discoverInboundConversationAttribution(input: {
  conversationId?: string;
  senderEmail?: string;
  inboundSubject?: string;
  inboundBody?: string;
  receivedAtIso?: string;
  matchedOutboundRef?: string;
  matchBasis?: string;
  explicitProgramId?: string;
  explicitCampaignId?: string;
  explicitContextSourceRef?: string;
  explicitContextVerified?: boolean;
  hardAmbiguity?: boolean;
  requesterUid?: string;
  requesterRole?: string;
  // conv_13ioeao (2026-09-27): the quoted original recipient parsed out of a quoted-reply header
  // block whose quoted sender is our scp@ mailbox (mailQuotedReplyAttribution.ts). Populated when
  // the SMTP From doesn't match anything we sent to (personal/alternate reply address) but the
  // creator's mail client still quoted our original message's headers inline.
  quotedOriginalRecipientEmail?: string;
  /** When set, every evidence read (queries included) happens inside this Firestore transaction. */
  transaction?: Transaction;
}): Promise<InboundAttributionMaterialization> {
  const getDocument = (ref: FirebaseFirestore.DocumentReference) => (
    input.transaction ? input.transaction.get(ref) : ref.get()
  );
  const getAllDocuments = (refs: FirebaseFirestore.DocumentReference[]) => (
    input.transaction ? input.transaction.getAll(...refs) : adminDb.getAll(...refs)
  );
  const conversationId = asString(input.conversationId);
  const validConversationId = conversationId
    && !conversationId.includes("/")
    && conversationId.length <= 500
    ? conversationId
    : "";
  const senderEmail = asString(input.senderEmail).trim().toLowerCase();
  const senderHash = attributionEmailHash(senderEmail);
  const quotedRecipientEmail = asString(input.quotedOriginalRecipientEmail).trim().toLowerCase();
  const quotedRecipientHash = attributionEmailHash(quotedRecipientEmail);
  const matchedOutboundRef = validMessageSourceRef(input.matchedOutboundRef);
  const exactSnapshotPromise = matchedOutboundRef
    ? getDocument(adminDb.doc(matchedOutboundRef))
    : Promise.resolve(null);
  const conversationSnapshotPromise = validConversationId
    ? getDocument(adminDb.collection("conversations").doc(validConversationId))
    : Promise.resolve(null);
  const queryPromises: Array<Promise<AttributionEvidenceDocument[]>> = [];
  if (senderHash) {
    queryPromises.push(
      queryEvidenceDocuments("message_sources", "toHash", senderHash, "sentAtIso", input.transaction),
      queryEvidenceDocuments("scp_coldmail_history", "emailHash", senderHash, "sentAtIso", input.transaction),
    );
  }
  if (senderEmail) {
    queryPromises.push(
      queryEvidenceDocuments("message_sources", "toNormalized", senderEmail, undefined, input.transaction),
      queryEvidenceDocuments("message_sources", "to", senderEmail, undefined, input.transaction),
      queryEvidenceDocuments("message_sources", "creatorEmail", senderEmail, undefined, input.transaction),
      queryEvidenceDocuments("campaign_outreach", "creatorEmail", senderEmail, undefined, input.transaction),
      queryEvidenceDocuments("scp_coldmail_history", "emailLower", senderEmail, undefined, input.transaction),
      queryEvidenceDocuments("creator_links", "email", senderEmail, undefined, input.transaction),
      queryEvidenceDocuments("program_sheet_leads", "email", senderEmail, undefined, input.transaction),
      queryEvidenceDocuments("program_sheet_leads", "emailLower", senderEmail, undefined, input.transaction),
      queryEvidenceDocuments("program_sheet_leads", "applicant.email", senderEmail, undefined, input.transaction),
      queryEvidenceDocuments("program_sheet_leads", "applicant.emailLower", senderEmail, undefined, input.transaction),
      queryEvidenceDocuments("program_applications", "email", senderEmail, undefined, input.transaction),
      queryEvidenceDocuments("program_applications", "emailLower", senderEmail, undefined, input.transaction),
      queryEvidenceDocuments("program_applications", "applicant.email", senderEmail, undefined, input.transaction),
      queryEvidenceDocuments("program_applications", "applicant.emailLower", senderEmail, undefined, input.transaction),
    );
  }
  // conv_13ioeao: spoof guard is structural, not a text check — this only ever surfaces evidence
  // when Firestore actually holds a REAL outbound record (message_sources/campaign_outreach/
  // scp_coldmail_history) addressed to the quoted recipient. Scoped to the collections that are
  // actual sent-mail records — not creator_links/program_sheet_leads/program_applications, which
  // are registration data a quoted header block alone should never be able to surface.
  if (quotedRecipientEmail && quotedRecipientEmail !== senderEmail) {
    if (quotedRecipientHash) {
      queryPromises.push(
        queryEvidenceDocuments("message_sources", "toHash", quotedRecipientHash, "sentAtIso", input.transaction).then(asQuotedRecipientEvidence),
        queryEvidenceDocuments("scp_coldmail_history", "emailHash", quotedRecipientHash, "sentAtIso", input.transaction).then(asQuotedRecipientEvidence),
      );
    }
    queryPromises.push(
      queryEvidenceDocuments("message_sources", "toNormalized", quotedRecipientEmail, undefined, input.transaction).then(asQuotedRecipientEvidence),
      queryEvidenceDocuments("message_sources", "to", quotedRecipientEmail, undefined, input.transaction).then(asQuotedRecipientEvidence),
      queryEvidenceDocuments("message_sources", "creatorEmail", quotedRecipientEmail, undefined, input.transaction).then(asQuotedRecipientEvidence),
      queryEvidenceDocuments("campaign_outreach", "creatorEmail", quotedRecipientEmail, undefined, input.transaction).then(asQuotedRecipientEvidence),
      queryEvidenceDocuments("scp_coldmail_history", "emailLower", quotedRecipientEmail, undefined, input.transaction).then(asQuotedRecipientEvidence),
    );
  }
  const [exactSnapshot, conversationSnapshot, queryGroups] = await Promise.all([
    exactSnapshotPromise,
    conversationSnapshotPromise,
    Promise.all(queryPromises),
  ]);
  const exactDocument = exactSnapshot?.exists
    ? ({ path: exactSnapshot.ref.path, collection: "message_sources", data: exactSnapshot.data() ?? {}, exactLink: true } as AttributionEvidenceDocument)
    : null;
  const exactData = exactDocument?.data ?? {};
  const exactTrackingId = asString(exactData.trackingId, asString(exactData.externalTrackingId));
  const conversation = conversationSnapshot?.exists ? conversationSnapshot.data() ?? {} : {};
  const workflowRefs = Array.from(new Set([
    conversation.lastMessageRef,
    conversation.applicationRef,
    conversation.submissionRef,
    conversation.reviewRef,
    conversation.activeHumanReviewRef,
    asString(conversation.applicationId) ? `program_applications/${asString(conversation.applicationId)}` : "",
    asString(conversation.submissionId) ? `submissions/${asString(conversation.submissionId)}` : "",
    asString(conversation.reviewId) ? `reviews/${asString(conversation.reviewId)}` : "",
  ].map(authoritativeWorkflowRef).filter(Boolean)));
  const workflowSnapshots = workflowRefs.length > 0
    ? await getAllDocuments(workflowRefs.map((ref) => adminDb.doc(ref)))
    : [];
  const workflowDocuments: AttributionEvidenceDocument[] = workflowSnapshots
    .filter((snapshot) => snapshot.exists)
    .map((snapshot) => ({
      path: snapshot.ref.path,
      collection: authoritativeWorkflowCollection(snapshot.ref.path) as AuthoritativeWorkflowCollection,
      data: snapshot.data() ?? {},
      exactLink: true,
      exactRelationshipMatch: true,
    }));
  const relatedQueries: Array<Promise<AttributionEvidenceDocument[]>> = [];
  if (exactTrackingId) {
    relatedQueries.push(
      queryEvidenceDocuments("campaign_outreach", "trackingId", exactTrackingId, undefined, input.transaction),
      queryEvidenceDocuments("mail_outbound_log", "trackingId", exactTrackingId, undefined, input.transaction),
    );
  }
  if (matchedOutboundRef) {
    relatedQueries.push(queryEvidenceDocuments("campaign_outreach", "messageRef", matchedOutboundRef, undefined, input.transaction));
  }
  const relatedGroups = await Promise.all(relatedQueries);
  const documents = new Map<string, AttributionEvidenceDocument>();
  for (const document of [
    ...(exactDocument ? [exactDocument] : []),
    ...workflowDocuments,
    ...queryGroups.flat(),
    ...relatedGroups.flat().map((document) => ({
      ...document,
      exactLink: Boolean(exactTrackingId && asString(document.data.trackingId) === exactTrackingId) ||
        Boolean(matchedOutboundRef && asString(document.data.messageRef) === matchedOutboundRef),
    })),
  ]) {
    if (document.collection === "message_sources" && asString(document.data.direction) !== "outbound") continue;
    const previous = documents.get(document.path);
    documents.set(document.path, {
      ...(previous ?? document),
      ...document,
      exactLink: previous?.exactLink === true || document.exactLink === true,
      exactSenderMatch: previous?.exactSenderMatch === true || document.exactSenderMatch === true,
      exactSenderHashMatch: previous?.exactSenderHashMatch === true || document.exactSenderHashMatch === true,
      exactRelationshipMatch: previous?.exactRelationshipMatch === true || document.exactRelationshipMatch === true,
      quotedRecipientMatch: previous?.quotedRecipientMatch === true || document.quotedRecipientMatch === true,
    });
  }

  const rawTargets = Array.from(documents.values()).map((document) => ({
    document,
    target: conversationAttributionTarget(document.data),
  })).filter((row) => !row.target.manualDirect);
  const explicitContextSourceRef = safeEvidenceRef(input.explicitContextSourceRef);
  const explicitContextVerified = input.explicitContextVerified === true
    && /^(campaign_outreach|mail_outbound_log|creator_links|program_applications|program_sheet_leads)\/[A-Za-z0-9_.:-]+$/.test(explicitContextSourceRef);
  const verifiedExplicitCampaignId = explicitContextVerified
    ? asString(input.explicitCampaignId)
    : "";
  const verifiedExplicitProgramId = explicitContextVerified
    ? resolveCanonicalProgramId(input.explicitProgramId)
    : "";
  const campaignIds = Array.from(new Set([
    verifiedExplicitCampaignId,
    ...rawTargets.map((row) => row.target.campaignId),
  ].filter(Boolean))).slice(0, 100);
  const campaignSnapshots = campaignIds.length > 0
    ? await getAllDocuments(campaignIds.map((id) => adminDb.collection("campaigns").doc(id)))
    : [];
  const campaigns = new Map(campaignSnapshots.filter((snapshot) => snapshot.exists).map((snapshot) => [snapshot.id, snapshot.data() ?? {}]));
  const targetProgramIds = Array.from(new Set([
    verifiedExplicitProgramId,
    ...rawTargets.flatMap((row) => {
      const campaign = campaigns.get(row.target.campaignId);
      return [row.target.programId, resolveCanonicalProgramId(campaign?.programId)];
    }),
  ].filter(Boolean))).slice(0, 100);
  const programSnapshots = targetProgramIds.length > 0
    ? await getAllDocuments(targetProgramIds.map((id) => adminDb.collection("programs").doc(id)))
    : [];
  const programs = new Map(programSnapshots.filter((snapshot) => snapshot.exists).map((snapshot) => [resolveCanonicalProgramId(snapshot.id), snapshot.data() ?? {}]));
  const inboundText = `${asString(input.inboundSubject)} ${asString(input.inboundBody)}`;
  const evidence: InboundAttributionEvidence[] = [];

  for (const { document, target } of rawTargets) {
    const campaign = campaigns.get(target.campaignId);
    const campaignProgramId = resolveCanonicalProgramId(campaign?.programId);
    const programId = resolveCanonicalProgramId(target.programId || campaignProgramId);
    if (!programId) continue;
    const program = programs.get(programId);
    const sourceOwner = attributionOwner(document.data, { ignoreSystemAutomationOwners: true });
    const campaignOwner = attributionOwner(campaign ?? {});
    const programOwner = attributionOwner(program ?? {});
    const sourceHash = asString(document.data.toHash, asString(document.data.recipientHash));
    const sourceRecipient = asString(document.data.toNormalized, asString(document.data.to, asString(document.data.creatorEmail))).toLowerCase();
    // Driven by the query-provenance marker (asQuotedRecipientEvidence), not a raw
    // sourceRecipient/sourceHash comparison — those locals never inspect the emailLower/
    // emailHash fields scp_coldmail_history is queried on, so they would silently miss a real
    // match there.
    const quotedOriginalRecipientMatch = Boolean(
      document.quotedRecipientMatch === true
      && quotedRecipientSubjectConsistent(input.inboundSubject, document.data.subject),
    );
    // conv_13ioeao BLOCKER fix (adversarial review): isAuthoritativeSentOutreach fires on any
    // message_sources/campaign_outreach/scp_coldmail_history/mail_outbound_log row with a
    // sentAtIso — it does not itself check sender identity, because every OTHER way a document
    // reaches this loop already implies a real identity match (senderEmail/senderHash query hit,
    // or an exact tracking/workflow link). A document reached ONLY via the quoted-recipient query
    // has no such guarantee on its own — without this gate it would silently bypass
    // quotedRecipientSubjectConsistent entirely and grant the same 98-point exact-tier score
    // authoritativeRelationshipMatch normally requires real sender evidence for.
    const legitimateNonQuotedBasis = document.exactSenderMatch === true
      || document.exactSenderHashMatch === true
      || document.exactLink === true
      || Boolean(senderEmail && (sourceRecipient === senderEmail || sourceHash === senderHash));
    evidence.push({
      candidateRef: document.path,
      programId,
      // Preserve the claimed campaign even when its document is missing. The
      // materializer then treats an absent/mismatched campaignProgramId as an
      // ownership conflict and fails closed to Direct review. Dropping the id
      // here produced a Program-only exact result that later crashed the
      // campaign-scoped feedback gate instead of ingesting the reply safely.
      ...(target.campaignId ? { campaignId: target.campaignId, campaignProgramId } : {}),
      programVerified: Boolean(program),
      evidenceOwnerUid: sourceOwner.ownerUid,
      programOwnerUid: programOwner.ownerUid,
      campaignOwnerUid: campaignOwner.ownerUid,
      ownershipConflict: sourceOwner.conflict || programOwner.conflict || campaignOwner.conflict,
      subject: asString(document.data.subject),
      observedAtIso: evidenceObservedAt(document.data),
      senderHashMatch: document.exactSenderMatch === true
        || Boolean(senderEmail && (sourceRecipient === senderEmail || sourceHash === senderHash)),
      recipientHashMatch: document.exactSenderHashMatch === true
        || Boolean(senderHash && sourceHash === senderHash),
      quotedOriginalRecipientMatch,
      creatorHistoryMatch: [
        "creator_links",
        "program_sheet_leads",
        "program_applications",
      ].includes(document.collection) || Boolean(asString(document.data.creatorId)),
      outreachHistoryMatch: [
        "message_sources",
        "campaign_outreach",
        "scp_coldmail_history",
        "mail_outbound_log",
      ].includes(document.collection),
      linkMatch: attributionContextMatch(inboundText, [
        document.data.programTitle,
        document.data.campaignTitle,
        campaign?.name,
        campaign?.title,
        program?.title,
      ]),
      exactLink: document.exactLink === true,
      authoritativeRelationshipMatch: (
        (legitimateNonQuotedBasis || quotedOriginalRecipientMatch) && isAuthoritativeSentOutreach(document)
      ) || isAuthoritativeWorkflowRelationship(document),
      creatorIdentityKey: attributionCreatorIdentity(document.data, senderHash),
    });
  }

  const explicitProgramId = verifiedExplicitProgramId;
  if (explicitProgramId) {
    const program = programs.get(explicitProgramId);
    const campaignId = verifiedExplicitCampaignId;
    const campaign = campaigns.get(campaignId);
    const programOwner = attributionOwner(program ?? {});
    const campaignOwner = attributionOwner(campaign ?? {});
    evidence.push({
      candidateRef: explicitContextSourceRef,
      programId: explicitProgramId,
      ...(campaignId ? { campaignId, campaignProgramId: resolveCanonicalProgramId(campaign?.programId) } : {}),
      programVerified: Boolean(program),
      programOwnerUid: programOwner.ownerUid,
      campaignOwnerUid: campaignOwner.ownerUid,
      ownershipConflict: programOwner.conflict || campaignOwner.conflict,
      explicitContextMatch: true,
      verifiedWorkflowContext: true,
      creatorIdentityKey: "identity:unknown",
    });
  }

  return materializeInboundAttributionEvidence({
    evidence,
    inboundSubject: input.inboundSubject,
    receivedAtIso: input.receivedAtIso,
    matchedOutboundRef,
    matchBasis: input.matchBasis,
    explicitProgramId,
    explicitCampaignId: verifiedExplicitCampaignId,
    requesterUid: input.requesterUid,
    requesterRole: input.requesterRole,
    hardAmbiguity: input.hardAmbiguity,
  });
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode: "invalid_argument_unauthorized" });
}

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(`failed-precondition: ${message}`), { code: "failed-precondition", errorCode: "failed_precondition_unauthorized" });
}

function conversationRefFromId(value: unknown) {
  const id = asString(value);
  if (!id || id.includes("/") || id.length > 500) throw invalidArgument("conversationId is required");
  return adminDb.collection("conversations").doc(id);
}

function requiredReason(value: unknown): string {
  const reason = asString(value).replace(/\s+/g, " ").slice(0, 500);
  if (reason.length < 5) throw invalidArgument("a concrete reclassification reason is required");
  return reason;
}

function manualSnapshot(data: Record<string, unknown>, nowIso: string): ConversationAttributionSnapshot {
  const primaryBucket = data.primaryBucket === "program" ? "program" : data.primaryBucket === "direct" ? "direct" : "";
  if (!primaryBucket) throw invalidArgument("primaryBucket must be program or direct");
  const programId = primaryBucket === "program" ? resolveCanonicalProgramId(data.programId) : "";
  if (primaryBucket === "program" && !programId) throw invalidArgument("programId is required for program attribution");
  return {
    primaryBucket,
    ...(programId ? { programId } : {}),
    ...(programId && asString(data.campaignId) ? { campaignId: asString(data.campaignId) } : {}),
    confidence: 1,
    source: "manual",
    reasonId: primaryBucket === "program" ? "operator_reclassified_program" : "operator_reclassified_direct",
    decidedAtIso: nowIso,
  };
}

export function topLevelAttributionPatch(final: ConversationAttributionSnapshot): Record<string, unknown> {
  if (final.primaryBucket === "program" && final.programId) {
    const programId = resolveCanonicalProgramId(final.programId);
    return {
      programId,
      canonicalProgramId: programId,
      // Titles from the previous attribution are denormalized display data. Clear them
      // when the authoritative ids change so the client resolves fresh registry labels.
      programTitle: FieldValue.delete(),
      campaignId: final.campaignId || FieldValue.delete(),
      campaignTitle: FieldValue.delete(),
      type: final.campaignId ? "campaign" : "program",
    };
  }
  return {
    programId: FieldValue.delete(),
    canonicalProgramId: FieldValue.delete(),
    programTitle: FieldValue.delete(),
    campaignId: FieldValue.delete(),
    campaignTitle: FieldValue.delete(),
    type: "direct",
  };
}

function automaticAuditId(conversationId: string, messageRef: string): string {
  return `auto_${createHash("sha256")
    .update(`${conversationId}|${safeEvidenceRef(messageRef)}`)
    .digest("hex")
    .slice(0, 40)}`;
}

function privateAuditEvidenceRef(value: unknown): string {
  return `evidence_hash/${createHash("sha256").update(asString(value)).digest("hex").slice(0, 32)}`;
}

export function attributionReviewId(conversationId: string): string {
  return `conversation_attribution_${createHash("sha256").update(conversationId).digest("hex").slice(0, 32)}`;
}

function mutationActor(auth: { userId: string; role: string }) {
  return { uid: auth.userId, role: auth.role };
}

function assertManualAttributionOwnership(input: {
  auth: { userId: string; role: string };
  conversation: Record<string, unknown>;
  final: ConversationAttributionSnapshot;
  program?: Record<string, unknown>;
  campaign?: Record<string, unknown>;
}): void {
  const actor = mutationActor(input.auth);
  assertMutationOwner(
    actor,
    mutationOwnerUids(input.conversation, { includeCreatedBy: true }),
    "conversation attribution",
  );
  if (input.final.primaryBucket !== "program") return;
  const program = input.program ?? {};
  const campaign = input.campaign ?? {};
  const programOwnership = attributionOwner(program);
  const campaignOwnership = attributionOwner(campaign);
  if (programOwnership.conflict || campaignOwnership.conflict) {
    throw failedPrecondition("program or campaign ownership is ambiguous");
  }
  if (
    programOwnership.ownerUid &&
    campaignOwnership.ownerUid &&
    programOwnership.ownerUid !== campaignOwnership.ownerUid
  ) {
    throw failedPrecondition("campaign ownership does not match the selected program");
  }
  assertMutationOwner(
    actor,
    mutationOwnerUids(program, { includeCreatedBy: true }),
    "selected program",
  );
  const campaignOwners = mutationOwnerUids(campaign, { includeCreatedBy: true });
  if (input.final.campaignId && campaignOwners.length > 0) {
    assertMutationOwner(actor, campaignOwners, "selected campaign");
  }
}

function existingAttributionState(
  conversation: Record<string, unknown>,
): ConversationAttributionState | null {
  const existing = asRecord(conversation.attribution);
  if (
    existing.policyVersion !== CONVERSATION_ATTRIBUTION_POLICY_VERSION ||
    !Number.isInteger(Number(existing.version)) ||
    Number(existing.version) < 1
  ) return null;
  const fallback = originalSnapshot(conversation);
  return {
    policyVersion: CONVERSATION_ATTRIBUTION_POLICY_VERSION,
    attributionStatus: recordedAttributionStatus(cleanSnapshot(existing.final, fallback)),
    version: Number(existing.version),
    reviewRequired: existing.reviewRequired === true,
    original: cleanSnapshot(existing.original, fallback),
    suggested: cleanSnapshot(existing.suggested, fallback),
    final: cleanSnapshot(existing.final, fallback),
    rankedCandidates: Array.isArray(existing.rankedCandidates)
      ? existing.rankedCandidates as RankedAttributionCandidate[]
      : [],
    updatedAtIso: asString(existing.updatedAtIso),
  };
}

/**
 * Hash-only CAS fence for automatic reconciliation. It deliberately covers
 * routing, the latest inbound evidence pointer, and the complete attribution
 * decision without exposing any of those identifiers to callers or audits.
 */
export function conversationAutomaticAttributionFence(
  conversation: Record<string, unknown>,
): string {
  const attribution = asRecord(conversation.attribution);
  const latestEvidenceHash = createHash("sha256")
    .update(asString(conversation.lastMessageRef))
    .digest("hex")
    .slice(0, 32);
  return createHash("sha256").update(JSON.stringify({
    type: asString(conversation.type),
    programId: resolveCanonicalProgramId(conversation.programId ?? conversation.canonicalProgramId),
    campaignId: asString(conversation.campaignId),
    attributionReviewRequired: conversation.attributionReviewRequired === true,
    attributionStatus: asString(conversation.attributionStatus),
    lastMessageAtIso: asString(conversation.lastMessageAtIso),
    latestEvidenceHash,
    attribution: {
      policyVersion: asString(attribution.policyVersion),
      attributionStatus: asString(attribution.attributionStatus),
      version: Math.max(0, Number(attribution.version) || 0),
      reviewRequired: attribution.reviewRequired === true,
      original: attribution.original ?? null,
      suggested: attribution.suggested ?? null,
      final: attribution.final ?? null,
      rankedCandidates: attribution.rankedCandidates ?? [],
      updatedAtIso: asString(attribution.updatedAtIso),
    },
  })).digest("hex");
}

function automaticAttributionVersion(conversation: Record<string, unknown>): number {
  return Math.max(0, Number(asRecord(conversation.attribution).version) || 0);
}

function assertAutomaticAttributionFence(input: {
  conversation: Record<string, unknown>;
  expectedAttributionVersion?: number;
  expectedStateFingerprint?: string;
}): void {
  const final = asRecord(asRecord(input.conversation.attribution).final);
  if (final.source === "manual" || final.source === "revert") {
    throw Object.assign(new Error("aborted: manual_final_preserved"), { code: "aborted", errorCode: "assert_automatic_attribution_fence_manual_final_preserved" });
  }
  if (
    input.expectedAttributionVersion != null &&
    automaticAttributionVersion(input.conversation) !== input.expectedAttributionVersion
  ) {
    throw Object.assign(new Error("aborted: automatic_attribution_version_stale"), { code: "aborted", errorCode: "assert_automatic_attribution_fence_automatic_attribution_version_stale" });
  }
  if (
    input.expectedStateFingerprint &&
    conversationAutomaticAttributionFence(input.conversation) !== input.expectedStateFingerprint
  ) {
    throw Object.assign(new Error("aborted: automatic_attribution_state_stale"), { code: "aborted", errorCode: "assert_automatic_attribution_fence_automatic_attribution_state_stale" });
  }
}

export async function materializeAutomaticConversationAttribution(input: {
  conversationId: string;
  messageRef: string;
  resolution: ConversationAttributionResolution;
  rejectedCandidateRefs?: string[];
  decidedAtIso?: string;
  actorUid?: string;
  actorRole?: string;
  ownerUid?: string;
  expectedAttributionVersion?: number;
  expectedStateFingerprint?: string;
  auditPrivacy?: "hashed_identifiers";
  recipientInboundLock?: {
    recipientHash: string;
    lastReplyAtIso: string;
    matchBasis: string;
    ambiguous: boolean;
    candidateSourceRefs?: string[];
  };
}): Promise<{ attribution: ConversationAttributionState; auditRef: string; idempotentReplay: boolean }> {
  const conversationRef = conversationRefFromId(input.conversationId);
  const messageRef = safeEvidenceRef(input.messageRef);
  const auditRef = adminDb.collection(AUDIT_COLLECTION).doc(automaticAuditId(conversationRef.id, messageRef));
  const reviewRef = adminDb.collection("reviews").doc(attributionReviewId(conversationRef.id));
  const decidedAtIso = asString(input.decidedAtIso, new Date().toISOString());
  return adminDb.runTransaction(async (transaction) => {
    const [conversationSnapshot, auditSnapshot, reviewSnapshot] = await Promise.all([
      transaction.get(conversationRef),
      transaction.get(auditRef),
      transaction.get(reviewRef),
    ]);
    const conversation = conversationSnapshot.data() ?? {};
    const current = existingAttributionState(conversation);
    const recipientHash = asString(input.recipientInboundLock?.recipientHash).toLowerCase();
    const writeRecipientInboundLock = () => {
      if (!/^[a-f0-9]{24}$/.test(recipientHash) || !input.recipientInboundLock) return;
      const lockRef = adminDb.collection("mail_recipient_inbound_locks").doc(recipientHash);
      const lastReplyAtIso = asString(input.recipientInboundLock.lastReplyAtIso, decidedAtIso);
      transaction.set(lockRef, {
        id: lockRef.id,
        schemaVersion: "mail-recipient-inbound-lock-v1",
        recipientHash,
        hasReply: true,
        lastReplyAtIso,
        lastInboundMessageRefHash: createHash("sha256")
          .update(messageRef)
          .digest("hex")
          .slice(0, 32),
        conversationHash: createHash("sha256")
          .update(conversationRef.id)
          .digest("hex")
          .slice(0, 32),
        matchBasis: asString(input.recipientInboundLock.matchBasis, "headerless"),
        ambiguous: input.recipientInboundLock.ambiguous === true,
        updatedAtIso: lastReplyAtIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      const candidateSourceRefs = Array.from(new Set(
        (input.recipientInboundLock.candidateSourceRefs ?? [])
          .map(validMessageSourceRef)
          .filter(Boolean),
      )).sort().slice(0, 100);
      for (const candidateRef of candidateSourceRefs) {
        transaction.set(adminDb.doc(candidateRef), {
          hasReply: true,
          lastReplyAtIso,
          recipientInboundLockRef: lockRef.path,
          recipientInboundLockHash: recipientHash,
        }, { merge: true });
      }
    };
    if (auditSnapshot.exists && current) {
      writeRecipientInboundLock();
      transaction.set(conversationRef, {
        attribution: { attributionStatus: current.attributionStatus },
        attributionStatus: current.attributionStatus,
        attributionReviewRequired: current.reviewRequired,
        attributionUpdatedAtIso: current.updatedAtIso || decidedAtIso,
        lastAutomaticAttributionAuditRef: auditRef.path,
        ...topLevelAttributionPatch(current.final),
      }, { merge: true });
      if (!current.reviewRequired && reviewSnapshot.exists) {
        transaction.set(reviewRef, {
          status: "resolved",
          resolvedAtIso: decidedAtIso,
          updatedAtIso: decidedAtIso,
        }, { merge: true });
      }
      return { attribution: current, auditRef: auditRef.path, idempotentReplay: true };
    }

    assertAutomaticAttributionFence({
      conversation,
      expectedAttributionVersion: input.expectedAttributionVersion,
      expectedStateFingerprint: input.expectedStateFingerprint,
    });

    const beforeFinal = current?.final ?? originalSnapshot(conversation);
    const attribution = mergeAutomaticConversationAttribution(
      conversation,
      input.resolution,
      decidedAtIso,
    );
    writeRecipientInboundLock();
    transaction.set(conversationRef, {
      attribution,
      attributionStatus: attribution.attributionStatus,
      attributionReviewRequired: attribution.reviewRequired,
      attributionUpdatedAtIso: decidedAtIso,
      lastAutomaticAttributionAuditRef: auditRef.path,
      ...topLevelAttributionPatch(attribution.final),
    }, { merge: true });
    const candidateRefs = Array.from(new Set(input.resolution.rankedCandidates
      .flatMap((candidate) => candidate.evidenceRefs?.length ? candidate.evidenceRefs : [candidate.candidateRef])
      .map(safeEvidenceRef)
      .filter(Boolean))).sort();
    if (attribution.reviewRequired) {
      transaction.set(reviewRef, {
        id: reviewRef.id,
        source: "conversation_attribution",
        status: "pending",
        title: "대화 프로그램 귀속 확인",
        deliverable: "Direct 대화의 프로그램 귀속 후보를 확인하세요.",
        reason: attribution.suggested.reasonId,
        reasonCode: attribution.suggested.reasonId,
        conversationId: conversationRef.id,
        conversationRef: conversationRef.path,
        messageRef,
        suggested: attribution.suggested,
        final: attribution.final,
        confidence: attribution.suggested.confidence,
        candidateRefs,
        rejectedCandidateRefs: Array.from(new Set((input.rejectedCandidateRefs ?? [])
          .map(safeEvidenceRef)
          .filter(Boolean))).sort(),
        checks: [
          { label: "프로그램·캠페인 소유권 확인", ok: false },
          { label: "과거 발송·회신 증거 확인", ok: false },
          { label: "Program 또는 Direct 최종 귀속 확정", ok: false },
        ],
        guidance: {
          why: "자동 귀속 신뢰도가 확정 기준보다 낮거나 후보가 충돌합니다.",
          recommendedAction: "증거 링크를 확인한 뒤 대화 귀속 편집에서 최종 분류하세요.",
        },
        ...(safeOwnerUid(input.ownerUid ?? conversation.ownerUid) ? { ownerUid: safeOwnerUid(input.ownerUid ?? conversation.ownerUid) } : {}),
        createdAtIso: asString(reviewSnapshot.get("createdAtIso"), decidedAtIso),
        updatedAtIso: decidedAtIso,
      }, { merge: true });
    } else if (reviewSnapshot.exists) {
      transaction.set(reviewRef, {
        status: "resolved",
        resolvedAtIso: decidedAtIso,
        updatedAtIso: decidedAtIso,
      }, { merge: true });
    }
    if (!auditSnapshot.exists) {
      const hashedAuditIdentifiers = input.auditPrivacy === "hashed_identifiers";
      const auditCandidateRefs = hashedAuditIdentifiers
        ? candidateRefs.map(privateAuditEvidenceRef)
        : candidateRefs;
      const auditRejectedCandidateRefs = Array.from(new Set((input.rejectedCandidateRefs ?? [])
        .map(safeEvidenceRef)
        .filter(Boolean)))
        .sort()
        .map((ref) => hashedAuditIdentifiers ? privateAuditEvidenceRef(ref) : ref);
      const auditRankedCandidates = hashedAuditIdentifiers
        ? attribution.rankedCandidates.map((candidate) => ({
            ...candidate,
            candidateRef: privateAuditEvidenceRef(candidate.candidateRef),
            evidenceRefs: candidate.evidenceRefs.map(privateAuditEvidenceRef),
          }))
        : attribution.rankedCandidates;
      transaction.create(auditRef, {
        id: auditRef.id,
        action: "automatic_materialize",
        policyVersion: CONVERSATION_ATTRIBUTION_POLICY_VERSION,
        ...(hashedAuditIdentifiers
          ? {
              conversationHash: createHash("sha256").update(conversationRef.id).digest("hex").slice(0, 32),
              messageRefHash: createHash("sha256").update(messageRef).digest("hex").slice(0, 32),
            }
          : {
              conversationId: conversationRef.id,
              conversationRef: conversationRef.path,
              messageRef,
            }),
        versionBefore: current?.version ?? 0,
        versionAfter: attribution.version,
        beforeFinal,
        afterFinal: attribution.final,
        original: attribution.original,
        suggested: attribution.suggested,
        reasonId: input.resolution.reasonId,
        reviewRequired: attribution.reviewRequired,
        candidateRefs: auditCandidateRefs,
        rejectedCandidateRefs: auditRejectedCandidateRefs,
        rankedCandidates: auditRankedCandidates,
        actor: {
          role: asString(input.actorRole, "system"),
          uidHash: asString(input.actorUid)
            ? createHash("sha256").update(asString(input.actorUid)).digest("hex").slice(0, 24)
            : "",
        },
        createdAtIso: decidedAtIso,
        createdAt: FieldValue.serverTimestamp(),
        expireAt: expireAt180DaysFromIso(decidedAtIso),
      });
    }
    return { attribution, auditRef: auditRef.path, idempotentReplay: false };
  });
}

function expectedVersion(data: Record<string, unknown>, actual: number): void {
  if (data.expectedVersion == null) return;
  const expected = Number(data.expectedVersion);
  if (!Number.isInteger(expected) || expected !== actual) {
    throw failedPrecondition(`attribution version changed (expected ${expected}, actual ${actual})`);
  }
}

type ManualProjectionFingerprint = {
  ref: string;
  exists: boolean;
  fingerprint: string;
};

type ManualReclassificationPlan = {
  actionId: string;
  actorUid: string;
  actorRole: string;
  conversationId: string;
  expectedVersion: number;
  reason: string;
  final: ConversationAttributionSnapshot;
  conversationFingerprint: string;
  sourceFingerprints: ManualProjectionFingerprint[];
  ledgerFingerprints: ManualProjectionFingerprint[];
  ambiguityTargetKeys: string[];
  createdAtIso: string;
  expiresAtIso: string;
};

type ManualReclassificationEnvelope = {
  ok: true;
  dryRun: boolean;
  actionId: string;
  conversationId: string;
  version: number;
  auditRef?: string;
  previewToken?: string;
  previewHash?: string;
  projectedMessageSourceCount: number;
  projectedOutboundLedgerCount: number;
  ambiguityDetected: boolean;
  ambiguityTargetKeys: string[];
  humanConfirmationRequired: boolean;
  idempotentReplay: boolean;
  readbackVerified: boolean;
  mailSent: false;
};

function manualActionId(value: unknown): string {
  const actionId = asString(value).trim();
  if (!/^[A-Za-z0-9_.:-]{16,120}$/.test(actionId)) {
    throw invalidArgument("actionId is required");
  }
  return actionId;
}

function manualPreviewToken(value: unknown): string {
  const token = asString(value).trim();
  if (!/^[A-Za-z0-9._-]{32,200}$/.test(token)) {
    throw invalidArgument("previewToken is required");
  }
  return token;
}

function manualPreviewHash(value: unknown): string {
  const hash = asString(value).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw invalidArgument("previewHash is required");
  return hash;
}

function manualCapabilityToken(): string {
  return `${randomUUID()}.${randomBytes(24).toString("base64url")}`;
}

function manualHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validOutboundLedgerRef(value: unknown): string {
  const ref = asString(value);
  return /^mail_outbound_log\/[A-Za-z0-9_.:-]+$/.test(ref) ? ref : "";
}

function manualEvidenceRefs(
  conversation: Record<string, unknown>,
  final: ConversationAttributionSnapshot,
): string[] {
  const attribution = asRecord(conversation.attribution);
  const rankedCandidates = Array.isArray(attribution.rankedCandidates)
    ? attribution.rankedCandidates.map(asRecord)
    : [];
  const refs: unknown[] = [
    conversation.lastMessageRef,
    conversation.messageRef,
  ];
  if (final.primaryBucket === "program") {
    const finalProgramId = resolveCanonicalProgramId(final.programId);
    const finalCampaignId = asString(final.campaignId);
    const selectedCandidates = rankedCandidates.filter((candidate) => {
      if (resolveCanonicalProgramId(candidate.programId) !== finalProgramId) return false;
      return !finalCampaignId || asString(candidate.campaignId) === finalCampaignId;
    });
    const selectedIdentities = Array.from(new Set(
      selectedCandidates.map((candidate) => safeCreatorIdentityKey(candidate.creatorIdentityKey)),
    ));
    if (selectedIdentities.length === 1) {
      refs.push(...selectedCandidates.flatMap((candidate) => [
        candidate.candidateRef,
        ...(Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs : []),
      ]));
    }
    const matchBasis = asString(conversation.matchedOutboundMatchBasis);
    if (matchBasis === "reply_header" || matchBasis === "tracking_id") {
      refs.push(conversation.matchedOutboundRef);
    }
  }
  const normalizedRefs = refs.map(validMessageSourceRef).filter(Boolean);
  return Array.from(new Set(normalizedRefs)).sort().slice(0, MANUAL_RECLASSIFICATION_MAX_EVIDENCE_REFS);
}

function manualProjectionFence(record: Record<string, unknown>): string {
  const attribution = asRecord(record.attribution);
  const rankedCandidates = Array.isArray(attribution.rankedCandidates)
    ? attribution.rankedCandidates.map(asRecord).map((candidate) => ({
        candidateRef: safeEvidenceRef(candidate.candidateRef),
        evidenceRefs: Array.isArray(candidate.evidenceRefs)
          ? candidate.evidenceRefs.map(safeEvidenceRef).filter(Boolean).sort()
          : [],
        programId: resolveCanonicalProgramId(candidate.programId),
        campaignId: asString(candidate.campaignId),
        creatorIdentityKey: safeCreatorIdentityKey(candidate.creatorIdentityKey),
      }))
    : [];
  return manualHash({
    ownerUids: mutationOwnerUids(record, { includeCreatedBy: true }).sort(),
    direction: asString(record.direction),
    conversationId: asString(record.conversationId),
    conversationRef: asString(record.conversationRef),
    messageRef: validMessageSourceRef(record.messageRef),
    lastMessageRef: validMessageSourceRef(record.lastMessageRef),
    matchedOutboundRef: validMessageSourceRef(record.matchedOutboundRef),
    matchedOutboundMatchBasis: asString(record.matchedOutboundMatchBasis),
    trackingId: asString(record.trackingId),
    programId: resolveCanonicalProgramId(record.programId ?? record.canonicalProgramId),
    campaignId: asString(record.campaignId),
    creatorIdentityKey: attributionCreatorIdentity(record, asString(record.toHash, asString(record.fromHash))),
    inboundAttributionCandidateRefs: Array.isArray(record.inboundAttributionCandidateRefs)
      ? record.inboundAttributionCandidateRefs.map(safeEvidenceRef).filter(Boolean).sort()
      : [],
    attribution: {
      policyVersion: asString(attribution.policyVersion),
      version: Math.max(0, Number(attribution.version) || 0),
      final: attribution.final ?? null,
      rankedCandidates,
      updatedAtIso: asString(attribution.updatedAtIso),
    },
  });
}

function manualConversationFence(conversation: Record<string, unknown>): string {
  return manualHash({
    automaticFence: conversationAutomaticAttributionFence(conversation),
    projectionFence: manualProjectionFence(conversation),
  });
}

function manualSnapshotFingerprint(snapshot: DocumentSnapshot): ManualProjectionFingerprint {
  return {
    ref: snapshot.ref.path,
    exists: snapshot.exists,
    fingerprint: snapshot.exists
      ? manualProjectionFence(snapshot.data() ?? {})
      : manualHash({ missing: true, ref: snapshot.ref.path }),
  };
}

function manualAttributionTargetKey(
  programId: unknown,
  campaignId: unknown,
  creatorIdentityKey: unknown,
): string {
  return [
    resolveCanonicalProgramId(programId),
    asString(campaignId),
    safeCreatorIdentityKey(creatorIdentityKey),
  ].join("|");
}

function manualAmbiguityTargetKeys(
  conversation: Record<string, unknown>,
  sourceSnapshots: DocumentSnapshot[],
): string[] {
  const attribution = asRecord(conversation.attribution);
  const keys = (Array.isArray(attribution.rankedCandidates) ? attribution.rankedCandidates : [])
    .map(asRecord)
    .map((candidate) => manualAttributionTargetKey(
      candidate.programId,
      candidate.campaignId,
      candidate.creatorIdentityKey,
    ));
  for (const snapshot of sourceSnapshots) {
    if (!snapshot.exists) continue;
    const source = snapshot.data() ?? {};
    const target = conversationAttributionTarget(source);
    if (!target.programId || target.manualDirect) continue;
    keys.push(manualAttributionTargetKey(
      target.programId,
      target.campaignId,
      attributionCreatorIdentity(source, asString(source.toHash, asString(source.fromHash))),
    ));
  }
  return Array.from(new Set(keys.filter((key) => !key.startsWith("||")))).sort();
}

async function manualProjectionSnapshots(
  conversation: Record<string, unknown>,
  final: ConversationAttributionSnapshot,
): Promise<{ sourceSnapshots: DocumentSnapshot[]; ledgerSnapshots: DocumentSnapshot[] }> {
  const initialRefs = manualEvidenceRefs(conversation, final);
  const initialSnapshots = initialRefs.length > 0
    ? await adminDb.getAll(...initialRefs.map((ref) => adminDb.doc(ref)))
    : [];
  const linkedRefs = final.primaryBucket === "program"
    ? initialSnapshots
        .filter((snapshot) => snapshot.exists)
        .map((snapshot) => validMessageSourceRef(snapshot.get("matchedOutboundRef")))
        .filter(Boolean)
    : [];
  const allSourceRefs = Array.from(new Set([...initialRefs, ...linkedRefs]))
    .sort()
    .slice(0, MANUAL_RECLASSIFICATION_MAX_EVIDENCE_REFS);
  const sourceSnapshots = allSourceRefs.length > 0
    ? await adminDb.getAll(...allSourceRefs.map((ref) => adminDb.doc(ref)))
    : [];

  const ledgerRefs = new Set<string>();
  const addTrackingLedger = (value: unknown) => {
    const trackingId = asString(value);
    if (trackingId && !trackingId.includes("/") && trackingId.length <= 500) {
      ledgerRefs.add(`mail_outbound_log/${trackingId}`);
    }
  };
  if (final.primaryBucket === "program") addTrackingLedger(conversation.trackingId);
  for (const snapshot of sourceSnapshots) {
    if (!snapshot.exists) continue;
    addTrackingLedger(snapshot.get("trackingId"));
    for (const field of ["mailOutboundLogRef", "outboundLogRef", "ledgerRef", "sourceRef"]) {
      const ref = validOutboundLedgerRef(snapshot.get(field));
      if (ref) ledgerRefs.add(ref);
    }
  }
  const orderedLedgerRefs = Array.from(ledgerRefs).sort();
  if (orderedLedgerRefs.length > 400) {
    throw failedPrecondition("too many outbound ledger rows for one atomic reclassification");
  }
  const ledgerSnapshots = orderedLedgerRefs.length > 0
    ? await adminDb.getAll(...orderedLedgerRefs.map((ref) => adminDb.doc(ref)))
    : [];
  return { sourceSnapshots, ledgerSnapshots };
}

function manualPlanHash(plan: ManualReclassificationPlan): string {
  return manualHash({
    actionId: plan.actionId,
    actorUidHash: createHash("sha256").update(plan.actorUid).digest("hex"),
    actorRole: plan.actorRole,
    conversationId: plan.conversationId,
    expectedVersion: plan.expectedVersion,
    reasonHash: createHash("sha256").update(plan.reason).digest("hex"),
    final: plan.final,
    conversationFingerprint: plan.conversationFingerprint,
    sourceFingerprints: plan.sourceFingerprints,
    ledgerFingerprints: plan.ledgerFingerprints,
    ambiguityTargetKeys: plan.ambiguityTargetKeys,
    createdAtIso: plan.createdAtIso,
    expiresAtIso: plan.expiresAtIso,
  });
}

function manualEvidenceProjectionPatch(input: {
  final: ConversationAttributionSnapshot;
  conversationId: string;
  actionRef?: string;
  auditRef: string;
  nowIso: string;
  source: "manual" | "revert";
}): Record<string, unknown> {
  const programId = input.final.primaryBucket === "program"
    ? resolveCanonicalProgramId(input.final.programId)
    : "";
  const campaignId = programId ? asString(input.final.campaignId) : "";
  return {
    programId: programId || FieldValue.delete(),
    canonicalProgramId: programId || FieldValue.delete(),
    campaignId: campaignId || FieldValue.delete(),
    programTitle: FieldValue.delete(),
    campaignTitle: FieldValue.delete(),
    conversationAttributionProjection: {
      policyVersion: CONVERSATION_ATTRIBUTION_POLICY_VERSION,
      conversationId: input.conversationId,
      primaryBucket: input.final.primaryBucket,
      ...(programId ? { programId } : {}),
      ...(campaignId ? { campaignId } : {}),
      source: input.source,
      ...(input.actionRef ? { actionRef: input.actionRef } : {}),
      auditRef: input.auditRef,
      updatedAtIso: input.nowIso,
    },
    attributionUpdatedAtIso: input.nowIso,
  };
}

function manualProjectionMatches(
  record: Record<string, unknown>,
  final: ConversationAttributionSnapshot,
  requireConversationType: boolean,
): boolean {
  const programId = final.primaryBucket === "program"
    ? resolveCanonicalProgramId(final.programId)
    : "";
  const campaignId = programId ? asString(final.campaignId) : "";
  if (resolveCanonicalProgramId(record.programId ?? record.canonicalProgramId) !== programId) return false;
  if (asString(record.campaignId) !== campaignId) return false;
  if (requireConversationType) {
    const expectedType = programId ? (campaignId ? "campaign" : "program") : "direct";
    if (asString(record.type) !== expectedType) return false;
  }
  return true;
}

export async function reclassifyConversationAttribution(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "conversation_attribution.reclassify", WRITE_ROLES);
  const data = asRecord(request.data);
  const dryRun = data.dryRun !== false;
  const actionId = manualActionId(data.actionId);
  const conversationRef = conversationRefFromId(data.conversationId);
  const reason = requiredReason(data.reason);
  const nowIso = new Date().toISOString();
  const requestedFinal = manualSnapshot(data, nowIso);
  const campaignId = asString(requestedFinal.campaignId);
  if (campaignId.includes("/") || campaignId.length > 500) throw invalidArgument("campaignId is invalid");
  const programId = resolveCanonicalProgramId(requestedFinal.programId);
  const programRef = programId ? adminDb.collection("programs").doc(programId) : null;
  const campaignRef = campaignId ? adminDb.collection("campaigns").doc(campaignId) : null;
  // Flu conversation org-filter round 14 (codex adversarial review round 14, final sweep): this
  // callable mutates conversations/{caller-supplied conversationId} directly
  // (transaction.set(conversationRef, ...) below) but was gated only by assertManualAttributionOwnership
  // — a generic cross-resource ownership check (functions/mutationAuthorization.ts) that returns
  // immediately for role "admin" (and "super_admin") with NO org/mailbox check at all, and for
  // "manager" only checks conversation.ownerUid/programOwnerUid/createdBy, neither of which an scp@
  // mail conversation (system-created, no personal owner) ever carries. An admin caller could
  // reclassify/revert another org's scp@ conversation's program/campaign attribution with no scp
  // grant and no org match.
  //
  // Uses canReadScpConversationRowForOrg — which requires BOTH the positive scp grant
  // (hasScpEntitlement) AND an org match for a row it actually narrows (2026-09-28 owner scope
  // decision, codex adversarial review round 2 finding #1: org match alone let any org member
  // without an scp grant read/act on the org's own scp conversations) — not the full
  // mailbox-entitlement predicate (canReadConversationRowForScope) markConversationRead etc. use —
  // this callable reclassifies attribution for EVERY conversation type (program/campaign/direct),
  // most of which legitimately have no mailAccountId at all and are authorized purely by ownership
  // (assertManualAttributionOwnership below), matching tests/conversation-attribution-contract.test.mjs's
  // program-conversation-by-ownerUid case. canReadScpConversationRowForOrg passes any non-explicit-
  // scp row through unconditionally (same documented carve-out as dashboardPipelineProjection/
  // managementProfileTabsPorts) and only narrows (by scp grant + org) an EXPLICITLY
  // mailAccountId:"scp"-stamped row — exactly the case this finding is about. Resolved once per
  // request (not per conversation fetch) and applied to every existing target this callable
  // reads/writes.
  const accessScope = await resolveConversationMailAccessScope(auth);
  const validateRegistryAndOwnership = (
    conversation: Record<string, unknown>,
    programSnapshot: DocumentSnapshot | null,
    campaignSnapshot: DocumentSnapshot | null,
    final: ConversationAttributionSnapshot,
  ) => {
    if (programRef && !programSnapshot?.exists) {
      throw Object.assign(new Error("not-found: program not found"), { code: "not-found", errorCode: "reclassify_conversation_attribution_program_found" });
    }
    if (campaignRef && !campaignSnapshot?.exists) {
      throw Object.assign(new Error("not-found: campaign not found"), { code: "not-found", errorCode: "reclassify_conversation_attribution_campaign_found" });
    }
    if (campaignSnapshot) {
      const campaignProgramId = resolveCanonicalProgramId(campaignSnapshot.get("programId"));
      if (!campaignProgramId || campaignProgramId !== final.programId) {
        throw failedPrecondition("campaign does not belong to the selected program");
      }
    }
    if (!canReadScpConversationRowForOrg({ id: conversationRef.id, ...conversation }, accessScope)) {
      throw Object.assign(new Error("permission-denied: conversation belongs to another mail account/org"), {
        code: "permission-denied",
        errorCode: "reclassify_conversation_attribution_conversation_scope_denied",
      });
    }
    assertManualAttributionOwnership({
      auth,
      conversation,
      final,
      ...(programSnapshot ? { program: programSnapshot.data() ?? {} } : {}),
      ...(campaignSnapshot ? { campaign: campaignSnapshot.data() ?? {} } : {}),
    });
  };

  if (dryRun) {
    const [snapshot, programSnapshot, campaignSnapshot] = await Promise.all([
      conversationRef.get(),
      programRef ? programRef.get() : Promise.resolve(null),
      campaignRef ? campaignRef.get() : Promise.resolve(null),
    ]);
    if (!snapshot.exists) throw Object.assign(new Error("not-found: conversation not found"), { code: "not-found", errorCode: "reclassify_conversation_attribution_conversation_found" });
    const conversation = snapshot.data() ?? {};
    validateRegistryAndOwnership(conversation, programSnapshot, campaignSnapshot, requestedFinal);
    const existing = asRecord(conversation.attribution);
    const currentVersion = Math.max(0, Number(existing.version) || 0);
    expectedVersion(data, currentVersion);
    const { sourceSnapshots, ledgerSnapshots } = await manualProjectionSnapshots(
      conversation,
      requestedFinal,
    );
    const ambiguityTargetKeys = manualAmbiguityTargetKeys(conversation, sourceSnapshots);
    const previewToken = manualCapabilityToken();
    const expiresAtIso = new Date(Date.now() + MANUAL_RECLASSIFICATION_PREVIEW_TTL_MS).toISOString();
    const plan: ManualReclassificationPlan = {
      actionId,
      actorUid: auth.userId,
      actorRole: auth.role,
      conversationId: conversationRef.id,
      expectedVersion: currentVersion,
      reason,
      final: requestedFinal,
      conversationFingerprint: manualConversationFence(conversation),
      sourceFingerprints: sourceSnapshots.map(manualSnapshotFingerprint).sort((left, right) => left.ref.localeCompare(right.ref)),
      ledgerFingerprints: ledgerSnapshots.map(manualSnapshotFingerprint).sort((left, right) => left.ref.localeCompare(right.ref)),
      ambiguityTargetKeys,
      createdAtIso: nowIso,
      expiresAtIso,
    };
    const previewHash = manualPlanHash(plan);
    const claimRef = adminDb.collection(MANUAL_RECLASSIFICATION_CLAIMS_COLLECTION)
      .doc(`claim-${createHash("sha256").update(previewToken).digest("hex")}`);
    await claimRef.create({
      schemaVersion: "conversation_attribution_manual_reclass_v2",
      status: "previewed",
      actorUid: auth.userId,
      actorRole: auth.role,
      actionId,
      conversationId: conversationRef.id,
      previewHash,
      plan,
      createdAtIso: nowIso,
      expiresAtIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    return {
      ok: true,
      dryRun: true,
      actionId,
      conversationId: conversationRef.id,
      version: currentVersion,
      previewToken,
      previewHash,
      projectedMessageSourceCount: plan.sourceFingerprints.filter((row) => row.exists).length,
      projectedOutboundLedgerCount: plan.ledgerFingerprints.filter((row) => row.exists).length,
      ambiguityDetected: ambiguityTargetKeys.length > 1,
      ambiguityTargetKeys,
      humanConfirmationRequired: true,
      idempotentReplay: false,
      readbackVerified: false,
      mailSent: false,
    } satisfies ManualReclassificationEnvelope;
  }

  if (data.actual !== true || data.confirm !== true) {
    throw failedPrecondition("apply requires dryRun:false, actual:true, and confirm:true");
  }
  const previewToken = manualPreviewToken(data.previewToken);
  const suppliedPreviewHash = manualPreviewHash(data.previewHash);
  const claimRef = adminDb.collection(MANUAL_RECLASSIFICATION_CLAIMS_COLLECTION)
    .doc(`claim-${createHash("sha256").update(previewToken).digest("hex")}`);
  const claimSnapshot = await claimRef.get();
  if (!claimSnapshot.exists) throw failedPrecondition("preview claim not found");
  const claim = claimSnapshot.data() ?? {};
  const storedPlan = asRecord(claim.plan);
  const storedFinal = cleanSnapshot(storedPlan.final, requestedFinal);
  const sourceFingerprints = Array.isArray(storedPlan.sourceFingerprints)
    ? storedPlan.sourceFingerprints.map(asRecord).map((row) => ({
        ref: validMessageSourceRef(row.ref),
        exists: row.exists === true,
        fingerprint: asString(row.fingerprint),
      })).filter((row) => row.ref && /^[a-f0-9]{64}$/.test(row.fingerprint))
    : [];
  const ledgerFingerprints = Array.isArray(storedPlan.ledgerFingerprints)
    ? storedPlan.ledgerFingerprints.map(asRecord).map((row) => ({
        ref: validOutboundLedgerRef(row.ref),
        exists: row.exists === true,
        fingerprint: asString(row.fingerprint),
      })).filter((row) => row.ref && /^[a-f0-9]{64}$/.test(row.fingerprint))
    : [];
  const plan: ManualReclassificationPlan = {
    actionId: asString(storedPlan.actionId),
    actorUid: asString(storedPlan.actorUid),
    actorRole: asString(storedPlan.actorRole),
    conversationId: asString(storedPlan.conversationId),
    expectedVersion: Math.max(0, Number(storedPlan.expectedVersion) || 0),
    reason: asString(storedPlan.reason),
    final: storedFinal,
    conversationFingerprint: asString(storedPlan.conversationFingerprint),
    sourceFingerprints,
    ledgerFingerprints,
    ambiguityTargetKeys: Array.isArray(storedPlan.ambiguityTargetKeys)
      ? storedPlan.ambiguityTargetKeys.map((value) => asString(value)).filter(Boolean).sort()
      : [],
    createdAtIso: asString(storedPlan.createdAtIso),
    expiresAtIso: asString(storedPlan.expiresAtIso),
  };
  const sameRequestedTarget = requestedFinal.primaryBucket === plan.final.primaryBucket
    && resolveCanonicalProgramId(requestedFinal.programId) === resolveCanonicalProgramId(plan.final.programId)
    && asString(requestedFinal.campaignId) === asString(plan.final.campaignId);
  if (
    claim.status !== "previewed" && claim.status !== "applied"
    || asString(claim.actorUid) !== auth.userId
    || asString(claim.actorRole) !== auth.role
    || asString(claim.actionId) !== actionId
    || plan.actionId !== actionId
    || plan.actorUid !== auth.userId
    || plan.actorRole !== auth.role
    || plan.conversationId !== conversationRef.id
    || plan.reason !== reason
    || !sameRequestedTarget
    || asString(claim.previewHash) !== suppliedPreviewHash
    || manualPlanHash(plan) !== suppliedPreviewHash
  ) {
    throw failedPrecondition("preview claim does not match this reclassification");
  }
  if (Date.parse(plan.expiresAtIso) <= Date.now()) throw failedPrecondition("preview claim expired");

  const actionHash = createHash("sha256").update(`${auth.userId}|${actionId}`).digest("hex");
  const actionRef = adminDb.collection(MANUAL_RECLASSIFICATION_ACTIONS_COLLECTION).doc(`action-${actionHash}`);
  const auditRef = adminDb.collection(AUDIT_COLLECTION).doc(`manual-${actionHash.slice(0, 40)}`);
  const reviewRef = adminDb.collection("reviews").doc(attributionReviewId(conversationRef.id));
  const sourceRefs = plan.sourceFingerprints.map((row) => adminDb.doc(row.ref));
  const ledgerRefs = plan.ledgerFingerprints.map((row) => adminDb.doc(row.ref));

  const result = await adminDb.runTransaction(async (transaction): Promise<ManualReclassificationEnvelope> => {
    const [transactionClaim, actionSnapshot] = await Promise.all([
      transaction.get(claimRef),
      transaction.get(actionRef),
    ]);
    if (!transactionClaim.exists || asString(transactionClaim.get("previewHash")) !== suppliedPreviewHash) {
      throw failedPrecondition("preview claim changed");
    }
    if (actionSnapshot.exists) {
      const receipt = asRecord(actionSnapshot.get("receipt"));
      if (asString(actionSnapshot.get("previewHash")) !== suppliedPreviewHash) {
        throw failedPrecondition("actionId was already used for another preview");
      }
      return {
        ok: true,
        dryRun: false,
        actionId,
        conversationId: conversationRef.id,
        version: Math.max(0, Number(receipt.version) || 0),
        auditRef: asString(receipt.auditRef, auditRef.path),
        projectedMessageSourceCount: plan.sourceFingerprints.filter((row) => row.exists).length,
        projectedOutboundLedgerCount: plan.ledgerFingerprints.filter((row) => row.exists).length,
        ambiguityDetected: plan.ambiguityTargetKeys.length > 1,
        ambiguityTargetKeys: plan.ambiguityTargetKeys,
        humanConfirmationRequired: true,
        idempotentReplay: true,
        readbackVerified: false,
        mailSent: false,
      };
    }

    const [snapshot, programSnapshot, campaignSnapshot, reviewSnapshot, sourceSnapshots, ledgerSnapshots] = await Promise.all([
      transaction.get(conversationRef),
      programRef ? transaction.get(programRef) : Promise.resolve(null),
      campaignRef ? transaction.get(campaignRef) : Promise.resolve(null),
      transaction.get(reviewRef),
      Promise.all(sourceRefs.map((ref) => transaction.get(ref))),
      Promise.all(ledgerRefs.map((ref) => transaction.get(ref))),
    ]);
    if (!snapshot.exists) throw Object.assign(new Error("not-found: conversation not found"), { code: "not-found", errorCode: "reclassify_conversation_attribution_conversation_found_2" });
    const conversation = snapshot.data() ?? {};
    validateRegistryAndOwnership(conversation, programSnapshot, campaignSnapshot, plan.final);
    const existing = asRecord(conversation.attribution);
    const currentVersion = Math.max(0, Number(existing.version) || 0);
    if (currentVersion !== plan.expectedVersion || manualConversationFence(conversation) !== plan.conversationFingerprint) {
      throw failedPrecondition("conversation changed after preview");
    }
    const assertFingerprints = (
      expected: ManualProjectionFingerprint[],
      actual: DocumentSnapshot[],
      label: string,
    ) => {
      if (expected.length !== actual.length) throw failedPrecondition(`${label} evidence changed after preview`);
      for (let index = 0; index < expected.length; index += 1) {
        const actualFingerprint = manualSnapshotFingerprint(actual[index]);
        if (
          expected[index].ref !== actualFingerprint.ref
          || expected[index].exists !== actualFingerprint.exists
          || expected[index].fingerprint !== actualFingerprint.fingerprint
        ) {
          throw failedPrecondition(`${label} evidence changed after preview`);
        }
      }
    };
    assertFingerprints(plan.sourceFingerprints, sourceSnapshots, "message source");
    assertFingerprints(plan.ledgerFingerprints, ledgerSnapshots, "outbound ledger");

    const appliedAtIso = new Date().toISOString();
    const beforeFinal = cleanSnapshot(existing.final, originalSnapshot(conversation));
    const final: ConversationAttributionSnapshot = { ...plan.final, decidedAtIso: appliedAtIso };
    const nextVersion = currentVersion + 1;
    const nextState: ConversationAttributionState = {
      policyVersion: CONVERSATION_ATTRIBUTION_POLICY_VERSION,
      attributionStatus: "manual_confirmed",
      version: nextVersion,
      reviewRequired: false,
      original: cleanSnapshot(existing.original, originalSnapshot(conversation)),
      suggested: cleanSnapshot(existing.suggested, beforeFinal),
      final,
      rankedCandidates: Array.isArray(existing.rankedCandidates)
        ? existing.rankedCandidates as RankedAttributionCandidate[]
        : [],
      updatedAtIso: appliedAtIso,
    };
    const projectionPatch = manualEvidenceProjectionPatch({
      final,
      conversationId: conversationRef.id,
      actionRef: actionRef.path,
      auditRef: auditRef.path,
      nowIso: appliedAtIso,
      source: "manual",
    });
    transaction.set(conversationRef, {
      attribution: nextState,
      attributionStatus: nextState.attributionStatus,
      attributionReviewRequired: false,
      attributionUpdatedAtIso: appliedAtIso,
      lastAttributionAuditRef: auditRef.path,
      lastAttributionActionRef: actionRef.path,
      ...topLevelAttributionPatch(final),
    }, { merge: true });
    for (const sourceSnapshot of sourceSnapshots) {
      if (sourceSnapshot.exists) transaction.set(sourceSnapshot.ref, projectionPatch, { merge: true });
    }
    for (const ledgerSnapshot of ledgerSnapshots) {
      if (ledgerSnapshot.exists) transaction.set(ledgerSnapshot.ref, projectionPatch, { merge: true });
    }
    transaction.create(auditRef, {
      id: auditRef.id,
      action: "reclassify",
      actionId,
      actionRef: actionRef.path,
      previewHash: suppliedPreviewHash,
      conversationId: conversationRef.id,
      conversationRef: conversationRef.path,
      versionBefore: currentVersion,
      versionAfter: nextVersion,
      beforeFinal,
      afterFinal: final,
      original: nextState.original,
      suggested: nextState.suggested,
      ambiguityDetected: plan.ambiguityTargetKeys.length > 1,
      ambiguityTargetKeys: plan.ambiguityTargetKeys,
      projectedMessageSourceRefs: plan.sourceFingerprints.filter((row) => row.exists).map((row) => row.ref),
      projectedOutboundLedgerRefs: plan.ledgerFingerprints.filter((row) => row.exists).map((row) => row.ref),
      reason,
      actor: { uid: auth.userId, role: auth.role, team: auth.team },
      mailSent: false,
      createdAtIso: appliedAtIso,
      createdAt: FieldValue.serverTimestamp(),
      expireAt: expireAt180DaysFromIso(appliedAtIso),
    });
    if (reviewSnapshot.exists) {
      transaction.set(reviewRef, {
        status: "resolved",
        resolution: final,
        resolutionAuditRef: auditRef.path,
        resolvedAtIso: appliedAtIso,
        updatedAtIso: appliedAtIso,
      }, { merge: true });
    }
    const receipt = {
      version: nextVersion,
      auditRef: auditRef.path,
      appliedAtIso,
      mailSent: false,
    };
    transaction.create(actionRef, {
      schemaVersion: "conversation_attribution_manual_reclass_v2",
      status: "applied",
      actionId,
      actorUid: auth.userId,
      actorRole: auth.role,
      conversationId: conversationRef.id,
      previewHash: suppliedPreviewHash,
      claimRef: claimRef.path,
      auditRef: auditRef.path,
      receipt,
      createdAtIso: appliedAtIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.set(claimRef, {
      status: "applied",
      actionRef: actionRef.path,
      auditRef: auditRef.path,
      appliedAtIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return {
      ok: true,
      dryRun: false,
      actionId,
      conversationId: conversationRef.id,
      version: nextVersion,
      auditRef: auditRef.path,
      projectedMessageSourceCount: plan.sourceFingerprints.filter((row) => row.exists).length,
      projectedOutboundLedgerCount: plan.ledgerFingerprints.filter((row) => row.exists).length,
      ambiguityDetected: plan.ambiguityTargetKeys.length > 1,
      ambiguityTargetKeys: plan.ambiguityTargetKeys,
      humanConfirmationRequired: true,
      idempotentReplay: false,
      readbackVerified: false,
      mailSent: false,
    };
  });

  const [conversationReadback, sourceReadbacks, ledgerReadbacks] = await Promise.all([
    conversationRef.get(),
    Promise.all(plan.sourceFingerprints.filter((row) => row.exists).map((row) => adminDb.doc(row.ref).get())),
    Promise.all(plan.ledgerFingerprints.filter((row) => row.exists).map((row) => adminDb.doc(row.ref).get())),
  ]);
  const readbackVerified = conversationReadback.exists
    && manualProjectionMatches(conversationReadback.data() ?? {}, plan.final, true)
    && sourceReadbacks.every((snapshot) => snapshot.exists && manualProjectionMatches(snapshot.data() ?? {}, plan.final, false))
    && ledgerReadbacks.every((snapshot) => snapshot.exists && manualProjectionMatches(snapshot.data() ?? {}, plan.final, false));
  if (!readbackVerified) throw failedPrecondition("reclassification readback verification failed");
  const verifiedResult = { ...result, readbackVerified: true };
  await actionRef.set({
    receipt: {
      version: verifiedResult.version,
      auditRef: verifiedResult.auditRef,
      readbackVerified: true,
      mailSent: false,
    },
    readbackVerifiedAtIso: new Date().toISOString(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return verifiedResult;
}

export async function revertConversationAttribution(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "conversation_attribution.revert", WRITE_ROLES);
  const data = asRecord(request.data);
  const conversationRef = conversationRefFromId(data.conversationId);
  // Flu conversation org-filter round 14: see reclassifyConversationAttribution's matching comment
  // — assertManualAttributionOwnership alone is not enough for an explicitly scp@-stamped
  // conversation; canReadScpConversationRowForOrg (requires BOTH the positive scp grant and an org
  // match for a row it narrows — not the full mailbox-entitlement one) leaves every other
  // conversation type's existing ownership-based authorization untouched.
  const accessScope = await resolveConversationMailAccessScope(auth);
  const reason = requiredReason(data.reason);
  const rawAuditRef = asString(data.auditRef);
  const auditId = rawAuditRef.startsWith(`${AUDIT_COLLECTION}/`)
    ? rawAuditRef.slice(`${AUDIT_COLLECTION}/`.length)
    : rawAuditRef;
  if (!auditId || auditId.includes("/")) throw invalidArgument("auditRef is required");
  const sourceAuditRef = adminDb.collection(AUDIT_COLLECTION).doc(auditId);
  const revertAuditRef = adminDb.collection(AUDIT_COLLECTION).doc();
  const reviewRef = adminDb.collection("reviews").doc(attributionReviewId(conversationRef.id));
  const nowIso = new Date().toISOString();

  const version = await adminDb.runTransaction(async (transaction) => {
    const [conversationSnapshot, auditSnapshot, reviewSnapshot] = await Promise.all([
      transaction.get(conversationRef),
      transaction.get(sourceAuditRef),
      transaction.get(reviewRef),
    ]);
    if (!conversationSnapshot.exists) throw Object.assign(new Error("not-found: conversation not found"), { code: "not-found", errorCode: "revert_conversation_attribution_conversation_found" });
    if (!auditSnapshot.exists) throw Object.assign(new Error("not-found: attribution audit not found"), { code: "not-found", errorCode: "revert_conversation_attribution_attribution_audit_found" });
    const sourceAudit = auditSnapshot.data() ?? {};
    if (asString(sourceAudit.conversationId) !== conversationRef.id) throw failedPrecondition("audit belongs to another conversation");
    const projectedMessageSourceRefs = Array.from(new Set(
      (Array.isArray(sourceAudit.projectedMessageSourceRefs)
        ? sourceAudit.projectedMessageSourceRefs
        : [])
        .map(validMessageSourceRef)
        .filter(Boolean),
    )).sort().slice(0, MANUAL_RECLASSIFICATION_MAX_EVIDENCE_REFS);
    const projectedOutboundLedgerRefs = Array.from(new Set(
      (Array.isArray(sourceAudit.projectedOutboundLedgerRefs)
        ? sourceAudit.projectedOutboundLedgerRefs
        : [])
        .map(validOutboundLedgerRef)
        .filter(Boolean),
    )).sort().slice(0, 400);
    const conversation = conversationSnapshot.data() ?? {};
    const existing = asRecord(conversation.attribution);
    const currentVersion = Math.max(0, Number(existing.version) || 0);
    expectedVersion(data, currentVersion);
    const beforeFinal = cleanSnapshot(existing.final, originalSnapshot(conversation));
    const target = cleanSnapshot(sourceAudit.beforeFinal, originalSnapshot(conversation));
    const targetProgramId = target.primaryBucket === "program"
      ? resolveCanonicalProgramId(target.programId)
      : "";
    const targetCampaignId = targetProgramId ? asString(target.campaignId) : "";
    if (targetCampaignId.includes("/") || targetCampaignId.length > 500) {
      throw failedPrecondition("audit contains an invalid campaign target");
    }
    const targetProgramRef = targetProgramId
      ? adminDb.collection("programs").doc(targetProgramId)
      : null;
    const targetCampaignRef = targetCampaignId
      ? adminDb.collection("campaigns").doc(targetCampaignId)
      : null;
    const [programSnapshot, campaignSnapshot, sourceSnapshots, ledgerSnapshots] = await Promise.all([
      targetProgramRef ? transaction.get(targetProgramRef) : Promise.resolve(null),
      targetCampaignRef ? transaction.get(targetCampaignRef) : Promise.resolve(null),
      Promise.all(projectedMessageSourceRefs.map((ref) => transaction.get(adminDb.doc(ref)))),
      Promise.all(projectedOutboundLedgerRefs.map((ref) => transaction.get(adminDb.doc(ref)))),
    ]);
    if (targetProgramRef && !programSnapshot?.exists) {
      throw failedPrecondition("revert target program no longer exists");
    }
    if (targetCampaignRef && !campaignSnapshot?.exists) {
      throw failedPrecondition("revert target campaign no longer exists");
    }
    if (campaignSnapshot) {
      const campaignProgramId = resolveCanonicalProgramId(campaignSnapshot.get("programId"));
      if (!campaignProgramId || campaignProgramId !== targetProgramId) {
        throw failedPrecondition("revert target campaign does not belong to its program");
      }
    }
    if (!canReadScpConversationRowForOrg({ id: conversationRef.id, ...conversation }, accessScope)) {
      throw Object.assign(new Error("permission-denied: conversation belongs to another mail account/org"), {
        code: "permission-denied",
        errorCode: "revert_conversation_attribution_conversation_scope_denied",
      });
    }
    assertManualAttributionOwnership({
      auth,
      conversation,
      final: target,
      ...(programSnapshot ? { program: programSnapshot.data() ?? {} } : {}),
      ...(campaignSnapshot ? { campaign: campaignSnapshot.data() ?? {} } : {}),
    });
    const revertedFinal: ConversationAttributionSnapshot = {
      ...target,
      source: "revert",
      reasonId: "operator_reverted_attribution",
      decidedAtIso: nowIso,
    };
    const nextVersion = currentVersion + 1;
    const nextState: ConversationAttributionState = {
      policyVersion: CONVERSATION_ATTRIBUTION_POLICY_VERSION,
      attributionStatus: "manual_confirmed",
      version: nextVersion,
      reviewRequired: false,
      original: cleanSnapshot(existing.original, originalSnapshot(conversation)),
      suggested: cleanSnapshot(existing.suggested, target),
      final: revertedFinal,
      rankedCandidates: Array.isArray(existing.rankedCandidates)
        ? existing.rankedCandidates as RankedAttributionCandidate[]
        : [],
      updatedAtIso: nowIso,
    };
    const projectionPatch = manualEvidenceProjectionPatch({
      final: revertedFinal,
      conversationId: conversationRef.id,
      auditRef: revertAuditRef.path,
      nowIso,
      source: "revert",
    });
    transaction.set(conversationRef, {
      attribution: nextState,
      attributionStatus: nextState.attributionStatus,
      attributionReviewRequired: false,
      attributionUpdatedAtIso: nowIso,
      lastAttributionAuditRef: revertAuditRef.path,
      ...topLevelAttributionPatch(revertedFinal),
    }, { merge: true });
    for (const snapshot of sourceSnapshots) {
      if (snapshot.exists) transaction.set(snapshot.ref, projectionPatch, { merge: true });
    }
    for (const snapshot of ledgerSnapshots) {
      if (snapshot.exists) transaction.set(snapshot.ref, projectionPatch, { merge: true });
    }
    transaction.create(revertAuditRef, {
      id: revertAuditRef.id,
      action: "revert",
      conversationId: conversationRef.id,
      conversationRef: conversationRef.path,
      revertedAuditRef: sourceAuditRef.path,
      versionBefore: currentVersion,
      versionAfter: nextVersion,
      beforeFinal,
      afterFinal: revertedFinal,
      original: nextState.original,
      suggested: nextState.suggested,
      projectedMessageSourceRefs,
      projectedOutboundLedgerRefs,
      mailSent: false,
      reason,
      actor: { uid: auth.userId, role: auth.role, team: auth.team },
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
      expireAt: expireAt180DaysFromIso(nowIso),
    });
    if (reviewSnapshot.exists) {
      transaction.set(reviewRef, {
        status: "resolved",
        resolution: revertedFinal,
        resolutionAuditRef: revertAuditRef.path,
        resolvedAtIso: nowIso,
        updatedAtIso: nowIso,
      }, { merge: true });
    }
    return nextVersion;
  });
  return { ok: true, conversationId: conversationRef.id, version, auditRef: revertAuditRef.path };
}
