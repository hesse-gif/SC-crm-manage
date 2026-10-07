import type { CallableRequestShape } from "./shared";

type Handler = (request: CallableRequestShape) => Promise<unknown>;

type CacheEntry = { expiresAt: number; value: Promise<unknown> };

/**
 * Perf/cost 2026-09-27 (RSC/hard-navigation cost audit): a generic in-instance TTL cache for
 * idempotent READ callables, applied at the functions/index.ts export site around a handler
 * before it is passed to callable().
 *
 * Why this shape: it mirrors the caching idiom this codebase already established for
 * per-callable-internal reads — getOrgNameCached (functions/mailAccountCallables.ts),
 * MAIL_ACCOUNT_RESOLUTION_CACHE_TTL_MS (functions/mailAccounts.ts), ORG_TAB_PRESETS_CACHE_TTL_MS
 * (functions/orgTabPresets.ts): a `Map<key, {expiresAt, value: Promise}>`, bounded size with
 * oldest-first eviction, and a rejected value removes itself so a failed read is never cached and
 * the next call retries for real. This file generalizes that idiom to the whole callable response.
 *
 * IMPORTANT — who this is safe for: only wrap a handler whose authorization is entirely a
 * function of static token claims (role/team/gameId/tenant), never a *live* per-request
 * Firestore/Peoply grant lookup. This started as an attempt to cache the top-7d-invocation-count
 * read callables by execution_count (getDataset/listConversations/listCreators/listCampaigns/
 * listPrograms/listProgramApplications/getMyOrgContext), but adversarial review (codex round 2)
 * found that every one of those *except* listCreators resolves the caller's live mailbox/account
 * grant on every call (mailAccounts.ts's readExplicitMailAccountIds — deliberately never cached,
 * specifically so an admin revoking someone's mailbox access takes effect on their very next
 * call), via datasetAccountOwnershipFilter (read.ts's ACCOUNT_OWNERSHIP_DATASET_KEYS: "campaigns",
 * "programs", "candidatePool"), programApplicationParentFilter, resolveConversationOrgScope, or a
 * direct resolveMailSenderPolicyForEmail call. Caching those whole responses would delay that
 * revocation by up to the TTL — a real regression in a guarantee this codebase deliberately
 * hardened (Flu/Task-50 적대 리뷰 P0-1 did the same for viewAs target re-verification, which this
 * file also respects — see hasViewAsPayload below). listCreators is the one candidate whose only
 * authorization is the static role check (canReadDatasetKey — "creators" is not in
 * ACCOUNT_OWNERSHIP_DATASET_KEYS), so it has no live grant to go stale, and is the only callable
 * currently wrapped with this (functions/index.ts). Before adding another callable here, verify
 * the same thing: trace every scope/filter/policy resolution its handler calls and confirm none of
 * them reads current-moment Firestore/Peoply state that a revocation could change.
 *
 * Where this sits in the callable() pipeline (functions/index.ts): callable() always calls
 * whatever handler it is given and always runs persistCallableOutcome (behaviorLog/costLog/
 * callableRuns audit trail — LOG-P0-008) on that handler's result, cached or not. This wrapper
 * only changes what the *handler* does — serve a resolved value from cache vs. do the real
 * Firestore/Peoply work — so callableRuns (which reads uid/role/team straight off the CURRENT
 * request, never off the handler's return value) stays accurate on a hit. behaviorLog is
 * different: it is embedded in the handler's *return value* by the handler itself, so a naive
 * replay would persist the ORIGINAL (cache-populating) call's time/IP under the CURRENT caller's
 * behavior_logs row. patchBehaviorLogForCacheHit below fixes that up on every hit — see its
 * comment.
 *
 * RBAC (cache after authorization, per scope) — the cache key is derived only from the RAW
 * request, never from anything the handler computes, and is built from every claim any wrapped
 * handler's self-scope branch could read off the token (uid/role/team/gameId/tenant/email/
 * emailVerified/memberEmail — adversarial review round 1 BLOCKER, codex: a narrower key let the
 * same uid keep serving a stale response after its email/verification state changed). A HIT can
 * therefore only ever replay a value that this exact (identity, params) combination already
 * produced by running the real handler's full assertNonGuestAuth/canReadDatasetKey/
 * tenant-boundary/scope checks at least once. A cache hit must also never replay a viewAs-scoped
 * read (round 1 BLOCKER, codex): requests whose data carries viewAsUserId/viewAsEmail always
 * bypass this cache entirely (hasViewAsPayload below) and call straight through, so P0-1's live
 * re-verification of the viewAs target is never skipped.
 *
 * Residual, accepted tradeoff (documented, not fixed — matches this codebase's existing
 * precedent, e.g. ORG_NAME_CACHE_TTL_MS/MAIL_ACCOUNT_RESOLUTION_CACHE_TTL_MS accepting the same
 * class of staleness for their own sub-fetches): a write immediately followed by the same caller
 * re-reading listCreators with the same params can still observe the pre-write value until this
 * entry expires, since this cache has no invalidation hook into any write callable. Kept the TTL
 * short (functions/index.ts's READ_CACHE_TTL_MS, 15s — below the 30-60s starting target) to bound
 * the exposure rather than building a cross-callable invalidation protocol, which is a much larger
 * change than this PR's "smallest viable diff" scope (round 1 HIGH, codex).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** viewAs-scoped reads always bypass this cache — see the BLOCKER note above. */
function hasViewAsPayload(data: unknown): boolean {
  if (!isRecord(data)) return false;
  return (
    Object.prototype.hasOwnProperty.call(data, "viewAsUserId") ||
    Object.prototype.hasOwnProperty.call(data, "viewAsEmail")
  );
}

function cacheKeyFor(request: CallableRequestShape): string {
  const auth = request.auth;
  // JSON.stringify an array (not a "|"-joined string) so distinct claim tuples can never collide
  // by a delimiter appearing inside one of the claim values (adversarial review round 1 MEDIUM,
  // codex) — e.g. team:"a|b",gameId:"c" vs team:"a",gameId:"b|c" now serialize differently. Each
  // claim falls back to `null`, not `""`/`false` (adversarial review round 2 BLOCKER, codex): a
  // missing claim and one explicitly present-but-empty must not alias to the same key element —
  // JSON.stringify tells `null` apart from `""`/`false`, so they no longer collide.
  const identity = auth?.uid
    ? JSON.stringify([
        auth.uid,
        auth.token?.role ?? null,
        auth.token?.team ?? null,
        auth.token?.gameId ?? null,
        auth.token?.firebase?.tenant ?? null,
        auth.token?.email ?? null,
        auth.token?.emailVerified ?? null,
        auth.token?.memberEmail ?? null,
      ])
    : "guest";
  let params: string;
  try {
    params = JSON.stringify(request.data ?? null);
  } catch {
    // Callable request.data is already JSON-shaped by the time it reaches a handler, so this
    // should be unreachable — fail safe to "never share a cache slot" rather than throw.
    params = `unserializable:${Date.now()}:${Math.random()}`;
  }
  return `${identity}::${params}`;
}

/**
 * A cache hit replays a value some earlier request produced. If that value carries a
 * behaviorLog (functions/shared.ts's makeBehaviorLog shape — every handler this file wraps
 * returns one), its `time`/`IP` reflect the ORIGINAL request, not the current caller's — and
 * `result` still says "success" even though no real work happened this time. This codebase
 * already has a `"cache_hit"` BehaviorLog.result variant used by its own internal caches
 * (chatDraftPrefillCache.ts, reportDashboard.ts, sheet3SubmissionBridge.ts, tickets.ts all call
 * makeBehaviorLog(ctx, action, "cache_hit", ...) directly) — this reproduces the same outcome
 * without needing this generic wrapper to reconstruct each handler's own AuthContext: it patches
 * only the three fields that must reflect *this* request (time/IP/result) onto a shallow clone,
 * leaving userId/role/team/gameId/action/cost as originally computed (those are already
 * guaranteed identical to the current request by the cache key). Returns the value unchanged if
 * it has no behaviorLog-shaped field (nothing to patch).
 */
function patchBehaviorLogForCacheHit(resolved: unknown, request: CallableRequestShape): unknown {
  if (!isRecord(resolved)) return resolved;
  const behaviorLog = resolved.behaviorLog;
  if (!isRecord(behaviorLog)) return resolved;
  return {
    ...resolved,
    behaviorLog: {
      ...behaviorLog,
      time: new Date().toISOString(),
      IP: request.rawRequest?.ip ?? behaviorLog.IP,
      result: "cache_hit",
    },
  };
}

/**
 * Wrap a read-only callable handler with an in-instance TTL cache. `name` becomes the wrapped
 * function's `.name` — functions/index.ts's callable() reads `handler.name` both for the view-as
 * read-only whitelist (assertViewAsReadOnlyPayload) and as the audit-log callable name, so this
 * must equal the original exported handler's name (e.g. "getDataset") or those two things silently
 * break.
 */
export function cacheableRead(
  name: string,
  ttlMs: number,
  handler: Handler,
  maxEntries = 200,
): Handler {
  const cache = new Map<string, CacheEntry>();
  const wrapped: Handler = (request) => {
    if (hasViewAsPayload(request.data)) return handler(request);
    const key = cacheKeyFor(request);
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value.then((resolved) => patchBehaviorLogForCacheHit(resolved, request));
    }
    const value = Promise.resolve().then(() => handler(request));
    cache.delete(key);
    cache.set(key, { expiresAt: now + ttlMs, value });
    value.catch(() => {
      // Never cache a rejection — remove it only if it is still the current entry for this key
      // (a concurrent miss for the same key may already have replaced it).
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
    return value;
  };
  Object.defineProperty(wrapped, "name", { value: name, configurable: true });
  return wrapped;
}
