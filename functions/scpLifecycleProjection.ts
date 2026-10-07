import { normalizeScpProgramId, canonicalScpProgramId } from "./scpProgramAlias";
// 발송 판정 정본(허용목록 1종). 프로젝션마다 다시 정의하면 조용히 갈린다.
import { isDeliveredOutboundLogRow } from "./nudgeReportFacts";
import { createHash } from "crypto";
import { isDeepStrictEqual } from "util";

export const SCP_LIFECYCLE_STATES = [
  "coldmail_sent",
  "reply_received",
  "form_submitted",
  "qualification_pending",
  "qualification_passed",
  "qualification_failed",
  "pass_mail_pending",
  "fail_mail_pending",
  "onelink_sent",
  "uid_requested",
  "uid_received",
  "gem_scheduled",
  "gem_paid",
  "video_task_issued",
  "video_submitted",
  "video_review_pending",
  "video_approved",
  "video_rejected",
  "needs_resubmission",
  "live_tracking",
  "done_failed",
] as const;

export const CANONICAL_SCP_LIFECYCLE_STATES = SCP_LIFECYCLE_STATES;

export type ScpLifecycleState = (typeof SCP_LIFECYCLE_STATES)[number];
export const SCP_IDENTITY_CONFLICT_STATE = "identity_conflict" as const;
export const SCP_IDENTITY_CONFLICT_AUTOMATION_REASON_CODE = "identity_conflict_human_required" as const;
export type ScpLifecycleResolutionState = ScpLifecycleState | typeof SCP_IDENTITY_CONFLICT_STATE;

export const SCP_LIFECYCLE_MEMBERSHIP_STATES = [
  "active",
  "reactivated",
  "source_missing",
  "inactive_pending",
  "confirmed_inactive",
  "quarantined",
  "superseded",
  "ghost",
] as const;

export type ScpLifecycleMembershipState = (typeof SCP_LIFECYCLE_MEMBERSHIP_STATES)[number];

export type ScpLifecycleMembershipTombstone = {
  schemaVersion: "scp-lifecycle-membership.v1";
  kind: "tombstone";
  profileId: string;
  programId: string;
  projectionRevision: number;
  membershipState: Exclude<ScpLifecycleMembershipState, "active" | "reactivated">;
  removedAtIso: string;
  reasonCode: "membership_inactive" | "previously_exposed_source_missing";
};

export type ScpLifecycleMembershipSnapshot = {
  profileId: string;
  programId: string;
  projectionRevision: number;
  activeServing?: boolean;
};

export type ScpLifecycleMembershipProjection = {
  schemaVersion: "scp-lifecycle-membership.v1";
  projectionRevision: number;
  activeProfiles: ScpLifecycleProfile[];
  tombstones: ScpLifecycleMembershipTombstone[];
};

export type ScpAliasKind =
  | "leadId"
  | "email"
  | "handle"
  | "channelId"
  | "creatorId"
  | "submissionId"
  | "videoId"
  | "trackingId"
  | "conversationId";

export type ScpAlias = {
  kind: ScpAliasKind;
  aliasId: string;
  normalized: string;
  strength: "strong" | "weak";
  piiMinimized: boolean;
};

export type ScpAliasConflict = {
  type:
    | "weak_handle_collision"
    | "unsafe_strong_collision"
    | "program_scope_conflict"
    | "program_scope_malformed";
  aliasId: string;
  message: string;
  sourceRefs: string[];
};

export type ScpIdentityComponent = {
  profileId: string;
  aliasIds: string[];
  sourceRefs: string[];
};

export type ScpIdentityGraph = {
  aliases: ScpAlias[];
  components: ScpIdentityComponent[];
  conflicts: ScpAliasConflict[];
  profileForAlias: Record<string, string>;
};

export type ScpSourceRow = Record<string, unknown>;

export type ScpLifecycleSources = {
  scp_outreach?: ScpSourceRow[];
  scp_coldmail_history?: ScpSourceRow[];
  mail_outbound_log?: ScpSourceRow[];
  conversation_replies?: ScpSourceRow[];
  conversations?: ScpSourceRow[];
  program_applications?: ScpSourceRow[];
  program_sheet_leads?: ScpSourceRow[];
  qualification_decisions?: ScpSourceRow[];
  creator_links?: ScpSourceRow[];
  scp_mail_results?: ScpSourceRow[];
  submission_tasks?: ScpSourceRow[];
  submissions?: ScpSourceRow[];
  review_ledger?: ScpSourceRow[];
  videos?: ScpSourceRow[];
  video_view_series?: ScpSourceRow[];
  video_view_snapshots?: ScpSourceRow[];
  gem_grants?: ScpSourceRow[];
};

export type ScpLifecycleProfile = {
  profileId: string;
  programId: string;
  programIds: string[];
  primaryConversationId: string | null;
  currentState: ScpLifecycleResolutionState;
  stateEnteredAt: string;
  nextRequiredAction: string;
  blockingReason: string | null;
  counts: Record<string, number>;
  latestVideoStatus: Array<Record<string, unknown>>;
  videoHistoryCount: number;
  videoHistoryTruncated: boolean;
  projectionStatus: "fresh" | "stale" | "failed" | "rebuilding";
  identityConflict: boolean;
  canonicalIdentityHash: string;
  resolutionState: "resolved" | typeof SCP_IDENTITY_CONFLICT_STATE;
  automationBlocked: boolean;
  automationBlockReasonCode: typeof SCP_IDENTITY_CONFLICT_AUTOMATION_REASON_CODE | null;
  identityConflictSourceRefs: string[];
  onelinkProviderConfirmed: boolean;
  onelinkProviderConfirmedSourceRefs: string[];
  sourceRefs: string[];
  membershipState: ScpLifecycleMembershipState;
  membershipChangedAtIso: string;
  activeServing: boolean;
  computedAtIso: string;
};

export type ScpLifecycleProjectionResult = {
  profiles: ScpLifecycleProfile[];
  graph: ScpIdentityGraph;
  identityProfileIdByProfile: Record<string, string>;
  videoHistoryByProfile: Record<string, Array<Record<string, unknown>>>;
};

export type ScpLifecycleReconciliationCounts = {
  sourceCapture: number;
  immutableObservations: number;
  normalizedCanonicalRecords: number;
  activeReadProjection: number;
  uiApiResponses: number;
};

export type ScpLifecycleVersionFence = {
  sourceVersion: string;
  writerEpoch: number;
  projectionRevision: number;
  generation: number;
};

export type ScpOperationalSnapshotBoundary = {
  status: "fresh" | "stale" | "rebuilding" | "partial";
  generatedAtIso: string;
  staleAfterIso: string;
  requiresRebuild?: boolean;
};

export type ScpLifecycleReconciliationQualityFlag =
  | "source_capture_empty"
  | "source_capture_incomplete"
  | "source_capture_unstable"
  | "boundary_count_mismatch"
  | "identity_coverage_incomplete"
  | "identity_conflict"
  | "unavailable_conflict"
  | "ghost_conflict"
  | "membership_projection_revision_mismatch"
  | "membership_previous_snapshot_revision_mismatch"
  | "membership_active_set_mismatch"
  | "membership_tombstone_mismatch"
  | "version_fence_mismatch"
  | "max_age_exceeded"
  | "operational_snapshot_not_fresh"
  | "consecutive_success_window_incomplete";

export type ScpLifecycleReconciliationEnvelope = {
  schemaVersion: "scp-lifecycle-reconciliation.v1";
  counts: ScpLifecycleReconciliationCounts;
  boundaryDeltas: {
    captureToObservations: number;
    observationsToNormalized: number;
    normalizedToProjection: number;
    projectionToResponse: number;
  };
  identityCoverage: {
    resolved: number;
    total: number;
    ratio: number;
  };
  freshness: {
    asOfIso: string;
    ageMs: number;
    maxAgeMs: number;
    status: ScpLifecycleProfile["projectionStatus"];
  };
  versionsMatch: boolean;
  currentWindowEligible: boolean;
  consecutiveSuccesses: number;
  requiredConsecutiveSuccesses: number;
  parityEligible: boolean;
  qualityFlags: ScpLifecycleReconciliationQualityFlag[];
  projection: ScpLifecycleProjectionResult;
};

type SourceName = keyof ScpLifecycleSources;

type IndexedRow = {
  source: SourceName;
  index: number;
  ref: string;
  row: ScpSourceRow;
  aliases: ScpAlias[];
};

type ProgramScopeResolution =
  | { status: "resolved" | "legacy"; programId: string }
  | { status: "conflict" | "malformed"; programId: null };

type ProgramScopeAnalysis = {
  projectableRows: IndexedRow[];
  programIdBySourceRef: Map<string, string>;
  conflicts: ScpAliasConflict[];
};

type EventCandidate = {
  state: ScpLifecycleState;
  enteredAt: string;
  sourceRef: string;
  rank: number;
};

type IdentityConflictEvidence = {
  enteredAt: string;
  sourceRefs: string[];
};

type MembershipResolution = {
  state: ScpLifecycleMembershipState;
  changedAtIso: string;
  activeServing: boolean;
};

const SOURCE_NAMES: SourceName[] = [
  "scp_outreach",
  "scp_coldmail_history",
  "mail_outbound_log",
  "conversation_replies",
  "conversations",
  "program_applications",
  "program_sheet_leads",
  "qualification_decisions",
  "creator_links",
  "scp_mail_results",
  "submission_tasks",
  "submissions",
  "review_ledger",
  "videos",
  "video_view_series",
  "video_view_snapshots",
  "gem_grants",
];

const STATE_RANK: Record<ScpLifecycleState, number> = {
  coldmail_sent: 10,
  reply_received: 20,
  form_submitted: 30,
  qualification_pending: 40,
  qualification_passed: 50,
  qualification_failed: 51,
  pass_mail_pending: 60,
  fail_mail_pending: 61,
  onelink_sent: 70,
  uid_requested: 80,
  uid_received: 90,
  gem_scheduled: 100,
  gem_paid: 110,
  video_task_issued: 120,
  video_submitted: 130,
  video_review_pending: 140,
  video_approved: 150,
  video_rejected: 151,
  needs_resubmission: 152,
  live_tracking: 160,
  done_failed: 170,
};

const IDENTITY_CONFLICT_STATE_RANK = 52;
const MISSING_EVIDENCE_TIMESTAMP = new Date(0).toISOString();

const EMAIL_KEYS = ["email", "to", "from", "leadEmail", "creatorEmail", "recipientEmail"];
const HANDLE_KEYS = ["handle", "creatorHandle", "channelHandle", "youtubeHandle", "instagramHandle", "tiktokHandle"];
const CHANNEL_KEYS = ["channelId", "youtubeChannelId", "ytChannelId"];
const CREATOR_KEYS = ["creatorId", "creator_id"];
const LEAD_KEYS = ["leadId", "lead_id"];
const SUBMISSION_KEYS = ["submissionId", "submission_id"];
const VIDEO_KEYS = ["videoId", "video_id", "youtubeVideoId", "youtubeUrl", "videoUrl", "url"];
const TRACKING_KEYS = ["trackingId", "tracking_id", "seriesId", "viewSeriesId"];
const CONVERSATION_KEYS = ["conversationId", "conversation_id", "threadId"];
export const DEFAULT_SCP_PROGRAM_ID = "scp";

class DisjointSet {
  private readonly parent = new Map<string, string>();

  find(value: string): string {
    const parent = this.parent.get(value);
    if (!parent) {
      this.parent.set(value, value);
      return value;
    }
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }
}

export function normalizeEmail(value: unknown): string | null {
  const text = stringValue(value)?.trim().toLowerCase();
  if (!text || !text.includes("@")) return null;
  return text.replace(/^mailto:/, "");
}

export function normalizeHandle(value: unknown): string | null {
  const text = stringValue(value)?.trim().toLowerCase();
  if (!text) return null;
  const withoutUrl = text
    .replace(/^https?:\/\/(www\.)?(youtube\.com|instagram\.com|tiktok\.com)\//, "")
    .replace(/^channel\//, "")
    .replace(/^user\//, "")
    .replace(/^c\//, "")
    .split(/[/?#]/)[0] ?? "";
  const handle = withoutUrl.replace(/^@/, "").replace(/[^a-z0-9._-]/g, "");
  return handle ? `@${handle}` : null;
}

export function normalizeVideoId(value: unknown): string | null {
  const text = stringValue(value)?.trim();
  if (!text) return null;
  const youtubeMatch = text.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{6,})/);
  if (youtubeMatch?.[1]) return youtubeMatch[1];
  const bare = text.match(/^[A-Za-z0-9_-]{6,}$/);
  return bare ? text : null;
}

export function normalizeAliasValue(kind: ScpAliasKind, value: unknown): string | null {
  if (kind === "email") return normalizeEmail(value);
  if (kind === "handle") return normalizeHandle(value);
  if (kind === "videoId") return normalizeVideoId(value);
  const text = stringValue(value)?.trim();
  if (!text) return null;
  return text.replace(/\s+/g, " ");
}

export function makeScpAlias(kind: ScpAliasKind, value: unknown, weakOverride = false): ScpAlias | null {
  const normalized = normalizeAliasValue(kind, value);
  if (!normalized) return null;
  const piiMinimized = kind === "email" || kind === "handle";
  const key = piiMinimized ? shortHash(normalized) : stableAliasKey(normalized);
  return {
    kind,
    aliasId: `${kind}:${key}`,
    normalized,
    strength: kind === "handle" || weakOverride ? "weak" : "strong",
    piiMinimized,
  };
}

export function buildScpIdentityGraph(sources: ScpLifecycleSources): ScpIdentityGraph {
  const scope = analyzeProgramScopes(indexRows(sources));
  return buildScpIdentityGraphFromIndexed(scope.projectableRows, scope.conflicts);
}

function buildScpIdentityGraphFromIndexed(
  indexed: IndexedRow[],
  initialConflicts: ScpAliasConflict[] = [],
): ScpIdentityGraph {
  const dsu = new DisjointSet();
  const aliases = new Map<string, ScpAlias>();
  const aliasRefs = new Map<string, Set<string>>();
  const conflicts: ScpAliasConflict[] = [...initialConflicts];

  for (const item of indexed) {
    for (const alias of item.aliases) {
      aliases.set(alias.aliasId, alias);
      dsu.find(alias.aliasId);
      upsertSet(aliasRefs, alias.aliasId).add(item.ref);
    }

    const strongAliases = item.aliases.filter((alias) => alias.strength === "strong");
    for (let i = 1; i < strongAliases.length; i += 1) {
      dsu.union(strongAliases[0].aliasId, strongAliases[i].aliasId);
    }
  }

  const handleRefsByNormalized = new Map<string, Set<string>>();
  for (const item of indexed) {
    for (const alias of item.aliases) {
      if (alias.kind === "handle") upsertSet(handleRefsByNormalized, alias.normalized).add(item.ref);
    }
  }
  for (const [normalized, refs] of handleRefsByNormalized) {
    if (refs.size <= 1) continue;
    const strongNeighborRoots = new Set<string>();
    for (const item of indexed) {
      if (!item.aliases.some((candidate) => candidate.kind === "handle" && candidate.normalized === normalized)) continue;
      const strong = item.aliases.find((candidate) => candidate.strength === "strong");
      if (strong) strongNeighborRoots.add(dsu.find(strong.aliasId));
    }
    if (strongNeighborRoots.size > 1 || strongNeighborRoots.size === 0) {
      conflicts.push({
        type: "weak_handle_collision",
        aliasId: `handle:${shortHash(normalized)}`,
        message: "Handle-only evidence is weak and was not used as the sole merge authority.",
        sourceRefs: [...refs].sort(),
      });
    }
  }


  const leadByRoot = new Map<string, Set<string>>();
  const creatorByRoot = new Map<string, Set<string>>();
  for (const alias of aliases.values()) {
    const root = dsu.find(alias.aliasId);
    if (alias.kind === "leadId") upsertSet(leadByRoot, root).add(alias.aliasId);
    if (alias.kind === "creatorId") upsertSet(creatorByRoot, root).add(alias.aliasId);
  }
  for (const [root, leadIds] of leadByRoot) {
    if (leadIds.size > 1) {
      conflicts.push({
        type: "unsafe_strong_collision",
        aliasId: root,
        message: "Multiple leadId aliases converged into one component; projection remains visible with conflict status.",
        sourceRefs: sourceRefsForAliasIds(indexed, leadIds),
      });
    }
  }
  for (const [root, creatorIds] of creatorByRoot) {
    if (creatorIds.size > 1) {
      conflicts.push({
        type: "unsafe_strong_collision",
        aliasId: root,
        message: "Multiple creatorId aliases converged into one component; projection remains visible with conflict status.",
        sourceRefs: sourceRefsForAliasIds(indexed, creatorIds),
      });
    }
  }

  const roots = new Map<string, Set<string>>();
  const rootRefs = new Map<string, Set<string>>();
  for (const item of indexed) {
    for (const alias of item.aliases) {
      const root = dsu.find(alias.aliasId);
      upsertSet(roots, root).add(alias.aliasId);
      upsertSet(rootRefs, root).add(item.ref);
    }
  }

  const components = [...roots.entries()].map(([root, aliasIds]) => {
    const stable = chooseStableAlias([...aliasIds], aliases) ?? root;
    return {
      profileId: `scp_profile_${shortHash(stable)}`,
      aliasIds: [...aliasIds].sort(),
      sourceRefs: [...(rootRefs.get(root) ?? new Set<string>())].sort(),
    };
  }).sort((a, b) => a.profileId.localeCompare(b.profileId));

  const profileForAlias: Record<string, string> = {};
  for (const component of components) {
    for (const aliasId of component.aliasIds) profileForAlias[aliasId] = component.profileId;
  }

  return {
    aliases: [...aliases.values()].sort((a, b) => a.aliasId.localeCompare(b.aliasId)),
    components,
    conflicts,
    profileForAlias,
  };
}

export const buildScpIdentityAliasGraph = buildScpIdentityGraph;

export function projectScpLifecycleProfiles(
  sources: ScpLifecycleSources,
  options: { computedAtIso?: string } = {},
): ScpLifecycleProjectionResult {
  const computedAtIso = options.computedAtIso ?? new Date().toISOString();
  const indexed = indexRows(sources);
  const scope = analyzeProgramScopes(indexed);
  const graph = buildScpIdentityGraphFromIndexed(scope.projectableRows, scope.conflicts);
  const byProfile = new Map<string, IndexedRow[]>();
  const identityProfileIdByProfile: Record<string, string> = {};
  const programIdByProfile = new Map<string, string>();
  const videoHistoryByProfile: Record<string, Array<Record<string, unknown>>> = {};

  for (const item of scope.projectableRows) {
    const identityProfileId = item.aliases
      .filter((alias) => alias.strength === "strong")
      .map((alias) => graph.profileForAlias[alias.aliasId])
      .find(Boolean)
      ?? item.aliases.map((alias) => graph.profileForAlias[alias.aliasId]).find(Boolean);
    if (!identityProfileId) continue;
    const programId = scope.programIdBySourceRef.get(item.ref);
    if (!programId) continue;
    const profileId = programScopedLifecycleProfileId(identityProfileId, programId);
    identityProfileIdByProfile[profileId] = identityProfileId;
    programIdByProfile.set(profileId, programId);
    upsertArray(byProfile, profileId).push(item);
  }

  const profiles: ScpLifecycleProfile[] = [...byProfile.entries()].flatMap(([profileId, rows]) => {
    const sourceRefs = [...new Set(rows.map((row) => row.ref))].sort();
    const identityConflictEvidence = identityConflictEvidenceForRows(rows);
    const candidates = rows.flatMap((row) => candidatesForRow(row, rows));
    if (candidates.length === 0 && !identityConflictEvidence) return [];
    const winning = chooseWinningCandidate(candidates) ?? {
      state: "coldmail_sent" as ScpLifecycleState,
      enteredAt: MISSING_EVIDENCE_TIMESTAMP,
      sourceRef: sourceRefs[0] ?? "projection:empty",
      rank: STATE_RANK.coldmail_sent,
    };
    const videoStatuses = buildLatestVideoStatus(rows);
    const confirmedOnelinkRefs = providerConfirmedOnelinkSourceRefs(rows);
    videoHistoryByProfile[profileId] = videoStatuses;
    const profileConflicts = graph.conflicts.filter((conflict) => conflict.sourceRefs.some((ref) => sourceRefs.includes(ref)));
    const identityConflictSourceRefs = [...new Set([
      ...(identityConflictEvidence?.sourceRefs ?? []),
      ...profileConflicts.flatMap((conflict) => conflict.sourceRefs),
    ])].sort();
    const hasIdentityConflict = identityConflictSourceRefs.length > 0;
    const programId = programIdByProfile.get(profileId);
    if (!programId) return [];
    const identityProfileId = identityProfileIdByProfile[profileId];
    if (!identityProfileId) return [];
    const primaryConversationId = primaryConversationIdForRows(rows);
    const membership = resolveMembershipForRows(rows);
    const currentState: ScpLifecycleResolutionState = hasIdentityConflict
      ? SCP_IDENTITY_CONFLICT_STATE
      : winning.state;
    return {
      profileId,
      programId,
      programIds: [programId],
      primaryConversationId,
      currentState,
      stateEnteredAt: identityConflictEvidence?.enteredAt ?? winning.enteredAt,
      nextRequiredAction: nextRequiredActionFor(currentState),
      blockingReason: blockingReasonFor(currentState, rows),
      counts: buildCounts(rows, currentState),
      latestVideoStatus: videoStatuses.slice(0, 5),
      videoHistoryCount: videoStatuses.length,
      videoHistoryTruncated: videoStatuses.length > 5,
      projectionStatus: "fresh",
      identityConflict: hasIdentityConflict,
      canonicalIdentityHash: shortHash(["scp_canonical_identity_v1", identityProfileId].join("\u0000")),
      resolutionState: hasIdentityConflict ? SCP_IDENTITY_CONFLICT_STATE : "resolved",
      automationBlocked: hasIdentityConflict,
      automationBlockReasonCode: hasIdentityConflict
        ? SCP_IDENTITY_CONFLICT_AUTOMATION_REASON_CODE
        : null,
      identityConflictSourceRefs,
      onelinkProviderConfirmed: confirmedOnelinkRefs.length > 0,
      onelinkProviderConfirmedSourceRefs: confirmedOnelinkRefs,
      sourceRefs,
      membershipState: membership.state,
      membershipChangedAtIso: membership.changedAtIso,
      activeServing: membership.activeServing,
      computedAtIso,
    };
  });

  return {
    profiles: profiles.sort((a, b) => a.profileId.localeCompare(b.profileId)),
    graph,
    identityProfileIdByProfile,
    videoHistoryByProfile,
  };
}

export function serializeScpLifecycleMembershipProjection(input: {
  profiles: ScpLifecycleProfile[];
  previous?: ScpLifecycleMembershipSnapshot[];
  projectionRevision: number;
  computedAtIso?: string;
}): ScpLifecycleMembershipProjection {
  const projectionRevision = requireProjectionRevision(input.projectionRevision);
  const computedAtIso = validIso(input.computedAtIso) ?? new Date().toISOString();
  const previous = input.previous ?? [];
  const maxPreviousRevision = previous.reduce(
    (max, item) => Math.max(max, requireProjectionRevision(item.projectionRevision)),
    0,
  );
  if (previous.length > 0 && projectionRevision <= maxPreviousRevision) {
    throw new Error("membership projection revision must increase before emitting tombstones");
  }

  const currentByProfile = new Map(input.profiles.map((profile) => [profile.profileId, profile]));
  const tombstones = input.profiles
    .filter((profile) => !profile.activeServing)
    .map((profile): ScpLifecycleMembershipTombstone => ({
      schemaVersion: "scp-lifecycle-membership.v1",
      kind: "tombstone",
      profileId: profile.profileId,
      programId: profile.programId,
      projectionRevision,
      membershipState: inactiveMembershipState(profile.membershipState),
      removedAtIso: requireIso(
        profile.membershipChangedAtIso,
        `profiles[${profile.profileId}].membershipChangedAtIso`,
      ),
      reasonCode: "membership_inactive",
    }));

  for (const prior of previous) {
    if (prior.activeServing === false || currentByProfile.has(prior.profileId)) continue;
    tombstones.push({
      schemaVersion: "scp-lifecycle-membership.v1",
      kind: "tombstone",
      profileId: prior.profileId,
      programId: prior.programId,
      projectionRevision,
      membershipState: "source_missing",
      removedAtIso: computedAtIso,
      reasonCode: "previously_exposed_source_missing",
    });
  }

  return {
    schemaVersion: "scp-lifecycle-membership.v1",
    projectionRevision,
    activeProfiles: input.profiles
      .filter((profile) => profile.activeServing)
      .map((profile) => structuredClone(profile))
      .sort((left, right) => left.profileId.localeCompare(right.profileId)),
    tombstones: tombstones.sort((left, right) => left.profileId.localeCompare(right.profileId)),
  };
}

export const buildScpLifecycleMembershipProjection = serializeScpLifecycleMembershipProjection;

export function reconcileScpLifecycleProjectionFreshness(input: {
  projection: ScpLifecycleProjectionResult;
  membershipProjection: ScpLifecycleMembershipProjection;
  previousMembershipSnapshots: ScpLifecycleMembershipSnapshot[];
  counts: ScpLifecycleReconciliationCounts;
  sourceCapture: {
    complete: boolean;
    stable: boolean;
    asOfIso: string;
  };
  sourceFence: ScpLifecycleVersionFence;
  projectionFence: ScpLifecycleVersionFence;
  operationalSnapshot: ScpOperationalSnapshotBoundary;
  unavailableCount?: number;
  previousConsecutiveSuccesses?: number;
  requiredConsecutiveSuccesses?: number;
  maxAgeMs: number;
  nowIso?: string;
}): ScpLifecycleReconciliationEnvelope {
  const counts = validatedReconciliationCounts(input.counts);
  const nowIso = requireIso(input.nowIso ?? new Date().toISOString(), "nowIso");
  const captureAsOfIso = requireIso(input.sourceCapture.asOfIso, "sourceCapture.asOfIso");
  const snapshotGeneratedAtIso = requireIso(
    input.operationalSnapshot.generatedAtIso,
    "operationalSnapshot.generatedAtIso",
  );
  const snapshotStaleAfterIso = requireIso(
    input.operationalSnapshot.staleAfterIso,
    "operationalSnapshot.staleAfterIso",
  );
  const maxAgeMs = positiveSafeInteger(input.maxAgeMs, "maxAgeMs");
  const requiredConsecutiveSuccesses = positiveSafeInteger(
    input.requiredConsecutiveSuccesses ?? 2,
    "requiredConsecutiveSuccesses",
  );
  const previousConsecutiveSuccesses = nonNegativeSafeInteger(
    input.previousConsecutiveSuccesses ?? 0,
    "previousConsecutiveSuccesses",
  );
  const unavailableCount = nonNegativeSafeInteger(input.unavailableCount ?? 0, "unavailableCount");
  const sourceFence = validatedVersionFence(input.sourceFence, "sourceFence");
  const projectionFence = validatedVersionFence(input.projectionFence, "projectionFence");
  const versionsMatch = versionFencesMatch(sourceFence, projectionFence);
  const activeProfiles = input.projection.profiles.filter((profile) => profile.activeServing);
  const resolvedProfiles = activeProfiles.filter((profile) => (
    !profile.identityConflict && profile.resolutionState === "resolved"
  ));
  const identityConflictCount = activeProfiles.length - resolvedProfiles.length;
  const ghostCount = input.projection.profiles.filter((profile) => profile.membershipState === "ghost").length;
  const boundaryDeltas = {
    captureToObservations: counts.immutableObservations - counts.sourceCapture,
    observationsToNormalized: counts.normalizedCanonicalRecords - counts.immutableObservations,
    normalizedToProjection: counts.activeReadProjection - counts.normalizedCanonicalRecords,
    projectionToResponse: counts.uiApiResponses - counts.activeReadProjection,
  };
  const boundaryCountsMatch = Object.values(boundaryDeltas).every((delta) => delta === 0)
    && counts.normalizedCanonicalRecords === activeProfiles.length;
  const asOfIso = Date.parse(captureAsOfIso) <= Date.parse(snapshotGeneratedAtIso)
    ? captureAsOfIso
    : snapshotGeneratedAtIso;
  const ageMs = Math.max(0, Date.parse(nowIso) - Date.parse(asOfIso));
  const snapshotFresh = input.operationalSnapshot.status === "fresh"
    && input.operationalSnapshot.requiresRebuild !== true
    && Date.parse(snapshotStaleAfterIso) > Date.parse(nowIso);
  const maxAgeCompliant = ageMs <= maxAgeMs;
  const membershipQualityFlags = membershipProjectionQualityFlags({
    projection: input.projection,
    membershipProjection: input.membershipProjection,
    previousMembershipSnapshots: input.previousMembershipSnapshots,
    expectedProjectionRevision: projectionFence.projectionRevision,
  });

  const qualityFlags: ScpLifecycleReconciliationQualityFlag[] = [];
  if (counts.sourceCapture === 0) qualityFlags.push("source_capture_empty");
  if (!input.sourceCapture.complete) qualityFlags.push("source_capture_incomplete");
  if (!input.sourceCapture.stable) qualityFlags.push("source_capture_unstable");
  if (!boundaryCountsMatch) qualityFlags.push("boundary_count_mismatch");
  if (resolvedProfiles.length !== activeProfiles.length) qualityFlags.push("identity_coverage_incomplete");
  if (identityConflictCount > 0) qualityFlags.push("identity_conflict");
  if (unavailableCount > 0) qualityFlags.push("unavailable_conflict");
  if (ghostCount > 0) qualityFlags.push("ghost_conflict");
  qualityFlags.push(...membershipQualityFlags);
  if (!versionsMatch) qualityFlags.push("version_fence_mismatch");
  if (!maxAgeCompliant) qualityFlags.push("max_age_exceeded");
  if (!snapshotFresh) qualityFlags.push("operational_snapshot_not_fresh");

  const currentWindowEligible = qualityFlags.length === 0;
  const consecutiveSuccesses = currentWindowEligible ? previousConsecutiveSuccesses + 1 : 0;
  const parityEligible = currentWindowEligible && consecutiveSuccesses >= requiredConsecutiveSuccesses;
  if (currentWindowEligible && !parityEligible) qualityFlags.push("consecutive_success_window_incomplete");
  const status = reconciliationProjectionStatus(qualityFlags, parityEligible);
  const projection = cloneProjectionWithStatus(input.projection, status);

  return {
    schemaVersion: "scp-lifecycle-reconciliation.v1",
    counts,
    boundaryDeltas,
    identityCoverage: {
      resolved: resolvedProfiles.length,
      total: activeProfiles.length,
      ratio: activeProfiles.length === 0 ? 0 : resolvedProfiles.length / activeProfiles.length,
    },
    freshness: { asOfIso, ageMs, maxAgeMs, status },
    versionsMatch,
    currentWindowEligible,
    consecutiveSuccesses,
    requiredConsecutiveSuccesses,
    parityEligible,
    qualityFlags,
    projection,
  };
}

function membershipProjectionQualityFlags(input: {
  projection: ScpLifecycleProjectionResult;
  membershipProjection: ScpLifecycleMembershipProjection;
  previousMembershipSnapshots: ScpLifecycleMembershipSnapshot[];
  expectedProjectionRevision: number;
}): ScpLifecycleReconciliationQualityFlag[] {
  const flags: ScpLifecycleReconciliationQualityFlag[] = [];
  const membership = input.membershipProjection;
  if (
    membership.schemaVersion !== "scp-lifecycle-membership.v1"
    || membership.projectionRevision !== input.expectedProjectionRevision
  ) {
    flags.push("membership_projection_revision_mismatch");
  }
  const previousSnapshotRevisionsValid = input.previousMembershipSnapshots.every((snapshot) => (
    Number.isSafeInteger(snapshot.projectionRevision)
    && snapshot.projectionRevision >= 1
    && snapshot.projectionRevision < input.expectedProjectionRevision
  ));
  if (!previousSnapshotRevisionsValid) {
    flags.push("membership_previous_snapshot_revision_mismatch");
  }
  const previousSnapshotProfileIds = input.previousMembershipSnapshots.map((snapshot) => snapshot.profileId);
  const previousSnapshotProfileIdsUnique = new Set(previousSnapshotProfileIds).size
    === previousSnapshotProfileIds.length;

  const currentByProfile = new Map(input.projection.profiles.map((profile) => [profile.profileId, profile]));
  const expectedActiveIds = input.projection.profiles
    .filter((profile) => profile.activeServing)
    .map((profile) => profile.profileId)
    .sort();
  const expectedActiveById = new Map(
    input.projection.profiles
      .filter((profile) => profile.activeServing)
      .map((profile) => [profile.profileId, profile]),
  );
  const actualActiveIds = membership.activeProfiles.map((profile) => profile.profileId).sort();
  const activeIdsUnique = new Set(actualActiveIds).size === actualActiveIds.length;
  const activeMembershipValid = membership.activeProfiles.every((profile) => (
    profile.activeServing
    && (profile.membershipState === "active" || profile.membershipState === "reactivated")
    && canonicalValuesMatch(profile, expectedActiveById.get(profile.profileId))
  ));
  if (!activeIdsUnique || !activeMembershipValid || !sameSortedStrings(expectedActiveIds, actualActiveIds)) {
    flags.push("membership_active_set_mismatch");
  }

  const currentInactiveById = new Map(
    input.projection.profiles
      .filter((profile) => !profile.activeServing)
      .map((profile) => [profile.profileId, profile]),
  );
  const previousMissingById = new Map<string, ScpLifecycleMembershipSnapshot>();
  for (const previous of input.previousMembershipSnapshots) {
    if (previous.activeServing === false || currentByProfile.has(previous.profileId)) continue;
    if (!previousMissingById.has(previous.profileId)) {
      previousMissingById.set(previous.profileId, previous);
    }
  }
  const expectedTombstoneIds = new Set([...currentInactiveById.keys(), ...previousMissingById.keys()]);
  const actualTombstoneIds = membership.tombstones.map((tombstone) => tombstone.profileId).sort();
  const expectedTombstoneIdsSorted = [...expectedTombstoneIds].sort();
  const tombstonesUnique = new Set(actualTombstoneIds).size === actualTombstoneIds.length;
  const tombstonesCurrent = membership.tombstones.every((tombstone) => (
    tombstone.schemaVersion === "scp-lifecycle-membership.v1"
    && tombstone.kind === "tombstone"
    && tombstone.projectionRevision === membership.projectionRevision
    && (currentInactiveById.has(tombstone.profileId)
      ? currentInactiveTombstoneMatches(tombstone, currentInactiveById.get(tombstone.profileId)!)
      : previousMissingTombstoneMatches(tombstone, previousMissingById.get(tombstone.profileId)))
  ));
  if (
    !previousSnapshotProfileIdsUnique
    || !tombstonesUnique
    || !tombstonesCurrent
    || !sameSortedStrings(expectedTombstoneIdsSorted, actualTombstoneIds)
  ) {
    flags.push("membership_tombstone_mismatch");
  }
  return flags;
}

function sameSortedStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function currentInactiveTombstoneMatches(
  tombstone: ScpLifecycleMembershipTombstone,
  profile: ScpLifecycleProfile,
): boolean {
  const changedAtIso = validIso(profile.membershipChangedAtIso);
  const removedAtIso = validIso(tombstone.removedAtIso);
  return tombstone.programId === profile.programId
    && tombstone.membershipState === inactiveMembershipState(profile.membershipState)
    && tombstone.reasonCode === "membership_inactive"
    && changedAtIso !== null
    && removedAtIso !== null
    && removedAtIso === changedAtIso;
}

function previousMissingTombstoneMatches(
  tombstone: ScpLifecycleMembershipTombstone,
  previous: ScpLifecycleMembershipSnapshot | undefined,
): boolean {
  if (!previous) return false;
  return tombstone.programId === previous.programId
    && tombstone.membershipState === "source_missing"
    && tombstone.reasonCode === "previously_exposed_source_missing"
    && validIso(tombstone.removedAtIso) !== null;
}

function canonicalValuesMatch(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(canonicalValue(left), canonicalValue(right));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

function validatedReconciliationCounts(
  input: ScpLifecycleReconciliationCounts,
): ScpLifecycleReconciliationCounts {
  return {
    sourceCapture: nonNegativeSafeInteger(input.sourceCapture, "counts.sourceCapture"),
    immutableObservations: nonNegativeSafeInteger(input.immutableObservations, "counts.immutableObservations"),
    normalizedCanonicalRecords: nonNegativeSafeInteger(
      input.normalizedCanonicalRecords,
      "counts.normalizedCanonicalRecords",
    ),
    activeReadProjection: nonNegativeSafeInteger(input.activeReadProjection, "counts.activeReadProjection"),
    uiApiResponses: nonNegativeSafeInteger(input.uiApiResponses, "counts.uiApiResponses"),
  };
}

function validatedVersionFence(input: ScpLifecycleVersionFence, label: string): ScpLifecycleVersionFence {
  const sourceVersion = input.sourceVersion.trim();
  if (!sourceVersion) throw new Error(`${label}.sourceVersion must be non-empty`);
  return {
    sourceVersion,
    writerEpoch: nonNegativeSafeInteger(input.writerEpoch, `${label}.writerEpoch`),
    projectionRevision: positiveSafeInteger(input.projectionRevision, `${label}.projectionRevision`),
    generation: positiveSafeInteger(input.generation, `${label}.generation`),
  };
}

function versionFencesMatch(left: ScpLifecycleVersionFence, right: ScpLifecycleVersionFence): boolean {
  return left.sourceVersion === right.sourceVersion
    && left.writerEpoch === right.writerEpoch
    && left.projectionRevision === right.projectionRevision
    && left.generation === right.generation;
}

function reconciliationProjectionStatus(
  flags: ScpLifecycleReconciliationQualityFlag[],
  parityEligible: boolean,
): ScpLifecycleProfile["projectionStatus"] {
  if (parityEligible) return "fresh";
  if (flags.includes("max_age_exceeded") || flags.includes("operational_snapshot_not_fresh")) return "stale";
  if (flags.every((flag) => (
    flag === "source_capture_empty"
    || flag === "source_capture_incomplete"
    || flag === "source_capture_unstable"
    || flag === "consecutive_success_window_incomplete"
  ))) return "rebuilding";
  return "failed";
}

function cloneProjectionWithStatus(
  projection: ScpLifecycleProjectionResult,
  status: ScpLifecycleProfile["projectionStatus"],
): ScpLifecycleProjectionResult {
  return {
    profiles: projection.profiles.map((profile) => ({ ...profile, projectionStatus: status })),
    graph: projection.graph,
    identityProfileIdByProfile: { ...projection.identityProfileIdByProfile },
    videoHistoryByProfile: Object.fromEntries(
      Object.entries(projection.videoHistoryByProfile).map(([profileId, history]) => [
        profileId,
        history.map((item) => ({ ...item })),
      ]),
    ),
  };
}

function requireIso(value: string, label: string): string {
  const normalized = validIso(value);
  if (!normalized) throw new Error(`${label} must be a valid ISO timestamp`);
  return normalized;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function resolveMembershipForRows(rows: IndexedRow[]): MembershipResolution {
  const observations = rows.flatMap((item) => {
    const raw = item.row.membershipState ?? item.row.lifecycleMembershipState ?? item.row.servingMembership;
    if (raw === null || raw === undefined || raw === "") return [];
    const state = typeof raw === "string" && (SCP_LIFECYCLE_MEMBERSHIP_STATES as readonly string[]).includes(raw)
      ? raw as ScpLifecycleMembershipState
      : "quarantined" as const;
    const revision = nonNegativeInteger(
      item.row.membershipRevision ?? item.row.projectionRevision ?? item.row.sourceRevision,
    );
    const changedAtIso = timestamp(item.row, [
      "membershipChangedAtIso",
      "membershipUpdatedAtIso",
      "sourceUpdatedAtIso",
      "updatedAtIso",
      "createdAtIso",
    ]) ?? MISSING_EVIDENCE_TIMESTAMP;
    return [{ state, revision, changedAtIso, sourceRef: item.ref }];
  }).sort((left, right) => (
    left.revision - right.revision
    || left.changedAtIso.localeCompare(right.changedAtIso)
    || left.sourceRef.localeCompare(right.sourceRef)
  ));

  const latest = observations.at(-1);
  if (!latest) {
    // membership 증거가 전혀 없을 때 pass 타임스탬프(computedAtIso)를 실질 필드에 박으면
    // 매 pass마다 "변경됨"으로 판정되어 무변경 skip 가드가 성립할 수 없다. 파일의 다른
    // 증거-없음 경로(:562, :1085, :1102 등)와 동일하게 MISSING_EVIDENCE_TIMESTAMP를 쓴다.
    return { state: "active", changedAtIso: MISSING_EVIDENCE_TIMESTAMP, activeServing: true };
  }
  if (latest.state === "active") {
    return { state: latest.state, changedAtIso: latest.changedAtIso, activeServing: true };
  }
  if (latest.state === "reactivated") {
    const latestIndex = observations.length - 1;
    const hasEarlierInactive = observations.slice(0, latestIndex).some((item) => !isActiveMembershipState(item.state));
    return hasEarlierInactive
      ? { state: latest.state, changedAtIso: latest.changedAtIso, activeServing: true }
      : { state: "quarantined", changedAtIso: latest.changedAtIso, activeServing: false };
  }
  return { state: latest.state, changedAtIso: latest.changedAtIso, activeServing: false };
}

function isActiveMembershipState(state: ScpLifecycleMembershipState): boolean {
  return state === "active" || state === "reactivated";
}

function inactiveMembershipState(
  state: ScpLifecycleMembershipState,
): Exclude<ScpLifecycleMembershipState, "active" | "reactivated"> {
  if (state === "active" || state === "reactivated") return "quarantined";
  return state;
}

function requireProjectionRevision(value: unknown): number {
  const revision = nonNegativeInteger(value);
  if (revision < 1) throw new Error("membership projection revision must be a positive safe integer");
  return revision;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validIso(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) return null;
  try {
    return new Date(epochMs).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

function identityConflictEvidenceForRows(rows: IndexedRow[]): IdentityConflictEvidence | null {
  const evidence = [
    contradictoryQualificationEvidence(rows),
    ambiguousStrongCollisionEvidence(rows),
  ].filter((value): value is IdentityConflictEvidence => Boolean(value));
  if (evidence.length === 0) return null;
  return {
    enteredAt: evidence.map((item) => item.enteredAt).sort().at(-1) ?? MISSING_EVIDENCE_TIMESTAMP,
    sourceRefs: [...new Set(evidence.flatMap((item) => item.sourceRefs))].sort(),
  };
}

function contradictoryQualificationEvidence(rows: IndexedRow[]): IdentityConflictEvidence | null {
  const verdictRows = rows.flatMap((item) => {
    const verdict = qualificationVerdict(item);
    return verdict ? [{ item, verdict }] : [];
  });
  const verdicts = new Set(verdictRows.map(({ verdict }) => verdict));
  if (!verdicts.has("pass") || !verdicts.has("fail")) return null;
  const timestamps = verdictRows
    .map(({ item }) => qualificationVerdictTimestamp(item))
    .filter((value): value is string => Boolean(value))
    .sort();
  return {
    enteredAt: timestamps.at(-1) ?? MISSING_EVIDENCE_TIMESTAMP,
    sourceRefs: [...new Set(verdictRows.map(({ item }) => item.ref))].sort(),
  };
}

function ambiguousStrongCollisionEvidence(rows: IndexedRow[]): IdentityConflictEvidence | null {
  const sourceRefs = new Set<string>();
  for (const kind of ["leadId", "creatorId"] as const) {
    const refsByAlias = new Map<string, Set<string>>();
    for (const item of rows) {
      for (const alias of item.aliases) {
        if (alias.kind !== kind || alias.strength !== "strong") continue;
        upsertSet(refsByAlias, alias.aliasId).add(item.ref);
      }
    }
    if (refsByAlias.size <= 1) continue;
    for (const refs of refsByAlias.values()) {
      for (const ref of refs) sourceRefs.add(ref);
    }
  }
  if (sourceRefs.size === 0) return null;
  const timestamps = rows
    .filter((item) => sourceRefs.has(item.ref))
    .map((item) => timestamp(item.row, [
      "decidedAtIso",
      "qualifiedAtIso",
      "qualificationUpdatedAtIso",
      "updatedAtIso",
      "submittedAtIso",
      "createdAtIso",
      "createdAt",
    ]))
    .filter((value): value is string => Boolean(value))
    .sort();
  return {
    enteredAt: timestamps.at(-1) ?? MISSING_EVIDENCE_TIMESTAMP,
    sourceRefs: [...sourceRefs].sort(),
  };
}

function qualificationVerdict(item: IndexedRow): "pass" | "fail" | null {
  if (item.source === "program_sheet_leads") {
    const decision = item.row.qualificationStatus ?? item.row.status;
    if (isPassStatus(decision)) return "pass";
    if (isFailStatus(decision) || isRejectedStatus(decision)) return "fail";
    return null;
  }
  if (item.source === "qualification_decisions") {
    const aiRecommendation = objectValue(item.row.aiRecommendation);
    const decision = item.row.finalVerdict
      ?? item.row.decision
      ?? item.row.status
      ?? item.row.result
      ?? aiRecommendation?.verdict;
    if (isPassStatus(decision) || isApprovedStatus(decision)) return "pass";
    if (isFailStatus(decision) || isRejectedStatus(decision)) return "fail";
  }
  return null;
}

function qualificationVerdictTimestamp(item: IndexedRow): string | null {
  return item.source === "program_sheet_leads"
    ? timestamp(item.row, ["qualifiedAtIso", "qualificationUpdatedAtIso", "updatedAtIso", "submittedAtIso", "createdAtIso"])
    : timestamp(item.row, ["decidedAtIso", "createdAtIso", "updatedAtIso"]);
}

export const projectScpLifecycle = projectScpLifecycleProfiles;

function indexRows(sources: ScpLifecycleSources): IndexedRow[] {
  const indexed: IndexedRow[] = [];
  for (const source of SOURCE_NAMES) {
    const rows = sources[source] ?? [];
    rows.forEach((row, index) => {
      const ref = `${source}/${docId(row, index)}`;
      const aliases = scopeWeakOnlyAliases(aliasesForRow(source, row), ref);
      indexed.push({ source, index, ref, row, aliases });
    });
  }
  return indexed;
}


function aliasesForRow(source: SourceName, row: ScpSourceRow): ScpAlias[] {
  const aliases: ScpAlias[] = [];
  addAliases(aliases, "email", row, EMAIL_KEYS);
  addAliases(aliases, "handle", row, HANDLE_KEYS);
  addAliases(aliases, "channelId", row, CHANNEL_KEYS);
  addAliases(aliases, "creatorId", row, CREATOR_KEYS);
  addAliases(aliases, "leadId", row, LEAD_KEYS);
  addAliases(aliases, "submissionId", row, SUBMISSION_KEYS);
  addAliases(aliases, "videoId", row, VIDEO_KEYS);
  addAliases(aliases, "trackingId", row, TRACKING_KEYS);
  addAliases(aliases, "conversationId", row, CONVERSATION_KEYS);

  if (source === "program_sheet_leads") addAlias(aliases, "leadId", row, "id");
  if (source === "program_applications") {
    addAlias(aliases, "leadId", row, "leadId");
    addAlias(aliases, "creatorId", row, "creatorId");
  }
  if (source === "submissions") addAlias(aliases, "submissionId", row, "id");
  if (source === "videos") addAlias(aliases, "videoId", row, "id");
  const scpReviewMeta = objectValue(row.scpReviewMeta);
  if (scpReviewMeta) {
    for (const key of SUBMISSION_KEYS) addAlias(aliases, "submissionId", scpReviewMeta, key);
    for (const key of LEAD_KEYS) addAlias(aliases, "leadId", scpReviewMeta, key);
    for (const key of CREATOR_KEYS) addAlias(aliases, "creatorId", scpReviewMeta, key);
  }
  return dedupeAliases(aliases);
}

function scopeWeakOnlyAliases(aliases: ScpAlias[], ref: string): ScpAlias[] {
  if (aliases.some((alias) => alias.strength === "strong")) return aliases;
  return aliases.map((alias) => {
    if (alias.kind !== "handle") return alias;
    return { ...alias, aliasId: `${alias.aliasId}:weak:${shortHash(ref)}` };
  });
}

function candidatesForRow(item: IndexedRow, componentRows: IndexedRow[]): EventCandidate[] {
  const row = item.row;
  const out: EventCandidate[] = [];
  const add = (state: ScpLifecycleState, at?: string | null): void => {
    if (at) out.push({ state, enteredAt: at, sourceRef: item.ref, rank: STATE_RANK[state] });
  };

  if (item.source === "scp_outreach") {
    add("coldmail_sent", timestamp(row, ["coldSentAtIso", "sentAtIso", "sentAt", "createdAtIso", "createdAt"]));
    if (isReplyStatus(row.status) || row.hasReply === true || timestamp(row, ["replyReceivedAtIso", "repliedAtIso", "lastReplyAtIso"])) {
      add("reply_received", timestamp(row, ["replyReceivedAtIso", "repliedAtIso", "lastReplyAtIso", "updatedAtIso", "createdAtIso"]));
    }
  }
  if (item.source === "scp_coldmail_history") {
    add("coldmail_sent", timestamp(row, ["sentAtIso", "sentAt", "createdAtIso", "createdAt"]));
    if (row.hasReply === true || timestamp(row, ["replyReceivedAtIso", "repliedAtIso", "replyAtIso", "lastReplyAtIso"])) {
      add("reply_received", timestamp(row, ["replyReceivedAtIso", "repliedAtIso", "replyAtIso", "lastReplyAtIso", "updatedAtIso"]));
    }
  }
  if (item.source === "mail_outbound_log") {
    const kind = lower(row.mailType ?? row.templateType ?? row.kind ?? row.stage);
    const status = row.status;
    // W118 + 2026-09-05 적대 리뷰 P1: 발송 마일스톤은 **허용목록 1종**으로만 만든다.
    //   종전 거부목록(blocked/skipped/skipped_duplicate)은 `suppressed` · `bounced` ·
    //   `retryable_failed` · `dead_letter` · `queued` · 상태 결측을 전부 통과시켰고,
    //   `recordMailOutboundLog` 가 그런 행에도 `sentAtIso` 를 찍어 "안 나간 콜드메일"이 이력에 박혔다.
    //   `mail_outbound_log` 는 정규화된 deliveryState 를 항상 싣는 정본 원장이라 폴백이 필요 없다.
    const delivered = isDeliveredOutboundLogRow(row);
    if (delivered && (kind.includes("cold") || kind.includes("outreach"))) add("coldmail_sent", timestamp(row, ["sentAtIso", "createdAtIso", "createdAt"]));
    if (kind.includes("pass") && isMailPendingStatus(status)) add("pass_mail_pending", timestamp(row, ["createdAtIso", "queuedAtIso"]));
    if (kind.includes("fail") && isMailPendingStatus(status)) add("fail_mail_pending", timestamp(row, ["createdAtIso", "queuedAtIso"]));
    if (row.hasReply === true || timestamp(row, ["replyReceivedAtIso", "repliedAtIso", "lastReplyAtIso"])) {
      add("reply_received", timestamp(row, ["replyReceivedAtIso", "repliedAtIso", "lastReplyAtIso", "updatedAtIso", "createdAtIso"]));
    }
  }
  if (item.source === "conversation_replies") {
    add("reply_received", timestamp(row, ["receivedAtIso", "lastReplyAtIso", "lastInboundAtIso", "lastMessageAtIso", "createdAtIso", "updatedAtIso"]));
  }
  if (item.source === "conversations") {
    // 응답자 과대집계 갭 수리: outbound-only conversation rows must not imply creator
    // replies. Inbound markers: explicit hasCreatorReply flag, a creator-authored last
    // message (case-insensitive, codebase-wide lower() convention), or a PARSEABLE
    // inbound timestamp — unparseable strings must not mint reply evidence.
    if (hasInboundConversationMarker(row)) {
      add("reply_received", timestamp(row, ["receivedAtIso", "lastReplyAtIso", "lastInboundAtIso", "lastMessageAtIso", "createdAtIso", "updatedAtIso"]));
    }
  }
  if (item.source === "program_sheet_leads") {
    add("form_submitted", timestamp(row, ["submittedAtIso", "createdAtIso", "createdAt"]));
    const q = row.qualificationStatus ?? row.status;
    if (isPendingStatus(q)) add("qualification_pending", timestamp(row, ["qualificationUpdatedAtIso", "updatedAtIso", "submittedAtIso", "createdAtIso"]));
    const verdict = qualificationVerdict(item);
    const verdictAt = qualificationVerdictTimestamp(item) ?? MISSING_EVIDENCE_TIMESTAMP;
    if (verdict === "pass") add("qualification_passed", verdictAt);
    if (verdict === "fail") add("qualification_failed", verdictAt);
  }
  if (item.source === "program_applications") {
    const status = row.qualificationStatus ?? row.applicationStatus ?? row.status;
    const at = timestamp(row, ["submittedAtIso", "appliedAtIso", "updatedAtIso", "createdAtIso", "createdAt"]) ?? MISSING_EVIDENCE_TIMESTAMP;
    if (isPassStatus(status) || isApprovedStatus(status)) add("qualification_passed", at);
    else if (isFailStatus(status) || isRejectedStatus(status)) add("qualification_failed", at);
    else add("qualification_pending", at);
  }
  if (item.source === "qualification_decisions") {
    const aiRecommendation = row.aiRecommendation && typeof row.aiRecommendation === "object" ? row.aiRecommendation as Record<string, unknown> : {};
    const decision = row.finalVerdict ?? row.decision ?? row.status ?? row.result ?? aiRecommendation.verdict;
    if (isPendingStatus(decision)) add("qualification_pending", timestamp(row, ["decidedAtIso", "createdAtIso"]));
    const verdict = qualificationVerdict(item);
    const verdictAt = qualificationVerdictTimestamp(item) ?? MISSING_EVIDENCE_TIMESTAMP;
    if (verdict === "pass") add("qualification_passed", verdictAt);
    if (verdict === "fail") add("qualification_failed", verdictAt);
  }
  if (item.source === "creator_links") {
    if (!isFailedLinkStatus(row.status)) {
      add("onelink_sent", timestamp(row, ["sentAtIso", "issuedAtIso", "createdAtIso"]));
    }
    const uid = row.uidStatus ?? row.status;
    if (statusIs(uid, ["requested", "uid_requested"])) add("uid_requested", timestamp(row, ["uidRequestedAtIso", "updatedAtIso", "createdAtIso"]));
    if (statusIs(uid, ["received", "uid_received"]) || row.uid) add("uid_received", timestamp(row, ["uidReceivedAtIso", "updatedAtIso", "createdAtIso"]));
  }
  if (item.source === "scp_mail_results") {
    const mailType = lower(row.mailType ?? row.templateType ?? row.templateKind ?? row.kind);
    const status = row.status ?? row.result;
    if (mailType.includes("pass") && (isMailPendingStatus(status) || isMailHeldStatus(status))) add("pass_mail_pending", timestamp(row, ["createdAtIso", "updatedAtIso"]));
    if (mailType.includes("fail") && (isMailPendingStatus(status) || isMailHeldStatus(status))) add("fail_mail_pending", timestamp(row, ["createdAtIso", "updatedAtIso"]));
    if (mailType.includes("pass") && (statusIs(status, ["sent", "delivered"]) || row.onelinkUrl)) add("onelink_sent", timestamp(row, ["sentAtIso", "createdAtIso", "updatedAtIso"]));
  }
  if (item.source === "submission_tasks") add("video_task_issued", timestamp(row, ["issuedAtIso", "createdAtIso", "createdAt"]));
  if (item.source === "submissions") {
    add("video_submitted", timestamp(row, ["submittedAtIso", "createdAtIso", "createdAt"]));
    const status = row.reviewStatus ?? row.status;
    if (isPendingStatus(status)) add("video_review_pending", timestamp(row, ["reviewStatusAtIso", "updatedAtIso", "submittedAtIso", "createdAtIso"]));
    if (isApprovedStatus(status)) add("video_approved", timestamp(row, ["approvedAtIso", "reviewStatusAtIso", "updatedAtIso"]));
    if (isRejectedStatus(status)) add("video_rejected", timestamp(row, ["rejectedAtIso", "reviewStatusAtIso", "updatedAtIso"]));
    if (isNeedsResubmissionStatus(status)) add("needs_resubmission", timestamp(row, ["reviewStatusAtIso", "updatedAtIso"]));
    if (isDoneFailedStatus(status)) add("done_failed", timestamp(row, ["doneAtIso", "updatedAtIso"]));
    if (isLiveTrackingEligible(row, componentRows)) add("live_tracking", liveTrackingTimestamp(row, componentRows));
  }
  if (item.source === "review_ledger") {
    const status = reviewLedgerStatus(row);
    const at = reviewLedgerTimestamp(row);
    if (isPendingStatus(status)) add("video_review_pending", at);
    if (isApprovedStatus(status) || isPassStatus(status)) add("video_approved", at);
    if (isRejectedStatus(status) || statusIs(status, ["blocked"])) add("video_rejected", at);
    if (isNeedsResubmissionStatus(status) || statusIs(status, ["revise"])) add("needs_resubmission", at);
    if (isDoneFailedStatus(status) || statusIs(status, ["human_handled"])) add("done_failed", at);
  }
  if (item.source === "gem_grants") {
    const status = row.status;
    if (isGemScheduledStatus(status)) add("gem_scheduled", timestamp(row, ["scheduledAtIso", "fridayAtIso", "createdAtIso"]));
    if (isGemPaidStatus(status)) add("gem_paid", timestamp(row, ["paidAtIso", "updatedAtIso", "createdAtIso"]));
  }
  return out;
}

function isLiveTrackingEligible(submission: ScpSourceRow, rows: IndexedRow[]): boolean {
  const current = currentApprovedVideoEvidence(submission, rows);
  if (!current) return false;

  return rows.some((row) => isMatchingActiveViewSeries(row, current));
}

function currentApprovedVideoEvidence(submission: ScpSourceRow, rows: IndexedRow[]): { submissionId: string; videoIds: Set<string>; sawScpReviewVideo: boolean } | null {
  if (isSoftHidden(submission)) return null;
  const submissionStatus = submission.reviewStatus ?? submission.status;
  if (!isApprovedStatus(submissionStatus)) return null;
  const submissionId = normalizeAliasValue("submissionId", submission.submissionId ?? submission.id);
  if (!submissionId) return null;
  if (hasLaterNonApprovedReview(submissionId, rows, timestamp(submission, ["approvedAtIso", "reviewStatusAtIso", "updatedAtIso"]))) return null;

  const videoIds = new Set<string>();
  let sawScpReviewVideo = false;
  for (const row of rows) {
    if (row.source !== "videos") continue;
    const meta = objectValue(row.row.scpReviewMeta);
    const metaSubmissionId = normalizeAliasValue("submissionId", meta?.submissionId);
    if (metaSubmissionId !== submissionId) continue;
    sawScpReviewVideo = true;
    if (isSoftHidden(row.row)) continue;
    const metaStatus = meta?.reviewStatus ?? row.row.reviewStatus ?? row.row.status;
    if (!isApprovedStatus(metaStatus)) continue;
    const videoId = normalizeAliasValue("videoId", row.row.videoId ?? row.row.id ?? row.row.url);
    if (videoId) videoIds.add(videoId);
  }

  if (!sawScpReviewVideo || videoIds.size === 0) return null;
  return { submissionId, videoIds, sawScpReviewVideo };
}

function isMatchingTrackingRow(row: IndexedRow, current: { submissionId: string; videoIds: Set<string>; sawScpReviewVideo: boolean }): boolean {
  if (row.source !== "video_view_series" && row.source !== "video_view_snapshots") return false;
  if (isSoftHidden(row.row)) return false;
  const rowSubmissionId = normalizeAliasValue("submissionId", row.row.submissionId);
  const rowVideoId = normalizeAliasValue("videoId", row.row.videoId ?? row.row.youtubeUrl ?? row.row.url);
  if (rowSubmissionId !== current.submissionId && (!rowVideoId || !current.videoIds.has(rowVideoId))) return false;
  if (rowSubmissionId === current.submissionId && current.sawScpReviewVideo && rowVideoId && !current.videoIds.has(rowVideoId)) return false;
  return true;
}

function isMatchingActiveViewSeries(row: IndexedRow, current: { submissionId: string; videoIds: Set<string>; sawScpReviewVideo: boolean }): boolean {
  if (row.source !== "video_view_series") return false;
  if (!isMatchingTrackingRow(row, current)) return false;
  const status = row.row.status ?? row.row.trackingStatus ?? row.row.scheduleStatus;
  if (!isActiveTrackingStatus(status)) return false;
  return hasAny(row.row, ["scheduledAtIso", "startedAtIso", "updatedAtIso", "createdAtIso", "points"]);
}


function reviewLedgerStatus(row: ScpSourceRow): unknown {
  return row.reviewStatus ?? row.toStatus ?? row.status;
}

function reviewLedgerTimestamp(row: ScpSourceRow): string | null {
  const directDecision = timestamp(row, ["decidedAtIso", "paidAtIso", "paidAt", "blockedAt", "humanReplyAt", "updatedAtIso", "syncedAtIso"]);
  if (directDecision) return directDecision;
  const transition = objectValue(row.transition);
  const transitionDecision = transition ? timestamp(transition, ["decidedAtIso", "createdAtIso"]) : null;
  return transitionDecision ?? timestamp(row, ["createdAtIso"]);
}

function isNonApprovedReviewLedgerStatus(status: unknown): boolean {
  return isRejectedStatus(status)
    || isNeedsResubmissionStatus(status)
    || isPendingStatus(status)
    || isDoneFailedStatus(status)
    || statusIs(status, ["blocked", "revise", "human_handled"]);
}
function hasLaterNonApprovedReview(submissionId: string, rows: IndexedRow[], approvedAt: string | null): boolean {
  return rows.some((row) => {
    if (row.source !== "review_ledger") return false;
    const rowSubmissionId = normalizeAliasValue("submissionId", row.row.submissionId);
    if (rowSubmissionId !== submissionId) return false;
    const status = reviewLedgerStatus(row.row);
    if (!isNonApprovedReviewLedgerStatus(status)) return false;
    const at = reviewLedgerTimestamp(row.row);
    return !approvedAt || !at || at > approvedAt;
  });
}

function liveTrackingTimestamp(submission: ScpSourceRow, rows: IndexedRow[]): string {
  const current = currentApprovedVideoEvidence(submission, rows);
  const candidates = current
    ? rows
      .filter((row) => isMatchingActiveViewSeries(row, current))
      .map((row) => timestamp(row.row, ["scheduledAtIso", "startedAtIso", "updatedAtIso", "createdAtIso"]))
      .filter((value): value is string => Boolean(value))
      .sort()
    : [];
  return candidates[candidates.length - 1] ?? timestamp(submission, ["approvedAtIso", "updatedAtIso", "createdAtIso"]) ?? new Date(0).toISOString();
}

function chooseWinningCandidate(candidates: EventCandidate[]): EventCandidate | null {
  return candidates.sort((a, b) => b.rank - a.rank || b.enteredAt.localeCompare(a.enteredAt))[0] ?? null;
}

const PROGRAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,139}$/;
const PROGRAM_SCOPE_KEYS = ["canonicalProgramId", "programId", "programRef"] as const;

function analyzeProgramScopes(indexed: IndexedRow[]): ProgramScopeAnalysis {
  const projectableRows: IndexedRow[] = [];
  const programIdBySourceRef = new Map<string, string>();
  const conflicts: ScpAliasConflict[] = [];

  for (const item of indexed) {
    const scope = resolveProgramScopeForRow(item.row);
    if (scope.programId) {
      projectableRows.push(item);
      programIdBySourceRef.set(item.ref, scope.programId);
      continue;
    }
    const malformed = scope.status === "malformed";
    conflicts.push({
      type: malformed ? "program_scope_malformed" : "program_scope_conflict",
      aliasId: `programScope:${shortHash([item.ref, scope.status].join("\u0000")).slice(0, 16)}`,
      message: malformed
        ? "Program scope evidence is malformed and requires bounded migration review."
        : "Program scope declarations conflict and require bounded migration review.",
      sourceRefs: [item.ref],
    });
  }

  return {
    projectableRows,
    programIdBySourceRef,
    conflicts: conflicts.sort((left, right) => left.sourceRefs[0].localeCompare(right.sourceRefs[0])),
  };
}

function resolveProgramScopeForRow(row: ScpSourceRow): ProgramScopeResolution {
  const scpReviewMeta = objectValue(row.scpReviewMeta);
  const containers = [
    row,
    scpReviewMeta,
    objectValue(row.authoritative),
    objectValue(scpReviewMeta?.authoritative),
  ].filter((value): value is Record<string, unknown> => Boolean(value));
  const declarations: string[] = [];
  let malformed = false;

  for (const container of containers) {
    for (const key of PROGRAM_SCOPE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(container, key)) continue;
      const parsed = key === "programRef"
        ? programIdFromExactRef(container[key])
        : programIdFromDeclaration(container[key]);
      if (parsed.status === "absent") continue;
      if (parsed.status === "malformed") {
        malformed = true;
        continue;
      }
      declarations.push(parsed.programId);
    }
  }

  if (malformed) return { status: "malformed", programId: null };
  const canonicalIds = [...new Set(declarations.map(normalizeScpProgramId))].sort();
  if (canonicalIds.length > 1) return { status: "conflict", programId: null };
  if (canonicalIds[0]) return { status: "resolved", programId: canonicalIds[0] };
  // The existing lifecycle contract explicitly retains pre-scope rows in canonical SCP.
  // Never infer a sibling program from identity adjacency; a migration must stamp scope.
  return { status: "legacy", programId: canonicalScpProgramId };
}

type ParsedProgramDeclaration =
  | { status: "absent" }
  | { status: "malformed" }
  | { status: "resolved"; programId: string };

function programIdFromDeclaration(value: unknown): ParsedProgramDeclaration {
  if (value === null || value === undefined) return { status: "absent" };
  if (typeof value !== "string") return { status: "malformed" };
  const programId = value.trim();
  if (!programId) return { status: "absent" };
  return PROGRAM_ID_PATTERN.test(programId)
    ? { status: "resolved", programId }
    : { status: "malformed" };
}

function programIdFromExactRef(value: unknown): ParsedProgramDeclaration {
  if (value === null || value === undefined) return { status: "absent" };
  if (typeof value === "string" && !value.trim()) return { status: "absent" };
  const reference = objectValue(value);
  const path = typeof value === "string"
    ? value.trim()
    : reference && typeof reference.path === "string"
      ? reference.path.trim()
      : "";
  const match = /^programs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,139})$/.exec(path);
  return match?.[1]
    ? { status: "resolved", programId: match[1] }
    : { status: "malformed" };
}

function programScopedLifecycleProfileId(identityProfileId: string, programId: string): string {
  return `scp_profile_${shortHash(["scp_lifecycle_program_profile_v2", programId, identityProfileId].join("\u0000"))}`;
}

function primaryConversationIdForRows(rows: IndexedRow[]): string | null {
  const conversations = rows.filter((item) => item.source === "conversations");
  const inbound = conversations.filter((item) => hasInboundConversationMarker(item.row));
  const candidates = inbound.length > 0 ? inbound : conversations;
  const selected = candidates.sort((left, right) => {
    const byTime = conversationTimestamp(right.row).localeCompare(conversationTimestamp(left.row));
    return byTime || left.ref.localeCompare(right.ref);
  })[0];
  return selected ? conversationDocId(selected) : null;
}

function hasInboundConversationMarker(row: ScpSourceRow): boolean {
  const inboundAt = stringValue(row.lastInboundAtIso);
  return row.hasCreatorReply === true ||
    lower(row.lastMessageFrom) === "creator" ||
    (inboundAt !== null && Number.isFinite(Date.parse(inboundAt)));
}

function conversationTimestamp(row: ScpSourceRow): string {
  for (const key of ["receivedAtIso", "lastReplyAtIso", "lastInboundAtIso", "lastMessageAtIso", "updatedAtIso", "createdAtIso", "createdAt"]) {
    const value = stringValue(row[key]);
    if (value && Number.isFinite(Date.parse(value))) return value;
  }
  return "";
}

function conversationDocId(item: IndexedRow): string {
  return stringValue(item.row.id) ?? docId(item.row, item.index);
}

function buildLatestVideoStatus(rows: IndexedRow[]): Array<Record<string, unknown>> {
  const statuses: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (row.source !== "submissions" && row.source !== "review_ledger" && row.source !== "videos") continue;
    const videoId = normalizeAliasValue("videoId", row.row.videoId ?? row.row.youtubeUrl ?? row.row.videoUrl ?? row.row.url ?? row.row.id);
    const submissionId = normalizeAliasValue("submissionId", row.row.submissionId ?? row.row.id);
    if (!videoId && !submissionId) continue;
    statuses.push({
      sourceRef: row.ref,
      videoId,
      submissionId,
      status: row.row.reviewStatus ?? row.row.status ?? row.row.toStatus ?? null,
      updatedAtIso: timestamp(row.row, ["decidedAtIso", "approvedAtIso", "submittedAtIso", "updatedAtIso", "createdAtIso"]),
    });
  }
  return statuses.sort((a, b) => String(b.updatedAtIso ?? "").localeCompare(String(a.updatedAtIso ?? "")) || String(a.sourceRef).localeCompare(String(b.sourceRef)));
}

function providerConfirmedOnelinkSourceRefs(rows: IndexedRow[]): string[] {
  return [...new Set(rows.filter((item) => {
    if (item.source === "creator_links") {
      return !isFailedLinkStatus(item.row.status) && Boolean(timestamp(item.row, [
        "sentAtIso",
        "providerSentAtIso",
        "deliveredAtIso",
        "providerDeliveredAtIso",
      ]));
    }
    if (item.source === "scp_mail_results") {
      const mailType = lower(item.row.mailType ?? item.row.templateType ?? item.row.templateKind ?? item.row.kind);
      const status = item.row.status ?? item.row.result;
      const deliveryTruth = objectValue(item.row.deliveryTruth);
      const providerReceipt = objectValue(item.row.providerReceipt);
      return mailType.includes("pass") &&
        statusIs(status, ["sent", "delivered"]) &&
        Boolean(timestamp(item.row, ["sentAtIso", "deliveredAtIso"])) &&
        (
          deliveryTruth?.providerConfirmed === true ||
          providerReceipt?.providerConfirmed === true ||
          Boolean(timestamp(item.row, ["providerSentAtIso", "providerDeliveredAtIso"]))
        );
    }
    return false;
  }).map((item) => item.ref))].sort();
}

function buildCounts(rows: IndexedRow[], state: ScpLifecycleResolutionState): Record<string, number> {
  const counts: Record<string, number> = {
    sourceRows: rows.length,
    currentStateRank: state === SCP_IDENTITY_CONFLICT_STATE
      ? IDENTITY_CONFLICT_STATE_RANK
      : STATE_RANK[state],
  };
  for (const row of rows) counts[row.source] = (counts[row.source] ?? 0) + 1;
  counts.videos = rows.filter((row) => row.source === "videos").length;
  counts.submissions = rows.filter((row) => row.source === "submissions").length;
  return counts;
}

function nextRequiredActionFor(state: ScpLifecycleResolutionState): string {
  if (state === SCP_IDENTITY_CONFLICT_STATE) return "resolve_identity_conflict";
  const actions: Record<ScpLifecycleState, string> = {
    coldmail_sent: "wait_for_reply",
    reply_received: "send_or_confirm_form",
    form_submitted: "run_qualification",
    qualification_pending: "decide_qualification",
    qualification_passed: "prepare_pass_mail",
    qualification_failed: "prepare_fail_mail",
    pass_mail_pending: "send_pass_mail_after_gate",
    fail_mail_pending: "send_fail_mail_after_gate",
    onelink_sent: "request_uid",
    uid_requested: "wait_for_uid",
    uid_received: "schedule_gem_grant",
    gem_scheduled: "mark_gem_paid_after_audit",
    gem_paid: "issue_video_task",
    video_task_issued: "wait_for_video_submission",
    video_submitted: "review_video",
    video_review_pending: "review_video",
    video_approved: "start_view_tracking",
    video_rejected: "close_or_resubmit",
    needs_resubmission: "request_resubmission",
    live_tracking: "monitor_views",
    done_failed: "none",
  };
  return actions[state];
}

function blockingReasonFor(state: ScpLifecycleResolutionState, rows: IndexedRow[]): string | null {
  if (state === SCP_IDENTITY_CONFLICT_STATE) return SCP_IDENTITY_CONFLICT_AUTOMATION_REASON_CODE;
  if (state === "pass_mail_pending" || state === "fail_mail_pending") return "human_mail_gate_or_draft_only";
  if (state === "qualification_pending") return "qualification_decision_required";
  if (state === "video_review_pending") return "video_review_required";
  if (state === "video_approved" && !rows.some((row) => row.source === "video_view_series" || row.source === "video_view_snapshots")) return "view_tracking_not_matched";
  return null;
}

function isSoftHidden(row: ScpSourceRow): boolean {
  return Boolean(
    row.hidden === true ||
    row.softHidden === true ||
    row.archived === true ||
    row.deleted === true ||
    hasAny(row, ["hiddenAt", "hiddenAtIso", "softHiddenAt", "softHiddenAtIso", "archivedAt", "archivedAtIso", "deletedAt", "deletedAtIso"]),
  );
}

function addAliases(out: ScpAlias[], kind: ScpAliasKind, row: ScpSourceRow, keys: string[]): void {
  for (const key of keys) addAlias(out, kind, row, key);
}

function addAlias(out: ScpAlias[], kind: ScpAliasKind, row: ScpSourceRow, key: string): void {
  const value = row[key];
  if (Array.isArray(value)) {
    for (const item of value) {
      const alias = makeScpAlias(kind, item);
      if (alias) out.push(alias);
    }
    return;
  }
  const alias = makeScpAlias(kind, value);
  if (alias) out.push(alias);
}

function dedupeAliases(aliases: ScpAlias[]): ScpAlias[] {
  return [...new Map(aliases.map((alias) => [alias.aliasId, alias])).values()];
}

function chooseStableAlias(aliasIds: string[], aliases: Map<string, ScpAlias>): string | null {
  const order: ScpAliasKind[] = ["leadId", "creatorId", "submissionId", "channelId", "email", "videoId", "conversationId", "trackingId", "handle"];
  return aliasIds.sort((a, b) => {
    const aliasA = aliases.get(a);
    const aliasB = aliases.get(b);
    return order.indexOf(aliasA?.kind ?? "handle") - order.indexOf(aliasB?.kind ?? "handle") || a.localeCompare(b);
  })[0] ?? null;
}

function sourceRefsForAliasIds(indexed: IndexedRow[], aliasIds: Set<string>): string[] {
  return [...new Set(indexed.filter((item) => item.aliases.some((alias) => aliasIds.has(alias.aliasId))).map((item) => item.ref))].sort();
}

function timestamp(row: ScpSourceRow, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringValue(row[key]);
    if (value) return value;
  }
  return null;
}

function docId(row: ScpSourceRow, index: number): string {
  const value = stringValue(row.id ?? row.docId ?? row.leadId ?? row.submissionId ?? row.videoId ?? row.conversationId);
  return value ? safeKey(value) : String(index);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function lower(value: unknown): string {
  return String(value ?? "").toLowerCase();
}



function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasAny(row: ScpSourceRow, keys: string[]): boolean {
  return keys.some((key) => row[key] !== undefined && row[key] !== null && row[key] !== "");
}

function upsertSet<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let value = map.get(key);
  if (!value) {
    value = new Set<V>();
    map.set(key, value);
  }
  return value;
}

function upsertArray<K, V>(map: Map<K, V[]>, key: K): V[] {
  let value = map.get(key);
  if (!value) {
    value = [];
    map.set(key, value);
  }
  return value;
}

function stableAliasKey(value: string): string {
  return `${safeKey(value)}_${shortHash(value).slice(0, 12)}`;
}

function statusKey(value: unknown): string {
  return lower(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function statusIs(value: unknown, allowed: string[]): boolean {
  const key = statusKey(value);
  return key.length > 0 && allowed.includes(key);
}

function isReplyStatus(value: unknown): boolean {
  return statusIs(value, ["reply", "replied", "reply_received", "responded", "response_received"]);
}

function isPendingStatus(value: unknown): boolean {
  return statusIs(value, ["pending", "review_pending", "qualification_pending", "video_review_pending"]);
}

function isMailPendingStatus(value: unknown): boolean {
  return statusIs(value, ["pending", "draft", "draft_only", "queued"]);
}

// held/blocked mail results are stalled at the human gate — they must keep the
// profile visible at the mail-pending step (with the gate blocker) instead of
// producing no lifecycle candidate at all.
function isMailHeldStatus(value: unknown): boolean {
  return statusIs(value, ["held", "hold", "blocked"]);
}

// creator_links rows that failed or were rolled back must never advance a profile
// into the onelink_sent success flow.
function isFailedLinkStatus(value: unknown): boolean {
  return statusIs(value, ["failed", "rolled_back", "rolledback", "blocked", "cancelled", "canceled", "revoked"]);
}

function isPassStatus(value: unknown): boolean {
  return statusIs(value, ["pass", "passed", "qualified", "qualification_passed"]);
}

function isFailStatus(value: unknown): boolean {
  return statusIs(value, ["fail", "failed", "qualification_failed"]);
}

function isApprovedStatus(value: unknown): boolean {
  return statusIs(value, ["approved", "review_approved", "video_approved", "accepted", "live"]);
}

function isRejectedStatus(value: unknown): boolean {
  return statusIs(value, ["rejected", "reject", "review_rejected", "video_rejected"]);
}

function isNeedsResubmissionStatus(value: unknown): boolean {
  return statusIs(value, ["needs_review", "needs_resubmission", "resubmission_requested"]);
}

function isDoneFailedStatus(value: unknown): boolean {
  return statusIs(value, ["done_failed", "failed_terminal"]);
}

function isGemScheduledStatus(value: unknown): boolean {
  return statusIs(value, ["scheduled", "queued", "pending", "ready"]);
}

function isGemPaidStatus(value: unknown): boolean {
  return statusIs(value, ["paid", "payment_complete", "paid_complete", "settled"]);
}

function isActiveTrackingStatus(value: unknown): boolean {
  const key = statusKey(value);
  return key === "" || ["active", "scheduled", "tracking", "ok", "live", "enabled"].includes(key);
}
function safeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || shortHash(value);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
