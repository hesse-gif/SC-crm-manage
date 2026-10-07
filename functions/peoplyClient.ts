/**
 * Peoply Developer API — server-side read client.
 *
 * Contract integrated: semantic API version 0.15.0 (published 2026-09-10),
 * runtime contract revision 2026-09-10.api-operations-v1.
 * Re-read https://ai-peoply.web.app/docs/api/changelog.md and bump
 * PEOPLY_INTEGRATED_API_VERSION when the integration surface changes.
 *
 * Security posture (NET-P0-012 / SEC-P0-009):
 * - Runs only inside Cloud Functions. The key is read from process.env.PEOPLY_API_KEY
 *   (Secret Manager binding in deployed runtimes, functions/.secret.local in the emulator).
 * - The key is never placed in URLs, logs, or responses.
 * - Raw upstream payloads are never logged; responses are projected to a fixed
 *   privacy-safe field set before leaving this module.
 * - Only endpoints covered by the key's approved scopes are implemented:
 *   directory-basic:read, people:read, orgs:read, tfs:read, workspace-groups:read.
 */

export const PEOPLY_INTEGRATED_API_VERSION = "0.15.0" as const;
export const PEOPLY_RUNTIME_CONTRACT_REVISION = "2026-09-10.api-operations-v1" as const;
export const PEOPLY_CANONICAL_BASE_URL = "https://ai-peoply.web.app" as const;
export const PEOPLY_API_KEY_HEADER = "X-Peoply-API-Key" as const;

/** Directory snapshots have no fixed scheduler; keep the cache short and carry the source timestamp. */
export const PEOPLY_DIRECTORY_CACHE_TTL_MS = 5 * 60 * 1000;
export const PEOPLY_STATUS_CACHE_TTL_MS = 60 * 1000;
/** A 429 is retried once only when the upstream Retry-After fits inside a callable budget. */
export const PEOPLY_MAX_INLINE_RETRY_AFTER_SECONDS = 5;
// 2026-09-11 hotfix (prod latency incident, 0.6.71): was 8_000. Every resolveMailAccountForEmail
// call (mailAccounts.ts) and every direct getOrganization/getPerson call (mailAccountCallables.ts
// getMyOrgContext, candidateTable.ts listCandidates) blocks its callable's response on this
// single fetch, sequentially, with no circuit breaker. Prod logs show listCandidates paying a
// ~8.7s tax (matching this constant) before even reaching YouTube quota resolution. 3s keeps a
// generous margin over the endpoint's normal sub-2s response time while capping the worst case.
export const PEOPLY_REQUEST_TIMEOUT_MS = 3_000;
/**
 * Hard ceiling on time spent inside fetchJson (first request + inline 429 retry + its own
 * request timeout), kept comfortably under the callable's timeoutSeconds: 20 (functions/index.ts)
 * so a retry can never itself cause the callable to hit its deadline.
 */
export const PEOPLY_TOTAL_BUDGET_MS = 18_000;
/**
 * 2026-09-11 hotfix (prod latency incident, 0.6.71): how long a FAILED upstream call (timeout,
 * network error, rate limit, any non-2xx) is cached for — same cache/in-flight-dedupe machinery
 * as a success (see `cached` below), just a much shorter TTL. Before this, only successes were
 * cached: every caller during a Peoply slowdown/outage re-paid the full
 * PEOPLY_REQUEST_TIMEOUT_MS on every single call, including repeat calls for the SAME key
 * seconds apart. Deliberately shorter than the success TTLs above so a transient failure
 * recovers quickly once Peoply is healthy again.
 */
export const PEOPLY_NEGATIVE_CACHE_TTL_MS = 60 * 1000;

export type PeoplyErrorKind =
  | "missing_key"
  | "invalid_base_url"
  | "forbidden"
  | "rate_limited"
  | "not_found"
  | "invalid_request"
  | "upstream"
  | "network";

export class PeoplyClientError extends Error {
  readonly kind: PeoplyErrorKind;
  readonly httpStatus: number | null;
  readonly retryAfterSeconds: number | null;
  readonly upstreamCode: string | null;

  constructor(
    kind: PeoplyErrorKind,
    message: string,
    options: { httpStatus?: number | null; retryAfterSeconds?: number | null; upstreamCode?: string | null } = {},
  ) {
    super(message);
    this.name = "PeoplyClientError";
    this.kind = kind;
    this.httpStatus = options.httpStatus ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.upstreamCode = options.upstreamCode ?? null;
  }
}

export type PeoplyEnvSource = {
  PEOPLY_API_KEY?: string;
  PEOPLY_BASE_URL?: string;
};

export type PeoplyFetch = (input: string, init: { method: "GET"; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export type PeoplyClientDeps = {
  env?: PeoplyEnvSource;
  fetch?: PeoplyFetch;
  now?: () => number;
};

// ---------- projected (privacy-safe) shapes ----------

export type PeoplyKeyStatus = {
  status: string;
  appName: string;
  scopes: string[];
  accessMode: string;
  expiresAt: string | null;
  daysRemaining: number | null;
  rateLimitPerMinute: number | null;
  rateLimitPerDay: number | null;
  quota: {
    minute: PeoplyQuotaBucket;
    day: PeoplyQuotaBucket;
  };
  scopeRequest: PeoplyScopeRequest | null;
  rateLimitRequest: PeoplyRateLimitRequest | null;
};

/** Safe UTC quota window fields returned by GET /api/api-key/status. */
export type PeoplyQuotaBucket = {
  limit: number | null;
  used: number | null;
  remaining: number | null;
  resetsAt: string | null;
};

/** Safe projection of the owner's latest scope-expansion request. */
export type PeoplyScopeRequest = {
  status: string;
  createdAt: string | null;
  reviewedAt: string | null;
  additionalScopes: string[];
};

/** Safe projection of the owner's latest rate-limit request. */
export type PeoplyRateLimitRequest = {
  status: string;
  createdAt: string | null;
  reviewedAt: string | null;
  rateLimitPerMinute: number | null;
  rateLimitPerDay: number | null;
};

export type PeoplyPerson = {
  id: string;
  email: string;
  displayName: string;
  nickname: string;
  koreanName: string;
  department: string;
  title: string;
  jobName: string;
  status: string;
  /** Normalized primary org id; detail lookups derive it from memberships[].primary. */
  primaryMembership: string;
  slackUserId: string | null;
};

export type PeoplyMembership = {
  orgId: string;
  organizationName: string;
  /** Peoply 0.15 returns the display path as one string. */
  organizationPath: string;
  title: string;
  role: string;
  source: string;
  purpose: string;
  primary: boolean;
  managerEmail: string | null;
};

export type PeoplyPersonDetail = {
  directoryUpdatedAt: string | null;
  employee: PeoplyPerson;
  memberships: PeoplyMembership[];
};

export type PeoplyOrgLeader = {
  email: string;
  displayName: string;
  leaderLevel: string;
  leaderLevelLabel: string;
};

export type PeoplyOrganization = {
  id: string;
  hrOrgCode: string | null;
  name: string;
  parentId: string | null;
  active: boolean;
  type: string;
  source: string;
  organizationLevel: string;
  organizationLevelLabel: string;
  leaders: PeoplyOrgLeader[];
};

export type PeoplyOrganizationDetail = PeoplyOrganization & {
  directoryUpdatedAt: string | null;
  /** Peoply 0.15 returns the display path as one string. */
  path: string;
  members: PeoplyPerson[];
};

export type PeoplyWorkspaceGroup = {
  email: string;
  name: string;
  description: string;
  directMemberCount: number;
};

export type PeoplyWorkspaceGroupDetail = PeoplyWorkspaceGroup & {
  members: Array<{ email: string; role: string; type: string }>;
};

export type PeoplySnapshot<T> = {
  directoryUpdatedAt: string | null;
  fetchedAtIso: string;
  cacheHit: boolean;
  items: T[];
};

export type PeoplyMembershipView = "effective" | "official";

/**
 * The accepted active employee statuses are shared with authenticated signup/bootstrap. Keep this
 * set in the client layer so strict mailbox entitlement cannot drift from the login boundary.
 */
export const PEOPLY_ACTIVE_EMPLOYEE_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "current",
  "employed",
  "enabled",
  "member",
  "재직",
  "재직중",
]);

export function isPeoplyEmployeeActive(status: unknown): boolean {
  const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
  return PEOPLY_ACTIVE_EMPLOYEE_STATUSES.has(normalized);
}

/**
 * Returns the verified official primary membership for an expected Auth email. A person response
 * is usable for org routing only when the returned email matches, the employee is active, and a
 * primary membership row exists whose org id agrees with employee.primaryMembership. Empty or
 * malformed fields fail closed; callers must preserve their own personal account separately.
 */
export function verifiedPeoplyPrimaryMembershipForEmail(
  detail: PeoplyPersonDetail | null | undefined,
  expectedEmail: string,
): PeoplyMembership | null {
  const normalizedExpectedEmail = typeof expectedEmail === "string" ? expectedEmail.trim().toLowerCase() : "";
  const returnedEmail = typeof detail?.employee?.email === "string"
    ? detail.employee.email.trim().toLowerCase()
    : "";
  if (!normalizedExpectedEmail || returnedEmail !== normalizedExpectedEmail) return null;
  if (!isPeoplyEmployeeActive(detail?.employee?.status)) return null;

  const primaryOrgId = typeof detail?.employee?.primaryMembership === "string"
    ? detail.employee.primaryMembership.trim()
    : "";
  if (!primaryOrgId) return null;

  const memberships = Array.isArray(detail?.memberships) ? detail.memberships : [];
  return memberships.find((membership) => (
    membership
      && membership.primary === true
      && typeof membership.orgId === "string"
      && membership.orgId.trim() === primaryOrgId
  )) ?? null;
}

// ---------- helpers ----------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function projectPeoplyQuotaBucket(raw: unknown): PeoplyQuotaBucket {
  const r = asRecord(raw);
  return {
    limit: asNumberOrNull(r.limit),
    used: asNumberOrNull(r.used),
    remaining: asNumberOrNull(r.remaining),
    resetsAt: asNullableString(r.resetsAt),
  };
}

function projectPeoplyScopeRequest(raw: unknown): PeoplyScopeRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = asRecord(raw);
  return {
    status: asString(r.status),
    createdAt: asNullableString(r.createdAt),
    reviewedAt: asNullableString(r.reviewedAt),
    additionalScopes: asArray(r.additionalScopes).filter((scope): scope is string => typeof scope === "string"),
  };
}

function projectPeoplyRateLimitRequest(raw: unknown): PeoplyRateLimitRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = asRecord(raw);
  return {
    status: asString(r.status),
    createdAt: asNullableString(r.createdAt),
    reviewedAt: asNullableString(r.reviewedAt),
    rateLimitPerMinute: asNumberOrNull(r.rateLimitPerMinute),
    rateLimitPerDay: asNumberOrNull(r.rateLimitPerDay),
  };
}

export function resolvePeoplyBaseUrl(env: PeoplyEnvSource): string {
  const configured = env.PEOPLY_BASE_URL?.trim();
  if (!configured) return PEOPLY_CANONICAL_BASE_URL;
  // Older copied fh-*.a.run.app URLs are explicitly rejected by the Peoply contract.
  if (configured.replace(/\/+$/, "") !== PEOPLY_CANONICAL_BASE_URL) {
    throw new PeoplyClientError(
      "invalid_base_url",
      `PEOPLY_BASE_URL must be exactly ${PEOPLY_CANONICAL_BASE_URL}.`,
    );
  }
  return PEOPLY_CANONICAL_BASE_URL;
}

export function peoplyKeyConfigured(env: PeoplyEnvSource = process.env): boolean {
  return (env.PEOPLY_API_KEY ?? "").trim().length > 0;
}

function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - nowMs) / 1000));
  return null;
}

/** Only the short upstream error code survives; bodies are never logged or surfaced. */
async function readUpstreamCode(response: { json(): Promise<unknown>; text(): Promise<string> }): Promise<string | null> {
  try {
    const body = asRecord(await response.json());
    const code = body.error ?? body.code ?? body.reasonCode;
    return typeof code === "string" ? code.slice(0, 160) : null;
  } catch {
    return null;
  }
}

function sanitizeQuery(value: string): string {
  return value.trim().slice(0, 120);
}

// ---------- projections ----------

export function projectPeoplyKeyStatus(raw: unknown): PeoplyKeyStatus {
  const r = asRecord(raw);
  // The upstream status body may echo key/secret metadata; none of it is projected.
  return {
    status: asString(r.status, "unknown"),
    appName: asString(r.appName),
    scopes: asArray(r.scopes).filter((s): s is string => typeof s === "string"),
    accessMode: asString(r.accessMode),
    expiresAt: asNullableString(r.accessExpiresAt) ?? asNullableString(r.expiresAt),
    daysRemaining: asNumberOrNull(r.daysRemaining),
    rateLimitPerMinute: asNumberOrNull(r.rateLimitPerMinute),
    rateLimitPerDay: asNumberOrNull(r.rateLimitPerDay),
    quota: {
      minute: projectPeoplyQuotaBucket(asRecord(r.quota).minute),
      day: projectPeoplyQuotaBucket(asRecord(r.quota).day),
    },
    scopeRequest: projectPeoplyScopeRequest(r.scopeRequest),
    rateLimitRequest: projectPeoplyRateLimitRequest(r.rateLimitRequest),
  };
}

export function projectPeoplyPerson(raw: unknown): PeoplyPerson {
  const r = asRecord(raw);
  // Deliberately dropped: phone, employeeNumber, hireDate, terminationDate, avatar.
  return {
    id: asString(r.id),
    email: asString(r.email).toLowerCase(),
    displayName: asString(r.displayName),
    nickname: asString(r.nickname),
    koreanName: asString(r.koreanName),
    department: asString(r.department),
    title: asString(r.title),
    jobName: asString(r.jobName),
    status: asString(r.status),
    primaryMembership: typeof r.primaryMembership === "string" ? r.primaryMembership : asString(asRecord(r.primaryMembership).orgId),
    slackUserId: asNullableString(r.slackUserId),
  };
}

export function projectPeoplyMembership(raw: unknown): PeoplyMembership {
  const r = asRecord(raw);
  const organization = asRecord(r.organization);
  return {
    orgId: asString(r.orgId),
    organizationName: asString(organization.name),
    // The 0.15 contract is a display string, not the pre-0.15 node array.
    // Keep the string intact so callers can render the upstream hierarchy without data loss.
    organizationPath: asString(r.organizationPath),
    title: asString(r.title),
    role: asString(r.role),
    source: asString(r.source),
    purpose: asString(r.purpose),
    primary: r.primary === true,
    managerEmail: asNullableString(r.managerEmail),
  };
}

function projectLeader(raw: unknown): PeoplyOrgLeader {
  const r = asRecord(raw);
  const employee = asRecord(r.employee);
  return {
    email: asString(employee.email).toLowerCase(),
    displayName: asString(employee.displayName),
    leaderLevel: asString(r.leaderLevel),
    leaderLevelLabel: asString(r.leaderLevelLabel),
  };
}

export function projectPeoplyOrganization(raw: unknown): PeoplyOrganization {
  const r = asRecord(raw);
  return {
    id: asString(r.id),
    hrOrgCode: asNullableString(r.hrOrgCode),
    name: asString(r.name),
    parentId: asNullableString(r.parentId),
    active: r.active !== false,
    type: asString(r.type),
    source: asString(r.source),
    organizationLevel: asString(r.organizationLevel),
    organizationLevelLabel: asString(r.organizationLevelLabel),
    leaders: asArray(r.leaders).map(projectLeader),
  };
}

export function projectPeoplyOrganizationDetail(raw: unknown): PeoplyOrganizationDetail {
  const r = asRecord(raw);
  return {
    ...projectPeoplyOrganization(r),
    directoryUpdatedAt: asNullableString(r.directoryUpdatedAt),
    // The 0.15 contract is a display string; do not coerce it through asArray(),
    // which would silently turn a valid path into [].
    path: asString(r.path),
    members: asArray(r.members).map((member) => {
      const m = asRecord(member);
      return projectPeoplyPerson(m.employee ?? m);
    }),
  };
}

export function projectPeoplyWorkspaceGroup(raw: unknown): PeoplyWorkspaceGroup {
  const r = asRecord(raw);
  return {
    email: asString(r.email ?? r.groupEmail).toLowerCase(),
    name: asString(r.name),
    description: asString(r.description),
    directMemberCount: asNumberOrNull(r.directMembersCount) ?? asArray(r.members).length,
  };
}

export function projectPeoplyWorkspaceGroupDetail(raw: unknown): PeoplyWorkspaceGroupDetail {
  const outer = asRecord(raw);
  // Detail responses wrap the group under `group`; list rows are bare.
  const r = "group" in outer ? asRecord(outer.group) : outer;
  return {
    ...projectPeoplyWorkspaceGroup(r),
    members: asArray(r.members).map((member) => {
      const m = asRecord(member);
      return { email: asString(m.email).toLowerCase(), role: asString(m.role), type: asString(m.type) };
    }),
  };
}

// ---------- client ----------

// 2026-09-11 hotfix: an entry is either a cached success (`value`) or a cached failure
// (`error`, see PEOPLY_NEGATIVE_CACHE_TTL_MS above) — `cached` below rethrows the latter.
type CacheEntry = { expiresAt: number; value: unknown } | { expiresAt: number; error: unknown };

export type PeoplyClient = {
  readonly configured: boolean;
  getKeyStatus(): Promise<PeoplyKeyStatus>;
  searchPeople(q: string, options?: { membershipView?: PeoplyMembershipView }): Promise<PeoplySnapshot<PeoplyPerson>>;
  getPerson(email: string, options?: { membershipView?: PeoplyMembershipView }): Promise<PeoplyPersonDetail>;
  listOrganizations(q?: string, options?: { membershipView?: PeoplyMembershipView }): Promise<PeoplySnapshot<PeoplyOrganization>>;
  getOrganization(orgId: string, options?: { membershipView?: PeoplyMembershipView }): Promise<PeoplyOrganizationDetail>;
  listTaskForces(q?: string, options?: { membershipView?: PeoplyMembershipView }): Promise<PeoplySnapshot<PeoplyOrganization>>;
  getTaskForce(tfOrgId: string, options?: { membershipView?: PeoplyMembershipView }): Promise<PeoplyOrganizationDetail>;
  searchWorkspaceGroups(q: string): Promise<PeoplySnapshot<PeoplyWorkspaceGroup>>;
  getWorkspaceGroup(groupEmail: string): Promise<PeoplyWorkspaceGroupDetail>;
  /** Test/ops hook: drop every cached snapshot. */
  clearCache(): void;
};

export function createPeoplyClient(deps: PeoplyClientDeps = {}): PeoplyClient {
  const env = deps.env ?? process.env;
  const fetchImpl: PeoplyFetch = deps.fetch ?? ((input, init) => fetch(input, init) as never);
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<unknown>>();

  function requireKey(): string {
    const key = (env.PEOPLY_API_KEY ?? "").trim();
    if (!key) {
      throw new PeoplyClientError(
        "missing_key",
        "PEOPLY_API_KEY is not configured for this runtime (Secret Manager binding or functions/.secret.local).",
      );
    }
    return key;
  }

  function buildUrl(path: string, params: Record<string, string | undefined>): string {
    const base = resolvePeoplyBaseUrl(env);
    const url = new URL(path, base);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(name, value);
    }
    return url.toString();
  }

  async function requestOnce(url: string, key: string): Promise<{ status: number; retryAfter: number | null; body: unknown; code: string | null }> {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), PEOPLY_REQUEST_TIMEOUT_MS) : null;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { [PEOPLY_API_KEY_HEADER]: key, Accept: "application/json" },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (response.status >= 200 && response.status < 300) {
        return { status: response.status, retryAfter: null, body: await response.json(), code: null };
      }
      return {
        status: response.status,
        retryAfter: parseRetryAfter(response.headers.get("retry-after"), now()),
        body: null,
        code: await readUpstreamCode(response),
      };
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError" ? "Peoply request timed out." : "Peoply request failed before a response was received.";
      throw new PeoplyClientError("network", message);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function toError(result: { status: number; retryAfter: number | null; code: string | null }): PeoplyClientError {
    const upstreamCode = result.code;
    if (result.status === 403) {
      return new PeoplyClientError("forbidden", "Peoply rejected the key (invalid, disabled, expired, under-scoped, or origin-denied). Check GET /api/api-key/status.", { httpStatus: 403, upstreamCode });
    }
    if (result.status === 429) {
      return new PeoplyClientError("rate_limited", "Peoply rate limit reached.", { httpStatus: 429, retryAfterSeconds: result.retryAfter, upstreamCode });
    }
    if (result.status === 404) {
      return new PeoplyClientError("not_found", "Peoply resource not found.", { httpStatus: 404, upstreamCode });
    }
    if (result.status === 400 || result.status === 422) {
      return new PeoplyClientError("invalid_request", "Peoply rejected the request parameters.", { httpStatus: result.status, upstreamCode });
    }
    return new PeoplyClientError("upstream", `Peoply responded with HTTP ${result.status}.`, { httpStatus: result.status, upstreamCode });
  }

  async function fetchJson(url: string): Promise<unknown> {
    const key = requireKey();
    const startedAt = now();
    let result = await requestOnce(url, key);
    if (
      result.status === 429 &&
      result.retryAfter !== null &&
      result.retryAfter <= PEOPLY_MAX_INLINE_RETRY_AFTER_SECONDS &&
      // Skip the retry if the elapsed time so far, plus the wait, plus a worst-case retry
      // request (up to PEOPLY_REQUEST_TIMEOUT_MS), would blow the total request budget —
      // that budget is kept under the callable's timeoutSeconds (functions/index.ts).
      now() - startedAt + result.retryAfter * 1000 + PEOPLY_REQUEST_TIMEOUT_MS <= PEOPLY_TOTAL_BUDGET_MS
    ) {
      await new Promise((resolve) => setTimeout(resolve, result.retryAfter! * 1000));
      result = await requestOnce(url, key);
    }
    if (result.status < 200 || result.status >= 300) throw toError(result);
    return result.body;
  }

  /** Cache + in-flight de-duplication keyed by the full URL. */
  async function cached<T>(url: string, ttlMs: number, project: (body: unknown) => T): Promise<{ value: T; cacheHit: boolean }> {
    const entry = cache.get(url);
    if (entry && entry.expiresAt > now()) {
      // 2026-09-11 hotfix: a cached failure rethrows immediately instead of re-paying the full
      // PEOPLY_REQUEST_TIMEOUT_MS — see PEOPLY_NEGATIVE_CACHE_TTL_MS above.
      if ("error" in entry) throw entry.error;
      return { value: entry.value as T, cacheHit: true };
    }
    const pending = inflight.get(url);
    if (pending) return { value: (await pending) as T, cacheHit: true };
    const run = (async () => {
      try {
        const value = project(await fetchJson(url));
        cache.set(url, { expiresAt: now() + ttlMs, value });
        return value;
      } catch (error) {
        cache.set(url, { expiresAt: now() + PEOPLY_NEGATIVE_CACHE_TTL_MS, error });
        throw error;
      } finally {
        inflight.delete(url);
      }
    })();
    inflight.set(url, run);
    return { value: (await run) as T, cacheHit: false };
  }

  function snapshot<T>(body: unknown, listKey: string, project: (raw: unknown) => T): Omit<PeoplySnapshot<T>, "cacheHit"> {
    const r = asRecord(body);
    return {
      directoryUpdatedAt: asNullableString(r.directoryUpdatedAt) ?? asNullableString(r.workspaceGroupsUpdatedAt),
      fetchedAtIso: new Date(now()).toISOString(),
      items: asArray(r[listKey]).map(project),
    };
  }

  async function list<T>(url: string, listKey: string, project: (raw: unknown) => T): Promise<PeoplySnapshot<T>> {
    const { value, cacheHit } = await cached(url, PEOPLY_DIRECTORY_CACHE_TTL_MS, (body) => snapshot(body, listKey, project));
    return { ...value, cacheHit };
  }

  return {
    get configured() {
      return peoplyKeyConfigured(env);
    },
    async getKeyStatus() {
      const url = buildUrl("/api/api-key/status", {});
      const { value } = await cached(url, PEOPLY_STATUS_CACHE_TTL_MS, projectPeoplyKeyStatus);
      return value;
    },
    searchPeople(q, options = {}) {
      const url = buildUrl("/api/people", { q: sanitizeQuery(q), membershipView: options.membershipView ?? "effective" });
      return list(url, "people", projectPeoplyPerson);
    },
    async getPerson(email, options = {}) {
      const normalized = email.trim().toLowerCase();
      if (!normalized.includes("@")) throw new PeoplyClientError("invalid_request", "A full email address is required.");
      const url = buildUrl(`/api/people/${encodeURIComponent(normalized)}`, { membershipView: options.membershipView ?? "effective" });
      const { value } = await cached(url, PEOPLY_DIRECTORY_CACHE_TTL_MS, (body) => {
        const r = asRecord(body);
        const memberships = asArray(r.memberships).map(projectPeoplyMembership);
        const employee = projectPeoplyPerson(r.employee);
        // `/api/people/{email}` carries the authoritative primary org on its membership row;
        // `employee.primaryMembership` is only present on search rows in the current contract.
        // Preserve the compact employee projection consumed by mail routing while deriving it
        // from the explicit primary membership instead of silently losing the org id.
        if (!employee.primaryMembership) {
          employee.primaryMembership = memberships.find((membership) => membership.primary)?.orgId ?? "";
        }
        return {
          directoryUpdatedAt: asNullableString(r.directoryUpdatedAt),
          employee,
          memberships,
        } satisfies PeoplyPersonDetail;
      });
      return value;
    },
    listOrganizations(q = "", options = {}) {
      const url = buildUrl("/api/orgs", { q: sanitizeQuery(q), membershipView: options.membershipView ?? "effective" });
      return list(url, "organizations", projectPeoplyOrganization);
    },
    async getOrganization(orgId, options = {}) {
      const url = buildUrl(`/api/orgs/${encodeURIComponent(orgId.trim())}`, { membershipView: options.membershipView ?? "effective" });
      const { value } = await cached(url, PEOPLY_DIRECTORY_CACHE_TTL_MS, projectPeoplyOrganizationDetail);
      return value;
    },
    listTaskForces(q = "", options = {}) {
      const url = buildUrl("/api/tfs", { q: sanitizeQuery(q), membershipView: options.membershipView ?? "effective" });
      return list(url, "tfs", projectPeoplyOrganization);
    },
    async getTaskForce(tfOrgId, options = {}) {
      const url = buildUrl(`/api/tfs/${encodeURIComponent(tfOrgId.trim())}`, { membershipView: options.membershipView ?? "effective" });
      const { value } = await cached(url, PEOPLY_DIRECTORY_CACHE_TTL_MS, projectPeoplyOrganizationDetail);
      return value;
    },
    searchWorkspaceGroups(q) {
      const url = buildUrl("/api/workspace-groups", { q: sanitizeQuery(q) });
      return list(url, "groups", projectPeoplyWorkspaceGroup);
    },
    async getWorkspaceGroup(groupEmail) {
      const url = buildUrl(`/api/workspace-groups/${encodeURIComponent(groupEmail.trim().toLowerCase())}`, {});
      const { value } = await cached(url, PEOPLY_DIRECTORY_CACHE_TTL_MS, projectPeoplyWorkspaceGroupDetail);
      return value;
    },
    clearCache() {
      cache.clear();
      inflight.clear();
    },
  };
}

/**
 * Flu/Task-61 — emulator-only fixture: PEOPLY_API_KEY is never configured in the local Functions
 * emulator (no Secret Manager; functions/.secret.local is normally empty there), so every
 * resolveMailAccountForEmail() call used to fail closed to orgId:null ("no_primary_membership")
 * for every caller — no e2e could ever exercise a non-Growth org branch (actorOrgId gate, org tab
 * presets, chat personal-mailbox default). Covers only the fixed test accounts scripts/
 * seed-emulator.mjs creates in Firebase Auth; every other email still resolves exactly as before
 * (getPerson throws "not_found", caught by resolveMailAccountForEmail same as a real Peoply
 * miss). getPeoplyClient() below only ever installs this when FUNCTIONS_EMULATOR is true AND no
 * real key is configured, so a deployed runtime — or an emulator deliberately given a real key —
 * is never affected.
 */
const EMULATOR_PEOPLY_FIXTURE_BY_EMAIL: Readonly<Record<string, string>> = {
  "test-admin@demo-flu": "org-e2e-admin",
  "test-growth-manager@demo-flu": "org-growth",
  "test-drama-manager@demo-flu": "org-ai-drama",
};

function isEmulatorPeoplyFixtureActive(env: PeoplyEnvSource = process.env): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true" && !peoplyKeyConfigured(env);
}

function createEmulatorPeoplyClientFixture(): PeoplyClient {
  const unsupported = (method: string): never => {
    throw new PeoplyClientError("not_found", `Emulator Peoply fixture does not implement ${method} — only getPerson for known e2e test accounts.`);
  };
  // 2026-09-29 (peoply-directory-cache round-2 review finding #2): getOrganization used to throw
  // unconditionally, so the new ancestry builder (peoplyDirectoryCache.ts buildOrgAncestryChain)
  // treated every fixture user's org climb as an incomplete/failed lookup — the daily/manual sync
  // could never write a cache row for a fixture user (status:"failed", successCount:0), so e2e
  // suites that rely on the cache-hit path for these accounts had nothing to hit. Each fixture org
  // below is a flat root org (parentId: null) — a real, complete (one-link) ancestry chain, not a
  // capability gap — matching the fixture's own single-level org model.
  const fixtureOrgIds: ReadonlySet<string> = new Set(Object.values(EMULATOR_PEOPLY_FIXTURE_BY_EMAIL));
  return {
    configured: true,
    getKeyStatus: () => unsupported("getKeyStatus"),
    searchPeople: () => unsupported("searchPeople"),
    async getPerson(email) {
      const normalized = email.trim().toLowerCase();
      const primaryMembership = EMULATOR_PEOPLY_FIXTURE_BY_EMAIL[normalized];
      if (!primaryMembership) {
        throw new PeoplyClientError("not_found", `No emulator Peoply fixture entry for ${normalized}.`);
      }
      return {
        directoryUpdatedAt: null,
        employee: {
          id: normalized,
          email: normalized,
          displayName: normalized,
          nickname: "",
          koreanName: "",
          department: "",
          title: "",
          jobName: "",
          status: "active",
          primaryMembership,
          slackUserId: null,
        },
        memberships: [{
          orgId: primaryMembership,
          organizationName: primaryMembership,
          organizationPath: primaryMembership,
          title: "",
          role: "member",
          source: "emulator",
          purpose: "primary",
          primary: true,
          managerEmail: null,
        }],
      };
    },
    listOrganizations: () => unsupported("listOrganizations"),
    async getOrganization(orgId) {
      const normalized = orgId.trim();
      if (!fixtureOrgIds.has(normalized)) {
        throw new PeoplyClientError("not_found", `No emulator Peoply fixture org entry for ${normalized}.`);
      }
      return {
        id: normalized,
        hrOrgCode: null,
        name: normalized,
        parentId: null,
        active: true,
        type: "org",
        source: "emulator",
        organizationLevel: "root",
        organizationLevelLabel: "root",
        leaders: [],
        directoryUpdatedAt: null,
        path: normalized,
        members: [],
      };
    },
    listTaskForces: () => unsupported("listTaskForces"),
    getTaskForce: () => unsupported("getTaskForce"),
    searchWorkspaceGroups: () => unsupported("searchWorkspaceGroups"),
    getWorkspaceGroup: () => unsupported("getWorkspaceGroup"),
    clearCache() {},
  };
}

let defaultClient: PeoplyClient | null = null;

/** Process-wide client so the snapshot cache survives across callable invocations in one instance. */
export function getPeoplyClient(): PeoplyClient {
  if (!defaultClient) {
    defaultClient = isEmulatorPeoplyFixtureActive() ? createEmulatorPeoplyClientFixture() : createPeoplyClient();
  }
  return defaultClient;
}

/**
 * Test-only seam: inject a fake client (or reset to null) so peoplyCallables.ts tests
 * never touch the network or process.env. Not used by any production code path.
 */
export function setPeoplyClientForTests(client: PeoplyClient | null): void {
  defaultClient = client;
}
