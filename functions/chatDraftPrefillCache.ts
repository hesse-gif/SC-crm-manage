import { createHash } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { canReadConversationRowForScope, resolveConversationMailAccessScope } from "./conversationMailAccessScope";

// S4/P4 (RT-4/A4, COST-P0-011) — decorator around the gatewayProxy callable entry point
// (wired in index.ts, NOT inside chat-ai.ts) so the on-demand chat-open prefill flow
// never re-invokes the model for an inbound message it has already resolved. This is
// deliberately a thin wrapper at the callable boundary rather than an edit inside
// gatewayProxy's body: chat-ai.ts:3513-3615 (runGatewayLive calls + persistLlmUsageRollup,
// P12 double-counting) is another lane's active edit surface.
//
// Only requests carrying `autoPrefill: true` are affected — the existing manual "AI 초안"
// button and its retry path never set this flag, so they always recompute (unchanged).
// The cache is permanent (no TTL): once a specific inbound messageRef has a resolved
// draft/blockedReason, reopening the conversation later must not re-call the model even
// after the generic 1h semantic gateway cache (ai_gateway_cache) has expired.

type Handler = (request: CallableRequestShape) => Promise<unknown>;

const PREFILL_CACHE_COLLECTION = "chat_draft_prefill_cache";

function cacheScopeHash(userId: string, gameId: string, conversationId: string, messageRef: string): string {
  // Cache identity is an opaque digest of the verified caller plus the authoritative
  // conversation and immutable message reference. This prevents normalized/truncated
  // document-id collisions and forbids a cache hit from crossing accounts or conversations.
  return createHash("sha256").update(`${userId}\u0000${gameId}\u0000${conversationId}\u0000${messageRef}`).digest("hex");
}

function prefillCacheDocId(scopeHash: string): string {
  return `prefill-${scopeHash}`;
}

// Red-team fix(S3): the doc id alone (messageRef) doesn't capture WHAT was
// fed into the draft computation. If the same messageRef were ever recomputed with
// different input content (accumulated conversation context, a corrected fixture, etc.)
// a stale cache hit would silently serve a response to a different question. Hash the raw
// `signal` text (the actual draft input) and only serve the cache when it still matches —
// a content change under the same messageRef now recomputes fresh instead of going stale.
function contentHashForSignal(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return createHash("sha256").update(text).digest("hex");
}

export function withAutoPrefillCache(handler: Handler): Handler {
  const wrapped = async (request: CallableRequestShape): Promise<unknown> => {
    const data = asRecord(request.data);
    const autoPrefill = data.autoPrefill === true;
    const messageRef = asString(data.messageRef, "");
    // Not an auto-prefill call (manual "AI 초안"/재시도 button, or missing messageRef to key
    // on) — behave exactly as before, no cache involved.
    if (!autoPrefill || !messageRef) return handler(request);

    const ctx = assertNonGuestAuth(request, "gatewayProxy.autoPrefill");
    const conversationId = asString(data.conversationId, "");
    // A canonical conversation alias is not proof that the same account remains authorized.
    // Require an authoritative conversation id and bind every cache row to the caller scope.
    if (!conversationId) return handler(request);
    const contentHash = contentHashForSignal(data.signal);
    const scopeHash = cacheScopeHash(ctx.userId, ctx.gameId, conversationId, messageRef);
    const cacheRef = adminDb.collection(PREFILL_CACHE_COLLECTION).doc(prefillCacheDocId(scopeHash));
    const cached = await cacheRef.get();
    const cachedRecord = cached.exists ? cached.data() ?? {} : null;
    if (cachedRecord && cachedRecord.contentHash === contentHash && cachedRecord.scopeHash === scopeHash) {
      // Flu conversation org-filter round 3 (codex adversarial review round 3, finding #5): the
      // cache key binds (userId, gameId, conversationId, messageRef) at WRITE time, but a caller's
      // scp grant/org eligibility can be revoked afterward — recheck the caller's CURRENT scope
      // against the conversation before ever serving a hit, so a stale cached draft cannot outlive
      // the access that produced it. A denial here simply falls through to the normal handler call
      // below (same as any other cache miss), which enforces the same live check itself.
      const accessScope = await resolveConversationMailAccessScope(ctx);
      const conversationSnapshot = await adminDb.collection("conversations").doc(conversationId).get();
      // Flu conversation org-filter round 5 (codex adversarial review round 5, finding #3): a
      // deleted conversation must fail closed here, not read as `{}` and pass the non-scp
      // pass-through — a missing doc proves nothing about scp/org scope, so it can never be
      // reauthorized as still in-scope (super_admin bypasses this regardless, same as always).
      // Flu conversation org-filter round 11 (codex adversarial review round 11, finding #1):
      // canReadScpConversationRowForOrg alone deliberately passes legacy conversations with no
      // mailAccountId at all — it only narrows the SHARED scp mailbox by org, and never checks
      // positive mailbox entitlement in the first place. A manager whose scp grant was revoked
      // could still get a cache hit for a known legacy conversationId. Use the same combined
      // predicate listConversations/canReadConversationForAuth apply (mailbox entitlement,
      // including today's legacy-blank handling, AND the org gate).
      const stillAuthorized = conversationSnapshot.exists && canReadConversationRowForScope(
        { id: conversationId, ...(conversationSnapshot.data() ?? {}) },
        accessScope,
      ) || accessScope.isSuperAdmin;
      if (stillAuthorized) {
        const response = cachedRecord.response && typeof cachedRecord.response === "object" ? cachedRecord.response as Record<string, unknown> : {};
        return {
          ...response,
          resolvedFromCache: true,
          source: "gateway-prefill-cache-hit",
          behaviorLog: makeBehaviorLog(ctx, "gatewayProxy.autoPrefill", "cache_hit", ctx.gameId, 0),
        };
      }
    }

    const result = await handler(request);
    const record = asRecord(result);
    // Persist only the response contract (no prompt/raw content, SEC-P0-009) so a later
    // reopen of the same messageRef reconstructs the same reply without a model call.
    await cacheRef.set({
      conversationId,
      messageRef,
      scopeHash,
      contentHash,
      response: {
        ok: record.ok,
        source: record.source,
        summaryKr: record.summaryKr,
        draftText: record.draftText,
        draftPreview: record.draftPreview,
        draftRef: record.draftRef,
        trackingId: record.trackingId,
        humanGate: record.humanGate,
      },
      computedAtIso: new Date().toISOString(),
    }, { merge: true });
    return result;
  };
  // Preserve the wrapped handler's function name — index.ts's callable() wrapper uses
  // handler.name for callableRuns/engineSnapshots doc ids and audit logging.
  Object.defineProperty(wrapped, "name", { value: handler.name, configurable: true });
  return wrapped;
}
