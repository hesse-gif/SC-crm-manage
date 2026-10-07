import { createHash, randomUUID } from "node:crypto";
import { FieldPath, type Transaction } from "firebase-admin/firestore";
import { authHeader, getRuntimeIntegration, liveIntegrationsEnabled, publicString, requireEnvSecret, timeoutSignal } from "./liveIntegrations";
import { adminDb } from "./firebaseAdmin";
import {
  sourceRef as makeSourceRef,
  writeKnowledgeNode,
  ingestKnowledgeNode,
  type KnowledgeNodeInput,
} from "./knowledgeGraph";
import { resolveCanonicalProgramId } from "./programCanonical";
import { rowMatchesAccountScope } from "./readScope";
import type { AuthContext } from "./shared";
import {
  EXPLICIT_GLOBAL_SCOPE,
  FEEDBACK_SCOPE_VERSION,
  buildFeedbackGovernanceScope,
  decodeFeedbackCursor,
  encodeFeedbackCursor,
  feedbackScopeFromStored,
  feedbackScopesEqual,
  fineTuneIdempotencyKey,
  fineTuneOutboxId,
  planFeedbackReviewTransition,
  redactKnowledgeRef,
  redactKnowledgeText,
  requireStoredFeedbackScope,
  type FeedbackGovernanceScope,
  type FeedbackReviewState,
} from "./feedbackKbGovernanceCore";
import {
  FINE_TUNE_COMPENSATION_MAX_ATTEMPTS,
  fineTuneCompensationIdentity,
  planFineTuneCompensationClaim,
  planFineTuneCompensationFailure,
  planFineTuneCompensationSuccess,
  requireCancellationHandle,
} from "./feedbackFineTuneCompensationCore";

// Governed feedback knowledge path.
//
// Current capability boundary:
// - Firestore-backed lexical retrieval is active.
// - Vector/embedding retrieval is unavailable.
// - Submitted feedback is inert until an operator explicitly approves it.
// - Approval writes a review -> sanitized example -> eval -> promotion lineage.
// - Only promoted entries can be retrieved by production generation.
//
// Raw prompts/responses and direct client Firestore writes are forbidden.

export type Role = "super_admin" | "admin" | "manager" | "viewer" | "guest";

type CallableRequest = {
  auth?: {
    uid?: string;
    token?: {
      role?: Role;
      team?: string;
      gameId?: string;
      email?: string;
      name?: string;
      memberEmail?: string;
      memberName?: string;
    };
  };
  data?: unknown;
  rawRequest?: { ip?: string };
};

export type FeedbackPrincipal = {
  uid: string;
  role: Exclude<Role, "guest">;
  team: string;
  gameId: string;
  email?: string;
  name?: string;
};

/**
 * Extra, additive metadata a `submitFeedbackCore` caller other than the public
 * `submitFeedback` callable may attach. Every field here is optional and, when present,
 * is merged onto both the `feedback/{id}` and `feedback_kb_entries/{id}` documents —
 * existing readers (this file's own `normalizeKbEntry`, the admin/knowledge screen)
 * only project known fields, so unknown extras are inert until a reader opts in.
 * Used by functions/manualReplyLearning.ts to tag implicit-manual-reply KB candidates
 * without duplicating submitFeedback's transaction/idempotency/scope-resolution logic.
 */
export type SubmitFeedbackCoreExtra = {
  /** e.g. "implicit_manual_reply" — distinguishes system-captured candidates from
   * operator-submitted thumbs up/down. Absent for the public callable (unchanged). */
  source?: string;
  /** Additional tags appended after the existing target/rating/reason tags. */
  extraTags?: string[];
  /** Arbitrary additional fields merged onto both stored documents (server-ref-only
   * values expected — no raw prompt/response payloads, per SEC-P0-009). */
  extraFields?: DataRecord;
};

type FeedbackRating = "up" | "down";
type FeedbackTarget = "chat" | "email" | "contract" | "priority" | "negotiation" | "mail";
type PipelineDomain = "priority" | "negotiation" | "mail" | "contract" | "chat";
type ReviewDecision = "approve" | "reject";

type FeedbackReviewTransactionResult = {
  resultStatus: string;
  feedbackRef: string;
  storedArtifactRef: string;
  reviewRef: string;
  reviewEventRef: string;
  revision: number;
  domain: PipelineDomain;
  scope: FeedbackGovernanceScope;
  idempotent: boolean;
  promotionRef?: string;
  lineage?: ReturnType<typeof promotionLineage>;
  evaluation?: ReturnType<typeof reviewedArtifactIntegrityEval>;
};

type BehaviorLog = {
  userId: string;
  role: Role;
  team: string;
  gameId: string;
  action: string;
  time: string;
  IP: string;
  result: "allow" | "deny";
  cost: number;
};

type CacheMeta = {
  checked: true;
  hit: boolean;
  key: string;
  ttlSeconds: number;
};

type CostLog = {
  provider: "internal" | "ai-hub";
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  cacheKey: string;
};

export type DataRecord = Record<string, unknown>;
type RetrieveFeedbackKbInput = {
  target?: unknown;
  pipelineDomain?: unknown;
  query?: unknown;
  artifactRef?: unknown;
  limit?: unknown;
  candidateLimit?: unknown;
  cursor?: unknown;
  gameId?: unknown;
  programId?: unknown;
  campaignId?: unknown;
  locale?: unknown;
  globalScope?: unknown;
};

const ALLOWED_ROLES: Role[] = ["super_admin", "admin", "manager", "viewer"];
const REVIEW_ROLES: Role[] = ["super_admin", "admin", "manager"];
const RELEASE_ROLES: Role[] = ["super_admin", "admin"];
const DOWN_REASONS = ["톤이 안 맞음", "사실/숫자 오류", "비용 가이드 위반", "너무 김/장황", "맥락 누락", "기타"] as const;
const TARGETS: FeedbackTarget[] = ["chat", "email", "contract", "priority", "negotiation", "mail"];
const DOMAINS: PipelineDomain[] = ["priority", "negotiation", "mail", "contract", "chat"];

export const FEEDBACK_LEXICAL_STRATEGY = "lexical-token-overlap-v1" as const;
export const FEEDBACK_PROMPT_VERSION = "feedback-guidance-v1" as const;
export const FEEDBACK_POLICY_VERSION = "feedback-promotion-policy-v1" as const;
export const FEEDBACK_EVAL_DATASET_VERSION = "feedback-review-eval-v1" as const;

const PIPELINE_BY_TARGET: Record<FeedbackTarget, PipelineDomain> = {
  chat: "chat",
  email: "mail",
  contract: "contract",
  priority: "priority",
  negotiation: "negotiation",
  mail: "mail",
};

// These are actual runtime consumers, not aspirational labels. All domains are
// available through the explicit retrieve callable; chat is additionally used by
// gatewayProxy during production reply generation.
const PIPELINE_CONSUMERS: Record<PipelineDomain, string[]> = {
  priority: ["retrieveFeedbackKb"],
  negotiation: ["retrieveFeedbackKb"],
  mail: ["retrieveFeedbackKb", "receiveEmail"],
  contract: ["retrieveFeedbackKb"],
  chat: ["retrieveFeedbackKb", "gatewayProxy"],
};

function requireRole(
  request: CallableRequest,
  action: string,
  roles: Role[] = ALLOWED_ROLES,
): FeedbackPrincipal {
  const uid = request.auth?.uid;
  const role = request.auth?.token?.role ?? "guest";
  const team = request.auth?.token?.team ?? "unassigned";

  if (!uid || !roles.includes(role)) {
    throw Object.assign(new Error(`AUTH-P0 denied for ${action}`), {
      code: "permission-denied", errorCode: "require_role_auth_p0_denied",
      behaviorLog: makeBehaviorLog(request, action, "deny", 0),
    });
  }

  const token = request.auth?.token;
  return {
    uid,
    role: role as Exclude<Role, "guest">,
    team,
    gameId: token?.gameId ?? "global",
    ...(token?.email || token?.memberEmail ? { email: token.email ?? token.memberEmail } : {}),
    ...(token?.name || token?.memberName ? { name: token.name ?? token.memberName } : {}),
  };
}

function authContextForPrincipal(principal: FeedbackPrincipal): AuthContext {
  return {
    userId: principal.uid,
    role: principal.role,
    team: principal.team,
    gameId: principal.gameId,
    ip: "server-callable",
    ...(principal.email ? { email: principal.email } : {}),
    ...(principal.name ? { name: principal.name } : {}),
  };
}

function asRecord(data: unknown): DataRecord {
  return data && typeof data === "object" && !Array.isArray(data) ? (data as DataRecord) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asRating(value: unknown): FeedbackRating {
  return value === "down" ? "down" : "up";
}

function asTarget(value: unknown): FeedbackTarget {
  return typeof value === "string" && TARGETS.includes(value as FeedbackTarget) ? (value as FeedbackTarget) : "chat";
}

function asDomain(value: unknown, target: FeedbackTarget): PipelineDomain {
  return typeof value === "string" && DOMAINS.includes(value as PipelineDomain) ? (value as PipelineDomain) : PIPELINE_BY_TARGET[target];
}

function asDownReason(value: unknown, rating: FeedbackRating): string | undefined {
  if (rating !== "down") return undefined;
  const reason = asString(value, "기타");
  return DOWN_REASONS.includes(reason as (typeof DOWN_REASONS)[number]) ? reason : "기타";
}

function asReviewDecision(value: unknown): ReviewDecision | null {
  if (value === "approve" || value === "reject") return value;
  return null;
}

function makeId(prefix: string, seed: string): string {
  const normalized = seed.toLowerCase().replace(/[^a-z0-9가-힣]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `${prefix}-${normalized || "item"}-${randomUUID()}`.slice(0, 180);
}

function stableId(prefix: string, seed: string): string {
  const normalized = seed.toLowerCase().replace(/[^a-z0-9가-힣_-]+/gi, "-").replace(/^-|-$/g, "").slice(0, 100);
  return `${prefix}-${normalized || "item"}`;
}

function sanitizeRef(value: unknown, fallback: string): string {
  return redactKnowledgeRef(asString(value, fallback), fallback).slice(0, 160);
}

function redactSensitiveText(value: string): string {
  return redactKnowledgeText(value);
}

function sanitizeExcerpt(value: unknown): string {
  const text = redactSensitiveText(asString(value, "sanitized feedback artifact"))
    .replace(/\b(prompt|response|raw|query)\s*[:=][\s\S]*/gi, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (text || "sanitized feedback artifact").slice(0, 240);
}

function sanitizeOptionalExcerpt(value: unknown): string {
  if (!asString(value)) return "";
  const sanitized = sanitizeExcerpt(value);
  return sanitized === "sanitized feedback artifact" ? "" : sanitized;
}

function boundedRetrieveLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(10, Math.max(1, Math.trunc(parsed))) : 5;
}

function boundedCandidateLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(500, Math.max(25, Math.trunc(parsed))) : 200;
}

function textTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9가-힣_@.-]+/).filter((token) => token.length >= 2));
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function kbEntryText(entry: DataRecord): string {
  return [
    entry.target,
    entry.pipelineDomain,
    entry.rating,
    entry.reason,
    entry.note,
    entry.sanitizedExcerpt,
    Array.isArray(entry.tags) ? entry.tags.join(" ") : "",
  ].map((value) => asString(value)).join(" ");
}

function scoreKbEntry(entry: DataRecord, queryTokens: Set<string>, target: FeedbackTarget, domain: PipelineDomain): number {
  let score = 0;
  if (entry.target === target) score += 4;
  if (entry.pipelineDomain === domain) score += 4;
  const entryTokens = textTokens(kbEntryText(entry));
  let lexicalMatches = 0;
  for (const token of queryTokens) {
    if (!entryTokens.has(token)) continue;
    lexicalMatches += 1;
    score += 3;
  }
  // Target/domain equality narrows the candidates, but it is not lexical
  // relevance. Never inject arbitrary reviewed guidance on zero token overlap.
  if (lexicalMatches === 0) return 0;
  return score;
}

function normalizeKbEntry(id: string, data: DataRecord): DataRecord {
  return {
    id,
    feedbackRef: asString(data.feedbackRef),
    artifactRef: asString(data.artifactRef),
    target: asString(data.target),
    pipelineDomain: asString(data.pipelineDomain),
    rating: asString(data.rating),
    reason: data.reason ?? null,
    note: sanitizeOptionalExcerpt(data.note),
    sanitizedExcerpt: sanitizeExcerpt(data.sanitizedExcerpt),
    sourceRefs: Array.isArray(data.sourceRefs) ? data.sourceRefs : [],
    tags: Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === "string") : [],
    reviewStatus: asString(data.reviewStatus),
    retrievalStatus: asString(data.retrievalStatus),
    evalStatus: asString(data.evalStatus),
    promotionStatus: asString(data.promotionStatus),
    promptVersion: asString(data.promptVersion),
    policyVersion: asString(data.policyVersion),
    reviewedExampleRef: asString(data.reviewedExampleRef),
    evalDatasetItemRef: asString(data.evalDatasetItemRef),
    evalResultRef: asString(data.evalResultRef),
    promotionRef: asString(data.promotionRef),
    createdAt: asString(data.createdAt),
    promotedAt: asString(data.promotedAt),
    revision: Number.isInteger(data.revision) ? data.revision : 0,
    scope: feedbackScopeFromStored(data.scope),
  };
}

function scopePayload(data: DataRecord): Pick<RetrieveFeedbackKbInput, "programId" | "campaignId" | "locale" | "globalScope"> {
  return {
    programId: data.programId,
    campaignId: data.campaignId,
    locale: data.locale,
    globalScope: data.globalScope,
  };
}

function scopeSafeId(value: unknown): string {
  return asString(value).replace(/[^a-zA-Z0-9._~-]/g, "-").replace(/-+/g, "-").slice(0, 160);
}

async function resolveFeedbackScope(
  input: Pick<RetrieveFeedbackKbInput, "programId" | "campaignId" | "locale" | "globalScope">,
  principal: FeedbackPrincipal,
): Promise<FeedbackGovernanceScope> {
  if (input.globalScope === EXPLICIT_GLOBAL_SCOPE) {
    return buildFeedbackGovernanceScope({ locale: input.locale, globalScope: input.globalScope });
  }
  const canonicalProgramId = resolveCanonicalProgramId(input.programId);
  const campaignId = scopeSafeId(input.campaignId);
  if (!canonicalProgramId || !campaignId) {
    throw Object.assign(new Error("invalid-argument: exact programId/campaignId/locale scope or globalScope=global is required"), { code: "invalid-argument", errorCode: "resolve_feedback_scope_exact_program_id_campaign_id" });
  }
  const campaignSnapshot = await adminDb.collection("campaigns").doc(campaignId).get();
  if (!campaignSnapshot.exists) {
    throw Object.assign(new Error("not-found: scoped campaign does not exist"), { code: "not-found", errorCode: "resolve_feedback_scope_scoped_campaign_exist" });
  }
  const campaign = campaignSnapshot.data() ?? {};
  const campaignRow = { id: campaignSnapshot.id, ...campaign };
  if (
    principal.role === "manager"
    && !rowMatchesAccountScope("campaigns", campaignRow, authContextForPrincipal(principal))
  ) {
    throw Object.assign(new Error("permission-denied: campaign belongs to another account"), { code: "permission-denied", errorCode: "resolve_feedback_scope_campaign_belongs_another_account" });
  }
  const storedCampaignId = scopeSafeId(campaign.id) || campaignSnapshot.id;
  const campaignCanonicalProgramId = resolveCanonicalProgramId(campaign.canonicalProgramId ?? campaign.programId);
  const accountOwnerUid = scopeSafeId(campaign.ownerUid ?? campaign.campaignOwnerUid ?? campaign.createdBy);
  if (storedCampaignId !== campaignId) {
    throw Object.assign(new Error("failed-precondition: campaign identity mismatch"), { code: "failed-precondition", errorCode: "resolve_feedback_scope_campaign_identity_mismatch" });
  }
  try {
    return buildFeedbackGovernanceScope({
      canonicalProgramId,
      campaignId,
      campaignCanonicalProgramId,
      accountOwnerUid,
      locale: input.locale,
    });
  } catch (error) {
    throw Object.assign(new Error("failed-precondition: feedback scope mismatch"), {
      code: "failed-precondition", errorCode: "resolve_feedback_scope_feedback_scope_mismatch",
      cause: error,
    });
  }
}

function feedbackKbEntryCollection(scope: FeedbackGovernanceScope) {
  return adminDb.collection("feedback_kb_scopes").doc(scope.scopeKey).collection("feedback_kb_entries");
}

function reviewStateFromFeedback(feedback: DataRecord): FeedbackReviewState {
  return {
    status: asString(feedback.status, "review_pending"),
    reviewStatus: asString(feedback.reviewStatus, "pending"),
    retrievalStatus: asString(feedback.retrievalStatus, "excluded_unreviewed"),
    evalStatus: asString(feedback.evalStatus, "not_started"),
    promotionStatus: asString(feedback.promotionStatus, "not_promoted"),
    revision: Number.isInteger(feedback.revision) ? Number(feedback.revision) : 0,
    lastTransitionId: asString(feedback.lastTransitionId) || undefined,
  };
}

function refLeaf(ref: string): string {
  return ref.split("/").filter(Boolean).pop() ?? "item";
}

function makeBehaviorLog(request: CallableRequest, action: string, result: BehaviorLog["result"], cost: number): BehaviorLog {
  return {
    userId: request.auth?.uid ?? "anonymous",
    role: request.auth?.token?.role ?? "guest",
    team: request.auth?.token?.team ?? "unassigned",
    gameId: asString(asRecord(request.data).gameId, "global"),
    action,
    time: new Date().toISOString(),
    IP: request.rawRequest?.ip ? `ip-${fingerprint(request.rawRequest.ip)}` : "unavailable",
    result,
    cost,
  };
}

function vectorCapability() {
  return {
    status: "unavailable" as const,
    reason: "embedding_provider_not_configured" as const,
    indexedDocuments: 0,
  };
}

function lexicalCapability() {
  return {
    strategy: FEEDBACK_LEXICAL_STRATEGY,
    status: "available" as const,
    store: "firestore-feedback-kb" as const,
  };
}

function lineageFromEntries(entries: DataRecord[]) {
  return entries.map((entry) => ({
    feedbackRef: asString(entry.feedbackRef),
    reviewedExampleRef: asString(entry.reviewedExampleRef),
    evalDatasetItemRef: asString(entry.evalDatasetItemRef),
    evalResultRef: asString(entry.evalResultRef),
    promotionRef: asString(entry.promotionRef),
    promptVersion: asString(entry.promptVersion),
    policyVersion: asString(entry.policyVersion),
  }));
}

async function retrieveFeedbackKbInternal(request: CallableRequest, input: RetrieveFeedbackKbInput) {
  const principal = requireRole(request, "retrieveFeedbackKb");
  const target = asTarget(input.target);
  const domain = asDomain(input.pipelineDomain, target);
  const scope = await resolveFeedbackScope(input, principal);
  const limit = boundedRetrieveLimit(input.limit);
  const candidateLimit = boundedCandidateLimit(input.candidateLimit);
  const query = sanitizeExcerpt(input.query);
  const artifactRef = sanitizeRef(input.artifactRef, `artifacts/${target}/unspecified`);
  const queryTokens = textTokens(query);
  const queryFingerprint = fingerprint(`${scope.scopeKey}|${domain}|${target}|${query}`);
  const cache = cacheMeta("feedback-kb-retrieve", [scope.scopeKey, domain, target, queryFingerprint, artifactRef]);
  const cost = costLog(FEEDBACK_LEXICAL_STRATEGY, cache.key, queryTokens.size, 0);

  // Each exact program/campaign/locale scope has its own physical collection.
  // We page a deterministic latest window and report truncation honestly; legacy
  // unscoped entries live elsewhere and therefore fail closed by construction.
  const entriesCollection = feedbackKbEntryCollection(scope);
  const decodedCursor = decodeFeedbackCursor(input.cursor);
  if (input.cursor && !decodedCursor) {
    throw Object.assign(new Error("invalid-argument: invalid feedback retrieval cursor"), { code: "invalid-argument", errorCode: "retrieve_feedback_kb_internal_invalid_feedback_retrieval_cursor" });
  }
  let candidateQuery: FirebaseFirestore.Query = entriesCollection
    .orderBy("promotedAt", "desc")
    .orderBy(FieldPath.documentId(), "asc");
  if (decodedCursor) candidateQuery = candidateQuery.startAfter(decodedCursor.promotedAt, decodedCursor.id);
  const [snapshot, activeCountSnapshot] = await Promise.all([
    candidateQuery.limit(candidateLimit + 1).get(),
    entriesCollection.where("retrievalStatus", "==", "active").count().get(),
  ]);
  const hasMoreCandidates = snapshot.docs.length > candidateLimit;
  const candidateDocs = hasMoreCandidates ? snapshot.docs.slice(0, candidateLimit) : snapshot.docs;
  const matchingCandidates = candidateDocs
    .map((doc) => ({ doc, entry: normalizeKbEntry(doc.id, doc.data() ?? {}) }))
    .filter(({ entry }) => {
      const entryScope = entry.scope as FeedbackGovernanceScope | null;
      return entryScope
        && feedbackScopesEqual(entryScope, scope)
        && entry.target === target
        && entry.pipelineDomain === domain
        && entry.reviewStatus === "approved"
        && entry.retrievalStatus === "active"
        && entry.promotionStatus === "promoted"
        && entry.evalStatus === "passed";
    })
    .map(({ doc, entry }) => ({ doc, entry, score: scoreKbEntry(entry, queryTokens, target, domain) }))
    .filter(({ score }) => score > 0);
  const pageCandidates = matchingCandidates.slice(0, limit);
  const ranked: DataRecord[] = [...pageCandidates]
    .sort((left, right) => right.score - left.score || String(right.entry.promotedAt || right.entry.createdAt).localeCompare(String(left.entry.promotedAt || left.entry.createdAt)))
    .map(({ entry, score }) => ({ ...entry, score }));
  const sourceRefs = ranked.flatMap((entry) => Array.isArray(entry.sourceRefs) ? entry.sourceRefs : []);
  const retrievalDoc = adminDb.collection("feedback_kb_scopes").doc(scope.scopeKey).collection("retrievals").doc();
  const retrievalId = retrievalDoc.id;
  const retrievalRef = retrievalDoc.path;
  const createdAt = new Date().toISOString();
  const lineage = lineageFromEntries(ranked);
  const moreMatchesInWindow = matchingCandidates.length > limit;
  const cursorCandidate = moreMatchesInWindow
    ? pageCandidates.at(-1)?.doc
    : hasMoreCandidates
      ? candidateDocs.at(-1)
      : null;
  const nextCursor = cursorCandidate
    ? encodeFeedbackCursor(asString(cursorCandidate.get("promotedAt")), cursorCandidate.id)
    : null;
  const totalActive = activeCountSnapshot.data().count;
  const coverage = {
    mode: "latest-scoped-page" as const,
    candidateLimit,
    scanned: candidateDocs.length,
    totalActive,
    totalMatched: hasMoreCandidates || Boolean(decodedCursor) ? null : matchingCandidates.length,
    truncated: hasMoreCandidates || moreMatchesInWindow || Boolean(decodedCursor),
    hasMore: Boolean(nextCursor),
    nextCursor,
  };
  await retrievalDoc.set({
    id: retrievalId,
    retrievalRef,
    scope,
    scopeKey: scope.scopeKey,
    target,
    pipelineDomain: domain,
    queryFingerprint,
    queryTokenCount: queryTokens.size,
    artifactRef,
    entryRefs: ranked.map((entry) => `${entriesCollection.path}/${asString(entry.id)}`),
    sourceRefs,
    lineage,
    retrieval: lexicalCapability(),
    vectorCapability: vectorCapability(),
    coverage,
    gate: "approved_feedback_only",
    createdBy: request.auth?.uid ?? "system",
    createdAt,
    artifactPolicy: "server-ref-only",
  }, { merge: true });
  return {
    ok: true,
    retrievalRef,
    target,
    pipelineDomain: domain,
    queryFingerprint,
    artifactRef,
    scope,
    entries: ranked,
    sourceRefs,
    lineage,
    retrieval: lexicalCapability(),
    vectorCapability: vectorCapability(),
    coverage,
    cache,
    costLog: cost,
    behaviorLog: makeBehaviorLog(request, "retrieveFeedbackKb", "allow", cost.estimatedUsd),
  };
}

export async function retrieveFeedbackKbForGate(request: CallableRequest, input: RetrieveFeedbackKbInput) {
  return retrieveFeedbackKbInternal(request, input);
}

function cacheMeta(kind: string, keyParts: string[]): CacheMeta {
  return {
    checked: true,
    hit: false,
    key: `${kind}:${keyParts.join(":")}`.slice(0, 200),
    ttlSeconds: 600,
  };
}

function costLog(
  model: string,
  cacheKey: string,
  inputTokens = 0,
  outputTokens = 0,
  provider: CostLog["provider"] = "internal",
): CostLog {
  return {
    provider,
    model,
    inputTokens,
    outputTokens,
    estimatedUsd: 0,
    cacheKey,
  };
}

async function enqueueAiHubFineTune(
  queueJob: DataRecord,
): Promise<{ externalJobRef: string; cancellationHandle: string; costLog: CostLog } | null> {
  if (!liveIntegrationsEnabled("aihub")) return null;

  const config = await getRuntimeIntegration("aiHub");
  const endpoint = publicString(config, "endpoint", "AIHUB_ENDPOINT");
  if (!endpoint) return null;
  const cancellationEndpoint = publicString(config, "cancellationEndpoint", "AIHUB_CANCELLATION_ENDPOINT");
  if (!cancellationEndpoint) {
    throw Object.assign(new Error("failed-precondition: AI Hub cancellation capability is unavailable"), {
      code: "aihub_cancellation_unavailable", errorCode: "enqueue_ai_hub_fine_tune_ai_hub_cancellation_capability_unavailable",
    });
  }

  const projectKey = requireEnvSecret("AIHUB_PROJECT_KEY", "AI Hub");
  const idempotencyKey = asString(queueJob.idempotencyKey);
  if (!idempotencyKey) {
    throw Object.assign(new Error("failed-precondition: fine-tune idempotency key is missing"), { code: "failed-precondition", errorCode: "enqueue_ai_hub_fine_tune_fine_tune_idempotency_key_missing" });
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      ...authHeader(projectKey),
    },
    body: JSON.stringify({
      projectId: publicString(config, "projectId", "AIHUB_PROJECT_ID"),
      region: publicString(config, "region", "AIHUB_REGION", "asia-northeast3"),
      queueRef: queueJob.queueRef,
      pipelineDomain: queueJob.pipelineDomain,
      target: queueJob.target,
      feedbackRef: queueJob.feedbackRef,
      promotionRef: queueJob.promotionRef,
      reviewedExampleRef: queueJob.reviewedExampleRef,
      evalResultRef: queueJob.evalResultRef,
      idempotencyKey,
      artifactPolicy: "server-ref-only",
    }),
    signal: timeoutSignal(12_000),
  });
  if (!response.ok) throw Object.assign(new Error(`AI Hub fine-tune queue failed (${response.status})`), { code: "failed-precondition", errorCode: "enqueue_ai_hub_fine_tune_ai_hub_fine_tune" });

  const json = asRecord(await response.json());
  const cancellationHandle = requireCancellationHandle(
    asString(json.cancellationHandle, asString(json.jobRef, asString(json.id))),
  );
  return {
    externalJobRef: asString(json.jobRef, asString(json.id, cancellationHandle)),
    cancellationHandle,
    costLog: costLog("ai-hub-fine-tune-queue", String(queueJob.queueRef), 0, 0, "ai-hub"),
  };
}

async function cancelAiHubFineTune(input: {
  cancellationHandle: string;
  idempotencyKey: string;
  queueRef: string;
}): Promise<void> {
  if (!liveIntegrationsEnabled("aihub")) {
    throw Object.assign(new Error("failed-precondition: AI Hub cancellation capability is unavailable"), {
      code: "aihub_cancellation_unavailable", errorCode: "cancel_ai_hub_fine_tune_ai_hub_cancellation_capability_unavailable",
    });
  }
  const config = await getRuntimeIntegration("aiHub");
  const cancellationEndpoint = publicString(config, "cancellationEndpoint", "AIHUB_CANCELLATION_ENDPOINT");
  if (!cancellationEndpoint) {
    throw Object.assign(new Error("failed-precondition: AI Hub cancellation capability is unavailable"), {
      code: "aihub_cancellation_unavailable", errorCode: "cancel_ai_hub_fine_tune_ai_hub_cancellation_capability_unavailable_2",
    });
  }
  const projectKey = requireEnvSecret("AIHUB_PROJECT_KEY", "AI Hub");
  const cancellationHandle = requireCancellationHandle(input.cancellationHandle);
  const response = await fetch(cancellationEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
      ...authHeader(projectKey),
    },
    body: JSON.stringify({
      cancellationHandle,
      queueRef: input.queueRef,
      idempotencyKey: input.idempotencyKey,
      artifactPolicy: "server-ref-only",
    }),
    signal: timeoutSignal(12_000),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`AI Hub fine-tune cancellation failed (${response.status})`), {
      code: "aihub_cancellation_failed", errorCode: "cancel_ai_hub_fine_tune_ai_hub_fine_tune_cancellation",
    });
  }
}

function promotionLineage(feedbackId: string, revision: number) {
  const revisionId = stableId("feedback-revision", `${feedbackId}-r${revision}`);
  return {
    reviewedExampleRef: `reviewed_examples/${revisionId}`,
    evalDatasetItemRef: `eval_dataset_items/${revisionId}`,
    evalResultRef: `eval_results/${revisionId}`,
    promotionRef: `prompt_policy_promotions/${revisionId}`,
    currentLineageRef: `feedback_lineage_current/${stableId("feedback", feedbackId)}`,
    promptVersion: FEEDBACK_PROMPT_VERSION,
    policyVersion: FEEDBACK_POLICY_VERSION,
    evalDatasetVersion: FEEDBACK_EVAL_DATASET_VERSION,
  };
}

function reviewedArtifactIntegrityEval(guidance: string, lineage: ReturnType<typeof promotionLineage>) {
  const lineageRefs = [
    [lineage.reviewedExampleRef, "reviewed_examples/"],
    [lineage.evalDatasetItemRef, "eval_dataset_items/"],
    [lineage.evalResultRef, "eval_results/"],
    [lineage.promotionRef, "prompt_policy_promotions/"],
  ] as const;
  const containsSensitiveText = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(guidance)
    || /https?:\/\/\S+/i.test(guidance)
    || /\b(api[_-]?key|secret|token|password)\s*[:=]\s*(?!\[redacted-secret\])\S+/i.test(guidance);
  const assertions = {
    hasSanitizedGuidance: guidance.length >= 4 && guidance !== "sanitized feedback artifact",
    validServerLineage: lineageRefs.every(([ref, prefix]) => ref.startsWith(prefix) && ref.length > prefix.length),
    noRawPromptFields: !/\b(prompt|response|raw|query)\s*[:=]/i.test(guidance),
    noSensitiveText: !containsSensitiveText,
    noCapabilityClaim: !/\b(vectorRef|embeddingRef)\b|\b(vector|embedding)\s+(index|store|provider)\b/i.test(guidance),
  };
  return {
    status: Object.values(assertions).every(Boolean) ? "passed" as const : "failed" as const,
    score: Object.values(assertions).filter(Boolean).length / Object.keys(assertions).length,
    assertions,
  };
}

function feedbackSubmissionFingerprint(input: {
  scopeKey: string;
  target: FeedbackTarget;
  domain: PipelineDomain;
  rating: FeedbackRating;
  reason?: string;
  artifactRef: string;
  sanitizedExcerpt: string;
  sanitizedNote: string;
}): string {
  return fingerprint(JSON.stringify([
    input.scopeKey,
    input.target,
    input.domain,
    input.rating,
    input.reason ?? null,
    input.artifactRef,
    input.sanitizedExcerpt,
    input.sanitizedNote,
  ]));
}

function storedFeedbackFingerprint(feedback: DataRecord): string {
  const target = asTarget(feedback.target);
  const scope = feedbackScopeFromStored(feedback.scope);
  return feedbackSubmissionFingerprint({
    scopeKey: scope?.scopeKey ?? "legacy-unscoped",
    target,
    domain: asDomain(feedback.pipelineDomain, target),
    rating: asRating(feedback.rating),
    reason: asDownReason(feedback.reason, asRating(feedback.rating)),
    artifactRef: sanitizeRef(feedback.artifactRef, `artifacts/${target}/unspecified`),
    sanitizedExcerpt: sanitizeExcerpt(feedback.sanitizedExcerpt ?? feedback.excerpt),
    sanitizedNote: sanitizeOptionalExcerpt(feedback.note),
  });
}

function feedbackReviewIsTerminal(feedback: DataRecord): boolean {
  return feedback.reviewStatus === "approved"
    || feedback.reviewStatus === "rejected"
    || feedback.status === "promoted"
    || feedback.status === "rejected"
    || feedback.status === "eval_failed"
    || feedback.evalStatus === "passed"
    || feedback.evalStatus === "failed"
    || feedback.promotionStatus === "promoted"
    || feedback.promotionStatus === "revoked";
}

const FEEDBACK_GRAPH_PROJECTION_COLLECTION = "feedback_graph_projection_outbox";

type FeedbackGraphProjectionStatus = "pending" | "processing" | "complete" | "retryable";

type FeedbackGraphProjectionResult = {
  status: FeedbackGraphProjectionStatus;
  outboxRef: string;
  revision: number;
  attemptCount: number;
  idempotent: boolean;
  knowledgeNodeRef?: string;
  canonicalNodeRef?: string;
  kbIngestStatus?: "ingested" | "duplicate" | "conflict";
  conflictRef?: string;
  lastErrorCode?: string;
};

function graphProjectionOutboxDoc(feedbackId: string) {
  return adminDb.collection(FEEDBACK_GRAPH_PROJECTION_COLLECTION)
    .doc(stableId("feedback-graph", feedbackId));
}

function graphProjectionStatus(value: unknown): FeedbackGraphProjectionStatus {
  return value === "processing" || value === "complete" || value === "retryable"
    ? value
    : "pending";
}

function graphProjectionErrorCode(error: unknown): string {
  const code = error && typeof error === "object" ? asString((error as DataRecord).code) : "";
  return (code || "knowledge_graph_projection_failed")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 80);
}

function projectionNodeInput(outbox: DataRecord, canonical: boolean): KnowledgeNodeInput {
  const scope = feedbackScopeFromStored(outbox.scope);
  if (!scope) {
    throw Object.assign(new Error("failed-precondition: graph projection scope is invalid"), { code: "failed-precondition", errorCode: "projection_node_input_graph_projection_scope_invalid" });
  }
  const sourceRefs = Array.isArray(outbox.sourceRefs)
    ? outbox.sourceRefs.map((value) => {
        const item = asRecord(value);
        return makeSourceRef(
          asString(item.ref),
          item.type === "feedback" ? "feedback" : "artifact",
          asString(item.summary),
        );
      }).filter((value) => Boolean(value.ref))
    : [];
  const entityRefs = Array.isArray(outbox.entityRefs)
    ? outbox.entityRefs.map((value) => sanitizeRef(value, "")).filter(Boolean)
    : [];
  return {
    id: asString(canonical ? outbox.canonicalNodeId : outbox.knowledgeNodeId),
    type: "feedback_kb",
    title: sanitizeExcerpt(outbox.title),
    summary: sanitizeExcerpt(outbox.summary),
    sourceRefs,
    entityRefs,
    governanceScope: scope,
    createdAtIso: asString(outbox.createdAt, new Date().toISOString()),
  };
}

async function processFeedbackGraphProjection(
  graphProjectionOutboxRef: string,
  actorId: string,
): Promise<FeedbackGraphProjectionResult> {
  const outboxDocRef = adminDb.doc(graphProjectionOutboxRef);
  const leaseId = randomUUID();
  const claimed = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(outboxDocRef);
    if (!snapshot.exists) {
      throw Object.assign(new Error("not-found: feedback graph projection outbox does not exist"), { code: "not-found", errorCode: "process_feedback_graph_projection_feedback_graph_projection_outbox" });
    }
    const outbox = snapshot.data() ?? {};
    const status = graphProjectionStatus(outbox.status);
    const revision = Number.isInteger(outbox.revision) ? Number(outbox.revision) : 0;
    const attemptCount = Number.isInteger(outbox.attemptCount) ? Number(outbox.attemptCount) : 0;
    if (status === "complete") {
      return { claimed: false as const, outbox, status, revision, attemptCount };
    }
    const leaseUntilMs = Date.parse(asString(outbox.leaseUntil));
    if (status === "processing" && Number.isFinite(leaseUntilMs) && leaseUntilMs > Date.now()) {
      return { claimed: false as const, outbox, status, revision, attemptCount };
    }
    const claimedAt = new Date().toISOString();
    const nextRevision = revision + 1;
    const nextAttemptCount = attemptCount + 1;
    transaction.set(outboxDocRef, {
      status: "processing",
      revision: nextRevision,
      attemptCount: nextAttemptCount,
      leaseId,
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      claimedBy: actorId,
      claimedAt,
      updatedAt: claimedAt,
    }, { merge: true });
    return {
      claimed: true as const,
      outbox,
      status: "processing" as const,
      revision: nextRevision,
      attemptCount: nextAttemptCount,
    };
  });

  if (!claimed.claimed) {
    return {
      status: claimed.status,
      outboxRef: graphProjectionOutboxRef,
      revision: claimed.revision,
      attemptCount: claimed.attemptCount,
      idempotent: true,
      ...(asString(claimed.outbox.knowledgeNodeRef) ? { knowledgeNodeRef: asString(claimed.outbox.knowledgeNodeRef) } : {}),
      ...(asString(claimed.outbox.canonicalNodeRef) ? { canonicalNodeRef: asString(claimed.outbox.canonicalNodeRef) } : {}),
      ...(claimed.outbox.kbIngestStatus === "ingested" || claimed.outbox.kbIngestStatus === "duplicate" || claimed.outbox.kbIngestStatus === "conflict"
        ? { kbIngestStatus: claimed.outbox.kbIngestStatus }
        : {}),
      ...(asString(claimed.outbox.conflictRef) ? { conflictRef: asString(claimed.outbox.conflictRef) } : {}),
      ...(asString(claimed.outbox.lastErrorCode) ? { lastErrorCode: asString(claimed.outbox.lastErrorCode) } : {}),
    };
  }

  try {
    const graphBatch = adminDb.batch();
    const knowledgeNodeRef = writeKnowledgeNode(graphBatch, projectionNodeInput(claimed.outbox, false));
    await graphBatch.commit();
    const kbIngest = await ingestKnowledgeNode(projectionNodeInput(claimed.outbox, true));
    const completed = await adminDb.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(outboxDocRef);
      const outbox = snapshot.data() ?? {};
      const currentRevision = Number.isInteger(outbox.revision) ? Number(outbox.revision) : claimed.revision;
      if (!snapshot.exists || outbox.status !== "processing" || outbox.leaseId !== leaseId) {
        return { updated: false as const, outbox, revision: currentRevision };
      }
      const completedAt = new Date().toISOString();
      const revision = currentRevision + 1;
      transaction.set(outboxDocRef, {
        status: "complete",
        revision,
        leaseId: null,
        leaseUntil: null,
        knowledgeNodeRef,
        canonicalNodeRef: kbIngest.nodePath,
        kbIngestStatus: kbIngest.status,
        conflictRef: kbIngest.status === "conflict" ? kbIngest.reviewPath : null,
        lastErrorCode: null,
        completedBy: actorId,
        completedAt,
        updatedAt: completedAt,
      }, { merge: true });
      const feedbackRef = asString(outbox.feedbackRef);
      if (feedbackRef.startsWith("feedback/")) {
        transaction.set(adminDb.doc(feedbackRef), {
          graphProjectionStatus: "complete",
          graphProjectionOutboxRef,
          knowledgeNodeRef,
          canonicalKnowledgeNodeRef: kbIngest.nodePath,
          kbIngestStatus: kbIngest.status,
        }, { merge: true });
      }
      const kbEntryRef = asString(outbox.kbEntryRef);
      if (/^feedback_kb_scopes\/[^/]+\/feedback_kb_entries\/[^/]+$/.test(kbEntryRef)) {
        transaction.set(adminDb.doc(kbEntryRef), {
          graphProjectionStatus: "complete",
          graphProjectionOutboxRef,
          knowledgeNodeRef,
          canonicalKnowledgeNodeRef: kbIngest.nodePath,
          kbIngestStatus: kbIngest.status,
        }, { merge: true });
      }
      return { updated: true as const, outbox, revision };
    });
    if (!completed.updated) {
      return {
        status: graphProjectionStatus(completed.outbox.status),
        outboxRef: graphProjectionOutboxRef,
        revision: completed.revision,
        attemptCount: claimed.attemptCount,
        idempotent: true,
      };
    }
    return {
      status: "complete",
      outboxRef: graphProjectionOutboxRef,
      revision: completed.revision,
      attemptCount: claimed.attemptCount,
      idempotent: false,
      knowledgeNodeRef,
      canonicalNodeRef: kbIngest.nodePath,
      kbIngestStatus: kbIngest.status,
      ...(kbIngest.status === "conflict" ? { conflictRef: kbIngest.reviewPath } : {}),
    };
  } catch (error) {
    const lastErrorCode = graphProjectionErrorCode(error);
    const failed = await adminDb.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(outboxDocRef);
      const outbox = snapshot.data() ?? {};
      const status = graphProjectionStatus(outbox.status);
      const currentRevision = Number.isInteger(outbox.revision) ? Number(outbox.revision) : claimed.revision;
      if (!snapshot.exists || status === "complete" || outbox.leaseId !== leaseId) {
        return { status, revision: currentRevision, updated: false as const };
      }
      const failedAt = new Date().toISOString();
      const revision = currentRevision + 1;
      transaction.set(outboxDocRef, {
        status: "retryable",
        revision,
        leaseId: null,
        leaseUntil: null,
        lastErrorCode,
        failedBy: actorId,
        failedAt,
        updatedAt: failedAt,
      }, { merge: true });
      const feedbackRef = asString(outbox.feedbackRef);
      if (feedbackRef.startsWith("feedback/")) {
        transaction.set(adminDb.doc(feedbackRef), {
          graphProjectionStatus: "retryable",
          graphProjectionOutboxRef,
          graphProjectionLastErrorCode: lastErrorCode,
        }, { merge: true });
      }
      const kbEntryRef = asString(outbox.kbEntryRef);
      if (/^feedback_kb_scopes\/[^/]+\/feedback_kb_entries\/[^/]+$/.test(kbEntryRef)) {
        transaction.set(adminDb.doc(kbEntryRef), {
          graphProjectionStatus: "retryable",
          graphProjectionOutboxRef,
          graphProjectionLastErrorCode: lastErrorCode,
        }, { merge: true });
      }
      return { status: "retryable" as const, revision, updated: true as const };
    });
    return {
      status: failed.status,
      outboxRef: graphProjectionOutboxRef,
      revision: failed.revision,
      attemptCount: claimed.attemptCount,
      idempotent: !failed.updated,
      ...(failed.status === "retryable" ? { lastErrorCode } : {}),
    };
  }
}

/**
 * Core write path for submitFeedback — scope resolution + the feedback/kbEntry/graph-
 * projection transaction + graph-projection dispatch. Factored out so a system-triggered
 * writer (functions/manualReplyLearning.ts) can reuse the exact same idempotency,
 * scope-resolution and Firestore-write contract instead of re-implementing it, without
 * going through the request-bound `requireRole` callable boundary. Behavior for the
 * public callable is unchanged: `submitFeedback` below calls this with no `extra` and
 * attaches the request-bound `behaviorLog` on top of the returned envelope.
 */
async function submitFeedbackCore(
  principal: FeedbackPrincipal,
  data: DataRecord,
  extra?: SubmitFeedbackCoreExtra,
) {
  const scope = await resolveFeedbackScope(scopePayload(data), principal);
  const target = asTarget(data.target);
  const domain = asDomain(data.pipelineDomain, target);
  const rating = asRating(data.rating);
  const reason = asDownReason(data.reason, rating);
  const artifactRef = sanitizeRef(data.artifactRef, `artifacts/${target}/unspecified`);
  const requestedFeedbackRef = sanitizeRef(data.feedbackRef, "");
  const feedbackId = requestedFeedbackRef.startsWith("feedback/")
    ? refLeaf(requestedFeedbackRef)
    : makeId("fb", `${target}-${rating}-${principal.uid}`);
  const feedbackRef = `feedback/${feedbackId}`;
  const kbEntryId = stableId("kb", feedbackId);
  const kbEntryRef = feedbackKbEntryCollection(scope).doc(kbEntryId).path;
  const graphProjectionOutboxDocRef = graphProjectionOutboxDoc(feedbackId);
  const graphProjectionOutboxRef = graphProjectionOutboxDocRef.path;
  const sanitizedExcerpt = sanitizeExcerpt(data.excerpt);
  const sanitizedNote = sanitizeOptionalExcerpt(data.note);
  const submissionFingerprint = feedbackSubmissionFingerprint({
    scopeKey: scope.scopeKey,
    target,
    domain,
    rating,
    reason,
    artifactRef,
    sanitizedExcerpt,
    sanitizedNote,
  });
  const createdAt = new Date().toISOString();
  const sourceRefs = [
    makeSourceRef(artifactRef, "artifact", "reviewed AI artifact reference"),
    makeSourceRef(feedbackRef, "feedback", reason ?? rating),
  ];

  const kbEntry = {
    // Caller-supplied extras go first so none of the governance fields declared below can
    // ever be overridden by them (reviewStatus/tags/etc. always come from this function).
    ...(extra?.extraFields ?? {}),
    id: kbEntryId,
    feedbackRef,
    artifactRef,
    target,
    pipelineDomain: domain,
    scope,
    scopeKey: scope.scopeKey,
    scopeVersion: FEEDBACK_SCOPE_VERSION,
    rating,
    reason: reason ?? null,
    note: sanitizedNote,
    sanitizedExcerpt,
    sourceRefs,
    tags: [
      domain,
      rating === "down" ? "negative" : "positive",
      reason ?? "accepted",
      ...(extra?.extraTags ?? []),
    ],
    ...(extra?.source ? { source: extra.source } : {}),
    reviewStatus: "pending",
    retrievalStatus: "excluded_unreviewed",
    evalStatus: "not_started",
    promotionStatus: "not_promoted",
    fineTuneStatus: "not_requested",
    graphProjectionStatus: "pending",
    graphProjectionOutboxRef,
    revision: 0,
    lastTransitionId: null,
    promptVersion: null,
    policyVersion: FEEDBACK_POLICY_VERSION,
    createdBy: principal.uid,
    createdAt,
    submissionFingerprint,
    artifactPolicy: "server-ref-only",
  };
  const feedbackDoc = {
    // Same override-safety ordering as kbEntry above.
    ...(extra?.extraFields ?? {}),
    id: feedbackId,
    feedbackRef,
    kbEntryRef,
    artifactRef,
    target,
    pipelineDomain: domain,
    scope,
    scopeKey: scope.scopeKey,
    scopeVersion: FEEDBACK_SCOPE_VERSION,
    rating,
    reason: reason ?? null,
    note: sanitizedNote,
    excerpt: sanitizedExcerpt,
    sanitizedExcerpt,
    sourceRefs,
    tags: kbEntry.tags,
    ...(extra?.source ? { source: extra.source } : {}),
    model: sanitizeExcerpt(data.model ?? "unknown-model"),
    user: principal.uid,
    team: principal.team,
    time: createdAt,
    createdBy: principal.uid,
    createdAt,
    status: "review_pending",
    reviewStatus: "pending",
    retrievalStatus: "excluded_unreviewed",
    evalStatus: "not_started",
    promotionStatus: "not_promoted",
    fineTuneStatus: "not_requested",
    fineTuneRevision: 0,
    graphProjectionStatus: "pending",
    graphProjectionOutboxRef,
    revision: 0,
    lastTransitionId: null,
    policyVersion: FEEDBACK_POLICY_VERSION,
    submissionFingerprint,
    artifactPolicy: "server-ref-only",
  };
  const graphProjectionDoc = {
    id: graphProjectionOutboxDocRef.id,
    outboxRef: graphProjectionOutboxRef,
    feedbackRef,
    kbEntryRef,
    knowledgeNodeId: `feedback-kb-${kbEntryId}`,
    canonicalNodeId: `feedback-canonical-${feedbackId}`,
    title: `${domain}:${target}:${rating}:review-pending`,
    summary: sanitizedExcerpt,
    sourceRefs,
    entityRefs: [feedbackRef, artifactRef],
    scope,
    scopeKey: scope.scopeKey,
    status: "pending",
    revision: 0,
    attemptCount: 0,
    leaseId: null,
    leaseUntil: null,
    createdBy: principal.uid,
    createdAt,
    updatedAt: createdAt,
    artifactPolicy: "server-ref-only",
  };
  const feedbackDocRef = adminDb.collection("feedback").doc(feedbackId);
  const kbEntryDocRef = adminDb.doc(kbEntryRef);
  const submission = await adminDb.runTransaction(async (transaction) => {
    const existingSnapshot = await transaction.get(feedbackDocRef);
    const graphProjectionSnapshot = await transaction.get(graphProjectionOutboxDocRef);
    const existing = existingSnapshot.data() ?? {};
    if (existingSnapshot.exists) {
      const existingOwner = asString(existing.createdBy, asString(existing.user));
      if (!existingOwner || existingOwner !== principal.uid) {
        throw Object.assign(
          new Error("permission-denied: feedbackRef is already owned by another submission"),
          { code: "permission-denied", errorCode: "submit_feedback_feedback_ref_already_owned_by" },
        );
      }
      const existingFingerprint = asString(existing.submissionFingerprint) || storedFeedbackFingerprint(existing);
      if (existingFingerprint !== submissionFingerprint) {
        const state = feedbackReviewIsTerminal(existing) ? "reviewed" : "pending";
        throw Object.assign(
          new Error(`failed-precondition: ${state} feedback cannot be overwritten; submit a new feedbackRef`),
          { code: "failed-precondition", errorCode: "submit_feedback_feedback_cannot_be_overwritten_submit" },
        );
      }
      requireStoredFeedbackScope(existing.scope, scope);
      if (!graphProjectionSnapshot.exists) {
        transaction.create(graphProjectionOutboxDocRef, graphProjectionDoc);
        transaction.set(feedbackDocRef, {
          graphProjectionStatus: "pending",
          graphProjectionOutboxRef,
        }, { merge: true });
      }
      return { kind: "existing" as const, existing };
    }
    transaction.set(feedbackDocRef, feedbackDoc, { merge: true });
    transaction.set(kbEntryDocRef, kbEntry, { merge: true });
    transaction.create(graphProjectionOutboxDocRef, graphProjectionDoc);
    return { kind: "stored" as const, existing: feedbackDoc };
  });

  const graphProjection = await processFeedbackGraphProjection(graphProjectionOutboxRef, principal.uid);

  if (submission.kind === "existing") {
    const existing = submission.existing;
    const existingScope = feedbackScopeFromStored(existing.scope);
    return {
      feedbackRef,
      artifactRef: sanitizeRef(existing.artifactRef, artifactRef),
      kbRef: sanitizeRef(existing.kbEntryRef, kbEntryRef),
      status: asString(existing.status, "review_pending"),
      persisted: true,
      idempotent: true,
      graphProjection,
      pipeline: {
        domain: asDomain(existing.pipelineDomain, asTarget(existing.target)),
        consumers: PIPELINE_CONSUMERS[asDomain(existing.pipelineDomain, asTarget(existing.target))],
        reviewStatus: asString(existing.reviewStatus, "pending"),
        retrievalStatus: asString(existing.retrievalStatus, "excluded_unreviewed"),
        evalStatus: asString(existing.evalStatus, "not_started"),
        promotionStatus: asString(existing.promotionStatus, "not_promoted"),
        fineTuneStatus: asString(existing.fineTuneStatus, "not_requested"),
      },
      scope: existingScope,
      retrieval: lexicalCapability(),
      vectorCapability: vectorCapability(),
      artifactPolicy: "server-ref-only",
    };
  }

  return {
    feedbackRef,
    artifactRef,
    kbRef: kbEntryRef,
    ...(graphProjection.knowledgeNodeRef ? { knowledgeNodeRef: graphProjection.knowledgeNodeRef } : {}),
    ...(graphProjection.kbIngestStatus ? { kbIngestStatus: graphProjection.kbIngestStatus } : {}),
    graphProjection,
    status: "review_pending",
    persisted: true,
    pipeline: {
      domain,
      consumers: PIPELINE_CONSUMERS[domain],
      reviewStatus: "pending",
      retrievalStatus: "excluded_unreviewed",
      evalStatus: "not_started",
      promotionStatus: "not_promoted",
      fineTuneStatus: "not_requested",
    },
    scope,
    retrieval: lexicalCapability(),
    vectorCapability: vectorCapability(),
    artifactPolicy: "server-ref-only",
  };
}

export async function submitFeedback(request: CallableRequest) {
  const principal = requireRole(request, "submitFeedback");
  const result = await submitFeedbackCore(principal, asRecord(request.data));
  return {
    ...result,
    behaviorLog: makeBehaviorLog(request, "submitFeedback", "allow", 0),
  };
}

/**
 * Internal entry point for a system-triggered feedback-KB write (no callable request,
 * no `requireRole` check — the caller is trusted server code, not an end user). Used by
 * functions/manualReplyLearning.ts to capture implicit manual-reply candidates through
 * the exact same write/idempotency contract submitFeedback uses.
 */
export async function submitFeedbackAsSystem(
  principal: FeedbackPrincipal,
  data: DataRecord,
  extra: SubmitFeedbackCoreExtra,
) {
  return submitFeedbackCore(principal, data, extra);
}

export async function retryFeedbackGraphProjection(request: CallableRequest) {
  const principal = requireRole(request, "retryFeedbackGraphProjection", RELEASE_ROLES);
  const data = asRecord(request.data);
  const feedbackRef = sanitizeRef(data.feedbackRef, "");
  if (!feedbackRef.startsWith("feedback/")) {
    throw Object.assign(new Error("invalid-argument: feedbackRef is required"), { code: "invalid-argument", errorCode: "retry_feedback_graph_projection_feedback_ref_required" });
  }
  const graphProjectionOutboxRef = graphProjectionOutboxDoc(refLeaf(feedbackRef)).path;
  const requestedOutboxRef = sanitizeRef(data.graphProjectionOutboxRef, graphProjectionOutboxRef);
  if (requestedOutboxRef !== graphProjectionOutboxRef) {
    throw Object.assign(new Error("failed-precondition: graph projection outbox identity mismatch"), { code: "failed-precondition", errorCode: "retry_feedback_graph_projection_graph_projection_outbox_identity" });
  }
  const graphProjection = await processFeedbackGraphProjection(graphProjectionOutboxRef, principal.uid);
  return {
    ok: true,
    feedbackRef,
    graphProjectionOutboxRef,
    graphProjection,
    behaviorLog: makeBehaviorLog(request, "retryFeedbackGraphProjection", "allow", 0),
  };
}

// Compatibility name retained for deployed clients. This is no longer a fake
// vector-index action: it is the explicit human review/promotion gate.
export async function indexFeedbackKb(request: CallableRequest) {
  const principal = requireRole(request, "indexFeedbackKb", REVIEW_ROLES);
  const data = asRecord(request.data);
  const decision = asReviewDecision(data.reviewDecision);
  const target = asTarget(data.target);
  const requestedDomain = asDomain(data.pipelineDomain, target);
  const requestedScope = await resolveFeedbackScope(scopePayload(data), principal);
  const requestedFeedbackRef = sanitizeRef(data.feedbackRef, "");
  const artifactRef = sanitizeRef(data.artifactRef, `artifacts/${target}/unspecified`);
  const cache = cacheMeta("feedback-review", [requestedScope.scopeKey, requestedDomain, requestedFeedbackRef || "missing", artifactRef]);
  const cost = costLog("feedback-review-promotion", cache.key, 0, 0);

  if (!decision) {
    return {
      status: "requires_review",
      feedbackRef: requestedFeedbackRef || undefined,
      artifactRef,
      scope: requestedScope,
      persisted: false,
      retrieval: lexicalCapability(),
      vectorCapability: vectorCapability(),
      pipeline: { domain: requestedDomain, consumers: PIPELINE_CONSUMERS[requestedDomain], status: "review_pending" },
      cache,
      costLog: cost,
      behaviorLog: makeBehaviorLog(request, "indexFeedbackKb", "deny", 0),
    };
  }
  if (!requestedFeedbackRef.startsWith("feedback/")) {
    throw Object.assign(new Error("invalid-argument: feedbackRef is required for review"), { code: "invalid-argument", errorCode: "index_feedback_kb_feedback_ref_required_review" });
  }
  const feedbackId = refLeaf(requestedFeedbackRef);
  const feedbackRef = `feedback/${feedbackId}`;
  const reviewRef = `feedback_reviews/${feedbackId}`;
  const reviewedAt = new Date().toISOString();
  const reviewNote = sanitizeOptionalExcerpt(data.reviewNote);
  const correctionNote = sanitizeOptionalExcerpt(data.correctionNote);
  const expectedRevision = typeof data.expectedRevision === "number" ? data.expectedRevision : Number(data.expectedRevision);
  const transitionId = asString(data.transitionId);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw Object.assign(new Error("invalid-argument: expectedRevision is required"), { code: "invalid-argument", errorCode: "index_feedback_kb_expected_revision_required" });
  }
  if (!transitionId) {
    throw Object.assign(new Error("invalid-argument: transitionId is required"), { code: "invalid-argument", errorCode: "index_feedback_kb_transition_id_required" });
  }
  const reviewEventId = stableId("review-transition", `${feedbackId}-${fingerprint(transitionId)}`);
  const reviewEventDoc = adminDb.collection("feedback_review_events").doc(reviewEventId);
  const reviewEventRef = `feedback_review_events/${reviewEventDoc.id}`;
  const feedbackDocRef = adminDb.collection("feedback").doc(feedbackId);
  const transitionResult = await adminDb.runTransaction<FeedbackReviewTransactionResult>(async (transaction) => {
    const feedbackSnapshot = await transaction.get(feedbackDocRef);
    const existingEvent = await transaction.get(reviewEventDoc);
    if (existingEvent.exists) {
      const event = existingEvent.data() ?? {};
      const eventScope = requireStoredFeedbackScope(event.scope, requestedScope);
      if (event.feedbackRef !== feedbackRef || event.decision !== decision || !feedbackScopesEqual(eventScope, requestedScope)) {
        throw Object.assign(new Error("already-exists: transitionId belongs to another decision"), { code: "already-exists", errorCode: "index_feedback_kb_already_exists_transition_id_belongs" });
      }
      return {
        resultStatus: asString(event.resultStatus),
        feedbackRef,
        storedArtifactRef: asString(event.artifactRef, artifactRef),
        reviewRef: asString(event.reviewRef, reviewRef),
        reviewEventRef,
        revision: Number.isInteger(event.revision) ? Number(event.revision) : expectedRevision,
        domain: asDomain(event.pipelineDomain, target),
        scope: eventScope,
        idempotent: true,
        ...(asString(event.promotionRef) ? { promotionRef: asString(event.promotionRef) } : {}),
      };
    }
    if (!feedbackSnapshot.exists) {
      throw Object.assign(new Error("not-found: feedback does not exist"), { code: "not-found", errorCode: "index_feedback_kb_feedback_exist" });
    }
    const feedback = feedbackSnapshot.data() ?? {};
    requireStoredFeedbackScope(feedback.scope, requestedScope);
    const storedTarget = asTarget(feedback.target);
    const domain = asDomain(feedback.pipelineDomain, storedTarget);
    if ((data.target && target !== storedTarget) || (data.pipelineDomain && requestedDomain !== domain)) {
      throw Object.assign(new Error("failed-precondition: feedback target/domain mismatch"), { code: "failed-precondition", errorCode: "index_feedback_kb_feedback_target_domain_mismatch" });
    }
    const storedArtifactRef = sanitizeRef(feedback.artifactRef, artifactRef);
    const expectedKbEntryRef = feedbackKbEntryCollection(requestedScope).doc(stableId("kb", feedbackId)).path;
    const kbEntryRef = asString(feedback.kbEntryRef, expectedKbEntryRef);
    if (kbEntryRef !== expectedKbEntryRef) {
      throw Object.assign(new Error("failed-precondition: feedback KB entry path mismatch"), { code: "failed-precondition", errorCode: "index_feedback_kb_feedback_kb_entry_path_mismatch" });
    }
    const outboxRef = asString(feedback.fineTuneQueueRef);
    const outboxSnapshot = outboxRef ? await transaction.get(adminDb.doc(outboxRef)) : null;
    let rejectionCompensation: {
      identity: FineTuneCompensationIdentity;
      exists: boolean;
      externalJobRefHash: string;
      providerReceiptRef: string | null;
      cancellationHandleHash: string | null;
    } | null = null;
    if (decision === "reject" && outboxSnapshot?.exists) {
      const outbox = outboxSnapshot.data() ?? {};
      const compensationRequired = asString(outbox.status) === "sent_to_aihub" || Boolean(outbox.externalJobRefHash);
      if (compensationRequired) {
        const externalJobRefHash = asString(outbox.externalJobRefHash, "unverified");
        const identity = fineTuneCompensationIdentity(outboxSnapshot.id, externalJobRefHash);
        const compensationSnapshot = await transaction.get(adminDb.doc(identity.outboxRef));
        rejectionCompensation = {
          identity,
          exists: compensationSnapshot.exists,
          externalJobRefHash,
          providerReceiptRef: asString(outbox.providerReceiptRef) || null,
          cancellationHandleHash: asString(outbox.cancellationHandleHash) || null,
        };
      }
    }
    const current = reviewStateFromFeedback(feedback);
    const rating = asRating(feedback.rating);
    const reason = asDownReason(feedback.reason, rating);
    const sanitizedExcerpt = sanitizeExcerpt(feedback.sanitizedExcerpt ?? feedback.excerpt);
    const sanitizedNote = sanitizeOptionalExcerpt(feedback.note);
    const lineage = promotionLineage(feedbackId, current.revision + 1);
    const guidance = decision === "approve"
      ? (rating === "down" ? correctionNote : sanitizedNote || sanitizedExcerpt)
      : "";
    const evaluation = reviewedArtifactIntegrityEval(guidance, lineage);
    const plan = planFeedbackReviewTransition({
      current,
      decision,
      expectedRevision,
      transitionId,
      rating,
      evaluationPassed: evaluation.status === "passed",
      correctionNote,
    });
    const sourceRefs = [
      makeSourceRef(storedArtifactRef, "artifact", "reviewed AI artifact reference"),
      makeSourceRef(feedbackRef, "feedback", reason ?? rating),
    ];
    const beforeState = { ...current };
    const afterState = { ...plan.next };
    const resultStatus = decision === "reject" ? "rejected" : evaluation.status === "passed" ? "promoted" : "eval_failed";
    const priorPromotionRef = asString(feedback.promotionRef);

    transaction.create(reviewEventDoc, {
      id: reviewEventDoc.id,
      transitionId,
      reviewEventRef,
      feedbackRef,
      artifactRef: storedArtifactRef,
      kbEntryRef,
      reviewRef,
      scope: requestedScope,
      scopeKey: requestedScope.scopeKey,
      decision,
      note: reviewNote,
      correctionNote: decision === "approve" && rating === "down" ? correctionNote : null,
      before: beforeState,
      after: afterState,
      resultStatus,
      pipelineDomain: domain,
      target: storedTarget,
      promotionRef: decision === "reject"
        ? priorPromotionRef || null
        : evaluation.status === "passed"
          ? lineage.promotionRef
          : null,
      currentLineageRef: lineage.currentLineageRef,
      revision: plan.revision,
      evalResultRef: decision === "approve" ? lineage.evalResultRef : null,
      reviewedBy: principal.uid,
      reviewedAt,
      policyVersion: FEEDBACK_POLICY_VERSION,
      artifactPolicy: "server-ref-only",
    });
    transaction.set(adminDb.doc(reviewRef), {
      id: feedbackId,
      feedbackRef,
      kbEntryRef,
      scope: requestedScope,
      decision,
      note: reviewNote,
      status: resultStatus,
      revision: plan.revision,
      reviewedBy: principal.uid,
      reviewedAt,
      latestEventRef: reviewEventRef,
      policyVersion: FEEDBACK_POLICY_VERSION,
      artifactPolicy: "server-ref-only",
    }, { merge: true });

    if (decision === "reject") {
      const revokedPromotionRef = priorPromotionRef;
      transaction.set(feedbackSnapshot.ref, {
        ...afterState,
        reviewRef,
        latestReviewEventRef: reviewEventRef,
        reviewedBy: principal.uid,
        reviewedAt,
      }, { merge: true });
      transaction.set(adminDb.doc(kbEntryRef), {
        ...afterState,
        reviewRef,
        latestReviewEventRef: reviewEventRef,
        reviewedBy: principal.uid,
        reviewedAt,
      }, { merge: true });
      transaction.set(adminDb.doc(lineage.currentLineageRef), {
        id: refLeaf(lineage.currentLineageRef),
        feedbackRef,
        kbEntryRef,
        scope: requestedScope,
        scopeKey: requestedScope.scopeKey,
        status: revokedPromotionRef ? "revoked" : "rejected",
        promotionRef: revokedPromotionRef || null,
        reviewedExampleRef: asString(feedback.reviewedExampleRef) || null,
        evalDatasetItemRef: asString(feedback.evalDatasetItemRef) || null,
        evalResultRef: asString(feedback.evalResultRef) || null,
        revokedBy: revokedPromotionRef ? principal.uid : null,
        revokedAt: revokedPromotionRef ? reviewedAt : null,
        revocationReason: revokedPromotionRef ? reviewNote || "human_review_rejected" : null,
        latestReviewEventRef: reviewEventRef,
        revision: plan.revision,
        artifactPolicy: "server-ref-only",
      }, { merge: true });
      if (outboxRef && outboxSnapshot?.exists) {
        const outbox = outboxSnapshot.data() ?? {};
        const compensationRequired = Boolean(rejectionCompensation);
        const cancellationStatus = compensationRequired ? "compensation_required" : "cancelled";
        const releaseEventRef = adminDb.collection("fine_tune_release_events").doc(`revoke-${reviewEventDoc.id}`);
        if (rejectionCompensation) {
          enqueueFineTuneCompensation(transaction, rejectionCompensation.identity, {
            exists: rejectionCompensation.exists,
            queueRef: outboxRef,
            feedbackRef,
            scope: requestedScope,
            providerReceiptRef: rejectionCompensation.providerReceiptRef,
            externalJobRefHash: rejectionCompensation.externalJobRefHash,
            cancellationHandleHash: rejectionCompensation.cancellationHandleHash,
            reason: "feedback_promotion_revoked",
            actorId: principal.uid,
            createdAt: reviewedAt,
          });
        }
        transaction.set(outboxSnapshot.ref, {
          status: cancellationStatus,
          cancellationReason: "feedback_promotion_revoked",
          compensationRef: rejectionCompensation?.identity.outboxRef ?? null,
          cancelledBy: principal.uid,
          cancelledAt: reviewedAt,
          revision: Number.isInteger(outbox.revision) ? Number(outbox.revision) + 1 : 1,
        }, { merge: true });
        transaction.create(releaseEventRef, {
          id: releaseEventRef.id,
          type: compensationRequired ? "compensation_required" : "cancelled_before_dispatch",
          queueRef: outboxRef,
          feedbackRef,
          scope: requestedScope,
          reviewEventRef,
          compensationRef: rejectionCompensation?.identity.outboxRef ?? null,
          cancellationHandleRef: rejectionCompensation?.identity.handleRef ?? null,
          cancellationHandleHash: rejectionCompensation?.cancellationHandleHash ?? null,
          createdBy: principal.uid,
          createdAt: reviewedAt,
          artifactPolicy: "server-ref-only",
        });
        transaction.set(feedbackSnapshot.ref, {
          fineTuneStatus: cancellationStatus,
          fineTuneRevision: Number.isInteger(outbox.revision) ? Number(outbox.revision) + 1 : 1,
        }, { merge: true });
      }
      return {
        resultStatus,
        feedbackRef,
        storedArtifactRef,
        reviewRef,
        reviewEventRef,
        ...(revokedPromotionRef ? { promotionRef: revokedPromotionRef } : {}),
        revision: plan.revision,
        domain,
        scope: requestedScope,
        idempotent: false,
      };
    }

    const commonLineage = {
      id: feedbackId,
      feedbackRef,
      kbEntryRef,
      scope: requestedScope,
      scopeKey: requestedScope.scopeKey,
      target: storedTarget,
      pipelineDomain: domain,
      revision: plan.revision,
      artifactPolicy: "server-ref-only",
    };
    transaction.create(adminDb.doc(lineage.reviewedExampleRef), {
      ...commonLineage,
      id: refLeaf(lineage.reviewedExampleRef),
      rating,
      reason: reason ?? null,
      guidance,
      sanitizedExcerpt,
      sourceRefs,
      reviewRef,
      reviewedBy: principal.uid,
      reviewedAt,
    });
    transaction.create(adminDb.doc(lineage.evalDatasetItemRef), {
      ...commonLineage,
      id: refLeaf(lineage.evalDatasetItemRef),
      datasetVersion: FEEDBACK_EVAL_DATASET_VERSION,
      reviewedExampleRef: lineage.reviewedExampleRef,
      expected: { retrievalEligible: evaluation.status === "passed", rawPromptStored: false, vectorClaimed: false },
      createdAt: reviewedAt,
    });
    transaction.create(adminDb.doc(lineage.evalResultRef), {
      ...commonLineage,
      id: refLeaf(lineage.evalResultRef),
      datasetVersion: FEEDBACK_EVAL_DATASET_VERSION,
      datasetItemRef: lineage.evalDatasetItemRef,
      reviewedExampleRef: lineage.reviewedExampleRef,
      status: evaluation.status,
      score: evaluation.score,
      assertions: evaluation.assertions,
      evaluatedAt: reviewedAt,
      evaluator: "deterministic-feedback-promotion-integrity-v1",
      evaluationScope: "artifact-safety-and-lineage-only",
    });
    transaction.set(adminDb.doc(lineage.currentLineageRef), {
      id: refLeaf(lineage.currentLineageRef),
      feedbackRef,
      kbEntryRef,
      scope: requestedScope,
      scopeKey: requestedScope.scopeKey,
      reviewedExampleRef: lineage.reviewedExampleRef,
      evalDatasetItemRef: lineage.evalDatasetItemRef,
      evalResultRef: lineage.evalResultRef,
      promotionRef: evaluation.status === "passed" ? lineage.promotionRef : null,
      status: evaluation.status === "passed" ? "active" : "eval_failed",
      revision: plan.revision,
      latestReviewEventRef: reviewEventRef,
      updatedBy: principal.uid,
      updatedAt: reviewedAt,
      artifactPolicy: "server-ref-only",
    }, { merge: true });

    if (evaluation.status === "passed") {
      transaction.create(adminDb.doc(lineage.promotionRef), {
        ...commonLineage,
        id: refLeaf(lineage.promotionRef),
        reviewedExampleRef: lineage.reviewedExampleRef,
        evalDatasetItemRef: lineage.evalDatasetItemRef,
        evalResultRef: lineage.evalResultRef,
        promptVersion: lineage.promptVersion,
        policyVersion: lineage.policyVersion,
        status: "active",
        approvedBy: principal.uid,
        approvedAt: reviewedAt,
        revokedBy: null,
        revokedAt: null,
        revocationReason: null,
        latestReviewEventRef: reviewEventRef,
        retrievalStrategy: FEEDBACK_LEXICAL_STRATEGY,
        vectorCapability: vectorCapability(),
      });
      const promotionFields = {
        ...afterState,
        reviewedBy: principal.uid,
        reviewedAt,
        promotedBy: principal.uid,
        promotedAt: reviewedAt,
        reviewRef,
        latestReviewEventRef: reviewEventRef,
        fineTuneStatus: "not_requested",
        fineTuneQueueRef: null,
        fineTuneRevision: 0,
        ...lineage,
      };
      transaction.set(feedbackSnapshot.ref, promotionFields, { merge: true });
      transaction.set(adminDb.doc(kbEntryRef), promotionFields, { merge: true });
      writeKnowledgeNode(transaction, {
        id: `feedback-promotion-${requestedScope.scopeKey}-${feedbackId}`,
        type: "human_review_guidance",
        title: `${domain}:${storedTarget}:approved-guidance`,
        summary: guidance,
        sourceRefs,
        entityRefs: [feedbackRef, reviewRef, lineage.evalResultRef, lineage.promotionRef],
        governanceScope: requestedScope,
        createdAtIso: reviewedAt,
      });
    } else {
      const failureFields = {
        ...afterState,
        reviewedBy: principal.uid,
        reviewedAt,
        reviewRef,
        latestReviewEventRef: reviewEventRef,
        ...lineage,
      };
      transaction.set(feedbackSnapshot.ref, failureFields, { merge: true });
      transaction.set(adminDb.doc(kbEntryRef), failureFields, { merge: true });
    }
    return {
      resultStatus,
      feedbackRef,
      storedArtifactRef,
      reviewRef,
      reviewEventRef,
      lineage,
      evaluation,
      revision: plan.revision,
      domain,
      scope: requestedScope,
      idempotent: false,
    };
  });

  const resultStatus = asString(transitionResult.resultStatus);
  const domain = asDomain(transitionResult.domain, target);
  return {
    status: resultStatus,
    feedbackRef,
    artifactRef: asString(transitionResult.storedArtifactRef, artifactRef),
    reviewRef,
    reviewEventRef,
    scope: requestedScope,
    revision: transitionResult.revision,
    idempotent: transitionResult.idempotent === true,
    ...(transitionResult.promotionRef ? { promotionRef: transitionResult.promotionRef } : {}),
    ...(transitionResult.lineage ? { lineage: transitionResult.lineage } : {}),
    ...(transitionResult.evaluation ? { evaluation: transitionResult.evaluation } : {}),
    persisted: true,
    retrieval: lexicalCapability(),
    vectorCapability: vectorCapability(),
    pipeline: {
      domain,
      consumers: PIPELINE_CONSUMERS[domain],
      status: resultStatus === "promoted" ? "active" : resultStatus === "rejected" ? "excluded_rejected" : "excluded_eval_failed",
    },
    cache,
    costLog: cost,
    behaviorLog: makeBehaviorLog(request, "indexFeedbackKb", "allow", 0),
  };
}

export async function retrieveFeedbackKb(request: CallableRequest) {
  const data = asRecord(request.data);
  return retrieveFeedbackKbInternal(request, {
    target: data.target,
    pipelineDomain: data.pipelineDomain,
    query: data.query ?? data.signal ?? data.intent ?? data.artifactRef,
    artifactRef: data.artifactRef,
    limit: data.limit,
    candidateLimit: data.candidateLimit,
    cursor: data.cursor,
    gameId: data.gameId,
    ...scopePayload(data),
  });
}

type FineTuneOutboxStatus =
  | "pending"
  | "dispatching"
  | "sent_to_aihub"
  | "approved_waiting_for_provider"
  | "retryable"
  | "blocked_provider_cancellation_unavailable"
  | "cancelled"
  | "compensation_required";

type PreparedFineTuneOutbox = {
  queueRef: string;
  queueId: string;
  feedbackRef: string;
  artifactRef: string;
  promotionRef: string;
  currentLineageRef: string;
  reviewedExampleRef: string;
  evalResultRef: string;
  domain: PipelineDomain;
  target: FeedbackTarget;
  scope: FeedbackGovernanceScope;
  reviewRevision: number;
  outboxRevision: number;
  status: FineTuneOutboxStatus;
  idempotencyKey: string;
  idempotent: boolean;
};

function requiredFineTuneRevision(value: unknown, field: string): number {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(revision) || revision < 0) {
    throw Object.assign(new Error(`invalid-argument: ${field} is required`), { code: "invalid-argument", errorCode: "required_fine_tune_revision_required" });
  }
  return revision;
}

function fineTuneErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = asString((error as DataRecord).code).toLowerCase();
    const name = asString((error as DataRecord).name).toLowerCase();
    if (code === "aihub_cancellation_unavailable") return code;
    if (code === "aihub_cancellation_failed") return code;
    if (code === "aihub_cancellation_handle_missing" || code === "aihub_cancellation_handle_invalid") return code;
    if (name.includes("abort") || code.includes("timeout")) return "aihub_timeout";
    if (code.includes("permission") || code.includes("auth")) return "aihub_auth_failed";
    if (code.includes("resource-exhausted") || code.includes("rate")) return "aihub_rate_limited";
  }
  return "aihub_enqueue_failed";
}

function fineTuneStatus(value: unknown): FineTuneOutboxStatus {
  const allowed: FineTuneOutboxStatus[] = [
    "pending",
    "dispatching",
    "sent_to_aihub",
    "approved_waiting_for_provider",
    "retryable",
    "blocked_provider_cancellation_unavailable",
    "cancelled",
    "compensation_required",
  ];
  return typeof value === "string" && allowed.includes(value as FineTuneOutboxStatus)
    ? value as FineTuneOutboxStatus
    : "pending";
}

type FineTuneCompensationIdentity = ReturnType<typeof fineTuneCompensationIdentity>;

function persistFineTuneCancellationHandle(
  transaction: Transaction,
  identity: FineTuneCompensationIdentity,
  input: {
    queueRef: string;
    feedbackRef: string;
    externalJobRefHash: string;
    cancellationHandle: string;
    createdAt: string;
  },
): { cancellationHandleRef: string; cancellationHandleHash: string } {
  const cancellationHandle = requireCancellationHandle(input.cancellationHandle);
  const cancellationHandleHash = fingerprint(cancellationHandle);
  transaction.set(adminDb.doc(identity.handleRef), {
    id: refLeaf(identity.handleRef),
    queueRef: input.queueRef,
    feedbackRef: input.feedbackRef,
    externalJobRefHash: input.externalJobRefHash,
    cancellationHandle,
    cancellationHandleHash,
    provider: "ai-hub",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    accessPolicy: "server-only",
  }, { merge: true });
  return { cancellationHandleRef: identity.handleRef, cancellationHandleHash };
}

function enqueueFineTuneCompensation(
  transaction: Transaction,
  identity: FineTuneCompensationIdentity,
  input: {
    exists: boolean;
    queueRef: string;
    feedbackRef: string;
    scope: FeedbackGovernanceScope;
    providerReceiptRef: string | null;
    externalJobRefHash: string;
    cancellationHandleHash: string | null;
    reason: string;
    actorId: string;
    createdAt: string;
  },
): void {
  const compensationRef = adminDb.doc(identity.outboxRef);
  const immutable = {
    id: compensationRef.id,
    compensationRef: identity.outboxRef,
    queueRef: input.queueRef,
    feedbackRef: input.feedbackRef,
    scope: input.scope,
    scopeKey: input.scope.scopeKey,
    providerReceiptRef: input.providerReceiptRef,
    externalJobRefHash: input.externalJobRefHash,
    cancellationHandleRef: identity.handleRef,
    cancellationHandleHash: input.cancellationHandleHash,
    idempotencyKey: identity.idempotencyKey,
    provider: "ai-hub",
    artifactPolicy: "server-ref-only",
  };
  if (input.exists) {
    transaction.set(compensationRef, immutable, { merge: true });
    return;
  }
  transaction.create(compensationRef, {
    ...immutable,
    status: "pending",
    revision: 0,
    attemptCount: 0,
    maxAttempts: FINE_TUNE_COMPENSATION_MAX_ATTEMPTS,
    leaseId: null,
    leaseUntil: null,
    reason: input.reason,
    createdBy: input.actorId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

async function prepareFineTuneOutbox(input: {
  principal: { uid: string; role: Role };
  data: DataRecord;
  feedbackRef: string;
  artifactRef: string;
  target: FeedbackTarget;
  requestedDomain: PipelineDomain;
  requestedScope: FeedbackGovernanceScope;
}): Promise<PreparedFineTuneOutbox> {
  const feedbackId = refLeaf(input.feedbackRef);
  const feedbackDocRef = adminDb.collection("feedback").doc(feedbackId);
  const expectedRevision = requiredFineTuneRevision(input.data.expectedRevision, "expectedRevision");
  const action = input.data.fineTuneAction === "retry" ? "retry" : "release";
  const transitionId = asString(input.data.transitionId)
    .replace(/[^a-zA-Z0-9._~-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 160);
  if (!transitionId) {
    throw Object.assign(new Error("invalid-argument: transitionId is required"), { code: "invalid-argument", errorCode: "prepare_fine_tune_outbox_transition_id_required" });
  }

  return adminDb.runTransaction<PreparedFineTuneOutbox>(async (transaction) => {
    const feedbackSnapshot = await transaction.get(feedbackDocRef);
    if (!feedbackSnapshot.exists) {
      throw Object.assign(new Error("not-found: feedback does not exist"), { code: "not-found", errorCode: "prepare_fine_tune_outbox_feedback_exist" });
    }
    const feedback = feedbackSnapshot.data() ?? {};
    requireStoredFeedbackScope(feedback.scope, input.requestedScope);
    const reviewRevision = Number.isInteger(feedback.revision) ? Number(feedback.revision) : 0;
    if (reviewRevision !== expectedRevision) {
      throw Object.assign(new Error("aborted: feedback revision conflict"), { code: "aborted", errorCode: "prepare_fine_tune_outbox_feedback_revision_conflict" });
    }
    const storedTarget = asTarget(feedback.target);
    const domain = asDomain(feedback.pipelineDomain, storedTarget);
    if ((input.data.target && input.target !== storedTarget) || (input.data.pipelineDomain && input.requestedDomain !== domain)) {
      throw Object.assign(new Error("failed-precondition: feedback target/domain mismatch"), { code: "failed-precondition", errorCode: "prepare_fine_tune_outbox_feedback_target_domain_mismatch" });
    }
    const promotionRef = asString(feedback.promotionRef);
    const currentLineageRef = asString(feedback.currentLineageRef);
    if (
      feedback.reviewStatus !== "approved"
      || feedback.evalStatus !== "passed"
      || feedback.promotionStatus !== "promoted"
      || !promotionRef
      || !currentLineageRef
    ) {
      throw Object.assign(new Error("failed-precondition: feedback promotion is not active"), { code: "failed-precondition", errorCode: "prepare_fine_tune_outbox_feedback_promotion_active" });
    }
    const promotionSnapshot = await transaction.get(adminDb.doc(promotionRef));
    const currentLineageSnapshot = await transaction.get(adminDb.doc(currentLineageRef));
    const promotion = promotionSnapshot.data() ?? {};
    const currentLineage = currentLineageSnapshot.data() ?? {};
    if (
      !promotionSnapshot.exists
      || !currentLineageSnapshot.exists
      || promotion.status !== "active"
      || Number(promotion.revision) !== reviewRevision
      || currentLineage.status !== "active"
      || currentLineage.promotionRef !== promotionRef
      || Number(currentLineage.revision) !== reviewRevision
    ) {
      throw Object.assign(new Error("aborted: prompt promotion revision is not current"), { code: "aborted", errorCode: "prepare_fine_tune_outbox_prompt_promotion_revision_current" });
    }
    requireStoredFeedbackScope(currentLineage.scope, input.requestedScope);

    const queueId = fineTuneOutboxId(feedbackId, input.requestedScope.scopeKey, reviewRevision);
    const queueDocRef = adminDb.collection("fine_tune_outbox").doc(queueId);
    const queueRef = queueDocRef.path;
    const queueSnapshot = await transaction.get(queueDocRef);
    const releaseEventRef = adminDb.collection("fine_tune_release_events")
      .doc(stableId("release", `${queueId}-${fingerprint(transitionId)}`));
    const releaseEventSnapshot = await transaction.get(releaseEventRef);
    if (releaseEventSnapshot.exists) {
      const event = releaseEventSnapshot.data() ?? {};
      if (event.queueRef !== queueRef || event.action !== action) {
        throw Object.assign(new Error("already-exists: transitionId belongs to another fine-tune action"), { code: "already-exists", errorCode: "prepare_fine_tune_outbox_already_exists_transition_id_belongs" });
      }
      const existingQueue = queueSnapshot.data() ?? {};
      return {
        queueRef,
        queueId,
        feedbackRef: input.feedbackRef,
        artifactRef: sanitizeRef(feedback.artifactRef, input.artifactRef),
        promotionRef,
        currentLineageRef,
        reviewedExampleRef: asString(feedback.reviewedExampleRef),
        evalResultRef: asString(feedback.evalResultRef),
        domain,
        target: storedTarget,
        scope: input.requestedScope,
        reviewRevision,
        outboxRevision: Number.isInteger(existingQueue.revision) ? Number(existingQueue.revision) : 0,
        status: fineTuneStatus(existingQueue.status),
        idempotencyKey: asString(existingQueue.idempotencyKey, fineTuneIdempotencyKey(input.feedbackRef, promotionRef, reviewRevision)),
        idempotent: true,
      };
    }

    const createdAt = new Date().toISOString();
    const artifactRef = sanitizeRef(feedback.artifactRef, input.artifactRef);
    const idempotencyKey = fineTuneIdempotencyKey(input.feedbackRef, promotionRef, reviewRevision);
    let outboxRevision = 0;
    if (queueSnapshot.exists) {
      const existingQueue = queueSnapshot.data() ?? {};
      requireStoredFeedbackScope(existingQueue.scope, input.requestedScope);
      if (action === "release") {
        return {
          queueRef,
          queueId,
          feedbackRef: input.feedbackRef,
          artifactRef,
          promotionRef,
          currentLineageRef,
          reviewedExampleRef: asString(feedback.reviewedExampleRef),
          evalResultRef: asString(feedback.evalResultRef),
          domain,
          target: storedTarget,
          scope: input.requestedScope,
          reviewRevision,
          outboxRevision: Number.isInteger(existingQueue.revision) ? Number(existingQueue.revision) : 0,
          status: fineTuneStatus(existingQueue.status),
          idempotencyKey: asString(existingQueue.idempotencyKey, idempotencyKey),
          idempotent: true,
        };
      }
      const expectedOutboxRevision = requiredFineTuneRevision(input.data.expectedOutboxRevision, "expectedOutboxRevision");
      const currentOutboxRevision = Number.isInteger(existingQueue.revision) ? Number(existingQueue.revision) : 0;
      const currentStatus = fineTuneStatus(existingQueue.status);
      const leaseUntilMs = Date.parse(asString(existingQueue.leaseUntil));
      const dispatchLeaseExpired = currentStatus === "dispatching"
        && Number.isFinite(leaseUntilMs)
        && leaseUntilMs <= Date.now();
      if (currentOutboxRevision !== expectedOutboxRevision) {
        throw Object.assign(new Error("aborted: fine-tune outbox revision conflict"), { code: "aborted", errorCode: "prepare_fine_tune_outbox_fine_tune_outbox_revision_conflict" });
      }
      if (
        currentStatus !== "retryable"
        && currentStatus !== "approved_waiting_for_provider"
        && currentStatus !== "blocked_provider_cancellation_unavailable"
        && !dispatchLeaseExpired
      ) {
        throw Object.assign(new Error("failed-precondition: fine-tune outbox is not retryable"), { code: "failed-precondition", errorCode: "prepare_fine_tune_outbox_fine_tune_outbox_retryable" });
      }
      outboxRevision = currentOutboxRevision + 1;
      transaction.set(queueDocRef, {
        status: "pending",
        revision: outboxRevision,
        lastErrorCode: null,
        leaseId: null,
        leaseUntil: null,
        retriedBy: input.principal.uid,
        retriedAt: createdAt,
      }, { merge: true });
    } else {
      if (action === "retry") {
        throw Object.assign(new Error("not-found: fine-tune outbox does not exist"), { code: "not-found", errorCode: "prepare_fine_tune_outbox_fine_tune_outbox_exist" });
      }
      transaction.create(queueDocRef, {
        id: queueId,
        queueRef,
        feedbackRef: input.feedbackRef,
        artifactRef,
        pipelineDomain: domain,
        target: storedTarget,
        scope: input.requestedScope,
        scopeKey: input.requestedScope.scopeKey,
        promotionRef,
        currentLineageRef,
        reviewedExampleRef: asString(feedback.reviewedExampleRef),
        evalResultRef: asString(feedback.evalResultRef),
        promptVersion: asString(feedback.promptVersion, FEEDBACK_PROMPT_VERSION),
        policyVersion: asString(feedback.policyVersion, FEEDBACK_POLICY_VERSION),
        reviewRevision,
        revision: 0,
        attemptCount: 0,
        status: "pending",
        idempotencyKey,
        releaseApprovedBy: input.principal.uid,
        createdBy: input.principal.uid,
        createdAt,
        updatedAt: createdAt,
        artifactPolicy: "server-ref-only",
      });
    }
    transaction.create(releaseEventRef, {
      id: releaseEventRef.id,
      transitionId,
      action,
      queueRef,
      feedbackRef: input.feedbackRef,
      promotionRef,
      currentLineageRef,
      scope: input.requestedScope,
      reviewRevision,
      outboxRevision,
      createdBy: input.principal.uid,
      createdAt,
      artifactPolicy: "server-ref-only",
    });
    transaction.set(feedbackSnapshot.ref, {
      fineTuneStatus: "pending",
      fineTuneQueueRef: queueRef,
      fineTuneRevision: outboxRevision,
      fineTuneReleasedAt: createdAt,
      fineTuneReleasedBy: input.principal.uid,
    }, { merge: true });
    return {
      queueRef,
      queueId,
      feedbackRef: input.feedbackRef,
      artifactRef,
      promotionRef,
      currentLineageRef,
      reviewedExampleRef: asString(feedback.reviewedExampleRef),
      evalResultRef: asString(feedback.evalResultRef),
      domain,
      target: storedTarget,
      scope: input.requestedScope,
      reviewRevision,
      outboxRevision,
      status: "pending",
      idempotencyKey,
      idempotent: false,
    };
  });
}

async function dispatchFineTuneOutbox(
  prepared: PreparedFineTuneOutbox,
  actorId: string,
): Promise<{ status: FineTuneOutboxStatus; outboxRevision: number; source: string; costLog: CostLog }> {
  if (prepared.status !== "pending") {
    return {
      status: prepared.status,
      outboxRevision: prepared.outboxRevision,
      source: "durable-outbox-existing",
      costLog: costLog("fine-tune-release-gate", prepared.queueRef),
    };
  }
  const queueDocRef = adminDb.doc(prepared.queueRef);
  const leaseId = randomUUID();
  const claimed = await adminDb.runTransaction(async (transaction) => {
    const queueSnapshot = await transaction.get(queueDocRef);
    if (!queueSnapshot.exists) throw Object.assign(new Error("not-found: fine-tune outbox does not exist"), { code: "not-found", errorCode: "dispatch_fine_tune_outbox_fine_tune_outbox_exist" });
    const queue = queueSnapshot.data() ?? {};
    requireStoredFeedbackScope(queue.scope, prepared.scope);
    const status = fineTuneStatus(queue.status);
    const currentRevision = Number.isInteger(queue.revision) ? Number(queue.revision) : 0;
    if (status !== "pending") return { claimed: false as const, status, revision: currentRevision };
    const feedbackDocRef = adminDb.collection("feedback").doc(refLeaf(prepared.feedbackRef));
    const promotionDocRef = adminDb.doc(prepared.promotionRef);
    const currentLineageDocRef = adminDb.doc(prepared.currentLineageRef);
    const feedbackSnapshot = await transaction.get(feedbackDocRef);
    const promotionSnapshot = await transaction.get(promotionDocRef);
    const currentLineageSnapshot = await transaction.get(currentLineageDocRef);
    const feedback = feedbackSnapshot.data() ?? {};
    const promotion = promotionSnapshot.data() ?? {};
    const currentLineage = currentLineageSnapshot.data() ?? {};
    if (
      !feedbackSnapshot.exists
      || !promotionSnapshot.exists
      || !currentLineageSnapshot.exists
      || Number(feedback.revision) !== prepared.reviewRevision
      || feedback.reviewStatus !== "approved"
      || feedback.promotionStatus !== "promoted"
      || promotion.status !== "active"
      || Number(promotion.revision) !== prepared.reviewRevision
      || currentLineage.status !== "active"
      || currentLineage.promotionRef !== prepared.promotionRef
      || Number(currentLineage.revision) !== prepared.reviewRevision
    ) {
      throw Object.assign(new Error("aborted: feedback promotion changed before fine-tune dispatch"), { code: "aborted", errorCode: "dispatch_fine_tune_outbox_feedback_promotion_changed_before_fine" });
    }
    requireStoredFeedbackScope(feedback.scope, prepared.scope);
    requireStoredFeedbackScope(currentLineage.scope, prepared.scope);
    const attemptCount = (Number.isInteger(queue.attemptCount) ? Number(queue.attemptCount) : 0) + 1;
    const revision = currentRevision + 1;
    const claimedAt = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + 60_000).toISOString();
    const claimEventRef = adminDb.collection("fine_tune_release_events").doc(`claim-${prepared.queueId}-${attemptCount}`);
    transaction.set(queueDocRef, {
      status: "dispatching",
      revision,
      attemptCount,
      leaseId,
      leaseUntil,
      claimedBy: actorId,
      claimedAt,
      updatedAt: claimedAt,
    }, { merge: true });
    transaction.create(claimEventRef, {
      id: claimEventRef.id,
      type: "dispatch_claimed",
      queueRef: prepared.queueRef,
      feedbackRef: prepared.feedbackRef,
      scope: prepared.scope,
      reviewRevision: prepared.reviewRevision,
      outboxRevision: revision,
      attemptCount,
      leaseId,
      createdBy: actorId,
      createdAt: claimedAt,
      artifactPolicy: "server-ref-only",
    });
    return { claimed: true as const, status: "dispatching" as const, revision, attemptCount };
  });
  if (!claimed.claimed) {
    return {
      status: claimed.status,
      outboxRevision: claimed.revision,
      source: "durable-outbox-concurrent",
      costLog: costLog("fine-tune-release-gate", prepared.queueRef),
    };
  }

  // Re-read every CAS anchor after the durable lease is committed and directly
  // before the external side effect. A later revoke is handled by compensation.
  await adminDb.runTransaction(async (transaction) => {
    const queueSnapshot = await transaction.get(queueDocRef);
    const feedbackSnapshot = await transaction.get(adminDb.collection("feedback").doc(refLeaf(prepared.feedbackRef)));
    const promotionSnapshot = await transaction.get(adminDb.doc(prepared.promotionRef));
    const currentLineageSnapshot = await transaction.get(adminDb.doc(prepared.currentLineageRef));
    const queue = queueSnapshot.data() ?? {};
    const feedback = feedbackSnapshot.data() ?? {};
    const promotion = promotionSnapshot.data() ?? {};
    const currentLineage = currentLineageSnapshot.data() ?? {};
    if (
      queue.status !== "dispatching"
      || queue.leaseId !== leaseId
      || Number(queue.reviewRevision) !== prepared.reviewRevision
      || !feedbackSnapshot.exists
      || !promotionSnapshot.exists
      || !currentLineageSnapshot.exists
      || Number(feedback.revision) !== prepared.reviewRevision
      || feedback.promotionStatus !== "promoted"
      || promotion.status !== "active"
      || Number(promotion.revision) !== prepared.reviewRevision
      || currentLineage.status !== "active"
      || currentLineage.promotionRef !== prepared.promotionRef
      || Number(currentLineage.revision) !== prepared.reviewRevision
    ) {
      throw Object.assign(new Error("aborted: fine-tune dispatch CAS recheck failed"), { code: "aborted", errorCode: "dispatch_fine_tune_outbox_fine_tune_dispatch_cas_recheck" });
    }
    requireStoredFeedbackScope(queue.scope, prepared.scope);
    requireStoredFeedbackScope(feedback.scope, prepared.scope);
    requireStoredFeedbackScope(currentLineage.scope, prepared.scope);
  });

  let liveQueue: Awaited<ReturnType<typeof enqueueAiHubFineTune>> = null;
  let errorCode: string | null = null;
  try {
    liveQueue = await enqueueAiHubFineTune({
      id: prepared.queueId,
      queueRef: prepared.queueRef,
      feedbackRef: prepared.feedbackRef,
      artifactRef: prepared.artifactRef,
      promotionRef: prepared.promotionRef,
      reviewedExampleRef: prepared.reviewedExampleRef,
      evalResultRef: prepared.evalResultRef,
      pipelineDomain: prepared.domain,
      target: prepared.target,
      reviewRevision: prepared.reviewRevision,
      idempotencyKey: prepared.idempotencyKey,
      artifactPolicy: "server-ref-only",
    });
  } catch (error) {
    errorCode = fineTuneErrorCode(error);
  }

  const externalJobRefHash = liveQueue ? fingerprint(liveQueue.externalJobRef) : null;
  const providerReceiptRef = externalJobRefHash ? `aihub-receipt-${externalJobRefHash}` : null;
  const compensationIdentity = externalJobRefHash
    ? fineTuneCompensationIdentity(prepared.queueId, externalJobRefHash)
    : null;
  const cancellationHandleHash = liveQueue ? fingerprint(liveQueue.cancellationHandle) : null;
  const finalized = await adminDb.runTransaction(async (transaction) => {
    const queueSnapshot = await transaction.get(queueDocRef);
    if (!queueSnapshot.exists) throw Object.assign(new Error("not-found: fine-tune outbox disappeared"), { code: "not-found", errorCode: "dispatch_fine_tune_outbox_fine_tune_outbox_disappeared" });
    const queue = queueSnapshot.data() ?? {};
    const currentRevision = Number.isInteger(queue.revision) ? Number(queue.revision) : claimed.revision;
    const feedbackDocRef = adminDb.collection("feedback").doc(refLeaf(prepared.feedbackRef));
    const feedbackSnapshot = await transaction.get(feedbackDocRef);
    const compensationSnapshot = compensationIdentity
      ? await transaction.get(adminDb.doc(compensationIdentity.outboxRef))
      : null;
    const finalizedAt = new Date().toISOString();
    if (liveQueue && compensationIdentity && externalJobRefHash) {
      persistFineTuneCancellationHandle(transaction, compensationIdentity, {
        queueRef: prepared.queueRef,
        feedbackRef: prepared.feedbackRef,
        externalJobRefHash,
        cancellationHandle: liveQueue.cancellationHandle,
        createdAt: finalizedAt,
      });
    }
    if (queue.status !== "dispatching" || queue.leaseId !== leaseId) {
      if (liveQueue && (queue.status === "cancelled" || queue.status === "compensation_required")) {
        const revision = currentRevision + 1;
        const compensationEventRef = adminDb.collection("fine_tune_release_events")
          .doc(`compensate-${prepared.queueId}-${claimed.attemptCount}`);
        if (!compensationIdentity || !externalJobRefHash) {
          throw Object.assign(new Error("failed-precondition: compensation identity is missing"), { code: "failed-precondition", errorCode: "dispatch_fine_tune_outbox_compensation_identity_missing" });
        }
        enqueueFineTuneCompensation(transaction, compensationIdentity, {
          exists: compensationSnapshot?.exists ?? false,
          queueRef: prepared.queueRef,
          feedbackRef: prepared.feedbackRef,
          scope: prepared.scope,
          providerReceiptRef,
          externalJobRefHash,
          cancellationHandleHash,
          reason: "promotion_revoked_during_dispatch",
          actorId,
          createdAt: finalizedAt,
        });
        transaction.set(queueDocRef, {
          status: "compensation_required",
          revision,
          externalJobRefHash,
          providerReceiptRef,
          cancellationHandleRef: compensationIdentity.handleRef,
          cancellationHandleHash,
          compensationRef: compensationIdentity.outboxRef,
          compensationReason: "promotion_revoked_during_dispatch",
          updatedAt: finalizedAt,
        }, { merge: true });
        transaction.create(compensationEventRef, {
          id: compensationEventRef.id,
          type: "compensation_required",
          queueRef: prepared.queueRef,
          feedbackRef: prepared.feedbackRef,
          scope: prepared.scope,
          providerReceiptRef,
          cancellationHandleRef: compensationIdentity.handleRef,
          cancellationHandleHash,
          compensationRef: compensationIdentity.outboxRef,
          reviewRevision: prepared.reviewRevision,
          outboxRevision: revision,
          createdAt: finalizedAt,
          artifactPolicy: "server-ref-only",
        });
        return { status: "compensation_required" as const, revision };
      }
      return { status: fineTuneStatus(queue.status), revision: currentRevision };
    }

    const status: FineTuneOutboxStatus = errorCode === "aihub_cancellation_unavailable"
      ? "blocked_provider_cancellation_unavailable"
      : errorCode
        ? "retryable"
      : liveQueue
        ? "sent_to_aihub"
        : "approved_waiting_for_provider";
    const revision = currentRevision + 1;
    const finalizeEventRef = adminDb.collection("fine_tune_release_events")
      .doc(`finalize-${prepared.queueId}-${claimed.attemptCount}`);
    transaction.set(queueDocRef, {
      status,
      revision,
      leaseId: null,
      leaseUntil: null,
      lastErrorCode: errorCode,
      externalJobRefHash,
      providerReceiptRef,
      cancellationHandleRef: compensationIdentity?.handleRef ?? null,
      cancellationHandleHash,
      finalizedAt,
      updatedAt: finalizedAt,
    }, { merge: true });
    transaction.create(finalizeEventRef, {
      id: finalizeEventRef.id,
      type: status,
      queueRef: prepared.queueRef,
      feedbackRef: prepared.feedbackRef,
      scope: prepared.scope,
      reviewRevision: prepared.reviewRevision,
      outboxRevision: revision,
      attemptCount: claimed.attemptCount,
      lastErrorCode: errorCode,
      providerReceiptRef,
      cancellationHandleRef: compensationIdentity?.handleRef ?? null,
      cancellationHandleHash,
      createdAt: finalizedAt,
      artifactPolicy: "server-ref-only",
    });
    const feedback = feedbackSnapshot.data() ?? {};
    if (feedbackSnapshot.exists && feedback.fineTuneQueueRef === prepared.queueRef) {
      transaction.set(feedbackDocRef, {
        fineTuneStatus: status,
        fineTuneRevision: revision,
        fineTuneProviderReceiptRef: providerReceiptRef,
        fineTuneCancellationHandleRef: compensationIdentity?.handleRef ?? null,
        fineTuneCancellationHandleHash: cancellationHandleHash,
      }, { merge: true });
    }
    return { status, revision };
  });
  return {
    status: finalized.status,
    outboxRevision: finalized.revision,
    source: liveQueue
      ? "aihub-live-callable"
      : errorCode === "aihub_cancellation_unavailable"
        ? "durable-outbox-blocked-cancellation-capability"
        : errorCode
          ? "durable-outbox-retryable"
          : "durable-outbox-waiting-provider",
    costLog: liveQueue?.costLog ?? costLog("fine-tune-release-gate", prepared.queueRef),
  };
}

export async function queueFineTuneExample(request: CallableRequest) {
  const principal = requireRole(request, "queueFineTuneExample", REVIEW_ROLES);
  const data = asRecord(request.data);
  const target = asTarget(data.target);
  const requestedDomain = asDomain(data.pipelineDomain, target);
  const requestedScope = await resolveFeedbackScope(scopePayload(data), principal);
  const feedbackRef = sanitizeRef(data.feedbackRef, "");
  const artifactRef = sanitizeRef(data.artifactRef, `artifacts/${target}/unspecified`);
  const cache = cacheMeta("fine-tune-example", [requestedScope.scopeKey, requestedDomain, feedbackRef || "missing"]);
  const internalCost = costLog("fine-tune-release-gate", cache.key, 0, 0);

  if (!feedbackRef.startsWith("feedback/")) {
    return {
      status: "blocked_pending_promotion",
      feedbackRef: feedbackRef || undefined,
      artifactRef,
      persisted: false,
      cache,
      costLog: internalCost,
      behaviorLog: makeBehaviorLog(request, "queueFineTuneExample", "deny", 0),
    };
  }
  if (data.releaseApproved !== true) {
    const feedbackSnapshot = await adminDb.collection("feedback").doc(refLeaf(feedbackRef)).get();
    const feedback = feedbackSnapshot.data() ?? {};
    const promotionRef = asString(feedback.promotionRef);
    const currentLineageRef = asString(feedback.currentLineageRef);
    const [promotionSnapshot, currentLineageSnapshot] = promotionRef && currentLineageRef
      ? await Promise.all([
          adminDb.doc(promotionRef).get(),
          adminDb.doc(currentLineageRef).get(),
        ])
      : [null, null];
    const promotion = promotionSnapshot?.data() ?? {};
    const currentLineage = currentLineageSnapshot?.data() ?? {};
    const reviewRevision = Number.isInteger(feedback.revision) ? Number(feedback.revision) : 0;
    const promoted = feedbackSnapshot.exists
      && feedback.reviewStatus === "approved"
      && feedback.evalStatus === "passed"
      && feedback.promotionStatus === "promoted"
      && promotionSnapshot?.exists === true
      && currentLineageSnapshot?.exists === true
      && promotion.status === "active"
      && Number(promotion.revision) === reviewRevision
      && currentLineage.status === "active"
      && currentLineage.promotionRef === promotionRef
      && Number(currentLineage.revision) === reviewRevision;
    if (!promoted) {
      return {
        status: "blocked_pending_promotion",
        feedbackRef,
        artifactRef,
        scope: requestedScope,
        persisted: false,
        cache,
        costLog: internalCost,
        behaviorLog: makeBehaviorLog(request, "queueFineTuneExample", "deny", 0),
      };
    }
    requireStoredFeedbackScope(feedback.scope, requestedScope);
    requireStoredFeedbackScope(currentLineage.scope, requestedScope);
    return {
      status: "requires_release_approval",
      feedbackRef,
      artifactRef,
      promotionRef,
      currentLineageRef,
      scope: requestedScope,
      revision: reviewRevision,
      persisted: false,
      cache,
      costLog: internalCost,
      behaviorLog: makeBehaviorLog(request, "queueFineTuneExample", "deny", 0),
    };
  }
  if (!RELEASE_ROLES.includes(principal.role)) {
    throw Object.assign(new Error("permission-denied: fine-tune release requires admin approval"), { code: "permission-denied", errorCode: "queue_fine_tune_example_fine_tune_release_requires_admin" });
  }

  const prepared = await prepareFineTuneOutbox({
    principal,
    data,
    feedbackRef,
    artifactRef,
    target,
    requestedDomain,
    requestedScope,
  });
  const dispatched = await dispatchFineTuneOutbox(prepared, principal.uid);

  return {
    status: dispatched.status,
    queueRef: prepared.queueRef,
    source: dispatched.source,
    feedbackRef,
    artifactRef: prepared.artifactRef,
    promotionRef: prepared.promotionRef,
    scope: prepared.scope,
    reviewRevision: prepared.reviewRevision,
    outboxRevision: dispatched.outboxRevision,
    idempotent: prepared.idempotent,
    persisted: true,
    pipeline: { domain: prepared.domain, consumers: PIPELINE_CONSUMERS[prepared.domain], status: dispatched.status },
    cache,
    costLog: dispatched.costLog,
    behaviorLog: makeBehaviorLog(request, "queueFineTuneExample", "allow", dispatched.costLog.estimatedUsd),
  };
}

export async function processFineTuneCompensationOutbox(request: CallableRequest) {
  const principal = requireRole(request, "processFineTuneCompensationOutbox", ["super_admin"]);
  const data = asRecord(request.data);
  if (data.execute !== true || data.confirm !== "CANCEL_EXTERNAL_FINE_TUNE") {
    throw Object.assign(new Error("failed-precondition: explicit external cancellation confirmation is required"), {
      code: "failed-precondition", errorCode: "process_fine_tune_compensation_outbox_explicit_external_cancellation",
    });
  }
  const compensationRef = asString(data.compensationRef);
  if (!/^fine_tune_compensation_outbox\/[a-zA-Z0-9_-]+$/.test(compensationRef)) {
    throw Object.assign(new Error("invalid-argument: compensationRef is required"), { code: "invalid-argument", errorCode: "process_fine_tune_compensation_outbox_compensation_ref_required" });
  }
  const compensationDocRef = adminDb.doc(compensationRef);
  const leaseId = randomUUID();
  const nowMs = Date.now();
  const claimed = await adminDb.runTransaction(async (transaction) => {
    const compensationSnapshot = await transaction.get(compensationDocRef);
    if (!compensationSnapshot.exists) {
      throw Object.assign(new Error("not-found: fine-tune compensation does not exist"), { code: "not-found", errorCode: "process_fine_tune_compensation_outbox_fine_tune_compensation_exist" });
    }
    const compensation = compensationSnapshot.data() ?? {};
    const plan = planFineTuneCompensationClaim(compensation, { nowMs, leaseId });
    if (!plan.claimed) {
      if ("terminalize" in plan && plan.terminalize) {
        const terminalAt = new Date(nowMs).toISOString();
        transaction.set(compensationDocRef, {
          status: "dead_letter",
          revision: plan.revision,
          leaseId: null,
          leaseUntil: null,
          lastErrorCode: "compensation_attempts_exhausted",
          deadLetteredAt: terminalAt,
          updatedAt: terminalAt,
        }, { merge: true });
      }
      return {
        claimed: false as const,
        status: plan.status,
        revision: plan.revision,
        attemptCount: plan.attemptCount,
        queueRef: asString(compensation.queueRef),
      };
    }

    const handleRef = asString(compensation.cancellationHandleRef);
    const handleSnapshot = /^fine_tune_cancellation_handles\/[a-zA-Z0-9_-]+$/.test(handleRef)
      ? await transaction.get(adminDb.doc(handleRef))
      : null;
    let cancellationHandle: string | null = null;
    try {
      cancellationHandle = handleSnapshot?.exists
        ? requireCancellationHandle(handleSnapshot.get("cancellationHandle"))
        : null;
    } catch {
      cancellationHandle = null;
    }
    const claimedAt = new Date(nowMs).toISOString();
    if (!cancellationHandle) {
      const failed = planFineTuneCompensationFailure(plan, { permanent: true });
      const deadLetterEvent = adminDb.collection("fine_tune_release_events")
        .doc(`compensation-dead-${compensationSnapshot.id}-${failed.revision}`);
      transaction.set(compensationDocRef, {
        ...failed,
        lastErrorCode: "cancellation_handle_missing",
        deadLetteredAt: claimedAt,
        updatedAt: claimedAt,
      }, { merge: true });
      transaction.create(deadLetterEvent, {
        id: deadLetterEvent.id,
        type: "compensation_dead_letter",
        compensationRef,
        queueRef: asString(compensation.queueRef),
        feedbackRef: asString(compensation.feedbackRef),
        cancellationHandleRef: handleRef || null,
        cancellationHandleHash: asString(compensation.cancellationHandleHash) || null,
        attemptCount: failed.attemptCount,
        lastErrorCode: "cancellation_handle_missing",
        createdAt: claimedAt,
        artifactPolicy: "server-ref-only",
      });
      return {
        claimed: false as const,
        status: failed.status,
        revision: failed.revision,
        attemptCount: failed.attemptCount,
        queueRef: asString(compensation.queueRef),
      };
    }

    transaction.set(compensationDocRef, {
      status: plan.status,
      revision: plan.revision,
      attemptCount: plan.attemptCount,
      leaseId: plan.leaseId,
      leaseUntil: plan.leaseUntil,
      claimedBy: principal.uid,
      claimedAt,
      updatedAt: claimedAt,
    }, { merge: true });
    return {
      claimed: true as const,
      status: plan.status,
      revision: plan.revision,
      attemptCount: plan.attemptCount,
      queueRef: asString(compensation.queueRef),
      feedbackRef: asString(compensation.feedbackRef),
      providerReceiptRef: asString(compensation.providerReceiptRef) || null,
      cancellationHandleRef: handleRef,
      cancellationHandleHash: asString(compensation.cancellationHandleHash) || null,
      idempotencyKey: asString(compensation.idempotencyKey),
      cancellationHandle,
    };
  });

  if (!claimed.claimed) {
    return {
      status: claimed.status,
      compensationRef,
      queueRef: claimed.queueRef,
      revision: claimed.revision,
      attemptCount: claimed.attemptCount,
      source: claimed.status === "dead_letter" ? "durable-compensation-dead-letter" : "durable-compensation-existing",
      behaviorLog: makeBehaviorLog(request, "processFineTuneCompensationOutbox", "allow", 0),
    };
  }

  let errorCode: string | null = null;
  try {
    await cancelAiHubFineTune({
      cancellationHandle: claimed.cancellationHandle,
      idempotencyKey: claimed.idempotencyKey,
      queueRef: claimed.queueRef,
    });
  } catch (error) {
    errorCode = fineTuneErrorCode(error);
  }

  const finalizedAt = new Date().toISOString();
  const finalized = await adminDb.runTransaction(async (transaction) => {
    const compensationSnapshot = await transaction.get(compensationDocRef);
    if (!compensationSnapshot.exists) {
      throw Object.assign(new Error("not-found: fine-tune compensation disappeared"), { code: "not-found", errorCode: "process_fine_tune_compensation_outbox_fine_tune_compensation" });
    }
    const compensation = compensationSnapshot.data() ?? {};
    const queueRef = asString(compensation.queueRef, claimed.queueRef);
    const feedbackRef = asString(compensation.feedbackRef, claimed.feedbackRef);
    const queueDocRef = /^fine_tune_outbox\/[a-zA-Z0-9_-]+$/.test(queueRef) ? adminDb.doc(queueRef) : null;
    const feedbackDocRef = /^feedback\/[a-zA-Z0-9_-]+$/.test(feedbackRef) ? adminDb.doc(feedbackRef) : null;
    const queueSnapshot = queueDocRef ? await transaction.get(queueDocRef) : null;
    const feedbackSnapshot = feedbackDocRef ? await transaction.get(feedbackDocRef) : null;
    if (compensation.status !== "cancelling" || compensation.leaseId !== leaseId) {
      return {
        status: asString(compensation.status, "retryable"),
        revision: Number.isInteger(compensation.revision) ? Number(compensation.revision) : claimed.revision,
        attemptCount: Number.isInteger(compensation.attemptCount) ? Number(compensation.attemptCount) : claimed.attemptCount,
        queueRef,
        source: "durable-compensation-concurrent",
      };
    }

    const next = errorCode
      ? planFineTuneCompensationFailure(compensation)
      : planFineTuneCompensationSuccess(compensation);
    const finalizeEvent = adminDb.collection("fine_tune_release_events")
      .doc(`compensation-finalize-${compensationSnapshot.id}-${claimed.attemptCount}`);
    transaction.set(compensationDocRef, {
      ...next,
      lastErrorCode: errorCode,
      ...(next.status === "cancelled" ? { cancelledAt: finalizedAt, cancelledBy: principal.uid } : {}),
      ...(next.status === "dead_letter" ? { deadLetteredAt: finalizedAt } : {}),
      updatedAt: finalizedAt,
    }, { merge: true });
    if (queueDocRef && queueSnapshot?.exists) {
      transaction.set(queueDocRef, {
        ...(next.status === "cancelled" ? { status: "cancelled", cancelledAt: finalizedAt } : {}),
        compensationStatus: next.status,
        compensationRevision: next.revision,
        compensationLastErrorCode: errorCode,
        updatedAt: finalizedAt,
      }, { merge: true });
    }
    const feedback = feedbackSnapshot?.data() ?? {};
    if (feedbackDocRef && feedbackSnapshot?.exists && feedback.fineTuneQueueRef === queueRef) {
      transaction.set(feedbackDocRef, {
        ...(next.status === "cancelled" ? { fineTuneStatus: "cancelled" } : {}),
        fineTuneCompensationStatus: next.status,
        fineTuneCompensationRevision: next.revision,
      }, { merge: true });
    }
    transaction.create(finalizeEvent, {
      id: finalizeEvent.id,
      type: next.status === "cancelled" ? "compensation_cancelled" : `compensation_${next.status}`,
      compensationRef,
      queueRef,
      feedbackRef,
      providerReceiptRef: claimed.providerReceiptRef,
      cancellationHandleRef: claimed.cancellationHandleRef,
      cancellationHandleHash: claimed.cancellationHandleHash,
      attemptCount: next.attemptCount,
      lastErrorCode: errorCode,
      createdBy: principal.uid,
      createdAt: finalizedAt,
      artifactPolicy: "server-ref-only",
    });
    return {
      status: next.status,
      revision: next.revision,
      attemptCount: next.attemptCount,
      queueRef,
      source: next.status === "cancelled"
        ? "aihub-live-cancellation"
        : next.status === "dead_letter"
          ? "durable-compensation-dead-letter"
          : "durable-compensation-retryable",
    };
  });

  return {
    status: finalized.status,
    compensationRef,
    queueRef: finalized.queueRef,
    revision: finalized.revision,
    attemptCount: finalized.attemptCount,
    source: finalized.source,
    behaviorLog: makeBehaviorLog(request, "processFineTuneCompensationOutbox", "allow", 0),
  };
}

export async function getFeedbackKbGovernanceStatus(request: CallableRequest) {
  requireRole(request, "getFeedbackKbGovernanceStatus", RELEASE_ROLES);
  const feedback = adminDb.collection("feedback");
  const kbEntries = adminDb.collectionGroup("feedback_kb_entries");
  const kbReview = adminDb.collection("kb_review");
  const outbox = adminDb.collection("fine_tune_outbox");
  const compensationOutbox = adminDb.collection("fine_tune_compensation_outbox");
  const graphProjectionOutbox = adminDb.collection(FEEDBACK_GRAPH_PROJECTION_COLLECTION);
  const [
    feedbackTotal,
    feedbackPending,
    feedbackApproved,
    feedbackRejected,
    activeEntries,
    pendingConflicts,
    outboxTotal,
    outboxPending,
    outboxRetryable,
    outboxSent,
    outboxCompensation,
    compensationTotal,
    compensationPending,
    compensationCancelling,
    compensationRetryable,
    compensationCancelled,
    compensationDeadLetter,
    graphProjectionTotal,
    graphProjectionPending,
    graphProjectionProcessing,
    graphProjectionRetryable,
    graphProjectionComplete,
  ] = await Promise.all([
    feedback.count().get(),
    feedback.where("reviewStatus", "==", "pending").count().get(),
    feedback.where("reviewStatus", "==", "approved").count().get(),
    feedback.where("reviewStatus", "==", "rejected").count().get(),
    // Collection-group automatic indexes are not maintained by default. Keep
    // the document-id direction explicit so the reviewed add-only composite
    // index contract can prove this organization-wide aggregate before release.
    kbEntries
      .where("retrievalStatus", "==", "active")
      .orderBy(FieldPath.documentId(), "desc")
      .count()
      .get(),
    kbReview.where("status", "==", "pending").count().get(),
    outbox.count().get(),
    outbox.where("status", "in", ["pending", "dispatching", "approved_waiting_for_provider"]).count().get(),
    outbox.where("status", "==", "retryable").count().get(),
    outbox.where("status", "==", "sent_to_aihub").count().get(),
    outbox.where("status", "==", "compensation_required").count().get(),
    compensationOutbox.count().get(),
    compensationOutbox.where("status", "==", "pending").count().get(),
    compensationOutbox.where("status", "==", "cancelling").count().get(),
    compensationOutbox.where("status", "==", "retryable").count().get(),
    compensationOutbox.where("status", "==", "cancelled").count().get(),
    compensationOutbox.where("status", "==", "dead_letter").count().get(),
    graphProjectionOutbox.count().get(),
    graphProjectionOutbox.where("status", "==", "pending").count().get(),
    graphProjectionOutbox.where("status", "==", "processing").count().get(),
    graphProjectionOutbox.where("status", "==", "retryable").count().get(),
    graphProjectionOutbox.where("status", "==", "complete").count().get(),
  ]);

  const integrationEnabled = liveIntegrationsEnabled("aihub");
  let endpointConfigured = false;
  let cancellationEndpointConfigured = false;
  let projectKeyConfigured = false;
  if (integrationEnabled) {
    const config = await getRuntimeIntegration("aiHub");
    endpointConfigured = Boolean(publicString(config, "endpoint", "AIHUB_ENDPOINT"));
    cancellationEndpointConfigured = Boolean(
      publicString(config, "cancellationEndpoint", "AIHUB_CANCELLATION_ENDPOINT"),
    );
    try {
      projectKeyConfigured = Boolean(requireEnvSecret("AIHUB_PROJECT_KEY", "AI Hub"));
    } catch {
      projectKeyConfigured = false;
    }
  }
  const providerConfigured = integrationEnabled
    && endpointConfigured
    && cancellationEndpointConfigured
    && projectKeyConfigured;
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    source: "firestore-aggregations",
    capabilities: {
      lexicalRetrieval: {
        status: "available",
        strategy: FEEDBACK_LEXICAL_STRATEGY,
        scopeContract: FEEDBACK_SCOPE_VERSION,
        legacyUnscoped: "fail_closed",
      },
      vectorRetrieval: vectorCapability(),
      knowledgeGraph: {
        status: graphProjectionRetryable.data().count > 0 ? "degraded" : "available",
        conflictResolution: "transaction-cas-v1",
        durableProjectionOutbox: true,
        retryCallable: "retryFeedbackGraphProjection",
      },
      feedbackReview: {
        status: "available",
        transition: "transaction-cas-v1",
        audit: "append-only-events",
        piiRedaction: "persisted-and-projected",
      },
      fineTuneRelease: {
        status: providerConfigured ? "provider_configured" : "durable_outbox_only",
        durableOutbox: true,
        durableCompensationOutbox: true,
        idempotency: "provider-key-and-cas-lease",
        integrationEnabled,
        endpointConfigured,
        cancellationEndpointConfigured,
        projectKeyConfigured,
      },
    },
    counts: {
      feedback: {
        total: feedbackTotal.data().count,
        pending: feedbackPending.data().count,
        approved: feedbackApproved.data().count,
        rejected: feedbackRejected.data().count,
      },
      knowledge: {
        activeEntries: activeEntries.data().count,
        pendingConflicts: pendingConflicts.data().count,
      },
      fineTuneOutbox: {
        total: outboxTotal.data().count,
        pending: outboxPending.data().count,
        retryable: outboxRetryable.data().count,
        sent: outboxSent.data().count,
        compensationRequired: outboxCompensation.data().count,
      },
      fineTuneCompensationOutbox: {
        total: compensationTotal.data().count,
        pending: compensationPending.data().count,
        cancelling: compensationCancelling.data().count,
        retryable: compensationRetryable.data().count,
        cancelled: compensationCancelled.data().count,
        deadLetter: compensationDeadLetter.data().count,
      },
      graphProjectionOutbox: {
        total: graphProjectionTotal.data().count,
        pending: graphProjectionPending.data().count,
        processing: graphProjectionProcessing.data().count,
        retryable: graphProjectionRetryable.data().count,
        complete: graphProjectionComplete.data().count,
      },
    },
  };
}
