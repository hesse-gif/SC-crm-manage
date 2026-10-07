import { createHash } from "node:crypto";
import { FieldPath } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  feedbackScopeFromStored,
  redactKnowledgeRef,
  redactKnowledgeText,
  type FeedbackGovernanceScope,
} from "./feedbackKbGovernanceCore";
import { assertNonGuestAuth, type CallableRequestShape } from "./shared";

export type SourceRef = {
  ref: string;
  type: "message_source" | "conversation_message" | "program" | "program_application" | "campaign" | "contract" | "review" | "settings" | "feedback" | "artifact" | "video" | "creator" | "ad_proposal" | "feed_proposal_learning_event" | "other";
  summary?: string;
};

export type KnowledgeNodeInput = {
  id: string;
  type: "ai_summary" | "auto_reply" | "negotiation_guide" | "program_knowledge" | "feedback_kb" | "human_review_guidance" | "feed_proposal_learning";
  title: string;
  summary: string;
  sourceRefs: SourceRef[];
  entityRefs?: string[];
  governanceScope?: FeedbackGovernanceScope;
  createdAtIso?: string;
};

type WriteSink = FirebaseFirestore.WriteBatch | FirebaseFirestore.Transaction;
type ReviewDecision = "accept" | "keep";

function isWriteBatch(sink: WriteSink): sink is FirebaseFirestore.WriteBatch {
  return "commit" in sink;
}

function mergeSet(
  sink: WriteSink,
  ref: FirebaseFirestore.DocumentReference,
  data: FirebaseFirestore.DocumentData,
): void {
  if (isWriteBatch(sink)) {
    sink.set(ref, data, { merge: true });
    return;
  }
  sink.set(ref, data, { merge: true });
}

function governanceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function safeDocId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 180) || "node";
}

function hash(value: string, length = 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function normalizeRef(value: unknown): string {
  return redactKnowledgeRef(value, "artifact/redacted");
}

function sanitizeText(value: unknown, limit: number): string {
  return redactKnowledgeText(value).slice(0, limit);
}

function sanitizeScope(value: unknown): FeedbackGovernanceScope | null {
  return feedbackScopeFromStored(value);
}

function normalizeRevision(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function requiredRevision(value: unknown): number {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(revision) || revision < 0) {
    throw governanceError("invalid-argument", "expectedRevision is required");
  }
  return revision;
}

function requiredTransitionId(value: unknown): string {
  const transitionId = typeof value === "string"
    ? value.trim().replace(/[^a-zA-Z0-9._~-]/g, "-").replace(/-+/g, "-").slice(0, 160)
    : "";
  if (!transitionId) throw governanceError("invalid-argument", "transitionId is required");
  return transitionId;
}

export function sourceRef(ref: string, type: SourceRef["type"], summary?: string): SourceRef {
  return {
    ref: normalizeRef(ref),
    type,
    ...(summary ? { summary: sanitizeText(summary, 240) } : {}),
  };
}

function nodeTitle(input: KnowledgeNodeInput): string {
  return sanitizeText(input.title, 180);
}

function nodeSummary(input: KnowledgeNodeInput): string {
  return sanitizeText(input.summary, 1000);
}

function cleanSourceRefs(input: Pick<KnowledgeNodeInput, "sourceRefs">): SourceRef[] {
  return input.sourceRefs
    .filter((item): item is SourceRef => Boolean(item) && typeof item.ref === "string" && Boolean(item.ref.trim()))
    .map((item) => sourceRef(item.ref, item.type, item.summary));
}

function cleanEntityRefs(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => normalizeRef(value));
}

function normalizedNodeSnapshot(input: KnowledgeNodeInput): Record<string, unknown> {
  const governanceScope = sanitizeScope(input.governanceScope);
  return {
    id: safeDocId(input.id),
    type: input.type,
    title: nodeTitle(input),
    summary: nodeSummary(input),
    sourceRefs: cleanSourceRefs(input),
    entityRefs: cleanEntityRefs(input.entityRefs),
    governanceScope,
    scopeKey: governanceScope?.scopeKey ?? null,
  };
}

function normalizedStoredSnapshot(data: FirebaseFirestore.DocumentData): Record<string, unknown> {
  const rawSources = Array.isArray(data.sourceRefs) ? data.sourceRefs : [];
  const sourceRefs = rawSources
    .filter((item): item is SourceRef => Boolean(item) && typeof item === "object" && typeof (item as SourceRef).ref === "string")
    .map((item) => sourceRef(item.ref, item.type, item.summary));
  const governanceScope = sanitizeScope(data.governanceScope);
  return {
    id: safeDocId(typeof data.id === "string" ? data.id : "node"),
    type: data.type,
    title: sanitizeText(data.title, 180),
    summary: sanitizeText(data.summary, 1000),
    sourceRefs,
    entityRefs: cleanEntityRefs(data.entityRefs),
    governanceScope,
    scopeKey: governanceScope?.scopeKey ?? null,
  };
}

function contentFingerprint(snapshot: Record<string, unknown>): string {
  const sources = Array.isArray(snapshot.sourceRefs)
    ? (snapshot.sourceRefs as SourceRef[]).map((ref) => `${ref.type}|${ref.ref}|${ref.summary ?? ""}`).sort()
    : [];
  const entities = cleanEntityRefs(snapshot.entityRefs).sort();
  return hash(JSON.stringify({
    type: snapshot.type,
    title: snapshot.title,
    summary: snapshot.summary,
    sources,
    entities,
    scopeKey: typeof snapshot.scopeKey === "string" ? snapshot.scopeKey : null,
  }), 64);
}

function fingerprintFromInput(input: KnowledgeNodeInput): string {
  return contentFingerprint(normalizedNodeSnapshot(input));
}

function fingerprintFromExisting(data: FirebaseFirestore.DocumentData): string {
  return contentFingerprint(normalizedStoredSnapshot(data));
}

export type IngestOutcome =
  | { status: "ingested"; nodePath: string }
  | { status: "duplicate"; nodePath: string }
  | { status: "conflict"; nodePath: string; reviewPath: string };

// Canonical-node detection and conflict creation share one transaction. A
// concurrent ingest therefore cannot overwrite a conflict or create two queues.
export async function ingestKnowledgeNode(input: KnowledgeNodeInput): Promise<IngestOutcome> {
  const nowIso = input.createdAtIso ?? new Date().toISOString();
  const id = safeDocId(input.id);
  const nodeRef = adminDb.collection("knowledge_nodes").doc(id);
  const incomingSnapshot = normalizedNodeSnapshot({ ...input, id });
  const incomingFingerprint = fingerprintFromInput({ ...input, id });

  return adminDb.runTransaction(async (transaction) => {
    const existing = await transaction.get(nodeRef);
    if (!existing.exists) {
      writeKnowledgeNode(transaction, { ...input, id, createdAtIso: nowIso });
      return { status: "ingested" as const, nodePath: nodeRef.path };
    }

    const existingData = existing.data() ?? {};
    const baseNodeFingerprint = fingerprintFromExisting(existingData);
    if (baseNodeFingerprint === incomingFingerprint) {
      transaction.set(nodeRef, { updatedAtIso: nowIso }, { merge: true });
      return { status: "duplicate" as const, nodePath: nodeRef.path };
    }

    const reviewId = safeDocId(`${id}-${hash(`${baseNodeFingerprint}|${incomingFingerprint}`, 32)}`);
    const reviewRef = adminDb.collection("kb_review").doc(reviewId);
    const existingReview = await transaction.get(reviewRef);
    if (existingReview.exists) {
      const review = existingReview.data() ?? {};
      transaction.set(reviewRef, {
        lastSeenAtIso: nowIso,
        occurrenceCount: normalizeRevision(review.occurrenceCount) + 1,
      }, { merge: true });
      return { status: "conflict" as const, nodePath: nodeRef.path, reviewPath: reviewRef.path };
    }

    transaction.create(reviewRef, {
      id: reviewId,
      nodeId: id,
      nodeRef: nodeRef.path,
      reason: "conflicting_content",
      status: "pending",
      resolution: null,
      revision: 0,
      lastTransitionId: null,
      baseNodeFingerprint,
      incomingFingerprint,
      existing: normalizedStoredSnapshot(existingData),
      incoming: incomingSnapshot,
      governanceScope: sanitizeScope(input.governanceScope),
      artifactPolicy: "server-ref-only",
      graphVersion: "phase-1.3",
      occurrenceCount: 1,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      lastSeenAtIso: nowIso,
    });
    return { status: "conflict" as const, nodePath: nodeRef.path, reviewPath: reviewRef.path };
  });
}

export type ResolveKbReviewResult = {
  status: "resolved";
  decision: ReviewDecision;
  nodePath?: string;
  revision: number;
  resolutionEventRef: string;
  idempotent: boolean;
};

// Accept/keep is an optimistic-concurrency transition with an append-only event.
// Accept also verifies the canonical node has not changed since conflict capture.
export async function resolveKbReview(
  reviewId: string,
  decision: ReviewDecision,
  resolvedBy: string,
  expectedRevision: number,
  transitionId: string,
): Promise<ResolveKbReviewResult> {
  const normalizedReviewId = safeDocId(reviewId);
  const safeTransitionId = requiredTransitionId(transitionId);
  const requiredExpectedRevision = requiredRevision(expectedRevision);
  const reviewRef = adminDb.collection("kb_review").doc(normalizedReviewId);
  const eventRef = adminDb.collection("kb_review_resolution_events")
    .doc(safeDocId(`${normalizedReviewId}-${hash(safeTransitionId, 32)}`));

  return adminDb.runTransaction(async (transaction) => {
    const eventSnapshot = await transaction.get(eventRef);
    if (eventSnapshot.exists) {
      const event = eventSnapshot.data() ?? {};
      if (event.reviewId !== normalizedReviewId || event.decision !== decision) {
        throw governanceError("already-exists", "transitionId belongs to another resolution");
      }
      return {
        status: "resolved" as const,
        decision,
        ...(typeof event.nodePath === "string" ? { nodePath: event.nodePath } : {}),
        revision: normalizeRevision(event.revision),
        resolutionEventRef: eventRef.path,
        idempotent: true,
      };
    }

    const reviewSnapshot = await transaction.get(reviewRef);
    if (!reviewSnapshot.exists) {
      throw governanceError("not-found", "kb_review item does not exist");
    }
    const review = reviewSnapshot.data() ?? {};
    const currentRevision = normalizeRevision(review.revision);
    if (review.status !== "pending") {
      throw governanceError("failed-precondition", "kb_review item is no longer pending");
    }
    if (currentRevision !== requiredExpectedRevision) {
      throw governanceError("aborted", "kb_review revision conflict");
    }
    const nodeId = safeDocId(typeof review.nodeId === "string" ? review.nodeId : "");
    const nodeRef = adminDb.collection("knowledge_nodes").doc(nodeId);
    const nodeSnapshot = await transaction.get(nodeRef);
    if (!nodeSnapshot.exists) {
      throw governanceError("not-found", "canonical knowledge node does not exist");
    }
    if (decision === "accept") {
      const currentFingerprint = fingerprintFromExisting(nodeSnapshot.data() ?? {});
      if (!review.baseNodeFingerprint || review.baseNodeFingerprint !== currentFingerprint) {
        throw governanceError("aborted", "canonical knowledge node changed after conflict capture");
      }
    }

    const nowIso = new Date().toISOString();
    const nextRevision = currentRevision + 1;
    let nodePath = nodeRef.path;
    if (decision === "accept" && review.incoming && typeof review.incoming === "object") {
      const incoming = review.incoming as Record<string, unknown>;
      const incomingScope = sanitizeScope(incoming.governanceScope);
      nodePath = writeKnowledgeNode(transaction, {
        id: typeof incoming.id === "string" ? incoming.id : nodeId,
        type: incoming.type as KnowledgeNodeInput["type"],
        title: typeof incoming.title === "string" ? incoming.title : "",
        summary: typeof incoming.summary === "string" ? incoming.summary : "",
        sourceRefs: Array.isArray(incoming.sourceRefs) ? incoming.sourceRefs as SourceRef[] : [],
        entityRefs: Array.isArray(incoming.entityRefs) ? incoming.entityRefs as string[] : [],
        ...(incomingScope ? { governanceScope: incomingScope } : {}),
        createdAtIso: nowIso,
      });
    }

    transaction.create(eventRef, {
      id: eventRef.id,
      reviewId: normalizedReviewId,
      reviewRef: reviewRef.path,
      transitionId: safeTransitionId,
      decision,
      before: { status: review.status, revision: currentRevision },
      after: { status: "resolved", revision: nextRevision },
      nodePath,
      revision: nextRevision,
      resolvedBy,
      resolvedAtIso: nowIso,
      artifactPolicy: "server-ref-only",
      graphVersion: "phase-1.3",
    });
    transaction.set(reviewRef, {
      status: "resolved",
      resolution: decision,
      revision: nextRevision,
      lastTransitionId: safeTransitionId,
      latestResolutionEventRef: eventRef.path,
      resolvedBy,
      updatedAtIso: nowIso,
    }, { merge: true });
    return {
      status: "resolved" as const,
      decision,
      nodePath,
      revision: nextRevision,
      resolutionEventRef: eventRef.path,
      idempotent: false,
    };
  });
}

export type KbReviewQueueItem = {
  id: string;
  nodeId: string;
  nodeRef: string;
  reason: string;
  status: string;
  revision: number;
  existing: Record<string, unknown>;
  incoming: Record<string, unknown>;
  governanceScope: FeedbackGovernanceScope | null;
  createdAtIso: string;
};

function encodeQueueCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

function decodeQueueCursor(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 400) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof parsed.id === "string" ? safeDocId(parsed.id) : null;
  } catch {
    return null;
  }
}

function queuePageLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(1, Math.trunc(parsed))) : 50;
}

// Queue totals and truncation are server-derived; the UI never treats a page as
// the entire queue.
export async function listKbReviewQueue(request: CallableRequestShape): Promise<{
  items: KbReviewQueueItem[];
  total: number;
  pageInfo: { limit: number; returned: number; truncated: boolean; nextCursor: string | null };
}> {
  assertNonGuestAuth(request, "knowledgeGraph.listKbReviewQueue", ["super_admin", "admin"]);
  const data = request.data && typeof request.data === "object" && !Array.isArray(request.data)
    ? request.data as Record<string, unknown>
    : {};
  const limit = queuePageLimit(data.limit);
  const cursor = decodeQueueCursor(data.cursor);
  if (data.cursor && !cursor) throw governanceError("invalid-argument", "invalid kb_review cursor");
  const baseQuery = adminDb.collection("kb_review").where("status", "==", "pending");
  let pageQuery: FirebaseFirestore.Query = baseQuery.orderBy(FieldPath.documentId(), "asc");
  if (cursor) pageQuery = pageQuery.startAfter(cursor);
  const [snapshot, countSnapshot] = await Promise.all([
    pageQuery.limit(limit + 1).get(),
    baseQuery.count().get(),
  ]);
  const truncated = snapshot.docs.length > limit;
  const docs = truncated ? snapshot.docs.slice(0, limit) : snapshot.docs;
  const items: KbReviewQueueItem[] = docs.map((doc) => {
    const data = doc.data() ?? {};
    const existing = data.existing && typeof data.existing === "object"
      ? normalizedStoredSnapshot(data.existing as FirebaseFirestore.DocumentData)
      : {};
    const incoming = data.incoming && typeof data.incoming === "object"
      ? normalizedStoredSnapshot(data.incoming as FirebaseFirestore.DocumentData)
      : {};
    return {
      id: doc.id,
      nodeId: safeDocId(typeof data.nodeId === "string" ? data.nodeId : ""),
      nodeRef: normalizeRef(data.nodeRef),
      reason: sanitizeText(data.reason, 120),
      status: typeof data.status === "string" ? data.status : "pending",
      revision: normalizeRevision(data.revision),
      existing,
      incoming,
      governanceScope: sanitizeScope(data.governanceScope),
      createdAtIso: typeof data.createdAtIso === "string" ? data.createdAtIso : "",
    };
  });
  const lastDoc = docs.at(-1);
  return {
    items,
    total: countSnapshot.data().count,
    pageInfo: {
      limit,
      returned: items.length,
      truncated,
      nextCursor: truncated && lastDoc ? encodeQueueCursor(lastDoc.id) : null,
    },
  };
}

export async function resolveKbReviewCallable(request: CallableRequestShape): Promise<ResolveKbReviewResult> {
  const auth = assertNonGuestAuth(request, "knowledgeGraph.resolveKbReview", ["super_admin", "admin"]);
  const data = request.data && typeof request.data === "object" && !Array.isArray(request.data)
    ? request.data as Record<string, unknown>
    : {};
  const reviewId = typeof data.reviewId === "string" ? data.reviewId.trim() : "";
  const decision = data.decision === "accept" ? "accept" : data.decision === "keep" ? "keep" : null;
  if (!reviewId || !decision) {
    throw governanceError("invalid-argument", "reviewId and decision(accept|keep) are required");
  }
  return resolveKbReview(
    reviewId,
    decision,
    auth.userId,
    requiredRevision(data.expectedRevision),
    requiredTransitionId(data.transitionId),
  );
}

export function writeKnowledgeNode(sink: WriteSink, input: KnowledgeNodeInput): string {
  const nowIso = input.createdAtIso ?? new Date().toISOString();
  const snapshot = normalizedNodeSnapshot(input);
  const id = snapshot.id as string;
  const nodeRef = adminDb.collection("knowledge_nodes").doc(id);
  const sourceRefs = snapshot.sourceRefs as SourceRef[];
  const entityRefs = snapshot.entityRefs as string[];

  mergeSet(sink, nodeRef, {
    ...snapshot,
    artifactPolicy: "server-ref-only",
    graphVersion: "phase-1.3",
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
  });

  for (const ref of sourceRefs) {
    const edgeRef = adminDb.collection("knowledge_edges").doc(safeDocId(`${id}-derived-from-${hash(ref.ref, 24)}`));
    mergeSet(sink, edgeRef, {
      id: edgeRef.id,
      from: nodeRef.path,
      to: ref.ref,
      edgeType: "derived_from",
      sourceRefs: [ref],
      governanceScope: snapshot.governanceScope,
      scopeKey: snapshot.scopeKey,
      graphVersion: "phase-1.3",
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    });
  }

  for (const entityRef of entityRefs) {
    const edgeRef = adminDb.collection("knowledge_edges").doc(safeDocId(`${id}-about-${hash(entityRef, 24)}`));
    mergeSet(sink, edgeRef, {
      id: edgeRef.id,
      from: nodeRef.path,
      to: entityRef,
      edgeType: "about",
      sourceRefs,
      governanceScope: snapshot.governanceScope,
      scopeKey: snapshot.scopeKey,
      graphVersion: "phase-1.3",
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    });
  }

  return nodeRef.path;
}
