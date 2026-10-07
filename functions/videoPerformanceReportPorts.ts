// Real Firestore-backed port + read-callable handlers for the video-performance-settlement-report
// Wave-2 UI lane (.specs/spec_video_performance_settlement_report/spec.md §7 read callables). Wires
// ./videoPerformanceReportProjection.ts's pure projection functions to bounded, index-backed Firestore
// reads. This is the ONLY file in this lane allowed to touch Firestore directly.
//
// DECISION (documented): ./videoPerformanceReportProjection.ts exports one optional callable factory
// (`createVideoPerformanceLedgerCallable`), but its request/response shape does not match what
// src/lib/videoPerformanceData.ts (the client this integration must satisfy) actually sends/expects —
// the client always sends a required `period` window and expects every response wrapped in
// `{ ok: true, ... }`; the factory's own parser ignores `period` entirely and returns the bare page. It
// also has no factory at all for `getVideoPerformanceSummary`/`getVideoPerformanceDetail` (Wave-2 only
// built the ledger one). Rather than register a callable that silently drops the client's period filter,
// this file implements all three read callables directly against the SAME pure functions the Wave-2
// lane already proved (`listVideoPerformanceLedgerRows`, `summarizeVideoPerformance`, `projectRowDetail`,
// `clampPeriodToMaxWindow`, `assertCanReadVideoPerformance`) — no projection logic is reimplemented, only
// the period-aware request parsing + Firestore fetch + envelope wrapping that Wave-2's non-goals
// (`NO functions/index.ts wiring`) left for this lane.
//
// Bounded-by-construction: every Firestore query below is a PREFIX of one of the two composite indexes
// declared in ./videoPerformanceReportProjection.ts's REQUIRED_INDEX_SIGNATURES comment block (equality
// on `reportEligible` [+ `scope.enrollmentId` when scoped], ordered by `attentionRank`), `.limit(n)`
// always applied. Any additional filtering (programId/campaignId/country/period window/etc.) is applied
// AFTER that bounded fetch, purely in-memory, over the already-bounded row set — never as a second,
// wider Firestore query (spec §9.1: never client-constructed arbitrary-filter Firestore queries).
//
// [확인 필요] `measurementStartAt` has no independent source of truth wired anywhere in this codebase;
// this port passes the video's `publishedAt` as a conservative stand-in ("measurement window starts no
// earlier than publish") — never a fabricated/independent value. `diagnosticOnlyCounts`/`auditTimeline`
// have no source either and are always returned empty rather than fabricated.
import type { CallableRequest } from "firebase-functions/v2/https";
import { onCall } from "firebase-functions/v2/https";
import { adminDb } from "./firebaseAdmin";
import { toCallableResponse, toHttpsError } from "./callableErrorBoundary";
import {
  assertCanReadVideoPerformance,
  clampPeriodToMaxWindow,
  isReportEligible,
  listVideoPerformanceLedgerRows,
  projectRowDetail,
  summarizeVideoPerformance,
  type VideoPerformanceLedgerFilter,
  type VideoPerformanceLedgerPage,
  type VideoPerformanceLedgerSortKey,
  type VideoPerformanceReportRow,
  type VideoPerformanceRowDetail,
  type VideoPerformanceSummary,
} from "./videoPerformanceReportProjection";
import { ManagementReadModelError, type ManagementRole } from "./managementProfileTabsReadModels";
import {
  resolveCreatorCountryProjection,
  type CreatorCountryProjection,
} from "./creatorCountryProjection";
import {
  calculateViewCpmRewardMinor,
  getViewCpmPolicyForCountry,
} from "./scpDashboardSnapshotContract";
import { isOperationalFixtureRecord } from "./operationalFixtureProvenance";

type FirestoreDb = Pick<FirebaseFirestore.Firestore, "collection" | "getAll">;

const VIDEO_PERFORMANCE_COLLECTION = "video_performance_report_rows";
const CREATORS_COLLECTION = "creators";
const VIDEO_VIEW_ROLLUPS_COLLECTION = "video_view_rollups";
// 롤업 문서는 programId__campaignId 조합당 1건이다(운영 실측 3건). 상한을 두고 한 번만 읽는다.
const VIDEO_VIEW_ROLLUP_DOC_LIMIT = 25;
// 한 번의 getAll 에 넣을 문서 수 상한. 페이지 상한(500행)이 전부 서로 다른 크리에이터여도 2회면 끝난다.
const CREATOR_COUNTRY_BATCH_SIZE = 300;

function chunkIds(ids: readonly string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push([...ids.slice(index, index + size)]);
  }
  return chunks;
}
// Bounded fetch ceiling for the in-memory filter/sort/paginate step below — never an unbounded scan; a
// caller wanting more than this many report-eligible rows in one scope must narrow enrollmentId/period.
const VIDEO_PERFORMANCE_FETCH_LIMIT = 500;

export interface VideoPerformanceFetchScope {
  readonly enrollmentId?: string;
  readonly programId?: string;
}

// One bounded, index-backed fetch: equality on `reportEligible` (+ `scope.enrollmentId` when the caller
// scoped to one enrollment), ordered by `attentionRank` — a strict prefix of both declared composite
// indexes, never a wider/un-indexed query. `programId`-only scoping has no declared index prefix, so it
// is applied by the in-memory filter step downstream (rowMatchesFilter), never as a Firestore `where`.
// Returns `truncated: true` when the raw fetch hit VIDEO_PERFORMANCE_FETCH_LIMIT exactly (adversarial-
// review remediation, P3#10b) — the caller must surface this honestly rather than silently presenting a
// possibly-incomplete row set as the complete scope.
export interface VideoPerformanceRowsFetch {
  readonly rows: readonly VideoPerformanceReportRow[];
  readonly truncated: boolean;
}

async function fetchBoundedReportRows(
  db: FirestoreDb,
  scope: VideoPerformanceFetchScope,
  limit: number = VIDEO_PERFORMANCE_FETCH_LIMIT,
): Promise<VideoPerformanceRowsFetch> {
  let query: FirebaseFirestore.Query = db.collection(VIDEO_PERFORMANCE_COLLECTION);
  if (scope.enrollmentId) {
    query = query.where("scope.enrollmentId", "==", scope.enrollmentId);
  }
  // The bounded fetch MUST order by the FULL composite-index sort chain that is actually deployed
  // (reportEligible ↦ attentionRank ↦ metrics.measurementEndExclusive ↦ lastSyncedAt), not by
  // attentionRank alone. Ordering by attentionRank only made Firestore demand a distinct
  // (reportEligible, attentionRank, __name__) index that was never declared/deployed, so the live query
  // failed closed with gRPC 9 FAILED_PRECONDITION → callableErrorBoundary maps status 9 to
  // `failed-precondition` → the UI showed "요청을 처리할 수 없습니다" on 0.5.39 (root cause of the video-
  // performance surface outage; verified against prod: aligned query returns 0 rows, unaligned throws 9).
  // The extra sort keys never change the row SET (same reportEligible==true predicate) — they only make
  // the query a valid prefix of the deployed composite index; DEFAULT_SORT still re-sorts in memory.
  query = query
    .where("reportEligible", "==", true)
    .orderBy("attentionRank", "asc")
    .orderBy("metrics.measurementEndExclusive", "asc")
    .orderBy("lastSyncedAt", "desc")
    .limit(limit);
  const snapshot = await query.get();
  // 시드/픽스처 행은 정산 원장과 KPI 에 실제 실적처럼 섞이면 안 된다 — 검수·파트너 목록이
  // 이미 하는 것과 같은 필터다. (운영 실측: seed-0540-report-1 이 조회수 2,261 과 예상금액
  // 45 를 들고 원장·요약에 들어와 있었다.)
  const rows = snapshot.docs
    .filter((doc) => !isOperationalFixtureRecord(
      { id: doc.id, ...((doc.data() ?? {}) as Record<string, unknown>) },
      VIDEO_PERFORMANCE_COLLECTION,
    ))
    .map((doc) => doc.data() as VideoPerformanceReportRow);
  // truncated 는 원시 페치가 상한에 닿았는지를 말한다 — 필터 후 개수로 판단하면 잘림을 숨긴다.
  return { rows, truncated: snapshot.docs.length >= limit };
}

export interface VideoPerformanceReportPort {
  fetchRows(scope: VideoPerformanceFetchScope): Promise<VideoPerformanceRowsFetch>;
  fetchRowById(rowId: string): Promise<VideoPerformanceReportRow | null>;
  // 선택 메서드: 있으면 읽기 시점에 creators 등록 국가를 **참고용 별도 필드**로 붙인다. 정산 국가
  // (declared/verified/effective)는 건드리지 않는다. 없으면 국가 표시는 지금처럼 미확인으로 남는다.
  fetchCreatorCountries?(
    creatorIds: readonly string[],
  ): Promise<ReadonlyMap<string, CreatorCountryProjection>>;
  // 선택 메서드: 있으면 **측정창이 아직 열려 있는 행에 한해** 매시 갱신 롤업으로 조회수를 덮는다.
  // 닫힌 창(=마감된 행)은 절대 건드리지 않는다 — 확정된 금액이 조회할 때마다 흔들리면 안 된다.
  fetchViewRollups?(): Promise<ReadonlyMap<string, VideoViewRollupEntry>>;
}

export interface VideoViewRollupEntry {
  readonly totalViews: number;
  readonly latestDailyDeltaViews: number;
}

export function createFirestoreVideoPerformanceReportPort(db: FirestoreDb = adminDb): VideoPerformanceReportPort {
  return {
    fetchRows: (scope) => fetchBoundedReportRows(db, scope),
    async fetchRowById(rowId: string) {
      const doc = await db.collection(VIDEO_PERFORMANCE_COLLECTION).doc(rowId).get();
      if (!doc.exists) return null;
      return doc.data() as VideoPerformanceReportRow;
    },
    async fetchCreatorCountries(creatorIds: readonly string[]) {
      const resolved = new Map<string, CreatorCountryProjection>();
      if (creatorIds.length === 0) return resolved;
      // 배치 getAll — 행마다 순차 왕복하면 목록 조회가 크리에이터 수에 비례해 느려진다
      // (운영 실측 2026-07-27: 19명 순차 2,751ms vs 배치 217ms). 호출자가 이미 dedupe 한다.
      for (const idsChunk of chunkIds(creatorIds, CREATOR_COUNTRY_BATCH_SIZE)) {
        const docs = await db.getAll(
          ...idsChunk.map((creatorId) => db.collection(CREATORS_COLLECTION).doc(creatorId)),
        );
        for (const doc of docs) {
          if (!doc.exists) continue;
          resolved.set(doc.id, resolveCreatorCountryProjection(doc.data() ?? {}));
        }
      }
      return resolved;
    },
    async fetchViewRollups() {
      // 롤업은 programId__campaignId 단위 소수 문서다(운영 실측 3건). 문서 안의 videos 맵이
      // youtubeVideoId → 최신 조회수를 들고 있어 행마다 개별 조회를 하지 않는다.
      const snapshot = await db
        .collection(VIDEO_VIEW_ROLLUPS_COLLECTION)
        .limit(VIDEO_VIEW_ROLLUP_DOC_LIMIT)
        .get();
      const byVideoId = new Map<string, VideoViewRollupEntry>();
      for (const doc of snapshot.docs) {
        const videos = (doc.data() ?? {}).videos;
        if (!videos || typeof videos !== "object" || Array.isArray(videos)) continue;
        for (const [videoId, raw] of Object.entries(videos as Record<string, unknown>)) {
          if (!videoId || !raw || typeof raw !== "object") continue;
          const entry = raw as Record<string, unknown>;
          const totalViews = typeof entry.totalViews === "number" && Number.isFinite(entry.totalViews)
            ? Math.max(0, Math.trunc(entry.totalViews))
            : null;
          if (totalViews === null) continue;
          const delta = typeof entry.latestDailyDeltaViews === "number" && Number.isFinite(entry.latestDailyDeltaViews)
            ? Math.max(0, Math.trunc(entry.latestDailyDeltaViews))
            : 0;
          const existing = byVideoId.get(videoId);
          if (!existing || existing.totalViews < totalViews) {
            byVideoId.set(videoId, { totalViews, latestDailyDeltaViews: delta });
          }
        }
      }
      return byVideoId;
    },
  };
}

// 읽기 시점 파생: creators 에 등록된 국가를 `country.creatorRegion` + 출처 필드로 붙인다. 저장하지 않고,
// 정산 기준(countryForBasis)은 이 값을 읽지 않는다 — 레거시 값이 "검증된 국가"로 보이면 정산 근거가 오염된다.
async function withCreatorRegions(
  port: VideoPerformanceReportPort,
  rows: readonly VideoPerformanceReportRow[],
): Promise<readonly VideoPerformanceReportRow[]> {
  if (!port.fetchCreatorCountries || rows.length === 0) return rows;
  const creatorIds = [...new Set(rows.map((row) => row.creator.fluCreatorId).filter(Boolean))];
  if (creatorIds.length === 0) return rows;
  const byCreatorId = await port.fetchCreatorCountries(creatorIds);
  return rows.map((row) => {
    const resolved = byCreatorId.get(row.creator.fluCreatorId);
    if (!resolved?.code || !resolved.sourceField) return row;
    return {
      ...row,
      country: { ...row.country, creatorRegion: resolved.code, creatorRegionSource: resolved.sourceField },
    };
  });
}

// ---- 읽기 시점 정산 표시 파생 (저장 없음) ---------------------------------------------------------
//
// 정산 국가 근거는 verified → declared 두 가지뿐이다. `country.creatorRegion` 은 참고 표시 전용
// 필드이고 정산 근거로 새면 안 된다(videoPerformanceReportProjection.ts:194-196 불변식,
// videoPerformanceObservationCore spec §3.5). 두 근거가 모두 없으면 금액을 만들지 않는다 —
// 최저 티어로 값을 채우는 건 날조다.
export const DECLARED_COUNTRY_TIER_SUFFIX = " · 신고 국가 기준";

/** 측정창이 아직 열려 있는가. 닫힌 행의 조회수·금액은 다시 계산하지 않는다. */
function measurementWindowOpen(row: VideoPerformanceReportRow, nowIso: string): boolean {
  if (row.metrics.finalizedAt) return false;
  if (row.measurementState === "finalized" || row.measurementState === "invalidated") return false;
  return nowIso < row.metrics.measurementEndExclusive;
}

/** 정산 근거 국가. verified 우선, 없으면 declared. 둘 다 없으면 null(=금액 없음). */
function settlementCountryBasis(
  row: VideoPerformanceReportRow,
): { readonly code: string; readonly verified: boolean } | null {
  const verified = row.country.verified ?? "";
  if (verified) return { code: verified, verified: true };
  const declared = row.country.declared ?? "";
  if (declared) return { code: declared, verified: false };
  return null;
}

/**
 * 측정창이 열려 있는 행에만 매시 롤업 조회수를 덮는다.
 * - `eligibleViews` 가 이미 있으면 그 행은 정산 인정 조회수가 확정된 것이므로 건드리지 않는다.
 * - 닫힌 측정창은 마지막 동결값을 그대로 둔다.
 */
function applyLiveViewCounts(
  rows: readonly VideoPerformanceReportRow[],
  rollups: ReadonlyMap<string, VideoViewRollupEntry>,
  nowIso: string,
): readonly VideoPerformanceReportRow[] {
  if (rollups.size === 0) return rows;
  return rows.map((row) => {
    if (row.metrics.eligibleViews) return row;
    if (!measurementWindowOpen(row, nowIso)) return row;
    const rollup = rollups.get(row.video.youtubeVideoId);
    if (!rollup) return row;
    const totalViews = String(rollup.totalViews);
    const periodDeltaViews = String(rollup.latestDailyDeltaViews);
    if (row.metrics.totalViews === totalViews && row.metrics.periodDeltaViews === periodDeltaViews) return row;
    return { ...row, metrics: { ...row.metrics, totalViews, periodDeltaViews } };
  });
}

/**
 * 파이프라인이 저장한 rate/예상 금액이 있으면 그 값을 그대로 보여준다. 저장값이 없는 행에만
 * 국가별 CPM 정책(포털 계약과 같은 정본)으로 예상 금액을 계산한다.
 * 확정(fluCalculated)·지급(portalFinal) 금액과 정산 상태는 어느 경우에도 건드리지 않는다.
 */
function applyEstimatedSettlement(
  rows: readonly VideoPerformanceReportRow[],
): readonly VideoPerformanceReportRow[] {
  return rows.map((row) => {
    if (row.settlement.estimatedAmountMinor || row.rate) return row;
    if (row.settlement.fluCalculatedAmountMinor || row.settlement.portalFinalAmountMinor) return row;
    const basis = settlementCountryBasis(row);
    // 국가 근거가 없으면 금액도 티어도 만들지 않는다 — 화면은 "국가 확인 대기"로 표시한다.
    if (!basis) return row;
    const policy = getViewCpmPolicyForCountry(basis.code);
    const views = row.metrics.eligibleViews ?? row.metrics.totalViews;
    let estimatedAmountMinor: string;
    try {
      estimatedAmountMinor = calculateViewCpmRewardMinor(views, policy.cpmMicrosPerThousand);
    } catch {
      // 조회수가 정수 문자열이 아니면 금액을 지어내지 않는다.
      return row;
    }
    const tier = basis.verified ? policy.tierCode : `${policy.tierCode}${DECLARED_COUNTRY_TIER_SUFFIX}`;
    return {
      ...row,
      rate: { tier, cpmMicrosPerThousand: policy.cpmMicrosPerThousand, currency: "USD" },
      settlement: { ...row.settlement, estimatedAmountMinor },
    };
  });
}

/**
 * 요약 밴드와 원장 행이 같은 수를 말하도록, 두 콜러블 모두 **같은 행 집합에 같은 순서로** 이 파생을
 * 적용한다(페이지 단위가 아니라 기간 필터 직후). 여기서 갈리면 상단 합계와 아래 행이 어긋난다.
 */
async function withSettlementProjection(
  port: VideoPerformanceReportPort,
  rows: readonly VideoPerformanceReportRow[],
  nowIso: string,
): Promise<readonly VideoPerformanceReportRow[]> {
  const withRegions = await withCreatorRegions(port, rows);
  const rollups = port.fetchViewRollups && withRegions.length > 0
    ? await port.fetchViewRollups()
    : new Map<string, VideoViewRollupEntry>();
  return applyEstimatedSettlement(applyLiveViewCounts(withRegions, rollups, nowIso));
}

export interface VideoPerformanceAuthContext {
  readonly role: ManagementRole | null;
}

function resolveVideoPerformanceAuth(request: CallableRequest<unknown>): VideoPerformanceAuthContext {
  const token = request.auth?.token as Record<string, unknown> | undefined;
  const rawRole = token?.role;
  const role: ManagementRole | null =
    rawRole === "manager" || rawRole === "admin" || rawRole === "super_admin" ? (rawRole as ManagementRole) : null;
  return { role };
}

export interface VideoPerformancePeriodInput {
  readonly mode: "week" | "month" | "range";
  readonly from: string;
  readonly to: string;
}

function withinPeriod(row: VideoPerformanceReportRow, fromIso: string, toIso: string): boolean {
  return row.metrics.measurementEndExclusive >= fromIso && row.metrics.measurementEndExclusive <= toIso;
}

function rowsForRequestedPeriod(
  rows: readonly VideoPerformanceReportRow[],
  filter: VideoPerformanceLedgerFilter,
  fromIso: string,
  toIso: string,
): readonly VideoPerformanceReportRow[] {
  // An exact enrollment is the Partner detail's authoritative current-video scope, not a calendar
  // report query. Applying the UI's default current-week period after that exact bounded fetch hid
  // historical approved rows even though Videos resolved the same enrollment/current revision.
  if (filter.enrollmentId) return rows;
  return rows.filter((row) => withinPeriod(row, fromIso, toIso));
}

function parsePeriod(record: Record<string, unknown>): VideoPerformancePeriodInput {
  const period = (record.period ?? {}) as Record<string, unknown>;
  const mode = period.mode === "week" || period.mode === "month" || period.mode === "range" ? period.mode : "range";
  const from = typeof period.from === "string" ? period.from : new Date(0).toISOString();
  const to = typeof period.to === "string" ? period.to : new Date().toISOString();
  return { mode, from, to };
}

function parseFilter(record: Record<string, unknown>): VideoPerformanceLedgerFilter {
  return (record.filter && typeof record.filter === "object" ? (record.filter as VideoPerformanceLedgerFilter) : {}) ?? {};
}

// ---- getVideoPerformanceSummary --------------------------------------------------------------------

export interface GetVideoPerformanceSummaryConfig {
  readonly port: VideoPerformanceReportPort;
}

export function createGetVideoPerformanceSummaryHandler(
  config: GetVideoPerformanceSummaryConfig,
): (request: CallableRequest<unknown>) => Promise<{
  ok: true;
  summary: VideoPerformanceSummary;
  periodClamped: boolean;
  globalFetchTruncated: boolean;
}> {
  return async (request) => {
    try {
      const auth = resolveVideoPerformanceAuth(request);
      assertCanReadVideoPerformance(auth.role);
      const record = (request.data ?? {}) as Record<string, unknown>;
      const period = parsePeriod(record);
      const filter = parseFilter(record);
      const resolvedPeriod = clampPeriodToMaxWindow({ fromIso: period.from, toIso: period.to });
      const { rows, truncated: globalFetchTruncated } = await config.port.fetchRows({
        enrollmentId: filter.enrollmentId,
        programId: filter.programId,
      });
      const periodRows = await withSettlementProjection(
        config.port,
        rowsForRequestedPeriod(rows, filter, resolvedPeriod.fromIso, resolvedPeriod.toIso),
        new Date().toISOString(),
      );
      const summary = summarizeVideoPerformance(periodRows, filter);
      return toCallableResponse({
        ok: true as const,
        summary,
        periodClamped: resolvedPeriod.periodClamped,
        globalFetchTruncated,
      });
    } catch (err) {
      throw toHttpsError(err);
    }
  };
}

export function createGetVideoPerformanceSummaryCallable(config: GetVideoPerformanceSummaryConfig) {
  return onCall(createGetVideoPerformanceSummaryHandler(config));
}

// ---- listVideoPerformanceLedger -------------------------------------------------------------------

export interface ListVideoPerformanceLedgerConfig {
  readonly port: VideoPerformanceReportPort;
}

export function createListVideoPerformanceLedgerHandler(
  config: ListVideoPerformanceLedgerConfig,
): (request: CallableRequest<unknown>) => Promise<{ ok: true; globalFetchTruncated: boolean } & VideoPerformanceLedgerPage> {
  return async (request) => {
    try {
      const auth = resolveVideoPerformanceAuth(request);
      assertCanReadVideoPerformance(auth.role);
      const record = (request.data ?? {}) as Record<string, unknown>;
      const period = parsePeriod(record);
      const filter = parseFilter(record);
      const resolvedPeriod = clampPeriodToMaxWindow({ fromIso: period.from, toIso: period.to });
      const { rows, truncated: globalFetchTruncated } = await config.port.fetchRows({
        enrollmentId: filter.enrollmentId,
        programId: filter.programId,
      });
      // 요약 밴드와 같은 파생을 같은 행 집합에 먼저 적용한다(페이징 전) — 두 화면 값이 갈리지 않는다.
      const periodRows = await withSettlementProjection(
        config.port,
        rowsForRequestedPeriod(rows, filter, resolvedPeriod.fromIso, resolvedPeriod.toIso),
        new Date().toISOString(),
      );
      const cursor = typeof record.cursor === "string" ? record.cursor : null;
      const pageSize = typeof record.pageSize === "number" ? record.pageSize : undefined;
      const sort = Array.isArray(record.sort) ? (record.sort as VideoPerformanceLedgerSortKey[]) : undefined;
      const page = listVideoPerformanceLedgerRows(periodRows, filter, { cursor, limit: pageSize }, sort);
      return toCallableResponse({ ok: true as const, globalFetchTruncated, ...page, rows: [...page.rows] });
    } catch (err) {
      throw toHttpsError(err);
    }
  };
}

export function createListVideoPerformanceLedgerCallable(config: ListVideoPerformanceLedgerConfig) {
  return onCall(createListVideoPerformanceLedgerHandler(config));
}

// ---- getVideoPerformanceDetail --------------------------------------------------------------------

export interface GetVideoPerformanceDetailConfig {
  readonly port: VideoPerformanceReportPort;
}

export function createGetVideoPerformanceDetailHandler(
  config: GetVideoPerformanceDetailConfig,
): (request: CallableRequest<unknown>) => Promise<{ ok: true; detail: VideoPerformanceRowDetail }> {
  return async (request) => {
    try {
      const auth = resolveVideoPerformanceAuth(request);
      assertCanReadVideoPerformance(auth.role);
      const record = (request.data ?? {}) as Record<string, unknown>;
      const rowId = typeof record.rowId === "string" ? record.rowId : "";
      if (!rowId) {
        throw new ManagementReadModelError("invalid-argument", "rowId is required", false);
      }
      const row = await config.port.fetchRowById(rowId);
      if (!row || !isReportEligible(row)) {
        throw new ManagementReadModelError("failed-precondition", "video_performance_row_not_found", false);
      }
      const nowIso = new Date().toISOString();
      const [rowWithRegion = row] = await withSettlementProjection(config.port, [row], nowIso);
      const detail = projectRowDetail({
        row: rowWithRegion,
        measurementStartAt: row.video.publishedAt,
        nowIso,
        diagnosticOnlyCounts: [],
        auditTimeline: [],
      });
      return toCallableResponse({ ok: true as const, detail });
    } catch (err) {
      throw toHttpsError(err);
    }
  };
}

export function createGetVideoPerformanceDetailCallable(config: GetVideoPerformanceDetailConfig) {
  return onCall(createGetVideoPerformanceDetailHandler(config));
}
