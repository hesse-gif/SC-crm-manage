export type DatasetPageLoaderPayload = {
  cursor?: string;
  limit?: number;
  programId?: string;
  campaignId?: string;
  viewAsUserId?: string;
  viewAsEmail?: string;
};

export type LivePagedDatasetScope = {
  communityProgramId: string;
  communityCampaignId: string;
  scpLifecycleProgramId: string;
  /** Present only for a verified super_admin viewAs target. */
  viewAsUserId?: string;
  viewAsEmail?: string;
};

type ScpLifecyclePageBundle = {
  scpLifecycleProfiles: unknown[];
  loadedKeys?: string[];
  pageInfo: Record<string, unknown>;
  counts?: Record<string, number>;
  loadErrors?: Record<string, string | undefined>;
  partialLoadError?: string;
};

export function scopedDatasetPagePayload(
  key: string,
  payload: DatasetPageLoaderPayload,
  scope: LivePagedDatasetScope,
): DatasetPageLoaderPayload {
  if (key === "communityPosts") {
    return {
      ...payload,
      programId: scope.communityProgramId,
      campaignId: scope.communityCampaignId,
    };
  }
  if (key === "scpLifecycleProfiles" && scope.scpLifecycleProgramId) {
    return {
      ...payload,
      programId: scope.scpLifecycleProgramId,
      // 2026-09-27 codex adversarial review round 3 FAIL-10: this branch used to return early,
      // dropping viewAs below for this key even though it's now covered by that check too — its
      // scp entitlement gate (functions/read.ts's listScpLifecycleProfiles) must evaluate a
      // super_admin viewAs target's real scope, not the super_admin's own bypass.
      ...(scope.viewAsUserId && scope.viewAsEmail ? { viewAsUserId: scope.viewAsUserId, viewAsEmail: scope.viewAsEmail } : {}),
    };
  }
  // Keep this deliberately narrower than getDataset: /flu/programs needs its
  // own programs plus the ownership-filtered campaigns rendered beneath them.
  // Each callable re-verifies this target pair server-side before deriving the
  // target organization; candidatePool and unrelated dataset reads stay self-scoped.
  // 2026-09-27 codex adversarial review round 3 FAIL-10: scpLifecycleProfiles added (for the
  // no-scpLifecycleProgramId case — the branch above handles the with-programId case) — same
  // reason as that branch's comment.
  if ((key === "programs" || key === "campaigns" || key === "programApplications" || key === "conversations" || key === "scpLifecycleProfiles") && scope.viewAsUserId && scope.viewAsEmail) {
    return { ...payload, viewAsUserId: scope.viewAsUserId, viewAsEmail: scope.viewAsEmail };
  }
  return { ...payload };
}

export function invokeScopedDatasetPageLoader<TResult>(
  loader: (payload: DatasetPageLoaderPayload) => Promise<TResult>,
  key: string,
  payload: DatasetPageLoaderPayload,
  scope: LivePagedDatasetScope,
): Promise<TResult> {
  return loader(scopedDatasetPagePayload(key, payload, scope));
}

export function resetScpLifecycleProfilePage<T extends ScpLifecyclePageBundle>(bundle: T): T {
  const pageInfo = { ...bundle.pageInfo };
  delete pageInfo.scpLifecycleProfiles;
  const counts = { ...(bundle.counts ?? {}) };
  delete counts.scpLifecycleProfiles;

  const loadErrors = { ...(bundle.loadErrors ?? {}) };
  delete loadErrors.scpLifecycleProfiles;
  const remainingErrors = Object.entries(loadErrors)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);

  return {
    ...bundle,
    scpLifecycleProfiles: [],
    loadedKeys: bundle.loadedKeys?.filter((key) => key !== "scpLifecycleProfiles"),
    pageInfo,
    counts,
    loadErrors: remainingErrors.length > 0 ? Object.fromEntries(remainingErrors) : undefined,
    partialLoadError: remainingErrors.length > 0
      ? remainingErrors.map(([key, message]) => `${key}: ${message}`).join("; ")
      : undefined,
  } as T;
}
