import { makeScpAlias } from "./scp-alias-id.ts";
import { isScpLikeProgramId as isScpProgramId } from "./scp-program-alias.ts";

export type ScpLifecycleState =
  | "coldmail_sent"
  | "reply_received"
  | "form_submitted"
  | "qualification_pending"
  | "qualification_passed"
  | "qualification_failed"
  | "pass_mail_pending"
  | "fail_mail_pending"
  | "onelink_sent"
  | "uid_requested"
  | "uid_received"
  | "gem_scheduled"
  | "gem_paid"
  | "video_task_issued"
  | "video_submitted"
  | "video_review_pending"
  | "video_approved"
  | "video_rejected"
  | "needs_resubmission"
  | "live_tracking"
  | "done_failed";

export const DEFAULT_SCP_PROGRAM_ID = "scp";

export type ScpManagementBucketKey = "management" | "preReply";
export type ScpManagementClassificationReason =
  | "scp_responder"
  | "manual_non_scp"
  | "scp_pre_reply"
  | "discovery_promotion_pre_reply"
  | "handle_only_unmatched_pre_reply"
  | "program_filtered";

export type ScpManagementCreatorInput = {
  id?: string;
  creatorId?: string;
  creator_id?: string;
  email?: string;
  profileMatchedEmail?: string;
  channelId?: string;
  youtubeChannelId?: string;
  ytChannelId?: string;
  handle?: string;
  creatorHandle?: string;
  channelHandle?: string;
  source?: string;
  promotedFromCandidate?: unknown;
  sourceTag?: string;
  discoverySource?: string;
  promotedAtIso?: unknown;
  adCandidate?: unknown;
  owner?: string;
  promotionSourcePurpose?: string;
  promotionProgramIds?: readonly string[];
  promotionCampaignIds?: readonly string[];
  promotionParticipationRefs?: readonly string[];
  programStageAuthority?: string;
};

export type ScpManagementProfileInput = {
  id?: string;
  profileId?: string;
  currentState?: string;
  aliasIds?: readonly string[];
  programId?: string;
  programIds?: readonly string[];
  /**
   * 서버 투영이 실어 보내는 행 출처. 지원서 폴백 행만 SCP_APPLICATION_MANAGEMENT_FALLBACK_PROFILE_SOURCE
   * 를 쓰고, 실 lifecycle 프로필은 materialized_reconcile/drift_detection/refresh_outbox/manual_refresh 다.
   */
  source?: string;
};

export type ScpManagementProfileRef = {
  profileId: string;
  currentState: string;
  programId: string;
  programIds: string[];
  /** 지원서(scp_application_management) 폴백 행인가 — 실 lifecycle 프로필에 언제나 밀린다. */
  fallback: boolean;
};

export type ScpManagementClassifiedCreator<T extends ScpManagementCreatorInput> = {
  creator: T;
  bucket: ScpManagementBucketKey;
  reason: ScpManagementClassificationReason;
  matchedProfile: ScpManagementProfileRef | null;
  matchedAliasId: string | null;
};

export type ScpManagementBuckets<T extends ScpManagementCreatorInput> = {
  management: T[];
  preReply: T[];
  classified: ScpManagementClassifiedCreator<T>[];
  counts: {
    management: number;
    preReply: number;
    total: number;
  };
};

export type ScpManagementBucketOptions = {
  programId?: string | null;
};

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

const REPLY_RECEIVED_RANK = STATE_RANK.reply_received;

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function uniqueText(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = textValue(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * 서버가 지원서 폴백 행에만 싣는 출처 값(functions/scpLifecycleProfiles.ts 의
 * SCP_APPLICATION_MANAGEMENT_FALLBACK_SOURCE 와 같은 문자열 — parity 는 테스트로 봉인).
 */
export const SCP_APPLICATION_MANAGEMENT_FALLBACK_PROFILE_SOURCE = "scp_application_management";

export function isScpApplicationManagementFallbackProfile(profile: ScpManagementProfileInput): boolean {
  return textValue(profile.source) === SCP_APPLICATION_MANAGEMENT_FALLBACK_PROFILE_SOURCE;
}

export function normalizeScpManagementProgramId(value: unknown): string {
  const text = textValue(value)?.trim();
  if (!text) return DEFAULT_SCP_PROGRAM_ID;
  // SCP 별칭(scp/pg-super-creator-partners)은 관리 필터에서 동일 취급 — DEFAULT_SCP_PROGRAM_ID 슬롯으로 정규화(dual-read).
  return isScpProgramId(text) ? DEFAULT_SCP_PROGRAM_ID : text;
}

function scpProfileProgramIds(profile: ScpManagementProfileInput): string[] {
  const ids = uniqueText([
    profile.programId,
    ...(Array.isArray(profile.programIds) ? profile.programIds : []),
  ]).map(normalizeScpManagementProgramId);
  return ids.length > 0 ? [...new Set(ids)] : [DEFAULT_SCP_PROGRAM_ID];
}

export function scpProfileMatchesProgram(profile: ScpManagementProfileInput, programId: string): boolean {
  return scpProfileProgramIds(profile).includes(normalizeScpManagementProgramId(programId));
}

export function scpProfileMatchesProgramSelection(
  profile: ScpManagementProfileInput,
  selectedProgramId: string,
): boolean {
  return !selectedProgramId.trim() || scpProfileMatchesProgram(profile, selectedProgramId);
}

function scpCreatorPromotionProgramIds(creator: ScpManagementCreatorInput): string[] {
  return uniqueText(Array.isArray(creator.promotionProgramIds) ? creator.promotionProgramIds : [])
    .map(normalizeScpManagementProgramId);
}

function scpCreatorPromotionMatchesProgram(
  creator: ScpManagementCreatorInput,
  selectedProgramId: string,
): boolean {
  const promotionProgramIds = scpCreatorPromotionProgramIds(creator);
  if (promotionProgramIds.length > 0) return promotionProgramIds.includes(selectedProgramId);
  const purpose = textValue(creator.promotionSourcePurpose)?.toLowerCase();
  if (purpose === "program_candidate") return false;
  if (purpose === "feed_discovery") return selectedProgramId === DEFAULT_SCP_PROGRAM_ID;
  if (creator.programStageAuthority === "campaign_candidates") return false;
  // General feed discovery historically populates SCP's pre-reply feed. Keep
  // that purpose explicit and do not leak it into unrelated program filters.
  return selectedProgramId === DEFAULT_SCP_PROGRAM_ID;
}

function scpProfileRef(profile: ScpManagementProfileInput): ScpManagementProfileRef | null {
  const profileId = textValue(profile.profileId) ?? textValue(profile.id) ?? "";
  const currentState = textValue(profile.currentState) ?? "";
  if (!profileId || !Array.isArray(profile.aliasIds)) return null;
  const programIds = scpProfileProgramIds(profile);
  return {
    profileId,
    currentState,
    programId: programIds[0] ?? DEFAULT_SCP_PROGRAM_ID,
    programIds,
    fallback: isScpApplicationManagementFallbackProfile(profile),
  };
}

/**
 * 지원서 폴백 행은 `currentState: "form_submitted"`(rank 30) 하나만 주장할 수 있는데, 그 rank 가
 * 실 lifecycle 상태인 coldmail_sent(10)·reply_received(20)보다 높다. rank 만으로 고르면 같은 사람의
 * **실** 프로필이 지원서 폴백 행에 밀려 matchedProfile 이 뒤바뀐다. 그래서 폴백 행은 후보에 실
 * 프로필이 하나라도 있으면 언제나 열세다 — rank 비교는 그다음이다.
 */
function scpProfileCandidateWins(
  candidate: ScpManagementProfileRef,
  candidatePriority: number,
  incumbent: ScpManagementProfileRef | null,
  incumbentPriority: number,
): boolean {
  if (!incumbent) return true;
  if (candidate.fallback !== incumbent.fallback) return !candidate.fallback;
  const candidateRank = scpLifecycleStateRank(candidate.currentState);
  const incumbentRank = scpLifecycleStateRank(incumbent.currentState);
  if (candidateRank !== incumbentRank) return candidateRank > incumbentRank;
  return candidatePriority < incumbentPriority;
}

export function scpLifecycleStateRank(state: unknown): number {
  return typeof state === "string" && state in STATE_RANK ? STATE_RANK[state as ScpLifecycleState] : 0;
}

export function hasReplyReceivedOrLater(state: unknown): boolean {
  return scpLifecycleStateRank(state) >= REPLY_RECEIVED_RANK;
}

export function scpProfileAliasMap(profiles: readonly ScpManagementProfileInput[]): Map<string, ScpManagementProfileRef> {
  const byAlias = new Map<string, ScpManagementProfileRef>();
  for (const profile of profiles) {
    const aliasIds = Array.isArray(profile.aliasIds) ? profile.aliasIds : [];
    const ref = scpProfileRef(profile);
    if (!ref) continue;
    for (const aliasId of aliasIds) {
      if (typeof aliasId !== "string" || !aliasId) continue;
      const existing = byAlias.get(aliasId);
      // 같은 alias 를 두 행이 주장하면 먼저 온 쪽이 이긴다 — 단 지원서 폴백 행이 앉아 있고 실
      // lifecycle 프로필이 뒤에 오면 자리를 넘긴다(폴백은 실 프로필에 언제나 열세).
      if (existing && !(existing.fallback && !ref.fallback)) continue;
      byAlias.set(aliasId, ref);
    }
  }
  return byAlias;
}

export function scpCreatorStrongAliasIds(creator: ScpManagementCreatorInput): string[] {
  return scpCreatorStrongAliasCandidates(creator).map((alias) => alias.aliasId);
}

type ScpStrongAliasCandidate = {
  aliasId: string;
  priority: number;
};

function scpCreatorStrongAliasCandidates(creator: ScpManagementCreatorInput): ScpStrongAliasCandidate[] {
  const aliases = [
    ...uniqueText([creator.email, creator.profileMatchedEmail]).map((value) => ({
      aliasId: makeScpAlias("email", value)?.aliasId,
      priority: 0,
    })),
    ...uniqueText([creator.creatorId, creator.creator_id, creator.id]).map((value) => ({
      aliasId: makeScpAlias("creatorId", value)?.aliasId,
      priority: 1,
    })),
    ...uniqueText([creator.channelId, creator.youtubeChannelId, creator.ytChannelId]).map((value) => ({
      aliasId: makeScpAlias("channelId", value)?.aliasId,
      priority: 2,
    })),
  ].filter((alias): alias is ScpStrongAliasCandidate => Boolean(alias.aliasId));

  const seen = new Set<string>();
  const out: ScpStrongAliasCandidate[] = [];
  for (const alias of aliases) {
    if (seen.has(alias.aliasId)) continue;
    seen.add(alias.aliasId);
    out.push(alias);
  }
  return out;
}

function hasExplicitStrongIdentity(creator: ScpManagementCreatorInput): boolean {
  return uniqueText([
    creator.email,
    creator.profileMatchedEmail,
    creator.creatorId,
    creator.creator_id,
    creator.channelId,
    creator.youtubeChannelId,
    creator.ytChannelId,
  ]).length > 0;
}

export function isDiscoveryPromotedCreator(creator: ScpManagementCreatorInput): boolean {
  const source = textValue(creator.source)?.toLowerCase();
  const sourceTag = textValue(creator.sourceTag)?.toLowerCase();
  const discoverySource = textValue(creator.discoverySource)?.toLowerCase();
  return source === "discovery-promotion" ||
    sourceTag === "discovery-promotion" ||
    sourceTag === "candidate-pool" ||
    sourceTag === "csv-upload" ||
    sourceTag?.startsWith("rec-panel:") === true ||
    sourceTag === "rec-panel" ||
    discoverySource === "candidate-pool" ||
    discoverySource === "csv-upload" ||
    textValue(creator.promotedFromCandidate) !== null ||
    textValue(creator.promotedAtIso) !== null ||
    creator.adCandidate === true;
}

export function classifyScpManagementCreator<T extends ScpManagementCreatorInput>(
  creator: T,
  profileByAliasId: ReadonlyMap<string, ScpManagementProfileRef>,
): ScpManagementClassifiedCreator<T> {
  let matchedProfile: ScpManagementProfileRef | null = null;
  let matchedAliasId: string | null = null;
  let matchedPriority = Number.POSITIVE_INFINITY;

  for (const alias of scpCreatorStrongAliasCandidates(creator)) {
    const profile = profileByAliasId.get(alias.aliasId);
    if (!profile) continue;
    if (scpProfileCandidateWins(profile, alias.priority, matchedProfile, matchedPriority)) {
      matchedProfile = profile;
      matchedAliasId = alias.aliasId;
      matchedPriority = alias.priority;
    }
  }

  if (matchedProfile) {
    if (hasReplyReceivedOrLater(matchedProfile.currentState)) {
      return { creator, bucket: "management", reason: "scp_responder", matchedProfile, matchedAliasId };
    }
    return { creator, bucket: "preReply", reason: "scp_pre_reply", matchedProfile, matchedAliasId };
  }

  const hasHandle = uniqueText([creator.handle, creator.creatorHandle, creator.channelHandle]).length > 0;
  const isDiscoveryPromoted = isDiscoveryPromotedCreator(creator);
  if (isDiscoveryPromoted && hasHandle && !hasExplicitStrongIdentity(creator)) {
    return { creator, bucket: "preReply", reason: "handle_only_unmatched_pre_reply", matchedProfile: null, matchedAliasId: null };
  }

  if (isDiscoveryPromoted) {
    return { creator, bucket: "preReply", reason: "discovery_promotion_pre_reply", matchedProfile: null, matchedAliasId: null };
  }

  return { creator, bucket: "management", reason: "manual_non_scp", matchedProfile: null, matchedAliasId: null };
}

export function bucketScpManagementCreators<T extends ScpManagementCreatorInput>(
  creators: readonly T[],
  profiles: readonly ScpManagementProfileInput[],
  options: ScpManagementBucketOptions = {},
): ScpManagementBuckets<T> {
  const selectedProgramId = options.programId ? normalizeScpManagementProgramId(options.programId) : null;
  const profileByAliasId = scpProfileAliasMap(
    selectedProgramId ? profiles.filter((profile) => scpProfileMatchesProgram(profile, selectedProgramId)) : profiles,
  );
  const allProfileByAliasId = selectedProgramId ? scpProfileAliasMap(profiles) : profileByAliasId;
  const classified = creators
    .map((creator) => {
      const row = classifyScpManagementCreator(creator, profileByAliasId);
      if (!selectedProgramId || row.matchedProfile) return row;
      const crossProgramRow = classifyScpManagementCreator(creator, allProfileByAliasId);
      if (crossProgramRow.matchedProfile) {
        return { ...row, bucket: "preReply" as const, reason: "program_filtered" as const };
      }
      return row;
    })
    .filter((row) => {
      if (!selectedProgramId) return true;
      if (row.matchedProfile) return row.matchedProfile.programIds.includes(selectedProgramId);
      if (row.reason === "program_filtered") return false;
      if (isDiscoveryPromotedCreator(row.creator)) {
        return scpCreatorPromotionMatchesProgram(row.creator, selectedProgramId);
      }
      return selectedProgramId === DEFAULT_SCP_PROGRAM_ID;
    });
  const management = classified.filter((row) => row.bucket === "management").map((row) => row.creator);
  const preReply = classified.filter((row) => row.bucket === "preReply").map((row) => row.creator);
  return {
    management,
    preReply,
    classified,
    counts: {
      management: management.length,
      preReply: preReply.length,
      total: classified.length,
    },
  };
}
