"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ensureOperationalSnapshotFresh,
  getOperationalSnapshot,
  type GetOperationalSnapshotEnvelope,
} from "@/lib/data";
import { canonicalScopeIdentity, publicCallableErrorMessage, useLive } from "@/lib/live";
import { useViewAs } from "@/lib/viewAs";
import {
  OPERATIONAL_SNAPSHOT_SCHEMA_VERSION,
  validateOperationalSnapshotV1,
  type OperationalSnapshotStatus,
  type OperationalSnapshotSurface,
  type OperationalSnapshotV1,
} from "@/lib/operational-snapshot";

type SnapshotCacheEntry = {
  snapshot: OperationalSnapshotV1;
};

type OperationalSnapshotPartialReason = "identity_conflict" | "alias_registry_fence_changed" | "source_truncated";
type OperationalSnapshotPartialDetails = {
  partialReasons?: OperationalSnapshotPartialReason[];
  conflictSummaries?: Array<Record<string, unknown>>;
};
type OperationalSnapshotWithPartialDetails = OperationalSnapshotV1 & OperationalSnapshotPartialDetails;

type SnapshotRequestIdentity = {
  scopeKey: string | null;
  surface: OperationalSnapshotSurface;
  authScopeGeneration: number;
  generation: number;
  requestKey: string | null;
};

type SnapshotViewState = {
  requestKey: string | null;
  snapshot: OperationalSnapshotV1 | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  found: boolean;
  requiresRebuild: boolean;
  requested: boolean;
  unavailable: boolean;
};

type UseOperationalSnapshotResult = {
  snapshot: OperationalSnapshotV1 | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  found: boolean;
  requiresRebuild: boolean;
  requested: boolean;
  refresh: () => Promise<void>;
};

const snapshotMemoryCache = new Map<string, SnapshotCacheEntry>();
type ResolvedSnapshotEnvelope = {
  found: boolean;
  requiresRebuild: boolean;
  snapshot: OperationalSnapshotV1 | null;
  unavailable: boolean;
};

const snapshotInFlight = new Map<string, Promise<GetOperationalSnapshotEnvelope>>();

// A newly deployed snapshot producer can take one scheduler interval to materialize its first
// document. A tab that observed found=false before that write previously stayed missing forever,
// because the server-side write cannot dispatch a browser event. Retry only that explicit missing
// state with a bounded backoff spanning one thirty-minute scheduler cadence, the producer's
// five-minute execution budget, and a recovery margin; errors continue to use the existing
// manual/visibility refresh path so an outage cannot create an unbounded poll loop.
// (스케줄 주기를 바꾸면 이 사다리 총합이 "주기 + 실행예산 + 여유"를 계속 덮는지 재산정할 것 —
// 회귀 pin: tests/operational-snapshot-callable.test.mjs "bounded cadence")
export const OPERATIONAL_SNAPSHOT_MISSING_RETRY_DELAYS_MS: readonly number[] = [
  5_000,
  10_000,
  20_000,
  40_000,
  ...Array.from({ length: 36 }, () => 60_000),
];

// W86-A [SWR]: stale/missing 문서를 관측하면 서버 재구축을 **유발만** 하고 기다리지 않는다.
//   재구축은 최대 ~35초라 await 하면 화면이 그만큼 멈춘다 — 계약은 "현재 문서 즉시 표시"다.
//   유발 후 한 번만 되읽어 새 문서를 집는다. 이 값이 재구축 예산보다 짧으면 옛 문서를 다시 읽어
//   무의미한 왕복이 되므로, 서버 리스 TTL(5분)보다는 짧고 재구축 실측(~35초)보다는 길게 잡는다.
export const OPERATIONAL_SNAPSHOT_REBUILD_SETTLE_MS = 45_000;

// 재방문 즉시 표시용 persisted 캐시 — 스냅샷은 서버에서 assertPiiSafeSnapshot으로
// PII-free가 강제된 집계 수치뿐이며, 읽을 때 validateOperationalSnapshotV1로 fail-closed
// 검증한다(파싱·스키마 실패 시 해당 키 제거). 키에 uid/role/scope가 포함되어 사용자 간
// 캐시가 섞이지 않는다. 저장 실패(쿼터·프라이빗 모드)는 조용히 메모리 캐시로 폴백한다.
// v1 used a delimiter-joined auth identity, so custom UID/team values could alias. Those entries
// cannot be migrated safely: v2 ignores them and waits for authenticated server evidence.
const SNAPSHOT_STORAGE_PREFIX = "flu.operational-snapshot.v3.super-admin-global:";

function readPersistedSnapshot(key: string): OperationalSnapshotV1 | null {
  if (typeof window === "undefined") return null;
  const storageKey = SNAPSHOT_STORAGE_PREFIX + key;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    return validateOperationalSnapshotV1(JSON.parse(raw));
  } catch {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // storage unavailable — memory cache still applies
    }
    return null;
  }
}

function persistSnapshot(key: string, snapshot: OperationalSnapshotV1): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SNAPSHOT_STORAGE_PREFIX + key, JSON.stringify(previousServerSnapshotWire(snapshot)));
  } catch {
    // quota/private mode — memory cache still applies
  }
}

function removePersistedSnapshot(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(SNAPSHOT_STORAGE_PREFIX + key);
  } catch {
    // storage unavailable — memory cache eviction still applies
  }
}

export function operationalSnapshotCacheKey(authScopeKey: string, surface: OperationalSnapshotSurface): string {
  return canonicalScopeIdentity("operational-snapshot-cache-v2", [authScopeKey, surface]);
}

function isNewerSnapshot(next: OperationalSnapshotV1, prev: OperationalSnapshotV1 | null): boolean {
  if (!prev) return true;
  if (next.snapshotVersion !== prev.snapshotVersion) return next.snapshotVersion > prev.snapshotVersion;
  return Date.parse(next.generatedAtIso) >= Date.parse(prev.generatedAtIso);
}

function snapshotRequiresRebuild(snapshot: OperationalSnapshotV1 | null, nowMs = Date.now()): boolean {
  return Boolean(snapshot && snapshotFreshnessState(snapshot, nowMs) !== "fresh");
}

function previousServerSnapshotWire(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const {
    requiresRebuild: _requiresRebuild,
    aliasRegistryRevision: _aliasRegistryRevision,
    producerAggregateVersion: _producerAggregateVersion,
    contentHash: _contentHash,
    partialReasons: _partialReasons,
    conflictSummaries: _conflictSummaries,
    ...publicSnapshot
  } = value as Record<string, unknown>;
  return publicSnapshot;
}

function partialDetailsFromWire(value: unknown): OperationalSnapshotPartialDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const allowed = new Set<OperationalSnapshotPartialReason>([
    "identity_conflict",
    "alias_registry_fence_changed",
    "source_truncated",
  ]);
  const partialReasons = Array.isArray(record.partialReasons)
    ? [...new Set(record.partialReasons.filter((item): item is OperationalSnapshotPartialReason => allowed.has(item as OperationalSnapshotPartialReason)))].sort()
    : [];
  const conflictSummaries = Array.isArray(record.conflictSummaries)
    ? record.conflictSummaries.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)).slice(0, 20)
    : [];
  return {
    ...(partialReasons.length > 0 ? { partialReasons } : {}),
    ...(conflictSummaries.length > 0 ? { conflictSummaries } : {}),
  };
}

function hasPreviousServerPersistenceProof(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.requiresRebuild === "boolean"
    && typeof record.aliasRegistryRevision === "string"
    && record.aliasRegistryRevision.length > 0
    && typeof record.producerAggregateVersion === "string"
    && record.producerAggregateVersion.length > 0
    && typeof record.contentHash === "string"
    && /^[a-f0-9]{40}$/.test(record.contentHash);
}

export function resolveOperationalSnapshotEnvelope(
  envelope: Pick<GetOperationalSnapshotEnvelope, "found" | "snapshot">
    & Partial<Pick<GetOperationalSnapshotEnvelope, "storedFound" | "requiresRebuild" | "unavailable">>,
  cached: OperationalSnapshotV1 | null,
): ResolvedSnapshotEnvelope {
  if (envelope.unavailable === true) {
    return { found: false, requiresRebuild: false, snapshot: null, unavailable: true };
  }
  // A missing materialized document is not a real zero-valued snapshot. Keep an older cached
  // snapshot available as a stale fallback while preserving the server's explicit absence state.
  // During a rolling deploy, the previous server can still report found=false for
  // a valid partial document. Accept only its exact persistence-proven shape; malformed fallback
  // zeroes have an empty content hash and remain missing.
  const previousServerFound = envelope.storedFound === true
    && hasPreviousServerPersistenceProof(envelope.snapshot);
  if (!envelope.found && !previousServerFound) {
    return { found: false, requiresRebuild: true, snapshot: cached, unavailable: false };
  }
  const next = {
    ...validateOperationalSnapshotV1(previousServerSnapshotWire(envelope.snapshot)),
    ...partialDetailsFromWire(envelope.snapshot),
  } as OperationalSnapshotWithPartialDetails;
  const snapshot = isNewerSnapshot(next, cached) ? next : cached;
  return {
    found: true,
    requiresRebuild: envelope.requiresRebuild === true || snapshotRequiresRebuild(snapshot),
    snapshot,
    unavailable: false,
  };
}

export function useOperationalSnapshot(surface: OperationalSnapshotSurface): UseOperationalSnapshotResult {
  const { authScopeKey, authScopeGeneration = 0, authReady, canRead, role } = useLive();
  const { isViewingAs: viewAsFlagActive } = useViewAs();
  const [view, setView] = useState<SnapshotViewState>({
    requestKey: null,
    snapshot: null,
    loading: true,
    refreshing: false,
    error: null,
    found: false,
    requiresRebuild: false,
    requested: false,
    unavailable: false,
  });
  const [freshnessRevision, setFreshnessRevision] = useState(0);
  const requestIdentityRef = useRef<SnapshotRequestIdentity>({
    scopeKey: null,
    surface,
    authScopeGeneration: 0,
    generation: 0,
    requestKey: null,
  });
  const missingRetryRef = useRef<{ requestKey: string | null; attempt: number }>({ requestKey: null, attempt: 0 });
  // W86-A: 이 요청 신원에서 트리거를 이미 쐈는지. 요청 신원이 바뀌면(스코프/서피스/재로그인)
  //   자동으로 초기화되므로, "한 번 실패하면 영영 안 쏜다"가 되지 않는다 — 다음 로드가 다시 쏜다
  //   (W85 의 "실패 1회 흡수" 원칙을 SWR 형태로 계승).
  const ensureFiredRef = useRef<{ requestKey: string | null; fired: boolean }>({ requestKey: null, fired: false });
  // Operational snapshots are global aggregate materializations. A scoped manager/admin/viewer, or
  // a super_admin currently using viewAs, must never read or retain the global payload/cache: their
  // live data path is ACL-scoped and the backend now returns no materialized snapshot for scoped
  // callers. Gate before cache lookup/request setup so auth/viewAs transitions fail closed in the
  // same paint and cannot schedule retry/ensure loops.
  const canUseGlobalSnapshot = role === "super_admin" && !viewAsFlagActive;
  const activeScopeKey = authReady && canRead && canUseGlobalSnapshot && authScopeKey ? authScopeKey : null;

  // Ref identity is aligned during render so an auth transition fails closed in the same paint,
  // before effects have an opportunity to clear state. The monotonically increasing generation
  // also prevents A1 from being reused when the operator moves A -> B -> A.
  if (
    requestIdentityRef.current.scopeKey !== activeScopeKey
    || requestIdentityRef.current.surface !== surface
    || requestIdentityRef.current.authScopeGeneration !== authScopeGeneration
  ) {
    const generation = requestIdentityRef.current.generation + 1;
    requestIdentityRef.current = {
      scopeKey: activeScopeKey,
      surface,
      authScopeGeneration,
      generation,
      requestKey: activeScopeKey
        ? canonicalScopeIdentity("operational-snapshot-view-v2", [
            activeScopeKey,
            surface,
            String(authScopeGeneration),
            String(generation),
          ])
        : null,
    };
  }
  const activeRequestIdentity = requestIdentityRef.current;
  const activeRequestKey = activeRequestIdentity.requestKey;
  const activeInFlightKey = activeScopeKey
    ? canonicalScopeIdentity("operational-snapshot-flight-v2", [activeScopeKey, surface, String(authScopeGeneration)])
    : null;

  const loadSnapshot = useCallback(async () => {
    if (!activeScopeKey || !activeRequestKey || !activeInFlightKey) {
      setView({
        requestKey: null,
        snapshot: null,
        loading: false,
        refreshing: false,
        error: null,
        found: false,
        requiresRebuild: false,
        requested: false,
        unavailable: false,
      });
      return;
    }
    const requestIdentity = activeRequestIdentity;
    const key = operationalSnapshotCacheKey(activeScopeKey, surface);
    const cached = snapshotMemoryCache.get(key)?.snapshot ?? readPersistedSnapshot(key);
    if (requestIdentityRef.current.requestKey !== requestIdentity.requestKey) return;
    setView({
      requestKey: requestIdentity.requestKey,
      snapshot: cached,
      loading: !cached,
      refreshing: Boolean(cached),
      error: null,
      found: Boolean(cached),
      requiresRebuild: snapshotRequiresRebuild(cached),
      requested: true,
      unavailable: false,
    });

    let request = snapshotInFlight.get(activeInFlightKey);
    if (!request) {
      request = getOperationalSnapshot({
        surface,
        acceptedSchemaVersions: [OPERATIONAL_SNAPSHOT_SCHEMA_VERSION],
      });
      snapshotInFlight.set(activeInFlightKey, request);
    }

    try {
      const envelope = await request;
      const next = resolveOperationalSnapshotEnvelope(envelope, cached);
      if (requestIdentityRef.current.requestKey !== requestIdentity.requestKey) return;
      if (next.unavailable) {
        snapshotMemoryCache.delete(key);
        removePersistedSnapshot(key);
      } else if (next.found && next.snapshot) {
        snapshotMemoryCache.set(key, { snapshot: next.snapshot });
        persistSnapshot(key, next.snapshot);
      }
      setView((current) => current.requestKey === requestIdentity.requestKey
        ? { ...current, snapshot: next.snapshot, found: next.found, requiresRebuild: next.requiresRebuild, unavailable: next.unavailable }
        : current);
    } catch (caught) {
      if (requestIdentityRef.current.requestKey !== requestIdentity.requestKey) return;
      setView((current) => current.requestKey === requestIdentity.requestKey
        ? {
            ...current,
            error: publicCallableErrorMessage(caught, "snapshot unavailable"),
            snapshot: current.snapshot ?? cached,
            found: Boolean(current.snapshot ?? cached),
            requiresRebuild: snapshotRequiresRebuild(current.snapshot ?? cached),
            unavailable: false,
          }
        : current);
    } finally {
      if (snapshotInFlight.get(activeInFlightKey) === request) snapshotInFlight.delete(activeInFlightKey);
      if (requestIdentityRef.current.requestKey === requestIdentity.requestKey) {
        setView((current) => current.requestKey === requestIdentity.requestKey
          ? { ...current, loading: false, refreshing: false }
          : current);
      }
    }
  }, [activeInFlightKey, activeRequestIdentity, activeRequestKey, activeScopeKey, surface]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  const refreshSnapshot = useCallback(async () => {
    missingRetryRef.current = { requestKey: activeRequestKey, attempt: 0 };
    await loadSnapshot();
  }, [activeRequestKey, loadSnapshot]);

  useEffect(() => {
    if (missingRetryRef.current.requestKey !== activeRequestKey) {
      missingRetryRef.current = { requestKey: activeRequestKey, attempt: 0 };
    }
    if (
      !activeRequestKey
      || view.requestKey !== activeRequestKey
      || !view.requested
      || view.loading
      || view.refreshing
      || view.error
      || view.unavailable
    ) return;
    if (view.found) {
      missingRetryRef.current.attempt = 0;
      return;
    }
    const delay = OPERATIONAL_SNAPSHOT_MISSING_RETRY_DELAYS_MS[missingRetryRef.current.attempt];
    if (delay === undefined) return;
    missingRetryRef.current.attempt += 1;
    const timer = window.setTimeout(() => {
      void loadSnapshot();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [activeRequestKey, loadSnapshot, view.error, view.found, view.loading, view.refreshing, view.requested, view.requestKey, view.unavailable]);

  // W86-A [SWR 트리거]: stale/missing 을 관측한 화면이 그 자리에서 서버 재구축을 유발한다.
  //   종전에는 30분 스케줄이 아무도 안 볼 때도 무조건 돌았고(48회/일), 화면은 그 결과를 읽기만 했다.
  //   이제 **보는 행위가 갱신을 만든다** — 비용이 사용량에 비례한다.
  //
  //   설계상 중요한 세 가지:
  //     ① await 하지 않는다. 재구축 ~35초를 기다리면 "즉시 표시" 계약이 깨진다.
  //     ② 실패를 삼킨다. 트리거는 편의 기능이고, 여기서 에러를 띄우면 멀쩡히 보이는 문서 위에
  //        관계없는 오류가 뜬다. 실패해도 문서는 여전히 stale 이므로 다음 로드가 다시 쏜다.
  //     ③ 서버가 stale 게이트·single-flight 를 모두 지므로 클라의 latch 는 **중복 호출 절약**일 뿐
  //        정확성 근거가 아니다(탭 N개가 동시에 쏴도 재구축은 1회).
  useEffect(() => {
    if (ensureFiredRef.current.requestKey !== activeRequestKey) {
      ensureFiredRef.current = { requestKey: activeRequestKey, fired: false };
    }
    if (
      !activeRequestKey
      || view.requestKey !== activeRequestKey
      || !view.requested
      || view.loading
      || view.refreshing
      || view.error
      || !view.requiresRebuild
      || ensureFiredRef.current.fired
    ) return;
    ensureFiredRef.current.fired = true;
    void ensureOperationalSnapshotFresh({ surface }).catch(() => undefined);
    // 되읽기 타이머는 **found-but-stale 일 때만** 건다.
    //   문서가 아예 없는(missing) 경우엔 위쪽 missing 사다리가 이미 5초부터 되읽고 있다 —
    //   여기서 하나 더 걸면 같은 일을 두 타이머가 하고 사다리의 예산 계산도 어긋난다.
    //   반대로 found-but-stale 은 staleAfterIso 가 이미 과거라 freshness 타이머가 걸리지 않으므로,
    //   이 되읽기가 없으면 재구축 결과를 다음 방문까지 못 본다.
    if (!view.found) return;
    const timer = window.setTimeout(() => {
      void loadSnapshot();
    }, OPERATIONAL_SNAPSHOT_REBUILD_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [
    activeRequestKey,
    loadSnapshot,
    surface,
    view.error,
    view.loading,
    view.refreshing,
    view.requested,
    view.requestKey,
    view.found,
    view.requiresRebuild,
  ]);

  useEffect(() => {
    if (!view.snapshot || view.requestKey !== activeRequestKey) return;
    const deadline = Date.parse(view.snapshot.staleAfterIso);
    const remaining = deadline - Date.now();
    if (!Number.isFinite(deadline) || remaining <= 0) return;
    const timer = window.setTimeout(
      () => setFreshnessRevision((value) => value + 1),
      Math.min(remaining + 50, 2_147_000_000),
    );
    return () => window.clearTimeout(timer);
  }, [activeRequestKey, freshnessRevision, view.requestKey, view.snapshot]);

  useEffect(() => {
    function onRefresh() {
      void refreshSnapshot();
    }
    function onVisible() {
      if (document.visibilityState === "visible") void refreshSnapshot();
    }
    window.addEventListener("flu:data-refresh", onRefresh);
    window.addEventListener("flu:operational-snapshot-refresh", onRefresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("flu:data-refresh", onRefresh);
      window.removeEventListener("flu:operational-snapshot-refresh", onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshSnapshot]);

  const viewIsCurrent = Boolean(activeRequestKey && view.requestKey === activeRequestKey);
  const visibleView: SnapshotViewState = viewIsCurrent
    ? view
    : {
        requestKey: activeRequestKey,
        snapshot: null,
        loading: Boolean(!authReady || activeScopeKey),
        refreshing: false,
        error: null,
        found: false,
        requiresRebuild: false,
        requested: false,
        unavailable: false,
      };

  return {
    snapshot: visibleView.snapshot,
    loading: visibleView.loading,
    refreshing: visibleView.refreshing,
    error: visibleView.error,
    found: visibleView.found,
    requiresRebuild: visibleView.requiresRebuild || snapshotRequiresRebuild(visibleView.snapshot),
    requested: visibleView.requested,
    refresh: refreshSnapshot,
  };
}

export function snapshotFreshnessState(
  snapshot: Pick<OperationalSnapshotV1, "status" | "staleAfterIso" | "completeness">,
  nowMs = Date.now(),
): OperationalSnapshotStatus {
  if (snapshot.status === "rebuilding") return "rebuilding";
  const staleAfterMs = Date.parse(snapshot.staleAfterIso);
  if (snapshot.status === "stale" || !Number.isFinite(staleAfterMs) || staleAfterMs <= nowMs) return "stale";
  if (snapshot.status === "partial" || snapshot.completeness.state === "truncated") return "partial";
  return "fresh";
}

export function snapshotFreshnessLabel(
  snapshot: OperationalSnapshotV1,
  refreshing: boolean,
  nowMs = Date.now(),
): string {
  const state = snapshotFreshnessState(snapshot, nowMs);
  if (refreshing || state === "rebuilding") return "스냅샷 동기화 중";
  if (state === "stale" && (snapshot.status === "partial" || snapshot.completeness.state === "truncated")) return "스냅샷 일부·오래됨";
  if (state === "partial") return "스냅샷 일부만 집계됨";
  if (state === "fresh") return "스냅샷 최신";
  return "스냅샷 오래됨";
}

export function snapshotFreshnessMeta(snapshot: OperationalSnapshotV1): string {
  const generated = new Date(snapshot.generatedAtIso).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
  const staleAfter = new Date(snapshot.staleAfterIso).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
  const partialReasons = (snapshot as OperationalSnapshotWithPartialDetails).partialReasons ?? [];
  const completeness = snapshot.completeness.state === "complete"
    ? partialReasonCopy(partialReasons, snapshot.status)
    : partialReasonCopy(partialReasons, snapshot.status, `일부 소스 제한 (${snapshot.completeness.truncatedSources.join(", ")})`);
  return `생성 ${generated} · 만료 ${staleAfter} · ${completeness}`;
}

function partialReasonCopy(
  reasons: OperationalSnapshotPartialReason[],
  status: OperationalSnapshotStatus,
  truncatedFallback?: string,
): string {
  if (reasons.includes("source_truncated")) return truncatedFallback ?? "일부 소스 제한";
  if (reasons.includes("alias_registry_fence_changed")) return "프로그램 별칭 변경으로 재집계 필요";
  if (reasons.includes("identity_conflict")) return "식별자 충돌 검토 필요";
  if (truncatedFallback) return truncatedFallback;
  return status === "partial" ? "일부 집계 검토 필요" : "전체 소스 집계";
}

export function __clearOperationalSnapshotMemoryForTests() {
  snapshotMemoryCache.clear();
  snapshotInFlight.clear();
}
