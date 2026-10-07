import { getSettings as getSettingsImpl } from "./settings";
import { getMyOrgContext as getMyOrgContextImpl } from "./mailAccountCallables";
import { listPrograms as listProgramsImpl } from "./read";
import { getOperationalSnapshot as getOperationalSnapshotImpl } from "./operationalSnapshot";
import { getDashboardPipelineProjection as getDashboardPipelineProjectionImpl } from "./dashboardPipelineProjection";
import { toCallableResponse, toHttpsError } from "./callableErrorBoundary";
import { asRecord } from "./shared";
import type { CallableRequestShape } from "./shared";

type AppBootstrapDeps = {
  getSettings: typeof getSettingsImpl;
  getMyOrgContext: typeof getMyOrgContextImpl;
  listPrograms: typeof listProgramsImpl;
  getOperationalSnapshot: typeof getOperationalSnapshotImpl;
  getDashboardPipelineProjection: typeof getDashboardPipelineProjectionImpl;
};

const defaultDeps: AppBootstrapDeps = {
  getSettings: getSettingsImpl,
  getMyOrgContext: getMyOrgContextImpl,
  listPrograms: listProgramsImpl,
  getOperationalSnapshot: getOperationalSnapshotImpl,
  getDashboardPipelineProjection: getDashboardPipelineProjectionImpl,
};

let deps: AppBootstrapDeps = defaultDeps;

/** Test-only seam (same pattern as functions/mailAccountCallables.ts's
 * setMailAccountGrantAuthVerifierForTests) — lets a unit test exercise the
 * Promise.allSettled/payload-routing logic below with fakes instead of standing up all 5 nested
 * handlers' own Firestore/Peoply dependencies. Pass null to restore the real handlers. */
export function setAppBootstrapDependenciesForTests(overrides: Partial<AppBootstrapDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

/**
 * Perf/cost 2026-09-24: the /flu dashboard mount independently triggers up to five separate
 * Gen2 callable services on the same page load — getSettings, getMyOrgContext, listPrograms,
 * getOperationalSnapshot, getDashboardPipelineProjection — each paying its own Cloud Run cold
 * start (prod-measured 2-8s cold vs 0.3-0.9s warm). This callable composes the same
 * review-approved read handlers **in-process** (a plain function call, not a second network
 * hop), so a caller that genuinely wants all five pays for one cold start instead of up to five.
 *
 * The five individual callables stay exported and unchanged for every other read path — this is
 * additive, not a replacement, and reuses each handler's own RBAC/auth/viewAs logic verbatim
 * rather than duplicating it.
 *
 * Not wired into the client in this PR (2026-09-24 adversarial review round 2): an earlier
 * version had the /flu dashboard prefetch this endpoint but consume only the orgContext field,
 * which added a real (Firestore/Peoply-costing) call to all 5 nested reads while only reliably
 * saving, at best, the one it used — net cost-negative-to-neutral, not the "collapse 5 cold
 * starts" this endpoint is built for. Removed rather than kept as a partial win; a future PR that
 * actually consumes all 5 fields through their respective hooks (useOperationalSnapshot,
 * useDashboardPipelineProjection, the "programs" dataset key, settings pages) is the honest way
 * to realize this endpoint's value, and is its own dedicated, carefully-tested change — this PR
 * ships the server-side foundation only.
 *
 * `Promise.allSettled` (not `Promise.all`): each nested handler has its own RBAC/guest
 * semantics — e.g. getMyOrgContext throws for a guest caller — and today fails independently
 * per-client-hook. A single `Promise.all` would turn one handler's expected rejection into a
 * hard failure for the whole bootstrap response, which no existing caller expects.
 *
 * Response sanitization (2026-09-24 adversarial review, Codex round 1): functions/index.ts's
 * callable() wrapper normally sanitizes a response through toCallableResponse (strips
 * behaviorLog) and, on rejection, through toHttpsError (maps to a public code/message via
 * CALLABLE_PUBLIC_MESSAGES — never the raw internal error text) — but only at the TOP level of a
 * single callable call. Since this handler nests 5 full handler results/rejections instead of
 * being caught by that boundary individually, it applies the exact same two functions
 * (functions/callableErrorBoundary.ts) to each nested field itself, so a client reading
 * `result.settings.value` or `result.orgContext.error` sees exactly what it would have seen
 * calling getSettings/getMyOrgContext directly — no internal behaviorLog or raw error text leaks
 * through the batch that wouldn't have leaked through the individual call.
 *
 * viewAsUserId/viewAsEmail (Flu/Task-50 "대신 보기") are read only from the top-level payload —
 * functions/index.ts's callable() wrapper gates this via assertViewAsReadOnlyPayload before this
 * handler ever runs (see functions/viewAsWriteGuard.ts's VIEW_AS_READ_ALLOWLIST, which this
 * callable's name must be added to). Only the nested handlers that actually consume it
 * (getMyOrgContext, listPrograms, and — 2026-09-27 codex adversarial review round 2 FAIL-5 —
 * getSettings, whose scp-field masking must reflect the viewAs target's real entitlement, not the
 * super_admin's own bypass; all three already allowlisted individually) receive it. The other two
 * never see it — and operationalSnapshot/dashboardPipelineProjection are not skipped from
 * that forwarding by accident: neither handler has any viewAs awareness at all, so calling them
 * during an active viewAs session would silently return the super_admin's own (or the global)
 * data instead of failing closed the way the client's own useOperationalSnapshot hook already
 * requires (`canUseGlobalSnapshot = role === "super_admin" && !viewAsFlagActive`,
 * src/lib/use-operational-snapshot.ts). This handler skips calling those two entirely while
 * viewAsUserId is set, returning an explicit `unavailable_during_view_as` field instead of
 * fetching (and sending to the browser) data the caller's viewAs target was never meant to see.
 */
export interface AppBootstrapPayload {
  viewAsUserId?: string;
  viewAsEmail?: string;
  operationalSnapshot?: { surface?: string; acceptedSchemaVersions?: string[] };
  dashboardPipelineProjection?: {
    limit?: number;
    applicationCursor?: string;
    leadCursor?: string;
    creatorCursor?: string;
    conversationCursor?: string;
  };
  programs?: { limit?: number; cursor?: string };
}

export type AppBootstrapFieldResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string; code?: string } };

function settledField<T>(result: PromiseSettledResult<T>): AppBootstrapFieldResult<T> {
  if (result.status === "fulfilled") {
    return { ok: true, value: toCallableResponse(result.value) };
  }
  // Same sanitization boundary a direct call to the individual callable would have gone through
  // (functions/index.ts's callable() wrapper calls toHttpsError on any thrown error before it
  // reaches the client) — never the raw internal error/message.
  const httpsError = toHttpsError(result.reason);
  return { ok: false, error: { message: httpsError.message, code: httpsError.code } };
}

function skippedDuringViewAsField<T>(): AppBootstrapFieldResult<T> {
  return {
    ok: false,
    error: { message: "unavailable while viewing as another member", code: "unavailable_during_view_as" },
  };
}

/** True when a settled field is a rejection, OR a resolved value that itself carries `ok:false`
 * (getSettings' CallableOk|CallableDenied contract denies this way instead of throwing — a bare
 * `!field.ok` check on the wrapper alone would miss it; see 2026-09-24 adversarial review round
 * 2). Used only to roll the batch's own audit record up to "denied" — never to alter what the
 * client receives. */
function fieldIndicatesDenial(field: AppBootstrapFieldResult<unknown>): boolean {
  if (!field.ok) return true;
  const value = field.value;
  return Boolean(value && typeof value === "object" && (value as { ok?: unknown }).ok === false);
}

export async function getAppBootstrap(request: CallableRequestShape) {
  const data = asRecord(request.data) as AppBootstrapPayload;
  const viewAsUserId = typeof data.viewAsUserId === "string" ? data.viewAsUserId : undefined;
  const viewAsEmail = typeof data.viewAsEmail === "string" ? data.viewAsEmail : undefined;
  // getMyOrgContext/listPrograms are the only nested handlers that read/verify viewAsUserId
  // (see functions/viewAsWriteGuard.ts VIEW_AS_READ_ALLOWLIST) — forward it to those two only.
  const orgScopedData: Record<string, unknown> = viewAsUserId
    ? { viewAsUserId, ...(viewAsEmail ? { viewAsEmail } : {}) }
    : {};
  // Each sub-payload is explicitly whitelisted to its own declared fields (AppBootstrapPayload
  // above) rather than spread wholesale — 2026-09-24 adversarial review round 2 found that
  // spreading `data.programs` after `orgScopedData` let a `programs.viewAsUserId` field silently
  // override the top-level viewAs target for just that one nested call (listPrograms resolving a
  // different target than getMyOrgContext in the same response). Whitelisting removes that whole
  // class of cross-field override, not just this one instance.
  const rawSnapshotSub = asRecord(data.operationalSnapshot);
  const snapshotSub: Record<string, unknown> = {
    ...(typeof rawSnapshotSub.surface === "string" ? { surface: rawSnapshotSub.surface } : {}),
    ...(Array.isArray(rawSnapshotSub.acceptedSchemaVersions) ? { acceptedSchemaVersions: rawSnapshotSub.acceptedSchemaVersions } : {}),
  };
  const rawPipelineSub = asRecord(data.dashboardPipelineProjection);
  const pipelineSub: Record<string, unknown> = {
    ...(typeof rawPipelineSub.limit === "number" ? { limit: rawPipelineSub.limit } : {}),
    ...(typeof rawPipelineSub.applicationCursor === "string" ? { applicationCursor: rawPipelineSub.applicationCursor } : {}),
    ...(typeof rawPipelineSub.leadCursor === "string" ? { leadCursor: rawPipelineSub.leadCursor } : {}),
    ...(typeof rawPipelineSub.creatorCursor === "string" ? { creatorCursor: rawPipelineSub.creatorCursor } : {}),
    ...(typeof rawPipelineSub.conversationCursor === "string" ? { conversationCursor: rawPipelineSub.conversationCursor } : {}),
  };
  const rawProgramsSub = asRecord(data.programs);
  const programsData: Record<string, unknown> = {
    ...orgScopedData,
    ...(typeof rawProgramsSub.limit === "number" ? { limit: rawProgramsSub.limit } : {}),
    ...(typeof rawProgramsSub.cursor === "string" ? { cursor: rawProgramsSub.cursor } : {}),
  };

  const withData = (nextData: Record<string, unknown>): CallableRequestShape => ({
    ...request,
    data: nextData,
  });

  // While viewing as another member, operationalSnapshot/dashboardPipelineProjection are not
  // called at all (see the header comment) — these two placeholder promises are never read
  // (skippedDuringViewAsField() below overrides them unconditionally); they exist only to keep
  // the Promise.allSettled tuple's shape/order fixed.
  const [settings, orgContext, programs, operationalSnapshotSettled, dashboardPipelineProjectionSettled] =
    await Promise.allSettled([
      // 2026-09-27 codex adversarial review round 2 FAIL-5: getSettings is now viewAs-aware (its
      // scp-field masking must reflect the target's real entitlement, not the super_admin's own
      // bypass) — forward the same orgScopedData getMyOrgContext/listPrograms already receive.
      deps.getSettings(withData(orgScopedData)),
      deps.getMyOrgContext(withData(orgScopedData)),
      deps.listPrograms(withData(programsData)),
      viewAsUserId ? Promise.resolve(null) : deps.getOperationalSnapshot(withData(snapshotSub)),
      viewAsUserId ? Promise.resolve(null) : deps.getDashboardPipelineProjection(withData(pipelineSub)),
    ]);

  const settingsField = settledField(settings);
  const orgContextField = settledField(orgContext);
  const programsField = settledField(programs);
  const operationalSnapshotField = viewAsUserId
    ? skippedDuringViewAsField<Awaited<ReturnType<typeof getOperationalSnapshotImpl>>>()
    : settledField(operationalSnapshotSettled);
  const dashboardPipelineProjectionField = viewAsUserId
    ? skippedDuringViewAsField<Awaited<ReturnType<typeof getDashboardPipelineProjectionImpl>>>()
    : settledField(dashboardPipelineProjectionSettled);

  // operationalSnapshot/dashboardPipelineProjection are excluded here while viewing as another
  // member — their {ok:false} is an intentional skip (see skippedDuringViewAsField above), not a
  // denial, and must not make an otherwise fully-successful viewAs bootstrap read show up as
  // "denied" in the one audit record this batch produces (2026-09-24 adversarial review round 2).
  const auditableFields = viewAsUserId
    ? [settingsField, orgContextField, programsField]
    : [settingsField, orgContextField, programsField, operationalSnapshotField, dashboardPipelineProjectionField];
  const anyFieldFailed = auditableFields.some(fieldIndicatesDenial);

  return {
    ok: true as const,
    settings: settingsField,
    orgContext: orgContextField,
    programs: programsField,
    operationalSnapshot: operationalSnapshotField,
    dashboardPipelineProjection: dashboardPipelineProjectionField,
    // LOG-P0-008 (2026-09-24 adversarial review, Codex round 1): this call replaces up to five
    // separate audited callable invocations with one, and functions/index.ts's
    // persistCallableOutcome only ever sees this ONE synthetic record (it cannot distinguish "the
    // bootstrap itself threw" from "a nested read was denied" — this handler never throws, by
    // design, so Promise.allSettled can report partial results). `result` is a coarse rollup:
    // "denied" whenever any nested field failed (most commonly RBAC/guest denial, e.g.
    // getMyOrgContext rejecting a guest), not a precise per-field audit trail — an accepted,
    // explicitly documented tradeoff of batching reads into one audited call, not full parity
    // with calling all 5 individually. `action` carries the viewAs target when present so "who
    // viewed as whom" through this endpoint stays visible in behavior_logs, mirroring (not
    // duplicating) getMyOrgContext's own dedicated viewAs audit action.
    behaviorLog: {
      userId: request.auth?.uid ?? "anonymous",
      role: request.auth?.token?.role ?? "guest",
      team: request.auth?.token?.team ?? "unknown",
      gameId: request.auth?.token?.gameId ?? "global",
      action: viewAsUserId ? `data.appBootstrap.read(viewAs:${viewAsUserId})` : "data.appBootstrap.read",
      time: new Date().toISOString(),
      IP: request.rawRequest?.ip ?? "unknown",
      result: anyFieldFailed ? ("denied" as const) : ("success" as const),
      cost: 0,
    },
  };
}
