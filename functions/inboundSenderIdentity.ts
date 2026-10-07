import { createHash } from "node:crypto";
import { asRecord, asString } from "./shared";
import { CHAT_CASEBOOK } from "./chatCasebook";

/**
 * Inbound sender identity binding (2026-10-03, operator decision: keep `sender_not_creator` exactly as
 * strict as before and fix attribution so legitimate creator replies pass it).
 *
 * Three different things used to be conflated into one `creatorEmail`/`fromHash` pair on an inbound
 * `message_sources` row:
 *   1. the ACTUAL inbound sender  — the server-parsed From address   → `inboundSenderHash`
 *   2. the outreach RECIPIENT     — the To of OUR real sent outbound  → `outreachRecipientHash`
 *   3. the BOUND creator          — what we are willing to treat as "the creator" → `senderIdentityBinding`
 *
 * A binding is `verified` only when (1) equals (2) for a real, prior, single-target outbound of ours.
 * Everything else (tracking id / RFC header / quoted recipient reaching a DIFFERENT From address,
 * display names, free text, same domain, subject similarity, agency/MCN, shared addresses) is
 * `review_required` — a candidate for a human, never an automatic promotion.
 */
export const INBOUND_SENDER_BINDING_POLICY_VERSION = "inbound_sender_binding_v1" as const;

export type SenderBindingMatchBasis = "reply_header" | "tracking_id" | "from_address" | "address_history";
export type SenderBindingEvidenceKind =
  | "from_equals_outbound_recipient"
  | "rfc_reply_from_equals_outbound_recipient"
  | "tracking_from_equals_outbound_recipient";

/**
 * `identity_only` (2026-10-03, operator decision): the sender is VERIFIED as the exact address we really mailed
 * (From == To of a real sent outbound, one consolidated creator) but program/campaign attribution is unresolved.
 * It authorises ONLY the generic casebook templates that need no program facts, and only while
 * humanReviewPolicy.allowIdentityOnlyAutoReply is not switched off. Absent scope = the original program-attributed
 * binding (backward compatible).
 */
export type SenderBindingScope = "program_attributed" | "identity_only";

export type SenderIdentityBinding = {
  policyVersion: typeof INBOUND_SENDER_BINDING_POLICY_VERSION;
  status: "verified" | "review_required";
  bindingScope?: SenderBindingScope;
  reasonCode: string;
  evidenceKind: SenderBindingEvidenceKind | "";
  inboundSenderHash: string;
  outreachRecipientHash: string;
  outboundRef: string;
  matchBasis: string;
  decidedAtIso: string;
  decidedBy: "ingest" | "repair";
  // Only on verified bindings written by the repair path: the ranked attribution candidate this
  // binding was tied to, so the backlog gate can require that candidate to cite the very outbound
  // record that proves From == recipient.
  creatorIdentityKey?: string;
  candidateRef?: string;
  evidenceRefs?: string[];
  evidenceFingerprint?: string;
  // Ranked candidates proven (same outbound / tracking id) to derive from the SAME outreach send as the
  // proving outbound: their identifiers (handle:x, youtube:...) are one creator, never counted twice.
  linkedCandidateRefs?: string[];
  // Explicit identity keys asserted by the proving outbound record itself (creator/channel/handle/youtube/
  // candidate ids of ONE creator): a candidate carrying any of them is that same creator.
  linkedIdentityKeys?: string[];
  // Server-resolved groups of explicit identity keys proven to name ONE channel (see canonicalizeCreatorIdentityKeys).
  // Written only by the ingest / repair that read the backing docs; every gate reads the SAME stored groups.
  // Stored as [{ keys }] (Firestore forbids directly nested arrays); read back through readCanonicalIdentityGroups.
  canonicalIdentityGroups?: Array<{ keys: string[] }>;
  // Keys collapsed into the address identity (docless per-program ids / aliases asserted only by our own single-recipient sends).
  addressAliasKeys?: string[];
  // identity_only repair bindings merged several prior outbounds to the SAME address + SAME consolidated creator:
  // every merged outbound ref (the proving one is `outboundRef`, the most recent prior sent).
  mergedOutboundRefs?: string[];
};

/** Kill switch (default ON per operator decision): only an explicit `false` turns identity_only auto-reply off. */
export function identityOnlyAutoReplyEnabled(humanReviewPolicy: unknown): boolean {
  return asRecord(humanReviewPolicy).allowIdentityOnlyAutoReply !== false;
}

/** Attribution outcomes where program is merely UNRESOLVED (never an ownership conflict between owners). */
export const IDENTITY_ONLY_ATTRIBUTION_REASON_IDS: ReadonlySet<string> = new Set([
  "no_program_evidence_direct",
  "ambiguous_candidate_review",
  "fuzzy_candidate_review",
]);

/**
 * identity_only attribution gate shared by the repair plan, the live ingest and every re-judge. Program attribution is
 * "merely unresolved" for IDENTITY_ONLY_ATTRIBUTION_REASON_IDS, and so is an ownership conflict between programs / owners: the
 * binding claims no program and the template needs none, so a dispute between program owners does not decide who the sender is.
 * Every identity guard (ambiguity / unlinked / rejected competing identity / address history / agency) still runs after this.
 * `programAgnosticProof` (merged outbounds / address-history proof) can never claim a program, so a resolved-program reason
 * is also acceptable there (the binding stays identity_only regardless).
 */
export function identityOnlyAttributionReasonAllowed(
  resolution: { reasonId: string },
  programAgnosticProof = false,
): boolean {
  // Operator policy (2026-10-03, reconfirmed 2026-10-04): "which owner / program, ownership conflicts between programs" does not decide
  // who the sender is. The binding claims no program; every identity guard still runs after this gate.
  if (resolution.reasonId === "ownership_conflict_review") return true;
  return programAgnosticProof || IDENTITY_ONLY_ATTRIBUTION_REASON_IDS.has(resolution.reasonId);
}

/**
 * Cases whose auto-reply template needs program/creator-specific facts (verified application receipt, per-creator
 * status/code/settlement) can never ride an identity_only binding. Fail closed: unknown / template-less case = needs program.
 */
const PROGRAM_FACT_CASE_IDS: ReadonlySet<string> = new Set(["scp_application_received"]);
const PROGRAM_FACT_TOKEN = /^(application|creator|review|program\.(specific|id|title)|campaign)\b/;
export function caseNeedsProgramFacts(caseId: string | null | undefined, hasScpInquiryFacts = false, operatorOverride = false): boolean {
  if (hasScpInquiryFacts) return true;
  // An operator-saved reply is free text the casebook template metadata says nothing about (it may carry per-creator
  // approval / status / code claims): never sendable on an address-only identity.
  if (operatorOverride) return true;
  const id = asString(caseId, "");
  if (!id || PROGRAM_FACT_CASE_IDS.has(id)) return true;
  const entry = CHAT_CASEBOOK.find((item) => item.id === id);
  if (!entry || !entry.autoReplyTemplate) return true;
  return entry.autoReplyTemplate.factTokenIds.some((token) => PROGRAM_FACT_TOKEN.test(token));
}

export function normalizedSingleAddress(value: unknown): string {
  const raw = asString(value, "").trim().toLowerCase();
  if (!raw || /[\s,;<>"()]/.test(raw)) return "";
  return /^[^@]+@[^@]+\.[^@]+$/.test(raw) ? raw : "";
}

export function senderEmailHash24(email: unknown): string {
  const normalized = normalizedSingleAddress(email);
  return normalized ? createHash("sha256").update(normalized).digest("hex").slice(0, 24) : "";
}

const MESSAGE_SOURCE_REF = /^message_sources\/[A-Za-z0-9_.:-]+$/;

export function isMessageSourceRef(value: unknown): boolean {
  return typeof value === "string" && MESSAGE_SOURCE_REF.test(value);
}

function canonicalAccount(value: unknown): string {
  return asString(value, "").trim().toLowerCase() || "scp";
}

export type OutboundSenderEvidenceInput = {
  /** Server-parsed From of the inbound message. Never a caller-supplied candidate/creator email. */
  actualFromEmail?: string;
  /** Alternative to actualFromEmail for rows that only retain the From hash (repair path). */
  actualFromHash?: string;
  inboundSubject?: unknown;
  inboundAtIso?: unknown;
  inboundMailAccountId?: unknown;
  matchBasis: string;
  outboundRef: string;
  outbound: Record<string, unknown> | null;
  /** reply_header only: the hash of the RFC id the matcher used (must equal the outbound's own). */
  matchedProviderMessageIdHash?: string;
  /** tracking_id only: the tracking id the matcher used. */
  matchedTrackingId?: string;
  normalizeSubject: (value: unknown) => string;
};

export type OutboundSenderEvidenceResult = {
  status: "verified" | "review_required";
  reasonCode: string;
  evidenceKind: SenderBindingEvidenceKind | "";
  inboundSenderHash: string;
  outreachRecipientHash: string;
};

/**
 * Pure decision: may the actual sender be treated as the recipient of this real outbound?
 * `verified` requires every one of: single plain From == single plain outbound To, a real prior send
 * (outbound direction + sentAtIso not after the inbound), same mail account scope, and the matcher's
 * own key (RFC hash / tracking id) re-confirmed against the outbound record.
 */
export function evaluateOutboundSenderEvidence(input: OutboundSenderEvidenceInput): OutboundSenderEvidenceResult {
  const suppliedHash = asString(input.actualFromHash, "").toLowerCase();
  const inboundSenderHash = /^[a-f0-9]{24}$/.test(suppliedHash) ? suppliedHash : senderEmailHash24(input.actualFromEmail);
  const outbound = input.outbound;
  const fail = (reasonCode: string, outreachRecipientHash = ""): OutboundSenderEvidenceResult => ({
    status: "review_required",
    reasonCode,
    evidenceKind: "",
    inboundSenderHash,
    outreachRecipientHash,
  });
  if (!inboundSenderHash) return fail("actual_sender_missing");
  if (!outbound || !isMessageSourceRef(input.outboundRef)) return fail("matched_outbound_missing");
  if (asString(outbound.direction, "") !== "outbound") return fail("matched_outbound_not_outbound");
  const toRaw = asString(outbound.toNormalized, asString(outbound.to, asString(outbound.recipientEmail, "")));
  const toAddress = normalizedSingleAddress(toRaw);
  if (!toAddress) return fail("outbound_recipient_not_single_address");
  const outreachRecipientHash = senderEmailHash24(toAddress);
  const storedToHash = asString(outbound.toHash, "").toLowerCase();
  if (storedToHash && /^[a-f0-9]{24}$/.test(storedToHash) && storedToHash !== outreachRecipientHash) {
    return fail("outbound_recipient_hash_conflict", outreachRecipientHash);
  }
  if (outreachRecipientHash !== inboundSenderHash) return fail("sender_differs_from_outreach_recipient", outreachRecipientHash);

  const sentAtMs = Date.parse(asString(outbound.sentAtIso, ""));
  if (!Number.isFinite(sentAtMs)) return fail("outbound_not_sent", outreachRecipientHash);
  // sendEmail stamps sentAtIso on dry-run / mock sends too (deliveryState "mock_sent", dryRun true):
  // those are not a real prior send to a real recipient.
  const deliveryState = asString(outbound.deliveryState, "").trim().toLowerCase();
  if (outbound.dryRun === true || (deliveryState && deliveryState !== "sent")) return fail("outbound_not_live_sent", outreachRecipientHash);
  const inboundAtMs = Date.parse(asString(input.inboundAtIso, ""));
  if (Number.isFinite(inboundAtMs) && sentAtMs > inboundAtMs) return fail("outbound_after_inbound", outreachRecipientHash);
  // The account the message was ACTUALLY sent from: `sendMailAccountId` (stamped by sendEmail on every
  // outbound since 2026-10-03) over the conversation-scoped `mailAccountId`; unstamped legacy rows count
  // as scp only.
  if (canonicalAccount(asString(outbound.sendMailAccountId, "") || asString(outbound.mailAccountId, "")) !== canonicalAccount(input.inboundMailAccountId)) {
    return fail("mail_account_scope_mismatch", outreachRecipientHash);
  }

  let evidenceKind: SenderBindingEvidenceKind;
  if (input.matchBasis === "reply_header") {
    const stored = asString(outbound.providerMessageIdHash, "").toLowerCase();
    if (!stored || stored !== asString(input.matchedProviderMessageIdHash, "").toLowerCase()) {
      return fail("rfc_message_id_not_confirmed", outreachRecipientHash);
    }
    evidenceKind = "rfc_reply_from_equals_outbound_recipient";
  } else if (input.matchBasis === "tracking_id") {
    const tracking = asString(outbound.trackingId, "");
    if (!tracking || tracking !== asString(input.matchedTrackingId, "")) {
      return fail("tracking_id_not_confirmed", outreachRecipientHash);
    }
    evidenceKind = "tracking_from_equals_outbound_recipient";
  } else if (input.matchBasis === "from_address") {
    const inboundSubject = input.normalizeSubject(input.inboundSubject);
    if (!inboundSubject || input.normalizeSubject(outbound.subject) !== inboundSubject) {
      return fail("from_address_subject_mismatch", outreachRecipientHash);
    }
    evidenceKind = "from_equals_outbound_recipient";
  } else if (input.matchBasis === "address_history") {
    // identity_only ONLY (the planner/ingest never lets this basis claim a program): the sender is the exact address of a real,
    // live-sent, single-recipient prior outbound of ours, whatever the subject (a fresh-subject reply). Everything above
    // (single plain From == single plain To, live send before the inbound, same account) still applies.
    evidenceKind = "from_equals_outbound_recipient";
  } else {
    return fail("match_basis_unsupported", outreachRecipientHash);
  }
  return { status: "verified", reasonCode: "verified", evidenceKind, inboundSenderHash, outreachRecipientHash };
}

export type AddressOutboundHistoryResult = { ok: boolean; reasonCode: string; refs: string[]; keys: string[] };

/**
 * Shared-address guard that is INDEPENDENT of program attribution (attribution discards programless / owner-conflicted
 * records, so two creators behind one agency address can both be invisible to it). Every real, live-sent, prior outbound to
 * the verified sender address must consolidate to ONE creator (same rules as the merge) and the proving outbound must be
 * one of them. A multi-recipient outbound that includes the address, or a keyless one next to others, is not provably one
 * creator => not ok (human).
 */
export function evaluateAddressOutboundHistory(input: {
  address: string;
  outbounds: ReadonlyArray<{ ref: string; data: Record<string, unknown> }>;
  provingRef: string;
  inboundAtIso: string;
  keysOf: (doc: Record<string, unknown>) => string[];
  /** Canonical groups (canonicalizeCreatorIdentityKeys) so one channel under different key types is ONE creator. */
  identityGroups?: ReadonlyArray<readonly string[]>;
  /** Address-identity mode (see consolidateOutboundCreatorIdentity); absent = strict. */
  aliasKeys?: readonly string[];
}): AddressOutboundHistoryResult {
  const address = normalizedSingleAddress(input.address);
  const fail = (reasonCode: string): AddressOutboundHistoryResult => ({ ok: false, reasonCode, refs: [], keys: [] });
  if (!address) return fail("address_missing");
  const inboundAtMs = Date.parse(input.inboundAtIso);
  const relevant: Array<{ ref: string; data: Record<string, unknown> }> = [];
  for (const item of input.outbounds) {
    if (asString(item.data.direction, "") !== "outbound") continue;
    const rawTo = asString(item.data.toNormalized, asString(item.data.to, asString(item.data.recipientEmail, ""))).toLowerCase();
    const single = normalizedSingleAddress(rawTo);
    // Sent imports may persist only `toHash`/`toMasked` (no plaintext recipient): a hash match is a recipient match too.
    const storedToHash = asString(item.data.toHash, "").toLowerCase();
    const hashMatches = /^[a-f0-9]{24}$/.test(storedToHash) && storedToHash === senderEmailHash24(address);
    if (single !== address) {
      if (rawTo.includes(address)) return fail("address_history_multi_recipient_outbound");
      // plaintext names another single recipient but the stored hash says this address: inconsistent => not provable
      if (hashMatches && single !== "") return fail("address_history_hash_conflict");
      if (!hashMatches) continue;
    } else if (/^[a-f0-9]{24}$/.test(storedToHash) && !hashMatches) {
      return fail("address_history_hash_conflict");
    }
    const sentAtMs = Date.parse(asString(item.data.sentAtIso, ""));
    const deliveryState = asString(item.data.deliveryState, "").trim().toLowerCase();
    if (!Number.isFinite(sentAtMs) || item.data.dryRun === true || (deliveryState && deliveryState !== "sent")) continue;
    if (Number.isFinite(inboundAtMs) && sentAtMs > inboundAtMs) continue;
    relevant.push(item);
  }
  if (!relevant.some((item) => item.ref === input.provingRef)) return fail("address_history_proving_outbound_missing");
  if (relevant.length === 1) return { ok: true, reasonCode: "single_outbound", refs: [relevant[0].ref], keys: [] };
  const consolidated = consolidateOutboundCreatorIdentity(relevant.map((item) => item.data), input.keysOf, input.identityGroups, input.aliasKeys);
  if (!consolidated.ok) return fail("address_history_creators_differ");
  return { ok: true, reasonCode: "history_consolidated", refs: relevant.map((item) => item.ref).sort(), keys: consolidated.keys };
}

export type MergedOutboundEvidenceInput = Omit<OutboundSenderEvidenceInput, "matchBasis" | "outboundRef" | "outbound" | "matchedProviderMessageIdHash" | "matchedTrackingId"> & {
  outbounds: ReadonlyArray<{ ref: string; data: Record<string, unknown> }>;
  keysOf: (doc: Record<string, unknown>) => string[];
  identityGroups?: ReadonlyArray<readonly string[]>;
  aliasKeys?: readonly string[];
};

export type MergedOutboundEvidenceResult =
  | { ok: false; reasonCode: string }
  | { ok: true; proving: { ref: string; data: Record<string, unknown> }; evidence: OutboundSenderEvidenceResult; keys: string[]; refs: string[] };

/**
 * outbound_match_ambiguous resolution (identity only): several prior same-subject outbounds from-address-matched the
 * inbound. They are one identity ONLY when EVERY one independently verifies (From == its single To, real prior live send,
 * same account) and they consolidate to ONE creator (consolidateOutboundCreatorIdentity). The most recent prior sent one
 * is the proof. Different creators / addresses / a keyless outbound => not ok (stays ambiguous). Never proves a program.
 */
export function evaluateMergedOutboundSenderEvidence(input: MergedOutboundEvidenceInput): MergedOutboundEvidenceResult {
  if (input.outbounds.length < 2 || input.outbounds.length > 10) return { ok: false, reasonCode: "outbound_merge_size_unsupported" };
  const refs = input.outbounds.map((item) => item.ref);
  if (new Set(refs).size !== refs.length) return { ok: false, reasonCode: "outbound_merge_duplicate_ref" };
  const results = input.outbounds.map((item) => evaluateOutboundSenderEvidence({
    actualFromEmail: input.actualFromEmail,
    actualFromHash: input.actualFromHash,
    inboundSubject: input.inboundSubject,
    inboundAtIso: input.inboundAtIso,
    inboundMailAccountId: input.inboundMailAccountId,
    matchBasis: "from_address",
    outboundRef: item.ref,
    outbound: item.data,
    normalizeSubject: input.normalizeSubject,
  }));
  if (results.some((result) => result.status !== "verified")) return { ok: false, reasonCode: "outbound_merge_member_unverified" };
  const consolidated = consolidateOutboundCreatorIdentity(input.outbounds.map((item) => item.data), input.keysOf, input.identityGroups, input.aliasKeys);
  if (!consolidated.ok) return { ok: false, reasonCode: "outbound_merge_creators_differ" };
  const sentAt = (index: number) => Date.parse(asString(input.outbounds[index].data.sentAtIso, ""));
  const order = input.outbounds.map((_, index) => index).sort((a, b) => (sentAt(b) - sentAt(a)) || refs[a].localeCompare(refs[b]));
  const best = order[0];
  return { ok: true, proving: input.outbounds[best], evidence: results[best], keys: consolidated.keys, refs: [...refs].sort() };
}

export type AddressHistoryOutboundEvidenceInput = Omit<OutboundSenderEvidenceInput, "matchBasis" | "outboundRef" | "outbound" | "matchedProviderMessageIdHash" | "matchedTrackingId"> & {
  /** The server-parsed From address (normalized single address): the exact address every proving outbound must have been sent to. */
  address: string;
  outbounds: ReadonlyArray<{ ref: string; data: Record<string, unknown> }>;
};

export type AddressHistoryOutboundEvidenceResult =
  | { ok: false; reasonCode: string }
  | { ok: true; proving: { ref: string; data: Record<string, unknown> }; evidence: OutboundSenderEvidenceResult };

/**
 * identity_only proof when no outbound matched by header / tracking / same subject (a fresh-subject reply): the sender is the
 * EXACT address of at least one real, live-sent, single-recipient prior outbound of ours (message_sources, the same
 * isOwnSingleRecipientSend + evaluateOutboundSenderEvidence verification as every other basis, minus the subject comparison).
 * The most recent such send is the proof. It proves the ADDRESS only — never a program — and the caller must still run the
 * shared-address guard (evaluateAddressOutboundHistory over EVERY prior outbound to the address) before binding.
 */
export function evaluateAddressHistoryOutboundEvidence(input: AddressHistoryOutboundEvidenceInput): AddressHistoryOutboundEvidenceResult {
  const address = normalizedSingleAddress(input.address);
  if (!address) return { ok: false, reasonCode: "address_missing" };
  const verified: Array<{ ref: string; data: Record<string, unknown>; evidence: OutboundSenderEvidenceResult }> = [];
  for (const item of input.outbounds) {
    if (!isMessageSourceRef(item.ref) || asString(item.data.direction, "") !== "outbound") continue;
    if (!isOwnSingleRecipientSend(item.data, item.ref, address)) continue;
    const evidence = evaluateOutboundSenderEvidence({
      actualFromEmail: input.actualFromEmail,
      actualFromHash: input.actualFromHash,
      inboundSubject: input.inboundSubject,
      inboundAtIso: input.inboundAtIso,
      inboundMailAccountId: input.inboundMailAccountId,
      matchBasis: "address_history",
      outboundRef: item.ref,
      outbound: item.data,
      normalizeSubject: input.normalizeSubject,
    });
    if (evidence.status === "verified") verified.push({ ...item, evidence });
  }
  if (verified.length === 0) return { ok: false, reasonCode: "address_history_no_verified_outbound" };
  const sentAt = (item: { data: Record<string, unknown> }) => Date.parse(asString(item.data.sentAtIso, ""));
  verified.sort((a, b) => (sentAt(b) - sentAt(a)) || a.ref.localeCompare(b.ref));
  return { ok: true, proving: { ref: verified[0].ref, data: verified[0].data }, evidence: verified[0].evidence };
}

/** Hash-only, order-stable fingerprint of the evidence a repair/ingest decision relied on. */
export function senderEvidenceFingerprint(parts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(parts, Object.keys(parts).sort())).digest("hex").slice(0, 40);
}

export type SenderBindingGateResult =
  | { ok: true; identityKey: string; outboundRef: string; scope: SenderBindingScope }
  | { ok: false; reason: "binding_missing_legacy" | "identity_binding_review_required" | "identity_binding_invalid" };

/**
 * POSITIVE ALLOWLIST (2026-10-03): an automated reply is eligible only with a CURRENT, `verified`
 * senderIdentityBinding whose hashes agree with the source's own actual-sender hash. Absent (legacy row,
 * or any write that did not come through trusted IMAP ingest / the authenticated repair), review_required
 * or invalid => not eligible. There is deliberately no "no binding => behave as before" branch.
 */
export function readSenderBindingForGate(sourceDoc: Record<string, unknown>): SenderBindingGateResult {
  const raw = sourceDoc.senderIdentityBinding;
  if (raw === undefined || raw === null) return { ok: false, reason: "binding_missing_legacy" };
  const binding = asRecord(raw);
  if (binding.policyVersion !== INBOUND_SENDER_BINDING_POLICY_VERSION) return { ok: false, reason: "identity_binding_invalid" };
  if (binding.status === "review_required") return { ok: false, reason: "identity_binding_review_required" };
  const inboundSenderHash = asString(sourceDoc.inboundSenderHash, "").toLowerCase();
  if (
    binding.status !== "verified"
    || !/^[a-f0-9]{24}$/.test(inboundSenderHash)
    || asString(binding.inboundSenderHash, "").toLowerCase() !== inboundSenderHash
    || asString(binding.outreachRecipientHash, "").toLowerCase() !== inboundSenderHash
    || !isMessageSourceRef(binding.outboundRef)
    || !["from_equals_outbound_recipient", "rfc_reply_from_equals_outbound_recipient", "tracking_from_equals_outbound_recipient"].includes(asString(binding.evidenceKind, ""))
  ) return { ok: false, reason: "identity_binding_invalid" };
  const rawScope = binding.bindingScope;
  if (rawScope !== undefined && rawScope !== "program_attributed" && rawScope !== "identity_only") {
    return { ok: false, reason: "identity_binding_invalid" };
  }
  // The subject-less address-history proof can only ever back an identity_only binding (never a program claim).
  if (binding.matchBasis === "address_history" && rawScope !== "identity_only") return { ok: false, reason: "identity_binding_invalid" };
  if (rawScope === "identity_only") {
    // identity_only proves the ADDRESS only: it must never carry a candidate key (that would be a program binding in disguise).
    if (asString(binding.creatorIdentityKey, "") !== "" || asString(binding.reasonCode, "") !== "identity_only_bound") {
      return { ok: false, reason: "identity_binding_invalid" };
    }
    return { ok: true, identityKey: "", outboundRef: asString(binding.outboundRef, ""), scope: "identity_only" };
  }
  // Address aliases are an identity_only concept: a program-attributed binding that carries any is inconsistent => invalid.
  if (Array.isArray(binding.addressAliasKeys) && binding.addressAliasKeys.length > 0) return { ok: false, reason: "identity_binding_invalid" };
  const identityKey = asString(binding.creatorIdentityKey, "");
  // An ingest-written binding carries no key of its own (the source's own identity fields apply);
  // only a repair-written one adds the bound candidate key.
  return { ok: true, identityKey, outboundRef: identityKey ? asString(binding.outboundRef, "") : "", scope: "program_attributed" };
}

/**
 * Shared-address ambiguity: a ranked candidate naming a DIFFERENT explicit creator (creator:/channel:/
 * handle:/youtube:/candidate: key) than the creator proven by the outreach send. Address-derived
 * `recipient:` keys and `identity:unknown` name no person and are ignored. Identifiers proven equivalent
 * through the same authoritative send (candidates in `linkedRefs`, or citing the proving outbound) are ONE
 * creator and are consolidated before counting — never merged by email alone. Without any linked candidate
 * the rule degrades to "more than one distinct explicit key".
 */
export function hasAmbiguousCreatorIdentity(
  rankedCandidates: unknown,
  provingOutboundRef = "",
  linkedRefs: readonly string[] = [],
  linkedIdentityKeys: readonly string[] = [],
  identityGroups: ReadonlyArray<readonly string[]> = [],
  aliasKeys: readonly string[] = [],
): boolean {
  const linked = new Set(linkedRefs);
  const canon = canonicalKeyOf(identityGroups);
  const aliases = new Set(aliasKeys);
  const linkedKeyHints = new Set(linkedIdentityKeys.map(canon));
  const explicitKey = (record: Record<string, unknown>): string => {
    const key = asString(record.creatorIdentityKey, "");
    return key && key !== "identity:unknown" && !key.startsWith("recipient:") && !aliases.has(key) ? canon(key) : "";
  };
  const rows = (Array.isArray(rankedCandidates) ? rankedCandidates : []).map((value) => asRecord(value));
  const isLinked = (row: Record<string, unknown>): boolean => {
    const ref = asString(row.candidateRef, "");
    const evidenceRefs = Array.isArray(row.evidenceRefs) ? row.evidenceRefs : [];
    const rowKey = asString(row.creatorIdentityKey, "");
    return linked.has(ref)
      || (rowKey !== "" && linkedKeyHints.has(canon(rowKey)))
      || (provingOutboundRef !== "" && (ref === provingOutboundRef || evidenceRefs.includes(provingOutboundRef)));
  };
  const linkedKeys = new Set(rows.filter(isLinked).map(explicitKey).filter(Boolean));
  if (linkedKeys.size === 0) return new Set(rows.map(explicitKey).filter(Boolean)).size > 1;
  return rows.some((row) => {
    if (isLinked(row)) return false;
    const key = explicitKey(row);
    return key !== "" && !linkedKeys.has(key);
  });
}

/**
 * identity_only is stricter than the program path: ANY explicit creator identity on the ranked list must be tied to the
 * proving send. Explicit keys that exist while none is linked (e.g. a forged quoted-recipient block naming another
 * creator) can never ride an identity_only binding. No explicit key at all (address-only) is fine.
 */
export function hasUnlinkedExplicitIdentity(
  rankedCandidates: unknown,
  provingOutboundRef: string,
  linkedRefs: readonly string[] = [],
  linkedIdentityKeys: readonly string[] = [],
  identityGroups: ReadonlyArray<readonly string[]> = [],
  aliasKeys: readonly string[] = [],
): boolean {
  const linked = new Set(linkedRefs);
  const canon = canonicalKeyOf(identityGroups);
  const aliases = new Set(aliasKeys);
  const linkedKeys = new Set(linkedIdentityKeys.map(canon));
  // EVERY explicit-identity row must itself be tied to the proving send (a linked row never vouches for its neighbours).
  return (Array.isArray(rankedCandidates) ? rankedCandidates : []).some((value) => {
    const row = asRecord(value);
    const key = asString(row.creatorIdentityKey, "");
    if (!key || key === "identity:unknown" || key.startsWith("recipient:") || aliases.has(key)) return false;
    const ref = asString(row.candidateRef, "");
    const evidenceRefs = Array.isArray(row.evidenceRefs) ? row.evidenceRefs : [];
    const isLinked = linked.has(ref)
      || linkedKeys.has(canon(key))
      || (provingOutboundRef !== "" && (ref === provingOutboundRef || evidenceRefs.includes(provingOutboundRef)));
    return !isLinked;
  });
}

// ── identity key canonicalization (0.6.114) ─────────────────────────────────────────────────────────
// The same person shows up under different identifier TYPES (creator doc id / handle / YouTube channel) or under several
// per-program creator docs. Two keys are ONE identity only when they share a canonical CHANNEL identifier (YouTube channel
// id or normalized handle) — never an email (an agency address maps to many channels). Resolution reads the backing docs
// (async, fail-closed) and the result is stored on the verified binding as `canonicalIdentityGroups`; every gate (repair
// plan/apply re-check, backlog, live ingest, dispatch) reads those SAME stored groups, so they cannot diverge and the
// dispatch transaction needs no extra reads.

const CANONICAL_KEY_PATTERN = /^(creator|channel|handle|youtube|candidate):[a-z0-9_.:@/-]+$/;
const CANONICAL_KEY_BUDGET = 40;
const CANONICAL_DOC_BUDGET = 16;
const CANONICAL_GROUP_BUDGET = 8;
const CANONICAL_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** Same token normalization the attribution engine applies when it builds a `creator:` key. */
function normalizedCreatorToken(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/^@+/, "").replace(/\s+/g, "");
}

/**
 * lower-cased creator id -> exact id spelling, from records that assert `creatorId` (our own outbound / outreach records).
 * Anything unprovable maps to "": a non-ASCII / oddly-spelled assertion (it would otherwise borrow another record's ASCII
 * spelling for the same normalized key) or two different spellings of one normalized id.
 */
function exactCreatorIdsOf(records: ReadonlyArray<Record<string, unknown>>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const record of records) {
    const raw = typeof record.creatorId === "string" ? record.creatorId : ""; // RAW: surrounding whitespace is not an exact spelling
    if (raw === "") continue;
    const lower = normalizedCreatorToken(raw);
    const provable = raw.length <= 200 && /^[A-Za-z0-9_.-]+$/.test(raw);
    if (!provable) { map[lower] = ""; continue; }
    if (map[lower] === undefined) map[lower] = raw;
    else if (map[lower] !== raw) map[lower] = "";
  }
  return map;
}

/** True when `doc` is OUR OWN real, sent, single-recipient outbound record to exactly `address` (never inbound / quoted / applicant data). */
export function isOwnSingleRecipientSend(doc: Record<string, unknown>, path: string, address: string): boolean {
  if (address === "") return false;
  const collection = path === "" ? "message_sources" : path.slice(0, path.indexOf("/"));
  if (!["message_sources", "campaign_outreach", "scp_coldmail_history", "mail_outbound_log"].includes(collection)) return false;
  if (collection === "message_sources" && asString(doc.direction, "") !== "outbound") return false;
  if (asString(doc.direction, "outbound") !== "outbound") return false;
  if (asString(doc.sentAtIso, asString(doc.deliveredAtIso, "")) === "" || doc.dryRun === true) return false;
  const deliveryState = asString(doc.deliveryState, "").trim().toLowerCase();
  if (deliveryState !== "" && deliveryState !== "sent") return false;
  // Recipient per production schema: plaintext (`toNormalized` / `to` / `recipientEmail`, coldmail history `emailLower` / `email`) and
  // hash (`toHash`, coldmail history `emailHash`, both senderEmailHash24). A MASKED plaintext ("cr***@x") is no plaintext at all: only the
  // hash can prove the recipient. A plaintext single address must equal `address`; a multi-recipient field, another address or a
  // hash / plaintext conflict is never "our single send".
  // campaign_outreach stores its recipient as `creatorEmail` (server-written at createCampaign). Never read it from message_sources:
  // an INBOUND message_sources row carries the sender there.
  const raws = [doc.toNormalized, doc.to, doc.recipientEmail, doc.emailLower, doc.email, collection === "campaign_outreach" ? doc.creatorEmail : undefined]
    .map((value) => asString(value, "").trim().toLowerCase())
    .filter((value) => value !== "");
  if (raws.some((value) => /[,;\s]/.test(value))) return false; // multi-recipient / display-name forms are never "a single send"
  const plain = raws.filter((value) => !value.includes("*"));
  const hashes = [doc.toHash, doc.emailHash].map((value) => asString(value, "").toLowerCase()).filter((value) => value !== "");
  const expectedHash = senderEmailHash24(address);
  if (plain.some((value) => normalizedSingleAddress(value) !== address)) return false;
  if (hashes.some((value) => value !== expectedHash)) return false;
  return plain.length > 0 || hashes.length > 0;
}

/**
 * ONE entry point for repair plan, live ingest and the outbound-merge / address-history re-proofs: collects the explicit keys of
 * the ranked lists, the proving outbound's own keys and any extra keys/records, recovers the exact creator-id spelling from the
 * ranked rows' own evidence docs (bounded), canonicalizes, and finds the keys that add NO competing identity.
 *
 * Address aliases (operator decision 2026-10-03): when the sender is verified as the exact address we mailed, a docless
 * per-program `creator:<id>` (no creators/<exact id> doc) or a handle/channel/youtube alias is NOT a second person if EVERY
 * record asserting it is our own real single-recipient send to that exact address (isOwnSingleRecipientSend). Inbound text,
 * quoted blocks, application docs, multi-recipient sends, another address, a missing evidence doc or an unprovable id spelling
 * keep the key a distinct identity. Existing creators/ docs always stay explicit identities (merged only via youtubeChannelId).
 */
export async function canonicalizeRankedIdentities(
  input: {
    rankedLists?: ReadonlyArray<unknown>;
    linkedKeys?: readonly string[];
    extraKeys?: readonly string[];
    records?: ReadonlyArray<Record<string, unknown>>;
    /** Discovery-REJECTED candidate docs: read as extra assertion sources so a non-own record asserting an alias key poisons it. */
    rejectedRefs?: readonly string[];
    /** The verified sender address (normalized single address); empty disables alias collapsing. */
    senderAddress?: string;
    keysOf?: (doc: Record<string, unknown>) => string[];
    /** The conversation judged: lets its own synthetic human-review queue key `creator:<conversation id>` collapse (see isSelfReviewAssertion). */
    conversationId?: string;
  },
  readDoc: (path: string) => Promise<Record<string, unknown> | null>,
): Promise<CanonicalIdentityResult> {
  const isExplicit = (key: string) => key !== "" && key !== "identity:unknown" && !key.startsWith("recipient:");
  const keys = new Set<string>([...(input.linkedKeys ?? []), ...(input.extraKeys ?? [])].filter(isExplicit));
  const records: Array<Record<string, unknown>> = [...(input.records ?? [])];
  const evidenceDocs: CanonicalIdentityResult["docs"] = [];
  const failed = (field: keyof CanonicalIdentityFailures): CanonicalIdentityResult => ({
    groups: [], aliasKeys: [], docs: evidenceDocs,
    failures: { missing_doc: 0, no_channel: 0, conflict: 0, overflow: 0, read_error: 0, [field]: 1 },
  });
  // Never truncate silently: incomplete exact-id recovery could hide a conflicting spelling => fail closed.
  if (records.length > 100) return failed("overflow");
  const readCache = new Map<string, Record<string, unknown> | null>();
  const poisoned = new Set<string>(); // creator ids whose asserting evidence doc is missing: exact spelling unprovable
  const unverifiedAssertions = new Set<string>(); // keys with a missing / non-own asserting record
  const evidenceByKey = new Map<string, Array<{ path: string; doc: Record<string, unknown> | null }>>();
  try {
    for (const list of input.rankedLists ?? []) {
      for (const value of Array.isArray(list) ? list : []) {
        const row = asRecord(value);
        const key = asString(row.creatorIdentityKey, "");
        if (!isExplicit(key)) continue;
        keys.add(key);
        const paths = [asString(row.candidateRef, ""), ...(Array.isArray(row.evidenceRefs) ? row.evidenceRefs : [])]
          .filter((ref): ref is string => typeof ref === "string" && /^[a-z_]+\/[A-Za-z0-9_.:-]+$/.test(ref));
        if (paths.length > 8) return failed("overflow");
        for (const path of paths) {
          let doc = readCache.get(path);
          if (doc === undefined) {
            if (readCache.size >= 40) return failed("overflow");
            doc = await readDoc(path);
            readCache.set(path, doc);
            evidenceDocs.push({ path, data: doc });
            if (doc) records.push(doc);
          }
          evidenceByKey.set(key, [...(evidenceByKey.get(key) ?? []), { path, doc }]);
          if (!doc) {
            unverifiedAssertions.add(key);
            if (key.startsWith("creator:")) poisoned.add(key.slice("creator:".length));
          }
        }
      }
    }
  } catch {
    return failed("read_error");
  }
  const rejectedDocs: Array<{ path: string; doc: Record<string, unknown> }> = [];
  try {
    for (const path of Array.from(new Set(input.rejectedRefs ?? []))) {
      if (!/^[a-z_]+\/[A-Za-z0-9_.:-]+$/.test(path)) continue;
      let doc = readCache.get(path);
      if (doc === undefined) {
        if (readCache.size >= 40) return failed("overflow");
        doc = await readDoc(path);
        readCache.set(path, doc);
        evidenceDocs.push({ path, data: doc });
        if (doc) records.push(doc);
      }
      if (doc) rejectedDocs.push({ path, doc });
    }
  } catch {
    return failed("read_error");
  }
  const exactIds = exactCreatorIdsOf(records);
  for (const lower of poisoned) exactIds[lower] = "";
  const resolved = await canonicalizeCreatorIdentityKeys(Array.from(keys), readDoc, exactIds);
  const address = normalizedSingleAddress(input.senderAddress ?? "");
  if (address === "" || !input.keysOf || resolved.failures.overflow > 0 || resolved.failures.read_error > 0) {
    return { ...resolved, docs: [...resolved.docs, ...evidenceDocs] };
  }
  // ── address aliases ────────────────────────────────────────────────────────────────────────────
  const keysOf = input.keysOf;
  const selfConversationId = input.conversationId ?? "";
  // The human-review queue row of an inbound conversation (reviews/, source mail_human_review) carries the conversation's OWN id as its
  // creatorId, so attribution ranks it as `creator:<conversation id>`. That key names the conversation, not a person: it is an address
  // alias ONLY when the row is exactly that synthetic queue row AND no real creators/<id> doc exists for the id (the docless rule below).
  const isSelfReviewAssertion = (doc: Record<string, unknown> | null, path: string, key: string): boolean => {
    if (!doc || selfConversationId === "" || !path.startsWith("reviews/")) return false;
    return key === `creator:${normalizedCreatorToken(selfConversationId)}`
      && asString(doc.source, "") === "mail_human_review"
      && asString(doc.conversationId, "") === selfConversationId
      && asString(doc.creatorId, "") === selfConversationId;
  };
  const assertions = new Map<string, boolean>(); // key -> every asserting record is our own single-recipient send to `address`
  const note = (key: string, own: boolean) => assertions.set(key, (assertions.get(key) ?? true) && own);
  for (const record of input.records ?? []) for (const key of keysOf(record).filter(isExplicit)) note(key, isOwnSingleRecipientSend(record, "", address));
  for (const items of evidenceByKey.values()) {
    for (const item of items) {
      if (!item.doc) continue;
      for (const key of keysOf(item.doc).filter(isExplicit)) note(key, isOwnSingleRecipientSend(item.doc, item.path, address) || isSelfReviewAssertion(item.doc, item.path, key));
    }
  }
  for (const item of rejectedDocs) for (const key of keysOf(item.doc).filter(isExplicit)) note(key, isOwnSingleRecipientSend(item.doc, item.path, address));
  const existingChannels = new Set<string>();
  const docByPath = new Map(resolved.docs.map((entry) => [entry.path, entry.data] as const));
  for (const data of docByPath.values()) {
    const channel = data ? asString(data.youtubeChannelId, "") : "";
    if (CANONICAL_CHANNEL_ID.test(channel)) existingChannels.add(channel.toLowerCase());
  }
  const grouped = new Set(resolved.groups.flat());
  const aliasKeys: string[] = [];
  for (const key of keys) {
    if (grouped.has(key) || unverifiedAssertions.has(key) || assertions.get(key) !== true) continue;
    if (key.startsWith("creator:")) {
      const exact = exactIds[key.slice("creator:".length)] ?? "";
      const path = exact !== "" ? `creators/${exact}` : "";
      // docless = a SUCCESSFUL read that found nothing (a read failure already returned above); existing docs stay explicit identities
      if (path !== "" && docByPath.has(path) && docByPath.get(path) === null) aliasKeys.push(key);
    } else if (key.startsWith("handle:")) {
      aliasKeys.push(key);
    } else if (key.startsWith("channel:") || key.startsWith("youtube:")) {
      const token = key.startsWith("channel:") ? key.slice("channel:".length) : youtubeKeyChannelToken(key.slice("youtube:".length));
      // a channel claim must not contradict an existing creator doc's verified channel
      if (key.startsWith("youtube:") && token === "") aliasKeys.push(key);
      else if (token !== "" && (existingChannels.size === 0 || existingChannels.has(token.toLowerCase()))) aliasKeys.push(key);
    }
  }
  aliasKeys.sort();
  if (aliasKeys.length > CANONICAL_KEY_BUDGET) return failed("overflow");
  return { ...resolved, aliasKeys, docs: [...resolved.docs, ...evidenceDocs] };
}

/** Canonical groups + address aliases over the explicit keys of several outbound records (all to `senderAddress`). */
export async function canonicalizeOutboundIdentityKeys(
  outbounds: ReadonlyArray<Record<string, unknown>>,
  keysOf: (doc: Record<string, unknown>) => string[],
  readDoc: (path: string) => Promise<Record<string, unknown> | null>,
  senderAddress = "",
): Promise<CanonicalIdentityResult> {
  return canonicalizeRankedIdentities({ extraKeys: outbounds.flatMap((doc) => keysOf(doc)), records: outbounds, senderAddress, keysOf }, readDoc);
}

export function canonicalKeyOf(groups: ReadonlyArray<readonly string[]>): (key: string) => string {
  const index = new Map<string, string>();
  groups.forEach((group, i) => group.forEach((key) => { if (!index.has(key)) index.set(key, `group:${i}`); }));
  return (key) => index.get(key) ?? key;
}

/** Stored alias keys are untrusted shape-wise: anything malformed or over budget is ignored (no collapsing = strict). */
export function readAddressAliasKeys(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > CANONICAL_KEY_BUDGET) return [];
  const keys: string[] = [];
  for (const key of raw) {
    if (typeof key !== "string" || !CANONICAL_KEY_PATTERN.test(key) || key.startsWith("candidate:")) return [];
    keys.push(key);
  }
  return keys;
}

/** Recognized agency/MCN or vendor actor on the source (model label or operator hold): identity_only stays human. */
export function sourceActorIsAgency(sourceDoc: Record<string, unknown>): boolean {
  const agency = (value: unknown) => value === "agency_mcn" || value === "vendor_or_notification";
  return agency(asRecord(sourceDoc.classification).actorType) || agency(asRecord(sourceDoc.operatorActorHold).actorType);
}

/** In-memory groups (string[][]) -> the Firestore-safe stored shape. */
export function storedIdentityGroups(groups: ReadonlyArray<readonly string[]>): Array<{ keys: string[] }> {
  return groups.map((keys) => ({ keys: [...keys] }));
}

/** Stored groups are untrusted shape-wise: anything malformed or over budget is ignored (no merging = strict). */
export function readCanonicalIdentityGroups(raw: unknown): string[][] {
  if (!Array.isArray(raw) || raw.length > CANONICAL_GROUP_BUDGET) return [];
  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const group = asRecord(entry).keys;
    if (!Array.isArray(group) || group.length < 2 || group.length > CANONICAL_KEY_BUDGET) return [];
    for (const key of group) {
      if (typeof key !== "string" || !CANONICAL_KEY_PATTERN.test(key) || seen.has(key)) return [];
      seen.add(key);
    }
    groups.push([...(group as string[])]);
  }
  return groups;
}

/** Lower-cased YouTube channel id of a `youtube:host/channel/<id>` key (keys are already lower-cased upstream). */
function youtubeKeyChannelToken(hostAndPath: string): string {
  const match = /^(?:www\.|m\.)?youtube\.com\/channel\/(uc[a-z0-9_-]{22})(?:[/?#]|$)/.exec(hostAndPath);
  return match ? match[1] : "";
}

export type CanonicalIdentityFailures = { missing_doc: number; no_channel: number; conflict: number; overflow: number; read_error: number };
export type CanonicalIdentityResult = {
  groups: string[][];
  /** Explicit keys that add NO competing identity: asserted only by our own single-recipient sends to the verified address. */
  aliasKeys: string[];
  /** Every doc the resolution read (path + data, null = absent): the repair fences them in its transactional apply. */
  docs: Array<{ path: string; data: Record<string, unknown> | null }>;
  failures: CanonicalIdentityFailures;
};

/**
 * Resolves explicit identity keys into groups that provably name ONE YouTube channel.
 *
 * Members are `creator:<id>` keys ONLY, and the sole authority is the `youtubeChannelId` of the server-written creators/<id>
 * doc (it has no operator-reachable writer — see scpPortalChannelVerifiedIngress; `creators.channelId`, handles, URLs,
 * applicant-submitted application/lead docs, emails and every `channel:`/`youtube:`/`handle:`/`candidate:` key are
 * forgeable, claimable or case-folded and are NEVER backing facts). Docs without a valid youtubeChannelId, missing docs,
 * overflow, read errors and case-variant channel ids leave the keys un-merged (the strict pre-0.6.114 behaviour). Never throws.
 */
export async function canonicalizeCreatorIdentityKeys(
  rawKeys: readonly string[],
  readDoc: (path: string) => Promise<Record<string, unknown> | null>,
  /** lower-cased key id -> the exact (case-sensitive) creators/ doc id, taken from a record that asserts it. */
  exactIds: Readonly<Record<string, string>> = {},
): Promise<CanonicalIdentityResult> {
  const failures: CanonicalIdentityFailures = { missing_doc: 0, no_channel: 0, conflict: 0, overflow: 0, read_error: 0 };
  const docs: CanonicalIdentityResult["docs"] = [];
  const keys = Array.from(new Set(rawKeys.filter((key) => CANONICAL_KEY_PATTERN.test(key)))).sort();
  if (keys.length < 1) return { groups: [], aliasKeys: [], docs, failures };
  const creatorKeys = keys.filter((key) => key.startsWith("creator:"));
  const docPathOf = (key: string): string => {
    const lower = key.slice("creator:".length);
    // Keys are lower-cased but creators/ doc ids are case-sensitive: ONLY the exact spelling a record asserted is read. No
    // lower-case guess (it could be a different creator's doc), and a collided / absent assertion is unprovable => not merged.
    const id = exactIds[lower] ?? "";
    if (id === "" || id.toLowerCase() !== lower) return "";
    return /^[A-Za-z0-9_.-]+$/.test(id) && id !== "." && id !== ".." ? `creators/${id}` : "";
  };
  if (keys.length > CANONICAL_KEY_BUDGET || creatorKeys.length > CANONICAL_DOC_BUDGET) {
    failures.overflow += 1;
    return { groups: [], aliasKeys: [], docs, failures };
  }
  // Only creators/<id> docs with a verified youtubeChannelId can be members: channel:/youtube:/handle:/candidate: keys come from
  // applicant-claimable URLs/handles (public applications) and case-folded key normalization, so they never join a group.
  const byChannel = new Map<string, string[]>(); // EXACT (case-sensitive) channel id -> creator keys
  try {
    for (const key of creatorKeys) {
      const path = docPathOf(key);
      if (!path) { failures.missing_doc += 1; continue; }
      const data = await readDoc(path);
      docs.push({ path, data });
      if (!data) { failures.missing_doc += 1; continue; }
      const channel = asString(data.youtubeChannelId, "");
      if (!CANONICAL_CHANNEL_ID.test(channel)) { failures.no_channel += 1; continue; }
      byChannel.set(channel, [...(byChannel.get(channel) ?? []), key]);
    }
  } catch {
    failures.read_error += 1;
    return { groups: [], aliasKeys: [], docs, failures };
  }
  // channel ids are case-sensitive: spellings differing only by case are different channels and also never merged with each other
  const lowerSeen = new Map<string, number>();
  for (const channel of byChannel.keys()) lowerSeen.set(channel.toLowerCase(), (lowerSeen.get(channel.toLowerCase()) ?? 0) + 1);
  for (const [channel, members] of byChannel) {
    if ((lowerSeen.get(channel.toLowerCase()) ?? 0) > 1) { failures.conflict += members.length; byChannel.delete(channel); }
  }
  const groups = Array.from(byChannel.values()).filter((members) => members.length > 1).map((members) => members.sort());
  groups.sort((a, b) => a[0].localeCompare(b[0]));
  if (groups.length > CANONICAL_GROUP_BUDGET) { failures.overflow += 1; return { groups: [], aliasKeys: [], docs, failures }; }
  return { groups, aliasKeys: [], docs, failures };
}

/**
 * Several prior outbounds to the SAME single address are ONE creator only when every one carries an explicit identity
 * key, the keys are connected (shared key chain), and no authoritative id type (creator/channel/candidate) disagrees.
 * Anything else (different creators on one address, a keyless outbound) stays ambiguous.
 */
export function consolidateOutboundCreatorIdentity(
  outbounds: ReadonlyArray<Record<string, unknown>>,
  keysOf: (doc: Record<string, unknown>) => string[],
  identityGroups: ReadonlyArray<readonly string[]> = [],
  /** Present (even empty) = address-identity mode: alias keys and keyless outbounds add no competing identity. Absent = strict. */
  aliasKeys?: readonly string[],
): { ok: boolean; keys: string[] } {
  if (outbounds.length === 0) return { ok: false, keys: [] };
  const canon = canonicalKeyOf(identityGroups);
  const aliases = new Set(aliasKeys ?? []);
  const allSets = outbounds.map((doc) => new Set(keysOf(doc).filter((key) => key !== "identity:unknown" && !key.startsWith("recipient:") && !aliases.has(key))));
  if (aliasKeys === undefined && allSets.some((set) => set.size === 0)) return { ok: false, keys: [] };
  const sets = allSets.filter((set) => set.size > 0);
  if (sets.length === 0) return { ok: true, keys: [] };
  const union = new Set<string>();
  for (const set of sets) for (const key of set) union.add(key);
  // creator / candidate ids: more than one DISTINCT id is two creators — unless the canonical groups prove they share one channel.
  for (const type of ["creator:", "candidate:"]) {
    if (new Set([...union].filter((key) => key.startsWith(type)).map(canon)).size > 1) return { ok: false, keys: [] };
  }
  // A YouTube channel id is authoritative however it is spelled (`channel:UC…` key or a `/channel/UC…` URL key): two
  // different channel ids can never be one creator, even when a handle alias connects them.
  const channelIds = new Set<string>();
  for (const key of union) {
    if (key.startsWith("channel:")) channelIds.add(key.slice("channel:".length).toLowerCase());
    else if (key.startsWith("youtube:")) {
      const match = /\/channel\/([^/?#]+)/i.exec(key);
      if (match) channelIds.add(match[1].toLowerCase());
    }
  }
  if (channelIds.size > 1) return { ok: false, keys: [] };
  // connectivity (through canonical identities): grow a component from the first outbound through shared keys
  const canonSets = sets.map((set) => new Set([...set].map(canon)));
  const component = new Set(canonSets[0]);
  const joined = new Set([0]);
  let progressed = true;
  while (progressed && joined.size < canonSets.length) {
    progressed = false;
    canonSets.forEach((set, index) => {
      if (joined.has(index)) return;
      if ([...set].some((key) => component.has(key))) {
        joined.add(index);
        for (const key of set) component.add(key);
        progressed = true;
      }
    });
  }
  return joined.size === canonSets.length ? { ok: true, keys: [...union].sort() } : { ok: false, keys: [] };
}

/**
 * A verified binding must tie the ATTRIBUTED creator to the outbound that proved From == recipient: at least
 * one ranked candidate cites that outbound, is provably the same send, or carries an identifier the outbound
 * itself asserts. Otherwise the attribution came from somewhere else entirely (e.g. a forged quoted-recipient
 * block naming another creator) and the binding proves nothing about it.
 */
export function hasCandidateLinkedToProvingSend(
  rankedCandidates: unknown,
  provingOutboundRef: string,
  linkedRefs: readonly string[] = [],
  linkedIdentityKeys: readonly string[] = [],
): boolean {
  if (!provingOutboundRef) return false;
  const refs = new Set(linkedRefs);
  const keys = new Set(linkedIdentityKeys);
  return (Array.isArray(rankedCandidates) ? rankedCandidates : []).some((value) => {
    const row = asRecord(value);
    const ref = asString(row.candidateRef, "");
    const evidenceRefs = Array.isArray(row.evidenceRefs) ? row.evidenceRefs : [];
    return refs.has(ref) || ref === provingOutboundRef || evidenceRefs.includes(provingOutboundRef)
      || keys.has(asString(row.creatorIdentityKey, ""));
  });
}

/**
 * Reads the candidate docs that are NOT directly citing the proving outbound and reports those that are
 * provably the same outreach send (same tracking id / message ref) — e.g. the scp_coldmail_history row
 * `cmh_<trackingId>` that carries the creator's YouTube URL while the message source carries the handle.
 */
export async function computeLinkedCandidateRefs(
  rankedCandidates: ReadonlyArray<{ candidateRef: string; evidenceRefs: readonly string[] }>,
  outboundRef: string,
  outbound: Record<string, unknown>,
  readDoc: (path: string) => Promise<Record<string, unknown> | null>,
): Promise<string[]> {
  const trackingId = asString(outbound.trackingId, "");
  const linked: string[] = [];
  for (const candidate of rankedCandidates.slice(0, 20)) {
    if (candidate.candidateRef === outboundRef || candidate.evidenceRefs.includes(outboundRef)) {
      linked.push(candidate.candidateRef);
      continue;
    }
    // Attribution groups several documents under one representative candidateRef (the smallest id) and keeps
    // the rest in evidenceRefs: ANY grouped evidence doc proving the same send links the whole candidate.
    const docRefs = Array.from(new Set([candidate.candidateRef, ...candidate.evidenceRefs]))
      .filter((ref) => /^[a-z_]+\/[A-Za-z0-9_.:-]+$/.test(ref))
      .slice(0, 10);
    for (const ref of docRefs) {
      const doc = await readDoc(ref);
      if (!doc) continue;
      if (
        (trackingId !== "" && asString(doc.trackingId, "") === trackingId)
        || asString(doc.messageRef, "") === outboundRef
        || asString(doc.outboundRef, "") === outboundRef
      ) {
        linked.push(candidate.candidateRef);
        break;
      }
    }
  }
  return linked;
}

/**
 * Non-empty reason when a persisted source is NOT eligible for ANY automated reply (live dispatch, backlog,
 * case backlog send). Positive allowlist: needs a current verified binding (or the personal-account
 * registry marker, a separate server-stamped allowlist) and an unambiguous creator.
 */
export function personalRegistered(sourceDoc: Record<string, unknown>): boolean {
  return sourceDoc.counterpartyRegistered === true
    && /^candidate_pool\/[A-Za-z0-9_.:-]+$/.test(asString(sourceDoc.candidateRef, ""));
}

export type SenderBindingBlockOptions = {
  /** humanReviewPolicy.allowIdentityOnlyAutoReply (kill switch). Default false: fail closed unless the caller passes the setting. */
  allowIdentityOnly?: boolean;
  /** The case this send would answer; identity_only is refused when it needs program facts. */
  caseId?: string | null;
  /** True when the send carries per-creator SCP inquiry facts (always program/creator specific). */
  scpInquiry?: boolean;
  /** True when the case reply is an operator-saved override instead of the casebook template. */
  operatorOverride?: boolean;
};

export function senderBindingBlockReason(sourceDoc: Record<string, unknown>, options: SenderBindingBlockOptions = {}): string {
  // Personal accounts are NOT exempt: the registry marker never proves the sender is the creator the
  // outreach context names, so a verified actual-sender binding is required on every automatic path.
  const gate = readSenderBindingForGate(sourceDoc);
  if (!gate.ok) return gate.reason;
  const binding = asRecord(sourceDoc.senderIdentityBinding);
  const linkedRefs = Array.isArray(binding.linkedCandidateRefs) ? binding.linkedCandidateRefs.filter((v): v is string => typeof v === "string") : [];
  const linkedKeys = Array.isArray(binding.linkedIdentityKeys) ? binding.linkedIdentityKeys.filter((v): v is string => typeof v === "string") : [];
  const ranked = asRecord(sourceDoc.attribution).rankedCandidates;
  const groups = readCanonicalIdentityGroups(binding.canonicalIdentityGroups);
  const aliasKeys = gate.scope === "identity_only" ? readAddressAliasKeys(binding.addressAliasKeys) : [];
  if (hasAmbiguousCreatorIdentity(ranked, asString(binding.outboundRef, ""), linkedRefs, linkedKeys, groups, aliasKeys)) return "identity_ambiguous";
  if (gate.scope === "identity_only") {
    if (options.allowIdentityOnly !== true) return "identity_only_disabled";
    if (personalRegistered(sourceDoc)) return "identity_only_not_for_personal";
    if (sourceActorIsAgency(sourceDoc)) return "identity_only_agency_actor";
    if (hasUnlinkedExplicitIdentity(ranked, asString(binding.outboundRef, ""), linkedRefs, linkedKeys, groups, aliasKeys)) return "identity_candidate_unlinked";
    if (caseNeedsProgramFacts(options.caseId, options.scpInquiry === true, options.operatorOverride === true)) return "identity_only_case_needs_program";
    return "";
  }
  // A personal-account registry match (server-stamped candidate_pool ref) has no attribution candidates by
  // nature; its identity link is that registry entry plus the verified binding.
  if (personalRegistered(sourceDoc)) return "";
  return hasCandidateLinkedToProvingSend(ranked, asString(binding.outboundRef, ""), linkedRefs, linkedKeys) ? "" : "identity_candidate_unlinked";
}

/**
 * Attribution discovery drops ownership/program-conflicted candidates BEFORE ranking, so a second creator
 * sharing the address can be invisible in the ranked list. Every rejected evidence doc is therefore checked
 * here: it conflicts when it asserts an explicit creator identity that is neither one of the proving
 * outbound's own identifiers / a linked candidate's identity nor provably the same outreach send.
 */
export async function hasCompetingRejectedIdentity(
  rejectedRefs: readonly string[],
  outboundRef: string,
  outbound: Record<string, unknown>,
  knownKeys: readonly string[],
  keysOf: (doc: Record<string, unknown>) => string[],
  readDoc: (path: string) => Promise<Record<string, unknown> | null>,
  /**
   * identity_only mode (verified address, no program claim): a rejected doc that is OUR OWN real single-recipient send to exactly
   * the verified address names no other person — its keys are non-competing when they are address aliases, canonical-group
   * members of a known key, or a lead/application `candidate:` id. Anything else (an existing creators/ identity that is not
   * grouped, a non-own record: application / quoted / multi-recipient / another address) still competes.
   */
  identityOnly?: { address: string; groups: ReadonlyArray<readonly string[]>; aliasKeys: readonly string[] },
): Promise<boolean> {
  // Never truncate silently: more rejected refs than the inspection budget is itself a human case.
  if (rejectedRefs.length > 50) return true;
  const known = new Set(knownKeys);
  const canon = canonicalKeyOf(identityOnly?.groups ?? []);
  const knownCanon = new Set(knownKeys.map(canon));
  const aliases = new Set(identityOnly?.aliasKeys ?? []);
  const trackingId = asString(outbound.trackingId, "");
  for (const ref of rejectedRefs) {
    if (!/^[a-z_]+\/[A-Za-z0-9_.:-]+$/.test(ref) || ref === outboundRef) continue;
    const doc = await readDoc(ref);
    if (!doc) continue;
    const sameSend = (trackingId !== "" && asString(doc.trackingId, "") === trackingId)
      || asString(doc.messageRef, "") === outboundRef
      || asString(doc.outboundRef, "") === outboundRef;
    if (sameSend) continue;
    const ownSend = identityOnly !== undefined && isOwnSingleRecipientSend(doc, ref, identityOnly.address);
    if (keysOf(doc).some((key) => !known.has(key)
      && !knownCanon.has(canon(key))
      && !(identityOnly !== undefined && aliases.has(key))
      && !(ownSend && key.startsWith("candidate:")))) return true;
  }
  return false;
}
