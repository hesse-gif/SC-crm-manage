// Pure core for the video-performance-settlement-report Wave-1 foundation
// (.specs/spec_video_performance_settlement_report/spec.md §3 invariants/state machines, §5.2-§5.7 data
// model). Deterministic, NO I/O, NO Firestore, NO YouTube network calls — every decision here is a pure
// function of its inputs so the store layer (./videoPerformanceObservationStore) and its tests can compose
// them without a live provider.
//
// Hard invariants this module enforces at the type/function level (never re-derived elsewhere):
//   - Raw observations are append-only: same (id) + same canonical bytes => duplicate success; same id +
//     different bytes => conflict. NEVER overwritten.
//   - measurementEndExclusive = publishedAt + 168h (UTC ms). Only exact_window-capability evidence may
//     finalize a measurement; daily/hourly *descriptive* snapshots can NEVER be promoted to `finalized`
//     exact eligible views (spec §1.3 non-goals, §3.4).
//   - Only the CURRENT, non-superseded, non-withdrawn revision may finalize; a prior/superseded revision
//     attempting to finalize is always rejected (spec §3.2, §5.3).
//   - Cutoff-tolerance acceptance is an open policy item — [확인 필요: Data API boundary poll에 허용할 마감
//     오차(예: 5분)를 사업 정책상 exact로 인정할지]. Until that is resolved, any source that cannot prove
//     the exact 168h boundary lands in `verification_pending`, which can NEVER auto-finalize.
//   - declared vs verified country evidence are separate immutable facts; verified never overwrites
//     declared. Non-ISO2 codes and YouTube's unresolved `ZZ` are excluded from CPM primary-country
//     candidates. [확인 필요: ZZ 조회수를 eligible total에는 포함할지] — both aggregates (all-inclusive vs
//     primary-candidate-only) are represented; NEITHER is activated as settlement authority here.
//   - A unique top country is required for `verified`; any tie is `ambiguous_tie` and blocks automatic CPM
//     selection (spec §3.5).
//   - Flu's own estimate/calculation and Portal's confirmed final amount are separate immutable fields.
//     `payable`/`paid`/`portal_confirmed`/`disputed`/`adjustment_required`/`void` are reachable ONLY via a
//     Portal receipt projection — this module has no code path that can produce them without one (spec
//     §1.3, §3.6, §5.6). [확인 필요: Portal→Flu receipt endpoint/schema/version] is still open; production
//     state is never raised past `portal_review` until that contract is pinned.
//
// Every `[확인 필요]` marker below is preserved verbatim from the spec and MUST NOT be resolved by
// inventing a policy value here.

import { createHash } from "node:crypto";

export const OBSERVATION_SCHEMA_VERSION = "video.metrics.observed.v3" as const;
export const MEASUREMENT_SCHEMA_VERSION = "video.metric-measurement.v1" as const;

// ---- common scalar types (spec §5.1) -----------------------------------------------------------------

export type UIntString = string; // /^\d+$/, BigInt-convertible
export type MoneyMinorString = string; // USD cents, non-negative integer string
export type IsoInstant = string; // canonical UTC ISO-8601
export type IsoDate = string; // YYYY-MM-DD
export type IsoCountryCode = string; // ISO-3166-1 alpha-2

const UINT_STRING_RE = /^\d+$/;

export function isUIntString(value: unknown): value is UIntString {
  return typeof value === "string" && UINT_STRING_RE.test(value);
}

// ---- §5.2 raw metric observation ---------------------------------------------------------------------

export type ObservationSource = "youtube_data_api" | "youtube_analytics" | "ytdlp_backup";
// current_cumulative/daily_owner_analytics are DESCRIPTIVE ONLY. exact_window is the only capability that
// may ever finalize a measurement (spec §1.3 non-goals: viewCount snapshots are never retroactively exact;
// Analytics `day` dimension is never treated as an arbitrary-publishedAt exact 168h boundary).
export type SourceCapability = "current_cumulative" | "daily_owner_analytics" | "exact_window";

export interface VideoMetricObservationV3 {
  schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  observationId: string;
  metricKey: string;
  eligibilityEpoch: string;
  enrollmentId: string;
  videoSubmissionId: string;
  fluSubmissionId: string;
  youtubeVideoId: string;
  revision: string;
  contentFingerprint: string;
  observedAt: IsoInstant;
  publishedAt: IsoInstant;
  measurementStartAt: IsoInstant;
  measurementEndExclusive: IsoInstant;
  totalViews: UIntString;
  likes?: UIntString;
  comments?: UIntString;
  source: ObservationSource;
  sourceCapability: SourceCapability;
  sourceWatermark: string;
  sourceFingerprint: string;
  isSynthetic: boolean;
  createdAt: IsoInstant;
}

// Fields that participate in observationId derivation (spec §5.2:
// `observationId = sha256(metricKey + observedAt + sourceWatermark + sourceFingerprint)`).
export type ObservationIdentityMaterial = Readonly<{
  metricKey: string;
  observedAt: IsoInstant;
  sourceWatermark: string;
  sourceFingerprint: string;
}>;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function computeObservationId(material: ObservationIdentityMaterial): string {
  return sha256Hex(`${material.metricKey}|${material.observedAt}|${material.sourceWatermark}|${material.sourceFingerprint}`);
}

// Deterministic canonical-bytes serialization for append-only conflict comparison. Only content fields
// are included — `createdAt` (server-observed write time) is deliberately EXCLUDED so re-delivering the
// identical observation payload at a later wall-clock instant is still recognized as a duplicate, not a
// conflict.
export type ObservationCanonicalContent = Omit<VideoMetricObservationV3, "createdAt" | "observationId">;

export function canonicalizeObservationBytes(content: ObservationCanonicalContent): string {
  const keys = Object.keys(content).sort() as Array<keyof ObservationCanonicalContent>;
  const sorted: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (content as Record<string, unknown>)[key as string];
    if (value !== undefined) sorted[key as string] = value;
  }
  return JSON.stringify(sorted);
}

export type ObservationBytesComparison = "new" | "duplicate" | "conflict";

// Pure append-only decision: given the previously-stored canonical bytes for an observationId (or
// `null`/`undefined` when no row exists yet) and the incoming canonical bytes, decide whether this is a
// brand-new row, an idempotent duplicate replay, or a conflict that MUST NOT overwrite the stored row.
export function evaluateObservationBytesComparison(
  existingCanonicalBytes: string | null | undefined,
  incomingCanonicalBytes: string,
): ObservationBytesComparison {
  if (existingCanonicalBytes === null || existingCanonicalBytes === undefined) return "new";
  return existingCanonicalBytes === incomingCanonicalBytes ? "duplicate" : "conflict";
}

// Only exact-window evidence may ever produce a finalized/eligible-views promotion. Descriptive daily
// snapshots and current-cumulative reads can NEVER be promoted to exact eligible views, no matter how
// confident the collector is (spec §1.3 non-goals, §3.4).
export function canSourceCapabilityFinalize(capability: SourceCapability): boolean {
  return capability === "exact_window";
}

// ---- §3.4 / §5.3 exact measurement state -------------------------------------------------------------

export type MeasurementState =
  | "not_started"
  | "collecting"
  | "cutoff_waiting_source"
  | "verification_pending"
  | "finalized"
  | "conflict"
  | "invalidated";

export const MEASUREMENT_WINDOW_HOURS = 168 as const;
export const MEASUREMENT_WINDOW_MS = MEASUREMENT_WINDOW_HOURS * 60 * 60 * 1000;

export interface VideoMetricMeasurementV1 {
  schemaVersion: typeof MEASUREMENT_SCHEMA_VERSION;
  metricKey: string;
  eligibilityEpoch: string;
  enrollmentId: string;
  videoSubmissionId: string;
  revision: string;
  youtubeVideoId: string;
  state: MeasurementState;
  publishedAt: IsoInstant;
  measurementStartAt: IsoInstant;
  measurementEndExclusive: IsoInstant;
  totalViewsAtCutoff?: UIntString;
  eligibleViews?: UIntString;
  excludedViews?: UIntString;
  exclusionReasons?: Array<{ code: string; views: UIntString }>;
  exactEvidenceObservationId?: string;
  finalizedAt?: IsoInstant;
  invalidatedAt?: IsoInstant;
  invalidatedReason?: "superseded" | "withdrawn" | "approval_reversed" | "identity_conflict";
  lastErrorCode?: string;
  revisionNumber: number;
  updatedAt: IsoInstant;
}

// measurementStartAt = publishedAt; measurementEndExclusive = publishedAt + 168h (UTC millisecond
// arithmetic). ANCHOR SEMANTICS [확인 필요]: the spec pins the anchor to `publishedAt` verbatim and does
// NOT define a boundary-poll tolerance — see MEASUREMENT_WINDOW_HOURS comment above and
// planMeasurementFinalization's `sourceProvesExactBoundary` gate. This function performs NO rounding or
// tolerance; it is exact UTC-ms addition, fail-closed (`null`) on unparseable input.
export function computeMeasurementWindow(
  publishedAt: IsoInstant,
): { measurementStartAt: IsoInstant; measurementEndExclusive: IsoInstant } | null {
  const publishedMs = Date.parse(publishedAt);
  if (!Number.isFinite(publishedMs)) return null;
  return {
    measurementStartAt: new Date(publishedMs).toISOString(),
    measurementEndExclusive: new Date(publishedMs + MEASUREMENT_WINDOW_MS).toISOString(),
  };
}

// `now >= measurementEndExclusive` (inclusive boundary: the instant AT the boundary has reached cutoff).
// Fail-closed to `false` on unparseable input — an unmeasurable boundary is never treated as reached.
export function isCutoffReached(nowIso: IsoInstant, measurementEndExclusive: IsoInstant): boolean {
  const nowMs = Date.parse(nowIso);
  const endMs = Date.parse(measurementEndExclusive);
  if (!Number.isFinite(nowMs) || !Number.isFinite(endMs)) return false;
  return nowMs >= endMs;
}

export type MeasurementFinalizationInput = Readonly<{
  // CAS identity: the measurement row's currently-stored revisionNumber (0 if the row does not exist yet)
  // vs the revisionNumber presented by this finalize attempt. A presented revision strictly LOWER than the
  // stored one is always a prior/superseded revision attempting to finalize and is rejected — this is the
  // hard invariant "prior revision cannot finalize" (spec §3.2 eligibilityEpoch, §5.3).
  storedRevisionNumber: number;
  presentedRevisionNumber: number;
  currentState: MeasurementState;
  isCurrentRevision: boolean;
  withdrawn: boolean;
  superseded: boolean;
  nowIso: IsoInstant;
  measurementEndExclusive: IsoInstant;
  sourceCapability: SourceCapability;
  // Whether the finalizer's provider proved the exact [publishedAt, publishedAt+168h) boundary was
  // measured (vs. e.g. a `day`-dimension Analytics read or a current-cumulative snapshot straddling the
  // boundary). `false`/absent => verification_pending, regardless of sourceCapability.
  sourceProvesExactBoundary: boolean;
  totalViewsAtCutoff: UIntString;
  eligibleViews: UIntString;
  excludedViews: UIntString;
}>;

export type MeasurementFinalizationDecision = Readonly<{
  allowed: boolean;
  nextState: MeasurementState;
  reasonCode: string;
}>;

function reject(nextState: MeasurementState, reasonCode: string): MeasurementFinalizationDecision {
  return { allowed: false, nextState, reasonCode };
}

export function planMeasurementFinalization(input: MeasurementFinalizationInput): MeasurementFinalizationDecision {
  if (input.withdrawn) return reject("invalidated", "video_metric_revision_not_current");
  if (input.superseded) return reject("invalidated", "video_metric_revision_not_current");
  if (!input.isCurrentRevision) return reject("invalidated", "video_metric_revision_not_current");

  // Terminal states never regress via a new finalize attempt with different values; a caller replaying the
  // exact same finalized bytes is a store-layer duplicate concern, not this decision function's job.
  if (input.currentState === "finalized" || input.currentState === "invalidated") {
    return reject(input.currentState, "video_metric_measurement_conflict");
  }

  // Prior/superseded revision numbers can never finalize, even if every other input looks eligible.
  if (input.presentedRevisionNumber < input.storedRevisionNumber) {
    return reject(input.currentState, "video_metric_revision_not_current");
  }

  if (!isCutoffReached(input.nowIso, input.measurementEndExclusive)) {
    return reject("cutoff_waiting_source", "video_metric_cutoff_not_reached");
  }

  // Descriptive-only capability, or a provider that cannot prove the exact boundary, can NEVER promote to
  // `finalized` — this is the "snapshot-to-exact promotion impossible" / "verification_pending cannot
  // finalize" hard invariant. [확인 필요: Data API boundary poll에 허용할 마감 오차(예: 5분)를 사업 정책상
  // exact로 인정할지] remains unresolved; until it is, any non-exact-proven source stays pending forever.
  if (!canSourceCapabilityFinalize(input.sourceCapability) || !input.sourceProvesExactBoundary) {
    return reject("verification_pending", "video_metric_exact_source_unavailable");
  }

  if (!isUIntString(input.totalViewsAtCutoff) || !isUIntString(input.eligibleViews) || !isUIntString(input.excludedViews)) {
    return reject("conflict", "video_metric_measurement_conflict");
  }
  const totalViewsAtCutoff = BigInt(input.totalViewsAtCutoff);
  const eligibleViews = BigInt(input.eligibleViews);
  const excludedViews = BigInt(input.excludedViews);
  // spec §5.3: eligibleViews <= totalViewsAtCutoff; eligibleViews + excludedViews <= totalViewsAtCutoff.
  if (eligibleViews > totalViewsAtCutoff || eligibleViews + excludedViews > totalViewsAtCutoff) {
    return reject("conflict", "video_metric_measurement_conflict");
  }

  return { allowed: true, nextState: "finalized", reasonCode: "finalized" };
}

// ---- §3.5 audience country evidence ------------------------------------------------------------------

export type CountryEvidenceState =
  | "declared_only"
  | "oauth_pending"
  | "collecting"
  | "verified"
  | "ambiguous_tie"
  | "stale"
  | "failed";

const ISO2_RE = /^[A-Z]{2}$/;

export function isIso2CountryCode(code: string): boolean {
  return typeof code === "string" && ISO2_RE.test(code);
}

// ISO alpha-2 codes other than YouTube's "unresolved country" sentinel `ZZ` are primary-CPM candidates.
// [확인 필요: ZZ 조회수를 eligible total에는 포함할지] is intentionally NOT resolved by this predicate —
// it only governs primary-country candidacy, never the eligible-views total.
export function isPrimaryCountryCandidate(code: string): boolean {
  return isIso2CountryCode(code) && code !== "ZZ";
}

export type CountryViewsRow = Readonly<{ countryCode: string; views: UIntString }>;

export type VerifiedCountryDecision = Readonly<{
  state: "verified" | "ambiguous_tie";
  primaryCountryCode: IsoCountryCode | null;
  // Sum of views across ONLY primary-candidate (ISO2, non-ZZ) countries. This is one candidate aggregate
  // — never activated as settlement authority by this module.
  primaryCandidateViews: UIntString;
  // Sum of views reported under the ZZ sentinel. Represented alongside, never merged silently.
  zzViews: UIntString;
  // Sum across every row Portal/YouTube returned (primary candidates + ZZ + any non-ISO2 rows), i.e. the
  // "including everything" aggregate. [확인 필요: ZZ 조회수를 eligible total에는 포함할지] — this function
  // hands back BOTH totals side by side and activates NEITHER as the eligible-views authority.
  totalViewsAllRows: UIntString;
}>;

// Pure derivation of verified-country state from a 28-completed-day per-country views breakdown. A unique
// top primary candidate => `verified`; no unique top (including a genuine tie, or zero primary candidates)
// => `ambiguous_tie`, which blocks automatic CPM selection (spec §3.5, invariant #5).
export function deriveVerifiedCountryDecision(countries: readonly CountryViewsRow[]): VerifiedCountryDecision {
  let totalAllRows = 0n;
  let zzViews = 0n;
  let primaryCandidateViews = 0n;
  const primaryTotals = new Map<string, bigint>();

  for (const row of countries) {
    if (!isUIntString(row.views)) continue;
    const views = BigInt(row.views);
    totalAllRows += views;
    if (row.countryCode === "ZZ") {
      zzViews += views;
      continue;
    }
    if (!isPrimaryCountryCandidate(row.countryCode)) continue;
    primaryCandidateViews += views;
    primaryTotals.set(row.countryCode, (primaryTotals.get(row.countryCode) ?? 0n) + views);
  }

  let topCode: string | null = null;
  let topViews = -1n;
  let topIsUnique = true;
  for (const [code, views] of primaryTotals) {
    if (views > topViews) {
      topViews = views;
      topCode = code;
      topIsUnique = true;
    } else if (views === topViews) {
      topIsUnique = false;
    }
  }

  const verified = topCode !== null && topIsUnique;
  return {
    state: verified ? "verified" : "ambiguous_tie",
    primaryCountryCode: verified ? topCode : null,
    primaryCandidateViews: primaryCandidateViews.toString(),
    zzViews: zzViews.toString(),
    totalViewsAllRows: totalAllRows.toString(),
  };
}

export type EffectiveCountryResult = Readonly<{
  effective: IsoCountryCode | undefined;
  source: "declared" | "verified";
}>;

// declared and verified are ALWAYS kept as separate immutable facts; this helper only computes the
// display-time "effective" projection and never mutates or discards either source. verified overwrites
// the *effective* value ONLY when it is unambiguously verified — an ambiguous_tie NEVER silently falls
// back to overwriting effective with a guessed country; it falls back to declared.
export function computeEffectiveCountry(
  declaredCountryCode: IsoCountryCode,
  verifiedDecision: VerifiedCountryDecision | null,
): EffectiveCountryResult {
  if (verifiedDecision && verifiedDecision.state === "verified" && verifiedDecision.primaryCountryCode) {
    return { effective: verifiedDecision.primaryCountryCode, source: "verified" };
  }
  return { effective: declaredCountryCode || undefined, source: "declared" };
}

// ---- §3.6 settlement display state / §5.5-§5.7 estimate vs Portal final separation --------------------

export type SettlementDisplayState =
  | "not_eligible"
  | "estimated"
  | "measurement_pending"
  | "country_verification_pending"
  // P3#10e: spec .specs/spec_video_performance_settlement_report §5.6 enum verified — the sanctioned
  // state for finalized measurement + verified country + no calculation yet is `calculation_ready`
  // (funnel: estimated → measurement_pending → country_verification_pending → calculation_ready →
  // delivery_pending → portal_*). This union is exactly the spec's SettlementDisplayState enum.
  | "calculation_ready"
  | "delivery_pending"
  | "portal_review"
  | "portal_confirmed"
  | "payable"
  | "paid"
  | "disputed"
  | "adjustment_required"
  | "void";

// States reachable ONLY through a Portal settlement-receipt projection (spec §3.6: "portal_confirmed/
// payable/paid/disputed/adjustment_required/void는 Portal receipt projection으로만 전이합니다"). Flu has
// NO code path that can raise a row into one of these without a receipt present.
export const PORTAL_RECEIPT_GATED_STATES: ReadonlySet<SettlementDisplayState> = new Set([
  "portal_confirmed",
  "payable",
  "paid",
  "disputed",
  "adjustment_required",
  "void",
]);

// Fail-closed guard: a requested display state that is Portal-receipt-gated is only ever allowed when a
// Portal receipt is actually present. This is the concrete "no payable/paid path from Flu" proof point —
// any caller attempting to set one of PORTAL_RECEIPT_GATED_STATES without `hasPortalReceipt` is rejected.
export function assertNoFluOriginatedPayableTransition(
  hasPortalReceipt: boolean,
  requestedState: SettlementDisplayState,
): boolean {
  if (!PORTAL_RECEIPT_GATED_STATES.has(requestedState)) return true;
  return hasPortalReceipt === true;
}

export type SettlementDisplayInput = Readonly<{
  measurementState: MeasurementState;
  countryEvidenceState: CountryEvidenceState;
  hasCalculation: boolean;
  deliveryState?: "pending" | "delivering" | "accepted" | "duplicate" | "retry" | "dead_letter" | "conflict" | null;
  portalReceiptState?: "review" | "confirmed" | "payable" | "paid" | "disputed" | "adjustment_required" | "void" | null;
}>;

// Pure funnel derivation (spec §3.6 diagram). NEVER returns a Portal-receipt-gated state unless
// `portalReceiptState` itself carries that state — Flu recalculation can never overwrite or fabricate a
// Portal final state; a mismatch is surfaced by the caller as `calculationMismatch` (kept out of this pure
// function's scope; see VideoSettlementCalculationInput consumers).
export function deriveSettlementDisplayState(input: SettlementDisplayInput): SettlementDisplayState {
  if (input.portalReceiptState) {
    // Portal projection is authoritative once present, whatever it says (receipt-gated states allowed here
    // because a receipt IS present). Portal's wire values "review"/"confirmed" map to the UI's
    // "portal_review"/"portal_confirmed" labels; every other value passes through unchanged.
    const PORTAL_STATE_MAP: Record<string, SettlementDisplayState> = { review: "portal_review", confirmed: "portal_confirmed" };
    return PORTAL_STATE_MAP[input.portalReceiptState] ?? (input.portalReceiptState as SettlementDisplayState);
  }
  if (input.measurementState === "invalidated" || input.measurementState === "conflict") return "not_eligible";
  if (!input.hasCalculation) {
    if (input.measurementState !== "finalized") {
      // Before finalization, only a declared-country estimate can ever be shown (spec §3.5: "검증 전에는
      // declared country로 예상 금액만 표시할 수 있습니다").
      return "estimated";
    }
    if (input.countryEvidenceState === "ambiguous_tie" || input.countryEvidenceState !== "verified") {
      return "country_verification_pending";
    }
    // P3#10e fix: finalized measurement + verified country + no calculation yet is NOT the same funnel
    // stage as "measurement still pending" — the 168h window is already closed and the country is
    // already resolved; only the calculation step itself hasn't run. Spec §5.6 names this stage
    // `calculation_ready`.
    return "calculation_ready";
  }
  // A calculation exists but no Portal receipt drives a portal_* state: per the spec funnel the row is
  // awaiting delivery/receipt — `delivery_pending` (never re-labeled calculation_ready once calculated).
  return "delivery_pending";
}

// Flu's own estimate/calculated amount and Portal's confirmed final amount are separate immutable fields
// that are NEVER merged into one another. `estimatedAmountMinor` is available pre-finalization from
// declared-country policy; `fluCalculatedAmountMinor` is the immutable post-finalization Flu calculation;
// `portalFinalAmountMinor` comes ONLY from a Portal receipt projection.
export type DisplayAmounts = Readonly<{
  estimatedAmountMinor?: MoneyMinorString;
  fluCalculatedAmountMinor?: MoneyMinorString;
  portalFinalAmountMinor?: MoneyMinorString;
}>;

export function deriveDisplayAmounts(input: {
  estimatedAmountMinor?: MoneyMinorString | null;
  fluCalculatedAmountMinor?: MoneyMinorString | null;
  portalFinalAmountMinor?: MoneyMinorString | null;
}): DisplayAmounts {
  const out: { estimatedAmountMinor?: MoneyMinorString; fluCalculatedAmountMinor?: MoneyMinorString; portalFinalAmountMinor?: MoneyMinorString } = {};
  if (isUIntString(input.estimatedAmountMinor ?? undefined)) out.estimatedAmountMinor = input.estimatedAmountMinor as string;
  if (isUIntString(input.fluCalculatedAmountMinor ?? undefined)) out.fluCalculatedAmountMinor = input.fluCalculatedAmountMinor as string;
  if (isUIntString(input.portalFinalAmountMinor ?? undefined)) out.portalFinalAmountMinor = input.portalFinalAmountMinor as string;
  return out;
}

// `amountMinor = floor(eligibleViews * cpmMicrosPerThousand / 10,000,000)` (spec §5.5). BigInt-only, no
// floating point. Submission-unit floor happens ONCE, before any summation (invariant #10) — callers must
// floor per submission and only sum the already-floored MoneyMinorString results.
export function calculateAmountMinor(eligibleViews: UIntString, cpmMicrosPerThousand: UIntString): MoneyMinorString {
  if (!isUIntString(eligibleViews) || !isUIntString(cpmMicrosPerThousand)) return "0";
  const views = BigInt(eligibleViews);
  const cpm = BigInt(cpmMicrosPerThousand);
  return ((views * cpm) / 10_000_000n).toString();
}

// Submitted/manual view counts are diagnostic-only and MUST NEVER feed eligibleViews/settlement math.
// Kept as an explicit type-level marker + a runtime guard so a caller cannot accidentally wire a manual
// count into a finalization input.
export type DiagnosticOnlyViewCount = Readonly<{ kind: "submitted" | "manual"; views: UIntString; note?: string }>;

export function isDiagnosticOnlyViewCount(value: unknown): value is DiagnosticOnlyViewCount {
  return (
    !!value &&
    typeof value === "object" &&
    ((value as { kind?: unknown }).kind === "submitted" || (value as { kind?: unknown }).kind === "manual") &&
    isUIntString((value as { views?: unknown }).views)
  );
}
