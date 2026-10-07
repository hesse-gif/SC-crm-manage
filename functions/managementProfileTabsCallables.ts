// Callable handler FACTORIES for the creator Management detail seven-tab surface
// (spec_creator_management_profile_tabs/spec.md). Exported but intentionally NOT registered in
// functions/index.ts — the integration leader wires the concrete `onCall` exports once ports are
// connected to real Firestore/Portal-material readers.
//
// Every factory takes an injected "port" (a plain async data-access function) so this file stays
// testable with `node --test` and zero emulator/Firestore dependency, mirroring the existing pure-core +
// injected-IO pattern used by ./videoReviewTransitionCore.ts's callers.
//
// Server-side enforcement performed here for every read:
//   - role check (manager+; spec §2 access table),
//   - exact scope echo (no widening; spec §1 rule 1 / §4.1),
//   - cursor+limit bound (spec §4.1: never an unbounded scan),
//   - defense-in-depth scope re-check against every returned row before it leaves this boundary.
import type { CallableRequest } from "firebase-functions/v2/https";
import { onCall } from "firebase-functions/v2/https";
import { toCallableResponse, toHttpsError } from "./callableErrorBoundary";
import { resolveViewAsTarget } from "./mailAccountCallables";
import {
  assertRoleAtLeast,
  buildCursorPage,
  buildUnderlyingQueryScope,
  filterRecordsByScope,
  loadAllTabEnvelopesIndependently,
  ManagementReadModelError,
  ManagementTabKey,
  ManagementTabLoaders,
  ManagementTabEnvelopes,
  ManagementRole,
  resolveCursorPageRequest,
  ScopedRecord,
  CursorPage,
  UnderlyingQueryScope,
} from "./managementProfileTabsReadModels";

// ---- Auth context -------------------------------------------------------------------------------------

export interface CallableAuthContext {
  readonly uid: string | null;
  readonly role: ManagementRole | null;
  // Flu conversation org-filter round 2 (codex adversarial review): the journey tab's
  // conversation-outreach reader needs the caller's own Peoply-resolved org
  // (functions/conversationMailAccessScope.ts resolveConversationMailAccessScope requires an
  // email to look it up) to apply the scp per-org gate. Every other tab port ignores this field.
  readonly email: string | null;
}

// Reads the caller's role from the verified auth token's custom claim. Absent/unauthenticated => null
// role, which `assertRoleAtLeast` always rejects (fail-closed; guest/unauthenticated can never read).
export function resolveAuthContext(request: CallableRequest<unknown>): CallableAuthContext {
  const token = request.auth?.token as Record<string, unknown> | undefined;
  const rawRole = token?.role;
  const role: ManagementRole | null =
    rawRole === "manager" || rawRole === "admin" || rawRole === "super_admin" ? rawRole : null;
  const email = typeof token?.email === "string" && token.email ? token.email : null;
  return { uid: request.auth?.uid ?? null, role, email };
}

// Flu conversation org-filter round 16 (codex adversarial review round 16, finding #3): the journey
// tab's conversation-outreach reader (fetchConversationOutreach, managementProfileTabsPorts.ts) runs
// the scp per-org gate against THIS auth — before this fix it was always the real caller's own
// (resolveAuthContext above), so a super_admin's "대신 보기" (viewAs) preview of another member's
// Management journey silently showed the SUPER_ADMIN's own unrestricted scp visibility instead of
// the previewed target's real (possibly denied) scope. Reuses the SAME verified viewAs resolver
// getMyOrgContext/listMailOutbox/listConversations already use (functions/mailAccountCallables.ts
// resolveViewAsTarget) — the client-supplied viewAsUserId/viewAsEmail are never trusted directly;
// the target is re-looked-up against the members collection server-side. Returns the caller's own
// auth unchanged when no viewAs was requested (data has neither field).
async function resolveEffectiveAuthContext(
  request: CallableRequest<unknown>,
  auth: CallableAuthContext,
): Promise<CallableAuthContext> {
  // "guest" is a theoretically-typed but never runtime-assigned ManagementRole (resolveAuthContext
  // only ever narrows to manager/admin/super_admin or null) — excluded here only to satisfy
  // resolveViewAsTarget's caller-role type, which (correctly) never accepts a guest caller either.
  if (!auth.role || auth.role === "guest") return auth;
  const data = (request.data && typeof request.data === "object" ? request.data : {}) as Record<string, unknown>;
  const target = await resolveViewAsTarget(
    {
      userId: auth.uid ?? "",
      role: auth.role,
      team: "unassigned",
      ip: request.rawRequest?.ip ?? "0.0.0.0",
      gameId: "global",
      ...(auth.email ? { email: auth.email } : {}),
    },
    data,
  );
  if (!target) return auth;
  // resolveViewAsTarget's Role can also be "viewer", which ManagementRole does not model — a
  // previewed target whose real role is "viewer" simply has no Management access (assertRoleAtLeast
  // below denies null the same as any other unauthorized caller), not an elevated one.
  const role: ManagementRole | null = target.role === "manager" || target.role === "admin" || target.role === "super_admin"
    ? target.role
    : null;
  return { uid: target.uid, role, email: target.email };
}

// ---- Scoped list request payload ---------------------------------------------------------------------

export interface ScopedTabListRequestData {
  readonly fluCreatorId: string;
  readonly programId: string;
  readonly campaignId?: string;
  readonly enrollmentId?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export function parseScopedTabListRequestData(data: unknown): ScopedTabListRequestData {
  if (!data || typeof data !== "object") {
    throw new ManagementReadModelError("invalid-argument", "request payload is required", false);
  }
  const record = data as Record<string, unknown>;
  if (typeof record.fluCreatorId !== "string" || record.fluCreatorId.length === 0) {
    throw new ManagementReadModelError("invalid-argument", "fluCreatorId is required", false);
  }
  if (typeof record.programId !== "string" || record.programId.length === 0) {
    throw new ManagementReadModelError("invalid-argument", "programId is required", false);
  }
  return {
    fluCreatorId: record.fluCreatorId,
    programId: record.programId,
    campaignId: typeof record.campaignId === "string" && record.campaignId.length > 0 ? record.campaignId : undefined,
    enrollmentId:
      typeof record.enrollmentId === "string" && record.enrollmentId.length > 0 ? record.enrollmentId : undefined,
    cursor: typeof record.cursor === "string" && record.cursor.length > 0 ? record.cursor : null,
    limit: typeof record.limit === "number" ? record.limit : undefined,
  };
}

// ---- Generic scoped/bounded tab-list callable factory --------------------------------------------------

export interface ScopedTabListPort<TRow extends ScopedRecord> {
  // MUST fetch at most `page.limit + 1` rows for the given exact (non-widened) scope. Never an unbounded
  // collection scan; the store owns cursor semantics, this port only receives the resolved bound.
  // `auth` is the already-role-checked caller (Flu conversation org-filter round 2) — only the
  // journey port's conversation-outreach reader uses it (scp per-org gate); every other port
  // implementation ignores it.
  fetchPage(scope: UnderlyingQueryScope, page: { cursor: string | null; limit: number }, auth: CallableAuthContext): Promise<readonly TRow[]>;
  cursorOf(row: TRow): string;
}

export interface ScopedTabListCallableConfig<TRow extends ScopedRecord> {
  readonly minimumRole: ManagementRole;
  readonly port: ScopedTabListPort<TRow>;
  // Flu conversation org-filter round 2 (codex adversarial review): the journey port's
  // conversation-outreach reader resolves the caller's org via Peoply
  // (functions/conversationMailAccessScope.ts) — the registering export (functions/index.ts
  // manageProfileTabJourneyList) must bind PEOPLY_API_KEY here or every non-super_admin caller
  // silently resolves a null org. Every other tab omits this.
  readonly secrets?: readonly string[];
}

export function createScopedTabListHandler<TRow extends ScopedRecord>(
  config: ScopedTabListCallableConfig<TRow>,
): (request: CallableRequest<unknown>) => Promise<CursorPage<TRow>> {
  return async (request: CallableRequest<unknown>): Promise<CursorPage<TRow>> => {
    try {
      const auth = resolveAuthContext(request);
      assertRoleAtLeast(auth.role, config.minimumRole);
      const effectiveAuth = await resolveEffectiveAuthContext(request, auth);
      // Flu conversation org-filter round 17 (codex adversarial review round 17, finding #2): the
      // role floor above only ever proved the REAL caller (super_admin, during viewAs) can use this
      // callable — a viewAs TARGET whose own real role is below minimumRole (e.g. "viewer", or
      // resolveEffectiveAuthContext's own role===null fallback) must not have this page's
      // manager-only data previewed on their behalf; a super_admin previewing that target should
      // see exactly what the target would see if they opened this page themselves — nothing.
      assertRoleAtLeast(effectiveAuth.role, config.minimumRole);
      const parsed = parseScopedTabListRequestData(request.data);
      const scope = buildUnderlyingQueryScope(parsed);
      const page = resolveCursorPageRequest(parsed);
      const rows = await config.port.fetchPage(scope, { cursor: page.cursor, limit: page.limit + 1 }, effectiveAuth);
      const scoped = filterRecordsByScope(scope, rows);
      return toCallableResponse(buildCursorPage(scoped, page.limit, config.port.cursorOf));
    } catch (err) {
      throw toHttpsError(err);
    }
  };
}

// Wraps the pure handler in `onCall` for the leader to export/register directly (still unregistered
// here — this factory is never invoked at module load time in index.ts).
export function createScopedTabListCallable<TRow extends ScopedRecord>(config: ScopedTabListCallableConfig<TRow>) {
  return config.secrets && config.secrets.length
    ? onCall({ secrets: [...config.secrets] }, createScopedTabListHandler(config))
    : onCall(createScopedTabListHandler(config));
}

// ---- Tier-A shell + independent tab-envelope batch callable -------------------------------------------

export interface ShellRequestData {
  readonly fluCreatorId: string;
  readonly programId: string;
  readonly campaignId?: string;
  readonly enrollmentId?: string;
}

export function parseShellRequestData(data: unknown): ShellRequestData {
  if (!data || typeof data !== "object") {
    throw new ManagementReadModelError("invalid-argument", "request payload is required", false);
  }
  const record = data as Record<string, unknown>;
  if (typeof record.fluCreatorId !== "string" || record.fluCreatorId.length === 0) {
    throw new ManagementReadModelError("invalid-argument", "fluCreatorId is required", false);
  }
  if (typeof record.programId !== "string" || record.programId.length === 0) {
    throw new ManagementReadModelError("invalid-argument", "programId is required", false);
  }
  return {
    fluCreatorId: record.fluCreatorId,
    programId: record.programId,
    campaignId: typeof record.campaignId === "string" && record.campaignId.length > 0 ? record.campaignId : undefined,
    enrollmentId:
      typeof record.enrollmentId === "string" && record.enrollmentId.length > 0 ? record.enrollmentId : undefined,
  };
}

export interface ManagementTabEnvelopesPort {
  // Builds one loader per requested tab, scoped to the exact (non-widened) request scope. A tab this
  // caller doesn't want fetched yet (spec §4.1 lazy tab loading) is simply omitted from the returned map.
  // `auth` (Flu conversation org-filter round 2) is threaded to the journey loader's scp per-org
  // gate the same way ScopedTabListPort.fetchPage receives it; every other loader ignores it.
  buildLoaders(scope: UnderlyingQueryScope, auth: CallableAuthContext): ManagementTabLoaders;
}

export interface ManagementTabEnvelopesResult {
  readonly sourceStates: ManagementTabEnvelopes;
}

export interface ManagementTabEnvelopesCallableConfig {
  readonly minimumRole: ManagementRole;
  readonly port: ManagementTabEnvelopesPort;
  readonly previous?: ManagementTabEnvelopes;
  // Flu conversation org-filter round 2 (codex adversarial review): this batch includes the
  // journey loader, so the registering export (functions/index.ts manageProfileTabEnvelopes) must
  // bind PEOPLY_API_KEY the same as ScopedTabListCallableConfig.secrets above.
  readonly secrets?: readonly string[];
}

// Fetches every requested tab's envelope independently (Promise.allSettled under the hood): a slow or
// failed source (e.g. channel-intelligence quota error) returns only that tab's stale/error envelope and
// never blocks the others or the already-resolved Tier-A shell (spec §3.1/§5.6).
export function createManagementTabEnvelopesHandler(
  config: ManagementTabEnvelopesCallableConfig,
): (request: CallableRequest<unknown>) => Promise<ManagementTabEnvelopesResult> {
  return async (request: CallableRequest<unknown>): Promise<ManagementTabEnvelopesResult> => {
    try {
      const auth = resolveAuthContext(request);
      assertRoleAtLeast(auth.role, config.minimumRole);
      const effectiveAuth = await resolveEffectiveAuthContext(request, auth);
      // Flu conversation org-filter round 17: see createScopedTabListHandler's matching comment —
      // a viewAs target below minimumRole must not have this page's data previewed on their behalf.
      assertRoleAtLeast(effectiveAuth.role, config.minimumRole);
      const parsed = parseShellRequestData(request.data);
      const scope = buildUnderlyingQueryScope(parsed);
      const loaders = config.port.buildLoaders(scope, effectiveAuth);
      const sourceStates = await loadAllTabEnvelopesIndependently(loaders, config.previous ?? {});
      return toCallableResponse({ sourceStates });
    } catch (err) {
      throw toHttpsError(err);
    }
  };
}

export function createManagementTabEnvelopesCallable(config: ManagementTabEnvelopesCallableConfig) {
  return config.secrets && config.secrets.length
    ? onCall({ secrets: [...config.secrets] }, createManagementTabEnvelopesHandler(config))
    : onCall(createManagementTabEnvelopesHandler(config));
}

export type { ManagementTabKey };
