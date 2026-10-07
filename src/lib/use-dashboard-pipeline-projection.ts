"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getDashboardPipelineProjection,
  type DashboardPipelineProjectionEnvelope,
  type DashboardPipelineProjectionPageInfo,
} from "./data";
import { continueDashboardPipelineHiddenPages } from "./dashboard-pipeline-continuation";
import { useRole } from "./role";
import { useViewAs } from "./viewAs";

export const DASHBOARD_PIPELINE_CLIENT_LIMIT = 40;

function emptyPageInfo(): DashboardPipelineProjectionPageInfo {
  return {
    limit: DASHBOARD_PIPELINE_CLIENT_LIMIT,
    returned: 0,
    scanned: 0,
    hasMore: false,
    truncated: false,
    nextCursor: null,
  };
}

function emptyProjection(): Pick<
  DashboardPipelineProjectionEnvelope,
  "applications" | "programSheetLeads" | "creators" | "conversations" | "pageInfo" | "performance"
> {
  return {
    applications: [],
    programSheetLeads: [],
    creators: [],
    conversations: [],
    pageInfo: {
      applications: emptyPageInfo(),
      programSheetLeads: emptyPageInfo(),
      creators: emptyPageInfo(),
      conversations: emptyPageInfo(),
    },
    performance: {
      queryCount: 4,
      perRowReads: 0,
      documentReads: 0,
      documentReadUpperBound: 4 * (DASHBOARD_PIPELINE_CLIENT_LIMIT + 1),
      durationMs: 0,
    },
  };
}

function normalizePageInfo(value: unknown): DashboardPipelineProjectionPageInfo {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const numeric = (candidate: unknown, fallback: number) => (
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
      ? Math.trunc(candidate)
      : fallback
  );
  const hasMore = row.hasMore === true || row.truncated === true;
  return {
    limit: numeric(row.limit, DASHBOARD_PIPELINE_CLIENT_LIMIT),
    returned: numeric(row.returned, 0),
    scanned: numeric(row.scanned, 0),
    hasMore,
    truncated: hasMore,
    nextCursor: typeof row.nextCursor === "string" && row.nextCursor ? row.nextCursor : null,
  };
}

function normalizeProjection(response: DashboardPipelineProjectionEnvelope): ReturnType<typeof emptyProjection> {
  return {
    applications: Array.isArray(response.applications) ? response.applications : [],
    programSheetLeads: Array.isArray(response.programSheetLeads) ? response.programSheetLeads : [],
    creators: Array.isArray(response.creators) ? response.creators : [],
    conversations: Array.isArray(response.conversations) ? response.conversations : [],
    pageInfo: {
      applications: normalizePageInfo(response.pageInfo?.applications),
      programSheetLeads: normalizePageInfo(response.pageInfo?.programSheetLeads),
      creators: normalizePageInfo(response.pageInfo?.creators),
      conversations: normalizePageInfo(response.pageInfo?.conversations),
    },
    performance: response.performance,
  };
}

function errorMessage(_error: unknown): string {
  return "지원자 파이프라인을 불러오지 못했습니다.";
}

type DashboardPipelineProjectionState = ReturnType<typeof emptyProjection> & {
  authScopeKey: string | null;
  loading: boolean;
  settled: boolean;
  // Task-54 P1 (적대 리뷰): `settled` flips true the instant the first bounded page commits,
  // but continueDashboardPipelineHiddenPages then keeps mutating `conversations`/`pageInfo`
  // (up to `maxContinuations` more pages) in the background afterward. A consumer that gates
  // only on `settled` (e.g. the dashboard's human-review count) could observe settled=true
  // and still have its inputs change again once the hidden-page backfill lands. True for the
  // whole window between the first-page commit and the backfill's completion (success or
  // failure) so such a consumer can wait it out too.
  continuationInFlight: boolean;
  error: string;
};

function emptyProjectionState(
  authScopeKey: string | null,
  loading = false,
): DashboardPipelineProjectionState {
  return {
    ...emptyProjection(),
    authScopeKey,
    loading,
    settled: false,
    continuationInFlight: false,
    error: "",
  };
}

export function useDashboardPipelineProjection(enabled: boolean, authScopeKey: string | null) {
  const activeAuthScopeKey = enabled && authScopeKey ? authScopeKey : null;
  const [state, setState] = useState<DashboardPipelineProjectionState>(() => emptyProjectionState(null));
  const requestedScopeRef = useRef<string | null>(null);
  const requestVersionRef = useRef(0);

  // Flu conversation org-filter round 4 (codex adversarial review round 2, finding #3): without
  // this, a super_admin's viewAs preview of a restricted member received the CALLER's own
  // unrestricted scp conversations lane instead of the target's real, narrower scope — the server
  // (functions/dashboardPipelineProjection.ts) resolves and verifies this identity itself, but only
  // once the client actually sends it. authScopeKey (src/lib/live.tsx) already changes when viewAs
  // starts/stops, so this alone doesn't need to widen refresh's own trigger.
  const { role } = useRole();
  const { target: viewAsTarget, isViewingAs: viewAsFlagActive } = useViewAs();
  const isViewingAs = role === "super_admin" && viewAsFlagActive;
  const viewAsParams = useMemo(
    () => (isViewingAs && viewAsTarget ? { viewAsUserId: viewAsTarget.userId, viewAsEmail: viewAsTarget.email } : {}),
    [isViewingAs, viewAsTarget],
  );

  const refresh = useCallback(async () => {
    const requestScopeKey = activeAuthScopeKey;
    if (!requestScopeKey || requestedScopeRef.current !== requestScopeKey) return;
    const requestVersion = ++requestVersionRef.current;
    const requestIsCurrent = () => (
      requestVersion === requestVersionRef.current
      && requestScopeKey === requestedScopeRef.current
    );
    setState((previous) => {
      const scoped = previous.authScopeKey === requestScopeKey
        ? previous
        : emptyProjectionState(requestScopeKey);
      return { ...scoped, loading: true, error: "" };
    });
    try {
      const response = await getDashboardPipelineProjection({ limit: DASHBOARD_PIPELINE_CLIENT_LIMIT, ...viewAsParams });
      if (!requestIsCurrent()) return;
      const firstProjection = normalizeProjection(response);
      // Commit the first bounded page immediately. Hidden account rows are then
      // recovered in the background without holding the dashboard first paint.
      setState((previous) => previous.authScopeKey === requestScopeKey
        ? { ...previous, ...firstProjection, loading: false, settled: true, continuationInFlight: true }
        : previous);
      await continueDashboardPipelineHiddenPages({
        initial: firstProjection,
        fetchPage: async (payload) => normalizeProjection(await getDashboardPipelineProjection({ ...payload, ...viewAsParams })),
        shouldContinue: requestIsCurrent,
        onPage: (nextProjection) => {
          if (!requestIsCurrent()) return;
          setState((previous) => previous.authScopeKey === requestScopeKey
            ? { ...previous, ...nextProjection }
            : previous);
        },
      });
    } catch (loadError) {
      if (!requestIsCurrent()) return;
      setState((previous) => previous.authScopeKey === requestScopeKey
        ? { ...previous, error: errorMessage(loadError) }
        : previous);
    } finally {
      if (requestIsCurrent()) {
        setState((previous) => previous.authScopeKey === requestScopeKey
          ? { ...previous, loading: false, settled: true, continuationInFlight: false }
          : previous);
      }
    }
  }, [activeAuthScopeKey, viewAsParams]);

  useEffect(() => {
    if (!activeAuthScopeKey) {
      if (requestedScopeRef.current === null) return;
      requestVersionRef.current += 1;
      requestedScopeRef.current = null;
      setState(emptyProjectionState(null));
      return;
    }
    if (requestedScopeRef.current === activeAuthScopeKey) return;
    requestVersionRef.current += 1;
    requestedScopeRef.current = activeAuthScopeKey;
    setState(emptyProjectionState(activeAuthScopeKey, true));
    void refresh();
  }, [activeAuthScopeKey, refresh]);

  // Effects run after paint. Scope the returned value as well so old account rows, errors,
  // cursors and partial-page metadata are never exposed during the intervening render.
  const visibleState = activeAuthScopeKey && state.authScopeKey === activeAuthScopeKey
    ? state
    : emptyProjectionState(activeAuthScopeKey, activeAuthScopeKey !== null);

  return {
    applications: visibleState.applications,
    programSheetLeads: visibleState.programSheetLeads,
    creators: visibleState.creators,
    conversations: visibleState.conversations,
    pageInfo: visibleState.pageInfo,
    performance: visibleState.performance,
    loading: visibleState.loading,
    settled: visibleState.settled,
    continuationInFlight: visibleState.continuationInFlight,
    error: visibleState.error,
    refresh,
  };
}
