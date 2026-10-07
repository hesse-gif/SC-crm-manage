import { isOperationalFixtureRecord } from "../../functions/operationalFixtureProvenance.ts";

type DashboardHumanReviewCollection = "reviews" | "escalations";

type DashboardHumanReviewProjectionInput<TReview, TEscalation> = {
  reviews: readonly TReview[];
  escalations: readonly TEscalation[];
  allowFixtureRows: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function isDashboardHumanReviewFixture(
  value: unknown,
  collection: DashboardHumanReviewCollection,
): boolean {
  return isOperationalFixtureRecord(asRecord(value), collection);
}

/**
 * Defense-in-depth for the production dashboard. Dataset callables already remove
 * fixtures, but a stale function deployment must not make historical demo rows
 * look like current human work in a newer client bundle. Emulator builds retain
 * their fixture rows for the local verification harness.
 */
export function projectDashboardHumanReviewRows<TReview, TEscalation>({
  reviews,
  escalations,
  allowFixtureRows,
}: DashboardHumanReviewProjectionInput<TReview, TEscalation>): {
  reviews: TReview[];
  escalations: TEscalation[];
} {
  if (allowFixtureRows) {
    return { reviews: [...reviews], escalations: [...escalations] };
  }
  return {
    reviews: reviews.filter((row) => !isDashboardHumanReviewFixture(row, "reviews")),
    escalations: escalations.filter((row) => !isDashboardHumanReviewFixture(row, "escalations")),
  };
}

export type DashboardHumanReviewCountInputs = {
  // False while any contributing source (escalations/reviews gated by the post-snapshot
  // auxiliary load, or the conversations pipeline projection) has not yet settled. A
  // partially-loaded sum must never be shown as if it were final — that mix (some sources
  // still empty, others already hydrated) is exactly what produced the reported flicker
  // (e.g. 2 → 101 on the same refresh).
  ready: boolean;
  escalationCount: number;
  actionablePendingReviewCount: number;
  mailHumanReviewCount: number;
  // Task-54: `escalations`/`reviews` are read.ts DatasetKeys capped at DEFAULT_PAGE_SIZE
  // (100) per page; `conversations` (feeding mailHumanReviewCount) is capped by the
  // dashboard pipeline projection. When any of them is truncated, the sum below is a
  // floor, not an exact total — the caller must not present it as an exact count.
  escalationsTruncated: boolean;
  reviewsTruncated: boolean;
  conversationsTruncated: boolean;
};

export type DashboardHumanReviewCountSummary = {
  ready: boolean;
  count: number;
  capped: boolean;
  // Human-readable badge text. `null` while `ready` is false — render a loading state
  // instead of any number in that case.
  label: string | null;
};

/**
 * Pure, deterministic aggregation for the dashboard's "사람 검수 필요" count. Given the
 * same inputs it always returns the same output (no Date.now/Math.random/network calls),
 * so the same underlying data state renders the same count on every refresh. When any
 * contributing page is capped, `label` reads "N건 이상" (a floor) instead of a bare "N건"
 * that would otherwise look exact.
 */
export function dashboardHumanReviewCountSummary({
  ready,
  escalationCount,
  actionablePendingReviewCount,
  mailHumanReviewCount,
  escalationsTruncated,
  reviewsTruncated,
  conversationsTruncated,
}: DashboardHumanReviewCountInputs): DashboardHumanReviewCountSummary {
  const count = escalationCount + actionablePendingReviewCount + mailHumanReviewCount;
  const capped = escalationsTruncated || reviewsTruncated || conversationsTruncated;
  return {
    ready,
    count,
    capped,
    label: ready ? `${count}건${capped ? " 이상" : ""}` : null,
  };
}
