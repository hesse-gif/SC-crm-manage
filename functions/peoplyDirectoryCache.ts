/**
 * Peoply directory cache — server-only Firestore snapshot of the org/team projection that
 * `functions/peoplyClient.ts` would otherwise fetch live on every request.
 *
 * Why this exists (2026-09-29, owner 헤세): a ~7 minute Peoply outage broke Chat mailbox
 * loading and casebook scope lookups because `mailAccounts.ts`/`admin.ts` called Peoply live
 * on the request path. This module lets those call sites read a daily-synced snapshot first —
 * present in the cache (fresh or stale, up to `PEOPLY_DIRECTORY_CACHE_STALE_TOLERANCE_MS`) is
 * always good enough to serve the request; only a user who has never been synced falls back to
 * a live lookup. On sync failure the previous snapshot is left untouched (never deleted), so a
 * Peoply outage during the nightly sync degrades to "yesterday's data," not "no data."
 *
 * Firestore layout (both server-only; see firestore.rules):
 *   - `peoply_directory_cache/{emailHash}`      one row per known email (see PeoplyDirectoryCacheEntry)
 *   - `peoply_directory_cache_meta/status`      singleton sync-run status (see PeoplyDirectoryCacheMeta)
 *
 * Deliberately NOT wired through this cache: `peoplyCallables.ts`'s interactive directory
 * search/lookup (an admin explicitly wants LIVE data when browsing Peoply) and
 * `accountOwnership.ts`'s resolveExplicitOwnershipAssignment (a super_admin explicitly
 * reassigning someone's org must be verified against Peoply's current truth, not a snapshot).
 */
import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  getPeoplyClient,
  PeoplyClientError,
  verifiedPeoplyPrimaryMembershipForEmail,
  type PeoplyClient,
  type PeoplyMembership,
  type PeoplyMembershipView,
  type PeoplyPersonDetail,
} from "./peoplyClient";

export const PEOPLY_DIRECTORY_CACHE_COLLECTION = "peoply_directory_cache";
export const PEOPLY_DIRECTORY_CACHE_META_COLLECTION = "peoply_directory_cache_meta";
export const PEOPLY_DIRECTORY_CACHE_META_DOC_ID = "status";

/** A cache row younger than this is "fresh" (observability only — a hit is served either way). */
export const PEOPLY_DIRECTORY_CACHE_FRESH_MS = 24 * 60 * 60 * 1000;
/**
 * Documented staleness trade-off (design point 4): a row older than this is still served rather
 * than failing the request — Peoply being down must never break a known user's login/mailbox —
 * but it is flagged in logs as "very-stale" so an operator notices the daily sync has been
 * failing for a while and can run the manual super_admin refresh.
 */
export const PEOPLY_DIRECTORY_CACHE_STALE_TOLERANCE_MS = 30 * 24 * 60 * 60 * 1000;
/** Same bound `resolveConfiguredMailAccountForOrgHierarchy` (mailAccounts.ts) uses for its live walk. */
const ORG_ANCESTRY_MAX_DEPTH = 32;
/** Abort the sweep once this many consecutive per-user lookups fail with a transient kind — a
 * sign Peoply itself is down for the rest of the run, not that these particular users are unmapped. */
const SYNC_CIRCUIT_BREAKER_THRESHOLD = 5;
const TRANSIENT_PEOPLY_ERROR_KINDS: ReadonlySet<string> = new Set(["network", "upstream", "rate_limited", "forbidden", "missing_key", "invalid_base_url"]);

export type PeoplyOrgAncestryLink = {
  readonly orgId: string;
  readonly name: string;
  readonly parentId: string | null;
};

export type PeoplyDirectoryCacheSource = "scheduled-sync" | "manual-refresh" | "live-fallback";

/** One row's worth of the Peoply lookup role-relevant call sites need — no extra PII beyond the
 * identifying email itself. */
export type PeoplyDirectoryCacheEntry = {
  readonly emailHash: string;
  readonly email: string;
  /** false means Peoply confirmed this email has no directory entry (mirrors a live not_found). */
  readonly found: boolean;
  readonly employeeId: string | null;
  readonly employeeStatus: string | null;
  readonly primaryOrgId: string | null;
  readonly organizationName: string | null;
  readonly organizationPath: string | null;
  /** Self-then-ancestors, Peoply-authoritative parentId chain — lets org-hierarchy routing walk
   * without further live calls. Empty when found is false or no primary org exists. */
  readonly orgAncestry: readonly PeoplyOrgAncestryLink[];
  readonly syncedAtIso: string;
  readonly source: PeoplyDirectoryCacheSource;
};

export type PeoplyDirectoryCacheMeta = {
  readonly lastSyncStatus: "success" | "partial" | "failed" | null;
  readonly lastSyncAtIso: string | null;
  readonly lastSyncAttemptAtIso: string | null;
  readonly totalCandidates: number;
  readonly successCount: number;
  readonly notFoundCount: number;
  readonly errorCount: number;
  readonly lastError: string | null;
};

export type PeoplyDirectorySyncResult = {
  readonly status: "success" | "partial" | "failed";
  readonly source: PeoplyDirectoryCacheSource;
  readonly totalCandidates: number;
  readonly successCount: number;
  readonly notFoundCount: number;
  readonly errorCount: number;
  readonly circuitBroken: boolean;
};

// ---------- minimal Firestore seam (same pattern as functions/mailAccounts.ts / functions/goldenSet.ts) ----------

type FirestoreDocSnapshot = {
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
};
type FirestoreDocRef = {
  get(): Promise<FirestoreDocSnapshot>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
};
type FirestoreCollectionRef = {
  doc(id: string): FirestoreDocRef;
  get(): Promise<{ docs: readonly (FirestoreDocSnapshot & { id: string })[] }>;
};
type FirestoreBatchLike = {
  set(ref: FirestoreDocRef, data: Record<string, unknown>, options?: { merge?: boolean }): void;
  commit(): Promise<unknown>;
};
/** Base seam used by the cache read/write helpers — deliberately WITHOUT `batch()` so the exact
 * same minimal db fake `mailAccounts.ts`/`admin.ts` tests already inject (which never implement
 * batch) is structurally compatible with `deps.db` here. Only `runPeoplyDirectorySync` needs the
 * batch-capable extension below. */
export type PeoplyDirectoryCacheDb = {
  collection(name: string): FirestoreCollectionRef & { doc(id: string): FirestoreDocRef };
};
export type PeoplyDirectorySyncDb = PeoplyDirectoryCacheDb & {
  batch(): FirestoreBatchLike;
};

export type PeoplyDirectoryCacheDeps = {
  readonly db?: PeoplyDirectoryCacheDb;
  readonly peoplyClient?: PeoplyClient;
  readonly now?: () => number;
};

export type PeoplyDirectorySyncDeps = Omit<PeoplyDirectoryCacheDeps, "db"> & {
  readonly db?: PeoplyDirectorySyncDb;
};

function resolveDb(deps: PeoplyDirectoryCacheDeps): PeoplyDirectoryCacheDb {
  return deps.db ?? (adminDb as unknown as PeoplyDirectoryCacheDb);
}

function resolveSyncDb(deps: PeoplyDirectorySyncDeps): PeoplyDirectorySyncDb {
  return deps.db ?? (adminDb as unknown as PeoplyDirectorySyncDb);
}

function resolveClient(deps: PeoplyDirectoryCacheDeps): PeoplyClient {
  return deps.peoplyClient ?? getPeoplyClient();
}

function nowIso(deps: PeoplyDirectoryCacheDeps): string {
  return new Date((deps.now ?? (() => Date.now()))()).toISOString();
}

/** sha256 hex of the normalized (trim+lowercase) email — never stores the raw email as a doc id. */
export function hashPeoplyDirectoryEmail(email: string): string {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizeCacheEntry(raw: Record<string, unknown> | undefined): PeoplyDirectoryCacheEntry | null {
  if (!raw) return null;
  const orgAncestryRaw = Array.isArray(raw.orgAncestry) ? raw.orgAncestry : [];
  return {
    emailHash: typeof raw.emailHash === "string" ? raw.emailHash : "",
    email: typeof raw.email === "string" ? raw.email : "",
    found: raw.found === true,
    employeeId: typeof raw.employeeId === "string" ? raw.employeeId : null,
    employeeStatus: typeof raw.employeeStatus === "string" ? raw.employeeStatus : null,
    primaryOrgId: typeof raw.primaryOrgId === "string" ? raw.primaryOrgId : null,
    organizationName: typeof raw.organizationName === "string" ? raw.organizationName : null,
    organizationPath: typeof raw.organizationPath === "string" ? raw.organizationPath : null,
    orgAncestry: orgAncestryRaw
      .filter((link): link is Record<string, unknown> => Boolean(link) && typeof link === "object")
      .map((link) => ({
        orgId: typeof link.orgId === "string" ? link.orgId : "",
        name: typeof link.name === "string" ? link.name : "",
        parentId: typeof link.parentId === "string" ? link.parentId : null,
      })),
    syncedAtIso: typeof raw.syncedAtIso === "string" ? raw.syncedAtIso : "",
    source: raw.source === "scheduled-sync" || raw.source === "manual-refresh" || raw.source === "live-fallback"
      ? raw.source
      : "live-fallback",
  };
}

export async function readPeoplyDirectoryCacheEntry(
  email: string,
  deps: PeoplyDirectoryCacheDeps = {},
): Promise<PeoplyDirectoryCacheEntry | null> {
  const emailHash = hashPeoplyDirectoryEmail(email);
  if (!emailHash) return null;
  const snapshot = await resolveDb(deps).collection(PEOPLY_DIRECTORY_CACHE_COLLECTION).doc(emailHash).get();
  if (!snapshot.exists) return null;
  return normalizeCacheEntry(snapshot.data());
}

export async function writePeoplyDirectoryCacheEntry(
  entry: Omit<PeoplyDirectoryCacheEntry, "emailHash" | "syncedAtIso"> & { syncedAtIso?: string },
  deps: PeoplyDirectoryCacheDeps = {},
): Promise<void> {
  const normalizedEmail = entry.email.trim().toLowerCase();
  const emailHash = hashPeoplyDirectoryEmail(normalizedEmail);
  if (!emailHash) return;
  const record: PeoplyDirectoryCacheEntry = {
    ...entry,
    email: normalizedEmail,
    emailHash,
    syncedAtIso: entry.syncedAtIso ?? nowIso(deps),
  };
  await resolveDb(deps).collection(PEOPLY_DIRECTORY_CACHE_COLLECTION).doc(emailHash).set({ ...record });
}

/** Reconstructs the `PeoplyPersonDetail` shape existing call sites (admin.ts/mailAccounts.ts)
 * already know how to read. Only meaningful for a `found: true` entry. */
export function directoryCacheEntryToPersonDetail(entry: PeoplyDirectoryCacheEntry): PeoplyPersonDetail {
  return {
    directoryUpdatedAt: entry.syncedAtIso || null,
    employee: {
      id: entry.employeeId ?? "",
      email: entry.email,
      displayName: "",
      nickname: "",
      koreanName: "",
      department: "",
      title: "",
      jobName: "",
      status: entry.employeeStatus ?? "",
      primaryMembership: entry.primaryOrgId ?? "",
      slackUserId: null,
    },
    memberships: entry.primaryOrgId
      ? [{
        orgId: entry.primaryOrgId,
        organizationName: entry.organizationName ?? "",
        organizationPath: entry.organizationPath ?? "",
        title: "",
        role: "",
        source: "peoply-directory-cache",
        purpose: "primary",
        primary: true,
        managerEmail: null,
      }]
      : [],
  };
}

/** The result of climbing an org's parentId chain. `complete: false` only when an ancestor lookup
 * actually THREW partway through the climb — the chain returned is then a PREFIX, not the full
 * picture, and callers must never cache/count it as if it were authoritative (Codex round-1
 * review finding #3: a swallowed failure used to write a shortened chain and count as success).
 * Reaching the root, a cycle, the depth bound, or a client that structurally cannot look up
 * organizations at all (no live capability, e.g. a minimal test double or the emulator fixture) is
 * a complete, authoritative answer — there is nothing more to learn, that is not a "failure". */
type OrgAncestryBuildResult = {
  readonly chain: PeoplyOrgAncestryLink[];
  readonly complete: boolean;
};

/** Self-then-ancestors chain, following only Peoply's authoritative parentId — same bound/shape
 * `resolveConfiguredMailAccountForOrgHierarchy` (mailAccounts.ts) computes live. */
async function buildOrgAncestryChain(
  primaryOrgId: string | null,
  client: PeoplyClient,
): Promise<OrgAncestryBuildResult> {
  if (!primaryOrgId) return { chain: [], complete: true };
  const chain: PeoplyOrgAncestryLink[] = [];
  const visited = new Set<string>();
  let currentOrgId: string | null = primaryOrgId;
  for (let depth = 0; currentOrgId && depth < ORG_ANCESTRY_MAX_DEPTH; depth += 1) {
    if (visited.has(currentOrgId)) return { chain, complete: true };
    visited.add(currentOrgId);
    // The org itself always belongs in the chain (resolveConfiguredMailAccountForOrgHierarchy's
    // original live walk checks routing.byOrgId[currentOrgId] BEFORE ever calling
    // getOrganization) — only the PARENT walk depends on getOrganization succeeding/existing.
    if (typeof client.getOrganization !== "function") {
      chain.push({ orgId: currentOrgId, name: "", parentId: null });
      return { chain, complete: true };
    }
    let organization: Awaited<ReturnType<PeoplyClient["getOrganization"]>>;
    try {
      organization = await client.getOrganization(currentOrgId, { membershipView: "official" });
    } catch {
      // A genuine failure mid-climb: the chain so far is a PREFIX, not the full ancestry.
      chain.push({ orgId: currentOrgId, name: "", parentId: null });
      return { chain, complete: false };
    }
    const parentId = typeof organization.parentId === "string" && organization.parentId.trim() ? organization.parentId.trim() : null;
    chain.push({ orgId: currentOrgId, name: organization.name ?? "", parentId });
    currentOrgId = parentId;
  }
  return { chain, complete: true };
}

type ResolvedPeoplyProjection = {
  readonly detail: PeoplyPersonDetail;
  readonly primaryMembership: PeoplyMembership | null;
  readonly orgAncestry: PeoplyOrgAncestryLink[];
  /** false when the ancestor climb above failed partway — see OrgAncestryBuildResult. */
  readonly ancestryComplete: boolean;
};

/** getPerson + (if mapped) the full ancestor climb, in one place — both the sync job and the
 * live-fallback path need identical data so a cache hit and a live lookup for the same org agree
 * (Codex round-1 review finding #2: write-through used to store only the self org, silently
 * dropping ancestor-inherited mailbox routes on the very next cache hit). */
async function resolveLivePeoplyProjection(
  email: string,
  client: PeoplyClient,
  membershipView: PeoplyMembershipView,
): Promise<ResolvedPeoplyProjection> {
  const detail = await client.getPerson(email, { membershipView });
  const primaryMembership = verifiedPeoplyPrimaryMembershipForEmail(detail, email);
  if (!primaryMembership) return { detail, primaryMembership: null, orgAncestry: [], ancestryComplete: true };
  const { chain, complete } = await buildOrgAncestryChain(primaryMembership.orgId, client);
  return { detail, primaryMembership, orgAncestry: chain, ancestryComplete: complete };
}

export type CachedOrLivePeoplyPersonResult = {
  readonly detail: PeoplyPersonDetail;
  /** Self-then-ancestors chain. `undefined` when this call did not produce (or trust) a complete
   * chain — callers must pass `undefined` straight through to resolveConfiguredMailAccountForOrgHierarchy,
   * which then does its own full live walk for this one request rather than silently treating
   * "unknown" as "no ancestors". */
  readonly orgAncestry: readonly PeoplyOrgAncestryLink[] | undefined;
  readonly cacheState: "hit" | "live-fallback";
  /** The time this projection was last actually verified against Peoply — the cache row's own
   * `syncedAtIso` on a hit, or "now" on a live fallback. Callers must stamp their own "last synced"
   * bookkeeping (e.g. members/{uid}.peoplySyncedAtIso) with THIS value, never with "now" on a cache
   * hit (Codex round-1 review finding #1) — otherwise a merely-served stale row looks freshly
   * verified. */
  readonly syncedAtIso: string;
};

/** Live lookup + full ancestry climb, then (only if the ancestry is actually complete) write the
 * result through to the persistent cache. Shared by a genuine cache miss and a stale-cache-row
 * refresh (see getCachedOrLivePeoplyPerson) so both go through identical logic. */
async function liveFallbackAndCache(
  normalizedEmail: string,
  options: { membershipView?: PeoplyMembershipView },
  deps: PeoplyDirectoryCacheDeps,
): Promise<CachedOrLivePeoplyPersonResult> {
  const client = resolveClient(deps);
  const projection = await resolveLivePeoplyProjection(normalizedEmail, client, options.membershipView ?? "official");
  const syncedAtIso = nowIso(deps);
  if (!projection.ancestryComplete) {
    // Never cache a partial chain over a possibly-complete prior row (round-1 finding #3) — this
    // request still gets a correct answer via the live-walk fallback (orgAncestry: undefined).
    console.error(`[peoply-directory-cache] ancestor lookup incomplete during live fallback (emailHash=${hashPeoplyDirectoryEmail(normalizedEmail)}) — not caching this result`);
    return { detail: projection.detail, orgAncestry: undefined, cacheState: "live-fallback", syncedAtIso };
  }
  // Write-through is best-effort: a cache-write failure must never fail a request that already
  // has a good live answer.
  try {
    await writePeoplyDirectoryCacheEntry({
      email: normalizedEmail,
      found: true,
      employeeId: projection.detail.employee.id || null,
      employeeStatus: projection.detail.employee.status || null,
      primaryOrgId: projection.primaryMembership?.orgId ?? null,
      organizationName: projection.primaryMembership?.organizationName ?? null,
      organizationPath: projection.primaryMembership?.organizationPath ?? null,
      orgAncestry: projection.orgAncestry,
      source: "live-fallback",
      syncedAtIso,
    }, deps);
  } catch (writeError) {
    console.error("[peoply-directory-cache] write-through after live fallback failed", writeError);
  }
  return { detail: projection.detail, orgAncestry: projection.orgAncestry, cacheState: "live-fallback", syncedAtIso };
}

/**
 * The single call site every org-resolution request path should use instead of
 * `getPeoplyClient().getPerson(...)` directly. A FRESH cache hit (age <=
 * PEOPLY_DIRECTORY_CACHE_STALE_TOLERANCE_MS) never touches the network. A row older than that
 * tolerance is NOT trusted for granting org membership/mailbox entitlement (Codex round-1 review
 * finding #1 — a removed or moved user could otherwise keep old access indefinitely): it is
 * refreshed live instead, and a transient failure there throws straight through to the caller's
 * EXISTING fail-closed path (e.g. admin.ts's allowPersistedRoleFallback, mailAccounts.ts's
 * "directory_unavailable") rather than silently reusing the stale row. A genuine cache miss also
 * falls back to a live lookup and write-throughs the result — the ONLY place a genuinely uncached
 * user still depends on Peoply being reachable, matching design point 4 (existing fail-closed
 * behavior for users missing from the directory entirely).
 */
export async function getCachedOrLivePeoplyPerson(
  email: string,
  options: { membershipView?: PeoplyMembershipView } = {},
  deps: PeoplyDirectoryCacheDeps = {},
): Promise<CachedOrLivePeoplyPersonResult> {
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const cached = await readPeoplyDirectoryCacheEntry(normalizedEmail, deps);
  if (cached) {
    const now = deps.now ? deps.now() : Date.now();
    const ageMs = Date.parse(cached.syncedAtIso);
    const isStale = !Number.isFinite(ageMs) || now - ageMs > PEOPLY_DIRECTORY_CACHE_STALE_TOLERANCE_MS;
    if (!isStale) {
      if (!cached.found) {
        throw new PeoplyClientError("not_found", "Cached Peoply directory snapshot has no entry for this email.");
      }
      return {
        detail: directoryCacheEntryToPersonDetail(cached),
        orgAncestry: cached.orgAncestry,
        cacheState: "hit",
        syncedAtIso: cached.syncedAtIso,
      };
    }
    console.warn(`[peoply-directory-cache] cache row past the ${PEOPLY_DIRECTORY_CACHE_STALE_TOLERANCE_MS}ms staleness tolerance (emailHash=${cached.emailHash}) — refreshing live instead of granting from it`);
  }
  return liveFallbackAndCache(normalizedEmail, options, deps);
}

export async function readPeoplyDirectoryCacheMeta(deps: PeoplyDirectoryCacheDeps = {}): Promise<PeoplyDirectoryCacheMeta | null> {
  const snapshot = await resolveDb(deps).collection(PEOPLY_DIRECTORY_CACHE_META_COLLECTION).doc(PEOPLY_DIRECTORY_CACHE_META_DOC_ID).get();
  if (!snapshot.exists) return null;
  const raw = snapshot.data() ?? {};
  return {
    lastSyncStatus: raw.lastSyncStatus === "success" || raw.lastSyncStatus === "partial" || raw.lastSyncStatus === "failed" ? raw.lastSyncStatus : null,
    lastSyncAtIso: typeof raw.lastSyncAtIso === "string" ? raw.lastSyncAtIso : null,
    lastSyncAttemptAtIso: typeof raw.lastSyncAttemptAtIso === "string" ? raw.lastSyncAttemptAtIso : null,
    totalCandidates: typeof raw.totalCandidates === "number" ? raw.totalCandidates : 0,
    successCount: typeof raw.successCount === "number" ? raw.successCount : 0,
    notFoundCount: typeof raw.notFoundCount === "number" ? raw.notFoundCount : 0,
    errorCount: typeof raw.errorCount === "number" ? raw.errorCount : 0,
    lastError: typeof raw.lastError === "string" ? raw.lastError : null,
  };
}

function shortErrorReason(error: unknown): string {
  if (error instanceof PeoplyClientError) return `${error.kind}${error.upstreamCode ? `:${error.upstreamCode}` : ""}`;
  if (error instanceof Error) return error.name || "error";
  return "unknown_error";
}

/**
 * The nightly (and manual-refresh) sweep: for every email this app already knows about
 * (`members/{uid}.email`), resolve its Peoply primary org and ancestry, and upsert one cache row.
 * A per-user failure is skipped (its existing cache row, if any, is left untouched — "never delete
 * entries on a partial/failed pull"); nothing is EVER deleted here. If Peoply itself looks down
 * (a run of consecutive transient failures), the sweep stops early rather than paying a timeout
 * per remaining member. The meta doc's `lastSyncAtIso` only advances when at least one row
 * actually synced — a fully failed run keeps yesterday's snapshot as the last-known-good state.
 */
export async function runPeoplyDirectorySync(
  options: { source?: PeoplyDirectoryCacheSource } = {},
  deps: PeoplyDirectorySyncDeps = {},
): Promise<PeoplyDirectorySyncResult> {
  const source = options.source ?? "scheduled-sync";
  const db = resolveSyncDb(deps);
  const client = resolveClient(deps);
  const timestamp = nowIso(deps);

  const membersSnapshot = await db.collection("members").get();
  const emails = new Set<string>();
  for (const doc of membersSnapshot.docs) {
    const data = doc.data();
    const email = typeof data?.email === "string" ? data.email.trim().toLowerCase() : "";
    if (email.includes("@")) emails.add(email);
  }

  let successCount = 0;
  let notFoundCount = 0;
  let errorCount = 0;
  let consecutiveTransientFailures = 0;
  let circuitBroken = false;
  let batch = db.batch();
  let opsInBatch = 0;
  const BATCH_LIMIT = 400;

  const flush = async () => {
    if (opsInBatch === 0) return;
    await batch.commit();
    batch = db.batch();
    opsInBatch = 0;
  };

  for (const email of emails) {
    if (circuitBroken) break;
    try {
      const projection = await resolveLivePeoplyProjection(email, client, "official");
      if (!projection.ancestryComplete) {
        // A prefix chain is not the full picture (round-1 finding #3): treat exactly like any
        // other per-user failure below — never write over a possibly-complete prior row, and let
        // the shared kind-based classification decide whether this counts toward the circuit
        // breaker (an ancestor lookup is itself a live Peoply call, so "upstream" is accurate).
        throw new PeoplyClientError("upstream", "ancestor org lookup did not complete during sync");
      }
      const entry: PeoplyDirectoryCacheEntry = {
        emailHash: hashPeoplyDirectoryEmail(email),
        email,
        found: true,
        employeeId: projection.detail.employee.id || null,
        employeeStatus: projection.detail.employee.status || null,
        primaryOrgId: projection.primaryMembership?.orgId ?? null,
        organizationName: projection.primaryMembership?.organizationName ?? null,
        organizationPath: projection.primaryMembership?.organizationPath ?? null,
        orgAncestry: projection.orgAncestry,
        syncedAtIso: timestamp,
        source,
      };
      batch.set(db.collection(PEOPLY_DIRECTORY_CACHE_COLLECTION).doc(entry.emailHash), { ...entry });
      opsInBatch += 1;
      successCount += 1;
      consecutiveTransientFailures = 0;
    } catch (error) {
      if (error instanceof PeoplyClientError && error.kind === "not_found") {
        const entry: PeoplyDirectoryCacheEntry = {
          emailHash: hashPeoplyDirectoryEmail(email),
          email,
          found: false,
          employeeId: null,
          employeeStatus: null,
          primaryOrgId: null,
          organizationName: null,
          organizationPath: null,
          orgAncestry: [],
          syncedAtIso: timestamp,
          source,
        };
        batch.set(db.collection(PEOPLY_DIRECTORY_CACHE_COLLECTION).doc(entry.emailHash), { ...entry });
        opsInBatch += 1;
        notFoundCount += 1;
        consecutiveTransientFailures = 0;
      } else {
        errorCount += 1;
        // Never write anything for this email — its previous cache row (if any) is untouched.
        const kind = error instanceof PeoplyClientError ? error.kind : "network";
        if (TRANSIENT_PEOPLY_ERROR_KINDS.has(kind)) {
          consecutiveTransientFailures += 1;
          if (consecutiveTransientFailures >= SYNC_CIRCUIT_BREAKER_THRESHOLD) {
            circuitBroken = true;
            console.error(`[peoply-directory-cache] sync circuit-broken after ${consecutiveTransientFailures} consecutive transient failures (last: ${shortErrorReason(error)})`);
          }
        }
      }
    }
    if (opsInBatch >= BATCH_LIMIT) await flush();
  }
  await flush();

  const status: PeoplyDirectorySyncResult["status"] = errorCount === 0 && !circuitBroken
    ? "success"
    : successCount + notFoundCount > 0
      ? "partial"
      : "failed";

  const metaRef = db.collection(PEOPLY_DIRECTORY_CACHE_META_COLLECTION).doc(PEOPLY_DIRECTORY_CACHE_META_DOC_ID);
  if (status === "failed") {
    // Total failure: leave lastSyncStatus/lastSyncAtIso (the last-known-good sync) untouched,
    // only record that an attempt was made and why.
    await metaRef.set({
      lastSyncAttemptAtIso: timestamp,
      lastAttemptStatus: status,
      lastError: `no rows synced (${emails.size} candidates, circuitBroken=${circuitBroken})`,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } else {
    await metaRef.set({
      lastSyncStatus: status,
      lastSyncAtIso: timestamp,
      lastSyncAttemptAtIso: timestamp,
      totalCandidates: emails.size,
      successCount,
      notFoundCount,
      errorCount,
      lastError: errorCount > 0 ? `${errorCount} lookup(s) failed (circuitBroken=${circuitBroken})` : null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  return { status, source, totalCandidates: emails.size, successCount, notFoundCount, errorCount, circuitBroken };
}
