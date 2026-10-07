// Callable handler FACTORIES for the Partner detail 5-tab surface (`/flu/partners/{enrollmentId}`,
// .specs/spec_partner_profile_tabs/spec.md §9). Exported but intentionally NOT registered in
// functions/index.ts — the integration leader wires the concrete `onCall` exports next wave (same
// pattern as ./managementProfileTabsCallables.ts).
//
// Every factory takes an injected "port" (a plain async data-access function) so this file stays
// testable with `node --test` and zero emulator/Firestore dependency.
//
// Server-side enforcement performed here for every read:
//   - role check (manager+; spec §2.2 access table),
//   - activation-only membership (a non-active/absent activation never reaches the caller as Partner
//     data — spec §1 rule 2),
//   - exact enrollment-scope re-check against every returned row before it leaves this boundary,
//   - cursor+limit bound for bounded-list tabs (spec §13: never an unbounded scan),
//   - legacy route-alias resolution without ever exposing the raw token (spec §2.1).
import type { CallableRequest } from "firebase-functions/v2/https";
import { onCall } from "firebase-functions/v2/https";
import { toCallableResponse, toHttpsError } from "./callableErrorBoundary";
import { decodePartnerListCursor, encodePartnerListCursor } from "./partnerProfileTabsPorts";
import { partnerActivationId } from "./partnerActivationCore";
import {
  assertPartnerScopeMatch,
  assertRoleAtLeast,
  buildCursorPage,
  buildPartnerListQueryScope,
  buildPartnerListRow,
  filterActivePartnerActivations,
  filterPartnerRecordsByScope,
  loadAllPartnerTabEnvelopesIndependently,
  matchesPartnerListScope,
  resolveCursorPageRequest,
  resolvePartnerRoute,
  PartnerReadModelError,
  type BuildPartnerListRowInput,
  type CursorPage,
  type PartnerListQueryScope,
  type PartnerListRow,
  type PartnerListScopeRequest,
  type PartnerRole,
  type PartnerRouteAliasLookupPort,
  type PartnerScopeRequest,
  type PartnerTabLoaders,
  type PartnerTabEnvelopes,
  type ResolvedPartnerRoute,
} from "./partnerProfileTabsReadModels";
import type { PartnerActivationDocument } from "./partnerActivationCore";

// ---- Auth context (identical shape/semantics to managementProfileTabsCallables.ts) --------------------

export interface CallableAuthContext {
  readonly uid: string | null;
  readonly role: PartnerRole | null;
}

export function resolveAuthContext(request: CallableRequest<unknown>): CallableAuthContext {
  const token = request.auth?.token as Record<string, unknown> | undefined;
  const rawRole = token?.role;
  const role: PartnerRole | null =
    rawRole === "manager" || rawRole === "admin" || rawRole === "super_admin" ? rawRole : null;
  return { uid: request.auth?.uid ?? null, role };
}

// ---- getActivePartners (spec §9) ----------------------------------------------------------------------

export interface GetActivePartnersRequestData {
  readonly programId?: string;
  readonly campaignId?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export function parseGetActivePartnersRequestData(data: unknown): GetActivePartnersRequestData {
  const record = (data && typeof data === "object" ? (data as Record<string, unknown>) : {}) as Record<string, unknown>;
  return {
    programId: typeof record.programId === "string" && record.programId.length > 0 ? record.programId : undefined,
    campaignId: typeof record.campaignId === "string" && record.campaignId.length > 0 ? record.campaignId : undefined,
    cursor: typeof record.cursor === "string" && record.cursor.length > 0 ? record.cursor : null,
    limit: typeof record.limit === "number" ? record.limit : undefined,
  };
}

export interface ActivePartnersPort {
  // MUST fetch at most `limit + 1` `status == "active"` activation documents ordered by
  // `activatedAtIso desc` (spec §2.3 fixed query shape) — never an unbounded scan. This port receives
  // only the resolved cursor/limit bound; it must not itself widen scope beyond what `scope` supplies.
  fetchActiveActivationPage(
    scope: PartnerListQueryScope,
    page: { cursor: string | null; limit: number },
  ): Promise<readonly PartnerActivationDocument[]>;
  // Resolves display name/handle/profile-image inputs for an activation's identity — kept as a separate
  // port call (rather than baked into the activation doc) because `partner_profiles` is an optimization
  // projection, not the activation source of truth (spec §6.2).
  resolveProfileInputs(identity: PartnerActivationDocument["identity"]): Promise<Omit<BuildPartnerListRowInput, "activation">>;
  // Additive W6 provenance lookup. Production resolves the current bounded page in `in` batches; optional
  // keeps injected legacy/unit ports source-compatible while yielding an honest null campaignName.
  resolveCampaignNames?(campaignIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  // W91: 프로그램 표시명도 같은 방식으로 조인한다. 해석기는 provenanceDisplay 한 곳이고, `view-cpm`
  // 같은 전역 태그는 애초에 이 맵에 들어오지 않는다(이름 없음 = null → 화면은 세그먼트를 생략).
  resolveProgramNames?(programIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export interface GetActivePartnersCallableConfig {
  readonly minimumRole: PartnerRole;
  readonly port: ActivePartnersPort;
}

export function createGetActivePartnersHandler(
  config: GetActivePartnersCallableConfig,
): (request: CallableRequest<unknown>) => Promise<CursorPage<PartnerListRow>> {
  return async (request: CallableRequest<unknown>): Promise<CursorPage<PartnerListRow>> => {
    try {
      const auth = resolveAuthContext(request);
      assertRoleAtLeast(auth.role, config.minimumRole);
      const parsed = parseGetActivePartnersRequestData(request.data);
      const scope = buildPartnerListQueryScope(parsed as PartnerListScopeRequest);
      const page = resolveCursorPageRequest(parsed);
      const activations = await config.port.fetchActiveActivationPage(scope, { cursor: page.cursor, limit: page.limit + 1 });
      // Status server-fixed to `active` (spec §9 "status server-fixed `active`") — never trusts the
      // store to have already filtered, and the programId/campaignId scope is re-checked here too.
      const activeOnly = filterActivePartnerActivations(activations).filter((activation) =>
        matchesPartnerListScope(scope, { programId: activation.identity.programId, campaignId: activation.identity.campaignId ?? null }),
      );
      const campaignIds = [...new Set(activeOnly
        .map((activation) => activation.identity.campaignId)
        .filter((campaignId): campaignId is string =>
          Boolean(campaignId) && campaignId !== "unclassified"))];
      const programIds = [...new Set(activeOnly.map((activation) => activation.identity.programId).filter(Boolean))];
      const [campaignNames, programNames] = await Promise.all([
        config.port.resolveCampaignNames
          ? config.port.resolveCampaignNames(campaignIds)
          : Promise.resolve(new Map<string, string>()),
        config.port.resolveProgramNames
          ? config.port.resolveProgramNames(programIds)
          : Promise.resolve(new Map<string, string>()),
      ]);
      const rows = await Promise.all(
        activeOnly.map(async (activation) => {
          const profileInputs = await config.port.resolveProfileInputs(activation.identity);
          const campaignId = activation.identity.campaignId;
          return buildPartnerListRow({
            activation,
            ...profileInputs,
            campaignName: campaignId ? campaignNames.get(campaignId) ?? null : null,
            programName: programNames.get(activation.identity.programId) ?? null,
          });
        }),
      );
      // 커서의 기존 직렬화 슬롯명은 호환 때문에 emittedCreatorIds지만, 행 정본과 같은 enrollmentId를
      // 싣는다. ⚠️ lookahead(+1)가 아니라 실제로 내보낸 행만 넣어 다음 페이지 경계를 보존한다.
      const emittedEnrollmentIds = [
        ...decodePartnerListCursor(page.cursor).emittedCreatorIds,
        ...activeOnly.slice(0, page.limit).map((activation) => activation.identity.enrollmentId),
      ];
      const activationIdByEnrollment = new Map(
        activeOnly.map((activation) => [activation.identity.enrollmentId, activation]),
      );
      return toCallableResponse(
        buildCursorPage(rows, page.limit, (row) => {
          const activation = activationIdByEnrollment.get(row.enrollmentId);
          return encodePartnerListCursor(
            activation
              ? {
                activatedAtIso: activation.activatedAtIso,
                activationId: partnerActivationId(activation.identity.enrollmentId),
              }
              : row.enrollmentId,
            emittedEnrollmentIds,
          );
        }),
      );
    } catch (err) {
      throw toHttpsError(err);
    }
  };
}

export function createGetActivePartnersCallable(config: GetActivePartnersCallableConfig) {
  return onCall(createGetActivePartnersHandler(config));
}

// ---- resolvePartnerRouteAlias (spec §2.1, §9) -----------------------------------------------------------

export interface ResolvePartnerRouteAliasRequestData {
  readonly routeId: string;
}

export interface ResolvePartnerRouteAliasPort {
  lookup: PartnerRouteAliasLookupPort;
}

export interface ResolvePartnerRouteAliasCallableConfig {
  readonly minimumRole: PartnerRole;
  readonly port: ResolvePartnerRouteAliasPort;
}

export function createResolvePartnerRouteAliasHandler(
  config: ResolvePartnerRouteAliasCallableConfig,
): (request: CallableRequest<unknown>) => Promise<ResolvedPartnerRoute> {
  return async (request: CallableRequest<unknown>): Promise<ResolvedPartnerRoute> => {
    try {
      const auth = resolveAuthContext(request);
      assertRoleAtLeast(auth.role, config.minimumRole);
      const data = request.data as Record<string, unknown> | undefined;
      const routeId = typeof data?.routeId === "string" ? data.routeId : "";
      const resolved = await resolvePartnerRoute(routeId, config.port.lookup);
      return toCallableResponse(resolved);
    } catch (err) {
      throw toHttpsError(err);
    }
  };
}

export function createResolvePartnerRouteAliasCallable(config: ResolvePartnerRouteAliasCallableConfig) {
  return onCall(createResolvePartnerRouteAliasHandler(config));
}

// ---- Enrollment-scoped tab-envelope batch (mirrors ManagementTabEnvelopes batch) -----------------------

export interface EnrollmentScopedRequestData {
  readonly enrollmentId: string;
}

export function parseEnrollmentScopedRequestData(data: unknown): EnrollmentScopedRequestData {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const enrollmentId = typeof (record as Record<string, unknown>).enrollmentId === "string" ? (record as Record<string, unknown>).enrollmentId as string : "";
  if (enrollmentId.length === 0) {
    throw new PartnerReadModelError("invalid-argument", "enrollmentId is required", false);
  }
  return { enrollmentId };
}

export interface PartnerTabEnvelopesPort {
  // Builds one loader per requested tab, scoped to the exact enrollmentId. A tab the caller doesn't want
  // fetched yet (spec §3.2 lazy tab loading) is simply omitted from the returned map. Every loader's
  // resolved row(s) MUST be checked with assertPartnerScopeMatch/filterPartnerRecordsByScope before
  // returning — this port is trusted to do so itself, matching the store-layer contract in
  // ./partnerActivationStore.ts.
  buildLoaders(scope: PartnerScopeRequest): PartnerTabLoaders;
}

export interface PartnerTabEnvelopesResult {
  readonly sourceStates: PartnerTabEnvelopes;
}

export interface PartnerTabEnvelopesCallableConfig {
  readonly minimumRole: PartnerRole;
  readonly port: PartnerTabEnvelopesPort;
  readonly previous?: PartnerTabEnvelopes;
}

export function createPartnerTabEnvelopesHandler(
  config: PartnerTabEnvelopesCallableConfig,
): (request: CallableRequest<unknown>) => Promise<PartnerTabEnvelopesResult> {
  return async (request: CallableRequest<unknown>): Promise<PartnerTabEnvelopesResult> => {
    try {
      const auth = resolveAuthContext(request);
      assertRoleAtLeast(auth.role, config.minimumRole);
      const parsed = parseEnrollmentScopedRequestData(request.data);
      const loaders = config.port.buildLoaders(parsed);
      const sourceStates = await loadAllPartnerTabEnvelopesIndependently(loaders, config.previous ?? {});
      return toCallableResponse({ sourceStates });
    } catch (err) {
      throw toHttpsError(err);
    }
  };
}

export function createPartnerTabEnvelopesCallable(config: PartnerTabEnvelopesCallableConfig) {
  return onCall(createPartnerTabEnvelopesHandler(config));
}

export { assertPartnerScopeMatch, filterPartnerRecordsByScope };
