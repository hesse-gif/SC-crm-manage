// Bounded server projection helpers for the video-performance-settlement-report Wave-2 UI lane
// (.specs/spec_video_performance_settlement_report/spec.md §4 page composition, §5 report row projection,
// §12/§2 access control). Pure logic ONLY: this module never touches Firestore/network directly — it
// composes the Wave-1 pure core (./videoPerformanceObservationCore) and reuses the proven
// cursor/scope/envelope primitives from ./managementProfileTabsReadModels so bounded pagination, current-
// revision-only filtering, and estimate/final separation are never re-derived ad hoc.
//
// Scope (Wave-2 UI-projection lane — see task non-goals):
//   - NO functions/index.ts wiring (the optional callable factory below is exported but NEVER registered).
//   - NO firestore.indexes.json edits — REQUIRED_INDEX_SIGNATURES below documents the shape the
//     integration leader must add, mirroring ./managementProfileTabsReadModels's REQUIRED_FIRESTORE_...
//     comment-block pattern.
//   - NO Portal delivery activation and NO Flu-originated payable/paid authority: every settlement amount
//     this module surfaces is either an `estimated`/`fluCalculated` value (pre-Portal, always labeled) or a
//     `portalFinal` value that can ONLY be non-null when a Portal receipt is actually present
//     (`assertNoFluOriginatedPayableTransition` from the core module is used unmodified, never re-derived).
//
// [확인 필요] markers preserved verbatim from the spec, held open, never invented:
//   - 운영 기본 조회 기간(§4.2 필터 표): "최대 조회 구간 [확인 필요: 운영 기본 90일 여부]". Until that policy
//     is confirmed, DEFAULT_PERIOD_WINDOW_DAYS below implements a CONSERVATIVE bounded default of 90 days
//     and clampPeriodToMaxWindow() below NEVER allows an unbounded query — it clamps to that same 90-day
//     ceiling and reports `periodClamped: true` rather than silently widening scope.
//   - viewer 읽기 권한(spec §2 access table row 1: "정책상 허용 시 읽기 전용" — no confirmed activation
//     condition is given). Fail-closed: assertCanReadVideoPerformance() below requires manager+ and does
//     NOT grant viewer access; a future policy activation is a separate, explicit change, not an inference
//     made here.
//   - manual evidence override authority (spec §2 access table row 4: "[확인 필요: admin 허용 여부]").
//     assertManualEvidenceOverrideAllowed() below ALWAYS throws — there is no code path in this lane that
//     can ever authorize a manual override, regardless of role.
import { onCall, type CallableRequest } from "firebase-functions/v2/https";
import type { CreatorCountrySourceField } from "./creatorCountryProjection";

import {
  assertNoFluOriginatedPayableTransition,
  calculateAmountMinor,
  deriveDisplayAmounts,
  isUIntString,
  type CountryEvidenceState,
  type DisplayAmounts,
  type IsoCountryCode,
  type IsoInstant,
  type MeasurementState,
  type MoneyMinorString,
  type SettlementDisplayState,
  type UIntString,
} from "./videoPerformanceObservationCore";

import {
  assertRoleAtLeast,
  buildCursorPage,
  ManagementReadModelError,
  resolveCursorPageRequest,
  type CursorPage,
  type CursorPageRequest,
  type ManagementRole,
} from "./managementProfileTabsReadModels";

// ---------------------------------------------------------------------------------------------------
// REQUIRED_INDEX_SIGNATURES (for the integration leader to add to firestore.indexes.json — this lane
// does NOT edit that file per its non-goals; spec §9.2 minimum index shapes, restricted to the subset
// this lane's queries actually need).
// ---------------------------------------------------------------------------------------------------
/*
[
  {
    "collectionGroup": "video_performance_report_rows",
    "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "reportEligible", "order": "ASCENDING" },
      { "fieldPath": "attentionRank", "order": "ASCENDING" },
      { "fieldPath": "metrics.measurementEndExclusive", "order": "ASCENDING" },
      { "fieldPath": "lastSyncedAt", "order": "DESCENDING" }
    ]
  },
  {
    "collectionGroup": "video_performance_report_rows",
    "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "scope.enrollmentId", "order": "ASCENDING" },
      { "fieldPath": "reportEligible", "order": "ASCENDING" },
      { "fieldPath": "attentionRank", "order": "ASCENDING" },
      { "fieldPath": "metrics.measurementEndExclusive", "order": "ASCENDING" },
      { "fieldPath": "lastSyncedAt", "order": "DESCENDING" }
    ]
  }
]
*/

// ---- §3.3 tracking state (not modeled by the Wave-1 core; owned by this report-projection lane) -------

export type TrackingState =
  | "not_eligible"
  | "registration_pending"
  | "active"
  | "stale"
  | "source_diverged"
  | "temporarily_failed"
  | "unavailable"
  | "cutoff_reached"
  | "retired_superseded"
  | "retired_withdrawn";

// ---- §4.2 bounded period window (default clamp, [확인 필요: 운영 기본 90일 여부]) ------------------------

export const DEFAULT_PERIOD_WINDOW_DAYS = 90 as const;
export const PERIOD_WINDOW_POLICY_NOTE =
  "[확인 필요: 운영 기본 90일 여부] — conservative bounded default until business policy confirms the operational max query period.";

export type PeriodWindowRequest = Readonly<{ fromIso: IsoInstant; toIso: IsoInstant }>;

export type ResolvedPeriodWindow = Readonly<{
  fromIso: IsoInstant;
  toIso: IsoInstant;
  periodClamped: boolean;
  maxWindowDays: number;
}>;

// NEVER returns an unbounded window: a caller-requested range wider than DEFAULT_PERIOD_WINDOW_DAYS is
// clamped (never rejected-then-silently-widened, never passed through as-is) and `periodClamped: true`
// is surfaced so the UI/coverage projection can disclose the clamp rather than hide it.
export function clampPeriodToMaxWindow(
  request: PeriodWindowRequest,
  maxWindowDays: number = DEFAULT_PERIOD_WINDOW_DAYS,
): ResolvedPeriodWindow {
  const from = new Date(request.fromIso);
  const to = new Date(request.toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to.getTime() < from.getTime()) {
    throw new ManagementReadModelError("invalid-argument", "video_performance_invalid_filter", false);
  }
  const maxWindowMs = maxWindowDays * 24 * 60 * 60 * 1000;
  const spanMs = to.getTime() - from.getTime();
  if (spanMs <= maxWindowMs) {
    return { fromIso: request.fromIso, toIso: request.toIso, periodClamped: false, maxWindowDays };
  }
  const clampedFrom = new Date(to.getTime() - maxWindowMs);
  return { fromIso: clampedFrom.toISOString(), toIso: request.toIso, periodClamped: true, maxWindowDays };
}

// ---- §2 access control (fail-closed; viewer activation condition unresolved — see header note) -------

export type VideoPerformanceAction = "read" | "requestRefresh" | "openSettlementReview" | "exportCsv";

const ACTION_MIN_ROLE: Readonly<Record<VideoPerformanceAction, ManagementRole>> = {
  read: "manager",
  requestRefresh: "manager",
  openSettlementReview: "manager",
  exportCsv: "manager",
};

export function assertCanReadVideoPerformance(role: ManagementRole | null | undefined): void {
  assertRoleAtLeast(role, ACTION_MIN_ROLE.read);
}

export function assertVideoPerformanceActionAllowed(
  role: ManagementRole | null | undefined,
  action: VideoPerformanceAction,
): void {
  assertRoleAtLeast(role, ACTION_MIN_ROLE[action]);
}

// Manual evidence override authority is an OPEN policy item (spec §2: "[확인 필요: admin 허용 여부]").
// This function NEVER authorizes it, for any role — resolving that policy is out of this lane's scope.
export function assertManualEvidenceOverrideAllowed(_role: ManagementRole | null | undefined): never {
  throw new ManagementReadModelError(
    "failed-precondition",
    "video_performance_manual_override_policy_unresolved",
    false,
  );
}

// ---- §5.7 report row projection (subset this lane materializes into the UI) ---------------------------

export interface VideoPerformanceReportRow {
  readonly rowId: string; // metricKey
  readonly isCurrentRevision: boolean;
  readonly isApproved: boolean;
  readonly creator: { readonly fluCreatorId: string; readonly displayName: string; readonly handle: string; readonly profileImageUrl?: string };
  readonly scope: { readonly enrollmentId: string; readonly programId: string; readonly programName: string; readonly campaignId?: string; readonly campaignName?: string };
  readonly video: {
    readonly videoSubmissionId: string;
    readonly youtubeVideoId: string;
    readonly canonicalUrl: string;
    readonly title: string;
    readonly thumbnailUrl?: string;
    readonly channelTitle?: string;
    readonly publishedAt: IsoInstant;
    readonly revision: string;
  };
  readonly country: {
    readonly declared?: IsoCountryCode;
    readonly verified?: IsoCountryCode;
    readonly effective?: IsoCountryCode;
    readonly state: CountryEvidenceState;
    // 정산 근거가 아닌 참고 표시용 — creators 문서에 등록된 국가를 읽기 시점에 붙인다(저장하지 않는다).
    // countryForBasis 는 이 값을 절대 읽지 않는다: declared/verified/effective 로 새면 정산 국가가 오염된다.
    readonly creatorRegion?: IsoCountryCode;
    readonly creatorRegionSource?: CreatorCountrySourceField;
  };
  readonly metrics: {
    readonly totalViews: UIntString;
    readonly periodDeltaViews: UIntString;
    readonly eligibleViews?: UIntString;
    readonly excludedViews?: UIntString;
    readonly measurementEndExclusive: IsoInstant;
    readonly finalizedAt?: IsoInstant;
    readonly lastObservedAt?: IsoInstant;
  };
  readonly rate?: { readonly tier: string; readonly cpmMicrosPerThousand: UIntString; readonly currency: "USD" };
  readonly settlement: {
    readonly state: SettlementDisplayState;
    readonly estimatedAmountMinor?: MoneyMinorString;
    readonly fluCalculatedAmountMinor?: MoneyMinorString;
    readonly portalFinalAmountMinor?: MoneyMinorString;
    readonly hasPortalReceipt: boolean;
  };
  readonly trackingState: TrackingState;
  readonly measurementState: MeasurementState;
  readonly attentionCodes: readonly string[];
  readonly attentionRank: number;
  readonly lastSyncedAt: IsoInstant;
}

// ---- current-revision-only + report-eligibility gating (spec §3.1 hard invariant #1) -------------------

// Only current, non-superseded/withdrawn, approved revisions can ever be `reportEligible`. This is the
// SAME predicate everywhere in this module (summary, ledger, detail) — never re-derived per call site, so
// a previous-revision row can never sneak into an aggregate through one path while being excluded by
// another.
export function isReportEligible(row: VideoPerformanceReportRow): boolean {
  return row.isCurrentRevision === true && row.isApproved === true;
}

// ---- §4.2 filters ----------------------------------------------------------------------------------

export interface VideoPerformanceLedgerFilter {
  readonly enrollmentId?: string;
  readonly programId?: string;
  readonly campaignId?: string;
  readonly countryBasis?: "declared" | "verified" | "effective";
  readonly countryCode?: IsoCountryCode;
  readonly trackingStates?: readonly TrackingState[];
  readonly settlementStates?: readonly SettlementDisplayState[];
  readonly includeExcludedRevisions?: boolean;
}

function countryForBasis(row: VideoPerformanceReportRow, basis: "declared" | "verified" | "effective"): string | undefined {
  if (basis === "declared") return row.country.declared;
  if (basis === "verified") return row.country.verified;
  return row.country.effective ?? row.country.declared;
}

// Server-side filter application ONLY — never a hint for a client-constructed Firestore query (spec §9.1:
// "arbitrary multi-filter 조합을 client가 직접 Firestore query로 만들지 않습니다"). `includeExcludedRevisions`
// only reveals previous-revision rows for audit visibility; it NEVER re-includes them in any aggregate
// (enforced separately by isReportEligible/summarizeVideoPerformance, not by this predicate).
export function rowMatchesFilter(row: VideoPerformanceReportRow, filter: VideoPerformanceLedgerFilter): boolean {
  if (!filter.includeExcludedRevisions && !isReportEligible(row)) return false;
  if (filter.enrollmentId && row.scope.enrollmentId !== filter.enrollmentId) return false;
  if (filter.programId && row.scope.programId !== filter.programId) return false;
  if (filter.campaignId && row.scope.campaignId !== filter.campaignId) return false;
  if (filter.countryCode) {
    const basis = filter.countryBasis ?? "effective";
    if (countryForBasis(row, basis) !== filter.countryCode) return false;
  }
  if (filter.trackingStates && filter.trackingStates.length > 0 && !filter.trackingStates.includes(row.trackingState)) return false;
  if (filter.settlementStates && filter.settlementStates.length > 0 && !filter.settlementStates.includes(row.settlement.state)) return false;
  return true;
}

// ---- §4.3 summary band -------------------------------------------------------------------------------

export interface VideoPerformanceSummary {
  readonly totalViews: string;
  readonly periodDeltaViews: string;
  readonly eligibleViews: string;
  readonly cutoffPendingCount: number;
  readonly settlementConfirmedAmountMinor: string;
  readonly coverage: {
    readonly complete: boolean;
    readonly excludedRowCount: number;
    readonly excludedReasons: readonly string[];
  };
}

function sumUint(values: readonly (UIntString | undefined)[]): string {
  let total = 0n;
  for (const value of values) {
    if (isUIntString(value)) total += BigInt(value);
  }
  return total.toString();
}

// Aggregate-only: never scans/joins beyond the already-bounded `rows` slice the caller supplies (spec
// §9.3: "summary: precomputed document O(1), raw row scan 금지" — this pure function itself has no I/O,
// so the store-layer caller is the one responsible for supplying a bounded/precomputed row set, never an
// unbounded collection read).
export function summarizeVideoPerformance(
  rows: readonly VideoPerformanceReportRow[],
  filter: VideoPerformanceLedgerFilter = {},
): VideoPerformanceSummary {
  const excludedReasons: string[] = [];
  let excludedRowCount = 0;
  const included: VideoPerformanceReportRow[] = [];
  for (const row of rows) {
    if (!isReportEligible(row)) {
      excludedRowCount += 1;
      if (!excludedReasons.includes("previous_revision_excluded")) excludedReasons.push("previous_revision_excluded");
      continue;
    }
    if (!rowMatchesFilter(row, { ...filter, includeExcludedRevisions: false })) continue;
    if (row.measurementState === "conflict" || row.trackingState === "stale" || row.trackingState === "temporarily_failed") {
      excludedRowCount += 1;
      if (!excludedReasons.includes("stale_or_conflict_excluded")) excludedReasons.push("stale_or_conflict_excluded");
      continue;
    }
    included.push(row);
  }
  const settlementConfirmedRows = included.filter((row) => row.settlement.hasPortalReceipt && row.settlement.portalFinalAmountMinor);
  return {
    totalViews: sumUint(included.map((row) => row.metrics.totalViews)),
    periodDeltaViews: sumUint(included.map((row) => row.metrics.periodDeltaViews)),
    eligibleViews: sumUint(included.map((row) => row.metrics.eligibleViews)),
    cutoffPendingCount: included.filter((row) => row.measurementState !== "finalized" && row.measurementState !== "invalidated").length,
    settlementConfirmedAmountMinor: sumUint(settlementConfirmedRows.map((row) => row.settlement.portalFinalAmountMinor)),
    coverage: { complete: excludedRowCount === 0, excludedRowCount, excludedReasons },
  };
}

// ---- §4.6 bounded ledger (grouped rows + filters + sort + cursor) --------------------------------------

export type VideoPerformanceLedgerSortKey = "attentionRankAsc" | "measurementEndExclusiveAsc" | "lastSyncedAtDesc";

const DEFAULT_SORT: readonly VideoPerformanceLedgerSortKey[] = ["attentionRankAsc", "measurementEndExclusiveAsc", "lastSyncedAtDesc"];

function compareRows(a: VideoPerformanceReportRow, b: VideoPerformanceReportRow, sort: readonly VideoPerformanceLedgerSortKey[]): number {
  for (const key of sort) {
    if (key === "attentionRankAsc" && a.attentionRank !== b.attentionRank) return a.attentionRank - b.attentionRank;
    if (key === "measurementEndExclusiveAsc" && a.metrics.measurementEndExclusive !== b.metrics.measurementEndExclusive) {
      return a.metrics.measurementEndExclusive < b.metrics.measurementEndExclusive ? -1 : 1;
    }
    if (key === "lastSyncedAtDesc" && a.lastSyncedAt !== b.lastSyncedAt) {
      return a.lastSyncedAt > b.lastSyncedAt ? -1 : 1;
    }
  }
  return a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0;
}

function ledgerRowCursor(row: VideoPerformanceReportRow): string {
  return Buffer.from(`${row.attentionRank}|${row.metrics.measurementEndExclusive}|${row.lastSyncedAt}|${row.rowId}`, "utf8").toString("base64url");
}

export interface VideoPerformanceGroupSubtotal {
  readonly programId: string;
  readonly campaignId?: string;
  readonly rowCount: number;
  readonly totalViews: string;
  readonly eligibleViews: string;
}

export interface VideoPerformanceLedgerPage extends CursorPage<VideoPerformanceReportRow> {
  readonly groupSubtotals: readonly VideoPerformanceGroupSubtotal[];
}

// Bounded, deterministic pagination over an already-fetched (bounded) row set: `resolveCursorPageRequest`
// clamps limit into [MIN_PAGE_SIZE, MAX_PAGE_SIZE] and `buildCursorPage` fails closed if the caller ever
// supplies more than `limit + 1` rows (never silently truncated further, never scanned unbounded). The
// cursor itself is a deterministic encoding of the LAST row's sort key, so replaying the same cursor
// against the same filtered+sorted row set always resumes at the exact same position.
export function listVideoPerformanceLedgerRows(
  rows: readonly VideoPerformanceReportRow[],
  filter: VideoPerformanceLedgerFilter,
  cursorRequest: CursorPageRequest | undefined,
  sort: readonly VideoPerformanceLedgerSortKey[] = DEFAULT_SORT,
): VideoPerformanceLedgerPage {
  const { cursor, limit } = resolveCursorPageRequest(cursorRequest);
  const filtered = rows.filter((row) => rowMatchesFilter(row, filter)).slice().sort((a, b) => compareRows(a, b, sort));

  let startIndex = 0;
  if (cursor) {
    const foundIndex = filtered.findIndex((row) => ledgerRowCursor(row) === cursor);
    if (foundIndex === -1) {
      throw new ManagementReadModelError("invalid-argument", "video_performance_cursor_invalid", false);
    }
    startIndex = foundIndex + 1;
  }
  const windowRows = filtered.slice(startIndex, startIndex + limit + 1);
  const page = buildCursorPage(windowRows, limit, ledgerRowCursor);

  // group subtotals cover ONLY the rows rendered on this page (spec §4.6: "program → campaign → row
  // grouping은 한 페이지에 존재하는 group만 렌더하되 summary는 전체 필터 범위입니다") — the caller's separate
  // summarizeVideoPerformance() call remains the full-range authority, never this page-local subtotal.
  const subtotalKey = (row: VideoPerformanceReportRow) => `${row.scope.programId}::${row.scope.campaignId ?? ""}`;
  const subtotals = new Map<string, VideoPerformanceGroupSubtotal>();
  for (const row of page.rows) {
    const key = subtotalKey(row);
    const existing = subtotals.get(key);
    const totalViews = (BigInt(existing?.totalViews ?? "0") + BigInt(isUIntString(row.metrics.totalViews) ? row.metrics.totalViews : "0")).toString();
    const eligibleViews = (BigInt(existing?.eligibleViews ?? "0") + BigInt(isUIntString(row.metrics.eligibleViews) ? row.metrics.eligibleViews! : "0")).toString();
    subtotals.set(key, {
      programId: row.scope.programId,
      campaignId: row.scope.campaignId,
      rowCount: (existing?.rowCount ?? 0) + 1,
      totalViews,
      eligibleViews,
    });
  }
  return { ...page, groupSubtotals: [...subtotals.values()] };
}

// ---- §4.7 row detail projection (audit timeline / measurement window / country evidence) --------------

export interface VideoPerformanceRowDetail {
  readonly row: VideoPerformanceReportRow;
  readonly measurementWindow: {
    readonly publishedAt: IsoInstant;
    readonly measurementStartAt: IsoInstant;
    readonly measurementEndExclusive: IsoInstant;
    readonly finalizedAt?: IsoInstant;
    readonly cutoffReached: boolean;
  };
  readonly countryEvidence: {
    readonly declared?: IsoCountryCode;
    readonly verified?: IsoCountryCode;
    readonly effective?: IsoCountryCode;
    readonly state: CountryEvidenceState;
    // 참고 표시 전용(정산 근거 아님) — 출처 필드와 함께만 노출한다.
    readonly creatorRegion?: IsoCountryCode;
    readonly creatorRegionSource?: CreatorCountrySourceField;
  };
  readonly displayAmounts: DisplayAmounts;
  // Diagnostic-only counts (e.g. creator-submitted/manual view claims) are NEVER settlement math inputs —
  // they are surfaced here purely for operator diagnosis and are always explicitly labeled as such.
  readonly diagnosticOnlyCounts: readonly { readonly kind: "submitted" | "manual"; readonly views: UIntString; readonly note?: string }[];
  readonly auditTimeline: readonly { readonly at: IsoInstant; readonly code: string; readonly detail?: string }[];
}

export interface RowDetailInput {
  readonly row: VideoPerformanceReportRow;
  readonly measurementStartAt: IsoInstant;
  readonly nowIso: IsoInstant;
  readonly diagnosticOnlyCounts?: readonly { readonly kind: "submitted" | "manual"; readonly views: UIntString; readonly note?: string }[];
  readonly auditTimeline?: readonly { readonly at: IsoInstant; readonly code: string; readonly detail?: string }[];
}

// Strictly separates estimate vs Flu-calculated vs Portal-final (deriveDisplayAmounts from the Wave-1 core
// is reused unmodified — this lane never re-implements that separation). `hasPortalReceipt=false` is
// asserted against every settlement-gated state before this projection is built, so a caller cannot end up
// displaying a Portal-only state without an actual receipt (assertNoFluOriginatedPayableTransition throws
// otherwise, mirroring the core module's own fail-closed guard).
export function projectRowDetail(input: RowDetailInput): VideoPerformanceRowDetail {
  if (!assertNoFluOriginatedPayableTransition(input.row.settlement.hasPortalReceipt, input.row.settlement.state)) {
    throw new ManagementReadModelError("failed-precondition", "portal_settlement_receipt_missing", false);
  }
  return {
    row: input.row,
    measurementWindow: {
      publishedAt: input.row.video.publishedAt,
      measurementStartAt: input.measurementStartAt,
      measurementEndExclusive: input.row.metrics.measurementEndExclusive,
      finalizedAt: input.row.metrics.finalizedAt,
      cutoffReached: input.nowIso >= input.row.metrics.measurementEndExclusive,
    },
    countryEvidence: {
      declared: input.row.country.declared,
      verified: input.row.country.verified,
      effective: input.row.country.effective,
      state: input.row.country.state,
      ...(input.row.country.creatorRegion && input.row.country.creatorRegionSource
        ? {
            creatorRegion: input.row.country.creatorRegion,
            creatorRegionSource: input.row.country.creatorRegionSource,
          }
        : {}),
    },
    displayAmounts: deriveDisplayAmounts({
      estimatedAmountMinor: input.row.settlement.estimatedAmountMinor,
      fluCalculatedAmountMinor: input.row.settlement.fluCalculatedAmountMinor,
      portalFinalAmountMinor: input.row.settlement.portalFinalAmountMinor,
    }),
    diagnosticOnlyCounts: input.diagnosticOnlyCounts ?? [],
    auditTimeline: input.auditTimeline ?? [],
  };
}

export { calculateAmountMinor };

// ---- optional callable factory (spec §7 read callables) — UNWIRED, exported for the integration leader --

export interface VideoPerformanceLedgerRequestData {
  readonly filter?: VideoPerformanceLedgerFilter;
  readonly cursor?: string | null;
  readonly pageSize?: number;
  readonly sort?: readonly VideoPerformanceLedgerSortKey[];
}

export interface VideoPerformanceLedgerPort {
  // Returns an already-bounded row set the caller has fetched from `video_performance_report_rows` for
  // the given (server-validated) scope — NEVER an unbounded collection scan. This factory does no
  // Firestore I/O itself; that stays the integration leader's wiring responsibility.
  fetchRows(scope: { readonly enrollmentId?: string; readonly programId?: string }): Promise<readonly VideoPerformanceReportRow[]>;
}

export interface VideoPerformanceCallableAuthContext {
  readonly role: ManagementRole | null;
}

export interface VideoPerformanceLedgerCallableConfig {
  readonly port: VideoPerformanceLedgerPort;
  readonly resolveAuth: (request: CallableRequest<unknown>) => VideoPerformanceCallableAuthContext;
}

function parseLedgerRequestData(data: unknown): VideoPerformanceLedgerRequestData {
  if (!data || typeof data !== "object") return {};
  const record = data as Record<string, unknown>;
  return {
    filter: (record.filter as VideoPerformanceLedgerFilter) ?? undefined,
    cursor: typeof record.cursor === "string" ? record.cursor : null,
    pageSize: typeof record.pageSize === "number" ? record.pageSize : undefined,
    sort: Array.isArray(record.sort) ? (record.sort as VideoPerformanceLedgerSortKey[]) : undefined,
  };
}

// Fail-closed handler: role gate first, then exact scope echo (never widened), then bounded fetch, then
// pure filter/sort/cursor projection. NEVER registered in functions/index.ts by this lane.
export function createVideoPerformanceLedgerHandler(
  config: VideoPerformanceLedgerCallableConfig,
): (request: CallableRequest<unknown>) => Promise<VideoPerformanceLedgerPage> {
  return async (request) => {
    const auth = config.resolveAuth(request);
    assertCanReadVideoPerformance(auth.role);
    const parsed = parseLedgerRequestData(request.data);
    const filter = parsed.filter ?? {};
    const rows = await config.port.fetchRows({ enrollmentId: filter.enrollmentId, programId: filter.programId });
    return listVideoPerformanceLedgerRows(
      rows,
      filter,
      { cursor: parsed.cursor, limit: parsed.pageSize },
      parsed.sort,
    );
  };
}

export function createVideoPerformanceLedgerCallable(config: VideoPerformanceLedgerCallableConfig) {
  return onCall(createVideoPerformanceLedgerHandler(config));
}
