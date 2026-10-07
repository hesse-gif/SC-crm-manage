export type ManagementScopeSource = "classification" | "application" | "lifecycle";

export type ManagementScopeCandidate = {
  programId: string;
  campaignId?: string;
  enrollmentId?: string;
  source: ManagementScopeSource;
};

export type ResolvedManagementScope = {
  enrollmentId: string;
  programId: string;
  campaignId?: string;
  queryEnrollmentId?: string;
};

const fallbackKey = (scope: Pick<ManagementScopeCandidate, "programId" | "campaignId">) =>
  `scope:${scope.programId}:${scope.campaignId ?? ""}`;

/**
 * Canonical classification enrollment IDs are the only enrollment authority. They shadow a
 * matching legacy no-enrollment scope, but never a different campaign under the same program.
 */
export function resolveManagementEnrollmentScopes(candidates: ManagementScopeCandidate[]): ResolvedManagementScope[] {
  const valid = candidates.filter((scope) => Boolean(scope.programId));
  const canonicalCampaignKeys = new Set(
    valid
      .filter((scope) => scope.source === "classification" && Boolean(scope.enrollmentId))
      .map(fallbackKey),
  );
  const programsWithSpecificScopes = new Set(
    valid.filter((scope) => Boolean(scope.enrollmentId) || Boolean(scope.campaignId)).map((scope) => scope.programId),
  );
  const deduped = new Map<string, ManagementScopeCandidate>();

  for (const scope of valid) {
    const isLegacyFallback = !scope.enrollmentId;
    if (isLegacyFallback && canonicalCampaignKeys.has(fallbackKey(scope))) continue;
    // A program-only lifecycle projection adds no selectable scope once a concrete enrollment or
    // campaign scope exists. A legacy program/campaign fallback remains selectable when distinct.
    if (isLegacyFallback && scope.source === "lifecycle" && !scope.campaignId && programsWithSpecificScopes.has(scope.programId)) continue;

    const key = scope.enrollmentId ? `enrollment:${scope.enrollmentId}` : fallbackKey(scope);
    const existing = deduped.get(key);
    if (!existing || (scope.source === "classification" && existing.source !== "classification")) {
      deduped.set(key, scope);
    }
  }

  return Array.from(deduped.values()).map((scope) => ({
    enrollmentId: scope.enrollmentId ?? fallbackKey(scope),
    programId: scope.programId,
    campaignId: scope.campaignId,
    queryEnrollmentId: scope.enrollmentId,
  }));
}
