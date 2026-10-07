import { createHash, randomBytes, randomUUID } from "node:crypto";
import { FieldPath, FieldValue, type Transaction } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  MAX_MAX_AGE_HOURS,
  SELECTABLE_AUTO_REPLY_STATUSES,
  diagnoseBacklogSenderIdentity,
  evaluateAutoReplyBacklogSkip,
} from "./autoReplyBacklog";
import {
  attributionReviewId,
  attributionCreatorIdentityKeys,
  conversationAutomaticAttributionFence,
  discoverInboundConversationAttribution,
  mergeAutomaticConversationAttribution,
  normalizeAttributionSubject,
  topLevelAttributionPatch,
  type ConversationAttributionResolution,
} from "./conversationAttribution";
import { fetchImapMessageByUid, type LiveInboundEmail } from "./mailImapLive";
import {
  INBOUND_SENDER_BINDING_POLICY_VERSION,
  computeLinkedCandidateRefs,
  evaluateAddressHistoryOutboundEvidence,
  evaluateAddressOutboundHistory,
  evaluateMergedOutboundSenderEvidence,
  evaluateOutboundSenderEvidence,
  canonicalizeRankedIdentities,
  readAddressAliasKeys,
  readCanonicalIdentityGroups,
  sourceActorIsAgency,
  storedIdentityGroups,
  canonicalizeOutboundIdentityKeys,
  hasAmbiguousCreatorIdentity,
  hasCompetingRejectedIdentity,
  hasUnlinkedExplicitIdentity,
  identityOnlyAttributionReasonAllowed,
  identityOnlyAutoReplyEnabled,
  isMessageSourceRef,
  normalizedSingleAddress,
  senderEmailHash24,
  senderEvidenceFingerprint,
  type SenderBindingScope,
  type SenderIdentityBinding,
} from "./inboundSenderIdentity";
import { CANONICAL_OPERATIONAL_MAILBOX_V1 } from "./mailIdentity";
import { resolveCanonicalProgramId } from "./programCanonical";
import { readMailAccounts } from "./mailAccounts";
import { detectManualReplySinceInbound } from "./manualReplyDetection";
import { readSettings } from "./settings";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type AuthContext, type CallableRequestShape } from "./shared";
import type { InboundAutoReplyAccount } from "./inboundAutoReplyPolicy";

/**
 * repairInboundCreatorAttribution (2026-10-03) — super_admin only.
 *
 * Why this exists: the held-backlog path (autoReplyBacklog.ts diagnoseBacklogSenderIdentity) judges the
 * latest INBOUND message_sources doc, but every earlier repair path (conversationAttributionReconciliation,
 * manual attribution) only updated the CONVERSATION — so repairing a conversation never restored send
 * eligibility and 174/190 held replies stayed `sender_not_creator`. This callable repairs BOTH documents in
 * one transaction, and only from evidence the server can independently re-verify:
 *   - the actual sender (From) equals the To of OUR real, prior, single-target sent outbound
 *     (inboundSenderIdentity.ts evaluateOutboundSenderEvidence), and
 *   - the attribution engine, run with that outbound as the exact link, resolves to one program with no
 *     review requirement and a ranked candidate that cites that very outbound, and
 *   - the source's IMAP provenance is complete (never fabricated: a missing marker is restored only from the
 *     source's own `imap` coordinates corroborated by the scp-owned mail_ingest_cursors, exactly like
 *     backfillInboundMailProvenance), and
 *   - the projected source passes the UNCHANGED backlog gate (diagnoseBacklogSenderIdentity).
 * It never enqueues and never sends. After a repair the existing backlog re-evaluation path must re-pass
 * every gate (permit, JEV, case, manual reply, mail safety...). `sender_not_creator` is not relaxed.
 */
export const INBOUND_CREATOR_ATTRIBUTION_REPAIR_POLICY_VERSION = "inbound_creator_attribution_repair_v1" as const;
export const INBOUND_CREATOR_ATTRIBUTION_REPAIR_CONFIRM_TOKEN = "REPAIR_INBOUND_CREATOR_ATTRIBUTION";
const CODE_VERSION = "inbound-creator-attribution-repair/2026-10-03";
const ACTION = "inbound_creator_attribution.repair";
const CLAIMS_COLLECTION = "inbound_creator_attribution_repair_claims";
const AUDITS_COLLECTION = "inbound_creator_attribution_repair_audits";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SERVER_TIME_BUDGET_MS = 60_000;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;
const MAIL_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;
const SUPPORTED_MATCH_BASES = new Set(["reply_header", "tracking_id", "from_address"]);

/**
 * Where the outbound used as identity evidence came from (diagnostics only — every origin goes through the
 * same From == To verification and refusals):
 *  - matched_outbound: the source's own matchedOutboundRef (program context survived ingest)
 *  - rematched:        no matchedOutboundRef was stored (e.g. the program context had been rejected at ingest
 *                      and deleted it); the server matcher re-ran against the live mailbox message, inside the
 *                      apply transaction too. The separately persisted senderIdentityOutboundRef never selects
 *                      the outbound (trusted provenance proves the ORIGINAL evidence, not that the match is
 *                      still unique): it only cross-checks the fresh match.
 */
export type RepairIdentityOrigin = "matched_outbound" | "rematched";

/**
 * The authenticated inputs the server matcher reads from an inbound message (all re-read from the canonical
 * mailbox at preview; at apply the same shape is rebuilt from the fenced source + the verified outbound).
 */
export type RematchInboundInput = {
  trackingId: string;
  providerMessageId: string | null;
  fromNormalized: string | null;
  subject: string;
  body: string | null;
  receivedAtIso: string;
  replyHeaders: { inReplyTo: string | null; references: string[] };
};
/** The header-derived part of the input that is NOT recoverable from the stored source row. */
export type RematchHeaderInputs = Pick<RematchInboundInput, "trackingId" | "providerMessageId" | "replyHeaders">;

function rematchInputFrom(headers: RematchHeaderInputs, fields: { fromNormalized: string; subject: string; body: string; receivedAtIso: string }): RematchInboundInput {
  return {
    trackingId: headers.trackingId,
    providerMessageId: headers.providerMessageId,
    replyHeaders: { inReplyTo: headers.replyHeaders.inReplyTo, references: [...headers.replyHeaders.references] },
    fromNormalized: fields.fromNormalized,
    subject: fields.subject,
    body: fields.body,
    receivedAtIso: fields.receivedAtIso,
  };
}

/** Result of re-running the server's outbound matcher against a live mailbox message (read-only). */
export type RematchedOutbound =
  | { kind: "match"; path: string; matchBasis: string; matchedProviderMessageIdHash: string }
  | { kind: "ambiguous"; reason: string; eligiblePaths?: string[]; /** platform-wrapper identity quarantine: never relaxed. Absent = unknown = treated as quarantined. */ quarantine?: boolean }
  | { kind: "none" };

type ReasonCounts = Record<string, number>;
type RepairCounts = {
  scanned: number;
  planned: number;
  applied: number;
  idempotent: number;
  stale: number;
  needsHuman: number;
  skipped: number;
};

type ProvenancePatch = {
  inboundMailProvenance: { kind: "imap"; accountId: string; mailbox: string };
  mailAccountId: string;
  accountMailbox: string;
};

type RepairPlanItem = {
  conversationId: string;
  conversationHash: string;
  sourceRef: string;
  sourceRefHash: string;
  outboundRef: string;
  conversationFence: string;
  conversationStateFingerprint: string;
  sourceFingerprint: string;
  outboundFingerprint: string;
  expectedAttributionVersion: number;
  actualFromHash: string;
  matchBasis: string;
  resolution: ConversationAttributionResolution;
  rejectedCandidateRefs: string[];
  candidateRef: string;
  creatorIdentityKey: string;
  candidateEvidenceRefs: string[];
  evidenceKind: string;
  linkedCandidateRefs: string[];
  linkedIdentityKeys: string[];
  /** Groups of explicit identity keys proven to name ONE channel (stored on the binding; every gate reads the same groups). */
  canonicalIdentityGroups: Array<{ keys: string[] }>;
  /** Keys collapsed into the address identity (identity_only only): docless ids / aliases from our own single-recipient sends. */
  addressAliasKeys: string[];
  provenancePatch: ProvenancePatch | null;
  evidenceFingerprint: string;
  matchedProviderMessageIdHash: string;
  matchedTrackingId: string;
  identityOrigin: RepairIdentityOrigin;
  /** Header inputs of a re-matched plan (null for the other origins): apply re-runs the WHOLE matcher with them. */
  rematchHeaders: RematchHeaderInputs | null;
  resolutionDigest: string;
  dependencyFingerprints: Array<{ path: string; fingerprint: string; kind: "owner" | "full" }>;
  ownerUid?: string;
  /**
   * identity_only: the From == To identity is proven but program attribution is unresolved (or several prior outbounds
   * were merged as one creator). The repair then writes ONLY the binding (+ provenance restore); it never touches the
   * conversation/source attribution or the program fields.
   */
  bindingScope: SenderBindingScope;
  /** identity_only merge of several same-address outbounds (proof = outboundRef): every merged ref + its doc fingerprint. */
  mergedOutboundRefs: string[];
  mergedOutboundFingerprints: Array<{ ref: string; fingerprint: string }>;
  /** identity_only: digest of every real prior outbound to the verified address (shared-address guard); "" otherwise. */
  addressHistoryFingerprint: string;
};

type ManifestRow = { conversationHash: string; sourceRefHash: string; evidenceFingerprintHash: string; outcome: string };

export type InboundCreatorAttributionRepairEnvelope = {
  ok: true;
  dryRun: boolean;
  runId: string;
  mailAccountId: string;
  repairPolicyVersion: typeof INBOUND_CREATOR_ATTRIBUTION_REPAIR_POLICY_VERSION;
  nextCursor: string | null;
  done: boolean;
  readbackVerified: boolean;
  counts: RepairCounts;
  reasonCounts: ReasonCounts;
  manifest: ManifestRow[];
  previewToken?: string;
  previewHash?: string;
  // Never any of these: mail sent / queued. Present so a client can assert it.
  mailSent: false;
  enqueued: false;
};

type StoredClaim = {
  schemaVersion: typeof INBOUND_CREATOR_ATTRIBUTION_REPAIR_POLICY_VERSION;
  status: "previewed" | "applied";
  actorUid: string;
  actorRole: string;
  runId: string;
  mailAccountId: string;
  previewHash: string;
  expiresAtIso: string;
  publicPreview: InboundCreatorAttributionRepairEnvelope;
  plan: RepairPlanItem[];
  publicApply?: InboundCreatorAttributionRepairEnvelope;
};

function operationError(
  code: "invalid-argument" | "permission-denied" | "not-found" | "failed-precondition" | "aborted",
  reason: string,
): Error {
  return Object.assign(new Error(`${code}: ${reason}`), { code, errorCode: `inbound_creator_attribution_repair_${reason}` });
}

function sha(value: unknown, length = 32): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex")
    .slice(0, length);
}

function incrementReason(counts: ReasonCounts, reason: string, amount = 1): void {
  if (reason) counts[reason] = (counts[reason] ?? 0) + amount;
}

function capabilityToken(): string {
  return `${randomUUID()}.${randomBytes(24).toString("base64url")}`;
}

function assertCapability(value: unknown, label: string): string {
  const token = asString(value);
  if (!/^[A-Za-z0-9._-]{32,200}$/.test(token)) throw operationError("invalid-argument", `${label}_required`);
  return token;
}

function canonicalAccount(value: unknown): string {
  return asString(value, "").trim().toLowerCase() || "scp";
}

function viewAsRequested(data: Record<string, unknown>): boolean {
  return (typeof data.viewAsUserId === "string" && data.viewAsUserId.trim().length > 0)
    || (typeof data.viewAsEmail === "string" && data.viewAsEmail.trim().length > 0);
}

function validMessageSourceRef(value: unknown): string {
  const ref = asString(value);
  return isMessageSourceRef(ref) ? ref : "";
}

// ── fingerprints ───────────────────────────────────────────────────────────────────────────────

/** Every source field the verdict/projection depends on — leaf values only, fixed order. */
export function repairSourceFingerprint(source: Record<string, unknown>): string {
  const provenance = asRecord(source.inboundMailProvenance);
  const imap = asRecord(source.imap);
  return sha({
    conversationId: asString(source.conversationId),
    direction: asString(source.direction),
    source: asString(source.source),
    subject: asString(source.subject),
    bodyHash: sha(asString(source.body)),
    creatorEmail: asString(source.creatorEmail),
    quotedOriginalRecipientEmail: asString(source.quotedOriginalRecipientEmail),
    originalMessageRef: asString(source.originalMessageRef),
    from: asString(source.from),
    receivedAtIso: asString(source.receivedAtIso),
    fromHash: asString(source.fromHash),
    inboundSenderHash: asString(source.inboundSenderHash),
    creatorId: asString(source.creatorId),
    matchedOutboundRef: asString(source.matchedOutboundRef),
    matchedOutboundMatchBasis: asString(source.matchedOutboundMatchBasis),
    matchedOutboundTrackingId: asString(source.matchedOutboundTrackingId),
    matchedOutboundProviderMessageIdHash: asString(source.matchedOutboundProviderMessageIdHash),
    senderIdentityOutboundRef: asString(source.senderIdentityOutboundRef),
    senderIdentityMatchBasis: asString(source.senderIdentityMatchBasis),
    senderIdentityMatchedTrackingId: asString(source.senderIdentityMatchedTrackingId),
    senderIdentityMatchedProviderMessageIdHash: asString(source.senderIdentityMatchedProviderMessageIdHash),
    mailAccountId: asString(source.mailAccountId),
    accountMailbox: asString(source.accountMailbox),
    provenancePresent: source.inboundMailProvenance !== undefined && source.inboundMailProvenance !== null,
    provenanceKind: asString(provenance.kind),
    provenanceAccountId: asString(provenance.accountId),
    provenanceMailbox: asString(provenance.mailbox),
    imapMailbox: asString(imap.mailbox),
    imapUidValidity: asString(imap.uidValidity),
    imapUid: typeof imap.uid === "number" ? imap.uid : null,
    imapUser: asString(imap.user),
    attributionReviewRequired: source.attributionReviewRequired === true,
    attributionStatus: asString(source.attributionStatus),
    attribution: asRecord(source.attribution),
    senderIdentityBinding: asRecord(source.senderIdentityBinding),
  });
}

/** Conversation state that the attribution fence does not already cover (hold / reply state). */
function conversationStateFingerprint(conversation: Record<string, unknown>): string {
  return sha({
    aiActive: conversation.aiActive === false ? false : true,
    autoReplyStatus: asString(conversation.autoReplyStatus),
    lastMessageFrom: asString(conversation.lastMessageFrom),
    lastMessageRef: asString(conversation.lastMessageRef),
    humanReviewStatus: asString(conversation.humanReviewStatus),
    manualIntervention: asString(asRecord(conversation.manualIntervention).status),
    autoRepliedCaseIds: Array.isArray(conversation.autoRepliedCaseIds) ? conversation.autoRepliedCaseIds.length : 0,
    mailAccountId: canonicalAccount(conversation.mailAccountId),
    creatorEmail: asString(conversation.creatorEmail),
  });
}

const OWNER_FIELDS = ["ownerUid", "ownerUserId", "managerUid", "programOwnerUid", "createdBy", "orgId", "campaignProgramId", "canonicalProgramId"] as const;
function ownerFieldsOf(doc: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(OWNER_FIELDS.map((key) => [key, asString(doc[key])]));
}
/** Ownership/program inputs the attribution engine reads from program/campaign docs. */
function dependencyFingerprint(doc: Record<string, unknown> | null, kind: "owner" | "full" = "owner"): string {
  if (!doc) return "absent";
  return kind === "full"
    ? sha(doc)
    : sha({ ...ownerFieldsOf(doc), programId: asString(doc.programId), status: asString(doc.status) });
}
function resolutionDigestOf(resolution: ConversationAttributionResolution, rejectedCandidateRefs: readonly string[] = []): string {
  return sha({
    // rejected (ownership/program-conflicted) evidence is part of the decision: a newly rejected competing
    // creator changes the digest even when the ranked list does not move
    rejected: [...rejectedCandidateRefs].sort(),
    final: resolution.final,
    reviewRequired: resolution.reviewRequired,
    reasonId: resolution.reasonId,
    candidates: resolution.rankedCandidates.map((candidate) => ({
      candidateRef: candidate.candidateRef,
      evidenceRefs: [...candidate.evidenceRefs].sort(),
      programId: candidate.programId,
      campaignId: candidate.campaignId ?? "",
      creatorIdentityKey: candidate.creatorIdentityKey,
      score: candidate.score,
      signalIds: [...candidate.signalIds].sort(),
    })),
  });
}

/** The WHOLE outbound doc: every identity fallback (handle, channel ids, YouTube URL, candidate id...) counts. */
function outboundFingerprint(outbound: Record<string, unknown>): string {
  return sha(outbound);
}

/** Digest of the whole real-prior-outbound history of one address (refs + full docs): any change => a new preview. */
function addressHistoryFingerprintOf(rows: ReadonlyArray<{ path: string; data: Record<string, unknown> }>, refs: readonly string[]): string {
  const wanted = new Set(refs);
  return sha(rows.filter((row) => wanted.has(row.path)).map((row) => `${row.path}:${outboundFingerprint(row.data)}`).sort());
}

// ── planning ───────────────────────────────────────────────────────────────────────────────────

export type RepairPlanDependencies = {
  readDoc(path: string): Promise<Record<string, unknown> | null>;
  discover: typeof discoverInboundConversationAttribution;
  detectManualReply: (input: { creatorEmail: string; lastInboundAtIso: string }) => Promise<{ detected: boolean }>;
  accounts: readonly InboundAutoReplyAccount[];
  allowedAccountIds: unknown;
  /** Authoritative re-read of the canonical mailbox message (scp only). */
  fetchLive: (args: { mailbox: string; uid: number; uidValidity: string }) => Promise<LiveInboundEmail | null>;
  /**
   * Server matcher re-run against the AUTHENTICATED live message, for sources that carry neither a stored
   * matched outbound nor a stored identity outbound. Absent => such sources stay human (fail closed).
   */
  rematchOutbound?: (input: RematchInboundInput, transaction?: Transaction) => Promise<RematchedOutbound>;
  nowIso: string;
  actor: { userId: string; role: string };
  /** humanReviewPolicy.allowIdentityOnlyAutoReply (kill switch). Absent => identity_only is never planned or accepted. */
  allowIdentityOnly?: boolean;
  /** Every outbound doc addressed to/about this exact address (identity_only shared-address guard). Absent => identity_only stays human. */
  outboundsForAddress?: (address: string, transaction?: Transaction) => Promise<{ rows: Array<{ path: string; data: Record<string, unknown> }>; complete: boolean }>;
};

export type RepairPlanOutcome =
  | { kind: "skip"; reason: string; needsHuman: boolean }
  | { kind: "already_verified" }
  | { kind: "plan"; item: RepairPlanItem; reason: string; identityNote: "" | "identity_rematched" | "program_context_rejected_identity_kept" | "outbound_same_identity_merged" | "address_history_identity_proof"; scopeNote: "" | "identity_only_bound"; canonicalNote: "" | "identity_keys_canonicalized" };

const HUMAN = true;
/** Skips that only mean "the PROGRAM-scoped binding is not provable" (strict identity rules, no aliases): identity_only is then tried. */
const PROGRAM_SCOPE_ONLY_SKIP_REASONS: ReadonlySet<string> = new Set(["candidate_identity_ambiguous", "rejected_candidate_identity_conflict", "no_creator_candidate"]);
const skip = (reason: string, needsHuman = false): RepairPlanOutcome => ({ kind: "skip", reason, needsHuman });

function isProvenanceComplete(source: Record<string, unknown>): boolean {
  const provenance = asRecord(source.inboundMailProvenance);
  return asString(provenance.kind) === "imap"
    && Boolean(asString(provenance.accountId))
    && Boolean(asString(provenance.mailbox))
    && asString(source.mailAccountId) === asString(provenance.accountId)
    && asString(source.accountMailbox) === asString(provenance.mailbox);
}

function projectSource(
  source: Record<string, unknown>,
  patch: {
    provenancePatch: ProvenancePatch | null;
    inboundSenderHash: string;
    binding: SenderIdentityBinding;
    /** null (identity_only): the source's own attribution is left exactly as it is. */
    attribution: Record<string, unknown> | null;
  },
): Record<string, unknown> {
  return {
    ...source,
    ...(patch.provenancePatch ?? {}),
    inboundSenderHash: patch.inboundSenderHash,
    senderIdentityBinding: patch.binding,
    ...(patch.attribution
      ? {
          attribution: patch.attribution,
          attributionStatus: asString(patch.attribution.attributionStatus),
          attributionReviewRequired: patch.attribution.reviewRequired === true,
        }
      : {}),
  };
}

function bindingFor(item: RepairPlanItem, nowIso: string): SenderIdentityBinding {
  if (item.bindingScope === "identity_only") {
    // Address-only proof: no candidate / identity key (a key would make it a program binding in disguise).
    return {
      policyVersion: INBOUND_SENDER_BINDING_POLICY_VERSION,
      status: "verified",
      bindingScope: "identity_only",
      reasonCode: "identity_only_bound",
      evidenceKind: item.evidenceKind as SenderIdentityBinding["evidenceKind"],
      inboundSenderHash: item.actualFromHash,
      outreachRecipientHash: item.actualFromHash,
      outboundRef: item.outboundRef,
      matchBasis: item.matchBasis,
      decidedAtIso: nowIso,
      decidedBy: "repair",
      ...(item.linkedCandidateRefs.length > 0 ? { linkedCandidateRefs: item.linkedCandidateRefs } : {}),
      ...(item.linkedIdentityKeys.length > 0 ? { linkedIdentityKeys: item.linkedIdentityKeys } : {}),
      // always written (even empty): the binding merge-write must REPLACE a previously stored proof
      canonicalIdentityGroups: item.canonicalIdentityGroups ?? [],
      addressAliasKeys: readAddressAliasKeys(item.addressAliasKeys),
      ...(item.mergedOutboundRefs.length > 0 ? { mergedOutboundRefs: item.mergedOutboundRefs } : {}),
      evidenceFingerprint: item.evidenceFingerprint,
    };
  }
  return {
    policyVersion: INBOUND_SENDER_BINDING_POLICY_VERSION,
    status: "verified",
    reasonCode: "verified",
    evidenceKind: item.evidenceKind as SenderIdentityBinding["evidenceKind"],
    inboundSenderHash: item.actualFromHash,
    outreachRecipientHash: item.actualFromHash,
    outboundRef: item.outboundRef,
    matchBasis: item.matchBasis,
    decidedAtIso: nowIso,
    decidedBy: "repair",
    creatorIdentityKey: item.creatorIdentityKey,
    candidateRef: item.candidateRef,
    evidenceRefs: item.candidateEvidenceRefs,
    ...(item.linkedCandidateRefs.length > 0 ? { linkedCandidateRefs: item.linkedCandidateRefs } : {}),
    ...(item.linkedIdentityKeys.length > 0 ? { linkedIdentityKeys: item.linkedIdentityKeys } : {}),
    canonicalIdentityGroups: item.canonicalIdentityGroups ?? [],
    addressAliasKeys: [],
    evidenceFingerprint: item.evidenceFingerprint,
  };
}

/** Pure given its dependencies: decides what (if anything) may be repaired for ONE conversation. */
export async function planInboundCreatorRepair(
  conversationId: string,
  conversation: Record<string, unknown>,
  requestedMailAccountId: string,
  deps: RepairPlanDependencies,
): Promise<RepairPlanOutcome> {
  if (canonicalAccount(conversation.mailAccountId) !== canonicalAccount(requestedMailAccountId)) {
    return skip("account_scope_mismatch");
  }
  if (!(SELECTABLE_AUTO_REPLY_STATUSES as readonly string[]).includes(asString(conversation.autoReplyStatus))) {
    return skip("reply_state_not_selectable");
  }
  if (asString(conversation.lastMessageFrom) !== "creator") return skip("reply_state_changed");
  // AI-off, an open manual takeover, an already-sent case and a human review hold are operator choices:
  // untouched, never "repaired around".
  const heldReason = evaluateAutoReplyBacklogSkip(conversation);
  if (heldReason === "aiInactive") return skip("ai_inactive");
  if (heldReason === "takenOver") return skip("taken_over");
  if (heldReason === "alreadyReplied") return skip("already_replied");
  if (heldReason === "humanReviewHeld") return skip("human_hold");
  const finalSource = asString(asRecord(asRecord(conversation.attribution).final).source);
  if (finalSource === "manual" || finalSource === "revert") return skip("manual_decision_preserved");
  const sourceRef = validMessageSourceRef(conversation.lastMessageRef);
  if (!sourceRef) return skip("no_inbound_source", HUMAN);
  const source = await deps.readDoc(sourceRef);
  if (
    !source
    || asString(source.direction) !== "inbound"
    || asString(source.source) !== "receiveEmail"
    || asString(source.conversationId) !== conversationId
  ) return skip("no_inbound_source", HUMAN);
  if (diagnoseBacklogSenderIdentity(source, conversationId, deps.allowedAccountIds, deps.accounts, { allowIdentityOnly: deps.allowIdentityOnly === true }).ok) {
    return { kind: "already_verified" };
  }
  const manual = await deps.detectManualReply({
    creatorEmail: asString(conversation.creatorEmail, asString(source.creatorEmail, "")),
    lastInboundAtIso: asString(conversation.lastInboundAtIso, ""),
  });
  if (manual.detected) return skip("manual_reply_detected");

  // ── evidence: the matched outbound and the ACTUAL sender ───────────────────────────────────────
  // source.matchedOutbound* is only a HINT about which outbound to look at: public receiveEmail replays
  // can store caller-supplied values there, so nothing about the match is taken on trust.
  const storedMatchedRef = validMessageSourceRef(source.matchedOutboundRef);
  // The separately persisted identity outbound (ingest keeps it even when the program context — and with it
  // matchedOutboundRef — was rejected). Equally only a hint: the same verification applies to it.
  const storedIdentityRef = storedMatchedRef ? "" : validMessageSourceRef(source.senderIdentityOutboundRef);
  const hintRef = storedMatchedRef;
  const rematchOutbound = deps.rematchOutbound;
  if (!hintRef && !rematchOutbound) return skip("no_matched_outbound", HUMAN);
  const identityOrigin: RepairIdentityOrigin = storedMatchedRef ? "matched_outbound" : "rematched";
  const storedFields = {
    basis: asString(source.matchedOutboundMatchBasis),
    providerHash: asString(source.matchedOutboundProviderMessageIdHash, ""),
    tracking: asString(source.matchedOutboundTrackingId, ""),
  };
  let foundRef = hintRef;
  let foundOutbound: Record<string, unknown> | null = null;
  if (hintRef) {
    foundOutbound = await deps.readDoc(hintRef);
    if (!foundOutbound) return skip("matched_outbound_missing", HUMAN);
    if (!normalizedSingleAddress(asString(foundOutbound.toNormalized, asString(foundOutbound.to, "")))) return skip("outbound_recipient_not_single_address", HUMAN);
  }

  const stampedHash = asString(source.inboundSenderHash, "").toLowerCase();
  let actualFromHash = "";
  let matchBasis = "";
  let matchedProviderMessageIdHash = "";
  let matchedTrackingId = "";
  let provenancePatch: ProvenancePatch | null = null;
  let provenanceEvidence = "stamped";
  let rematchHeaders: RematchHeaderInputs | null = null;
  // outbound_match_ambiguous -> identity_only merge (several same-address prior outbounds, ONE consolidated creator).
  let mergedOutboundRefs: string[] = [];
  let mergedKeys: string[] = [];
  let mergedDocs: Array<{ ref: string; data: Record<string, unknown> }> = [];
  // outbound_match_ambiguous with NO same-subject candidate (a fresh-subject reply) -> identity_only proof from the address history.
  let addressHistoryProof = false;
  let preloadedHistory: { rows: Array<{ path: string; data: Record<string, unknown> }>; complete: boolean } | null = null;
  if (hintRef && isProvenanceComplete(source) && /^[a-f0-9]{24}$/.test(stampedHash)) {
    // Written by the trusted IMAP ingest itself (every non-trusted write deletes provenance + hash).
    actualFromHash = stampedHash;
    matchBasis = storedFields.basis;
    matchedProviderMessageIdHash = storedFields.providerHash;
    matchedTrackingId = storedFields.tracking;
    if (!SUPPORTED_MATCH_BASES.has(matchBasis)) return skip("match_basis_unsupported", HUMAN);
  } else {
    // Legacy / unstamped row, or a row with no stored outbound to check. No stored field can authenticate
    // the sender or the provenance (a public receiveEmail replay can write imap coordinates, matchedOutbound*,
    // from, fromHash). The only authentic record is the canonical mailbox itself: re-read the exact message
    // and require the stored row to BE that message.
    if (canonicalAccount(requestedMailAccountId) !== "scp") return skip("provenance_missing", HUMAN);
    const existing = asRecord(source.inboundMailProvenance);
    const hasExisting = source.inboundMailProvenance !== undefined && source.inboundMailProvenance !== null;
    if (
      (hasExisting && (asString(existing.kind) !== "imap" || (asString(existing.accountId) && asString(existing.accountId) !== "scp")))
      || (asString(source.mailAccountId) && asString(source.mailAccountId) !== "scp")
    ) return skip("provenance_conflict", HUMAN);
    const scpAccount = deps.accounts.find((account) => account.accountId === "scp") ?? null;
    if (
      !scpAccount
      || scpAccount.status !== "active"
      || scpAccount.mailbox.trim().toLowerCase() !== CANONICAL_OPERATIONAL_MAILBOX_V1
    ) return skip("scp_account_unavailable", HUMAN);
    const imap = asRecord(source.imap);
    const imapMailbox = asString(imap.mailbox);
    const imapUidValidity = asString(imap.uidValidity);
    const imapUid = typeof imap.uid === "number" && Number.isInteger(imap.uid) ? imap.uid : 0;
    if (!imapMailbox || !imapUidValidity || imapUid <= 0 || !asString(source.originalMessageRef)) return skip("imap_coordinates_missing", HUMAN);
    let live: LiveInboundEmail | null;
    try {
      live = await deps.fetchLive({ mailbox: imapMailbox, uid: imapUid, uidValidity: imapUidValidity });
    } catch {
      return skip("live_mailbox_unavailable", HUMAN);
    }
    if (!live || live.empty) return skip("live_message_not_found", HUMAN);
    if (
      live.messageRef !== asString(source.originalMessageRef)
      || live.mailAccountId !== "scp"
      || normalizedSingleAddress(live.accountMailbox) !== CANONICAL_OPERATIONAL_MAILBOX_V1
    ) return skip("live_message_mismatch", HUMAN);
    // The stored row must reproduce the real message exactly — otherwise it is somebody's synthetic row
    // that merely cites a real mailbox coordinate.
    if (
      asString(live.subject) !== asString(source.subject)
      || asString(live.receivedAtIso) !== asString(source.receivedAtIso)
      || sha(asString(live.body, "")) !== sha(asString(source.body))
    ) return skip("source_content_differs_from_mailbox", HUMAN);
    const liveFrom = normalizedSingleAddress(live.fromNormalized ?? "");
    if (!liveFrom) return skip("actual_sender_missing", HUMAN);
    actualFromHash = senderEmailHash24(liveFrom);
    if (foundOutbound) {
      // Re-derive the match basis from the authentic headers instead of trusting the stored one.
      const outboundMessageHash = asString(foundOutbound.providerMessageIdHash, "").toLowerCase();
      const replyIds = [live.replyHeaders.inReplyTo ?? "", ...live.replyHeaders.references]
        .map((id) => id.replace(/[<>]/g, "").trim().toLowerCase())
        .filter(Boolean);
      if (outboundMessageHash && replyIds.some((id) => createHash("sha256").update(id).digest("hex") === outboundMessageHash)) {
        matchBasis = "reply_header";
        matchedProviderMessageIdHash = outboundMessageHash;
      } else if (live.trackingId && asString(foundOutbound.trackingId) && live.trackingId === asString(foundOutbound.trackingId)) {
        matchBasis = "tracking_id";
        matchedTrackingId = live.trackingId;
      } else {
        matchBasis = "from_address";
      }
    } else if (rematchOutbound) {
      // Nothing stored names an outbound: let the SERVER matcher (same code as live ingest: In-Reply-To /
      // References, tracking id, then same-subject single-target From-address match sent before receipt)
      // choose one from the authenticated message ONLY. It names a candidate; the From == To verification
      // and every refusal below still decide. Ambiguity (multi-target) and no-match stay human.
      const headers: RematchHeaderInputs = {
        trackingId: live.trackingId,
        providerMessageId: live.providerMessageId ?? null,
        replyHeaders: { inReplyTo: live.replyHeaders.inReplyTo ?? null, references: [...live.replyHeaders.references] },
      };
      let rematched: RematchedOutbound;
      try {
        rematched = await rematchOutbound(rematchInputFrom(headers, {
          fromNormalized: liveFrom,
          subject: asString(source.subject),
          body: asString(source.body),
          receivedAtIso: asString(source.receivedAtIso),
        }));
      } catch {
        return skip("outbound_rematch_unavailable", HUMAN);
      }
      if (rematched.kind === "ambiguous") {
        // Same address + same consolidated creator across the ambiguous outbounds is ONE identity (never a program).
        const eligible = (rematched.eligiblePaths ?? []).map(validMessageSourceRef);
        if (deps.allowIdentityOnly === true && rematched.quarantine === false && eligible.length === 0) {
          // The matcher found real prior outbounds to this address but none with the same subject / before the inbound: the sender
          // is still the EXACT address we mailed. Proof = the most recent real single-recipient send to it (identity_only, never a
          // program); the shared-address history guard below judges EVERY prior outbound to the address.
          if (!deps.outboundsForAddress) return skip("outbound_match_ambiguous", HUMAN);
          try {
            preloadedHistory = await deps.outboundsForAddress(liveFrom);
          } catch {
            return skip("address_history_unavailable", HUMAN);
          }
          if (!preloadedHistory.complete) return skip("address_history_incomplete", HUMAN);
          const proof = evaluateAddressHistoryOutboundEvidence({
            address: liveFrom,
            actualFromHash,
            inboundSubject: asString(source.subject, asString(conversation.subject, "")),
            inboundAtIso: asString(source.receivedAtIso, asString(conversation.lastInboundAtIso, "")),
            inboundMailAccountId: requestedMailAccountId,
            normalizeSubject: normalizeAttributionSubject,
            outbounds: preloadedHistory.rows.map((row) => ({ ref: row.path, data: row.data })),
          });
          if (!proof.ok) return skip("outbound_match_ambiguous", HUMAN);
          foundRef = proof.proving.ref;
          foundOutbound = proof.proving.data;
          matchBasis = "address_history";
          matchedProviderMessageIdHash = "";
          matchedTrackingId = "";
          rematchHeaders = headers;
          addressHistoryProof = true;
        } else {
        if (deps.allowIdentityOnly !== true || eligible.length < 2 || eligible.some((ref) => !ref)) return skip("outbound_match_ambiguous", HUMAN);
        const docs = await Promise.all(eligible.map(async (ref) => ({ ref, data: await deps.readDoc(ref) })));
        if (docs.some((item) => item.data === null)) return skip("matched_outbound_missing", HUMAN);
        const mergeCanonical = await canonicalizeOutboundIdentityKeys(docs.map((item) => item.data as Record<string, unknown>), attributionCreatorIdentityKeys, deps.readDoc, liveFrom);
        const merged = evaluateMergedOutboundSenderEvidence({
          identityGroups: mergeCanonical.groups,
          aliasKeys: mergeCanonical.aliasKeys,
          actualFromHash,
          inboundSubject: asString(source.subject, asString(conversation.subject, "")),
          inboundAtIso: asString(source.receivedAtIso, asString(conversation.lastInboundAtIso, "")),
          inboundMailAccountId: requestedMailAccountId,
          normalizeSubject: normalizeAttributionSubject,
          outbounds: docs.map((item) => ({ ref: item.ref, data: item.data as Record<string, unknown> })),
          keysOf: attributionCreatorIdentityKeys,
        });
        if (!merged.ok) return skip("outbound_match_ambiguous", HUMAN);
        if (storedIdentityRef && storedIdentityRef !== merged.proving.ref) return skip("identity_outbound_mismatch", HUMAN);
        foundRef = merged.proving.ref;
        foundOutbound = merged.proving.data;
        matchBasis = "from_address";
        matchedProviderMessageIdHash = "";
        matchedTrackingId = "";
        rematchHeaders = headers;
        mergedOutboundRefs = merged.refs;
        mergedKeys = merged.keys;
        mergedDocs = docs.map((item) => ({ ref: item.ref, data: item.data as Record<string, unknown> }));
        }
      } else {
        const rematchedRef = rematched.kind === "match" ? validMessageSourceRef(rematched.path) : "";
        if (rematched.kind !== "match" || !rematchedRef) return skip("no_matched_outbound", HUMAN);
        if (!SUPPORTED_MATCH_BASES.has(rematched.matchBasis)) return skip("match_basis_unsupported", HUMAN);
        // A persisted identity outbound that the fresh server match no longer picks is a human case.
        if (storedIdentityRef && storedIdentityRef !== rematchedRef) return skip("identity_outbound_mismatch", HUMAN);
        foundRef = rematchedRef;
        foundOutbound = await deps.readDoc(rematchedRef);
        if (!foundOutbound) return skip("matched_outbound_missing", HUMAN);
        if (!normalizedSingleAddress(asString(foundOutbound.toNormalized, asString(foundOutbound.to, "")))) return skip("outbound_recipient_not_single_address", HUMAN);
        matchBasis = rematched.matchBasis;
        matchedProviderMessageIdHash = matchBasis === "reply_header" ? rematched.matchedProviderMessageIdHash : "";
        matchedTrackingId = matchBasis === "tracking_id" ? live.trackingId : "";
        rematchHeaders = headers;
      }
    }
    provenancePatch = isProvenanceComplete(source) ? null : {
      inboundMailProvenance: { kind: "imap", accountId: "scp", mailbox: scpAccount.mailbox },
      mailAccountId: "scp",
      accountMailbox: scpAccount.mailbox,
    };
    provenanceEvidence = sha({ messageRef: live.messageRef, mailbox: imapMailbox, uidValidity: imapUidValidity, uid: imapUid });
  }
  if (!foundOutbound || !foundRef) return skip("no_matched_outbound", HUMAN);
  const outbound = foundOutbound;
  const outboundRef = foundRef;
  const outboundToAddress = normalizedSingleAddress(asString(outbound.toNormalized, asString(outbound.to, "")));
  // Auto-replies go to the conversation/source recipient: it must be the verified sender itself.
  for (const target of [source.creatorEmail, conversation.creatorEmail]) {
    const normalized = normalizedSingleAddress(target);
    if (asString(target) && normalized !== outboundToAddress) return skip("reply_target_differs_from_sender", HUMAN);
  }
  const evidence = evaluateOutboundSenderEvidence({
    actualFromHash,
    inboundSubject: asString(source.subject, asString(conversation.subject, "")),
    inboundAtIso: asString(source.receivedAtIso, asString(conversation.lastInboundAtIso, "")),
    inboundMailAccountId: requestedMailAccountId,
    matchBasis,
    outboundRef,
    outbound,
    matchedProviderMessageIdHash,
    matchedTrackingId,
    normalizeSubject: normalizeAttributionSubject,
  });
  if (evidence.status !== "verified" || evidence.evidenceKind === "") return skip(evidence.reasonCode, HUMAN);

  // ── attribution: the engine, with the verified outbound as the exact link ──────────────────────
  // quotedOriginalRecipientEmail is deliberately NOT passed: a quoted header block never repairs.
  const discovered = await deps.discover({
    conversationId,
    senderEmail: outboundToAddress,
    inboundSubject: asString(source.subject, ""),
    inboundBody: asString(source.body, "").slice(0, 20_000),
    receivedAtIso: asString(source.receivedAtIso, ""),
    matchedOutboundRef: outboundRef,
    matchBasis: matchBasis === "address_history" ? "from_address" : matchBasis,
    requesterUid: deps.actor.userId,
    requesterRole: deps.actor.role,
  });
  const resolution = discovered.resolution;
  // The program-scoped judgement is strict (no address aliases). When ONLY that program-specific part blocks, the same verified
  // address may still carry an identity_only binding (operator policy: program attribution never decides who the sender is).
  const decide = async (forceIdentityOnly: boolean): Promise<RepairPlanOutcome> => {
    // identity_only: the address identity is proven (above) but program attribution is unresolved — or the identity came from
    // several merged outbounds, in which case NO program is ever claimed (the most recent outbound's program is not the creator's).
    // An ownership conflict between programs is "merely unresolved" for identity_only (identityOnlyAttributionReasonAllowed).
    let bindingScope: SenderBindingScope = "program_attributed";
    const programAgnosticProof = mergedOutboundRefs.length > 0 || addressHistoryProof;
    const programResolved = !forceIdentityOnly && !programAgnosticProof
      && !resolution.reviewRequired
      && resolution.final.primaryBucket === "program"
      && Boolean(resolution.final.programId)
      && (resolution.reasonId === "exact_match_auto_program" || resolution.reasonId === "high_confidence_auto_program");
    if (!programResolved) {
      const unresolvedOnly = identityOnlyAttributionReasonAllowed(resolution, programAgnosticProof || forceIdentityOnly);
      if (deps.allowIdentityOnly !== true || !unresolvedOnly) return skip("attribution_unresolved", HUMAN);
      bindingScope = "identity_only";
    }
    const finalProgramId = bindingScope === "identity_only" ? "" : resolveCanonicalProgramId(resolution.final.programId);
    const citing = bindingScope === "identity_only" ? [] : resolution.rankedCandidates.filter((candidate) => (
      (candidate.candidateRef === outboundRef || candidate.evidenceRefs.includes(outboundRef))
      && resolveCanonicalProgramId(candidate.programId) === finalProgramId
      && Number.isFinite(candidate.score) && candidate.score > 0
      && candidate.signalIds.length > 0
      && candidate.creatorIdentityKey
      && candidate.creatorIdentityKey !== "identity:unknown"
    ));
    if (bindingScope === "program_attributed" && citing.length === 0) return skip("no_creator_candidate", HUMAN);
    // Shared address / several creators: ambiguity is judged across EVERY ranked candidate, not only the
    // ones that cite the selected outbound (the engine treats program/campaign — not creator — as competing).
    // Identifiers proven equivalent through the SAME outreach send (tracking id / message ref) are one
    // creator (handle:x + youtube:... of one send); anything else naming another creator is ambiguous.
    const linkedCandidateRefs = await computeLinkedCandidateRefs(resolution.rankedCandidates, outboundRef, outbound, deps.readDoc);
    const linkedIdentityKeys = Array.from(new Set([...attributionCreatorIdentityKeys(outbound), ...mergedKeys]));
    // Explicit keys of ONE person under different identifier types / per-program creator docs are canonicalized to a shared
    // channel identity (docs read here, fenced in the transactional apply); anything unprovable stays a distinct identity.
    const canonicalBase = {
      rankedLists: [resolution.rankedCandidates, asRecord(source.attribution).rankedCandidates],
      linkedKeys: linkedIdentityKeys,
      records: [outbound, ...mergedDocs.map((doc) => doc.data as Record<string, unknown>)],
      senderAddress: outboundToAddress,
      keysOf: attributionCreatorIdentityKeys,
      rejectedRefs: discovered.rejectedCandidateRefs,
      conversationId,
    };
    let canonical = await canonicalizeRankedIdentities(canonicalBase, deps.readDoc);
    let canonicalIdentityGroups = canonical.groups;
    // Address aliases (docless per-program ids asserted only by our own single-recipient sends to this exact address) are an
    // identity_only concept: a program-attributed binding never relies on them.
    let addressAliasKeys = bindingScope === "identity_only" ? canonical.aliasKeys : [];
    const ambiguousStrict = hasAmbiguousCreatorIdentity(resolution.rankedCandidates, outboundRef, linkedCandidateRefs, linkedIdentityKeys);
    if (hasAmbiguousCreatorIdentity(resolution.rankedCandidates, outboundRef, linkedCandidateRefs, linkedIdentityKeys, canonicalIdentityGroups, addressAliasKeys)) return skip("candidate_identity_ambiguous", HUMAN);
    // identity_only is stricter: any explicit creator identity on the ranked list must be tied to the proving send.
    const unlinkedStrict = bindingScope === "identity_only" && hasUnlinkedExplicitIdentity(resolution.rankedCandidates, outboundRef, linkedCandidateRefs, linkedIdentityKeys);
    if (bindingScope === "identity_only" && sourceActorIsAgency(source)) return skip("identity_only_agency_actor", HUMAN);
    if (bindingScope === "identity_only" && hasUnlinkedExplicitIdentity(resolution.rankedCandidates, outboundRef, linkedCandidateRefs, linkedIdentityKeys, canonicalIdentityGroups, addressAliasKeys)) {
      return skip("identity_candidate_unlinked", HUMAN);
    }
    const identityKeysCanonicalized = (canonicalIdentityGroups.length > 0 || addressAliasKeys.length > 0) && (ambiguousStrict || unlinkedStrict);
    // ...and a competing creator that discovery REJECTED (ownership/program conflict) is not invisible either.
    const knownIdentityKeys = Array.from(new Set([
      ...linkedIdentityKeys,
      ...addressAliasKeys,
      ...resolution.rankedCandidates
        .filter((candidate) => linkedCandidateRefs.includes(candidate.candidateRef))
        .map((candidate) => candidate.creatorIdentityKey),
    ]));
    // (identity_only judges this once more, with the FINAL groups / aliases, in the shared-address block below.)
    if (bindingScope !== "identity_only" && await hasCompetingRejectedIdentity(discovered.rejectedCandidateRefs, outboundRef, outbound, knownIdentityKeys, attributionCreatorIdentityKeys, deps.readDoc)) {
      return skip("rejected_candidate_identity_conflict", HUMAN);
    }
    // identity_only shared-address guard INDEPENDENT of program attribution (the engine drops programless / owner-conflicted
    // records, so two creators behind one agency address can both be invisible to it).
    let addressHistoryFingerprint = "";
    if (bindingScope === "identity_only") {
      if (!deps.outboundsForAddress) return skip("address_history_unavailable", HUMAN);
      let historyRows: Array<{ path: string; data: Record<string, unknown> }>;
      try {
        const collected = preloadedHistory ?? await deps.outboundsForAddress(outboundToAddress);
        // An overflowed lookup is incomplete (a conflicting creator may sit outside it) => not provable => human.
        if (!collected.complete) return skip("address_history_incomplete", HUMAN);
        historyRows = collected.rows;
      } catch {
        return skip("address_history_unavailable", HUMAN);
      }
      // Re-canonicalize over every history outbound's keys too: the stored groups (item + binding) must cover what the apply re-proves.
      canonical = await canonicalizeRankedIdentities({
        ...canonicalBase,
        extraKeys: historyRows.flatMap((row) => attributionCreatorIdentityKeys(row.data)),
        records: [...canonicalBase.records, ...historyRows.map((row) => row.data)],
      }, deps.readDoc);
      canonicalIdentityGroups = canonical.groups;
      addressAliasKeys = canonical.aliasKeys;
      // The stored groups / aliases are the FINAL ones: ambiguity / unlinked eligibility is re-judged with exactly them.
      if (
        hasAmbiguousCreatorIdentity(resolution.rankedCandidates, outboundRef, linkedCandidateRefs, linkedIdentityKeys, canonicalIdentityGroups, addressAliasKeys)
        || hasUnlinkedExplicitIdentity(resolution.rankedCandidates, outboundRef, linkedCandidateRefs, linkedIdentityKeys, canonicalIdentityGroups, addressAliasKeys)
      ) return skip("identity_candidate_unlinked", HUMAN);
      // A competing creator that discovery REJECTED, judged with the final groups / aliases (own sends to this address add no person).
      if (await hasCompetingRejectedIdentity(
        discovered.rejectedCandidateRefs,
        outboundRef,
        outbound,
        Array.from(new Set([
          ...knownIdentityKeys,
          ...addressAliasKeys,
        ])),
        attributionCreatorIdentityKeys,
        deps.readDoc,
        { address: outboundToAddress, groups: canonicalIdentityGroups, aliasKeys: addressAliasKeys },
      )) return skip("rejected_candidate_identity_conflict", HUMAN);
      const history = evaluateAddressOutboundHistory({
        identityGroups: canonicalIdentityGroups,
        aliasKeys: addressAliasKeys,
        address: outboundToAddress,
        outbounds: historyRows.map((row) => ({ ref: row.path, data: row.data })),
        provingRef: outboundRef,
        inboundAtIso: asString(source.receivedAtIso, asString(conversation.lastInboundAtIso, "")),
        keysOf: attributionCreatorIdentityKeys,
      });
      if (!history.ok) return skip(history.reasonCode, HUMAN);
      addressHistoryFingerprint = addressHistoryFingerprintOf(historyRows, history.refs);
    }
    const chosen = citing[0] ?? null;

    const ownerPaths = Array.from(new Set([
      ...(finalProgramId ? [`programs/${finalProgramId}`] : []),
      ...(asString(resolution.final.campaignId) ? [`campaigns/${asString(resolution.final.campaignId)}`] : []),
      ...(asString(outbound.campaignId) ? [`campaigns/${asString(outbound.campaignId)}`] : []),
    ].filter((path) => /^(programs|campaigns)\/[A-Za-z0-9_.:-]+$/.test(path))));
    // Every document the engine ranked or rejected is fenced whole (a spurious stale only costs a new preview).
    const evidencePaths = Array.from(new Set([
      ...resolution.rankedCandidates.flatMap((candidate) => [candidate.candidateRef, ...candidate.evidenceRefs]),
      ...discovered.rejectedCandidateRefs,
    ].filter((path) => typeof path === "string" && /^[a-z_]+\/[A-Za-z0-9_.:-]+$/.test(path) && path !== outboundRef && !ownerPaths.includes(path))));
    // Never truncate a fence: an over-budget decision is a human case.
    if (evidencePaths.length > 50) return skip("dependency_budget_exceeded", HUMAN);
    const evidenceDocs = await Promise.all(evidencePaths.map(async (path) => ({ path, data: await deps.readDoc(path) })));
    // Program/campaign ownership docs behind EVERY ranked or rejected candidate decide ownership conflicts.
    const extraOwnerPaths = new Set<string>();
    const addOwnerPaths = (record: Record<string, unknown> | null | undefined, programIdHint?: unknown, campaignIdHint?: unknown) => {
      const programId = resolveCanonicalProgramId(asString(programIdHint) || asString(record?.programId) || asString(record?.canonicalProgramId));
      const campaignId = asString(campaignIdHint) || asString(record?.campaignId);
      if (programId) extraOwnerPaths.add(`programs/${programId}`);
      if (campaignId) extraOwnerPaths.add(`campaigns/${campaignId}`);
    };
    for (const candidate of resolution.rankedCandidates) addOwnerPaths(null, candidate.programId, candidate.campaignId);
    for (const doc of evidenceDocs) addOwnerPaths(doc.data);
    // A campaign names its program: fence that program too (incl. behind rejected, campaign-only evidence).
    const campaignDocs = await Promise.all([...new Set([...ownerPaths, ...extraOwnerPaths])]
      .filter((path) => path.startsWith("campaigns/"))
      .map(async (path) => deps.readDoc(path)));
    for (const campaign of campaignDocs) addOwnerPaths(null, campaign?.programId ?? campaign?.canonicalProgramId);
    const allOwnerPaths = Array.from(new Set([...ownerPaths, ...extraOwnerPaths]))
      .filter((path) => /^(programs|campaigns)\/[A-Za-z0-9_.:-]+$/.test(path) && path !== outboundRef);
    if (allOwnerPaths.length + evidencePaths.length > 100) return skip("dependency_budget_exceeded", HUMAN);
    const dependencyFingerprints: RepairPlanItem["dependencyFingerprints"] = [
      ...(await Promise.all(allOwnerPaths.map(async (path) => ({ path, kind: "owner" as const, fingerprint: dependencyFingerprint(await deps.readDoc(path), "owner") })))),
      ...evidenceDocs.map((doc) => ({ path: doc.path, kind: "full" as const, fingerprint: dependencyFingerprint(doc.data, "full") })),
      // every creator doc behind a canonicalized identity is fenced whole (the exact snapshot canonicalization read): a changed channel => stale
      ...canonical.docs
        .map((doc) => ({ path: doc.path, kind: "full" as const, fingerprint: dependencyFingerprint(doc.data, "full") })),
    ];
    const conversationFence = conversationAutomaticAttributionFence(conversation);
    const expectedAttributionVersion = Math.max(0, Number(asRecord(conversation.attribution).version) || 0);
    const evidenceFingerprint = senderEvidenceFingerprint({
      policy: INBOUND_CREATOR_ATTRIBUTION_REPAIR_POLICY_VERSION,
      sourceRef,
      outboundRef,
      outbound: outboundFingerprint(outbound),
      actualFromHash,
      matchBasis,
      evidenceKind: evidence.evidenceKind,
      candidateKey: chosen?.creatorIdentityKey ?? "",
      bindingScope,
      addressHistoryFingerprint,
      identityGroups: canonicalIdentityGroups,
      aliasKeys: addressAliasKeys,
      merged: mergedDocs.map((doc) => `${doc.ref}:${outboundFingerprint(doc.data)}`).sort(),
      provenance: provenanceEvidence,
      rematchHeaders,
      resolution: resolutionDigestOf(resolution, discovered.rejectedCandidateRefs),
      dependencies: dependencyFingerprints.map((dep) => `${dep.path}:${dep.fingerprint}`).join("|"),
    });
    const item: RepairPlanItem = {
      conversationId,
      conversationHash: sha(conversationId),
      sourceRef,
      sourceRefHash: sha(sourceRef),
      outboundRef,
      conversationFence,
      conversationStateFingerprint: conversationStateFingerprint(conversation),
      sourceFingerprint: repairSourceFingerprint(source),
      outboundFingerprint: outboundFingerprint(outbound),
      expectedAttributionVersion,
      actualFromHash,
      matchBasis,
      resolution,
      rejectedCandidateRefs: discovered.rejectedCandidateRefs,
      candidateRef: chosen?.candidateRef ?? "",
      creatorIdentityKey: chosen?.creatorIdentityKey ?? "",
      candidateEvidenceRefs: chosen?.evidenceRefs ?? [],
      evidenceKind: evidence.evidenceKind,
      linkedCandidateRefs,
      linkedIdentityKeys,
      canonicalIdentityGroups: storedIdentityGroups(canonicalIdentityGroups),
      addressAliasKeys,
      provenancePatch,
      evidenceFingerprint,
      matchedProviderMessageIdHash,
      matchedTrackingId,
      identityOrigin,
      rematchHeaders,
      resolutionDigest: resolutionDigestOf(resolution, discovered.rejectedCandidateRefs),
      dependencyFingerprints,
      ...(asString(conversation.ownerUid) ? { ownerUid: asString(conversation.ownerUid) } : {}),
      bindingScope,
      mergedOutboundRefs,
      mergedOutboundFingerprints: mergedDocs.map((doc) => ({ ref: doc.ref, fingerprint: outboundFingerprint(doc.data) })),
      addressHistoryFingerprint,
    };

    // The projected source must pass the UNCHANGED gate, or we do not write anything.
    const attributionState = mergeAutomaticConversationAttribution(conversation, resolution, deps.nowIso);
    const projected = projectSource(source, {
      provenancePatch,
      inboundSenderHash: actualFromHash,
      binding: bindingFor(item, deps.nowIso),
      attribution: bindingScope === "identity_only" ? null : attributionState as unknown as Record<string, unknown>,
    });
    const verdict = diagnoseBacklogSenderIdentity(projected, conversationId, deps.allowedAccountIds, deps.accounts, { allowIdentityOnly: deps.allowIdentityOnly === true });
    if (!verdict.ok) return skip(`projected_gate_${verdict.reason}`, HUMAN);
    return {
      kind: "plan",
      item,
      reason: bindingScope === "identity_only" ? "identity_only_bound" : resolution.reasonId,
      identityNote: mergedOutboundRefs.length > 0
        ? "outbound_same_identity_merged"
        : addressHistoryProof
          ? "address_history_identity_proof"
        : identityOrigin !== "rematched"
          ? ""
          : storedIdentityRef !== "" ? "program_context_rejected_identity_kept" : "identity_rematched",
      scopeNote: bindingScope === "identity_only" ? "identity_only_bound" : "",
      canonicalNote: identityKeysCanonicalized ? "identity_keys_canonicalized" : "",
    };
  };
  const programScoped = await decide(false);
  if (
    programScoped.kind === "skip"
    && deps.allowIdentityOnly === true
    && (PROGRAM_SCOPE_ONLY_SKIP_REASONS.has(programScoped.reason) || programScoped.reason.startsWith("projected_gate_"))
  ) {
    const identityScoped = await decide(true);
    // identity_only's own refusal is the real blocker once the program scope failed
    return identityScoped;
  }
  return programScoped;
}

// ── transactional apply (tx abstraction so it is unit-testable without an emulator) ────────────

export type RepairTransactionLike = {
  /** The real Firestore transaction (evidence QUERIES re-run inside it); absent in in-memory fakes. */
  native?: unknown;
  get(path: string): Promise<{ exists: boolean; data: Record<string, unknown> }>;
  set(path: string, data: Record<string, unknown>, options?: { merge: boolean }): void;
  create(path: string, data: Record<string, unknown>): void;
};

export type RepairApplyContext = {
  nowIso: string;
  runId: string;
  actor: { userId: string; role: string };
  allowedAccountIds: unknown;
  accounts: readonly InboundAutoReplyAccount[];
  requestedMailAccountId: string;
  /**
   * Re-runs the evidence queries + resolution INSIDE the transaction (reads before any write) and returns
   * the resolution digest. Fails closed (stale) when absent.
   */
  freshResolutionDigest?: (item: RepairPlanItem, tx: RepairTransactionLike, docs: { source: Record<string, unknown>; outbound: Record<string, unknown> }) => Promise<string>;
  /** Re-runs the server matcher INSIDE the transaction (every query a transactional read). Fails closed when absent. */
  freshRematch?: (input: RematchInboundInput, tx: RepairTransactionLike) => Promise<RematchedOutbound>;
  /** humanReviewPolicy.allowIdentityOnlyAutoReply read for THIS apply. Absent/false => an identity_only item is stale. */
  allowIdentityOnly?: boolean;
  /** Shared-address history re-read INSIDE the transaction (identity_only). Fails closed (stale) when absent. */
  freshAddressHistory?: (address: string, tx: RepairTransactionLike) => Promise<{ rows: Array<{ path: string; data: Record<string, unknown> }>; complete: boolean }>;
};

export type RepairApplyKind = "applied" | "idempotent" | "stale" | "engine_error";

function dataDigest(value: unknown): string {
  return sha(value, 24);
}

/**
 * Applies ONE planned repair inside a transaction: re-reads conversation + latest inbound source + the
 * matched outbound, re-verifies every fence and the evidence itself, then writes BOTH the source and the
 * conversation plus an append-only, PII-free audit doc. Returns a kind + stale reason; throws nothing for
 * stale states (a stale item is simply not written).
 */
export async function applyInboundCreatorRepairItem(
  tx: RepairTransactionLike,
  item: RepairPlanItem,
  context: RepairApplyContext,
): Promise<{ kind: RepairApplyKind; reason: string; writes: number }> {
  const conversationPath = `conversations/${item.conversationId}`;
  const reviewPath = `reviews/${attributionReviewId(item.conversationId)}`;
  const [conversationSnap, sourceSnap, outboundSnap, reviewSnap, ...restSnaps] = await Promise.all([
    tx.get(conversationPath),
    tx.get(item.sourceRef),
    tx.get(item.outboundRef),
    tx.get(reviewPath),
    ...item.dependencyFingerprints.map((dep) => tx.get(dep.path)),
    ...item.mergedOutboundFingerprints.map((merged) => tx.get(merged.ref)),
  ]);
  const dependencySnaps = restSnaps.slice(0, item.dependencyFingerprints.length);
  const mergedSnaps = restSnaps.slice(item.dependencyFingerprints.length);
  const identityOnly = item.bindingScope === "identity_only";
  // Kill switch re-read for THIS apply: an identity_only item is never written while it is off.
  if (identityOnly && context.allowIdentityOnly !== true) return { kind: "stale", reason: "identity_only_disabled", writes: 0 };
  if (!conversationSnap.exists || !sourceSnap.exists || !outboundSnap.exists) return { kind: "stale", reason: "document_missing", writes: 0 };
  const conversation = conversationSnap.data;
  const source = sourceSnap.data;
  const outbound = outboundSnap.data;

  // Idempotent on (messageSourceRef, evidenceFingerprint, repairPolicyVersion): the very same evidence is
  // already recorded on the source and the unchanged gate already passes.
  const existingBinding = asRecord(source.senderIdentityBinding);
  if (
    existingBinding.decidedBy === "repair"
    && existingBinding.status === "verified"
    && existingBinding.evidenceFingerprint === item.evidenceFingerprint
    && diagnoseBacklogSenderIdentity(source, item.conversationId, context.allowedAccountIds, context.accounts, { allowIdentityOnly: context.allowIdentityOnly === true }).ok
  ) return { kind: "idempotent", reason: "same_evidence_already_applied", writes: 0 };

  if (asString(conversation.lastMessageRef) !== item.sourceRef) return { kind: "stale", reason: "last_message_changed", writes: 0 };
  if (conversationStateFingerprint(conversation) !== item.conversationStateFingerprint) return { kind: "stale", reason: "conversation_state_changed", writes: 0 };
  const finalSource = asString(asRecord(asRecord(conversation.attribution).final).source);
  if (finalSource === "manual" || finalSource === "revert") return { kind: "stale", reason: "manual_decision_preserved", writes: 0 };
  if (conversationAutomaticAttributionFence(conversation) !== item.conversationFence) return { kind: "stale", reason: "attribution_changed", writes: 0 };
  const heldNow = evaluateAutoReplyBacklogSkip(conversation);
  if (heldNow === "aiInactive" || heldNow === "takenOver" || heldNow === "alreadyReplied" || heldNow === "humanReviewHeld") {
    return { kind: "stale", reason: "hold_or_reply_state_changed", writes: 0 };
  }
  if (repairSourceFingerprint(source) !== item.sourceFingerprint) return { kind: "stale", reason: "source_changed", writes: 0 };
  if (outboundFingerprint(outbound) !== item.outboundFingerprint) return { kind: "stale", reason: "outbound_evidence_changed", writes: 0 };
  // Program / campaign ownership inputs of the attribution decision are fenced too: changed => new preview.
  for (let index = 0; index < item.dependencyFingerprints.length; index += 1) {
    const snap = dependencySnaps[index];
    if (dependencyFingerprint(snap.exists ? snap.data : null, item.dependencyFingerprints[index].kind) !== item.dependencyFingerprints[index].fingerprint) {
      return { kind: "stale", reason: "attribution_dependency_changed", writes: 0 };
    }
  }

  // Auto-replies go to the conversation/source recipient: it must STILL be the verified sender.
  const outboundTo = normalizedSingleAddress(asString(outbound.toNormalized, asString(outbound.to, "")));
  for (const target of [source.creatorEmail, conversation.creatorEmail]) {
    if (asString(target) && normalizedSingleAddress(target) !== outboundTo) return { kind: "stale", reason: "reply_target_differs_from_sender", writes: 0 };
  }

  // Re-verify the evidence itself against the fresh documents (the plan is never trusted blindly).
  const evidence = evaluateOutboundSenderEvidence({
    actualFromHash: item.actualFromHash,
    inboundSubject: asString(source.subject, asString(conversation.subject, "")),
    inboundAtIso: asString(source.receivedAtIso, asString(conversation.lastInboundAtIso, "")),
    inboundMailAccountId: context.requestedMailAccountId,
    matchBasis: item.matchBasis,
    outboundRef: item.outboundRef,
    outbound,
    matchedProviderMessageIdHash: item.matchedProviderMessageIdHash,
    matchedTrackingId: item.matchedTrackingId,
    normalizeSubject: normalizeAttributionSubject,
  });
  if (evidence.status !== "verified" || evidence.evidenceKind !== item.evidenceKind) return { kind: "stale", reason: "evidence_no_longer_verified", writes: 0 };
  if (item.mergedOutboundRefs.length > 0) {
    // The merge is re-proven from the fresh docs: same set, unchanged, every member still verified and ONE creator, same proof.
    const freshMerged = item.mergedOutboundFingerprints.map((merged, index) => ({ ref: merged.ref, snap: mergedSnaps[index] }));
    if (freshMerged.some((merged) => !merged.snap.exists || outboundFingerprint(merged.snap.data) !== item.mergedOutboundFingerprints.find((entry) => entry.ref === merged.ref)?.fingerprint)) {
      return { kind: "stale", reason: "merged_outbound_changed", writes: 0 };
    }
    const remerged = evaluateMergedOutboundSenderEvidence({
      identityGroups: readCanonicalIdentityGroups(item.canonicalIdentityGroups), // a pre-0.6.114 preview item carries none
      aliasKeys: readAddressAliasKeys(item.addressAliasKeys),
      actualFromHash: item.actualFromHash,
      inboundSubject: asString(source.subject, asString(conversation.subject, "")),
      inboundAtIso: asString(source.receivedAtIso, asString(conversation.lastInboundAtIso, "")),
      inboundMailAccountId: context.requestedMailAccountId,
      normalizeSubject: normalizeAttributionSubject,
      outbounds: freshMerged.map((merged) => ({ ref: merged.ref, data: merged.snap.data })),
      keysOf: attributionCreatorIdentityKeys,
    });
    if (!remerged.ok || remerged.proving.ref !== item.outboundRef || remerged.refs.join("|") !== [...item.mergedOutboundRefs].sort().join("|")) {
      return { kind: "stale", reason: "merged_identity_no_longer_verified", writes: 0 };
    }
  }

  if (identityOnly) {
    if (!context.freshAddressHistory) return { kind: "stale", reason: "address_history_unavailable", writes: 0 };
    let freshRows: Array<{ path: string; data: Record<string, unknown> }>;
    try {
      const collected = await context.freshAddressHistory(outboundTo, tx);
      if (!collected.complete) return { kind: "stale", reason: "address_history_incomplete", writes: 0 };
      freshRows = collected.rows;
    } catch {
      return { kind: "stale", reason: "address_history_unavailable", writes: 0 };
    }
    const freshHistory = evaluateAddressOutboundHistory({
      identityGroups: readCanonicalIdentityGroups(item.canonicalIdentityGroups), // a pre-0.6.114 preview item carries none
      aliasKeys: readAddressAliasKeys(item.addressAliasKeys),
      address: outboundTo,
      outbounds: freshRows.map((row) => ({ ref: row.path, data: row.data })),
      provingRef: item.outboundRef,
      inboundAtIso: asString(source.receivedAtIso, asString(conversation.lastInboundAtIso, "")),
      keysOf: attributionCreatorIdentityKeys,
    });
    if (!freshHistory.ok || addressHistoryFingerprintOf(freshRows, freshHistory.refs) !== item.addressHistoryFingerprint) {
      return { kind: "stale", reason: "address_history_changed", writes: 0 };
    }
  }

  // Evidence QUERIES and resolution run inside this transaction: evidence inserted concurrently by any
  // writer conflicts with the transaction's reads and forces a retry (then a different digest => stale).
  if (!context.freshResolutionDigest) return { kind: "stale", reason: "fresh_resolution_unavailable", writes: 0 };
  const freshDigest = await context.freshResolutionDigest(item, tx, { source, outbound });
  if (freshDigest !== item.resolutionDigest) return { kind: "stale", reason: "attribution_evidence_changed", writes: 0 };
  // A re-matched identity rests on the WHOLE matcher decision (header / tracking / same-address priority and
  // uniqueness), none of which the attribution digest can see for rows without program context. Re-run the
  // matcher itself in this transaction from the same authenticated inputs: it must still pick the very same
  // outbound by the very same basis, or the item is stale and nothing is written.
  if (item.matchBasis === "address_history" && !identityOnly) return { kind: "stale", reason: "address_history_requires_identity_only", writes: 0 };
  // An address-history item rests on the fenced address history (re-proven above), not on the matcher's pick.
  if (item.identityOrigin === "rematched" && item.matchBasis !== "address_history") {
    if (!item.rematchHeaders || !context.freshRematch) return { kind: "stale", reason: "rematch_unavailable", writes: 0 };
    let fresh: RematchedOutbound;
    try {
      fresh = await context.freshRematch(rematchInputFrom(item.rematchHeaders, {
        fromNormalized: outboundTo,
        subject: asString(source.subject),
        body: asString(source.body),
        receivedAtIso: asString(source.receivedAtIso),
      }), tx);
    } catch {
      return { kind: "stale", reason: "rematch_unavailable", writes: 0 };
    }
    if (item.mergedOutboundRefs.length > 0) {
      // A merged item rests on the matcher STILL reporting exactly this ambiguous from-address set.
      if (
        fresh.kind !== "ambiguous"
        || [...(fresh.eligiblePaths ?? [])].sort().join("|") !== [...item.mergedOutboundRefs].sort().join("|")
      ) return { kind: "stale", reason: "rematch_changed", writes: 0 };
    } else if (
      fresh.kind !== "match"
      || fresh.path !== item.outboundRef
      || fresh.matchBasis !== item.matchBasis
      || (item.matchBasis === "reply_header" && fresh.matchedProviderMessageIdHash !== item.matchedProviderMessageIdHash)
    ) return { kind: "stale", reason: "rematch_changed", writes: 0 };
  }

  const attribution = mergeAutomaticConversationAttribution(conversation, item.resolution, context.nowIso);
  const binding = bindingFor(item, context.nowIso);
  const projected = projectSource(source, {
    provenancePatch: item.provenancePatch,
    inboundSenderHash: item.actualFromHash,
    binding,
    attribution: identityOnly ? null : attribution as unknown as Record<string, unknown>,
  });
  const verdict = diagnoseBacklogSenderIdentity(projected, item.conversationId, context.allowedAccountIds, context.accounts, { allowIdentityOnly: context.allowIdentityOnly === true });
  if (!verdict.ok) return { kind: "stale", reason: `projected_gate_${verdict.reason}`, writes: 0 };

  const topLevel = topLevelAttributionPatch(attribution.final);
  // identity_only writes the binding (+ provenance restore) and NOTHING about attribution/program: the unresolved
  // attribution, its review and the conversation's program fields stay exactly as they were.
  const attributionSourcePatch: Record<string, unknown> = identityOnly ? {} : {
    attribution,
    attributionStatus: attribution.attributionStatus,
    attributionReviewRequired: attribution.reviewRequired,
    ...topLevel,
  };
  const attributionConversationPatch: Record<string, unknown> = identityOnly ? {} : {
    attribution,
    attributionStatus: attribution.attributionStatus,
    attributionReviewRequired: attribution.reviewRequired,
    attributionUpdatedAtIso: context.nowIso,
    ...topLevel,
  };
  const sourcePatch: Record<string, unknown> = {
    ...(item.provenancePatch ?? {}),
    inboundSenderHash: item.actualFromHash,
    senderIdentityBinding: binding,
    // The verified identity outbound is recorded in its own server-owned fields. matchedOutboundRef (program
    // context) is deliberately NOT written: the repair never fabricates a match the ingest did not make.
    senderIdentityOutboundRef: item.outboundRef,
    senderIdentityMatchBasis: item.matchBasis,
    senderIdentityMatchedProviderMessageIdHash: item.matchedProviderMessageIdHash || FieldValue.delete(),
    senderIdentityMatchedTrackingId: item.matchedTrackingId || FieldValue.delete(),
    ...attributionSourcePatch,
  };
  const conversationPatch: Record<string, unknown> = {
    ...attributionConversationPatch,
    // The repair resolved the identity question: drop the stale deny reasons (the dismiss cleanup selects
    // sender_not_creator) — every other gate still re-judges on the next backlog evaluation.
    permitDenyReasons: (Array.isArray(conversation.permitDenyReasons) ? conversation.permitDenyReasons : [])
      .filter((reason: unknown) => reason !== "sender_not_creator" && reason !== "sender_identity_unverified"),
  };
  const auditId = `iar-${sha({
    sourceRef: item.sourceRef,
    evidenceFingerprint: item.evidenceFingerprint,
    policy: INBOUND_CREATOR_ATTRIBUTION_REPAIR_POLICY_VERSION,
    before: repairSourceFingerprint(source),
  }, 40)}`;
  const auditPath = `${AUDITS_COLLECTION}/${auditId}`;
  conversationPatch.lastInboundCreatorAttributionRepairAuditRef = auditPath;
  sourcePatch.inboundCreatorAttributionRepairAuditRef = auditPath;
  tx.set(item.sourceRef, sourcePatch, { merge: true });
  tx.set(conversationPath, conversationPatch, { merge: true });
  let writes = 2;
  if (reviewSnap.exists && !identityOnly) {
    tx.set(reviewPath, { status: "resolved", resolvedAtIso: context.nowIso, updatedAtIso: context.nowIso }, { merge: true });
    writes += 1;
  }
  // No addresses, bodies or names: hashes, refs-as-hashes, digests and codes only.
  tx.create(auditPath, {
    id: auditId,
    action: "inbound_creator_attribution_repair",
    repairPolicyVersion: INBOUND_CREATOR_ATTRIBUTION_REPAIR_POLICY_VERSION,
    senderBindingPolicyVersion: INBOUND_SENDER_BINDING_POLICY_VERSION,
    codeVersion: CODE_VERSION,
    runHash: sha(context.runId),
    conversationHash: item.conversationHash,
    messageSourceRefHash: item.sourceRefHash,
    outboundRefHash: sha(item.outboundRef),
    evidenceFingerprint: item.evidenceFingerprint,
    evidenceKind: item.evidenceKind,
    matchBasis: item.matchBasis,
    identityOrigin: item.identityOrigin,
    bindingScope: item.bindingScope,
    reasonCodes: [
      ...(identityOnly ? ["identity_only_bound"] : []),
      ...(item.mergedOutboundRefs.length > 0 ? ["outbound_same_identity_merged"] : []),
    ],
    mergedOutboundCount: item.mergedOutboundRefs.length,
    provenanceRestored: item.provenancePatch !== null,
    creatorIdentityKeyHash: sha(item.creatorIdentityKey),
    candidateRefHash: sha(item.candidateRef),
    evidenceRefHashes: item.candidateEvidenceRefs.map((ref) => sha(ref, 24)),
    before: {
      sourceDigest: dataDigest(repairSourceFingerprint(source)),
      conversationAttributionDigest: dataDigest(asRecord(conversation.attribution)),
      attributionReviewRequired: asRecord(conversation.attribution).reviewRequired === true,
    },
    after: {
      sourceDigest: dataDigest({ sourcePatchKeys: Object.keys(sourcePatch).sort(), binding: item.evidenceFingerprint }),
      conversationAttributionDigest: dataDigest(identityOnly ? asRecord(conversation.attribution) : attribution),
      attributionReviewRequired: identityOnly ? asRecord(conversation.attribution).reviewRequired === true : attribution.reviewRequired,
      attributionVersion: identityOnly ? Number(asRecord(conversation.attribution).version) || 0 : attribution.version,
    },
    actor: { role: context.actor.role, uidHash: sha(context.actor.userId, 24) },
    createdAtIso: context.nowIso,
    createdAt: FieldValue.serverTimestamp(),
  });
  writes += 1;
  return { kind: "applied", reason: "applied", writes };
}

/** Resolution digest of a fresh attribution run (optionally inside a Firestore transaction). */
export async function freshResolutionDigest(
  item: RepairPlanItem,
  docs: { source: Record<string, unknown>; outbound: Record<string, unknown> },
  deps: { discover: RepairPlanDependencies["discover"]; actor: { userId: string; role: string }; transaction?: Transaction },
): Promise<string> {
  const senderEmail = normalizedSingleAddress(asString(docs.outbound.toNormalized, asString(docs.outbound.to, "")));
  if (!senderEmail || senderEmailHash24(senderEmail) !== item.actualFromHash) return "sender_changed";
  const fresh = await deps.discover({
    conversationId: item.conversationId,
    senderEmail,
    inboundSubject: asString(docs.source.subject, ""),
    inboundBody: asString(docs.source.body, "").slice(0, 20_000),
    receivedAtIso: asString(docs.source.receivedAtIso, ""),
    matchedOutboundRef: item.outboundRef,
    matchBasis: item.matchBasis === "address_history" ? "from_address" : item.matchBasis,
    requesterUid: deps.actor.userId,
    requesterRole: deps.actor.role,
    ...(deps.transaction ? { transaction: deps.transaction } : {}),
  });
  return resolutionDigestOf(fresh.resolution, fresh.rejectedCandidateRefs);
}

/** Non-transactional convenience (tests / diagnostics): same decision as the in-transaction check. */
export async function freshResolutionMatches(
  item: RepairPlanItem,
  deps: { readDoc: RepairPlanDependencies["readDoc"]; discover: RepairPlanDependencies["discover"]; actor: { userId: string; role: string } },
): Promise<boolean> {
  const [source, outbound] = await Promise.all([deps.readDoc(item.sourceRef), deps.readDoc(item.outboundRef)]);
  if (!source || !outbound) return false;
  return (await freshResolutionDigest(item, { source, outbound }, deps)) === item.resolutionDigest;
}

// ── callable ───────────────────────────────────────────────────────────────────────────────────

export type InboundCreatorAttributionRepairDependencies = {
  now?: () => Date;
  nowMs?: () => number;
  readSettings?: typeof readSettings;
  readMailAccounts?: typeof readMailAccounts;
  readConversationPage?: (input: { mailAccountId: string; cutoffIso: string; limit: number; cursor: { lastInboundAtIso: string; id: string } | null }) => Promise<Array<{ id: string; data: Record<string, unknown> }>>;
  readConversationsByIds?: (ids: readonly string[]) => Promise<Array<{ id: string; data: Record<string, unknown> | null }>>;
  readDoc?: (path: string) => Promise<Record<string, unknown> | null>;
  discover?: typeof discoverInboundConversationAttribution;
  detectManualReply?: RepairPlanDependencies["detectManualReply"];
  fetchLive?: RepairPlanDependencies["fetchLive"];
  rematchOutbound?: RepairPlanDependencies["rematchOutbound"];
  outboundsForAddress?: RepairPlanDependencies["outboundsForAddress"];
};

// Lazy: chat-ai.ts is a very large module; the planner/apply core never needs it.
const defaultRematchOutbound: NonNullable<RepairPlanDependencies["rematchOutbound"]> = async (input, transaction) =>
  (await import("./chat-ai")).rematchOutboundForLiveInbound(input, transaction);

const defaultOutboundsForAddress: NonNullable<RepairPlanDependencies["outboundsForAddress"]> = async (address, transaction) =>
  (await import("./chat-ai")).collectOutboundSourcesForRecipientAddress(address, transaction);

type Cursor = { lastInboundAtIso: string; id: string };

function encodeCursor(mailAccountId: string, cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ v: 1, a: mailAccountId, t: cursor.lastInboundAtIso, i: cursor.id })).toString("base64url");
}

function decodeCursor(value: unknown, mailAccountId: string): Cursor | null {
  const raw = asString(value);
  if (!raw) return null;
  try {
    const parsed = asRecord(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (parsed.v !== 1 || parsed.a !== mailAccountId) throw new Error("scope");
    const t = asString(parsed.t);
    const i = asString(parsed.i);
    if (!t || !Number.isFinite(Date.parse(t)) || !CONVERSATION_ID_PATTERN.test(i)) throw new Error("shape");
    return { lastInboundAtIso: t, id: i };
  } catch {
    throw operationError("invalid-argument", "cursor_invalid");
  }
}

async function defaultReadConversationPage(input: { mailAccountId: string; cutoffIso: string; limit: number; cursor: Cursor | null }) {
  let query: FirebaseFirestore.Query = adminDb.collection("conversations")
    .where("mailAccountId", "==", input.mailAccountId)
    .where("lastMessageFrom", "==", "creator")
    .where("autoReplyStatus", "in", [...SELECTABLE_AUTO_REPLY_STATUSES])
    .where("lastInboundAtIso", ">=", input.cutoffIso)
    .orderBy("lastInboundAtIso", "asc")
    .orderBy(FieldPath.documentId(), "asc");
  if (input.cursor) query = query.startAfter(input.cursor.lastInboundAtIso, input.cursor.id);
  const snapshot = await query.limit(input.limit).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() ?? {} }));
}

async function defaultReadConversationsByIds(ids: readonly string[]) {
  if (ids.length === 0) return [];
  const snapshots = await adminDb.getAll(...ids.map((id) => adminDb.collection("conversations").doc(id)));
  return snapshots.map((snapshot, index) => ({ id: ids[index], data: snapshot.exists ? (snapshot.data() ?? {}) : null }));
}

async function defaultReadDoc(path: string): Promise<Record<string, unknown> | null> {
  const snapshot = await adminDb.doc(path).get();
  return snapshot.exists ? (snapshot.data() ?? {}) : null;
}

function readRequest(data: Record<string, unknown>): {
  dryRun: boolean;
  mailAccountId: string;
  cursor: unknown;
  conversationIds: string[] | null;
  limit: number;
  maxAgeHours: number;
} {
  const mailAccountId = asString(data.mailAccountId).trim();
  if (!MAIL_ACCOUNT_ID_PATTERN.test(mailAccountId)) throw operationError("invalid-argument", "mail_account_id_required");
  const hasCursor = data.cursor !== undefined && data.cursor !== null && data.cursor !== "";
  let conversationIds: string[] | null = null;
  if (data.conversationIds !== undefined) {
    if (
      !Array.isArray(data.conversationIds)
      || data.conversationIds.length === 0
      || data.conversationIds.length > MAX_LIMIT
      || data.conversationIds.some((id) => typeof id !== "string" || !CONVERSATION_ID_PATTERN.test(id))
    ) throw operationError("invalid-argument", "conversation_ids_invalid");
    conversationIds = Array.from(new Set(data.conversationIds as string[]));
  }
  if (hasCursor && conversationIds) throw operationError("invalid-argument", "cursor_and_conversation_ids_are_exclusive");
  const limitRaw = data.limit === undefined ? DEFAULT_LIMIT : Number(data.limit);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) throw operationError("invalid-argument", "limit_invalid");
  const maxAgeRaw = data.maxAgeHours === undefined ? MAX_MAX_AGE_HOURS : Number(data.maxAgeHours);
  if (!Number.isInteger(maxAgeRaw) || maxAgeRaw < 1 || maxAgeRaw > MAX_MAX_AGE_HOURS) throw operationError("invalid-argument", "max_age_hours_invalid");
  return {
    dryRun: data.dryRun !== false,
    mailAccountId,
    cursor: hasCursor ? data.cursor : null,
    conversationIds,
    limit: limitRaw,
    maxAgeHours: maxAgeRaw,
  };
}

async function previewPage(
  auth: AuthContext,
  request: ReturnType<typeof readRequest>,
  deps: InboundCreatorAttributionRepairDependencies,
): Promise<InboundCreatorAttributionRepairEnvelope> {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const startedMs = nowMs();
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const accounts = await (deps.readMailAccounts ?? readMailAccounts)();
  if (!accounts.some((account) => account.accountId === request.mailAccountId && account.status === "active")) {
    throw operationError("invalid-argument", "mail_account_unknown");
  }
  const settings = await (deps.readSettings ?? readSettings)();
  const allowedAccountIds = settings.automation.inboundAutoReplyAllowedMailAccountIds;
  const cursor = decodeCursor(request.cursor, request.mailAccountId);
  const cutoffIso = new Date(nowMs() - request.maxAgeHours * 3_600_000).toISOString();
  let candidates: Array<{ id: string; data: Record<string, unknown> | null }>;
  if (request.conversationIds) {
    candidates = await (deps.readConversationsByIds ?? defaultReadConversationsByIds)(request.conversationIds);
  } else {
    candidates = await (deps.readConversationPage ?? defaultReadConversationPage)({
      mailAccountId: request.mailAccountId,
      cutoffIso,
      limit: request.limit,
      cursor,
    });
  }
  const planDeps: RepairPlanDependencies = {
    readDoc: deps.readDoc ?? defaultReadDoc,
    discover: deps.discover ?? discoverInboundConversationAttribution,
    detectManualReply: deps.detectManualReply ?? ((input) => detectManualReplySinceInbound(input)),
    accounts,
    allowedAccountIds,
    fetchLive: deps.fetchLive ?? ((args) => fetchImapMessageByUid(args)),
    // Lazy: chat-ai.ts is a very large module; the planner itself never needs it.
    rematchOutbound: deps.rematchOutbound ?? defaultRematchOutbound,
    nowIso,
    actor: { userId: auth.userId, role: auth.role },
    allowIdentityOnly: identityOnlyAutoReplyEnabled(settings.humanReviewPolicy),
    outboundsForAddress: deps.outboundsForAddress ?? defaultOutboundsForAddress,
  };

  const counts: RepairCounts = { scanned: 0, planned: 0, applied: 0, idempotent: 0, stale: 0, needsHuman: 0, skipped: 0 };
  const reasonCounts: ReasonCounts = {};
  const manifest: ManifestRow[] = [];
  const plan: RepairPlanItem[] = [];
  let lastCursor: Cursor | null = cursor;
  let timedOut = false;
  for (const candidate of candidates) {
    if (nowMs() - startedMs >= SERVER_TIME_BUDGET_MS) {
      timedOut = true;
      break;
    }
    counts.scanned += 1;
    if (candidate.data) {
      lastCursor = { lastInboundAtIso: asString(candidate.data.lastInboundAtIso, ""), id: candidate.id };
    }
    const conversationHash = sha(candidate.id);
    if (!candidate.data) {
      counts.skipped += 1;
      incrementReason(reasonCounts, "conversation_not_found");
      manifest.push({ conversationHash, sourceRefHash: "", evidenceFingerprintHash: "", outcome: "conversation_not_found" });
      continue;
    }
    let outcome: RepairPlanOutcome;
    try {
      outcome = await planInboundCreatorRepair(candidate.id, candidate.data, request.mailAccountId, planDeps);
    } catch (error) {
      counts.skipped += 1;
      incrementReason(reasonCounts, "plan_error");
      console.warn("[repairInboundCreatorAttribution] plan failed", { conversationHash, error: error instanceof Error ? error.message : String(error) });
      manifest.push({ conversationHash, sourceRefHash: "", evidenceFingerprintHash: "", outcome: "plan_error" });
      continue;
    }
    if (outcome.kind === "plan") {
      plan.push(outcome.item);
      counts.planned += 1;
      incrementReason(reasonCounts, "planned");
      incrementReason(reasonCounts, outcome.identityNote);
      incrementReason(reasonCounts, outcome.scopeNote);
      incrementReason(reasonCounts, outcome.canonicalNote);
      manifest.push({ conversationHash, sourceRefHash: outcome.item.sourceRefHash, evidenceFingerprintHash: sha(outcome.item.evidenceFingerprint, 16), outcome: "planned" });
    } else if (outcome.kind === "already_verified") {
      counts.skipped += 1;
      incrementReason(reasonCounts, "already_verified");
      manifest.push({ conversationHash, sourceRefHash: "", evidenceFingerprintHash: "", outcome: "already_verified" });
    } else {
      counts.skipped += 1;
      if (outcome.needsHuman) counts.needsHuman += 1;
      incrementReason(reasonCounts, outcome.reason);
      manifest.push({ conversationHash, sourceRefHash: "", evidenceFingerprintHash: "", outcome: outcome.reason });
    }
  }
  // Account mode pages by the last EXAMINED row (a timeout never skips past an unexamined row); id mode
  // has no cursor. A timeout with zero progress and no inbound cursor returns done:false, no cursor.
  const idMode = request.conversationIds !== null;
  const exhausted = !timedOut && candidates.length < request.limit;
  const nextCursor = idMode || exhausted || !lastCursor ? null : encodeCursor(request.mailAccountId, lastCursor);
  const done = timedOut ? false : nextCursor === null;
  const runId = `iar-run-${randomUUID()}`;
  const previewToken = capabilityToken();
  const previewHash = sha({
    version: INBOUND_CREATOR_ATTRIBUTION_REPAIR_POLICY_VERSION,
    runId,
    mailAccountId: request.mailAccountId,
    plan: plan.map((item) => ({
      conversationHash: item.conversationHash,
      sourceRefHash: item.sourceRefHash,
      conversationFence: item.conversationFence,
      conversationStateFingerprint: item.conversationStateFingerprint,
      sourceFingerprint: item.sourceFingerprint,
      outboundFingerprint: item.outboundFingerprint,
      evidenceFingerprint: item.evidenceFingerprint,
    })),
  }, 64);
  const publicPreview: InboundCreatorAttributionRepairEnvelope = {
    ok: true,
    dryRun: true,
    runId,
    mailAccountId: request.mailAccountId,
    repairPolicyVersion: INBOUND_CREATOR_ATTRIBUTION_REPAIR_POLICY_VERSION,
    nextCursor,
    done,
    readbackVerified: false,
    counts,
    reasonCounts,
    manifest,
    previewToken,
    previewHash,
    mailSent: false,
    enqueued: false,
  };
  const claim: StoredClaim = {
    schemaVersion: INBOUND_CREATOR_ATTRIBUTION_REPAIR_POLICY_VERSION,
    status: "previewed",
    actorUid: auth.userId,
    actorRole: auth.role,
    runId,
    mailAccountId: request.mailAccountId,
    previewHash,
    expiresAtIso: new Date(Date.parse(nowIso) + PREVIEW_TTL_MS).toISOString(),
    publicPreview,
    plan,
  };
  // A preview that plans nothing writes nothing durable besides the claim-less envelope (no token needed).
  if (plan.length > 0) {
    await adminDb.collection(CLAIMS_COLLECTION).doc(`claim-${sha(previewToken, 64)}`).create({
      ...claim,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  return publicPreview;
}

function parseClaim(data: Record<string, unknown> | undefined): StoredClaim {
  const claim = data ?? {};
  if (
    claim.schemaVersion !== INBOUND_CREATOR_ATTRIBUTION_REPAIR_POLICY_VERSION
    || (claim.status !== "previewed" && claim.status !== "applied")
    || !Array.isArray(claim.plan)
  ) throw operationError("failed-precondition", "preview_claim_invalid");
  return claim as unknown as StoredClaim;
}

async function mapWithConcurrency<T, U>(rows: T[], limit: number, mapper: (row: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(rows.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, async () => {
    while (next < rows.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(rows[index]);
    }
  }));
  return results;
}

async function applyPreview(
  auth: AuthContext,
  data: Record<string, unknown>,
  deps: InboundCreatorAttributionRepairDependencies,
): Promise<InboundCreatorAttributionRepairEnvelope> {
  if (asString(data.confirm) !== INBOUND_CREATOR_ATTRIBUTION_REPAIR_CONFIRM_TOKEN) {
    throw operationError("failed-precondition", "explicit_confirmation_required");
  }
  const previewToken = assertCapability(data.previewToken, "preview_token");
  const previewHash = asString(data.previewHash);
  if (!/^[a-f0-9]{64}$/.test(previewHash)) throw operationError("invalid-argument", "preview_hash_required");
  const claimRef = adminDb.collection(CLAIMS_COLLECTION).doc(`claim-${sha(previewToken, 64)}`);
  const claimSnapshot = await claimRef.get();
  if (!claimSnapshot.exists) throw operationError("not-found", "preview_claim_not_found");
  const claim = parseClaim(claimSnapshot.data());
  if (claim.actorUid !== auth.userId) throw operationError("permission-denied", "preview_claim_owner_mismatch");
  if (claim.previewHash !== previewHash) throw operationError("failed-precondition", "preview_hash_mismatch");
  if (claim.status === "applied" && claim.publicApply) return claim.publicApply;
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  if (Date.parse(claim.expiresAtIso) <= Date.parse(nowIso)) throw operationError("failed-precondition", "preview_claim_expired");

  const accounts = await (deps.readMailAccounts ?? readMailAccounts)();
  const settings = await (deps.readSettings ?? readSettings)();
  const context: RepairApplyContext = {
    nowIso,
    runId: claim.runId,
    actor: { userId: auth.userId, role: auth.role },
    allowedAccountIds: settings.automation.inboundAutoReplyAllowedMailAccountIds,
    accounts,
    requestedMailAccountId: claim.mailAccountId,
    allowIdentityOnly: identityOnlyAutoReplyEnabled(settings.humanReviewPolicy),
    freshAddressHistory: (address, tx) => (deps.outboundsForAddress ?? defaultOutboundsForAddress)(address, tx.native as Transaction | undefined),
    freshRematch: (input, tx) => (deps.rematchOutbound ?? defaultRematchOutbound)(input, tx.native as Transaction | undefined),
    freshResolutionDigest: (planItem, tx, docs) => freshResolutionDigest(planItem, docs, {
      discover: deps.discover ?? discoverInboundConversationAttribution,
      actor: { userId: auth.userId, role: auth.role },
      transaction: tx.native as Transaction | undefined,
    }),
  };
  const outcomes = await mapWithConcurrency(claim.plan, 4, async (item) => {
    try {
      const result = await adminDb.runTransaction(async (transaction) => {
        const tx: RepairTransactionLike = {
          native: transaction,
          get: async (path) => {
            const snapshot = await transaction.get(adminDb.doc(path));
            return { exists: snapshot.exists, data: snapshot.data() ?? {} };
          },
          set: (path, value, options) => { transaction.set(adminDb.doc(path), value, options ?? { merge: false }); },
          create: (path, value) => { transaction.create(adminDb.doc(path), value); },
        };
        return applyInboundCreatorRepairItem(tx, item, context);
      });
      return { item, ...result };
    } catch (error) {
      const code = asString((error as { code?: unknown } | null)?.code);
      // already-exists on the append-only audit doc == a concurrent identical apply won the race.
      if (code === "already-exists" || code === "6") return { item, kind: "idempotent" as RepairApplyKind, reason: "audit_already_exists", writes: 0 };
      console.warn("[repairInboundCreatorAttribution] apply failed", { conversationHash: item.conversationHash, error: error instanceof Error ? error.message : String(error) });
      return { item, kind: "engine_error" as RepairApplyKind, reason: "engine_error", writes: 0 };
    }
  });
  const counts: RepairCounts = { ...claim.publicPreview.counts };
  const reasonCounts: ReasonCounts = { ...claim.publicPreview.reasonCounts };
  for (const outcome of outcomes) {
    incrementReason(reasonCounts, `apply_${outcome.kind}${outcome.kind === "stale" ? `:${outcome.reason}` : ""}`);
    if (outcome.kind === "applied") counts.applied += 1;
    else if (outcome.kind === "idempotent") {
      counts.applied += 1;
      counts.idempotent += 1;
    } else counts.stale += 1;
  }
  // Readback: every applied/idempotent source must now pass the UNCHANGED gate.
  let readbackVerified = true;
  for (const outcome of outcomes) {
    if (outcome.kind === "applied" || outcome.kind === "idempotent") {
      const fresh = await (deps.readDoc ?? defaultReadDoc)(outcome.item.sourceRef);
      if (!fresh || !diagnoseBacklogSenderIdentity(fresh, outcome.item.conversationId, context.allowedAccountIds, accounts, { allowIdentityOnly: context.allowIdentityOnly === true }).ok) readbackVerified = false;
    } else if (outcome.kind === "engine_error") readbackVerified = false;
  }
  const publicApply: InboundCreatorAttributionRepairEnvelope = {
    ...claim.publicPreview,
    dryRun: false,
    readbackVerified,
    counts,
    reasonCounts,
    mailSent: false,
    enqueued: false,
  };
  delete publicApply.previewToken;
  delete publicApply.previewHash;
  return adminDb.runTransaction(async (transaction) => {
    const latest = parseClaim((await transaction.get(claimRef)).data());
    if (latest.status === "applied" && latest.publicApply) return latest.publicApply;
    transaction.set(claimRef, { status: "applied", publicApply, appliedAtIso: nowIso, appliedAt: FieldValue.serverTimestamp() }, { merge: true });
    return publicApply;
  });
}

export async function repairInboundCreatorAttribution(
  request: CallableRequestShape,
  deps: InboundCreatorAttributionRepairDependencies = {},
): Promise<InboundCreatorAttributionRepairEnvelope & { behaviorLog: ReturnType<typeof makeBehaviorLog> }> {
  const auth = assertNonGuestAuth(request, ACTION, ["super_admin"]);
  const data = asRecord(request.data);
  if (viewAsRequested(data)) throw operationError("permission-denied", "view_as_not_supported");
  const envelope = data.dryRun !== false
    ? await previewPage(auth, readRequest(data), deps)
    : await applyPreview(auth, data, deps);
  return { ...envelope, behaviorLog: makeBehaviorLog(auth, ACTION, "success") };
}
