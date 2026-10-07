import type { DocumentReference, DocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asString } from "./shared";
import {
  canonicalConversationDocumentId as resolveCanonicalConversationDocumentId,
  canonicalCreatorId as resolveCanonicalCreatorId,
  canonicalThreadId as resolveCanonicalThreadId,
  canonicalWorkflowContextKey,
  conversationThreadCandidates,
} from "./creatorIdentity";

export type ConversationScope = {
  conversationId: string;
  threadId: string;
  contextKey: string;
  candidateIds: string[];
  existingSnapshots: DocumentSnapshot[];
  scopedSnapshots: DocumentSnapshot[];
  targetRefs: DocumentReference[];
};

function uniqueStrings(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (value && !result.includes(value)) result.push(value);
  }
  return result;
}

export function chatIdentity(data: Record<string, unknown>, fallbackConversationId = "") {
  const conversationId = asString(data.conversationId, fallbackConversationId);
  return {
    id: conversationId,
    conversationId,
    threadId: asString(data.threadId, ""),
    creatorId: asString(data.creatorId, ""),
    candidateId: asString(data.candidateId, ""),
    programId: asString(data.programId, ""),
    campaignId: asString(data.campaignId, ""),
    contextKey: asString(data.contextKey, ""),
    type: asString(data.type, ""),
    source: asString(data.source, ""),
    email: asString(data.email, asString(data.to, "")),
    creatorEmail: asString(data.creatorEmail, asString(data.to, "")),
    handle: asString(data.handle, ""),
    creatorHandle: asString(data.creatorHandle, ""),
    name: asString(data.name, asString(data.creatorName, "")),
    creatorName: asString(data.creatorName, ""),
    channelId: asString(data.channelId, ""),
    youtubeUrl: asString(data.youtubeUrl, ""),
  };
}

export function canonicalConversationIdForData(data: Record<string, unknown>, fallbackConversationId: string): string {
  const identity = chatIdentity(data, fallbackConversationId);
  return resolveCanonicalConversationDocumentId(identity) || identity.conversationId || fallbackConversationId;
}

export function canonicalThreadIdForData(data: Record<string, unknown>, fallbackConversationId: string): string {
  const identity = chatIdentity(data, fallbackConversationId);
  return resolveCanonicalThreadId(identity) || identity.conversationId || fallbackConversationId;
}

export function workflowContextKeyForData(data: Record<string, unknown>, conversationId: string, threadId: string): string {
  return canonicalWorkflowContextKey({
    ...chatIdentity(data, conversationId),
    conversationId,
    threadId,
  });
}

export function workflowContextKeyForSnapshot(id: string, data: Record<string, unknown>): string {
  const threadId = resolveCanonicalThreadId({
    conversationId: id,
    threadId: asString(data.threadId, ""),
    creatorId: asString(data.creatorId, ""),
    creatorEmail: asString(data.creatorEmail, ""),
    creatorHandle: asString(data.creatorHandle, ""),
    creatorName: asString(data.creatorName, ""),
    channelId: asString(data.channelId, ""),
    youtubeUrl: asString(data.youtubeUrl, ""),
  }) || asString(data.threadId, id);
  return canonicalWorkflowContextKey({
    conversationId: id,
    threadId,
    contextKey: asString(data.contextKey, ""),
    type: asString(data.type, ""),
    source: asString(data.source, ""),
    creatorId: asString(data.creatorId, ""),
    creatorEmail: asString(data.creatorEmail, ""),
    creatorHandle: asString(data.creatorHandle, ""),
    creatorName: asString(data.creatorName, ""),
    channelId: asString(data.channelId, ""),
    youtubeUrl: asString(data.youtubeUrl, ""),
    programId: asString(data.programId, ""),
    campaignId: asString(data.campaignId, ""),
  });
}

export function canonicalCreatorIdForData(data: Record<string, unknown>, conversationId: string): string {
  return resolveCanonicalCreatorId(chatIdentity(data, conversationId)) ||
    asString(data.creatorId, asString(data.candidateId, conversationId));
}

export function conversationIdsForData(data: Record<string, unknown>, conversationId: string, maxTargets = 20): string[] {
  const requested = Array.isArray(data.conversationIds)
    ? data.conversationIds.map((value) => asString(value, "")).filter(Boolean)
    : [];
  return uniqueStrings([
    conversationId,
    asString(data.threadId, ""),
    ...requested,
    ...conversationThreadCandidates(chatIdentity(data, conversationId)),
  ]).slice(0, maxTargets);
}

export async function resolveConversationScope(
  data: Record<string, unknown>,
  requestedConversationId: string,
  options: { maxTargets?: number; fallbackToCanonicalRef?: boolean } = {},
): Promise<ConversationScope> {
  const maxTargets = Math.max(1, Math.min(options.maxTargets ?? 20, 450));
  const conversationId = canonicalConversationIdForData(data, requestedConversationId);
  const seedRef = adminDb.collection("conversations").doc(conversationId);
  const seedSnapshot = await seedRef.get();
  const seedData = seedSnapshot.exists ? seedSnapshot.data() ?? {} : {};
  const scopedData = seedSnapshot.exists
    ? { ...data, ...seedData, conversationIds: data.conversationIds, conversationId }
    : data;
  const threadId = canonicalThreadIdForData(scopedData, conversationId);
  const contextKey = workflowContextKeyForData(scopedData, conversationId, threadId);
  const candidateIds = conversationIdsForData(scopedData, conversationId, maxTargets);
  const refs = candidateIds.map((id) => adminDb.collection("conversations").doc(id));
  const snapshots = await adminDb.getAll(...refs);
  const existingSnapshots = snapshots.filter((snapshot) => snapshot.exists);
  const scopedSnapshots = contextKey
    ? existingSnapshots.filter((snapshot) => workflowContextKeyForSnapshot(snapshot.id, snapshot.data() ?? {}) === contextKey)
    : existingSnapshots;
  const targetRefs = scopedSnapshots.map((snapshot) => snapshot.ref);
  if (targetRefs.length === 0 && options.fallbackToCanonicalRef) {
    targetRefs.push(seedRef);
  }
  return {
    conversationId,
    threadId,
    contextKey,
    candidateIds,
    existingSnapshots,
    scopedSnapshots,
    targetRefs,
  };
}
