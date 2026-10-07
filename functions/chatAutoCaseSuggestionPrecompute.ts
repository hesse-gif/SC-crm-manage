import { randomUUID } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import { CHAT_CASEBOOK } from "./chatCasebook";
import { isChatAutoPermitCaseId, type ChatAutoPermitCaseId } from "./chatAutoCasePermit";
import {
  CHAT_AUTO_CASE_DEFAULT_SUGGESTION_TTL_MS,
  chatAutoCaseDefaultSuggestionInputKey,
  chatAutoCaseReplyRevisionFor,
  generateChatAutoCaseReplySuggestion,
  isChatAutoCaseSuggestionApplicable,
  readChatAutoCaseReplyState,
  type ChatAutoCaseReplyState,
  type ChatAutoCaseReplySuggestionServiceDependencies,
} from "./chatAutoCaseReplies";
import { CHAT_AUTO_CASEBOOK_PENDING_SUPER_ADMIN_SCOPE_KEY, readChatAutoCasebookPendingSnapshot } from "./chatAutoCasebookPendingPrecompute";
import { readSettings } from "./settings";
import { selectVertexModelForTaskWithRoutes } from "./vertex";

// Default reply-suggestion precompute (casebook inbox, 2026-10-01).
//
// A 15-minute job drafts ONE default English reply suggestion per applicable casebook case and stores
// it in `chat_auto_case_reply_default_suggestions/{caseId}` so the console shows it instantly instead
// of making an operator wait on (and pay for) a model call. Safety shape:
//   - Server-only collection: firestore.rules has no read rule for it (deny by default) and every write
//     is Admin SDK. The job NEVER writes reply config, permits, the pending snapshot, or sends mail.
//   - A suggestion is only a draft: it passes the same sanitizer as an operator-saved reply plus the
//     suggestion-only link-token contract (see chatAutoCaseReplies.generateChatAutoCaseReplySuggestion).
//   - Saving/resetting a reply, a link-catalog change, a prompt-version bump, or a model switch changes
//     the inputKey, so the stored doc turns stale and is regenerated on the next run — no hook needed.
//   - A transactional lease per case prevents two overlapping runs from paying for the same draft.
//   - Cache-first: a hit in ai_gateway_cache costs zero model calls (and does not count against the cap).

export const CHAT_AUTO_CASE_DEFAULT_SUGGESTIONS_COLLECTION = "chat_auto_case_reply_default_suggestions";
export const CHAT_AUTO_CASE_DEFAULT_SUGGESTION_USAGE_TOOL_ID = "chat_auto_case_reply.default_suggestion";
/** Model calls per run (cache hits excluded) — bounds spend even if every case is stale. */
export const CHAT_AUTO_CASE_SUGGESTION_MAX_GENERATIONS_PER_RUN = 6;
export const CHAT_AUTO_CASE_SUGGESTION_CONCURRENCY = 2;
/** Longer than a worst-case generation, shorter than the 15-minute cadence: a crashed run self-heals. */
export const CHAT_AUTO_CASE_SUGGESTION_LEASE_MS = 6 * 60 * 1000;
export const CHAT_AUTO_CASE_SUGGESTION_BACKOFF_BASE_MS = 15 * 60 * 1000;
export const CHAT_AUTO_CASE_SUGGESTION_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
/** Stop starting new cases this far into the run (the schedule's hard timeout is 300s). */
export const CHAT_AUTO_CASE_SUGGESTION_RUN_DEADLINE_MS = 220_000;

export type ChatAutoCaseDefaultSuggestionStatus = "ready" | "stale" | "pending" | "failed" | "not_applicable";
export type ChatAutoCaseDefaultSuggestionView = {
  status: ChatAutoCaseDefaultSuggestionStatus;
  /** Only when status === "ready". */
  text: string | null;
  generatedAtIso: string | null;
  modelId: string | null;
};

type StoredSuggestion = Record<string, unknown>;
type ClaimVerdict = "fresh" | "leased" | "backoff" | "claim";

function iso(date: Date): string {
  return date.toISOString();
}

function isoMs(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

function leaseLive(doc: StoredSuggestion, nowMs: number): boolean {
  return doc.status === "pending" && typeof doc.leaseId === "string" && isoMs(doc.leaseUntilIso) > nowMs;
}

function readyAndUnexpired(doc: StoredSuggestion, nowMs: number): boolean {
  return doc.status === "ready" && typeof doc.text === "string" && isoMs(doc.expiresAtIso) > nowMs;
}

/** Whether a run should do work for a case, given what is stored and the inputs it would use now. */
function classifyForClaim(doc: StoredSuggestion | undefined, inputKey: string, nowMs: number): ClaimVerdict {
  if (!doc) return "claim";
  if (leaseLive(doc, nowMs)) return "leased";
  if (doc.inputKey !== inputKey) return "claim";
  if (readyAndUnexpired(doc, nowMs)) return "fresh";
  if (doc.status === "failed" && isoMs(doc.nextAttemptAtIso) > nowMs) return "backoff";
  return "claim";
}

function failureCodeFor(error: unknown): string {
  const record = (error && typeof error === "object" ? error : {}) as { errorCode?: unknown; code?: unknown };
  const raw = typeof record.errorCode === "string" ? record.errorCode : typeof record.code === "string" ? record.code : "";
  // Codes only — never an error message, which could echo model output or prompt text (SEC-P0-009).
  return /^[A-Za-z0-9_./-]{1,64}$/.test(raw) ? raw : "generation_failed";
}

function backoffMs(attempts: number): number {
  return Math.min(CHAT_AUTO_CASE_SUGGESTION_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), CHAT_AUTO_CASE_SUGGESTION_BACKOFF_MAX_MS);
}

async function resolveDefaultSuggestionModelId(): Promise<string> {
  const settings = await readSettings();
  return selectVertexModelForTaskWithRoutes("email_draft", settings.llmModelRoutes);
}

/**
 * Snapshot read: per-case default-suggestion status for the casebook console. Read-only.
 * ready  = inputKey matches the CURRENT inputs and the doc has not expired (24h);
 * stale  = a doc exists but its inputKey no longer matches (reply/link/model/prompt changed) or expired;
 * pending= no doc yet, or a generation is queued/in flight for the current inputs;
 * failed = the last attempt for the current inputs failed (job retries with backoff);
 * not_applicable = hard cases (blocked/auto-close) that never carry a reply.
 */
export async function readChatAutoCaseDefaultSuggestions(
  caseIds: readonly string[],
  replyState: ChatAutoCaseReplyState,
  now: Date = new Date(),
  deps: { db?: typeof adminDb; resolveModelId?: () => Promise<string> | string } = {},
): Promise<Map<string, ChatAutoCaseDefaultSuggestionView>> {
  const db = deps.db ?? adminDb;
  const nowMs = now.getTime();
  const result = new Map<string, ChatAutoCaseDefaultSuggestionView>();
  const applicable: ChatAutoPermitCaseId[] = [];
  for (const caseId of caseIds) {
    if (isChatAutoPermitCaseId(caseId) && isChatAutoCaseSuggestionApplicable(caseId)) applicable.push(caseId);
    else result.set(caseId, { status: "not_applicable", text: null, generatedAtIso: null, modelId: null });
  }
  if (!applicable.length) return result;
  let modelId: string | null = null;
  try {
    modelId = await (deps.resolveModelId ? deps.resolveModelId() : resolveDefaultSuggestionModelId());
  } catch {
    // Without the routed model the current inputKey is unknowable; report "pending" rather than break the snapshot.
    modelId = null;
  }
  const docs = await Promise.all(applicable.map(async (caseId) => {
    const snapshot = await db.collection(CHAT_AUTO_CASE_DEFAULT_SUGGESTIONS_COLLECTION).doc(caseId).get();
    return [caseId, snapshot.exists ? (snapshot.data() as StoredSuggestion | undefined) : undefined] as const;
  }));
  for (const [caseId, doc] of docs) {
    const pending: ChatAutoCaseDefaultSuggestionView = { status: "pending", text: null, generatedAtIso: null, modelId: null };
    if (!doc || modelId === null) {
      result.set(caseId, pending);
      continue;
    }
    const expectedKey = chatAutoCaseDefaultSuggestionInputKey(caseId, chatAutoCaseReplyRevisionFor(caseId, replyState).revisionHash, modelId);
    if (doc.inputKey !== expectedKey) {
      result.set(caseId, { status: "stale", text: null, generatedAtIso: null, modelId: null });
    } else if (doc.status === "ready" && typeof doc.text === "string") {
      result.set(caseId, isoMs(doc.expiresAtIso) > nowMs
        ? { status: "ready", text: doc.text, generatedAtIso: typeof doc.generatedAtIso === "string" ? doc.generatedAtIso : null, modelId: typeof doc.modelId === "string" ? doc.modelId : null }
        : { status: "stale", text: null, generatedAtIso: null, modelId: null });
    } else if (doc.status === "failed") {
      result.set(caseId, { status: "failed", text: null, generatedAtIso: null, modelId: null });
    } else {
      result.set(caseId, pending);
    }
  }
  return result;
}

async function defaultReadPendingCounts(): Promise<Record<string, number> | null> {
  const pending = await readChatAutoCasebookPendingSnapshot(CHAT_AUTO_CASEBOOK_PENDING_SUPER_ADMIN_SCOPE_KEY);
  return pending.status === "missing" ? null : pending.data.byCaseId;
}

/** Applicable cases, busiest super_admin pending queue first; canonical casebook order breaks ties/fallback. */
async function orderedCandidateCaseIds(readPendingCounts: () => Promise<Record<string, number> | null>): Promise<ChatAutoPermitCaseId[]> {
  const canonical = CHAT_CASEBOOK
    .map((item) => item.id)
    .filter((id): id is ChatAutoPermitCaseId => isChatAutoPermitCaseId(id) && isChatAutoCaseSuggestionApplicable(id));
  let counts: Record<string, number> | null = null;
  try {
    counts = await readPendingCounts();
  } catch {
    counts = null;
  }
  const countOf = (caseId: string) => (counts && Number.isFinite(counts[caseId]) ? counts[caseId] : 0);
  return canonical
    .map((caseId, index) => ({ caseId, index }))
    .sort((a, b) => countOf(b.caseId) - countOf(a.caseId) || a.index - b.index)
    .map((entry) => entry.caseId);
}

export type ChatAutoCaseSuggestionPrecomputeDependencies = Pick<
  ChatAutoCaseReplySuggestionServiceDependencies,
  "generate" | "reportUsage" | "readReplyState" | "readSuggestionCache" | "writeSuggestionCache"
> & {
  db?: typeof adminDb;
  now?: () => Date;
  vertexApproved?: () => boolean;
  resolveModelId?: () => Promise<string> | string;
  readPendingCounts?: () => Promise<Record<string, number> | null>;
  maxGenerations?: number;
  concurrency?: number;
  deadlineMs?: number;
};

export type ChatAutoCaseSuggestionPrecomputeResult = {
  skipped: "vertex_not_approved" | "reply_state_unavailable" | "model_unresolved" | null;
  modelId: string | null;
  considered: number;
  /** Model calls actually made (cache hits excluded). */
  generated: number;
  cacheHits: number;
  upToDate: number;
  leaseHeld: number;
  backoff: number;
  failed: Array<{ caseId: string; failureCode: string }>;
  capReached: boolean;
  deadlineExceeded: boolean;
};

const CAP_REACHED = Symbol("chat_auto_case_suggestion_cap_reached");

export async function runChatAutoCaseSuggestionPrecompute(deps: ChatAutoCaseSuggestionPrecomputeDependencies = {}): Promise<ChatAutoCaseSuggestionPrecomputeResult> {
  const db = deps.db ?? adminDb;
  const now = deps.now ?? (() => new Date());
  const maxGenerations = deps.maxGenerations ?? CHAT_AUTO_CASE_SUGGESTION_MAX_GENERATIONS_PER_RUN;
  const concurrency = Math.max(1, deps.concurrency ?? CHAT_AUTO_CASE_SUGGESTION_CONCURRENCY);
  const deadlineAtMs = now().getTime() + (deps.deadlineMs ?? CHAT_AUTO_CASE_SUGGESTION_RUN_DEADLINE_MS);
  const result: ChatAutoCaseSuggestionPrecomputeResult = {
    skipped: null, modelId: null, considered: 0, generated: 0, cacheHits: 0, upToDate: 0, leaseHeld: 0, backoff: 0, failed: [], capReached: false, deadlineExceeded: false,
  };
  if (!(deps.vertexApproved?.() ?? process.env.VERTEX_TICO_APPROVED === "true")) return { ...result, skipped: "vertex_not_approved" };
  let replyState: ChatAutoCaseReplyState;
  try {
    replyState = await (deps.readReplyState ?? readChatAutoCaseReplyState)();
  } catch {
    // An invalid saved reply config fails closed here too (same validation as save/suggest).
    return { ...result, skipped: "reply_state_unavailable" };
  }
  let modelId: string;
  try {
    modelId = await (deps.resolveModelId ? deps.resolveModelId() : resolveDefaultSuggestionModelId());
  } catch {
    return { ...result, skipped: "model_unresolved" };
  }
  result.modelId = modelId;
  const order = await orderedCandidateCaseIds(deps.readPendingCounts ?? defaultReadPendingCounts);
  result.considered = order.length;
  const collection = db.collection(CHAT_AUTO_CASE_DEFAULT_SUGGESTIONS_COLLECTION);
  const existing = new Map<string, StoredSuggestion | undefined>(await Promise.all(order.map(async (caseId) => {
    const snapshot = await collection.doc(caseId).get();
    return [caseId, snapshot.exists ? (snapshot.data() as StoredSuggestion | undefined) : undefined] as const;
  })));

  let modelCallsStarted = 0;
  const queue = [...order];

  const processCase = async (caseId: ChatAutoPermitCaseId): Promise<"continue" | "stop"> => {
    const revision = chatAutoCaseReplyRevisionFor(caseId, replyState);
    const inputKey = chatAutoCaseDefaultSuggestionInputKey(caseId, revision.revisionHash, modelId);
    const countVerdict = (verdict: ClaimVerdict) => {
      if (verdict === "fresh") result.upToDate += 1;
      else if (verdict === "leased") result.leaseHeld += 1;
      else if (verdict === "backoff") result.backoff += 1;
    };
    // Cheap pre-check from the up-front read; the claim transaction below re-validates atomically.
    const preVerdict = classifyForClaim(existing.get(caseId), inputKey, now().getTime());
    if (preVerdict !== "claim") {
      countVerdict(preVerdict);
      return "continue";
    }
    const ref = collection.doc(caseId);
    const leaseId = randomUUID();
    const claim = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const doc = snapshot.exists ? (snapshot.data() as StoredSuggestion | undefined) : undefined;
      const nowDate = now();
      const verdict = classifyForClaim(doc, inputKey, nowDate.getTime());
      if (verdict !== "claim") return { verdict } as const;
      const attempts = doc && doc.inputKey === inputKey && doc.status === "failed" && Number.isSafeInteger(doc.attempts) ? (doc.attempts as number) : 0;
      transaction.set(ref, {
        schemaVersion: 1,
        caseId,
        status: "pending",
        inputKey,
        text: null,
        generatedAtIso: null,
        expiresAtIso: null,
        modelId,
        provider: null,
        transport: null,
        failureCode: null,
        attempts,
        leaseId,
        leaseUntilIso: iso(new Date(nowDate.getTime() + CHAT_AUTO_CASE_SUGGESTION_LEASE_MS)),
        nextAttemptAtIso: null,
        updatedAtIso: iso(nowDate),
      }, { merge: false });
      return { verdict, attempts } as const;
    });
    if (claim.verdict !== "claim") {
      countVerdict(claim.verdict);
      return "continue";
    }

    // Writes only while we still hold this lease; a lease that expired and was re-claimed is left alone.
    const writeIfLeaseHeld = (build: (current: StoredSuggestion, nowDate: Date) => StoredSuggestion) =>
      db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        const current = snapshot.exists ? (snapshot.data() as StoredSuggestion | undefined) : undefined;
        if (!current || current.leaseId !== leaseId) return false;
        const nowDate = now();
        transaction.set(ref, { ...build(current, nowDate), leaseId: null, leaseUntilIso: null, updatedAtIso: iso(nowDate) }, { merge: false });
        return true;
      });

    try {
      const suggestion = await generateChatAutoCaseReplySuggestion({
        caseId,
        kind: "default",
        instruction: "",
        modelId,
        replyState,
        deps: {
          generate: deps.generate,
          reportUsage: deps.reportUsage,
          readReplyState: deps.readReplyState,
          now: deps.now,
          readSuggestionCache: deps.readSuggestionCache,
          writeSuggestionCache: deps.writeSuggestionCache,
          usageToolId: CHAT_AUTO_CASE_DEFAULT_SUGGESTION_USAGE_TOOL_ID,
          beforeGenerate: async () => {
            if (modelCallsStarted >= maxGenerations) throw CAP_REACHED;
            modelCallsStarted += 1;
          },
        },
      });
      await writeIfLeaseHeld((current, nowDate) => ({
        ...current,
        status: "ready",
        text: suggestion.text,
        generatedAtIso: iso(nowDate),
        expiresAtIso: iso(new Date(nowDate.getTime() + CHAT_AUTO_CASE_DEFAULT_SUGGESTION_TTL_MS)),
        modelId: suggestion.modelId,
        provider: suggestion.provider,
        transport: suggestion.transport,
        failureCode: null,
        attempts: 0,
        nextAttemptAtIso: null,
      }));
      if (suggestion.cacheHit) result.cacheHits += 1;
      else result.generated += 1;
      return "continue";
    } catch (error) {
      const capReached = error === CAP_REACHED;
      const failureCode = failureCodeFor(error);
      // Cap reached and "the reply changed while generating" are not failures: release the lease so the
      // next run (new inputKey / fresh cap) picks the case up without a backoff penalty.
      if (capReached || failureCode === "chat_auto_case_reply_revision_conflict") {
        await writeIfLeaseHeld((current) => ({ ...current }));
        if (capReached) result.capReached = true;
        return capReached ? "stop" : "continue";
      }
      await writeIfLeaseHeld((current, nowDate) => {
        const attempts = (Number.isSafeInteger(current.attempts) ? (current.attempts as number) : claim.attempts) + 1;
        return { ...current, status: "failed", failureCode, attempts, nextAttemptAtIso: iso(new Date(nowDate.getTime() + backoffMs(attempts))) };
      });
      result.failed.push({ caseId, failureCode });
      return "continue";
    }
  };

  const worker = async () => {
    while (queue.length) {
      if (now().getTime() >= deadlineAtMs) {
        result.deadlineExceeded = true;
        return;
      }
      const caseId = queue.shift() as ChatAutoPermitCaseId;
      if ((await processCase(caseId)) === "stop") {
        queue.length = 0;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return result;
}
