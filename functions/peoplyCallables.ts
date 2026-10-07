/**
 * Callable handlers for the Peoply (Supercent HR 인명부) read-only integration.
 *
 * All three handlers share one shape: call the server-only peoplyClient, and if it
 * throws a PeoplyClientError, return a non-throwing `{ ok: false, peoplyError }`
 * envelope instead of surfacing an HttpsError — the UI needs a clear state (key
 * missing/rejected, rate limited, upstream error) rather than a generic failure.
 * Any other error (programming bug, RBAC denial from assertNonGuestAuth) rethrows
 * and is handled by the normal callable error boundary.
 *
 * The upstream key and raw upstream payloads never leave functions/peoplyClient.ts —
 * every response here is already the client's privacy-safe projection.
 */
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";
import {
  getPeoplyClient,
  PEOPLY_INTEGRATED_API_VERSION,
  PEOPLY_RUNTIME_CONTRACT_REVISION,
  PeoplyClientError,
  type PeoplyClient,
  type PeoplyErrorKind,
  type PeoplyMembershipView,
} from "./peoplyClient";
import { runPeoplyDirectorySync, type PeoplyDirectorySyncResult } from "./peoplyDirectoryCache";
import { clearMailAccountResolutionCache } from "./mailAccounts";

/** How long another warm Cloud Functions instance's own process-local mailAccounts.ts memoization
 * can keep serving pre-refresh routing data — see refreshPeoplyDirectoryCache's doc comment. */
export const PEOPLY_MANUAL_REFRESH_OTHER_INSTANCE_PROPAGATION_MS = 5 * 60 * 1000;
const PEOPLY_MANUAL_REFRESH_OTHER_INSTANCE_PROPAGATION_MINUTES =
  PEOPLY_MANUAL_REFRESH_OTHER_INSTANCE_PROPAGATION_MS / 60_000;
const PEOPLY_MANUAL_REFRESH_PROPAGATION_NOTE_KO =
  `조직 정보 반영까지 최대 ${PEOPLY_MANUAL_REFRESH_OTHER_INSTANCE_PROPAGATION_MINUTES}분이 걸릴 수 있습니다.`;

export type PeoplyErrorProjection = {
  kind: PeoplyErrorKind;
  httpStatus: number | null;
  retryAfterSeconds: number | null;
  upstreamCode: string | null;
};

function projectPeoplyError(error: PeoplyClientError): PeoplyErrorProjection {
  return {
    kind: error.kind,
    httpStatus: error.httpStatus,
    retryAfterSeconds: error.retryAfterSeconds,
    upstreamCode: error.upstreamCode,
  };
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument",
    errorCode: "peoply_invalid_argument",
  });
}

export async function getPeoplyStatus(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "peoply.status.read", ["super_admin", "admin"]);
  const client = getPeoplyClient();
  try {
    const status = await client.getKeyStatus();
    return {
      ok: true,
      configured: client.configured,
      integratedApiVersion: PEOPLY_INTEGRATED_API_VERSION,
      runtimeContractRevision: PEOPLY_RUNTIME_CONTRACT_REVISION,
      status,
      peoplyError: null,
      behaviorLog: makeBehaviorLog(auth, "peoply.status.read", "success", "global", 0),
    };
  } catch (error) {
    if (error instanceof PeoplyClientError) {
      return {
        ok: false,
        configured: client.configured,
        integratedApiVersion: PEOPLY_INTEGRATED_API_VERSION,
        runtimeContractRevision: PEOPLY_RUNTIME_CONTRACT_REVISION,
        status: null,
        peoplyError: projectPeoplyError(error),
        behaviorLog: makeBehaviorLog(auth, "peoply.status.read", "error", "global", 0),
      };
    }
    throw error;
  }
}

type PeoplySearchKind = "people" | "orgs" | "tfs" | "workspace-groups";
const PEOPLY_SEARCH_KINDS: readonly PeoplySearchKind[] = ["people", "orgs", "tfs", "workspace-groups"];
const PRIVILEGED_PEOPLY_SEARCH_ROLES = ["super_admin", "admin", "manager"] as const;
const PEOPLY_SEARCH_ROLES = [...PRIVILEGED_PEOPLY_SEARCH_ROLES, "viewer"] as const;

function normalizeMembershipView(value: unknown): PeoplyMembershipView | undefined {
  return value === "official" ? "official" : value === "effective" ? "effective" : undefined;
}

function fetchPeoplySnapshot(
  client: PeoplyClient,
  kind: PeoplySearchKind,
  q: string,
  membershipView: PeoplyMembershipView | undefined,
) {
  if (kind === "people") return client.searchPeople(q, membershipView ? { membershipView } : {});
  if (kind === "orgs") return client.listOrganizations(q, membershipView ? { membershipView } : {});
  if (kind === "tfs") return client.listTaskForces(q, membershipView ? { membershipView } : {});
  return client.searchWorkspaceGroups(q);
}

export async function searchPeoplyDirectory(request: CallableRequestShape) {
  const data = asRecord(request.data);
  const kind = asString(data.kind) as PeoplySearchKind;
  // Ordinary authenticated members may discover real Workspace group recipients in Chat.
  // People/org/TF directory reads remain restricted to the existing manager-plus roles.
  const auth = assertNonGuestAuth(
    request,
    "peoply.directory.search",
    kind === "workspace-groups" ? PEOPLY_SEARCH_ROLES : PRIVILEGED_PEOPLY_SEARCH_ROLES,
  );
  if (!PEOPLY_SEARCH_KINDS.includes(kind)) {
    throw invalidArgument("kind must be one of people, orgs, tfs, workspace-groups");
  }
  const q = (typeof data.q === "string" ? data.q : "").trim().slice(0, 120);
  if ((kind === "people" || kind === "workspace-groups") && !q) {
    throw invalidArgument("q is required for this kind");
  }
  const membershipView = normalizeMembershipView(data.membershipView);

  const client = getPeoplyClient();
  try {
    const snapshot = await fetchPeoplySnapshot(client, kind, q, membershipView);
    return {
      ok: true,
      kind,
      snapshot,
      peoplyError: null,
      behaviorLog: makeBehaviorLog(auth, "peoply.directory.search", "success", "global", 0),
    };
  } catch (error) {
    if (error instanceof PeoplyClientError) {
      return {
        ok: false,
        kind,
        snapshot: null,
        peoplyError: projectPeoplyError(error),
        behaviorLog: makeBehaviorLog(auth, "peoply.directory.search", "error", "global", 0),
      };
    }
    throw error;
  }
}

export async function getPeoplyPerson(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "peoply.person.read", ["super_admin", "admin", "manager"]);
  const data = asRecord(request.data);
  const email = asString(data.email).toLowerCase();
  if (!email) throw invalidArgument("email is required");

  const client = getPeoplyClient();
  try {
    const detail = await client.getPerson(email);
    return {
      ok: true,
      detail,
      peoplyError: null,
      behaviorLog: makeBehaviorLog(auth, "peoply.person.read", "success", "global", 0),
    };
  } catch (error) {
    if (error instanceof PeoplyClientError) {
      return {
        ok: false,
        detail: null,
        peoplyError: projectPeoplyError(error),
        behaviorLog: makeBehaviorLog(auth, "peoply.person.read", "error", "global", 0),
      };
    }
    throw error;
  }
}

/**
 * Manual "지금 동기화" refresh. Honest contract (round-2 review finding #1 — coordinator decision:
 * cross-instance cache invalidation is NOT worth building; document the bound instead):
 * - THIS callable's own instance sees the new org data immediately after this call returns — both
 *   the process-wide PeoplyClient response cache AND this instance's own mailAccounts.ts
 *   process-local memoization is cleared below. That helper clears org routing answers and the
 *   mail account/routing read memos; the extra invalidation only forces fresh Firestore reads.
 * - Any OTHER already-warm Cloud Functions instance keeps its own independent copy of those same
 *   process-local memos and can keep routing a caller to the pre-refresh org until ITS copy
 *   naturally expires — up to 5 minutes, not immediate, for callers who happen to land on a
 *   different instance. `propagationNote` in the response documents this so any future UI can show
 *   it instead of implying instant global effect.
 *
 * super_admin only — this re-reads every known member's Peoply membership and writes the shared
 * cache every other request-path lookup reads, so a manager/admin-triggered refresh would let a
 * non-super_admin affect other users' cached org resolution. Never throws PeoplyClientError out:
 * a genuine Peoply outage during a manual refresh is reported as ok:false/status:"failed" (and the
 * existing snapshot is left untouched by the sync itself), not a callable error.
 */
export async function refreshPeoplyDirectoryCache(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "peoply.directoryCache.manualRefresh", ["super_admin"]);
  let result: PeoplyDirectorySyncResult;
  try {
    // Round-1 review finding #4: the process-wide PeoplyClient keeps its own short (5-minute)
    // in-memory response cache (peoplyClient.ts) shared across every callable on a warm instance.
    // Without clearing it first, "지금 동기화" could silently re-read and re-persist a getPerson
    // response from just before the org change this refresh exists to pick up — defeating the
    // entire point of a manual refresh. Clear it so every getPerson/getOrganization call below
    // hits Peoply fresh.
    getPeoplyClient().clearCache();
    // Round-2 review finding #1: also clear THIS instance's own mailAccounts.ts process-local
    // memoization, so a super_admin's very next request (likely to land back on this same warm
    // instance) reads fresh Firestore rows instead of up-to-5-minute-old in-memory answers.
    clearMailAccountResolutionCache();
    result = await runPeoplyDirectorySync({ source: "manual-refresh" });
  } catch (error) {
    if (error instanceof PeoplyClientError) {
      return {
        ok: false,
        result: null,
        peoplyError: projectPeoplyError(error),
        propagationNote: null,
        behaviorLog: makeBehaviorLog(auth, "peoply.directoryCache.manualRefresh", "error", "global", 0),
      };
    }
    throw error;
  } finally {
    // Discard routing answers repopulated from old rows while this sync was running.
    // Partial failures can also have updated some rows.
    clearMailAccountResolutionCache();
  }
  return {
    ok: result.status !== "failed",
    result,
    peoplyError: null,
    // See this function's doc comment — immediate on this instance, up to 5 minutes elsewhere.
    propagationNote: PEOPLY_MANUAL_REFRESH_PROPAGATION_NOTE_KO,
    behaviorLog: makeBehaviorLog(
      auth,
      "peoply.directoryCache.manualRefresh",
      result.status === "failed" ? "error" : "success",
      "global",
      0,
    ),
  };
}
