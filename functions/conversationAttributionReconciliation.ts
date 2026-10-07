import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  FieldPath,
  FieldValue,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  conversationAutomaticAttributionFence,
  discoverInboundConversationAttribution,
  materializeAutomaticConversationAttribution,
  type ConversationAttributionResolution,
} from "./conversationAttribution";
import {
  CONVERSATION_ATTRIBUTION_RECONCILIATION_VERSION,
  boundedConversationAttributionPageSize,
  classifyConversationAttributionReconciliationCandidate,
  conversationAttributionResolutionNeedsMaterialization,
  redactConversationAttributionResolutionEvidence,
  stableConversationAttributionHash,
} from "./conversationAttributionReconciliationCore";
import { assertNonGuestAuth, asRecord, asString, type AuthContext, type CallableRequestShape } from "./shared";

const ACTION = "conversation_attribution.reconcile";
const WRITE_ROLES = ["super_admin", "admin"] as const;
const SOURCE_COLLECTION = "conversations";
const RUNS_COLLECTION = "conversation_attribution_reconciliation_runs";
const CLAIMS_COLLECTION = "conversation_attribution_reconciliation_preview_claims";
const CURSORS_COLLECTION = "conversation_attribution_reconciliation_cursors";
const AUDITS_COLLECTION = "conversation_attribution_reconciliation_audits";
const PREVIEW_TTL_MS = 2 * 60 * 60 * 1000;

type ReasonCounts = Record<string, number>;
type ReconciliationCounts = {
  scanned: number;
  eligible: number;
  planned: number;
  skipped: number;
  applied: number;
  stale: number;
  idempotent: number;
};

type ReconciliationTargetCount = {
  primaryBucket: "program" | "direct";
  programId: string | null;
  campaignId: string | null;
  planned: number;
};

export type ConversationAttributionReconciliationEnvelope = {
  ok: true;
  dryRun: boolean;
  runId: string;
  watermarkHash: string;
  cursor: string | null;
  nextCursor: string | null;
  done: boolean;
  complete: boolean;
  readbackVerified: boolean;
  pageSize: number;
  counts: ReconciliationCounts;
  reasonCounts: ReasonCounts;
  targetCounts: ReconciliationTargetCount[];
  previewToken?: string;
  previewHash?: string;
};

type StoredRun = {
  schemaVersion: typeof CONVERSATION_ATTRIBUTION_RECONCILIATION_VERSION;
  runId: string;
  actorUid: string;
  actorRole: string;
  pageSize: number;
  watermarkDocumentId: string;
  watermarkReadTimeIso: string;
  watermarkHash: string;
  createdAtIso: string;
};

type StoredPlanItem = {
  conversationId: string;
  conversationHash: string;
  expectedAttributionVersion: number;
  expectedStateFingerprint: string;
  reconciliationMessageRef: string;
  resolution: ConversationAttributionResolution;
  rejectedCandidateRefs: string[];
  ownerUid?: string;
};

type StoredClaim = {
  schemaVersion: typeof CONVERSATION_ATTRIBUTION_RECONCILIATION_VERSION;
  status: "previewed" | "applied";
  actorUid: string;
  actorRole: string;
  runId: string;
  pageKey: string;
  previewHash: string;
  expiresAtIso: string;
  publicPreview: ConversationAttributionReconciliationEnvelope;
  plan: StoredPlanItem[];
  previousClaimRef?: string;
  publicApply?: ConversationAttributionReconciliationEnvelope;
};

function operationError(
  code: "invalid-argument" | "permission-denied" | "not-found" | "failed-precondition" | "aborted",
  reason: string,
): Error {
  return Object.assign(new Error(`${code}: ${reason}`), { code });
}

function incrementReason(counts: ReasonCounts, reason: string, amount = 1): void {
  if (!reason) return;
  counts[reason] = (counts[reason] ?? 0) + amount;
}

function emptyCounts(): ReconciliationCounts {
  return { scanned: 0, eligible: 0, planned: 0, skipped: 0, applied: 0, stale: 0, idempotent: 0 };
}

function reconciliationTargetCounts(plan: StoredPlanItem[]): ReconciliationTargetCount[] {
  const counts = new Map<string, ReconciliationTargetCount>();
  for (const item of plan) {
    const final = item.resolution.final;
    const programId = final.primaryBucket === "program" ? resolveProgramIdForReadback(final.programId) : "";
    const campaignId = programId ? asString(final.campaignId) : "";
    const key = `${final.primaryBucket}|${programId}|${campaignId}`;
    const current = counts.get(key);
    counts.set(key, {
      primaryBucket: final.primaryBucket,
      programId: programId || null,
      campaignId: campaignId || null,
      planned: (current?.planned ?? 0) + 1,
    });
  }
  return [...counts.values()].sort((left, right) => (
    right.planned - left.planned
    || `${left.primaryBucket}|${left.programId}|${left.campaignId}`.localeCompare(`${right.primaryBucket}|${right.programId}|${right.campaignId}`)
  ));
}

function capabilityToken(): string {
  return `${randomUUID()}.${randomBytes(24).toString("base64url")}`;
}

function capabilityHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertCapability(value: unknown, label: string): string {
  const token = asString(value);
  if (!/^[A-Za-z0-9._-]{32,200}$/.test(token)) throw operationError("invalid-argument", `${label}_required`);
  return token;
}

function timestampIso(snapshot: { readTime: { toDate(): Date } }): string {
  return snapshot.readTime.toDate().toISOString();
}

function snapshotChangedAfterWatermark(snapshot: QueryDocumentSnapshot, watermarkMs: number): boolean {
  return snapshot.createTime.toMillis() > watermarkMs || snapshot.updateTime.toMillis() > watermarkMs;
}

function validMessageSourceRef(value: unknown): string {
  const ref = asString(value);
  return /^message_sources\/[A-Za-z0-9_.:-]+$/.test(ref) ? ref : "";
}

function sourceForConversation(
  conversation: Record<string, unknown>,
  source: Record<string, unknown>,
): {
  senderEmail?: string;
  inboundSubject?: string;
  inboundBody?: string;
  receivedAtIso?: string;
  matchedOutboundRef?: string;
  matchBasis?: string;
  quotedOriginalRecipientEmail?: string;
} {
  const normalizeSender = (value: unknown): string => {
    const email = asString(value).trim().toLowerCase();
    return email.includes("@") && !/[\s*]/.test(email) ? email : "";
  };
  const fromNormalized = normalizeSender(source.fromNormalized);
  const fromHash = asString(source.fromHash).toLowerCase();
  const verifiedFromNormalized = fromNormalized
    && /^[a-f0-9]{24}$/.test(fromHash)
    && createHash("sha256").update(fromNormalized).digest("hex").slice(0, 24) === fromHash
    ? fromNormalized
    : "";
  const canonicalSender = normalizeSender(source.creatorEmail)
    || normalizeSender(conversation.creatorEmail);
  // `source.from` is a masked display value on live inbound rows. Only use an
  // unmasked legacy value when no canonical or hash-verified identity exists.
  const sender = canonicalSender
    || verifiedFromNormalized
    || normalizeSender(source.from);
  return {
    ...(sender.includes("@") ? { senderEmail: sender } : {}),
    ...(asString(source.subject, asString(conversation.subject, asString(conversation.title)))
      ? { inboundSubject: asString(source.subject, asString(conversation.subject, asString(conversation.title))) }
      : {}),
    ...(asString(source.body, asString(conversation.lastMessage))
      ? { inboundBody: asString(source.body, asString(conversation.lastMessage)) }
      : {}),
    ...(asString(source.receivedAtIso, asString(conversation.lastMessageAtIso))
      ? { receivedAtIso: asString(source.receivedAtIso, asString(conversation.lastMessageAtIso)) }
      : {}),
    ...(validMessageSourceRef(source.matchedOutboundRef ?? conversation.matchedOutboundRef)
      ? { matchedOutboundRef: validMessageSourceRef(source.matchedOutboundRef ?? conversation.matchedOutboundRef) }
      : {}),
    ...(asString(source.matchedOutboundMatchBasis, asString(conversation.matchedOutboundMatchBasis))
      ? { matchBasis: asString(source.matchedOutboundMatchBasis, asString(conversation.matchedOutboundMatchBasis)) }
      : {}),
    // conv_13ioeao: only present on message_sources rows ingested after this fix shipped.
    ...(asString(source.quotedOriginalRecipientEmail)
      ? { quotedOriginalRecipientEmail: asString(source.quotedOriginalRecipientEmail) }
      : {}),
  };
}

async function mapWithConcurrency<T, U>(
  rows: T[],
  limit: number,
  mapper: (row: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(rows.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(rows[index], index);
    }
  }));
  return results;
}

function parseRun(snapshot: DocumentSnapshot): StoredRun {
  const data = snapshot.data() ?? {};
  if (
    data.schemaVersion !== CONVERSATION_ATTRIBUTION_RECONCILIATION_VERSION ||
    asString(data.runId) !== snapshot.id ||
    !asString(data.actorUid) ||
    !asString(data.watermarkReadTimeIso)
  ) throw operationError("failed-precondition", "reconciliation_run_invalid");
  return data as StoredRun;
}

function assertRunOwner(run: StoredRun, auth: AuthContext): void {
  if (run.actorUid !== auth.userId) throw operationError("permission-denied", "reconciliation_run_owner_mismatch");
}

async function startRun(auth: AuthContext, pageSize: number): Promise<StoredRun> {
  // The Firestore emulator rejects descending __name__ scans even though the
  // production service supports them. Preserve the stronger production max-id
  // fence, and use the read-time fence in emulator verification. Both paths
  // reject documents created/updated after the run started.
  const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  const watermarkSnapshot = await adminDb.collection(SOURCE_COLLECTION)
    .orderBy(FieldPath.documentId(), emulator ? "asc" : "desc")
    .limit(1)
    .get();
  const runId = `car-${randomUUID()}`;
  const watermarkDocumentId = emulator ? "" : watermarkSnapshot.docs[0]?.id ?? "";
  const watermarkReadTimeIso = timestampIso(watermarkSnapshot);
  const run: StoredRun = {
    schemaVersion: CONVERSATION_ATTRIBUTION_RECONCILIATION_VERSION,
    runId,
    actorUid: auth.userId,
    actorRole: auth.role,
    pageSize,
    watermarkDocumentId,
    watermarkReadTimeIso,
    watermarkHash: stableConversationAttributionHash({ watermarkDocumentId, watermarkReadTimeIso }, 32),
    createdAtIso: new Date().toISOString(),
  };
  await adminDb.collection(RUNS_COLLECTION).doc(runId).create({
    ...run,
    createdAt: FieldValue.serverTimestamp(),
  });
  return run;
}

async function loadRun(auth: AuthContext, runId: string, pageSize: number): Promise<StoredRun> {
  if (!/^car-[A-Za-z0-9-]{30,100}$/.test(runId)) throw operationError("invalid-argument", "run_id_invalid");
  const snapshot = await adminDb.collection(RUNS_COLLECTION).doc(runId).get();
  if (!snapshot.exists) throw operationError("not-found", "reconciliation_run_not_found");
  const run = parseRun(snapshot);
  assertRunOwner(run, auth);
  if (run.pageSize !== pageSize) throw operationError("failed-precondition", "page_size_drift");
  return run;
}

async function cursorPosition(
  auth: AuthContext,
  run: StoredRun,
  cursor: unknown,
): Promise<{ startAfterDocumentId: string; previousClaimRef: string }> {
  const token = asString(cursor);
  if (!token) return { startAfterDocumentId: "", previousClaimRef: "" };
  assertCapability(token, "cursor");
  const snapshot = await adminDb.collection(CURSORS_COLLECTION).doc(`cursor-${capabilityHash(token)}`).get();
  const data = snapshot.data() ?? {};
  if (!snapshot.exists || asString(data.runId) !== run.runId) throw operationError("failed-precondition", "cursor_scope_invalid");
  if (asString(data.actorUid) !== auth.userId) throw operationError("permission-denied", "cursor_owner_mismatch");
  if (Date.parse(asString(data.expiresAtIso)) <= Date.now()) throw operationError("failed-precondition", "cursor_expired");
  const previousClaimRef = asString(data.previousClaimRef);
  if (!/^conversation_attribution_reconciliation_preview_claims\/claim-[a-f0-9]{64}$/.test(previousClaimRef)) {
    throw operationError("failed-precondition", "cursor_lineage_invalid");
  }
  return {
    startAfterDocumentId: asString(data.startAfterDocumentId),
    previousClaimRef,
  };
}

function publicPreviewFromStored(value: unknown): ConversationAttributionReconciliationEnvelope {
  const data = asRecord(value);
  return data as ConversationAttributionReconciliationEnvelope;
}

async function previewPage(
  auth: AuthContext,
  data: Record<string, unknown>,
): Promise<ConversationAttributionReconciliationEnvelope> {
  if (data.actual === true) throw operationError("failed-precondition", "dry_run_cannot_be_actual");
  const pageSize = boundedConversationAttributionPageSize(data.pageSize);
  const requestedRunId = asString(data.runId);
  const run = requestedRunId ? await loadRun(auth, requestedRunId, pageSize) : await startRun(auth, pageSize);
  const cursorState = await cursorPosition(auth, run, data.cursor);
  const { startAfterDocumentId } = cursorState;
  const pageKey = stableConversationAttributionHash({
    runId: run.runId,
    startAfterDocumentId,
    watermarkDocumentId: run.watermarkDocumentId,
    watermarkReadTimeIso: run.watermarkReadTimeIso,
    pageSize: run.pageSize,
  }, 40);
  const runRef = adminDb.collection(RUNS_COLLECTION).doc(run.runId);
  const pageRef = runRef.collection("pages").doc(pageKey);
  const existingPage = await pageRef.get();
  if (existingPage.exists) return publicPreviewFromStored(existingPage.get("publicPreview"));

  let query = adminDb.collection(SOURCE_COLLECTION)
    .orderBy(FieldPath.documentId(), "asc");
  if (run.watermarkDocumentId) query = query.endAt(run.watermarkDocumentId);
  if (startAfterDocumentId) query = query.startAfter(startAfterDocumentId);
  const pageSnapshot = await query.limit(run.pageSize).get();
  const documents: QueryDocumentSnapshot[] = pageSnapshot.docs;
  const counts = emptyCounts();
  const reasonCounts: ReasonCounts = {};
  counts.scanned = documents.length;
  const watermarkMs = Date.parse(run.watermarkReadTimeIso);
  const eligibleDocuments: QueryDocumentSnapshot[] = [];
  for (const document of documents) {
    if (snapshotChangedAfterWatermark(document, watermarkMs)) {
      counts.skipped += 1;
      incrementReason(reasonCounts, "changed_after_watermark");
      continue;
    }
    const classification = classifyConversationAttributionReconciliationCandidate(document.data() ?? {});
    if (!classification.eligible) {
      counts.skipped += 1;
      incrementReason(reasonCounts, classification.reasonCode);
      continue;
    }
    counts.eligible += 1;
    incrementReason(reasonCounts, classification.reasonCode);
    eligibleDocuments.push(document);
  }

  const sourcePaths = Array.from(new Set(eligibleDocuments
    .map((document) => validMessageSourceRef(document.get("lastMessageRef")))
    .filter(Boolean)));
  const sourceSnapshots = sourcePaths.length > 0
    ? await adminDb.getAll(...sourcePaths.map((path) => adminDb.doc(path)))
    : [];
  const sources = new Map(sourceSnapshots.map((snapshot) => [snapshot.ref.path, snapshot.data() ?? {}]));
  const planCandidates = await mapWithConcurrency(eligibleDocuments, 4, async (document) => {
    const conversation = document.data() ?? {};
    const classification = classifyConversationAttributionReconciliationCandidate(conversation);
    const lastMessageRef = validMessageSourceRef(conversation.lastMessageRef);
    const source = sources.get(lastMessageRef) ?? {};
    const discovered = await discoverInboundConversationAttribution({
      ...sourceForConversation(conversation, source),
      conversationId: document.id,
      requesterUid: auth.userId,
      requesterRole: auth.role,
    });
    const redacted = redactConversationAttributionResolutionEvidence(
      discovered.resolution,
      discovered.rejectedCandidateRefs,
    );
    if (!conversationAttributionResolutionNeedsMaterialization(conversation, discovered.resolution)) {
      return { plan: null, reasonCode: "no_material_change" };
    }
    const conversationHash = stableConversationAttributionHash(document.id, 32);
    // Reconciliation needs its own idempotency key. Reusing lastMessageRef would
    // collide with the original inbound materialization audit and replay a stale
    // automatic decision after evidence or scoring changes.
    const reconciliationMessageRef = `message_sources/reconcile_${stableConversationAttributionHash({
      runId: run.runId,
      pageKey,
      conversationHash,
    }, 40)}`;
    const plan: StoredPlanItem = {
      conversationId: document.id,
      conversationHash,
      expectedAttributionVersion: classification.expectedVersion,
      expectedStateFingerprint: conversationAutomaticAttributionFence(conversation),
      reconciliationMessageRef,
      resolution: discovered.resolution,
      rejectedCandidateRefs: discovered.rejectedCandidateRefs,
      ...(asString(conversation.ownerUid) ? { ownerUid: asString(conversation.ownerUid) } : {}),
    };
    return {
      plan: {
        ...plan,
        // Stored only in the private capability claim. The public preview and
        // append-only reconciliation audit expose counts/reason codes only.
      },
      reasonCode: redacted.resolution.reasonId,
    };
  });
  const plan = planCandidates.flatMap((row) => row.plan ? [row.plan] : []);
  for (const row of planCandidates) incrementReason(reasonCounts, row.reasonCode);
  counts.planned = plan.length;
  counts.skipped += eligibleDocuments.length - plan.length;

  const lastDocumentId = documents.at(-1)?.id ?? startAfterDocumentId;
  const done = documents.length < run.pageSize
    || Boolean(run.watermarkDocumentId && lastDocumentId === run.watermarkDocumentId);
  const nextCursor = done ? null : capabilityToken();
  const previewToken = capabilityToken();
  const previewHash = stableConversationAttributionHash({
    version: CONVERSATION_ATTRIBUTION_RECONCILIATION_VERSION,
    runId: run.runId,
    pageKey,
    watermarkHash: run.watermarkHash,
    plan: plan.map((item) => ({
      conversationHash: item.conversationHash,
      expectedAttributionVersion: item.expectedAttributionVersion,
      expectedStateFingerprint: item.expectedStateFingerprint,
      resolution: redactConversationAttributionResolutionEvidence(
        item.resolution,
        item.rejectedCandidateRefs,
      ).resolution,
    })),
  });
  const publicPreview: ConversationAttributionReconciliationEnvelope = {
    ok: true,
    dryRun: true,
    runId: run.runId,
    watermarkHash: run.watermarkHash,
    cursor: asString(data.cursor) || null,
    nextCursor,
    done,
    complete: done,
    readbackVerified: false,
    pageSize: run.pageSize,
    counts,
    reasonCounts,
    targetCounts: reconciliationTargetCounts(plan),
    previewToken,
    previewHash,
  };
  const expiresAtIso = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
  const claimRef = adminDb.collection(CLAIMS_COLLECTION).doc(`claim-${capabilityHash(previewToken)}`);
  const nextCursorRef = nextCursor
    ? adminDb.collection(CURSORS_COLLECTION).doc(`cursor-${capabilityHash(nextCursor)}`)
    : null;
  const storedClaim: StoredClaim = {
    schemaVersion: CONVERSATION_ATTRIBUTION_RECONCILIATION_VERSION,
    status: "previewed",
    actorUid: auth.userId,
    actorRole: auth.role,
    runId: run.runId,
    pageKey,
    previewHash,
    expiresAtIso,
    publicPreview,
    plan,
    ...(cursorState.previousClaimRef ? { previousClaimRef: cursorState.previousClaimRef } : {}),
  };
  const resolvedPreview = await adminDb.runTransaction(async (transaction) => {
    const existing = await transaction.get(pageRef);
    if (existing.exists) return publicPreviewFromStored(existing.get("publicPreview"));
    transaction.create(claimRef, { ...storedClaim, createdAt: FieldValue.serverTimestamp() });
    transaction.create(pageRef, {
      schemaVersion: CONVERSATION_ATTRIBUTION_RECONCILIATION_VERSION,
      actorUid: auth.userId,
      publicPreview,
      claimRef: claimRef.path,
      createdAtIso: new Date().toISOString(),
      createdAt: FieldValue.serverTimestamp(),
    });
    if (nextCursorRef && nextCursor) {
      transaction.create(nextCursorRef, {
        schemaVersion: CONVERSATION_ATTRIBUTION_RECONCILIATION_VERSION,
        actorUid: auth.userId,
        runId: run.runId,
        startAfterDocumentId: lastDocumentId,
        previousClaimRef: claimRef.path,
        expiresAtIso,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    return publicPreview;
  });
  return resolvedPreview;
}

function parseClaim(snapshot: DocumentSnapshot): StoredClaim {
  const data = snapshot.data() ?? {};
  if (
    data.schemaVersion !== CONVERSATION_ATTRIBUTION_RECONCILIATION_VERSION ||
    (data.status !== "previewed" && data.status !== "applied") ||
    !Array.isArray(data.plan)
  ) throw operationError("failed-precondition", "preview_claim_invalid");
  return data as StoredClaim;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "engine_error";
  const code = asString((error as { code?: unknown }).code);
  return code || "engine_error";
}

type ReconciliationApplyOutcome = {
  conversationId: string;
  kind: "applied" | "idempotent_replay" | "cas_stale" | "engine_error";
  item: StoredPlanItem;
};

function sameAttributionSnapshot(
  value: unknown,
  expected: ConversationAttributionResolution["final"],
): boolean {
  const snapshot = asRecord(value);
  return snapshot.primaryBucket === expected.primaryBucket
    && resolveProgramIdForReadback(snapshot.programId) === resolveProgramIdForReadback(expected.programId)
    && asString(snapshot.campaignId) === asString(expected.campaignId)
    && Number(snapshot.confidence) === expected.confidence
    && asString(snapshot.reasonId) === expected.reasonId
    && snapshot.source === expected.source;
}

function normalizedStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((entry) => asString(entry)).filter(Boolean))).sort()
    : [];
}

function normalizedFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedRankedCandidate(value: unknown): Record<string, unknown> {
  const candidate = asRecord(value);
  return {
    candidateRef: asString(candidate.candidateRef),
    evidenceRefs: normalizedStringArray(candidate.evidenceRefs),
    programId: resolveProgramIdForReadback(candidate.programId),
    campaignId: asString(candidate.campaignId),
    creatorIdentityKey: asString(candidate.creatorIdentityKey),
    score: normalizedFiniteNumber(candidate.score),
    confidence: normalizedFiniteNumber(candidate.confidence),
    exact: candidate.exact === true,
    signalIds: normalizedStringArray(candidate.signalIds),
  };
}

function sameRankedCandidates(
  value: unknown,
  expected: ConversationAttributionResolution["rankedCandidates"],
): boolean {
  const actualCandidates = Array.isArray(value)
    ? value.map(normalizedRankedCandidate)
    : [];
  const expectedCandidates = expected.slice(0, 10).map(normalizedRankedCandidate);
  return stableConversationAttributionHash(actualCandidates)
    === stableConversationAttributionHash(expectedCandidates);
}

function resolveProgramIdForReadback(value: unknown): string {
  return asString(value) === "scp" ? "pg-super-creator-partners" : asString(value);
}

function sameTopLevelAttributionProjection(
  conversation: Record<string, unknown>,
  expected: ConversationAttributionResolution,
): boolean {
  const final = expected.final;
  const expectedProgramId = final.primaryBucket === "program"
    ? resolveProgramIdForReadback(final.programId)
    : "";
  const expectedCampaignId = expectedProgramId ? asString(final.campaignId) : "";
  const expectedType = expectedCampaignId
    ? "campaign"
    : expectedProgramId
      ? "program"
      : "direct";
  return asString(conversation.type) === expectedType
    && resolveProgramIdForReadback(conversation.programId) === expectedProgramId
    && resolveProgramIdForReadback(conversation.canonicalProgramId) === expectedProgramId
    && asString(conversation.campaignId) === expectedCampaignId
    && conversation.attributionReviewRequired === expected.reviewRequired;
}

async function verifyReconciliationReadback(outcomes: ReconciliationApplyOutcome[]): Promise<boolean> {
  if (outcomes.length === 0) return true;
  const snapshots = await adminDb.getAll(...outcomes.map((outcome) => (
    adminDb.collection(SOURCE_COLLECTION).doc(outcome.conversationId)
  )));
  return snapshots.every((snapshot, index) => {
    const outcome = outcomes[index];
    if (outcome.kind === "engine_error") return false;
    if (outcome.kind === "cas_stale") {
      if (!snapshot.exists) return false;
      const conversation = snapshot.data() ?? {};
      const final = asRecord(asRecord(conversation.attribution).final);
      return final.source === "manual"
        || final.source === "revert"
        || conversationAutomaticAttributionFence(conversation) !== outcome.item.expectedStateFingerprint;
    }
    if (!snapshot.exists) return false;
    const conversation = snapshot.data() ?? {};
    const attribution = asRecord(conversation.attribution);
    return asString(conversation.attributionStatus) === "automatic"
      && asString(attribution.attributionStatus) === "automatic"
      && asString(attribution.policyVersion) === "conversation_attribution_v1"
      && Number(attribution.version) === outcome.item.expectedAttributionVersion + 1
      && attribution.reviewRequired === outcome.item.resolution.reviewRequired
      && sameAttributionSnapshot(attribution.suggested, outcome.item.resolution.suggested)
      && sameAttributionSnapshot(attribution.final, outcome.item.resolution.final)
      && sameRankedCandidates(attribution.rankedCandidates, outcome.item.resolution.rankedCandidates)
      && sameTopLevelAttributionProjection(conversation, outcome.item.resolution);
  });
}

async function assertPreviousPageApplied(
  auth: AuthContext,
  claim: StoredClaim,
): Promise<void> {
  if (!claim.publicPreview.cursor) {
    if (claim.previousClaimRef) throw operationError("failed-precondition", "previous_page_lineage_invalid");
    return;
  }
  const previousClaimRef = asString(claim.previousClaimRef);
  if (!/^conversation_attribution_reconciliation_preview_claims\/claim-[a-f0-9]{64}$/.test(previousClaimRef)) {
    throw operationError("failed-precondition", "previous_page_lineage_invalid");
  }
  const previousSnapshot = await adminDb.doc(previousClaimRef).get();
  if (!previousSnapshot.exists) throw operationError("failed-precondition", "previous_page_not_applied");
  const previous = parseClaim(previousSnapshot);
  const previousApply = previous.publicApply;
  if (
    previous.actorUid !== auth.userId
    || previous.runId !== claim.runId
    || previous.status !== "applied"
    || !previousApply
    || previousApply.readbackVerified !== true
    || previousApply.nextCursor !== claim.publicPreview.cursor
  ) {
    throw operationError("failed-precondition", "previous_page_not_applied");
  }
}

async function applyPreview(
  auth: AuthContext,
  data: Record<string, unknown>,
): Promise<ConversationAttributionReconciliationEnvelope> {
  if (data.actual !== true || data.confirm !== true) {
    throw operationError("failed-precondition", "explicit_confirmation_required");
  }
  const previewToken = assertCapability(data.previewToken, "preview_token");
  const previewHash = asString(data.previewHash);
  if (!/^[a-f0-9]{64}$/.test(previewHash)) throw operationError("invalid-argument", "preview_hash_required");
  const claimRef = adminDb.collection(CLAIMS_COLLECTION).doc(`claim-${capabilityHash(previewToken)}`);
  const claimSnapshot = await claimRef.get();
  if (!claimSnapshot.exists) throw operationError("not-found", "preview_claim_not_found");
  const claim = parseClaim(claimSnapshot);
  if (claim.actorUid !== auth.userId) throw operationError("permission-denied", "preview_claim_owner_mismatch");
  if (claim.previewHash !== previewHash) throw operationError("failed-precondition", "preview_hash_mismatch");
  if (claim.status === "applied" && claim.publicApply) return claim.publicApply;
  if (Date.parse(claim.expiresAtIso) <= Date.now()) throw operationError("failed-precondition", "preview_claim_expired");
  await assertPreviousPageApplied(auth, claim);

  const outcomes = await mapWithConcurrency<StoredPlanItem, ReconciliationApplyOutcome>(claim.plan, 4, async (item) => {
    try {
      const result = await materializeAutomaticConversationAttribution({
        conversationId: item.conversationId,
        messageRef: item.reconciliationMessageRef,
        resolution: item.resolution,
        rejectedCandidateRefs: item.rejectedCandidateRefs,
        actorUid: auth.userId,
        actorRole: auth.role,
        ownerUid: item.ownerUid,
        expectedAttributionVersion: item.expectedAttributionVersion,
        expectedStateFingerprint: item.expectedStateFingerprint,
        auditPrivacy: "hashed_identifiers",
      });
      return {
        conversationId: item.conversationId,
        kind: result.idempotentReplay ? "idempotent_replay" : "applied",
        item,
      };
    } catch (error) {
      const code = errorCode(error);
      return {
        conversationId: item.conversationId,
        kind: code === "aborted" || code === "failed-precondition" || code === "not-found"
          ? "cas_stale"
          : "engine_error",
        item,
      };
    }
  });
  const counts = { ...claim.publicPreview.counts };
  const reasonCounts = { ...claim.publicPreview.reasonCounts };
  for (const outcome of outcomes) {
    incrementReason(reasonCounts, outcome.kind);
    if (outcome.kind === "applied") counts.applied += 1;
    else if (outcome.kind === "idempotent_replay") {
      counts.applied += 1;
      counts.idempotent += 1;
    } else counts.stale += 1;
  }
  const readbackVerified = await verifyReconciliationReadback(outcomes);
  const publicApply: ConversationAttributionReconciliationEnvelope = {
    ok: true,
    dryRun: false,
    runId: claim.publicPreview.runId,
    watermarkHash: claim.publicPreview.watermarkHash,
    cursor: claim.publicPreview.cursor,
    nextCursor: claim.publicPreview.nextCursor,
    done: claim.publicPreview.done,
    complete: claim.publicPreview.complete && readbackVerified,
    readbackVerified,
    pageSize: claim.publicPreview.pageSize,
    counts,
    reasonCounts,
    targetCounts: claim.publicPreview.targetCounts,
  };
  const auditRef = adminDb.collection(AUDITS_COLLECTION).doc(`audit-${stableConversationAttributionHash({
    runId: claim.runId,
    pageKey: claim.pageKey,
    previewHash: claim.previewHash,
  }, 40)}`);
  return adminDb.runTransaction(async (transaction) => {
    const [latestClaimSnapshot, auditSnapshot] = await Promise.all([
      transaction.get(claimRef),
      transaction.get(auditRef),
    ]);
    const latestClaim = parseClaim(latestClaimSnapshot);
    if (latestClaim.status === "applied" && latestClaim.publicApply) return latestClaim.publicApply;
    if (auditSnapshot.exists) {
      const replay = publicPreviewFromStored(auditSnapshot.get("publicResult"));
      transaction.set(claimRef, { status: "applied", publicApply: replay }, { merge: true });
      return replay;
    }
    transaction.create(auditRef, {
      schemaVersion: CONVERSATION_ATTRIBUTION_RECONCILIATION_VERSION,
      action: "conversation_attribution_reconciliation_apply",
      runHash: stableConversationAttributionHash(claim.runId, 32),
      pageHash: stableConversationAttributionHash(claim.pageKey, 32),
      watermarkHash: claim.publicPreview.watermarkHash,
      cursorHash: stableConversationAttributionHash(claim.publicPreview.cursor ?? "start", 32),
      nextCursorHash: stableConversationAttributionHash(claim.publicPreview.nextCursor ?? "done", 32),
      previewHash: claim.previewHash,
      counts,
      reasonCounts,
      actor: {
        role: auth.role,
        uidHash: stableConversationAttributionHash(auth.userId, 24),
      },
      publicResult: publicApply,
      createdAtIso: new Date().toISOString(),
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.set(claimRef, {
      status: "applied",
      publicApply,
      appliedAtIso: new Date().toISOString(),
      appliedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return publicApply;
  });
}

export async function reconcileConversationAttribution(
  request: CallableRequestShape,
): Promise<ConversationAttributionReconciliationEnvelope> {
  const auth = assertNonGuestAuth(request, ACTION, WRITE_ROLES);
  const data = asRecord(request.data);
  const dryRun = data.dryRun !== false;
  return dryRun ? previewPage(auth, data) : applyPreview(auth, data);
}
